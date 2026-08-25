import { describe, expect, it, vi } from "vitest";
import type { SessionNotification } from "@agentclientprotocol/sdk";
import { AUTO_MODE_FALLBACK, type SessionMode, SessionModeManager } from "../session-mode.js";

const SESSION_ID = "session-1";

function createSession(overrides: Partial<SessionMode> = {}): SessionMode {
  return {
    query: { setPermissionMode: vi.fn() },
    modes: {
      currentModeId: "default",
      availableModes: [
        { id: "default", name: "Manual" },
        { id: "acceptEdits", name: "Accept edits" },
        { id: "plan", name: "Plan" },
        { id: "auto", name: "Auto" },
      ],
    },
    models: { currentModelId: "opus" },
    modelInfos: [{ value: "opus", displayName: "Opus", description: "", supportsAutoMode: true }],
    ...overrides,
  };
}

function createNotifications(updates: SessionNotification[]) {
  return {
    sessionUpdate: vi.fn(async (update: SessionNotification) => {
      updates.push(update);
    }),
    logError: vi.fn(),
  };
}

function createManager(session: SessionMode | undefined, updates: SessionNotification[] = []) {
  const notifications = createNotifications(updates);
  const updateConfigOption = vi.fn();
  const manager = new SessionModeManager({
    ...notifications,
    getSession: () => session,
    sessionEndedMessage: "start a new session",
    updateConfigOption,
  });
  return { manager, notifications, updateConfigOption };
}

describe("session mode", () => {
  it("applies a valid mode to the SDK query", async () => {
    const session = createSession();
    const { manager } = createManager(session);
    await expect(manager.selectMode(SESSION_ID, "plan")).resolves.toBe("plan");
    expect(session.query.setPermissionMode).toHaveBeenCalledWith("plan");
  });

  it("rejects invalid and unavailable modes before touching the query", async () => {
    const session = createSession();
    const { manager } = createManager(session);
    await expect(manager.selectMode(SESSION_ID, "future")).rejects.toThrow("Invalid Mode");
    await expect(manager.selectMode(SESSION_ID, "bypassPermissions")).rejects.toThrow(
      "Mode bypassPermissions is not available in this session",
    );
    expect(session.query.setPermissionMode).not.toHaveBeenCalled();
  });

  it("detects model-specific Auto availability", () => {
    const session = createSession({
      modelInfos: [
        { value: "opus", displayName: "Opus", description: "", supportsAutoMode: true },
        { value: "haiku", displayName: "Haiku", description: "" },
      ],
    });
    const { manager } = createManager(session);
    expect(manager.effectiveMode(session, "auto")).toBe("auto");
    session.models.currentModelId = "haiku";
    expect(manager.effectiveMode(session, "auto")).toBe("acceptEdits");
    session.models.currentModelId = "unknown";
    expect(manager.effectiveMode(session, "auto")).toBe("auto");
  });

  it("falls Auto back to Accept edits and warns only once per session", async () => {
    const updates: SessionNotification[] = [];
    const session = createSession({
      models: { currentModelId: "haiku" },
      modelInfos: [{ value: "haiku", displayName: "Haiku", description: "" }],
    });
    const { manager } = createManager(session, updates);

    await expect(manager.selectMode(SESSION_ID, "auto")).resolves.toBe(AUTO_MODE_FALLBACK);
    await manager.selectMode(SESSION_ID, "auto");

    expect(session.query.setPermissionMode).toHaveBeenCalledTimes(2);
    expect(session.query.setPermissionMode).toHaveBeenCalledWith("acceptEdits");
    expect(
      updates.filter((notification) => notification.update.sessionUpdate === "agent_message_chunk"),
    ).toHaveLength(1);
  });

  it("handles setSessionMode and publishes the updated config option", async () => {
    const updates: SessionNotification[] = [];
    const session = createSession();
    const { manager, notifications, updateConfigOption } = createManager(session, updates);

    await manager.setSessionMode({ sessionId: SESSION_ID, modeId: "plan" });

    expect(updateConfigOption).toHaveBeenCalledWith(SESSION_ID, "mode", "plan");
    expect(notifications.sessionUpdate).not.toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({ sessionUpdate: "current_mode_update" }),
      }),
    );
  });

  it("rejects missing and closed sessions", async () => {
    await expect(
      createManager(undefined).manager.setSessionMode({ sessionId: SESSION_ID, modeId: "plan" }),
    ).rejects.toThrow("Session not found");

    await expect(
      createManager(createSession({ queryClosed: true })).manager.setSessionMode({
        sessionId: SESSION_ID,
        modeId: "plan",
      }),
    ).rejects.toThrow("start a new session");
  });

  it("initializes the stable mode catalog and falls unsupported Auto back", async () => {
    const setPermissionMode = vi.fn();
    const { manager, notifications } = createManager(undefined);
    const result = await manager.initialize({
      query: { setPermissionMode },
      requestedMode: "auto",
      currentModelInfo: { value: "haiku", displayName: "Haiku", description: "" },
      currentModelId: "haiku",
    });

    expect(result.modes.currentModeId).toBe("acceptEdits");
    expect(result.modes.availableModes.map((mode) => mode.id)).toEqual(
      expect.arrayContaining(["default", "acceptEdits", "plan", "auto"]),
    );
    expect(result.autoModeFallbackWarningPending).toBe(true);
    expect(setPermissionMode).toHaveBeenCalledWith("acceptEdits");
    expect(notifications.logError).toHaveBeenCalledWith(expect.stringContaining("falling back"));
  });

  it("keeps mode state and its config option synchronized", () => {
    const session = {
      ...createSession(),
      configOptions: [SessionModeManager.configOption(createSession().modes)],
    };
    createManager(session).manager.syncConfig(session, "plan");

    expect(session.modes.currentModeId).toBe("plan");
    expect(session.configOptions[0].currentValue).toBe("plan");
  });

  it("reconciles Auto after a model switch", async () => {
    const session = createSession();
    session.modes.currentModeId = "auto";
    const { manager } = createManager(session);

    await expect(
      manager.reconcileForModel(session, {
        value: "haiku",
        displayName: "Haiku",
        description: "",
      }),
    ).resolves.toBe(true);
    expect(session.modes.currentModeId).toBe("acceptEdits");
    expect(session.query.setPermissionMode).toHaveBeenCalledWith("acceptEdits");
  });
});
