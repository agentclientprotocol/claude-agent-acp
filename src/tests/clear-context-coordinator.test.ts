import { describe, expect, it, vi } from "vitest";
import {
  ClearContextCoordinatorHost,
  ClearContextSession,
  ClearContextTurn,
  continuePlanInFreshContext,
} from "../clear-context-coordinator.js";

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
  return {
    currentSession: vi.fn(() => oldSession),
    closeQueryStream: vi.fn(),
    restartSession: vi.fn(async () => freshSession),
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
