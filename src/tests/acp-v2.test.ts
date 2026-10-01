/**
 * The experimental draft ACP v2 surface, driven through the protocol router
 * with the SDK's own v1 and v2 client apps. The v2 client app validates every
 * response against the v2 schema, so a malformed v2 message fails the test.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as v1 from "@agentclientprotocol/sdk";
import * as v2 from "@agentclientprotocol/sdk/experimental/v2";
import type { ClaudeAcpAgent } from "../acp-agent.js";
import type { AuthStatusUpdateNotification } from "../auth-status.js";
import { acpProtocolRouter } from "../v2/run.js";
import packageJson from "../../package.json" with { type: "json" };

const execFileSpy = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return { ...actual, execFile: execFileSpy };
});

const CLI_SUBSCRIPTION = JSON.stringify({
  loggedIn: true,
  authMethod: "claude.ai",
  apiProvider: "firstParty",
  email: "user@example.com",
  subscriptionType: "max",
});

const V2_CLIENT_INFO = { name: "v2-test-client", version: "1.0.0" };

const agents: ClaudeAcpAgent[] = [];

beforeEach(() => {
  // `claude auth status --json` reports a subscription, `claude auth logout` succeeds.
  execFileSpy.mockImplementation((...invocation: unknown[]) => {
    const args = invocation[1] as string[];
    const callback = invocation[invocation.length - 1] as (...a: unknown[]) => void;
    callback(null, { stdout: args[1] === "status" ? CLI_SUBSCRIPTION : "", stderr: "" });
  });
});

afterEach(async () => {
  await Promise.all(agents.splice(0).map((agent) => agent.dispose()));
  execFileSpy.mockReset();
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

/** A v2 client app that collects every `_auth/status_update` it receives. */
function v2Client() {
  const authUpdates: AuthStatusUpdateNotification[] = [];
  let notifyAuthUpdate = () => {};
  const app = v2.client({ name: V2_CLIENT_INFO.name }).onNotification(
    "_auth/status_update",
    (params) => params as AuthStatusUpdateNotification,
    ({ params }) => {
      authUpdates.push(params);
      notifyAuthUpdate();
    },
  );
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
  return { app, authUpdate };
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
    // The v2 session baseline and the providers methods are not served yet.
    expect(response.capabilities?.session).toBeUndefined();
    expect(response.capabilities?.providers).toBeUndefined();
    expect(response.authMethods?.length).toBeGreaterThan(0);
    for (const method of response.authMethods ?? []) {
      expect(method).not.toHaveProperty("id");
      expect(method).toMatchObject({ methodId: expect.any(String), type: "terminal" });
      expect((method as v2.AuthMethodTerminal).args?.[0]).toBe("--cli");
    }
  });

  it("rejects v2 session methods, which the v2 surface does not serve yet", async () => {
    const { app, authUpdate } = v2Client();
    await app.connectWith(connectRouter(), async (agent) => {
      await agent.request(v2.methods.agent.initialize, {
        protocolVersion: v2.PROTOCOL_VERSION,
        info: V2_CLIENT_INFO,
      });
      await expect(
        agent.request(v2.methods.agent.session.new, { cwd: process.cwd() }),
      ).rejects.toMatchObject({ code: -32601 });
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
