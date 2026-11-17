import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
    // The server's bearer token went to Claude Code over stdin: it is on no
    // command line of the adapter's processes (`ps`, so not on Windows). A
    // CLAUDE_CODE_EXECUTABLE CLI gets it on its command line.
    if (process.platform !== "win32" && !process.env.CLAUDE_CODE_EXECUTABLE) {
      const commandLines = spawnSync("ps", ["-axww", "-o", "ppid=,command="], { encoding: "utf8" })
        .stdout.split("\n")
        .filter((line) => line.trim().startsWith(`${child.pid} `));
      // Claude Code's session process is one of them.
      expect(commandLines.some((line) => line.includes("stream-json"))).toBe(true);
      expect(commandLines.filter((line) => line.includes("Bearer "))).toEqual([]);
    }
  }, 60_000);

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

  it("fails a queued prompt with -32800 at a cancel and goes idle with cancelled", async () => {
    const sessionId = await newSession("bypassPermissions");
    await prompt(
      sessionId,
      "Use the Bash tool in the foreground (not run_in_background) to run exactly: ping -c 30 127.0.0.1 > /dev/null . Then reply with just: woke",
    );
    await until(() =>
      updates.some(
        ({ update }) =>
          update.sessionUpdate === "terminal_update" &&
          /ping/.test((update as v2.TerminalUpdate).command ?? ""),
      ),
    );
    // Claude Code takes in a prompt sent while it works only at its next
    // step, so this one is still queued at the cancel.
    // It answers when Claude Code starts it, so the cancel fails it instead.
    const queued = prompt(sessionId, "Reply with just: queued");
    await new Promise((resolve) => setTimeout(resolve, 500));
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
