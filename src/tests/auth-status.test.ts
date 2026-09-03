import type { Mock } from "vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AcpClient, ClaudeAcpAgent as ClaudeAcpAgentType, Logger } from "../acp-agent.js";
import { ClaudeAcpAgent } from "../acp-agent.js";
import type { AuthStatus } from "../auth-status.js";
import { fromAccountInfo, fromCliStatus, mergeAuthStatus, sameIdentity } from "../auth-status.js";
import { DEFAULT_CONTEXT_USAGE, makeMockQuery } from "./helpers.js";
import { randomUUID } from "node:crypto";

const mockQuery = vi.hoisted(() => vi.fn());

vi.mock("@anthropic-ai/claude-agent-sdk", async () => ({
  ...(await vi.importActual<typeof import("@anthropic-ai/claude-agent-sdk")>(
    "@anthropic-ai/claude-agent-sdk",
  )),
  query: mockQuery,
}));

/** Shared spy for both `claude auth status --json` and `claude auth logout`.
 *  Tests set `execFileResults` per invoked subcommand. */
const execFileSpy = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return { ...actual, execFile: execFileSpy };
});

/** CLI outputs verified against the real binary (see the extension spec). */
const CLI_SUBSCRIPTION = JSON.stringify({
  loggedIn: true,
  authMethod: "claude.ai",
  apiProvider: "firstParty",
  email: "user@example.com",
  orgId: "org-1",
  orgName: "ACME",
  subscriptionType: "max",
});
const CLI_API_KEY = JSON.stringify({
  loggedIn: true,
  authMethod: "none",
  apiProvider: "firstParty",
  apiKeySource: "apiKeyHelper",
});
/** An `apiKeyHelper` in settings.json next to a stored claude.ai login: the CLI
 *  reports both identities at once, and the helper key is what actually bills. */
const CLI_KEY_HELPER_AND_SUBSCRIPTION = JSON.stringify({
  loggedIn: true,
  authMethod: "claude.ai",
  apiProvider: "firstParty",
  apiKeySource: "apiKeyHelper",
  email: "user@example.com",
  orgName: "ACME",
  subscriptionType: "max",
});
const CLI_LOGGED_OUT = JSON.stringify({
  loggedIn: false,
  authMethod: "none",
  apiProvider: "firstParty",
});
/** The same login as CLI_SUBSCRIPTION, read from a source that omits the org. */
const CLI_SUBSCRIPTION_NO_ORG = JSON.stringify({
  loggedIn: true,
  authMethod: "claude.ai",
  apiProvider: "firstParty",
  email: "user@example.com",
  subscriptionType: "max",
});
/** A different person logged in since the last read. */
const CLI_OTHER_ACCOUNT = JSON.stringify({
  loggedIn: true,
  authMethod: "claude.ai",
  apiProvider: "firstParty",
  email: "other@example.com",
  subscriptionType: "pro",
});
/** A 3P backend: no claude.ai login, yet the agent is authenticated through
 *  credentials it does not own (AWS). `loggedIn` is false here. */
const CLI_BEDROCK = JSON.stringify({
  loggedIn: false,
  authMethod: "none",
  apiProvider: "bedrock",
});

const MOCK_MODELS = [
  { value: "id", displayName: "name", description: "description", supportsAutoMode: true },
];

/** One scripted SDK query: it echoes each pushed user message and answers it
 *  with a successful result, so a real `newSession` + `prompt` round trip runs
 *  against it and the turn-boundary probes fire. */
function scriptedTurnQuery(args: any, account: Record<string, unknown>) {
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
      yield {
        type: "result",
        subtype: "success",
        stop_reason: "end_turn",
        is_error: false,
        result: "done",
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
      };
    }
  }
  const query: any = messages();
  query.initializationResult = async () => ({ models: MOCK_MODELS, account });
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

describe("auth status mappers", () => {
  it("maps a first-party subscription account", () => {
    expect(
      fromAccountInfo({
        apiProvider: "firstParty",
        subscriptionType: "max",
        email: "user@example.com",
        organization: "ACME",
      }),
    ).toEqual({
      kind: "account",
      label: "Claude Max",
      account: { plan: "max", email: "user@example.com", organization: "ACME" },
    });
  });

  it("maps an API key source", () => {
    expect(
      fromAccountInfo({ apiProvider: "firstParty", apiKeySource: "ANTHROPIC_API_KEY" }),
    ).toEqual({
      kind: "api_key",
      label: "Anthropic API key",
      detail: "ANTHROPIC_API_KEY",
    });
  });

  it("prefers the API key over a stored subscription when both are reported", () => {
    // Claude Code's authentication precedence ranks an apiKeyHelper key above
    // the `/login` subscription, so the key is the identity that pays.
    expect(fromCliStatus(CLI_KEY_HELPER_AND_SUBSCRIPTION)).toEqual({
      kind: "api_key",
      label: "Anthropic API key",
      detail: "apiKeyHelper",
    });
    expect(
      fromAccountInfo({
        apiProvider: "firstParty",
        apiKeySource: "apiKeyHelper",
        subscriptionType: "max",
        email: "user@example.com",
        organization: "ACME",
      }),
    ).toEqual({
      kind: "api_key",
      label: "Anthropic API key",
      detail: "apiKeyHelper",
    });
  });

  it("maps third-party backends to external auth", () => {
    expect(fromAccountInfo({ apiProvider: "bedrock" })).toEqual({
      kind: "external",
      label: "AWS Bedrock",
    });
    expect(fromAccountInfo({ apiProvider: "vertex" })).toEqual({
      kind: "external",
      label: "Google Vertex AI",
    });
  });

  it("maps the gateway backend", () => {
    expect(fromAccountInfo({ apiProvider: "gateway" })).toEqual({
      kind: "gateway",
      label: "Custom model gateway",
    });
  });

  it("reports an account with no identity signal as no information", () => {
    // The SDK always fills apiProvider; under an apiKeyHelper that is all a
    // session account carries. Mapping it to `none` would claim "logged out".
    expect(fromAccountInfo({ apiProvider: "firstParty" })).toBeUndefined();
    expect(fromAccountInfo({})).toBeUndefined();
    expect(fromAccountInfo(undefined)).toBeUndefined();
    // `tokenSource` names the OAuth token's origin, never a key source.
    expect(
      fromAccountInfo({ apiProvider: "firstParty", tokenSource: "CLAUDE_CODE_OAUTH_TOKEN" }),
    ).toBeUndefined();
  });

  it("maps CLI probe output", () => {
    expect(fromCliStatus(CLI_SUBSCRIPTION)).toEqual({
      kind: "account",
      label: "Claude Max",
      account: { plan: "max", email: "user@example.com", organization: "ACME" },
    });
    expect(fromCliStatus(CLI_API_KEY)).toEqual({
      kind: "api_key",
      label: "Anthropic API key",
      detail: "apiKeyHelper",
    });
    expect(fromCliStatus(CLI_LOGGED_OUT)).toEqual({
      kind: "none",
      label: "Not logged in",
    });
  });

  it("lets a third-party backend outrank the logged-out flag", () => {
    // `loggedIn` tracks the claude.ai login only; on Bedrock the credentials
    // are external and the agent is authenticated all the same.
    expect(fromCliStatus(CLI_BEDROCK)).toEqual({ kind: "external", label: "AWS Bedrock" });
  });

  it("reports unparseable CLI output as not known", () => {
    expect(fromCliStatus("")).toBeUndefined();
    expect(fromCliStatus("Usage: claude auth status")).toBeUndefined();
    expect(fromCliStatus("[]")).toBeUndefined();
    expect(fromCliStatus('{"foo": 1}')).toBeUndefined();
  });

  it("merges a poorer read into the same identity and replaces a different one", () => {
    const stored = {
      kind: "account" as const,
      label: "Claude Max",
      account: { plan: "max", email: "user@example.com", organization: "ACME" },
    };
    // Same login, read from a source without the organization: it survives.
    expect(
      mergeAuthStatus(stored, {
        kind: "account",
        label: "Claude Max",
        account: { plan: "max", email: "user@example.com" },
      }),
    ).toEqual(stored);
    // A different login replaces everything, organization included.
    expect(
      mergeAuthStatus(stored, {
        kind: "account",
        label: "Claude Pro",
        account: { plan: "pro", email: "other@example.com" },
      }),
    ).toEqual({
      kind: "account",
      label: "Claude Pro",
      account: { plan: "pro", email: "other@example.com" },
    });
    // A different kind never merges, even when it looks adjacent.
    expect(
      mergeAuthStatus(stored, { kind: "api_key", label: "Anthropic API key", detail: "env" }),
    ).toEqual({ kind: "api_key", label: "Anthropic API key", detail: "env" });
    // Key sources identify api_key payloads.
    expect(
      sameIdentity(
        { kind: "api_key", label: "Anthropic API key", detail: "apiKeyHelper" },
        { kind: "api_key", label: "Anthropic API key", detail: "env" },
      ),
    ).toBe(false);
  });
});

describe("auth status over ACP", () => {
  let agent: ClaudeAcpAgentType;
  let extNotification: ReturnType<typeof vi.fn>;
  /** stdout the fake `claude auth status --json` prints, and whether the exec
   *  fails (the logged-out case exits 1 with JSON still on stdout). */
  let statusStdout: string;
  let statusFails: boolean;
  /** While true, probes hang until `flushStatus()` releases them, so a test can
   *  interleave an `authenticate`/`logout` with a probe that is still running.
   *  Each probe captures the output configured when it was spawned. */
  let deferStatus: boolean;
  let pendingStatus: Array<() => void>;

  /** Let every already-scheduled promise chain run to completion. */
  function settle() {
    return new Promise((resolve) => setTimeout(resolve, 0));
  }

  /** Release one pending probe by spawn order, so a test can decide which of
   *  two in-flight reads lands first. */
  async function releaseStatus(index: number) {
    const [release] = pendingStatus.splice(index, 1);
    release();
    await settle();
  }

  /** Release the probes spawned so far and let their promises settle, repeating
   *  so a probe spawned by that settling (e.g. logout's fresh read) is released
   *  too. */
  async function flushStatus(rounds = 3) {
    for (let round = 0; round < rounds; round++) {
      const pending = pendingStatus;
      pendingStatus = [];
      for (const release of pending) release();
      await settle();
    }
  }

  beforeEach(() => {
    // Skip native-binary resolution; the exec itself is mocked.
    process.env.CLAUDE_CODE_EXECUTABLE = "claude";
    statusStdout = CLI_SUBSCRIPTION;
    statusFails = false;
    deferStatus = false;
    pendingStatus = [];
    // The probe passes an options object and `logout` does not, so the
    // callback is read off the end rather than from a fixed position.
    execFileSpy.mockImplementation((...invocation: unknown[]) => {
      const args = invocation[1] as string[];
      const cb = invocation[invocation.length - 1] as (...a: unknown[]) => void;
      if (args[1] === "status") {
        const stdout = statusStdout;
        const fails = statusFails;
        const answer = () => {
          if (fails) {
            cb(Object.assign(new Error("exit 1"), { stdout, stderr: "" }));
          } else {
            cb(null, { stdout, stderr: "" });
          }
        };
        if (deferStatus) {
          pendingStatus.push(answer);
        } else {
          answer();
        }
        return;
      }
      cb(null, { stdout: "", stderr: "" });
    });
    mockQuery.mockImplementation(() => makeMockQuery());
    extNotification = vi.fn().mockResolvedValue(undefined);
    agent = new ClaudeAcpAgent({
      sessionUpdate: async () => {},
      extNotification,
    } as unknown as AcpClient);
  });

  afterEach(() => {
    delete process.env.CLAUDE_CODE_EXECUTABLE;
    vi.resetAllMocks();
  });

  function statusCalls() {
    return execFileSpy.mock.calls.filter((call) => (call[1] as string[])[1] === "status");
  }

  function updates() {
    return extNotification.mock.calls.filter((call) => call[0] === "_auth/status_update");
  }

  /** The last payload pushed, which is also what the connection now holds. */
  function lastPush() {
    return (updates().at(-1)?.[1] as { authStatus: AuthStatus } | undefined)?.authStatus;
  }

  /** `initialize` is where the connection learns its identity. It fires the
   *  probe and never waits for it, so let the push land before asserting. */
  async function initialize() {
    const response = await agent.initialize({ protocolVersion: 1, clientCapabilities: {} });
    await settle();
    return response;
  }

  /** A session whose scripted query answers every prompt, so a real `prompt()`
   *  round trip runs and its start-of-prompt probe fires. */
  async function scriptedSession(account: Record<string, unknown>) {
    mockQuery.mockImplementation((args: any) => scriptedTurnQuery(args, account));
    const { sessionId } = await agent.newSession({ cwd: process.cwd(), mcpServers: [] });
    return sessionId;
  }

  async function promptOnce(sessionId: string) {
    const response = await agent.prompt({
      sessionId,
      prompt: [{ type: "text" as const, text: "hi" }],
    });
    await settle();
    return response;
  }

  it("pushes the logged-out CLI verdict even though the probe exits non-zero", async () => {
    statusStdout = CLI_LOGGED_OUT;
    statusFails = true;
    await initialize();
    expect(lastPush()).toEqual({ kind: "none", label: "Not logged in" });
  });

  it("pushes nothing when the probe cannot be read", async () => {
    statusStdout = "";
    statusFails = true;
    await initialize();
    // "Cannot determine" is silence: no push at all, and the client keeps
    // showing "not reported". A known logged-out state would push a payload
    // of kind "none" instead.
    expect(updates()).toHaveLength(0);
    expect(agent.currentAuthStatus).toBeUndefined();
  });

  it("advertises the extension in agentCapabilities._meta", async () => {
    const response = await agent.initialize({ protocolVersion: 1, clientCapabilities: {} });
    // Presence is the whole advertisement — "this agent pushes its identity".
    // The marker stays empty, and a status payload there would violate the
    // contract.
    expect(response.agentCapabilities?._meta?.authStatus).toEqual({});
    // The marker lives in agentCapabilities only — never at the top level.
    expect(response._meta?.authStatus).toBeUndefined();
  });

  it("pushes the first identity after the initialize response, never before it", async () => {
    // The client registers its receiver around `initialize`; a push that
    // overtook the response could be dropped. The probe is asynchronous, so
    // the response always wins the race.
    const order: string[] = [];
    extNotification.mockImplementation(async (method: string) => {
      order.push(method);
    });

    const response = await agent.initialize({ protocolVersion: 1, clientCapabilities: {} });
    order.push("initialize:returned");
    await vi.waitFor(() => expect(updates()).toHaveLength(1));

    expect(order).toEqual(["initialize:returned", "_auth/status_update"]);
    // No snapshot rides in the initialize response — only the notification.
    expect(response._meta?.authStatus).toBeUndefined();
  });

  it("shares one in-flight probe between initialize and a start-of-prompt read", async () => {
    const sessionId = await scriptedSession({ apiKeySource: "apiKeyHelper" });
    deferStatus = true;

    const init = agent.initialize({ protocolVersion: 1, clientCapabilities: {} });
    const turn = agent.prompt({ sessionId, prompt: [{ type: "text", text: "hi" }] });
    await settle();
    // Two readers, one CLI process.
    expect(statusCalls()).toHaveLength(1);

    await flushStatus();
    await Promise.all([init, turn]);
    expect(lastPush()?.kind).toBe("account");
  });

  it("re-probes on every prompt, so an external logout is seen", async () => {
    // The start of a prompt is the connection's "re-check now": a logout
    // performed in another terminal shows up without a session create.
    const sessionId = await scriptedSession({ apiKeySource: "apiKeyHelper" });
    await promptOnce(sessionId);
    expect(lastPush()).toEqual({
      kind: "account",
      label: "Claude Max",
      account: { plan: "max", email: "user@example.com", organization: "ACME" },
    });

    statusStdout = CLI_LOGGED_OUT;
    statusFails = true;
    await promptOnce(sessionId);

    expect(statusCalls()).toHaveLength(2);
    expect(lastPush()).toEqual({ kind: "none", label: "Not logged in" });
  });

  it("keeps richer stored fields when a poorer probe reports the same identity", async () => {
    // The session AccountInfo knows the organization; the CLI probe here does
    // not. Re-reading the same login must not regress the payload.
    const sessionId = await scriptedSession({
      apiProvider: "firstParty",
      subscriptionType: "max",
      email: "user@example.com",
      organization: "ACME",
    });

    statusStdout = CLI_SUBSCRIPTION_NO_ORG;
    await promptOnce(sessionId);

    expect(agent.currentAuthStatus).toEqual({
      kind: "account",
      label: "Claude Max",
      account: { plan: "max", email: "user@example.com", organization: "ACME" },
    });
  });

  it("lets a probe of a different identity replace the stored one wholesale", async () => {
    const sessionId = await scriptedSession({
      apiProvider: "firstParty",
      subscriptionType: "max",
      email: "user@example.com",
      organization: "ACME",
    });

    // Someone logged in as another user in a terminal: no field survives.
    statusStdout = CLI_OTHER_ACCOUNT;
    await promptOnce(sessionId);

    expect(lastPush()).toEqual({
      kind: "account",
      label: "Claude Pro",
      account: { plan: "pro", email: "other@example.com" },
    });
  });

  it("pushes _auth/status_update when the initialize probe resolves", async () => {
    await agent.initialize({ protocolVersion: 1, clientCapabilities: {} });
    await vi.waitFor(() => expect(updates()).toHaveLength(1));
    expect(updates()).toEqual([
      [
        "_auth/status_update",
        {
          authStatus: {
            kind: "account",
            label: "Claude Max",
            account: { plan: "max", email: "user@example.com", organization: "ACME" },
          },
        },
      ],
    ]);
  });

  it("upgrades the identity from AccountInfo on session create", async () => {
    statusStdout = CLI_API_KEY;
    await initialize();
    mockQuery.mockImplementation(() =>
      makeMockQuery({
        initializationResult: async () => ({
          models: MOCK_MODELS,
          account: { apiProvider: "firstParty", subscriptionType: "pro", email: "u@x.com" },
        }),
      }),
    );

    await agent.newSession({ cwd: process.cwd(), mcpServers: [] });

    expect(updates().map((call) => call[1])).toEqual([
      {
        authStatus: {
          kind: "api_key",
          label: "Anthropic API key",
          detail: "apiKeyHelper",
        },
      },
      {
        authStatus: {
          kind: "account",
          label: "Claude Pro",
          account: { plan: "pro", email: "u@x.com" },
        },
      },
    ]);
  });

  it.each([
    ["only apiProvider", { apiProvider: "firstParty" }],
    ["an empty object", {}],
  ])("keeps the probed API key when the session account carries %s", async (_name, account) => {
    // Regression: an apiKeyHelper setup yields a truthy but empty account, and
    // mapping it to `none` used to overwrite the correct api_key status ~0.5 s
    // after connect.
    statusStdout = CLI_API_KEY;
    await initialize();
    expect(updates()).toHaveLength(1);

    mockQuery.mockImplementation(() =>
      makeMockQuery({
        initializationResult: async () => ({ models: MOCK_MODELS, account }),
      }),
    );
    await agent.newSession({ cwd: process.cwd(), mcpServers: [] });

    expect(updates()).toHaveLength(1);
    expect(agent.currentAuthStatus).toEqual({
      kind: "api_key",
      label: "Anthropic API key",
      detail: "apiKeyHelper",
    });
  });

  it("ignores the session account while a client provider override is active", async () => {
    // `providers/set` routing is the client's, not the agent's login: the
    // session then reports `apiProvider: "gateway"`, which must stay invisible
    // to authStatus. The CLI probe keeps describing the agent-owned store.
    statusStdout = CLI_API_KEY;
    await initialize();
    expect(updates()).toHaveLength(1);

    await agent.unstable_setProvider({
      providerId: "main",
      apiType: "anthropic",
      baseUrl: "https://client-gateway.example/v1",
      headers: {},
    });
    mockQuery.mockImplementation(() =>
      makeMockQuery({
        initializationResult: async () => ({
          models: MOCK_MODELS,
          account: { apiProvider: "gateway" },
        }),
      }),
    );
    await agent.newSession({ cwd: process.cwd(), mcpServers: [] });

    expect(updates()).toHaveLength(1);
    expect(agent.currentAuthStatus).toEqual({
      kind: "api_key",
      label: "Anthropic API key",
      detail: "apiKeyHelper",
    });
  });

  it("still probes the agent's own login under a client provider override", async () => {
    await agent.unstable_setProvider({
      providerId: "main",
      apiType: "anthropic",
      baseUrl: "https://client-gateway.example/v1",
      headers: {},
    });

    await initialize();

    expect(statusCalls()).toHaveLength(1);
    expect(updates()).toHaveLength(1);
  });

  it("pushes an unchanged identity once, however often it is read", async () => {
    // The identity is read on many occasions and almost all of them see the
    // same login. A repeat tells the client nothing, so it is not sent.
    const authStatus = {
      kind: "account",
      label: "Claude Max",
      account: { plan: "max", email: "user@example.com" },
    };
    mockQuery.mockImplementation(() =>
      makeMockQuery({
        initializationResult: async () => ({
          models: MOCK_MODELS,
          account: {
            apiProvider: "firstParty",
            subscriptionType: "max",
            email: "user@example.com",
          },
        }),
      }),
    );

    await agent.newSession({ cwd: process.cwd(), mcpServers: [] });
    await agent.newSession({ cwd: process.cwd(), mcpServers: [] });

    expect(updates().map((call) => call[1])).toEqual([{ authStatus }]);
  });

  it("pushes again as soon as a field of the payload changes", async () => {
    let account: Record<string, unknown> = {
      apiProvider: "firstParty",
      subscriptionType: "max",
      email: "user@example.com",
    };
    mockQuery.mockImplementation(() =>
      makeMockQuery({
        initializationResult: async () => ({ models: MOCK_MODELS, account }),
      }),
    );

    await agent.newSession({ cwd: process.cwd(), mcpServers: [] });
    // Same person, upgraded plan: the label changes, so the client hears it.
    account = { ...account, subscriptionType: "enterprise" };
    await agent.newSession({ cwd: process.cwd(), mcpServers: [] });

    expect(
      updates().map((call) => (call[1] as { authStatus: { label: string } }).authStatus.label),
    ).toEqual(["Claude Max", "Claude Enterprise"]);
  });

  it("reads the store once per user prompt, at the start", async () => {
    const sessionId = await scriptedSession({ apiKeySource: "apiKeyHelper" });
    // Session creation reads the account the SDK already has; it spawns no CLI.
    expect(statusCalls()).toHaveLength(0);

    await expect(promptOnce(sessionId)).resolves.toMatchObject({ stopReason: "end_turn" });

    // Exactly one process per user prompt, spawned before the turn runs so a
    // sign-in done between two prompts is seen by the prompt that follows it.
    expect(statusCalls()).toHaveLength(1);
    await promptOnce(sessionId);
    expect(statusCalls()).toHaveLength(2);
  });

  it("never makes a prompt wait for the probe", async () => {
    // The read is fire-and-forget: a CLI that has not answered yet — or never
    // answers — must not hold the turn.
    const sessionId = await scriptedSession({ apiKeySource: "apiKeyHelper" });
    deferStatus = true;

    await expect(promptOnce(sessionId)).resolves.toMatchObject({ stopReason: "end_turn" });
    expect(statusCalls()).toHaveLength(1);
    // Still pending when the turn is long over; its result lands afterwards.
    expect(pendingStatus).toHaveLength(1);

    await flushStatus();
    expect(lastPush()?.kind).toBe("account");
  });

  it("reports the gateway identity after gateway authentication", async () => {
    await agent.authenticate({
      methodId: "gateway",
      _meta: { gateway: { baseUrl: "https://gw.example.com/v1", headers: {} } },
    } as never);

    expect(updates().map((call) => call[1])).toEqual([
      {
        authStatus: {
          kind: "gateway",
          label: "Custom model gateway",
          detail: "gw.example.com",
        },
      },
    ]);
  });

  it("discards a probe that a gateway authenticate overtook", async () => {
    // The initialize-time probe is slower than the login: releasing it after
    // `authenticate` must not repaint the gateway identity with the CLI store's.
    deferStatus = true;
    await agent.initialize({ protocolVersion: 1, clientCapabilities: {} });

    await agent.authenticate({
      methodId: "gateway",
      _meta: { gateway: { baseUrl: "https://gw.example.com/v1", headers: {} } },
    } as never);
    await flushStatus();

    const gateway = {
      kind: "gateway",
      label: "Custom model gateway",
      detail: "gw.example.com",
    };
    // The overtaken read published nothing: one push, the gateway's.
    expect(updates().map((call) => call[1])).toEqual([{ authStatus: gateway }]);
    expect(agent.currentAuthStatus).toEqual(gateway);
  });

  it("ignores a pre-logout probe and pushes the fresh one", async () => {
    // A probe started before `logout` still describes the logged-in world: it
    // must neither be reused by logout nor be published when it lands.
    deferStatus = true;
    void agent.initialize({ protocolVersion: 1, clientCapabilities: {} });
    await settle();
    statusStdout = CLI_LOGGED_OUT;
    statusFails = true;

    const logout = agent.logout({});
    await flushStatus();
    await logout;

    // Two reads: the stale one, plus the fresh one logout started itself
    // instead of joining it.
    expect(statusCalls()).toHaveLength(2);
    // The logged-in identity the stale probe carried was never published.
    expect(updates().map((call) => call[1])).toEqual([
      { authStatus: { kind: "none", label: "Not logged in" } },
    ]);
    expect(agent.currentAuthStatus).toEqual({ kind: "none", label: "Not logged in" });
  });

  it("discards the pre-logout read even when it lands after the logout's own", async () => {
    // Both reads are in flight at once. The logout's lands first and pushes
    // "logged out"; the older one lands after and must publish nothing, or a
    // slow read would resurrect the identity the logout destroyed.
    deferStatus = true;
    void agent.initialize({ protocolVersion: 1, clientCapabilities: {} });
    await settle();
    statusStdout = CLI_LOGGED_OUT;
    statusFails = true;
    const logout = agent.logout({});
    await vi.waitFor(() => expect(pendingStatus).toHaveLength(2));

    await releaseStatus(1);
    expect(lastPush()).toEqual({ kind: "none", label: "Not logged in" });
    await releaseStatus(0);
    await logout;

    expect(updates()).toHaveLength(1);
    expect(agent.currentAuthStatus).toEqual({ kind: "none", label: "Not logged in" });
  });

  it("keeps the last known state when a probe is readable but empty", async () => {
    // The CLI cannot be read at all, yet a session already told us who we are:
    // keep that rather than pretending the state is unknown.
    const published = { kind: "api_key" as const, label: "Anthropic API key", detail: "env" };
    agent.setAuthStatus(published);
    await settle();
    extNotification.mockClear();
    statusStdout = "";
    statusFails = true;

    await initialize();

    expect(updates()).toHaveLength(0);
    expect(agent.currentAuthStatus).toEqual(published);
  });

  it("drops a stale identity when the post-logout probe is unreadable", async () => {
    await initialize();
    statusStdout = "";
    statusFails = true;

    await agent.logout({});

    expect(lastPush()).toEqual({ kind: "none", label: "Not logged in" });
  });

  it("re-probes after logout and reports the resulting state", async () => {
    await initialize();
    statusStdout = CLI_LOGGED_OUT;
    statusFails = true;

    await agent.logout({});

    expect(statusCalls()).toHaveLength(2);
    expect(lastPush()).toEqual({ kind: "none", label: "Not logged in" });
  });

  describe("when the CLI never answers", () => {
    /** The last known state, so a timed-out probe has something to fall back
     *  to and a wrong "cannot determine" answer would be visible. */
    const KNOWN: AuthStatus = { kind: "api_key", label: "Anthropic API key", detail: "env" };

    let logger: { log: Mock; error: Mock; warn: Mock };

    beforeEach(() => {
      vi.useFakeTimers();
      // A wedged `claude auth status --json`: it never answers by itself, and
      // the fake child dies the way Node kills a timed-out exec — the error
      // carries `killed`/`signal`, and any partial stdout is a fragment.
      execFileSpy.mockImplementation((...invocation: unknown[]) => {
        const args = invocation[1] as string[];
        const options = invocation[2] as { timeout?: number } | undefined;
        const cb = invocation[invocation.length - 1] as (...a: unknown[]) => void;
        if (args[1] !== "status") {
          cb(null, { stdout: "", stderr: "" });
          return;
        }
        if (options?.timeout === undefined) return;
        setTimeout(() => {
          cb(
            Object.assign(new Error("Command failed"), {
              killed: true,
              signal: "SIGTERM",
              stdout: "",
              stderr: "",
            }),
          );
        }, options.timeout);
      });
      logger = { log: vi.fn(), error: vi.fn(), warn: vi.fn() };
      extNotification = vi.fn().mockResolvedValue(undefined);
      agent = new ClaudeAcpAgent(
        { sessionUpdate: async () => {}, extNotification } as unknown as AcpClient,
        logger as Logger,
      );
      agent.setAuthStatus({ ...KNOWN });
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("bounds the probe at 5 s and keeps the last known state", async () => {
      agent.setAuthStatus({ ...KNOWN });
      const pushesBefore = updates().length;

      await agent.initialize({ protocolVersion: 1, clientCapabilities: {} });
      // The exec is spawned on a microtask (`claudeCliPath` is awaited first),
      // so let those run before the timer that kills it.
      await vi.advanceTimersByTimeAsync(0);
      expect(statusCalls()).toHaveLength(1);
      expect(statusCalls()[0]?.[2]).toMatchObject({ timeout: 5000 });

      await vi.advanceTimersByTimeAsync(5000);

      // Node killed the child, so the read reports nothing of its own: the
      // state stays what was known before it, and no push goes out.
      expect(agent.currentAuthStatus).toEqual(KNOWN);
      expect(updates()).toHaveLength(pushesBefore);
      expect(logger.error).toHaveBeenCalledWith(
        "claude auth status did not answer within 5 s; the identity is not refreshed",
      );
    });

    it("warns once however many probes time out", async () => {
      // A wedged CLI stays wedged: every later prompt would repeat the same
      // line otherwise.
      await agent.initialize({ protocolVersion: 1, clientCapabilities: {} });
      await vi.advanceTimersByTimeAsync(5000);
      await agent.initialize({ protocolVersion: 1, clientCapabilities: {} });
      await vi.advanceTimersByTimeAsync(5000);

      expect(statusCalls()).toHaveLength(2);
      expect(
        logger.error.mock.calls.filter((call) => String(call[0]).includes("did not answer")),
      ).toHaveLength(1);
    });
  });
});
