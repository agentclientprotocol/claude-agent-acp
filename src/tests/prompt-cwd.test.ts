import { describe, expect, it, vi } from "vitest";
import { RequestError } from "@agentclientprotocol/sdk/unstable";
import { ClaudeAcpAgent, computeSessionFingerprint, type AcpClient } from "../acp-agent.js";
import { Pushable } from "../utils.js";
import {
  moveSessionCwd,
  promptCwdFromMeta,
  type PromptCwdHost,
  type PromptCwdSession,
} from "../prompt-cwd.js";
import {
  mockSessionState,
  successfulResultMessage,
  userEcho,
  wrapQuery,
} from "./session-doubles.js";

vi.mock("@anthropic-ai/claude-agent-sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@anthropic-ai/claude-agent-sdk")>();
  const refused = () => {
    throw new Error("Unexpected real SDK call");
  };
  return {
    ...actual,
    query: vi.fn(refused),
    getSessionMessages: vi.fn(async () => []),
    getSubagentMessages: vi.fn(async () => []),
    listSessions: vi.fn(async () => []),
    getSessionInfo: vi.fn(async () => undefined),
    deleteSession: vi.fn(refused),
    forkSession: vi.fn(refused),
    importSessionToStore: vi.fn(refused),
  };
});

const OLD_CWD = "/old/project";
const NEW_CWD = "/new/project";

/** A `PromptCwdHost` whose validation accepts every path, so a test only
 *  overrides the parts it asserts on. */
function makeHost(overrides: Partial<PromptCwdHost> = {}): PromptCwdHost {
  return {
    validateCwd: vi.fn(async () => {}),
    fingerprint: (creationParams) => computeSessionFingerprint(creationParams),
    ...overrides,
  };
}

/** The settings manager of the session doubles: the shared stub plus the
 *  `setCwd` a move calls. */
function makeSettingsManager() {
  return {
    dispose: vi.fn(),
    getSettings: () => ({}),
    getApiKeyHelper: () => undefined,
    getCwd: () => OLD_CWD,
    setCwd: vi.fn(async () => {}),
  };
}

/** Resolves with the error `promise` rejected with, and fails when it
 *  resolves instead — `Promise.catch` would join the rejection with the
 *  success type. */
function rejected<T>(promise: Promise<T>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error("Expected the promise to reject");
    },
    (error: unknown) => error,
  );
}

/** A session projection standing in `OLD_CWD`, with spies on everything a
 *  move touches. The query carries a `setCwd` spy unless `withoutSetCwd`. */
function makeSession(
  overrides: {
    setCwdResponse?: unknown;
    setCwdRejects?: Error;
    withoutSetCwd?: boolean;
    creationParams?: PromptCwdSession["creationParams"];
  } = {},
) {
  const settingsManager = makeSettingsManager();
  const fileChangeReporter = { setWorkspace: vi.fn() };
  const setCwd = vi.fn(async () => {
    if (overrides.setCwdRejects) throw overrides.setCwdRejects;
    return overrides.setCwdResponse ?? { status: "ok", cwd: NEW_CWD, changed: true };
  });
  const query = wrapQuery(Object.assign((async function* () {})(), { setCwd }));
  if (overrides.withoutSetCwd) delete (query as Record<string, unknown>).setCwd;
  const session: PromptCwdSession = mockSessionState({
    query,
    input: new Pushable(),
    cwd: OLD_CWD,
    sessionFingerprint: computeSessionFingerprint({ cwd: OLD_CWD, mcpServers: [] }),
    creationParams: overrides.creationParams,
    settingsManager,
    fileChangeReporter,
  });
  return { session, setCwd, settingsManager, fileChangeReporter };
}

describe("promptCwdFromMeta", () => {
  it("reads the cwd under _meta.claudeCode", () => {
    expect(promptCwdFromMeta({ claudeCode: { cwd: "/tmp/project" } })).toBe("/tmp/project");
  });

  it.each([
    ["no _meta", undefined],
    ["a null _meta", null],
    ["no claudeCode object", {}],
    ["a non-object claudeCode", { claudeCode: "x" }],
    ["no cwd", { claudeCode: {} }],
    ["a non-string cwd", { claudeCode: { cwd: 42 } }],
    ["an empty-string cwd", { claudeCode: { cwd: "" } }],
  ])("answers no move for %s", (_name, meta) => {
    expect(promptCwdFromMeta(meta)).toBeUndefined();
  });
});

describe("moveSessionCwd", () => {
  it("moves the session and follows the cwd the CLI reports", async () => {
    const creationParams = {
      cwd: OLD_CWD,
      mcpServers: [],
      _meta: { claudeCode: { options: { model: "claude-sonnet-4-6" } } },
    } as PromptCwdSession["creationParams"];
    const { session, setCwd, settingsManager, fileChangeReporter } = makeSession({
      setCwdResponse: { status: "ok", cwd: NEW_CWD, changed: true, transcript_relocated: true },
      creationParams,
    });

    await moveSessionCwd(session, NEW_CWD, makeHost());

    expect(setCwd).toHaveBeenCalledWith(NEW_CWD);
    expect(session.cwd).toBe(NEW_CWD);
    expect(session.creationParams).toEqual({ ...creationParams, cwd: NEW_CWD });
    // A load/resume naming the moved directory then matches this fingerprint
    // and reuses the session instead of recreating it.
    expect(session.sessionFingerprint).toBe(
      computeSessionFingerprint({ ...creationParams, cwd: NEW_CWD }),
    );
    expect(fileChangeReporter.setWorkspace).toHaveBeenCalledWith(NEW_CWD);
    expect(settingsManager.setCwd).toHaveBeenCalledWith(NEW_CWD);
  });

  it("falls back to the requested cwd when the CLI reports none", async () => {
    const { session, setCwd } = makeSession({ setCwdResponse: { status: "ok" } });

    await moveSessionCwd(session, NEW_CWD, makeHost());

    expect(setCwd).toHaveBeenCalledWith(NEW_CWD);
    expect(session.cwd).toBe(NEW_CWD);
  });

  it("recomputes the fingerprint from a minimal creation when the session has none", async () => {
    const { session } = makeSession({ creationParams: undefined });

    await moveSessionCwd(session, NEW_CWD, makeHost());

    expect(session.sessionFingerprint).toBe(
      computeSessionFingerprint({ cwd: NEW_CWD, mcpServers: [] }),
    );
  });

  it("names the trust root and touches nothing on needs_trust", async () => {
    const { session, settingsManager, fileChangeReporter } = makeSession({
      setCwdResponse: { status: "needs_trust", trust_root: "/new" },
    });
    const before = session.sessionFingerprint;

    const error = (await rejected(moveSessionCwd(session, NEW_CWD, makeHost()))) as RequestError;

    expect(error).toBeInstanceOf(RequestError);
    expect(error.code).toBe(RequestError.invalidRequest().code);
    expect(error.data).toEqual({ cwd: NEW_CWD, trustRoot: "/new" });
    expect(error.message).toContain("/new");
    expect(error.message).toContain(NEW_CWD);
    expect(session.cwd).toBe(OLD_CWD);
    expect(session.sessionFingerprint).toBe(before);
    expect(fileChangeReporter.setWorkspace).not.toHaveBeenCalled();
    expect(settingsManager.setCwd).not.toHaveBeenCalled();
  });

  it("answers a trust requirement that names no root with the directory itself", async () => {
    const { session } = makeSession({ setCwdResponse: { status: "needs_trust" } });

    const error = (await rejected(moveSessionCwd(session, NEW_CWD, makeHost()))) as RequestError;

    expect(error).toBeInstanceOf(RequestError);
    expect(error.message).toContain(NEW_CWD);
    expect(error.data).toEqual({ cwd: NEW_CWD });
  });

  it("refuses the move when the session's SDK has no setCwd control", async () => {
    const { session, setCwd, settingsManager } = makeSession({ withoutSetCwd: true });
    const host = makeHost();

    await expect(moveSessionCwd(session, NEW_CWD, host)).rejects.toThrow("no set_cwd control");

    expect(setCwd).not.toHaveBeenCalled();
    expect(host.validateCwd).not.toHaveBeenCalled();
    expect(settingsManager.setCwd).not.toHaveBeenCalled();
    expect(session.cwd).toBe(OLD_CWD);
  });

  it("answers a CLI refusal with the CLI's message and touches nothing", async () => {
    const { session, settingsManager } = makeSession({
      setCwdRejects: new Error("turn in flight"),
    });

    const error = (await rejected(moveSessionCwd(session, NEW_CWD, makeHost()))) as RequestError;

    expect(error).toBeInstanceOf(RequestError);
    expect(error.message).toContain("turn in flight");
    expect(error.data).toEqual({ cwd: NEW_CWD });
    expect(session.cwd).toBe(OLD_CWD);
    expect(settingsManager.setCwd).not.toHaveBeenCalled();
  });

  it("fails on a response it cannot read instead of claiming the move", async () => {
    const { session } = makeSession({ setCwdResponse: { moved: true } });

    const error = (await rejected(moveSessionCwd(session, NEW_CWD, makeHost()))) as RequestError;

    expect(error).toBeInstanceOf(RequestError);
    expect(error.code).toBe(RequestError.internalError().code);
    expect(session.cwd).toBe(OLD_CWD);
  });

  it("validates the directory before asking the CLI", async () => {
    const { session, setCwd } = makeSession();
    const host = makeHost({
      validateCwd: vi.fn(async (cwd: string) => {
        throw RequestError.invalidParams({ cwd }, "`cwd` does not exist");
      }),
    });

    await expect(moveSessionCwd(session, NEW_CWD, host)).rejects.toThrow("`cwd` does not exist");

    expect(setCwd).not.toHaveBeenCalled();
    expect(session.cwd).toBe(OLD_CWD);
  });
});

describe("a prompt that carries _meta.claudeCode.cwd", () => {
  function createAgent() {
    const client = { sessionUpdate: async () => {} } as unknown as AcpClient;
    return new ClaudeAcpAgent(client, { log: () => {}, error: () => {} });
  }

  function setupSession(
    agent: ClaudeAcpAgent,
    overrides: { turnInFlight?: boolean; onPromptSeen?: () => void } = {},
  ) {
    const setCwd = vi.fn(async () => ({ status: "ok", cwd: NEW_CWD, changed: true }));
    const settingsManager = makeSettingsManager();
    const input = new Pushable<any>();
    async function* messages() {
      const iter = input[Symbol.asyncIterator]();
      const { value: userMessage } = await iter.next();
      overrides.onPromptSeen?.();
      yield userEcho(userMessage);
      yield successfulResultMessage();
    }
    const session = mockSessionState({
      query: wrapQuery(Object.assign(messages(), { setCwd })),
      input,
      cwd: OLD_CWD,
      sessionFingerprint: computeSessionFingerprint({ cwd: OLD_CWD, mcpServers: [] }),
      settingsManager,
      ...(overrides.turnInFlight ? { turnQueue: [{ settled: false }] } : {}),
    });
    agent.sessions["test-session"] = session;
    return { setCwd, settingsManager, input, session };
  }

  it("moves the session before the prompt runs", async () => {
    const agent = createAgent();
    vi.spyOn(agent as any, "validateCwd").mockResolvedValue(undefined);
    let setCwdRanBeforeThePrompt = false;
    const { setCwd, settingsManager } = setupSession(agent, {
      onPromptSeen: () => {
        setCwdRanBeforeThePrompt = setCwd.mock.calls.length > 0;
      },
    });

    const response = await agent.prompt({
      sessionId: "test-session",
      prompt: [{ type: "text", text: "continue" }],
      _meta: { claudeCode: { cwd: NEW_CWD } },
    });

    expect(response.stopReason).toBe("end_turn");
    expect(setCwdRanBeforeThePrompt).toBe(true);
    expect(agent.sessions["test-session"].cwd).toBe(NEW_CWD);
    expect(settingsManager.setCwd).toHaveBeenCalledWith(NEW_CWD);
  });

  it("refuses the move while Claude is working", async () => {
    const agent = createAgent();
    const { setCwd } = setupSession(agent, { turnInFlight: true });

    await expect(
      agent.prompt({
        sessionId: "test-session",
        prompt: [{ type: "text", text: "continue" }],
        _meta: { claudeCode: { cwd: NEW_CWD } },
      }),
    ).rejects.toThrow("The working directory can't be changed while Claude is working");

    expect(setCwd).not.toHaveBeenCalled();
  });

  it("leaves a prompt without a cwd untouched", async () => {
    const agent = createAgent();
    const { setCwd, session } = setupSession(agent);

    await agent.prompt({
      sessionId: "test-session",
      prompt: [{ type: "text", text: "continue" }],
    });

    expect(setCwd).not.toHaveBeenCalled();
    expect(session.cwd).toBe(OLD_CWD);
  });

  it("leaves a prompt naming the current directory untouched", async () => {
    const agent = createAgent();
    const { setCwd, session } = setupSession(agent);

    await agent.prompt({
      sessionId: "test-session",
      prompt: [{ type: "text", text: "continue" }],
      _meta: { claudeCode: { cwd: OLD_CWD } },
    });

    expect(setCwd).not.toHaveBeenCalled();
    expect(session.cwd).toBe(OLD_CWD);
  });
});
