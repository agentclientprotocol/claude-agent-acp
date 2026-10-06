/**
 * Session hooks against the real Claude Code binary. A local stub of the
 * Messages API answers every turn, so the test needs no network or account.
 * The CLI merges the settings tiers, so a mock SDK cannot show that the user
 * and project hooks still run next to the hooks of `_meta.claudeCode.options`.
 */
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import type { NewSessionRequest } from "@agentclientprotocol/sdk";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ClaudeAcpAgent, type AcpClient } from "../acp-agent.js";

function sse(type: string, data: object): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
}

const REPLY =
  sse("message_start", {
    message: {
      id: "msg_stub",
      type: "message",
      role: "assistant",
      model: "claude-sonnet-4-5",
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 0 },
    },
  }) +
  sse("content_block_start", { index: 0, content_block: { type: "text", text: "" } }) +
  sse("content_block_delta", { index: 0, delta: { type: "text_delta", text: "ok" } }) +
  sse("content_block_stop", { index: 0 }) +
  sse("message_delta", {
    delta: { stop_reason: "end_turn", stop_sequence: null },
    usage: { output_tokens: 1 },
  }) +
  sse("message_stop", {});

describe("session hooks with the Claude Code binary", () => {
  let root: string;
  let cwd: string;
  let home: string;
  let log: string;
  let server: http.Server;
  let agent: ClaudeAcpAgent;
  let env: Record<string, string | undefined>;
  let settingsFiles: Record<string, string>;
  let logCursor = 0;

  /** A SessionStart hook that writes `tag` to the log. */
  function hooks(tag: string) {
    return {
      SessionStart: [{ hooks: [{ type: "command", command: `echo ${tag} >> "${log}"` }] }],
    };
  }

  function meta(tag?: string): NewSessionRequest["_meta"] {
    return { claudeCode: { options: { env, ...(tag && { settings: { hooks: hooks(tag) } }) } } };
  }

  /** The hooks that ran since the previous call. Hooks of one event run in parallel. */
  async function hooksSinceLastCheck(): Promise<string[]> {
    const lines = (await readFile(log, "utf8").catch(() => "")).split("\n").filter(Boolean);
    const added = lines.slice(logCursor);
    logCursor = lines.length;
    return added.sort();
  }

  /** A turn finishes after the SessionStart hooks, and it persists the session for a load. */
  async function finishTurn(sessionId: string): Promise<void> {
    const response = await agent.prompt({ sessionId, prompt: [{ type: "text", text: "hi" }] });
    expect(response.stopReason).toBe("end_turn");
  }

  async function readSettingsFiles(): Promise<Record<string, string>> {
    const files: Record<string, string> = {};
    for (const dir of [path.join(home, ".claude"), path.join(cwd, ".claude")]) {
      for (const name of await readdir(dir)) {
        if (name.startsWith("settings")) {
          files[path.join(dir, name)] = await readFile(path.join(dir, name), "utf8");
        }
      }
    }
    return files;
  }

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), "claude-acp-session-hooks-"));
    cwd = path.join(root, "workspace");
    home = path.join(root, "home");
    log = path.join(root, "hooks.log");
    await mkdir(path.join(cwd, ".claude"), { recursive: true });
    await mkdir(path.join(home, ".claude"), { recursive: true });
    await writeFile(
      path.join(home, ".claude", "settings.json"),
      JSON.stringify({ hooks: hooks("user") }),
    );
    await writeFile(
      path.join(cwd, ".claude", "settings.json"),
      JSON.stringify({ hooks: hooks("project") }),
    );
    settingsFiles = await readSettingsFiles();
    // vitest.config.ts points every test at `/usr/bin/false` in place of the
    // CLI. This file opts in to the real binary, and isolates the agent process
    // too: it reads user settings and runs `claude auth status` itself.
    vi.stubEnv("CLAUDE_CODE_EXECUTABLE", undefined);
    vi.stubEnv("HOME", home);
    vi.stubEnv("CLAUDE_CONFIG_DIR", path.join(home, ".claude"));

    server = http.createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        if (req.url?.startsWith("/v1/messages/count_tokens")) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ input_tokens: 1 }));
        } else if (req.url?.startsWith("/v1/messages")) {
          res.writeHead(200, { "content-type": "text/event-stream" });
          res.end(REPLY);
        } else {
          res.writeHead(200);
          res.end();
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

    env = {
      ...process.env,
      HOME: home,
      CLAUDE_CONFIG_DIR: path.join(home, ".claude"),
      ANTHROPIC_API_KEY: "sk-ant-test",
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    };
    const client = {
      sessionUpdate: async () => {},
      requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
    } as unknown as AcpClient;
    agent = new ClaudeAcpAgent(client, { log: () => {}, error: () => {} });
  });

  afterAll(async () => {
    await agent?.dispose();
    vi.unstubAllEnvs();
    await new Promise((resolve) => server?.close(resolve));
    // The CLI may still write the transcript of the last session after dispose.
    if (root) await rm(root, { recursive: true, force: true, maxRetries: 10 });
  });

  // With CLAUDE_MODEL_CONFIG, the adapter passes the merged settings inline.
  for (const modelConfig of [
    undefined,
    '{"modelOverrides":{"claude-opus-4-6":"claude-opus-4-6"}}',
  ]) {
    describe(modelConfig ? "with CLAUDE_MODEL_CONFIG" : "without CLAUDE_MODEL_CONFIG", () => {
      const original = process.env.CLAUDE_MODEL_CONFIG;
      beforeEach(() => {
        if (modelConfig) process.env.CLAUDE_MODEL_CONFIG = modelConfig;
        else delete process.env.CLAUDE_MODEL_CONFIG;
      });
      afterEach(() => {
        if (original === undefined) delete process.env.CLAUDE_MODEL_CONFIG;
        else process.env.CLAUDE_MODEL_CONFIG = original;
      });

      it("runs the user, project and IDE hooks of one event, only in their session", async () => {
        const withHooks = await agent.newSession({ cwd, mcpServers: [], _meta: meta("ide") });
        await finishTurn(withHooks.sessionId);
        expect(await hooksSinceLastCheck()).toEqual(["ide", "project", "user"]);

        const withoutHooks = await agent.newSession({ cwd, mcpServers: [], _meta: meta() });
        await finishTurn(withoutHooks.sessionId);
        expect(await hooksSinceLastCheck()).toEqual(["project", "user"]);

        expect(await readSettingsFiles()).toEqual(settingsFiles);
      }, 60_000);

      it("replaces and removes IDE hooks on session/load", async () => {
        const { sessionId } = await agent.newSession({
          cwd,
          mcpServers: [],
          _meta: meta("ide-old"),
        });
        await finishTurn(sessionId);
        expect(await hooksSinceLastCheck()).toEqual(["ide-old", "project", "user"]);

        await agent.loadSession({ sessionId, cwd, mcpServers: [], _meta: meta("ide-new") });
        await finishTurn(sessionId);
        expect(await hooksSinceLastCheck()).toEqual(["ide-new", "project", "user"]);

        await agent.loadSession({ sessionId, cwd, mcpServers: [], _meta: meta() });
        await finishTurn(sessionId);
        expect(await hooksSinceLastCheck()).toEqual(["project", "user"]);

        expect(await readSettingsFiles()).toEqual(settingsFiles);
      }, 60_000);
    });
  }
});
