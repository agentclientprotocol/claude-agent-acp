import {
  RequestError,
  type SessionConfigOption,
  type SessionModeState,
  type SessionNotification,
  type SetSessionModeRequest,
  type SetSessionModeResponse,
} from "@agentclientprotocol/sdk";
import type {
  ModelInfo,
  PermissionMode,
  PermissionResult,
  Query,
} from "@anthropic-ai/claude-agent-sdk";
import { ALLOW_BYPASS } from "./permissions/modes.js";

export const MODE_CONFIG_ID = "mode";
export const AUTO_MODE_FALLBACK: PermissionMode = "acceptEdits";

const AUTO_MODE_FALLBACK_NOTICE =
  "**Auto mode unavailable:** the selected model does not support Auto mode; using Accept edits instead.";

export type SessionMode = {
  query: Pick<Query, "setPermissionMode">;
  queryClosed?: boolean;
  modes: SessionModeState;
  models: { currentModelId: string };
  modelInfos: ModelInfo[];
  /** Prevents the model-specific Auto fallback from spamming the transcript. */
  autoModeFallbackWarningShown?: boolean;
  /** Initial mode fallback is reported after session/new, on the first prompt. */
  autoModeFallbackWarningPending?: boolean;
};

export type SessionModeManagerOptions<S extends SessionMode> = {
  getSession(sessionId: string): S | undefined;
  sessionEndedMessage: string;
  updateConfigOption(sessionId: string, configId: string, value: string): Promise<void>;
  sessionUpdate(params: SessionNotification): Promise<void>;
  logError(...args: unknown[]): void;
};

type ModeConfigSession = SessionMode & {
  configOptions: SessionConfigOption[];
};

type InitializeSessionModeParams = {
  query: Pick<Query, "setPermissionMode">;
  requestedMode: PermissionMode;
  currentModelInfo?: ModelInfo;
  currentModelId: string;
};

/** Owns session-mode policy and the ACP/SDK synchronization it requires. */
export class SessionModeManager<S extends SessionMode> {
  constructor(private readonly options: SessionModeManagerOptions<S>) {}

  async initialize({
    query,
    requestedMode,
    currentModelInfo,
    currentModelId,
  }: InitializeSessionModeParams): Promise<{
    modes: SessionModeState;
    autoModeFallbackWarningPending: boolean;
  }> {
    const availableModes = this.buildAvailableModes();
    let effectiveMode = requestedMode;
    let autoModeFallbackWarningPending = false;

    if (
      effectiveMode === "auto" &&
      currentModelInfo !== undefined &&
      currentModelInfo.supportsAutoMode !== true
    ) {
      this.options.logError(
        `permissions.defaultMode "auto" is not available for model ` +
          `"${currentModelId}"; falling back to "${AUTO_MODE_FALLBACK}".`,
      );
      effectiveMode = AUTO_MODE_FALLBACK;
      autoModeFallbackWarningPending = true;
      await this.trySyncMode(query, effectiveMode, "Failed to sync clamped permissionMode to SDK:");
    } else if (!this.isAvailable(availableModes, effectiveMode)) {
      this.options.logError(
        `permissions.defaultMode "${effectiveMode}" is not available in ` +
          `this session; falling back to "default".`,
      );
      effectiveMode = "default";
      await this.trySyncMode(query, effectiveMode, "Failed to sync clamped permissionMode to SDK:");
    }

    return {
      modes: { currentModeId: effectiveMode, availableModes },
      autoModeFallbackWarningPending,
    };
  }

  static configOption(modes: SessionModeState): SessionConfigOption {
    return {
      id: MODE_CONFIG_ID,
      name: "Mode",
      description: "Session permission mode",
      category: "mode",
      type: "select",
      currentValue: modes.currentModeId,
      options: modes.availableModes.map((mode) => ({
        value: mode.id,
        name: mode.name,
        description: mode.description,
        _meta: mode._meta,
      })),
    };
  }

  syncConfig(session: ModeConfigSession, mode: string): void {
    session.modes = { ...session.modes, currentModeId: mode };
    session.configOptions = session.configOptions.map((option) =>
      option.id === MODE_CONFIG_ID && typeof option.currentValue === "string"
        ? { ...option, currentValue: mode }
        : option,
    );
  }

  availableModeIds(modes: SessionModeState): string[] {
    return modes.availableModes.map((mode) => mode.id);
  }

  effectiveMode(session: SessionMode, requestedMode: PermissionMode): PermissionMode {
    return requestedMode === "auto" && this.isAutoUnavailable(session)
      ? AUTO_MODE_FALLBACK
      : requestedMode;
  }

  applyPermissionFallback(
    session: SessionMode,
    permissionResult: PermissionResult,
  ): { permissionResult: PermissionResult; fallbackApplied: boolean } {
    const fallbackApplied =
      this.isAutoUnavailable(session) &&
      permissionResult.behavior === "allow" &&
      permissionResult.updatedPermissions?.some(
        (update) => update.type === "setMode" && update.mode === "auto",
      ) === true;
    if (!fallbackApplied || permissionResult.behavior !== "allow") {
      return { permissionResult, fallbackApplied: false };
    }

    return {
      permissionResult: {
        ...permissionResult,
        updatedPermissions: permissionResult.updatedPermissions?.map((update) =>
          update.type === "setMode" && update.mode === "auto"
            ? { ...update, mode: AUTO_MODE_FALLBACK }
            : update,
        ),
      },
      fallbackApplied: true,
    };
  }

  /** Reconcile mode after a model switch. The caller rebuilds config options
   * before publishing the returned state change. */
  async reconcileForModel(session: SessionMode, model: ModelInfo | undefined) {
    if (
      session.modes.currentModeId !== "auto" ||
      model === undefined ||
      model.supportsAutoMode === true
    ) {
      return false;
    }

    session.modes = {
      availableModes: session.modes.availableModes,
      currentModeId: AUTO_MODE_FALLBACK,
    };
    await this.trySyncMode(
      session.query,
      AUTO_MODE_FALLBACK,
      `Failed to sync permissionMode to "${AUTO_MODE_FALLBACK}" after model switch invalidated "auto":`,
    );
    return true;
  }

  async selectMode(sessionId: string, modeId: string): Promise<PermissionMode> {
    const session = this.requireOpenSession(sessionId);
    const requestedMode = this.parseMode(modeId);
    if (!this.isAvailable(session.modes.availableModes, requestedMode)) {
      throw new Error(`Mode ${modeId} is not available in this session`);
    }

    const effectiveMode = this.effectiveMode(session, requestedMode);
    try {
      await session.query.setPermissionMode(effectiveMode);
    } catch (error) {
      if (error instanceof Error) {
        if (!error.message) error.message = "Invalid Mode";
        throw error;
      }
      // eslint-disable-next-line preserve-caught-error
      throw new Error("Invalid Mode");
    }

    if (effectiveMode !== requestedMode) {
      await this.publishFallbackWarning(sessionId, session);
    }
    return effectiveMode;
  }

  async setSessionMode(params: SetSessionModeRequest): Promise<SetSessionModeResponse> {
    const effectiveMode = await this.selectMode(params.sessionId, params.modeId);
    if (effectiveMode !== params.modeId) {
      await this.publishCurrent(params.sessionId, effectiveMode);
    }
    await this.options.updateConfigOption(params.sessionId, MODE_CONFIG_ID, effectiveMode);
    return {};
  }

  async publishCurrent(sessionId: string, mode: string): Promise<void> {
    await this.options.sessionUpdate({
      sessionId,
      update: { sessionUpdate: "current_mode_update", currentModeId: mode },
    });
  }

  async publishFallbackWarning(sessionId: string, session: SessionMode): Promise<void> {
    session.autoModeFallbackWarningPending = false;
    if (session.autoModeFallbackWarningShown) return;
    session.autoModeFallbackWarningShown = true;
    try {
      await this.options.sessionUpdate({
        sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: AUTO_MODE_FALLBACK_NOTICE },
        },
      });
    } catch (error) {
      // The fallback has already been applied; a failed advisory must not turn
      // the successful mode change into a failed request.
      this.options.logError(`Failed to publish Auto mode fallback warning: ${error}`);
    }
  }

  async publishFallbackState(sessionId: string, session: SessionMode): Promise<void> {
    await this.publishCurrent(sessionId, AUTO_MODE_FALLBACK);
    await this.publishFallbackWarning(sessionId, session);
  }

  private requireOpenSession(sessionId: string): S {
    const session = this.options.getSession(sessionId);
    if (!session) throw new Error("Session not found");
    if (session.queryClosed) {
      throw RequestError.internalError(undefined, this.options.sessionEndedMessage);
    }
    return session;
  }

  private isAutoUnavailable(
    session: SessionMode,
    modelId = session.models.currentModelId,
  ): boolean {
    const modelInfo = session.modelInfos.find((model) => model.value === modelId);
    return modelInfo !== undefined && modelInfo.supportsAutoMode !== true;
  }

  private isAvailable(availableModes: SessionModeState["availableModes"], modeId: string): boolean {
    return availableModes.some((mode) => mode.id === modeId);
  }

  private parseMode(modeId: string): PermissionMode {
    switch (modeId) {
      case "auto":
      case "default":
      case "acceptEdits":
      case "bypassPermissions":
      case "dontAsk":
      case "plan":
        return modeId;
      default:
        throw new Error("Invalid Mode");
    }
  }

  private buildAvailableModes(): SessionModeState["availableModes"] {
    const modes: SessionModeState["availableModes"] = [
      {
        id: "default",
        name: "Manual",
        description: "Always ask before making changes",
        _meta: { kind: "standard" },
      },
      {
        id: "acceptEdits",
        name: "Accept edits",
        description: "Automatically accept all file edits",
        _meta: { kind: "standard" },
      },
      {
        id: "plan",
        name: "Plan",
        description: "Create a plan before making changes",
        _meta: { kind: "plan" },
      },
      {
        id: "auto",
        name: "Auto",
        description: "Claude handles permission decisions",
        _meta: { kind: "auto_review" },
      },
    ];
    if (ALLOW_BYPASS) {
      modes.push({
        id: "bypassPermissions",
        name: "Bypass permissions",
        description: "Accepts all permissions",
        _meta: { kind: "full_access" },
      });
    }
    return modes;
  }

  private async trySyncMode(
    query: Pick<Query, "setPermissionMode">,
    mode: PermissionMode,
    errorMessage: string,
  ): Promise<void> {
    try {
      await query.setPermissionMode(mode);
    } catch (error) {
      this.options.logError(errorMessage, error);
    }
  }
}
