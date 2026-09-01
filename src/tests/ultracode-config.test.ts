import { describe, it, expect, beforeEach, vi } from "vitest";
import type { ModelInfo } from "@anthropic-ai/claude-agent-sdk";
import type { AcpClient, ClaudeAcpAgent as ClaudeAcpAgentType } from "../acp-agent.js";
import {
  buildConfigOptions,
  createUltracodeConfigOption,
  modelSupportsUltracode,
  resolveUltracodeEnabled,
  ULTRACODE_CONFIG_ID,
  ULTRACODE_ON,
  ULTRACODE_OFF,
} from "../acp-agent.js";
import { makeMockQuery } from "./helpers.js";

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

/** An xhigh-capable model — the only kind ultracode can run on. */
const XHIGH_MODEL: ModelInfo[] = [
  {
    value: "claude-opus-4-8",
    displayName: "Claude Opus",
    description: "Most capable",
    supportsEffort: true,
    supportedEffortLevels: ["low", "medium", "high", "xhigh"],
  },
];

/** Effort-capable, but its ceiling is below xhigh. */
const NO_XHIGH_MODEL: ModelInfo[] = [
  {
    value: "claude-opus-4-8",
    displayName: "Claude Opus",
    description: "Most capable",
    supportsEffort: true,
    supportedEffortLevels: ["low", "medium", "high"],
  },
];

describe("createUltracodeConfigOption", () => {
  it("produces a native boolean toggle when the client opted in", () => {
    expect(createUltracodeConfigOption(true, true)).toEqual({
      id: ULTRACODE_CONFIG_ID,
      name: "Ultracode",
      description: expect.any(String),
      category: "thought_level",
      type: "boolean",
      currentValue: true,
    });
  });

  it("falls back to an on/off select when the client did not opt in", () => {
    const option = createUltracodeConfigOption(false, false);
    expect(option).toMatchObject({
      id: ULTRACODE_CONFIG_ID,
      type: "select",
      category: "thought_level",
      currentValue: ULTRACODE_OFF,
      options: [
        { value: ULTRACODE_ON, name: "On" },
        { value: ULTRACODE_OFF, name: "Off" },
      ],
    });
    expect(option).not.toHaveProperty("currentValue", false);
  });
});

describe("modelSupportsUltracode", () => {
  it("requires the model to advertise xhigh", () => {
    expect(modelSupportsUltracode(XHIGH_MODEL[0])).toBe(true);
    expect(modelSupportsUltracode(NO_XHIGH_MODEL[0])).toBe(false);
  });

  it("is false for models that don't support effort at all", () => {
    expect(modelSupportsUltracode({ value: "m", displayName: "M", description: "" })).toBe(false);
    expect(modelSupportsUltracode(undefined)).toBe(false);
  });
});

describe("resolveUltracodeEnabled", () => {
  const base = { sessionId: "s", configId: ULTRACODE_CONFIG_ID };

  it("accepts native boolean values", () => {
    expect(resolveUltracodeEnabled({ ...base, type: "boolean", value: true })).toBe(true);
    expect(resolveUltracodeEnabled({ ...base, type: "boolean", value: false })).toBe(false);
  });

  it("accepts the on/off select fallback", () => {
    expect(resolveUltracodeEnabled({ ...base, value: ULTRACODE_ON })).toBe(true);
    expect(resolveUltracodeEnabled({ ...base, value: ULTRACODE_OFF })).toBe(false);
  });

  it("rejects any other value", () => {
    expect(() => resolveUltracodeEnabled({ ...base, value: "maybe" })).toThrow(
      /Invalid value for config option ultracode/,
    );
  });
});

describe("buildConfigOptions ultracode option", () => {
  const find = (options: ReturnType<typeof buildConfigOptions>) =>
    options.find((o) => o.id === ULTRACODE_CONFIG_ID);

  it("is omitted when no ultracode state is threaded through", () => {
    expect(find(buildConfigOptions(MODES, MODELS, XHIGH_MODEL))).toBeUndefined();
  });

  it("is omitted when the current model can't run xhigh", () => {
    const options = buildConfigOptions(
      MODES,
      MODELS,
      NO_XHIGH_MODEL,
      undefined,
      [],
      undefined,
      undefined,
      {
        supported: modelSupportsUltracode(NO_XHIGH_MODEL[0]),
        enabled: true,
        useBooleanOption: true,
      },
    );
    expect(find(options)).toBeUndefined();
  });

  it("is surfaced with the current value on an xhigh-capable model", () => {
    const options = buildConfigOptions(
      MODES,
      MODELS,
      XHIGH_MODEL,
      undefined,
      [],
      undefined,
      undefined,
      {
        supported: modelSupportsUltracode(XHIGH_MODEL[0]),
        enabled: true,
        useBooleanOption: true,
      },
    );
    expect(find(options)).toMatchObject({ type: "boolean", currentValue: true });
  });

  it("does not disturb the effort option", () => {
    const options = buildConfigOptions(
      MODES,
      MODELS,
      XHIGH_MODEL,
      "high",
      [],
      undefined,
      undefined,
      {
        supported: true,
        enabled: true,
        useBooleanOption: true,
      },
    );
    expect(options.find((o) => o.id === "effort")).toMatchObject({ currentValue: "high" });
  });
});

describe("setSessionConfigOption for ultracode", () => {
  const SESSION_ID = "test-session-id";
  let ClaudeAcpAgent: typeof ClaudeAcpAgentType;
  let agent: ClaudeAcpAgentType;
  let applyFlagSettingsSpy: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();
    ClaudeAcpAgent = (await import("../acp-agent.js")).ClaudeAcpAgent;
    agent = new ClaudeAcpAgent({
      sessionUpdate: async () => {},
      requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
      readTextFile: async () => ({ content: "" }),
      writeTextFile: async () => ({}),
    } as unknown as AcpClient);
    // The refreshed option follows the client's boolean capability, so declare
    // it — otherwise the toggle correctly degrades to the "on"/"off" select.
    (agent as unknown as { clientCapabilities: unknown }).clientCapabilities = {
      session: { configOptions: { boolean: {} } },
    };

    applyFlagSettingsSpy = vi.fn();
    (agent as unknown as { sessions: Record<string, unknown> }).sessions[SESSION_ID] = {
      query: makeMockQuery({ applyFlagSettings: applyFlagSettingsSpy }),
      input: null,
      cancelled: false,
      permissionMode: "default",
      settingsManager: {},
      modes: structuredClone(MODES),
      models: structuredClone(MODELS),
      modelInfos: XHIGH_MODEL,
      configOptions: [createUltracodeConfigOption(false, true)],
      ultracodeEnabled: false,
      contextWindowSize: 200000,
      toolUseCache: {},
      emittedToolCalls: new Set(),
    };
  });

  it("pushes the ultracode flag to the SDK and mirrors the toggle", async () => {
    const res = await agent.setSessionConfigOption({
      sessionId: SESSION_ID,
      configId: ULTRACODE_CONFIG_ID,
      type: "boolean",
      value: true,
    });

    expect(applyFlagSettingsSpy).toHaveBeenCalledWith({ ultracode: true });
    expect(res.configOptions.find((o) => o.id === ULTRACODE_CONFIG_ID)).toMatchObject({
      currentValue: true,
    });
  });

  it("accepts the on/off select fallback", async () => {
    await agent.setSessionConfigOption({
      sessionId: SESSION_ID,
      configId: ULTRACODE_CONFIG_ID,
      value: ULTRACODE_ON,
    });
    expect(applyFlagSettingsSpy).toHaveBeenCalledWith({ ultracode: true });
  });

  it("leaves the toggle untouched when the SDK rejects the flag", async () => {
    applyFlagSettingsSpy.mockRejectedValueOnce(new Error("refused"));

    await expect(
      agent.setSessionConfigOption({
        sessionId: SESSION_ID,
        configId: ULTRACODE_CONFIG_ID,
        type: "boolean",
        value: true,
      }),
    ).rejects.toThrow(/refused/);

    const session = (agent as unknown as { sessions: Record<string, any> }).sessions[SESSION_ID];
    expect(session.ultracodeEnabled).toBe(false);
    expect(session.configOptions.find((o: any) => o.id === ULTRACODE_CONFIG_ID)).toMatchObject({
      currentValue: false,
    });
  });
});
