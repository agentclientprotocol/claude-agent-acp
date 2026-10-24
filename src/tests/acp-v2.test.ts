/**
 * The experimental draft ACP v2 surface, driven through the protocol router
 * with the SDK's own v1 and v2 client apps. The v2 client app validates every
 * response, session update, and elicitation it receives against the v2
 * schema, so a malformed v2 message fails the test.
 */
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as v1 from "@agentclientprotocol/sdk/unstable";
import * as v2 from "@agentclientprotocol/sdk/experimental/v2/unstable";
import {
  forkSession,
  getSessionMessages,
  type Options,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { ClaudeAcpAgent } from "../acp-agent.js";
import type { AuthStatusUpdateNotification } from "../auth-status.js";
import { clientSupportsCompactionUpdates } from "../context-compaction.js";
import { v2DiffContent } from "../diff.js";
import { type AcpProtocols, acpProtocolRouter, acpProtocolsFromEnv } from "../serve.js";
import { clientSupportsNotices } from "../session-notices.js";
import { v1PermissionResponse, v2PermissionRequest } from "../v2/permission.js";
import { v1PromptRequest } from "../v2/prompt.js";
import { V2Terminals } from "../v2/terminal.js";
import { V2ToolCallMeta } from "../v2/tool-call-meta.js";
import { v2ChildStateUpdate, v2SessionUpdate } from "../v2/session-update.js";
import {
  v1ForkSessionRequest,
  v1NewSessionRequest,
  v1RestoreSessionRequest,
  v1SetSessionConfigOptionRequest,
  v2ConfigOptions,
} from "../v2/session.js";
import packageJson from "../../package.json" with { type: "json" };

const execFileSpy = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return { ...actual, execFile: execFileSpy };
});

/** What the mocked Claude Agent SDK saw and answers. Reset before each test. */
const sdk = vi.hoisted(() => ({
  queryOptions: [] as Options[],
  /** What Claude Code sends, given the prompts it receives (see `scriptTurns`). */
  run: async function* (
    _prompts: AsyncIterable<SDKUserMessage>,
    _options: Options,
  ): AsyncGenerator<Record<string, unknown>> {},
  /** Claude Code receives an interrupt, as `cancel()` sends one. */
  interrupt: async (): Promise<void> => {},
  /** Claude Code stops one task, as `cancel()` does for a child session. */
  stopTask: async (_taskId: string): Promise<void> => {},
  /** The query is closed, as `session/close` closes it. */
  close: (): void => {},
  mcpServerStatus: async (): Promise<Array<{ name: string; status: string }>> => [],
  mcpAuthenticate: async (
    _serverName: string,
  ): Promise<{ authUrl?: string; requiresUserAction: boolean; callbackExpected: boolean }> => ({
    requiresUserAction: false,
    callbackExpected: false,
  }),
}));
const sdkDefaults = { ...sdk };

vi.mock("@anthropic-ai/claude-agent-sdk", async () => {
  const actual = await vi.importActual<typeof import("@anthropic-ai/claude-agent-sdk")>(
    "@anthropic-ai/claude-agent-sdk",
  );
  const { makeMockQuery } = await import("./helpers.js");
  return {
    ...actual,
    query: ({ prompt, options }: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => {
      sdk.queryOptions.push(options);
      // The agent reads the query with `next()`, so it is the generator itself.
      const messages = sdk.run(prompt, options);
      const controls = makeMockQuery({
        [Symbol.asyncIterator]: () => messages,
        initializationResult: async () => ({
          models: [
            {
              value: "claude-sonnet-4-6",
              displayName: "Claude Sonnet",
              description: "Fast",
              supportsAutoMode: true,
            },
          ],
        }),
        supportedCommands: async () => [
          { name: "review", description: "Review a change", argumentHint: "<pull request>" },
        ],
        mcpServerStatus: () => sdk.mcpServerStatus(),
        mcpAuthenticate: (serverName: string) => sdk.mcpAuthenticate(serverName),
        interrupt: () => sdk.interrupt(),
        stopTask: (taskId: string) => sdk.stopTask(taskId),
        close: () => sdk.close(),
      });
      return Object.assign(messages, controls);
    },
    listSessions: vi.fn(async () => [
      {
        sessionId: "11111111-2222-4333-8444-555555555555",
        cwd: "/workspace/project",
        summary: "Fix the build",
        lastModified: Date.UTC(2026, 9, 1),
      },
    ]),
    getSessionMessages: vi.fn(async () => []),
    forkSession: vi.fn(async () => ({ sessionId: "99999999-8888-4777-8666-555555555555" })),
    deleteSession: vi.fn(async () => {}),
  };
});

vi.mock("../tools.js", async () => ({
  ...(await vi.importActual<typeof import("../tools.js")>("../tools.js")),
  registerHookCallback: vi.fn(),
}));

const CLI_SUBSCRIPTION = JSON.stringify({
  loggedIn: true,
  authMethod: "claude.ai",
  apiProvider: "firstParty",
  email: "user@example.com",
  subscriptionType: "max",
});

const V2_CLIENT_INFO = { name: "v2-test-client", version: "1.0.0" };

const agents: ClaudeAcpAgent[] = [];
/** An empty Claude config directory and a session cwd, so no test reads the real ones. */
let tempDir: string;
let cwd: string;

beforeEach(async () => {
  // `claude auth status --json` reports a subscription, `claude auth logout` succeeds.
  execFileSpy.mockImplementation((...invocation: unknown[]) => {
    const args = invocation[1] as string[];
    const callback = invocation[invocation.length - 1] as (...a: unknown[]) => void;
    callback(null, { stdout: args[1] === "status" ? CLI_SUBSCRIPTION : "", stderr: "" });
  });
  tempDir = await mkdtemp(path.join(os.tmpdir(), "acp-v2-"));
  cwd = await mkdtemp(path.join(tempDir, "project-"));
  vi.stubEnv("CLAUDE_CONFIG_DIR", path.join(tempDir, "claude"));
  Object.assign(sdk, sdkDefaults, { queryOptions: [] });
});

afterEach(async () => {
  await Promise.all(agents.splice(0).map((agent) => agent.dispose()));
  execFileSpy.mockReset();
  vi.unstubAllEnvs();
  await rm(tempDir, { recursive: true, force: true });
});

/** Connects a fresh router to a client, and returns the client end of the stream. */
function connectRouter(protocols?: AcpProtocols): v2.Stream {
  const toAgent = new TransformStream<v2.AnyWireMessage, v2.AnyWireMessage>();
  const toClient = new TransformStream<v2.AnyWireMessage, v2.AnyWireMessage>();
  acpProtocolRouter(undefined, (agent) => agents.push(agent), protocols).connect({
    readable: toAgent.readable,
    writable: toClient.writable,
  });
  return { readable: toClient.readable, writable: toAgent.writable };
}

/**
 * A v2 client app that collects every `_auth/status_update`, session update,
 * elicitation, and permission request it receives, answers elicitations with
 * `answerElicitation` (it accepts them), and answers permission requests with
 * `answerPermission`.
 */
function v2Client({
  answerPermission = () => ({ outcome: { outcome: "cancelled" } }),
  answerElicitation = () => ({ action: "accept" }),
}: {
  answerPermission?: (request: v2.RequestPermissionRequest) => v2.RequestPermissionResponse;
  answerElicitation?: (
    request: v2.CreateElicitationRequest,
  ) => v2.CreateElicitationResponse | Promise<v2.CreateElicitationResponse>;
} = {}) {
  const authUpdates: AuthStatusUpdateNotification[] = [];
  const sessionUpdates: v2.UpdateSessionNotification[] = [];
  const elicitations: v2.CreateElicitationRequest[] = [];
  const completedElicitations: v2.CompleteElicitationNotification[] = [];
  const permissionRequests: v2.RequestPermissionRequest[] = [];
  let notifyAuthUpdate = () => {};
  const app = v2
    .client({ name: V2_CLIENT_INFO.name })
    .onNotification(
      "_auth/status_update",
      (params) => params as AuthStatusUpdateNotification,
      ({ params }) => {
        authUpdates.push(params);
        notifyAuthUpdate();
      },
    )
    .onNotification(v2.methods.client.session.update, ({ params }) => {
      sessionUpdates.push(params);
    })
    .onRequest(v2.methods.client.elicitation.create, ({ params }) => {
      elicitations.push(params);
      return answerElicitation(params);
    })
    .onNotification(v2.methods.client.elicitation.complete, ({ params }) => {
      completedElicitations.push(params);
    })
    .onRequest(v2.methods.client.session.requestPermission, ({ params }) => {
      permissionRequests.push(params);
      return answerPermission(params);
    });
  /** Resolves once the client has received `count` auth status updates. */
  const authUpdate = (count: number) =>
    new Promise<AuthStatusUpdateNotification>((resolve) => {
      notifyAuthUpdate = () => {
        if (authUpdates.length >= count) {
          resolve(authUpdates[count - 1]);
        }
      };
      notifyAuthUpdate();
    });
  /** The session updates of one kind that the client has received. */
  const updates = <Kind extends string>(kind: Kind) =>
    sessionUpdates
      .map((notification) => notification.update)
      .filter(
        (update): update is Extract<v2.SessionUpdate, { sessionUpdate: Kind }> =>
          update.sessionUpdate === kind,
      );
  return {
    app,
    authUpdate,
    sessionUpdates,
    updates,
    elicitations,
    completedElicitations,
    permissionRequests,
  };
}

async function initializeV2(agent: v2.ClientContext, capabilities: v2.ClientCapabilities = {}) {
  return agent.request(v2.methods.agent.initialize, {
    protocolVersion: v2.PROTOCOL_VERSION,
    info: V2_CLIENT_INFO,
    capabilities,
  });
}

describe("ACP protocol routing", () => {
  it("serves the unchanged v1 handshake to a v1 client", async () => {
    let authUpdated!: () => void;
    const authUpdate = new Promise<void>((resolve) => (authUpdated = resolve));
    const response = await v1
      .client({ name: "v1-test-client" })
      .onNotification(
        "_auth/status_update",
        (params) => params,
        () => authUpdated(),
      )
      .connectWith(connectRouter() as unknown as v1.Stream, async (agent) => {
        const response = await agent.request(v1.methods.agent.initialize, {
          protocolVersion: v1.PROTOCOL_VERSION,
          clientCapabilities: { auth: { terminal: true } },
        });
        await authUpdate;
        return response;
      });

    expect(response.protocolVersion).toBe(1);
    expect(response.agentCapabilities?.loadSession).toBe(true);
    expect(response.agentCapabilities?.sessionCapabilities?.resume).toEqual({});
    expect(response.authMethods?.length).toBeGreaterThan(0);
    for (const method of response.authMethods ?? []) {
      expect(method).toHaveProperty("id");
    }
  });

  it("serves the v2 handshake to a v2 client", async () => {
    const { app, authUpdate } = v2Client();
    const response = await app.connectWith(connectRouter(), async (agent) => {
      const response = await agent.request(v2.methods.agent.initialize, {
        protocolVersion: v2.PROTOCOL_VERSION,
        info: V2_CLIENT_INFO,
        capabilities: { auth: { terminal: {} } },
      });
      await authUpdate(1);
      return response;
    });

    expect(response.protocolVersion).toBe(2);
    expect(response.info).toEqual({
      name: packageJson.name,
      title: "Claude Agent",
      version: packageJson.version,
    });
    // The session baseline and the session extensions that the v2 surface serves,
    // and the providers methods.
    expect(response.capabilities?.session).toEqual({
      prompt: { image: {}, embeddedContext: {} },
      mcp: { stdio: {}, http: {} },
      delete: {},
      fork: {},
      additionalDirectories: {},
      systemPrompt: { mode: { override: {} } },
    });
    expect(response.capabilities?.providers).toEqual({});
    // Not `_session/steering`, which v1 advertises in the top-level `_meta`.
    expect(response._meta?.steering).toBeUndefined();
    expect(response.authMethods?.length).toBeGreaterThan(0);
    for (const method of response.authMethods ?? []) {
      expect(method).not.toHaveProperty("id");
      expect(method).toMatchObject({ methodId: expect.any(String), type: "terminal" });
      expect((method as v2.AuthMethodTerminal).args?.[0]).toBe("--cli");
    }
  });

  it("negotiates a v2 client down to v1 when limited to v1", async () => {
    // On the raw stream, since the v2 client app cannot read the v1 response
    // that a real client would switch to v1 on.
    const stream = connectRouter("v1");
    const writer = stream.writable.getWriter();
    await writer.write({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: v2.PROTOCOL_VERSION, info: V2_CLIENT_INFO, capabilities: {} },
    });
    const reader = stream.readable.getReader();
    let response: v2.AnyWireMessage | undefined;
    while (!response) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!Array.isArray(value) && "id" in value && value.id === 1) response = value;
    }
    await writer.close();

    expect(response).toMatchObject({ id: 1, result: { protocolVersion: 1 } });
  });

  it("rejects a v1 client when limited to v2", async () => {
    const initialize = v1
      .client({ name: "v1-test-client" })
      .connectWith(connectRouter("v2") as unknown as v1.Stream, (agent) =>
        agent.request(v1.methods.agent.initialize, {
          protocolVersion: v1.PROTOCOL_VERSION,
          clientCapabilities: {},
        }),
      );

    await expect(initialize).rejects.toThrow(/Unsupported protocol version/);
    expect(agents).toHaveLength(0);
  });

  it("reads the protocols to serve from CLAUDE_AGENT_ACP_PROTOCOL", () => {
    expect(acpProtocolsFromEnv(undefined)).toBe("auto");
    expect(acpProtocolsFromEnv("")).toBe("auto");
    expect(acpProtocolsFromEnv("auto")).toBe("auto");
    expect(acpProtocolsFromEnv("v1")).toBe("v1");
    expect(acpProtocolsFromEnv("v2")).toBe("v2");
    expect(() => acpProtocolsFromEnv("1")).toThrow(/CLAUDE_AGENT_ACP_PROTOCOL/);
  });
});

/** The commands of every session of the mocked SDK, in v2 form. */
const SESSION_COMMANDS: v2.AvailableCommand[] = [
  {
    name: "review",
    description: "Review a change",
    input: { type: "text", hint: "<pull request>" },
  },
  {
    name: "mcp",
    description: "Show the MCP servers and their status, or reconnect, enable, or disable a server",
    input: { type: "text", hint: "[reconnect|enable|disable [<server>|all]]" },
  },
];

describe("ACP v2 sessions", () => {
  it("creates a session with v2 MCP servers, config options, and commands", async () => {
    const client = v2Client();
    const response = await client.app.connectWith(connectRouter(), async (agent) => {
      await initializeV2(agent);
      const response = await agent.request(v2.methods.agent.session.new, {
        cwd,
        mcpServers: [
          { type: "stdio", name: "files", command: "/usr/local/bin/mcp-files" },
          { type: "http", name: "linear", url: "https://mcp.linear.app/mcp" },
        ],
      });
      await client.authUpdate(1);
      // The agent's post-setup work runs on a timer.
      await new Promise((resolve) => setTimeout(resolve, 20));
      return response;
    });

    // A v2 stdio server has a `type`, which v1 omits, and may omit its lists.
    expect(sdk.queryOptions[0].mcpServers).toMatchObject({
      files: { type: "stdio", command: "/usr/local/bin/mcp-files", args: [] },
      linear: { type: "http", url: "https://mcp.linear.app/mcp" },
    });
    expect(response).not.toHaveProperty("modes");
    expect(response.configOptions?.map((option) => option.configId)).toEqual(["mode", "model"]);
    for (const option of response.configOptions ?? []) {
      expect(option).not.toHaveProperty("id");
    }
    expect(response.configOptions?.[0]).toMatchObject({ category: "mode", type: "select" });
    // The commands come in the response, so no update repeats them.
    expect(response.availableCommands).toEqual(SESSION_COMMANDS);
    expect(client.updates("available_commands_update")).toEqual([]);
  });

  it("lists the commands in every setup response: resume, resume with replay, and fork", async () => {
    const client = v2Client();
    const responses = await client.app.connectWith(connectRouter(), async (agent) => {
      await initializeV2(agent);
      const { sessionId } = await agent.request(v2.methods.agent.session.new, { cwd });
      const resumed = await agent.request(v2.methods.agent.session.resume, { sessionId, cwd });
      const replayed = await agent.request(v2.methods.agent.session.resume, {
        sessionId,
        cwd,
        replayFrom: { type: "start" },
      });
      const forked = await agent.request(v2.methods.agent.session.fork, { sessionId, cwd });
      await client.authUpdate(1);
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { resumed, replayed, forked };
    });

    expect(responses.resumed.availableCommands).toEqual(SESSION_COMMANDS);
    expect(responses.replayed.availableCommands).toEqual(SESSION_COMMANDS);
    expect(responses.forked.availableCommands).toEqual(SESSION_COMMANDS);
    expect(client.updates("available_commands_update")).toEqual([]);
  });

  it("rejects an MCP transport that v1 cannot express", async () => {
    const { app, authUpdate } = v2Client();
    await app.connectWith(connectRouter(), async (agent) => {
      await initializeV2(agent);
      await expect(
        agent.request(v2.methods.agent.session.new, {
          cwd,
          mcpServers: [{ type: "_custom", name: "custom" }],
        }),
      ).rejects.toMatchObject({ code: -32602 });
      await authUpdate(1);
    });
    expect(sdk.queryOptions).toHaveLength(0);
  });

  it("lists, resumes, closes, and deletes sessions", async () => {
    const { app, authUpdate } = v2Client();
    await app.connectWith(connectRouter(), async (agent) => {
      await initializeV2(agent);
      expect(await agent.request(v2.methods.agent.session.list, {})).toEqual({
        sessions: [
          {
            sessionId: "11111111-2222-4333-8444-555555555555",
            cwd: "/workspace/project",
            title: "Fix the build",
            updatedAt: "2026-10-01T00:00:00.000Z",
          },
        ],
      });

      const { sessionId } = await agent.request(v2.methods.agent.session.new, { cwd });
      await agent.request(v2.methods.agent.session.close, { sessionId });
      // A closed session is resumed from its transcript.
      const resumed = await agent.request(v2.methods.agent.session.resume, { sessionId, cwd });
      expect(sdk.queryOptions.at(-1)?.resume).toBe(sessionId);
      expect(resumed).not.toHaveProperty("modes");
      expect(resumed.configOptions?.[0].configId).toBe("mode");

      // v1 replays only from the start.
      await expect(
        agent.request(v2.methods.agent.session.resume, {
          sessionId,
          cwd,
          replayFrom: { type: "_message", messageId: "m" },
        }),
      ).rejects.toMatchObject({ code: -32602 });

      await agent.request(v2.methods.agent.session.delete, { sessionId });
      await authUpdate(1);
    });
  });

  it("sets a config option with a v2 value and reports modes only as config options", async () => {
    const client = v2Client();
    const response = await client.app.connectWith(connectRouter(), async (agent) => {
      await initializeV2(agent);
      const { sessionId } = await agent.request(v2.methods.agent.session.new, { cwd });
      const response = await agent.request(v2.methods.agent.session.setConfigOption, {
        sessionId,
        configId: "mode",
        type: "id",
        value: "plan",
      });
      await client.authUpdate(1);
      return response;
    });

    expect(response.configOptions[0]).toMatchObject({ configId: "mode", currentValue: "plan" });
    expect(client.updates("current_mode_update")).toEqual([]);
  });

  it("tells the agent that a v2 client takes notices and compaction updates", async () => {
    const { app, authUpdate } = v2Client();
    await app.connectWith(connectRouter(), async (agent) => {
      await initializeV2(agent);
      await authUpdate(1);
    });
    expect(clientSupportsNotices(agents[0].clientCapabilities)).toBe(true);
    expect(clientSupportsCompactionUpdates(agents[0].clientCapabilities)).toBe(true);
  });

  it("forwards the URL elicitation of MCP OAuth to a v2 client", async () => {
    let statusCall = 0;
    sdk.mcpServerStatus = async () =>
      statusCall++ === 0
        ? [{ name: "linear", status: "needs-auth" }]
        : [{ name: "linear", status: "connected" }];
    sdk.mcpAuthenticate = async () => ({
      authUrl: "https://example.com/oauth/authorize",
      requiresUserAction: true,
      callbackExpected: true,
    });
    const client = v2Client();
    const sessionId = await client.app.connectWith(connectRouter(), async (agent) => {
      await initializeV2(agent, { elicitation: { url: {} } });
      const { sessionId } = await agent.request(v2.methods.agent.session.new, {
        cwd,
        mcpServers: [{ type: "http", name: "linear", url: "https://mcp.linear.app/mcp" }],
      });
      await vi.waitFor(() => expect(client.completedElicitations).toHaveLength(1));
      await client.authUpdate(1);
      return sessionId;
    });

    expect(client.elicitations).toEqual([
      {
        mode: "url",
        sessionId,
        message: "Authenticate with MCP server linear",
        url: "https://example.com/oauth/authorize",
        elicitationId: expect.stringMatching(/^mcp-oauth-/),
      },
    ]);
    expect(client.completedElicitations).toEqual([
      { elicitationId: (client.elicitations[0] as { elicitationId: string }).elicitationId },
    ]);
  });
});

/** Claude Code's side of one prompt, after it echoed the prompt. */
type TurnScript = (options: Options) => AsyncGenerator<Record<string, unknown>>;

/**
 * Claude Code takes in each prompt it receives in order, echoes it, and runs
 * the next of `turns` for it. Returns the uuids of the echoed prompts.
 */
function scriptTurns(...turns: TurnScript[]): string[] {
  const echoed: string[] = [];
  sdk.run = async function* (prompts, options) {
    const input = prompts[Symbol.asyncIterator]();
    for (const turn of turns) {
      const { value, done } = await input.next();
      if (done) return;
      echoed.push(value.uuid!);
      yield {
        type: "user",
        message: value.message,
        parent_tool_use_id: null,
        uuid: value.uuid,
        session_id: options.sessionId,
        isReplay: true,
      };
      yield* turn(options);
    }
    // Later prompts are taken off the input without an answer.
    while (!(await input.next()).done);
  };
  return echoed;
}

/** An entry of a Claude Code transcript, as `getSessionMessages` returns it. */
function transcriptEntry(type: "user" | "assistant", uuid: string, message: unknown) {
  return { type, uuid, session_id: "session", parent_tool_use_id: null, message };
}

function stream(options: Options, event: Record<string, unknown>) {
  return {
    type: "stream_event",
    event,
    parent_tool_use_id: null,
    uuid: randomUUID(),
    session_id: options.sessionId,
  };
}

function idleState(options: Options) {
  return {
    type: "system",
    subtype: "session_state_changed",
    state: "idle",
    uuid: randomUUID(),
    session_id: options.sessionId,
  };
}

function assistantText(options: Options, text: string, id = "msg_answer") {
  return {
    type: "assistant",
    message: {
      id,
      type: "message",
      role: "assistant",
      model: "claude-sonnet-4-6",
      content: [{ type: "text", text }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 3, output_tokens: 2 },
    },
    parent_tool_use_id: null,
    uuid: randomUUID(),
    session_id: options.sessionId,
  };
}

function result(options: Options, overrides: Record<string, unknown> = {}) {
  return {
    type: "result",
    subtype: "success",
    stop_reason: "end_turn",
    is_error: false,
    result: "",
    errors: [],
    duration_ms: 0,
    duration_api_ms: 0,
    num_turns: 1,
    total_cost_usd: 0,
    usage: {
      input_tokens: 3,
      output_tokens: 2,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
    modelUsage: {},
    permission_denials: [],
    uuid: randomUUID(),
    session_id: options.sessionId,
    ...overrides,
  };
}

/** A complete assistant message that calls the tool `name`, for the main conversation or a subagent. */
function toolUseMessage(
  options: Options,
  id: string,
  name: string,
  input: Record<string, unknown>,
  parent: string | null = null,
) {
  return {
    type: "assistant",
    message: {
      id: `msg_${id}`,
      type: "message",
      role: "assistant",
      model: "claude-sonnet-4-6",
      content: [{ type: "tool_use", id, name, input }],
      stop_reason: "tool_use",
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    },
    parent_tool_use_id: parent,
    uuid: randomUUID(),
    session_id: options.sessionId,
  };
}

/** The result of a tool call, with the SDK's `tool_result_meta` sidecar when it stamps one. */
function toolResultMessage(
  options: Options,
  id: string,
  fields: Record<string, unknown>,
  nonExecutionKind?: string,
) {
  return {
    type: "user",
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: id, content: "result", ...fields }],
    },
    ...(nonExecutionKind
      ? { tool_result_meta: [{ id, non_execution_kind: nonExecutionKind }] }
      : {}),
    parent_tool_use_id: null,
    uuid: randomUUID(),
    session_id: options.sessionId,
  };
}

/** How a result ends work that an interrupt stopped while a tool ran. */
const ABORTED_TOOLS = {
  subtype: "error_during_execution",
  is_error: true,
  stop_reason: null,
  terminal_reason: "aborted_tools",
};

/** The turn of a session as the client saw it: messages, states, and notices. */
function turnTrace(updates: v2.UpdateSessionNotification[]): string[] {
  return updates.flatMap(({ update }) => {
    if (update.sessionUpdate === "state_update") {
      const { state, stopReason } = update as { state: string; stopReason?: string };
      return [stopReason ? `${state} ${stopReason}` : state];
    }
    return ["user_message", "agent_message_chunk", "notice"].includes(update.sessionUpdate)
      ? [update.sessionUpdate]
      : [];
  });
}

const text = (value: string) => [{ type: "text" as const, text: value }];

describe("ACP v2 prompts", () => {
  it("answers a prompt once Claude Code takes it in, then reports the turn as state", async () => {
    const answer = Promise.withResolvers<void>();
    const echoed = scriptTurns(async function* (options) {
      await answer.promise;
      yield assistantText(options, "Hello!");
      yield result(options);
    });
    const client = v2Client();
    await client.app.connectWith(connectRouter(), async (agent) => {
      await initializeV2(agent);
      const { sessionId } = await agent.request(v2.methods.agent.session.new, { cwd });
      const response = await agent.request(v2.methods.agent.session.prompt, {
        sessionId,
        prompt: text("hi"),
      });

      // Answered while the turn still runs.
      expect(response).toEqual({ messageId: echoed[0] });
      await vi.waitFor(() =>
        expect(turnTrace(client.sessionUpdates)).toEqual(["user_message", "running"]),
      );
      answer.resolve();
      await vi.waitFor(() =>
        expect(turnTrace(client.sessionUpdates)).toEqual([
          "user_message",
          "running",
          "agent_message_chunk",
          "idle end_turn",
        ]),
      );
      await client.authUpdate(1);
    });

    expect(client.updates("user_message")).toEqual([
      { sessionUpdate: "user_message", messageId: echoed[0], content: text("hi") },
    ]);
    expect(client.updates("agent_message_chunk")).toEqual([
      {
        sessionUpdate: "agent_message_chunk",
        messageId: "msg_answer",
        content: { type: "text", text: "Hello!" },
      },
    ]);
    expect(client.updates("state_update").at(-1)).toMatchObject({
      state: "idle",
      stopReason: "end_turn",
      usage: { inputTokens: 3, outputTokens: 2 },
    });
  });

  it("reports waiting on a question as requires_action", async () => {
    scriptTurns(async function* (options) {
      await options.onElicitation!(
        {
          serverName: "linear",
          message: "Which team?",
          mode: "form",
          requestedSchema: { type: "object", properties: { team: { type: "string" } } },
        },
        { signal: new AbortController().signal } as Parameters<
          NonNullable<Options["onElicitation"]>
        >[1],
      );
      yield assistantText(options, "Thanks.");
      yield result(options);
    });
    const client = v2Client();
    await client.app.connectWith(connectRouter(), async (agent) => {
      await initializeV2(agent, { elicitation: { form: {} } });
      const { sessionId } = await agent.request(v2.methods.agent.session.new, { cwd });
      await agent.request(v2.methods.agent.session.prompt, { sessionId, prompt: text("hi") });
      await vi.waitFor(() => expect(turnTrace(client.sessionUpdates)).toContain("idle end_turn"));
      await client.authUpdate(1);
    });

    expect(client.elicitations).toHaveLength(1);
    expect(turnTrace(client.sessionUpdates)).toEqual([
      "user_message",
      "running",
      "requires_action",
      "running",
      "agent_message_chunk",
      "idle end_turn",
    ]);
  });

  it("does not report the next turn as waiting for a question that its client never settled", async () => {
    // Claude Code's interrupt withdraws the question. The client holds it and
    // ignores $/cancel_request, so only the agent can stop waiting for it.
    const withdrawal = new AbortController();
    sdk.interrupt = async () => withdrawal.abort();
    const client = v2Client({ answerElicitation: () => new Promise<never>(() => {}) });
    scriptTurns(
      async function* (options) {
        void options.canUseTool!(
          "AskUserQuestion",
          {
            questions: [
              {
                question: "Which package?",
                header: "Package",
                options: [
                  { label: "core", description: "The core package" },
                  { label: "cli", description: "The CLI" },
                ],
                multiSelect: false,
              },
            ],
          },
          {
            signal: withdrawal.signal,
            suggestions: [],
            toolUseID: "toolu_question",
            requestId: randomUUID(),
          } as Parameters<NonNullable<Options["canUseTool"]>>[2],
        ).catch(() => undefined);
        // Claude Code does not wait for the callback of a request that it withdrew.
        await new Promise((resolve) => withdrawal.signal.addEventListener("abort", resolve));
        yield result(options, ABORTED_TOOLS);
        yield idleState(options);
      },
      async function* (options) {
        yield assistantText(options, "Hello again.");
        yield result(options);
        yield idleState(options);
      },
    );
    await client.app.connectWith(connectRouter(), async (agent) => {
      await initializeV2(agent, { elicitation: { form: {} } });
      const { sessionId } = await agent.request(v2.methods.agent.session.new, { cwd });
      await agent.request(v2.methods.agent.session.prompt, { sessionId, prompt: text("ask") });
      await vi.waitFor(() => expect(client.elicitations).toHaveLength(1));
      await agent.notify(v2.methods.agent.session.cancel, { sessionId });
      await vi.waitFor(() => expect(turnTrace(client.sessionUpdates)).toContain("idle cancelled"));

      await agent.request(v2.methods.agent.session.prompt, { sessionId, prompt: text("again") });
      await vi.waitFor(() => expect(turnTrace(client.sessionUpdates)).toContain("idle end_turn"));
      await client.authUpdate(1);
    });

    const trace = turnTrace(client.sessionUpdates);
    expect(trace.slice(trace.lastIndexOf("user_message"))).toEqual([
      "user_message",
      "running",
      "agent_message_chunk",
      "idle end_turn",
    ]);
  });

  it("asks for permission with a title of its own, and reads the answer back", async () => {
    const decisions: unknown[] = [];
    scriptTurns(async function* (options) {
      // Claude Code asks about each Bash tool use, then returns its result.
      for (const toolUseID of ["toolu_allow", "toolu_reject", "toolu_custom"]) {
        yield {
          type: "assistant",
          message: {
            id: `msg_${toolUseID}`,
            type: "message",
            role: "assistant",
            model: "claude-sonnet-4-6",
            content: [{ type: "tool_use", id: toolUseID, name: "Bash", input: { command: "ls" } }],
            stop_reason: "tool_use",
            stop_sequence: null,
            usage: { input_tokens: 1, output_tokens: 1 },
          },
          parent_tool_use_id: null,
          uuid: randomUUID(),
          session_id: options.sessionId,
        };
        const decision = await options.canUseTool!("Bash", { command: "ls" }, {
          signal: new AbortController().signal,
          toolUseID,
          suggestions: [],
        } as unknown as Parameters<NonNullable<Options["canUseTool"]>>[2]).catch(
          (error: Error) => error.message,
        );
        decisions.push(decision);
        yield {
          type: "user",
          message: {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: toolUseID,
                content: "done",
                is_error: (decision as { behavior?: string }).behavior !== "allow",
              },
            ],
          },
          parent_tool_use_id: null,
          uuid: randomUUID(),
          session_id: options.sessionId,
        };
      }
      yield result(options);
    });
    const answers: v2.RequestPermissionResponse[] = [
      { outcome: { outcome: "selected", optionId: "allow-once" } },
      { outcome: { outcome: "selected", optionId: "reject" } },
      // The draft says an outcome that the agent does not know is no approval.
      { outcome: { outcome: "_later" } },
    ];
    const client = v2Client({ answerPermission: () => answers.shift()! });
    await client.app.connectWith(connectRouter(), async (agent) => {
      await initializeV2(agent);
      const { sessionId } = await agent.request(v2.methods.agent.session.new, { cwd });
      await agent.request(v2.methods.agent.session.prompt, { sessionId, prompt: text("hi") });
      await vi.waitFor(() => expect(turnTrace(client.sessionUpdates)).toContain("idle end_turn"));
      await client.authUpdate(1);
    });

    expect(client.permissionRequests[0]).toMatchObject({
      title: "ls",
      subject: { type: "tool_call", toolCall: { toolCallId: "toolu_allow", title: "ls" } },
      options: [
        { optionId: "allow-once", kind: "allow_once" },
        { optionId: "reject", kind: "reject_once" },
      ],
    });
    expect(decisions).toEqual([
      expect.objectContaining({ behavior: "allow" }),
      expect.objectContaining({ behavior: "deny" }),
      "Tool use aborted",
    ]);
    expect(turnTrace(client.sessionUpdates)).toEqual([
      "user_message",
      "running",
      "requires_action",
      "running",
      "requires_action",
      "running",
      "requires_action",
      "running",
      "idle end_turn",
    ]);
  });

  it("forks a session into one that the client can prompt at once", async () => {
    const forkId = "99999999-8888-4777-8666-555555555555";
    const echoed = scriptTurns(async function* (options) {
      yield assistantText(options, "Forked.");
      yield result(options);
    });
    const client = v2Client();
    await client.app.connectWith(connectRouter(), async (agent) => {
      await initializeV2(agent);
      const { sessionId } = await agent.request(v2.methods.agent.session.new, { cwd });
      const fork = await agent.request(v2.methods.agent.session.fork, {
        sessionId,
        cwd,
        mcpServers: [{ type: "http", name: "linear", url: "https://mcp.linear.app/mcp" }],
      });

      expect(fork.sessionId).toBe(forkId);
      expect(fork.configOptions?.map((option) => option.configId)).toContain("mode");
      expect(forkSession).toHaveBeenCalledWith(sessionId, { dir: cwd });
      // The fork runs as its own Claude Code session, resumed from the copied
      // transcript, with the MCP servers of the fork request.
      const forkQuery = sdk.queryOptions.at(-1)!;
      expect(forkQuery.resume).toBe(forkId);
      expect(Object.keys(forkQuery.mcpServers ?? {})).toContain("linear");

      // No session/resume needed before the first prompt.
      const { messageId } = await agent.request(v2.methods.agent.session.prompt, {
        sessionId: forkId,
        prompt: text("go on"),
      });
      expect(messageId).toBe(echoed[0]);
      await vi.waitFor(() =>
        expect(
          turnTrace(client.sessionUpdates.filter((update) => update.sessionId === forkId)),
        ).toContain("idle end_turn"),
      );
      await client.authUpdate(1);
    });
  });

  it("replays a Write without the v1 diff that v2 cannot take", async () => {
    const client = v2Client();
    await client.app.connectWith(connectRouter(), async (agent) => {
      await initializeV2(agent);
      const { sessionId } = await agent.request(v2.methods.agent.session.new, { cwd });
      const file = path.join(cwd, "a.ts");
      vi.mocked(getSessionMessages).mockResolvedValueOnce([
        transcriptEntry("assistant", randomUUID(), {
          id: "msg_write",
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "toolu_w",
              name: "Write",
              input: { file_path: file, content: "x\n" },
            },
          ],
        }),
        transcriptEntry("user", randomUUID(), {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_w",
              content: `File created successfully at: ${file}`,
            },
          ],
        }),
      ] as unknown as Awaited<ReturnType<typeof getSessionMessages>>);
      await agent.request(v2.methods.agent.session.resume, {
        sessionId,
        cwd,
        replayFrom: { type: "start" },
      });
      await client.authUpdate(1);
    });

    expect(client.updates("tool_call_update")).toContainEqual(
      expect.objectContaining({ toolCallId: "toolu_w", title: "Write a.ts", content: [] }),
    );
  });

  it("replays a subagent's history to its own session, and clears each replayed message there first", async () => {
    const client = v2Client();
    await client.app.connectWith(connectRouter(), async (agent) => {
      await initializeV2(agent);
      const { sessionId } = await agent.request(v2.methods.agent.session.new, { cwd });
      // Claude Code keeps the subagent's history in its own transcript, beside
      // the session's, with a metadata file that names its launch.
      const project = path.join(tempDir, "claude", "projects", "-project");
      const subagents = path.join(project, sessionId, "subagents");
      await mkdir(subagents, { recursive: true });
      const entry = (uuid: string, parentUuid: string | null, message: unknown, sidechain = true) =>
        JSON.stringify({
          type: (message as { role: string }).role,
          uuid,
          parentUuid,
          sessionId,
          cwd,
          version: "2.0.0",
          isSidechain: sidechain,
          ...(sidechain ? { agentId: "abc123" } : {}),
          userType: "external",
          timestamp: "2026-09-24T00:00:00.000Z",
          message,
        });
      await writeFile(
        path.join(project, `${sessionId}.jsonl`),
        entry("r1", null, { role: "user", content: "Explore it" }, false) + "\n",
      );
      await writeFile(
        path.join(subagents, "agent-abc123.jsonl"),
        [
          entry("c1", null, { role: "user", content: "Look around" }),
          entry("c2", "c1", {
            id: "msg_child",
            role: "assistant",
            model: "claude-haiku-4-5",
            content: [{ type: "text", text: "Child report." }],
          }),
        ].join("\n") + "\n",
      );
      await writeFile(
        path.join(subagents, "agent-abc123.meta.json"),
        JSON.stringify({ agentType: "Explore", name: "scout", toolUseId: "toolu_agent" }),
      );
      vi.mocked(getSessionMessages).mockResolvedValueOnce([
        transcriptEntry("assistant", randomUUID(), {
          id: "msg_agent",
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "toolu_agent",
              name: "Agent",
              input: { name: "scout", subagent_type: "Explore", prompt: "Look around" },
            },
          ],
        }),
        transcriptEntry("user", randomUUID(), {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "toolu_agent", content: "Found it." }],
        }),
      ] as unknown as Awaited<ReturnType<typeof getSessionMessages>>);
      await agent.request(v2.methods.agent.session.resume, {
        sessionId,
        cwd,
        replayFrom: { type: "start" },
      });
      client.sessionUpdates.push({
        sessionId: "response",
        update: { sessionUpdate: "response" },
      } as never);
      await vi.waitFor(() =>
        expect(
          client.sessionUpdates.filter(
            ({ sessionId, update }) =>
              sessionId === "abc123" && update.sessionUpdate === "state_update",
          ),
        ).toHaveLength(2),
      );
      await client.authUpdate(1);
    });

    const child = client.sessionUpdates.flatMap(({ sessionId, update }) =>
      sessionId === "abc123" || sessionId === "response" ? [update] : [],
    );
    // The child's past `running` does not replay; its last state goes once,
    // after the replay. That state is history to the client, so the child's
    // current state follows the response: its process is gone, so it is idle.
    expect(child).toEqual([
      expect.objectContaining({ sessionUpdate: "session_message", content: text("Look around") }),
      // The client may still hold the child's message, so the replay clears it.
      { sessionUpdate: "agent_message", messageId: "msg_child", content: [] },
      expect.objectContaining({
        sessionUpdate: "agent_message_chunk",
        messageId: "msg_child",
        content: text("Child report.")[0],
      }),
      { sessionUpdate: "state_update", state: "idle", stopReason: "end_turn" },
      { sessionUpdate: "response" },
      { sessionUpdate: "state_update", state: "idle", stopReason: "end_turn" },
    ]);
    // The current state on the parent grants nothing: the child cannot run again here.
    expect(
      client.sessionUpdates.filter(
        ({ update }) =>
          update.sessionUpdate === "subagent_update" && (update as any).capabilities != null,
      ),
    ).toEqual([]);
  });

  it("ends a resume with replay with one end event for a client with loadReplayEnd", async () => {
    const client = v2Client();
    const isEnd = (notification: v2.UpdateSessionNotification) =>
      (notification.update._meta as any)?.jetbrains?.air?.loadReplayEnd === true;
    let atResponse: v2.UpdateSessionNotification[] = [];
    let resumedSessionId = "";
    await client.app.connectWith(connectRouter(), async (agent) => {
      await initializeV2(agent, {
        _meta: { jetbrains: { air: { version: 1, capabilities: ["loadReplayEnd"] } } },
      } as v2.ClientCapabilities);
      const { sessionId } = await agent.request(v2.methods.agent.session.new, { cwd });
      resumedSessionId = sessionId;
      vi.mocked(getSessionMessages).mockResolvedValueOnce([
        transcriptEntry("user", randomUUID(), { role: "user", content: "Say hello" }),
        transcriptEntry("assistant", randomUUID(), {
          id: "msg_hello",
          role: "assistant",
          content: [{ type: "text", text: "Hello!" }],
        }),
      ] as unknown as Awaited<ReturnType<typeof getSessionMessages>>);
      client.sessionUpdates.length = 0;
      await agent.request(v2.methods.agent.session.resume, {
        sessionId,
        cwd,
        replayFrom: { type: "start" },
      });
      atResponse = [...client.sessionUpdates];
      // A resume without a replay sends no end event.
      await agent.request(v2.methods.agent.session.resume, { sessionId, cwd });
      await client.authUpdate(1);
    });

    // The end event closes the replay. v2 then requires the state snapshot
    // after the replay and before the response.
    expect(atResponse.map(({ update }) => update.sessionUpdate)).toEqual([
      "user_message",
      "user_message_chunk",
      "agent_message",
      "agent_message_chunk",
      "session_info_update",
      "state_update",
    ]);
    expect(atResponse.at(-2)).toEqual({
      sessionId: resumedSessionId,
      update: {
        sessionUpdate: "session_info_update",
        _meta: { jetbrains: { air: { version: 1, loadReplayEnd: true } } },
      },
    });
    expect(atResponse.at(-1)?.update).toEqual({ sessionUpdate: "state_update", state: "idle" });
    expect(client.sessionUpdates.filter(isEnd)).toHaveLength(1);
  });

  it("replays the plan of an approved ExitPlanMode as a markdown plan", async () => {
    const client = v2Client();
    await client.app.connectWith(connectRouter(), async (agent) => {
      await initializeV2(agent);
      const { sessionId } = await agent.request(v2.methods.agent.session.new, { cwd });
      vi.mocked(getSessionMessages).mockResolvedValueOnce([
        transcriptEntry("assistant", randomUUID(), {
          id: "msg_plan",
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "toolu_plan",
              name: "ExitPlanMode",
              // The transcript keeps the plan that Claude Code adds to the input.
              input: { plan: "# Plan\n1. Do it", planFilePath: "/plans/p.md" },
            },
          ],
        }),
        transcriptEntry("user", randomUUID(), {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_plan",
              content: "User has approved your plan. You can now start coding.",
            },
          ],
        }),
      ] as unknown as Awaited<ReturnType<typeof getSessionMessages>>);
      await agent.request(v2.methods.agent.session.resume, {
        sessionId,
        cwd,
        replayFrom: { type: "start" },
      });
      await client.authUpdate(1);
    });

    expect(client.updates("plan_update")).toEqual([
      {
        sessionUpdate: "plan_update",
        plan: { type: "markdown", planId: "plan-mode", content: "# Plan\n1. Do it" },
      },
    ]);
  });

  it("reports Claude Code's warnings as live notices", async () => {
    scriptTurns(async function* (options) {
      yield {
        type: "system",
        subtype: "informational",
        level: "warning",
        content: "Stop hook blocked continuation\nThe hook said no.",
        uuid: randomUUID(),
        session_id: options.sessionId,
      };
      yield assistantText(options, "Done.");
      yield result(options);
    });
    const client = v2Client();
    await client.app.connectWith(connectRouter(), async (agent) => {
      await initializeV2(agent);
      const { sessionId } = await agent.request(v2.methods.agent.session.new, { cwd });
      await agent.request(v2.methods.agent.session.prompt, { sessionId, prompt: text("hi") });
      await vi.waitFor(() => expect(turnTrace(client.sessionUpdates)).toContain("idle end_turn"));
      await client.authUpdate(1);
    });

    expect(turnTrace(client.sessionUpdates)).toEqual([
      "user_message",
      "running",
      "notice",
      "agent_message_chunk",
      "idle end_turn",
    ]);
    expect(client.updates("notice")).toEqual([
      {
        sessionUpdate: "notice",
        severity: "warning",
        title: "Stop hook blocked continuation",
        description: "The hook said no.",
      },
    ]);
  });

  it("replays a compaction as one completed compaction_update at its position", async () => {
    const summary =
      "This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.\n\n" +
      "Summary:\n1. Primary Request and Intent:\n   Count upward.\n\n" +
      "Continue the conversation from where it left off without asking the user any further questions. Resume directly — do not acknowledge the summary.";
    const client = v2Client();
    await client.app.connectWith(connectRouter(), async (agent) => {
      await initializeV2(agent);
      const { sessionId } = await agent.request(v2.methods.agent.session.new, { cwd });
      vi.mocked(getSessionMessages).mockResolvedValueOnce([
        transcriptEntry("user", "prompt-uuid", { role: "user", content: text("count") }),
        {
          ...transcriptEntry("user", "summary-uuid", { role: "user", content: summary }),
          isCompactSummary: true,
        },
        transcriptEntry("assistant", randomUUID(), {
          id: "msg_after",
          role: "assistant",
          content: text("4"),
        }),
      ] as unknown as Awaited<ReturnType<typeof getSessionMessages>>);
      const before = client.sessionUpdates.length;
      await agent.request(v2.methods.agent.session.resume, {
        sessionId,
        cwd,
        replayFrom: { type: "start" },
      });
      // The materialized form only: no in-progress update and no summary
      // chunks, and the summary between the messages around it.
      expect(
        client.sessionUpdates
          .slice(before)
          .map(({ update }) => update)
          .filter((update) => !update.sessionUpdate.endsWith("_chunk")),
      ).toEqual([
        { sessionUpdate: "user_message", messageId: "prompt-uuid", content: [] },
        {
          sessionUpdate: "compaction_update",
          compactionId: "summary-uuid",
          status: "completed",
          summary: text("1. Primary Request and Intent:\n   Count upward."),
        },
        { sessionUpdate: "agent_message", messageId: "msg_after", content: [] },
        { sessionUpdate: "state_update", state: "idle" },
      ]);
      await client.authUpdate(1);
    });
  });

  it("replays the history before it answers session/resume, clearing each message first", async () => {
    const echoed = scriptTurns(
      async function* (options) {
        yield assistantText(options, "Hello!");
        yield result(options);
      },
      async function* (options) {
        yield assistantText(options, "Again.", "msg_again");
        yield result(options);
      },
    );
    const client = v2Client();
    await client.app.connectWith(connectRouter(), async (agent) => {
      await initializeV2(agent);
      const { sessionId } = await agent.request(v2.methods.agent.session.new, { cwd });
      const { messageId } = await agent.request(v2.methods.agent.session.prompt, {
        sessionId,
        prompt: text("hi"),
      });
      await vi.waitFor(() => expect(turnTrace(client.sessionUpdates)).toContain("idle end_turn"));

      // Claude Code keeps the uuid of the prompt's user message in the transcript.
      vi.mocked(getSessionMessages).mockResolvedValueOnce([
        transcriptEntry("user", echoed[0], { role: "user", content: text("hi") }),
        transcriptEntry("assistant", randomUUID(), {
          id: "msg_answer",
          role: "assistant",
          content: text("Hello!"),
        }),
      ] as unknown as Awaited<ReturnType<typeof getSessionMessages>>);
      const before = client.sessionUpdates.length;
      await agent.request(v2.methods.agent.session.resume, {
        sessionId,
        cwd,
        replayFrom: { type: "start" },
      });
      const replayed = client.sessionUpdates.slice(before).map(({ update }) => update);
      // The prompt's user message replays under the id that its response returned.
      expect(replayed).toEqual([
        { sessionUpdate: "user_message", messageId, content: [] },
        { sessionUpdate: "user_message_chunk", messageId, content: text("hi")[0] },
        { sessionUpdate: "agent_message", messageId: "msg_answer", content: [] },
        {
          sessionUpdate: "agent_message_chunk",
          messageId: "msg_answer",
          content: text("Hello!")[0],
        },
        // The current foreground state, after the replay and before the response.
        { sessionUpdate: "state_update", state: "idle" },
      ]);

      // Live chunks after the replay get no clear.
      const afterReplay = client.sessionUpdates.length;
      await agent.request(v2.methods.agent.session.prompt, { sessionId, prompt: text("again") });
      await vi.waitFor(() =>
        expect(turnTrace(client.sessionUpdates.slice(afterReplay))).toContain("idle end_turn"),
      );
      expect(
        client.sessionUpdates.slice(afterReplay).map(({ update }) => update.sessionUpdate),
      ).not.toContain("agent_message");
      await client.authUpdate(1);
    });
  });

  it("reports the running turn of a live session it resumes, before the response", async () => {
    const answer = Promise.withResolvers<void>();
    scriptTurns(async function* (options) {
      await answer.promise;
      yield result(options);
    });
    const client = v2Client();
    await client.app.connectWith(connectRouter(), async (agent) => {
      await initializeV2(agent);
      const { sessionId } = await agent.request(v2.methods.agent.session.new, { cwd });
      await agent.request(v2.methods.agent.session.prompt, { sessionId, prompt: text("hi") });
      await vi.waitFor(() => expect(turnTrace(client.sessionUpdates)).toContain("running"));

      const before = client.sessionUpdates.length;
      await agent.request(v2.methods.agent.session.resume, { sessionId, cwd });
      expect(client.sessionUpdates.slice(before).map(({ update }) => update)).toEqual([
        { sessionUpdate: "state_update", state: "running" },
      ]);

      answer.resolve();
      await vi.waitFor(() => expect(turnTrace(client.sessionUpdates)).toContain("idle end_turn"));
      await client.authUpdate(1);
    });
  });

  it("answers a queued prompt once Claude Code takes it in, after the turn before it", async () => {
    const firstAnswer = Promise.withResolvers<void>();
    const echoed = scriptTurns(
      async function* (options) {
        await firstAnswer.promise;
        yield result(options);
      },
      async function* (options) {
        yield result(options);
      },
    );
    const client = v2Client();
    await client.app.connectWith(connectRouter(), async (agent) => {
      await initializeV2(agent);
      const { sessionId } = await agent.request(v2.methods.agent.session.new, { cwd });
      await agent.request(v2.methods.agent.session.prompt, { sessionId, prompt: text("first") });
      let answered = false;
      const queued = agent
        .request(v2.methods.agent.session.prompt, { sessionId, prompt: text("second") })
        .finally(() => (answered = true));
      await vi.waitFor(() => expect(agents[0].sessions[sessionId]?.turnQueue).toHaveLength(2));
      expect(answered).toBe(false);

      firstAnswer.resolve();
      expect(await queued).toEqual({ messageId: echoed[1] });
      await vi.waitFor(() =>
        expect(turnTrace(client.sessionUpdates).filter((s) => s === "idle end_turn")).toHaveLength(
          2,
        ),
      );
      await client.authUpdate(1);
    });

    expect(turnTrace(client.sessionUpdates)).toEqual([
      "user_message",
      "running",
      "idle end_turn",
      "user_message",
      "running",
      "idle end_turn",
    ]);
    expect(client.updates("user_message").map((update) => update.messageId)).toEqual(echoed);
  });

  it("cancels the running turn after its last output, and a queued prompt with -32800", async () => {
    const interrupted = Promise.withResolvers<void>();
    sdk.interrupt = async () => interrupted.resolve();
    scriptTurns(async function* (options) {
      yield stream(options, {
        type: "message_start",
        message: { id: "msg_working", role: "assistant", content: [], usage: {} },
      });
      yield stream(options, {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "Working on it" },
      });
      await interrupted.promise;
      // Claude Code still sends what it had when the interrupt arrived.
      yield stream(options, {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: ", stopping" },
      });
      yield result(options);
      yield idleState(options);
    });
    const client = v2Client();
    await client.app.connectWith(connectRouter(), async (agent) => {
      await initializeV2(agent);
      const { sessionId } = await agent.request(v2.methods.agent.session.new, { cwd });
      await agent.request(v2.methods.agent.session.prompt, { sessionId, prompt: text("first") });
      await vi.waitFor(() =>
        expect(turnTrace(client.sessionUpdates)).toContain("agent_message_chunk"),
      );
      const queued = agent.request(v2.methods.agent.session.prompt, {
        sessionId,
        prompt: text("second"),
      });
      await vi.waitFor(() => expect(agents[0].sessions[sessionId]?.turnQueue).toHaveLength(2));

      await agent.notify(v2.methods.agent.session.cancel, { sessionId });

      await expect(queued).rejects.toMatchObject({ code: -32800 });
      await vi.waitFor(() => expect(turnTrace(client.sessionUpdates)).toContain("idle cancelled"));
      await client.authUpdate(1);
    });

    expect(turnTrace(client.sessionUpdates)).toEqual([
      "user_message",
      "running",
      "agent_message_chunk",
      "agent_message_chunk",
      "idle cancelled",
    ]);
  });

  it("reports idle cancelled when the stream dies while a cancel stops the turn", async () => {
    const interrupted = Promise.withResolvers<void>();
    sdk.interrupt = async () => interrupted.resolve();
    scriptTurns(async function* (options) {
      yield assistantText(options, "Working on it");
      await interrupted.promise;
      // Stopping the work kills Claude Code.
      throw new Error("Claude Code process terminated by signal SIGTERM");
    });
    const client = v2Client();
    await client.app.connectWith(connectRouter(), async (agent) => {
      await initializeV2(agent);
      const { sessionId } = await agent.request(v2.methods.agent.session.new, { cwd });
      await agent.request(v2.methods.agent.session.prompt, { sessionId, prompt: text("go") });
      await vi.waitFor(() =>
        expect(turnTrace(client.sessionUpdates)).toContain("agent_message_chunk"),
      );

      await agent.notify(v2.methods.agent.session.cancel, { sessionId });

      await vi.waitFor(() =>
        expect(turnTrace(client.sessionUpdates).some((state) => state.startsWith("idle"))).toBe(
          true,
        ),
      );
      await client.authUpdate(1);
    });

    expect(turnTrace(client.sessionUpdates)).toEqual([
      "user_message",
      "running",
      "agent_message_chunk",
      "idle cancelled",
    ]);
  });

  it("answers a prompt that a session/close stops before it is queued with -32800", async () => {
    scriptTurns(async function* (options) {
      yield result(options);
    });
    const client = v2Client();
    await client.app.connectWith(connectRouter(), async (agent) => {
      await initializeV2(agent);
      const { sessionId } = await agent.request(v2.methods.agent.session.new, { cwd });
      // The prompt waits in the subscription guard while the close runs.
      const guard = Promise.withResolvers<void>();
      const guarded = Promise.withResolvers<void>();
      vi.spyOn(agents[0] as any, "runClaudeSubscriptionGuard").mockImplementation(() => {
        guarded.resolve();
        return guard.promise;
      });
      const prompt = agent.request(v2.methods.agent.session.prompt, {
        sessionId,
        prompt: text("go"),
      });
      await guarded.promise;
      await agent.request(v2.methods.agent.session.close, { sessionId });
      guard.resolve();

      await expect(prompt).rejects.toMatchObject({ code: -32800 });
      await client.authUpdate(1);
    });

    expect(turnTrace(client.sessionUpdates)).toEqual([]);
  });

  it("ends a turn with idle cancelled before it answers session/close, when the turn does not end on its own", async () => {
    // Claude Code never answers again, and the consumer misses the teardown's
    // wake-up (its `cancelController` is replaced below).
    scriptTurns(async function* (options) {
      yield assistantText(options, "Working on it");
      await new Promise(() => {});
    });
    const client = v2Client();
    let atClose: string[] = [];
    await client.app.connectWith(connectRouter(), async (agent) => {
      await initializeV2(agent);
      const { sessionId } = await agent.request(v2.methods.agent.session.new, { cwd });
      await agent.request(v2.methods.agent.session.prompt, { sessionId, prompt: text("go") });
      await vi.waitFor(() =>
        expect(turnTrace(client.sessionUpdates)).toContain("agent_message_chunk"),
      );
      agents[0].sessions[sessionId]!.cancelController = new AbortController();

      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        const closed = agent.request(v2.methods.agent.session.close, { sessionId });
        await vi.advanceTimersByTimeAsync(5_000);
        await closed;
      } finally {
        vi.useRealTimers();
      }
      atClose = turnTrace(client.sessionUpdates);
      await client.authUpdate(1);
    });

    expect(atClose).toEqual(["user_message", "running", "agent_message_chunk", "idle cancelled"]);
  });

  // Hook callbacks bypass the SDK's message queue, so the hook can also come
  // before the agent has seen the streamed tool_use.
  it.each([
    ["after the streamed tool_use", false],
    ["before the streamed tool_use", true],
  ])(
    "shows an auto-approved Edit's exact patch before the Edit runs, with the hook %s",
    async (_, hookFirst) => {
      const file = path.join(cwd, "app.ts");
      await writeFile(file, "line 1\nconst value = 1;\nline 3\n");
      const input = {
        file_path: file,
        old_string: "const value = 1;",
        new_string: "const value = 2;",
      };
      scriptTurns(async function* (options) {
        const toolUse = {
          type: "assistant",
          message: {
            id: "msg_edit",
            type: "message",
            role: "assistant",
            model: "claude-sonnet-4-6",
            content: [{ type: "tool_use", id: "toolu_edit", name: "Edit", input }],
            stop_reason: "tool_use",
            stop_sequence: null,
            usage: { input_tokens: 1, output_tokens: 1 },
          },
          parent_tool_use_id: null,
          uuid: randomUUID(),
          session_id: options.sessionId,
        };
        // Claude Code runs the PreToolUse hooks and waits for them; no
        // permission request comes for an auto-approved Edit.
        const preToolUse = async () => {
          for (const matcher of options.hooks?.PreToolUse ?? []) {
            for (const hook of matcher.hooks) {
              await hook(
                {
                  hook_event_name: "PreToolUse",
                  session_id: options.sessionId!,
                  cwd,
                  tool_name: "Edit",
                  tool_input: input,
                  tool_use_id: "toolu_edit",
                } as never,
                "toolu_edit",
                { signal: new AbortController().signal },
              );
            }
          }
        };
        if (hookFirst) await preToolUse();
        yield toolUse;
        if (!hookFirst) await preToolUse();
        // The Edit runs.
        await writeFile(file, "line 1\nconst value = 2;\nline 3\n");
        yield {
          type: "user",
          message: {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "toolu_edit",
                content: "The file has been updated.",
              },
            ],
          },
          parent_tool_use_id: null,
          uuid: randomUUID(),
          session_id: options.sessionId,
        };
        yield result(options);
      });
      const client = v2Client();
      await client.app.connectWith(connectRouter(), async (agent) => {
        await initializeV2(agent);
        const { sessionId } = await agent.request(v2.methods.agent.session.new, { cwd });
        await agent.request(v2.methods.agent.session.prompt, { sessionId, prompt: text("hi") });
        await vi.waitFor(() => expect(turnTrace(client.sessionUpdates)).toContain("idle end_turn"));
        await client.authUpdate(1);
      });

      const edits = client
        .updates("tool_call_update")
        .filter((update) => update.toolCallId === "toolu_edit");
      const withPatch = edits.findIndex((update) =>
        update.content?.some((item) => item.type === "diff"),
      );
      // The patch of the file before the Edit: after it, old_string no longer
      // matches, and no patch could be built.
      expect(edits[withPatch]?.content).toEqual([
        expect.objectContaining({
          changes: [{ operation: "modify", path: file, fileType: "text" }],
          patch: {
            format: "git_patch",
            text: expect.stringContaining("-const value = 1;\n+const value = 2;\n"),
          },
        }),
      ]);
      // It arrives before the Edit's result.
      expect(withPatch).toBeLessThan(edits.findIndex((update) => update.status === "completed"));
      // The client got the tool call once, with its title, and the stream did
      // not replace the patch.
      expect(edits[0]).toMatchObject({ title: expect.any(String) });
      expect(
        edits.slice(withPatch + 1).some((update) => update.content && update.content.length === 0),
      ).toBe(false);
    },
  );

  it("reports a tool call whose run was interrupted as cancelled", async () => {
    scriptTurns(async function* (options) {
      yield {
        type: "assistant",
        message: {
          id: "msg_bash",
          type: "message",
          role: "assistant",
          model: "claude-sonnet-4-6",
          content: [
            { type: "tool_use", id: "toolu_bash", name: "Bash", input: { command: "make" } },
          ],
          stop_reason: "tool_use",
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        },
        parent_tool_use_id: null,
        uuid: randomUUID(),
        session_id: options.sessionId,
      };
      yield {
        type: "user",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_bash",
              content: "[Request interrupted by user for tool use]",
              is_error: true,
            },
          ],
        },
        tool_result_meta: [{ id: "toolu_bash", non_execution_kind: "interrupted" }],
        parent_tool_use_id: null,
        uuid: randomUUID(),
        session_id: options.sessionId,
      };
      yield result(options);
    });
    const client = v2Client();
    await client.app.connectWith(connectRouter(), async (agent) => {
      await initializeV2(agent);
      const { sessionId } = await agent.request(v2.methods.agent.session.new, { cwd });
      await agent.request(v2.methods.agent.session.prompt, { sessionId, prompt: text("hi") });
      await vi.waitFor(() => expect(turnTrace(client.sessionUpdates)).toContain("idle end_turn"));
      await client.authUpdate(1);
    });

    const statuses = client
      .updates("tool_call_update")
      .filter((update) => update.toolCallId === "toolu_bash" && update.status)
      .map((update) => update.status);
    expect(statuses.at(-1)).toBe("cancelled");
  });

  it("reports a command whose result says interrupted as cancelled", async () => {
    scriptTurns(async function* (options) {
      yield {
        type: "assistant",
        message: {
          id: "msg_bash",
          type: "message",
          role: "assistant",
          model: "claude-sonnet-4-6",
          content: [
            { type: "tool_use", id: "toolu_bash", name: "Bash", input: { command: "make" } },
          ],
          stop_reason: "tool_use",
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        },
        parent_tool_use_id: null,
        uuid: randomUUID(),
        session_id: options.sessionId,
      };
      // Claude Code aborted the command for a steering message: a successful
      // result whose structured output says `interrupted`.
      yield {
        type: "user",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_bash",
              content:
                "Command aborted before execution<error>Command was aborted before completion</error>",
            },
          ],
        },
        tool_use_result: {
          stdout: "",
          stderr: "Command aborted before execution",
          interrupted: true,
          isImage: false,
        },
        parent_tool_use_id: null,
        uuid: randomUUID(),
        session_id: options.sessionId,
      };
      yield result(options);
    });
    const client = v2Client();
    await client.app.connectWith(connectRouter(), async (agent) => {
      await initializeV2(agent);
      const { sessionId } = await agent.request(v2.methods.agent.session.new, { cwd });
      await agent.request(v2.methods.agent.session.prompt, { sessionId, prompt: text("hi") });
      await vi.waitFor(() => expect(turnTrace(client.sessionUpdates)).toContain("idle end_turn"));
      await client.authUpdate(1);
    });

    const statuses = client
      .updates("tool_call_update")
      .filter((update) => update.toolCallId === "toolu_bash" && update.status)
      .map((update) => update.status);
    expect(statuses.at(-1)).toBe("cancelled");
  });

  describe("the tool calls that a cancel stops", () => {
    type Seen = { sessionId: string; update: Record<string, any> };

    /**
     * Runs a turn that the client cancels once `toolCallId` has an update, and
     * returns what the client got, and the id of the session. The turn ends
     * with the idle of that session: a subagent's child session has an idle of
     * its own, which comes before it.
     */
    async function cancelWhileRunning(toolCallId: string) {
      const client = v2Client();
      let root = "";
      await client.app.connectWith(connectRouter(), async (agent) => {
        await initializeV2(agent);
        ({ sessionId: root } = await agent.request(v2.methods.agent.session.new, { cwd }));
        await agent.request(v2.methods.agent.session.prompt, {
          sessionId: root,
          prompt: text("go"),
        });
        await vi.waitFor(() =>
          expect(client.updates("tool_call_update").some((u) => u.toolCallId === toolCallId)).toBe(
            true,
          ),
        );
        await agent.notify(v2.methods.agent.session.cancel, { sessionId: root });
        await vi.waitFor(() =>
          expect(
            turnTrace(client.sessionUpdates.filter(({ sessionId }) => sessionId === root)),
          ).toContain("idle cancelled"),
        );
        await client.authUpdate(1);
      });
      return { root, updates: client.sessionUpdates as unknown as Seen[] };
    }
    const idleAt = (root: string, updates: Seen[]) =>
      updates.findIndex(
        ({ sessionId, update }) =>
          sessionId === root && update.sessionUpdate === "state_update" && update.state === "idle",
      );
    const lastStatusAt = (updates: Seen[], id: string) =>
      updates.findLastIndex(({ update }) => update.toolCallId === id && update.status);

    it("ends a stopped tool call and its subagent's as cancelled, before it reports idle cancelled", async () => {
      const interrupted = Promise.withResolvers<void>();
      sdk.interrupt = async () => interrupted.resolve();
      const subagentTask = (
        options: Options,
        subtype: string,
        fields: Record<string, unknown>,
      ) => ({
        type: "system",
        subtype,
        task_id: "agent-1",
        tool_use_id: "toolu_agent",
        uuid: randomUUID(),
        session_id: options.sessionId,
        ...fields,
      });
      scriptTurns(async function* (options) {
        yield toolUseMessage(options, "toolu_agent", "Agent", {
          description: "Run a slow command",
          subagent_type: "general-purpose",
          prompt: "Run it",
        });
        yield subagentTask(options, "task_started", {
          description: "Run a slow command",
          subagent_type: "general-purpose",
          prompt: "Run it",
        });
        yield toolUseMessage(options, "toolu_child", "Bash", { command: "make" }, "toolu_agent");
        await interrupted.promise;
        // Claude Code stops the subagent, then gives the Agent call a result, in
        // the stream. It stamps the result `user-rejected`, the kind of a tool
        // that the user refused, which is `failed`, though the cancel stopped
        // this one. The subagent's command gets none.
        yield subagentTask(options, "task_notification", {
          status: "stopped",
          output_file: "",
          summary: "stopped",
        });
        yield toolResultMessage(options, "toolu_agent", { is_error: true }, "user-rejected");
        yield result(options, ABORTED_TOOLS);
        yield idleState(options);
      });

      const { root, updates } = await cancelWhileRunning("toolu_child");

      // The parent does not show the Agent call: the child's idle reports the
      // stop. The subagent's command ends in the child's session, before the
      // root's idle.
      const idle = idleAt(root, updates);
      expect(lastStatusAt(updates, "toolu_agent")).toBe(-1);
      expect(updates[idleAt("agent-1", updates)]).toMatchObject({
        update: { stopReason: "cancelled" },
      });
      const childEnd = lastStatusAt(updates, "toolu_child");
      expect(updates[childEnd]).toMatchObject({
        sessionId: "agent-1",
        update: { status: "cancelled" },
      });
      expect(childEnd).toBeLessThan(idle);
    });

    it("ends the terminal of a stopped subagent's command with the tool call", async () => {
      const interrupted = Promise.withResolvers<void>();
      sdk.interrupt = async () => interrupted.resolve();
      const subagentTask = (
        options: Options,
        subtype: string,
        fields: Record<string, unknown>,
      ) => ({
        type: "system",
        subtype,
        task_id: "agent-1",
        tool_use_id: "toolu_agent",
        uuid: randomUUID(),
        session_id: options.sessionId,
        ...fields,
      });
      scriptTurns(async function* (options) {
        yield toolUseMessage(options, "toolu_agent", "Agent", {
          description: "Run a slow command",
          subagent_type: "general-purpose",
          prompt: "Run it",
        });
        yield subagentTask(options, "task_started", {
          description: "Run a slow command",
          subagent_type: "general-purpose",
          prompt: "Run it",
        });
        yield toolUseMessage(options, "toolu_child", "Bash", { command: "make" }, "toolu_agent");
        await interrupted.promise;
        // Claude Code sends no result for the subagent's command.
        yield subagentTask(options, "task_notification", {
          status: "stopped",
          output_file: "",
          summary: "stopped",
        });
        yield toolResultMessage(options, "toolu_agent", { is_error: true }, "user-rejected");
        yield result(options, ABORTED_TOOLS);
        yield idleState(options);
      });

      const { root, updates } = await cancelWhileRunning("toolu_child");

      // The command's terminal shows in the child's session, and its exit comes
      // with the tool call's end, before the root reports idle. The exit code is
      // unknown, so the exit carries none.
      const terminalAt = (predicate: (update: Seen["update"]) => boolean) =>
        updates.findIndex(
          ({ sessionId, update }) =>
            sessionId === "agent-1" &&
            update.sessionUpdate === "terminal_update" &&
            predicate(update),
        );
      const exit = terminalAt((update) => update.exitStatus !== undefined);
      expect(terminalAt((update) => update.exitStatus === undefined)).toBeGreaterThanOrEqual(0);
      expect(updates[exit]).toMatchObject({
        update: { terminalId: "toolu_child", exitStatus: {} },
      });
      expect(exit).toBeGreaterThan(terminalAt((update) => update.exitStatus === undefined));
      expect(exit).toBeLessThan(idleAt(root, updates));
      expect(updates[lastStatusAt(updates, "toolu_child")]).toMatchObject({
        sessionId: "agent-1",
        update: { status: "cancelled" },
      });
    });

    it("ends a tool call that finished as the cancel landed as completed, not cancelled", async () => {
      const interrupted = Promise.withResolvers<void>();
      sdk.interrupt = async () => interrupted.resolve();
      scriptTurns(async function* (options) {
        yield toolUseMessage(options, "toolu_bash", "Bash", { command: "make" });
        await interrupted.promise;
        yield toolResultMessage(options, "toolu_bash", {});
        yield result(options, ABORTED_TOOLS);
        yield idleState(options);
      });

      const { root, updates } = await cancelWhileRunning("toolu_bash");

      const at = lastStatusAt(updates, "toolu_bash");
      expect(updates[at]).toMatchObject({ update: { status: "completed" } });
      expect(at).toBeLessThan(idleAt(root, updates));
    });

    it("ends the tool call of a background subagent as cancelled when the SDK reports it stopped while the root is idle", async () => {
      const interrupted = Promise.withResolvers<void>();
      sdk.interrupt = async () => interrupted.resolve();
      const subagentTask = (
        options: Options,
        subtype: string,
        fields: Record<string, unknown>,
      ) => ({
        type: "system",
        subtype,
        task_id: "agent-1",
        tool_use_id: "toolu_agent",
        uuid: randomUUID(),
        session_id: options.sessionId,
        ...fields,
      });
      scriptTurns(async function* (options) {
        yield toolUseMessage(options, "toolu_agent", "Agent", {
          description: "Run a slow command",
          subagent_type: "general-purpose",
          prompt: "Run it",
          run_in_background: true,
        });
        yield subagentTask(options, "task_started", {
          description: "Run a slow command",
          subagent_type: "general-purpose",
          prompt: "Run it",
          is_backgrounded: true,
        });
        // Claude Code answers a background Agent call when the subagent launches.
        yield toolResultMessage(options, "toolu_agent", {});
        yield toolUseMessage(options, "toolu_child", "Bash", { command: "make" }, "toolu_agent");
        yield result(options);
        yield idleState(options);
        await interrupted.promise;
        // The interrupt stops the subagent while nothing else runs. Claude Code
        // sends the interrupted result of its command after that.
        yield subagentTask(options, "task_updated", { patch: { status: "killed" } });
        yield subagentTask(options, "task_notification", {
          status: "stopped",
          output_file: "",
          summary: "stopped",
        });
        yield {
          ...toolResultMessage(options, "toolu_child", { is_error: true }, "user-rejected"),
          parent_tool_use_id: "toolu_agent",
        };
        yield idleState(options);
      });

      const client = v2Client();
      let root = "";
      await client.app.connectWith(connectRouter(), async (agent) => {
        await initializeV2(agent);
        ({ sessionId: root } = await agent.request(v2.methods.agent.session.new, { cwd }));
        await agent.request(v2.methods.agent.session.prompt, {
          sessionId: root,
          prompt: text("go"),
        });
        await vi.waitFor(() => expect(turnTrace(client.sessionUpdates)).toContain("idle end_turn"));
        await agent.notify(v2.methods.agent.session.cancel, { sessionId: root });
        await vi.waitFor(() =>
          expect(
            client
              .updates("tool_call_update")
              .filter((update) => update.toolCallId === "toolu_child")
              .map((update) => update.status),
          ).toContain("cancelled"),
        );
        await client.authUpdate(1);
      });

      const updates = client.sessionUpdates as unknown as Seen[];
      // The child reported idle first, and then its command ended in its session.
      const childIdle = updates.findIndex(
        ({ sessionId, update }) =>
          sessionId === "agent-1" &&
          update.sessionUpdate === "state_update" &&
          update.state === "idle" &&
          update.stopReason === "cancelled",
      );
      expect(childIdle).toBeGreaterThanOrEqual(0);
      expect(updates[lastStatusAt(updates, "toolu_child")]).toMatchObject({
        sessionId: "agent-1",
        update: { status: "cancelled" },
      });
      expect(lastStatusAt(updates, "toolu_child")).toBeGreaterThan(childIdle);
      // Claude Code's result for the command was dropped, so only one report ended it.
      expect(
        updates.filter(
          ({ update }) => update.toolCallId === "toolu_child" && update.status === "cancelled",
        ),
      ).toHaveLength(1);
      // The cancel found no work to end: the root reported nothing after its idle.
      expect(turnTrace(updates.filter(({ sessionId }) => sessionId === root) as never)).toEqual([
        "user_message",
        "running",
        "idle end_turn",
      ]);
    });
  });

  it("reports a tool call that Claude dropped before it ran as cancelled", async () => {
    scriptTurns(async function* (options) {
      // Claude starts a tool_use, but no complete assistant message holds it,
      // so it never runs.
      yield stream(options, {
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "toolu_dropped", name: "Bash", input: {} },
      });
      yield assistantText(options, "Here is the answer.");
      yield result(options);
    });
    const client = v2Client();
    await client.app.connectWith(connectRouter(), async (agent) => {
      await initializeV2(agent);
      const { sessionId } = await agent.request(v2.methods.agent.session.new, { cwd });
      await agent.request(v2.methods.agent.session.prompt, { sessionId, prompt: text("hi") });
      await vi.waitFor(() => expect(turnTrace(client.sessionUpdates)).toContain("idle end_turn"));
      await client.authUpdate(1);
    });

    const dropped = client
      .updates("tool_call_update")
      .filter((update) => update.toolCallId === "toolu_dropped" && update.status);
    expect(dropped.map((update) => update.status)).toEqual(["pending", "cancelled"]);
    expect(JSON.stringify(dropped.at(-1)?.content)).toContain(
      "Claude stopped this tool call before it ran.",
    );
    // It is not a failure of the turn.
    expect(turnTrace(client.sessionUpdates).at(-1)).toBe("idle end_turn");
  });

  it("reports a turn that fails after it was taken in as idle with the error stop reason", async () => {
    scriptTurns(async function* (options) {
      yield result(options, { is_error: true, result: "API Error: 529 Overloaded" });
    });
    const client = v2Client();
    await client.app.connectWith(connectRouter(), async (agent) => {
      await initializeV2(agent);
      const { sessionId } = await agent.request(v2.methods.agent.session.new, { cwd });
      await agent.request(v2.methods.agent.session.prompt, { sessionId, prompt: text("hi") });
      await vi.waitFor(() => expect(turnTrace(client.sessionUpdates)).toContain("idle error"));
      await client.authUpdate(1);
    });

    // The stop reason carries the failure, so no notice repeats it. The error
    // is the one v1 rejects the prompt with.
    expect(turnTrace(client.sessionUpdates)).toEqual(["user_message", "running", "idle error"]);
    expect(client.updates("notice")).toEqual([]);
    const v1Error = v1.RequestError.internalError(undefined, "API Error: 529 Overloaded");
    expect(client.updates("state_update").at(-1)).toEqual({
      sessionUpdate: "state_update",
      state: "idle",
      stopReason: "error",
      error: expect.objectContaining({ code: v1Error.code, message: v1Error.message }),
    });
  });

  it("keeps the auth_required code of a turn that fails for a missing login", async () => {
    scriptTurns(async function* (options) {
      yield result(options, { is_error: true, result: "Not logged in · Please run /login" });
    });
    const client = v2Client();
    await client.app.connectWith(connectRouter(), async (agent) => {
      await initializeV2(agent);
      const { sessionId } = await agent.request(v2.methods.agent.session.new, { cwd });
      await agent.request(v2.methods.agent.session.prompt, { sessionId, prompt: text("hi") });
      await vi.waitFor(() => expect(turnTrace(client.sessionUpdates)).toContain("idle error"));
      await client.authUpdate(1);
    });

    // The code starts the client's sign-in, which owns the login UI, so the
    // message does not say to run /login.
    expect(client.updates("state_update").at(-1)).toMatchObject({
      stopReason: "error",
      error: {
        code: v1.RequestError.authRequired().code,
        message: "Authentication required",
      },
    });
  });

  it("answers a queued prompt with the error of a turn that failed before it was taken in", async () => {
    // Claude Code answers the first prompt, then its stream ends.
    sdk.run = async function* (prompts, options) {
      const input = prompts[Symbol.asyncIterator]();
      const { value } = await input.next();
      yield {
        type: "user",
        message: value.message,
        parent_tool_use_id: null,
        uuid: value.uuid,
        session_id: options.sessionId,
        isReplay: true,
      };
      await input.next();
      yield result(options);
    };
    const client = v2Client();
    await client.app.connectWith(connectRouter(), async (agent) => {
      await initializeV2(agent);
      const { sessionId } = await agent.request(v2.methods.agent.session.new, { cwd });
      await agent.request(v2.methods.agent.session.prompt, { sessionId, prompt: text("first") });
      await expect(
        agent.request(v2.methods.agent.session.prompt, { sessionId, prompt: text("second") }),
      ).rejects.toMatchObject({ code: -32603 });
      await client.authUpdate(1);
    });

    expect(turnTrace(client.sessionUpdates)).toEqual(["user_message", "running", "idle end_turn"]);
  });

  it("gives a messageId to the chunks that the agent builds from a command's output and a result", async () => {
    const outputId = randomUUID();
    const resultId = randomUUID();
    scriptTurns(
      async function* (options) {
        yield {
          type: "system",
          subtype: "local_command_output",
          content: "Total cost: $0.00",
          uuid: outputId,
          session_id: options.sessionId,
        };
        yield result(options);
      },
      async function* (options) {
        // A result that answers without a streamed answer is forwarded (issue #453).
        yield result(options, {
          result: "Done.",
          uuid: resultId,
          usage: { input_tokens: 0, output_tokens: 0 },
        });
      },
    );
    const client = v2Client();
    await client.app.connectWith(connectRouter(), async (agent) => {
      await initializeV2(agent);
      const { sessionId } = await agent.request(v2.methods.agent.session.new, { cwd });
      for (const prompt of ["/cost", "again"]) {
        const idles = turnTrace(client.sessionUpdates).filter((s) => s.startsWith("idle")).length;
        await agent.request(v2.methods.agent.session.prompt, { sessionId, prompt: text(prompt) });
        await vi.waitFor(() =>
          expect(turnTrace(client.sessionUpdates).filter((s) => s.startsWith("idle"))).toHaveLength(
            idles + 1,
          ),
        );
      }
      await client.authUpdate(1);
    });

    expect(
      client.updates("agent_message_chunk").map(({ messageId, content }) => [messageId, content]),
    ).toEqual([
      [outputId, { type: "text", text: "Total cost: $0.00" }],
      [resultId, { type: "text", text: "Done." }],
    ]);
  });

  it("gives a refusal explanation the messageId of the refusing result", async () => {
    const resultId = randomUUID();
    scriptTurns(async function* (options) {
      yield {
        ...assistantText(options, ""),
        message: {
          ...assistantText(options, "").message,
          content: [],
          stop_reason: "refusal",
          stop_details: { explanation: "I can't help with that." },
        },
      };
      yield result(options, { stop_reason: "refusal", uuid: resultId });
    });
    const client = v2Client();
    await client.app.connectWith(connectRouter(), async (agent) => {
      await initializeV2(agent);
      const { sessionId } = await agent.request(v2.methods.agent.session.new, { cwd });
      await agent.request(v2.methods.agent.session.prompt, { sessionId, prompt: text("hi") });
      await vi.waitFor(() => expect(turnTrace(client.sessionUpdates)).toContain("idle refusal"));
      await client.authUpdate(1);
    });

    expect(client.updates("agent_message_chunk")).toEqual([
      {
        sessionUpdate: "agent_message_chunk",
        messageId: resultId,
        content: { type: "text", text: "I can't help with that." },
      },
    ]);
  });

  it("rejects a prompt with a content block that v1 cannot express", async () => {
    const echoed = scriptTurns();
    const { app, authUpdate } = v2Client();
    await app.connectWith(connectRouter(), async (agent) => {
      await initializeV2(agent);
      const { sessionId } = await agent.request(v2.methods.agent.session.new, { cwd });
      await expect(
        agent.request(v2.methods.agent.session.prompt, {
          sessionId,
          prompt: [{ type: "_acme/widget", spec: 1 }],
        }),
      ).rejects.toMatchObject({ code: -32602 });
      await authUpdate(1);
    });
    expect(echoed).toEqual([]);
  });
});

// Claude Code runs model cycles that no prompt started, for example its
// follow-up after a background command finished. v2 reports them as
// foreground work.
describe("ACP v2 model cycles that Claude Code starts on its own", () => {
  /** The result of a cycle that a background task's notification started. */
  const followupResult = (options: Options, overrides: Record<string, unknown> = {}) =>
    result(options, { origin: { kind: "task-notification" }, ...overrides });

  /** What the client saw of the turn of the prompt "hi" that ended. */
  const endedTurn = ["user_message", "running", "agent_message_chunk", "idle end_turn"];

  /**
   * Sends the prompt "hi", runs `during`, waits until the client saw `idles`
   * idle states, and returns the client.
   */
  async function promptAndWait(
    idles: number,
    during?: (
      agent: v2.ClientContext,
      sessionId: string,
      client: ReturnType<typeof v2Client>,
    ) => Promise<void>,
    capabilities: v2.ClientCapabilities = {},
  ) {
    const client = v2Client();
    await client.app.connectWith(connectRouter(), async (agent) => {
      await initializeV2(agent, capabilities);
      const { sessionId } = await agent.request(v2.methods.agent.session.new, { cwd });
      await agent.request(v2.methods.agent.session.prompt, { sessionId, prompt: text("hi") });
      await during?.(agent, sessionId, client);
      await vi.waitFor(() =>
        expect(
          turnTrace(client.sessionUpdates).filter((state) => state.startsWith("idle")),
        ).toHaveLength(idles),
      );
      await client.authUpdate(1);
    });
    return client;
  }

  it("reports a cycle after the turn ended as running, then idle with the cycle's usage", async () => {
    scriptTurns(async function* (options) {
      yield assistantText(options, "Started the build in the background.");
      yield result(options);
      yield idleState(options);
      // The build finishes, and Claude Code wakes the model to report it.
      yield assistantText(options, "The build passed.", "msg_followup");
      yield followupResult(options, {
        usage: {
          input_tokens: 7,
          output_tokens: 4,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
      });
      yield idleState(options);
    });
    const client = await promptAndWait(2);

    expect(turnTrace(client.sessionUpdates)).toEqual([
      ...endedTurn,
      "running",
      "agent_message_chunk",
      "idle end_turn",
    ]);
    expect(client.updates("state_update").at(-1)).toMatchObject({
      state: "idle",
      stopReason: "end_turn",
      usage: { inputTokens: 7, outputTokens: 4, totalTokens: 11 },
      _meta: { quota: { token_count: { inputTokens: 7, outputTokens: 4, totalTokens: 11 } } },
    });
  });

  it("closes a tool call that Claude dropped before it ran in a cycle as cancelled, before the cycle's idle", async () => {
    scriptTurns(async function* (options) {
      yield assistantText(options, "Started the build in the background.");
      yield result(options);
      yield idleState(options);
      // Claude Code's follow-up starts a tool_use, but no complete assistant
      // message holds it, so it never runs.
      yield stream(options, {
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "toolu_dropped", name: "Bash", input: {} },
      });
      yield assistantText(options, "The build passed.", "msg_followup");
      yield followupResult(options);
      yield idleState(options);
    });
    const client = await promptAndWait(2);

    const dropped = client.sessionUpdates.flatMap(({ update }) =>
      update.sessionUpdate === "tool_call_update" &&
      update.toolCallId === "toolu_dropped" &&
      update.status
        ? [update.status]
        : update.sessionUpdate === "state_update"
          ? [`state ${update.state}`]
          : [],
    );
    expect(dropped).toEqual([
      "state running",
      "state idle",
      "state running",
      "pending",
      "cancelled",
      "state idle",
    ]);
    expect(turnTrace(client.sessionUpdates).at(-1)).toBe("idle end_turn");
  });

  it("ends the tool call that a cancelled cycle runs with Claude Code's result, before idle cancelled", async () => {
    const interrupted = Promise.withResolvers<void>();
    sdk.interrupt = async () => interrupted.resolve();
    scriptTurns(async function* (options) {
      yield assistantText(options, "Started the build in the background.");
      yield result(options);
      yield idleState(options);
      // Claude Code's follow-up runs a command.
      yield toolUseMessage(options, "toolu_cycle", "Bash", { command: "make" });
      await interrupted.promise;
      yield toolResultMessage(options, "toolu_cycle", { is_error: true }, "user-rejected");
      yield followupResult(options, ABORTED_TOOLS);
      yield idleState(options);
    });
    const client = await promptAndWait(2, async (agent, sessionId, client) => {
      await vi.waitFor(() =>
        expect(client.updates("tool_call_update").some((u) => u.toolCallId === "toolu_cycle")).toBe(
          true,
        ),
      );
      await agent.notify(v2.methods.agent.session.cancel, { sessionId });
    });

    const updates = client.sessionUpdates.map(({ update }) => update) as Array<Record<string, any>>;
    const at = updates.findLastIndex((u) => u.toolCallId === "toolu_cycle" && u.status);
    expect(updates[at]).toMatchObject({ status: "cancelled" });
    const cycleIdle = updates.findLastIndex(
      (u) => u.sessionUpdate === "state_update" && u.state === "idle",
    );
    expect(updates[cycleIdle]).toMatchObject({ stopReason: "cancelled" });
    expect(at).toBeLessThan(cycleIdle);
  });

  describe("the tool calls that a cancelled cycle leaves open", () => {
    type Seen = { sessionId: string; update: Record<string, any> };

    /**
     * Sends the prompt "hi", cancels once the tool call `toolCallId` has an
     * update, which the script's cycle runs, and returns what the client got
     * once the root session reported its second idle.
     */
    async function cancelCycle(toolCallId: string) {
      const client = v2Client();
      let root = "";
      await client.app.connectWith(connectRouter(), async (agent) => {
        await initializeV2(agent);
        ({ sessionId: root } = await agent.request(v2.methods.agent.session.new, { cwd }));
        await agent.request(v2.methods.agent.session.prompt, {
          sessionId: root,
          prompt: text("hi"),
        });
        await vi.waitFor(() =>
          expect(
            client.updates("tool_call_update").some((update) => update.toolCallId === toolCallId),
          ).toBe(true),
        );
        await agent.notify(v2.methods.agent.session.cancel, { sessionId: root });
        await vi.waitFor(() =>
          expect(
            turnTrace(client.sessionUpdates.filter(({ sessionId }) => sessionId === root)).filter(
              (state) => state.startsWith("idle"),
            ),
          ).toHaveLength(2),
        );
        await client.authUpdate(1);
      });
      return { root, updates: client.sessionUpdates as unknown as Seen[] };
    }
    const lastStatusAt = (updates: Seen[], id: string) =>
      updates.findLastIndex(({ update }) => update.toolCallId === id && update.status);
    const lastIdleAt = (updates: Seen[], sessionId: string) =>
      updates.findLastIndex(
        ({ sessionId: id, update }) =>
          id === sessionId && update.sessionUpdate === "state_update" && update.state === "idle",
      );
    const statusesOf = (updates: Seen[], id: string) =>
      updates.filter(({ update }) => update.toolCallId === id && update.status);
    /** A system frame about the task of a subagent that the Agent call `toolUseId` started. */
    const taskFrame = (
      options: Options,
      subtype: string,
      taskId: string,
      toolUseId: string,
      fields: Record<string, unknown> = {},
    ) => ({
      type: "system",
      subtype,
      task_id: taskId,
      tool_use_id: toolUseId,
      uuid: randomUUID(),
      session_id: options.sessionId,
      ...fields,
    });
    const agentCall = (options: Options, id: string, fields: Record<string, unknown> = {}) =>
      toolUseMessage(options, id, "Agent", {
        description: "Run it",
        subagent_type: "general-purpose",
        prompt: "Run it",
        ...fields,
      });

    it("ends the command of a foreground subagent that the cycle runs, which Claude Code sends no result for, before idle cancelled", async () => {
      const interrupted = Promise.withResolvers<void>();
      sdk.interrupt = async () => interrupted.resolve();
      scriptTurns(async function* (options) {
        yield assistantText(options, "Started the build in the background.");
        yield result(options);
        yield idleState(options);
        // Claude Code's follow-up runs a subagent, which runs a command.
        yield agentCall(options, "toolu_agent");
        yield taskFrame(options, "task_started", "agent-1", "toolu_agent", {
          description: "Run it",
          subagent_type: "general-purpose",
          prompt: "Run it",
        });
        yield toolUseMessage(options, "toolu_child", "Bash", { command: "make" }, "toolu_agent");
        await interrupted.promise;
        // The interrupt stops the subagent, and Claude Code answers the Agent
        // call, but not the subagent's command.
        yield taskFrame(options, "task_notification", "agent-1", "toolu_agent", {
          status: "stopped",
          output_file: "",
          summary: "stopped",
        });
        yield toolResultMessage(options, "toolu_agent", { is_error: true }, "user-rejected");
        yield followupResult(options, ABORTED_TOOLS);
        yield idleState(options);
      });

      const { root, updates } = await cancelCycle("toolu_child");

      // The parent does not show the Agent call: the child's idle reports the
      // stop. The command ends in the child's session, after the child's idle
      // and before the cycle's.
      expect(statusesOf(updates, "toolu_agent")).toEqual([]);
      expect(updates[lastIdleAt(updates, "agent-1")]).toMatchObject({
        update: { stopReason: "cancelled" },
      });
      const end = lastStatusAt(updates, "toolu_child");
      expect(updates[end]).toMatchObject({ sessionId: "agent-1", update: { status: "cancelled" } });
      expect(statusesOf(updates, "toolu_child").map(({ update }) => update.status)).toEqual([
        "pending",
        "cancelled",
      ]);
      expect(end).toBeGreaterThan(lastIdleAt(updates, "agent-1"));
      expect(updates[lastIdleAt(updates, root)]).toMatchObject({
        update: { stopReason: "cancelled" },
      });
      expect(end).toBeLessThan(lastIdleAt(updates, root));
    });

    it("ends a tool call that Claude abandoned in the cycle before idle cancelled", async () => {
      const interrupted = Promise.withResolvers<void>();
      sdk.interrupt = async () => interrupted.resolve();
      scriptTurns(async function* (options) {
        yield assistantText(options, "Started the build in the background.");
        yield result(options);
        yield idleState(options);
        // Claude Code's follow-up starts a command, but no complete message holds it.
        yield stream(options, {
          type: "content_block_start",
          index: 0,
          content_block: { type: "tool_use", id: "toolu_dropped", name: "Bash", input: {} },
        });
        await interrupted.promise;
        yield followupResult(options, ABORTED);
        yield idleState(options);
      });

      const { root, updates } = await cancelCycle("toolu_dropped");

      const end = lastStatusAt(updates, "toolu_dropped");
      expect(updates[end]).toMatchObject({ update: { status: "cancelled" } });
      expect(JSON.stringify(updates[end].update.content)).toContain(
        "Claude stopped this tool call before it ran.",
      );
      expect(end).toBeLessThan(lastIdleAt(updates, root));
    });

    it("ends the tool calls of a cycle that the cancel ends at the idle, when no result comes", async () => {
      const interrupted = Promise.withResolvers<void>();
      sdk.interrupt = async () => interrupted.resolve();
      scriptTurns(async function* (options) {
        yield assistantText(options, "Started the build in the background.");
        yield result(options);
        yield idleState(options);
        yield stream(options, {
          type: "content_block_start",
          index: 0,
          content_block: { type: "tool_use", id: "toolu_dropped", name: "Bash", input: {} },
        });
        await interrupted.promise;
        // The interrupt ends the cycle with an idle, and no result.
        yield idleState(options);
      });

      const { root, updates } = await cancelCycle("toolu_dropped");

      const end = lastStatusAt(updates, "toolu_dropped");
      expect(updates[end]).toMatchObject({ update: { status: "cancelled" } });
      expect(updates[lastIdleAt(updates, root)]).toMatchObject({
        update: { stopReason: "cancelled" },
      });
      expect(end).toBeLessThan(lastIdleAt(updates, root));
    });

    it("leaves the tool call of a cycle that the SDK aborted without a cancel to Claude Code's result", async () => {
      const aborted = Promise.withResolvers<void>();
      scriptTurns(async function* (options) {
        yield assistantText(options, "Started the build in the background.");
        yield result(options);
        yield idleState(options);
        yield toolUseMessage(options, "toolu_cycle", "Bash", { command: "make" });
        // For example, a steering message aborts the cycle. Nobody cancelled it,
        // so Claude Code's result for the command is still to be delivered.
        yield followupResult(options, ABORTED_TOOLS);
        yield idleState(options);
        aborted.resolve();
        yield toolResultMessage(options, "toolu_cycle", { is_error: true }, "interrupted");
      });
      const client = v2Client();
      await client.app.connectWith(connectRouter(), async (agent) => {
        await initializeV2(agent);
        const { sessionId } = await agent.request(v2.methods.agent.session.new, { cwd });
        await agent.request(v2.methods.agent.session.prompt, { sessionId, prompt: text("hi") });
        await aborted.promise;
        await vi.waitFor(() =>
          expect(
            client
              .updates("tool_call_update")
              .filter((update) => update.toolCallId === "toolu_cycle" && update.status)
              .map((update) => update.status),
          ).toEqual(["pending", "cancelled"]),
        );
        await client.authUpdate(1);
      });

      // The end is Claude Code's, with the kind that it stamped, not this closing's.
      expect(
        client
          .updates("tool_call_update")
          .findLast((update) => update.toolCallId === "toolu_cycle" && update.status),
      ).toMatchObject({ _meta: { claudeCode: { nonExecutionKind: "interrupted" } } });
    });

    it("closes the calls of a held turn's follow-up before idle cancelled, and leaves a running background subagent's open", async () => {
      const interrupted = Promise.withResolvers<void>();
      sdk.interrupt = async () => interrupted.resolve();
      scriptTurns(async function* (options) {
        yield markersInit(options);
        // The turn starts two background subagents, and ends while they run, so
        // v1 holds its answer for them. Its work ended at the result.
        for (const n of [1, 2]) {
          yield agentCall(options, `toolu_bg_${n}`, { run_in_background: true });
          yield taskFrame(options, "task_started", `agent-bg-${n}`, `toolu_bg_${n}`, {
            description: "Run it",
            subagent_type: "general-purpose",
            prompt: "Run it",
            is_backgrounded: true,
          });
        }
        yield toolUseMessage(
          options,
          "toolu_bg_child",
          "Bash",
          { command: "sleep 99" },
          "toolu_bg_2",
        );
        yield assistantText(options, "Running two subagents in the background.");
        yield result(options);
        yield idleState(options);
        // The first subagent finishes, and Claude Code's follow-up runs another
        // subagent in the foreground, which runs a command.
        yield taskFrame(options, "task_notification", "agent-bg-1", "toolu_bg_1", {
          status: "completed",
          output_file: "",
          summary: "done",
        });
        yield requesting(options);
        yield agentCall(options, "toolu_agent");
        yield taskFrame(options, "task_started", "agent-1", "toolu_agent", {
          description: "Run it",
          subagent_type: "general-purpose",
          prompt: "Run it",
        });
        yield toolUseMessage(options, "toolu_child", "Bash", { command: "make" }, "toolu_agent");
        await interrupted.promise;
        yield taskFrame(options, "task_notification", "agent-1", "toolu_agent", {
          status: "stopped",
          output_file: "",
          summary: "stopped",
        });
        yield toolResultMessage(options, "toolu_agent", { is_error: true }, "user-rejected");
        yield followupResult(options, ABORTED_TOOLS);
        yield idleState(options);
      });

      const { root, updates } = await cancelCycle("toolu_child");

      // The follow-up is a cycle that v2 reports: its calls end before its idle,
      // not at the settle of the held turn, which comes after. Each ends once.
      const end = lastStatusAt(updates, "toolu_child");
      expect(updates[end]).toMatchObject({ sessionId: "agent-1", update: { status: "cancelled" } });
      expect(statusesOf(updates, "toolu_child")).toHaveLength(2);
      expect(end).toBeLessThan(lastIdleAt(updates, root));
      // The other background subagent was not stopped, so its command runs on.
      expect(statusesOf(updates, "toolu_bg_child").map(({ update }) => update.status)).toEqual([
        "pending",
      ]);
    });
  });

  it("ends a cycle that the client cancels with idle cancelled", async () => {
    const interrupted = Promise.withResolvers<void>();
    sdk.interrupt = async () => interrupted.resolve();
    scriptTurns(async function* (options) {
      yield assistantText(options, "Started the build in the background.");
      yield result(options);
      yield idleState(options);
      yield stream(options, {
        type: "message_start",
        message: { id: "msg_followup", role: "assistant", content: [], usage: {} },
      });
      yield stream(options, {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "The build" },
      });
      await interrupted.promise;
      yield followupResult(options);
      yield idleState(options);
    });
    const client = await promptAndWait(2, async (agent, sessionId, client) => {
      await vi.waitFor(() =>
        expect(turnTrace(client.sessionUpdates)).toEqual([
          ...endedTurn,
          "running",
          "agent_message_chunk",
        ]),
      );
      await agent.notify(v2.methods.agent.session.cancel, { sessionId });
    });

    expect(turnTrace(client.sessionUpdates)).toEqual([
      ...endedTurn,
      "running",
      "agent_message_chunk",
      "idle cancelled",
    ]);
  });

  it("lets a prompt that Claude Code takes in during a cycle take the cycle over", async () => {
    const echoed = scriptTurns(
      async function* (options) {
        yield assistantText(options, "Started the build in the background.");
        yield result(options);
        yield idleState(options);
        // The follow-up still runs when the next prompt comes in.
        yield assistantText(options, "The build passed.", "msg_followup");
      },
      async function* (options) {
        yield assistantText(options, "Deployed.", "msg_deploy");
        yield result(options);
        yield idleState(options);
      },
    );
    const client = await promptAndWait(2, async (agent, sessionId, client) => {
      await vi.waitFor(() =>
        expect(turnTrace(client.sessionUpdates)).toEqual([
          ...endedTurn,
          "running",
          "agent_message_chunk",
        ]),
      );
      expect(
        await agent.request(v2.methods.agent.session.prompt, { sessionId, prompt: text("deploy") }),
      ).toEqual({ messageId: echoed[1] });
    });

    // The work runs on under the turn: no idle, and no second running.
    expect(turnTrace(client.sessionUpdates)).toEqual([
      ...endedTurn,
      "running",
      "agent_message_chunk",
      "user_message",
      "agent_message_chunk",
      "idle end_turn",
    ]);
  });

  it("ends a cycle at its own result, not at a placeholder result or an idle owed to the turn", async () => {
    scriptTurns(async function* (options) {
      yield assistantText(options, "Started two builds in the background.");
      yield result(options);
      // The turn's idle comes late, after the follow-up started.
      yield assistantText(options, "The first build passed.", "msg_first");
      yield idleState(options);
      // Claude Code answers queued notifications with one model call, and
      // gives each but the last a placeholder result.
      yield followupResult(options, { num_turns: 0 });
      yield assistantText(options, "The second build passed too.", "msg_second");
      yield followupResult(options);
      yield idleState(options);
    });
    const client = await promptAndWait(2);

    expect(turnTrace(client.sessionUpdates)).toEqual([
      ...endedTurn,
      "running",
      "agent_message_chunk",
      "agent_message_chunk",
      "idle end_turn",
    ]);
  });

  it("ends a cycle at an idle when its result never comes", async () => {
    scriptTurns(async function* (options) {
      yield assistantText(options, "Started the build in the background.");
      yield result(options);
      yield idleState(options);
      yield assistantText(options, "The build", "msg_followup");
      // The stream lost the cycle's result.
      yield idleState(options);
    });
    const client = await promptAndWait(2);

    expect(turnTrace(client.sessionUpdates)).toEqual([
      ...endedTurn,
      "running",
      "agent_message_chunk",
      "idle end_turn",
    ]);
    expect(client.updates("state_update").at(-1)).not.toHaveProperty("usage");
  });

  it("reports a cycle that waits on a question as requires_action", async () => {
    scriptTurns(async function* (options) {
      yield assistantText(options, "Started the build in the background.");
      yield result(options);
      yield idleState(options);
      yield assistantText(options, "The build failed. One question first.", "msg_followup");
      await options.onElicitation!(
        {
          serverName: "linear",
          message: "Which team?",
          mode: "form",
          requestedSchema: { type: "object", properties: { team: { type: "string" } } },
        },
        { signal: new AbortController().signal } as Parameters<
          NonNullable<Options["onElicitation"]>
        >[1],
      );
      yield followupResult(options);
      yield idleState(options);
    });
    const client = await promptAndWait(2, undefined, { elicitation: { form: {} } });

    expect(turnTrace(client.sessionUpdates)).toEqual([
      ...endedTurn,
      "running",
      "agent_message_chunk",
      "requires_action",
      "running",
      "idle end_turn",
    ]);
  });

  it("reports a cycle whose result is an error as idle with the error stop reason", async () => {
    scriptTurns(async function* (options) {
      yield assistantText(options, "Started the build in the background.");
      yield result(options);
      yield idleState(options);
      yield assistantText(options, "Looking at the build.", "msg_followup");
      yield followupResult(options, { is_error: true, result: "API Error: 529 Overloaded" });
      yield idleState(options);
    });
    const client = await promptAndWait(2);

    expect(turnTrace(client.sessionUpdates)).toEqual([
      ...endedTurn,
      "running",
      "agent_message_chunk",
      "idle error",
    ]);
    expect(client.updates("state_update").at(-1)).toMatchObject({
      error: { code: -32603, message: expect.stringContaining("API Error: 529 Overloaded") },
    });
  });

  it.each([
    ["ends", false],
    ["fails", true],
  ])("ends a cycle with an error when the stream %s during it", async (_, fails) => {
    sdk.run = async function* (prompts, options) {
      const { value } = await prompts[Symbol.asyncIterator]().next();
      yield {
        type: "user",
        message: value!.message,
        parent_tool_use_id: null,
        uuid: value!.uuid,
        session_id: options.sessionId,
        isReplay: true,
      };
      yield assistantText(options, "Started the build in the background.");
      yield result(options);
      yield idleState(options);
      yield assistantText(options, "The build", "msg_followup");
      // Claude Code exits, or the stream breaks.
      if (fails) throw new Error("stream broke");
    };
    const client = await promptAndWait(2);

    expect(turnTrace(client.sessionUpdates)).toEqual([
      ...endedTurn,
      "running",
      "agent_message_chunk",
      "idle error",
    ]);
  });

  it("leaves output that comes before a queued prompt's echo to that prompt", async () => {
    sdk.run = async function* (prompts, options) {
      const input = prompts[Symbol.asyncIterator]();
      const echo = (value: SDKUserMessage) => ({
        type: "user",
        message: value.message,
        parent_tool_use_id: null,
        uuid: value.uuid,
        session_id: options.sessionId,
        isReplay: true,
      });
      yield echo((await input.next()).value);
      yield assistantText(options, "Started the build in the background.");
      yield result(options);
      yield idleState(options);
      // The next prompt's answer starts streaming before its echo.
      const next = (await input.next()).value;
      yield stream(options, {
        type: "message_start",
        message: { id: "msg_deploy", role: "assistant", content: [], usage: {} },
      });
      yield stream(options, {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "Deploying" },
      });
      yield echo(next);
      yield result(options);
      yield idleState(options);
      while (!(await input.next()).done);
    };
    const client = await promptAndWait(2, async (agent, sessionId, client) => {
      await vi.waitFor(() => expect(turnTrace(client.sessionUpdates)).toEqual(endedTurn));
      await agent.request(v2.methods.agent.session.prompt, { sessionId, prompt: text("deploy") });
    });

    expect(turnTrace(client.sessionUpdates)).toEqual([
      ...endedTurn,
      "agent_message_chunk",
      "user_message",
      "running",
      "idle end_turn",
    ]);
  });

  it("leaves a subagent's output after the turn to the session's background", async () => {
    scriptTurns(async function* (options) {
      yield assistantText(options, "Started a background review.");
      yield result(options);
      yield idleState(options);
      yield {
        ...assistantText(options, "Reviewing.", "msg_subagent"),
        parent_tool_use_id: "toolu_agent",
      };
      // Claude Code goes idle again while the subagent works. That idle would
      // end a cycle that the subagent's output had opened.
      yield idleState(options);
      yield assistantText(options, "The review is done.", "msg_followup");
      yield followupResult(options);
      yield idleState(options);
    });
    const client = await promptAndWait(2);

    // The cycle starts at the main conversation's output, not the subagent's.
    expect(turnTrace(client.sessionUpdates)).toEqual([
      ...endedTurn,
      "running",
      "agent_message_chunk",
      "idle end_turn",
    ]);
  });

  it("reports idle at the result of a turn that v1 holds for its background subagent, and the follow-up as a cycle", async () => {
    scriptTurns(async function* (options) {
      yield {
        type: "system",
        subtype: "task_started",
        task_id: "agent-1",
        tool_use_id: "toolu_agent-1",
        description: "Explore the project",
        subagent_type: "Explore",
        uuid: randomUUID(),
        session_id: options.sessionId,
      };
      yield assistantText(options, "Exploring in the background.");
      // The turn's result: v1 holds its answer for the live subagent.
      yield result(options);
      yield idleState(options);
      // The subagent asks for permission while the session is idle. The test
      // client declines, which rejects the request.
      await options.canUseTool!("Bash", { command: "ls" }, {
        signal: new AbortController().signal,
        suggestions: [],
        toolUseID: "toolu_explore",
        agentID: "agent-1",
        requestId: "request-explore",
      } as Parameters<NonNullable<Options["canUseTool"]>>[2]).catch(() => undefined);
      yield {
        type: "system",
        subtype: "task_notification",
        task_id: "agent-1",
        tool_use_id: "toolu_agent-1",
        status: "completed",
        output_file: "",
        summary: "done",
        uuid: randomUUID(),
        session_id: options.sessionId,
      };
      // Claude Code wakes the model to report what the subagent found.
      yield assistantText(options, "The exploration found three issues.", "msg_followup");
      yield followupResult(options);
      yield idleState(options);
    });
    const client = await promptAndWait(2);

    expect(client.permissionRequests).toHaveLength(1);
    // The background request leaves the idle session idle.
    expect(turnTrace(client.sessionUpdates)).toEqual([
      ...endedTurn,
      "running",
      "agent_message_chunk",
      "idle end_turn",
    ]);
    expect(client.updates("state_update")[1]).toMatchObject({
      state: "idle",
      stopReason: "end_turn",
      usage: { inputTokens: 3, outputTokens: 2 },
    });
  });

  it("starts a cycle at output before a queued prompt that Claude Code reports it has not started", async () => {
    sdk.run = async function* (prompts, options) {
      const input = prompts[Symbol.asyncIterator]();
      const echo = (value: SDKUserMessage) => ({
        type: "user",
        message: value.message,
        parent_tool_use_id: null,
        uuid: value.uuid,
        session_id: options.sessionId,
        isReplay: true,
      });
      const lifecycle = (value: SDKUserMessage, state: string) => ({
        type: "command_lifecycle",
        command_uuid: value.uuid,
        state,
        uuid: randomUUID(),
        session_id: options.sessionId,
      });
      yield {
        type: "system",
        subtype: "init",
        session_id: options.sessionId,
        capabilities: ["msg_lifecycle_v1"],
      };
      const first = (await input.next()).value;
      yield lifecycle(first, "started");
      yield echo(first);
      yield assistantText(options, "Started the build in the background.");
      yield result(options);
      yield idleState(options);
      // The next prompt is queued while Claude Code reports the build.
      const next = (await input.next()).value;
      yield assistantText(options, "The build passed.", "msg_followup");
      yield followupResult(options);
      yield lifecycle(next, "started");
      yield echo(next);
      yield result(options);
      yield idleState(options);
      while (!(await input.next()).done);
    };
    const client = await promptAndWait(3, async (agent, sessionId, client) => {
      await vi.waitFor(() => expect(turnTrace(client.sessionUpdates)).toEqual(endedTurn));
      await agent.request(v2.methods.agent.session.prompt, { sessionId, prompt: text("deploy") });
    });

    expect(turnTrace(client.sessionUpdates)).toEqual([
      ...endedTurn,
      "running",
      "agent_message_chunk",
      "idle end_turn",
      "user_message",
      "running",
      "idle end_turn",
    ]);
  });

  it("ends a cycle with idle cancelled before it answers session/close", async () => {
    const followup = Promise.withResolvers<void>();
    scriptTurns(async function* (options) {
      yield assistantText(options, "Started the build in the background.");
      yield result(options);
      yield idleState(options);
      yield assistantText(options, "The build", "msg_followup");
      await followup.promise;
    });
    const client = v2Client();
    let atClose: string[] = [];
    await client.app.connectWith(connectRouter(), async (agent) => {
      await initializeV2(agent);
      const { sessionId } = await agent.request(v2.methods.agent.session.new, { cwd });
      await agent.request(v2.methods.agent.session.prompt, { sessionId, prompt: text("hi") });
      await vi.waitFor(() =>
        expect(turnTrace(client.sessionUpdates)).toEqual([
          ...endedTurn,
          "running",
          "agent_message_chunk",
        ]),
      );
      await agent.request(v2.methods.agent.session.close, { sessionId });
      atClose = turnTrace(client.sessionUpdates);
      followup.resolve();
      await client.authUpdate(1);
    });

    expect(atClose).toEqual([...endedTurn, "running", "agent_message_chunk", "idle cancelled"]);
  });

  // After an interrupt, CLI 2.1.293 ends the interrupted work with an aborted
  // result, then goes on with its queue, and each model request starts with a
  // `status: requesting` frame that lists the prompts it serves.

  /** Claude Code's `system`/init, advertising that its requests list their prompts. */
  const markersInit = (options: Options) => ({
    type: "system",
    subtype: "init",
    capabilities: ["request_marker_lists_v1"],
    session_id: options.sessionId,
  });
  /** The frame that starts a model request serving `prompts`. */
  const requesting = (options: Options, ...prompts: string[]) => ({
    type: "system",
    subtype: "status",
    status: "requesting",
    ...(prompts.length > 0 ? { user_message_uuids: prompts } : {}),
    uuid: randomUUID(),
    session_id: options.sessionId,
  });
  /** How a result ends work that an interrupt stopped while the model streamed. */
  const ABORTED = {
    subtype: "error_during_execution",
    is_error: true,
    stop_reason: null,
    terminal_reason: "aborted_streaming",
  };

  it("ends a cancelled turn at its result and reports the follow-up after it as a cycle", async () => {
    const interrupted = Promise.withResolvers<void>();
    sdk.interrupt = async () => interrupted.resolve();
    scriptTurns(async function* (options) {
      yield markersInit(options);
      yield stream(options, {
        type: "message_start",
        message: { id: "msg_1", role: "assistant", content: [], usage: {} },
      });
      yield stream(options, {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "Starting" },
      });
      await interrupted.promise;
      yield result(options, ABORTED);
      // A command that the turn backgrounded finished while it ran, so
      // Claude Code runs its follow-up next, with no idle in between.
      yield requesting(options);
      yield assistantText(options, "The build passed.", "msg_followup");
      yield followupResult(options);
      yield idleState(options);
    });
    const client = await promptAndWait(2, async (agent, sessionId, client) => {
      await vi.waitFor(() =>
        expect(turnTrace(client.sessionUpdates)).toEqual([
          "user_message",
          "running",
          "agent_message_chunk",
        ]),
      );
      await agent.notify(v2.methods.agent.session.cancel, { sessionId });
    });

    expect(turnTrace(client.sessionUpdates)).toEqual([
      "user_message",
      "running",
      "agent_message_chunk",
      "idle cancelled",
      "running",
      "agent_message_chunk",
      "idle end_turn",
    ]);
  });

  it("reports a follow-up that Claude Code runs after a cancel while nothing ran", async () => {
    const interrupted = Promise.withResolvers<void>();
    sdk.interrupt = async () => interrupted.resolve();
    scriptTurns(async function* (options) {
      yield markersInit(options);
      yield assistantText(options, "Started the build in the background.");
      yield result(options);
      yield idleState(options);
      await interrupted.promise;
      // An interrupt while nothing runs makes Claude Code report idle again.
      yield idleState(options);
      yield requesting(options);
      yield assistantText(options, "The build passed.", "msg_followup");
      yield followupResult(options);
      yield idleState(options);
    });
    const client = await promptAndWait(2, async (agent, sessionId, client) => {
      await vi.waitFor(() => expect(turnTrace(client.sessionUpdates)).toEqual(endedTurn));
      await agent.notify(v2.methods.agent.session.cancel, { sessionId });
    });

    expect(turnTrace(client.sessionUpdates)).toEqual([
      ...endedTurn,
      "running",
      "agent_message_chunk",
      "idle end_turn",
    ]);
  });

  it("reports the compaction of a follow-up that Claude Code runs after a cancel", async () => {
    const interrupted = Promise.withResolvers<void>();
    sdk.interrupt = async () => interrupted.resolve();
    scriptTurns(async function* (options) {
      yield markersInit(options);
      yield assistantText(options, "Started the build in the background.");
      yield result(options);
      yield idleState(options);
      await interrupted.promise;
      yield idleState(options);
      // The follow-up's request compacts the context before the model runs.
      yield requesting(options);
      yield {
        type: "system",
        subtype: "status",
        status: "compacting",
        uuid: randomUUID(),
        session_id: options.sessionId,
      };
      yield {
        type: "system",
        subtype: "compact_boundary",
        compact_metadata: { trigger: "auto", pre_tokens: 1000, post_tokens: 100, duration_ms: 7 },
        uuid: randomUUID(),
        session_id: options.sessionId,
      };
      yield {
        type: "system",
        subtype: "status",
        status: null,
        compact_result: "success",
        uuid: randomUUID(),
        session_id: options.sessionId,
      };
      yield assistantText(options, "The build passed.", "msg_followup");
      yield followupResult(options);
      yield idleState(options);
    });
    const client = await promptAndWait(2, async (agent, sessionId, client) => {
      await vi.waitFor(() => expect(turnTrace(client.sessionUpdates)).toEqual(endedTurn));
      await agent.notify(v2.methods.agent.session.cancel, { sessionId });
    });

    expect(client.updates("compaction_update").length).toBeGreaterThan(0);
  });

  it("reports a later cycle after the client cancelled one", async () => {
    const interrupted = Promise.withResolvers<void>();
    sdk.interrupt = async () => interrupted.resolve();
    scriptTurns(async function* (options) {
      yield markersInit(options);
      yield assistantText(options, "Started two builds in the background.");
      yield result(options);
      yield idleState(options);
      yield requesting(options);
      yield assistantText(options, "The first build", "msg_first");
      await interrupted.promise;
      yield followupResult(options, ABORTED);
      yield idleState(options);
      yield requesting(options);
      yield assistantText(options, "The second build passed.", "msg_second");
      yield followupResult(options);
      yield idleState(options);
    });
    const client = await promptAndWait(3, async (agent, sessionId, client) => {
      await vi.waitFor(() =>
        expect(turnTrace(client.sessionUpdates)).toEqual([
          ...endedTurn,
          "running",
          "agent_message_chunk",
        ]),
      );
      await agent.notify(v2.methods.agent.session.cancel, { sessionId });
    });

    expect(turnTrace(client.sessionUpdates)).toEqual([
      ...endedTurn,
      "running",
      "agent_message_chunk",
      "idle cancelled",
      "running",
      "agent_message_chunk",
      "idle end_turn",
    ]);
  });

  it("ends a cycle that the interrupt stopped cancelled, when Claude Code had started it before the cancel arrived", async () => {
    const interrupted = Promise.withResolvers<void>();
    sdk.interrupt = async () => interrupted.resolve();
    scriptTurns(async function* (options) {
      yield markersInit(options);
      yield assistantText(options, "Started two builds in the background.");
      yield result(options);
      yield idleState(options);
      yield requesting(options);
      yield assistantText(options, "The first build passed.", "msg_first");
      await interrupted.promise;
      // Claude Code had finished the first cycle and started the second one
      // when the interrupt arrived, so the interrupt stops the second.
      yield followupResult(options);
      yield requesting(options);
      yield assistantText(options, "The second build", "msg_second");
      yield followupResult(options, ABORTED);
      yield idleState(options);
    });
    const client = await promptAndWait(3, async (agent, sessionId, client) => {
      await vi.waitFor(() =>
        expect(turnTrace(client.sessionUpdates)).toEqual([
          ...endedTurn,
          "running",
          "agent_message_chunk",
        ]),
      );
      await agent.notify(v2.methods.agent.session.cancel, { sessionId });
    });

    expect(turnTrace(client.sessionUpdates)).toEqual([
      ...endedTurn,
      "running",
      "agent_message_chunk",
      "idle cancelled",
      "running",
      "agent_message_chunk",
      "idle cancelled",
    ]);
  });

  it("drops the streamed answer to a prompt that Claude Code had taken before the cancel", async () => {
    const interrupted = Promise.withResolvers<void>();
    sdk.interrupt = async () => interrupted.resolve();
    const echo = (options: Options, prompt: { uuid?: string; message: unknown }) => ({
      type: "user",
      message: prompt.message,
      parent_tool_use_id: null,
      uuid: prompt.uuid,
      session_id: options.sessionId,
      isReplay: true,
    });
    // How Claude Code sends an answer: it streams the text, then sends the
    // whole message.
    const answer = (options: Options, text: string, id: string) => [
      stream(options, {
        type: "message_start",
        message: { id, role: "assistant", content: [], usage: {} },
      }),
      stream(options, {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      }),
      stream(options, {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text },
      }),
      assistantText(options, text, id),
      stream(options, { type: "content_block_stop", index: 0 }),
      stream(options, { type: "message_stop" }),
    ];
    sdk.run = async function* (prompts, options) {
      const input = prompts[Symbol.asyncIterator]();
      const { value: first } = await input.next();
      yield markersInit(options);
      yield requesting(options, first.uuid!);
      yield echo(options, first);
      yield* answer(options, "Starting the build.", "msg_first");
      const { value: second } = await input.next();
      await interrupted.promise;
      yield result(options, { ...ABORTED, user_message_uuids: [first.uuid] });
      // Claude Code had already taken the second prompt, so it still runs it.
      yield requesting(options, second.uuid!);
      yield echo(options, second);
      yield* answer(options, "Here is the second answer.", "msg_second");
      yield result(options, { user_message_uuids: [second.uuid] });
      yield idleState(options);
      // A command that the first turn backgrounded finished.
      yield requesting(options);
      yield* answer(options, "The build passed.", "msg_followup");
      yield followupResult(options);
      yield idleState(options);
      while (!(await input.next()).done);
    };
    const client = await promptAndWait(2, async (agent, sessionId, client) => {
      await vi.waitFor(() =>
        expect(turnTrace(client.sessionUpdates)).toEqual([
          "user_message",
          "running",
          "agent_message_chunk",
        ]),
      );
      const queued = agent.request(v2.methods.agent.session.prompt, {
        sessionId,
        prompt: text("and test it"),
      });
      await vi.waitFor(() => expect(agents[0].sessions[sessionId]?.turnQueue).toHaveLength(2));
      await agent.notify(v2.methods.agent.session.cancel, { sessionId });
      await expect(queued).rejects.toMatchObject({ code: -32800 });
    });

    expect(turnTrace(client.sessionUpdates)).toEqual([
      "user_message",
      "running",
      "agent_message_chunk",
      "idle cancelled",
      "running",
      "agent_message_chunk",
      "idle end_turn",
    ]);
    expect(client.updates("agent_message_chunk").map(({ content }) => content)).toEqual([
      { type: "text", text: "Starting the build." },
      { type: "text", text: "The build passed." },
    ]);
  });

  it("shows nothing of a tool that a prompt the cancel abandoned asks to run, and denies it (#1061)", async () => {
    const interrupted = Promise.withResolvers<void>();
    sdk.interrupt = async () => interrupted.resolve();
    const echo = (options: Options, prompt: { uuid?: string; message: unknown }) => ({
      type: "user",
      message: prompt.message,
      parent_tool_use_id: null,
      uuid: prompt.uuid,
      session_id: options.sessionId,
      isReplay: true,
    });
    const input = { file_path: path.join(cwd, "notes.md"), content: "done\n" };
    let decision: unknown;
    sdk.run = async function* (prompts, options) {
      const iter = prompts[Symbol.asyncIterator]();
      const { value: first } = await iter.next();
      yield markersInit(options);
      yield requesting(options, first.uuid!);
      yield echo(options, first);
      yield assistantText(options, "Starting the build.", "msg_first");
      const { value: second } = await iter.next();
      await interrupted.promise;
      yield result(options, { ...ABORTED, user_message_uuids: [first.uuid] });
      // Claude Code had already taken the second prompt, so it still runs it,
      // and its answer writes a file.
      yield requesting(options, second.uuid!);
      yield echo(options, second);
      yield stream(options, {
        type: "message_start",
        message: { id: "msg_second", role: "assistant", content: [], usage: {} },
      });
      yield stream(options, {
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "toolu_late", name: "Write", input: {} },
      });
      yield {
        type: "assistant",
        message: {
          id: "msg_second",
          type: "message",
          role: "assistant",
          model: "claude-sonnet-4-6",
          content: [{ type: "tool_use", id: "toolu_late", name: "Write", input }],
          stop_reason: "tool_use",
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        },
        parent_tool_use_id: null,
        uuid: randomUUID(),
        session_id: options.sessionId,
      };
      // Claude Code runs the PreToolUse hooks, then asks for the permission.
      for (const matcher of options.hooks?.PreToolUse ?? []) {
        for (const hook of matcher.hooks) {
          await hook(
            {
              hook_event_name: "PreToolUse",
              session_id: options.sessionId!,
              cwd,
              tool_name: "Write",
              tool_input: input,
              tool_use_id: "toolu_late",
            } as never,
            "toolu_late",
            { signal: new AbortController().signal },
          );
        }
      }
      decision = await options.canUseTool!("Write", input, {
        signal: new AbortController().signal,
        suggestions: [],
        toolUseID: "toolu_late",
      } as never);
      yield {
        type: "user",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_late",
              content: "The user cancelled this prompt.",
              is_error: true,
            },
          ],
        },
        parent_tool_use_id: null,
        uuid: randomUUID(),
        session_id: options.sessionId,
      };
      yield result(options, { user_message_uuids: [second.uuid] });
      yield idleState(options);
      while (!(await iter.next()).done);
    };
    const client = await promptAndWait(1, async (agent, sessionId, client) => {
      await vi.waitFor(() =>
        expect(turnTrace(client.sessionUpdates)).toEqual([
          "user_message",
          "running",
          "agent_message_chunk",
        ]),
      );
      const queued = agent.request(v2.methods.agent.session.prompt, {
        sessionId,
        prompt: text("and write it down"),
      });
      await vi.waitFor(() => expect(agents[0].sessions[sessionId]?.turnQueue).toHaveLength(2));
      await agent.notify(v2.methods.agent.session.cancel, { sessionId });
      await expect(queued).rejects.toMatchObject({ code: -32800 });
      await vi.waitFor(() => expect(decision).toBeDefined());
    });

    expect(decision).toEqual({ behavior: "deny", message: "The user cancelled this prompt." });
    // Neither a tool call, which would never end, nor a patch, nor a request.
    expect(client.sessionUpdates.filter(({ update }) => "toolCallId" in update)).toEqual([]);
    expect(client.permissionRequests).toEqual([]);
    expect(turnTrace(client.sessionUpdates)).toEqual([
      "user_message",
      "running",
      "agent_message_chunk",
      "idle cancelled",
    ]);
  });

  it("reports what the interrupt flushes of a cycle that Claude Code started before idle cancelled", async () => {
    const interrupted = Promise.withResolvers<void>();
    sdk.interrupt = async () => interrupted.resolve();
    scriptTurns(async function* (options) {
      yield markersInit(options);
      yield assistantText(options, "Started the build in the background.");
      yield result(options);
      yield idleState(options);
      yield requesting(options);
      yield stream(options, {
        type: "message_start",
        message: { id: "msg_followup", role: "assistant", content: [], usage: {} },
      });
      yield stream(options, {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "The build" },
      });
      await interrupted.promise;
      yield stream(options, {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: " passed." },
      });
      yield assistantText(options, "The build passed.", "msg_followup");
      yield stream(options, { type: "message_stop" });
      yield followupResult(options, ABORTED);
      yield idleState(options);
    });
    const client = await promptAndWait(2, async (agent, sessionId, client) => {
      await vi.waitFor(() =>
        expect(turnTrace(client.sessionUpdates)).toEqual([
          ...endedTurn,
          "running",
          "agent_message_chunk",
        ]),
      );
      await agent.notify(v2.methods.agent.session.cancel, { sessionId });
    });

    expect(turnTrace(client.sessionUpdates)).toEqual([
      ...endedTurn,
      "running",
      "agent_message_chunk",
      "agent_message_chunk",
      "idle cancelled",
    ]);
  });

  it("drops the output of a held turn's follow-up that a cancel stopped before it showed any", async () => {
    const interrupted = Promise.withResolvers<void>();
    sdk.interrupt = async () => interrupted.resolve();
    scriptTurns(async function* (options) {
      yield markersInit(options);
      yield {
        type: "system",
        subtype: "task_started",
        task_id: "agent-1",
        tool_use_id: "toolu_agent-1",
        description: "Explore the project",
        subagent_type: "Explore",
        uuid: randomUUID(),
        session_id: options.sessionId,
      };
      yield assistantText(options, "Exploring in the background.");
      // The turn's result: v1 holds its answer for the live subagent, and v2
      // reports idle.
      yield result(options);
      yield idleState(options);
      yield {
        type: "system",
        subtype: "task_notification",
        task_id: "agent-1",
        tool_use_id: "toolu_agent-1",
        status: "completed",
        output_file: "",
        summary: "done",
        uuid: randomUUID(),
        session_id: options.sessionId,
      };
      // The follow-up's request starts, and the cancel comes before its output.
      yield requesting(options);
      await interrupted.promise;
      yield stream(options, {
        type: "message_start",
        message: { id: "msg_followup", role: "assistant", content: [], usage: {} },
      });
      yield stream(options, {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "The exploration" },
      });
      yield followupResult(options, ABORTED);
      yield idleState(options);
      // A later cycle shows that the session goes on.
      yield requesting(options);
      yield assistantText(options, "The build passed.", "msg_later");
      yield followupResult(options);
      yield idleState(options);
    });
    const client = await promptAndWait(2, async (agent, sessionId, client) => {
      await vi.waitFor(() => expect(turnTrace(client.sessionUpdates)).toEqual(endedTurn));
      await vi.waitFor(() =>
        expect(agents[0].sessions[sessionId]?.modelRequestSinceResult).toBe(true),
      );
      await agent.notify(v2.methods.agent.session.cancel, { sessionId });
    });

    expect(turnTrace(client.sessionUpdates)).toEqual([
      ...endedTurn,
      "running",
      "agent_message_chunk",
      "idle end_turn",
    ]);
    expect(client.updates("agent_message_chunk").map(({ content }) => content)).toEqual([
      { type: "text", text: "Exploring in the background." },
      { type: "text", text: "The build passed." },
    ]);
  });
});

// The session reports `requires_action` only for a request that blocks its
// foreground work: the main conversation's, or a subagent's whose spawning tool
// call waits on it. A subagent in the background asks without blocking it.
describe("ACP v2 requests that subagents make", () => {
  const taskStarted = (options: Options, taskId: string, fields: Record<string, unknown>) => ({
    type: "system",
    subtype: "task_started",
    task_id: taskId,
    tool_use_id: `toolu_${taskId}`,
    description: "Explore the project",
    subagent_type: "Explore",
    uuid: randomUUID(),
    session_id: options.sessionId,
    ...fields,
  });

  /** Asks for permission for a Bash call of the subagent `agentID`, and
   *  resolves once the client answers, or Claude Code aborts `signal`. */
  const askFor = (options: Options, agentID: string, signal = new AbortController().signal) =>
    options.canUseTool!("Bash", { command: "ls" }, {
      signal,
      suggestions: [],
      toolUseID: `toolu_ls_${agentID}`,
      agentID,
      requestId: randomUUID(),
    } as Parameters<NonNullable<Options["canUseTool"]>>[2]).catch(() => undefined);

  /** Sends the prompt "hi" and returns the client once the turn is idle. */
  async function promptToIdle(
    client: ReturnType<typeof v2Client>,
    capabilities: v2.ClientCapabilities = {},
  ) {
    await client.app.connectWith(connectRouter(), async (agent) => {
      await initializeV2(agent, capabilities);
      const { sessionId } = await agent.request(v2.methods.agent.session.new, { cwd });
      await agent.request(v2.methods.agent.session.prompt, { sessionId, prompt: text("hi") });
      await vi.waitFor(() => expect(turnTrace(client.sessionUpdates)).toContain("idle end_turn"));
      await client.authUpdate(1);
    });
    return client;
  }

  /** One turn in which the subagent `agentID` asks for permission. */
  function turnWithRequest(tasks: Array<[string, Record<string, unknown>]>, agentID: string) {
    scriptTurns(async function* (options) {
      for (const [taskId, fields] of tasks) yield taskStarted(options, taskId, fields);
      yield assistantText(options, "Exploring.");
      await askFor(options, agentID);
      yield result(options);
      yield idleState(options);
    });
  }

  it("reports a subagent as a child session, with its work state also on the child's stream", async () => {
    scriptTurns(async function* (options) {
      yield {
        type: "assistant",
        message: {
          id: "msg_agent",
          type: "message",
          role: "assistant",
          model: "claude-sonnet-4-6",
          content: [
            {
              type: "tool_use",
              id: "toolu_agent-1",
              name: "Agent",
              input: { description: "Explore the project", prompt: "Look around" },
            },
          ],
          stop_reason: "tool_use",
          stop_sequence: null,
          usage: { input_tokens: 3, output_tokens: 2 },
        },
        parent_tool_use_id: null,
        uuid: randomUUID(),
        session_id: options.sessionId,
      };
      yield taskStarted(options, "agent-1", { prompt: "Look around" });
      yield {
        type: "system",
        subtype: "task_updated",
        task_id: "agent-1",
        patch: { status: "failed", error: "The model is overloaded" },
        uuid: randomUUID(),
        session_id: options.sessionId,
      };
      yield result(options);
      yield idleState(options);
    });
    const client = await promptToIdle(v2Client());

    const root = client.sessionUpdates.find(
      ({ update }) => update.sessionUpdate === "user_message",
    )!.sessionId;
    const traffic = client.sessionUpdates.flatMap(({ sessionId, update }) => {
      const on = sessionId === root ? "root" : sessionId;
      if (update.sessionUpdate === "subagent_update") {
        const state = update.state as { state: string; stopReason?: string } | undefined;
        return [
          `${on} subagent_update ${update.sessionId} ${state?.state} ${state?.stopReason ?? ""}`,
        ];
      }
      if (sessionId === root) return [];
      if (update.sessionUpdate === "state_update") {
        const { state, stopReason } = update as { state: string; stopReason?: string };
        return [`${on} state_update ${state} ${stopReason ?? ""}`];
      }
      return [`${on} ${update.sessionUpdate}`];
    });
    // The announcement comes first, and each state reaches the parent, then
    // the child.
    expect(traffic).toEqual([
      "root subagent_update agent-1 running ",
      "agent-1 state_update running ",
      "agent-1 session_message",
      "root subagent_update agent-1 idle error",
      "agent-1 state_update idle error",
    ]);
    expect(
      client.sessionUpdates.filter(
        ({ sessionId, update }) =>
          sessionId === "agent-1" && update.sessionUpdate === "state_update",
      )[1].update,
    ).toEqual({
      sessionUpdate: "state_update",
      state: "idle",
      stopReason: "error",
      error: { code: -32603, message: "The model is overloaded" },
    });
  });

  it("stops a child's task when the client cancels the child session, and reports the child idle cancelled on both streams", async () => {
    const stopped = Promise.withResolvers<string>();
    sdk.stopTask = async (taskId) => stopped.resolve(taskId);
    let interrupted = false;
    sdk.interrupt = async () => {
      interrupted = true;
    };
    scriptTurns(async function* (options) {
      yield {
        type: "assistant",
        message: {
          id: "msg_agent",
          type: "message",
          role: "assistant",
          model: "claude-sonnet-4-6",
          content: [
            {
              type: "tool_use",
              id: "toolu_agent-1",
              name: "Agent",
              input: { description: "Explore the project", prompt: "Look around" },
            },
          ],
          stop_reason: "tool_use",
          stop_sequence: null,
          usage: { input_tokens: 3, output_tokens: 2 },
        },
        parent_tool_use_id: null,
        uuid: randomUUID(),
        session_id: options.sessionId,
      };
      yield taskStarted(options, "agent-1", { prompt: "Look around" });
      await stopped.promise;
      // As seen live: the child's end, then the Agent call's interrupted
      // result, and the turn goes on.
      yield {
        type: "system",
        subtype: "task_updated",
        task_id: "agent-1",
        patch: { status: "killed" },
        uuid: randomUUID(),
        session_id: options.sessionId,
      };
      yield {
        type: "user",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_agent-1",
              is_error: true,
              content: "[Request interrupted by user for tool use]",
            },
          ],
        },
        parent_tool_use_id: null,
        uuid: randomUUID(),
        session_id: options.sessionId,
      };
      yield assistantText(options, "The subagent was stopped.");
      yield result(options);
      yield idleState(options);
    });
    const client = v2Client();
    await client.app.connectWith(connectRouter(), async (agent) => {
      await initializeV2(agent);
      const { sessionId } = await agent.request(v2.methods.agent.session.new, { cwd });
      await agent.request(v2.methods.agent.session.prompt, { sessionId, prompt: text("hi") });
      await vi.waitFor(() =>
        expect(
          client.sessionUpdates.some(({ update }) => update.sessionUpdate === "subagent_update"),
        ).toBe(true),
      );
      await agent.notify(v2.methods.agent.session.cancel, { sessionId: "agent-1" });
      await expect(stopped.promise).resolves.toBe("agent-1");
      await vi.waitFor(() => expect(turnTrace(client.sessionUpdates)).toContain("idle end_turn"));
      await client.authUpdate(1);
    });

    expect(interrupted).toBe(false);
    const subagentUpdates = client.sessionUpdates.flatMap(({ update }) =>
      update.sessionUpdate === "subagent_update" ? [update] : [],
    );
    expect(subagentUpdates[0]).toMatchObject({
      sessionId: "agent-1",
      capabilities: { cancel: {} },
      state: { state: "running" },
    });
    expect(subagentUpdates.at(-1)).toEqual({
      sessionUpdate: "subagent_update",
      sessionId: "agent-1",
      state: { state: "idle", stopReason: "cancelled" },
    });
    expect(
      client.sessionUpdates
        .filter(
          ({ sessionId, update }) =>
            sessionId === "agent-1" && update.sessionUpdate === "state_update",
        )
        .map(({ update }) => update),
    ).toEqual([
      { sessionUpdate: "state_update", state: "running" },
      { sessionUpdate: "state_update", state: "idle", stopReason: "cancelled" },
    ]);
    // The turn goes on, and ends as Claude Code ends it.
    expect(turnTrace(client.sessionUpdates).at(-1)).toBe("idle end_turn");
  });

  it("keeps the turn running while a background subagent's request is open", async () => {
    turnWithRequest([["agent-1", { is_backgrounded: true }]], "agent-1");
    const client = await promptToIdle(v2Client());

    expect(client.permissionRequests).toHaveLength(1);
    expect(turnTrace(client.sessionUpdates)).toEqual([
      "user_message",
      "running",
      "agent_message_chunk",
      "idle end_turn",
    ]);
  });

  it("keeps the turn running while a background subagent's question is open", async () => {
    scriptTurns(async function* (options) {
      yield taskStarted(options, "agent-1", { is_backgrounded: true });
      yield assistantText(options, "Exploring.");
      await options.canUseTool!(
        "AskUserQuestion",
        {
          questions: [
            {
              question: "Which package?",
              header: "Package",
              options: [
                { label: "core", description: "The core package" },
                { label: "cli", description: "The CLI" },
              ],
              multiSelect: false,
            },
          ],
        },
        {
          signal: new AbortController().signal,
          suggestions: [],
          toolUseID: "toolu_question",
          agentID: "agent-1",
          requestId: randomUUID(),
        } as Parameters<NonNullable<Options["canUseTool"]>>[2],
      ).catch(() => undefined);
      yield result(options);
      yield idleState(options);
    });
    const client = await promptToIdle(v2Client(), { elicitation: { form: {} } });

    expect(client.elicitations).toHaveLength(1);
    expect(turnTrace(client.sessionUpdates)).toEqual([
      "user_message",
      "running",
      "agent_message_chunk",
      "idle end_turn",
    ]);
  });

  it("reports requires_action while a foreground subagent's request is open", async () => {
    turnWithRequest([["agent-1", { is_backgrounded: false }]], "agent-1");
    const client = await promptToIdle(v2Client());

    expect(turnTrace(client.sessionUpdates)).toEqual([
      "user_message",
      "running",
      "agent_message_chunk",
      "requires_action",
      "running",
      "idle end_turn",
    ]);
  });

  it("keeps the turn running for a foreground subagent that a background subagent launched", async () => {
    turnWithRequest(
      [
        ["agent-1", { is_backgrounded: true }],
        ["agent-2", { is_backgrounded: false, parent_task_id: "agent-1" }],
      ],
      "agent-2",
    );
    const client = await promptToIdle(v2Client());

    expect(client.permissionRequests).toHaveLength(1);
    expect(turnTrace(client.sessionUpdates)).toEqual([
      "user_message",
      "running",
      "agent_message_chunk",
      "idle end_turn",
    ]);
  });

  it("waits for a request once its subagent, which asked before its task_started, turns out to run in the foreground", async () => {
    const answer = Promise.withResolvers<v2.RequestPermissionResponse>();
    const client = v2Client({
      answerPermission: () => answer.promise as unknown as v2.RequestPermissionResponse,
    });
    let beforeTaskStarted: string[] = [];
    let atAnswer: string[] = [];
    scriptTurns(async function* (options) {
      yield assistantText(options, "Exploring.");
      // The consumer can read the request before the subagent's task_started.
      const asking = askFor(options, "agent-1");
      await vi.waitFor(() => expect(client.permissionRequests).toHaveLength(1));
      beforeTaskStarted = turnTrace(client.sessionUpdates);
      yield taskStarted(options, "agent-1", { is_backgrounded: false });
      await vi.waitFor(() =>
        expect(turnTrace(client.sessionUpdates).at(-1)).toBe("requires_action"),
      );
      atAnswer = turnTrace(client.sessionUpdates);
      answer.resolve({ outcome: { outcome: "cancelled" } });
      await asking;
      yield result(options);
      yield idleState(options);
    });
    await promptToIdle(client);

    expect(beforeTaskStarted).toEqual(["user_message", "running", "agent_message_chunk"]);
    expect(atAnswer).toEqual(["user_message", "running", "agent_message_chunk", "requires_action"]);
  });

  it("stops waiting for a request once its foreground subagent settles", async () => {
    const answer = Promise.withResolvers<v2.RequestPermissionResponse>();
    const client = v2Client({
      answerPermission: () => answer.promise as unknown as v2.RequestPermissionResponse,
    });
    let atAnswer: string[] = [];
    scriptTurns(async function* (options) {
      yield taskStarted(options, "agent-1", { is_backgrounded: false });
      yield assistantText(options, "Exploring.");
      const asking = askFor(options, "agent-1");
      await vi.waitFor(() =>
        expect(turnTrace(client.sessionUpdates).at(-1)).toBe("requires_action"),
      );
      // Claude Code stops the subagent before the client answers.
      yield {
        type: "system",
        subtype: "task_updated",
        task_id: "agent-1",
        patch: { status: "killed" },
        uuid: randomUUID(),
        session_id: options.sessionId,
      };
      await vi.waitFor(() => expect(turnTrace(client.sessionUpdates).at(-1)).toBe("running"));
      atAnswer = turnTrace(client.sessionUpdates);
      answer.resolve({ outcome: { outcome: "cancelled" } });
      await asking;
      yield result(options);
      yield idleState(options);
    });
    await promptToIdle(client);

    expect(atAnswer).toEqual([
      "user_message",
      "running",
      "agent_message_chunk",
      "requires_action",
      "running",
    ]);
  });

  it("stops waiting for a request once Claude Code moves its subagent to the background", async () => {
    const answer = Promise.withResolvers<v2.RequestPermissionResponse>();
    const client = v2Client({
      answerPermission: () => answer.promise as unknown as v2.RequestPermissionResponse,
    });
    let atAnswer: string[] = [];
    scriptTurns(async function* (options) {
      yield taskStarted(options, "agent-1", { is_backgrounded: false });
      yield assistantText(options, "Exploring.");
      const asking = askFor(options, "agent-1");
      await vi.waitFor(() =>
        expect(turnTrace(client.sessionUpdates).at(-1)).toBe("requires_action"),
      );
      yield {
        type: "system",
        subtype: "task_updated",
        task_id: "agent-1",
        patch: { is_backgrounded: true },
        uuid: randomUUID(),
        session_id: options.sessionId,
      };
      await vi.waitFor(() => expect(turnTrace(client.sessionUpdates).at(-1)).toBe("running"));
      atAnswer = turnTrace(client.sessionUpdates);
      answer.resolve({ outcome: { outcome: "cancelled" } });
      await asking;
      yield result(options);
      yield idleState(options);
    });
    await promptToIdle(client);

    expect(atAnswer).toEqual([
      "user_message",
      "running",
      "agent_message_chunk",
      "requires_action",
      "running",
    ]);
  });

  it("reports no running before idle cancelled for a child's request that a cancel withdraws, and for the turn that waits on it", async () => {
    // Claude Code's interrupt withdraws the request, which the client holds and
    // would not settle, then it stops the child.
    const withdrawal = new AbortController();
    sdk.interrupt = async () => withdrawal.abort();
    const client = v2Client({
      answerPermission: () =>
        new Promise<never>(() => {}) as unknown as v2.RequestPermissionResponse,
    });
    scriptTurns(async function* (options) {
      yield toolUseMessage(options, "toolu_agent-1", "Agent", {
        description: "Explore the project",
        prompt: "Look around",
        subagent_type: "Explore",
      });
      yield taskStarted(options, "agent-1", { is_backgrounded: false });
      await options.canUseTool!("Bash", { command: "ls" }, {
        signal: withdrawal.signal,
        suggestions: [],
        toolUseID: "toolu_ls",
        agentID: "agent-1",
        requestId: randomUUID(),
      } as Parameters<NonNullable<Options["canUseTool"]>>[2]).catch(() => undefined);
      yield {
        type: "system",
        subtype: "task_updated",
        task_id: "agent-1",
        patch: { status: "killed" },
        uuid: randomUUID(),
        session_id: options.sessionId,
      };
      yield result(options, ABORTED_TOOLS);
      yield idleState(options);
    });
    let root = "";
    await client.app.connectWith(connectRouter(), async (agent) => {
      await initializeV2(agent);
      ({ sessionId: root } = await agent.request(v2.methods.agent.session.new, { cwd }));
      await agent.request(v2.methods.agent.session.prompt, { sessionId: root, prompt: text("go") });
      await vi.waitFor(() => expect(client.permissionRequests).toHaveLength(1));
      await agent.notify(v2.methods.agent.session.cancel, { sessionId: root });
      await vi.waitFor(() =>
        expect(
          turnTrace(client.sessionUpdates.filter(({ sessionId }) => sessionId === root)),
        ).toContain("idle cancelled"),
      );
      await client.authUpdate(1);
    });

    expect(client.permissionRequests[0].sessionId).toBe("agent-1");
    // The child's own stream, and the parent's copy of its states.
    expect(
      turnTrace(client.sessionUpdates.filter(({ sessionId }) => sessionId === "agent-1")),
    ).toEqual(["running", "requires_action", "idle cancelled"]);
    // The turn waits on the foreground child, so its request holds the root too.
    expect(turnTrace(client.sessionUpdates.filter(({ sessionId }) => sessionId === root))).toEqual([
      "user_message",
      "running",
      "requires_action",
      "idle cancelled",
    ]);
    expect(
      client.sessionUpdates.flatMap(({ sessionId, update }) => {
        if (sessionId !== root || update.sessionUpdate !== "subagent_update" || !update.state) {
          return [];
        }
        const { state, stopReason } = update.state as { state: string; stopReason?: string };
        return [stopReason ? `${state} ${stopReason}` : state];
      }),
    ).toEqual(["running", "requires_action", "idle cancelled"]);
  });

  it("reports nothing for a background subagent's request that a cancel withdraws", async () => {
    const withdrawal = new AbortController();
    sdk.interrupt = async () => withdrawal.abort();
    const client = v2Client({
      answerPermission: () =>
        new Promise<never>(() => {}) as unknown as v2.RequestPermissionResponse,
    });
    scriptTurns(async function* (options) {
      yield taskStarted(options, "agent-1", { is_backgrounded: true });
      yield assistantText(options, "Exploring.");
      await askFor(options, "agent-1", withdrawal.signal);
      yield result(options, ABORTED_TOOLS);
      yield idleState(options);
    });
    await client.app.connectWith(connectRouter(), async (agent) => {
      await initializeV2(agent);
      const { sessionId } = await agent.request(v2.methods.agent.session.new, { cwd });
      await agent.request(v2.methods.agent.session.prompt, { sessionId, prompt: text("go") });
      await vi.waitFor(() => expect(client.permissionRequests).toHaveLength(1));
      await agent.notify(v2.methods.agent.session.cancel, { sessionId });
      await vi.waitFor(() => expect(turnTrace(client.sessionUpdates)).toContain("idle cancelled"));
      await client.authUpdate(1);
    });

    // The request does not hold the turn, so the cancel changes nothing of the
    // turn's states but its end.
    expect(turnTrace(client.sessionUpdates)).toEqual([
      "user_message",
      "running",
      "agent_message_chunk",
      "idle cancelled",
    ]);
  });

  it("reports no running for a turn's request that a cancel withdraws along with a background subagent's", async () => {
    const withdrawal = new AbortController();
    sdk.interrupt = async () => withdrawal.abort();
    const client = v2Client({
      answerPermission: () =>
        new Promise<never>(() => {}) as unknown as v2.RequestPermissionResponse,
    });
    scriptTurns(async function* (options) {
      yield taskStarted(options, "agent-1", { is_backgrounded: true });
      yield assistantText(options, "Exploring.");
      await Promise.all([
        // The turn's own request, and the subagent's.
        options.canUseTool!("Bash", { command: "make" }, {
          signal: withdrawal.signal,
          suggestions: [],
          toolUseID: "toolu_make",
          requestId: randomUUID(),
        } as Parameters<NonNullable<Options["canUseTool"]>>[2]).catch(() => undefined),
        askFor(options, "agent-1", withdrawal.signal),
      ]);
      yield result(options, ABORTED_TOOLS);
      yield idleState(options);
    });
    await client.app.connectWith(connectRouter(), async (agent) => {
      await initializeV2(agent);
      const { sessionId } = await agent.request(v2.methods.agent.session.new, { cwd });
      await agent.request(v2.methods.agent.session.prompt, { sessionId, prompt: text("go") });
      await vi.waitFor(() => expect(client.permissionRequests).toHaveLength(2));
      await agent.notify(v2.methods.agent.session.cancel, { sessionId });
      await vi.waitFor(() => expect(turnTrace(client.sessionUpdates)).toContain("idle cancelled"));
      await client.authUpdate(1);
    });

    expect(turnTrace(client.sessionUpdates)).toEqual([
      "user_message",
      "running",
      "agent_message_chunk",
      "requires_action",
      "idle cancelled",
    ]);
  });
});

// Claude Code's interrupt withdraws each request that is open: the SDK aborts
// the signal of the request's callback. A client that holds the request does
// not settle it, so the withdrawal alone ends it. The work is being stopped
// then and reports idle next, so it reports no running before that. A
// withdrawal without a cancel is something else answering the request, such as
// a `PermissionRequest` hook, and the work goes on.
describe("ACP v2 requests that a cancel withdraws", () => {
  /** What Claude Code asks of the user, with the signal that it aborts to withdraw the request. */
  type Ask = (options: Options, signal: AbortSignal) => Promise<unknown>;

  const askPermission =
    (toolUseID = "toolu_ls"): Ask =>
    (options, signal) =>
      options.canUseTool!("Bash", { command: "ls" }, {
        signal,
        suggestions: [],
        toolUseID,
        requestId: randomUUID(),
      } as Parameters<NonNullable<Options["canUseTool"]>>[2]);
  const askQuestion: Ask = (options, signal) =>
    options.canUseTool!(
      "AskUserQuestion",
      {
        questions: [
          {
            question: "Which package?",
            header: "Package",
            options: [
              { label: "core", description: "The core package" },
              { label: "cli", description: "The CLI" },
            ],
            multiSelect: false,
          },
        ],
      },
      {
        signal,
        suggestions: [],
        toolUseID: "toolu_question",
        requestId: randomUUID(),
      } as Parameters<NonNullable<Options["canUseTool"]>>[2],
    );
  const askElicitation: Ask = (options, signal) =>
    options.onElicitation!(
      {
        serverName: "linear",
        message: "Which team?",
        mode: "form",
        requestedSchema: { type: "object", properties: { team: { type: "string" } } },
      },
      { signal } as Parameters<NonNullable<Options["onElicitation"]>>[1],
    );
  const askRefusalFallback: Ask = (options, signal) =>
    options.onUserDialog!(
      {
        dialogKind: "refusal_fallback_prompt",
        payload: { originalModel: "claude-fable-5", fallbackModel: "claude-opus-4-8" },
      },
      { signal } as Parameters<NonNullable<Options["onUserDialog"]>>[1],
    );
  /** Every kind of request that holds the work, with the tool use it is for, if any. */
  const ASKS: Array<[string, Ask, string | undefined]> = [
    ["a permission request", askPermission(), "toolu_ls"],
    ["a question", askQuestion, "toolu_question"],
    ["an MCP server's elicitation", askElicitation, undefined],
    ["the refusal fallback's consent prompt", askRefusalFallback, undefined],
  ];

  const hold = () => new Promise<never>(() => {});
  /** A client that holds each request it gets, as one does that ignores `$/cancel_request`. */
  const holdingClient = () =>
    v2Client({
      answerPermission: hold as unknown as () => v2.RequestPermissionResponse,
      answerElicitation: hold,
    });
  const allowOnce: v2.RequestPermissionResponse = {
    outcome: { outcome: "selected", optionId: "allow-once" },
  };
  const toolCallOf = (request: v2.RequestPermissionRequest) =>
    (request.subject as { toolCall?: { toolCallId?: string } }).toolCall?.toolCallId;

  /** Resolves once the turn waits for the user. */
  const awaitsUser = (client: ReturnType<typeof v2Client>) =>
    vi.waitFor(() => expect(turnTrace(client.sessionUpdates).at(-1)).toBe("requires_action"));

  /**
   * Sends the prompt "go", runs `during`, and returns what the client saw of
   * the turn once it is idle.
   */
  async function runTurn(
    client: ReturnType<typeof v2Client>,
    during: (agent: v2.ClientContext, sessionId: string) => Promise<unknown> = async () => {},
  ): Promise<string[]> {
    await client.app.connectWith(connectRouter(), async (agent) => {
      await initializeV2(agent, { elicitation: { form: {} } });
      const { sessionId } = await agent.request(v2.methods.agent.session.new, { cwd });
      await agent.request(v2.methods.agent.session.prompt, { sessionId, prompt: text("go") });
      await during(agent, sessionId);
      await vi.waitFor(() =>
        expect(turnTrace(client.sessionUpdates).some((state) => state.startsWith("idle"))).toBe(
          true,
        ),
      );
      await client.authUpdate(1);
    });
    return turnTrace(client.sessionUpdates);
  }

  it.each(ASKS)(
    "reports no running before idle cancelled for %s that a cancel withdraws",
    async (_, ask) => {
      const withdrawal = new AbortController();
      sdk.interrupt = async () => withdrawal.abort();
      scriptTurns(async function* (options) {
        await ask(options, withdrawal.signal).catch(() => undefined);
        yield result(options, ABORTED_TOOLS);
        yield idleState(options);
      });
      const client = holdingClient();

      const trace = await runTurn(client, async (agent, sessionId) => {
        await awaitsUser(client);
        await agent.notify(v2.methods.agent.session.cancel, { sessionId });
      });

      expect(trace).toEqual(["user_message", "running", "requires_action", "idle cancelled"]);
    },
  );

  it.each(ASKS)(
    "reports no running before idle cancelled for %s that a session/close withdraws",
    async (_, ask) => {
      const withdrawal = new AbortController();
      // The SDK's cleanup of a closed query aborts every request that is open.
      sdk.close = () => withdrawal.abort();
      const closed = Promise.withResolvers<void>();
      scriptTurns(async function* (options) {
        await ask(options, withdrawal.signal).catch(() => undefined);
        // Claude Code sends nothing more once the session is closed.
        await closed.promise;
        yield idleState(options);
      });
      const client = holdingClient();

      let atClose: string[] = [];
      await runTurn(client, async (agent, sessionId) => {
        await awaitsUser(client);
        await agent.request(v2.methods.agent.session.close, { sessionId });
        atClose = turnTrace(client.sessionUpdates);
      });
      closed.resolve();

      expect(atClose).toEqual(["user_message", "running", "requires_action", "idle cancelled"]);
    },
  );

  it.each(ASKS)(
    "reports running when Claude Code withdraws %s without a cancel, since the work goes on",
    async (_, ask, toolUseId) => {
      const withdrawal = new AbortController();
      const client = holdingClient();
      scriptTurns(async function* (options) {
        const asking = ask(options, withdrawal.signal).catch(() => undefined);
        await awaitsUser(client);
        // A hook answers the request in the user's place.
        withdrawal.abort();
        await asking;
        if (toolUseId) yield toolResultMessage(options, toolUseId, {});
        yield assistantText(options, "Done.");
        yield result(options);
        yield idleState(options);
      });

      expect(await runTurn(client)).toEqual([
        "user_message",
        "running",
        "requires_action",
        "running",
        "agent_message_chunk",
        "idle end_turn",
      ]);
    },
  );

  it("reports running when the user answers the request after the cancel", async () => {
    const interrupted = Promise.withResolvers<void>();
    sdk.interrupt = async () => interrupted.resolve();
    const answer = Promise.withResolvers<v2.RequestPermissionResponse>();
    const client = v2Client({
      answerPermission: () => answer.promise as unknown as v2.RequestPermissionResponse,
    });
    scriptTurns(async function* (options) {
      // Claude Code does not withdraw the request.
      const asking = askPermission()(options, new AbortController().signal);
      await interrupted.promise;
      answer.resolve(allowOnce);
      await asking;
      yield result(options, ABORTED_TOOLS);
      yield idleState(options);
    });

    const trace = await runTurn(client, async (agent, sessionId) => {
      await awaitsUser(client);
      await agent.notify(v2.methods.agent.session.cancel, { sessionId });
    });

    expect(trace).toEqual([
      "user_message",
      "running",
      "requires_action",
      "running",
      "idle cancelled",
    ]);
  });

  it("reports running when Claude Code withdraws a request that opened after the cancel", async () => {
    // The cancel came before the request opened, so it did not stop that
    // request's work: a prompt that Claude Code took up after the cancel can ask
    // before the agent has seen its echo.
    const interrupted = Promise.withResolvers<void>();
    sdk.interrupt = async () => interrupted.resolve();
    const withdrawal = new AbortController();
    const client = holdingClient();
    scriptTurns(async function* (options) {
      await interrupted.promise;
      yield toolUseMessage(options, "toolu_ls", "Bash", { command: "ls" });
      const asking = askPermission()(options, withdrawal.signal).catch(() => undefined);
      await awaitsUser(client);
      withdrawal.abort();
      await asking;
      yield result(options, ABORTED_TOOLS);
      yield idleState(options);
    });

    const trace = await runTurn(client, async (agent, sessionId) => {
      await agent.notify(v2.methods.agent.session.cancel, { sessionId });
    });

    expect(trace).toEqual([
      "user_message",
      "running",
      "requires_action",
      "running",
      "idle cancelled",
    ]);
  });

  describe("two requests that are open together", () => {
    // The work reports once, when the last of them ends, by how that one ended.
    const wait = (client: ReturnType<typeof v2Client>) =>
      vi.waitFor(() => expect(client.permissionRequests).toHaveLength(2));

    it("reports no running when a cancel withdraws both", async () => {
      const withdrawal = new AbortController();
      sdk.interrupt = async () => withdrawal.abort();
      const client = holdingClient();
      scriptTurns(async function* (options) {
        await Promise.all(
          [askPermission("toolu_a"), askPermission("toolu_b")].map((ask) =>
            ask(options, withdrawal.signal).catch(() => undefined),
          ),
        );
        yield result(options, ABORTED_TOOLS);
        yield idleState(options);
      });

      const trace = await runTurn(client, async (agent, sessionId) => {
        await wait(client);
        await agent.notify(v2.methods.agent.session.cancel, { sessionId });
      });

      expect(trace).toEqual(["user_message", "running", "requires_action", "idle cancelled"]);
    });

    it("reports running when the user answers the one that the cancel did not withdraw", async () => {
      const withdrawal = new AbortController();
      sdk.interrupt = async () => withdrawal.abort();
      const answer = Promise.withResolvers<v2.RequestPermissionResponse>();
      const client = v2Client({
        answerPermission: (request) =>
          (toolCallOf(request) === "toolu_b"
            ? answer.promise
            : hold()) as unknown as v2.RequestPermissionResponse,
      });
      scriptTurns(async function* (options) {
        const a = askPermission("toolu_a")(options, withdrawal.signal).catch(() => undefined);
        const b = askPermission("toolu_b")(options, new AbortController().signal);
        // The cancel withdraws the first, which ends while the second is open.
        await a;
        answer.resolve(allowOnce);
        await b;
        yield result(options, ABORTED_TOOLS);
        yield idleState(options);
      });

      const trace = await runTurn(client, async (agent, sessionId) => {
        await wait(client);
        await agent.notify(v2.methods.agent.session.cancel, { sessionId });
      });

      expect(trace).toEqual([
        "user_message",
        "running",
        "requires_action",
        "running",
        "idle cancelled",
      ]);
    });

    it("reports no running when a cancel withdraws the one that ends last, after the user answered the other", async () => {
      const withdrawal = new AbortController();
      sdk.interrupt = async () => withdrawal.abort();
      const answer = Promise.withResolvers<v2.RequestPermissionResponse>();
      const client = v2Client({
        answerPermission: (request) =>
          (toolCallOf(request) === "toolu_b"
            ? answer.promise
            : hold()) as unknown as v2.RequestPermissionResponse,
      });
      scriptTurns(async function* (options) {
        const a = askPermission("toolu_a")(options, withdrawal.signal).catch(() => undefined);
        const b = askPermission("toolu_b")(options, new AbortController().signal);
        await b;
        await a;
        yield result(options, ABORTED_TOOLS);
        yield idleState(options);
      });

      const trace = await runTurn(client, async (agent, sessionId) => {
        await wait(client);
        // The first is still open, so the answer changes nothing.
        answer.resolve(allowOnce);
        await vi.waitFor(() => expect(agents[0].sessions[sessionId]?.openUserInputs?.size).toBe(1));
        await agent.notify(v2.methods.agent.session.cancel, { sessionId });
      });

      expect(trace).toEqual(["user_message", "running", "requires_action", "idle cancelled"]);
    });
  });

  it("reports no running before idle cancelled for a request of a cycle that Claude Code started, which a cancel withdraws", async () => {
    const withdrawal = new AbortController();
    sdk.interrupt = async () => withdrawal.abort();
    const client = holdingClient();
    scriptTurns(async function* (options) {
      yield assistantText(options, "Started the build in the background.");
      yield result(options);
      yield idleState(options);
      // The build finished, and Claude Code wakes the model to report it.
      yield assistantText(options, "The build failed.", "msg_followup");
      await askQuestion(options, withdrawal.signal).catch(() => undefined);
      yield result(options, {
        origin: { kind: "task-notification" },
        ...ABORTED_TOOLS,
      });
      yield idleState(options);
    });

    const trace = await runTurn(client, async (agent, sessionId) => {
      await vi.waitFor(() =>
        expect(turnTrace(client.sessionUpdates)).toEqual([
          "user_message",
          "running",
          "agent_message_chunk",
          "idle end_turn",
          "running",
          "agent_message_chunk",
          "requires_action",
        ]),
      );
      await agent.notify(v2.methods.agent.session.cancel, { sessionId });
      await vi.waitFor(() => expect(turnTrace(client.sessionUpdates)).toContain("idle cancelled"));
    });

    expect(trace.slice(4)).toEqual([
      "running",
      "agent_message_chunk",
      "requires_action",
      "idle cancelled",
    ]);
  });
});

// A Bash call that sends its command to the background returns at once, while
// the command runs on, so the command's terminal exits when its task ends.
describe("ACP v2 terminal of a command in the background", () => {
  const bashUse = (options: Options) => ({
    type: "assistant",
    message: {
      id: "msg_bg",
      type: "message",
      role: "assistant",
      model: "claude-sonnet-4-6",
      content: [
        {
          type: "tool_use",
          id: "toolu_bg",
          name: "Bash",
          input: { command: "make test", run_in_background: true },
        },
      ],
      stop_reason: "tool_use",
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    },
    parent_tool_use_id: null,
    uuid: randomUUID(),
    session_id: options.sessionId,
  });
  /** The Bash call's result: the command went on in the background. */
  const backgrounded = (options: Options) => ({
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
    tool_use_result: {
      stdout: "",
      stderr: "",
      interrupted: false,
      isImage: false,
      backgroundTaskId: "bg1",
    },
    parent_tool_use_id: null,
    uuid: randomUUID(),
    session_id: options.sessionId,
  });
  const taskEvent = (options: Options, subtype: string, fields: Record<string, unknown>) => ({
    type: "system",
    subtype,
    task_id: "bg1",
    uuid: randomUUID(),
    session_id: options.sessionId,
    ...fields,
  });
  /** The command's task starts; Claude Code sends this before the Bash result. */
  const taskStarted = (options: Options) =>
    taskEvent(options, "task_started", {
      task_type: "local_bash",
      description: "make test",
      tool_use_id: "toolu_bg",
      is_backgrounded: true,
    });
  /** The command exits with code 3, which Claude Code names only in the summary. */
  const taskEnded = (options: Options) => [
    taskEvent(options, "task_updated", { patch: { status: "failed" } }),
    taskEvent(options, "task_notification", {
      tool_use_id: "toolu_bg",
      status: "failed",
      output_file: "/tmp/tasks/bg1.output",
      summary: 'Background command "make test" failed with exit code 3',
    }),
  ];

  /** The command's terminal updates (`exit` when one carries the exit) and the
   *  session's states, in order. */
  const terminalTrace = (client: ReturnType<typeof v2Client>) =>
    client.sessionUpdates.flatMap(({ update }) =>
      update.sessionUpdate === "terminal_update"
        ? [update.exitStatus ? "exit" : "terminal"]
        : update.sessionUpdate === "state_update"
          ? [
              update.state +
                ("stopReason" in update && update.stopReason ? ` ${update.stopReason}` : ""),
            ]
          : [],
    );

  async function promptUntilIdle(idles: number) {
    const client = v2Client();
    await client.app.connectWith(connectRouter(), async (agent) => {
      await initializeV2(agent);
      const { sessionId } = await agent.request(v2.methods.agent.session.new, { cwd });
      await agent.request(v2.methods.agent.session.prompt, { sessionId, prompt: text("hi") });
      await vi.waitFor(() =>
        expect(
          turnTrace(client.sessionUpdates).filter((state) => state.startsWith("idle")),
        ).toHaveLength(idles),
      );
      await client.authUpdate(1);
    });
    return client;
  }

  it("keeps the terminal running after the Bash call, and ends it when the command's task ends", async () => {
    scriptTurns(async function* (options) {
      yield taskStarted(options);
      yield bashUse(options);
      yield backgrounded(options);
      yield result(options);
      yield idleState(options);
      yield* taskEnded(options);
      yield assistantText(options, "The tests failed.", "msg_followup");
      yield result(options, { origin: { kind: "task-notification" } });
      yield idleState(options);
    });
    const client = await promptUntilIdle(2);

    const trace = terminalTrace(client);
    expect(trace.filter((entry) => entry === "exit")).toHaveLength(1);
    expect(trace.indexOf("exit")).toBeGreaterThan(trace.indexOf("idle end_turn"));
    // Claude Code reports no exit code for a command in the background.
    expect(
      client.updates("terminal_update").find((update) => update.exitStatus)?.exitStatus,
    ).toEqual({});
    expect(
      client
        .updates("tool_call_update")
        .filter((update) => update.toolCallId === "toolu_bg" && update.status)
        .map((update) => update.status),
    ).toEqual(["pending", "completed"]);
  });

  it("ends the terminal at the Bash result when the command's task ended before it", async () => {
    scriptTurns(async function* (options) {
      yield taskStarted(options);
      yield bashUse(options);
      yield* taskEnded(options);
      yield backgrounded(options);
      yield result(options);
      yield idleState(options);
    });
    const client = await promptUntilIdle(1);

    const trace = terminalTrace(client);
    expect(trace.filter((entry) => entry === "exit")).toHaveLength(1);
    expect(trace.indexOf("exit")).toBeLessThan(trace.indexOf("idle end_turn"));
  });
});

describe("ACP v2 session translation", () => {
  it("renames the group id of grouped select options", () => {
    expect(
      v2ConfigOptions([
        {
          id: "model",
          name: "Model",
          type: "select",
          currentValue: "sonnet",
          options: [{ group: "claude", name: "Claude", options: [{ value: "sonnet", name: "S" }] }],
        },
      ]),
    ).toEqual([
      {
        configId: "model",
        name: "Model",
        type: "select",
        currentValue: "sonnet",
        options: [{ groupId: "claude", name: "Claude", options: [{ value: "sonnet", name: "S" }] }],
      },
    ]);
  });

  it("passes systemPrompt to every v1 session lifecycle request", () => {
    const systemPrompt = {
      mode: "override",
      content: [{ type: "text" as const, text: "Be brief.", annotations: { audience: ["_bot"] } }],
    };
    // The audience holds only a role v1 does not know, so it is dropped.
    const v1SystemPrompt = {
      mode: "override",
      content: [{ type: "text", text: "Be brief.", annotations: {} }],
    };
    const cwd = "/work";
    expect(v1NewSessionRequest({ cwd, systemPrompt }).systemPrompt).toEqual(v1SystemPrompt);
    expect(v1ForkSessionRequest({ sessionId: "s", cwd, systemPrompt }).systemPrompt).toEqual(
      v1SystemPrompt,
    );
    expect(
      v1RestoreSessionRequest({ sessionId: "s", cwd, systemPrompt }).request.systemPrompt,
    ).toEqual(v1SystemPrompt);
    expect(
      v1RestoreSessionRequest({ sessionId: "s", cwd, systemPrompt, replayFrom: { type: "start" } })
        .request.systemPrompt,
    ).toEqual(v1SystemPrompt);
  });

  it("rejects a config option value type that v1 cannot express", () => {
    expect(() =>
      v1SetSessionConfigOptionRequest({
        sessionId: "s",
        configId: "c",
        type: "_range",
        value: 3,
      }),
    ).toThrow("Config option values of type _range are not supported");
  });

  it("fails on session updates that it does not translate yet", () => {
    expect(() =>
      v2SessionUpdate({
        sessionUpdate: "subagent_state_update",
        subagentSessionId: "agent_n",
        state: "failed",
      }),
    ).toThrow("does not translate subagent_state_update session updates yet");
  });

  it("passes the subagent updates through, which v1 and v2 share", () => {
    const announcement = {
      sessionUpdate: "subagent_update" as const,
      sessionId: "agent-1",
      title: "Explore",
      description: "Look around",
      state: { state: "running" as const },
    };
    expect(v2SessionUpdate(announcement)).toEqual(announcement);
    const message = {
      sessionUpdate: "session_message" as const,
      messageId: "toolu_agent",
      senderSessionId: "root",
      recipientSessionId: "agent-1",
      content: text("Look around"),
    };
    expect(v2SessionUpdate(message)).toEqual(message);
    const chunk = {
      sessionUpdate: "session_message_chunk" as const,
      messageId: "m",
      content: text("Look")[0],
    };
    expect(v2SessionUpdate(chunk)).toEqual(chunk);
  });

  it("reports a subagent's work state on the child's stream as well", () => {
    const failed = {
      state: "idle" as const,
      stopReason: "error" as const,
      error: { code: -32603, message: "Overloaded" },
    };
    expect(
      v2ChildStateUpdate({ sessionUpdate: "subagent_update", sessionId: "agent-1", state: failed }),
    ).toEqual({ sessionId: "agent-1", update: { sessionUpdate: "state_update", ...failed } });
    // An update of the association that reports no state has no copy.
    expect(
      v2ChildStateUpdate({ sessionUpdate: "subagent_update", sessionId: "agent-1", title: "X" }),
    ).toBeUndefined();
  });

  it("fails on a subagent state that the subagents RFD does not define", () => {
    expect(() =>
      v2SessionUpdate({
        sessionUpdate: "subagent_update",
        sessionId: "agent-1",
        state: { state: "_paused" },
      }),
    ).toThrow("does not translate the subagent state _paused");
    expect(() =>
      v2SessionUpdate({
        sessionUpdate: "subagent_update",
        sessionId: "agent-1",
        state: { state: "idle", stopReason: "_timeout" },
      }),
    ).toThrow("the subagent state idle with the stop reason _timeout");
  });

  it("sends compaction updates as they are, which v1 and v2 share", () => {
    const update = {
      sessionUpdate: "compaction_update" as const,
      compactionId: "c",
      status: "completed",
      summary: text("The summary."),
    };
    expect(v2SessionUpdate(update)).toEqual(update);
    const chunk = {
      sessionUpdate: "compaction_summary_chunk" as const,
      compactionId: "c",
      content: { type: "text" as const, text: "The" },
    };
    expect(v2SessionUpdate(chunk)).toEqual(chunk);
  });

  it("reports the plan of the session as one v2 plan", () => {
    const entries = [{ content: "Test", priority: "high" as const, status: "pending" as const }];
    const meta = { claudeCode: { parentToolUseId: "toolu_agent" } };
    expect(v2SessionUpdate({ sessionUpdate: "plan", entries, _meta: meta })).toEqual({
      sessionUpdate: "plan_update",
      plan: { type: "items", planId: "plan", entries },
      _meta: meta,
    });
  });

  it("passes the agent's plan operations through, which have v2's shape", () => {
    const update = {
      sessionUpdate: "plan_update" as const,
      plan: { type: "markdown" as const, planId: "plan-mode", content: "# Plan" },
    };
    expect(v2SessionUpdate(update)).toEqual(update);
    const removed = { sessionUpdate: "plan_removed" as const, planId: "plan-mode" };
    expect(v2SessionUpdate(removed)).toEqual(removed);
  });

  it("reports a new tool call with an upserting tool_call_update", () => {
    expect(
      v2SessionUpdate({
        sessionUpdate: "tool_call",
        toolCallId: "t",
        title: "Read",
        name: "Read",
        kind: "read",
        status: "pending",
        content: [{ type: "content", content: text("a.ts")[0] }],
        locations: [{ path: "/p/a.ts" }],
      }),
    ).toEqual({
      sessionUpdate: "tool_call_update",
      toolCallId: "t",
      title: "Read",
      name: "Read",
      kind: "read",
      status: "pending",
      content: [{ type: "content", content: text("a.ts")[0] }],
      locations: [{ path: "/p/a.ts" }],
    });
  });

  it("leaves out the null fields of a tool call update, which v2 would clear", () => {
    // In v1, null leaves a tool call field unchanged; in v2 it clears it.
    expect(
      v2SessionUpdate({
        sessionUpdate: "tool_call_update",
        toolCallId: "t",
        status: "completed",
        title: null,
        name: null,
        content: null,
        locations: null,
        rawOutput: null,
        _meta: null,
      }),
    ).toEqual({ sessionUpdate: "tool_call_update", toolCallId: "t", status: "completed" });
    // An empty array still clears, in both.
    expect(
      v2SessionUpdate({ sessionUpdate: "tool_call_update", toolCallId: "t", content: [] }),
    ).toEqual({ sessionUpdate: "tool_call_update", toolCallId: "t", content: [] });
  });

  it("sends the diffs that the agent built for v2 as they are", () => {
    const diff = v2DiffContent("/p/a.ts", "update", [
      { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ["-a", "+b"] },
    ]);
    expect(
      v2SessionUpdate({ sessionUpdate: "tool_call_update", toolCallId: "t", content: [diff] }),
    ).toEqual({ sessionUpdate: "tool_call_update", toolCallId: "t", content: [diff] });
  });

  it("turns the terminal extension of a command into a display terminal", () => {
    const terminals = new V2Terminals();
    const base64 = (text: string) => Buffer.from(text).toString("base64");
    const toolCallId = "toolu_bash";
    // The first report of a streamed tool use names the terminal, without a command yet.
    expect(
      terminals.split("s", {
        sessionUpdate: "tool_call",
        toolCallId,
        title: "Terminal",
        rawInput: {},
        content: [{ type: "terminal", terminalId: "term" }],
        _meta: { claudeCode: { toolName: "Bash" }, terminal_info: { terminal_id: "term" } },
      }),
    ).toEqual({
      terminal: [{ sessionUpdate: "terminal_update", terminalId: "term" }],
      report: {
        sessionUpdate: "tool_call",
        toolCallId,
        title: "Terminal",
        rawInput: {},
        content: [{ type: "terminal", terminalId: "term" }],
        _meta: { claudeCode: { toolName: "Bash" } },
      },
    });
    // The command, once the input carries it, and only once.
    const refinement = {
      sessionUpdate: "tool_call_update" as const,
      toolCallId,
      rawInput: { command: "make" },
    };
    expect(terminals.split("s", refinement).terminal).toEqual([
      { sessionUpdate: "terminal_update", terminalId: "term", command: "make" },
    ]);
    expect(terminals.split("s", refinement).terminal).toEqual([]);
    // A chunk of output, then the output report that carries nothing else.
    expect(
      terminals.split("s", {
        sessionUpdate: "tool_call_update",
        toolCallId,
        _meta: {
          claudeCode: { parentToolUseId: "toolu_agent" },
          terminal_output_delta: { terminal_id: "term", data: "bu" },
        },
      }),
    ).toEqual({
      terminal: [
        { sessionUpdate: "terminal_output_chunk", terminalId: "term", data: base64("bu") },
      ],
      report: undefined,
    });
    // The exit, then the status.
    expect(
      terminals.split("s", {
        sessionUpdate: "tool_call_update",
        toolCallId,
        status: "failed",
        _meta: {
          claudeCode: { toolName: "Bash" },
          terminal_output: { terminal_id: "term", data: "build" },
          terminal_exit: { terminal_id: "term", exit_code: 2, signal: "SIGTERM" },
        },
      }),
    ).toEqual({
      terminal: [
        {
          sessionUpdate: "terminal_update",
          terminalId: "term",
          output: { data: base64("build") },
          exitStatus: { exitCode: 2, signal: "SIGTERM" },
        },
      ],
      report: {
        sessionUpdate: "tool_call_update",
        toolCallId,
        status: "failed",
        _meta: { claudeCode: { toolName: "Bash" } },
      },
    });
    // The command exited: a later report updates no terminal, and a report
    // without the extension's keys passes as it is.
    const hook = {
      sessionUpdate: "tool_call_update" as const,
      toolCallId,
      rawInput: { command: "make all" },
      _meta: { claudeCode: { toolResponse: { stdout: "build" } } },
    };
    expect(terminals.split("s", hook)).toEqual({ terminal: [], report: hook });
  });

  it("leaves an exit code that the agent does not know out of the terminal's exit", () => {
    const terminals = new V2Terminals();
    terminals.split("s", {
      sessionUpdate: "tool_call",
      toolCallId: "toolu_bash",
      title: "Terminal",
      _meta: { terminal_info: { terminal_id: "term" } },
    });
    const { terminal } = terminals.split("s", {
      sessionUpdate: "tool_call_update",
      toolCallId: "toolu_bash",
      status: "failed",
      _meta: { terminal_exit: { terminal_id: "term", exit_code: null, signal: null } },
    });
    expect(terminal).toEqual([
      { sessionUpdate: "terminal_update", terminalId: "term", exitStatus: {} },
    ]);
  });

  it("forgets the terminals of a closed session", () => {
    const terminals = new V2Terminals();
    const named = (sessionId: string) =>
      terminals.split(sessionId, {
        sessionUpdate: "tool_call",
        toolCallId: "toolu_bash",
        title: "Terminal",
        _meta: { terminal_info: { terminal_id: "term" } },
      });
    const commanded = (sessionId: string) =>
      terminals.split(sessionId, {
        sessionUpdate: "tool_call_update",
        toolCallId: "toolu_bash",
        rawInput: { command: "ls" },
      }).terminal;
    named("closed");
    named("open");
    terminals.forget("closed");
    expect(commanded("closed")).toEqual([]);
    expect(commanded("open")).toHaveLength(1);
  });

  describe("the _meta that the client stores for a tool call", () => {
    const report = (_meta?: Record<string, unknown>, fields: Record<string, unknown> = {}) => ({
      toolCallId: "t",
      ...fields,
      ...(_meta ? { _meta } : {}),
    });

    it("gives the tool's name as name, once, and leaves it out of _meta", () => {
      const meta = new V2ToolCallMeta();
      expect(meta.apply("s", report({ claudeCode: { toolName: "memory_recall" } }), true)).toEqual([
        { toolCallId: "t", name: "memory_recall" },
      ]);
      expect(meta.apply("s", report({ claudeCode: { toolName: "Bash" } }), false)).toEqual([
        { toolCallId: "t" },
      ]);
      // A report's own name wins.
      expect(
        meta.apply("s", report({ claudeCode: { toolName: "Bash" } }, { name: "Read" }), true),
      ).toEqual([{ toolCallId: "t", name: "Read" }]);
    });

    it("sends the earlier claudeCode keys again with a key that changes", () => {
      const meta = new V2ToolCallMeta();
      const denial = { toolResponse: { decisionReasonType: "rule" } };
      expect(meta.apply("s", report({ claudeCode: denial }), true)).toEqual([
        report({ claudeCode: denial }),
      ]);
      // The client replaces `claudeCode` whole, so all of it goes again.
      expect(
        meta.apply("s", report({ claudeCode: { nonExecutionKind: "permission-rule" } }), false),
      ).toEqual([report({ claudeCode: { ...denial, nonExecutionKind: "permission-rule" } })]);
    });

    it("sends only the top-level keys that change, each whole", () => {
      const meta = new V2ToolCallMeta();
      meta.apply(
        "s",
        report({ claudeCode: { toolResponse: { elapsedTimeSeconds: 1 } }, flag: { a: 1 } }),
        true,
      );
      expect(
        meta.apply("s", report({ claudeCode: { toolResponse: { status: "ok" } } }), false),
      ).toEqual([report({ claudeCode: { toolResponse: { status: "ok" } } })]);
      expect(meta.apply("s", report({ flag: { b: 2 } }), false)).toEqual([
        report({ flag: { b: 2 } }),
      ]);
    });

    it("removes a key that a v1 report sets to null", () => {
      const meta = new V2ToolCallMeta();
      meta.apply("s", report({ flag: 1, other: 2 }), true);
      expect(meta.apply("s", report({ flag: null }), false)).toEqual([report({ flag: null })]);
      // A key the client does not hold needs no removal.
      expect(meta.apply("s", report({ flag: null }), false)).toEqual([{ toolCallId: "t" }]);
    });

    it("sends no _meta on a report that changes nothing", () => {
      const meta = new V2ToolCallMeta();
      meta.apply("s", report({ claudeCode: { toolName: "Bash", parentToolUseId: "p" } }), true);
      expect(
        meta.apply(
          "s",
          report(
            { claudeCode: { toolName: "Bash", parentToolUseId: "p" } },
            { status: "completed" },
          ),
          false,
        ),
      ).toEqual([{ toolCallId: "t", status: "completed" }]);
    });

    it("gives a permission request's subject the whole _meta, also when it changes nothing", () => {
      const meta = new V2ToolCallMeta();
      meta.apply("s", report({ claudeCode: { toolName: "Bash", parentToolUseId: "p" } }), true);
      expect(meta.subject("s", report({ claudeCode: { toolName: "Bash" } }))).toEqual(
        report({ claudeCode: { parentToolUseId: "p" } }),
      );
      // Its own keys are stored, since the subject updates the tool call.
      meta.subject("s", report({ claudeCode: { mcpServer: { name: "docs" } } }));
      expect(meta.apply("s", report({ claudeCode: { nonExecutionKind: "x" } }), false)).toEqual([
        report({
          claudeCode: { parentToolUseId: "p", mcpServer: { name: "docs" }, nonExecutionKind: "x" },
        }),
      ]);
    });

    it("keeps the tool calls of each session apart, and forgets a closed session's", () => {
      const meta = new V2ToolCallMeta();
      const started = { claudeCode: { parentToolUseId: "p" } };
      meta.apply("closed", report(started), true);
      meta.apply("open", report(started), true);
      meta.forget("closed");
      const failed = report({ claudeCode: { nonExecutionKind: "x" } });
      expect(meta.apply("closed", failed, false)[0]._meta).toEqual(failed._meta);
      expect(meta.apply("open", failed, false)[0]._meta).toEqual({
        claudeCode: { parentToolUseId: "p", nonExecutionKind: "x" },
      });
    });

    it("removes what an earlier tool call with the same id stored, when one starts", () => {
      const meta = new V2ToolCallMeta();
      meta.apply("s", report({ claudeCode: { toolName: "Bash", parentToolUseId: "p" } }), true);
      expect(meta.apply("s", report({ claudeCode: { toolName: "Read" } }), true)).toEqual([
        { toolCallId: "t", name: "Read", _meta: { claudeCode: null } },
      ]);
    });

    it("clears the _meta that the client may hold when a replay starts a tool call", () => {
      const meta = new V2ToolCallMeta();
      const started = report({ claudeCode: { parentToolUseId: "p" } }, { title: "ls" });
      expect(meta.apply("s", started, true, true)).toEqual([
        { toolCallId: "t", title: "ls", _meta: null },
        { toolCallId: "t", _meta: { claudeCode: { parentToolUseId: "p" } } },
      ]);
      // A tool call without `_meta` needs only the clear.
      expect(meta.apply("s", report(undefined, { toolCallId: "u" }), true, true)).toEqual([
        { toolCallId: "u", _meta: null },
      ]);
      // A tool call this connection reported holds what it sent.
      expect(meta.apply("s", report(undefined, { title: "ls" }), true, true)).toEqual([
        { toolCallId: "t", title: "ls", _meta: { claudeCode: null } },
      ]);
    });
  });

  it("fails on a permission request without the title that v2 requires", () => {
    const request = {
      sessionId: "s",
      toolCall: { toolCallId: "t", title: "ls" },
      options: [{ optionId: "allow-once", name: "Yes", kind: "allow_once" as const }],
    };
    expect(() => v2PermissionRequest(request)).toThrow(
      "An ACP v2 permission request needs a title",
    );
    expect(v2PermissionRequest({ ...request, title: "Run ls?" })).toEqual({
      sessionId: "s",
      title: "Run ls?",
      subject: { type: "tool_call", toolCall: { toolCallId: "t", title: "ls" } },
      options: request.options,
    });
  });

  it("reads an unknown permission outcome as cancelled, never as approval", () => {
    expect(v1PermissionResponse({ outcome: { outcome: "_later" } })).toEqual({
      outcome: { outcome: "cancelled" },
    });
    expect(v1PermissionResponse({ outcome: { outcome: "selected", optionId: "o" } })).toEqual({
      outcome: { outcome: "selected", optionId: "o" },
    });
  });

  it("fails on a v1 diff, and passes a display terminal as it is", () => {
    const update = (content: v1.ToolCallContent) =>
      v2SessionUpdate({ sessionUpdate: "tool_call_update", toolCallId: "t", content: [content] });
    // A v1 diff can hold a snippet, without the operation or line numbers.
    expect(() => update({ type: "diff", path: "/p/a.ts", oldText: "a", newText: "b" })).toThrow(
      "An ACP v2 client cannot take a v1 diff",
    );
    expect(update({ type: "terminal", terminalId: "term" })).toMatchObject({
      content: [{ type: "terminal", terminalId: "term" }],
    });
  });

  it("keeps the audience roles of a prompt block that v1 knows", () => {
    const prompt = (audience: string[]) =>
      v1PromptRequest({
        sessionId: "s",
        prompt: [{ type: "text", text: "hi", annotations: { audience, priority: 1 } }],
      }).prompt[0].annotations;
    expect(prompt(["user", "_robot"])).toEqual({ audience: ["user"], priority: 1 });
    // Only unknown roles: no audience, rather than an audience of nobody.
    expect(prompt(["_robot"])).toEqual({ priority: 1 });
    expect(prompt([])).toEqual({ audience: [], priority: 1 });
  });

  it("fails on a message chunk without a messageId, which v2 requires", () => {
    expect(() =>
      v2SessionUpdate({ sessionUpdate: "agent_message_chunk", content: text("hi")[0] }),
    ).toThrow("An ACP v2 agent_message_chunk needs a messageId");
  });
});

describe("ACP v2 providers", () => {
  it("lists, sets, and disables the provider", async () => {
    const { app, authUpdate } = v2Client();
    await app.connectWith(connectRouter(), async (agent) => {
      await initializeV2(agent);
      const list = async () => (await agent.request(v2.methods.agent.providers.list, {})).providers;
      const [native] = await list();
      expect(native).toMatchObject({
        providerId: "main",
        supported: ["anthropic", "bedrock", "vertex"],
        required: false,
      });

      await agent.request(v2.methods.agent.providers.set, {
        providerId: "main",
        apiType: "anthropic",
        baseUrl: "https://gateway.example.com",
      });
      expect((await list())[0].current).toEqual({
        apiType: "anthropic",
        baseUrl: "https://gateway.example.com",
      });
      await expect(
        agent.request(v2.methods.agent.providers.set, {
          providerId: "other",
          apiType: "anthropic",
          baseUrl: "https://gateway.example.com",
        }),
      ).rejects.toMatchObject({ code: -32602 });

      // Disabling restores the native routing.
      await agent.request(v2.methods.agent.providers.disable, { providerId: "main" });
      expect((await list())[0].current).toEqual(native.current);
      await authUpdate(1);
    });
  });
});

describe("ACP v2 auth", () => {
  it("pushes the auth status of the connection after initialize", async () => {
    const { app, authUpdate } = v2Client();
    const update = await app.connectWith(connectRouter(), async (agent) => {
      await agent.request(v2.methods.agent.initialize, {
        protocolVersion: v2.PROTOCOL_VERSION,
        info: V2_CLIENT_INFO,
      });
      return authUpdate(1);
    });

    expect(update.authStatus).toMatchObject({
      kind: "account",
      account: { email: "user@example.com" },
    });
  });

  it("logs in to a gateway with auth/login and out with auth/logout", async () => {
    const { app, authUpdate } = v2Client();
    await app.connectWith(connectRouter(), async (agent) => {
      const response = await agent.request(v2.methods.agent.initialize, {
        protocolVersion: v2.PROTOCOL_VERSION,
        info: V2_CLIENT_INFO,
        capabilities: { auth: { _meta: { gateway: true } } },
      });
      expect(response.authMethods).toContainEqual({
        methodId: "gateway",
        type: "agent",
        name: "Custom model gateway",
        description: "Use a custom gateway to authenticate and access models",
        _meta: { gateway: { protocol: "anthropic" } },
      });
      await authUpdate(1);

      await agent.request(v2.methods.agent.auth.login, {
        methodId: "gateway",
        _meta: { gateway: { baseUrl: "https://gateway.example.com", headers: {} } },
      });
      expect((await authUpdate(2)).authStatus).toMatchObject({
        kind: "gateway",
        detail: "gateway.example.com",
      });

      await agent.request(v2.methods.agent.auth.logout, {});
      expect(execFileSpy).toHaveBeenCalledWith(
        expect.any(String),
        ["auth", "logout"],
        expect.any(Function),
      );
      expect((await authUpdate(3)).authStatus).toMatchObject({ kind: "account" });
    });
  });
});
