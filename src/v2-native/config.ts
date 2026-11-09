/**
 * The config options of a native v2 session: its permission mode and its
 * model. Claude Code owns both. The session sets each on the query when the
 * client picks a value, and follows the changes it learns of (an approved
 * plan's mode, a model switch that the adapter did not make).
 *
 * The mode follows the v1 core's rules (`SessionModeManager`): a model whose
 * `ModelInfo` does not report `supportsAutoMode` runs `auto` as `acceptEdits`,
 * with a notice, whether the client picks `auto`, an answer to ExitPlanMode
 * does, or a model switch leaves the session in it.
 */
import {
  RequestError,
  type SessionConfigOption,
  type SessionModeState,
  type SessionNotification,
} from "@agentclientprotocol/sdk/unstable";
import type * as v2 from "@agentclientprotocol/sdk/experimental/v2/unstable";
import type {
  HookCallbackMatcher,
  ModelInfo,
  PermissionMode,
  PermissionResult,
  Query,
} from "@anthropic-ai/claude-agent-sdk";
import type { Logger } from "../acp-agent.js";
import type { SubagentModels } from "../native-subagents.js";
import {
  buildModelConfigOption,
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
import { v2ConfigOptions } from "../v2/session.js";

type ConfigQuery = Pick<Query, "setPermissionMode" | "setModel">;

/** The session's mode and model, as `SessionModeManager` reads and updates them. */
type ModeSession = SessionMode & {
  query: ConfigQuery;
  models: SessionModelState;
  /** Unused: `SessionModeManager.syncConfig` updates it; the options are built from the state. */
  configOptions: SessionConfigOption[];
};

export class SessionConfig {
  private readonly session: ModeSession;
  private readonly rules: SessionModeManager<ModeSession>;

  private constructor(
    private readonly sessionId: string,
    query: ConfigQuery,
    modes: SessionModeState,
    models: SessionModelState,
    /** What Claude Code reports of each model: its descriptions and `supportsAutoMode`. */
    private readonly modelInfos: ModelInfo[],
    /** Sends an update of the session, such as the Auto mode fallback's notice. */
    notify: (notification: SessionNotification) => void,
    logger: Logger,
    autoModeFallbackWarningPending: boolean,
  ) {
    this.session = {
      query,
      modes,
      models,
      modelInfos,
      configOptions: [],
      autoModeFallbackWarningPending,
    };
    this.rules = new SessionModeManager<ModeSession>({
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
   * (`SessionModeManager.initialize`): a mode the model cannot serve falls
   * back, and the fallback's notice goes out with the first prompt.
   */
  static async start(
    sessionId: string,
    query: ConfigQuery,
    mode: { mode: PermissionMode; builtInDefault: boolean } & ModeAvailability,
    models: SessionModelState,
    modelInfos: ModelInfo[],
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
      currentModelInfo: modelInfos.find((model) => model.value === models.currentModelId),
      currentModelId: models.currentModelId,
      allowBypass: mode.allowBypass,
      allowAuto: mode.allowAuto,
    });
    return new SessionConfig(
      sessionId,
      query,
      modes,
      models,
      modelInfos,
      notify,
      logger,
      autoModeFallbackWarningPending,
    );
  }

  /** The options, built as the v1 core builds its mode and model options. */
  options(): v2.SessionConfigOption[] {
    return v2ConfigOptions(this.v1Options());
  }

  /** The entries of the `model` option, for the `model` of a subagent's session. */
  subagentModels(): SubagentModels {
    return {
      entry: (model) => modelEntryFor(this.v1Options(), this.modelInfos, model),
      name: (model) => modelDisplayName(this.modelInfos, model),
    };
  }

  private v1Options(): SessionConfigOption[] {
    const { modes, models } = this.session;
    return [
      SessionModeManager.configOption(modes),
      // A gateway that lists none of the SDK's models leaves no model option.
      ...(models.availableModels.length > 0
        ? [buildModelConfigOption(models, this.modelInfos, false)]
        : []),
    ];
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
   * Sets `value` on the query, and records it once Claude Code took it. Both
   * options are selects, which take an `id` value.
   */
  async set(configId: string, type: string | undefined, value: unknown): Promise<void> {
    if (type !== "id" || typeof value !== "string") {
      throw RequestError.invalidParams(
        { configId, type },
        `${configId} is a select option: set it with an \`id\` value`,
      );
    }
    switch (configId) {
      case MODE_CONFIG_ID: {
        if (!this.availableModeIds().includes(value)) {
          throw RequestError.invalidParams({ value }, `Unknown mode: ${value}`);
        }
        const requested = value as PermissionMode;
        const mode = this.rules.effectiveMode(this.session, requested);
        await this.session.query.setPermissionMode(mode);
        this.rules.syncConfig(this.session, mode);
        if (mode !== requested)
          await this.rules.publishFallbackWarning(this.sessionId, this.session);
        return;
      }
      case MODEL_CONFIG_ID: {
        if (!this.session.models.availableModels.some((model) => model.modelId === value)) {
          throw RequestError.invalidParams({ value }, `Unknown model: ${value}`);
        }
        await this.session.query.setModel(value);
        await this.recordModel(value);
        return;
      }
      default:
        throw RequestError.invalidParams({ configId }, `Unknown config option: ${configId}`);
    }
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
   * Claude Code switched the model without the adapter, such as for a
   * `/model` command typed as a prompt. Returns whether the options changed.
   * A model that the option does not list is recorded by its id, which the
   * option then lists, as on the bridge.
   */
  async modelSwitched(model: string): Promise<boolean> {
    const value = resolveModelPreference(this.modelInfos, model)?.value ?? model;
    if (this.session.models.currentModelId === value) return false;
    await this.recordModel(value);
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

  /** Records the model `value`; an `auto` mode it cannot serve falls back. */
  private async recordModel(value: string): Promise<void> {
    this.session.models = { ...this.session.models, currentModelId: value };
    const info = this.modelInfos.find((model) => model.value === value);
    if (await this.rules.reconcileForModel(this.session, info)) {
      await this.rules.publishFallbackWarning(this.sessionId, this.session);
    }
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
