import { describe, it, expect, vi } from "vitest";
import type { ClientCapabilities, SessionNotification } from "@agentclientprotocol/sdk";
import type { ModelInfo } from "@anthropic-ai/claude-agent-sdk";
import {
  buildConfigOptions,
  clientSupportsBooleanConfigOptions,
  createFastModeConfigOption,
  fastModeStateEnabled,
  resolveFastModeEnabled,
  FAST_MODE_CONFIG_ID,
  FAST_MODE_ON,
  FAST_MODE_OFF,
  ClaudeAcpAgent,
  type AcpClient,
} from "../acp-agent.js";

const MODES = {
  currentModeId: "default",
  availableModes: [{ id: "default", name: "Default", description: "Standard behavior" }],
};

const MODELS = {
  currentModelId: "claude-opus-4-8",
  availableModels: [
    { modelId: "claude-opus-4-8", name: "Claude Opus", description: "Most capable" },
  ],
};

const MODEL_INFOS: ModelInfo[] = [
  { value: "claude-opus-4-8", displayName: "Claude Opus", description: "Most capable" },
];

describe("createFastModeConfigOption", () => {
  it("produces a native boolean toggle when the client opted in", () => {
    expect(createFastModeConfigOption(true, true)).toEqual({
      id: FAST_MODE_CONFIG_ID,
      name: "Fast mode",
      description: expect.any(String),
      category: "model_config",
      type: "boolean",
      currentValue: true,
    });
  });

  it("falls back to an on/off select when the client did not opt in", () => {
    const option = createFastModeConfigOption(false, false);
    expect(option).toMatchObject({
      id: FAST_MODE_CONFIG_ID,
      type: "select",
      category: "model_config",
      currentValue: FAST_MODE_OFF,
      options: [
        { value: FAST_MODE_ON, name: "On" },
        { value: FAST_MODE_OFF, name: "Off" },
      ],
    });
    expect(option).not.toHaveProperty("currentValue", true);
  });
});

describe("clientSupportsBooleanConfigOptions", () => {
  it("is true only when session.configOptions.boolean is present", () => {
    expect(
      clientSupportsBooleanConfigOptions({ session: { configOptions: { boolean: {} } } }),
    ).toBe(true);
  });

  it("is false when the capability is omitted or null at any level", () => {
    expect(clientSupportsBooleanConfigOptions(undefined)).toBe(false);
    expect(clientSupportsBooleanConfigOptions(null)).toBe(false);
    expect(clientSupportsBooleanConfigOptions({})).toBe(false);
    expect(clientSupportsBooleanConfigOptions({ session: { configOptions: {} } })).toBe(false);
    expect(
      clientSupportsBooleanConfigOptions({ session: { configOptions: { boolean: null } } }),
    ).toBe(false);
  });
});

describe("resolveFastModeEnabled", () => {
  const base = { sessionId: "s", configId: FAST_MODE_CONFIG_ID };

  it("accepts native boolean values", () => {
    expect(resolveFastModeEnabled({ ...base, type: "boolean", value: true })).toBe(true);
    expect(resolveFastModeEnabled({ ...base, type: "boolean", value: false })).toBe(false);
  });

  it("accepts the on/off select fallback", () => {
    expect(resolveFastModeEnabled({ ...base, value: FAST_MODE_ON })).toBe(true);
    expect(resolveFastModeEnabled({ ...base, value: FAST_MODE_OFF })).toBe(false);
  });

  it("rejects any other value", () => {
    expect(() => resolveFastModeEnabled({ ...base, value: "maybe" })).toThrow(
      /Invalid value for config option fast/,
    );
  });
});

describe("fastModeStateEnabled", () => {
  it("treats cooldown as on (the user's intent persists through rate-limit cooldown)", () => {
    expect(fastModeStateEnabled("on")).toBe(true);
    expect(fastModeStateEnabled("cooldown")).toBe(true);
    expect(fastModeStateEnabled("off")).toBe(false);
  });
});

describe("buildConfigOptions Fast mode", () => {
  it("omits the Fast mode option when the model does not support it", () => {
    const options = buildConfigOptions(MODES, MODELS, MODEL_INFOS, undefined, [], "default", {
      supported: false,
      enabled: false,
      useBooleanOption: true,
    });
    expect(options.find((o) => o.id === FAST_MODE_CONFIG_ID)).toBeUndefined();
  });

  it("omits the Fast mode option when no fast mode state is provided", () => {
    const options = buildConfigOptions(MODES, MODELS, MODEL_INFOS, undefined, [], "default");
    expect(options.find((o) => o.id === FAST_MODE_CONFIG_ID)).toBeUndefined();
  });

  it("surfaces a boolean toggle when supported and the client opted in", () => {
    const options = buildConfigOptions(MODES, MODELS, MODEL_INFOS, undefined, [], "default", {
      supported: true,
      enabled: true,
      useBooleanOption: true,
    });
    expect(options).toContainEqual(createFastModeConfigOption(true, true));
  });

  it("surfaces a select fallback when supported but the client did not opt in", () => {
    const options = buildConfigOptions(MODES, MODELS, MODEL_INFOS, undefined, [], "default", {
      supported: true,
      enabled: false,
      useBooleanOption: false,
    });
    expect(options).toContainEqual(createFastModeConfigOption(false, false));
  });
});

describe("setSessionConfigOption Fast mode toggle", () => {
  const SESSION_ID = "fast-session";

  function setup(opts: { useBooleanOption: boolean }) {
    const sessionUpdates: SessionNotification[] = [];
    const client = {
      sessionUpdate: async (n: SessionNotification) => {
        sessionUpdates.push(n);
      },
      requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
      readTextFile: async () => ({ content: "" }),
      writeTextFile: async () => ({}),
    } as unknown as AcpClient;

    const agent = new ClaudeAcpAgent(client);
    const clientCapabilities: ClientCapabilities = opts.useBooleanOption
      ? { session: { configOptions: { boolean: {} } } }
      : {};
    (agent as unknown as { clientCapabilities: ClientCapabilities }).clientCapabilities =
      clientCapabilities;

    const applyFlagSettings = vi.fn();
    (agent as unknown as { sessions: Record<string, unknown> }).sessions[SESSION_ID] = {
      query: { applyFlagSettings },
      fastModeEnabled: false,
      configOptions: [createFastModeConfigOption(false, opts.useBooleanOption)],
    };

    return { agent, applyFlagSettings, sessionUpdates };
  }

  it("toggles Fast mode on/off through a boolean value", async () => {
    const { agent, applyFlagSettings } = setup({ useBooleanOption: true });

    const onResponse = await agent.setSessionConfigOption({
      sessionId: SESSION_ID,
      configId: FAST_MODE_CONFIG_ID,
      type: "boolean",
      value: true,
    });
    expect(applyFlagSettings).toHaveBeenCalledWith({ fastMode: true });
    expect(onResponse.configOptions).toContainEqual(createFastModeConfigOption(true, true));
    expect(
      (agent as unknown as { sessions: Record<string, { fastModeEnabled: boolean }> }).sessions[
        SESSION_ID
      ].fastModeEnabled,
    ).toBe(true);

    const offResponse = await agent.setSessionConfigOption({
      sessionId: SESSION_ID,
      configId: FAST_MODE_CONFIG_ID,
      type: "boolean",
      value: false,
    });
    expect(applyFlagSettings).toHaveBeenLastCalledWith({ fastMode: false });
    expect(offResponse.configOptions).toContainEqual(createFastModeConfigOption(false, true));
  });

  it("toggles Fast mode through the on/off select fallback", async () => {
    const { agent, applyFlagSettings } = setup({ useBooleanOption: false });

    const response = await agent.setSessionConfigOption({
      sessionId: SESSION_ID,
      configId: FAST_MODE_CONFIG_ID,
      value: FAST_MODE_ON,
    });
    expect(applyFlagSettings).toHaveBeenCalledWith({ fastMode: true });
    expect(response.configOptions).toContainEqual(createFastModeConfigOption(true, false));
  });

  it("does not change session state when the SDK rejects the flag", async () => {
    const { agent, applyFlagSettings } = setup({ useBooleanOption: true });
    applyFlagSettings.mockRejectedValueOnce(new Error("nope"));

    await expect(
      agent.setSessionConfigOption({
        sessionId: SESSION_ID,
        configId: FAST_MODE_CONFIG_ID,
        type: "boolean",
        value: true,
      }),
    ).rejects.toThrow("nope");

    const session = (agent as unknown as { sessions: Record<string, { fastModeEnabled: boolean }> })
      .sessions[SESSION_ID];
    expect(session.fastModeEnabled).toBe(false);
  });
});

describe("syncFastModeState (SDK-driven state changes)", () => {
  const SESSION_ID = "fast-session";

  function setup(opts: { fastModeEnabled: boolean; withOption: boolean }) {
    const sessionUpdates: SessionNotification[] = [];
    const client = {
      sessionUpdate: async (n: SessionNotification) => {
        sessionUpdates.push(n);
      },
      requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
      readTextFile: async () => ({ content: "" }),
      writeTextFile: async () => ({}),
    } as unknown as AcpClient;

    const agent = new ClaudeAcpAgent(client);
    (agent as unknown as { clientCapabilities: ClientCapabilities }).clientCapabilities = {
      session: { configOptions: { boolean: {} } },
    };

    const session = {
      query: {},
      fastModeEnabled: opts.fastModeEnabled,
      configOptions: opts.withOption
        ? [createFastModeConfigOption(opts.fastModeEnabled, true)]
        : [],
    };
    (agent as unknown as { sessions: Record<string, unknown> }).sessions[SESSION_ID] = session;

    const sync = (
      agent as unknown as {
        syncFastModeState: (
          sessionId: string,
          session: unknown,
          state: string | undefined,
        ) => Promise<void>;
      }
    ).syncFastModeState.bind(agent);

    return { sync, session, sessionUpdates };
  }

  it("emits a config_option_update when the SDK reports a new state", async () => {
    const { sync, session, sessionUpdates } = setup({ fastModeEnabled: false, withOption: true });

    await sync(SESSION_ID, session, "on");

    expect(session.fastModeEnabled).toBe(true);
    expect(session.configOptions).toContainEqual(createFastModeConfigOption(true, true));
    expect(sessionUpdates).toHaveLength(1);
    expect(sessionUpdates[0].update).toMatchObject({
      sessionUpdate: "config_option_update",
    });
    const updated = (
      sessionUpdates[0].update as { configOptions: ReturnType<typeof createFastModeConfigOption>[] }
    ).configOptions;
    expect(updated).toContainEqual(createFastModeConfigOption(true, true));
  });

  it("leaves the toggle on and quiet during a rate-limit cooldown", async () => {
    const { sync, session, sessionUpdates } = setup({ fastModeEnabled: true, withOption: true });

    // cooldown is a transient suspension of an already-enabled fast mode.
    await sync(SESSION_ID, session, "cooldown");

    expect(session.fastModeEnabled).toBe(true);
    expect(sessionUpdates).toHaveLength(0);
  });

  it("never lets a stray cooldown spuriously enable a toggle the user has off", async () => {
    const { sync, session, sessionUpdates } = setup({ fastModeEnabled: false, withOption: true });

    await sync(SESSION_ID, session, "cooldown");

    expect(session.fastModeEnabled).toBe(false);
    expect(sessionUpdates).toHaveLength(0);
  });

  it("clears the toggle when the SDK reports off", async () => {
    const { sync, session, sessionUpdates } = setup({ fastModeEnabled: true, withOption: true });

    await sync(SESSION_ID, session, "off");

    expect(session.fastModeEnabled).toBe(false);
    expect(session.configOptions).toContainEqual(createFastModeConfigOption(false, true));
    expect(sessionUpdates).toHaveLength(1);
  });

  it("is a no-op when the reported state is undefined or unchanged", async () => {
    const { sync, session, sessionUpdates } = setup({ fastModeEnabled: false, withOption: true });

    await sync(SESSION_ID, session, undefined);
    await sync(SESSION_ID, session, "off");

    expect(sessionUpdates).toHaveLength(0);
  });

  it("preserves the retained setting (no clobber) when the model has no Fast mode option", async () => {
    // Model without fast support: the SDK reports a capability-driven state, not
    // the user's intent. We must leave session.fastModeEnabled untouched so it's
    // correct when a supporting model is reselected — reconciling here was the
    // original intent-clobber bug.
    const enabledCase = setup({ fastModeEnabled: true, withOption: false });
    await enabledCase.sync(SESSION_ID, enabledCase.session, "off");
    expect(enabledCase.session.fastModeEnabled).toBe(true);
    expect(enabledCase.sessionUpdates).toHaveLength(0);

    const disabledCase = setup({ fastModeEnabled: false, withOption: false });
    await disabledCase.sync(SESSION_ID, disabledCase.session, "on");
    expect(disabledCase.session.fastModeEnabled).toBe(false);
    expect(disabledCase.sessionUpdates).toHaveLength(0);
  });
});
