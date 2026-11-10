/**
 * The experimental draft ACP v2 surface, driven through the protocol router
 * with the SDK's own v1 and v2 client apps. The v2 client app validates every
 * response, session update, and elicitation it receives against the v2
 * schema, so a malformed v2 message fails the test.
 */
import { randomUUID } from "node:crypto";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as v1 from "@agentclientprotocol/sdk/unstable";
import * as v2 from "@agentclientprotocol/sdk/experimental/v2/unstable";
import {
  forkSession,
  getSessionInfo,
  getSessionMessages,
  type Options,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { AuthStatusUpdateNotification } from "../../auth-status.js";
import { clearContextWindowCache } from "../../context-window.js";
import { v2DiffContent } from "../../diff.js";
import { type AcpProtocols, acpProtocolRouter, acpProtocolsFromEnv } from "../../serve.js";
import { v1PermissionResponse, v2PermissionRequest } from "../../v2/permissions.js";
import { v1PromptRequest } from "../../v2/prompt.js";
import { V2Terminals } from "../../v2/terminal.js";
import { V2ToolCallMeta } from "../../v2/tool-call-meta.js";
import { v2RestartedToolCall } from "../../v2/tool-call.js";
import { v2SessionUpdate } from "../../v2/session-update.js";
import type { AgentHandle } from "../../v2/agent.js";
import {
  v1ForkSessionRequest,
  v1NewSessionRequest,
  v1SetSessionConfigOptionRequest,
  v2ConfigOptions,
} from "../../v2/session-requests.js";
import { startupFailure } from "../helpers.js";
import packageJson from "../../../package.json" with { type: "json" };

const execFileSpy = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return { ...actual, execFile: execFileSpy };
});

/** What the mocked Claude Agent SDK saw and answers. Reset before each test. */
const sdk = vi.hoisted(() => ({
  queryOptions: [] as Options[],
  /**
   * What Claude Code sends, given the prompts it receives (see `scriptTurns`).
   * By default it sends nothing and, like the real CLI, runs until its input
   * ends.
   */
  run: async function* (
    prompts: AsyncIterable<SDKUserMessage>,
    _options: Options,
  ): AsyncGenerator<Record<string, unknown>> {
    const input = prompts[Symbol.asyncIterator]();
    while (!(await input.next()).done);
    yield* [];
  },
  /** Claude Code receives an interrupt, as `cancel()` sends one. */
  interrupt: async (): Promise<void> => {},
  /** Claude Code stops one task, as `cancel()` does for a child session. */
  stopTask: async (_taskId: string): Promise<void> => {},
  /** The query is closed, as `session/close` closes it. */
  close: (): void => {},
  initializationResult: async (): Promise<Record<string, unknown>> => ({
    models: [
      {
        value: "claude-sonnet-4-6",
        displayName: "Claude Sonnet",
        description: "Fast",
        supportsAutoMode: true,
      },
    ],
  }),
  mcpServerStatus: async (): Promise<Array<{ name: string; status: string }>> => [],
  /** Claude Code's agents (`supportedAgents`), with its built-in subagents. */
  supportedAgents: async (): Promise<Array<{ name: string; description: string }>> => [
    { name: "general-purpose", description: "General-purpose agent" },
  ],
  /** The flag settings that the agent applied (`applyFlagSettings`), in order. */
  flagSettings: [] as Array<Record<string, unknown>>,
  /** What `getContextUsage({ detail: "summary" })` answers. */
  contextUsage: async (): Promise<{ totalTokens: number; rawMaxTokens: number }> => ({
    totalTokens: 0,
    rawMaxTokens: 200000,
  }),
  supportedCommands: async (): Promise<
    Array<{ name: string; description: string; argumentHint: string }>
  > => [{ name: "review", description: "Review a change", argumentHint: "<pull request>" }],
  mcpAuthenticate: async (
    _serverName: string,
  ): Promise<{ authUrl?: string; requiresUserAction: boolean; callbackExpected: boolean }> => ({
    requiresUserAction: false,
    callbackExpected: false,
  }),
  /** The query replaces its MCP servers, as a resume of the active session asks. */
  setMcpServers: async (_servers: Record<string, unknown>): Promise<Record<string, unknown>> => ({
    added: [],
    removed: [],
    errors: {},
  }),
  /** The account that the query cached at its start, which `accountInfo()` reads. */
  accountInfo: async (): Promise<Record<string, unknown>> => ({}),
  /** The query switches its model (`setModel`). */
  setModel: async (_model?: string): Promise<void> => {},
  /** Set to serve Remote Control, as a query of a CLI that supports it does. */
  enableRemoteControl: undefined as
    ((enabled: boolean, name?: string) => Promise<{ session_url?: string }>) | undefined,
}));
const sdkDefaults = { ...sdk };

vi.mock("@anthropic-ai/claude-agent-sdk", async () => {
  const actual = await vi.importActual<typeof import("@anthropic-ai/claude-agent-sdk")>(
    "@anthropic-ai/claude-agent-sdk",
  );
  const { makeMockQuery } = await import("../helpers.js");
  return {
    ...actual,
    query: ({ prompt, options }: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => {
      sdk.queryOptions.push(options);
      // The agent reads the query with `next()`, so it is the generator itself.
      const messages = sdk.run(prompt, options);
      const controls = makeMockQuery({
        [Symbol.asyncIterator]: () => messages,
        initializationResult: () => sdk.initializationResult(),
        supportedCommands: () => sdk.supportedCommands(),
        mcpServerStatus: () => sdk.mcpServerStatus(),
        supportedAgents: () => sdk.supportedAgents(),
        applyFlagSettings: async (settings: Record<string, unknown>) => {
          sdk.flagSettings.push(settings);
        },
        getContextUsage: () => sdk.contextUsage(),
        mcpAuthenticate: (serverName: string) => sdk.mcpAuthenticate(serverName),
        interrupt: () => sdk.interrupt(),
        stopTask: (taskId: string) => sdk.stopTask(taskId),
        close: () => sdk.close(),
        accountInfo: () => sdk.accountInfo(),
        setMcpServers: (servers: Record<string, unknown>) => sdk.setMcpServers(servers),
        setModel: (model?: string) => sdk.setModel(model),
        ...(sdk.enableRemoteControl ? { enableRemoteControl: sdk.enableRemoteControl } : {}),
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
    getSessionInfo: vi.fn(async () => undefined),
    forkSession: vi.fn(async () => ({ sessionId: "99999999-8888-4777-8666-555555555555" })),
    deleteSession: vi.fn(async () => {}),
  };
});

vi.mock("../../tools.js", async () => ({
  ...(await vi.importActual<typeof import("../../tools.js")>("../../tools.js")),
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

const agents: AgentHandle[] = [];
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
  Object.assign(sdk, sdkDefaults, { queryOptions: [], flagSettings: [] });
});

afterEach(async () => {
  await Promise.all(agents.splice(0).map((agent) => agent.dispose()));
  execFileSpy.mockReset();
  vi.mocked(getSessionInfo).mockReset();
  vi.unstubAllEnvs();
  await rm(tempDir, { recursive: true, force: true, maxRetries: 10 });
});

/** Connects a fresh router to a client, and returns the client end of the stream. */
function connectRouter(protocols?: AcpProtocols): v2.Stream {
  const toAgent = new TransformStream<v2.AnyMessage, v2.AnyMessage>();
  const toClient = new TransformStream<v2.AnyMessage, v2.AnyMessage>();
  acpProtocolRouter(undefined, (agent) => agents.push(agent), protocols, {
    onV2Agent: (agent) => agents.push(agent),
  }).connect({
    readable: toAgent.readable,
    writable: toClient.writable,
  });
  return { readable: toClient.readable, writable: toAgent.writable };
}

/** The v2 core's session `sessionId` (a `V2Session`), for waits on its internals. */
function v2Session(sessionId: string): any {
  return (agents[0] as unknown as { sessions: Map<string, unknown> }).sessions.get(sessionId);
}

/**
 * Waits until Claude Code has the prompt queued behind the running turn: the
 * core has pushed the prompt and waits for its insertion.
 */
async function waitForQueuedPrompt(sessionId: string): Promise<void> {
  await vi.waitFor(() =>
    expect(
      [...v2Session(sessionId).pending.values()].filter(
        (prompt: { pushed: boolean }) => prompt.pushed,
      ),
    ).toHaveLength(1),
  );
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
  /** The `auth/status_update` notifications. */
  const acpAuthUpdates: v2.AuthStatusUpdateNotification[] = [];
  const sessionUpdates: v2.UpdateSessionNotification[] = [];
  const elicitations: v2.CreateElicitationRequest[] = [];
  const completedElicitations: v2.CompleteElicitationNotification[] = [];
  const permissionRequests: v2.RequestPermissionRequest[] = [];
  /** The methods of the requests that the agent cancelled with `$/cancel_request`. */
  const cancelledRequests: string[] = [];
  // The request's signal also aborts when the connection closes, with another reason.
  const recordCancel = (method: string, signal: AbortSignal) =>
    signal.addEventListener(
      "abort",
      () => {
        if ((signal.reason as { code?: unknown } | undefined)?.code === -32800) {
          cancelledRequests.push(method);
        }
      },
      { once: true },
    );
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
    .onNotification(v2.methods.client.auth.statusUpdate, ({ params }) => {
      acpAuthUpdates.push(params);
    })
    .onNotification(v2.methods.client.session.update, ({ params }) => {
      sessionUpdates.push(params);
    })
    .onRequest(v2.methods.client.elicitation.create, ({ params, signal }) => {
      elicitations.push(params);
      recordCancel(v2.methods.client.elicitation.create, signal);
      return answerElicitation(params);
    })
    .onNotification(v2.methods.client.elicitation.complete, ({ params }) => {
      completedElicitations.push(params);
    })
    .onRequest(v2.methods.client.session.requestPermission, ({ params, signal }) => {
      permissionRequests.push(params);
      recordCancel(v2.methods.client.session.requestPermission, signal);
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
    acpAuthUpdates,
    sessionUpdates,
    updates,
    elicitations,
    completedElicitations,
    permissionRequests,
    cancelledRequests,
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

  it("does not advertise the AIR async tasks and goal extensions to a v2 AIR client", async () => {
    const { app, authUpdate } = v2Client();
    const response = await app.connectWith(connectRouter(), async (agent) => {
      const response = await initializeV2(agent, {
        _meta: { jetbrains: { air: { version: 1, capabilities: [] } } },
      });
      await authUpdate(1);
      return response;
    });

    // The v2 app registers neither `_session/async_task/stop` nor `_session/goal`.
    // The core lists only the AIR extensions that v2 does not cover (see
    // "ACP v2" in docs/air-extensions.md).
    const air = (response._meta as any)?.jetbrains?.air;
    expect(air.capabilities).toEqual(["agentFileChangeReport", "recommendedValue"]);
    expect(air.capabilities).not.toContain("asyncTasks");
    expect(air).not.toHaveProperty("goal");
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
    let response: v2.AnyMessage | undefined;
    while (!response) {
      const { value, done } = await reader.read();
      if (done) break;
      if ("id" in value && value.id === 1) response = value;
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
    type: "command",
    name: "review",
    description: "Review a change",
    input: { type: "text", hint: "<pull request>" },
  },
  {
    type: "command",
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

  it("sends the commands in an update after the response when reading them for it fails", async () => {
    let commandsRead = 0;
    const commands = sdkDefaults.supportedCommands;
    sdk.supportedCommands = async () => {
      // The first read is the response's; the second is the update's.
      if (++commandsRead === 1) throw new Error("control request failed");
      return commands();
    };
    const client = v2Client();
    const response = await client.app.connectWith(connectRouter(), async (agent) => {
      await initializeV2(agent);
      const response = await agent.request(v2.methods.agent.session.new, { cwd });
      await vi.waitFor(() => expect(client.updates("available_commands_update")).toHaveLength(1));
      return response;
    });

    expect(response).not.toHaveProperty("availableCommands");
    expect(client.updates("available_commands_update")).toEqual([
      { sessionUpdate: "available_commands_update", availableCommands: SESSION_COMMANDS },
    ]);
  });

  it("rejects session/new with the reason Claude Code gave for not starting", async () => {
    sdk.initializationResult = async () => {
      throw startupFailure("proxy_invalid", 'Invalid proxy URL in HTTPS_PROXY: "not a url".');
    };
    const { app, authUpdate } = v2Client();
    await app.connectWith(connectRouter(), async (agent) => {
      await initializeV2(agent);
      await expect(agent.request(v2.methods.agent.session.new, { cwd })).rejects.toMatchObject({
        code: -32603,
        message: 'Internal error: Invalid proxy URL in HTTPS_PROXY: "not a url".',
        data: { startupFailureReason: "proxy_invalid" },
      });
      await authUpdate(1);
    });
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

  it("rejects an MCP-over-ACP server, which the agent does not advertise", async () => {
    const { app, authUpdate } = v2Client();
    await app.connectWith(connectRouter(), async (agent) => {
      await initializeV2(agent);
      await expect(
        agent.request(v2.methods.agent.session.new, {
          cwd,
          mcpServers: [{ type: "acp", name: "tools", serverId: "server-1" }],
        }),
      ).rejects.toMatchObject({ code: -32602, data: { type: "acp" } });
      await authUpdate(1);
    });
    expect(sdk.queryOptions).toHaveLength(0);
  });

  it("rejects two MCP servers with the same name in new, resume, and fork", async () => {
    const { app, authUpdate } = v2Client();
    const mcpServers: v2.McpServer[] = [
      { type: "stdio", name: "files", command: "/usr/local/bin/mcp-files" },
      { type: "http", name: "files", url: "https://mcp.example.com/mcp" },
    ];
    const duplicate = { code: -32602, data: { name: "files" } };
    await app.connectWith(connectRouter(), async (agent) => {
      await initializeV2(agent);
      await expect(
        agent.request(v2.methods.agent.session.new, { cwd, mcpServers }),
      ).rejects.toMatchObject(duplicate);
      const { sessionId } = await agent.request(v2.methods.agent.session.new, { cwd });
      await expect(
        agent.request(v2.methods.agent.session.resume, { sessionId, cwd, mcpServers }),
      ).rejects.toMatchObject(duplicate);
      await expect(
        agent.request(v2.methods.agent.session.resume, {
          sessionId,
          cwd,
          mcpServers,
          replayFrom: { type: "start" },
        }),
      ).rejects.toMatchObject(duplicate);
      await expect(
        agent.request(v2.methods.agent.session.fork, { sessionId, cwd, mcpServers }),
      ).rejects.toMatchObject(duplicate);
      await authUpdate(1);
    });
    // Only the session without MCP servers started.
    expect(sdk.queryOptions).toHaveLength(1);
  });

  it.each([
    ["a mode it does not support", { mode: "_custom", content: text("Be brief.") }],
    [
      "content other than text",
      { mode: "append", content: [{ type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" }] },
    ],
  ] as const)(
    "rejects a systemPrompt with %s on resume of the active session and on fork, and copies nothing",
    async (_case, systemPrompt) => {
      const { app, authUpdate } = v2Client();
      const invalid = { code: -32602, data: { systemPrompt: expect.anything() } };
      await app.connectWith(connectRouter(), async (agent) => {
        await initializeV2(agent);
        const { sessionId } = await agent.request(v2.methods.agent.session.new, { cwd });
        vi.mocked(forkSession).mockClear();
        await expect(
          agent.request(v2.methods.agent.session.resume, {
            sessionId,
            cwd,
            systemPrompt: systemPrompt as v2.SystemPrompt,
          }),
        ).rejects.toMatchObject(invalid);
        await expect(
          agent.request(v2.methods.agent.session.fork, {
            sessionId,
            cwd,
            systemPrompt: systemPrompt as v2.SystemPrompt,
          }),
        ).rejects.toMatchObject(invalid);
        await authUpdate(1);
      });
      expect(forkSession).not.toHaveBeenCalled();
      expect(sdk.queryOptions).toHaveLength(1);
    },
  );

  it("restarts the active session with the additional directories that a resume brings", async () => {
    const extra = await mkdtemp(path.join(tempDir, "extra-"));
    const client = v2Client();
    await client.app.connectWith(connectRouter(), async (agent) => {
      await initializeV2(agent);
      const { sessionId } = await agent.request(v2.methods.agent.session.new, { cwd });
      await agent.request(v2.methods.agent.session.resume, {
        sessionId,
        cwd,
        additionalDirectories: [extra],
      });
      await vi.waitFor(() => expect(sdk.queryOptions).toHaveLength(2));
      await client.authUpdate(1);
    });

    expect(sdk.queryOptions[1]).toMatchObject({
      resume: sdk.queryOptions[0].sessionId,
      additionalDirectories: [extra],
    });
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

      // Both cores replay only from the start. Another cursor is rejected,
      // and the session is not resumed without its replay.
      const queries = sdk.queryOptions.length;
      await agent.request(v2.methods.agent.session.close, { sessionId });
      await expect(
        agent.request(v2.methods.agent.session.resume, {
          sessionId,
          cwd,
          replayFrom: { type: "_message", messageId: "m" },
        }),
      ).rejects.toMatchObject({
        code: -32602,
        message: expect.stringContaining("Replaying from a _message cursor is not supported"),
      });
      expect(sdk.queryOptions).toHaveLength(queries);

      await agent.request(v2.methods.agent.session.delete, { sessionId });
      await authUpdate(1);
    });
  });

  it("offers a resumed Fable 5.2 session's model as `fable`, as a new session lists it", async () => {
    // On resume, the CLI lists the transcript's Fable row under its id, with no `fable` row.
    const row = (value: string, resolvedModel: string, displayName: string) => ({
      value,
      resolvedModel,
      displayName,
      description: "",
    });
    sdk.initializationResult = async () => ({
      models: [
        row("default", "claude-opus-5-5", "Default (recommended)"),
        row("claude-fable-5-2", "claude-fable-5-2", "Fable 5.2"),
      ],
    });
    const setModel = vi.fn(sdkDefaults.setModel);
    sdk.setModel = setModel;
    scriptTurns();
    let model: unknown;
    const client = v2Client();
    await client.app.connectWith(connectRouter(), async (agent) => {
      await initializeV2(agent);
      const { sessionId } = await agent.request(v2.methods.agent.session.new, { cwd });
      await agent.request(v2.methods.agent.session.close, { sessionId });
      vi.mocked(getSessionMessages).mockResolvedValueOnce([
        transcriptEntry("assistant", randomUUID(), {
          id: "msg_fable",
          role: "assistant",
          model: "claude-fable-5-2",
          content: [{ type: "text", text: "ok" }],
        }),
      ] as unknown as Awaited<ReturnType<typeof getSessionMessages>>);
      const resumed = await agent.request(v2.methods.agent.session.resume, {
        sessionId,
        cwd,
        replayFrom: { type: "start" },
      });
      model = resumed.configOptions?.find((option) => option.configId === "model");
      await client.authUpdate(1);
    });

    expect(model).toMatchObject({
      currentValue: "fable",
      options: [{ value: "default" }, { value: "fable", name: "Fable 5.2" }],
    });
    expect(setModel).not.toHaveBeenCalled();
  });

  it("keeps the running turn of the active session that a resume gives other MCP servers", async () => {
    const release = Promise.withResolvers<void>();
    scriptTurns(async function* (options) {
      await release.promise;
      yield result(options);
    });
    sdk.setMcpServers = vi.fn(sdkDefaults.setMcpServers);
    const server = (name: string) => ({
      type: "http" as const,
      name,
      url: `https://${name}.dev/mcp`,
    });
    const client = v2Client();
    await client.app.connectWith(connectRouter(), async (agent) => {
      await initializeV2(agent);
      const { sessionId } = await agent.request(v2.methods.agent.session.new, {
        cwd,
        mcpServers: [server("linear")],
      });
      await agent.request(v2.methods.agent.session.prompt, { sessionId, prompt: text("work") });
      await agent.request(v2.methods.agent.session.resume, {
        sessionId,
        cwd,
        mcpServers: [server("github")],
      });
      release.resolve();
      await vi.waitFor(() => expect(turnTrace(client.sessionUpdates).at(-1)).toMatch(/^idle/));
      await client.authUpdate(1);
    });

    // v2 asks that ongoing work continue.
    expect(sdk.queryOptions).toHaveLength(1);
    expect(sdk.setMcpServers).toHaveBeenCalledExactlyOnceWith({
      github: expect.objectContaining({ type: "http", url: "https://github.dev/mcp" }),
    });
    expect(turnTrace(client.sessionUpdates).at(-1)).toBe("idle end_turn");
  });

  it("resumes an unavailable mode using the configured mode in the v2 response", async () => {
    const project = path.join(tempDir, "claude", "projects", "-project");
    await mkdir(project, { recursive: true });
    await writeFile(
      path.join(tempDir, "claude", "settings.json"),
      JSON.stringify({ permissions: { defaultMode: "plan" } }),
    );
    const sessionId = randomUUID();
    await writeFile(
      path.join(project, `${sessionId}.jsonl`),
      JSON.stringify({
        type: "user",
        uuid: randomUUID(),
        parentUuid: null,
        sessionId,
        cwd,
        isSidechain: false,
        origin: { kind: "human" },
        message: { role: "user", content: "hello" },
        permissionMode: "dontAsk",
      }) + "\n",
    );
    const { app, authUpdate } = v2Client();
    await app.connectWith(connectRouter(), async (agent) => {
      await initializeV2(agent);
      const response = await agent.request(v2.methods.agent.session.resume, { sessionId, cwd });
      expect(sdk.queryOptions.at(-1)?.permissionMode).toBe("plan");
      expect(
        response.configOptions?.find((option) => option.configId === "mode")?.currentValue,
      ).toBe("plan");
      await authUpdate(1);
    });
  });

  it("sets a config option with a v2 value and reports modes only as config options", async () => {
    const client = v2Client();
    const { response, updatesBeforeResponse } = await client.app.connectWith(
      connectRouter(),
      async (agent) => {
        await initializeV2(agent);
        const { sessionId } = await agent.request(v2.methods.agent.session.new, { cwd });
        const response = await agent.request(v2.methods.agent.session.setConfigOption, {
          sessionId,
          configId: "mode",
          type: "id",
          value: "plan",
        });
        const updatesBeforeResponse = client.updates("config_option_update");
        await client.authUpdate(1);
        return { response, updatesBeforeResponse };
      },
    );

    expect(response.configOptions[0]).toMatchObject({ configId: "mode", currentValue: "plan" });
    expect(client.updates("current_mode_update")).toEqual([]);
    // The client also gets the change as an update, before the response.
    expect(updatesBeforeResponse).toEqual([
      { sessionUpdate: "config_option_update", configOptions: response.configOptions },
    ]);
  });

  it("sends no config_option_update when setting a config option fails", async () => {
    const client = v2Client();
    await client.app.connectWith(connectRouter(), async (agent) => {
      await initializeV2(agent);
      const { sessionId } = await agent.request(v2.methods.agent.session.new, { cwd });
      await expect(
        agent.request(v2.methods.agent.session.setConfigOption, {
          sessionId,
          configId: "mode",
          type: "id",
          value: "no-such-mode",
        }),
      ).rejects.toThrow();
      await client.authUpdate(1);
    });

    expect(client.updates("config_option_update")).toEqual([]);
  });

  describe("the model's config options", () => {
    /** A model with effort levels, Fast mode and ultracode, and one with none of them. */
    const OPUS = {
      value: "claude-opus-4-8",
      displayName: "Claude Opus",
      description: "Most capable",
      supportsAutoMode: true,
      supportsEffort: true,
      supportedEffortLevels: ["low", "medium", "high", "xhigh"],
      supportsFastMode: true,
    };
    const HAIKU = {
      value: "claude-haiku-4-5",
      displayName: "Claude Haiku",
      description: "Fastest",
      supportsAutoMode: true,
    };

    beforeEach(() => {
      sdk.initializationResult = async () => ({ models: [OPUS, HAIKU] });
      sdk.supportedAgents = async () => [
        { name: "general-purpose", description: "General-purpose agent" },
        { name: "reviewer", description: "Reviews changes" },
      ];
    });

    /** The options of a session, by id: their type and current value. */
    const values = (options: v2.SessionConfigOption[] | null | undefined) =>
      Object.fromEntries(
        (options ?? []).map((option) => [option.configId, [option.type, option.currentValue]]),
      );

    it("offers effort, Fast mode, ultracode and the custom agents, and sets each on Claude Code", async () => {
      const client = v2Client();
      const { created, set } = await client.app.connectWith(connectRouter(), async (agent) => {
        await initializeV2(agent);
        const created = await agent.request(v2.methods.agent.session.new, { cwd });
        const { sessionId } = created;
        const set = [];
        for (const request of [
          { configId: "effort", type: "id", value: "high" },
          { configId: "fast", type: "boolean", value: true },
          { configId: "ultracode", type: "boolean", value: true },
          { configId: "agent", type: "id", value: "reviewer" },
        ] as const) {
          set.push(
            await agent.request(v2.methods.agent.session.setConfigOption, {
              sessionId,
              ...request,
            }),
          );
        }
        await client.authUpdate(1);
        return { created, set };
      });

      // Every v2 client takes boolean options. The built-in subagents are no
      // main-thread agent.
      expect(values(created.configOptions)).toEqual({
        mode: ["select", "auto"],
        model: ["select", "claude-opus-4-8"],
        effort: ["select", "default"],
        fast: ["boolean", false],
        ultracode: ["boolean", false],
        agent: ["select", "default"],
      });
      expect(created.configOptions?.find((option) => option.configId === "agent")).toMatchObject({
        options: [
          { value: "default", name: "Default" },
          { value: "reviewer", name: "reviewer", description: "Reviews changes" },
        ],
      });
      // Each value goes to Claude Code before the option shows it.
      expect(sdk.flagSettings).toEqual([
        { effortLevel: "high" },
        { fastMode: true },
        { ultracode: true },
        { agent: "reviewer" },
      ]);
      expect(values(set.at(-1)!.configOptions)).toMatchObject({
        effort: ["select", "high"],
        fast: ["boolean", true],
        ultracode: ["boolean", true],
        agent: ["select", "reviewer"],
      });
      expect(client.updates("config_option_update")).toHaveLength(4);
    });

    it.each([
      [
        "a select value for a boolean option",
        { configId: "fast", type: "id", value: "on" },
        'Config option fast takes a boolean value, but received: "on"',
      ],
      [
        "a boolean for a select option",
        { configId: "effort", type: "boolean", value: true },
        "Config option effort takes a string value, but received: true",
      ],
      [
        "a level the model does not offer",
        { configId: "effort", type: "id", value: "max" },
        "Invalid value for config option effort: max",
      ],
      // "a" is a substring of "claude": a substring match would pick Opus.
      [
        "a model the session does not offer",
        { configId: "model", type: "id", value: "not-a-model" },
        "Invalid value for config option model: not-a-model",
      ],
      [
        "a mode the session does not offer",
        { configId: "mode", type: "id", value: "not-a-mode" },
        "Invalid value for config option mode: not-a-mode",
      ],
      [
        "an agent the session does not offer",
        { configId: "agent", type: "id", value: "not-an-agent" },
        "Invalid value for config option agent: not-an-agent",
      ],
    ] as const)(
      "rejects %s and leaves the options as they were",
      async (_case, request, message) => {
        const models: Array<string | undefined> = [];
        sdk.setModel = async (model) => {
          models.push(model);
        };
        const client = v2Client();
        const { created, listed } = await client.app.connectWith(connectRouter(), async (agent) => {
          await initializeV2(agent);
          const created = await agent.request(v2.methods.agent.session.new, { cwd });
          const { sessionId } = created;
          await expect(
            agent.request(v2.methods.agent.session.setConfigOption, { sessionId, ...request }),
          ).rejects.toMatchObject({ code: -32602, message: expect.stringContaining(message) });
          // Setting a valid value again returns every option's current value.
          const listed = await agent.request(v2.methods.agent.session.setConfigOption, {
            sessionId,
            configId: "agent",
            type: "id",
            value: "default",
          });
          await client.authUpdate(1);
          return { created, listed };
        });
        expect(sdk.flagSettings).toEqual([{ agent: null }]);
        expect(models).toEqual([]);
        expect(values(listed.configOptions)).toEqual(values(created.configOptions));
      },
    );

    it("rebuilds the options for a model switch, and clears an effort the new model lacks", async () => {
      const client = v2Client();
      const response = await client.app.connectWith(connectRouter(), async (agent) => {
        await initializeV2(agent);
        const { sessionId } = await agent.request(v2.methods.agent.session.new, { cwd });
        await agent.request(v2.methods.agent.session.setConfigOption, {
          sessionId,
          configId: "effort",
          type: "id",
          value: "high",
        });
        const response = await agent.request(v2.methods.agent.session.setConfigOption, {
          sessionId,
          configId: "model",
          type: "id",
          value: "claude-haiku-4-5",
        });
        await client.authUpdate(1);
        return response;
      });

      // Effort, Fast mode and ultracode show only on a model that has them.
      expect(values(response.configOptions)).toEqual({
        mode: ["select", "auto"],
        model: ["select", "claude-haiku-4-5"],
        agent: ["select", "default"],
      });
      // The pin the new model cannot run is cleared in Claude Code too.
      expect(sdk.flagSettings).toEqual([{ effortLevel: "high" }, { effortLevel: null }]);
    });

    it("runs config changes of a session in the order they came", async () => {
      // The model switch takes a while: the effort change waits for it, and
      // then finds no effort option on the new model.
      sdk.setModel = () => new Promise((resolve) => setTimeout(resolve, 20));
      const client = v2Client();
      await client.app.connectWith(connectRouter(), async (agent) => {
        await initializeV2(agent);
        const { sessionId } = await agent.request(v2.methods.agent.session.new, { cwd });
        const model = agent.request(v2.methods.agent.session.setConfigOption, {
          sessionId,
          configId: "model",
          type: "id",
          value: "claude-haiku-4-5",
        });
        const effort = agent.request(v2.methods.agent.session.setConfigOption, {
          sessionId,
          configId: "effort",
          type: "id",
          value: "high",
        });
        await model;
        await expect(effort).rejects.toMatchObject({ code: -32602 });
        await client.authUpdate(1);
      });

      expect(sdk.flagSettings).toEqual([]);
    });

    it("keeps the client's effort, Fast mode, ultracode and agent across a restart of the query", async () => {
      const client = v2Client();
      await client.app.connectWith(connectRouter(), async (agent) => {
        await initializeV2(agent);
        // The effort that the session was created with is no longer the client's choice.
        const { sessionId } = await agent.request(v2.methods.agent.session.new, {
          cwd,
          _meta: { claudeCode: { options: { effort: "high" } } },
        });
        for (const request of [
          { configId: "effort", type: "id", value: "low" },
          { configId: "fast", type: "boolean", value: true },
          { configId: "ultracode", type: "boolean", value: true },
          { configId: "agent", type: "id", value: "reviewer" },
        ] as const) {
          await agent.request(v2.methods.agent.session.setConfigOption, { sessionId, ...request });
        }
        sdk.flagSettings = [];
        await agent.request(v2.methods.agent.providers.set, {
          providerId: "main",
          apiType: "anthropic",
          baseUrl: "https://gateway.example.com",
        });
        await vi.waitFor(() =>
          // The gateway lists no models, so the model option is gone.
          expect(values(client.updates("config_option_update").at(-1)?.configOptions)).toEqual({
            mode: ["select", "auto"],
            effort: ["select", "low"],
            fast: ["boolean", true],
            ultracode: ["boolean", true],
            agent: ["select", "reviewer"],
          }),
        );
        await client.authUpdate(1);
      });

      expect(sdk.queryOptions).toHaveLength(2);
      expect(sdk.queryOptions[1].effort).toBeUndefined();
      expect(sdk.flagSettings).toEqual([
        { ultracode: true },
        { fastMode: true },
        { effortLevel: "low", ultracode: true },
        { agent: "reviewer" },
      ]);
    });

    it("turns Fast mode off with a notice when Claude Code reports it off", async () => {
      sdk.initializationResult = async () => ({ models: [OPUS], fast_mode_state: "on" });
      scriptTurns(async function* (options) {
        yield assistantText(options, "Done.");
        yield result(options, {
          fast_mode_state: "off",
          fast_mode_disabled_reason: "extra_usage_disabled",
        });
        yield idleState(options);
      });
      const client = v2Client();
      const created = await client.app.connectWith(connectRouter(), async (agent) => {
        await initializeV2(agent);
        const created = await agent.request(v2.methods.agent.session.new, { cwd });
        await agent.request(v2.methods.agent.session.prompt, {
          sessionId: created.sessionId,
          prompt: text("hi"),
        });
        await vi.waitFor(() => expect(turnTrace(client.sessionUpdates)).toContain("idle end_turn"));
        await client.authUpdate(1);
        return created;
      });

      expect(values(created.configOptions).fast).toEqual(["boolean", true]);
      expect(client.updates("notice")).toEqual([
        {
          sessionUpdate: "notice",
          severity: "warning",
          title: "Fast mode turned off",
          description: "Requires extra usage to be enabled for this account.",
        },
      ]);
      const [update] = client.updates("config_option_update");
      expect(update.configOptions.find((option) => option.configId === "fast")).toMatchObject({
        currentValue: false,
        description:
          "Faster responses on supported models — requires extra usage to be enabled for this account",
      });
    });

    it("reports a refusal fallback with a notice and follows the model it swapped to", async () => {
      sdk.initializationResult = async () => ({ models: [OPUS, HAIKU] });
      scriptTurns(async function* (options) {
        yield {
          type: "system",
          subtype: "model_refusal_fallback",
          trigger: "refusal",
          direction: "retry",
          scope: "session",
          original_model: "claude-opus-4-8",
          fallback_model: "claude-haiku-4-5",
          request_id: "req_1",
          api_refusal_category: "cyber",
          content: "banner",
          uuid: randomUUID(),
          session_id: options.sessionId,
        };
        yield assistantText(options, "Done.");
        yield result(options);
        yield idleState(options);
      });
      const client = v2Client();
      await client.app.connectWith(connectRouter(), async (agent) => {
        await initializeV2(agent);
        const { sessionId } = await agent.request(v2.methods.agent.session.new, { cwd });
        await agent.request(v2.methods.agent.session.prompt, { sessionId, prompt: text("hi") });
        await vi.waitFor(() => expect(turnTrace(client.sessionUpdates)).toContain("idle end_turn"));
        await client.authUpdate(1);
      });

      expect(client.updates("notice")).toEqual([
        {
          sessionUpdate: "notice",
          severity: "warning",
          title:
            "claude-opus-4-8 declined this request (cyber); retried with claude-haiku-4-5. The session will continue on claude-haiku-4-5.",
        },
      ]);
      const [update] = client.updates("config_option_update");
      expect(values(update.configOptions)).toEqual({
        mode: ["select", "auto"],
        model: ["select", "claude-haiku-4-5"],
        agent: ["select", "default"],
      });
    });
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

  it.each([
    ["renders URL elicitations, which the sign-in uses", { elicitation: { url: {} } }, []],
    ["renders no URL elicitations", {}, ['MCP server "linear" needs authentication']],
  ])(
    "reports an MCP server that needs a sign-in as a notice only when the client %s",
    async (_case, capabilities, notices) => {
      scriptTurns(async function* (options) {
        yield {
          type: "system",
          subtype: "init",
          mcp_servers: [{ name: "linear", status: "needs-auth" }],
          session_id: options.sessionId,
          uuid: randomUUID(),
        };
        yield assistantText(options, "Done.");
        yield result(options);
        yield idleState(options);
      });
      const client = v2Client();
      await client.app.connectWith(connectRouter(), async (agent) => {
        await initializeV2(agent, capabilities);
        const { sessionId } = await agent.request(v2.methods.agent.session.new, {
          cwd,
          mcpServers: [{ type: "http", name: "linear", url: "https://mcp.linear.app/mcp" }],
        });
        await agent.request(v2.methods.agent.session.prompt, { sessionId, prompt: text("hi") });
        await vi.waitFor(() => expect(turnTrace(client.sessionUpdates)).toContain("idle end_turn"));
        await client.authUpdate(1);
      });

      expect(client.updates("notice").map((notice) => notice.title)).toEqual(notices);
    },
  );

  it("sends the URL elicitation of MCP OAuth only after the session/new response", async () => {
    sdk.mcpServerStatus = async () => [{ name: "linear", status: "needs-auth" }];
    sdk.mcpAuthenticate = async () => ({
      authUrl: "https://example.com/oauth/authorize",
      requiresUserAction: true,
      callbackExpected: true,
    });
    // Reading the commands for the response takes longer than starting OAuth.
    const commands = sdkDefaults.supportedCommands;
    sdk.supportedCommands = async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return commands();
    };
    const events: string[] = [];
    const client = v2Client({
      answerElicitation: () => {
        events.push("elicitation");
        return { action: "decline" };
      },
    });
    await client.app.connectWith(connectRouter(), async (agent) => {
      await initializeV2(agent, { elicitation: { url: {} } });
      await agent.request(v2.methods.agent.session.new, {
        cwd,
        mcpServers: [{ type: "http", name: "linear", url: "https://mcp.linear.app/mcp" }],
      });
      events.push("response");
      await vi.waitFor(() => expect(events).toContain("elicitation"));
    });

    expect(events).toEqual(["response", "elicitation"]);
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

/** A record of a Claude Code transcript file, as Claude Code writes it. */
function transcriptRecord(
  sessionId: string,
  uuid: string,
  parentUuid: string | null,
  message: { role: string } & Record<string, unknown>,
  fields: Record<string, unknown> = {},
) {
  return {
    type: message.role,
    uuid,
    parentUuid,
    sessionId,
    cwd,
    version: "2.0.0",
    isSidechain: false,
    userType: "external",
    timestamp: "2026-09-24T00:00:00.000Z",
    message,
    ...fields,
  };
}

/**
 * Writes the history that Claude Code keeps of a session: its transcript
 * (`root`), and the subagent `agentId`'s own transcript (`records`) beside
 * it, with the metadata file that names the subagent's launch (`meta`).
 */
async function writeSubagentHistory(
  sessionId: string,
  root: Array<Record<string, unknown>>,
  agentId: string,
  meta: Record<string, unknown>,
  records: Array<Record<string, unknown>>,
) {
  const project = path.join(tempDir, "claude", "projects", "-project");
  const subagents = path.join(project, sessionId, "subagents");
  await mkdir(subagents, { recursive: true });
  const lines = (entries: Array<Record<string, unknown>>) =>
    entries.map((entry) => JSON.stringify(entry) + "\n").join("");
  await writeFile(path.join(project, `${sessionId}.jsonl`), lines(root));
  await writeFile(
    path.join(subagents, `agent-${agentId}.jsonl`),
    lines(records.map((record) => ({ ...record, isSidechain: true, agentId }))),
  );
  await writeFile(path.join(subagents, `agent-${agentId}.meta.json`), JSON.stringify(meta));
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

  it("answers an MCP server's elicitation with cancel when the client cannot render it", async () => {
    let answer: unknown;
    scriptTurns(async function* (options) {
      answer = await options.onElicitation!(
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
      yield assistantText(options, "No answer.");
      yield result(options);
    });
    // The client rejects a form it cannot render with -32602.
    const client = v2Client({
      answerElicitation: () => {
        throw v1.RequestError.invalidParams(undefined, "Cannot render this form");
      },
    });
    await client.app.connectWith(connectRouter(), async (agent) => {
      await initializeV2(agent, { elicitation: { form: {} } });
      const { sessionId } = await agent.request(v2.methods.agent.session.new, { cwd });
      await agent.request(v2.methods.agent.session.prompt, { sessionId, prompt: text("hi") });
      await vi.waitFor(() => expect(turnTrace(client.sessionUpdates)).toContain("idle end_turn"));
    });

    expect(client.elicitations).toHaveLength(1);
    // The user never saw the form, so the MCP server is not told they declined.
    expect(answer).toEqual({ action: "cancel" });
  });

  it("answers an MCP server's URL elicitation with cancel when the client supports only forms", async () => {
    let answer: unknown;
    scriptTurns(async function* (options) {
      answer = await options.onElicitation!(
        {
          serverName: "linear",
          message: "Sign in",
          mode: "url",
          url: "https://linear.app/oauth",
          elicitationId: "e1",
        },
        { signal: new AbortController().signal } as Parameters<
          NonNullable<Options["onElicitation"]>
        >[1],
      );
      yield assistantText(options, "No answer.");
      yield result(options);
    });
    const client = v2Client();
    await client.app.connectWith(connectRouter(), async (agent) => {
      await initializeV2(agent, { elicitation: { form: {} } });
      const { sessionId } = await agent.request(v2.methods.agent.session.new, { cwd });
      await agent.request(v2.methods.agent.session.prompt, { sessionId, prompt: text("hi") });
      await vi.waitFor(() => expect(turnTrace(client.sessionUpdates)).toContain("idle end_turn"));
    });

    expect(client.elicitations).toHaveLength(0);
    expect(answer).toEqual({ action: "cancel" });
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
      for (const toolUseID of ["toolu_allow", "toolu_reject", "toolu_dismissed", "toolu_custom"]) {
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
      // Without a session/cancel, `cancelled` means that the user dismissed
      // the prompt or the client declined it by policy.
      { outcome: { outcome: "cancelled" } },
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
    const refused = {
      behavior: "deny",
      message: "User refused permission to run tool",
      decisionClassification: "user_reject",
    };
    expect(decisions).toEqual([
      expect.objectContaining({ behavior: "allow" }),
      expect.objectContaining({ behavior: "deny" }),
      expect.objectContaining({ ...refused, toolUseID: "toolu_dismissed" }),
      expect.objectContaining({ ...refused, toolUseID: "toolu_custom" }),
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
      "requires_action",
      "running",
      "idle end_turn",
    ]);
  });

  it.each(["same", "different"])("forks a promptable session in the %s cwd", async (dir) => {
    const forkId = "99999999-8888-4777-8666-555555555555";
    const forkCwd = dir === "same" ? cwd : await mkdtemp(path.join(tempDir, "fork-"));
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
        cwd: forkCwd,
        mcpServers: [{ type: "http", name: "linear", url: "https://mcp.linear.app/mcp" }],
      });

      expect(fork.sessionId).toBe(forkId);
      expect(fork.configOptions?.map((option) => option.configId)).toContain("mode");
      expect(forkSession).toHaveBeenCalledWith(sessionId);
      // The fork runs as its own Claude Code session, resumed from the copied
      // transcript, with the MCP servers of the fork request.
      const forkQuery = sdk.queryOptions.at(-1)!;
      expect(forkQuery.resume).toBe(forkId);
      expect(forkQuery.cwd).toBe(forkCwd);
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
    // The client may hold the tool call from before the replay, so the replayed
    // start resets what it leaves out.
    expect(client.updates("tool_call_update")[0]).toMatchObject({
      toolCallId: "toolu_w",
      rawOutput: null,
      _meta: null,
    });
  });

  it("replays a subagent's history to its own session, and clears each replayed message there first", async () => {
    // Claude Code keeps its stream open while the session lives.
    scriptTurns();
    const client = v2Client();
    await client.app.connectWith(connectRouter(), async (agent) => {
      await initializeV2(agent);
      const { sessionId } = await agent.request(v2.methods.agent.session.new, { cwd });
      await writeSubagentHistory(
        sessionId,
        [transcriptRecord(sessionId, "r1", null, { role: "user", content: "Explore it" })],
        "abc123",
        { agentType: "Explore", name: "scout", toolUseId: "toolu_agent" },
        [
          transcriptRecord(sessionId, "c1", null, { role: "user", content: "Look around" }),
          transcriptRecord(sessionId, "c2", "c1", {
            id: "msg_child",
            role: "assistant",
            model: "claude-haiku-4-5",
            content: [{ type: "text", text: "Child report." }],
          }),
        ],
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
    // The child's model, from its transcript, goes right after its
    // announcement. It does not go again after the response: it is unchanged.
    const model = expect.objectContaining({
      sessionUpdate: "config_option_update",
      configOptions: [
        expect.objectContaining({ configId: "model", currentValue: "claude-haiku-4-5" }),
      ],
    });
    expect(child).toEqual([
      model,
      expect.objectContaining({ sessionUpdate: "session_message", content: text("Look around") }),
      // The client may still hold the child's message, so the replay clears it.
      { sessionUpdate: "agent_message", messageId: "msg_child", content: [] },
      expect.objectContaining({
        sessionUpdate: "agent_message_chunk",
        messageId: "msg_child",
        content: text("Child report.")[0],
      }),
      { sessionUpdate: "state_update", state: "idle", stopReason: "end_turn", background: [] },
      { sessionUpdate: "response" },
      { sessionUpdate: "state_update", state: "idle", stopReason: "end_turn", background: [] },
    ]);
    // The current state on the parent grants nothing: the child cannot run again here.
    expect(
      client.sessionUpdates.filter(
        ({ update }) =>
          update.sessionUpdate === "subagent_update" && (update as any).capabilities != null,
      ),
    ).toEqual([]);
  });

  it("replays a SendMessage call's delivery, a hand-back and a child's model change as live", async () => {
    scriptTurns();
    const client = v2Client();
    let root = "";
    await client.app.connectWith(connectRouter(), async (agent) => {
      await initializeV2(agent);
      const { sessionId } = await agent.request(v2.methods.agent.session.new, { cwd });
      root = sessionId;
      const response = (uuid: string, parent: string, model: string, content: unknown[]) =>
        transcriptRecord(sessionId, uuid, parent, {
          id: `msg_${uuid}`,
          role: "assistant",
          model,
          content,
        });
      await writeSubagentHistory(
        sessionId,
        [transcriptRecord(sessionId, "r1", null, { role: "user", content: "Explore it" })],
        "abc123",
        { agentType: "Explore", name: "scout", toolUseId: "toolu_agent" },
        [
          transcriptRecord(sessionId, "c1", null, { role: "user", content: "Look around" }),
          response("c2", "c1", "claude-haiku-4-5", [
            {
              type: "tool_use",
              id: "toolu_handback",
              name: "SubagentHandback",
              input: { message: "Found it." },
            },
          ]),
          transcriptRecord(sessionId, "c3", "c2", {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "toolu_handback", content: "Delivered" }],
          }),
          // Claude Code frames a SendMessage call's message for the child's model.
          transcriptRecord(
            sessionId,
            "c4",
            "c3",
            {
              role: "user",
              content:
                "The coordinator sent a message while you were working:\nLook again\n\nAddress this before completing your current task.",
            },
            { isMeta: true, origin: { kind: "coordinator" } },
          ),
          response("c5", "c4", "claude-sonnet-4-6", [{ type: "text", text: "Still fine." }]),
        ],
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
          content: [{ type: "tool_result", tool_use_id: "toolu_agent", content: "Delivered." }],
        }),
        transcriptEntry("assistant", randomUUID(), {
          id: "msg_send",
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "toolu_send",
              name: "SendMessage",
              input: { to: "scout", message: "Look again" },
            },
          ],
        }),
        transcriptEntry("user", randomUUID(), {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "toolu_send", content: "Message sent" }],
        }),
      ] as unknown as Awaited<ReturnType<typeof getSessionMessages>>);
      await agent.request(v2.methods.agent.session.resume, {
        sessionId,
        cwd,
        replayFrom: { type: "start" },
      });
      await client.authUpdate(1);
    });

    const messages = client.sessionUpdates.flatMap(({ sessionId, update }) => {
      if (update.sessionUpdate !== "session_message") return [];
      const name = (id: string | null | undefined) => (id === root ? "root" : id);
      const { messageId, senderSessionId, recipientSessionId } = update as {
        messageId: string;
        senderSessionId?: string;
        recipientSessionId: string;
      };
      return [
        `${name(sessionId)} ${messageId} ${name(senderSessionId)} -> ${name(recipientSessionId)}`,
      ];
    });
    // The hand-back is the child's message to its parent, so the launch's
    // result is no reply. The delivered message replaces its call.
    expect(messages).toEqual([
      "root toolu_agent root -> abc123",
      "abc123 toolu_agent root -> abc123",
      "abc123 toolu_handback abc123 -> root",
      "root toolu_handback abc123 -> root",
      "abc123 toolu_send root -> abc123",
      "root toolu_send root -> abc123",
    ]);
    expect(client.updates("tool_call_update")).toEqual([]);
    // The child's model goes again when a response changes it.
    expect(
      client.sessionUpdates.flatMap(({ sessionId, update }) =>
        sessionId === "abc123" && update.sessionUpdate === "config_option_update"
          ? [(update as { configOptions: Array<{ currentValue: unknown }> }).configOptions[0]!]
          : [],
      ),
    ).toEqual([
      expect.objectContaining({ currentValue: "claude-haiku-4-5" }),
      expect.objectContaining({ currentValue: "claude-sonnet-4-6" }),
    ]);
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
    // An AIR client gets v2's `background` list too.
    expect(atResponse.at(-1)?.update).toEqual({
      sessionUpdate: "state_update",
      state: "idle",
      background: [],
    });
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

  it("removes the checklist and the approved plan on a conversation reset", async () => {
    scriptTurns(
      async function* (options) {
        const todoWrite = assistantText(options, "", "msg_todo");
        todoWrite.message.content = [
          {
            type: "tool_use",
            id: "toolu_todo",
            name: "TodoWrite",
            input: { todos: [{ content: "Do X", status: "pending", activeForm: "Doing X" }] },
          },
        ] as never;
        yield todoWrite;
        yield result(options);
      },
      async function* (options) {
        yield {
          type: "conversation_reset",
          new_conversation_id: randomUUID(),
          uuid: randomUUID(),
          session_id: options.sessionId,
        };
        yield result(options);
      },
    );
    const client = v2Client();
    await client.app.connectWith(connectRouter(), async (agent) => {
      await initializeV2(agent);
      const { sessionId } = await agent.request(v2.methods.agent.session.new, { cwd });
      await agent.request(v2.methods.agent.session.prompt, { sessionId, prompt: text("plan") });
      await agent.request(v2.methods.agent.session.prompt, { sessionId, prompt: text("/clear") });
      await vi.waitFor(() => expect(client.updates("plan_removed")).toHaveLength(2));
      await client.authUpdate(1);
    });

    expect(
      client.sessionUpdates
        .map(({ update }) => update)
        .filter(({ sessionUpdate }) => sessionUpdate.startsWith("plan_")),
    ).toEqual([
      {
        sessionUpdate: "plan_update",
        plan: {
          type: "items",
          planId: "plan",
          entries: [{ content: "Do X", status: "pending", priority: "medium" }],
        },
      },
      { sessionUpdate: "plan_removed", planId: "plan" },
      { sessionUpdate: "plan_removed", planId: "plan-mode" },
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
        { sessionUpdate: "state_update", state: "idle", background: [] },
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
        { sessionUpdate: "state_update", state: "idle", background: [] },
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

  it("sends the current session info after the replay and before the resume response", async () => {
    scriptTurns(async function* (options) {
      yield result(options);
    });
    const client = v2Client();
    await client.app.connectWith(connectRouter(), async (agent) => {
      await initializeV2(agent);
      const { sessionId } = await agent.request(v2.methods.agent.session.new, { cwd });
      await agent.request(v2.methods.agent.session.prompt, { sessionId, prompt: text("hi") });
      await vi.waitFor(() => expect(turnTrace(client.sessionUpdates)).toContain("idle end_turn"));

      vi.mocked(getSessionInfo).mockResolvedValue({
        sessionId,
        summary: "Say hi",
        lastModified: Date.UTC(2026, 9, 2),
      } as Awaited<ReturnType<typeof getSessionInfo>>);
      const info = {
        sessionUpdate: "session_info_update",
        title: "Say hi",
        updatedAt: "2026-10-02T00:00:00.000Z",
      };

      // Without a replay, and again although the client was already sent it.
      for (let i = 0; i < 2; i++) {
        const before = client.sessionUpdates.length;
        await agent.request(v2.methods.agent.session.resume, { sessionId, cwd });
        expect(client.sessionUpdates.slice(before).map(({ update }) => update)).toEqual([
          info,
          { sessionUpdate: "state_update", state: "idle", background: [] },
        ]);
      }

      // With a replay, after the replayed history.
      vi.mocked(getSessionMessages).mockResolvedValueOnce([
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
      expect(client.sessionUpdates.slice(before).map(({ update }) => update.sessionUpdate)).toEqual(
        ["agent_message", "agent_message_chunk", "session_info_update", "state_update"],
      );
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
        { sessionUpdate: "state_update", state: "running", background: [] },
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
      await waitForQueuedPrompt(sessionId);
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
      await waitForQueuedPrompt(sessionId);

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

  it("sends the tail of a text block whose stream was cut short from the consolidated message", async () => {
    scriptTurns(async function* (options) {
      yield stream(options, {
        type: "message_start",
        message: { id: "msg_answer", role: "assistant", content: [], usage: {} },
      });
      yield stream(options, {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      });
      yield stream(options, {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "Here is" },
      });
      // The stream loses the rest of the block, and the consolidated message holds it.
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

    expect(
      client.updates("agent_message_chunk").map((update) => ({
        messageId: update.messageId,
        text: (update.content as { text: string }).text,
      })),
    ).toEqual([
      { messageId: "msg_answer", text: "Here is" },
      { messageId: "msg_answer", text: " the answer." },
    ]);
  });

  it("drops the consolidated messages of the work a cancel stops, except the results of its shown tool calls", async () => {
    const interrupted = Promise.withResolvers<void>();
    sdk.interrupt = async () => interrupted.resolve();
    scriptTurns(async function* (options) {
      yield stream(options, {
        type: "message_start",
        message: { id: "msg_working", role: "assistant", content: [], usage: {} },
      });
      yield stream(options, {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      });
      yield stream(options, {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "Working on" },
      });
      yield stream(options, {
        type: "content_block_start",
        index: 1,
        content_block: { type: "tool_use", id: "toolu_shown", name: "Bash", input: {} },
      });
      await interrupted.promise;
      // What Claude Code had when the interrupt arrived: the consolidated
      // message, with the text's tail and a tool use that never streamed.
      yield {
        ...assistantText(options, "Working on it", "msg_working"),
        message: {
          ...assistantText(options, "", "msg_working").message,
          content: [
            { type: "text", text: "Working on it" },
            { type: "tool_use", id: "toolu_shown", name: "Bash", input: { command: "ls" } },
            { type: "tool_use", id: "toolu_unseen", name: "Bash", input: { command: "pwd" } },
          ],
          stop_reason: "tool_use",
        },
      };
      // The interrupt gives both tools an error result.
      yield {
        type: "user",
        message: {
          role: "user",
          content: ["toolu_shown", "toolu_unseen"].map((id) => ({
            type: "tool_result",
            tool_use_id: id,
            content: "[Request interrupted by user for tool use]",
            is_error: true,
          })),
        },
        parent_tool_use_id: null,
        uuid: randomUUID(),
        session_id: options.sessionId,
      };
      yield result(options, ABORTED_TOOLS);
      yield idleState(options);
    });
    const client = v2Client();
    await client.app.connectWith(connectRouter(), async (agent) => {
      await initializeV2(agent);
      const { sessionId } = await agent.request(v2.methods.agent.session.new, { cwd });
      await agent.request(v2.methods.agent.session.prompt, { sessionId, prompt: text("go") });
      await vi.waitFor(() =>
        expect(client.updates("tool_call_update").map((u) => u.toolCallId)).toContain(
          "toolu_shown",
        ),
      );

      await agent.notify(v2.methods.agent.session.cancel, { sessionId });

      await vi.waitFor(() => expect(turnTrace(client.sessionUpdates)).toContain("idle cancelled"));
      await client.authUpdate(1);
    });

    expect(
      client.updates("agent_message_chunk").map((u) => (u.content as { text: string }).text),
    ).toEqual(["Working on"]);
    const toolCalls = client.updates("tool_call_update");
    expect(toolCalls.some((update) => update.toolCallId === "toolu_unseen")).toBe(false);
    expect(toolCalls.filter((update) => update.toolCallId === "toolu_shown").at(-1)).toMatchObject({
      status: "cancelled",
    });
  });

  it.each([
    ["Claude Code goes idle", false],
    ["the stream dies", true],
  ])(
    "reports zero usage on the idle of a prompt's turn that a cancel stops before its result, when %s",
    async (_, dies) => {
      const interrupted = Promise.withResolvers<void>();
      sdk.interrupt = async () => interrupted.resolve();
      scriptTurns(async function* (options) {
        yield assistantText(options, "Working on it");
        await interrupted.promise;
        // The interrupt stops the turn before its result.
        if (dies) throw new Error("Claude Code process terminated by signal SIGTERM");
        yield idleState(options);
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
          expect(turnTrace(client.sessionUpdates)).toContain("idle cancelled"),
        );
        await client.authUpdate(1);
      });

      const zero = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
      expect(client.updates("state_update").at(-1)).toMatchObject({
        stopReason: "cancelled",
        usage: { ...zero, cachedReadTokens: 0, cachedWriteTokens: 0 },
        _meta: { quota: { token_count: zero, model_usage: [] } },
      });
    },
  );

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
      // The prompt waits while the close runs, for the interrupt of an
      // earlier cancel.
      const guard = Promise.withResolvers<void>();
      const guarded = Promise.withResolvers<void>();
      sdk.interrupt = () => guard.promise;
      await agent.notify(v2.methods.agent.session.cancel, { sessionId });
      guarded.resolve();
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
      // The close ends the work itself: it waits for no consumer.

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

  it.each([
    ["Edit", "workflow-agent"],
    ["Write", undefined],
  ] as const)("does not publish a preview for a hook-only %s", async (name, agentId) => {
    const file = path.join(cwd, "app.ts");
    await writeFile(file, "const value = 1;\n");
    const input =
      name === "Edit"
        ? { file_path: file, old_string: "const value = 1;", new_string: "const value = 2;" }
        : { file_path: file, content: "const value = 2;\n" };
    scriptTurns(async function* (options) {
      // Workflow agents run these hooks without streaming their tool uses
      // or results to the root query.
      await previewToolUse(options, { id: "workflow-edit", name, input, agentId });
      await writeFile(file, "const value = 2;\n");
      yield result(options);
    });
    const client = v2Client();
    await client.app.connectWith(connectRouter(), async (agent) => {
      await initializeV2(agent);
      const { sessionId } = await agent.request(v2.methods.agent.session.new, { cwd });
      await agent.request(v2.methods.agent.session.prompt, { sessionId, prompt: text("hi") });
      await vi.waitFor(() => expect(turnTrace(client.sessionUpdates)).toContain("idle end_turn"));
    });

    expect(client.updates("tool_call_update")).toEqual([]);
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
        const preToolUse = () => previewToolUse(options, { id: "toolu_edit", name: "Edit", input });
        if (hookFirst) await preToolUse();
        yield stream(options, {
          type: "message_start",
          message: { id: "msg_edit", role: "assistant", content: [], usage: {} },
        });
        yield stream(options, {
          type: "content_block_start",
          index: 0,
          content_block: { type: "tool_use", id: "toolu_edit", name: "Edit", input: {} },
        });
        if (!hookFirst) await preToolUse();
        yield toolUse;
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
      // The command ends in the child's session, before the child's idle: v2
      // asks for the updates after a cancel before the idle that reports it.
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
      expect(lastStatusAt(updates, "toolu_child")).toBeLessThan(childIdle);
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
      background: [],
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

  describe("the context window before the first result", () => {
    afterEach(() => clearContextWindowCache());

    /** The `size` of each `usage_update` of a session's first turn. */
    async function firstTurnSizes(
      modelUsage: Record<string, unknown> = {},
    ): Promise<Array<number | undefined>> {
      scriptTurns(async function* (options) {
        yield assistantText(options, "Done.");
        yield result(options, { modelUsage });
        yield idleState(options);
      });
      const client = v2Client();
      await client.app.connectWith(connectRouter(), async (agent) => {
        await initializeV2(agent);
        const { sessionId } = await agent.request(v2.methods.agent.session.new, { cwd });
        await agent.request(v2.methods.agent.session.prompt, { sessionId, prompt: text("hi") });
        await vi.waitFor(() => expect(turnTrace(client.sessionUpdates)).toContain("idle end_turn"));
        await client.authUpdate(1);
      });
      return client.updates("usage_update").map((update) => update.size);
    }

    it("reports the window that Claude Code reads for the model", async () => {
      sdk.contextUsage = async () => ({ totalTokens: 0, rawMaxTokens: 1_000_000 });
      expect(await firstTurnSizes()).toEqual([1_000_000]);
    });

    it("reports a window that another session's result reported for the model", async () => {
      // The first session learns the window from its result.
      expect(
        await firstTurnSizes({
          "claude-sonnet-4-6": {
            inputTokens: 3,
            outputTokens: 2,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
            webSearchRequests: 0,
            costUSD: 0,
            contextWindow: 500_000,
            maxOutputTokens: 32_000,
          },
        }),
      ).toEqual([500_000]);
      // The second session cannot read its window from Claude Code.
      sdk.contextUsage = () => Promise.reject(new Error("Unsupported control request"));
      expect(await firstTurnSizes()).toEqual([500_000]);
    });
  });

  it("clears the Task plan when Claude Code starts a fresh conversation", async () => {
    scriptTurns(
      async function* (options) {
        yield toolUseMessage(options, "toolu_task", "TaskCreate", {
          subject: "Run tests",
          description: "Run the test suite",
        });
        yield {
          ...toolResultMessage(options, "toolu_task", {}),
          tool_use_result: { task: { id: "1", subject: "Run tests" } },
        };
        yield result(options);
        yield idleState(options);
      },
      async function* (options) {
        yield {
          type: "conversation_reset",
          new_conversation_id: randomUUID(),
          uuid: randomUUID(),
          trigger: "clear",
          timestamp: new Date().toISOString(),
          session_id: options.sessionId,
        };
        yield result(options, { num_turns: 0 });
        yield idleState(options);
      },
    );
    const client = v2Client();
    await client.app.connectWith(connectRouter(), async (agent) => {
      await initializeV2(agent);
      const { sessionId } = await agent.request(v2.methods.agent.session.new, { cwd });
      await agent.request(v2.methods.agent.session.prompt, { sessionId, prompt: text("plan") });
      await vi.waitFor(() => expect(turnTrace(client.sessionUpdates)).toContain("idle end_turn"));
      await agent.request(v2.methods.agent.session.prompt, { sessionId, prompt: text("/clear") });
      await vi.waitFor(() =>
        expect(turnTrace(client.sessionUpdates).filter((e) => e === "idle end_turn")).toHaveLength(
          2,
        ),
      );
      await client.authUpdate(1);
    });

    expect(client.updates("plan_update").at(-1)).toEqual({
      sessionUpdate: "plan_update",
      plan: {
        type: "items",
        planId: "plan",
        entries: [{ content: "Run tests", status: "pending", priority: "medium" }],
      },
    });
    expect(client.updates("plan_removed")).toEqual([
      { sessionUpdate: "plan_removed", planId: "plan" },
      { sessionUpdate: "plan_removed", planId: "plan-mode" },
    ]);
  });

  it.each([
    ["a model with Auto", true, "auto"],
    // Auto runs as its fallback, with no notice: the answer chose the mode.
    ["a model without Auto", false, "acceptEdits"],
  ])(
    "carries out a plan accepted with clearing the context in a fresh context, in the same turn, on %s",
    async (_case, supportsAutoMode, mode) => {
      sdk.initializationResult = async () => ({
        models: [
          {
            value: "claude-sonnet-4-6",
            displayName: "Claude Sonnet",
            description: "Fast",
            supportsAutoMode,
          },
        ],
      });
      /**
       * Claude Code, as the bundled CLI answers each prompt: the client's
       * prompt plans and calls ExitPlanMode, `/clear` mounts a fresh
       * conversation, and the plan's prompt carries it out. Each echo carries
       * the prompt's `origin`, as the bundled CLI's does.
       */
      const prompts: string[] = [];
      sdk.run = async function* (input, options) {
        for await (const prompt of input) {
          const content = prompt.message.content;
          const promptText =
            typeof content === "string"
              ? content
              : content.map((block) => (block.type === "text" ? block.text : "")).join("");
          prompts.push(promptText);
          yield {
            type: "user",
            message: prompt.message,
            parent_tool_use_id: null,
            uuid: prompt.uuid,
            session_id: options.sessionId,
            isReplay: true,
            origin: prompt.origin,
          };
          if (promptText === "/clear") {
            yield {
              type: "conversation_reset",
              new_conversation_id: randomUUID(),
              uuid: randomUUID(),
              trigger: "clear",
              user_message_uuid: prompt.uuid,
              timestamp: new Date().toISOString(),
              session_id: options.sessionId,
            };
            yield result(options, {
              num_turns: 0,
              stop_reason: null,
              usage: {
                input_tokens: 0,
                output_tokens: 0,
                cache_read_input_tokens: 0,
                cache_creation_input_tokens: 0,
              },
            });
            yield idleState(options);
          } else if (promptText.startsWith("Implement the following plan")) {
            yield assistantText(options, "Implemented.", "msg_implemented");
            yield result(options, { stop_reason: "max_tokens" });
            yield idleState(options);
          } else {
            yield toolUseMessage(options, "toolu_plan", "ExitPlanMode", { plan: "Implement it" });
            const decision = await options.canUseTool!("ExitPlanMode", { plan: "Implement it" }, {
              signal: new AbortController().signal,
              toolUseID: "toolu_plan",
              suggestions: [],
            } as unknown as Parameters<NonNullable<Options["canUseTool"]>>[2]);
            expect(decision).toMatchObject({ behavior: "deny", interrupt: true });
            yield {
              ...toolResultMessage(options, "toolu_plan", {
                content: "User accepted the plan and requested a fresh context",
                is_error: true,
              }),
              tool_result_meta: [{ id: "toolu_plan", non_execution_kind: "user-rejected" }],
            };
            yield result(options, {
              subtype: "error_during_execution",
              is_error: true,
              stop_reason: null,
              errors: [
                "[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=tool_use",
              ],
            });
            yield idleState(options);
          }
        }
      };
      const client = v2Client({
        answerPermission: () => ({
          outcome: { outcome: "selected", optionId: "exit-plan-clear-auto" },
        }),
      });
      await client.app.connectWith(connectRouter(), async (agent) => {
        await initializeV2(agent);
        const { sessionId } = await agent.request(v2.methods.agent.session.new, { cwd });
        await agent.request(v2.methods.agent.session.prompt, { sessionId, prompt: text("plan") });
        await vi.waitFor(() =>
          expect(turnTrace(client.sessionUpdates)).toContain("idle max_tokens"),
        );
        await client.authUpdate(1);
      });

      // The option says how much of the context is in use.
      expect(client.permissionRequests[0].options).toContainEqual({
        optionId: "exit-plan-clear-auto",
        name: "Yes, clear context (0% used) and use auto mode",
        kind: "allow_always",
      });
      expect(prompts.at(-1)).toBe("Implement the following plan:\n\nImplement it");
      // One turn: the adapter's prompts show no user message, and the turn ends with its result.
      expect(client.updates("user_message_chunk")).toEqual([]);
      expect(turnTrace(client.sessionUpdates)).toEqual([
        "user_message",
        "running",
        "requires_action",
        "running",
        "agent_message_chunk",
        "idle max_tokens",
      ]);
      // The accepted plan's tool call completes, and the fresh context starts empty.
      expect(client.updates("tool_call_update").at(-1)).toMatchObject({
        toolCallId: "toolu_plan",
        status: "completed",
      });
      expect(client.updates("usage_update").map(({ used }) => used)).toContain(0);
      expect(client.updates("plan_update").at(-1)).toEqual({
        sessionUpdate: "plan_update",
        plan: { type: "markdown", planId: "plan-mode", content: "Implement it" },
      });
      expect(
        client
          .updates("config_option_update")
          .at(-1)
          ?.configOptions.find((option) => option.configId === "mode")?.currentValue,
      ).toBe(mode);
    },
  );
});

describe("ACP v2 idle compaction", () => {
  /** A main-thread request that wrote 250k tokens to the one-hour cache. */
  const largeOneHourRequest = (options: Options) => ({
    ...assistantText(options, "Done."),
    message: {
      ...assistantText(options, "Done.").message,
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        cache_creation_input_tokens: 250_000,
        cache_creation: { ephemeral_1h_input_tokens: 250_000, ephemeral_5m_input_tokens: 0 },
      },
    },
  });

  /** The session is idle for 54 minutes after a large one-hour request, and the adapter's `/compact` runs. */
  it("reports the compaction that the adapter starts as running, then idle, with no user_message", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      const received: string[] = [];
      sdk.run = async function* (prompts, options) {
        const input = prompts[Symbol.asyncIterator]();
        for (;;) {
          const { value, done } = await input.next();
          if (done) return;
          received.push((value.message.content as Array<{ text: string }>)[0].text);
          if (received.length === 1) {
            yield {
              type: "user",
              message: value.message,
              parent_tool_use_id: null,
              uuid: value.uuid,
              session_id: options.sessionId,
              isReplay: true,
            };
            yield largeOneHourRequest(options);
          } else {
            yield { type: "system", subtype: "status", status: "compacting", uuid: randomUUID() };
          }
          yield result(options);
          yield idleState(options);
        }
      };
      const client = v2Client();
      await client.app.connectWith(connectRouter(), async (agent) => {
        await initializeV2(agent);
        const { sessionId } = await agent.request(v2.methods.agent.session.new, { cwd });
        await agent.request(v2.methods.agent.session.prompt, { sessionId, prompt: text("hi") });
        await vi.advanceTimersByTimeAsync(0);
        await vi.advanceTimersByTimeAsync(54 * 60_000);
        for (let i = 0; i < 20 && received.length < 2; i++) await vi.advanceTimersByTimeAsync(0);
        for (let i = 0; i < 20 && turnTrace(client.sessionUpdates).length < 6; i++) {
          await vi.advanceTimersByTimeAsync(0);
        }
        await client.authUpdate(1);
      });

      expect(received).toEqual(["hi", "/compact"]);
      expect(turnTrace(client.sessionUpdates)).toEqual([
        "user_message",
        "running",
        "agent_message_chunk",
        "idle end_turn",
        "running",
        "idle end_turn",
      ]);
    } finally {
      vi.useRealTimers();
    }
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
      // stop. The command ends in the child's session, before the child's
      // idle, as v2 asks of the updates after a cancel.
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
      expect(end).toBeLessThan(lastIdleAt(updates, "agent-1"));
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
      await waitForQueuedPrompt(sessionId);
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
      await previewToolUse(options, { id: "toolu_late", name: "Write", input });
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
      await waitForQueuedPrompt(sessionId);
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
        expect(v2Session(sessionId).stopped.modelRequestSinceResult).toBe(true),
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
      background: [],
    });
  });

  describe("a subagent's session", () => {
    /** Runs the hooks of `event` for a hook input of a subagent, as Claude Code does. */
    async function runHooks(options: Options, event: string, input: Record<string, unknown>) {
      const hooks = (options.hooks ?? {}) as Record<
        string,
        NonNullable<Options["hooks"]>["PreToolUse"]
      >;
      for (const matcher of hooks?.[event] ?? []) {
        for (const hook of matcher.hooks) {
          await hook(
            {
              hook_event_name: event,
              session_id: options.sessionId!,
              transcript_path: "",
              cwd,
              ...input,
            } as never,
            input.tool_use_id as string | undefined,
            { signal: new AbortController().signal },
          );
        }
      }
    }

    /** Claude Code's report of the end of a run of the subagent `taskId`. */
    const taskNotification = (
      options: Options,
      taskId: string,
      fields: Record<string, unknown>,
    ) => ({
      type: "system",
      subtype: "task_notification",
      task_id: taskId,
      tool_use_id: `toolu_${taskId}`,
      status: "completed",
      summary: "Done",
      output_file: "",
      uuid: randomUUID(),
      session_id: options.sessionId,
      ...fields,
    });

    /** A message of the subagent that the Agent call `parent` launched. */
    const childMessage = (options: Options, message: Record<string, unknown>, parent: string) => ({
      ...message,
      parent_tool_use_id: parent,
    });

    /** The session messages, as `<session> <messageId> <sender> -> <recipient> <text>`. */
    const sessionMessages = (client: ReturnType<typeof v2Client>, root: string) =>
      client.sessionUpdates.flatMap(({ sessionId, update }) => {
        if (update.sessionUpdate !== "session_message") return [];
        const name = (id: string | null | undefined) => (id === root ? "root" : id);
        const { messageId, senderSessionId, recipientSessionId, content } = update as {
          messageId: string;
          senderSessionId?: string;
          recipientSessionId: string;
          content: Array<{ text: string }>;
        };
        return [
          `${name(sessionId)} ${messageId} ${name(senderSessionId)} -> ${name(recipientSessionId)} ${content[0]?.text}`,
        ];
      });

    /** The tool calls the client was shown, by id. */
    const shownToolCalls = (client: ReturnType<typeof v2Client>) => [
      ...new Set(
        client.sessionUpdates.flatMap(({ update }) =>
          update.sessionUpdate === "tool_call_update"
            ? [(update as { toolCallId: string }).toolCallId]
            : [],
        ),
      ),
    ];

    it("reports the mode, effort and agent type of a subagent's hooks, with its model, as its configuration", async () => {
      scriptTurns(async function* (options) {
        yield toolUseMessage(options, "toolu_agent-1", "Agent", {
          description: "Explore the project",
          prompt: "Look around",
          subagent_type: "Explore",
        });
        yield taskStarted(options, "agent-1", { prompt: "Look around" });
        await runHooks(options, "PostToolUse", {
          agent_id: "agent-1",
          agent_type: "Explore",
          permission_mode: "acceptEdits",
          effort: { level: "high" },
          tool_name: "Read",
          tool_input: {},
          tool_response: {},
          tool_use_id: "toolu_read",
        });
        yield childMessage(options, assistantText(options, "Done.", "msg_child"), "toolu_agent-1");
        yield taskNotification(options, "agent-1", {});
        yield result(options);
        yield idleState(options);
      });
      const client = await promptToIdle(v2Client());

      const configurations = client.sessionUpdates.flatMap(({ sessionId, update }) =>
        sessionId === "agent-1" && update.sessionUpdate === "config_option_update"
          ? [
              (
                update as { configOptions: Array<{ configId: string; currentValue: unknown }> }
              ).configOptions.map(({ configId, currentValue }) => `${configId}=${currentValue}`),
            ]
          : [],
      );
      // The hook's options, then all of them again with the model of the
      // child's response, the mode first.
      expect(configurations).toEqual([
        ["mode=acceptEdits", "effort=high", "agent=Explore"],
        ["mode=acceptEdits", "model=claude-sonnet-4-6", "effort=high", "agent=Explore"],
      ]);
    });

    it("sends a live child's configuration again after a replay's response, when the replay sent another", async () => {
      scriptTurns(async function* (options) {
        yield toolUseMessage(options, "toolu_agent-1", "Agent", {
          description: "Explore the project",
          prompt: "Look around",
          subagent_type: "Explore",
        });
        yield taskStarted(options, "agent-1", { prompt: "Look around" });
        await runHooks(options, "PostToolUse", {
          agent_id: "agent-1",
          agent_type: "Explore",
          permission_mode: "acceptEdits",
          tool_name: "Read",
          tool_input: {},
          tool_response: {},
          tool_use_id: "toolu_read",
        });
        yield childMessage(options, assistantText(options, "Done.", "msg_child"), "toolu_agent-1");
        yield taskNotification(options, "agent-1", {});
        yield result(options);
        yield idleState(options);
      });
      const client = v2Client();
      await client.app.connectWith(connectRouter(), async (agent) => {
        await initializeV2(agent);
        const { sessionId } = await agent.request(v2.methods.agent.session.new, { cwd });
        await agent.request(v2.methods.agent.session.prompt, { sessionId, prompt: text("hi") });
        await vi.waitFor(() => expect(turnTrace(client.sessionUpdates)).toContain("idle end_turn"));
        await writeSubagentHistory(
          sessionId,
          [transcriptRecord(sessionId, "r1", null, { role: "user", content: "hi" })],
          "agent-1",
          { agentType: "Explore", toolUseId: "toolu_agent-1" },
          [
            transcriptRecord(sessionId, "c1", null, { role: "user", content: "Look around" }),
            transcriptRecord(sessionId, "c2", "c1", {
              id: "msg_child",
              role: "assistant",
              model: "claude-sonnet-4-6",
              content: [{ type: "text", text: "Done." }],
            }),
          ],
        );
        vi.mocked(getSessionMessages).mockResolvedValueOnce([
          transcriptEntry("assistant", randomUUID(), {
            id: "msg_agent",
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "toolu_agent-1",
                name: "Agent",
                input: { subagent_type: "Explore", prompt: "Look around" },
              },
            ],
          }),
          transcriptEntry("user", randomUUID(), {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "toolu_agent-1", content: "Done." }],
          }),
        ] as unknown as Awaited<ReturnType<typeof getSessionMessages>>);
        client.sessionUpdates.length = 0;
        await agent.request(v2.methods.agent.session.resume, {
          sessionId,
          cwd,
          replayFrom: { type: "start" },
        });
        client.sessionUpdates.push({
          sessionId: "agent-1",
          update: { sessionUpdate: "response" },
        } as never);
        await vi.waitFor(() =>
          expect(client.sessionUpdates.at(-1)?.update.sessionUpdate).toBe("config_option_update"),
        );
        await client.authUpdate(1);
      });

      const configurations = client.sessionUpdates.flatMap(({ sessionId, update }) => {
        if (sessionId !== "agent-1") return [];
        if (update.sessionUpdate === "response") return ["response"];
        if (update.sessionUpdate !== "config_option_update") return [];
        return [
          (
            update as { configOptions: Array<{ configId: string; currentValue: unknown }> }
          ).configOptions
            .map(({ configId, currentValue }) => `${configId}=${currentValue}`)
            .join(" "),
        ];
      });
      // The replay sends the model of the child's response. The live child's
      // configuration has its mode too, so it goes again after the response.
      expect(configurations).toEqual([
        "model=claude-sonnet-4-6",
        "response",
        "mode=acceptEdits model=claude-sonnet-4-6 agent=Explore",
      ]);
    });

    it("names a replayed child's model by the session's model list, on a resume of a closed session", async () => {
      scriptTurns();
      const client = v2Client();
      await client.app.connectWith(connectRouter(), async (agent) => {
        await initializeV2(agent);
        const { sessionId } = await agent.request(v2.methods.agent.session.new, { cwd });
        await agent.request(v2.methods.agent.session.close, { sessionId });
        await writeSubagentHistory(
          sessionId,
          [transcriptRecord(sessionId, "r1", null, { role: "user", content: "hi" })],
          "agent-1",
          { agentType: "Explore", toolUseId: "toolu_agent-1" },
          [
            transcriptRecord(sessionId, "c1", null, { role: "user", content: "Look around" }),
            transcriptRecord(sessionId, "c2", "c1", {
              id: "msg_child",
              role: "assistant",
              model: "claude-sonnet-4-6",
              content: [{ type: "text", text: "Done." }],
            }),
          ],
        );
        vi.mocked(getSessionMessages).mockResolvedValueOnce([
          transcriptEntry("assistant", randomUUID(), {
            id: "msg_agent",
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "toolu_agent-1",
                name: "Agent",
                input: { subagent_type: "Explore", prompt: "Look around" },
              },
            ],
          }),
          transcriptEntry("user", randomUUID(), {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "toolu_agent-1", content: "Done." }],
          }),
        ] as unknown as Awaited<ReturnType<typeof getSessionMessages>>);
        await agent.request(v2.methods.agent.session.resume, {
          sessionId,
          cwd,
          replayFrom: { type: "start" },
        });
        client.sessionUpdates.push({
          sessionId: "agent-1",
          update: { sessionUpdate: "response" },
        } as never);
        // The child's current state follows the response.
        await vi.waitFor(() =>
          expect(
            client.sessionUpdates.filter(
              ({ sessionId, update }) =>
                sessionId === "agent-1" && update.sessionUpdate === "state_update",
            ),
          ).toHaveLength(2),
        );
        await client.authUpdate(1);
      });

      const models = client.sessionUpdates.flatMap(({ sessionId, update }) => {
        if (sessionId !== "agent-1") return [];
        if (update.sessionUpdate === "response") return ["response"];
        if (update.sessionUpdate !== "config_option_update") return [];
        const [option] = (
          update as {
            configOptions: Array<{ currentValue: unknown; options: Array<{ name: string }> }>;
          }
        ).configOptions;
        return [`${option!.currentValue} ${option!.options[0]!.name}`];
      });
      // The core replays after Claude Code started, so the model goes as the
      // model list's entry at once.
      expect(models).toEqual(["claude-sonnet-4-6 Claude Sonnet 4.6", "response"]);
    });

    it("drops a foreground child's consolidated messages after the root's cancel, except the results of its shown tool calls", async () => {
      const interrupted = Promise.withResolvers<void>();
      sdk.interrupt = async () => interrupted.resolve();
      const child = (message: Record<string, unknown>) =>
        childMessage(options!, message, "toolu_agent-1");
      let options: Options | undefined;
      scriptTurns(async function* (turnOptions) {
        options = turnOptions;
        yield toolUseMessage(turnOptions, "toolu_agent-1", "Agent", {
          description: "Explore the project",
          prompt: "Look around",
        });
        yield taskStarted(turnOptions, "agent-1", { prompt: "Look around" });
        yield child(
          stream(turnOptions, {
            type: "message_start",
            message: { id: "msg_child", role: "assistant", content: [], usage: {} },
          }),
        );
        yield child(
          stream(turnOptions, {
            type: "content_block_start",
            index: 0,
            content_block: { type: "text", text: "" },
          }),
        );
        yield child(
          stream(turnOptions, {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: "Working on" },
          }),
        );
        yield child(
          stream(turnOptions, {
            type: "content_block_start",
            index: 1,
            content_block: { type: "tool_use", id: "toolu_shown", name: "Bash", input: {} },
          }),
        );
        await interrupted.promise;
        // What the child had when the interrupt arrived: the consolidated
        // message, with the text's tail and a tool use that never streamed.
        yield child({
          ...assistantText(turnOptions, "", "msg_child"),
          message: {
            ...assistantText(turnOptions, "", "msg_child").message,
            content: [
              { type: "text", text: "Working on it" },
              { type: "tool_use", id: "toolu_shown", name: "Bash", input: { command: "ls" } },
              { type: "tool_use", id: "toolu_unseen", name: "Bash", input: { command: "pwd" } },
            ],
            stop_reason: "tool_use",
          },
        });
        yield child({
          type: "user",
          message: {
            role: "user",
            content: ["toolu_shown", "toolu_unseen"].map((id) => ({
              type: "tool_result",
              tool_use_id: id,
              content: "[Request interrupted by user for tool use]",
              is_error: true,
            })),
          },
          uuid: randomUUID(),
          session_id: turnOptions.sessionId,
        });
        yield taskNotification(turnOptions, "agent-1", { status: "stopped" });
        yield toolResultMessage(turnOptions, "toolu_agent-1", {
          content: "[Request interrupted by user for tool use]",
          is_error: true,
        });
        yield result(turnOptions, ABORTED_TOOLS);
        yield idleState(turnOptions);
      });
      const client = v2Client();
      await client.app.connectWith(connectRouter(), async (agent) => {
        await initializeV2(agent);
        const { sessionId } = await agent.request(v2.methods.agent.session.new, { cwd });
        await agent.request(v2.methods.agent.session.prompt, { sessionId, prompt: text("go") });
        await vi.waitFor(() =>
          expect(client.updates("tool_call_update").map((u) => u.toolCallId)).toContain(
            "toolu_shown",
          ),
        );

        await agent.notify(v2.methods.agent.session.cancel, { sessionId });

        await vi.waitFor(() =>
          expect(turnTrace(client.sessionUpdates)).toContain("idle cancelled"),
        );
        await client.authUpdate(1);
      });

      const ofChild = client.sessionUpdates.flatMap(({ sessionId, update }) =>
        sessionId === "agent-1" ? [update] : [],
      );
      expect(
        ofChild.flatMap((update) =>
          update.sessionUpdate === "agent_message_chunk"
            ? [(update.content as { text: string }).text]
            : [],
        ),
      ).toEqual(["Working on"]);
      const toolCalls = ofChild.flatMap((update) =>
        update.sessionUpdate === "tool_call_update"
          ? [update as { toolCallId: string; status?: string }]
          : [],
      );
      expect(toolCalls.some((update) => update.toolCallId === "toolu_unseen")).toBe(false);
      expect(
        toolCalls.filter((update) => update.toolCallId === "toolu_shown").at(-1),
      ).toMatchObject({ status: "cancelled" });
    });

    it("ends the subagents that work when Claude Code starts a fresh conversation", async () => {
      scriptTurns(
        async function* (options) {
          yield toolUseMessage(options, "toolu_agent-1", "Agent", {
            description: "Explore the project",
            prompt: "Look around",
            run_in_background: true,
          });
          yield taskStarted(options, "agent-1", { prompt: "Look around", is_backgrounded: true });
          yield childMessage(
            options,
            toolUseMessage(options, "toolu_ls", "Bash", { command: "ls" }),
            "toolu_agent-1",
          );
          yield toolResultMessage(options, "toolu_agent-1", { content: "Launched." });
          yield result(options);
          yield idleState(options);
        },
        async function* (options) {
          yield {
            type: "conversation_reset",
            new_conversation_id: randomUUID(),
            uuid: randomUUID(),
            trigger: "clear",
            timestamp: new Date().toISOString(),
            session_id: options.sessionId,
          };
          // The reset forgot the child: its later end changes nothing.
          yield taskNotification(options, "agent-1", {});
          yield result(options, { num_turns: 0 });
          yield idleState(options);
        },
      );
      const client = v2Client();
      let root = "";
      await client.app.connectWith(connectRouter(), async (agent) => {
        await initializeV2(agent);
        const { sessionId } = await agent.request(v2.methods.agent.session.new, { cwd });
        root = sessionId;
        await agent.request(v2.methods.agent.session.prompt, { sessionId, prompt: text("go") });
        await vi.waitFor(() => expect(turnTrace(client.sessionUpdates)).toContain("idle end_turn"));
        client.sessionUpdates.length = 0;
        await agent.request(v2.methods.agent.session.prompt, { sessionId, prompt: text("/clear") });
        await vi.waitFor(() => expect(turnTrace(client.sessionUpdates)).toContain("idle end_turn"));
        await client.authUpdate(1);
      });

      const trace = client.sessionUpdates.flatMap(({ sessionId, update }) => {
        const on = sessionId === root ? "root" : sessionId;
        const state = (value: unknown) => {
          const { state, stopReason } = value as { state: string; stopReason?: string };
          return `${state}${stopReason ? ` ${stopReason}` : ""}`;
        };
        switch (update.sessionUpdate) {
          case "subagent_update":
            return update.state
              ? [`${on} subagent ${update.sessionId} ${state(update.state)}`]
              : [];
          case "state_update": {
            const listed = (
              (update as { background?: Array<{ sessionId?: string }> }).background ?? []
            )
              .map((item) => item.sessionId)
              .join(",");
            return [`${on} ${state(update)} [${listed}]`];
          }
          case "tool_call_update": {
            const { toolCallId, status } = update as { toolCallId: string; status?: string };
            return status ? [`${on} ${toolCallId} ${status}`] : [];
          }
          default:
            return [];
        }
      });
      // The child's run ends with no stop reason: nothing says how. Its tool
      // call ends first, as v2 asks.
      expect(trace).toEqual([
        "root running []",
        "agent-1 toolu_ls failed",
        "root subagent agent-1 idle",
        "agent-1 idle []",
        "root idle end_turn []",
      ]);
    });

    it("sends a SendMessage call's message and a SubagentHandback call's report as session messages, instead of the calls", async () => {
      scriptTurns(async function* (options) {
        yield toolUseMessage(options, "toolu_agent-1", "Agent", {
          description: "Explore the project",
          prompt: "Look around",
        });
        yield taskStarted(options, "agent-1", { prompt: "Look around" });
        yield toolUseMessage(
          options,
          "toolu_handback",
          "SubagentHandback",
          { message: "Found it." },
          "toolu_agent-1",
        );
        yield childMessage(
          options,
          toolResultMessage(options, "toolu_handback", { content: "Delivered" }),
          "toolu_agent-1",
        );
        yield taskNotification(options, "agent-1", {});
        // The run handed back its report: its result is no reply.
        yield toolResultMessage(options, "toolu_agent-1", {
          content: [{ type: "text", text: "The report was delivered as a message." }],
        });
        yield toolUseMessage(options, "toolu_send", "SendMessage", {
          to: "agent-1",
          message: "Look again",
        });
        yield taskStarted(options, "agent-1", {
          tool_use_id: "toolu_send",
          prompt: "Look again",
          is_backgrounded: true,
        });
        yield toolResultMessage(options, "toolu_send", { content: "Message sent" });
        yield taskNotification(options, "agent-1", {
          tool_use_id: "toolu_send",
        });
        yield result(options);
        yield idleState(options);
      });
      const client = await promptToIdle(v2Client());
      const root = client.sessionUpdates.find(
        ({ update }) => update.sessionUpdate === "user_message",
      )!.sessionId;

      expect(sessionMessages(client, root)).toEqual([
        "root toolu_agent-1 root -> agent-1 Look around",
        "agent-1 toolu_agent-1 root -> agent-1 Look around",
        "agent-1 toolu_handback agent-1 -> root Found it.",
        "root toolu_handback agent-1 -> root Found it.",
        "root toolu_send root -> agent-1 Look again",
        "agent-1 toolu_send root -> agent-1 Look again",
      ]);
      expect(shownToolCalls(client)).toEqual([]);
    });

    it("shows a SendMessage call whose message reached no child session as a tool call", async () => {
      scriptTurns(async function* (options) {
        yield toolUseMessage(options, "toolu_send", "SendMessage", {
          to: "team-lead",
          message: "Status?",
        });
        yield toolResultMessage(options, "toolu_send", { content: "Message sent" });
        yield result(options);
        yield idleState(options);
      });
      const client = await promptToIdle(v2Client());

      expect(client.updates("tool_call_update")).toContainEqual(
        expect.objectContaining({ toolCallId: "toolu_send", status: "completed" }),
      );
      expect(client.updates("session_message")).toEqual([]);
    });

    it.each([
      // The client holds the call from the request: it keeps getting it, and
      // the message goes to the child only, and names its sender.
      ["before", 1, ["agent-1 toolu_send root -> agent-1 Look again"]],
      [
        "after",
        0,
        [
          "root toolu_send root -> agent-1 Look again",
          "agent-1 toolu_send root -> agent-1 Look again",
        ],
      ],
    ])(
      "shows a SendMessage call only when its permission request came %s its tool use streamed",
      async (order, completedUpdates, delivery) => {
        scriptTurns(async function* (options) {
          yield toolUseMessage(options, "toolu_agent-1", "Agent", {
            description: "Explore the project",
            prompt: "Look around",
          });
          yield taskStarted(options, "agent-1", { prompt: "Look around" });
          yield taskNotification(options, "agent-1", {});
          yield toolResultMessage(options, "toolu_agent-1", {
            content: [{ type: "text", text: "Found it." }],
          });
          const ask = () =>
            options.canUseTool!("SendMessage", { to: "agent-1", message: "Look again" }, {
              signal: new AbortController().signal,
              suggestions: [],
              toolUseID: "toolu_send",
              requestId: randomUUID(),
            } as unknown as Parameters<NonNullable<Options["canUseTool"]>>[2]);
          if (order === "before") await ask();
          yield toolUseMessage(options, "toolu_send", "SendMessage", {
            to: "agent-1",
            message: "Look again",
          });
          if (order === "after") await ask();
          yield taskStarted(options, "agent-1", {
            tool_use_id: "toolu_send",
            prompt: "Look again",
            is_backgrounded: true,
          });
          yield toolResultMessage(options, "toolu_send", { content: "Message sent" });
          yield taskNotification(options, "agent-1", { tool_use_id: "toolu_send" });
          yield result(options);
          yield idleState(options);
        });
        const client = await promptToIdle(
          v2Client({
            answerPermission: (request) => ({
              outcome: {
                outcome: "selected",
                optionId: request.options.find((option) => option.kind === "allow_once")!.optionId,
              },
            }),
          }),
        );
        const root = client.sessionUpdates.find(
          ({ update }) => update.sessionUpdate === "user_message",
        )!.sessionId;

        expect(client.permissionRequests).toHaveLength(1);
        expect(
          client.sessionUpdates.filter(
            ({ sessionId, update }) =>
              sessionId === root &&
              update.sessionUpdate === "tool_call_update" &&
              (update as { toolCallId: string }).toolCallId === "toolu_send" &&
              (update as { status?: string }).status === "completed",
          ),
        ).toHaveLength(completedUpdates);
        expect(sessionMessages(client, root).slice(3)).toEqual(delivery);
      },
    );

    it.each(["its task_started", "the resumedAgentId of its result alone"])(
      "restores a subagent that a SendMessage call resumes from the session's subagent history, at %s",
      async (signal) => {
        const started = signal === "its task_started";
        scriptTurns(async function* (options) {
          // Claude Code no longer tracks the agent, from before a restart:
          // its history names the call that launched it from the root.
          const sessionId = options.sessionId!;
          await writeSubagentHistory(
            sessionId,
            [
              transcriptRecord(sessionId, "r1", null, {
                role: "assistant",
                content: [
                  {
                    type: "tool_use",
                    id: "toolu_old",
                    name: "Agent",
                    input: { name: "scout", prompt: "Look around" },
                  },
                ],
              }),
            ],
            "abc123",
            { agentType: "Explore", name: "scout", toolUseId: "toolu_old" },
            [transcriptRecord(sessionId, "c1", null, { role: "user", content: "Look around" })],
          );
          yield toolUseMessage(options, "toolu_send", "SendMessage", {
            to: "scout",
            message: "Look again",
          });
          if (started) {
            yield taskStarted(options, "abc123", {
              tool_use_id: "toolu_send",
              prompt: "Look again",
              subagent_type: "Explore",
              is_backgrounded: true,
            });
          } else {
            // Claude Code can resume an agent without a `task_started`.
            yield {
              ...toolResultMessage(options, "toolu_send", { content: "Message sent" }),
              tool_use_result: { success: true, message: "Resumed", resumedAgentId: "abc123" },
            };
          }
          // The resumed run's messages carry the call that launched it.
          yield childMessage(
            options,
            assistantText(options, "Still fine.", "msg_child"),
            "toolu_old",
          );
          if (started) yield toolResultMessage(options, "toolu_send", { content: "Message sent" });
          yield taskNotification(options, "abc123", {
            tool_use_id: "toolu_send",
          });
          yield result(options);
          yield idleState(options);
        });
        const client = await promptToIdle(v2Client());
        const sessionId = client.sessionUpdates.find(
          ({ update }) => update.sessionUpdate === "user_message",
        )!.sessionId;

        expect(
          client.sessionUpdates.flatMap(({ sessionId: on, update }) => {
            const where = on === sessionId ? "root" : on;
            if (update.sessionUpdate === "subagent_update") {
              const { title, state } = update as { title?: string; state?: { state: string } };
              return [`${where} subagent_update ${title ?? ""} ${state?.state ?? ""}`];
            }
            if (on === sessionId) {
              return update.sessionUpdate === "session_message" ? [`${where} session_message`] : [];
            }
            return update.sessionUpdate === "state_update"
              ? []
              : [`${where} ${update.sessionUpdate}`];
          }),
        ).toEqual([
          "root subagent_update scout running",
          "root session_message",
          "abc123 session_message",
          "abc123 config_option_update",
          "abc123 agent_message_chunk",
          "root subagent_update  idle",
        ]);
        expect(sessionMessages(client, sessionId)).toEqual([
          "root toolu_send root -> abc123 Look again",
          "abc123 toolu_send root -> abc123 Look again",
        ]);
        expect(shownToolCalls(client)).toEqual([]);
      },
    );
  });

  it("shows a subagent's checklist in the subagent's session, apart from the root's", async () => {
    const todoWrite = (
      options: Options,
      id: string,
      content: string,
      parentToolUseId: string | null,
    ) => ({
      type: "assistant",
      message: {
        id: `msg_${id}`,
        type: "message",
        role: "assistant",
        model: "claude-sonnet-4-6",
        content: [
          {
            type: "tool_use",
            id,
            name: "TodoWrite",
            input: { todos: [{ content, status: "pending", activeForm: content }] },
          },
        ],
        stop_reason: "tool_use",
        stop_sequence: null,
        usage: { input_tokens: 3, output_tokens: 2 },
      },
      parent_tool_use_id: parentToolUseId,
      uuid: randomUUID(),
      session_id: options.sessionId,
    });
    scriptTurns(async function* (options) {
      yield todoWrite(options, "toolu_main_todo", "Main step", null);
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
      yield todoWrite(options, "toolu_agent_todo", "Agent step", "toolu_agent-1");
      yield result(options);
      yield idleState(options);
    });
    const client = await promptToIdle(v2Client());

    const root = client.sessionUpdates.find(
      ({ update }) => update.sessionUpdate === "user_message",
    )!.sessionId;
    expect(
      client.sessionUpdates.flatMap(({ sessionId, update }) =>
        update.sessionUpdate === "plan_update"
          ? [{ on: sessionId === root ? "root" : sessionId, plan: update.plan }]
          : [],
      ),
    ).toEqual([
      {
        on: "root",
        plan: {
          type: "items",
          planId: "plan",
          entries: [{ content: "Main step", status: "pending", priority: "medium" }],
        },
      },
      {
        on: "agent-1",
        plan: {
          type: "items",
          planId: "plan",
          entries: [{ content: "Agent step", status: "pending", priority: "medium" }],
        },
      },
    ]);
  });

  describe("background work", () => {
    /** Claude Code's live background task set. */
    const level = (options: Options, tasks: Array<Record<string, unknown>>) => ({
      type: "system",
      subtype: "background_tasks_changed",
      tasks: tasks.map((fields) => ({ description: "Explore the project", ...fields })),
      uuid: randomUUID(),
      session_id: options.sessionId,
    });
    const agent1 = { task_id: "agent-1", task_type: "local_agent", subagent_type: "Explore" };
    /** The root starts the subagent `agent-1` in the background. */
    const agentUse = (options: Options) => ({
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
            input: {
              description: "Explore the project",
              prompt: "Look around",
              run_in_background: true,
            },
          },
        ],
        stop_reason: "tool_use",
        stop_sequence: null,
        usage: { input_tokens: 3, output_tokens: 2 },
      },
      parent_tool_use_id: null,
      uuid: randomUUID(),
      session_id: options.sessionId,
    });
    const taskEnd = (options: Options, taskId: string, toolUseId: string) => ({
      type: "system",
      subtype: "task_notification",
      task_id: taskId,
      tool_use_id: toolUseId,
      status: "completed",
      output_file: `/tmp/tasks/${taskId}.output`,
      summary: "Done",
      uuid: randomUUID(),
      session_id: options.sessionId,
    });

    /** The states of each session with their lists, and the subagent's mirrored states. */
    const trace = (client: ReturnType<typeof v2Client>, root: string) =>
      client.sessionUpdates.flatMap(({ sessionId, update }) => {
        if (update.sessionUpdate === "subagent_update") {
          return [`subagent ${(update.state as { state?: string } | undefined)?.state ?? ""}`];
        }
        if (update.sessionUpdate === "terminal_update" && update.exitStatus) {
          return [`${sessionId} exit`];
        }
        if (update.sessionUpdate !== "state_update") return [];
        const { background } = update as { background?: v2.BackgroundWork[] };
        const items = background?.map((item) =>
          "sessionId" in item
            ? String(item.sessionId)
            : "terminalId" in item
              ? String(item.terminalId)
              : "",
        );
        return [`${sessionId === root ? "root" : sessionId} ${update.state} [${items ?? "none"}]`];
      });

    /** Prompts once, and runs `during` once the trace holds `until`. */
    async function promptUntil(
      until: string,
      during: (
        agent: v2.ClientContext,
        root: string,
        client: ReturnType<typeof v2Client>,
      ) => Promise<unknown> = async () => {},
    ) {
      const client = v2Client();
      let root = "";
      await client.app.connectWith(connectRouter(), async (agent) => {
        await initializeV2(agent);
        ({ sessionId: root } = await agent.request(v2.methods.agent.session.new, { cwd }));
        await agent.request(v2.methods.agent.session.prompt, {
          sessionId: root,
          prompt: text("hi"),
        });
        await vi.waitFor(() => expect(trace(client, root)).toContain(until));
        await during(agent, root, client);
      });
      return { client, root };
    }

    it("lists a background subagent's session in the root's list until it reports idle", async () => {
      scriptTurns(async function* (options) {
        yield agentUse(options);
        yield level(options, [agent1]);
        yield taskStarted(options, "agent-1", { prompt: "Look around", is_backgrounded: true });
        yield result(options);
        yield idleState(options);
        yield taskEnd(options, "agent-1", "toolu_agent-1");
        // The level that drops the subagent can come later: the SDK leaves its
        // order against the task's end open. The child's idle drops it already.
      });
      const { client, root } = await promptUntil("root idle []");

      // The child's own idle comes before the list that drops it. The child
      // reports its own list, which is empty.
      expect(trace(client, root)).toEqual([
        "root running []",
        "subagent running",
        "agent-1 running []",
        "root running [agent-1]",
        "root idle [agent-1]",
        "subagent idle",
        "agent-1 idle []",
        "root idle []",
      ]);
    });

    it("starts a subagent's task without a tool call on the subagent's stream, and lists it there", async () => {
      const workflow = {
        task_id: "wf1",
        task_type: "local_workflow",
        description: "Review",
        parent_task_id: "agent-1",
      };
      scriptTurns(async function* (options) {
        yield agentUse(options);
        yield level(options, [agent1]);
        yield taskStarted(options, "agent-1", { prompt: "Look around", is_backgrounded: true });
        yield result(options);
        yield idleState(options);
        yield level(options, [agent1, workflow]);
        yield {
          type: "system",
          subtype: "task_started",
          ...workflow,
          uuid: randomUUID(),
          session_id: options.sessionId,
        };
      });
      const client = v2Client();
      await client.app.connectWith(connectRouter(), async (agent) => {
        await initializeV2(agent);
        const { sessionId } = await agent.request(v2.methods.agent.session.new, { cwd });
        await agent.request(v2.methods.agent.session.prompt, { sessionId, prompt: text("hi") });
        await vi.waitFor(() =>
          expect(
            client.sessionUpdates
              .filter(
                ({ sessionId, update }) =>
                  sessionId === "agent-1" && update.sessionUpdate === "state_update",
              )
              .at(-1)?.update,
          ).toMatchObject({ background: [{ type: "tool_call", toolCallId: "task_wf1" }] }),
        );
      });

      expect(
        client.sessionUpdates.filter(
          ({ update }) =>
            update.sessionUpdate === "tool_call_update" && update.toolCallId === "task_wf1",
        )[0],
      ).toMatchObject({
        sessionId: "agent-1",
        update: { title: "Review", kind: "other", status: "in_progress" },
      });
    });

    it("keeps an idle subagent listed while its own command runs in the background", async () => {
      const childMessage = (options: Options, message: Record<string, unknown>) => ({
        ...message,
        parent_tool_use_id: "toolu_agent-1",
        uuid: randomUUID(),
        session_id: options.sessionId,
      });
      const bash = { task_id: "bg1", task_type: "local_bash", parent_task_id: "agent-1" };
      scriptTurns(async function* (options) {
        yield agentUse(options);
        yield level(options, [agent1]);
        yield taskStarted(options, "agent-1", { prompt: "Look around", is_backgrounded: true });
        yield result(options);
        yield idleState(options);
        // The subagent runs a command in the background, and finishes.
        yield childMessage(options, {
          type: "assistant",
          message: {
            id: "msg_child_bash",
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
        });
        yield level(options, [agent1, bash]);
        yield {
          type: "system",
          subtype: "task_started",
          task_id: "bg1",
          task_type: "local_bash",
          description: "make test",
          tool_use_id: "toolu_bg",
          parent_task_id: "agent-1",
          owned_by_subagent: true,
          is_backgrounded: true,
          uuid: randomUUID(),
          session_id: options.sessionId,
        };
        // As seen live (CLI 2.1.318): a subagent's tool result has no
        // `tool_use_result`, so only the `task_started` above names the task.
        yield childMessage(options, {
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
        });
        yield taskEnd(options, "agent-1", "toolu_agent-1");
        yield level(options, [bash]);
        // The command ends later.
        yield taskEnd(options, "bg1", "toolu_bg");
        yield level(options, []);
      });
      const { client, root } = await promptUntil("root idle []");

      expect(trace(client, root).slice(5)).toEqual([
        "subagent running",
        "agent-1 running [toolu_bg]",
        "subagent idle",
        "agent-1 idle [toolu_bg]",
        "agent-1 exit",
        "subagent idle",
        "agent-1 idle []",
        "root idle []",
      ]);
      expect(trace(client, root).slice(0, 5)).toEqual([
        "root running []",
        "subagent running",
        "agent-1 running []",
        "root running [agent-1]",
        "root idle [agent-1]",
      ]);
    });

    it("sends the current state of each listed subagent before the state snapshot of session/resume", async () => {
      scriptTurns(async function* (options) {
        yield agentUse(options);
        yield level(options, [agent1]);
        yield taskStarted(options, "agent-1", { prompt: "Look around", is_backgrounded: true });
        yield result(options);
        yield idleState(options);
      });
      let resumed: v2.UpdateSessionNotification[] = [];
      await promptUntil("root idle [agent-1]", async (agent, root, client) => {
        const before = client.sessionUpdates.length;
        await agent.request(v2.methods.agent.session.resume, { sessionId: root, cwd });
        resumed = client.sessionUpdates.slice(before);
      });

      expect(resumed.map(({ update }) => update)).toEqual([
        {
          sessionUpdate: "subagent_update",
          sessionId: "agent-1",
          title: "Explore the project",
          description: "Explore",
          capabilities: { cancel: {} },
          state: { state: "running", background: [] },
        },
        // The child's own stream gets its state too, as for every subagent_update.
        { sessionUpdate: "state_update", state: "running", background: [] },
        {
          sessionUpdate: "state_update",
          state: "idle",
          background: [{ type: "subagent", sessionId: "agent-1" }],
        },
      ]);
      expect(resumed.map(({ sessionId }) => sessionId)).toEqual([
        expect.not.stringMatching(/^agent-1$/),
        "agent-1",
        expect.not.stringMatching(/^agent-1$/),
      ]);
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
      state: { state: "idle", stopReason: "cancelled", background: [] },
    });
    expect(
      client.sessionUpdates
        .filter(
          ({ sessionId, update }) =>
            sessionId === "agent-1" && update.sessionUpdate === "state_update",
        )
        .map(({ update }) => update),
    ).toEqual([
      { sessionUpdate: "state_update", state: "running", background: [] },
      { sessionUpdate: "state_update", state: "idle", stopReason: "cancelled", background: [] },
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
      // The client does not answer the request, so the agent cancels it.
      expect(client.cancelledRequests).toHaveLength(1);
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
      let cancelledAtClose: string[] = [];
      await runTurn(client, async (agent, sessionId) => {
        await awaitsUser(client);
        await agent.request(v2.methods.agent.session.close, { sessionId });
        atClose = turnTrace(client.sessionUpdates);
        cancelledAtClose = [...client.cancelledRequests];
      });
      closed.resolve();

      expect(atClose).toEqual(["user_message", "running", "requires_action", "idle cancelled"]);
      // The request is cancelled with `$/cancel_request` before session/close responds.
      expect(cancelledAtClose).toHaveLength(1);
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
        await vi.waitFor(() => expect(v2Session(sessionId).requests.size).toBe(1));
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

  describe("background work", () => {
    /** Claude Code's live background task set. A task joins it before its
     *  `task_started`, and leaves it after its `task_notification`. */
    const level = (options: Options, tasks: Array<Record<string, unknown>>) => ({
      type: "system",
      subtype: "background_tasks_changed",
      tasks: tasks.map((fields) => ({
        task_id: "bg1",
        task_type: "local_bash",
        description: "make test",
        ...fields,
      })),
      uuid: randomUUID(),
      session_id: options.sessionId,
    });

    /** The session's states with their `background` lists, and the terminal
     *  updates that change whether it can be cancelled or end it. */
    const backgroundTrace = (client: ReturnType<typeof v2Client>) =>
      client.sessionUpdates.flatMap(({ update }) => {
        if (update.sessionUpdate === "terminal_update") {
          if (update.exitStatus) return [update.capabilities === null ? "exit, no cancel" : "exit"];
          const capabilities = update.capabilities as { cancel?: unknown } | null | undefined;
          return capabilities?.cancel ? ["cancel"] : [];
        }
        if (update.sessionUpdate !== "state_update") return [];
        const stopReason =
          "stopReason" in update && update.stopReason ? ` ${update.stopReason}` : "";
        const { background } = update as { background?: v2.BackgroundWork[] | null };
        const items = (background ?? []).map((item) =>
          "terminalId" in item
            ? String(item.terminalId)
            : "toolCallId" in item
              ? String(item.toolCallId)
              : String(item.type),
        );
        return [`${update.state}${stopReason} [${items.join(",")}]`];
      });

    /** Prompts once, and runs `during` once the trace holds `until`. */
    async function promptUntil(
      until: string,
      during: (
        agent: v2.ClientContext,
        sessionId: string,
        client: ReturnType<typeof v2Client>,
      ) => Promise<unknown> = async () => {},
    ) {
      const client = v2Client();
      await client.app.connectWith(connectRouter(), async (agent) => {
        await initializeV2(agent);
        const { sessionId } = await agent.request(v2.methods.agent.session.new, { cwd });
        await agent.request(v2.methods.agent.session.prompt, { sessionId, prompt: text("hi") });
        await vi.waitFor(() => expect(backgroundTrace(client)).toContain(until));
        await during(agent, sessionId, client);
      });
      return client;
    }

    it("lists the terminal from the Bash result until the command's task ends, and lets the client cancel it meanwhile", async () => {
      scriptTurns(async function* (options) {
        yield level(options, [{}]);
        yield taskStarted(options);
        yield bashUse(options);
        yield backgrounded(options);
        yield result(options);
        yield idleState(options);
        yield* taskEnded(options);
        yield level(options, []);
        yield assistantText(options, "The tests failed.", "msg_followup");
        yield result(options, { origin: { kind: "task-notification" } });
        yield idleState(options);
      });
      const client = await promptUntil("idle end_turn []");

      // The terminal can be cancelled before a list names it, and no longer
      // once it exits, before the list drops it. A repeated state has no stop
      // reason.
      expect(backgroundTrace(client)).toEqual([
        "running []",
        "cancel",
        "running [toolu_bg]",
        "idle end_turn [toolu_bg]",
        "exit, no cancel",
        "idle []",
        "running []",
        "idle end_turn []",
      ]);
    });

    it("ends the terminal before the list drops it when Claude Code reports no end for its task", async () => {
      scriptTurns(async function* (options) {
        yield level(options, [{}]);
        yield taskStarted(options);
        yield bashUse(options);
        yield backgrounded(options);
        yield result(options);
        yield idleState(options);
        yield level(options, []);
      });
      const client = await promptUntil("idle []");

      expect(backgroundTrace(client).slice(-3)).toEqual([
        "idle end_turn [toolu_bg]",
        "exit, no cancel",
        "idle []",
      ]);
    });

    it("reads the command's output file into its terminal, and the rest before its exit", async () => {
      const dir = await mkdtemp(path.join(os.tmpdir(), "background-output-"));
      const outputFile = path.join(dir, "tasks", "bg1.output");
      await mkdir(path.dirname(outputFile));
      await writeFile(outputFile, "compiling\n");
      const ended = Promise.withResolvers<void>();
      scriptTurns(async function* (options) {
        yield level(options, [{}]);
        yield taskStarted(options);
        yield bashUse(options);
        // The Bash result names the file, as Claude Code writes it.
        const bashResult = backgrounded(options);
        yield {
          ...bashResult,
          message: {
            ...bashResult.message,
            content: [
              {
                ...bashResult.message.content[0],
                content: `Command running in background with ID: bg1. Output is being written to: ${outputFile}`,
              },
            ],
          },
        };
        yield result(options);
        yield idleState(options);
        await ended.promise;
        yield* taskEnded(options);
        yield level(options, []);
      });
      const output = (client: ReturnType<typeof v2Client>) =>
        client.sessionUpdates.flatMap(({ update }) => {
          if (update.sessionUpdate === "terminal_output_chunk") {
            return [`chunk ${Buffer.from(String(update.data), "base64").toString()}`];
          }
          if (update.sessionUpdate !== "terminal_update") return [];
          return [
            ...(update.output
              ? [
                  `output ${Buffer.from((update.output as { data: string }).data, "base64").toString()}`,
                ]
              : []),
            ...(update.exitStatus ? ["exit"] : []),
          ];
        });
      try {
        const client = await promptUntil("idle end_turn [toolu_bg]", async (_, __, client) => {
          await vi.waitFor(() => expect(output(client)).toContain("output compiling\n"), {
            timeout: 2000,
          });
          await appendFile(outputFile, "tests passed\n");
          await vi.waitFor(() => expect(output(client)).toContain("chunk tests passed\n"), {
            timeout: 2000,
          });
          // The command writes its last line as it ends.
          await appendFile(outputFile, "done\n");
          ended.resolve();
          await vi.waitFor(() => expect(backgroundTrace(client)).toContain("idle []"));
        });

        // The file's first text replaces the Bash result's placeholder.
        expect(output(client).slice(-4)).toEqual([
          "output compiling\n",
          "chunk tests passed\n",
          "chunk done\n",
          "exit",
        ]);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it("ends the listed terminals when the query ends, as its background tasks end with it", async () => {
      scriptTurns(async function* (options) {
        yield level(options, [{}]);
        yield taskStarted(options);
        yield bashUse(options);
        yield backgrounded(options);
        yield result(options);
        yield idleState(options);
        throw new Error("The Claude Code process exited");
      });
      const client = await promptUntil("idle []");

      expect(backgroundTrace(client).slice(-3)).toEqual([
        "idle end_turn [toolu_bg]",
        "exit, no cancel",
        "idle []",
      ]);
    });

    it("reports no list when the session's interrupt would stop background tasks", async () => {
      scriptTurns(async function* (options) {
        yield level(options, [{}]);
        yield taskStarted(options);
        yield bashUse(options);
        yield backgrounded(options);
        yield result(options);
        yield idleState(options);
      });
      const client = v2Client();
      await client.app.connectWith(connectRouter(), async (agent) => {
        await initializeV2(agent);
        // Without the declaration, Claude Code's interrupt kills background
        // tasks, so session/cancel could not leave listed work running.
        const { sessionId } = await agent.request(v2.methods.agent.session.new, {
          cwd,
          _meta: { claudeCode: { options: { perTaskStopAffordance: false } } },
        });
        await agent.request(v2.methods.agent.session.prompt, { sessionId, prompt: text("hi") });
        await vi.waitFor(() => expect(turnTrace(client.sessionUpdates)).toContain("idle end_turn"));
        await expect(
          agent.request(v2.methods.agent.terminal.cancel, { sessionId, terminalId: "toolu_bg" }),
        ).rejects.toMatchObject({ code: -32602 });
      });

      expect(sdk.queryOptions.at(-1)?.perTaskStopAffordance).toBe(false);
      expect(client.updates("state_update").filter((update) => "background" in update)).toEqual([]);
      expect(backgroundTrace(client)).not.toContain("cancel");
    });

    it("leaves out a task that Claude Code marks ambient", async () => {
      scriptTurns(async function* (options) {
        yield level(options, [{ ambient: true }]);
        yield taskStarted(options);
        yield bashUse(options);
        yield backgrounded(options);
        yield result(options);
        yield idleState(options);
      });
      const client = await promptUntil("idle end_turn []");

      expect(backgroundTrace(client)).toEqual(["running []", "idle end_turn []"]);
    });

    it("stops the command's task on terminal/cancel, and rejects a terminal that is not listed", async () => {
      const stopped = Promise.withResolvers<string>();
      sdk.stopTask = async (taskId) => stopped.resolve(taskId);
      scriptTurns(async function* (options) {
        yield level(options, [{}]);
        yield taskStarted(options);
        yield bashUse(options);
        yield backgrounded(options);
        yield result(options);
        yield idleState(options);
        await stopped.promise;
        yield taskEvent(options, "task_notification", {
          tool_use_id: "toolu_bg",
          status: "stopped",
          output_file: "/tmp/tasks/bg1.output",
          summary: "Stopped",
        });
        yield level(options, []);
      });
      let rejected: unknown;
      const client = await promptUntil(
        "idle end_turn [toolu_bg]",
        async (agent, sessionId, client) => {
          await expect(
            agent.request(v2.methods.agent.terminal.cancel, { sessionId, terminalId: "toolu_bg" }),
          ).resolves.toEqual({});
          expect(await stopped.promise).toBe("bg1");
          await vi.waitFor(() => expect(backgroundTrace(client)).toContain("idle []"));
          rejected = await agent
            .request(v2.methods.agent.terminal.cancel, { sessionId, terminalId: "toolu_bg" })
            .catch((error: unknown) => error);
        },
      );

      // The response does not wait for the command to stop: its exit follows.
      expect(backgroundTrace(client).slice(-2)).toEqual(["exit, no cancel", "idle []"]);
      expect(rejected).toMatchObject({ code: -32602 });
    });

    describe("a task that a tool call started", () => {
      // Claude Code marks every live-update watcher ambient, a requested
      // Monitor's task included.
      const monitor = {
        task_id: "mon1",
        task_type: "local_monitor",
        description: "Watch the logs",
        ambient: true,
      };
      const workflow = { task_id: "wf1", task_type: "local_workflow", description: "Review" };
      /** A Monitor call whose task `mon1` runs on after the call returns. The
       *  tool starts the task, which joins the level before its
       *  `task_started`, and returns. */
      async function* monitorStarts(options: Options) {
        yield toolUseMessage(options, "toolu_mon", "Monitor", { command: "tail -f app.log" });
        yield level(options, [monitor]);
        yield taskEvent(options, "task_started", { ...monitor, tool_use_id: "toolu_mon" });
        yield {
          ...toolResultMessage(options, "toolu_mon", { content: "Monitor started (task mon1)." }),
          tool_use_result: { taskId: "mon1", timeoutMs: 0, persistent: true },
        };
      }
      const monitorEvent = (options: Options, subtype: string, fields: Record<string, unknown>) =>
        taskEvent(options, subtype, { ...fields, task_id: "mon1" });

      /** The states with their lists, and the Monitor call's statuses and capability. */
      const toolCallTrace = (client: ReturnType<typeof v2Client>) =>
        client.sessionUpdates.flatMap(({ update }) => {
          if (update.sessionUpdate === "tool_call_update" && update.toolCallId === "toolu_mon") {
            const capabilities = update.capabilities as { cancel?: unknown } | null | undefined;
            return [
              ...(update.status ? [String(update.status)] : []),
              ...(capabilities === null ? ["no cancel"] : capabilities?.cancel ? ["cancel"] : []),
            ];
          }
          if (update.sessionUpdate !== "state_update") return [];
          const stopReason =
            "stopReason" in update && update.stopReason ? ` ${update.stopReason}` : "";
          const { background } = update as { background?: v2.BackgroundWork[] | null };
          const items = (background ?? []).map((item) =>
            "toolCallId" in item ? String(item.toolCallId) : String(item.type),
          );
          return [`${update.state}${stopReason} [${items.join(",")}]`];
        });

      it("keeps the call in_progress and listed until its task ends, and paused while the task is", async () => {
        scriptTurns(async function* (options) {
          yield* monitorStarts(options);
          yield result(options);
          yield idleState(options);
          yield monitorEvent(options, "task_updated", { patch: { status: "paused" } });
          yield monitorEvent(options, "task_updated", { patch: { status: "running" } });
          yield monitorEvent(options, "task_notification", {
            tool_use_id: "toolu_mon",
            status: "completed",
            output_file: "/tmp/tasks/mon1.output",
            summary: "Done",
          });
          yield level(options, []);
        });
        const client = await promptUntil("idle end_turn [toolu_mon]");
        await vi.waitFor(() => expect(toolCallTrace(client)).toContain("idle []"));

        // The task is part of the call until the call returns, so nothing is
        // listed before. The call can be cancelled before a list names it, and
        // no longer once it ends, before the list drops it.
        expect(toolCallTrace(client)).toEqual([
          "running []",
          "pending",
          "in_progress",
          "cancel",
          "running [toolu_mon]",
          "idle end_turn [toolu_mon]",
          "paused",
          "in_progress",
          "completed",
          "no cancel",
          "idle []",
        ]);
      });

      it("stops the task on tool_call/cancel, and reports the call cancelled", async () => {
        const stopped = Promise.withResolvers<string>();
        sdk.stopTask = async (taskId) => stopped.resolve(taskId);
        scriptTurns(async function* (options) {
          yield* monitorStarts(options);
          yield result(options);
          yield idleState(options);
          await stopped.promise;
          // Claude Code reports a stopped task as killed first.
          yield monitorEvent(options, "task_updated", { patch: { status: "killed" } });
          yield monitorEvent(options, "task_notification", {
            tool_use_id: "toolu_mon",
            status: "stopped",
            output_file: "/tmp/tasks/mon1.output",
            summary: "Stopped",
          });
          yield level(options, []);
        });
        let rejected: unknown;
        const client = await promptUntil(
          "idle end_turn [toolu_mon]",
          async (agent, sessionId, client) => {
            await expect(
              agent.request(v2.methods.agent.toolCall.cancel, {
                sessionId,
                toolCallId: "toolu_mon",
              }),
            ).resolves.toEqual({});
            expect(await stopped.promise).toBe("mon1");
            await vi.waitFor(() => expect(toolCallTrace(client)).toContain("idle []"));
            rejected = await agent
              .request(v2.methods.agent.toolCall.cancel, { sessionId, toolCallId: "toolu_mon" })
              .catch((error: unknown) => error);
          },
        );

        expect(toolCallTrace(client).slice(-3)).toEqual(["cancelled", "no cancel", "idle []"]);
        expect(rejected).toMatchObject({ code: -32602 });
      });

      it("cancels the call when the query ends, as its task ends with it", async () => {
        scriptTurns(async function* (options) {
          yield* monitorStarts(options);
          yield result(options);
          yield idleState(options);
          throw new Error("The Claude Code process exited");
        });
        const client = await promptUntil("idle []");

        expect(toolCallTrace(client).slice(-4)).toEqual([
          "idle end_turn [toolu_mon]",
          "cancelled",
          "no cancel",
          "idle []",
        ]);
      });

      it("leaves a listed Workflow running on session/cancel", async () => {
        const interrupted = Promise.withResolvers<void>();
        sdk.interrupt = async () => interrupted.resolve();
        const stopTask = vi.fn(async () => {});
        sdk.stopTask = stopTask;
        scriptTurns(async function* (options) {
          yield toolUseMessage(options, "toolu_wf", "Workflow", { script: "review" });
          yield level(options, [workflow]);
          yield taskEvent(options, "task_started", { ...workflow, tool_use_id: "toolu_wf" });
          yield {
            ...toolResultMessage(options, "toolu_wf", { content: "Workflow launched." }),
            tool_use_result: {
              status: "async_launched",
              taskId: "wf1",
              taskType: "local_workflow",
            },
          };
          await interrupted.promise;
          yield result(options, ABORTED_TOOLS);
          yield idleState(options);
        });
        const client = await promptUntil("running [toolu_wf]", async (agent, sessionId, client) => {
          await agent.notify(v2.methods.agent.session.cancel, { sessionId });
          await vi.waitFor(() =>
            expect(backgroundTrace(client)).toContain("idle cancelled [toolu_wf]"),
          );
        });

        expect(stopTask).not.toHaveBeenCalled();
        expect(
          client
            .updates("tool_call_update")
            .filter((update) => update.toolCallId === "toolu_wf" && update.status)
            .map((update) => update.status),
        ).toEqual(["pending", "in_progress"]);
      });

      it("updates a workflow card from SDK progress before launch and while idle, and keeps it on resume", async () => {
        const finish = Promise.withResolvers<void>();
        const progress = (options: Options, fields: Record<string, unknown> = {}) =>
          taskEvent(options, "task_progress", {
            task_id: "wf1",
            tool_use_id: "toolu_wf",
            description: "Probe: probe",
            summary: "Run a probe",
            last_tool_name: "probe",
            usage: { total_tokens: 0, tool_uses: 0, duration_ms: 29 },
            ...fields,
          });
        scriptTurns(async function* (options) {
          yield progress(options, { task_id: "unknown" });
          yield toolUseMessage(options, "toolu_wf", "Workflow", { script: "probe" });
          yield level(options, [workflow]);
          yield taskEvent(options, "task_started", { ...workflow, tool_use_id: "toolu_wf" });
          // Observed on CLI 2.1.319: workflow progress can precede the launch
          // result. last_tool_name is the active agent's label, not a tool.
          yield progress(options);
          yield {
            ...toolResultMessage(options, "toolu_wf", { content: "Workflow launched." }),
            tool_use_result: {
              status: "async_launched",
              taskId: "wf1",
              taskType: "local_workflow",
            },
          };
          yield result(options);
          yield idleState(options);
          yield taskEvent(options, "task_updated", { task_id: "wf1", patch: { status: "paused" } });
          yield progress(options, {
            summary: undefined,
            last_tool_name: undefined,
            usage: { total_tokens: 4003, tool_uses: 2, duration_ms: 1494 },
          });
          yield level(options, [workflow]);
          yield progress(options, {
            usage: { total_tokens: 4003, tool_uses: 2, duration_ms: 1494 },
          });
          await finish.promise;
          yield taskEvent(options, "task_updated", {
            task_id: "wf1",
            patch: { status: "completed" },
          });
          yield progress(options, { description: "Late progress" });
          yield level(options, []);
        });
        const body = (tokens: string, tools: number, seconds: number) => [
          {
            type: "content",
            content: {
              type: "text",
              text: `Run a probe\n\nLast activity: probe\n\n${tokens} tokens · ${tools} tool calls · ${seconds}s`,
            },
          },
        ];
        let resumed: v2.SessionUpdate[] = [];
        let live: v2.SessionUpdate[] = [];
        const client = await promptUntil(
          "idle end_turn [toolu_wf]",
          async (agent, sessionId, client) => {
            await vi.waitFor(() =>
              expect(client.updates("tool_call_update")).toContainEqual(
                expect.objectContaining({ content: body("4,003", 2, 1) }),
              ),
            );
            live = client.updates("tool_call_update");
            const before = client.sessionUpdates.length;
            await agent.request(v2.methods.agent.session.resume, { sessionId, cwd });
            resumed = client.sessionUpdates.slice(before).map(({ update }) => update);
            finish.resolve();
            await vi.waitFor(() => expect(backgroundTrace(client)).toContain("idle []"));
          },
        );

        expect(
          live.filter(
            (update) =>
              update.sessionUpdate === "tool_call_update" &&
              update.title === "Workflow: Probe: probe",
          ),
        ).toEqual([
          {
            sessionUpdate: "tool_call_update",
            toolCallId: "toolu_wf",
            title: "Workflow: Probe: probe",
            content: body("0", 0, 0),
          },
          {
            sessionUpdate: "tool_call_update",
            toolCallId: "toolu_wf",
            title: "Workflow: Probe: probe",
            content: body("4,003", 2, 1),
          },
        ]);
        expect(resumed[0]).toMatchObject({
          toolCallId: "toolu_wf",
          title: "Workflow: Probe: probe",
          content: body("4,003", 2, 1),
          status: "paused",
        });
        expect(
          client
            .updates("tool_call_update")
            .flatMap((update) => (update.status ? [update.status] : [])),
        ).toEqual(["pending", "in_progress", "paused", "paused", "completed"]);
        const calls = client.updates("tool_call_update");
        const completed = calls.findIndex((update) => update.status === "completed");
        expect(
          calls.slice(completed + 1).filter((update) => update.title || update.content),
        ).toEqual([]);
      });

      it("lists a workflow's phases and agents on its card, and keeps them when a report has none", async () => {
        // As CLI 2.1.319 sends it, trimmed of the fields the card ignores.
        const snapshot = [
          { type: "workflow_phase", index: 1, title: "Count" },
          { type: "workflow_phase", index: 2, title: "Sum" },
          {
            type: "workflow_agent",
            index: 1,
            label: "two",
            phaseIndex: 1,
            phaseTitle: "Count",
            agentId: "af3724ea06eadb5dd",
            model: "claude-haiku-5-5",
            state: "done",
            attempt: 1,
            promptPreview: "Reply with only the number 2.",
            tokens: 14629,
            toolCalls: 0,
            durationMs: 1329,
            resultPreview: "2",
          },
          {
            type: "workflow_agent",
            index: 2,
            label: "three",
            phaseIndex: 1,
            phaseTitle: "Count",
            model: "claude-haiku-5-5",
            state: "start",
            lastToolName: "Bash",
            lastToolSummary: "echo 3",
          },
        ];
        const progress = (options: Options, fields: Record<string, unknown>) =>
          taskEvent(options, "task_progress", {
            task_id: "wf1",
            tool_use_id: "toolu_wf",
            description: "Count: three",
            ...fields,
          });
        scriptTurns(async function* (options) {
          yield toolUseMessage(options, "toolu_wf", "Workflow", { script: "probe" });
          yield level(options, [workflow]);
          yield taskEvent(options, "task_started", { ...workflow, tool_use_id: "toolu_wf" });
          yield {
            ...toolResultMessage(options, "toolu_wf", { content: "Workflow launched." }),
            tool_use_result: {
              status: "async_launched",
              taskId: "wf1",
              taskType: "local_workflow",
            },
          };
          yield progress(options, {
            usage: { total_tokens: 14629, tool_uses: 0, duration_ms: 1343 },
            workflow_progress: snapshot,
          });
          // The CLI leaves the snapshot out of some reports.
          yield progress(options, {
            usage: { total_tokens: 29282, tool_uses: 1, duration_ms: 2806 },
          });
          yield result(options);
          yield idleState(options);
        });
        const list = [
          "**Count**",
          "- two: done · 14,629 tokens · 0 tool calls · 1s",
          "- three: running · Bash: echo 3",
          "",
          "**Sum**",
          "- not started",
        ].join("\n");
        const client = await promptUntil("idle end_turn [toolu_wf]");

        expect(
          client
            .updates("tool_call_update")
            .flatMap((update) => (update.content ? [update.content] : []))
            .slice(-2),
        ).toEqual(
          ["14,629 tokens · 0 tool calls · 1s", "29,282 tokens · 1 tool calls · 2s"].map(
            (usage) => [
              {
                type: "content",
                content: { type: "text", text: `Count: three\n\n${usage}\n\n${list}` },
              },
            ],
          ),
        );
      });

      it("sends each listed call's current state before the state snapshot of session/resume", async () => {
        scriptTurns(async function* (options) {
          yield* monitorStarts(options);
          yield result(options);
          yield idleState(options);
          yield monitorEvent(options, "task_updated", { patch: { status: "paused" } });
        });
        let resumed: v2.SessionUpdate[] = [];
        await promptUntil("idle end_turn [toolu_mon]", async (agent, sessionId, client) => {
          await vi.waitFor(() => expect(toolCallTrace(client)).toContain("paused"));
          const before = client.sessionUpdates.length;
          await agent.request(v2.methods.agent.session.resume, { sessionId, cwd });
          resumed = client.sessionUpdates.slice(before).map(({ update }) => update);
        });

        // The call as its tool use shows it, with its status now, then its
        // capability.
        expect(resumed).toEqual([
          expect.objectContaining({
            sessionUpdate: "tool_call_update",
            toolCallId: "toolu_mon",
            name: "Monitor",
            status: "paused",
            rawInput: { command: "tail -f app.log" },
          }),
          {
            sessionUpdate: "tool_call_update",
            toolCallId: "toolu_mon",
            capabilities: { cancel: {} },
          },
          {
            sessionUpdate: "state_update",
            state: "idle",
            background: [{ type: "tool_call", toolCallId: "toolu_mon" }],
          },
        ]);
      });

      /** The adapter's own call for the task `mcp1`, which an MCP call started
       *  but which started only after that call returned with its final status. */
      async function* lateTaskStarts(options: Options) {
        yield toolUseMessage(options, "toolu_mcp", "mcp__ci__watch", { job: "build" });
        yield toolResultMessage(options, "toolu_mcp", { content: "Watching the build." });
        const task = { task_id: "mcp1", task_type: "mcp_task", description: "Watch the build" };
        yield level(options, [task]);
        yield taskEvent(options, "task_started", { ...task, tool_use_id: "toolu_mcp" });
        yield result(options);
        yield idleState(options);
      }

      it("starts a tool call for a task whose call returned before the task started, and lists it", async () => {
        scriptTurns(lateTaskStarts);
        const client = await promptUntil("idle end_turn [task_mcp1]");

        const updates = client.sessionUpdates.map(({ update }) => update);
        const started = updates.findIndex(
          (update) =>
            update.sessionUpdate === "tool_call_update" && update.toolCallId === "task_mcp1",
        );
        const listed = updates.findIndex(
          (update) =>
            update.sessionUpdate === "state_update" &&
            JSON.stringify(update).includes('"task_mcp1"'),
        );
        expect(updates[started]).toMatchObject({
          title: "Watch the build",
          kind: "other",
          status: "in_progress",
        });
        expect(started).toBeLessThan(listed);
        // The call that started the task keeps its final status.
        expect(
          updates
            .filter(
              (update) =>
                update.sessionUpdate === "tool_call_update" &&
                update.toolCallId === "toolu_mcp" &&
                update.status !== undefined,
            )
            .map((update) => (update as { status?: unknown }).status)
            .at(-1),
        ).toBe("completed");
      });

      it("stops such a task on tool_call/cancel, and reports its call cancelled", async () => {
        const stopped = Promise.withResolvers<string>();
        sdk.stopTask = async (taskId) => stopped.resolve(taskId);
        scriptTurns(async function* (options) {
          yield* lateTaskStarts(options);
          await stopped.promise;
          yield taskEvent(options, "task_notification", {
            task_id: "mcp1",
            tool_use_id: "toolu_mcp",
            status: "stopped",
            summary: "Stopped",
          });
          yield level(options, []);
        });
        const client = await promptUntil(
          "idle end_turn [task_mcp1]",
          async (agent, sessionId, client) => {
            await expect(
              agent.request(v2.methods.agent.toolCall.cancel, {
                sessionId,
                toolCallId: "task_mcp1",
              }),
            ).resolves.toEqual({});
            expect(await stopped.promise).toBe("mcp1");
            await vi.waitFor(() => expect(backgroundTrace(client)).toContain("idle []"));
          },
        );

        const statuses = client.sessionUpdates.flatMap(({ update }) =>
          update.sessionUpdate === "tool_call_update" &&
          update.toolCallId === "task_mcp1" &&
          update.status
            ? [String(update.status)]
            : [],
        );
        expect(statuses).toEqual(["in_progress", "cancelled"]);
      });

      it("sends such a task's call before the state snapshot of session/resume", async () => {
        scriptTurns(lateTaskStarts);
        let resumed: v2.SessionUpdate[] = [];
        await promptUntil("idle end_turn [task_mcp1]", async (agent, sessionId, client) => {
          const before = client.sessionUpdates.length;
          await agent.request(v2.methods.agent.session.resume, { sessionId, cwd });
          resumed = client.sessionUpdates.slice(before).map(({ update }) => update);
        });

        expect(resumed).toEqual([
          expect.objectContaining({
            sessionUpdate: "tool_call_update",
            toolCallId: "task_mcp1",
            title: "Watch the build",
            kind: "other",
            status: "in_progress",
          }),
          {
            sessionUpdate: "tool_call_update",
            toolCallId: "task_mcp1",
            capabilities: { cancel: {} },
          },
          {
            sessionUpdate: "state_update",
            state: "idle",
            background: [{ type: "tool_call", toolCallId: "task_mcp1" }],
          },
        ]);
      });

      // No tool call started these, such as tasks that a hook started.
      it.each([
        {
          task: workflow,
          trace: ["running []", "running [task_wf1]", "idle end_turn [task_wf1]"],
          background: [{ type: "tool_call", toolCallId: "task_wf1" }],
        },
        // A watcher Claude Code started by itself is housekeeping.
        {
          task: monitor,
          trace: ["running []", "idle end_turn []"],
          background: [],
        },
      ])(
        "starts and lists a tool call for a $task.task_type task without such a call unless it is ambient",
        async ({ task, trace, background }) => {
          scriptTurns(async function* (options) {
            yield level(options, [task]);
            yield taskEvent(options, "task_started", task);
            yield result(options);
            yield idleState(options);
          });
          const client = await promptUntil(trace.at(-1)!);

          expect(backgroundTrace(client)).toEqual(trace);
          expect(client.updates("state_update").at(-1)).toMatchObject({ background });
        },
      );
    });

    it("rejects terminal/cancel with -32602 when the command ends before Claude Code stops it", async () => {
      const ended = Promise.withResolvers<void>();
      scriptTurns(async function* (options) {
        yield level(options, [{}]);
        yield taskStarted(options);
        yield bashUse(options);
        yield backgrounded(options);
        yield result(options);
        yield idleState(options);
        await ended.promise;
        yield* taskEnded(options);
        yield level(options, []);
      });
      let rejected: unknown;
      await promptUntil("idle end_turn [toolu_bg]", async (agent, sessionId, client) => {
        // The command ends while Claude Code handles the stop, which then
        // finds no task.
        sdk.stopTask = async () => {
          ended.resolve();
          await vi.waitFor(() => expect(backgroundTrace(client)).toContain("idle []"));
          throw new Error("No task bg1");
        };
        rejected = await agent
          .request(v2.methods.agent.terminal.cancel, { sessionId, terminalId: "toolu_bg" })
          .catch((error: unknown) => error);
      });

      expect(rejected).toMatchObject({ code: -32602 });
    });

    it("sends each listed terminal's current state before the state snapshot of session/resume", async () => {
      scriptTurns(async function* (options) {
        yield level(options, [{}]);
        yield taskStarted(options);
        yield bashUse(options);
        yield backgrounded(options);
        yield result(options);
        yield idleState(options);
      });
      let resumed: v2.SessionUpdate[] = [];
      await promptUntil("idle end_turn [toolu_bg]", async (agent, sessionId, client) => {
        const before = client.sessionUpdates.length;
        await agent.request(v2.methods.agent.session.resume, { sessionId, cwd });
        resumed = client.sessionUpdates.slice(before).map(({ update }) => update);
      });

      expect(resumed).toEqual([
        {
          sessionUpdate: "terminal_update",
          terminalId: "toolu_bg",
          command: "make test",
          capabilities: { cancel: {} },
        },
        {
          sessionUpdate: "state_update",
          state: "idle",
          background: [{ type: "terminal", terminalId: "toolu_bg" }],
        },
      ]);
    });
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
      cwd: "/project/.claude/worktrees/agent-1",
      state: { state: "running" as const },
    };
    expect(v2SessionUpdate(announcement)).toEqual(announcement);
    const cleared = { sessionUpdate: "subagent_update" as const, sessionId: "agent-1", cwd: null };
    expect(v2SessionUpdate(cleared)).toEqual(cleared);
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

  it("reports an empty legacy plan as the removal of the session's v2 plan", () => {
    expect(v2SessionUpdate({ sessionUpdate: "plan", entries: [] })).toEqual({
      sessionUpdate: "plan_removed",
      planId: "plan",
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

  it("resets the fields that a restarted tool call leaves out", () => {
    expect(
      v2RestartedToolCall({
        sessionUpdate: "tool_call",
        toolCallId: "t",
        title: "ls",
        kind: "execute",
        rawInput: { command: "ls" },
      }),
    ).toEqual({
      sessionUpdate: "tool_call_update",
      toolCallId: "t",
      title: "ls",
      kind: "execute",
      rawInput: { command: "ls" },
      name: null,
      status: null,
      content: null,
      locations: null,
      rawOutput: null,
    });
    // A `_meta: null` from `V2ToolCallMeta` clears the client's `_meta`, so it
    // stays, where the v2 form of a v1 report drops `null` fields.
    expect(
      v2RestartedToolCall({
        sessionUpdate: "tool_call",
        toolCallId: "t",
        title: "ls",
        status: "pending",
        content: [],
        _meta: null,
      }),
    ).toMatchObject({ status: "pending", content: [], locations: null, _meta: null });
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

  it("rejects audio prompt content, which the agent does not advertise", () => {
    expect(() =>
      v1PromptRequest({
        sessionId: "s",
        prompt: [{ type: "audio", data: "AAAA", mimeType: "audio/wav" }],
      }),
    ).toThrow(expect.objectContaining({ code: -32602, data: { type: "audio" } }));
  });

  it("rejects an empty prompt", () => {
    expect(() => v1PromptRequest({ sessionId: "s", prompt: [] })).toThrow(
      expect.objectContaining({ code: -32602, data: { prompt: [] } }),
    );
  });

  it("rejects an embedded blob that Claude cannot read, and passes one it can", () => {
    const prompt = (mimeType?: string) =>
      v1PromptRequest({
        sessionId: "s",
        prompt: [{ type: "resource", resource: { uri: "file:///work/a", blob: "AAAA", mimeType } }],
      }).prompt[0];
    expect(prompt("application/pdf")).toEqual({
      type: "resource",
      resource: { uri: "file:///work/a", blob: "AAAA", mimeType: "application/pdf" },
    });
    expect(() => prompt("application/zip")).toThrow(
      "Embedded blob resources of type application/zip are not supported",
    );
    expect(() => prompt("application/zip")).toThrow(expect.objectContaining({ code: -32602 }));
    expect(() => prompt()).toThrow("Embedded blob resources of type unknown are not supported");
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

  const GATEWAY = "https://gateway.example.com";
  const setGateway = (agent: v2.ClientContext) =>
    agent.request(v2.methods.agent.providers.set, {
      providerId: "main",
      apiType: "anthropic",
      baseUrl: GATEWAY,
    });

  /**
   * Claude Code echoes each prompt and answers it. A turn of a query without
   * the gateway's route waits for `release` first.
   */
  function answerEachPrompt(release: Promise<void>): Array<{ text: string; routed: boolean }> {
    const answered: Array<{ text: string; routed: boolean }> = [];
    sdk.run = async function* (prompts, options) {
      const routed = options.env?.ANTHROPIC_BASE_URL === GATEWAY;
      for await (const prompt of prompts) {
        yield {
          type: "user",
          message: prompt.message,
          parent_tool_use_id: null,
          uuid: prompt.uuid,
          session_id: options.sessionId,
          isReplay: true,
        };
        if (!routed) await release;
        const content = prompt.message.content;
        answered.push({
          text: typeof content === "string" ? content : (content[0] as { text: string }).text,
          routed,
        });
        yield assistantText(options, "done");
        yield result(options);
      }
    };
    return answered;
  }

  it("answers a provider set while a session works, and routes the session at its turn boundary", async () => {
    const release = Promise.withResolvers<void>();
    const answered = answerEachPrompt(release.promise);
    const client = v2Client();
    await client.app.connectWith(connectRouter(), async (agent) => {
      await initializeV2(agent);
      const { sessionId } = await agent.request(v2.methods.agent.session.new, { cwd });
      await agent.request(v2.methods.agent.session.setConfigOption, {
        sessionId,
        configId: "mode",
        type: "id",
        value: "acceptEdits",
      });
      await agent.request(v2.methods.agent.session.prompt, { sessionId, prompt: text("first") });
      await setGateway(agent);
      // The running turn keeps its query, and so does a prompt sent meanwhile.
      expect(sdk.queryOptions).toHaveLength(1);
      const second = agent.request(v2.methods.agent.session.prompt, {
        sessionId,
        prompt: text("second"),
      });
      // The second prompt reaches the session before the first turn ends.
      await new Promise((resolve) => setTimeout(resolve, 20));
      release.resolve();
      await second;
      await vi.waitFor(() => expect(sdk.queryOptions).toHaveLength(2));
      expect(sdk.queryOptions[1]).toMatchObject({
        resume: sessionId,
        env: { ANTHROPIC_BASE_URL: GATEWAY },
      });
      // A prompt during the restart goes to the new query.
      await agent.request(v2.methods.agent.session.prompt, { sessionId, prompt: text("third") });
      // The new query keeps the mode the client chose.
      expect(
        client
          .updates("config_option_update")
          .at(-1)
          ?.configOptions.find((option) => option.configId === "mode"),
      ).toMatchObject({ currentValue: "acceptEdits" });
      await vi.waitFor(() => expect(answered).toHaveLength(3));
      await client.authUpdate(1);
    });

    expect(answered).toEqual([
      { text: "first", routed: false },
      { text: "second", routed: false },
      { text: "third", routed: true },
    ]);
  });

  it.each([
    [
      "providers/disable",
      (agent: v2.ClientContext) =>
        agent.request(v2.methods.agent.providers.disable, { providerId: "main" }),
    ],
    ["auth/logout", (agent: v2.ClientContext) => agent.request(v2.methods.agent.auth.logout, {})],
  ])("routes a live session off the provider after %s", async (_method, leave) => {
    answerEachPrompt(Promise.resolve());
    const client = v2Client();
    await client.app.connectWith(connectRouter(), async (agent) => {
      await initializeV2(agent);
      await setGateway(agent);
      const { sessionId } = await agent.request(v2.methods.agent.session.new, { cwd });
      await leave(agent);
      expect(sdk.queryOptions.map((options) => options.env?.ANTHROPIC_BASE_URL)).toEqual([
        GATEWAY,
        undefined,
      ]);
      expect(sdk.queryOptions[1]).toMatchObject({ resume: sessionId });
      await client.authUpdate(1);
    });
  });

  it("routes only the sessions started after a gateway login", async () => {
    const client = v2Client();
    await client.app.connectWith(connectRouter(), async (agent) => {
      await initializeV2(agent, { auth: { _meta: { gateway: true } } });
      await agent.request(v2.methods.agent.session.new, { cwd });
      await agent.request(v2.methods.agent.auth.login, {
        methodId: "gateway",
        _meta: { gateway: { baseUrl: GATEWAY, headers: {} } },
      });
      await agent.request(v2.methods.agent.session.new, { cwd });
      await client.authUpdate(2);
    });

    expect(sdk.queryOptions.map((options) => options.env?.ANTHROPIC_BASE_URL)).toEqual([
      undefined,
      GATEWAY,
    ]);
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

  it("advertises auth.status, sends auth/status_update, and answers auth/status", async () => {
    const { app, authUpdate, acpAuthUpdates } = v2Client();
    const status = await app.connectWith(connectRouter(), async (agent) => {
      const response = await initializeV2(agent);
      expect(response.capabilities?.auth?.status).toEqual({});
      await authUpdate(1);
      return agent.request(v2.methods.agent.auth.status, {});
    });

    expect(status).toMatchObject({
      state: "authenticated",
      accounts: [{ active: true, email: "user@example.com" }],
    });
    // The same payload as the notification, and the unchanged read of
    // `auth/status` sent no second one.
    expect(acpAuthUpdates).toEqual([status]);
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

describe("ACP v2 subscription guard (--hide-claude-auth)", () => {
  const SUBSCRIPTION = {
    email: "user@example.com",
    subscriptionType: "max",
    apiProvider: "firstParty",
  };
  const API_KEY = { apiKeySource: "ANTHROPIC_API_KEY", apiProvider: "firstParty" };
  const NOT_SUPPORTED = { code: -32000, data: { reason: "claude_subscription_not_supported" } };

  beforeEach(() => {
    const argv = process.argv;
    process.argv = [...argv, "--hide-claude-auth"];
    // The guard judges the account that `claude auth status` reports. A
    // real-CLI run (`npm run test:integration`) would otherwise probe the
    // machine's own login, so these tests read only the scripted accounts.
    vi.stubEnv("CLAUDE_CODE_EXECUTABLE", "/usr/bin/false");
    return () => {
      process.argv = argv;
      vi.unstubAllEnvs();
    };
  });

  /** Each query caches the next of `accounts` at its start, and the last one after them. */
  function accountsAtStart(...accounts: Array<Record<string, unknown>>) {
    let started = 0;
    sdk.initializationResult = async () => ({
      ...(await sdkDefaults.initializationResult()),
      account: accounts[Math.min(started++, accounts.length - 1)],
    });
  }

  it.each([
    ["a subscription would pay", SUBSCRIPTION, NOT_SUPPORTED],
    ["the account holds no credential", {}, { code: -32000, data: undefined }],
  ])("refuses session/new when %s", async (_case, account, refusal) => {
    accountsAtStart(account);
    const client = v2Client();
    await client.app.connectWith(connectRouter(), async (agent) => {
      await initializeV2(agent);
      await expect(agent.request(v2.methods.agent.session.new, { cwd })).rejects.toMatchObject(
        refusal,
      );
    });
  });

  it("refuses a prompt before insertion when the cached account bills a subscription", async () => {
    accountsAtStart(API_KEY);
    const client = v2Client();
    await client.app.connectWith(connectRouter(), async (agent) => {
      await initializeV2(agent);
      const { sessionId } = await agent.request(v2.methods.agent.session.new, { cwd });
      sdk.accountInfo = async () => SUBSCRIPTION;
      await expect(
        agent.request(v2.methods.agent.session.prompt, { sessionId, prompt: text("hi") }),
      ).rejects.toMatchObject(NOT_SUPPORTED);
      await client.authUpdate(1);
    });

    expect(client.updates("user_message")).toEqual([]);
  });

  it.each([
    [
      "session/cancel",
      (agent: v2.ClientContext, sessionId: string) =>
        agent.notify(v2.methods.agent.session.cancel, { sessionId }),
    ],
    [
      "session/close",
      (agent: v2.ClientContext, sessionId: string) =>
        agent.request(v2.methods.agent.session.close, { sessionId }),
    ],
  ])("answers a prompt that the guard still judges with -32800 on %s", async (_method, stop) => {
    accountsAtStart(API_KEY);
    scriptTurns(async function* (options) {
      yield result(options);
    });
    const client = v2Client();
    await client.app.connectWith(connectRouter(), async (agent) => {
      await initializeV2(agent);
      const { sessionId } = await agent.request(v2.methods.agent.session.new, { cwd });
      const reading = Promise.withResolvers<void>();
      const account = Promise.withResolvers<Record<string, unknown>>();
      sdk.accountInfo = () => {
        reading.resolve();
        return account.promise;
      };
      const prompt = agent
        .request(v2.methods.agent.session.prompt, { sessionId, prompt: text("hi") })
        .catch((error: unknown) => error);
      await reading.promise;
      const stopped = stop(agent, sessionId);
      await new Promise((resolve) => setTimeout(resolve, 20));
      account.resolve(API_KEY);
      expect(await prompt).toMatchObject({ code: -32800 });
      await stopped;
      await client.authUpdate(1);
    });

    expect(client.updates("user_message")).toEqual([]);
  });

  it("starts the query again after a sign-out, and refuses the next prompt on the account it finds", async () => {
    accountsAtStart(API_KEY, SUBSCRIPTION);
    sdk.accountInfo = async () => API_KEY;
    scriptTurns(async function* (options) {
      yield result(options, { is_error: true, result: "Not logged in · Please run /login" });
    });
    const client = v2Client();
    await client.app.connectWith(connectRouter(), async (agent) => {
      await initializeV2(agent);
      const { sessionId } = await agent.request(v2.methods.agent.session.new, { cwd });
      await agent.request(v2.methods.agent.session.prompt, { sessionId, prompt: text("hi") });
      await vi.waitFor(() => expect(turnTrace(client.sessionUpdates)).toContain("idle error"));
      await expect(
        agent.request(v2.methods.agent.session.prompt, { sessionId, prompt: text("again") }),
      ).rejects.toMatchObject(NOT_SUPPORTED);
      expect(sdk.queryOptions).toHaveLength(2);
      expect(sdk.queryOptions[1]).toMatchObject({ resume: sessionId });
      await client.authUpdate(1);
    });

    expect(client.updates("user_message")).toHaveLength(1);
  });

  it("restarts the query for a provider change only after the account restart that runs", async () => {
    accountsAtStart(API_KEY);
    sdk.accountInfo = async () => API_KEY;
    scriptTurns(
      async function* (options) {
        yield result(options, { is_error: true, result: "Not logged in · Please run /login" });
      },
      async function* (options) {
        yield result(options);
      },
    );
    // Whether the prompt input of each query is still open: a session ends its query's input.
    const inputOpen: boolean[] = [];
    const run = sdk.run;
    sdk.run = (prompts, options) => {
      const index = inputOpen.push(true) - 1;
      return run(
        (async function* () {
          yield* prompts;
          inputOpen[index] = false;
        })(),
        options,
      );
    };
    const client = v2Client();
    await client.app.connectWith(connectRouter(), async (agent) => {
      await initializeV2(agent);
      const { sessionId } = await agent.request(v2.methods.agent.session.new, { cwd });
      await agent.request(v2.methods.agent.session.prompt, { sessionId, prompt: text("hi") });
      await vi.waitFor(() => expect(turnTrace(client.sessionUpdates)).toContain("idle error"));
      // The account restart's query takes a while to start.
      const started = Promise.withResolvers<void>();
      const initialization = sdk.initializationResult;
      sdk.initializationResult = async () => {
        await started.promise;
        return initialization();
      };
      const again = agent.request(v2.methods.agent.session.prompt, {
        sessionId,
        prompt: text("again"),
      });
      await vi.waitFor(() => expect(sdk.queryOptions).toHaveLength(2));
      // The session's account restart runs: the route restart is due after it.
      await agent.request(v2.methods.agent.providers.set, {
        providerId: "main",
        apiType: "anthropic",
        baseUrl: "https://gateway.example.com",
      });
      started.resolve();
      await again;
      // One query of the session is left: none of the others was left running.
      await vi.waitFor(() => expect(inputOpen).toHaveLength(3));
      await vi.waitFor(() => expect(inputOpen.filter((open) => open)).toHaveLength(1));
      await client.authUpdate(1);
    });
  });
});

describe("ACP v2 Remote Control", () => {
  const SESSION_URL = "https://claude.ai/code/session_123";

  beforeEach(() => {
    sdk.enableRemoteControl = vi.fn(async () => ({ session_url: SESSION_URL }));
  });

  it("lists /remote-control when the query serves Remote Control", async () => {
    const client = v2Client();
    const response = await client.app.connectWith(connectRouter(), async (agent) => {
      await initializeV2(agent);
      return agent.request(v2.methods.agent.session.new, { cwd });
    });

    expect(response.availableCommands).toContainEqual(
      expect.objectContaining({ type: "command", name: "remote-control" }),
    );
  });

  it("connects with /remote-control and answers with the session URL", async () => {
    const client = v2Client();
    const response = await client.app.connectWith(connectRouter(), async (agent) => {
      await initializeV2(agent);
      const { sessionId } = await agent.request(v2.methods.agent.session.new, { cwd });
      const response = await agent.request(v2.methods.agent.session.prompt, {
        sessionId,
        prompt: text("/remote-control laptop"),
      });
      await vi.waitFor(() => expect(sdk.enableRemoteControl).toHaveBeenCalled());
      await vi.waitFor(() => expect(turnTrace(client.sessionUpdates)).toContain("idle end_turn"));
      await client.authUpdate(1);
      return response;
    });

    expect(sdk.enableRemoteControl).toHaveBeenCalledExactlyOnceWith(true, "laptop");
    expect(client.updates("user_message")).toEqual([
      {
        sessionUpdate: "user_message",
        messageId: response.messageId,
        content: text("/remote-control laptop"),
      },
    ]);
    expect(client.updates("agent_message_chunk")[0].content).toMatchObject({
      text: expect.stringContaining(SESSION_URL),
    });
    // v2 asks a local command to report `running`, then `idle`.
    expect(turnTrace(client.sessionUpdates)).toEqual([
      "user_message",
      "running",
      "agent_message_chunk",
      "idle end_turn",
    ]);
  });

  // v2 asks that held prompts be inserted in the order received.
  it("inserts a prompt that the subscription guard judges before a /remote-control sent after it", async () => {
    const argv = process.argv;
    process.argv = [...argv, "--hide-claude-auth"];
    const apiKey = { apiKeySource: "ANTHROPIC_API_KEY", apiProvider: "firstParty" };
    sdk.initializationResult = async () => ({
      ...(await sdkDefaults.initializationResult()),
      account: apiKey,
    });
    const account = Promise.withResolvers<Record<string, unknown>>();
    sdk.accountInfo = () => account.promise;
    scriptTurns(async function* (options) {
      yield result(options);
    });
    const client = v2Client();
    try {
      await client.app.connectWith(connectRouter(), async (agent) => {
        await initializeV2(agent);
        const { sessionId } = await agent.request(v2.methods.agent.session.new, { cwd });
        const first = agent.request(v2.methods.agent.session.prompt, {
          sessionId,
          prompt: text("fix the bug"),
        });
        const command = agent.request(v2.methods.agent.session.prompt, {
          sessionId,
          prompt: text("/remote-control"),
        });
        await new Promise((resolve) => setTimeout(resolve, 20));
        account.resolve(apiKey);
        await Promise.all([first, command]);
        await vi.waitFor(() => expect(sdk.enableRemoteControl).toHaveBeenCalled());
        await client.authUpdate(1);
      });
    } finally {
      process.argv = argv;
    }

    expect(client.updates("user_message").map((message) => message.content)).toEqual([
      text("fix the bug"),
      text("/remote-control"),
    ]);
  });

  it("runs /remote-control sent while Claude works once the turn ends", async () => {
    const release = Promise.withResolvers<void>();
    scriptTurns(async function* (options) {
      await release.promise;
      yield result(options);
    });
    const client = v2Client();
    await client.app.connectWith(connectRouter(), async (agent) => {
      await initializeV2(agent);
      const { sessionId } = await agent.request(v2.methods.agent.session.new, { cwd });
      await agent.request(v2.methods.agent.session.prompt, { sessionId, prompt: text("work") });
      const command = agent.request(v2.methods.agent.session.prompt, {
        sessionId,
        prompt: text("/remote-control"),
      });
      // v2 asks to hold a prompt rather than reject it while Claude works.
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(sdk.enableRemoteControl).not.toHaveBeenCalled();
      release.resolve();
      await command;
      await vi.waitFor(() =>
        expect(turnTrace(client.sessionUpdates)).toEqual([
          "user_message",
          "running",
          "idle end_turn",
          "user_message",
          "running",
          "agent_message_chunk",
          "idle end_turn",
        ]),
      );
      await client.authUpdate(1);
    });
  });

  it("shows a message typed in another client of the session as a user message", async () => {
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
        origin: { kind: "human" },
      };
      yield result(options);
      // Claude Code echoes a prompt that a person typed in claude.ai, and runs it.
      yield {
        type: "user",
        message: { role: "user", content: [{ type: "text", text: "typed on my phone" }] },
        parent_tool_use_id: null,
        uuid: "remote-message",
        session_id: options.sessionId,
        isReplay: true,
        origin: { kind: "human" },
      };
      yield assistantText(options, "On it.", "msg_remote");
      yield result(options);
      while (!(await input.next()).done);
    };
    const client = v2Client();
    await client.app.connectWith(connectRouter(), async (agent) => {
      await initializeV2(agent);
      const { sessionId } = await agent.request(v2.methods.agent.session.new, { cwd });
      await agent.request(v2.methods.agent.session.prompt, { sessionId, prompt: text("hi") });
      await vi.waitFor(() => expect(client.updates("agent_message_chunk")).toHaveLength(1));
      await client.authUpdate(1);
    });

    // Only the other client's message: the echo of the session's own prompt is its user_message.
    expect(client.updates("user_message_chunk")).toEqual([
      {
        sessionUpdate: "user_message_chunk",
        messageId: "remote-message",
        content: { type: "text", text: "typed on my phone" },
      },
    ]);
  });
});

async function previewToolUse(
  options: Options,
  tool: { id: string; name: string; input: unknown; agentId?: string },
): Promise<void> {
  for (const matcher of options.hooks?.PreToolUse ?? []) {
    for (const hook of matcher.hooks) {
      await hook(
        {
          hook_event_name: "PreToolUse",
          session_id: options.sessionId!,
          transcript_path: path.join(cwd, "session.jsonl"),
          cwd,
          tool_name: tool.name,
          tool_input: tool.input,
          tool_use_id: tool.id,
          ...(tool.agentId ? { agent_id: tool.agentId } : {}),
        },
        tool.id,
        { signal: new AbortController().signal },
      );
    }
  }
}
