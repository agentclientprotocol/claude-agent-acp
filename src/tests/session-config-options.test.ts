import { describe, it, expect, beforeEach, vi } from "vitest";
import { AgentSideConnection, SessionNotification } from "@agentclientprotocol/sdk";
import type { ClaudeAcpAgent as ClaudeAcpAgentType } from "../acp-agent.js";

const { registerHookCallbackSpy } = vi.hoisted(() => ({
  registerHookCallbackSpy: vi.fn(),
}));

vi.mock("../tools.js", async () => {
  const actual = await vi.importActual<typeof import("../tools.js")>("../tools.js");
  return {
    ...actual,
    registerHookCallback: registerHookCallbackSpy,
  };
});

const SESSION_ID = "test-session-id";

const MOCK_MODES = {
  currentModeId: "default",
  availableModes: [
    { id: "default", name: "Default", description: "Standard behavior" },
    { id: "plan", name: "Plan Mode", description: "Planning mode" },
    { id: "acceptEdits", name: "Accept Edits", description: "Auto-accept edits" },
  ],
};

const MOCK_MODELS = {
  currentModelId: "claude-opus-4-5",
  availableModels: [
    { modelId: "claude-opus-4-5", name: "Claude Opus", description: "Most capable" },
    { modelId: "claude-sonnet-4-5", name: "Claude Sonnet", description: "Balanced" },
  ],
};

const MOCK_CONFIG_OPTIONS = [
  {
    id: "mode",
    name: "Mode",
    type: "select",
    category: "mode",
    currentValue: "default",
    options: MOCK_MODES.availableModes.map((m) => ({
      value: m.id,
      name: m.name,
      description: m.description,
    })),
  },
  {
    id: "model",
    name: "Model",
    type: "select",
    category: "model",
    currentValue: "claude-opus-4-5",
    options: MOCK_MODELS.availableModels.map((m) => ({
      value: m.modelId,
      name: m.name,
      description: m.description,
    })),
  },
];

describe("session config options", () => {
  let agent: ClaudeAcpAgentType;
  let ClaudeAcpAgent: typeof ClaudeAcpAgentType;
  let sessionUpdates: SessionNotification[];
  let createSessionSpy: ReturnType<typeof vi.fn>;
  let setPermissionModeSpy: ReturnType<typeof vi.fn>;
  let setModelSpy: ReturnType<typeof vi.fn>;

  function createMockClient(): AgentSideConnection {
    return {
      sessionUpdate: async (notification: SessionNotification) => {
        sessionUpdates.push(notification);
      },
      requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
      readTextFile: async () => ({ content: "" }),
      writeTextFile: async () => ({}),
    } as unknown as AgentSideConnection;
  }

  function populateSession() {
    setPermissionModeSpy = vi.fn();
    setModelSpy = vi.fn();

    (agent as unknown as { sessions: Record<string, unknown> }).sessions[SESSION_ID] = {
      query: {
        setPermissionMode: setPermissionModeSpy,
        setModel: setModelSpy,
        supportedCommands: async () => [],
      },
      input: null,
      cancelled: false,
      cwd: "/test",
      settingsManager: {},
      accumulatedUsage: {
        inputTokens: 0,
        outputTokens: 0,
        cachedReadTokens: 0,
        cachedWriteTokens: 0,
      },
      modes: structuredClone(MOCK_MODES),
      models: structuredClone(MOCK_MODELS),
      configOptions: structuredClone(MOCK_CONFIG_OPTIONS),
      promptRunning: false,
      pendingMessages: new Map(),
      nextPendingOrder: 0,
      abortController: new AbortController(),
    };
  }

  beforeEach(async () => {
    sessionUpdates = [];
    registerHookCallbackSpy.mockClear();

    vi.resetModules();
    const acpAgent = await import("../acp-agent.js");
    ClaudeAcpAgent = acpAgent.ClaudeAcpAgent;

    agent = new ClaudeAcpAgent(createMockClient());
    createSessionSpy = vi.fn(async () => ({
      sessionId: SESSION_ID,
      modes: MOCK_MODES,
      models: MOCK_MODELS,
      configOptions: MOCK_CONFIG_OPTIONS,
    }));
    (agent as unknown as { createSession: typeof createSessionSpy }).createSession =
      createSessionSpy;
  });

  describe("newSession returns configOptions", () => {
    it("includes configOptions in the response", async () => {
      const response = await agent.newSession({ cwd: "/test", mcpServers: [] });
      expect(response.configOptions).toBeDefined();
      expect(response.configOptions).toEqual(MOCK_CONFIG_OPTIONS);
    });

    it("includes mode and model config options", async () => {
      const response = await agent.newSession({ cwd: "/test", mcpServers: [] });
      const modeOption = response.configOptions?.find((o) => o.id === "mode");
      const modelOption = response.configOptions?.find((o) => o.id === "model");
      expect(modeOption).toBeDefined();
      expect(modelOption).toBeDefined();
    });
  });

  describe("loadSession returns configOptions", () => {
    it("includes configOptions from createSession", async () => {
      // loadSession calls findSessionFile first - override the whole method
      const loadSessionSpy = vi.fn(async () => ({
        modes: MOCK_MODES,
        models: MOCK_MODELS,
        configOptions: MOCK_CONFIG_OPTIONS,
      }));
      (agent as unknown as { loadSession: typeof loadSessionSpy }).loadSession = loadSessionSpy;

      const response = await agent.loadSession({
        cwd: "/test",
        sessionId: SESSION_ID,
        mcpServers: [],
      });
      expect(response.configOptions).toEqual(MOCK_CONFIG_OPTIONS);
    });
  });

  describe("setSessionConfigOption", () => {
    beforeEach(() => {
      populateSession();
    });

    it("throws when session not found", async () => {
      await expect(
        agent.setSessionConfigOption({
          sessionId: "nonexistent",
          configId: "mode",
          value: "plan",
        }),
      ).rejects.toThrow("Session not found");
    });

    it("throws when config option not found", async () => {
      await expect(
        agent.setSessionConfigOption({
          sessionId: SESSION_ID,
          configId: "unknown-option",
          value: "some-value",
        }),
      ).rejects.toThrow("Unknown config option: unknown-option");
    });

    it("throws when value is not valid for the option", async () => {
      await expect(
        agent.setSessionConfigOption({
          sessionId: SESSION_ID,
          configId: "mode",
          value: "invalid-mode",
        }),
      ).rejects.toThrow("Invalid value for config option mode: invalid-mode");
    });

    it("changes mode, sends current_mode_update but not config_option_update", async () => {
      await agent.setSessionConfigOption({
        sessionId: SESSION_ID,
        configId: "mode",
        value: "plan",
      });

      expect(setPermissionModeSpy).toHaveBeenCalledWith("plan");

      const modeUpdate = sessionUpdates.find(
        (n) => n.update.sessionUpdate === "current_mode_update",
      );
      expect(modeUpdate?.update).toMatchObject({
        sessionUpdate: "current_mode_update",
        currentModeId: "plan",
      });

      const configUpdate = sessionUpdates.find(
        (n) => n.update.sessionUpdate === "config_option_update",
      );
      expect(configUpdate).toBeUndefined();
    });

    it("changes model and does not send a config_option_update notification", async () => {
      await agent.setSessionConfigOption({
        sessionId: SESSION_ID,
        configId: "model",
        value: "claude-sonnet-4-5",
      });

      expect(setModelSpy).toHaveBeenCalledWith("claude-sonnet-4-5");

      const configUpdate = sessionUpdates.find(
        (n) => n.update.sessionUpdate === "config_option_update",
      );
      expect(configUpdate).toBeUndefined();
    });

    it("resolves model alias 'opus' to full model ID", async () => {
      const response = await agent.setSessionConfigOption({
        sessionId: SESSION_ID,
        configId: "model",
        value: "opus",
      });

      expect(setModelSpy).toHaveBeenCalledWith("claude-opus-4-5");

      const modelOption = response.configOptions.find((o) => o.id === "model");
      expect(modelOption?.currentValue).toBe("claude-opus-4-5");
    });

    it("resolves model alias 'sonnet' to full model ID", async () => {
      await agent.setSessionConfigOption({
        sessionId: SESSION_ID,
        configId: "model",
        value: "sonnet",
      });

      expect(setModelSpy).toHaveBeenCalledWith("claude-sonnet-4-5");
    });

    it("resolves display name to model ID", async () => {
      await agent.setSessionConfigOption({
        sessionId: SESSION_ID,
        configId: "model",
        value: "Claude Sonnet",
      });

      expect(setModelSpy).toHaveBeenCalledWith("claude-sonnet-4-5");
    });

    it("still works with exact model ID", async () => {
      const response = await agent.setSessionConfigOption({
        sessionId: SESSION_ID,
        configId: "model",
        value: "claude-sonnet-4-5",
      });

      expect(setModelSpy).toHaveBeenCalledWith("claude-sonnet-4-5");
      const modelOption = response.configOptions.find((o) => o.id === "model");
      expect(modelOption?.currentValue).toBe("claude-sonnet-4-5");
    });

    it("throws for completely invalid model value", async () => {
      await expect(
        agent.setSessionConfigOption({
          sessionId: SESSION_ID,
          configId: "model",
          value: "gpt-4",
        }),
      ).rejects.toThrow("Invalid value for config option model: gpt-4");
    });

    it("returns full configOptions in the response", async () => {
      const response = await agent.setSessionConfigOption({
        sessionId: SESSION_ID,
        configId: "mode",
        value: "plan",
      });

      expect(response.configOptions).toHaveLength(MOCK_CONFIG_OPTIONS.length);
      const modeOption = response.configOptions.find((o) => o.id === "mode");
      expect(modeOption?.currentValue).toBe("plan");
    });

    it("other options are unchanged when one is updated", async () => {
      const response = await agent.setSessionConfigOption({
        sessionId: SESSION_ID,
        configId: "mode",
        value: "plan",
      });

      const modelOption = response.configOptions.find((o) => o.id === "model");
      expect(modelOption?.currentValue).toBe("claude-opus-4-5");
    });
  });

  describe("setSessionMode sends config_option_update", () => {
    beforeEach(() => {
      populateSession();
    });

    it("sends config_option_update when mode is changed via setSessionMode", async () => {
      await agent.setSessionMode({ sessionId: SESSION_ID, modeId: "acceptEdits" });

      const configUpdate = sessionUpdates.find(
        (n) => n.update.sessionUpdate === "config_option_update",
      );
      expect(configUpdate).toBeDefined();
      expect(configUpdate?.update).toMatchObject({
        sessionUpdate: "config_option_update",
        configOptions: expect.arrayContaining([
          expect.objectContaining({ id: "mode", currentValue: "acceptEdits" }),
        ]),
      });
    });

    it("updates stored configOptions currentValue when mode changes", async () => {
      await agent.setSessionMode({ sessionId: SESSION_ID, modeId: "plan" });

      const session = (
        agent as unknown as {
          sessions: Record<string, { configOptions: typeof MOCK_CONFIG_OPTIONS }>;
        }
      ).sessions[SESSION_ID];
      const modeOption = session.configOptions.find((o) => o.id === "mode");
      expect(modeOption?.currentValue).toBe("plan");
    });

    it("does not send config_option_update for an invalid mode", async () => {
      await expect(
        agent.setSessionMode({ sessionId: SESSION_ID, modeId: "not-a-mode" as any }),
      ).rejects.toThrow("Invalid Mode");

      const configUpdate = sessionUpdates.find(
        (n) => n.update.sessionUpdate === "config_option_update",
      );
      expect(configUpdate).toBeUndefined();
    });
  });

  describe("unstable_setSessionModel sends config_option_update", () => {
    beforeEach(() => {
      populateSession();
    });

    it("sends config_option_update when model is changed via setSessionModel", async () => {
      await agent.unstable_setSessionModel({
        sessionId: SESSION_ID,
        modelId: "claude-sonnet-4-5",
      });

      const configUpdate = sessionUpdates.find(
        (n) => n.update.sessionUpdate === "config_option_update",
      );
      expect(configUpdate).toBeDefined();
      expect(configUpdate?.update).toMatchObject({
        sessionUpdate: "config_option_update",
        configOptions: expect.arrayContaining([
          expect.objectContaining({ id: "model", currentValue: "claude-sonnet-4-5" }),
        ]),
      });
    });

    it("updates stored configOptions currentValue when model changes", async () => {
      await agent.unstable_setSessionModel({
        sessionId: SESSION_ID,
        modelId: "claude-sonnet-4-5",
      });

      const session = (
        agent as unknown as {
          sessions: Record<string, { configOptions: typeof MOCK_CONFIG_OPTIONS }>;
        }
      ).sessions[SESSION_ID];
      const modelOption = session.configOptions.find((o) => o.id === "model");
      expect(modelOption?.currentValue).toBe("claude-sonnet-4-5");
    });
  });

  describe("no config_option_update notification when using setSessionConfigOption", () => {
    beforeEach(() => {
      populateSession();
    });

    it("sends no config_option_update when setting mode via config option", async () => {
      await agent.setSessionConfigOption({
        sessionId: SESSION_ID,
        configId: "mode",
        value: "plan",
      });

      const configUpdates = sessionUpdates.filter(
        (n) => n.update.sessionUpdate === "config_option_update",
      );
      expect(configUpdates).toHaveLength(0);
    });

    it("sends no config_option_update when setting model via config option", async () => {
      await agent.setSessionConfigOption({
        sessionId: SESSION_ID,
        configId: "model",
        value: "claude-sonnet-4-5",
      });

      const configUpdates = sessionUpdates.filter(
        (n) => n.update.sessionUpdate === "config_option_update",
      );
      expect(configUpdates).toHaveLength(0);
    });
  });

  describe("bidirectional consistency", () => {
    beforeEach(() => {
      populateSession();
    });

    it("setSessionConfigOption for mode also calls underlying setPermissionMode", async () => {
      await agent.setSessionConfigOption({
        sessionId: SESSION_ID,
        configId: "mode",
        value: "acceptEdits",
      });

      expect(setPermissionModeSpy).toHaveBeenCalledWith("acceptEdits");
    });

    it("setSessionConfigOption for model also calls underlying setModel", async () => {
      await agent.setSessionConfigOption({
        sessionId: SESSION_ID,
        configId: "model",
        value: "claude-sonnet-4-5",
      });

      expect(setModelSpy).toHaveBeenCalledWith("claude-sonnet-4-5");
    });

    it("setSessionMode also syncs configOptions", async () => {
      await agent.setSessionMode({ sessionId: SESSION_ID, modeId: "plan" });

      const session = (
        agent as unknown as {
          sessions: Record<string, { configOptions: typeof MOCK_CONFIG_OPTIONS }>;
        }
      ).sessions[SESSION_ID];
      expect(session.configOptions.find((o) => o.id === "mode")?.currentValue).toBe("plan");
    });

    it("setSessionModel also syncs configOptions", async () => {
      await agent.unstable_setSessionModel({
        sessionId: SESSION_ID,
        modelId: "claude-sonnet-4-5",
      });

      const session = (
        agent as unknown as {
          sessions: Record<string, { configOptions: typeof MOCK_CONFIG_OPTIONS }>;
        }
      ).sessions[SESSION_ID];
      expect(session.configOptions.find((o) => o.id === "model")?.currentValue).toBe(
        "claude-sonnet-4-5",
      );
    });
  });
});
