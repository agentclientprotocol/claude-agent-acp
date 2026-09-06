import { randomUUID } from "node:crypto";
import { describe, expect, it, Mock, vi, afterEach, beforeEach } from "vitest";
import type { AccountInfo } from "@anthropic-ai/claude-agent-sdk";
import { AcpClient, ClaudeAcpAgent } from "../acp-agent.js";
import {
  billsClaudeSubscription,
  CLAUDE_LOGIN_REQUIRED_MESSAGE,
  CLAUDE_SUBSCRIPTION_NOT_SUPPORTED_MESSAGE,
  CLAUDE_SUBSCRIPTION_NOT_SUPPORTED_REASON,
} from "../hide-claude-auth.js";
import { SessionFailureController } from "../session-failure-extension.js";
import { DEFAULT_CONTEXT_USAGE, makeMockQuery } from "./helpers.js";

const mockQuery = vi.hoisted(() => vi.fn());

/** The real `process`. Several tests stub the global with a plain object
 *  spread, which drops the EventEmitter methods, so hold the original. */
const realProcess = process;

/** Yield one macrotask on real timers so Node can report an unhandled
 *  rejection. The suite runs on fake timers, so switch back afterwards. */
async function flushMacrotask(): Promise<void> {
  vi.useRealTimers();
  await new Promise((resolve) => setTimeout(resolve, 0));
  vi.useFakeTimers();
}

vi.mock("@anthropic-ai/claude-agent-sdk", async () => ({
  ...(await vi.importActual<typeof import("@anthropic-ai/claude-agent-sdk")>(
    "@anthropic-ai/claude-agent-sdk",
  )),
  query: mockQuery,
}));

/** The agent probes `claude auth status --json` at the start of every user
 *  prompt. Stub the exec so no test here spawns a real CLI: the probe is left
 *  hanging, which reports nothing and therefore never pushes an identity of its
 *  own. What these tests watch is the account the session and the guard
 *  report. */
const execFileSpy = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return { ...actual, execFile: execFileSpy };
});

describe("authorization", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Skip native-binary resolution; the exec itself is stubbed.
    process.env.CLAUDE_CODE_EXECUTABLE = "claude";
    execFileSpy.mockImplementation(
      (_file: string, args: string[], cb: (...a: unknown[]) => void) => {
        // `auth status` never answers, so the probe stays pending and silent.
        if (args[1] === "status") return;
        cb(null, { stdout: "", stderr: "" });
      },
    );
    // Set here (not in vi.fn(impl) at hoist time) so the helper import is
    // available; afterEach's resetAllMocks clears it, beforeEach re-sets it.
    mockQuery.mockImplementation(() =>
      makeMockQuery({
        initializationResult: async () => ({
          models: [
            {
              value: "id",
              displayName: "name",
              description: "description",
              supportsAutoMode: true,
            },
          ],
        }),
      }),
    );
  });

  afterEach(() => {
    //await all pending events like
    vi.runAllTimers();
    vi.useRealTimers();

    delete process.env.CLAUDE_CODE_EXECUTABLE;
    vi.unstubAllGlobals();
    vi.resetAllMocks();
  });

  /** Third element: the `extNotification` spy, so a test can read the
   *  `_auth/status_update` pushes the agent sent. */
  async function createAgentMock(): Promise<[ClaudeAcpAgent, Mock, Mock]> {
    const extNotification = vi.fn(async () => {});
    const connectionMock = {
      sessionUpdate: async (_: any) => {},
      extNotification,
    } as unknown as AcpClient;

    const agent = new ClaudeAcpAgent(connectionMock);

    return [agent, mockQuery, extNotification];
  }

  /** The `_auth/status_update` payloads pushed through an `extNotification` spy,
   *  in the order they were sent. */
  function authStatusUpdates(extNotification: Mock) {
    return extNotification.mock.calls
      .filter((call) => call[0] === "_auth/status_update")
      .map((call) => (call[1] as { authStatus: any }).authStatus);
  }

  it("gateway auth not offered without capability", async () => {
    const [agent] = await createAgentMock();

    const initializeResponse = await agent.initialize({
      protocolVersion: 1,
      clientCapabilities: {},
    });
    expect(initializeResponse.authMethods).not.toContainEqual(
      expect.objectContaining({ id: "gateway" }),
    );
    expect(initializeResponse.authMethods).not.toContainEqual(
      expect.objectContaining({ id: "gateway-bedrock" }),
    );
  });

  it("gateway auth offered when client advertises auth._meta.gateway capability", async () => {
    const [agent] = await createAgentMock();

    const initializeResponse = await agent.initialize({
      protocolVersion: 1,
      clientCapabilities: {
        auth: { _meta: { gateway: true } },
      } as any,
    });
    expect(initializeResponse.authMethods).toContainEqual(
      expect.objectContaining({
        id: "gateway",
        _meta: { gateway: { protocol: "anthropic" } },
      }),
    );
    expect(initializeResponse.authMethods).toContainEqual(
      expect.objectContaining({
        id: "gateway-bedrock",
        _meta: { gateway: { protocol: "bedrock" } },
      }),
    );
  });

  it("uses gateway env after anthropic gateway auth", async () => {
    const [agent, mockQuery] = await createAgentMock();

    const initializeResponse = await agent.initialize({
      protocolVersion: 1,
      clientCapabilities: {
        auth: { terminal: true, _meta: { gateway: true } },
      } as any,
    });
    expect(initializeResponse.authMethods).toContainEqual(
      expect.objectContaining({ id: "gateway" }),
    );

    await agent.authenticate({
      methodId: "gateway",
      _meta: { gateway: { baseUrl: "https://gateway.example", headers: { "x-api-key": "test" } } },
    });

    await agent.newSession({
      cwd: process.cwd(),
      mcpServers: [],
      _meta: {
        claudeCode: {
          options: {
            env: {
              userEnv: "userEnv",
            },
          },
        },
      },
    });

    expect(mockQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({
          env: expect.objectContaining({
            ANTHROPIC_AUTH_TOKEN: "acp-proxy",
            ANTHROPIC_BASE_URL: "https://gateway.example",
            ANTHROPIC_CUSTOM_HEADERS: "x-api-key: test",
            userEnv: "userEnv",
          }),
        }),
      }),
    );
  });

  it("uses gateway env after gateway auth", async () => {
    const [agent, mockQuery] = await createAgentMock();

    await agent.initialize({
      protocolVersion: 1,
      clientCapabilities: {
        auth: { terminal: true, _meta: { gateway: true } },
      } as any,
    });

    await agent.authenticate({
      methodId: "gateway-bedrock",
      _meta: {
        gateway: { baseUrl: "https://gateway.example", headers: { "custom-header": "test" } },
      },
    });

    await agent.newSession({
      cwd: process.cwd(),
      mcpServers: [],
    });

    expect(mockQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({
          env: expect.objectContaining({
            CLAUDE_CODE_USE_BEDROCK: "1",
            AWS_BEARER_TOKEN_BEDROCK: "acp-proxy",
            ANTHROPIC_BEDROCK_BASE_URL: "https://gateway.example",
            ANTHROPIC_CUSTOM_HEADERS: "custom-header: test",
          }),
        }),
      }),
    );
  });

  it("hide claude authentication without terminal-auth", async () => {
    const [agent] = await createAgentMock();
    vi.stubGlobal("process", { ...process, argv: ["--hide-claude-auth"] });

    const initializeResponse = await agent.initialize({
      protocolVersion: 1,
      clientCapabilities: {
        auth: { _meta: { gateway: true } },
      } as any,
    });
    expect(initializeResponse.authMethods).not.toContainEqual(
      expect.objectContaining({ id: "claude-ai-login" }),
    );
    expect(initializeResponse.authMethods).not.toContainEqual(
      expect.objectContaining({ id: "console-login" }),
    );
    expect(initializeResponse.authMethods).toContainEqual(
      expect.objectContaining({ id: "gateway" }),
    );
  });

  it("hide claude auth but still show console login when terminal-auth is set", async () => {
    const [agent] = await createAgentMock();
    vi.stubGlobal("process", { ...process, argv: ["--hide-claude-auth"] });

    const initializeResponse = await agent.initialize({
      protocolVersion: 1,
      clientCapabilities: {
        _meta: { "terminal-auth": true },
      },
    });
    expect(initializeResponse.authMethods).not.toContainEqual(
      expect.objectContaining({ id: "claude-ai-login" }),
    );
    expect(initializeResponse.authMethods).toContainEqual(
      expect.objectContaining({ id: "console-login" }),
    );
  });

  it("hide claude auth but still show console login with terminal capability", async () => {
    const [agent] = await createAgentMock();
    vi.stubGlobal("process", { ...process, argv: ["--hide-claude-auth"] });

    const initializeResponse = await agent.initialize({
      protocolVersion: 1,
      clientCapabilities: {
        auth: { terminal: true },
      },
    });
    expect(initializeResponse.authMethods).not.toContainEqual(
      expect.objectContaining({ id: "claude-ai-login" }),
    );
    expect(initializeResponse.authMethods).toContainEqual(
      expect.objectContaining({ id: "console-login" }),
    );
  });

  describe("--hide-claude-auth subscription guard", () => {
    const REASON = CLAUDE_SUBSCRIPTION_NOT_SUPPORTED_REASON;
    const MESSAGE = CLAUDE_SUBSCRIPTION_NOT_SUPPORTED_MESSAGE;
    const LOGIN_REQUIRED_MESSAGE = CLAUDE_LOGIN_REQUIRED_MESSAGE;
    const AUTH_REQUIRED_CODE = -32000;
    const INVALID_PARAMS_CODE = -32602;
    /** The refusal every client gets: the ACP auth error with the reason. */
    const refusal = {
      code: AUTH_REQUIRED_CODE,
      message: `Authentication required: ${MESSAGE}`,
      data: { reason: REASON },
    };
    /** The turn the mock query cannot run. `makeMockQuery` has no `next`, so a
     *  turn that the guard let through dies in the consumer with this error.
     *  Asserting it proves the guard passed instead of merely not refusing. */
    const MOCK_QUERY_TURN_ERROR = "session.query.next is not a function";
    const models = [
      { value: "id", displayName: "name", description: "description", supportsAutoMode: true },
    ];
    /** A session-creation account that passes the fail-closed check, so a test
     *  can drive the per-turn guard from a session that legally exists. */
    const SIGNED_IN_WITH_KEY = { apiKeySource: "ANTHROPIC_API_KEY" };

    function mockAccount(
      account: Record<string, unknown>,
      overrides: Record<string, unknown> = {},
    ) {
      mockQuery.mockImplementation(() =>
        makeMockQuery({
          initializationResult: async () => ({ models, account }),
          ...overrides,
        }),
      );
    }

    function hideClaudeAuth() {
      vi.stubGlobal("process", { ...process, argv: ["--hide-claude-auth"] });
    }

    const airSessionFailureCapabilities = {
      _meta: { jetbrains: { air: { version: 1, capabilities: ["sessionFailure"] } } },
    };

    /** An agent that records every `session/update` it sends. `capable` decides
     *  whether the client advertises the AIR session-failure capability. */
    function createRecordingAgent(
      capable: boolean,
      logger?: { log: (...args: any[]) => void; error: (...args: any[]) => void; warn?: any },
    ): [ClaudeAcpAgent, any[], Mock] {
      const updates: any[] = [];
      const extNotification = vi.fn(async () => {});
      const agent = new ClaudeAcpAgent(
        {
          sessionUpdate: async (update: any) => {
            updates.push(update);
          },
          extNotification,
        } as unknown as AcpClient,
        logger,
      );
      if (capable) {
        (agent as any).clientCapabilities = airSessionFailureCapabilities;
      }
      return [agent, updates, extNotification];
    }

    function failuresIn(updates: any[]) {
      return updates
        .map((update) => update.update?._meta?.jetbrains?.air?.sessionFailure)
        .filter(Boolean);
    }

    function newSessionParams() {
      return { cwd: process.cwd(), mcpServers: [] };
    }

    describe("billsClaudeSubscription", () => {
      /** Every member of the SDK's `ApiKeySource` enum, plus a value no
       *  current CLI emits: the field is an open `string`, so an unknown one
       *  must keep the guard on. */
      const API_KEY_SOURCES = [
        "ANTHROPIC_API_KEY",
        "apiKeyHelper",
        "/login managed key",
        "none",
        "user",
        "project",
        "org",
        "temporary",
        "oauth",
        "a-source-only-a-future-cli-emits",
      ];
      const OUTRANKS_SUBSCRIPTION = new Set([
        "ANTHROPIC_API_KEY",
        "apiKeyHelper",
        "/login managed key",
      ]);

      it.each(API_KEY_SOURCES)("classifies apiKeySource %s", (apiKeySource) => {
        const account = { subscriptionType: "pro", apiKeySource } satisfies AccountInfo;
        expect(billsClaudeSubscription(account)).toBe(!OUTRANKS_SUBSCRIPTION.has(apiKeySource));
      });

      /** Every member of the SDK's `apiProvider` enum. Only `firstParty` uses
       *  the Anthropic OAuth login the subscription belongs to. */
      const API_PROVIDERS = [
        "firstParty",
        "bedrock",
        "vertex",
        "foundry",
        "anthropicAws",
        "anthropicGoogleCloud",
        "mantle",
        "gateway",
      ] as const;

      it.each(API_PROVIDERS)("classifies apiProvider %s", (apiProvider) => {
        const account = { subscriptionType: "pro", apiProvider } satisfies AccountInfo;
        expect(billsClaudeSubscription(account)).toBe(apiProvider === "firstParty");
      });

      it("bills the subscription when apiProvider and apiKeySource are absent", () => {
        const account = { subscriptionType: "max" } satisfies AccountInfo;
        expect(billsClaudeSubscription(account)).toBe(true);
      });

      it("does not bill the subscription when a bearer token pays", () => {
        const account = {
          subscriptionType: "pro",
          tokenSource: "ANTHROPIC_AUTH_TOKEN",
          apiKeySource: "none",
        } satisfies AccountInfo;
        expect(billsClaudeSubscription(account)).toBe(false);
      });

      it("is false without a subscription", () => {
        expect(billsClaudeSubscription({} satisfies AccountInfo)).toBe(false);
        expect(billsClaudeSubscription(undefined)).toBe(false);
        const withKey = { apiKeySource: "ANTHROPIC_API_KEY" } satisfies AccountInfo;
        expect(billsClaudeSubscription(withKey)).toBe(false);
      });
    });

    describe("fails closed at session creation", () => {
      /** What the flag does with an account at session creation. */
      type Verdict = "subscription" | "signedOut" | "allowed";

      const CASES: Array<{ name: string; account: AccountInfo; verdict: Verdict }> = [
        { name: "a logged-out CLI", account: {}, verdict: "signedOut" },
        {
          name: "an account with no key in use",
          account: { apiKeySource: "none" },
          verdict: "signedOut",
        },
        {
          name: "a claude.ai subscription",
          account: { subscriptionType: "pro" },
          verdict: "subscription",
        },
        {
          name: "ANTHROPIC_API_KEY",
          account: { apiKeySource: "ANTHROPIC_API_KEY" },
          verdict: "allowed",
        },
        { name: "apiKeyHelper", account: { apiKeySource: "apiKeyHelper" }, verdict: "allowed" },
        {
          name: "a Console login",
          account: { apiKeySource: "/login managed key" },
          verdict: "allowed",
        },
        {
          name: "a bearer token",
          account: { tokenSource: "ANTHROPIC_AUTH_TOKEN" },
          verdict: "allowed",
        },
        { name: "bedrock", account: { apiProvider: "bedrock" }, verdict: "allowed" },
        { name: "vertex", account: { apiProvider: "vertex" }, verdict: "allowed" },
      ];

      async function assertVerdict(
        create: () => Promise<unknown>,
        verdict: Verdict,
      ): Promise<void> {
        if (verdict === "allowed") {
          await expect(create()).resolves.toMatchObject({ sessionId: expect.any(String) });
          return;
        }
        const error: any = await create().then(
          () => undefined,
          (thrown) => thrown,
        );
        expect(error).toBeDefined();
        expect(error.code).toBe(AUTH_REQUIRED_CODE);
        if (verdict === "subscription") {
          expect(error.message).toBe(`Authentication required: ${MESSAGE}`);
          expect(error.data).toEqual({ reason: REASON });
        } else {
          expect(error.message).toBe(`Authentication required: ${LOGIN_REQUIRED_MESSAGE}`);
          // The plain sign-out carries no reason: it is the state every ACP
          // client already answers with its own auth flow.
          expect(error.data).toBeUndefined();
        }
      }

      it.each(CASES)("refuses or allows $name", async ({ account, verdict }) => {
        const [agent] = await createAgentMock();
        hideClaudeAuth();
        mockAccount(account as Record<string, unknown>);

        await assertVerdict(() => agent.newSession(newSessionParams()), verdict);
      });

      it.each(CASES)("refuses or allows $name on loadSession", async ({ account, verdict }) => {
        const [agent] = await createAgentMock();
        hideClaudeAuth();
        mockAccount(account as Record<string, unknown>);

        await assertVerdict(
          () => agent.loadSession({ sessionId: randomUUID(), ...newSessionParams() }),
          verdict,
        );
      });

      it.each(CASES)("refuses or allows $name on resumeSession", async ({ account, verdict }) => {
        const [agent] = await createAgentMock();
        hideClaudeAuth();
        mockAccount(account as Record<string, unknown>);

        await assertVerdict(
          () => agent.resumeSession({ sessionId: randomUUID(), ...newSessionParams() }),
          verdict,
        );
      });

      it("allows a logged-out account while a provider override is active", async () => {
        const [agent] = await createAgentMock();
        hideClaudeAuth();
        mockAccount({});
        await agent.unstable_setProvider({
          providerId: "main",
          apiType: "anthropic",
          baseUrl: "https://gateway.example/v1",
          headers: {},
        });

        await expect(agent.newSession(newSessionParams())).resolves.toMatchObject({
          sessionId: expect.any(String),
        });
      });

      it("allows a logged-out account without the flag", async () => {
        const [agent] = await createAgentMock();
        mockAccount({});

        await expect(agent.newSession(newSessionParams())).resolves.toMatchObject({
          sessionId: expect.any(String),
        });
      });
    });

    describe("on session creation", () => {
      it("rejects like a logged-out agent, with the reason in data", async () => {
        const [agent] = await createAgentMock();
        hideClaudeAuth();
        mockAccount({ subscriptionType: "pro" });

        await expect(agent.newSession(newSessionParams())).rejects.toMatchObject(refusal);
      });

      it("reports the refused account before the refusal reaches the client", async () => {
        const [agent, , extNotification] = await createAgentMock();
        hideClaudeAuth();
        mockAccount({ subscriptionType: "pro" });

        // A refusal without an account behind it is unreadable in the UI, so
        // the identity must be on the wire before `newSession` rejects.
        const order: string[] = [];
        extNotification.mockImplementation(async (method: string) => {
          if (method === "_auth/status_update") order.push("update");
        });

        await agent.newSession(newSessionParams()).then(
          () => order.push("resolved"),
          () => order.push("rejected"),
        );

        expect(order).toEqual(["update", "rejected"]);
        expect(authStatusUpdates(extNotification)).toEqual([
          { kind: "account", label: "Claude Pro", account: { plan: "pro" } },
        ]);
      });

      it("rejects loadSession the same way", async () => {
        const [agent] = await createAgentMock();
        hideClaudeAuth();
        mockAccount({ subscriptionType: "pro" });

        await expect(
          agent.loadSession({ sessionId: randomUUID(), ...newSessionParams() }),
        ).rejects.toMatchObject(refusal);
      });

      it("rejects resumeSession the same way", async () => {
        const [agent] = await createAgentMock();
        hideClaudeAuth();
        mockAccount({ subscriptionType: "pro" });

        await expect(
          agent.resumeSession({ sessionId: randomUUID(), ...newSessionParams() }),
        ).rejects.toMatchObject(refusal);
      });

      it("allows a session without the flag", async () => {
        const [agent] = await createAgentMock();
        mockAccount({ subscriptionType: "pro" });

        await expect(agent.newSession(newSessionParams())).resolves.toMatchObject({
          sessionId: expect.any(String),
        });
      });

      it("allows a session when an API key pays next to a stored subscription", async () => {
        const [agent] = await createAgentMock();
        hideClaudeAuth();
        mockAccount({ subscriptionType: "pro", apiKeySource: "ANTHROPIC_API_KEY" });

        await expect(agent.newSession(newSessionParams())).resolves.toMatchObject({
          sessionId: expect.any(String),
        });
      });

      it("allows a session after gateway authenticate", async () => {
        const [agent] = await createAgentMock();
        hideClaudeAuth();
        mockAccount({ subscriptionType: "pro" });

        await agent.authenticate({
          methodId: "gateway",
          _meta: { gateway: { baseUrl: "https://gateway.example", headers: {} } },
        });

        await expect(agent.newSession(newSessionParams())).resolves.toMatchObject({
          sessionId: expect.any(String),
        });
      });

      it("allows a session after providers/set", async () => {
        const [agent] = await createAgentMock();
        hideClaudeAuth();
        mockAccount({ subscriptionType: "pro" });

        await agent.unstable_setProvider({
          providerId: "main",
          apiType: "anthropic",
          baseUrl: "https://gateway.example/v1",
          headers: {},
        });

        await expect(agent.newSession(newSessionParams())).resolves.toMatchObject({
          sessionId: expect.any(String),
        });
      });

      it("warns once when the CLI reports no account at all", async () => {
        const warnings: string[] = [];
        const [agent] = createRecordingAgent(false, {
          log: () => {},
          error: () => {},
          warn: (message: unknown) => warnings.push(String(message)),
        });
        hideClaudeAuth();
        mockQuery.mockImplementation(() =>
          makeMockQuery({ initializationResult: async () => ({ models }) }),
        );

        await expect(agent.newSession(newSessionParams())).resolves.toMatchObject({
          sessionId: expect.any(String),
        });
        expect(warnings.filter((message) => message.includes("guard is degraded"))).toHaveLength(1);
      });
    });

    describe("gateway authenticate validation", () => {
      it("accepts a call with no gateway payload and installs no override", async () => {
        const [agent] = await createAgentMock();

        // Historically a no-op: it stored a request that resolved to no
        // provider config. Clients that probe the method this way must keep
        // working, so this stays a success, not an `invalidParams`.
        await expect(agent.authenticate({ methodId: "gateway" } as any)).resolves.toBeUndefined();
        expect(agent.resolveProviderConfig()).toBeNull();

        await expect(
          agent.authenticate({ methodId: "gateway", _meta: {} } as any),
        ).resolves.toBeUndefined();
        expect(agent.resolveProviderConfig()).toBeNull();
      });

      it("keeps the guard on when no gateway payload was installed", async () => {
        const [agent] = await createAgentMock();
        hideClaudeAuth();
        mockAccount({ subscriptionType: "pro" });

        await expect(
          agent.authenticate({ methodId: "gateway", _meta: {} } as any),
        ).resolves.toBeUndefined();
        // No override is active, so the subscription guard still applies.
        await expect(agent.newSession(newSessionParams())).rejects.toMatchObject(refusal);
      });

      it("rejects a present but unusable gateway payload", async () => {
        const [agent] = await createAgentMock();

        await expect(
          agent.authenticate({ methodId: "gateway", _meta: { gateway: {} } } as any),
        ).rejects.toMatchObject({ code: INVALID_PARAMS_CODE });
        expect(agent.resolveProviderConfig()).toBeNull();
      });

      it("reports no identity for a gateway payload it rejected", async () => {
        const [agent, , extNotification] = await createAgentMock();

        await expect(
          agent.authenticate({
            methodId: "gateway",
            _meta: { gateway: { baseUrl: "not-a-url" } },
          } as any),
        ).rejects.toMatchObject({ code: INVALID_PARAMS_CODE });
        // The identity is assigned only after the payload was accepted and
        // stored, so a refused login leaves the reported state untouched.
        expect(authStatusUpdates(extNotification)).toEqual([]);
        expect(agent.currentAuthStatus).toBeUndefined();
      });

      it("rejects an empty baseUrl instead of disabling the guard", async () => {
        const [agent] = await createAgentMock();
        hideClaudeAuth();
        mockAccount({ subscriptionType: "pro" });

        await expect(
          agent.authenticate({
            methodId: "gateway",
            _meta: { gateway: { baseUrl: "", headers: {} } },
          } as any),
        ).rejects.toMatchObject({ code: INVALID_PARAMS_CODE });
        expect(agent.resolveProviderConfig()).toBeNull();
        // The rejected payload stored nothing, so the guard still applies.
        await expect(agent.newSession(newSessionParams())).rejects.toMatchObject(refusal);
      });
    });

    describe("on every prompt", () => {
      const promptParams = (sessionId: string) => ({
        sessionId,
        prompt: [{ type: "text" as const, text: "hello" }],
      });

      it("rejects a turn when the live account became a subscription", async () => {
        const [agent] = await createAgentMock();
        hideClaudeAuth();
        // Spawn-time account passes; the store changes underneath the session.
        const accountInfo = vi.fn(async () => ({ subscriptionType: "pro", apiKeySource: "none" }));
        mockAccount(SIGNED_IN_WITH_KEY, { accountInfo });
        const { sessionId } = await agent.newSession(newSessionParams());

        await expect(agent.prompt(promptParams(sessionId))).rejects.toMatchObject(refusal);
        expect(accountInfo).toHaveBeenCalledTimes(1);
        // Refused before anything reached the SDK: no turn was queued.
        expect(agent.sessions[sessionId].turnQueue ?? []).toHaveLength(0);
      });

      it("reports the account of a refused turn before the turn rejects", async () => {
        const [agent, , extNotification] = await createAgentMock();
        hideClaudeAuth();
        // Spawn-time account passes; the store changes underneath the session.
        mockAccount(SIGNED_IN_WITH_KEY, {
          accountInfo: async () => ({ subscriptionType: "pro" }),
        });
        const { sessionId } = await agent.newSession(newSessionParams());

        // Drop the create-time `api_key` push; this test is about the turn.
        extNotification.mockClear();
        const order: string[] = [];
        extNotification.mockImplementation(async (method: string) => {
          if (method === "_auth/status_update") order.push("update");
        });

        await agent.prompt(promptParams(sessionId)).then(
          () => order.push("resolved"),
          () => order.push("rejected"),
        );

        expect(order).toEqual(["update", "rejected"]);
        // The session was created on a key; the guard read the subscription
        // the store now holds, and that is what the client is told.
        expect(authStatusUpdates(extNotification)).toEqual([
          { kind: "account", label: "Claude Pro", account: { plan: "pro" } },
        ]);
      });

      it("publishes one session-scoped access failure for capable clients", async () => {
        const [agent, updates] = createRecordingAgent(true);
        hideClaudeAuth();
        mockAccount(SIGNED_IN_WITH_KEY, {
          accountInfo: async () => ({ subscriptionType: "pro", apiKeySource: "none" }),
        });
        const { sessionId } = await agent.newSession(newSessionParams());

        await expect(agent.prompt(promptParams(sessionId))).rejects.toMatchObject(refusal);
        await expect(agent.prompt(promptParams(sessionId))).rejects.toMatchObject(refusal);

        const failures = failuresIn(updates);
        expect(failures).toHaveLength(1);
        expect(failures[0]).toEqual(
          expect.objectContaining({
            category: "access",
            severity: "error",
            title: "Sign in to continue using Claude.",
            details: MESSAGE,
            reason: REASON,
            actions: ["login"],
          }),
        );
        expect(failures[0].turnId).toBeUndefined();
        expect([...agent.sessions[sessionId].sessionFailureState.active.values()]).toHaveLength(1);
      });

      it("gives a client without the capability the reason on the error only", async () => {
        const [agent, updates] = createRecordingAgent(false);
        hideClaudeAuth();
        mockAccount(SIGNED_IN_WITH_KEY, { accountInfo: async () => ({ subscriptionType: "pro" }) });
        const { sessionId } = await agent.newSession(newSessionParams());

        await expect(agent.prompt(promptParams(sessionId))).rejects.toMatchObject(refusal);
        expect(failuresIn(updates)).toEqual([]);
      });

      it("publishes one failure row for two concurrent prompts", async () => {
        const [agent, updates] = createRecordingAgent(true);
        hideClaudeAuth();
        mockAccount(SIGNED_IN_WITH_KEY, { accountInfo: async () => ({ subscriptionType: "pro" }) });
        const { sessionId } = await agent.newSession(newSessionParams());

        const outcomes = await Promise.allSettled([
          agent.prompt(promptParams(sessionId)),
          agent.prompt(promptParams(sessionId)),
        ]);

        expect(outcomes.map((outcome) => outcome.status)).toEqual(["rejected", "rejected"]);
        for (const outcome of outcomes) {
          expect((outcome as PromiseRejectedResult).reason).toMatchObject(refusal);
        }
        expect(failuresIn(updates)).toHaveLength(1);
      });

      it("survives a cancel that races the refused prompt", async () => {
        const unhandled: unknown[] = [];
        const onUnhandled = (error: unknown) => unhandled.push(error);
        realProcess.on("unhandledRejection", onUnhandled);
        try {
          const [agent] = createRecordingAgent(true);
          hideClaudeAuth();
          mockAccount(SIGNED_IN_WITH_KEY, {
            accountInfo: async () => ({ subscriptionType: "pro" }),
          });
          const { sessionId } = await agent.newSession(newSessionParams());

          const refused = agent.prompt(promptParams(sessionId));
          const cancelled = agent.cancel({ sessionId });

          await expect(refused).rejects.toMatchObject(refusal);
          await expect(cancelled).resolves.toBeUndefined();
          await flushMacrotask();
          expect(unhandled).toEqual([]);
        } finally {
          realProcess.off("unhandledRejection", onUnhandled);
        }
      });

      it("does not probe the account when a provider override is active", async () => {
        const [agent] = await createAgentMock();
        hideClaudeAuth();
        const accountInfo = vi.fn(async () => ({ subscriptionType: "pro" }));
        mockAccount(SIGNED_IN_WITH_KEY, { accountInfo });
        await agent.unstable_setProvider({
          providerId: "main",
          apiType: "anthropic",
          baseUrl: "https://gateway.example/v1",
          headers: {},
        });
        const { sessionId } = await agent.newSession(newSessionParams());

        await expect(agent.prompt(promptParams(sessionId))).rejects.toThrow(MOCK_QUERY_TURN_ERROR);
        expect(accountInfo).not.toHaveBeenCalled();
      });

      it("does not probe the account without the flag", async () => {
        const [agent] = await createAgentMock();
        const accountInfo = vi.fn(async () => ({ subscriptionType: "pro" }));
        mockAccount(SIGNED_IN_WITH_KEY, { accountInfo });
        const { sessionId } = await agent.newSession(newSessionParams());

        await expect(agent.prompt(promptParams(sessionId))).rejects.toThrow(MOCK_QUERY_TURN_ERROR);
        expect(accountInfo).not.toHaveBeenCalled();
      });

      it("lets the turn through when the live account is not a subscription", async () => {
        const [agent] = await createAgentMock();
        hideClaudeAuth();
        const accountInfo = vi.fn(async () => ({ apiKeySource: "ANTHROPIC_API_KEY" }));
        mockAccount(SIGNED_IN_WITH_KEY, { accountInfo });
        const { sessionId } = await agent.newSession(newSessionParams());

        await expect(agent.prompt(promptParams(sessionId))).rejects.toThrow(MOCK_QUERY_TURN_ERROR);
        expect(accountInfo).toHaveBeenCalledTimes(1);
      });

      it("fails open when the CLI cannot answer accountInfo", async () => {
        const [agent] = await createAgentMock();
        hideClaudeAuth();
        mockAccount(SIGNED_IN_WITH_KEY, {
          accountInfo: async () => {
            throw new Error("unsupported control request");
          },
        });
        const { sessionId } = await agent.newSession(newSessionParams());

        await expect(agent.prompt(promptParams(sessionId))).rejects.toThrow(MOCK_QUERY_TURN_ERROR);
      });

      it("fails open and warns once when the SDK has no accountInfo", async () => {
        const warnings: string[] = [];
        const [agent] = createRecordingAgent(false, {
          log: () => {},
          error: () => {},
          warn: (message: unknown) => warnings.push(String(message)),
        });
        hideClaudeAuth();
        mockAccount({ apiKeySource: "ANTHROPIC_API_KEY" });
        const { sessionId } = await agent.newSession(newSessionParams());

        const outcomes = await Promise.allSettled([
          agent.prompt(promptParams(sessionId)),
          agent.prompt(promptParams(sessionId)),
        ]);

        for (const outcome of outcomes) {
          expect(outcome.status).toBe("rejected");
          expect((outcome as PromiseRejectedResult).reason).toMatchObject({
            message: expect.stringContaining(MOCK_QUERY_TURN_ERROR),
          });
        }
        expect(warnings.filter((message) => message.includes("guard is degraded"))).toHaveLength(1);
      });
    });

    describe("respawns after a mid-session sign-out", () => {
      const promptParams = (sessionId: string) => ({
        sessionId,
        prompt: [{ type: "text" as const, text: "hello" }],
      });

      /** The CLI's sign-out report: an error-shaped result whose text is the
       *  TUI advice the live loop maps to `auth_required`. */
      const signOutResult = () => ({
        type: "result" as const,
        subtype: "success" as const,
        stop_reason: null,
        is_error: true,
        result: "Not logged in · Please run /login",
        errors: [],
        duration_ms: 0,
        duration_api_ms: 0,
        num_turns: 1,
        total_cost_usd: 0,
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
        modelUsage: {},
        permission_denials: [],
        uuid: randomUUID(),
        session_id: "test-session",
      });

      const successResult = () => ({
        ...signOutResult(),
        is_error: false,
        stop_reason: "end_turn",
        result: "done",
      });

      /** One scripted SDK query. It echoes each pushed user message, then emits
       *  the messages the script holds for that turn, so a real `newSession` +
       *  `prompt` round trip runs against it. */
      function scriptedQuery(args: any, account: Record<string, unknown>, script: any[][]) {
        const input = args.prompt;
        const turns = [...script];
        async function* messages() {
          const iterator = input[Symbol.asyncIterator]();
          for (;;) {
            const { value, done } = await iterator.next();
            if (done || !value) return;
            yield {
              type: "user",
              message: value.message,
              parent_tool_use_id: null,
              uuid: value.uuid,
              session_id: "test-session",
              isReplay: true,
            };
            for (const message of turns.shift() ?? []) yield message;
          }
        }
        const query: any = messages();
        query.initializationResult = async () => ({ models, account });
        query.accountInfo = async () => account;
        query.setModel = async () => {};
        query.setPermissionMode = async () => {};
        query.supportedCommands = async () => [];
        query.mcpServerStatus = async () => [];
        query.getContextUsage = async () => DEFAULT_CONTEXT_USAGE;
        query.close = vi.fn();
        query.interrupt = vi.fn(async () => {});
        query.stopTask = vi.fn(async () => {});
        return query;
      }

      /** Script the successive `query()` calls: the first builds the session
       *  that signs out, each later one is a respawn. */
      function mockQueries(
        ...spawns: Array<{ account: Record<string, unknown>; script: any[][] }>
      ) {
        let spawn = 0;
        mockQuery.mockImplementation((args: any) => {
          const current = spawns[Math.min(spawn, spawns.length - 1)];
          spawn += 1;
          return scriptedQuery(args, current.account, current.script);
        });
      }

      /** Create a session, run one turn, and let the CLI sign out during it. */
      async function signOutDuringTurn(agent: ClaudeAcpAgent) {
        const { sessionId } = await agent.newSession(newSessionParams());
        await expect(agent.prompt(promptParams(sessionId))).rejects.toMatchObject({
          code: AUTH_REQUIRED_CODE,
        });
        expect(agent.sessions[sessionId].needsSignOutRespawn).toBe(true);
        expect(agent.sessions[sessionId].queryClosed).toBe(true);
        return sessionId;
      }

      it("refuses the next turn when the CLI now holds a subscription", async () => {
        const [agent, updates] = createRecordingAgent(true);
        hideClaudeAuth();
        mockQueries(
          { account: SIGNED_IN_WITH_KEY, script: [[signOutResult()]] },
          { account: { subscriptionType: "pro" }, script: [] },
        );
        const sessionId = await signOutDuringTurn(agent);

        await expect(agent.prompt(promptParams(sessionId))).rejects.toMatchObject(refusal);
        // The respawn ran, resuming the same Claude session so history is kept.
        expect(mockQuery).toHaveBeenCalledTimes(2);
        expect(mockQuery.mock.calls[1][0].options).toMatchObject({ resume: sessionId });
        // The refusal keeps the husk, so the client can sign in and retry here.
        expect(agent.sessions[sessionId]).toBeDefined();
        expect(failuresIn(updates).filter((failure) => failure.kind !== "advisory")).toHaveLength(
          1,
        );
      });

      it("proceeds when the CLI now holds a key, on a clean failure state", async () => {
        const [agent] = createRecordingAgent(true);
        hideClaudeAuth();
        mockQueries(
          { account: SIGNED_IN_WITH_KEY, script: [[signOutResult()]] },
          { account: SIGNED_IN_WITH_KEY, script: [[successResult()]] },
        );
        const sessionId = await signOutDuringTurn(agent);

        await expect(agent.prompt(promptParams(sessionId))).resolves.toMatchObject({
          stopReason: "end_turn",
        });
        expect(mockQuery).toHaveBeenCalledTimes(2);
        const respawned = agent.sessions[sessionId];
        expect(respawned.needsSignOutRespawn).toBeUndefined();
        expect(respawned.queryClosed).toBeUndefined();
        // The recreated session starts with no active failure: the sign-out
        // row belonged to the query that is gone.
        expect([...respawned.sessionFailureState.active.values()]).toHaveLength(0);
      });

      it("refuses with the plain error and no second row when still signed out", async () => {
        const [agent, updates] = createRecordingAgent(true);
        hideClaudeAuth();
        mockQueries(
          { account: SIGNED_IN_WITH_KEY, script: [[signOutResult()]] },
          { account: {}, script: [] },
        );
        const sessionId = await signOutDuringTurn(agent);
        const rowsAfterSignOut = failuresIn(updates).length;

        const error: any = await agent.prompt(promptParams(sessionId)).then(
          () => undefined,
          (thrown) => thrown,
        );
        expect(error.code).toBe(AUTH_REQUIRED_CODE);
        expect(error.message).toBe(`Authentication required: ${LOGIN_REQUIRED_MESSAGE}`);
        expect(error.data).toBeUndefined();
        expect(failuresIn(updates)).toHaveLength(rowsAfterSignOut);
      });

      it("shares one respawn between two prompts", async () => {
        const [agent] = createRecordingAgent(true);
        hideClaudeAuth();
        mockQueries(
          { account: SIGNED_IN_WITH_KEY, script: [[signOutResult()]] },
          { account: { subscriptionType: "pro" }, script: [] },
        );
        const sessionId = await signOutDuringTurn(agent);

        const outcomes = await Promise.allSettled([
          agent.prompt(promptParams(sessionId)),
          agent.prompt(promptParams(sessionId)),
        ]);

        expect(outcomes.map((outcome) => outcome.status)).toEqual(["rejected", "rejected"]);
        for (const outcome of outcomes) {
          expect((outcome as PromiseRejectedResult).reason).toMatchObject(refusal);
        }
        // One respawn, not two.
        expect(mockQuery).toHaveBeenCalledTimes(2);
      });

      it("reports the identity the respawned session logged back in with", async () => {
        const [agent, , extNotification] = createRecordingAgent(true);
        hideClaudeAuth();
        // Signed out on a key from the environment, back in on a helper key.
        mockQueries(
          { account: SIGNED_IN_WITH_KEY, script: [[signOutResult()]] },
          { account: { apiKeySource: "apiKeyHelper" }, script: [[successResult()]] },
        );
        const sessionId = await signOutDuringTurn(agent);

        await expect(agent.prompt(promptParams(sessionId))).resolves.toMatchObject({
          stopReason: "end_turn",
        });

        // The respawn runs a full `createSession`, which reports the new
        // account by itself — no CLI probe is needed for the post-login state.
        expect(authStatusUpdates(extNotification)).toEqual([
          { kind: "api_key", label: "Anthropic API key", detail: "ANTHROPIC_API_KEY" },
          { kind: "api_key", label: "Anthropic API key", detail: "apiKeyHelper" },
        ]);
      });

      it("answers a cancel during the dead state", async () => {
        const [agent] = createRecordingAgent(true);
        hideClaudeAuth();
        mockQueries(
          { account: SIGNED_IN_WITH_KEY, script: [[signOutResult()]] },
          { account: SIGNED_IN_WITH_KEY, script: [[successResult()]] },
        );
        const sessionId = await signOutDuringTurn(agent);

        await expect(agent.cancel({ sessionId })).resolves.toBeUndefined();
        expect(agent.sessions[sessionId].needsSignOutRespawn).toBe(true);
      });

      it("leaves the session alone without the flag", async () => {
        const [agent] = createRecordingAgent(true);
        mockQueries({ account: SIGNED_IN_WITH_KEY, script: [[signOutResult()]] });
        const { sessionId } = await agent.newSession(newSessionParams());

        await expect(agent.prompt(promptParams(sessionId))).rejects.toMatchObject({
          code: AUTH_REQUIRED_CODE,
        });
        expect(agent.sessions[sessionId].needsSignOutRespawn).toBeUndefined();
        expect(mockQuery).toHaveBeenCalledTimes(1);
      });

      /** The CLI writes a conversation only after a turn produced something.
       *  A session that signed out on its very first turn has none, so its
       *  `resume` fails. `initError` is how that reaches `createSession`. */
      function mockQuerySpawns(
        ...spawns: Array<{
          account?: Record<string, unknown>;
          script?: any[][];
          initError?: Error;
        }>
      ) {
        let spawn = 0;
        mockQuery.mockImplementation((args: any) => {
          const current = spawns[Math.min(spawn, spawns.length - 1)];
          spawn += 1;
          const query = scriptedQuery(
            args,
            current.account ?? SIGNED_IN_WITH_KEY,
            current.script ?? [],
          );
          if (current.initError) {
            const error = current.initError;
            query.initializationResult = async () => {
              throw error;
            };
          }
          return query;
        });
      }

      const NO_CONVERSATION = () => new Error("No conversation found with session ID abc-123-def");

      it("starts a fresh query when the conversation was never persisted", async () => {
        const [agent] = createRecordingAgent(true);
        hideClaudeAuth();
        mockQuerySpawns(
          { account: SIGNED_IN_WITH_KEY, script: [[signOutResult()]] },
          { initError: NO_CONVERSATION() },
          { account: SIGNED_IN_WITH_KEY, script: [[successResult()]] },
        );
        const sessionId = await signOutDuringTurn(agent);

        await expect(agent.prompt(promptParams(sessionId))).resolves.toMatchObject({
          stopReason: "end_turn",
        });

        // Resume, then the fallback: a NEW conversation under the same id.
        expect(mockQuery).toHaveBeenCalledTimes(3);
        const fallback = mockQuery.mock.calls[2][0].options;
        expect(fallback.sessionId).toBe(sessionId);
        expect(fallback.resume).toBeUndefined();
        expect(agent.sessions[sessionId]).toBeDefined();
      });

      it("refuses the fresh query when the guard rejects the new account", async () => {
        const [agent] = createRecordingAgent(true);
        hideClaudeAuth();
        mockQuerySpawns(
          { account: SIGNED_IN_WITH_KEY, script: [[signOutResult()]] },
          { initError: NO_CONVERSATION() },
          { account: { subscriptionType: "pro" }, script: [] },
        );
        const sessionId = await signOutDuringTurn(agent);

        await expect(agent.prompt(promptParams(sessionId))).rejects.toMatchObject(refusal);
        // The husk stays addressable: the next prompt meets the guard again,
        // not "Session not found".
        await expect(agent.prompt(promptParams(sessionId))).rejects.toMatchObject(refusal);
        expect(agent.sessions[sessionId]).toBeDefined();
      });

      it("does not retry a resume that failed for another reason", async () => {
        const [agent] = createRecordingAgent(true);
        hideClaudeAuth();
        mockQuerySpawns(
          { account: SIGNED_IN_WITH_KEY, script: [[signOutResult()]] },
          { initError: new Error("boom") },
        );
        const sessionId = await signOutDuringTurn(agent);

        await expect(agent.prompt(promptParams(sessionId))).rejects.toThrow("boom");
        // One recreate attempt, no fallback.
        expect(mockQuery).toHaveBeenCalledTimes(2);
      });

      describe("recreates when the start-of-prompt probe finds another identity", () => {
        /** `claude auth status --json` on a claude.ai subscription. */
        const PROBE_SUBSCRIPTION = JSON.stringify({
          loggedIn: true,
          authMethod: "claude.ai",
          apiProvider: "firstParty",
          subscriptionType: "max",
          email: "x@y",
        });
        /** The same kind of identity the session was created on. */
        const PROBE_KEY = JSON.stringify({
          loggedIn: true,
          apiKeySource: "ANTHROPIC_API_KEY",
          apiProvider: "firstParty",
        });
        /** An OAuth token names no identity: `accountInfoHasIdentitySignal`
         *  ignores `tokenSource`, so the session gets no `accountKind`. */
        const SIGNED_IN_WITH_TOKEN = { tokenSource: "CLAUDE_CODE_OAUTH_TOKEN" };

        /** What the fake `claude auth status --json` prints. `undefined` keeps
         *  the outer stub, where the probe never answers at all. */
        let probeStdout: string | undefined;

        beforeEach(() => {
          probeStdout = undefined;
          execFileSpy.mockImplementation((...invocation: unknown[]) => {
            const args = invocation[1] as string[];
            const cb = invocation[invocation.length - 1] as (...a: unknown[]) => void;
            if (args[1] === "status") {
              if (probeStdout !== undefined) cb(null, { stdout: probeStdout, stderr: "" });
              return;
            }
            cb(null, { stdout: "", stderr: "" });
          });
        });

        /** The probe is never awaited, so let its promise chain run. */
        async function settleProbe() {
          for (let round = 0; round < 5; round++) await vi.advanceTimersByTimeAsync(0);
        }

        function deferred() {
          let resolve!: () => void;
          const promise = new Promise<void>((settle) => (resolve = settle));
          return { promise, resolve };
        }

        /** Spawn scripting whose FIRST query hangs after echoing the prompt,
         *  until `held` resolves. That is the window in which the probe lands:
         *  the turn is live and producing. Later spawns are ordinary scripted
         *  queries, so the respawn behaves as everywhere else. */
        function mockHeldFirstTurn(
          account: Record<string, unknown>,
          held: Promise<void>,
          ...later: Array<{ account: Record<string, unknown>; script: any[][] }>
        ) {
          let spawn = 0;
          mockQuery.mockImplementation((args: any) => {
            const index = spawn++;
            if (index > 0) {
              const next = later[Math.min(index - 1, later.length - 1)];
              return scriptedQuery(args, next.account, next.script);
            }
            const input = args.prompt;
            async function* messages() {
              const iterator = input[Symbol.asyncIterator]();
              for (;;) {
                const { value, done } = await iterator.next();
                if (done || !value) return;
                yield {
                  type: "user",
                  message: value.message,
                  parent_tool_use_id: null,
                  uuid: value.uuid,
                  session_id: "test-session",
                  isReplay: true,
                };
                await held;
                yield successResult();
              }
            }
            const query: any = messages();
            query.initializationResult = async () => ({ models, account });
            query.accountInfo = async () => account;
            query.setModel = async () => {};
            query.setPermissionMode = async () => {};
            query.supportedCommands = async () => [];
            query.mcpServerStatus = async () => [];
            query.getContextUsage = async () => DEFAULT_CONTEXT_USAGE;
            query.close = vi.fn();
            query.interrupt = vi.fn(async () => {});
            query.stopTask = vi.fn(async () => {});
            return query;
          });
        }

        it("lets the marked turn finish and recreates at the NEXT prompt", async () => {
          // The probe now fires at the start of the prompt, so its answer
          // usually arrives while that very turn is still running. The mark is
          // a flag and nothing more: the turn keeps its query to the end, and
          // only the following prompt consumes it.
          const [agent] = createRecordingAgent(true);
          hideClaudeAuth();
          probeStdout = PROBE_SUBSCRIPTION;
          const held = deferred();
          mockHeldFirstTurn(SIGNED_IN_WITH_KEY, held.promise, {
            account: { subscriptionType: "pro" },
            script: [],
          });
          const { sessionId } = await agent.newSession(newSessionParams());

          const turn = agent.prompt(promptParams(sessionId));
          await settleProbe();

          // Marked mid-turn, but the query is untouched and no respawn ran.
          expect(agent.sessions[sessionId].needsSignOutRespawn).toBe(true);
          expect(agent.sessions[sessionId].queryClosed).toBeFalsy();
          expect(mockQuery).toHaveBeenCalledTimes(1);

          held.resolve();
          await expect(turn).resolves.toMatchObject({ stopReason: "end_turn" });
          // The turn completed on the query it started on.
          expect(mockQuery).toHaveBeenCalledTimes(1);

          // Now the boundary: the next prompt recreates and the creation guard
          // judges the subscription the CLI swapped in.
          await expect(agent.prompt(promptParams(sessionId))).rejects.toMatchObject(refusal);
          expect(mockQuery).toHaveBeenCalledTimes(2);
          expect(mockQuery.mock.calls[1][0].options).toMatchObject({ resume: sessionId });
        });

        it("marks the session when the probe kind differs from the account", async () => {
          const [agent] = createRecordingAgent(true);
          hideClaudeAuth();
          probeStdout = PROBE_SUBSCRIPTION;
          mockQueries(
            { account: SIGNED_IN_WITH_KEY, script: [[successResult()]] },
            { account: { subscriptionType: "pro" }, script: [] },
          );
          const { sessionId } = await agent.newSession(newSessionParams());

          await expect(agent.prompt(promptParams(sessionId))).resolves.toMatchObject({
            stopReason: "end_turn",
          });
          await settleProbe();
          expect(agent.sessions[sessionId].needsSignOutRespawn).toBe(true);

          // The probe refuses nothing itself: the next prompt recreates the
          // query, and the creation guard judges the account it reports.
          await expect(agent.prompt(promptParams(sessionId))).rejects.toMatchObject(refusal);
          expect(mockQuery).toHaveBeenCalledTimes(2);
          expect(mockQuery.mock.calls[1][0].options).toMatchObject({ resume: sessionId });
        });

        it("leaves the session alone when the probe finds the same kind", async () => {
          const [agent] = createRecordingAgent(true);
          hideClaudeAuth();
          probeStdout = PROBE_KEY;
          mockQueries({
            account: SIGNED_IN_WITH_KEY,
            script: [[successResult()], [successResult()]],
          });
          const { sessionId } = await agent.newSession(newSessionParams());

          await expect(agent.prompt(promptParams(sessionId))).resolves.toMatchObject({
            stopReason: "end_turn",
          });
          await settleProbe();
          expect(agent.sessions[sessionId].needsSignOutRespawn).toBeUndefined();

          await expect(agent.prompt(promptParams(sessionId))).resolves.toMatchObject({
            stopReason: "end_turn",
          });
          expect(mockQuery).toHaveBeenCalledTimes(1);
        });

        it("never marks a session without the flag", async () => {
          const [agent] = createRecordingAgent(true);
          probeStdout = PROBE_SUBSCRIPTION;
          mockQueries({
            account: SIGNED_IN_WITH_KEY,
            script: [[successResult()], [successResult()]],
          });
          const { sessionId } = await agent.newSession(newSessionParams());

          await expect(agent.prompt(promptParams(sessionId))).resolves.toMatchObject({
            stopReason: "end_turn",
          });
          await settleProbe();

          expect(agent.sessions[sessionId].needsSignOutRespawn).toBeUndefined();
          await expect(agent.prompt(promptParams(sessionId))).resolves.toMatchObject({
            stopReason: "end_turn",
          });
          expect(mockQuery).toHaveBeenCalledTimes(1);
        });

        it("never marks a session whose account named no identity", async () => {
          const [agent] = createRecordingAgent(true);
          hideClaudeAuth();
          probeStdout = PROBE_SUBSCRIPTION;
          mockQueries({
            account: SIGNED_IN_WITH_TOKEN,
            script: [[successResult()], [successResult()]],
          });
          const { sessionId } = await agent.newSession(newSessionParams());

          await expect(agent.prompt(promptParams(sessionId))).resolves.toMatchObject({
            stopReason: "end_turn",
          });
          await settleProbe();

          // Nothing to compare: an absent kind is not a mismatch.
          expect(agent.sessions[sessionId].accountKind).toBeUndefined();
          expect(agent.sessions[sessionId].needsSignOutRespawn).toBeUndefined();
          await expect(agent.prompt(promptParams(sessionId))).resolves.toMatchObject({
            stopReason: "end_turn",
          });
          expect(mockQuery).toHaveBeenCalledTimes(1);
        });
      });
    });

    describe("reason-aware failure dedupe", () => {
      /** A controller on the session's own state, publishing through the same
       *  client, so its rows land in the same `updates` array the agent uses. */
      function controllerFor(agent: ClaudeAcpAgent, sessionId: string) {
        return new SessionFailureController({
          sessionId,
          state: agent.sessions[sessionId].sessionFailureState,
          capabilities: (agent as any).clientCapabilities,
          isCurrent: () => true,
          sendUpdate: (notification) => (agent as any).client.sessionUpdate(notification),
          logger: { error: () => {} },
        });
      }

      const promptParams = (sessionId: string) => ({
        sessionId,
        prompt: [{ type: "text" as const, text: "hello" }],
      });

      it("publishes the subscription row while a plain sign-out is active", async () => {
        const [agent, updates] = createRecordingAgent(true);
        hideClaudeAuth();
        mockAccount(SIGNED_IN_WITH_KEY, { accountInfo: async () => ({ subscriptionType: "pro" }) });
        const { sessionId } = await agent.newSession(newSessionParams());

        await controllerFor(agent, sessionId).publish("auth_required", { sessionScoped: true });
        await expect(agent.prompt(promptParams(sessionId))).rejects.toMatchObject(refusal);

        const failures = failuresIn(updates);
        expect(failures).toHaveLength(2);
        expect(failures[0].reason).toBeUndefined();
        expect(failures[1].reason).toBe(REASON);
      });

      it("publishes a plain sign-out while the subscription row is active", async () => {
        const [agent, updates] = createRecordingAgent(true);
        hideClaudeAuth();
        mockAccount(SIGNED_IN_WITH_KEY, { accountInfo: async () => ({ subscriptionType: "pro" }) });
        const { sessionId } = await agent.newSession(newSessionParams());

        await expect(agent.prompt(promptParams(sessionId))).rejects.toMatchObject(refusal);

        const controller = controllerFor(agent, sessionId);
        // This is the check `failActiveWithSessionFailure` makes before it
        // publishes a sign-out. The subscription row must not answer it.
        expect(controller.hasActiveSessionError("auth_required")).toBe(false);
        expect(controller.hasActiveSessionError("auth_required", REASON)).toBe(true);
        await controller.publish("auth_required", { sessionScoped: true });

        const failures = failuresIn(updates);
        expect(failures).toHaveLength(2);
        expect(failures[0].reason).toBe(REASON);
        expect(failures[1].reason).toBeUndefined();
      });
    });

    describe("on steer", () => {
      it("rejects a steer that would start a new turn", async () => {
        const [agent] = await createAgentMock();
        hideClaudeAuth();
        mockAccount(SIGNED_IN_WITH_KEY, { accountInfo: async () => ({ subscriptionType: "pro" }) });
        const { sessionId } = await agent.newSession(newSessionParams());

        await expect(
          agent.steer({ sessionId, prompt: [{ type: "text", text: "hello" }] }),
        ).rejects.toMatchObject(refusal);
        expect(agent.sessions[sessionId].turnQueue ?? []).toHaveLength(0);
      });
    });

    describe("on providers/disable", () => {
      it("keeps going when a session cannot be recreated", async () => {
        const unhandled: unknown[] = [];
        const onUnhandled = (error: unknown) => unhandled.push(error);
        realProcess.on("unhandledRejection", onUnhandled);
        try {
          const [agent, updates] = createRecordingAgent(true);
          hideClaudeAuth();
          await agent.unstable_setProvider({
            providerId: "main",
            apiType: "anthropic",
            baseUrl: "https://gateway.example/v1",
            headers: {},
          });
          // The override kept these sessions legal; without it they are not.
          mockAccount({ subscriptionType: "pro" });
          const first = await agent.newSession(newSessionParams());
          const second = await agent.newSession(newSessionParams());

          await expect(agent.unstable_disableProvider({ providerId: "main" })).resolves.toEqual({});

          // The loop ran to the end: both sessions are gone and both reported.
          expect(agent.sessions[first.sessionId]).toBeUndefined();
          expect(agent.sessions[second.sessionId]).toBeUndefined();
          const failures = failuresIn(updates).filter((failure) => failure.reason === REASON);
          expect(failures).toHaveLength(2);
          expect(failures[0]).toMatchObject({ category: "access", details: MESSAGE });

          // `providerUpdate` is not poisoned: the next call reaches the guard
          // and reports the guard's own reason.
          await expect(agent.newSession(newSessionParams())).rejects.toMatchObject(refusal);
          await flushMacrotask();
          expect(unhandled).toEqual([]);
        } finally {
          realProcess.off("unhandledRejection", onUnhandled);
        }
      });
    });
  });

  it("SSH session falls back to single legacy login method", async () => {
    const [agent] = await createAgentMock();
    vi.stubGlobal("process", { ...process, env: { ...process.env, SSH_TTY: "/dev/pts/0" } });

    const initializeResponse = await agent.initialize({
      protocolVersion: 1,
      clientCapabilities: { auth: { terminal: true } },
    });

    expect(initializeResponse.authMethods).toContainEqual(
      expect.objectContaining({ id: "claude-login" }),
    );
    expect(initializeResponse.authMethods).not.toContainEqual(
      expect.objectContaining({ id: "claude-ai-login" }),
    );
    expect(initializeResponse.authMethods).not.toContainEqual(
      expect.objectContaining({ id: "console-login" }),
    );
  });

  it("CLAUDE_CODE_REMOTE falls back to single legacy login method", async () => {
    const [agent] = await createAgentMock();
    vi.stubGlobal("process", { ...process, env: { ...process.env, CLAUDE_CODE_REMOTE: "1" } });

    const initializeResponse = await agent.initialize({
      protocolVersion: 1,
      clientCapabilities: { auth: { terminal: true } },
    });

    expect(initializeResponse.authMethods).toContainEqual(
      expect.objectContaining({ id: "claude-login" }),
    );
    expect(initializeResponse.authMethods).not.toContainEqual(
      expect.objectContaining({ id: "claude-ai-login" }),
    );
    expect(initializeResponse.authMethods).not.toContainEqual(
      expect.objectContaining({ id: "console-login" }),
    );
  });

  it("remote environment respects hide-claude-auth", async () => {
    const [agent] = await createAgentMock();
    vi.stubGlobal("process", {
      ...process,
      argv: ["--hide-claude-auth"],
      env: { ...process.env, SSH_CONNECTION: "192.168.1.1 12345 192.168.1.2 22" },
    });

    const initializeResponse = await agent.initialize({
      protocolVersion: 1,
      clientCapabilities: { auth: { terminal: true } },
    });

    expect(initializeResponse.authMethods).not.toContainEqual(
      expect.objectContaining({ id: "claude-login" }),
    );
  });

  it("show claude authentication", async () => {
    const [agent] = await createAgentMock();

    const initializeResponse = await agent.initialize({
      protocolVersion: 1,
      clientCapabilities: { auth: { terminal: true } },
    });

    expect(initializeResponse.authMethods).toContainEqual(
      expect.objectContaining({ id: "claude-ai-login" }),
    );
    expect(initializeResponse.authMethods).toContainEqual(
      expect.objectContaining({ id: "console-login" }),
    );
  });
});

describe("session failure reason field", () => {
  it("carries reason only when the publisher passes one", async () => {
    const { SessionFailureController, createSessionFailureState } =
      await import("../session-failure-extension.js");
    const capabilities = {
      _meta: { jetbrains: { air: { version: 1, capabilities: ["sessionFailure"] } } },
    } as any;

    const withReason: any[] = [];
    const controllerWithReason = new SessionFailureController({
      sessionId: "s1",
      state: createSessionFailureState(),
      capabilities,
      isCurrent: () => true,
      sendUpdate: async (notification) => {
        withReason.push(notification);
      },
      logger: { error: () => {} },
    });
    await controllerWithReason.publish("auth_required", {
      sessionScoped: true,
      details: "This integration does not support using claude.ai subscriptions.",
      reason: "claude_subscription_not_supported",
    });
    const subscriptionFailure = withReason[0]?.update?._meta?.jetbrains?.air?.sessionFailure;
    expect(subscriptionFailure).toMatchObject({ reason: "claude_subscription_not_supported" });

    const withoutReason: any[] = [];
    const controllerWithoutReason = new SessionFailureController({
      sessionId: "s2",
      state: createSessionFailureState(),
      capabilities,
      isCurrent: () => true,
      sendUpdate: async (notification) => {
        withoutReason.push(notification);
      },
      logger: { error: () => {} },
    });
    await controllerWithoutReason.publish("auth_required", {
      sessionScoped: true,
      details: "Authentication required.",
    });
    const signedOutFailure = withoutReason[0]?.update?._meta?.jetbrains?.air?.sessionFailure;
    expect(signedOutFailure).toBeDefined();
    expect(signedOutFailure.reason).toBeUndefined();
  });
});
