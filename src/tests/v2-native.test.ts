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
  getSessionInfo,
  getSessionMessages,
  type Options,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { acpProtocolRouter, v2CoreFromEnv } from "../serve.js";
import { SettingsManager } from "../settings.js";
import type { AgentHandle } from "../v2-native/agent.js";
import { StoppedWork } from "../v2-native/stopped-work.js";

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

const DEFAULT_MODELS: Array<Record<string, unknown>> = [
  { value: "default", displayName: "Default", description: "Recommended" },
  { value: "opus", displayName: "Opus", description: "Most capable" },
];

const sdk = vi.hoisted(() => ({
  processes: [] as FakeClaudeCode[],
  models: [] as Array<Record<string, unknown>>,
  /** What `mcpServerStatus` reports. */
  mcpServers: [] as Array<{ name: string; status: string }>,
  /** The subagents of the session's transcript, by the id of their launch call. */
  subagents: new Map<string, Record<string, unknown>>(),
  /** When set, a permission request's patch preview waits for it. */
  previewGate: undefined as Promise<void> | undefined,
  /** When set, Claude Code fails to start with it. */
  startFailure: undefined as Error | undefined,
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
        initializationResult: async () => {
          if (sdk.startFailure) throw sdk.startFailure;
          return { models: sdk.models };
        },
        supportedCommands: async () => [
          { name: "review", description: "Review a change", argumentHint: "<pull request>" },
        ],
        interrupt: fake.interrupt,
        setPermissionMode: fake.setPermissionMode,
        setModel: fake.setModel,
        stopTask: fake.stopTask,
        close: fake.close,
        mcpServerStatus: async () => sdk.mcpServers,
        // A server that needs OAuth: Claude Code returns its authorization URL.
        mcpAuthenticate: async () => ({
          authUrl: "https://mcp.example.com/authorize",
          requiresUserAction: true,
          callbackExpected: true,
        }),
      });
    },
    getSessionMessages: vi.fn(async () => []),
    getSessionInfo: vi.fn(async () => undefined),
    forkSession: vi.fn(async () => ({ sessionId: globalThis.crypto.randomUUID() })),
  };
});

vi.mock("../diff.js", async () => {
  const actual = await vi.importActual<typeof import("../diff.js")>("../diff.js");
  return {
    ...actual,
    previewPatchContent: async (...args: Parameters<typeof actual.previewPatchContent>) => {
      await sdk.previewGate;
      return actual.previewPatchContent(...args);
    },
  };
});

// The subagents that a replayed transcript launched, as their metadata files name them.
vi.mock("../subagent-history.js", async () => ({
  ...(await vi.importActual<typeof import("../subagent-history.js")>("../subagent-history.js")),
  subagentHistory: vi.fn(async () => ({ agents: sdk.subagents })),
  readSubagentMessages: vi.fn(async () => []),
}));

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
  sdk.mcpServers = [];
  sdk.models = DEFAULT_MODELS;
  sdk.subagents = new Map();
  sdk.previewGate = undefined;
  sdk.startFailure = undefined;
});

afterEach(async () => {
  await Promise.all(agents.splice(0).map((agent) => agent.dispose()));
  vi.unstubAllEnvs();
  await rm(tempDir, { recursive: true, force: true, maxRetries: 10 });
});

/** A v2 client of the native core that records the session updates it receives. */
function nativeClient({
  answerPermission = () => ({ outcome: { outcome: "cancelled" } }),
  answerElicitation = () => ({ action: "cancel" }),
}: {
  answerPermission?: (
    request: v2.RequestPermissionRequest,
  ) => v2.RequestPermissionResponse | Promise<v2.RequestPermissionResponse>;
  /** `signal` aborts when the agent cancels the request. */
  answerElicitation?: (
    request: v2.CreateElicitationRequest,
    signal: AbortSignal,
  ) => v2.CreateElicitationResponse | Promise<v2.CreateElicitationResponse>;
} = {}) {
  const sessionUpdates: v2.SessionUpdate[] = [];
  const notifications: v2.UpdateSessionNotification[] = [];
  const permissionRequests: v2.RequestPermissionRequest[] = [];
  const elicitations: v2.CreateElicitationRequest[] = [];
  /** The ids of the `elicitation/complete` notifications. */
  const completedElicitations: string[] = [];
  const app = v2
    .client({ name: "native-test-client" })
    .onNotification(v2.methods.client.session.update, ({ params }) => {
      notifications.push(params);
      sessionUpdates.push(params.update);
    })
    .onRequest(v2.methods.client.session.requestPermission, ({ params }) => {
      permissionRequests.push(params);
      return answerPermission(params);
    })
    .onRequest(v2.methods.client.elicitation.create, ({ params, signal }) => {
      elicitations.push(params);
      return answerElicitation(params, signal);
    })
    .onNotification(v2.methods.client.elicitation.complete, ({ params }) => {
      completedElicitations.push(params.elicitationId);
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
    elicitations,
    completedElicitations,
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

/**
 * The first output of a turn: the `message_start` of its model's stream. It
 * opens a turn that no prompt started, such as after a background task ends.
 */
function cycleStart() {
  return {
    type: "stream_event",
    event: { type: "message_start", message: { id: `msg_${randomUUID()}`, content: [] } },
    parent_tool_use_id: null,
    uuid: randomUUID(),
  };
}

function textDelta(id: string, text: string) {
  return [
    {
      type: "stream_event",
      event: {
        type: "message_start",
        message: {
          id,
          role: "assistant",
          content: [],
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      },
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
    total_cost_usd: 0,
    modelUsage: {},
    uuid: randomUUID(),
    ...overrides,
  };
}

const PROMPT = [{ type: "text" as const, text: "Hi" }];

/** Claude Code's permission check of a tool use (`canUseTool`), with `fields` of its options. */
function askPermission(
  claude: FakeClaudeCode,
  toolName: string,
  input: Record<string, unknown>,
  fields: Record<string, unknown> = {},
) {
  return claude.options.canUseTool!(toolName, input, {
    signal: new AbortController().signal,
    toolUseID: "toolu_ask",
    requestId: "r1",
    suggestions: [],
    ...fields,
  } as Parameters<NonNullable<Options["canUseTool"]>>[2]);
}

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
    /** The Agent call that launches it, made by the root or by the agent of `parent`. */
    launch: (parent: string | null = null) => ({
      ...assistant(`msg_${launch}`, [
        {
          type: "tool_use",
          id: launch,
          name: "Agent",
          input: {
            description: "Investigate the test",
            prompt: "Find why the test fails",
            subagent_type: "general-purpose",
            ...(fields.is_backgrounded === true ? { run_in_background: true } : {}),
          },
        },
      ]),
      parent_tool_use_id: parent,
    }),
    started: (more: Record<string, unknown> = {}) =>
      system("task_started", {
        tool_use_id: launch,
        task_type: "local_agent",
        subagent_type: "general-purpose",
        description: "Investigate the test",
        prompt: "Find why the test fails",
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

  describe("a provider change of live sessions", () => {
    const setProvider = (agent: v2.ClientContext) =>
      agent.request(v2.methods.agent.providers.set, {
        providerId: "main",
        apiType: "anthropic",
        baseUrl: "https://gateway.example.com",
      });

    it("restarts the query only once the background subagents ended", async () => {
      const client = nativeClient();
      await client.connect(async (agent) => {
        const { response, claude } = await openSession(agent);
        void agent.request(v2.methods.agent.session.prompt, {
          sessionId: response.sessionId,
          prompt: PROMPT,
        });
        const prompt = await claude.prompt(0);
        claude.send(lifecycle(prompt, "started"));
        const helper = subagent("agent-1", "toolu_agent", { is_backgrounded: true });
        claude.send(helper.launch());
        claude.send(helper.started());
        claude.send(result());
        await vi.waitFor(() => expect(client.states().at(-1)).toBe("idle"));
        let switched = false;
        const set = setProvider(agent).then(() => (switched = true));
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(switched).toBe(false);
        expect(sdk.processes).toHaveLength(1);

        claude.send(helper.ended());
        await set;
        expect(sdk.processes).toHaveLength(2);
        expect(claude.close).toHaveBeenCalled();
        expect(sdk.processes[1].options).toMatchObject({ resume: response.sessionId });
      });
    });

    it("answers a prompt that waits for the restart with -32800 on session/cancel", async () => {
      const client = nativeClient();
      await client.connect(async (agent) => {
        const { response, claude } = await openSession(agent);
        const sessionId = response.sessionId;
        void agent.request(v2.methods.agent.session.prompt, { sessionId, prompt: PROMPT });
        claude.send(lifecycle(await claude.prompt(0), "started"));
        const set = setProvider(agent);
        const waiting = agent.request(v2.methods.agent.session.prompt, {
          sessionId,
          prompt: [{ type: "text", text: "next" }],
        });
        await new Promise((resolve) => setTimeout(resolve, 20));
        await agent.notify(v2.methods.agent.session.cancel, { sessionId });
        await expect(waiting).rejects.toMatchObject({ code: -32800 });

        claude.send(result({ subtype: "error_during_execution", is_error: true }));
        await set;
        // The cancelled prompt never reached either query.
        expect(claude.prompts).toHaveLength(1);
        expect(sdk.processes[1].prompts).toHaveLength(0);
      });
    });

    it("ends a session whose query does not start again under the new route", async () => {
      const client = nativeClient();
      await client.connect(async (agent) => {
        const { response } = await openSession(agent);
        sdk.startFailure = new Error("Claude Code could not start");
        await setProvider(agent);
        await expect(
          agent.request(v2.methods.agent.session.prompt, {
            sessionId: response.sessionId,
            prompt: PROMPT,
          }),
        ).rejects.toMatchObject({ code: -32002 });
      });
    });
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
    expect(kinds).toEqual([
      "user_message",
      "state_update",
      // The context window at the response's `message_start`, then at the result.
      "usage_update",
      "agent_message_chunk",
      "usage_update",
      "state_update",
    ]);
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
      // As on the bridge: the turn's tokens, and its rows by model.
      _meta: {
        quota: {
          token_count: {
            totalTokens: 6,
            inputTokens: 3,
            cachedInputTokens: 1,
            cachedWriteTokens: 0,
            outputTokens: 2,
            reasoningOutputTokens: 0,
          },
          model_usage: [],
        },
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
      const queued = agent
        .request(v2.methods.agent.session.prompt, { sessionId, prompt: PROMPT })
        .catch((error: unknown) => error);
      const waiting = await claude.prompt(1);

      await agent.notify(v2.methods.agent.session.cancel, { sessionId });
      // The cancel answers the queued prompt at once.
      expect(await queued).toMatchObject({ code: -32800 });
      await vi.waitFor(() => expect(claude.interrupt).toHaveBeenCalledWith({ cancelQueued: true }));
      // Claude Code ends the queued prompt, then the interrupted work.
      claude.send(lifecycle(waiting, "cancelled"));
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
      claude.send(cycleStart());
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

  it("sends the title that Claude Code stored, once its session state is idle", async () => {
    const client = nativeClient();
    await client.connect(async (agent) => {
      const { response, claude } = await openSession(agent);
      vi.mocked(getSessionInfo).mockResolvedValueOnce({
        sessionId: response.sessionId,
        summary: "Hi",
        customTitle: "Greet the user",
        lastModified: Date.UTC(2026, 9, 2),
      });
      const answer = agent.request(v2.methods.agent.session.prompt, {
        sessionId: response.sessionId,
        prompt: PROMPT,
      });
      const prompt = await claude.prompt(0);
      claude.send(lifecycle(prompt, "started"));
      await answer;
      claude.send(result());
      claude.send(sessionState("idle"));
      await vi.waitFor(() =>
        expect(client.sessionUpdates.at(-1)).toEqual({
          sessionUpdate: "session_info_update",
          title: "Greet the user",
          updatedAt: "2026-10-02T00:00:00.000Z",
        }),
      );
    });
  });

  it("reports a client MCP server that failed to start as a notice, once", async () => {
    const client = nativeClient();
    await client.connect(async (agent) => {
      await agent.request(v2.methods.agent.initialize, {
        protocolVersion: v2.PROTOCOL_VERSION,
        info: { name: "native-test-client", version: "1.0.0" },
        capabilities: {},
      });
      await agent.request(v2.methods.agent.session.new, {
        cwd,
        mcpServers: [{ type: "stdio", name: "files", command: "/usr/local/bin/mcp-files" }],
      });
      const claude = sdk.processes.at(-1)!;
      // Each turn's init lists the servers; one that is not the client's is not reported.
      for (let turn = 0; turn < 2; turn++) {
        claude.send({
          type: "system",
          subtype: "init",
          uuid: randomUUID(),
          mcp_servers: [
            { name: "files", status: "failed" },
            { name: "plugin", status: "failed" },
          ],
        });
        claude.send(result());
      }
      await vi.waitFor(() =>
        expect(client.states()).toEqual(["running", "idle", "running", "idle"]),
      );
    });

    expect(client.sessionUpdates.filter((update) => update.sessionUpdate === "notice")).toEqual([
      {
        sessionUpdate: "notice",
        severity: "warning",
        title: 'MCP server "files" failed to start',
        description: "Its tools are unavailable in this session. Run /mcp for the error.",
      },
    ]);
  });

  it("replaces Claude Code's text of /mcp with the server list, before the turn's idle", async () => {
    const client = nativeClient();
    sdk.mcpServers = [{ name: "linear", status: "connected" }];
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
      claude.send(cycleStart());
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
      claude.send(cycleStart());
      await answer;
      claude.send(result({ result: "launched" }));
      claude.send(lifecycle(prompt, "completed"));
      await vi.waitFor(() => expect(client.states()).toEqual(["running", "idle"]));
      claude.send(cycleStart());
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
      const first = agent
        .request(v2.methods.agent.session.prompt, { sessionId, prompt: PROMPT })
        .catch((error: unknown) => error);
      const queued = await claude.prompt(0);
      await agent.notify(v2.methods.agent.session.cancel, { sessionId });
      expect(await first).toMatchObject({ code: -32800 });
      await vi.waitFor(() => expect(claude.interrupt).toHaveBeenCalled());
      claude.send(lifecycle(queued, "cancelled"));

      const second = agent.request(v2.methods.agent.session.prompt, { sessionId, prompt: PROMPT });
      const prompt = await claude.prompt(1);
      claude.send(lifecycle(prompt, "started"));
      await second;
      claude.send(result());
      await vi.waitFor(() => expect(client.states()).toEqual(["running", "idle"]));
    });

    expect(client.sessionUpdates.at(-1)).toMatchObject({ state: "idle", stopReason: "end_turn" });
  });

  it("drops the run of a prompt that a cancel answered after Claude Code took it in, and denies its tools", async () => {
    const client = nativeClient();
    const decision = await client.connect(async (agent) => {
      const { response, claude } = await openSession(agent);
      const sessionId = response.sessionId;
      const queued = agent
        .request(v2.methods.agent.session.prompt, { sessionId, prompt: PROMPT })
        .catch((error: unknown) => error);
      const prompt = await claude.prompt(0);
      await agent.notify(v2.methods.agent.session.cancel, { sessionId });
      expect(await queued).toMatchObject({ code: -32800 });
      // Claude Code had taken the prompt in before the interrupt arrived.
      claude.send(lifecycle(prompt, "started"));
      claude.send(
        assistant("msg_late", [
          { type: "tool_use", id: "toolu_late", name: "Bash", input: { command: "make" } },
        ]),
      );
      const decision = await claude.options.canUseTool!(
        "Bash",
        { command: "make" },
        {
          signal: new AbortController().signal,
          toolUseID: "toolu_late",
          requestId: "r1",
          suggestions: [],
        },
      );
      claude.send(result());
      claude.send(sessionState("idle"));
      // A later cycle shows that the session goes on.
      claude.send(cycleStart());
      claude.send(result());
      await vi.waitFor(() => expect(client.states()).toEqual(["running", "idle"]));
      return decision;
    });

    expect(decision).toEqual({ behavior: "deny", message: "The user cancelled this prompt." });
    expect(client.permissionRequests).toEqual([]);
    expect(
      client.sessionUpdates.filter(
        (update) => update.sessionUpdate === "user_message" || "toolCallId" in update,
      ),
    ).toEqual([]);
  });

  it("ends a turn cancelled when a cancel comes while an approved plan waits for its fresh context", async () => {
    const client = nativeClient({
      answerPermission: () => ({
        outcome: { outcome: "selected", optionId: "exit-plan-clear-auto" },
      }),
    });
    await client.connect(async (agent) => {
      const { response, claude } = await openSession(agent);
      const sessionId = response.sessionId;
      const prompted = agent.request(v2.methods.agent.session.prompt, {
        sessionId,
        prompt: PROMPT,
      });
      claude.send(echo(await claude.prompt(0)));
      await prompted;
      claude.send(
        assistant("msg_plan", [
          { type: "tool_use", id: "toolu_plan", name: "ExitPlanMode", input: { plan: "Do it" } },
        ]),
      );
      const decision = await askPermission(
        claude,
        "ExitPlanMode",
        { plan: "Do it" },
        { toolUseID: "toolu_plan" },
      );
      expect(decision).toMatchObject({ behavior: "deny", interrupt: true });
      claude.send({
        type: "user",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_plan",
              content: "User accepted the plan and requested a fresh context",
              is_error: true,
            },
          ],
        },
        tool_result_meta: [{ id: "toolu_plan", non_execution_kind: "user-rejected" }],
        parent_tool_use_id: null,
        uuid: randomUUID(),
      });
      claude.send(
        result({
          subtype: "error_during_execution",
          is_error: true,
          stop_reason: null,
          errors: ["[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=tool_use"],
        }),
      );
      claude.send(sessionState("idle"));
      // The turn goes on: the session sends `/clear` for the fresh context.
      const clear = await claude.prompt(1);
      expect(clear.message.content).toEqual([{ type: "text", text: "/clear" }]);
      expect(client.states()).toEqual(["running", "requires_action", "running"]);
      await agent.notify(v2.methods.agent.session.cancel, { sessionId });
      await vi.waitFor(() =>
        expect(client.states()).toEqual(["running", "requires_action", "running", "idle"]),
      );
      // Claude Code had taken `/clear` in before the interrupt: its run is dropped.
      claude.send(lifecycle(clear, "started"));
      claude.send(echo(clear));
      claude.send(result({ num_turns: 0, stop_reason: null }));
      claude.send(lifecycle(clear, "completed"));
      claude.send(sessionState("idle"));
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    expect(
      client.sessionUpdates.filter((update) => update.sessionUpdate === "state_update").at(-1),
    ).toMatchObject({ state: "idle", stopReason: "cancelled" });
    expect(client.states()).toEqual(["running", "requires_action", "running", "idle"]);
    // No plan's prompt went out after the cancel.
    expect(sdk.processes[0].prompts).toHaveLength(2);
  });

  it("ends a cycle at its own result, not at a placeholder or at the idle of the turn before", async () => {
    const client = nativeClient();
    await client.connect(async (agent) => {
      const { claude } = await openSession(agent);
      claude.send(cycleStart());
      claude.send(result());
      // The turn's idle comes after the next cycle started.
      claude.send(cycleStart());
      claude.send(sessionState("idle"));
      const followup = { origin: { kind: "task-notification" } };
      claude.send(result({ ...followup, num_turns: 0 }));
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(client.states()).toEqual(["running", "idle", "running"]);
      claude.send(result({ ...followup, num_turns: 1 }));
      await vi.waitFor(() =>
        expect(client.states()).toEqual(["running", "idle", "running", "idle"]),
      );
    });
  });

  it("reports a tool call that Claude dropped before it ran as cancelled at the turn's end", async () => {
    const client = nativeClient();
    await client.connect(async (agent) => {
      const { claude } = await openSession(agent);
      claude.send({
        type: "stream_event",
        event: {
          type: "content_block_start",
          index: 0,
          content_block: { type: "tool_use", id: "toolu_dropped", name: "Bash", input: {} },
        },
        parent_tool_use_id: null,
        uuid: randomUUID(),
      });
      claude.send(result());
      await vi.waitFor(() => expect(client.states()).toEqual(["running", "idle"]));
    });

    expect(client.sessionUpdates.slice(-2)).toMatchObject([
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "toolu_dropped",
        status: "cancelled",
        content: [
          {
            type: "content",
            content: { type: "text", text: "Claude stopped this tool call before it ran." },
          },
        ],
      },
      { state: "idle", stopReason: "end_turn" },
    ]);
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
      claude.send(cycleStart());
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
      claude.send(cycleStart());
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

  it("replays a compaction's summary message as the completed compaction, at its place", async () => {
    const entry = (uuid: string, message: unknown, fields: Record<string, unknown> = {}) => ({
      type: "user",
      uuid,
      session_id: "s",
      parent_tool_use_id: null,
      parent_agent_id: null,
      message,
      ...fields,
    });
    vi.mocked(getSessionMessages).mockResolvedValueOnce([
      entry("u1", { role: "user", content: "Count" }),
      // Claude Code's framing of the summary that it keeps.
      entry(
        "summary",
        {
          role: "user",
          content:
            "This session is being continued from a previous conversation that ran out of context.\n\n" +
            "Summary:\nCount upward.\n\n" +
            "Continue the conversation from where it left off without asking the user any further questions.",
        },
        { isCompactSummary: true },
      ),
      entry("u2", { role: "user", content: "Go on" }),
    ] as never);
    const client = nativeClient();
    await client.connect(async (agent) => {
      await agent.request(v2.methods.agent.initialize, {
        protocolVersion: v2.PROTOCOL_VERSION,
        info: { name: "native-test-client", version: "1.0.0" },
        capabilities: {},
      });
      await agent.request(v2.methods.agent.session.resume, {
        sessionId: randomUUID(),
        cwd,
        replayFrom: { type: "start" },
      });
    });

    expect(
      client.sessionUpdates
        .filter((update) => !update.sessionUpdate.endsWith("_chunk"))
        .slice(0, 3),
    ).toEqual([
      { sessionUpdate: "user_message", messageId: "u1", content: [] },
      {
        sessionUpdate: "compaction_update",
        compactionId: "summary",
        status: "completed",
        summary: [{ type: "text", text: "Count upward." }],
      },
      { sessionUpdate: "user_message", messageId: "u2", content: [] },
    ]);
  });

  it.each([
    [
      "a prompt that Claude Code started after the cancel answered it",
      ["result", "started", "cancelled", "late"],
    ],
    ["the turn that a cancelled frame closed", ["cancelled", "late"]],
  ])("skips the late result of a dead turn: %s", async (_, events) => {
    const client = nativeClient();
    await client.connect(async (agent) => {
      const { response, claude } = await openSession(agent);
      const sessionId = response.sessionId;
      const first = agent.request(v2.methods.agent.session.prompt, { sessionId, prompt: PROMPT });
      const p1 = await claude.prompt(0);
      claude.send(lifecycle(p1, "started"));
      await first;
      const second = agent
        .request(v2.methods.agent.session.prompt, { sessionId, prompt: PROMPT })
        .catch((error: unknown) => error);
      const p2 = await claude.prompt(1);
      await agent.notify(v2.methods.agent.session.cancel, { sessionId });
      expect(await second).toMatchObject({ code: -32800 });
      for (const event of events) {
        if (event === "result") {
          claude.send(
            result({
              subtype: "error_during_execution",
              is_error: true,
              terminal_reason: "aborted_streaming",
            }),
          );
          claude.send(sessionState("idle"));
        } else if (event === "started") {
          claude.send(lifecycle(p2, "started"));
        } else if (event === "cancelled") {
          claude.send(lifecycle(events.includes("started") ? p2 : p1, "cancelled"));
        } else {
          // The dead turn's late result.
          claude.send(
            result({
              subtype: "error_during_execution",
              is_error: true,
              terminal_reason: "aborted_streaming",
            }),
          );
          claude.send(sessionState("idle"));
        }
      }
      // A later cycle shows that the session went on.
      claude.send(cycleStart());
      claude.send(result());
      await vi.waitFor(() =>
        expect(client.states()).toEqual(["running", "idle", "running", "idle"]),
      );
    });

    const idles = client.sessionUpdates.filter(
      (update) => update.sessionUpdate === "state_update" && update.state === "idle",
    );
    expect(idles.map((idle) => (idle as { stopReason?: string }).stopReason)).toEqual([
      "cancelled",
      "end_turn",
    ]);
  });

  it("keeps dropping a prompt's run when another abandoned prompt's cancelled frame comes", async () => {
    const client = nativeClient();
    await client.connect(async (agent) => {
      const { response, claude } = await openSession(agent);
      const sessionId = response.sessionId;
      const ask = () =>
        agent
          .request(v2.methods.agent.session.prompt, { sessionId, prompt: PROMPT })
          .catch((error: unknown) => error);
      const [b, c] = [ask(), ask()];
      const [promptB, promptC] = [await claude.prompt(0), await claude.prompt(1)];
      await agent.notify(v2.methods.agent.session.cancel, { sessionId });
      expect(await b).toMatchObject({ code: -32800 });
      expect(await c).toMatchObject({ code: -32800 });
      // Claude Code had taken B in. The interrupt's `cancelQueued` ends C.
      claude.send(lifecycle(promptB, "started"));
      claude.send(lifecycle(promptC, "cancelled"));
      for (const event of textDelta("msg_b", "B runs")) claude.send(event);
      claude.send(
        result({
          subtype: "error_during_execution",
          is_error: true,
          terminal_reason: "aborted_streaming",
        }),
      );
      claude.send(lifecycle(promptB, "completed"));
      claude.send(sessionState("idle"));
      claude.send(cycleStart());
      claude.send(result());
      await vi.waitFor(() => expect(client.states()).toEqual(["running", "idle"]));
    });

    expect(
      client.sessionUpdates.filter((update) => update.sessionUpdate === "agent_message_chunk"),
    ).toEqual([]);
    expect(client.sessionUpdates.at(-1)).toMatchObject({ state: "idle", stopReason: "end_turn" });
  });

  it("sends no permission request of a session after session/close answered", async () => {
    const client = nativeClient();
    const decision = await client.connect(async (agent) => {
      const { response, claude } = await openSession(agent);
      await agent.request(v2.methods.agent.session.close, { sessionId: response.sessionId });
      // Claude Code asks while its process ends.
      return askPermission(claude, "Bash", { command: "ls" });
    });

    expect(client.permissionRequests).toEqual([]);
    expect(decision).toMatchObject({ behavior: "deny" });
  });

  it("does not show Claude Code's sign-in message, and fails the turn with authRequired", async () => {
    const client = nativeClient();
    await client.connect(async (agent) => {
      const { claude } = await openSession(agent);
      claude.send(cycleStart());
      claude.send({
        ...assistant("msg_login", [{ type: "text", text: "Not logged in · Please run /login" }]),
        message: {
          id: "msg_login",
          type: "message",
          role: "assistant",
          model: "<synthetic>",
          content: [{ type: "text", text: "Not logged in · Please run /login" }],
          usage: {},
        },
        error: "authentication_failed",
      });
      claude.send(result({ is_error: true, result: "Not logged in · Please run /login" }));
      await vi.waitFor(() => expect(client.states()).toEqual(["running", "idle"]));
    });

    expect(
      client.sessionUpdates.filter((update) => update.sessionUpdate === "agent_message_chunk"),
    ).toEqual([]);
    expect(client.sessionUpdates.at(-1)).toMatchObject({
      state: "idle",
      stopReason: "error",
      error: { code: -32000 },
    });
  });

  it.each([
    [
      "an authentication failure as authRequired",
      "authentication_failed",
      "Failed to authenticate. API Error: 401",
      { code: -32000 },
    ],
    [
      "another failure with its error kind",
      "rate_limit",
      "API Error: 429",
      { code: -32603, data: { errorKind: "rate_limit" } },
    ],
  ])("reports %s, from the assistant message's error", async (_, kind, text, error) => {
    const client = nativeClient();
    await client.connect(async (agent) => {
      const { claude } = await openSession(agent);
      claude.send(cycleStart());
      claude.send({ ...assistant("msg_failed", [{ type: "text", text }]), error: kind });
      claude.send(result({ is_error: true, result: text }));
      await vi.waitFor(() => expect(client.states()).toEqual(["running", "idle"]));
    });

    expect(client.sessionUpdates.at(-1)).toMatchObject({
      state: "idle",
      stopReason: "error",
      error,
    });
  });

  it.each([
    [
      "an error at the turn limit",
      { subtype: "error_max_turns", is_error: true, errors: ["a", "b"] },
      { stopReason: "error", error: { message: "Internal error: a, b" } },
    ],
    [
      "a run that is no error",
      { subtype: "error_during_execution", is_error: false },
      { stopReason: "end_turn" },
    ],
    [
      "the budget limit",
      { subtype: "error_max_budget_usd", is_error: false },
      { stopReason: "max_turn_requests" },
    ],
  ])("reads %s from the result as the v1 core does", async (_, fields, expected) => {
    const client = nativeClient();
    await client.connect(async (agent) => {
      const { claude } = await openSession(agent);
      claude.send(cycleStart());
      claude.send(result(fields));
      await vi.waitFor(() => expect(client.states()).toEqual(["running", "idle"]));
    });

    expect(client.sessionUpdates.at(-1)).toMatchObject(expected);
  });

  it("answers a refusal with the explanation of model_refusal_no_fallback when the message has none", async () => {
    const client = nativeClient();
    await client.connect(async (agent) => {
      const { claude } = await openSession(agent);
      claude.send(cycleStart());
      claude.send({
        ...assistant("msg_refused", []),
        message: {
          id: "msg_refused",
          type: "message",
          role: "assistant",
          content: [],
          stop_reason: "refusal",
          usage: {},
        },
      });
      claude.send({
        type: "system",
        subtype: "model_refusal_no_fallback",
        original_model: "opus",
        request_id: null,
        api_refusal_explanation: "This request is declined.",
        refused_user_message_uuid: "u1",
        content: "Claude declined",
        uuid: randomUUID(),
        session_id: "session",
      });
      claude.send(result({ stop_reason: "refusal" }));
      await vi.waitFor(() => expect(client.states()).toEqual(["running", "idle"]));
    });

    expect(client.sessionUpdates.slice(-2)).toMatchObject([
      {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "This request is declined." },
      },
      { state: "idle", stopReason: "refusal" },
    ]);
  });

  it("denies the AskUserQuestion of a prompt that a cancel answered, without asking", async () => {
    const client = nativeClient();
    const decision = await client.connect(async (agent) => {
      const { response, claude } = await openSession(agent, { elicitation: { form: {} } });
      const sessionId = response.sessionId;
      const queued = agent
        .request(v2.methods.agent.session.prompt, { sessionId, prompt: PROMPT })
        .catch((error: unknown) => error);
      const prompt = await claude.prompt(0);
      await agent.notify(v2.methods.agent.session.cancel, { sessionId });
      expect(await queued).toMatchObject({ code: -32800 });
      claude.send(lifecycle(prompt, "started"));
      claude.send(
        assistant("msg_late", [
          { type: "tool_use", id: "toolu_ask", name: "AskUserQuestion", input: {} },
        ]),
      );
      return askPermission(claude, "AskUserQuestion", {
        questions: [
          {
            question: "Which?",
            header: "Which",
            options: [{ label: "a" }, { label: "b" }],
            multiSelect: false,
          },
        ],
      });
    });

    expect(decision).toEqual({ behavior: "deny", message: "The user cancelled this prompt." });
    expect(client.elicitations).toEqual([]);
  });

  it("runs auto as acceptEdits, with a notice, for a model that does not support it", async () => {
    sdk.models = [
      {
        value: "default",
        displayName: "Default",
        description: "Recommended",
        supportsAutoMode: true,
      },
      { value: "haiku", displayName: "Haiku", description: "Fast", supportsAutoMode: false },
    ];
    const client = nativeClient();
    const modes = await client.connect(async (agent) => {
      const { response, claude } = await openSession(agent);
      const sessionId = response.sessionId;
      const set = (configId: string, value: string) =>
        agent.request(v2.methods.agent.session.setConfigOption, {
          sessionId,
          configId,
          type: "id",
          value,
        } as v2.SetSessionConfigOptionRequest);
      await set("mode", "auto");
      // A switch to a model without Auto mode leaves it.
      const switched = await set("model", "haiku");
      const picked = await set("mode", "auto");
      return { claude, switched, picked };
    });

    const mode = (options: v2.SessionConfigOption[]) =>
      options.find((option) => option.configId === "mode")?.currentValue;
    expect(mode(modes.switched.configOptions)).toBe("acceptEdits");
    expect(mode(modes.picked.configOptions)).toBe("acceptEdits");
    expect(modes.claude.setPermissionMode).toHaveBeenLastCalledWith("acceptEdits");
    // Once per session.
    expect(client.sessionUpdates.filter((update) => update.sessionUpdate === "notice")).toEqual([
      expect.objectContaining({ title: "Auto mode unavailable" }),
    ]);
  });

  it("follows a model switch that Claude Code made without the adapter", async () => {
    const client = nativeClient();
    await client.connect(async (agent) => {
      const { claude } = await openSession(agent);
      const hook = claude.options.hooks?.PostModelSwitch?.at(-1)?.hooks[0];
      await hook!(
        {
          hook_event_name: "PostModelSwitch",
          source: "command",
          from_model: "default",
          to_model: "opus",
        } as never,
        undefined,
        { signal: new AbortController().signal },
      );
      await vi.waitFor(() =>
        expect(client.sessionUpdates.at(-1)).toMatchObject({
          sessionUpdate: "config_option_update",
        }),
      );
    });

    const update = client.sessionUpdates.at(-1) as { configOptions: v2.SessionConfigOption[] };
    expect(update.configOptions.find((option) => option.configId === "model")?.currentValue).toBe(
      "opus",
    );
  });

  it("names the MCP server of a tool in the permission request", async () => {
    const client = nativeClient();
    await client.connect(async (agent) => {
      const { claude } = await openSession(agent);
      await askPermission(
        claude,
        "mcp__docs__search",
        { query: "x" },
        {
          mcpServer: { name: "docs", source: "sdk" },
        },
      );
    });

    const subject = client.permissionRequests[0].subject as { toolCall: { _meta?: unknown } };
    expect(subject.toolCall._meta).toMatchObject({
      claudeCode: { mcpServer: { name: "docs", source: "sdk" } },
    });
  });

  it("lists bypass before auto in ExitPlanMode's options after plan mode left bypass", async () => {
    const client = nativeClient();
    await client.connect(async (agent) => {
      const { response, claude } = await openSession(agent);
      const sessionId = response.sessionId;
      for (const value of ["bypassPermissions", "plan"]) {
        await agent.request(v2.methods.agent.session.setConfigOption, {
          sessionId,
          configId: "mode",
          type: "id",
          value,
        } as v2.SetSessionConfigOptionRequest);
      }
      await askPermission(claude, "ExitPlanMode", { plan: "Fix it" });
    });

    expect(
      client.permissionRequests[0].options
        .map((option) => option.optionId)
        .filter((id) => id === "exit-plan-bypass" || id === "exit-plan-auto"),
    ).toEqual(["exit-plan-bypass", "exit-plan-auto"]);
  });

  it("disposes the settings of a session that fails to start", async () => {
    const initialized = vi.spyOn(SettingsManager.prototype, "initialize");
    const disposed = vi.spyOn(SettingsManager.prototype, "dispose");
    const client = nativeClient();
    const error = await client.connect(async (agent) => {
      await agent.request(v2.methods.agent.initialize, {
        protocolVersion: v2.PROTOCOL_VERSION,
        info: { name: "native-test-client", version: "1.0.0" },
        capabilities: {},
      });
      return agent
        .request(v2.methods.agent.session.new, {
          cwd,
          _meta: { claudeCode: { options: { settings: "missing.json" } } },
        })
        .catch((error: unknown) => error);
    });

    expect(error).toBeDefined();
    expect(disposed).toHaveBeenCalledTimes(initialized.mock.calls.length);
    initialized.mockRestore();
    disposed.mockRestore();
  });

  describe("subagents and background work", () => {
    it("announces a subagent before its traffic, and reports its runs on its own stream", async () => {
      const client = nativeClient();
      const agentId = "a7f0c1";
      const sessionId = await client.connect(async (agent) => {
        const { response, claude } = await openSession(agent);
        const child = subagent(agentId, "toolu_launch");
        claude.send(cycleStart());
        claude.send(child.launch());
        // Its first message can come before its `task_started`: it waits for the announcement.
        claude.send(child.prompt("Find why the test fails"));
        claude.send(child.started());
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

      // The parent is not shown the Agent call: the announcement, then the
      // call's prompt as the parent's message to the child.
      const parent = updatesOf(client.notifications, sessionId).filter(
        (update) =>
          update.sessionUpdate === "subagent_update" ||
          update.sessionUpdate === "session_message" ||
          update.sessionUpdate === "tool_call_update",
      );
      expect(parent).toEqual([
        {
          sessionUpdate: "subagent_update",
          sessionId: agentId,
          title: "Investigate the test",
          description: "general-purpose",
          capabilities: { cancel: {} },
          state: { state: "running", background: [] },
        },
        {
          sessionUpdate: "session_message",
          messageId: "toolu_launch",
          senderSessionId: sessionId,
          recipientSessionId: agentId,
          recipientMessageId: "toolu_launch",
          content: [{ type: "text", text: "Find why the test fails" }],
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
        senderMessageId: "toolu_launch",
        content: [{ type: "text", text: "Find why the test fails" }],
      });
    });

    it("lists a background subagent while it works, after the turn's idle", async () => {
      const client = nativeClient();
      const agentId = "a5966d";
      const sessionId = await client.connect(async (agent) => {
        const { response, claude } = await openSession(agent);
        const child = subagent(agentId, "toolu_bg_agent", { is_backgrounded: true });
        claude.send(cycleStart());
        claude.send(child.launch());
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
        claude.send(cycleStart());
        const inner = subagent("inner", "toolu_inner", { parent_task_id: "outer" });
        claude.send(subagent("outer", "toolu_outer").launch());
        claude.send(subagent("outer", "toolu_outer").started());
        claude.send(inner.launch("toolu_outer"));
        claude.send(inner.started());
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
        claude.send(cycleStart());
        claude.send(subagent("child", "toolu_launch").launch());
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
        claude.send(cycleStart());
        claude.send(subagent("child", "toolu_launch", { is_backgrounded: true }).launch());
        claude.send(subagent("child", "toolu_launch", { is_backgrounded: true }).started());
        await vi.waitFor(() =>
          expect(updatesOf(client.notifications, "child")).toContainEqual(
            expect.objectContaining({ state: "running" }),
          ),
        );
        claude.send({
          ...assistant("msg_child_bash", [
            { type: "tool_use", id: "toolu_child_bash", name: "Bash", input: { command: "make" } },
          ]),
          parent_tool_use_id: "toolu_launch",
        });
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

      // Its command ends before the idle that confirms the cancel, as v2 asks.
      const child = updatesOf(client.notifications, "child");
      const ended = child.findIndex(
        (update) =>
          update.sessionUpdate === "tool_call_update" &&
          update.toolCallId === "toolu_child_bash" &&
          update.status === "cancelled",
      );
      expect(ended).toBeGreaterThanOrEqual(0);
      expect(ended).toBeLessThan(child.length - 1);
    });

    it.each([
      ["failed", "failed", "error"],
      ["completed", "cancelled", "end_turn"],
    ])(
      "gives a %s run's tool call that never ran its final status before the child's idle",
      async (status, toolStatus, stopReason) => {
        const client = nativeClient();
        await client.connect(async (agent) => {
          const { claude } = await openSession(agent);
          claude.send(cycleStart());
          claude.send(subagent("child", "toolu_launch").launch());
          claude.send(subagent("child", "toolu_launch").started());
          claude.send({
            type: "stream_event",
            event: {
              type: "content_block_start",
              index: 0,
              content_block: { type: "tool_use", id: "toolu_streamed", name: "Bash", input: {} },
            },
            parent_tool_use_id: "toolu_launch",
            uuid: randomUUID(),
          });
          claude.send(subagent("child", "toolu_launch").ended(status));
          await vi.waitFor(() =>
            expect(updatesOf(client.notifications, "child").at(-1)).toMatchObject({
              state: "idle",
            }),
          );
        });

        expect(updatesOf(client.notifications, "child").slice(-2)).toMatchObject([
          { sessionUpdate: "tool_call_update", toolCallId: "toolu_streamed", status: toolStatus },
          { sessionUpdate: "state_update", state: "idle", stopReason },
        ]);
      },
    );

    it("reports a child running again when Claude Code refuses to stop it", async () => {
      let answer = (_: v2.RequestPermissionResponse) => {};
      const client = nativeClient({
        answerPermission: () => new Promise((resolve) => (answer = resolve)),
      });
      await client.connect(async (agent) => {
        const { claude } = await openSession(agent);
        const child = subagent("child", "toolu_launch", { is_backgrounded: true });
        claude.send(cycleStart());
        claude.send(child.launch());
        claude.send(child.started());
        await vi.waitFor(() => expect(updatesOf(client.notifications, "child")).not.toEqual([]));
        void askPermission(claude, "Bash", { command: "make" }, { agentID: "child" }).catch(
          () => {},
        );
        await vi.waitFor(() =>
          expect(updatesOf(client.notifications, "child").at(-1)).toMatchObject({
            state: "requires_action",
          }),
        );
        claude.stopTask.mockImplementationOnce(
          () => new Promise((_, reject) => setTimeout(() => reject(new Error("refused")), 20)),
        );
        await agent.notify(v2.methods.agent.session.cancel, { sessionId: "child" });
        await vi.waitFor(() =>
          expect(updatesOf(client.notifications, "child").at(-1)).toMatchObject({
            state: "running",
          }),
        );
        answer({ outcome: { outcome: "cancelled" } });
      });
    });

    it("reports the root running again when the interrupt fails, and lets its subagent ask again", async () => {
      let answer = (_: v2.RequestPermissionResponse) => {};
      const client = nativeClient({
        answerPermission: () => new Promise((resolve) => (answer = resolve)),
      });
      const decision = await client.connect(async (agent) => {
        const { response, claude } = await openSession(agent);
        claude.send(cycleStart());
        claude.send(subagent("child", "toolu_launch").launch());
        claude.send(subagent("child", "toolu_launch").started());
        void askPermission(claude, "Bash", { command: "make" }, { agentID: "child" }).catch(
          () => {},
        );
        await vi.waitFor(() => expect(client.states()).toEqual(["running", "requires_action"]));
        claude.interrupt.mockImplementationOnce(
          () => new Promise((_, reject) => setTimeout(() => reject(new Error("refused")), 20)),
        );
        await agent.notify(v2.methods.agent.session.cancel, { sessionId: response.sessionId });
        await vi.waitFor(() =>
          expect(client.states()).toEqual(["running", "requires_action", "running"]),
        );
        // The subagent's next request is its own again: a dismissal is a refusal.
        const next = askPermission(claude, "Bash", { command: "ls" }, { agentID: "child" });
        await vi.waitFor(() => expect(client.permissionRequests).toHaveLength(2));
        answer({ outcome: { outcome: "cancelled" } });
        return next;
      });

      expect(decision).toMatchObject({ behavior: "deny", decisionClassification: "user_reject" });
    });

    it("sends a subagent's request on its session when it is announced while the request is built", async () => {
      const client = nativeClient({ answerPermission: () => new Promise(() => {}) });
      await client.connect(async (agent) => {
        const { claude } = await openSession(agent);
        const child = subagent("child", "toolu_launch");
        claude.send(cycleStart());
        await vi.waitFor(() => expect(client.states()).toEqual(["running"]));
        const preview = Promise.withResolvers<void>();
        sdk.previewGate = preview.promise;
        // The request comes before the subagent's task_started, and the
        // subagent is announced while its patch preview is read.
        void askPermission(
          claude,
          "Write",
          { file_path: path.join(cwd, "notes.md"), content: "Notes" },
          { agentID: "child" },
        ).catch(() => {});
        await new Promise((resolve) => setTimeout(resolve, 10));
        claude.send(child.launch());
        claude.send(child.started());
        await vi.waitFor(() => expect(updatesOf(client.notifications, "child")).not.toEqual([]));
        preview.resolve();
        await vi.waitFor(() => expect(client.permissionRequests).toHaveLength(1));
        await vi.waitFor(() =>
          expect(updatesOf(client.notifications, "child").at(-1)).toMatchObject({
            state: "requires_action",
          }),
        );
      });

      expect(client.permissionRequests[0].sessionId).toBe("child");
    });

    it("announces a nested subagent that no launch call names only after its parent", async () => {
      const client = nativeClient();
      await client.connect(async (agent) => {
        const { claude } = await openSession(agent);
        const outer = subagent("outer", "toolu_outer");
        claude.send(cycleStart());
        // The outer agent's launch call has not been read yet.
        claude.send(outer.started());
        claude.send({
          ...subagent("inner", "toolu_unused").started({ parent_task_id: "outer" }),
          tool_use_id: undefined,
        });
        claude.send(outer.launch());
        await vi.waitFor(() =>
          expect(updatesOf(client.notifications, "outer")).toContainEqual(
            expect.objectContaining({ sessionUpdate: "subagent_update", sessionId: "inner" }),
          ),
        );
      });

      const announced = client.notifications.findIndex(
        (n) => n.update.sessionUpdate === "subagent_update" && n.update.sessionId === "outer",
      );
      const firstOfOuter = client.notifications.findIndex((n) => n.sessionId === "outer");
      expect(announced).toBeGreaterThanOrEqual(0);
      expect(announced).toBeLessThan(firstOfOuter);
    });

    it("keeps the root running while another foreground subagent makes progress", async () => {
      const client = nativeClient({ answerPermission: () => new Promise(() => {}) });
      await client.connect(async (agent) => {
        const { claude } = await openSession(agent);
        claude.send(cycleStart());
        for (const [agentId, launch] of [
          ["a", "toolu_a"],
          ["b", "toolu_b"],
        ]) {
          claude.send(subagent(agentId, launch).launch());
          claude.send(subagent(agentId, launch).started());
        }
        await vi.waitFor(() => expect(updatesOf(client.notifications, "b")).not.toEqual([]));
        void askPermission(claude, "Bash", { command: "make" }, { agentID: "a" }).catch(() => {});
        await vi.waitFor(() =>
          expect(updatesOf(client.notifications, "a").at(-1)).toMatchObject({
            state: "requires_action",
          }),
        );
        // B still works.
        expect(client.states()).toEqual(["running"]);
        claude.send(subagent("b", "toolu_b").ended());
        // With B done, the work waits on A alone.
        await vi.waitFor(() => expect(client.states()).toEqual(["running", "requires_action"]));
      });
    });

    it("sends a background child's listed terminal before the child's state on resume", async () => {
      const client = nativeClient();
      await client.connect(async (agent) => {
        const { response, claude } = await openSession(agent);
        const sessionId = response.sessionId;
        const child = subagent("child", "toolu_launch", { is_backgrounded: true });
        claude.send(cycleStart());
        claude.send(child.launch());
        claude.send(child.started());
        claude.send({
          ...assistant("msg_child_bg", [
            {
              type: "tool_use",
              id: "toolu_child_bg",
              name: "Bash",
              input: { command: "make test", run_in_background: true },
            },
          ]),
          parent_tool_use_id: "toolu_launch",
        });
        claude.send({
          type: "system",
          subtype: "task_started",
          task_id: "bg1",
          task_type: "local_bash",
          description: "make test",
          tool_use_id: "toolu_child_bg",
          parent_task_id: "child",
          uuid: randomUUID(),
        });
        claude.send({
          type: "system",
          subtype: "background_tasks_changed",
          tasks: [
            { task_id: "child", task_type: "local_agent", description: "child" },
            { task_id: "bg1", task_type: "local_bash", description: "make test" },
          ],
          uuid: randomUUID(),
        });
        claude.send({
          type: "user",
          message: {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "toolu_child_bg",
                content: "Command running in background with ID: bg1.",
              },
            ],
          },
          tool_use_result: { stdout: "", stderr: "", interrupted: false, backgroundTaskId: "bg1" },
          parent_tool_use_id: "toolu_launch",
          uuid: randomUUID(),
        });
        claude.send(result());
        await vi.waitFor(() => expect(client.states().at(-1)).toBe("idle"));
        client.notifications.length = 0;
        await agent.request(v2.methods.agent.session.resume, { sessionId, cwd });
      });

      const snapshot = client.notifications.map(
        ({ sessionId, update }) =>
          `${sessionId} ${update.sessionUpdate}${"state" in update ? ` ${String(update.state)}` : ""}`,
      );
      // The child's announcement, its terminal, then its state that lists the terminal.
      const announced = snapshot.findIndex((entry) => entry.includes("subagent_update"));
      const terminal = snapshot.indexOf("child terminal_update");
      expect(announced).toBeGreaterThanOrEqual(0);
      expect(terminal).toBeGreaterThan(announced);
      expect(terminal).toBeLessThan(snapshot.indexOf("child state_update running"));
    });

    it("keeps a live background subagent running after a resume of the active session replays it", async () => {
      sdk.subagents = new Map([
        [
          "toolu_bg_agent",
          {
            agentId: "a5966d",
            background: true,
            stoppedByUser: false,
            agentType: "general-purpose",
          },
        ],
      ]);
      const client = nativeClient();
      await client.connect(async (agent) => {
        const { response, claude } = await openSession(agent);
        const sessionId = response.sessionId;
        const child = subagent("a5966d", "toolu_bg_agent", { is_backgrounded: true });
        claude.send(cycleStart());
        claude.send(child.launch());
        claude.send({
          type: "system",
          subtype: "background_tasks_changed",
          tasks: [{ task_id: "a5966d", task_type: "local_agent", description: "sleeper" }],
          uuid: randomUUID(),
        });
        claude.send(child.started());
        claude.send(result({ result: "launched" }));
        await vi.waitFor(() => expect(client.states().at(-1)).toBe("idle"));
        vi.mocked(getSessionMessages).mockResolvedValueOnce([
          {
            type: "assistant",
            uuid: "a1",
            session_id: sessionId,
            parent_tool_use_id: null,
            parent_agent_id: null,
            message: child.launch().message,
          },
        ]);
        await agent.request(v2.methods.agent.session.resume, {
          sessionId,
          cwd,
          replayFrom: { type: "start" },
        });
        // After the response.
        await new Promise((resolve) => setTimeout(resolve, 20));
      });

      expect(updatesOf(client.notifications, "a5966d").at(-1)).toMatchObject({
        sessionUpdate: "state_update",
        state: "running",
      });
    });

    it.each([
      ["session/prompt", v2.methods.agent.session.prompt, { prompt: PROMPT }],
      ["session/close", v2.methods.agent.session.close, {}],
    ])("rejects %s on a subagent's session", async (_, method, params) => {
      const client = nativeClient();
      const error = await client.connect(async (agent) => {
        const { claude } = await openSession(agent);
        claude.send(cycleStart());
        claude.send(subagent("child", "toolu_launch").launch());
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
        claude.send(cycleStart());
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

  describe("elicitations", () => {
    it.each([
      ["no elicitation", {}, { ask: false, mcp: false, dialog: false }],
      ["forms", { form: {} }, { ask: true, mcp: true, dialog: true }],
      ["URLs only", { url: {} }, { ask: false, mcp: true, dialog: false }],
    ])(
      "asks Claude Code for the requests that a client with %s renders",
      async (_, elicitation, expected) => {
        const client = nativeClient();
        const { claude } = await client.connect((agent) => openSession(agent, { elicitation }));

        const { options } = claude;
        expect(!(options.disallowedTools ?? []).includes("AskUserQuestion")).toBe(expected.ask);
        expect(options.onElicitation !== undefined).toBe(expected.mcp);
        expect(options.onUserDialog !== undefined).toBe(expected.dialog);
        expect(options.supportedDialogKinds).toEqual(
          expected.dialog ? ["refusal_fallback_prompt"] : undefined,
        );
      },
    );

    it.each([
      [
        "lists",
        ["ask_user_question_unanswered_v1"],
        { "Which package?": { unanswered: "skipped" } },
      ],
      ["does not list", [], undefined],
    ])(
      "marks a skipped question as unanswered only when the turn's system/init %s the capability",
      async (_, capabilities, annotations) => {
        const client = nativeClient({
          answerElicitation: () => ({ action: "accept", content: {} }),
        });
        const decision = await client.connect(async (agent) => {
          const { claude } = await openSession(agent, { elicitation: { form: {} } });
          claude.send({ type: "system", subtype: "init", uuid: randomUUID(), capabilities });
          claude.send(cycleStart());
          await vi.waitFor(() => expect(client.states()).toEqual(["running"]));
          return claude.options.canUseTool!(
            "AskUserQuestion",
            {
              questions: [
                {
                  question: "Which package?",
                  header: "Package",
                  options: [{ label: "core" }, { label: "cli" }],
                  multiSelect: false,
                },
              ],
            },
            {
              signal: new AbortController().signal,
              toolUseID: "toolu_ask",
              requestId: "r1",
              suggestions: [],
            },
          );
        });

        expect(client.elicitations[0]).toMatchObject({ mode: "form", toolCallId: "toolu_ask" });
        expect(decision).toMatchObject({ behavior: "allow", updatedInput: { answers: {} } });
        expect(
          (decision as { updatedInput?: { annotations?: unknown } }).updatedInput?.annotations,
        ).toEqual(annotations);
      },
    );

    it("completes an MCP server's URL elicitation when Claude Code reports it complete", async () => {
      const client = nativeClient();
      await client.connect(async (agent) => {
        const { claude } = await openSession(agent, { elicitation: { url: {} } });
        claude.send({
          type: "system",
          subtype: "elicitation_complete",
          mcp_server_name: "linear",
          elicitation_id: "e1",
          uuid: randomUUID(),
          session_id: "session",
        });
        await vi.waitFor(() => expect(client.completedElicitations).toEqual(["e1"]));
      });
    });

    it("keeps the work requires_action after the user accepts an MCP server's URL until Claude Code reports it complete", async () => {
      const client = nativeClient({ answerElicitation: () => ({ action: "accept" }) });
      await client.connect(async (agent) => {
        const { claude } = await openSession(agent, { elicitation: { url: {} } });
        claude.send(cycleStart());
        await vi.waitFor(() => expect(client.states()).toEqual(["running"]));
        const answer = await claude.options.onElicitation!(
          {
            serverName: "linear",
            message: "Sign in to Linear",
            mode: "url",
            url: "https://linear.example.com/authorize",
            elicitationId: "e1",
          },
          { signal: new AbortController().signal } as Parameters<
            NonNullable<Options["onElicitation"]>
          >[1],
        );
        // Claude Code gets the answer at once; the user still works in the browser.
        expect(answer).toMatchObject({ action: "accept" });
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(client.states()).toEqual(["running", "requires_action"]);
        claude.send({
          type: "system",
          subtype: "elicitation_complete",
          mcp_server_name: "linear",
          elicitation_id: "e1",
          uuid: randomUUID(),
          session_id: "session",
        });
        await vi.waitFor(() =>
          expect(client.states()).toEqual(["running", "requires_action", "running"]),
        );
      });
    });

    it("starts OAuth for the MCP servers of a forked session", async () => {
      sdk.mcpServers = [{ name: "linear", status: "needs-auth" }];
      const client = nativeClient();
      await client.connect(async (agent) => {
        await agent.request(v2.methods.agent.initialize, {
          protocolVersion: v2.PROTOCOL_VERSION,
          info: { name: "native-test-client", version: "1.0.0" },
          capabilities: { elicitation: { url: {} } },
        });
        await agent.request(v2.methods.agent.session.fork, {
          sessionId: randomUUID(),
          cwd,
          mcpServers: [{ type: "http", name: "linear", url: "https://mcp.example.com/mcp" }],
        });
        await vi.waitFor(() => expect(client.elicitations).toHaveLength(1));
      });

      expect(client.elicitations[0]).toMatchObject({ mode: "url" });
    });

    it("cancels an open MCP OAuth elicitation before it answers session/close", async () => {
      // The server stays `needs-auth`: the user has not signed in yet.
      sdk.mcpServers = [{ name: "linear", status: "needs-auth" }];
      let cancelled = false;
      const client = nativeClient({
        answerElicitation: (_, signal) =>
          new Promise((resolve) =>
            signal.addEventListener("abort", () => {
              cancelled = true;
              resolve({ action: "cancel" });
            }),
          ),
      });
      const cancelledAtClose = await client.connect(async (agent) => {
        await agent.request(v2.methods.agent.initialize, {
          protocolVersion: v2.PROTOCOL_VERSION,
          info: { name: "native-test-client", version: "1.0.0" },
          capabilities: { elicitation: { url: {} } },
        });
        const { sessionId } = await agent.request(v2.methods.agent.session.new, {
          cwd,
          mcpServers: [{ type: "http", name: "linear", url: "https://mcp.example.com/mcp" }],
        });
        await vi.waitFor(() => expect(client.elicitations).toHaveLength(1));
        await agent.request(v2.methods.agent.session.close, { sessionId });
        return cancelled;
      });

      expect(client.elicitations[0]).toMatchObject({
        mode: "url",
        url: "https://mcp.example.com/authorize",
      });
      expect(cancelledAtClose).toBe(true);
    });
  });

  it("reads which v2 core to serve from CLAUDE_AGENT_ACP_V2_CORE", () => {
    expect(v2CoreFromEnv(undefined)).toBe("bridge");
    expect(v2CoreFromEnv("")).toBe("bridge");
    expect(v2CoreFromEnv("native")).toBe("native");
    expect(() => v2CoreFromEnv("v2")).toThrow(/CLAUDE_AGENT_ACP_V2_CORE/);
  });
});

describe("StoppedWork", () => {
  it("forgets a tool use that canUseTool waited for in vain", async () => {
    const stopped = new StoppedWork();
    stopped.cancelled(["prompt"], false);
    const abort = new AbortController();
    const dropped = stopped.dropsToolUse("toolu_never_streamed", undefined, abort.signal);
    abort.abort();
    expect(await dropped).toBe(false);
    expect(
      (stopped as unknown as { toolUseWaiters: Map<string, unknown> }).toolUseWaiters.size,
    ).toBe(0);
  });
});
