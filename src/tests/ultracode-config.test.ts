import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ClientCapabilities } from "@agentclientprotocol/sdk/unstable";
import type { ModelInfo, Query } from "@anthropic-ai/claude-agent-sdk";
import type { AcpClient, ClaudeAcpAgent as ClaudeAcpAgentType } from "../acp-agent.js";
import {
  createUltracodeConfigOption,
  modelSupportsUltracode,
  readUltracodeSettings,
  resolveUltracodeEnabled,
  ULTRACODE_CONFIG_ID,
  ULTRACODE_OFF,
  ULTRACODE_ON,
  ultracodeSupported,
  ultracodeWorkflowsEnabled,
} from "../session-ultracode.js";
import { makeMockQuery } from "./helpers.js";

const { querySpy } = vi.hoisted(() => ({ querySpy: vi.fn() }));

vi.mock("@anthropic-ai/claude-agent-sdk", async () => {
  const actual = await vi.importActual<any>("@anthropic-ai/claude-agent-sdk");
  return { ...actual, query: querySpy };
});

const OPUS: ModelInfo = {
  value: "opus",
  displayName: "Opus",
  description: "",
  supportsEffort: true,
  supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
};
const FABLE: ModelInfo = {
  value: "fable",
  displayName: "Fable",
  description: "",
  supportsEffort: true,
  supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
};
// Opus 4.6 and Haiku 4.5 have no `xhigh` effort, so the CLI has no ultracode
// for them either.
const OLD_OPUS: ModelInfo = {
  value: "claude-opus-4-6",
  displayName: "Opus 4.6",
  description: "",
  supportsEffort: true,
  supportedEffortLevels: ["low", "medium", "high", "max"],
};

function getSettingsQuery(getSettings: unknown): Query {
  return { getSettings } as unknown as Query;
}

describe("ultracode helpers", () => {
  it("builds a boolean option or an on/off select", () => {
    expect(createUltracodeConfigOption(true, true)).toEqual({
      id: ULTRACODE_CONFIG_ID,
      name: "Ultracode",
      description: "Dynamic workflows on every task, at any effort level",
      category: "model_config",
      type: "boolean",
      currentValue: true,
    });
    expect(createUltracodeConfigOption(false, false)).toMatchObject({
      type: "select",
      currentValue: ULTRACODE_OFF,
      options: [
        { value: ULTRACODE_ON, name: "On" },
        { value: ULTRACODE_OFF, name: "Off" },
      ],
    });
  });

  it("accepts booleans and the select strings", () => {
    const request = (value: unknown) =>
      ({ sessionId: "s", configId: ULTRACODE_CONFIG_ID, value }) as never;
    expect(resolveUltracodeEnabled(request(true))).toBe(true);
    expect(resolveUltracodeEnabled(request(ULTRACODE_OFF))).toBe(false);
    expect(() => resolveUltracodeEnabled(request("maybe"))).toThrow(
      "Invalid value for config option ultracode: maybe",
    );
  });

  it("treats a model as supporting ultracode when it supports xhigh effort", () => {
    expect(modelSupportsUltracode(OPUS)).toBe(true);
    expect(modelSupportsUltracode(OLD_OPUS)).toBe(false);
    expect(modelSupportsUltracode({ ...OPUS, supportsEffort: false })).toBe(false);
    expect(modelSupportsUltracode(undefined)).toBe(false);
  });

  it("infers the workflows gate only when the start model can tell", () => {
    expect(ultracodeWorkflowsEnabled({ available: true }, OLD_OPUS)).toBe(true);
    expect(ultracodeWorkflowsEnabled({ available: false }, OPUS)).toBe(false);
    // Opus 4.6 is unavailable regardless of workflows.
    expect(ultracodeWorkflowsEnabled({ available: false }, OLD_OPUS)).toBeUndefined();
    expect(ultracodeWorkflowsEnabled(undefined, OPUS)).toBeUndefined();

    expect(ultracodeSupported(undefined, OPUS)).toBe(true);
    expect(ultracodeSupported(false, OPUS)).toBe(false);
    expect(ultracodeSupported(true, OLD_OPUS)).toBe(false);
  });

  it("reads the CLI's ultracode report and tolerates CLIs without one", async () => {
    await expect(
      readUltracodeSettings(
        getSettingsQuery(async () => ({
          applied: { ultracodeAvailable: true, ultracodeRequested: false },
        })),
      ),
    ).resolves.toEqual({ available: true, requested: false });
    await expect(
      readUltracodeSettings(getSettingsQuery(async () => ({ applied: {} }))),
    ).resolves.toEqual({ available: undefined, requested: undefined });
    await expect(readUltracodeSettings(getSettingsQuery(undefined))).resolves.toBeUndefined();
    await expect(
      readUltracodeSettings(
        getSettingsQuery(async () => {
          throw new Error("unsupported control request");
        }),
      ),
    ).resolves.toBeUndefined();
  });
});

describe("ultracode session config option", () => {
  let tempDir: string;
  let originalClaudeConfigDir: string | undefined;

  beforeEach(async () => {
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "acp-ultracode-"));
    originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = tempDir;
    querySpy.mockReset();
    vi.resetModules();
  });

  afterEach(async () => {
    if (originalClaudeConfigDir) {
      process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDir;
    } else {
      delete process.env.CLAUDE_CONFIG_DIR;
    }
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  });

  async function createSession(opts: {
    models?: ModelInfo[];
    getSettings?: () => Promise<unknown>;
    settings?: Record<string, unknown>;
    clientCapabilities?: ClientCapabilities;
  }) {
    if (opts.settings) {
      await fs.promises.writeFile(
        path.join(tempDir, "settings.json"),
        JSON.stringify(opts.settings),
      );
    }
    const applyFlagSettings = vi.fn();
    querySpy.mockReturnValue(
      makeMockQuery({
        initializationResult: async () => ({ models: opts.models ?? [OPUS, FABLE, OLD_OPUS] }),
        applyFlagSettings,
        ...(opts.getSettings ? { getSettings: opts.getSettings } : {}),
      }),
    );
    const { ClaudeAcpAgent } = await import("../acp-agent.js");
    const agent: ClaudeAcpAgentType = new ClaudeAcpAgent({
      sessionUpdate: async () => {},
      requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
      readTextFile: async () => ({ content: "" }),
      writeTextFile: async () => ({}),
    } as unknown as AcpClient);
    (agent as any).clientCapabilities = opts.clientCapabilities ?? {
      session: { configOptions: { boolean: {} } },
    };
    const response = await (agent as any).createSession({
      cwd: tempDir,
      mcpServers: [],
      _meta: { disableBuiltInTools: true },
    });
    const sessionId: string = response.sessionId;
    const ultracodeOption = () =>
      agent.sessions[sessionId].configOptions.find((o) => o.id === ULTRACODE_CONFIG_ID);
    return { agent, sessionId, applyFlagSettings, ultracodeOption };
  }

  it("seeds the option from the CLI's report", async () => {
    const { ultracodeOption, agent, sessionId } = await createSession({
      getSettings: async () => ({
        applied: { ultracodeAvailable: true, ultracodeRequested: true },
      }),
    });
    expect(ultracodeOption()).toEqual(createUltracodeConfigOption(true, true));
    expect(agent.sessions[sessionId].ultracodeEnabled).toBe(true);
  });

  it("hides the option while dynamic workflows are off, across model switches", async () => {
    const { agent, sessionId, ultracodeOption } = await createSession({
      getSettings: async () => ({
        applied: { ultracodeAvailable: false, ultracodeRequested: false },
      }),
    });
    expect(ultracodeOption()).toBeUndefined();

    await agent.setSessionConfigOption({ sessionId, configId: "model", value: "fable" });
    expect(ultracodeOption()).toBeUndefined();
  });

  it("follows the model's support and keeps the toggle across switches", async () => {
    const { agent, sessionId, applyFlagSettings, ultracodeOption } = await createSession({
      clientCapabilities: {},
    });
    expect(ultracodeOption()).toEqual(createUltracodeConfigOption(false, false));

    await agent.setSessionConfigOption({
      sessionId,
      configId: ULTRACODE_CONFIG_ID,
      value: ULTRACODE_ON,
    });
    expect(applyFlagSettings).toHaveBeenLastCalledWith({ ultracode: true });

    await agent.setSessionConfigOption({ sessionId, configId: "model", value: "claude-opus-4-6" });
    expect(ultracodeOption()).toBeUndefined();

    await agent.setSessionConfigOption({ sessionId, configId: "model", value: "fable" });
    expect(ultracodeOption()).toEqual(createUltracodeConfigOption(true, false));
  });

  it("keeps a toggled-on ultracode when effort changes, and not a toggled-off one", async () => {
    // An effortLevel apply without an ultracode key turns ultracode off, so
    // the effort picker must carry the session's toggle.
    const { agent, sessionId, applyFlagSettings } = await createSession({
      settings: { ultracode: true },
    });

    await agent.setSessionConfigOption({
      sessionId,
      configId: ULTRACODE_CONFIG_ID,
      type: "boolean",
      value: false,
    });
    expect(applyFlagSettings).toHaveBeenLastCalledWith({ ultracode: false });
    await agent.setSessionConfigOption({ sessionId, configId: "effort", value: "high" });
    expect(applyFlagSettings).toHaveBeenLastCalledWith({ effortLevel: "high" });

    await agent.setSessionConfigOption({
      sessionId,
      configId: ULTRACODE_CONFIG_ID,
      type: "boolean",
      value: true,
    });
    await agent.setSessionConfigOption({ sessionId, configId: "effort", value: "low" });
    expect(applyFlagSettings).toHaveBeenLastCalledWith({ effortLevel: "low", ultracode: true });
  });

  it("keeps ultracode on through the effort apply that follows a model switch", async () => {
    // recommendedValue clients apply the new model's effort on every switch.
    const { agent, sessionId, applyFlagSettings } = await createSession({
      clientCapabilities: {
        session: { configOptions: { boolean: {} } },
        _meta: { jetbrains: { air: { version: 1, capabilities: ["recommendedValue"] } } },
      },
    });
    await agent.setSessionConfigOption({
      sessionId,
      configId: ULTRACODE_CONFIG_ID,
      type: "boolean",
      value: true,
    });

    await agent.setSessionConfigOption({ sessionId, configId: "model", value: "fable" });
    expect(applyFlagSettings).toHaveBeenLastCalledWith({ effortLevel: "medium", ultracode: true });
  });

  it("does not change session state when the SDK rejects the flag", async () => {
    const { agent, sessionId, applyFlagSettings, ultracodeOption } = await createSession({});
    applyFlagSettings.mockRejectedValueOnce(new Error("nope"));

    await expect(
      agent.setSessionConfigOption({
        sessionId,
        configId: ULTRACODE_CONFIG_ID,
        type: "boolean",
        value: true,
      }),
    ).rejects.toThrow("nope");
    expect(agent.sessions[sessionId].ultracodeEnabled).toBe(false);
    expect(ultracodeOption()).toEqual(createUltracodeConfigOption(false, true));
  });
});
