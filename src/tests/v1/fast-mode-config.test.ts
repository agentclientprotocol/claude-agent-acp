import { describe, it, expect, vi } from "vitest";
import type { ClientCapabilities, SessionNotification } from "@agentclientprotocol/sdk/unstable";
import type { FastModeDisabledReason, ModelInfo } from "@anthropic-ai/claude-agent-sdk";
import { ClaudeAcpAgent } from "../../v1/acp-agent.js";
import {
  buildConfigOptions,
  clientSupportsBooleanConfigOptions,
} from "../../session-config-options.js";
import {
  createFastModeConfigOption,
  fastModeStateEnabled,
  normalizeFastModeDisabledReason,
  resolveFastModeEnabled,
  FAST_MODE_CONFIG_ID,
  FAST_MODE_ON,
  FAST_MODE_OFF,
} from "../../session-fast-mode.js";
import type { AcpClient } from "../../acp-client.js";
import { Pushable } from "../../utils.js";
import { initializeClient } from "../helpers.js";
import {
  mockSessionState,
  successfulResultMessage,
  userEcho,
  wrapQuery,
} from "./session-doubles.js";

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

const FUTURE_REASON = "some_future_reason" as FastModeDisabledReason;

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

  /**
   * Scenario:
   * 1. Build the option with the toggle off and a disabled reason.
   * Expected:
   * - The description is the base text plus the reason's explanation.
   * - A code the table lacks gets the generic text naming the code.
   */
  it.each([
    ["free", "not available on the free plan"],
    ["preference", "not enabled for your organization or API gateway"],
    ["unknown", "currently unavailable"],
    [FUTURE_REASON, "not available (some_future_reason)"],
  ] as [FastModeDisabledReason, string][])(
    "explains the disabled reason %s while the toggle reads off",
    (reason, explanation) => {
      const option = createFastModeConfigOption(false, true, reason);
      expect(option.description).toBe(`Faster responses on supported models — ${explanation}`);
    },
  );

  /**
   * Scenario:
   * 1. Build the option, toggle off, with `sdk_opt_in_required` or `pending`.
   * 2. Build the option, toggle on, with `free`.
   * Expected:
   * - The description stays the base text in all three cases.
   */
  it("ignores unexplained and on-state reasons", () => {
    // Every SDK session starts at `sdk_opt_in_required` — the toggle IS the
    // opt-in, so it must not read as a blocker.
    expect(createFastModeConfigOption(false, true, "sdk_opt_in_required").description).toBe(
      "Faster responses on supported models",
    );
    expect(createFastModeConfigOption(false, true, "pending").description).toBe(
      "Faster responses on supported models",
    );
    // A reason riding an `on` state isn't blocking anything right now.
    expect(createFastModeConfigOption(true, true, "free").description).toBe(
      "Faster responses on supported models",
    );
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
      expect.objectContaining({
        code: -32602,
        message: expect.stringContaining("Invalid value for config option fast"),
      }),
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

describe("normalizeFastModeDisabledReason", () => {
  /**
   * Scenario:
   * 1. Normalize each explained reason, including `preference`, `unknown` and a future code.
   * Expected:
   * - Each reason is returned unchanged.
   */
  it.each([
    "free",
    "extra_usage_disabled",
    "model_not_allowed",
    "not_first_party",
    "disabled_by_env",
    "network_error",
    "preference",
    "unknown",
    FUTURE_REASON,
  ] as FastModeDisabledReason[])("retains the explained reason %s", (reason) => {
    expect(normalizeFastModeDisabledReason(reason)).toBe(reason);
  });

  /**
   * Scenario:
   * 1. Normalize `sdk_opt_in_required`, `pending` and `undefined`.
   * Expected:
   * - Each normalizes to `undefined`.
   */
  it.each(["sdk_opt_in_required", "pending", undefined] as (FastModeDisabledReason | undefined)[])(
    "drops the unexplained reason %s",
    (reason) => {
      expect(normalizeFastModeDisabledReason(reason)).toBeUndefined();
    },
  );
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

  it("rejects a value whose type differs from the option's advertised type", async () => {
    // Advertised as `type: "boolean"`: "on" is not a boolean.
    const booleanClient = setup({ useBooleanOption: true });
    await expect(
      booleanClient.agent.setSessionConfigOption({
        sessionId: SESSION_ID,
        configId: FAST_MODE_CONFIG_ID,
        value: FAST_MODE_ON,
      }),
    ).rejects.toMatchObject({ code: -32602 });
    expect(booleanClient.applyFlagSettings).not.toHaveBeenCalled();

    // Advertised as an on/off select: `true` is not a string.
    const selectClient = setup({ useBooleanOption: false });
    await expect(
      selectClient.agent.setSessionConfigOption({
        sessionId: SESSION_ID,
        configId: FAST_MODE_CONFIG_ID,
        type: "boolean",
        value: true,
      }),
    ).rejects.toMatchObject({ code: -32602 });
    expect(selectClient.applyFlagSettings).not.toHaveBeenCalled();
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

  function setup(opts: { fastModeEnabled: boolean; withOption: boolean; notices?: boolean }) {
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
      session: { configOptions: { boolean: {} }, ...(opts.notices ? { notices: {} } : {}) },
    };

    const session = {
      query: {},
      fastModeEnabled: opts.fastModeEnabled,
      fastModeDisabledReason: undefined as FastModeDisabledReason | undefined,
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
          reason?: FastModeDisabledReason,
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
    // A routine reason normalizes away, so it's still "unchanged" — an
    // `sdk_opt_in_required` on every turn's result must not churn the option.
    await sync(SESSION_ID, session, "off", "sdk_opt_in_required");

    expect(sessionUpdates).toHaveLength(0);
  });

  /**
   * Scenario:
   * 1. The toggle is on and the SDK reports `off` with a reason.
   * 2. The SDK reports the same `off` and reason again.
   * Expected:
   * - The toggle is cleared and the reason retained.
   * - One transcript line carries the explanation, then one `config_option_update`.
   * - The repeat report sends nothing.
   */
  it.each([
    ["extra_usage_disabled", "requires extra usage to be enabled for this account"],
    ["preference", "not enabled for your organization or API gateway"],
    ["unknown", "currently unavailable"],
    [FUTURE_REASON, "not available (some_future_reason)"],
  ] as [FastModeDisabledReason, string][])(
    "explains the blocking reason %s once when the SDK refuses a toggle the user turned on",
    async (reason, explanation) => {
      const { sync, session, sessionUpdates } = setup({ fastModeEnabled: true, withOption: true });

      await sync(SESSION_ID, session, "off", reason);

      expect(session.fastModeEnabled).toBe(false);
      expect(session.fastModeDisabledReason).toBe(reason);
      expect(sessionUpdates).toHaveLength(2);
      expect(sessionUpdates[0].update).toEqual({
        sessionUpdate: "agent_message_chunk",
        content: {
          type: "text",
          text: `\n\n> **Fast mode turned off:** ${explanation}.\n\n`,
        },
      });
      expect(sessionUpdates[1].update).toMatchObject({ sessionUpdate: "config_option_update" });
      expect(session.configOptions).toContainEqual(createFastModeConfigOption(false, true, reason));

      // The same report again changes nothing the user can see: no repeat notice.
      await sync(SESSION_ID, session, "off", reason);
      expect(sessionUpdates).toHaveLength(2);
    },
  );

  /**
   * Scenario:
   * 1. The toggle is on and the SDK reports `off` with `sdk_opt_in_required`.
   * Expected:
   * - The toggle is cleared and no reason is retained.
   * - Only a `config_option_update` is sent: no notice or transcript line.
   */
  it("clears the toggle quietly when the SDK reports off with sdk_opt_in_required", async () => {
    const { sync, session, sessionUpdates } = setup({ fastModeEnabled: true, withOption: true });

    await sync(SESSION_ID, session, "off", "sdk_opt_in_required");

    expect(session.fastModeEnabled).toBe(false);
    expect(session.fastModeDisabledReason).toBeUndefined();
    expect(sessionUpdates.map((n) => n.update.sessionUpdate)).toEqual(["config_option_update"]);
  });

  it("explains the flip as a live notice to a client on the notice contract", async () => {
    const { sync, session, sessionUpdates } = setup({
      fastModeEnabled: true,
      withOption: true,
      notices: true,
    });

    await sync(SESSION_ID, session, "off", "free");

    // An operational advisory, not something the model said: no transcript line.
    expect(sessionUpdates.map((n) => n.update.sessionUpdate)).toEqual([
      "notice",
      "config_option_update",
    ]);
    expect(sessionUpdates[0].update).toEqual({
      sessionUpdate: "notice",
      severity: "warning",
      title: "Fast mode turned off",
      description: "Not available on the free plan.",
    });
  });

  it("updates the description when only the reason changes", async () => {
    const { sync, session, sessionUpdates } = setup({ fastModeEnabled: false, withOption: true });

    await sync(SESSION_ID, session, "off", "not_first_party");

    expect(session.fastModeEnabled).toBe(false);
    // The toggle was already off, so the flip-time notice doesn't fire — only
    // the description carries the explanation.
    expect(sessionUpdates).toHaveLength(1);
    expect(sessionUpdates[0].update).toMatchObject({ sessionUpdate: "config_option_update" });
    expect(session.configOptions).toContainEqual(
      createFastModeConfigOption(false, true, "not_first_party"),
    );
  });

  it("drops a retained reason once fast mode comes back on", async () => {
    const { sync, session } = setup({ fastModeEnabled: false, withOption: true });

    await sync(SESSION_ID, session, "off", "network_error");
    expect(session.fastModeDisabledReason).toBe("network_error");

    await sync(SESSION_ID, session, "on");
    expect(session.fastModeEnabled).toBe(true);
    expect(session.fastModeDisabledReason).toBeUndefined();
    expect(session.configOptions).toContainEqual(createFastModeConfigOption(true, true));
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

describe("Fast mode that Claude Code refuses during a turn", () => {
  const SESSION_ID = "test-session";

  /** A session whose Claude Code answers the first prompt with a `system`/init
   *  that reports Fast mode off with `reason`, as it does on every turn. */
  async function setupTurn(reason: FastModeDisabledReason) {
    const updates: SessionNotification[] = [];
    const client = {
      sessionUpdate: async (n: SessionNotification) => {
        updates.push(n);
      },
    } as unknown as AcpClient;
    const agent = new ClaudeAcpAgent(client, { log: () => {}, error: () => {} });
    await initializeClient(agent, { session: { configOptions: { boolean: {} } } });

    const input = new Pushable<any>();
    async function* messages() {
      const { value: prompt } = await input[Symbol.asyncIterator]().next();
      yield userEcho(prompt);
      yield {
        type: "system",
        subtype: "init",
        fast_mode_state: "off",
        fast_mode_disabled_reason: reason,
        session_id: SESSION_ID,
      };
      yield successfulResultMessage();
      yield { type: "system", subtype: "session_state_changed", state: "idle" };
    }
    const query = Object.assign(wrapQuery(messages()), { applyFlagSettings: async () => {} });
    agent.sessions[SESSION_ID] = mockSessionState({
      query,
      input,
      fastModeEnabled: false,
      configOptions: [createFastModeConfigOption(false, true)],
    });
    return { agent, updates };
  }

  /**
   * Scenario:
   * 1. The client, without the notices capability, turns Fast mode on.
   * 2. It sends a prompt, and Claude Code's init reports Fast mode off, reason `preference`.
   * Expected:
   * - The transcript gets one line that explains the organization or gateway has not enabled it.
   * - Then one `config_option_update` where `fast` reads off, with the explanation in its description.
   */
  it("explains a Fast mode that the organization or gateway has not enabled", async () => {
    const { agent, updates } = await setupTurn("preference");

    await agent.setSessionConfigOption({
      sessionId: SESSION_ID,
      configId: "fast",
      type: "boolean",
      value: true,
    });
    updates.length = 0;
    await agent.prompt({ sessionId: SESSION_ID, prompt: [{ type: "text", text: "hi" }] });

    const explained = updates
      .map((n) => n.update)
      .filter((u) => u.sessionUpdate !== "usage_update");
    expect(explained).toEqual([
      {
        sessionUpdate: "agent_message_chunk",
        content: {
          type: "text",
          text: "\n\n> **Fast mode turned off:** not enabled for your organization or API gateway.\n\n",
        },
      },
      {
        sessionUpdate: "config_option_update",
        configOptions: [
          expect.objectContaining({
            id: "fast",
            currentValue: false,
            description: expect.stringMatching(
              / — not enabled for your organization or API gateway$/,
            ),
          }),
        ],
      },
    ]);
  });
});
