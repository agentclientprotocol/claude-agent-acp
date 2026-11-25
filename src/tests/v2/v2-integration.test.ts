import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as v2 from "@agentclientprotocol/sdk/experimental/v2/unstable";
import { nodeToWebReadable, nodeToWebWritable } from "../../utils.js";

/**
 * The ACP v2 core (`src/v2/`) against the bundled Claude Code
 * CLI, in the adapter's own process as a client starts it. The doubles of
 * `v2.test.ts` send the frames the core builds its turn model on
 * (`command_lifecycle`, `session_state_changed`, `interrupt({ cancelQueued })`);
 * these cases check that the real CLI still sends them. They cost API usage.
 */
describe.skipIf(!process.env.RUN_INTEGRATION_TESTS)("v2 core with Claude Code", () => {
  let child: ChildProcess;
  let agent: v2.ClientContext;
  let cwd: string;
  const updates: v2.UpdateSessionNotification[] = [];
  const waiters: Array<() => void> = [];
  let permissionAnswer: v2.PermissionOptionKind = "allow_once";
  /** The MCP servers that the client serves over the connection (`mcp/message`). */
  const mcp = new v2.McpOverAcpProvider();

  beforeAll(() => {
    if (spawnSync("npx", ["tsc"], { stdio: "inherit" }).status) {
      throw new Error("failed to compile");
    }
  }, 120_000);

  beforeEach(async () => {
    cwd = await mkdtemp(path.join(os.tmpdir(), "v2-integration-"));
    await writeFile(path.join(cwd, "file.txt"), "one\n");
    updates.length = 0;
    permissionAnswer = "allow_once";
    child = spawn("node", [path.resolve("dist/index.js")], {
      cwd,
      env: { ...process.env, CLAUDE_AGENT_ACP_PROTOCOL: "v2" },
      stdio: ["pipe", "pipe", "inherit"],
    });
    const connection = v2
      .client({ name: "v2-integration" })
      .onNotification(v2.methods.client.session.update, ({ params }) => {
        updates.push(params);
        for (const notify of waiters.splice(0)) notify();
      })
      .onRequest(v2.methods.client.session.requestPermission, ({ params }) => {
        const option = params.options.find((candidate) => candidate.kind === permissionAnswer);
        return option
          ? { outcome: { outcome: "selected", optionId: option.optionId } }
          : { outcome: { outcome: "cancelled" } };
      })
      .onRequest(v2.methods.client.mcp.message, mcp.handleRequest)
      .connect(v2.ndJsonStream(nodeToWebWritable(child.stdin!), nodeToWebReadable(child.stdout!)));
    agent = connection.agent;
    await agent.request(v2.methods.agent.initialize, {
      protocolVersion: v2.PROTOCOL_VERSION,
      info: { name: "v2-integration", version: "1" },
      capabilities: {},
    });
  }, 60_000);

  afterEach(async () => {
    // Not `connection.close()`: it cancels the stdout stream, and the socket's
    // later `end` then closes it again (`nodeToWebReadable`), which throws.
    child.kill();
    await rm(cwd, { recursive: true, force: true, maxRetries: 10 });
  });

  afterAll(() => child?.kill());

  /**
   * Whether the adapter sends MCP servers and settings to Claude Code over
   * stdin (see `cliDelivery`), and `ps` can show that: not for a
   * CLAUDE_CODE_EXECUTABLE CLI, and not on Windows.
   */
  const takesOptionsOverStdin = process.platform !== "win32" && !process.env.CLAUDE_CODE_EXECUTABLE;

  /** The command lines of the processes that the adapter started. */
  const adapterCommandLines = () =>
    spawnSync("ps", ["-axww", "-o", "ppid=,command="], { encoding: "utf8" })
      .stdout.split("\n")
      .filter((line) => line.trim().startsWith(`${child.pid} `));

  /** The states of the root session's `state_update`s, in order. */
  const states = (sessionId: string) =>
    updates.flatMap(({ sessionId: id, update }) =>
      id === sessionId && update.sessionUpdate === "state_update" ? [update] : [],
    );

  /** Resolves once `test` holds for the updates received so far. */
  async function until(test: () => boolean, ms = 120_000): Promise<void> {
    const deadline = Date.now() + ms;
    while (!test()) {
      if (Date.now() > deadline) throw new Error("timed out waiting for the session's updates");
      await new Promise<void>((resolve) => {
        waiters.push(resolve);
        setTimeout(resolve, 1000);
      });
    }
  }

  /** A new session on its haiku model, the cheapest, in `mode`. */
  async function newSession(mode: string): Promise<string> {
    const { sessionId, configOptions } = await agent.request(v2.methods.agent.session.new, {
      cwd,
    });
    type Entry = { value: string; name: string; options?: Entry[] };
    const model = configOptions?.find((option) => option.configId === "model") as
      { options?: Entry[] } | undefined;
    const values = (model?.options ?? []).flatMap((entry) => entry.options ?? [entry]);
    const haiku = values.find((entry) => /haiku/i.test(`${entry.value} ${entry.name}`));
    if (haiku) {
      await agent.request(v2.methods.agent.session.setConfigOption, {
        sessionId,
        configId: "model",
        type: "id",
        value: haiku.value,
      });
    }
    await agent.request(v2.methods.agent.session.setConfigOption, {
      sessionId,
      configId: "mode",
      type: "id",
      value: mode,
    });
    return sessionId;
  }

  const prompt = (sessionId: string, text: string) =>
    agent.request(v2.methods.agent.session.prompt, {
      sessionId,
      prompt: [{ type: "text", text }],
    });

  it("answers a prompt at insertion and reports running, then idle", async () => {
    const sessionId = await newSession("default");
    await prompt(sessionId, "Reply with exactly the single word: pong");
    // The prompt answers at insertion, before the turn's idle.
    expect(states(sessionId).some((update) => update.state === "idle")).toBe(false);
    await until(() => states(sessionId).some((update) => update.state === "idle"));
    expect(states(sessionId).map((update) => update.state)).toEqual(["running", "idle"]);
    expect(states(sessionId).at(-1)).toMatchObject({ stopReason: "end_turn" });
  }, 180_000);

  it("inserts one message for an idempotencyKey, and knows the key after a close and a resume", async () => {
    const sessionId = await newSession("default");
    const keyed = {
      sessionId,
      idempotencyKey: "0b6f3c1e-8d2a-4c57-9a41-5e2f7d90c3ab",
      prompt: [{ type: "text" as const, text: "Reply with exactly the single word: pong" }],
    };
    const userMessages = () =>
      updates.filter(
        ({ sessionId: id, update }) => id === sessionId && update.sessionUpdate === "user_message",
      );
    const { messageId } = await agent.request(v2.methods.agent.session.prompt, keyed);
    await until(() => states(sessionId).some((update) => update.state === "idle"));
    expect(await agent.request(v2.methods.agent.session.prompt, keyed)).toEqual({ messageId });

    // Claude Code stored the message under the uuid that carries the key.
    await agent.request(v2.methods.agent.session.close, { sessionId });
    await agent.request(v2.methods.agent.session.resume, { sessionId, cwd });
    expect(await agent.request(v2.methods.agent.session.prompt, keyed)).toEqual({ messageId });
    expect(userMessages()).toHaveLength(1);
    expect(states(sessionId).filter((update) => update.state === "running")).toHaveLength(1);
  }, 180_000);
  it("forks at the cursor before a prompt, with the history that came before it", async () => {
    const sessionId = await newSession("default");
    const kinds = (id: string, kind: string) =>
      updates.flatMap(({ sessionId: session, update }) =>
        session === id && update.sessionUpdate === kind ? [update] : [],
      );
    const idles = () => states(sessionId).filter((update) => update.state === "idle").length;
    await prompt(sessionId, "Reply with exactly the single word: one");
    await until(() => idles() === 1);
    const second = await prompt(sessionId, "Reply with exactly the single word: two");
    await until(() => idles() === 2);
    // The first prompt has nothing before it: only the second has a cursor.
    const [cursor, ...others] = kinds(sessionId, "cursor_update") as v2.CursorUpdate[];
    expect(others).toEqual([]);
    expect(cursor).toMatchObject({
      capabilities: { fork: {} },
      anchor: { type: "user_message", messageId: second.messageId, position: "before" },
    });

    const fork = await agent.request(v2.methods.agent.session.fork, {
      sessionId,
      cwd,
      cursorId: cursor!.cursorId,
    });
    await agent.request(v2.methods.agent.session.close, { sessionId: fork.sessionId });
    await agent.request(v2.methods.agent.session.resume, {
      sessionId: fork.sessionId,
      cwd,
      replayFrom: { type: "start" },
    });
    const replayedPrompts = kinds(fork.sessionId, "user_message_chunk").map(
      (update) => (update as { content: { text?: string } }).content.text,
    );
    expect(replayedPrompts).toEqual(["Reply with exactly the single word: one"]);
    expect(kinds(fork.sessionId, "agent_message_chunk")).not.toEqual([]);
  }, 240_000);

  // No prompt: it costs no API usage.
  it("lists the tools of an MCP server that the client serves over ACP", async () => {
    const served: string[] = [];
    const tools = mcp.registerServer(agent, {
      name: "tools",
      handler: ({ method }) => {
        served.push(method);
        if (method === "server/discover") {
          return {
            result: {
              resultType: "complete",
              supportedVersions: ["2026-07-28"],
              capabilities: { tools: {} },
              _meta: { "io.modelcontextprotocol/serverInfo": { name: "tools", version: "1.0.0" } },
            },
          };
        }
        if (method === "tools/list") {
          const echo = { name: "echo", inputSchema: { type: "object" } };
          return { result: { resultType: "complete", tools: [echo] } };
        }
        throw new v2.McpProtocolError(-32601, `Method not found: ${method}`);
      },
    });
    await agent.request(v2.methods.agent.session.new, { cwd, mcpServers: [tools.declaration] });
    // Claude Code asks for the server's MCP revision first, not with `initialize`.
    await until(() => served.includes("tools/list"), 30_000);
    expect(served[0]).toBe("server/discover");
    // The server's bearer token went to Claude Code over stdin.
    if (takesOptionsOverStdin) {
      const commandLines = adapterCommandLines();
      // Claude Code's session process is one of them.
      expect(commandLines.some((line) => line.includes("stream-json"))).toBe(true);
      expect(commandLines.filter((line) => line.includes("Bearer "))).toEqual([]);
    }
  }, 60_000);

  // No prompt: it costs no API usage.
  it.skipIf(!takesOptionsOverStdin)(
    "sends a session's settings to Claude Code over stdin",
    async () => {
      const marker = `v2-integration-${randomUUID()}`;
      await agent.request(v2.methods.agent.session.new, {
        cwd,
        _meta: {
          claudeCode: { options: { settings: { env: { V2_INTEGRATION_MARKER: marker } } } },
        },
      });
      const commandLines = adapterCommandLines();
      // Claude Code's session process, told to read the settings from the initialize request.
      expect(commandLines.some((line) => line.includes("--initialize-fields=settings"))).toBe(true);
      expect(commandLines.filter((line) => line.includes(marker))).toEqual([]);
    },
    60_000,
  );

  // The session's requests go to two local servers: it costs no API usage.
  it("keeps a provider's route when Claude Code does not load the client's settings", async () => {
    const servers: Server[] = [];
    /** Starts a local server that records the paths of its POST requests in `posts`. */
    const serve = async (posts: string[]): Promise<string> => {
      const server = createServer((request, response) => {
        if (request.method === "POST") posts.push(request.url ?? "");
        // No model listing (404), and no answer to a model request (400).
        response.writeHead(request.method === "POST" ? 400 : 404, {
          "content-type": "application/json",
        });
        response.end(
          JSON.stringify({
            type: "error",
            error: { type: "invalid_request_error", message: "local test server" },
          }),
        );
      }).listen(0, "127.0.0.1");
      servers.push(server);
      await once(server, "listening");
      return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    };
    try {
      const providerPosts: string[] = [];
      const projectPosts: string[] = [];
      // The project's settings name another base URL than the provider's.
      await mkdir(path.join(cwd, ".claude"));
      await writeFile(
        path.join(cwd, ".claude", "settings.json"),
        JSON.stringify({ env: { ANTHROPIC_BASE_URL: await serve(projectPosts) } }),
      );
      await agent.request(v2.methods.agent.providers.set, {
        providerId: "main",
        apiType: "anthropic",
        baseUrl: await serve(providerPosts),
      });
      const { sessionId } = await agent.request(v2.methods.agent.session.new, {
        cwd,
        // `allow` must be a list, so Claude Code leaves the whole `settings` option out.
        _meta: { claudeCode: { options: { settings: { permissions: { allow: "Bash" } } } } },
      });
      await prompt(sessionId, "Reply with exactly the single word: pong");
      await until(() => states(sessionId).some((update) => update.state === "idle"));

      expect(providerPosts.some((url) => url.startsWith("/v1/messages"))).toBe(true);
      expect(projectPosts).toEqual([]);
    } finally {
      for (const server of servers) server.close();
    }
  }, 180_000);

  it("starts a session without the MCP servers that managed settings keep out, and says so", async () => {
    const { sessionId } = await agent.request(v2.methods.agent.session.new, {
      cwd,
      mcpServers: [
        { type: "stdio", name: "files", command: "/bin/cat", args: [], env: [] },
        { type: "stdio", name: "search", command: "/bin/cat", args: [], env: [] },
      ],
      _meta: {
        claudeCode: {
          // As an administrator's managed settings: Claude Code refuses a start with MCP servers.
          options: { model: "haiku", managedSettings: { disableSideloadFlags: true } },
        },
      },
    });
    await prompt(sessionId, "Reply with exactly the single word: pong");
    await until(() => states(sessionId).some((update) => update.state === "idle"));

    const notices = updates.flatMap(({ update }) =>
      update.sessionUpdate === "notice" ? [update] : [],
    );
    expect(notices).toEqual([
      {
        sessionUpdate: "notice",
        severity: "warning",
        title: "2 MCP servers failed to start",
        description: expect.stringContaining('"files" and "search"'),
      },
    ]);
    expect(states(sessionId).at(-1)).toMatchObject({ state: "idle", stopReason: "end_turn" });
  }, 180_000);

  it("reports requires_action while a permission request waits", async () => {
    const sessionId = await newSession("default");
    await prompt(
      sessionId,
      "Use the Edit tool on file.txt to replace the word one with the word two. Then reply with just: done",
    );
    await until(() => states(sessionId).some((update) => update.state === "idle"));
    expect(states(sessionId).map((update) => update.state)).toEqual([
      "running",
      "requires_action",
      "running",
      "idle",
    ]);
  }, 180_000);

  it("ends the work once when Claude Code folds a prompt into it", async () => {
    const sessionId = await newSession("bypassPermissions");
    await prompt(
      sessionId,
      "Use the Bash tool in the foreground (not run_in_background) to run exactly: ping -c 8 127.0.0.1 > /dev/null . Then reply with just: woke",
    );
    await until(() =>
      updates.some(
        ({ update }) =>
          update.sessionUpdate === "terminal_update" &&
          /ping/.test((update as v2.TerminalUpdate).command ?? ""),
      ),
    );
    // Claude Code takes this prompt in after the command, into the same work.
    // It sends the prompt's `completed` frame before the work's result.
    await prompt(sessionId, "Reply with exactly the single word: pong");
    await until(() => states(sessionId).some((update) => update.state === "idle"));
    // A turn that the result opened would follow the idle at once.
    await new Promise((resolve) => setTimeout(resolve, 2000));
    expect(states(sessionId).map((update) => update.state)).toEqual(["running", "idle"]);
    // The idle is the result's: it carries what the work spent.
    const idle = states(sessionId).at(-1) as { stopReason?: string; usage?: v2.Usage };
    expect(idle.stopReason).toBe("end_turn");
    expect(idle.usage?.totalTokens).toBeGreaterThan(0);
  }, 240_000);

  // The chunks need two things of Claude Code that the SDK's `Query` type does
  // not declare: a `task_started` frame for a foreground command (it comes
  // about 3 s into the command) and `getTaskOutput` on the query. Without
  // either, the command's result is the first output the client gets.
  it("sends the output of a foreground command while the command runs", async () => {
    const sessionId = await newSession("bypassPermissions");
    await prompt(
      sessionId,
      "Run exactly this Bash command in the foreground (not run_in_background), with no other tool call, then reply with just: done\n" +
        "for i in 1 2 3 4 5 6 7 8; do echo line$i; sleep 1; done",
    );
    await until(() => states(sessionId).some((update) => update.state === "idle"));
    const text = (data: string) => Buffer.from(data, "base64").toString();
    const output = updates.flatMap(({ update }) => {
      if (update.sessionUpdate === "terminal_output_chunk") {
        return [{ sent: "while running", text: text((update as v2.TerminalOutputChunk).data) }];
      }
      const whole =
        update.sessionUpdate === "terminal_update" && (update as v2.TerminalUpdate).output;
      return whole ? [{ sent: "with the result", text: text(whole.data) }] : [];
    });
    expect(output[0]).toEqual({ sent: "while running", text: expect.stringMatching(/^line1\r\n/) });
    // The result then replaces the chunks with the whole output.
    expect(output.at(-1)).toEqual({
      sent: "with the result",
      text: expect.stringMatching(/^line1\r\n[^]*line8/),
    });
  }, 240_000);

  // A forked skill that the user types runs as a subagent that no tool call
  // launched. Its child session rests on what the SDK's types do not promise:
  // a `task_started` without a tool call, messages that name the subagent by
  // `agent_id` only, and their order (Claude Code writes them after the
  // task's end and before the turn's result).
  it("gives the child of a typed forked skill its tool call and text, before its idle", async () => {
    const skill = path.join(cwd, ".claude", "skills", "forked");
    await mkdir(skill, { recursive: true });
    await writeFile(
      path.join(skill, "SKILL.md"),
      [
        "---",
        "name: forked",
        "description: Runs one command in a forked context",
        "context: fork",
        "---",
        "",
        "Run exactly this Bash command, with no other tool call: echo forked",
        "Then reply with just: done",
        "",
      ].join("\n"),
    );
    const sessionId = await newSession("bypassPermissions");
    await prompt(sessionId, "/forked");
    await until(() => states(sessionId).some((update) => update.state === "idle"));

    const announcement = updates.find(
      ({ sessionId: id, update }) => id === sessionId && update.sessionUpdate === "subagent_update",
    );
    const childId = (announcement?.update as { sessionId?: string } | undefined)?.sessionId;
    expect(childId).toBeDefined();
    const child = updates.flatMap(({ sessionId: id, update }) => {
      if (id !== childId) return [];
      if (update.sessionUpdate === "state_update") return [update.state];
      if (update.sessionUpdate === "agent_message_chunk") return ["text"];
      const ended =
        update.sessionUpdate === "tool_call_update" &&
        (update as { status?: string }).status === "completed";
      return ended ? ["tool call"] : [];
    });
    expect(child).toEqual(["running", "tool call", "text", "idle"]);
    // The root has the command's output, and none of the child's tool calls.
    const root = updates.flatMap(({ sessionId: id, update }) =>
      id === sessionId ? [update.sessionUpdate] : [],
    );
    expect(root).toContain("agent_message_chunk");
    expect(root).not.toContain("tool_call_update");
  }, 180_000);

  it("fails a queued prompt with -32800 at a cancel and goes idle with cancelled", async () => {
    const sessionId = await newSession("bypassPermissions");
    await prompt(
      sessionId,
      `Use the Bash tool in the foreground (not run_in_background) to run exactly: printf "cancel-ready\\n"; sleep 30. Then reply with just: woke`,
    );
    // Wait for the command's stdout, so it is running when the prompt is queued.
    // Output that is not UTF-8 arrives as a `terminal_update` snapshot, not a chunk.
    await until(() =>
      updates.some(({ sessionId: id, update }) => {
        if (id !== sessionId) return false;
        const data =
          update.sessionUpdate === "terminal_output_chunk"
            ? (update as v2.TerminalOutputChunk).data
            : update.sessionUpdate === "terminal_update"
              ? (update as v2.TerminalUpdate).output?.data
              : undefined;
        return (
          data !== undefined && Buffer.from(data, "base64").toString().includes("cancel-ready")
        );
      }),
    );
    // Claude Code takes in a prompt sent while it works only at its next step,
    // here the end of the Bash call, so this one is still queued at the cancel.
    // It answers when Claude Code starts it, so the cancel fails it with -32800.
    const queued = prompt(sessionId, "Reply with just: queued");
    await new Promise((resolve) => setTimeout(resolve, 500));
    // The tool result also sends the output as a snapshot, just before the exit.
    expect(
      updates.some(
        ({ sessionId: id, update }) =>
          id === sessionId &&
          update.sessionUpdate === "terminal_update" &&
          (update as v2.TerminalUpdate).exitStatus,
      ),
    ).toBe(false);
    await agent.notify(v2.methods.agent.session.cancel, { sessionId });
    await expect(queued).rejects.toMatchObject({ code: -32800 });
    await until(() => states(sessionId).some((update) => update.state === "idle"));
    expect(states(sessionId).at(-1)).toMatchObject({ state: "idle", stopReason: "cancelled" });

    // The next prompt runs normally.
    const before = states(sessionId).length;
    await prompt(sessionId, "Reply with exactly the single word: ok");
    await until(() =>
      states(sessionId)
        .slice(before)
        .some((update) => update.state === "idle"),
    );
    expect(states(sessionId).slice(before).at(-1)).toMatchObject({ stopReason: "end_turn" });
  }, 240_000);
});
