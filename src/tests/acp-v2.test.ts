/**
 * The experimental draft ACP v2 surface, driven through the protocol router
 * with the SDK's own v1 and v2 client apps. The v2 client app validates every
 * response, session update, and elicitation it receives against the v2
 * schema, so a malformed v2 message fails the test.
 */
import { mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as v1 from "@agentclientprotocol/sdk";
import * as v2 from "@agentclientprotocol/sdk/experimental/v2";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import type { ClaudeAcpAgent } from "../acp-agent.js";
import type { AuthStatusUpdateNotification } from "../auth-status.js";
import { acpProtocolRouter } from "../serve.js";
import { clientSupportsNotices } from "../session-notices.js";
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
    query: ({ options }: { options: Options }) => {
      sdk.queryOptions.push(options);
      return makeMockQuery({
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
      });
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
 * and elicitation it receives, and accepts every elicitation.
 */
function v2Client() {
  const authUpdates: AuthStatusUpdateNotification[] = [];
  const sessionUpdates: v2.UpdateSessionNotification[] = [];
  const elicitations: v2.CreateElicitationRequest[] = [];
  const completedElicitations: v2.CompleteElicitationNotification[] = [];
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
  return { app, authUpdate, sessionUpdates, updates, elicitations, completedElicitations };
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
    // The whole v2 session baseline and the providers methods are not served yet.
    expect(response.capabilities?.session).toBeUndefined();
    expect(response.capabilities?.providers).toBeUndefined();
    expect(response.authMethods?.length).toBeGreaterThan(0);
    for (const method of response.authMethods ?? []) {
      expect(method).not.toHaveProperty("id");
      expect(method).toMatchObject({ methodId: expect.any(String), type: "terminal" });
      expect((method as v2.AuthMethodTerminal).args?.[0]).toBe("--cli");
    }
  });

  it("rejects v2 prompts, which the v2 surface does not serve yet", async () => {
    const { app, authUpdate } = v2Client();
    await app.connectWith(connectRouter(), async (agent) => {
      await initializeV2(agent);
      const { sessionId } = await agent.request(v2.methods.agent.session.new, { cwd });
      await expect(
        agent.request(v2.methods.agent.session.prompt, {
          sessionId,
          prompt: [{ type: "text", text: "hello" }],
        }),
      ).rejects.toMatchObject({ code: -32601 });
      await authUpdate(1);
    });
  });
});

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
      await vi.waitFor(() => expect(client.updates("available_commands_update")).toHaveLength(1));
      await client.authUpdate(1);
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
    expect(client.updates("available_commands_update")[0].availableCommands).toEqual([
      {
        name: "review",
        description: "Review a change",
        input: { type: "text", hint: "<pull request>" },
      },
      {
        name: "mcp",
        description:
          "Show the MCP servers and their status, or reconnect, enable, or disable a server",
        input: { type: "text", hint: "[reconnect|enable|disable [<server>|all]]" },
      },
    ]);
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

      await expect(
        agent.request(v2.methods.agent.session.resume, {
          sessionId,
          cwd,
          replayFrom: { type: "start" },
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

  it("tells the agent that a v2 client takes notices", async () => {
    const { app, authUpdate } = v2Client();
    await app.connectWith(connectRouter(), async (agent) => {
      await initializeV2(agent);
      await authUpdate(1);
    });
    expect(clientSupportsNotices(agents[0].clientCapabilities)).toBe(true);
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
      v2SessionUpdate({ sessionUpdate: "tool_call", toolCallId: "t", title: "Read" }),
    ).toThrow("does not translate tool_call session updates yet");
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
