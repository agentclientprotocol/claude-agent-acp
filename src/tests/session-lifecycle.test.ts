import { describe, expect, it, vi } from "vitest";
import { ClaudeAcpAgent, computeSessionFingerprint, type AcpClient } from "../acp-agent.js";
import { mockSessionState, wrapQuery } from "./session-doubles.js";
import { Pushable } from "../utils.js";

vi.mock("../resumed-session.js", async () => ({
  ...(await vi.importActual<typeof import("../resumed-session.js")>("../resumed-session.js")),
  readResumedSession: vi.fn(async () => ({ messages: [] })),
}));

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => (release = resolve));
  return { promise, release };
}

function fixture() {
  const agent = new ClaudeAcpAgent(
    {
      sessionUpdate: async () => {},
      extNotification: async () => {},
    } as unknown as AcpClient,
    { log: () => {}, error: () => {} },
  );
  vi.spyOn(agent as any, "validateCwd").mockResolvedValue(undefined);
  vi.spyOn(agent as any, "replaySessionHistory").mockResolvedValue(undefined);
  vi.spyOn(agent as any, "sendAvailableCommandsUpdate").mockResolvedValue(undefined);
  const queries: ReturnType<typeof wrapQuery>[] = [];
  function install(sessionId: string, cwd = "/new") {
    const params = { cwd, mcpServers: [] };
    const query = wrapQuery((async function* () {})());
    queries.push(query);
    const session = mockSessionState({
      input: new Pushable(),
      query,
      creationParams: params,
      cwd,
      sessionFingerprint: computeSessionFingerprint(params),
    });
    agent.sessions[sessionId] = session;
    return session;
  }
  const started = gate();
  const creation = gate();
  const create = vi
    .spyOn(agent as any, "createSession")
    .mockImplementation(async (params: any, options: any = {}) => {
      started.release();
      await creation.promise;
      const sessionId = options.resume ?? options.publicSessionId ?? "new-session";
      const session = install(sessionId, params.cwd);
      return { sessionId, modes: session.modes, configOptions: session.configOptions };
    });
  return { agent, install, queries, started, creation, create };
}

describe("session lifecycle serialization", () => {
  it("creates an initially absent session only once for concurrent loads", async () => {
    const f = fixture();
    const params = { sessionId: "s1", cwd: "/new", mcpServers: [] };
    try {
      const first = f.agent.loadSession(params);
      const second = f.agent.loadSession(params);
      await f.started.promise;
      f.creation.release();
      await Promise.all([first, second]);
      expect(f.create).toHaveBeenCalledTimes(1);
    } finally {
      f.creation.release();
      await f.agent.dispose();
    }
  });

  it("disposes the replacement created by an in-flight resume", async () => {
    const f = fixture();
    f.install("s1", "/old");
    try {
      const resume = f.agent.resumeSession({ sessionId: "s1", cwd: "/new", mcpServers: [] });
      await f.started.promise;
      const dispose = f.agent.dispose();
      f.creation.release();
      await Promise.all([resume, dispose]);
      expect(f.agent.sessions).toEqual({});
      expect(f.queries).toHaveLength(2);
      for (const query of f.queries) expect(query.close).toHaveBeenCalledTimes(1);
    } finally {
      f.creation.release();
      await f.agent.dispose();
    }
  });

  it("rejects new lifecycle work once disposal starts", async () => {
    const f = fixture();
    try {
      const resume = f.agent.resumeSession({ sessionId: "s1", cwd: "/new", mcpServers: [] });
      await f.started.promise;
      const dispose = f.agent.dispose();
      const late = f.agent.resumeSession({ sessionId: "s2", cwd: "/new", mcpServers: [] }).then(
        () => ({ accepted: true, error: undefined }),
        (error: unknown) => ({ accepted: false, error }),
      );
      f.creation.release();
      await Promise.all([resume, dispose]);
      const result = await late;
      expect(result.accepted).toBe(false);
      expect(result.error).toMatchObject({ message: expect.stringMatching(/shutting down/) });
      expect(f.create).toHaveBeenCalledTimes(1);
    } finally {
      f.creation.release();
      await f.agent.dispose();
    }
  });

  it("closes the replacement rather than racing a provider recreation", async () => {
    const f = fixture();
    f.install("s1");
    try {
      const update = (f.agent as any).enqueueProviderUpdate(undefined);
      await f.started.promise;
      const close = f.agent.closeSession({ sessionId: "s1" }).then(
        () => ({ closed: true, error: undefined }),
        (error: unknown) => ({ closed: false, error }),
      );
      await Promise.resolve();
      f.creation.release();
      await update;
      expect(await close).toEqual({ closed: true, error: undefined });
      expect(f.agent.sessions).toEqual({});
      expect(f.queries).toHaveLength(2);
      for (const query of f.queries) expect(query.close).toHaveBeenCalledTimes(1);
    } finally {
      f.creation.release();
      await f.agent.dispose();
    }
  });

  it("does not resurrect a session when close races a sign-out respawn", async () => {
    const f = fixture();
    const original = f.install("s1");
    original.needsSignOutRespawn = true;
    original.queryClosed = true;
    original.query.close();
    try {
      const respawn = (f.agent as any)
        .respawnSignedOutSession("s1", original)
        .catch((error: Error) => error);
      await f.started.promise;
      const close = f.agent.closeSession({ sessionId: "s1" });
      await Promise.resolve();
      f.creation.release();
      await Promise.all([respawn, close]);
      expect(f.agent.sessions).toEqual({});
      expect(f.queries).toHaveLength(2);
      expect(f.queries[1].close).toHaveBeenCalledTimes(1);
    } finally {
      f.creation.release();
      await f.agent.dispose();
    }
  });

  it("allows different session IDs to create concurrently", async () => {
    const f = fixture();
    try {
      const first = f.agent.resumeSession({ sessionId: "s1", cwd: "/new", mcpServers: [] });
      const second = f.agent.resumeSession({ sessionId: "s2", cwd: "/new", mcpServers: [] });
      await vi.waitFor(() => expect(f.create).toHaveBeenCalledTimes(2));
      f.creation.release();
      await Promise.all([first, second]);
      expect(Object.keys(f.agent.sessions).sort()).toEqual(["s1", "s2"]);
    } finally {
      f.creation.release();
      await f.agent.dispose();
    }
  });

  it("drains anonymous creation and shares the disposal promise", async () => {
    const f = fixture();
    try {
      const create = f.agent.newSession({ cwd: "/new", mcpServers: [] });
      await f.started.promise;
      const dispose = f.agent.dispose();
      expect(f.agent.dispose()).toBe(dispose);
      f.creation.release();
      await Promise.all([create, dispose]);
      expect(f.agent.sessions).toEqual({});
      expect(f.queries[0].close).toHaveBeenCalledTimes(1);
    } finally {
      f.creation.release();
      await f.agent.dispose();
    }
  });

  it("includes an accepted creation in a subsequent provider update", async () => {
    const f = fixture();
    try {
      const create = f.agent.resumeSession({ sessionId: "s1", cwd: "/new", mcpServers: [] });
      await f.started.promise;
      const update = (f.agent as any).enqueueProviderUpdate(undefined);
      f.creation.release();
      await Promise.all([create, update]);
      expect(f.create).toHaveBeenCalledTimes(2);
      expect(f.queries[0].close).toHaveBeenCalledTimes(1);
      expect(f.agent.sessions.s1.query).toBe(f.queries[1]);
    } finally {
      f.creation.release();
      await f.agent.dispose();
    }
  });

  it("disposes a provider replacement already being created", async () => {
    const f = fixture();
    f.install("s1");
    try {
      const update = (f.agent as any).enqueueProviderUpdate(undefined);
      await f.started.promise;
      const dispose = f.agent.dispose();
      f.creation.release();
      await Promise.all([update, dispose]);
      expect(f.agent.sessions).toEqual({});
      expect(f.queries).toHaveLength(2);
      for (const query of f.queries) expect(query.close).toHaveBeenCalledTimes(1);
    } finally {
      f.creation.release();
      await f.agent.dispose();
    }
  });

  it("cancels a turn before waiting for its blocked provider update", async () => {
    const f = fixture();
    const session = f.install("s1");
    const turn = gate();
    const waiting = gate();
    session.turnQueue = [{ completion: turn.promise }] as any;
    vi.spyOn(turn.promise, "then").mockImplementation((...args) => {
      waiting.release();
      return Promise.prototype.then.apply(turn.promise, args);
    });
    vi.spyOn(f.agent as any, "cancelTurns").mockImplementation(async () => turn.release());
    try {
      const update = (f.agent as any).enqueueProviderUpdate(undefined);
      await waiting.promise;
      await Promise.all([update, f.agent.dispose()]);
      expect(f.create).not.toHaveBeenCalled();
      expect(f.agent.sessions).toEqual({});
      expect(f.queries[0].close).toHaveBeenCalledTimes(1);
    } finally {
      turn.release();
      f.creation.release();
      await f.agent.dispose();
    }
  });

  it("closes an existing session before a legacy new-session resume", async () => {
    const f = fixture();
    f.install("s1");
    try {
      const create = f.agent.newSession({
        cwd: "/new",
        mcpServers: [],
        _meta: { claudeCode: { options: { resume: "s1" } } },
      });
      await f.started.promise;
      expect(f.queries[0].close).toHaveBeenCalledTimes(1);
      f.creation.release();
      await create;
      expect(f.agent.sessions.s1.query).toBe(f.queries[1]);
    } finally {
      f.creation.release();
      await f.agent.dispose();
    }
  });

  it("keeps the existing session if legacy resume cwd validation fails", async () => {
    const f = fixture();
    const original = f.install("s1");
    vi.mocked((f.agent as any).validateCwd).mockRejectedValue(new Error("Invalid cwd"));
    try {
      await expect(
        f.agent.newSession({
          cwd: "/invalid",
          mcpServers: [],
          _meta: { claudeCode: { options: { resume: "s1" } } },
        }),
      ).rejects.toThrow("Invalid cwd");
      expect(f.agent.sessions.s1).toBe(original);
      expect(f.queries[0].close).not.toHaveBeenCalled();
      expect(f.create).not.toHaveBeenCalled();
    } finally {
      await f.agent.dispose();
    }
  });

  it("continues the lifecycle queue after a failed creation", async () => {
    const f = fixture();
    f.create.mockRejectedValueOnce(new Error("Creation failed"));
    try {
      const first = f.agent.resumeSession({ sessionId: "s1", cwd: "/new", mcpServers: [] });
      const second = f.agent.resumeSession({ sessionId: "s1", cwd: "/new", mcpServers: [] });
      await expect(first).rejects.toThrow("Creation failed");
      await f.started.promise;
      f.creation.release();
      await second;
      expect(f.create).toHaveBeenCalledTimes(2);
      expect(f.agent.sessions.s1).toBeDefined();
    } finally {
      f.creation.release();
      await f.agent.dispose();
    }
  });

  it("closes a replacement created by a clear-context restart", async () => {
    const f = fixture();
    const original = f.install("s1");
    const host = (f.agent as any).exitPlan.host;
    host.closeQueryStream(original);
    try {
      const restart = host.restartSession(original.creationParams, {
        publicSessionId: "s1",
        permissionMode: "default",
      });
      await f.started.promise;
      const close = f.agent.closeSession({ sessionId: "s1" });
      f.creation.release();
      await Promise.all([restart, close]);
      expect(f.agent.sessions).toEqual({});
      expect(f.queries).toHaveLength(2);
      for (const query of f.queries) expect(query.close).toHaveBeenCalledTimes(1);
    } finally {
      f.creation.release();
      await f.agent.dispose();
    }
  });

  it("abandons a clear-context restart queued behind a close", async () => {
    const f = fixture();
    const original = f.install("s1");
    const host = (f.agent as any).exitPlan.host;
    try {
      const close = f.agent.closeSession({ sessionId: "s1" });
      const restart = host.restartSession(original.creationParams, {
        publicSessionId: "s1",
        permissionMode: "default",
      });
      await expect(restart).rejects.toThrow("Clear-context restart aborted");
      await close;
      expect(f.create).not.toHaveBeenCalled();
      expect(f.agent.sessions).toEqual({});
    } finally {
      await f.agent.dispose();
    }
  });

  it("does not respawn a signed-out session queued behind a close", async () => {
    const f = fixture();
    const original = f.install("s1");
    original.needsSignOutRespawn = true;
    try {
      const close = f.agent.closeSession({ sessionId: "s1" });
      const respawn = (f.agent as any).respawnSignedOutSession("s1", original);
      await expect(respawn).rejects.toThrow("Session not found");
      await close;
      expect(f.create).not.toHaveBeenCalled();
      expect(f.agent.sessions).toEqual({});
    } finally {
      await f.agent.dispose();
    }
  });

  it("does not discard a later resume when a cancelled restart finishes", async () => {
    const f = fixture();
    const original = f.install("s1");
    const turn = {
      promptUuid: "turn",
      settled: false,
      resolve: vi.fn(),
      reject: vi.fn(),
    };
    original.activeTurn = turn as any;
    original.turnQueue = [turn] as any;
    vi.spyOn(f.agent as any, "ensureConsumer").mockImplementation(() => {});
    try {
      const restart = (f.agent as any).exitPlan.restart("s1", original, {
        toolUseId: "plan",
        plan: "Implement it",
        mode: "default",
      });
      await f.started.promise;
      const close = f.agent.closeSession({ sessionId: "s1" });
      const resume = f.agent.resumeSession({ sessionId: "s1", cwd: "/next", mcpServers: [] });
      f.creation.release();
      await Promise.all([restart, close, resume]);
      expect(f.agent.sessions.s1.query).toBe(f.queries[2]);
      expect(f.queries[2].close).not.toHaveBeenCalled();
      expect(turn.resolve).toHaveBeenCalledWith(
        expect.objectContaining({ stopReason: "cancelled" }),
      );
    } finally {
      f.creation.release();
      await f.agent.dispose();
    }
  });
});
