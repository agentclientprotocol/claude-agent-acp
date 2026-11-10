/**
 * The ACP v2 core (`src/v2/`), driven through the protocol
 * router with the SDK's v2 client app, which validates every response and
 * session update against the v2 schema.
 *
 * Claude Code is a double that the test drives message by message (see
 * {@link FakeClaudeCode}), shaped like what the bundled CLI sends: prompt
 * echoes with `isReplay`, `command_lifecycle` frames, and
 * `session_state_changed`.
 */
import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
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
import { acpProtocolRouter } from "../../serve.js";
import { SettingsManager } from "../../settings.js";
import type { AgentHandle } from "../../v2/agent.js";
import { StoppedWork } from "../../v2/stopped-work.js";

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
  applyFlagSettings: ReturnType<typeof vi.fn>;
  /** The dry-run rewind of a prompt's checkpoint: the files it changed. */
  rewindFiles: ReturnType<typeof vi.fn>;
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
  /** When set, Claude Code's start waits for it. */
  startGate: undefined as Promise<void> | undefined,
  /** When set, the query serves Remote Control with it (`enableRemoteControl`). */
  enableRemoteControl: undefined as ((...args: unknown[]) => Promise<unknown>) | undefined,
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
        applyFlagSettings: vi.fn(async () => {}),
        rewindFiles: vi.fn(async () => ({ canRewind: true, filesChanged: [] })),
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
          await sdk.startGate;
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
        applyFlagSettings: fake.applyFlagSettings,
        rewindFiles: fake.rewindFiles,
        mcpServerStatus: async () => sdk.mcpServers,
        ...(sdk.enableRemoteControl ? { enableRemoteControl: sdk.enableRemoteControl } : {}),
        setMcpServers: async () => ({ added: [], removed: [], errors: {} }),
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

vi.mock("../../diff.js", async () => {
  const actual = await vi.importActual<typeof import("../../diff.js")>("../../diff.js");
  return {
    ...actual,
    previewPatchContent: async (...args: Parameters<typeof actual.previewPatchContent>) => {
      await sdk.previewGate;
      return actual.previewPatchContent(...args);
    },
  };
});

// The subagents that a replayed transcript launched, as their metadata files name them.
vi.mock("../../subagent-history.js", async () => ({
  ...(await vi.importActual<typeof import("../../subagent-history.js")>(
    "../../subagent-history.js",
  )),
  subagentHistory: vi.fn(async () => ({ agents: sdk.subagents })),
  readSubagentMessages: vi.fn(async () => []),
}));

vi.mock("../../tools.js", async () => ({
  ...(await vi.importActual<typeof import("../../tools.js")>("../../tools.js")),
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
  tempDir = await mkdtemp(path.join(os.tmpdir(), "acp-v2-"));
  cwd = await mkdtemp(path.join(tempDir, "project-"));
  vi.stubEnv("CLAUDE_CONFIG_DIR", path.join(tempDir, "claude"));
  sdk.processes = [];
  sdk.mcpServers = [];
  sdk.models = DEFAULT_MODELS;
  sdk.subagents = new Map();
  sdk.previewGate = undefined;
  sdk.startFailure = undefined;
  sdk.startGate = undefined;
  sdk.enableRemoteControl = undefined;
});

afterEach(async () => {
  await Promise.all(agents.splice(0).map((agent) => agent.dispose()));
  vi.unstubAllEnvs();
  await rm(tempDir, { recursive: true, force: true, maxRetries: 10 });
});

/** A v2 client of the v2 core that records the session updates it receives. */
function v2Client({
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
    .client({ name: "v2-test-client" })
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
    onV2Agent: (agent) => agents.push(agent),
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
    info: { name: "v2-test-client", version: "1.0.0" },
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
    /**
     * The streamed start of its Agent call, which comes before the
     * consolidated `launch`: after a cancel, only the stream goes out.
     */
    launchStart: () => ({
      type: "stream_event",
      event: {
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: launch, name: "Agent", input: {} },
      },
      parent_tool_use_id: null,
      uuid: randomUUID(),
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

describe("ACP v2 core", () => {
  it("advertises the v2 session baseline with fork, and terminal logins", async () => {
    const client = v2Client();
    const response = await client.connect((agent) =>
      agent.request(v2.methods.agent.initialize, {
        protocolVersion: v2.PROTOCOL_VERSION,
        info: { name: "v2-test-client", version: "1.0.0" },
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
    const client = v2Client();
    const baseUrl = "https://gateway.example.com";
    await client.connect(async (agent) => {
      await agent.request(v2.methods.agent.initialize, {
        protocolVersion: v2.PROTOCOL_VERSION,
        info: { name: "v2-test-client", version: "1.0.0" },
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

    it("answers at once while a background subagent runs, and restarts the session once it ends", async () => {
      const client = v2Client();
      await client.connect(async (agent) => {
        const { response, claude } = await openSession(agent);
        const sessionId = response.sessionId;
        void agent.request(v2.methods.agent.session.prompt, { sessionId, prompt: PROMPT });
        claude.send(lifecycle(await claude.prompt(0), "started"));
        const helper = subagent("agent-1", "toolu_agent", { is_backgrounded: true });
        claude.send(helper.launch());
        claude.send(helper.started());
        claude.send(result());
        await vi.waitFor(() => expect(client.states().at(-1)).toBe("idle"));
        await setProvider(agent);
        expect(sdk.processes).toHaveLength(1);

        // A prompt meanwhile goes to the current query.
        void agent.request(v2.methods.agent.session.prompt, {
          sessionId,
          prompt: [{ type: "text", text: "next" }],
        });
        claude.send(lifecycle(await claude.prompt(1), "started"));
        claude.send(result());
        await vi.waitFor(() => expect(client.states().at(-1)).toBe("idle"));
        expect(sdk.processes).toHaveLength(1);

        claude.send(helper.ended());
        await vi.waitFor(() => expect(claude.close).toHaveBeenCalled());
        expect(sdk.processes).toHaveLength(2);
        expect(sdk.processes[1].options).toMatchObject({ resume: sessionId });
      });
    });

    it("sends a prompt of an idle session right after the response to the new query", async () => {
      const client = v2Client();
      await client.connect(async (agent) => {
        const { response, claude } = await openSession(agent);
        await setProvider(agent);
        const answer = agent.request(v2.methods.agent.session.prompt, {
          sessionId: response.sessionId,
          prompt: PROMPT,
        });
        sdk.processes[1].send(lifecycle(await sdk.processes[1].prompt(0), "started"));
        await answer;
        expect(claude.prompts).toHaveLength(0);
      });
    });

    it("sends a prompt that waited for the restart to the new query, and forgets it", async () => {
      const client = v2Client();
      await client.connect(async (agent) => {
        const { response, claude } = await openSession(agent);
        const started = Promise.withResolvers<void>();
        sdk.startGate = started.promise;
        const set = setProvider(agent);
        await vi.waitFor(() => expect(sdk.processes).toHaveLength(2));
        const answer = agent.request(v2.methods.agent.session.prompt, {
          sessionId: response.sessionId,
          prompt: PROMPT,
        });
        await new Promise((resolve) => setTimeout(resolve, 20));
        started.resolve();
        await set;
        sdk.processes[1].send(lifecycle(await sdk.processes[1].prompt(0), "started"));
        await answer;
        expect(claude.prompts).toHaveLength(0);
        const restarts = (agents[0] as unknown as { restarts: { held: Map<string, unknown> } })
          .restarts;
        expect(restarts.held.size).toBe(0);
      });
    });

    it("answers a prompt that waits for the restart with -32800 on session/cancel", async () => {
      const client = v2Client();
      await client.connect(async (agent) => {
        const { response, claude } = await openSession(agent);
        const sessionId = response.sessionId;
        const started = Promise.withResolvers<void>();
        sdk.startGate = started.promise;
        const set = setProvider(agent);
        await vi.waitFor(() => expect(sdk.processes).toHaveLength(2));
        const waiting = agent.request(v2.methods.agent.session.prompt, {
          sessionId,
          prompt: [{ type: "text", text: "next" }],
        });
        await new Promise((resolve) => setTimeout(resolve, 20));
        await agent.notify(v2.methods.agent.session.cancel, { sessionId });
        await expect(waiting).rejects.toMatchObject({ code: -32800 });

        started.resolve();
        await set;
        // The cancelled prompt never reached either query.
        expect(claude.prompts).toHaveLength(0);
        expect(sdk.processes[1].prompts).toHaveLength(0);
      });
    });

    it("ends the old query only after a turn that Claude Code started on it while the new one started", async () => {
      const client = v2Client();
      await client.connect(async (agent) => {
        const { claude } = await openSession(agent);
        const started = Promise.withResolvers<void>();
        sdk.startGate = started.promise;
        const set = setProvider(agent);
        await vi.waitFor(() => expect(sdk.processes).toHaveLength(2));
        // A background task ended, say: Claude Code starts a turn on its own.
        claude.send(cycleStart());
        await vi.waitFor(() => expect(client.states()).toEqual(["running"]));
        started.resolve();
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(claude.close).not.toHaveBeenCalled();

        claude.send(result());
        await set;
        expect(claude.close).toHaveBeenCalled();
      });

      expect(client.sessionUpdates).toContainEqual(
        expect.objectContaining({
          sessionUpdate: "state_update",
          state: "idle",
          stopReason: "end_turn",
        }),
      );
    });

    it("restarts a session whose start read the route before the change, once its setup answered", async () => {
      const client = v2Client();
      await client.connect(async (agent) => {
        await agent.request(v2.methods.agent.initialize, {
          protocolVersion: v2.PROTOCOL_VERSION,
          info: { name: "v2-test-client", version: "1.0.0" },
          capabilities: {},
        });
        const started = Promise.withResolvers<void>();
        sdk.startGate = started.promise;
        const created = agent.request(v2.methods.agent.session.new, { cwd });
        await vi.waitFor(() => expect(sdk.processes).toHaveLength(1));
        await setProvider(agent);
        started.resolve();
        const { sessionId } = await created;
        expect(sdk.processes).toHaveLength(1);

        await vi.waitFor(() => expect(sdk.processes[0].close).toHaveBeenCalled());
        expect(sdk.processes).toHaveLength(2);
        expect(sdk.processes[1].options).toMatchObject({
          resume: sessionId,
          env: { ANTHROPIC_BASE_URL: "https://gateway.example.com" },
        });
      });
    });

    it("forgets a session that session/close closed while its restart ran", async () => {
      const client = v2Client();
      await client.connect(async (agent) => {
        const { response } = await openSession(agent);
        const started = Promise.withResolvers<void>();
        sdk.startGate = started.promise;
        const set = setProvider(agent);
        await vi.waitFor(() => expect(sdk.processes).toHaveLength(2));
        const close = agent.request(v2.methods.agent.session.close, {
          sessionId: response.sessionId,
        });
        // The close waits for the restart.
        await new Promise((resolve) => setTimeout(resolve, 20));
        started.resolve();
        await close;
        await set;
        expect(sdk.processes[1].close).toHaveBeenCalled();
        // Its setup is gone, so no later route change restarts it.
        const restarts = (agents[0] as unknown as { restarts: { setups: Map<string, unknown> } })
          .restarts;
        expect(restarts.setups.has(response.sessionId)).toBe(false);
      });
    });

    describe("MCP OAuth", () => {
      const linear = { type: "http" as const, name: "linear", url: "https://mcp.example.com/mcp" };
      /** A client that leaves each OAuth elicitation open until the agent withdraws it. */
      const oauthClient = () => {
        const withdrawn: number[] = [];
        const client = v2Client({
          answerElicitation: (_, signal) =>
            new Promise((resolve) =>
              signal.addEventListener("abort", () => {
                withdrawn.push(client.elicitations.length);
                resolve({ action: "cancel" });
              }),
            ),
        });
        return { client, withdrawn };
      };
      const initialize = (agent: v2.ClientContext) =>
        agent.request(v2.methods.agent.initialize, {
          protocolVersion: v2.PROTOCOL_VERSION,
          info: { name: "v2-test-client", version: "1.0.0" },
          capabilities: { elicitation: { url: {} } },
        });

      it("starts OAuth again on the new query of a restart that withdrew it", async () => {
        // The server stays `needs-auth`: the user has not signed in yet.
        sdk.mcpServers = [{ name: "linear", status: "needs-auth" }];
        const { client, withdrawn } = oauthClient();
        await client.connect(async (agent) => {
          await initialize(agent);
          await agent.request(v2.methods.agent.session.new, { cwd, mcpServers: [linear] });
          await vi.waitFor(() => expect(client.elicitations).toHaveLength(1));
          await setProvider(agent);
          await vi.waitFor(() => expect(client.elicitations).toHaveLength(2));
          // The old query's elicitation was withdrawn before the new one went out.
          expect(withdrawn).toEqual([1]);
        });
      });

      it("starts OAuth only on the new query of a resume with other additional directories", async () => {
        sdk.mcpServers = [{ name: "linear", status: "needs-auth" }];
        const extra = await mkdtemp(path.join(tempDir, "extra-"));
        const { client, withdrawn } = oauthClient();
        await client.connect(async (agent) => {
          await initialize(agent);
          const { sessionId } = await agent.request(v2.methods.agent.session.new, { cwd });
          await agent.request(v2.methods.agent.session.resume, {
            sessionId,
            cwd,
            mcpServers: [linear],
            additionalDirectories: [extra],
          });
          await vi.waitFor(() => expect(sdk.processes[0].close).toHaveBeenCalled());
          await vi.waitFor(() => expect(client.elicitations).toHaveLength(1));
          await new Promise((resolve) => setTimeout(resolve, 20));
          expect(client.elicitations).toHaveLength(1);
          expect(withdrawn).toEqual([]);
        });
      });
    });

    it("stops a session whose query does not start again under the new route", async () => {
      const client = v2Client();
      await client.connect(async (agent) => {
        const { response } = await openSession(agent);
        sdk.startFailure = new Error("Claude Code could not start");
        await setProvider(agent);
        // The session is still active: v2 ends that only at close.
        await expect(
          agent.request(v2.methods.agent.session.prompt, {
            sessionId: response.sessionId,
            prompt: PROMPT,
          }),
        ).rejects.toMatchObject({
          code: -32603,
          message: expect.stringContaining("could not start again. Resume the session"),
        });
        // A close ends it: it is no longer active then.
        await agent.request(v2.methods.agent.session.close, { sessionId: response.sessionId });
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
    const client = v2Client();
    const { response, claude } = await client.connect((agent) => openSession(agent));

    expect(response.configOptions?.map((option) => option.configId)).toEqual(["mode", "model"]);
    expect(response.availableCommands).toEqual([
      {
        type: "command",
        name: "review",
        description: "Review a change",
        input: { type: "text", hint: "<pull request>" },
      },
      // The adapter's own `/mcp`.
      expect.objectContaining({ type: "command", name: "mcp" }),
    ]);
    // Each prompt is echoed, and the session's state is reported.
    expect(claude.options.extraArgs).toMatchObject({ "replay-user-messages": "" });
    expect(claude.options.env?.CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS).toBe("1");
  });

  it("answers a prompt when Claude Code starts it, and reports the work until the turn's result", async () => {
    const client = v2Client();
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
      // The turn's tokens, and its rows by model.
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
    const client = v2Client();
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
    const client = v2Client();
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
    const client = v2Client();
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
    const client = v2Client({
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
    const client = v2Client();
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
    const client = v2Client();
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
    const client = v2Client();
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
    const client = v2Client();
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
    const client = v2Client();
    await client.connect(async (agent) => {
      await agent.request(v2.methods.agent.initialize, {
        protocolVersion: v2.PROTOCOL_VERSION,
        info: { name: "v2-test-client", version: "1.0.0" },
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
    const client = v2Client();
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
    const client = v2Client();
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

  it("ends an open compaction before the idle when Claude Code exits during it", async () => {
    const client = v2Client();
    await client.connect(async (agent) => {
      const { response, claude } = await openSession(agent);
      const answer = agent.request(v2.methods.agent.session.prompt, {
        sessionId: response.sessionId,
        prompt: [{ type: "text", text: "/compact" }],
      });
      await claude.prompt(0);
      claude.send(cycleStart());
      claude.send({
        type: "system",
        subtype: "status",
        status: "compacting",
        session_id: response.sessionId,
        uuid: "compact-1",
      });
      claude.end(new Error("Claude Code process exited with code 1"));
      await answer.catch(() => {});
      await vi.waitFor(() => expect(client.states()).toEqual(["running", "idle"]));
    });

    expect(
      client.sessionUpdates.filter(
        (update) =>
          update.sessionUpdate === "compaction_update" || update.sessionUpdate === "state_update",
      ),
    ).toMatchObject([
      { sessionUpdate: "state_update", state: "running" },
      { sessionUpdate: "compaction_update", compactionId: "compact-1", status: "in_progress" },
      { sessionUpdate: "compaction_update", compactionId: "compact-1", status: "cancelled" },
      { sessionUpdate: "state_update", state: "idle", stopReason: "error" },
    ]);
  });

  it("starts a session whose query ended again on resume", async () => {
    const client = v2Client();
    await client.connect(async (agent) => {
      const { response, claude } = await openSession(agent);
      claude.end(new Error("Claude Code process exited with code 1"));
      // The session is still active, as v2 asks until its close: its
      // requests say what happened instead of -32002.
      for (const request of [
        agent.request(v2.methods.agent.session.prompt, {
          sessionId: response.sessionId,
          prompt: PROMPT,
        }),
        agent.request(v2.methods.agent.session.setConfigOption, {
          sessionId: response.sessionId,
          configId: "mode",
          type: "id",
          value: "plan",
        }),
      ]) {
        await expect(request).rejects.toMatchObject({
          code: -32603,
          message: expect.stringContaining("Claude Code stopped. Resume the session to continue."),
          data: { sessionId: response.sessionId },
        });
      }
      await agent.request(v2.methods.agent.session.resume, { sessionId: response.sessionId, cwd });
    });

    expect(sdk.processes).toHaveLength(2);
    expect(sdk.processes[1].options.resume).toBe(sdk.processes[0].options.sessionId);
  });

  it("starts an inactive session once for concurrent resumes", async () => {
    const client = v2Client();
    await client.connect(async (agent) => {
      await openSession(agent);
      const started = Promise.withResolvers<void>();
      sdk.startGate = started.promise;
      const sessionId = randomUUID();
      const resumes = [1, 2].map(() =>
        agent.request(v2.methods.agent.session.resume, { sessionId, cwd }),
      );
      await vi.waitFor(() => expect(sdk.processes).toHaveLength(2));
      started.resolve();
      await Promise.all(resumes);
    });

    expect(sdk.processes).toHaveLength(2);
    expect(sdk.processes[1].close).not.toHaveBeenCalled();
  });

  it("starts a session again for a resume that waited for a start that failed", async () => {
    const client = v2Client();
    await client.connect(async (agent) => {
      await openSession(agent);
      const started = Promise.withResolvers<void>();
      sdk.startGate = started.promise;
      sdk.startFailure = new Error("Claude Code process exited with code 1");
      const sessionId = randomUUID();
      const failed = agent
        .request(v2.methods.agent.session.resume, { sessionId, cwd })
        .catch((error: unknown) => error);
      await vi.waitFor(() => expect(sdk.processes).toHaveLength(2));
      const resumed = agent.request(v2.methods.agent.session.resume, { sessionId, cwd });
      // The second resume reaches the agent while the first start waits.
      await new Promise((resolve) => setTimeout(resolve, 20));
      started.resolve();
      expect(await failed).toMatchObject({ code: -32603 });
      sdk.startFailure = undefined;
      await resumed;
    });

    expect(sdk.processes).toHaveLength(3);
  });

  it("closes a session that session/close found still starting", async () => {
    const client = v2Client();
    const error = await client.connect(async (agent) => {
      await openSession(agent);
      const started = Promise.withResolvers<void>();
      sdk.startGate = started.promise;
      const sessionId = randomUUID();
      const resume = agent.request(v2.methods.agent.session.resume, { sessionId, cwd });
      await vi.waitFor(() => expect(sdk.processes).toHaveLength(2));
      const close = agent.request(v2.methods.agent.session.close, { sessionId });
      // The close reaches the agent while the start waits.
      await new Promise((resolve) => setTimeout(resolve, 20));
      started.resolve();
      await resume;
      await close;
      expect(sdk.processes[1].close).toHaveBeenCalled();
      return agent
        .request(v2.methods.agent.session.prompt, { sessionId, prompt: PROMPT })
        .catch((error: unknown) => error);
    });

    expect(error).toMatchObject({ code: -32002 });
  });

  it("closes a session that session/delete found still starting", async () => {
    const client = v2Client();
    await client.connect(async (agent) => {
      await openSession(agent);
      const started = Promise.withResolvers<void>();
      sdk.startGate = started.promise;
      const sessionId = randomUUID();
      const resume = agent.request(v2.methods.agent.session.resume, { sessionId, cwd });
      await vi.waitFor(() => expect(sdk.processes).toHaveLength(2));
      const deleted = agent.request(v2.methods.agent.session.delete, { sessionId });
      // The delete reaches the agent while the start waits.
      await new Promise((resolve) => setTimeout(resolve, 20));
      started.resolve();
      await resume;
      await deleted;
      expect(sdk.processes[1].close).toHaveBeenCalled();
    });
  });

  it("answers a session/close that comes during a resume's replay after the resume, and sends nothing after it", async () => {
    const client = v2Client();
    const read = Promise.withResolvers<never[]>();
    await client.connect(async (agent) => {
      const { response } = await openSession(agent);
      const sessionId = response.sessionId;
      vi.mocked(getSessionMessages).mockReturnValueOnce(read.promise);
      const order: string[] = [];
      const resume = agent
        .request(v2.methods.agent.session.resume, { sessionId, cwd, replayFrom: { type: "start" } })
        .then(() => order.push("resume"));
      await vi.waitFor(() => expect(getSessionMessages).toHaveBeenCalled());
      let sentBeforeClose = -1;
      const close = agent.request(v2.methods.agent.session.close, { sessionId }).then(() => {
        order.push("close");
        sentBeforeClose = client.notifications.length;
      });
      // The close reaches the agent while the replay reads the transcript.
      await new Promise((resolve) => setTimeout(resolve, 20));
      read.resolve([]);
      await Promise.all([resume, close]);
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(order).toEqual(["resume", "close"]);
      expect(client.notifications.slice(sentBeforeClose)).toEqual([]);
      const restarts = (agents[0] as unknown as { restarts: { setups: Map<string, unknown> } })
        .restarts;
      expect(restarts.setups.has(sessionId)).toBe(false);
    });
  });

  it("ends the work at the turn's result while background subagents keep Claude Code running", async () => {
    const client = v2Client();
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
    const client = v2Client();
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
    const client = v2Client();
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
    const client = v2Client({
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

  it("continues an approved plan in its fresh context while a /remote-control waits for the turn", async () => {
    sdk.enableRemoteControl = vi.fn(async () => ({
      session_url: "https://claude.ai/code/session_123",
    }));
    const client = v2Client({
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
      await askPermission(claude, "ExitPlanMode", { plan: "Do it" }, { toolUseID: "toolu_plan" });
      // Held until the turn ends.
      const command = agent.request(v2.methods.agent.session.prompt, {
        sessionId,
        prompt: [{ type: "text", text: "/remote-control" }],
      });
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
      const clear = await claude.prompt(1);
      claude.send(lifecycle(clear, "started"));
      claude.send(echo(clear));
      claude.send({
        type: "conversation_reset",
        new_conversation_id: randomUUID(),
        uuid: randomUUID(),
        trigger: "clear",
        timestamp: new Date().toISOString(),
        session_id: sessionId,
      });
      claude.send(result({ num_turns: 0, stop_reason: null }));
      claude.send(lifecycle(clear, "completed"));
      const plan = await claude.prompt(2);
      claude.send(lifecycle(plan, "started"));
      claude.send(echo(plan));
      claude.send(result());
      claude.send(lifecycle(plan, "completed"));
      claude.send(sessionState("idle"));
      await command;
      await vi.waitFor(() => expect(sdk.enableRemoteControl).toHaveBeenCalled());
    });

    expect(sdk.processes[0].prompts.map((prompt) => prompt.message.content)).toEqual([
      PROMPT,
      [{ type: "text", text: "/clear" }],
      [{ type: "text", text: "Implement the following plan:\n\nDo it" }],
    ]);
  });

  it("ends a cycle at its own result, not at a placeholder or at the idle of the turn before", async () => {
    const client = v2Client();
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
    const client = v2Client();
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
    const client = v2Client();
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
    const client = v2Client();
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
    const client = v2Client();
    const response = await client.connect(async (agent) => {
      await openSession(agent);
      return agent.request(method, { sessionId: randomUUID() });
    });

    expect(response).toEqual({});
  });

  it("rejects a config value whose type does not match the option", async () => {
    const client = v2Client();
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
    const client = v2Client();
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
    const client = v2Client();
    const sessionId = randomUUID();
    await client.connect(async (agent) => {
      await agent.request(v2.methods.agent.initialize, {
        protocolVersion: v2.PROTOCOL_VERSION,
        info: { name: "v2-test-client", version: "1.0.0" },
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

  it("gives a replayed tool call that has no result a final status, before the state", async () => {
    const entry = (type: string, uuid: string, message: unknown) => ({
      type,
      uuid,
      session_id: "s",
      parent_tool_use_id: null,
      parent_agent_id: null,
      message,
    });
    // Claude Code was killed while `make` ran: the transcript has no result for it.
    vi.mocked(getSessionMessages).mockResolvedValueOnce([
      entry("user", "u1", { role: "user", content: "Build it" }),
      entry("assistant", "a1", {
        id: "msg_a",
        role: "assistant",
        content: [{ type: "tool_use", id: "toolu_make", name: "Bash", input: { command: "make" } }],
      }),
    ] as never);
    const client = v2Client();
    await client.connect(async (agent) => {
      await agent.request(v2.methods.agent.initialize, {
        protocolVersion: v2.PROTOCOL_VERSION,
        info: { name: "v2-test-client", version: "1.0.0" },
        capabilities: {},
      });
      await agent.request(v2.methods.agent.session.resume, {
        sessionId: randomUUID(),
        cwd,
        replayFrom: { type: "start" },
      });
    });

    expect(client.sessionUpdates.slice(-2)).toEqual([
      { sessionUpdate: "tool_call_update", toolCallId: "toolu_make", status: "failed" },
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
    const client = v2Client();
    await client.connect(async (agent) => {
      await agent.request(v2.methods.agent.initialize, {
        protocolVersion: v2.PROTOCOL_VERSION,
        info: { name: "v2-test-client", version: "1.0.0" },
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
    const client = v2Client();
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
    const client = v2Client();
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

  it.each([
    ["a cycle of Claude Code's own ended", "cycle"],
    ["a prompt started", "prompt"],
  ])(
    "does not read a later aborted result as cancelled by a cancel of an idle session once %s",
    async (_, after) => {
      const client = v2Client();
      await client.connect(async (agent) => {
        const { response, claude } = await openSession(agent);
        const sessionId = response.sessionId;
        // Claude Code runs nothing: the interrupt stops nothing and sends nothing.
        await agent.notify(v2.methods.agent.session.cancel, { sessionId });
        await vi.waitFor(() => expect(claude.interrupt).toHaveBeenCalled());
        if (after === "cycle") {
          // Say, a background task ended: Claude Code starts a cycle after the interrupt.
          claude.send(cycleStart());
          claude.send(result());
          claude.send(sessionState("idle"));
          await vi.waitFor(() => expect(client.states()).toEqual(["running", "idle"]));
          claude.send(cycleStart());
        } else {
          const answer = agent.request(v2.methods.agent.session.prompt, {
            sessionId,
            prompt: PROMPT,
          });
          claude.send(lifecycle(await claude.prompt(0), "started"));
          await answer;
        }
        // Then an interrupt of Claude Code's remote control stops the work.
        claude.send(
          result({
            subtype: "error_during_execution",
            is_error: true,
            terminal_reason: "aborted_streaming",
          }),
        );
        claude.send(sessionState("idle"));
        await vi.waitFor(() =>
          expect(client.states()).toEqual(
            after === "cycle" ? ["running", "idle", "running", "idle"] : ["running", "idle"],
          ),
        );
      });

      expect(client.sessionUpdates.at(-1)).toMatchObject({ state: "idle", stopReason: "error" });
    },
  );

  it("sends no permission request of a session after session/close answered", async () => {
    const client = v2Client();
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
    const client = v2Client();
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
    const client = v2Client();
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
    [
      "the turn limit at the token limit",
      { subtype: "error_max_turns", is_error: false, stop_reason: "max_tokens" },
      { stopReason: "max_turn_requests" },
    ],
  ])("reads %s from the result as the v1 core does", async (_, fields, expected) => {
    const client = v2Client();
    await client.connect(async (agent) => {
      const { claude } = await openSession(agent);
      claude.send(cycleStart());
      claude.send(result(fields));
      await vi.waitFor(() => expect(client.states()).toEqual(["running", "idle"]));
    });

    expect(client.sessionUpdates.at(-1)).toMatchObject(expected);
  });

  it("answers a refusal with the explanation of model_refusal_no_fallback when the message has none", async () => {
    const client = v2Client();
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
    const client = v2Client();
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
    const client = v2Client();
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
    const client = v2Client();
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
    const client = v2Client();
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

  it("offers clearing the context at 0% used after Claude Code mounted a fresh conversation", async () => {
    const client = v2Client();
    await client.connect(async (agent) => {
      const { response, claude } = await openSession(agent);
      const prompted = agent.request(v2.methods.agent.session.prompt, {
        sessionId: response.sessionId,
        prompt: PROMPT,
      });
      claude.send(echo(await claude.prompt(0)));
      await prompted;
      const planned = assistant("msg_1", [{ type: "text", text: "Planned." }]);
      planned.message.usage = { input_tokens: 100_000, output_tokens: 0 };
      claude.send(planned);
      await vi.waitFor(() =>
        expect(client.sessionUpdates.at(-1)?.sessionUpdate).toBe("agent_message_chunk"),
      );
      await askPermission(claude, "ExitPlanMode", { plan: "Fix it" });
      claude.send({
        type: "conversation_reset",
        new_conversation_id: randomUUID(),
        uuid: randomUUID(),
        trigger: "clear",
        timestamp: new Date().toISOString(),
        session_id: "session",
      });
      await askPermission(claude, "ExitPlanMode", { plan: "Fix it" });
    });

    // After the reset, the context in use is 0, not the old context's figure.
    expect(
      client.permissionRequests.map(
        (request) =>
          request.options.find((option) => option.optionId === "exit-plan-clear-auto")?.name,
      ),
    ).toEqual([
      "Yes, clear context (50% used) and use auto mode",
      "Yes, clear context (0% used) and use auto mode",
    ]);
  });

  it("lists bypass before auto in ExitPlanMode's options after plan mode left bypass", async () => {
    const client = v2Client();
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
    const client = v2Client();
    const error = await client.connect(async (agent) => {
      await agent.request(v2.methods.agent.initialize, {
        protocolVersion: v2.PROTOCOL_VERSION,
        info: { name: "v2-test-client", version: "1.0.0" },
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
      const client = v2Client();
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
      const client = v2Client();
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
      const client = v2Client();
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
      const client = v2Client({
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
      const client = v2Client();
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
        const client = v2Client();
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
      const client = v2Client({
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

    it("lets the subagent that a child waits on ask again when Claude Code refuses to stop the child", async () => {
      const client = v2Client({ answerPermission: () => new Promise(() => {}) });
      await client.connect(async (agent) => {
        const { claude } = await openSession(agent);
        const child = subagent("child", "toolu_launch", { is_backgrounded: true });
        const inner = subagent("inner", "toolu_inner", { parent_task_id: "child" });
        claude.send(cycleStart());
        claude.send(child.launch());
        claude.send(child.started());
        claude.send(inner.launch("toolu_launch"));
        claude.send(inner.started());
        await vi.waitFor(() =>
          expect(updatesOf(client.notifications, "inner")).toContainEqual(
            expect.objectContaining({ state: "running" }),
          ),
        );
        claude.stopTask.mockRejectedValueOnce(new Error("refused"));
        await agent.notify(v2.methods.agent.session.cancel, { sessionId: "child" });
        await vi.waitFor(() => expect(claude.stopTask).toHaveBeenCalledWith("child"));
        await new Promise((resolve) => setTimeout(resolve, 20));
        // The inner subagent's run goes on: its next request is its own.
        void askPermission(claude, "Bash", { command: "make" }, { agentID: "inner" }).catch(
          () => {},
        );
        await vi.waitFor(() => expect(client.permissionRequests).toHaveLength(1));
        expect(client.permissionRequests[0].sessionId).toBe("inner");
      });
    });

    it("reports the root running again when the interrupt fails, and lets its subagent ask again", async () => {
      let answer = (_: v2.RequestPermissionResponse) => {};
      const client = v2Client({
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

    it("stops a foreground subagent that Claude Code reports after the root's cancel, until the cancelled work's result", async () => {
      const client = v2Client();
      await client.connect(async (agent) => {
        const { response, claude } = await openSession(agent);
        claude.send(cycleStart());
        await vi.waitFor(() => expect(client.states()).toEqual(["running"]));
        await agent.notify(v2.methods.agent.session.cancel, { sessionId: response.sessionId });
        await vi.waitFor(() => expect(claude.interrupt).toHaveBeenCalled());
        // The interrupt stopped a subagent whose launch the session reads only now.
        const late = subagent("late", "toolu_late");
        claude.send(late.launchStart());
        claude.send(late.launch());
        claude.send(late.started());
        claude.send(late.says("Half an answer"));
        // A background subagent goes on after the root's cancel.
        const background = subagent("bg", "toolu_bg", { is_backgrounded: true });
        claude.send(background.launchStart());
        claude.send(background.launch());
        claude.send(background.started());
        await vi.waitFor(() => expect(updatesOf(client.notifications, "bg")).not.toEqual([]));
        await expect(
          askPermission(claude, "Bash", { command: "make" }, { agentID: "late" }),
        ).rejects.toThrow("Tool use aborted");
        await askPermission(claude, "Bash", { command: "make" }, { agentID: "bg" });
        claude.send(late.ended("stopped"));
        claude.send(
          result({
            subtype: "error_during_execution",
            is_error: true,
            terminal_reason: "aborted_streaming",
          }),
        );
        claude.send(sessionState("idle"));
        await vi.waitFor(() => expect(client.states()).toEqual(["running", "idle"]));
        // The cancel ended with its work: a later turn's subagent asks the client.
        claude.send(cycleStart());
        const next = subagent("next", "toolu_next");
        claude.send(next.launch());
        claude.send(next.started());
        await askPermission(claude, "Bash", { command: "make" }, { agentID: "next" });
      });

      expect(client.permissionRequests.map((request) => request.sessionId)).toEqual(["bg", "next"]);
      // Announced, without the message of its stopped run.
      expect(updatesOf(client.notifications, "late").map((update) => update.sessionUpdate)).toEqual(
        ["state_update", "session_message", "state_update"],
      );
    });

    it("sends a subagent's request on its session when it is announced while the request is built", async () => {
      const client = v2Client({ answerPermission: () => new Promise(() => {}) });
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
      const client = v2Client();
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
      const client = v2Client({ answerPermission: () => new Promise(() => {}) });
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
      const client = v2Client();
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
      const client = v2Client();
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
      const client = v2Client();
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
      const client = v2Client();
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

    it("keeps a background command's terminal running when a resume replays its result", async () => {
      const toolUse = assistant("msg_bash", [
        {
          type: "tool_use",
          id: "toolu_bg",
          name: "Bash",
          input: { command: "make test", run_in_background: true },
        },
      ]);
      const toolResult = {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_bg",
            content: "Command running in background with ID: bg1.",
          },
        ],
      };
      const client = v2Client();
      let resumedAt = 0;
      const sessionId = await client.connect(async (agent) => {
        const { response, claude } = await openSession(agent);
        claude.send(cycleStart());
        claude.send(toolUse);
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
          message: toolResult,
          tool_use_result: { stdout: "", stderr: "", interrupted: false, backgroundTaskId: "bg1" },
          parent_tool_use_id: null,
          uuid: randomUUID(),
        });
        claude.send(result());
        await vi.waitFor(() => expect(client.states()).toEqual(["running", "running", "idle"]));
        const entry = (type: string, uuid: string, message: unknown) => ({
          type,
          uuid,
          session_id: response.sessionId,
          parent_tool_use_id: null,
          parent_agent_id: null,
          message,
        });
        vi.mocked(getSessionMessages).mockResolvedValueOnce([
          entry("assistant", "a1", toolUse.message),
          entry("user", "u1", toolResult),
        ] as never);
        resumedAt = client.notifications.length;
        await agent.request(v2.methods.agent.session.resume, {
          sessionId: response.sessionId,
          cwd,
          replayFrom: { type: "start" },
        });
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
        await vi.waitFor(() => expect(client.states()).toHaveLength(5));
        return response.sessionId;
      });

      const trace = updatesOf(client.notifications.slice(resumedAt), sessionId).flatMap((update) =>
        update.sessionUpdate === "terminal_update"
          ? [update.exitStatus ? "exit" : update.capabilities ? "cancellable" : "terminal"]
          : update.sessionUpdate === "state_update"
            ? [`${update.state} ${JSON.stringify(update.background)}`]
            : [],
      );
      // The snapshot's current state of the listed terminal, then its exit with its task.
      expect(trace.filter((entry) => entry !== "terminal")).toEqual([
        "cancellable",
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
        const client = v2Client();
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
        const client = v2Client({
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
      const client = v2Client();
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
      const client = v2Client({ answerElicitation: () => ({ action: "accept" }) });
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
      const client = v2Client();
      await client.connect(async (agent) => {
        await agent.request(v2.methods.agent.initialize, {
          protocolVersion: v2.PROTOCOL_VERSION,
          info: { name: "v2-test-client", version: "1.0.0" },
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
      const client = v2Client({
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
          info: { name: "v2-test-client", version: "1.0.0" },
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

  describe("a JetBrains AIR client", () => {
    /** The capabilities of an AIR client that declares `capabilities`. */
    const air = (...capabilities: string[]) =>
      ({ _meta: { jetbrains: { air: { version: 1, capabilities } } } }) as v2.ClientCapabilities;
    const airMeta = (payload: Record<string, unknown>) => ({
      jetbrains: { air: { version: 1, ...payload } },
    });

    it.each([
      [
        "an AIR client the AIR capabilities that v2 does not cover",
        air("loadReplayEnd"),
        airMeta({ capabilities: ["agentFileChangeReport", "recommendedValue"] }),
      ],
      ["any other client no AIR key", {}, undefined],
    ])("advertises to %s", async (_, capabilities, expected) => {
      const client = v2Client();
      const response = await client.connect((agent) =>
        agent.request(v2.methods.agent.initialize, {
          protocolVersion: v2.PROTOCOL_VERSION,
          info: { name: "v2-test-client", version: "1.0.0" },
          capabilities,
        }),
      );
      expect(response._meta).toEqual(expected);
    });

    it.each([
      ["declares recommendedValue", air("recommendedValue"), true],
      ["is AIR without recommendedValue", air(), false],
      ["is not AIR", {}, false],
    ])(
      "names the recommended model and effort only for a client that %s, and applies the effort",
      async (_, capabilities, recommended) => {
        const levels = ["low", "medium", "high"];
        sdk.models = [
          {
            value: "default",
            displayName: "Default",
            description: "Recommended",
            resolvedModel: "claude-opus-5",
            supportsEffort: true,
            supportedEffortLevels: levels,
          },
          {
            value: "opus",
            displayName: "Opus",
            description: "Most capable",
            resolvedModel: "claude-opus-5",
            supportsEffort: true,
            supportedEffortLevels: levels,
          },
        ];
        const client = v2Client();
        const { response, claude } = await client.connect((agent) =>
          openSession(agent, capabilities),
        );

        const option = (configId: string) =>
          response.configOptions?.find((entry) => entry.configId === configId) as {
            currentValue: unknown;
            options: Array<{ value: string }>;
            _meta?: unknown;
          };
        const values = (configId: string) => option(configId).options.map((entry) => entry.value);
        if (recommended) {
          expect(values("model")).toEqual(["opus"]);
          expect(option("model")).toMatchObject({
            currentValue: "opus",
            _meta: airMeta({ recommendedValue: "opus" }),
          });
          expect(values("effort")).toEqual(levels);
          expect(option("effort")).toMatchObject({
            currentValue: "medium",
            _meta: airMeta({ recommendedValue: "medium" }),
          });
          // The shown effort is the one Claude uses.
          expect(claude.applyFlagSettings).toHaveBeenCalledWith({ effortLevel: "medium" });
        } else {
          expect(values("model")).toContain("default");
          expect(option("model")._meta).toBeUndefined();
          expect(values("effort")).toEqual(["default", ...levels]);
          expect(option("effort")._meta).toBeUndefined();
          expect(claude.applyFlagSettings).not.toHaveBeenCalled();
        }
      },
    );

    it.each([
      ["an AIR client the AIR presentation", air(), true],
      ["any other client none", {}, false],
    ])("gives a permission request of %s", async (_, capabilities, airClient) => {
      const client = v2Client();
      await client.connect(async (agent) => {
        const { claude } = await openSession(agent, capabilities);
        // A subagent's request, on its session, of a tool that the stream did not show yet.
        claude.send(cycleStart());
        claude.send(subagent("child", "toolu_launch").launch());
        claude.send(subagent("child", "toolu_launch").started());
        await vi.waitFor(() => expect(client.states()).toEqual(["running"]));
        await askPermission(
          claude,
          "mcp__docs__search",
          { query: "x" },
          {
            agentID: "child",
            mcpServer: { name: "docs", source: "sdk" },
            decisionReason: "Asks every time",
          },
        );
      });

      const request = client.permissionRequests[0];
      expect(request.sessionId).toBe("child");
      const subject = request.subject as { toolCall: { _meta?: unknown } };
      const mcpServer = { name: "docs", source: "sdk" };
      if (airClient) {
        expect(request._meta).toEqual(
          airMeta({
            permission: {
              version: 1,
              title: request.title,
              description: "Reason: Asks every time",
            },
          }),
        );
        // AIR's rule (`permissionToolCallMeta`): no Agent call of the subagent.
        expect(subject.toolCall._meta).toEqual({ claudeCode: { mcpServer } });
      } else {
        expect(request._meta).toBeUndefined();
        expect(subject.toolCall._meta).toEqual({
          claudeCode: { parentToolUseId: "toolu_launch", mcpServer },
        });
      }
    });

    it.each([
      ["an AIR client", air(), true],
      ["any other client", {}, false],
    ])(
      "marks AskUserQuestion's custom answer field for %s only",
      async (_, capabilities, marked) => {
        const client = v2Client({
          answerElicitation: () => ({ action: "accept", content: {} }),
        });
        await client.connect(async (agent) => {
          const { claude } = await openSession(agent, {
            ...capabilities,
            elicitation: { form: {} },
          });
          await claude.options.canUseTool!(
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

        const properties = Object.values(
          (client.elicitations[0] as { requestedSchema: { properties: Record<string, unknown> } })
            .requestedSchema.properties,
        ) as Array<{ _meta?: unknown }>;
        const markers = properties.flatMap((property) => (property._meta ? [property._meta] : []));
        expect(markers).toEqual(
          marked
            ? [
                {
                  _askUserQuestionCustomAnswer: { questionId: "question_0", isCustomAnswer: true },
                  ...airMeta({
                    customAnswer: { questionId: "question_0", isCustomAnswer: true },
                  }),
                },
              ]
            : [],
        );
      },
    );

    it.each([
      ["an AIR client", air(), true],
      ["any other client", {}, false],
    ])(
      "sends %s the predicted follow-up prompt, cleared at the next prompt and at a reset",
      async (_, capabilities, predicted) => {
        const client = v2Client();
        const suggestion = (text: string) => ({
          type: "prompt_suggestion",
          suggestion: text,
          uuid: randomUUID(),
          session_id: "session",
        });
        const { claude, sessionId } = await client.connect(async (agent) => {
          const { response, claude } = await openSession(agent, capabilities);
          const prompt = async (index: number) => {
            const answer = agent.request(v2.methods.agent.session.prompt, {
              sessionId: response.sessionId,
              prompt: PROMPT,
            });
            claude.send(echo(await claude.prompt(index)));
            await answer;
          };
          await prompt(0);
          claude.send(result());
          claude.send(suggestion("Run the tests"));
          claude.send(sessionState("idle"));
          await vi.waitFor(() => expect(client.states()).toEqual(["running", "idle"]));
          await prompt(1);
          // A prediction that the next prompt outran: no result opened its window.
          claude.send(suggestion("Stale"));
          claude.send(result());
          claude.send(suggestion("Commit"));
          claude.send({
            type: "conversation_reset",
            new_conversation_id: randomUUID(),
            uuid: randomUUID(),
            trigger: "clear",
            timestamp: new Date().toISOString(),
            session_id: "session",
          });
          claude.send(sessionState("idle"));
          await vi.waitFor(() =>
            expect(client.states()).toEqual(["running", "idle", "running", "idle"]),
          );
          return { claude, sessionId: response.sessionId };
        });

        const sent = updatesOf(client.notifications, sessionId).flatMap((update) => {
          const meta = update._meta as { promptSuggestions?: { suggestions: unknown } } | null;
          return update.sessionUpdate === "session_info_update" && meta?.promptSuggestions
            ? [meta.promptSuggestions.suggestions]
            : [];
        });
        expect(sent).toEqual(
          predicted ? [[{ text: "Run the tests" }], [], [{ text: "Commit" }], []] : [],
        );
        expect(claude.options.promptSuggestions).toBe(predicted ? true : undefined);
      },
    );

    it("leaves the predicted prompt off when the client's options turn it off", async () => {
      const client = v2Client();
      await client.connect(async (agent) => {
        await agent.request(v2.methods.agent.initialize, {
          protocolVersion: v2.PROTOCOL_VERSION,
          info: { name: "v2-test-client", version: "1.0.0" },
          capabilities: air(),
        });
        await agent.request(v2.methods.agent.session.new, {
          cwd,
          _meta: { claudeCode: { options: { promptSuggestions: false } } },
        });
      });
      expect(sdk.processes[0].options.promptSuggestions).toBe(false);
    });

    describe("the agent file-change report", () => {
      const requestMeta = (requestId: string) => ({
        jetbrains: { air: { agentFileChangeReportRequest: { version: 1, requestId } } },
      });
      const reports = (updates: v2.SessionUpdate[]) =>
        updates.flatMap((update) => {
          const report = (update._meta as any)?.jetbrains?.air?.agentFileChangeReport;
          return update.sessionUpdate === "session_info_update" && report ? [report] : [];
        });

      it("lists the files of the prompt's checkpoint at its turn's end, before the idle", async () => {
        const client = v2Client();
        const changed = path.join(await realpath(cwd), "src", "App.ts");
        const { claude, sessionId, uuid } = await client.connect(async (agent) => {
          const { response, claude } = await openSession(agent, air("agentFileChangeReport"));
          claude.rewindFiles.mockResolvedValue({ canRewind: true, filesChanged: [changed] });
          const answer = agent.request(v2.methods.agent.session.prompt, {
            sessionId: response.sessionId,
            prompt: PROMPT,
            _meta: requestMeta("r-1"),
          });
          const prompt = await claude.prompt(0);
          claude.send(echo(prompt));
          await answer;
          claude.send(result());
          await vi.waitFor(() => expect(client.states()).toEqual(["running", "idle"]));
          return { claude, sessionId: response.sessionId, uuid: prompt.uuid };
        });

        expect(claude.options.enableFileCheckpointing).toBe(true);
        expect(claude.rewindFiles).toHaveBeenCalledWith(uuid, { dryRun: true });
        const updates = updatesOf(client.notifications, sessionId);
        expect(reports(updates)).toEqual([
          {
            version: 1,
            requestId: "r-1",
            status: "reported",
            paths: [changed],
            declaredComplete: false,
            truncated: false,
          },
        ]);
        const reportAt = updates.findIndex((update) => reports([update]).length > 0);
        const idleAt = updates.findIndex(
          (update) =>
            update.sessionUpdate === "state_update" &&
            (update as { state: string }).state === "idle",
        );
        expect(reportAt).toBeLessThan(idleAt);
      });

      it("reads the report of a turn whose plan ran in a fresh context from the plan's prompt", async () => {
        const client = v2Client({
          answerPermission: () => ({
            outcome: { outcome: "selected", optionId: "exit-plan-clear-auto" },
          }),
        });
        const changed = path.join(await realpath(cwd), "src", "App.ts");
        const { claude, sessionId, plan } = await client.connect(async (agent) => {
          const { response, claude } = await openSession(agent, air("agentFileChangeReport"));
          claude.rewindFiles.mockResolvedValue({ canRewind: true, filesChanged: [changed] });
          const answer = agent.request(v2.methods.agent.session.prompt, {
            sessionId: response.sessionId,
            prompt: PROMPT,
            _meta: requestMeta("r-1"),
          });
          claude.send(echo(await claude.prompt(0)));
          await answer;
          claude.send(
            assistant("msg_plan", [
              {
                type: "tool_use",
                id: "toolu_plan",
                name: "ExitPlanMode",
                input: { plan: "Do it" },
              },
            ]),
          );
          await askPermission(
            claude,
            "ExitPlanMode",
            { plan: "Do it" },
            { toolUseID: "toolu_plan" },
          );
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
              errors: [
                "[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=tool_use",
              ],
            }),
          );
          claude.send(sessionState("idle"));
          const clear = await claude.prompt(1);
          claude.send(echo(clear));
          claude.send({
            type: "conversation_reset",
            new_conversation_id: randomUUID(),
            uuid: randomUUID(),
            trigger: "clear",
            timestamp: new Date().toISOString(),
            session_id: "session",
          });
          claude.send(result({ num_turns: 0, stop_reason: null }));
          // `/clear` reset Claude Code's file history: only the plan's prompt has a checkpoint.
          const plan = await claude.prompt(2);
          claude.send(echo(plan));
          claude.send(result());
          claude.send(sessionState("idle"));
          await vi.waitFor(() => expect(client.states().at(-1)).toBe("idle"));
          return { claude, sessionId: response.sessionId, plan };
        });

        expect(claude.rewindFiles).toHaveBeenCalledExactlyOnceWith(plan.uuid, { dryRun: true });
        expect(reports(updatesOf(client.notifications, sessionId))).toEqual([
          {
            version: 1,
            requestId: "r-1",
            status: "reported",
            paths: [changed],
            declaredComplete: false,
            truncated: false,
          },
        ]);
      });

      it.each([
        ["a cancel answered with -32800 before its insertion", false, "cancel", "cancelled"],
        ["a cancel stopped after its insertion", true, "cancel", "cancelled"],
        ["ended with an error result", true, "error", "providerError"],
        ["ended without a result, as the query ended", true, "end", "providerError"],
        [
          "failed otherwise before its insertion, as the query ended",
          false,
          "end",
          "providerError",
        ],
      ] as const)(
        "reports a prompt that %s unavailable, without reading a checkpoint",
        async (_, insert, end, reason) => {
          const client = v2Client();
          const { claude, sessionId } = await client.connect(async (agent) => {
            const { response, claude } = await openSession(agent, air("agentFileChangeReport"));
            const sessionId = response.sessionId;
            const answer = agent
              .request(v2.methods.agent.session.prompt, {
                sessionId,
                prompt: PROMPT,
                _meta: requestMeta("r-1"),
              })
              .catch((error: unknown) => error);
            const prompt = await claude.prompt(0);
            if (insert) {
              claude.send(echo(prompt));
              expect(await answer).toEqual({ messageId: prompt.uuid });
            }
            if (end === "cancel") {
              await agent.notify(v2.methods.agent.session.cancel, { sessionId });
              if (insert) {
                await vi.waitFor(() => expect(claude.interrupt).toHaveBeenCalled());
                claude.send(
                  result({
                    subtype: "error_during_execution",
                    is_error: true,
                    terminal_reason: "aborted_streaming",
                  }),
                );
                claude.send(sessionState("idle"));
              }
            } else if (end === "error") {
              claude.send(
                result({
                  subtype: "error_during_execution",
                  is_error: true,
                  errors: ["Overloaded"],
                }),
              );
              claude.send(sessionState("idle"));
            } else {
              claude.end(new Error("Claude Code exited"));
            }
            if (!insert) {
              expect(await answer).toMatchObject({ code: end === "cancel" ? -32800 : -32603 });
            }
            await vi.waitFor(() =>
              expect(reports(updatesOf(client.notifications, sessionId))).toHaveLength(1),
            );
            return { claude, sessionId };
          });

          expect(claude.rewindFiles).not.toHaveBeenCalled();
          expect(reports(updatesOf(client.notifications, sessionId))).toEqual([
            { version: 1, requestId: "r-1", status: "unavailable", reason },
          ]);
        },
      );

      it.each([
        ["an AIR client without the capability", air()],
        ["any other client", {}],
      ])("sends %s no report and keeps checkpoints off", async (_, capabilities) => {
        const client = v2Client();
        const claude = await client.connect(async (agent) => {
          const { response, claude } = await openSession(agent, capabilities);
          const answer = agent.request(v2.methods.agent.session.prompt, {
            sessionId: response.sessionId,
            prompt: PROMPT,
            _meta: requestMeta("r-1"),
          });
          claude.send(echo(await claude.prompt(0)));
          await answer;
          claude.send(result());
          await vi.waitFor(() => expect(client.states()).toEqual(["running", "idle"]));
          return claude;
        });

        expect(claude.options.enableFileCheckpointing).toBeUndefined();
        expect(claude.rewindFiles).not.toHaveBeenCalled();
        expect(reports(client.sessionUpdates)).toEqual([]);
      });

      it("sends no report for the adapter's own /remote-control, as v1", async () => {
        sdk.enableRemoteControl = vi.fn(async () => ({
          session_url: "https://claude.ai/code/session_123",
        }));
        const client = v2Client();
        await client.connect(async (agent) => {
          const { response } = await openSession(agent, air("agentFileChangeReport"));
          await agent.request(v2.methods.agent.session.prompt, {
            sessionId: response.sessionId,
            prompt: [{ type: "text", text: "/remote-control" }],
            _meta: requestMeta("r-1"),
          });
          await vi.waitFor(() => expect(client.states()).toEqual(["running", "idle"]));
        });

        expect(sdk.enableRemoteControl).toHaveBeenCalled();
        expect(reports(client.sessionUpdates)).toEqual([]);
      });
    });
  });

  const AIR_CAPABILITIES = { _meta: { jetbrains: { air: { version: 1, capabilities: [] } } } };
  it.each([
    { client: "a plain", capabilities: {} },
    { client: "an AIR", capabilities: AIR_CAPABILITIES },
  ] as const)("serves $client v2 client with the v2 core", async ({ capabilities }) => {
    const v1Agents: { dispose(): Promise<void> }[] = [];
    const v2Agents: AgentHandle[] = [];
    const toAgent = new TransformStream<v2.AnyMessage, v2.AnyMessage>();
    const toClient = new TransformStream<v2.AnyMessage, v2.AnyMessage>();
    acpProtocolRouter(undefined, (agent) => v1Agents.push(agent), "v2", {
      onV2Agent: (agent) => v2Agents.push(agent),
    }).connect({ readable: toAgent.readable, writable: toClient.writable });
    try {
      await v2
        .client({ name: "test-client" })
        .connectWith({ readable: toClient.readable, writable: toAgent.writable }, (agent) =>
          agent.request(v2.methods.agent.initialize, {
            protocolVersion: v2.PROTOCOL_VERSION,
            info: { name: "test-client", version: "1" },
            capabilities,
          }),
        );
      expect({ v2: v2Agents.length, v1: v1Agents.length }).toEqual({ v2: 1, v1: 0 });
    } finally {
      await Promise.all([...v1Agents, ...v2Agents].map((agent) => agent.dispose()));
    }
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
