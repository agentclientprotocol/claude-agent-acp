/**
 * The native ACP v2 core (`src/v2-native/`), driven through the protocol
 * router with the SDK's v2 client app, which validates every response and
 * session update against the v2 schema.
 *
 * Claude Code is a double that the test drives message by message (see
 * {@link FakeClaudeCode}), shaped like what the bundled CLI sends: prompt
 * echoes with `isReplay`, `command_lifecycle` frames, and
 * `session_state_changed`.
 */
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as v2 from "@agentclientprotocol/sdk/experimental/v2/unstable";
import {
  getSessionMessages,
  type Options,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { acpProtocolRouter, v2CoreFromEnv } from "../serve.js";
import type { AgentHandle } from "../v2-native/agent.js";

/** One Claude Code process: the prompts it reads and the messages it sends. */
type FakeClaudeCode = {
  options: Options;
  /** The prompts the session pushed, in order. */
  prompts: SDKUserMessage[];
  /** Resolves with the `index`th prompt once the session pushed it. */
  prompt(index: number): Promise<SDKUserMessage>;
  /** Sends a message to the session. */
  send(message: Record<string, unknown>): void;
  /** Ends the stream, with `error` as a crash. */
  end(error?: Error): void;
  interrupt: ReturnType<typeof vi.fn>;
  setPermissionMode: ReturnType<typeof vi.fn>;
  setModel: ReturnType<typeof vi.fn>;
  stopTask: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
};

const sdk = vi.hoisted(() => ({
  processes: [] as FakeClaudeCode[],
  models: [
    { value: "default", displayName: "Default", description: "Recommended" },
    { value: "opus", displayName: "Opus", description: "Most capable" },
  ],
}));

vi.mock("@anthropic-ai/claude-agent-sdk", async () => {
  const actual = await vi.importActual<typeof import("@anthropic-ai/claude-agent-sdk")>(
    "@anthropic-ai/claude-agent-sdk",
  );
  return {
    ...actual,
    query: ({ prompt, options }: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => {
      const queue: Array<IteratorResult<Record<string, unknown>> | Error> = [];
      let wake = () => {};
      const prompts: SDKUserMessage[] = [];
      let promptArrived = () => {};
      void (async () => {
        for await (const message of prompt) {
          prompts.push(message);
          promptArrived();
        }
      })();
      const push = (item: IteratorResult<Record<string, unknown>> | Error) => {
        queue.push(item);
        wake();
      };
      const fake: FakeClaudeCode = {
        options,
        prompts,
        prompt: async (index) => {
          while (prompts.length <= index) {
            await new Promise<void>((resolve) => (promptArrived = resolve));
          }
          return prompts[index];
        },
        send: (message) => push({ value: message, done: false }),
        end: (error) => push(error ?? { value: undefined, done: true }),
        interrupt: vi.fn(async () => undefined),
        setPermissionMode: vi.fn(async () => {}),
        setModel: vi.fn(async () => {}),
        stopTask: vi.fn(async () => {}),
        close: vi.fn(() => push({ value: undefined, done: true })),
      };
      sdk.processes.push(fake);
      const messages: AsyncGenerator<Record<string, unknown>> = {
        async next() {
          while (queue.length === 0) await new Promise<void>((resolve) => (wake = resolve));
          const item = queue.shift()!;
          if (item instanceof Error) throw item;
          return item;
        },
        async return() {
          return { value: undefined, done: true };
        },
        async throw(error) {
          throw error;
        },
        [Symbol.asyncIterator]() {
          return this;
        },
        async [Symbol.asyncDispose]() {},
      };
      return Object.assign(messages, {
        initializationResult: async () => ({ models: sdk.models }),
        supportedCommands: async () => [
          { name: "review", description: "Review a change", argumentHint: "<pull request>" },
        ],
        mcpServerStatus: async () => [{ name: "linear", status: "connected" }],
        interrupt: fake.interrupt,
        setPermissionMode: fake.setPermissionMode,
        setModel: fake.setModel,
        stopTask: fake.stopTask,
        close: fake.close,
      });
    },
    getSessionMessages: vi.fn(async () => []),
  };
});

vi.mock("../tools.js", async () => ({
  ...(await vi.importActual<typeof import("../tools.js")>("../tools.js")),
  registerHookCallback: vi.fn(),
}));

// `claude auth status --json`, which the auth status probe runs, reports no login.
vi.mock("node:child_process", async () => ({
  ...(await vi.importActual<typeof import("node:child_process")>("node:child_process")),
  execFile: vi.fn((...invocation: unknown[]) => {
    const callback = invocation.at(-1) as (...args: unknown[]) => void;
    callback(null, { stdout: JSON.stringify({ loggedIn: false }), stderr: "" });
  }),
}));

const agents: AgentHandle[] = [];
let tempDir: string;
let cwd: string;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), "acp-v2-native-"));
  cwd = await mkdtemp(path.join(tempDir, "project-"));
  vi.stubEnv("CLAUDE_CONFIG_DIR", path.join(tempDir, "claude"));
  sdk.processes = [];
});

afterEach(async () => {
  await Promise.all(agents.splice(0).map((agent) => agent.dispose()));
  vi.unstubAllEnvs();
  await rm(tempDir, { recursive: true, force: true, maxRetries: 10 });
});

/** A v2 client of the native core that records the session updates it receives. */
function nativeClient({
  answerPermission = () => ({ outcome: { outcome: "cancelled" } }),
}: {
  answerPermission?: (
    request: v2.RequestPermissionRequest,
  ) => v2.RequestPermissionResponse | Promise<v2.RequestPermissionResponse>;
} = {}) {
  const sessionUpdates: v2.SessionUpdate[] = [];
  const notifications: v2.UpdateSessionNotification[] = [];
  const permissionRequests: v2.RequestPermissionRequest[] = [];
  const app = v2
    .client({ name: "native-test-client" })
    .onNotification(v2.methods.client.session.update, ({ params }) => {
      notifications.push(params);
      sessionUpdates.push(params.update);
    })
    .onRequest(v2.methods.client.session.requestPermission, ({ params }) => {
      permissionRequests.push(params);
      return answerPermission(params);
    });
  const toAgent = new TransformStream<v2.AnyMessage, v2.AnyMessage>();
  const toClient = new TransformStream<v2.AnyMessage, v2.AnyMessage>();
  acpProtocolRouter(undefined, () => {}, "v2", {
    v2Core: "native",
    onNativeAgent: (agent) => agents.push(agent),
  }).connect({ readable: toAgent.readable, writable: toClient.writable });
  /** The `state_update`s of root sessions, not subagents', as their states. */
  const states = () => {
    const children = new Set(
      notifications.flatMap(({ update }) =>
        update.sessionUpdate === "subagent_update" ? [update.sessionId] : [],
      ),
    );
    return notifications.flatMap(({ sessionId, update }) =>
      update.sessionUpdate === "state_update" && !children.has(sessionId) ? [update.state] : [],
    );
  };
  return {
    sessionUpdates,
    notifications,
    permissionRequests,
    states,
    connect: <T>(run: (agent: v2.ClientContext) => Promise<T>) =>
      app.connectWith({ readable: toClient.readable, writable: toAgent.writable }, run),
  };
}

async function openSession(agent: v2.ClientContext, capabilities: v2.ClientCapabilities = {}) {
  await agent.request(v2.methods.agent.initialize, {
    protocolVersion: v2.PROTOCOL_VERSION,
    info: { name: "native-test-client", version: "1.0.0" },
    capabilities,
  });
  const response = await agent.request(v2.methods.agent.session.new, { cwd });
  return { response, claude: sdk.processes.at(-1)! };
}

function lifecycle(prompt: SDKUserMessage, state: string) {
  return { type: "command_lifecycle", command_uuid: prompt.uuid, state, uuid: randomUUID() };
}

function echo(prompt: SDKUserMessage) {
  return {
    type: "user",
    message: prompt.message,
    parent_tool_use_id: null,
    uuid: prompt.uuid,
    session_id: "session",
    isReplay: true,
  };
}

function sessionState(state: "idle" | "running" | "requires_action") {
  return { type: "system", subtype: "session_state_changed", state, uuid: randomUUID() };
}

/** The `system/init` that starts each turn, also one that no prompt started. */
function turnInit() {
  return { type: "system", subtype: "init", uuid: randomUUID() };
}

function textDelta(id: string, text: string) {
  return [
    {
      type: "stream_event",
      event: { type: "message_start", message: { id, content: [] } },
      parent_tool_use_id: null,
      uuid: randomUUID(),
    },
    {
      type: "stream_event",
      event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
      parent_tool_use_id: null,
      uuid: randomUUID(),
    },
  ];
}

function assistant(id: string, content: unknown[]) {
  return {
    type: "assistant",
    message: { id, type: "message", role: "assistant", content, usage: {} },
    parent_tool_use_id: null,
    uuid: randomUUID(),
  };
}

function result(overrides: Record<string, unknown> = {}) {
  return {
    type: "result",
    subtype: "success",
    stop_reason: "end_turn",
    is_error: false,
    result: "",
    errors: [],
    usage: {
      input_tokens: 3,
      output_tokens: 2,
      cache_read_input_tokens: 1,
      cache_creation_input_tokens: 0,
    },
    uuid: randomUUID(),
    ...overrides,
  };
}

const PROMPT = [{ type: "text" as const, text: "Hi" }];

/**
 * A subagent's task events and messages, shaped like the bundled CLI's: its
 * messages carry the id of the Agent call that launched it.
 */
function subagent(agentId: string, launch: string, fields: Record<string, unknown> = {}) {
  const system = (subtype: string, more: Record<string, unknown>) => ({
    type: "system",
    subtype,
    task_id: agentId,
    uuid: randomUUID(),
    ...more,
  });
  return {
    started: (more: Record<string, unknown> = {}) =>
      system("task_started", {
        tool_use_id: launch,
        task_type: "local_agent",
        subagent_type: "general-purpose",
        description: "Investigate the test",
        is_backgrounded: false,
        ...fields,
        ...more,
      }),
    ended: (status = "completed") =>
      system("task_notification", { tool_use_id: launch, status, output_file: "", summary: "" }),
    prompt: (text: string) => ({
      type: "user",
      message: { role: "user", content: [{ type: "text", text }] },
      parent_tool_use_id: launch,
      uuid: randomUUID(),
    }),
    says: (text: string) => ({
      ...assistant(`msg_${agentId}`, [{ type: "text", text }]),
      parent_tool_use_id: launch,
    }),
  };
}

/** The updates of the session `sessionId` that the client received, in order. */
function updatesOf(
  notifications: v2.UpdateSessionNotification[],
  sessionId: string,
): v2.SessionUpdate[] {
  return notifications.flatMap((n) => (n.sessionId === sessionId ? [n.update] : []));
}

describe("native ACP v2 core", () => {
  it("advertises the v2 session baseline with fork, and terminal logins", async () => {
    const client = nativeClient();
    const response = await client.connect((agent) =>
      agent.request(v2.methods.agent.initialize, {
        protocolVersion: v2.PROTOCOL_VERSION,
        info: { name: "native-test-client", version: "1.0.0" },
        capabilities: { auth: { terminal: {} } },
      }),
    );

    expect(response.protocolVersion).toBe(2);
    expect(response.capabilities?.session?.fork).toEqual({});
    expect(response.capabilities?.session?.prompt).toEqual({ image: {}, embeddedContext: {} });
    expect((response.authMethods ?? []).map((method) => method.methodId)).toContain(
      "console-login",
    );
  });

  it("routes the sessions started after a gateway login through the gateway", async () => {
    const client = nativeClient();
    const baseUrl = "https://gateway.example.com";
    await client.connect(async (agent) => {
      await agent.request(v2.methods.agent.initialize, {
        protocolVersion: v2.PROTOCOL_VERSION,
        info: { name: "native-test-client", version: "1.0.0" },
        capabilities: { auth: { _meta: { gateway: true } } },
      });
      await agent.request(v2.methods.agent.auth.login, {
        methodId: "gateway",
        _meta: { gateway: { baseUrl, headers: { "x-team": "acp" } } },
      });
      await agent.request(v2.methods.agent.session.new, { cwd });
    });

    const { env, settings } = sdk.processes[0].options;
    expect(env).toMatchObject({
      ANTHROPIC_BASE_URL: baseUrl,
      ANTHROPIC_CUSTOM_HEADERS: "x-team: acp",
    });
    // In the settings tier too, so a settings.json env cannot restore another route.
    expect(settings).toMatchObject({ apiKeyHelper: "", env: { ANTHROPIC_BASE_URL: baseUrl } });
  });

  it("answers session/new with the mode and model options and the commands", async () => {
    const client = nativeClient();
    const { response, claude } = await client.connect((agent) => openSession(agent));

    expect(response.configOptions?.map((option) => option.configId)).toEqual(["mode", "model"]);
    expect(response.availableCommands).toEqual([
      {
        type: "command",
        name: "review",
        description: "Review a change",
        input: { type: "text", hint: "<pull request>" },
      },
      // The adapter's own `/mcp`, as on the bridge.
      expect.objectContaining({ type: "command", name: "mcp" }),
    ]);
    // Each prompt is echoed, and the session's state is reported.
    expect(claude.options.extraArgs).toMatchObject({ "replay-user-messages": "" });
    expect(claude.options.env?.CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS).toBe("1");
  });

  it("answers a prompt when Claude Code starts it, and reports the work until the turn's result", async () => {
    const client = nativeClient();
    await client.connect(async (agent) => {
      const { response, claude } = await openSession(agent);
      const answer = agent.request(v2.methods.agent.session.prompt, {
        sessionId: response.sessionId,
        prompt: PROMPT,
      });
      const prompt = await claude.prompt(0);
      claude.send(sessionState("running"));
      claude.send(lifecycle(prompt, "started"));
      expect(await answer).toEqual({ messageId: prompt.uuid });
      // The echo of a prompt that already started inserts nothing more.
      claude.send(echo(prompt));
      for (const event of textDelta("msg_1", "Hello")) claude.send(event);
      claude.send(assistant("msg_1", [{ type: "text", text: "Hello" }]));
      claude.send(result({ result: "Hello" }));
      claude.send(sessionState("idle"));
      await vi.waitFor(() => expect(client.states()).toEqual(["running", "idle"]));
    });

    const kinds = client.sessionUpdates
      .map((update) => update.sessionUpdate)
      .filter((kind) => kind !== "available_commands_update");
    expect(kinds).toEqual(["user_message", "state_update", "agent_message_chunk", "state_update"]);
    expect(client.sessionUpdates.at(-1)).toEqual({
      sessionUpdate: "state_update",
      state: "idle",
      stopReason: "end_turn",
      // The session reports its background work, on every state.
      background: [],
      usage: {
        inputTokens: 3,
        outputTokens: 2,
        cachedReadTokens: 1,
        cachedWriteTokens: 0,
        totalTokens: 6,
      },
    });
  });

  it("inserts a prompt that Claude Code folds into the running work at its echo", async () => {
    const client = nativeClient();
    await client.connect(async (agent) => {
      const { response, claude } = await openSession(agent);
      const answer = agent.request(v2.methods.agent.session.prompt, {
        sessionId: response.sessionId,
        prompt: PROMPT,
      });
      const prompt = await claude.prompt(0);
      claude.send(echo(prompt));
      expect(await answer).toEqual({ messageId: prompt.uuid });
    });

    expect(client.sessionUpdates).toContainEqual({
      sessionUpdate: "user_message",
      messageId: expect.any(String),
      content: PROMPT,
    });
  });

  it.each([
    ["discarded", -32603],
    ["refused", -32603],
  ])("fails a prompt that Claude Code %s", async (state, code) => {
    const client = nativeClient();
    const error = await client.connect(async (agent) => {
      const { response, claude } = await openSession(agent);
      const answer = agent.request(v2.methods.agent.session.prompt, {
        sessionId: response.sessionId,
        prompt: PROMPT,
      });
      claude.send(lifecycle(await claude.prompt(0), state));
      return answer.catch((error: unknown) => error);
    });

    expect(error).toMatchObject({ code });
  });

  it("cancels the work and the prompts not inserted yet with one interrupt", async () => {
    const client = nativeClient();
    await client.connect(async (agent) => {
      const { response, claude } = await openSession(agent);
      const sessionId = response.sessionId;
      const first = agent.request(v2.methods.agent.session.prompt, { sessionId, prompt: PROMPT });
      const running = await claude.prompt(0);
      claude.send(sessionState("running"));
      claude.send(lifecycle(running, "started"));
      await first;
      const queued = agent.request(v2.methods.agent.session.prompt, { sessionId, prompt: PROMPT });
      const waiting = await claude.prompt(1);

      await agent.notify(v2.methods.agent.session.cancel, { sessionId });
      await vi.waitFor(() => expect(claude.interrupt).toHaveBeenCalledWith({ cancelQueued: true }));
      // Claude Code ends the queued prompt, then the interrupted work.
      claude.send(lifecycle(waiting, "cancelled"));
      await expect(queued).rejects.toMatchObject({ code: -32800 });
      claude.send(result({ subtype: "error_during_execution", is_error: true }));
      claude.send(sessionState("idle"));
      await vi.waitFor(() => expect(client.states()).toEqual(["running", "idle"]));
    });

    expect(client.sessionUpdates.at(-1)).toMatchObject({ state: "idle", stopReason: "cancelled" });
  });

  it("reports requires_action while a permission request is open, and running once answered", async () => {
    const client = nativeClient({
      answerPermission: (request) => ({
        outcome: { outcome: "selected", optionId: request.options[0].optionId },
      }),
    });
    const decision = await client.connect(async (agent) => {
      const { claude } = await openSession(agent);
      claude.send(turnInit());
      await vi.waitFor(() => expect(client.states()).toEqual(["running"]));
      return claude.options.canUseTool!(
        "Bash",
        { command: "ls" },
        {
          signal: new AbortController().signal,
          toolUseID: "toolu_1",
          requestId: "r1",
          suggestions: [],
        },
      );
    });

    expect(decision?.behavior).toBe("allow");
    expect(client.states()).toEqual(["running", "requires_action", "running"]);
    expect(client.permissionRequests[0].subject).toMatchObject({
      type: "tool_call",
      toolCall: { toolCallId: "toolu_1" },
    });
  });

  it("reads a dismissed permission request as the user refusing the tool", async () => {
    const client = nativeClient();
    const decision = await client.connect(async (agent) => {
      const { claude } = await openSession(agent);
      return claude.options.canUseTool!(
        "Bash",
        { command: "rm -rf build" },
        {
          signal: new AbortController().signal,
          toolUseID: "toolu_1",
          requestId: "r1",
          suggestions: [],
        },
      );
    });

    expect(decision).toMatchObject({ behavior: "deny", decisionClassification: "user_reject" });
  });

  it("sets a config option on the query and sends it as an update too", async () => {
    const client = nativeClient();
    const { claude, configOptions } = await client.connect(async (agent) => {
      const { response, claude } = await openSession(agent);
      const { configOptions } = await agent.request(v2.methods.agent.session.setConfigOption, {
        sessionId: response.sessionId,
        configId: "mode",
        type: "id",
        value: "plan",
      } as v2.SetSessionConfigOptionRequest);
      return { claude, configOptions };
    });

    expect(claude.setPermissionMode).toHaveBeenCalledWith("plan");
    const mode = configOptions.find((option) => option.configId === "mode");
    expect(mode).toMatchObject({ currentValue: "plan" });
    expect(client.sessionUpdates).toContainEqual({
      sessionUpdate: "config_option_update",
      configOptions,
    });
  });

  it("forwards the result of a local command, which streamed no text", async () => {
    const client = nativeClient();
    await client.connect(async (agent) => {
      const { response, claude } = await openSession(agent);
      const answer = agent.request(v2.methods.agent.session.prompt, {
        sessionId: response.sessionId,
        prompt: [{ type: "text", text: "/context" }],
      });
      const prompt = await claude.prompt(0);
      claude.send(sessionState("running"));
      claude.send(lifecycle(prompt, "started"));
      await answer;
      claude.send(result({ result: "Context: 12k tokens" }));
      claude.send(sessionState("idle"));
      await vi.waitFor(() => expect(client.states()).toEqual(["running", "idle"]));
    });

    expect(client.sessionUpdates).toContainEqual(
      expect.objectContaining({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Context: 12k tokens" },
      }),
    );
  });

  it("replaces Claude Code's text of /mcp with the server list, before the turn's idle", async () => {
    const client = nativeClient();
    await client.connect(async (agent) => {
      const { response, claude } = await openSession(agent);
      const answer = agent.request(v2.methods.agent.session.prompt, {
        sessionId: response.sessionId,
        prompt: [{ type: "text", text: "/mcp" }],
      });
      const prompt = await claude.prompt(0);
      claude.send(lifecycle(prompt, "started"));
      await answer;
      claude.send(result({ result: "1 MCP server connected. Run /mcp in the terminal." }));
      claude.send(sessionState("idle"));
      await vi.waitFor(() => expect(client.states()).toEqual(["running", "idle"]));
    });

    const output = client.sessionUpdates.flatMap((update) =>
      update.sessionUpdate === "agent_message_chunk"
        ? [(update.content as { text: string }).text]
        : update.sessionUpdate === "state_update"
          ? [update.state]
          : [],
    );
    expect(output).toEqual(["running", expect.stringContaining("linear"), "idle"]);
    expect(output.join()).not.toContain("in the terminal");
  });

  it("fails the pending prompts and ends the work when Claude Code exits", async () => {
    const client = nativeClient();
    const error = await client.connect(async (agent) => {
      const { response, claude } = await openSession(agent);
      claude.send(turnInit());
      claude.send(
        assistant("msg_1", [
          { type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "make" } },
        ]),
      );
      const answer = agent.request(v2.methods.agent.session.prompt, {
        sessionId: response.sessionId,
        prompt: PROMPT,
      });
      await claude.prompt(0);
      claude.end(new Error("Claude Code process exited with code 1"));
      const error = await answer.catch((error: unknown) => error);
      await vi.waitFor(() => expect(client.states()).toEqual(["running", "idle"]));
      return error;
    });

    expect(error).toMatchObject({ code: -32603 });
    // The unfinished tool call fails before the idle.
    expect(client.sessionUpdates.slice(-2)).toMatchObject([
      { sessionUpdate: "tool_call_update", toolCallId: "toolu_1", status: "failed" },
      { state: "idle", stopReason: "error" },
    ]);
  });

  it("starts a session whose query ended again on resume", async () => {
    const client = nativeClient();
    await client.connect(async (agent) => {
      const { response, claude } = await openSession(agent);
      claude.end(new Error("Claude Code process exited with code 1"));
      await expect(
        agent.request(v2.methods.agent.session.prompt, {
          sessionId: response.sessionId,
          prompt: PROMPT,
        }),
      ).rejects.toMatchObject({ code: -32002, data: { sessionId: response.sessionId } });
      await agent.request(v2.methods.agent.session.resume, { sessionId: response.sessionId, cwd });
    });

    expect(sdk.processes).toHaveLength(2);
    expect(sdk.processes[1].options.resume).toBe(sdk.processes[0].options.sessionId);
  });

  it("ends the work at the turn's result while background subagents keep Claude Code running", async () => {
    const client = nativeClient();
    await client.connect(async (agent) => {
      const { response, claude } = await openSession(agent);
      const answer = agent.request(v2.methods.agent.session.prompt, {
        sessionId: response.sessionId,
        prompt: PROMPT,
      });
      const prompt = await claude.prompt(0);
      // As the bundled CLI sends it: `running` stays until the background
      // subagent ends and the turn that Claude Code starts on its own ends.
      claude.send(sessionState("running"));
      claude.send(lifecycle(prompt, "started"));
      claude.send(turnInit());
      await answer;
      claude.send(result({ result: "launched" }));
      claude.send(lifecycle(prompt, "completed"));
      await vi.waitFor(() => expect(client.states()).toEqual(["running", "idle"]));
      claude.send(turnInit());
      claude.send(result({ result: "The subagent finished." }));
      claude.send(sessionState("idle"));
      await vi.waitFor(() =>
        expect(client.states()).toEqual(["running", "idle", "running", "idle"]),
      );
    });
  });

  it("does not report a later turn as cancelled after a cancel that only ended queued prompts", async () => {
    const client = nativeClient();
    await client.connect(async (agent) => {
      const { response, claude } = await openSession(agent);
      const sessionId = response.sessionId;
      const first = agent.request(v2.methods.agent.session.prompt, { sessionId, prompt: PROMPT });
      const queued = await claude.prompt(0);
      await agent.notify(v2.methods.agent.session.cancel, { sessionId });
      await vi.waitFor(() => expect(claude.interrupt).toHaveBeenCalled());
      claude.send(lifecycle(queued, "cancelled"));
      await expect(first).rejects.toMatchObject({ code: -32800 });

      const second = agent.request(v2.methods.agent.session.prompt, { sessionId, prompt: PROMPT });
      const prompt = await claude.prompt(1);
      claude.send(lifecycle(prompt, "started"));
      await second;
      claude.send(result());
      await vi.waitFor(() => expect(client.states()).toEqual(["running", "idle"]));
    });

    expect(client.sessionUpdates.at(-1)).toMatchObject({ state: "idle", stopReason: "end_turn" });
  });

  it("pushes a prompt sent after session/cancel only once the interrupt is done", async () => {
    const client = nativeClient();
    await client.connect(async (agent) => {
      const { response, claude } = await openSession(agent);
      const sessionId = response.sessionId;
      let finishInterrupt = () => {};
      claude.interrupt.mockImplementationOnce(
        () => new Promise<void>((resolve) => (finishInterrupt = resolve)),
      );
      claude.send(turnInit());
      await vi.waitFor(() => expect(client.states()).toEqual(["running"]));
      await agent.notify(v2.methods.agent.session.cancel, { sessionId });
      await vi.waitFor(() => expect(claude.interrupt).toHaveBeenCalled());
      // Never answered: the test ends before Claude Code starts it.
      agent.request(v2.methods.agent.session.prompt, { sessionId, prompt: PROMPT }).catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(claude.prompts).toHaveLength(0);
      finishInterrupt();
      await claude.prompt(0);
    });
  });

  it("closes active work with its cancelled idle before the response, and nothing after", async () => {
    const client = nativeClient();
    let updatesAtResponse = 0;
    await client.connect(async (agent) => {
      const { response, claude } = await openSession(agent);
      const sessionId = response.sessionId;
      claude.send(turnInit());
      await vi.waitFor(() => expect(client.states()).toEqual(["running"]));
      claude.interrupt.mockImplementationOnce(async () => {
        claude.send(result({ subtype: "error_during_execution", is_error: true }));
      });
      await agent.request(v2.methods.agent.session.close, { sessionId });
      updatesAtResponse = client.sessionUpdates.length;
      claude.send(assistant("msg_late", [{ type: "text", text: "late" }]));
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    expect(client.sessionUpdates.at(-1)).toMatchObject({ state: "idle", stopReason: "cancelled" });
    expect(client.sessionUpdates).toHaveLength(updatesAtResponse);
  });

  it.each([
    ["session/close", v2.methods.agent.session.close],
    ["session/delete", v2.methods.agent.session.delete],
  ])("answers %s of a session that does not exist with an empty result", async (_, method) => {
    const client = nativeClient();
    const response = await client.connect(async (agent) => {
      await openSession(agent);
      return agent.request(method, { sessionId: randomUUID() });
    });

    expect(response).toEqual({});
  });

  it("rejects a config value whose type does not match the option", async () => {
    const client = nativeClient();
    const error = await client.connect(async (agent) => {
      const { response } = await openSession(agent);
      return agent
        .request(v2.methods.agent.session.setConfigOption, {
          sessionId: response.sessionId,
          configId: "mode",
          type: "boolean",
          value: true,
        } as v2.SetSessionConfigOptionRequest)
        .catch((error: unknown) => error);
    });

    expect(error).toMatchObject({ code: -32602 });
  });

  it("rejects additional directories that are not absolute", async () => {
    const client = nativeClient();
    const error = await client.connect(async (agent) => {
      await openSession(agent);
      return agent
        .request(v2.methods.agent.session.new, { cwd, additionalDirectories: ["src"] })
        .catch((error: unknown) => error);
    });

    expect(error).toMatchObject({ code: -32602 });
  });

  it("replays the stored history, then sends the state, before the resume response", async () => {
    vi.mocked(getSessionMessages).mockResolvedValueOnce([
      {
        type: "user",
        uuid: "u1",
        session_id: "s",
        parent_tool_use_id: null,
        parent_agent_id: null,
        message: { role: "user", content: "Fix the build" },
      },
      {
        type: "assistant",
        uuid: "a1",
        session_id: "s",
        parent_tool_use_id: null,
        parent_agent_id: null,
        message: { id: "msg_a", role: "assistant", content: [{ type: "text", text: "Done" }] },
      },
    ]);
    const client = nativeClient();
    const sessionId = randomUUID();
    await client.connect(async (agent) => {
      await agent.request(v2.methods.agent.initialize, {
        protocolVersion: v2.PROTOCOL_VERSION,
        info: { name: "native-test-client", version: "1.0.0" },
        capabilities: {},
      });
      await agent.request(v2.methods.agent.session.resume, {
        sessionId,
        cwd,
        replayFrom: { type: "start" },
      });
    });

    expect(sdk.processes[0].options.resume).toBe(sessionId);
    expect(client.sessionUpdates).toEqual([
      { sessionUpdate: "user_message", messageId: "u1", content: [] },
      {
        sessionUpdate: "user_message_chunk",
        messageId: "u1",
        content: { type: "text", text: "Fix the build" },
      },
      { sessionUpdate: "agent_message", messageId: "msg_a", content: [] },
      {
        sessionUpdate: "agent_message_chunk",
        messageId: "msg_a",
        content: { type: "text", text: "Done" },
      },
      // A snapshot, not a completion: no stop reason.
      { sessionUpdate: "state_update", state: "idle", background: [] },
    ]);
  });

  describe("subagents and background work", () => {
    it("announces a subagent before its traffic, and reports its runs on its own stream", async () => {
      const client = nativeClient();
      const agentId = "a7f0c1";
      const sessionId = await client.connect(async (agent) => {
        const { response, claude } = await openSession(agent);
        const child = subagent(agentId, "toolu_launch");
        claude.send(turnInit());
        claude.send(child.started());
        claude.send(child.prompt("Find why the test fails"));
        claude.send(child.says("It is a race."));
        claude.send(child.ended());
        await vi.waitFor(() =>
          expect(updatesOf(client.notifications, agentId).at(-1)).toMatchObject({
            sessionUpdate: "state_update",
            state: "idle",
          }),
        );
        return response.sessionId;
      });

      const parent = updatesOf(client.notifications, sessionId).filter(
        (update) => update.sessionUpdate === "subagent_update",
      );
      expect(parent).toEqual([
        {
          sessionUpdate: "subagent_update",
          sessionId: agentId,
          title: "Investigate the test",
          description: "general-purpose",
          capabilities: { cancel: {} },
        },
        {
          sessionUpdate: "subagent_update",
          sessionId: agentId,
          state: { state: "running", background: [] },
        },
        {
          sessionUpdate: "subagent_update",
          sessionId: agentId,
          state: { state: "idle", stopReason: "end_turn", background: [] },
        },
      ]);
      // The announcement comes before the child's first update.
      const announced = client.notifications.findIndex(
        (n) => n.update.sessionUpdate === "subagent_update",
      );
      const firstChild = client.notifications.findIndex((n) => n.sessionId === agentId);
      expect(announced).toBeLessThan(firstChild);
      expect(
        updatesOf(client.notifications, agentId).map((update) => update.sessionUpdate),
      ).toEqual(["state_update", "session_message", "agent_message_chunk", "state_update"]);
      expect(updatesOf(client.notifications, agentId)[1]).toMatchObject({
        senderSessionId: sessionId,
        recipientSessionId: agentId,
        content: [{ type: "text", text: "Find why the test fails" }],
      });
    });

    it("lists a background subagent while it works, after the turn's idle", async () => {
      const client = nativeClient();
      const agentId = "a5966d";
      const sessionId = await client.connect(async (agent) => {
        const { response, claude } = await openSession(agent);
        const child = subagent(agentId, "toolu_bg_agent", { is_backgrounded: true });
        claude.send(turnInit());
        claude.send({
          type: "system",
          subtype: "background_tasks_changed",
          tasks: [{ task_id: agentId, task_type: "local_agent", description: "sleeper" }],
          uuid: randomUUID(),
        });
        claude.send(child.started());
        claude.send(result({ result: "launched" }));
        // The list changes while the turn runs: the state goes out again with it.
        await vi.waitFor(() => expect(client.states()).toEqual(["running", "running", "idle"]));
        claude.send(child.ended());
        await vi.waitFor(() =>
          expect(client.states()).toEqual(["running", "running", "idle", "idle"]),
        );
        return response.sessionId;
      });

      const states = updatesOf(client.notifications, sessionId).filter(
        (update) => update.sessionUpdate === "state_update",
      );
      // The turn ends at its result, with the subagent still working.
      expect(states[2]).toMatchObject({
        state: "idle",
        stopReason: "end_turn",
        background: [{ type: "subagent", sessionId: agentId }],
      });
      // Its end drops it: a repeated idle without a stop reason, after the child's own idle.
      expect(states[3]).toEqual({ sessionUpdate: "state_update", state: "idle", background: [] });
      const childIdle = client.notifications.findIndex(
        (n) =>
          n.sessionId === agentId &&
          n.update.sessionUpdate === "state_update" &&
          n.update.state === "idle",
      );
      expect(childIdle).toBeLessThan(
        client.notifications.lastIndexOf(client.notifications.find((n) => n.update === states[3])!),
      );
    });

    it("announces a nested subagent on its parent subagent's stream", async () => {
      const client = nativeClient();
      await client.connect(async (agent) => {
        const { claude } = await openSession(agent);
        claude.send(turnInit());
        claude.send(subagent("outer", "toolu_outer").started());
        claude.send(subagent("inner", "toolu_inner", { parent_task_id: "outer" }).started());
        await vi.waitFor(() =>
          expect(updatesOf(client.notifications, "outer")).toContainEqual(
            expect.objectContaining({ sessionUpdate: "subagent_update", sessionId: "inner" }),
          ),
        );
      });
    });

    it("asks a subagent's permission on its session, and blocks the work that waits on it", async () => {
      let answer = (_: v2.RequestPermissionResponse) => {};
      const client = nativeClient({
        answerPermission: () => new Promise((resolve) => (answer = resolve)),
      });
      await client.connect(async (agent) => {
        const { claude } = await openSession(agent);
        claude.send(turnInit());
        claude.send(subagent("child", "toolu_launch").started());
        await vi.waitFor(() => expect(client.states()).toEqual(["running"]));
        const decision = claude.options.canUseTool!(
          "Bash",
          { command: "rm -rf build" },
          {
            signal: new AbortController().signal,
            toolUseID: "toolu_rm",
            requestId: "r1",
            suggestions: [],
            agentID: "child",
          },
        );
        await vi.waitFor(() => expect(client.permissionRequests).toHaveLength(1));
        expect(client.permissionRequests[0].sessionId).toBe("child");
        // The parent's turn waits on the foreground subagent, which waits on the user.
        await vi.waitFor(() => expect(client.states()).toEqual(["running", "requires_action"]));
        expect(updatesOf(client.notifications, "child").at(-1)).toMatchObject({
          state: "requires_action",
        });
        answer({
          outcome: {
            outcome: "selected",
            optionId: client.permissionRequests[0].options[0].optionId,
          },
        });
        await decision;
        await vi.waitFor(() =>
          expect(client.states()).toEqual(["running", "requires_action", "running"]),
        );
      });
    });

    it("stops a subagent's run on session/cancel of its session, and leaves the parent's work alone", async () => {
      const client = nativeClient();
      await client.connect(async (agent) => {
        const { claude } = await openSession(agent);
        claude.send(turnInit());
        claude.send(subagent("child", "toolu_launch", { is_backgrounded: true }).started());
        await vi.waitFor(() =>
          expect(updatesOf(client.notifications, "child")).toContainEqual(
            expect.objectContaining({ state: "running" }),
          ),
        );
        await agent.notify(v2.methods.agent.session.cancel, { sessionId: "child" });
        await vi.waitFor(() => expect(claude.stopTask).toHaveBeenCalledWith("child"));
        expect(claude.interrupt).not.toHaveBeenCalled();
        claude.send(subagent("child", "toolu_launch").ended("stopped"));
        await vi.waitFor(() =>
          expect(updatesOf(client.notifications, "child").at(-1)).toMatchObject({
            state: "idle",
            stopReason: "cancelled",
          }),
        );
      });
    });

    it.each([
      ["session/prompt", v2.methods.agent.session.prompt, { prompt: PROMPT }],
      ["session/close", v2.methods.agent.session.close, {}],
    ])("rejects %s on a subagent's session", async (_, method, params) => {
      const client = nativeClient();
      const error = await client.connect(async (agent) => {
        const { claude } = await openSession(agent);
        claude.send(turnInit());
        claude.send(subagent("child", "toolu_launch").started());
        await vi.waitFor(() =>
          expect(client.notifications.some((n) => n.sessionId === "child")).toBe(true),
        );
        return agent
          .request(
            method as typeof v2.methods.agent.session.close,
            {
              sessionId: "child",
              ...params,
            } as v2.CloseSessionRequest,
          )
          .catch((error: unknown) => error);
      });

      expect(error).toMatchObject({ code: -32602 });
    });

    it("keeps a background command's terminal running and listed until its task ends", async () => {
      const client = nativeClient();
      const sessionId = await client.connect(async (agent) => {
        const { response, claude } = await openSession(agent);
        claude.send(turnInit());
        claude.send(
          assistant("msg_bash", [
            {
              type: "tool_use",
              id: "toolu_bg",
              name: "Bash",
              input: { command: "make test", run_in_background: true },
            },
          ]),
        );
        claude.send({
          type: "system",
          subtype: "task_started",
          task_id: "bg1",
          task_type: "local_bash",
          description: "make test",
          tool_use_id: "toolu_bg",
          is_backgrounded: true,
          uuid: randomUUID(),
        });
        claude.send({
          type: "system",
          subtype: "background_tasks_changed",
          tasks: [{ task_id: "bg1", task_type: "local_bash", description: "make test" }],
          uuid: randomUUID(),
        });
        claude.send({
          type: "user",
          message: {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "toolu_bg",
                content: "Command running in background with ID: bg1.",
              },
            ],
          },
          tool_use_result: { stdout: "", stderr: "", interrupted: false, backgroundTaskId: "bg1" },
          parent_tool_use_id: null,
          uuid: randomUUID(),
        });
        claude.send(result());
        await vi.waitFor(() => expect(client.states()).toEqual(["running", "running", "idle"]));
        claude.send({
          type: "system",
          subtype: "task_notification",
          task_id: "bg1",
          tool_use_id: "toolu_bg",
          status: "completed",
          output_file: "",
          summary: "",
          uuid: randomUUID(),
        });
        await vi.waitFor(() =>
          expect(client.states()).toEqual(["running", "running", "idle", "idle"]),
        );
        return response.sessionId;
      });

      const trace = updatesOf(client.notifications, sessionId).flatMap((update) =>
        update.sessionUpdate === "terminal_update"
          ? [update.exitStatus ? "exit" : "terminal"]
          : update.sessionUpdate === "state_update"
            ? [`${update.state} ${JSON.stringify(update.background)}`]
            : [],
      );
      expect(trace.filter((entry) => entry !== "terminal")).toEqual([
        "running []",
        'running [{"terminalId":"toolu_bg","type":"terminal"}]',
        'idle [{"terminalId":"toolu_bg","type":"terminal"}]',
        "exit",
        "idle []",
      ]);
    });
  });

  it("reads which v2 core to serve from CLAUDE_AGENT_ACP_V2_CORE", () => {
    expect(v2CoreFromEnv(undefined)).toBe("bridge");
    expect(v2CoreFromEnv("")).toBe("bridge");
    expect(v2CoreFromEnv("native")).toBe("native");
    expect(() => v2CoreFromEnv("v2")).toThrow(/CLAUDE_AGENT_ACP_V2_CORE/);
  });
});
