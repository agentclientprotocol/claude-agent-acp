/**
 * The experimental draft ACP v2 surface, driven through the protocol router
 * with the SDK's own v1 and v2 client apps. The v2 client app validates every
 * response, session update, and elicitation it receives against the v2
 * schema, so a malformed v2 message fails the test.
 */
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as v1 from "@agentclientprotocol/sdk";
import * as v2 from "@agentclientprotocol/sdk/experimental/v2";
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
import { acpProtocolRouter } from "../serve.js";
import { clientSupportsNotices } from "../session-notices.js";
import { v1PermissionResponse, v2PermissionRequest } from "../v2/permission.js";
import { v1PromptRequest } from "../v2/prompt.js";
import { V2Terminals } from "../v2/terminal.js";
import { v2SessionUpdate } from "../v2/session-update.js";
import { v1SetSessionConfigOptionRequest, v2ConfigOptions } from "../v2/session.js";
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
function connectRouter(): v2.Stream {
  const toAgent = new TransformStream<v2.AnyWireMessage, v2.AnyWireMessage>();
  const toClient = new TransformStream<v2.AnyWireMessage, v2.AnyWireMessage>();
  acpProtocolRouter(undefined, (agent) => agents.push(agent)).connect({
    readable: toAgent.readable,
    writable: toClient.writable,
  });
  return { readable: toClient.readable, writable: toAgent.writable };
}

/**
 * A v2 client app that collects every `_auth/status_update`, session update,
 * elicitation, and permission request it receives, accepts every elicitation,
 * and answers permission requests with `answerPermission`.
 */
function v2Client({
  answerPermission = () => ({ outcome: { outcome: "cancelled" } }),
}: {
  answerPermission?: (request: v2.RequestPermissionRequest) => v2.RequestPermissionResponse;
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
      return { action: "accept" };
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
        sessionUpdate: "subagent_update",
        sessionId: "agent_n",
        state: { state: "idle" },
      }),
    ).toThrow("does not translate subagent_update session updates yet");
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
