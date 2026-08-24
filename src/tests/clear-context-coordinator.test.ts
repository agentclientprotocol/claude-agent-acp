import { describe, expect, it, vi } from "vitest";
import {
  ClearContextCoordinatorHost,
  ClearContextSession,
  ClearContextTurn,
  continuePlanInFreshContext,
} from "../clear-context-coordinator.js";
import { ExitPlanCoordinator, observeExitPlanToolResults } from "../exit-plan.js";

type TestSession = ClearContextSession<ClearContextTurn>;

function testSession(overrides: Partial<TestSession> = {}): TestSession {
  return {
    cwd: "/workspace",
    accumulatedUsage: {
      inputTokens: 10,
      outputTokens: 20,
      cachedReadTokens: 30,
      cachedWriteTokens: 40,
    },
    accumulatedModelUsage: {
      "claude-sonnet-5": {
        inputTokens: 10,
        outputTokens: 20,
        cachedReadTokens: 30,
        cachedWriteTokens: 40,
      },
    },
    models: { currentModelId: "default" },
    configOptions: [],
    currentAgent: "default",
    fastModeEnabled: false,
    input: { push: vi.fn() },
    ...overrides,
  };
}

function testHost(
  oldSession: TestSession,
  freshSession: TestSession,
): ClearContextCoordinatorHost<TestSession, ClearContextTurn> {
  let currentSession = oldSession;
  return {
    currentSession: vi.fn(() => currentSession),
    closeQueryStream: vi.fn(),
    restartSession: vi.fn(async () => {
      currentSession = freshSession;
      return freshSession;
    }),
    applyFastMode: vi.fn(async () => {}),
    publishSessionState: vi.fn(async () => {}),
    continuationMessage: vi.fn((sessionId, plan, promptUuid) => ({
      type: "user" as const,
      message: {
        role: "user" as const,
        content: [{ type: "text" as const, text: `Implement the following plan:\n\n${plan}` }],
      },
      session_id: sessionId,
      parent_tool_use_id: null,
      origin: { kind: "human" as const },
      uuid: promptUuid as `${string}-${string}-${string}-${string}-${string}`,
    })),
    ensureConsumer: vi.fn(),
    logError: vi.fn(),
  };
}

describe("continuePlanInFreshContext", () => {
  it("moves the pending ACP turn and its session preferences to a fresh query", async () => {
    const turn: ClearContextTurn = {
      settled: false,
      promptUuid: "00000000-0000-4000-8000-000000000000",
    };
    const reset = { toolUseId: "tool-plan", plan: "Ship it", mode: "auto" as const };
    const oldSession = testSession({
      activeTurn: turn,
      turnQueue: [turn],
      pendingExitPlanContextReset: reset,
      models: { currentModelId: "claude-sonnet" },
      currentAgent: "reviewer",
      fastModeEnabled: true,
      configOptions: [
        {
          id: "effort",
          name: "Effort",
          type: "select",
          currentValue: "high",
          options: [{ value: "high", name: "High" }],
        },
      ],
      creationParams: {
        cwd: "/workspace",
        mcpServers: [],
        _meta: { caller: "test", claudeCode: { options: { env: { PRESERVED: "yes" } } } },
      },
    });
    const freshSession = testSession();
    const host = testHost(oldSession, freshSession);

    await continuePlanInFreshContext("public-session", oldSession, reset, host);

    expect(host.restartSession).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: "/workspace",
        _meta: expect.objectContaining({
          caller: "test",
          claudeCode: {
            options: expect.objectContaining({
              env: { PRESERVED: "yes" },
              model: "claude-sonnet",
              agent: "reviewer",
              effort: "high",
            }),
          },
        }),
      }),
      { publicSessionId: "public-session", permissionMode: "auto" },
    );
    expect(turn.carriedUsage).toEqual(oldSession.accumulatedUsage);
    expect(turn.carriedUsage).not.toBe(oldSession.accumulatedUsage);
    // The per-model breakdown rides along, so the turn's `_meta.quota` rows
    // still cover what it spent before the restart.
    expect(turn.carriedModelUsage).toEqual(oldSession.accumulatedModelUsage);
    expect(turn.carriedModelUsage).not.toBe(oldSession.accumulatedModelUsage);
    expect(oldSession.pendingExitPlanContextReset).toBeUndefined();
    expect(oldSession.activeTurn).toBeNull();
    expect(oldSession.turnQueue).toEqual([]);
    expect(freshSession.turnQueue).toEqual([turn]);
    expect(freshSession.contextUsedTokens).toBe(0);
    expect(host.applyFastMode).toHaveBeenCalledWith(freshSession, true);
    expect(host.continuationMessage).toHaveBeenCalledWith(
      "public-session",
      "Ship it",
      turn.promptUuid,
    );
    expect(freshSession.input.push).toHaveBeenCalledWith(
      expect.objectContaining({
        uuid: turn.promptUuid,
        origin: { kind: "human" },
        message: expect.objectContaining({
          content: [{ type: "text", text: "Implement the following plan:\n\nShip it" }],
        }),
      }),
    );
    expect(host.ensureConsumer).toHaveBeenCalledWith(freshSession, "public-session");
  });

  it("does not resurrect original preferences after the session returns to defaults", async () => {
    const turn: ClearContextTurn = {
      settled: false,
      promptUuid: "00000000-0000-4000-8000-000000000000",
    };
    const oldSession = testSession({
      activeTurn: turn,
      models: { currentModelId: "default" },
      currentAgent: "default",
      configOptions: [
        {
          id: "effort",
          name: "Effort",
          type: "select",
          currentValue: "default",
          options: [{ value: "default", name: "Default" }],
        },
      ],
      creationParams: {
        cwd: "/workspace",
        mcpServers: [],
        _meta: {
          claudeCode: {
            options: {
              model: "stale-model",
              agent: "stale-agent",
              effort: "high",
              env: { PRESERVED: "yes" },
            },
          },
        },
      },
    });
    const host = testHost(oldSession, testSession());

    await continuePlanInFreshContext(
      "public-session",
      oldSession,
      { toolUseId: "tool-plan", plan: "Ship it", mode: "default" },
      host,
    );

    const restartParams = vi.mocked(host.restartSession).mock.calls[0]?.[0];
    expect(restartParams?._meta).toEqual({
      claudeCode: { options: { env: { PRESERVED: "yes" } } },
    });
  });

  it("restores disabled Fast mode when a fresh session starts with it enabled", async () => {
    const turn: ClearContextTurn = {
      settled: false,
      promptUuid: "00000000-0000-4000-8000-000000000000",
    };
    const oldSession = testSession({ activeTurn: turn, fastModeEnabled: false });
    const freshSession = testSession({ fastModeEnabled: true });
    const host = testHost(oldSession, freshSession);

    await continuePlanInFreshContext(
      "public-session",
      oldSession,
      { toolUseId: "tool-plan", plan: "Ship it", mode: "auto" },
      host,
    );

    expect(host.applyFastMode).toHaveBeenCalledWith(freshSession, false);
  });

  it("does not publish or continue a restart cancelled while creating the fresh session", async () => {
    const turn: ClearContextTurn = {
      settled: false,
      promptUuid: "00000000-0000-4000-8000-000000000000",
    };
    const oldSession = testSession({ activeTurn: turn });
    const freshSession = testSession();
    const host = testHost(oldSession, freshSession);
    let finishRestart!: () => void;
    vi.mocked(host.restartSession).mockImplementation(
      () =>
        new Promise<TestSession>((resolve) => {
          finishRestart = () => resolve(freshSession);
        }),
    );
    const controller = new AbortController();

    const restart = continuePlanInFreshContext(
      "public-session",
      oldSession,
      { toolUseId: "tool-plan", plan: "Ship it", mode: "auto" },
      host,
      controller.signal,
    );
    await vi.waitFor(() => expect(host.restartSession).toHaveBeenCalled());
    controller.abort();
    finishRestart();

    await expect(restart).rejects.toThrow("Clear-context restart aborted");
    expect(host.publishSessionState).not.toHaveBeenCalled();
    expect(freshSession.input.push).not.toHaveBeenCalled();
    expect(host.ensureConsumer).not.toHaveBeenCalled();
  });

  it("rejects a stale session before closing its query", async () => {
    const turn: ClearContextTurn = {
      settled: false,
      promptUuid: "00000000-0000-4000-8000-000000000000",
    };
    const oldSession = testSession({ activeTurn: turn });
    const host = testHost(oldSession, testSession());
    vi.mocked(host.currentSession).mockReturnValue(testSession());

    await expect(
      continuePlanInFreshContext(
        "public-session",
        oldSession,
        { toolUseId: "tool-plan", plan: "Ship it", mode: "auto" },
        host,
      ),
    ).rejects.toThrow("Cannot clear context without an active ACP turn");

    expect(host.closeQueryStream).not.toHaveBeenCalled();
    expect(host.restartSession).not.toHaveBeenCalled();
  });
});

describe("ExitPlanCoordinator", () => {
  it("owns cancellation cleanup for a replacement created after close", async () => {
    const turn: ClearContextTurn = {
      settled: false,
      promptUuid: "00000000-0000-4000-8000-000000000000",
    };
    const oldSession = testSession({ activeTurn: turn, turnQueue: [turn] });
    const freshSession = testSession();
    const baseHost = testHost(oldSession, freshSession);
    const destroyReplacement = vi.fn();
    const settleCancelledTurn = vi.fn((_old, _owner, cancelledTurn: ClearContextTurn) => {
      cancelledTurn.settled = true;
    });
    let finishRestart!: () => void;
    vi.mocked(baseHost.restartSession).mockImplementation(
      () =>
        new Promise<TestSession>((resolve) => {
          finishRestart = () => {
            vi.mocked(baseHost.currentSession).mockReturnValue(freshSession);
            resolve(freshSession);
          };
        }),
    );
    const host = {
      ...baseHost,
      sessionUpdate: vi.fn(async () => {}),
      destroyReplacement,
      settleCancelledTurn,
      settleFailedTurn: vi.fn(),
    };
    const coordinator = new ExitPlanCoordinator<TestSession, ClearContextTurn>(host);

    const restart = coordinator.restart("public-session", oldSession, {
      toolUseId: "tool-plan",
      plan: "Ship it",
      mode: "auto",
    });
    await vi.waitFor(() => expect(baseHost.restartSession).toHaveBeenCalled());
    coordinator.cancel("public-session");
    finishRestart();
    await restart;

    expect(destroyReplacement).toHaveBeenCalledWith("public-session", freshSession);
    expect(settleCancelledTurn).toHaveBeenCalledWith(oldSession, oldSession, turn);
    expect(oldSession.activeTurn).toBeNull();
    expect(oldSession.turnQueue).toEqual([]);
    expect(freshSession.input.push).not.toHaveBeenCalled();
    expect(baseHost.ensureConsumer).not.toHaveBeenCalled();
  });

  it("settles a restart failure without classifying it as a query transport loss", async () => {
    const error = new Error("restart failed");
    const turn: ClearContextTurn = {
      settled: false,
      promptUuid: "00000000-0000-4000-8000-000000000000",
    };
    const reset = { toolUseId: "tool-plan", plan: "Ship it", mode: "auto" as const };
    const oldSession = testSession({
      activeTurn: turn,
      turnQueue: [turn],
      pendingExitPlanContextReset: reset,
    });
    const baseHost = testHost(oldSession, testSession());
    vi.mocked(baseHost.restartSession).mockRejectedValue(error);
    const settleFailedTurn = vi.fn((_owner, failedTurn: ClearContextTurn) => {
      failedTurn.settled = true;
    });
    const host = {
      ...baseHost,
      sessionUpdate: vi.fn(async () => {}),
      destroyReplacement: vi.fn(),
      settleCancelledTurn: vi.fn(),
      settleFailedTurn,
    };
    const coordinator = new ExitPlanCoordinator<TestSession, ClearContextTurn>(host);

    await coordinator.restart("public-session", oldSession, reset);

    expect(settleFailedTurn).toHaveBeenCalledWith(oldSession, turn, error);
    expect(turn.carriedUsage).toBeUndefined();
    expect(turn.carriedModelUsage).toBeUndefined();
    expect(oldSession.pendingExitPlanContextReset).toBeUndefined();
    expect(oldSession.activeTurn).toBeNull();
    expect(oldSession.turnQueue).toEqual([]);
  });
});

describe("observeExitPlanToolResults", () => {
  it("restores a rejected ExitPlanMode marker from authoritative stream metadata", () => {
    const state = {
      toolUseCache: { "tool-plan": { name: "ExitPlanMode" } },
    };

    const accepted = observeExitPlanToolResults(
      {
        type: "user",
        tool_result_meta: [{ id: "tool-plan", non_execution_kind: "user-rejected" }],
      },
      [{ type: "tool_result", tool_use_id: "tool-plan", is_error: true }],
      state,
    );

    expect(accepted).toBeUndefined();
    expect(state).toEqual({
      toolUseCache: { "tool-plan": { name: "ExitPlanMode" } },
      pendingExitPlanModeInterruption: { toolUseId: "tool-plan", toolResultSeen: true },
    });
  });

  it("correlates an accepted plan result with its pending context reset", () => {
    const state = {
      toolUseCache: { "tool-plan": { name: "ExitPlanMode" } },
      pendingExitPlanContextReset: {
        toolUseId: "tool-plan",
        plan: "Ship it",
        mode: "auto" as const,
      },
    };

    expect(
      observeExitPlanToolResults(
        { type: "user" },
        [{ type: "tool_result", tool_use_id: "tool-plan", is_error: true }],
        state,
      ),
    ).toBe("tool-plan");
  });
});
