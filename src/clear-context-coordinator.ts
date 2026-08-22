import type { NewSessionRequest, SessionConfigOption } from "@agentclientprotocol/sdk";
import type {
  EffortLevel,
  Options,
  PermissionMode,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { DEFAULT_AGENT_ID, DEFAULT_MODEL_ID, EFFORT_CONFIG_ID } from "./session-config-ids.js";

export type ClearContextReset = {
  toolUseId: string;
  plan: string;
  mode: PermissionMode;
};

type Usage = {
  inputTokens: number;
  outputTokens: number;
  cachedReadTokens: number;
  cachedWriteTokens: number;
};

export type ClearContextTurn = {
  settled: boolean;
  promptUuid: string;
  carriedUsage?: Usage;
};

/** The session state needed to replace Claude's private conversation without
 * replacing the public ACP turn. Keeping this projection here makes the
 * restart workflow independent from the agent's much larger Session record. */
export type ClearContextSession<Turn extends ClearContextTurn = ClearContextTurn> = {
  cwd: string;
  creationParams?: NewSessionRequest;
  accumulatedUsage: Usage;
  models: { currentModelId: string };
  configOptions: SessionConfigOption[];
  currentAgent: string;
  fastModeEnabled: boolean;
  activeTurn?: Turn | null;
  turnQueue?: Turn[];
  pendingExitPlanContextReset?: ClearContextReset;
  contextUsedTokens?: number;
  input: { push(message: SDKUserMessage): unknown };
};

export type ClearContextCoordinatorHost<
  Session extends ClearContextSession<Turn>,
  Turn extends ClearContextTurn,
> = {
  currentSession(sessionId: string): Session | undefined;
  closeQueryStream(session: Session): void;
  restartSession(
    params: NewSessionRequest,
    options: { publicSessionId: string; permissionMode: PermissionMode },
  ): Promise<Session>;
  applyFastMode(session: Session, enabled: boolean): Promise<void>;
  publishSessionState(
    sessionId: string,
    mode: PermissionMode,
    configOptions: SessionConfigOption[],
  ): Promise<void>;
  continuationMessage(sessionId: string, plan: string, promptUuid: string): SDKUserMessage;
  ensureConsumer(session: Session, sessionId: string): void;
  logError(message: string, error: unknown): void;
};

function restartParams<Session extends ClearContextSession>(session: Session): NewSessionRequest {
  const originalParams = session.creationParams ?? { cwd: session.cwd, mcpServers: [] };
  const currentEffort = session.configOptions.find(
    (option) => option.id === EFFORT_CONFIG_ID,
  )?.currentValue;
  const originalMeta = originalParams._meta as
    ({ claudeCode?: { options?: Options } } & Record<string, unknown>) | undefined;
  const originalOptions = originalMeta?.claudeCode?.options;
  const unmanagedOptions = { ...(originalOptions ?? {}) };
  delete unmanagedOptions.model;
  delete unmanagedOptions.agent;
  delete unmanagedOptions.effort;

  return {
    ...originalParams,
    _meta: {
      ...(originalMeta ?? {}),
      claudeCode: {
        ...(originalMeta?.claudeCode ?? {}),
        options: {
          ...unmanagedOptions,
          ...(session.models.currentModelId !== DEFAULT_MODEL_ID
            ? { model: session.models.currentModelId }
            : {}),
          ...(session.currentAgent !== DEFAULT_AGENT_ID ? { agent: session.currentAgent } : {}),
          ...(typeof currentEffort === "string" && currentEffort !== "default"
            ? { effort: currentEffort as EffortLevel }
            : {}),
        },
      },
    },
  };
}

/** Replace Claude's private conversation and attach the still-pending ACP turn
 * to it. The host owns provider-specific creation and stream mechanics; this
 * coordinator owns the ordering and state transfer invariants. */
export async function continuePlanInFreshContext<
  Turn extends ClearContextTurn,
  Session extends ClearContextSession<Turn>,
>(
  sessionId: string,
  oldSession: Session,
  reset: ClearContextReset,
  host: ClearContextCoordinatorHost<Session, Turn>,
  signal?: AbortSignal,
): Promise<void> {
  const assertRestartActive = (session?: Session): void => {
    if (signal?.aborted || (session && host.currentSession(sessionId) !== session)) {
      throw new Error("Clear-context restart aborted");
    }
  };
  assertRestartActive();
  const turn = oldSession.activeTurn;
  if (!turn || turn.settled || host.currentSession(sessionId) !== oldSession) {
    throw new Error("Cannot clear context without an active ACP turn");
  }

  const params = restartParams(oldSession);
  host.closeQueryStream(oldSession);

  const freshSession = await host.restartSession(params, {
    publicSessionId: sessionId,
    permissionMode: reset.mode,
  });
  assertRestartActive(freshSession);

  // Do not consume the reset or mutate the turn until a replacement exists.
  // A failed restart must remain distinguishable from a lost query transport.
  turn.carriedUsage = { ...oldSession.accumulatedUsage };
  oldSession.pendingExitPlanContextReset = undefined;
  if (oldSession.fastModeEnabled !== freshSession.fastModeEnabled) {
    try {
      await host.applyFastMode(freshSession, oldSession.fastModeEnabled);
    } catch (error) {
      host.logError("Failed to restore Fast mode after clearing context:", error);
    }
    assertRestartActive(freshSession);
  }

  oldSession.activeTurn = null;
  oldSession.turnQueue = [];
  freshSession.turnQueue = [turn];
  freshSession.contextUsedTokens = 0;

  try {
    await host.publishSessionState(sessionId, reset.mode, freshSession.configOptions);
  } catch (error) {
    host.logError("Failed to publish clear-context session state:", error);
  }
  assertRestartActive(freshSession);

  freshSession.input.push(host.continuationMessage(sessionId, reset.plan, turn.promptUuid));
  assertRestartActive(freshSession);
  host.ensureConsumer(freshSession, sessionId);
}
