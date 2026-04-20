import { describe, it, expect, beforeEach, vi } from "vitest";
import { AgentSideConnection, SessionNotification } from "@agentclientprotocol/sdk";
import type { ModelInfo } from "@anthropic-ai/claude-agent-sdk";
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
  {
    id: "effort",
    name: "Effort",
    description: "Available effort levels for this model",
    type: "select",
    category: "effort",
    currentValue: "high",
    options: [
      { value: "low", name: "Low" },
      { value: "medium", name: "Medium" },
      { value: "high", name: "High" },
    ],
  },
];

describe("session config options", () => {
  let agent: ClaudeAcpAgentType;
  let ClaudeAcpAgent: typeof ClaudeAcpAgentType;
  let sessionUpdates: SessionNotification[];
  let createSessionSpy: ReturnType<typeof vi.fn>;
  let setPermissionModeSpy: ReturnType<typeof vi.fn>;
  let setModelSpy: ReturnType<typeof vi.fn>;
  let applyFlagSettingsSpy: ReturnType<typeof vi.fn>;

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
    applyFlagSettingsSpy = vi.fn();

    (agent as unknown as { sessions: Record<string, unknown> }).sessions[SESSION_ID] = {
      query: {
        setPermissionMode: setPermissionModeSpy,
        setModel: setModelSpy,
        applyFlagSettings: applyFlagSettingsSpy,
        supportedCommands: async () => [],
      },
      input: null,
      cancelled: false,
      permissionMode: "default",
      settingsManager: {},
      modes: structuredClone(MOCK_MODES),
      models: structuredClone(MOCK_MODELS),
      modelInfos: MOCK_MODELS.availableModels.map(
        (m): ModelInfo => ({
          value: m.modelId,
          displayName: m.name,
          description: m.description,
          supportsEffort: true,
          supportedEffortLevels: ["low", "medium", "high"],
        }),
      ),
      configOptions: structuredClone(MOCK_CONFIG_OPTIONS),
      contextWindowSize: 200000,
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

    it("includes updated effort in config_option_update when model drops effort support", async () => {
      const session = (agent as unknown as { sessions: Record<string, any> }).sessions[SESSION_ID];
      session.modelInfos = [
        {
          value: "claude-opus-4-5",
          displayName: "Claude Opus",
          description: "Most capable",
          supportsEffort: true,
          supportedEffortLevels: ["low", "medium", "high"],
        },
        {
          value: "claude-sonnet-4-5",
          displayName: "Claude Sonnet",
          description: "Balanced",
          supportsEffort: false,
        },
      ];

      await agent.unstable_setSessionModel({
        sessionId: SESSION_ID,
        modelId: "claude-sonnet-4-5",
      });

      const configUpdate = sessionUpdates.find(
        (n) => n.update.sessionUpdate === "config_option_update",
      );
      expect(configUpdate).toBeDefined();
      const effortOption = (configUpdate?.update as any).configOptions.find(
        (o: any) => o.id === "effort",
      );
      expect(effortOption).toBeUndefined();
      expect(applyFlagSettingsSpy).toHaveBeenCalledWith({ effortLevel: undefined });
    });

    it("clamps effort in config_option_update when new model has different supported levels", async () => {
      // Set current effort to "max" which the new model won't support
      const session = (agent as unknown as { sessions: Record<string, any> }).sessions[SESSION_ID];
      const effortOpt = session.configOptions.find((o: any) => o.id === "effort");
      if (effortOpt) effortOpt.currentValue = "max";

      session.modelInfos = [
        {
          value: "claude-opus-4-5",
          displayName: "Claude Opus",
          description: "Most capable",
          supportsEffort: true,
          supportedEffortLevels: ["low", "medium", "high", "max"],
        },
        {
          value: "claude-sonnet-4-5",
          displayName: "Claude Sonnet",
          description: "Balanced",
          supportsEffort: true,
          supportedEffortLevels: ["low", "medium", "high"],
        },
      ];

      await agent.unstable_setSessionModel({
        sessionId: SESSION_ID,
        modelId: "claude-sonnet-4-5",
      });

      const configUpdate = sessionUpdates.find(
        (n) => n.update.sessionUpdate === "config_option_update",
      );
      const effortOption = (configUpdate?.update as any).configOptions.find(
        (o: any) => o.id === "effort",
      );
      expect(effortOption).toBeDefined();
      expect(effortOption.currentValue).toBe("high");
      expect(applyFlagSettingsSpy).toHaveBeenCalledWith({ effortLevel: "high" });
    });

    it("preserves effort in config_option_update when new model supports same level", async () => {
      // Set effort to "low" first
      const session = (agent as unknown as { sessions: Record<string, any> }).sessions[SESSION_ID];
      const effortOpt = session.configOptions.find((o: any) => o.id === "effort");
      if (effortOpt) effortOpt.currentValue = "low";

      await agent.unstable_setSessionModel({
        sessionId: SESSION_ID,
        modelId: "claude-sonnet-4-5",
      });

      const configUpdate = sessionUpdates.find(
        (n) => n.update.sessionUpdate === "config_option_update",
      );
      const effortOption = (configUpdate?.update as any).configOptions.find(
        (o: any) => o.id === "effort",
      );
      expect(effortOption?.currentValue).toBe("low");
      // Effort didn't change, so applyFlagSettings should NOT be called
      expect(applyFlagSettingsSpy).not.toHaveBeenCalled();
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

  describe("setSessionConfigOption for effort", () => {
    beforeEach(() => {
      populateSession();
    });

    it("calls applyFlagSettings with effortLevel", async () => {
      await agent.setSessionConfigOption({
        sessionId: SESSION_ID,
        configId: "effort",
        value: "low",
      });

      expect(applyFlagSettingsSpy).toHaveBeenCalledWith({ effortLevel: "low" });
    });

    it("updates effort currentValue in returned configOptions", async () => {
      const response = await agent.setSessionConfigOption({
        sessionId: SESSION_ID,
        configId: "effort",
        value: "medium",
      });

      const effortOption = response.configOptions.find((o) => o.id === "effort");
      expect(effortOption?.currentValue).toBe("medium");
    });

    it("throws for invalid effort value", async () => {
      await expect(
        agent.setSessionConfigOption({
          sessionId: SESSION_ID,
          configId: "effort",
          value: "turbo",
        }),
      ).rejects.toThrow("Invalid value for config option effort: turbo");
    });

    it("does not send config_option_update notification", async () => {
      await agent.setSessionConfigOption({
        sessionId: SESSION_ID,
        configId: "effort",
        value: "low",
      });

      const configUpdates = sessionUpdates.filter(
        (n) => n.update.sessionUpdate === "config_option_update",
      );
      expect(configUpdates).toHaveLength(0);
    });

    it("other options are unchanged when effort is updated", async () => {
      const response = await agent.setSessionConfigOption({
        sessionId: SESSION_ID,
        configId: "effort",
        value: "low",
      });

      const modeOption = response.configOptions.find((o) => o.id === "mode");
      expect(modeOption?.currentValue).toBe("default");
      const modelOption = response.configOptions.find((o) => o.id === "model");
      expect(modelOption?.currentValue).toBe("claude-opus-4-5");
    });
  });

  describe("effort level and model switch interactions", () => {
    beforeEach(() => {
      populateSession();
    });

    it("drops effort option when switching to a model without effort support", async () => {
      // Make sonnet not support effort
      const session = (agent as unknown as { sessions: Record<string, any> }).sessions[SESSION_ID];
      session.modelInfos = [
        {
          value: "claude-opus-4-5",
          displayName: "Claude Opus",
          description: "Most capable",
          supportsEffort: true,
          supportedEffortLevels: ["low", "medium", "high"],
        },
        {
          value: "claude-sonnet-4-5",
          displayName: "Claude Sonnet",
          description: "Balanced",
          supportsEffort: false,
        },
      ];

      const response = await agent.setSessionConfigOption({
        sessionId: SESSION_ID,
        configId: "model",
        value: "claude-sonnet-4-5",
      });

      const effortOption = response.configOptions.find((o) => o.id === "effort");
      expect(effortOption).toBeUndefined();
    });

    it("clears effort via applyFlagSettings when switching to a model without effort", async () => {
      const session = (agent as unknown as { sessions: Record<string, any> }).sessions[SESSION_ID];
      session.modelInfos = [
        {
          value: "claude-opus-4-5",
          displayName: "Claude Opus",
          description: "Most capable",
          supportsEffort: true,
          supportedEffortLevels: ["low", "medium", "high"],
        },
        {
          value: "claude-sonnet-4-5",
          displayName: "Claude Sonnet",
          description: "Balanced",
          supportsEffort: false,
        },
      ];

      await agent.setSessionConfigOption({
        sessionId: SESSION_ID,
        configId: "model",
        value: "claude-sonnet-4-5",
      });

      expect(applyFlagSettingsSpy).toHaveBeenCalledWith({ effortLevel: undefined });
    });

    it("adds effort option when switching to a model that supports effort", async () => {
      const session = (agent as unknown as { sessions: Record<string, any> }).sessions[SESSION_ID];
      // Start with sonnet (no effort) as current
      session.models = { ...session.models, currentModelId: "claude-sonnet-4-5" };
      session.modelInfos = [
        {
          value: "claude-opus-4-5",
          displayName: "Claude Opus",
          description: "Most capable",
          supportsEffort: true,
          supportedEffortLevels: ["low", "medium", "high"],
        },
        {
          value: "claude-sonnet-4-5",
          displayName: "Claude Sonnet",
          description: "Balanced",
          supportsEffort: false,
        },
      ];
      // Remove effort from current config options
      session.configOptions = session.configOptions.filter((o: any) => o.id !== "effort");

      const response = await agent.setSessionConfigOption({
        sessionId: SESSION_ID,
        configId: "model",
        value: "claude-opus-4-5",
      });

      const effortOption = response.configOptions.find((o) => o.id === "effort");
      expect(effortOption).toBeDefined();
      // No previous effort, so defaults to "high" (the API default)
      expect(effortOption?.currentValue).toBe("high");
    });

    it("clamps effort to valid value when new model has different supported levels", async () => {
      const session = (agent as unknown as { sessions: Record<string, any> }).sessions[SESSION_ID];
      // Set current effort to "max" (not supported by sonnet in our mock)
      const effortOpt = session.configOptions.find((o: any) => o.id === "effort");
      if (effortOpt) effortOpt.currentValue = "max";

      session.modelInfos = [
        {
          value: "claude-opus-4-5",
          displayName: "Claude Opus",
          description: "Most capable",
          supportsEffort: true,
          supportedEffortLevels: ["low", "medium", "high", "max"],
        },
        {
          value: "claude-sonnet-4-5",
          displayName: "Claude Sonnet",
          description: "Balanced",
          supportsEffort: true,
          supportedEffortLevels: ["low", "medium", "high"],
        },
      ];

      const response = await agent.setSessionConfigOption({
        sessionId: SESSION_ID,
        configId: "model",
        value: "claude-sonnet-4-5",
      });

      const effortOption = response.configOptions.find((o) => o.id === "effort");
      expect(effortOption).toBeDefined();
      // "max" is not in sonnet's levels, so should fall back to "high" (the API default)
      expect(effortOption?.currentValue).toBe("high");
      // SDK should be told about the clamped value
      expect(applyFlagSettingsSpy).toHaveBeenCalledWith({ effortLevel: "high" });
    });

    it("preserves effort value when new model supports the same level", async () => {
      // Set effort to "low"
      await agent.setSessionConfigOption({
        sessionId: SESSION_ID,
        configId: "effort",
        value: "low",
      });

      // Switch model — both support "low"
      const response = await agent.setSessionConfigOption({
        sessionId: SESSION_ID,
        configId: "model",
        value: "claude-sonnet-4-5",
      });

      const effortOption = response.configOptions.find((o) => o.id === "effort");
      expect(effortOption?.currentValue).toBe("low");
      // applyFlagSettings was called once for the effort change, but not again for the model switch
      expect(applyFlagSettingsSpy).toHaveBeenCalledTimes(1);
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
