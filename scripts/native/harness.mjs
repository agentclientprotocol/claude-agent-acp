import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

export const repo = fileURLToPath(new URL("../../", import.meta.url));
export const model = "claude-sonnet-4-5-20250929";
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export async function until(check, label, timeout = 10_000) {
  const deadline = Date.now() + timeout;
  do {
    const value = await check();
    if (value) return value;
    await sleep(30);
  } while (Date.now() < deadline);
  assert.fail(`Timed out: ${label}`);
}
export function point(row) {
  const text = textOf(row.message.content);
  return {
    messageId: row.type === "assistant" ? row.message.id : row.uuid,
    messageFingerprint: "sha256:" + createHash("sha256").update(text).digest("hex"),
    messageOccurrence: 1,
  };
}
export function textOf(content) {
  return typeof content === "string"
    ? content
    : content
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("");
}
export function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
}

export async function fixture(
  name,
  capabilities = ["sessionRewind", "sessionRewindFiles", "runtime", "sessionMcp"],
) {
  const root = await mkdtemp(join(tmpdir(), "claude-native-e2e-"));
  const cwd = join(root, "workspace");
  const home = join(root, "home");
  const config = join(home, ".claude");
  const temp = join(root, "tmp");
  await Promise.all([cwd, config, temp].map((p) => mkdir(p, { recursive: true })));
  const requests = [],
    countRequests = [],
    children = [],
    faults = [],
    protocol = [];
  const keepEvidence = process.env.NATIVE_E2E_KEEP === "1";
  const hashes = async () => {
    const paths = [
      "scripts/native/e2e.mjs",
      "scripts/native/harness.mjs",
      "dist/index.js",
      "dist/acp-agent.js",
      "dist/session-rewind.js",
      "dist/session-history.js",
      "dist/session-rewind-persistence.js",
      "dist/resumed-session.js",
      "dist/native-rewind-control.js",
      "dist/native-mutation.js",
      "node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs",
    ];
    return Object.fromEntries(
      await Promise.all(
        paths.map(async (p) => [
          p,
          createHash("sha256")
            .update(await readFile(join(repo, p)))
            .digest("hex"),
        ]),
      ),
    );
  };
  const startedAt = new Date().toISOString();
  const beforeHashes = keepEvidence ? await hashes() : undefined;
  let toolStep = 0;
  const server = createServer(async (req, res) => {
    try {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const body = raw ? JSON.parse(raw) : {};
      const path = new URL(req.url, "http://localhost").pathname;
      if (path === "/v1/messages" || path === "/messages") {
        assert.equal(req.method, "POST");
        assert.equal(req.headers["x-api-key"], "native-e2e-dummy-key");
        assert.ok(Array.isArray(body.messages) && body.messages.length > 0);
        requests.push(body);
        await f.beforeReply?.(body, requests.length - 1);
        const last = textOf(body.messages.at(-1).content);
        let block = {
          type: "text",
          text: f.injectWrongReply ? "WRONG_NATIVE_REPLY" : `NATIVE_REPLY_${requests.length - 1}`,
        };
        if (name === "files" && toolStep < 2) {
          const tool =
            toolStep++ === 0
              ? { name: "Read", input: { file_path: join(cwd, "tracked.txt") } }
              : {
                  name: "Edit",
                  input: {
                    file_path: join(cwd, "tracked.txt"),
                    old_string: "ORIGINAL",
                    new_string: "CHANGED",
                  },
                };
          block = { type: "tool_use", id: `tool_${toolStep}`, ...tool };
        }
        const message = {
          id: "msg_mock_" + randomUUID().replaceAll("-", ""),
          type: "message",
          role: "assistant",
          model: body.model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 30, output_tokens: 0 },
        };
        assert.equal(body.stream, true, `Expected SDK streaming request for ${last}`);
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        const event = (type, data) =>
          res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
        event("message_start", { message });
        event("content_block_start", {
          index: 0,
          content_block:
            block.type === "text" ? { type: "text", text: "" } : { ...block, input: {} },
        });
        event("content_block_delta", {
          index: 0,
          delta:
            block.type === "text"
              ? { type: "text_delta", text: block.text }
              : { type: "input_json_delta", partial_json: JSON.stringify(block.input) },
        });
        event("content_block_stop", { index: 0 });
        event("message_delta", {
          delta: {
            stop_reason: block.type === "text" ? "end_turn" : "tool_use",
            stop_sequence: null,
          },
          usage: { output_tokens: 10 },
        });
        event("message_stop", {});
        res.end();
      } else if (path.endsWith("/messages/count_tokens")) {
        assert.equal(req.method, "POST");
        assert.equal(req.headers["x-api-key"], "native-e2e-dummy-key");
        countRequests.push(body);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ input_tokens: f.countTokens?.(body) ?? 30 }));
      } else {
        // Incidental native account/telemetry requests never reach a real service.
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({ error: { type: "permission_error", message: "Offline test provider" } }),
        );
      }
    } catch (error) {
      faults.push(error);
      res.writeHead(500);
      res.end();
    }
  });
  server.on("connect", (_req, socket) => socket.end("HTTP/1.1 403 Forbidden\r\n\r\n"));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (/^(SystemRoot|WINDIR|PATH|PATHEXT|COMSPEC|SYSTEMDRIVE)$/i.test(key)) env[key] = value;
  }
  Object.assign(env, {
    HOME: home,
    USERPROFILE: home,
    APPDATA: join(home, "AppData"),
    LOCALAPPDATA: join(home, "Local"),
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_CACHE_HOME: join(home, ".cache"),
    TEMP: temp,
    TMP: temp,
    TMPDIR: temp,
    CLAUDE_CONFIG_DIR: config,
    CLAUDE_SECURESTORAGE_CONFIG_DIR: config,
    ANTHROPIC_API_KEY: "native-e2e-dummy-key",
    ANTHROPIC_BASE_URL: base,
    HTTP_PROXY: base,
    HTTPS_PROXY: base,
    ALL_PROXY: base,
    NO_PROXY: "127.0.0.1,localhost",
    http_proxy: base,
    https_proxy: base,
    all_proxy: base,
    no_proxy: "127.0.0.1,localhost",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1",
    CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION: "false",
  });
  const f = {
    root,
    cwd,
    home,
    config,
    env,
    requests,
    countRequests,
    faults,
    children,
    protocol,
    keepEvidence,
    capabilities,
    async saveEvidence(error) {
      if (!keepEvidence) return;
      await writeFile(
        join(root, "evidence.json"),
        JSON.stringify(
          {
            name,
            root,
            repo,
            startedAt,
            finishedAt: new Date().toISOString(),
            node: process.version,
            error: error && {
              name: error.name,
              message: error.message,
              stack: error.stack,
              actual: error.actual,
              expected: error.expected,
            },
            beforeHashes,
            afterHashes: await hashes(),
            protocol,
            requests,
            countRequests,
            children: children.map((child) => ({
              pid: child.pid,
              exitCode: child.exitCode,
              signalCode: child.signalCode,
              stdout: child.stdoutText,
              stderr: child.stderrText,
            })),
          },
          null,
          2,
        ) + "\n",
      );
      console.error(`EVIDENCE ${name}: ${root}`);
    },
    options: {
      title: "Native contract test",
      enableFileCheckpointing: true,
      settingSources: [],
      tools: [],
      strictMcpConfig: true,
      settings: { disableAllHooks: true, autoMemoryEnabled: false },
      model,
      promptSuggestions: false,
    },
    spawn(script, args = []) {
      const child = spawn(process.execPath, [script, ...args], {
        cwd,
        env,
        windowsHide: true,
        detached: process.platform !== "win32",
        stdio: ["pipe", "pipe", "pipe"],
      });
      children.push(child);
      child.stdoutText = "";
      if (keepEvidence)
        child.stdout.on("data", (b) => {
          child.stdoutText += b;
        });
      child.stderrText = "";
      child.stderr.on("data", (b) => {
        child.stderrText += b;
      });
      child.stdin.on("error", () => {});
      child.failure = new Promise((_, reject) => child.once("error", reject));
      child.failure.catch(() => {});
      child.finished = new Promise((r) =>
        child.once("exit", (code, signal) => r({ code, signal })),
      );
      return child;
    },
    async transcript(sid) {
      const projects = join(config, "projects");
      for (const dir of await readdir(projects)) {
        const content = await readFile(join(projects, dir, sid + ".jsonl"), "utf8").catch(
          () => null,
        );
        if (content !== null)
          return content
            .trim()
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line));
      }
      throw new Error(`Missing native transcript: ${sid}`);
    },
    async history(sid) {
      return (await f.transcript(sid)).filter((r) => r.type === "user" || r.type === "assistant");
    },
    async cleanup() {
      for (const child of children) {
        // A completed/reaped child no longer identifies an owned process group.
        // Only signal while this ChildProcess is still live; never reuse old PIDs.
        if (child.pid && child.exitCode === null && child.signalCode === null) {
          if (process.platform === "win32") {
            await new Promise((r, reject) => {
              const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
                windowsHide: true,
                stdio: "ignore",
              });
              killer.once("error", reject);
              killer.once("exit", r);
            });
          } else {
            try {
              process.kill(-child.pid, "SIGKILL");
            } catch (error) {
              if (error.code !== "ESRCH") throw error;
            }
          }
          await until(
            () => child.exitCode !== null || child.signalCode !== null,
            "owned adapter/worker exit",
            5_000,
          );
        }
      }
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
      // MCP fixtures append every launch, including replacements of the same name.
      // Observe only: never kill a potentially recycled PID from an old marker.
      for (const marker of (await readdir(root)).filter((name) => name.endsWith(".pid"))) {
        for (const pid of (await readFile(join(root, marker), "utf8"))
          .trim()
          .split("\n")
          .map(Number)) {
          assert.ok(Number.isSafeInteger(pid) && pid > 0);
          await until(() => !alive(pid), `owned MCP ${marker} exit`, 5_000);
        }
      }
      // root is the exact mkdtemp result, never a caller-supplied directory.
      assert.equal(relative(resolve(tmpdir()), root).startsWith(".."), false);
      assert.ok(isAbsolute(root) && root !== resolve(tmpdir()));
      if (!keepEvidence)
        await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    },
  };
  return f;
}

export class AcpClient {
  constructor(f) {
    this.f = f;
    this.child = f.spawn(join(repo, "dist/index.js"));
    this.messages = [];
    this.pending = new Map();
    this.seq = 0;
    let buffer = "";
    this.child.stdout.on("data", (chunk) => {
      buffer += chunk;
      while (buffer.includes("\n")) {
        const index = buffer.indexOf("\n"),
          line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        try {
          const message = JSON.parse(line);
          if (f.keepEvidence)
            f.protocol.push({
              at: new Date().toISOString(),
              pid: this.child.pid,
              direction: "from-adapter",
              message,
            });
          this.messages.push(message);
          if (message.id !== undefined && !message.method) {
            const p = this.pending.get(message.id);
            assert.ok(p, `Unexpected response id ${message.id}`);
            this.pending.delete(message.id);
            clearTimeout(p.timer);
            if (message.error)
              p.reject(Object.assign(new Error(JSON.stringify(message.error)), message.error));
            else p.resolve(message.result);
          } else if (message.id !== undefined) {
            assert.equal(message.method, "session/request_permission");
            const option = message.params.options.find((o) => o.kind === "allow_once");
            assert.ok(option, "Permission request needs explicit allow_once");
            this.child.stdin.write(
              JSON.stringify({
                jsonrpc: "2.0",
                id: message.id,
                result: { outcome: { outcome: "selected", optionId: option.optionId } },
              }) + "\n",
            );
          }
        } catch (error) {
          f.faults.push(error);
          this.rejectPending(error);
        }
      }
    });
    this.child.finished.then(({ code, signal }) =>
      this.rejectPending(new Error(`ACP exited ${code}/${signal}`)),
    );
    this.child.failure.catch((error) => this.rejectPending(error));
  }
  rejectPending(error) {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(error);
    }
    this.pending.clear();
  }
  request(method, params, timeout = 30_000) {
    return new Promise((resolve, reject) => {
      const id = ++this.seq;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timeout: ${method}\n${this.child.stderrText.slice(-6000)}`));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      if (this.f.keepEvidence)
        this.f.protocol.push({
          at: new Date().toISOString(),
          pid: this.child.pid,
          direction: "to-adapter",
          message: { jsonrpc: "2.0", id, method, params },
        });
      this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }
  async initialize() {
    const result = await this.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: "native-e2e", version: "1" },
    });
    assert.equal(result.protocolVersion, 1);
    for (const name of this.f.capabilities) assert.equal(result._meta[name].version, 1);
    this.capabilities = result._meta;
  }
  async create(options = {}, mcpServers = []) {
    this.params = {
      cwd: this.f.cwd,
      mcpServers,
      _meta: {
        claudeCode: {
          ...(this.f.rawMessages ? { emitRawSDKMessages: true } : {}),
          options: { ...this.f.options, ...options },
        },
      },
    };
    const result = await this.request("session/new", this.params);
    assert.match(result.sessionId, /^[0-9a-f-]{36}$/);
    this.sid = result.sessionId;
    this.params.sessionId = this.sid;
    return this.sid;
  }
  async prompt(text) {
    const result = await this.request("session/prompt", {
      sessionId: this.sid,
      prompt: [{ type: "text", text }],
    });
    assert.equal(result.stopReason, "end_turn");
    return result;
  }
  replay(start = 0) {
    return this.messages
      .slice(start)
      .filter((m) => m.method === "session/update")
      .map((m) => m.params.update)
      .filter((u) => ["user_message_chunk", "agent_message_chunk"].includes(u.sessionUpdate))
      .map((u) => ({
        role: u.sessionUpdate === "user_message_chunk" ? "user" : "assistant",
        text: u.content.text,
      }));
  }
  async stop() {
    await this.request("session/close", { sessionId: this.sid });
    this.child.stdin.end();
    let timer;
    try {
      const outcome = await Promise.race([
        this.child.finished,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error("ACP did not exit on EOF")), 10_000);
        }),
      ]);
      assert.equal(outcome.code, 0);
    } finally {
      clearTimeout(timer);
    }
  }
}
