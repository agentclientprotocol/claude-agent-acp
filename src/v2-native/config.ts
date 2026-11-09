/**
 * The config options of a native v2 session: its permission mode, model,
 * effort, Fast mode, ultracode and main-thread agent. Claude Code owns them
 * all. The session sets each on the query when the client picks a value, and
 * follows the changes it learns of (an approved plan's mode, a model switch
 * that the adapter did not make, the Fast mode state that Claude Code
 * reports).
 *
 * The options are built and changed by the v1 core's rules, from the shared
 * modules (`session-config-options.ts`, `session-effort.ts`,
 * `session-fast-mode.ts`, `session-ultracode.ts`, `session-model.ts`,
 * `session-mode.ts`). Fast mode and ultracode are boolean options: every v2
 * client takes them. The options carry no AIR `recommendedValue`, as this
 * core serves no AIR extension.
 *
 * The mode follows `SessionModeManager`: a model whose `ModelInfo` does not
 * report `supportsAutoMode` runs `auto` as `acceptEdits`, with a notice,
 * whether the client picks `auto`, an answer to ExitPlanMode does, or a model
 * switch leaves the session in it.
 */
import {
  RequestError,
  type SessionConfigOption,
  type SessionModeState,
  type SessionNotification,
} from "@agentclientprotocol/sdk/unstable";
import type * as v2 from "@agentclientprotocol/sdk/experimental/v2/unstable";
import type {
  AgentInfo,
  FastModeDisabledReason,
  FastModeState,
  HookCallbackMatcher,
  ModelInfo,
  PermissionMode,
  PermissionResult,
  Query,
  Settings,
} from "@anthropic-ai/claude-agent-sdk";
import type { Logger } from "../acp-agent.js";
import type { SubagentModels } from "../native-subagents.js";
import { DEFAULT_AGENT_ID } from "../session-config-ids.js";
import {
  AGENT_CONFIG_ID,
  buildConfigOptions,
  configOptionValue,
  discoverCustomAgents,
} from "../session-config-options.js";
import {
  EFFORT_CONFIG_ID,
  effortFlagSettings,
  effortForModelSwitch,
  settleEffortAfterModelSwitch,
  settingsEffortForModel,
  type EffortState,
} from "../session-effort.js";
import {
  createFastModeConfigOption,
  FAST_MODE_CONFIG_ID,
  fastModeStateChange,
  fastModeStateEnabled,
  normalizeFastModeDisabledReason,
} from "../session-fast-mode.js";
import {
  MODEL_CONFIG_ID,
  modelDisplayName,
  modelEntryFor,
  resolveModelPreference,
  type SessionModelState,
} from "../session-model.js";
import {
  MODE_CONFIG_ID,
  SessionModeManager,
  type ModeAvailability,
  type SessionMode,
} from "../session-mode.js";
import { noticeUpdate } from "../session-notices.js";
import {
  createUltracodeConfigOption,
  readUltracodeSettings,
  ultracodeSupported,
  ultracodeWorkflowsEnabled,
} from "../session-ultracode.js";
import { v1SetSessionConfigOptionRequest, v2ConfigOptions } from "../v2/session.js";

type ConfigQuery = Pick<
  Query,
  "setPermissionMode" | "setModel" | "applyFlagSettings" | "supportedAgents"
>;

/** Every v2 client takes boolean config options. */
const BOOLEAN_OPTIONS = true;
/** The AIR `recommendedValue` presentation, which this core does not serve. */
const RECOMMENDED_VALUE = false;

/** The session's options and what they are built from, as `SessionModeManager` reads and updates them. */
type ConfigSession = SessionMode & {
  query: ConfigQuery;
  models: SessionModelState;
  /** The options as the client has them, in v1 form. */
  configOptions: SessionConfigOption[];
};

/** What a session starts with besides its mode and models (see {@link SessionConfig.start}). */
export interface ConfigSetup {
  /** The `fast_mode_state` and `fast_mode_disabled_reason` of the query's initialization. */
  fastMode: { state?: FastModeState; disabledReason?: FastModeDisabledReason };
  /** The client's `_meta.claudeCode.options`: its `effort` and `agent`. */
  client: { effort?: string; agent?: string } | undefined;
  /** The settings that effort resolves from (`mergeEffortSettings`), read at each model switch. */
  effortSettings(): Settings;
}

export class SessionConfig {
  private readonly session: ConfigSession;
  private readonly rules: SessionModeManager<ConfigSession>;
  private readonly agents: AgentInfo[];
  private currentAgent: string;
  private effort: EffortState;
  private fastModeEnabled: boolean;
  private fastModeDisabledReason: FastModeDisabledReason | undefined;
  private ultracodeEnabled: boolean;
  private readonly ultracodeWorkflowsEnabled: boolean | undefined;

  private constructor(
    private readonly sessionId: string,
    query: ConfigQuery,
    modes: SessionModeState,
    models: SessionModelState,
    /** What Claude Code reports of each model: its descriptions and capabilities. */
    private readonly modelInfos: ModelInfo[],
    state: {
      agents: AgentInfo[];
      currentAgent: string;
      effort: EffortState;
      fastModeEnabled: boolean;
      fastModeDisabledReason: FastModeDisabledReason | undefined;
      ultracodeEnabled: boolean;
      ultracodeWorkflowsEnabled: boolean | undefined;
      configOptions: SessionConfigOption[];
    },
    private readonly effortSettings: () => Settings,
    /** Sends an update of the session, such as the Auto mode fallback's notice. */
    private readonly notify: (notification: SessionNotification) => void,
    private readonly logger: Logger,
    autoModeFallbackWarningPending: boolean,
  ) {
    this.session = {
      query,
      modes,
      models,
      modelInfos,
      configOptions: state.configOptions,
      autoModeFallbackWarningPending,
    };
    this.agents = state.agents;
    this.currentAgent = state.currentAgent;
    this.effort = state.effort;
    this.fastModeEnabled = state.fastModeEnabled;
    this.fastModeDisabledReason = state.fastModeDisabledReason;
    this.ultracodeEnabled = state.ultracodeEnabled;
    this.ultracodeWorkflowsEnabled = state.ultracodeWorkflowsEnabled;
    this.rules = new SessionModeManager<ConfigSession>({
      getSession: () => this.session,
      sessionEndedMessage: "The session ended",
      updateConfigOption: async () => {},
      sessionUpdate: async (notification) => notify(notification),
      // Every v2 client takes `notice` updates.
      supportsNotices: () => true,
      logError: (...args) => logger.error(...args),
    });
  }

  /**
   * The config of a session that starts in `mode`, as the v1 core starts one
   * (`ClaudeAcpAgent.createSession`): a mode the model cannot serve falls
   * back, and the fallback's notice goes out with the first prompt. The
   * custom agents are discovered, Fast mode follows the reported state, and
   * ultracode follows Claude Code's `get_settings` report, or the settings
   * without one. The client's `effort` pins the effort when the model offers
   * it.
   */
  static async start(
    sessionId: string,
    query: ConfigQuery & Query,
    mode: { mode: PermissionMode; builtInDefault: boolean } & ModeAvailability,
    models: SessionModelState,
    modelInfos: ModelInfo[],
    currentModelInfo: ModelInfo | undefined,
    setup: ConfigSetup,
    notify: (notification: SessionNotification) => void,
    logger: Logger,
  ): Promise<SessionConfig> {
    const rules = new SessionModeManager({
      getSession: () => undefined,
      sessionEndedMessage: "",
      updateConfigOption: async () => {},
      sessionUpdate: async () => {},
      logError: (...args) => logger.error(...args),
    });
    const { modes, autoModeFallbackWarningPending } = await rules.initialize({
      query,
      requestedMode: mode.mode,
      builtInDefault: mode.builtInDefault,
      currentModelInfo,
      currentModelId: models.currentModelId,
      allowBypass: mode.allowBypass,
      allowAuto: mode.allowAuto,
    });
    const agents = await discoverCustomAgents(query);
    // Only a listed agent is selected: another would leave the option's
    // value outside its own entries.
    const requestedAgent = setup.client?.agent;
    const currentAgent =
      requestedAgent && agents.some((agent) => agent.name === requestedAgent)
        ? requestedAgent
        : DEFAULT_AGENT_ID;
    const fastModeEnabled =
      setup.fastMode.state !== undefined && fastModeStateEnabled(setup.fastMode.state);
    const fastModeDisabledReason = fastModeEnabled
      ? undefined
      : normalizeFastModeDisabledReason(setup.fastMode.disabledReason);
    const settings = setup.effortSettings();
    const ultracodeReport = await readUltracodeSettings(query);
    const ultracodeEnabled = ultracodeReport?.requested ?? settings.ultracode === true;
    const workflowsEnabled = ultracodeWorkflowsEnabled(ultracodeReport, currentModelInfo);
    const clientEffort = setup.client?.effort;
    const configOptions = buildConfigOptions(
      modes,
      models,
      modelInfos,
      clientEffort ?? settingsEffortForModel(settings, currentModelInfo),
      agents,
      currentAgent,
      {
        supported: currentModelInfo?.supportsFastMode ?? false,
        enabled: fastModeEnabled,
        useBooleanOption: BOOLEAN_OPTIONS,
        disabledReason: fastModeDisabledReason,
      },
      { useRecommendedValue: RECOMMENDED_VALUE },
      {
        supported:
          ultracodeReport?.available ?? ultracodeSupported(workflowsEnabled, currentModelInfo),
        enabled: ultracodeEnabled,
        useBooleanOption: BOOLEAN_OPTIONS,
      },
    );
    // The client's effort is a pin when the model offers it.
    const pinned =
      clientEffort !== undefined &&
      configOptions.find((option) => option.id === EFFORT_CONFIG_ID)?.currentValue === clientEffort
        ? clientEffort
        : undefined;
    return new SessionConfig(
      sessionId,
      query,
      modes,
      models,
      modelInfos,
      {
        agents,
        currentAgent,
        effort: { pinned, applied: pinned },
        fastModeEnabled,
        fastModeDisabledReason,
        ultracodeEnabled,
        ultracodeWorkflowsEnabled: workflowsEnabled,
        configOptions,
      },
      setup.effortSettings,
      notify,
      logger,
      autoModeFallbackWarningPending,
    );
  }

  /** The options, in v2 form. */
  options(): v2.SessionConfigOption[] {
    return v2ConfigOptions(this.session.configOptions);
  }

  /** The entries of the `model` option, for the `model` of a subagent's session. */
  subagentModels(): SubagentModels {
    return {
      entry: (model) => modelEntryFor(this.session.configOptions, this.modelInfos, model),
      name: (model) => modelDisplayName(this.modelInfos, model),
    };
  }

  /** The current model, and what Claude Code reports of it. */
  currentModel(): { id: string; info: ModelInfo | undefined } {
    const id = this.session.models.currentModelId;
    return { id, info: this.modelInfos.find((model) => model.value === id) };
  }

  availableModeIds(): string[] {
    return this.session.modes.availableModes.map((mode) => mode.id);
  }

  /** The mode the session left when it entered plan mode, while it is in plan. */
  prePlanMode(): string | undefined {
    return this.session.prePlanMode;
  }

  /** A prompt goes out: the notice of a fallback at the session's start goes with the first. */
  async promptSent(): Promise<void> {
    if (this.session.autoModeFallbackWarningPending) {
      await this.rules.publishFallbackWarning(this.sessionId, this.session);
    }
  }

  /**
   * Sets the value of `params` on the query, and records it once Claude Code
   * took it. The value is checked against the option as the session
   * advertised it (`configOptionValue`): a select takes an `id` of its
   * entries (or a model alias), a boolean takes a boolean.
   */
  async set(params: v2.SetSessionConfigOptionRequest): Promise<void> {
    const request = v1SetSessionConfigOptionRequest(params);
    const option = this.session.configOptions.find((entry) => entry.id === request.configId);
    if (!option) {
      throw RequestError.invalidParams(
        { configId: request.configId },
        `Unknown config option: ${request.configId}`,
      );
    }
    const selected = configOptionValue(option, request, this.modelInfos);
    if ("enabled" in selected) {
      if (request.configId === FAST_MODE_CONFIG_ID) await this.setFastMode(selected.enabled);
      else await this.setUltracode(selected.enabled);
      return;
    }
    const value = selected.value;
    switch (request.configId) {
      case MODE_CONFIG_ID:
        await this.enterMode(value as PermissionMode);
        return;
      case MODEL_CONFIG_ID:
        await this.session.query.setModel(value);
        await this.recordModel(value);
        return;
      case EFFORT_CONFIG_ID:
        // Applied first, so a rejected control request leaves the option as it was.
        await this.session.query.applyFlagSettings(
          effortFlagSettings(value, this.ultracodeEnabled),
        );
        this.setCurrentValue(EFFORT_CONFIG_ID, value);
        // "Default" hands effort back to the CLI's per-model settings: it un-pins.
        this.effort =
          value !== "default"
            ? { pinned: value, applied: value }
            : { pinned: undefined, applied: undefined };
        return;
      case AGENT_CONFIG_ID:
        // `null` clears the flag layer back to the standard Claude Code
        // agent. The change takes effect on the next turn.
        await this.session.query.applyFlagSettings({
          agent: value === DEFAULT_AGENT_ID ? null : value,
        });
        this.currentAgent = value;
        this.setCurrentValue(AGENT_CONFIG_ID, value);
        return;
      default:
        throw RequestError.invalidParams(
          { configId: request.configId },
          `Unknown config option: ${request.configId}`,
        );
    }
  }

  /**
   * Sets the mode `requested` on the query, and records it once Claude Code
   * took it: `auto` that the model cannot serve runs as its fallback, with a
   * notice.
   */
  async enterMode(requested: PermissionMode): Promise<void> {
    const mode = this.rules.effectiveMode(this.session, requested);
    await this.session.query.setPermissionMode(mode);
    this.rules.syncConfig(this.session, mode);
    if (mode !== requested) await this.rules.publishFallbackWarning(this.sessionId, this.session);
  }

  /** Claude Code switched the mode itself. Returns whether the option changed. */
  modeChanged(mode: PermissionMode): boolean {
    if (this.session.modes.currentModeId === mode || !this.availableModeIds().includes(mode)) {
      return false;
    }
    this.rules.syncConfig(this.session, mode);
    return true;
  }

  /**
   * Claude Code switched the model without the adapter: a typed `/model`, or
   * a refusal fallback. Returns whether the options changed. A model that the
   * option does not list is recorded by its id, which the option then lists,
   * as on the bridge.
   */
  async modelSwitched(model: string): Promise<boolean> {
    const value = resolveModelPreference(this.modelInfos, model)?.value ?? model;
    if (this.session.models.currentModelId === value) return false;
    await this.recordModel(value);
    return true;
  }

  /**
   * Claude Code reported a Fast mode state (`system`/init, a result). Returns
   * whether the option changed. Without a Fast mode option the model does not
   * support it, and the state says nothing of the user's intent, which stays
   * for a model that does (see `fastModeStateChange`).
   */
  fastModeReported(
    state: FastModeState | undefined,
    reason: FastModeDisabledReason | undefined,
  ): boolean {
    if (!this.session.configOptions.some((option) => option.id === FAST_MODE_CONFIG_ID)) {
      return false;
    }
    const change = fastModeStateChange(
      { enabled: this.fastModeEnabled, disabledReason: this.fastModeDisabledReason },
      state,
      reason,
    );
    if (!change) return false;
    this.fastModeEnabled = change.enabled;
    this.fastModeDisabledReason = change.disabledReason;
    this.refreshFastModeOption();
    if (change.notice) {
      this.notify({ sessionId: this.sessionId, update: noticeUpdate(change.notice.notice) });
    }
    return true;
  }

  /**
   * An allowed permission answer, with an `auto` mode that the model cannot
   * serve set as its fallback (see the module doc).
   */
  async permissionAllowed(result: PermissionResult): Promise<PermissionResult> {
    const { permissionResult, fallbackApplied } = this.rules.applyPermissionFallback(
      this.session,
      result,
    );
    if (fallbackApplied) await this.rules.publishFallbackWarning(this.sessionId, this.session);
    return permissionResult;
  }

  /** Applied first, so a rejected control request leaves the option as it was. */
  private async setFastMode(enabled: boolean): Promise<void> {
    await this.session.query.applyFlagSettings({ fastMode: enabled });
    this.fastModeEnabled = enabled;
    this.refreshFastModeOption();
  }

  /**
   * An explicit boolean leaves the effort level alone (`null` would reset the
   * flag layer). Applied first, so a rejected control request leaves the
   * option as it was.
   */
  private async setUltracode(enabled: boolean): Promise<void> {
    await this.session.query.applyFlagSettings({ ultracode: enabled });
    this.ultracodeEnabled = enabled;
    this.replaceOption(createUltracodeConfigOption(enabled, BOOLEAN_OPTIONS));
  }

  private refreshFastModeOption(): void {
    this.replaceOption(
      createFastModeConfigOption(
        this.fastModeEnabled,
        BOOLEAN_OPTIONS,
        this.fastModeDisabledReason,
      ),
    );
  }

  private replaceOption(option: SessionConfigOption): void {
    this.session.configOptions = this.session.configOptions.map((entry) =>
      entry.id === option.id ? option : entry,
    );
  }

  private setCurrentValue(configId: string, value: string): void {
    this.session.configOptions = this.session.configOptions.map((entry) =>
      entry.id === configId && typeof entry.currentValue === "string"
        ? { ...entry, currentValue: value }
        : entry,
    );
  }

  /**
   * Records the model `value`, as the v1 core does (`applyConfigOptionValue`):
   * an `auto` mode it cannot serve falls back, and the options are rebuilt
   * for it. Effort follows `effortForModelSwitch`; Fast mode and ultracode
   * show only on a model that supports them, with the user's retained
   * choice.
   */
  private async recordModel(value: string): Promise<void> {
    const info = this.modelInfos.find((model) => model.value === value);
    this.session.models = { ...this.session.models, currentModelId: value };
    const modeDowngraded = await this.rules.reconcileForModel(this.session, info);
    // `model_not_allowed` described the model the session left. The other
    // reasons are account- or environment-scoped and stay true.
    if (this.fastModeDisabledReason === "model_not_allowed") {
      this.fastModeDisabledReason = undefined;
    }
    const displayed = this.session.configOptions.find(
      (option) => option.id === EFFORT_CONFIG_ID,
    )?.currentValue;
    const effortSwitch = effortForModelSwitch({
      state: this.effort,
      displayed: typeof displayed === "string" ? displayed : undefined,
      newModelInfo: info,
      modelId: value,
      settings: this.effortSettings(),
      useRecommendedValue: RECOMMENDED_VALUE,
    });
    const options = buildConfigOptions(
      this.session.modes,
      this.session.models,
      this.modelInfos,
      effortSwitch.seed,
      this.agents,
      this.currentAgent,
      {
        supported: info?.supportsFastMode ?? false,
        enabled: this.fastModeEnabled,
        useBooleanOption: BOOLEAN_OPTIONS,
        disabledReason: this.fastModeDisabledReason,
      },
      { useRecommendedValue: RECOMMENDED_VALUE },
      {
        supported: ultracodeSupported(this.ultracodeWorkflowsEnabled, info),
        enabled: this.ultracodeEnabled,
        useBooleanOption: BOOLEAN_OPTIONS,
      },
    );
    const effort = await settleEffortAfterModelSwitch(
      effortSwitch,
      options.find((option) => option.id === EFFORT_CONFIG_ID),
      this.ultracodeEnabled,
      RECOMMENDED_VALUE,
      (settings) => this.session.query.applyFlagSettings(settings),
    );
    this.effort = effort.state;
    this.session.configOptions = options.flatMap((option) =>
      option.id !== EFFORT_CONFIG_ID ? [option] : effort.option ? [effort.option] : [],
    );
    // The model switch already happened: a failed effort sync only logs.
    if ("error" in effort) {
      this.logger.error(
        `Session ${this.sessionId}: failed to synchronize effort after the switch to ${value}`,
        effort.error,
      );
    }
    if (modeDowngraded) await this.rules.publishFallbackWarning(this.sessionId, this.session);
  }
}

/**
 * The PostModelSwitch hook: a switch of the root's model that the adapter
 * did not make (`source` other than `sdk`, its own `setModel`, and `resume`,
 * which the setup read already) updates the `model` option. A subagent's
 * switch (`agent_id`) is not the session's.
 */
export function modelSwitchHook(switched: (model: string) => void): HookCallbackMatcher {
  return {
    hooks: [
      async (input) => {
        if (
          input.hook_event_name === "PostModelSwitch" &&
          !input.agent_id &&
          input.source !== "sdk" &&
          input.source !== "resume"
        ) {
          // After the hook's answer: Claude Code waits for it, and the
          // session's control requests share its channel.
          const model = input.to_model;
          setImmediate(() => switched(model));
        }
        return { continue: true };
      },
    ],
  };
}
