import type { SessionNotification } from "@agentclientprotocol/sdk";
import type { SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  type ClearContextCoordinatorHost,
  type ClearContextReset,
  type ClearContextSession,
  type ClearContextTurn,
  continuePlanInFreshContext,
} from "./clear-context-coordinator.js";
import { parseToolResultMeta } from "./tool-result-meta.js";

export function acceptedPlanToolResult(
  notification: SessionNotification,
  toolUseId: string | undefined,
): SessionNotification {
  const update = notification.update;
  if (
    !toolUseId ||
    update.sessionUpdate !== "tool_call_update" ||
    update.toolCallId !== toolUseId
  ) {
    return notification;
  }
  const completed = { ...update };
  delete completed.rawOutput;
  delete completed.content;
  return { ...notification, update: { ...completed, status: "completed" } };
}

function containsToolResultFor(content: unknown, toolUseId: string): boolean {
  return (
    Array.isArray(content) &&
    content.some(
      (block) =>
        typeof block === "object" &&
        block !== null &&
        (block as { type?: unknown }).type === "tool_result" &&
        (block as { tool_use_id?: unknown }).tool_use_id === toolUseId,
    )
  );
}

type ExitPlanState = {
  toolUseCache: Record<string, { name: string } | undefined>;
  pendingExitPlanModeInterruption?: { toolUseId: string; toolResultSeen: boolean };
  pendingExitPlanContextReset?: ClearContextReset;
};

function rejectedExitPlanToolUseId(
  content: unknown,
  toolUseCache: ExitPlanState["toolUseCache"],
  rawToolResultMeta: unknown,
): string | undefined {
  if (!Array.isArray(content)) return undefined;
  const toolResultMeta = parseToolResultMeta(rawToolResultMeta);
  if (!toolResultMeta) return undefined;
  for (const block of content) {
    if (typeof block !== "object" || block === null) continue;
    const { type, tool_use_id: toolUseId, is_error: isError } = block as Record<string, unknown>;
    if (
      type === "tool_result" &&
      typeof toolUseId === "string" &&
      isError === true &&
      toolResultMeta.get(toolUseId)?.nonExecutionKind === "user-rejected" &&
      toolUseCache[toolUseId]?.name === "ExitPlanMode"
    ) {
      return toolUseId;
    }
  }
  return undefined;
}

/** Reconcile an SDK user message with the two pending ExitPlanMode lanes and
 * return the accepted plan tool id whose rendered update must be completed. */
export function observeExitPlanToolResults(
  message: { type: string; tool_result_meta?: unknown },
  content: unknown,
  state: ExitPlanState,
): string | undefined {
  if (message.type !== "user") return undefined;

  const rejectedToolUseId = rejectedExitPlanToolUseId(
    content,
    state.toolUseCache,
    message.tool_result_meta,
  );
  if (rejectedToolUseId) {
    // The stream is authoritative: resumed queries can lose the short-lived
    // marker installed by canUseTool, while metadata preserves correlation.
    state.pendingExitPlanModeInterruption = {
      toolUseId: rejectedToolUseId,
      toolResultSeen: true,
    };
  }

  const pendingInterruption = state.pendingExitPlanModeInterruption;
  if (pendingInterruption && containsToolResultFor(content, pendingInterruption.toolUseId)) {
    pendingInterruption.toolResultSeen = true;
  }

  const pendingReset = state.pendingExitPlanContextReset;
  return pendingReset && containsToolResultFor(content, pendingReset.toolUseId)
    ? pendingReset.toolUseId
    : undefined;
}

export function executionDiagnostic(message: SDKResultMessage): string | undefined {
  if (message.subtype === "success") {
    return message.result.startsWith("[ede_diagnostic]") ? message.result : undefined;
  }
  return message.errors.find((error) => error.startsWith("[ede_diagnostic]"));
}

/** Claude wraps a rejected ExitPlanMode explanation in a Markdown code fence.
 * Strip exactly one complete outer fence for that tool only. */
export function exitPlanModeRawOutput(toolName: string, content: unknown): unknown {
  if (toolName !== "ExitPlanMode" || typeof content !== "string") {
    return content;
  }
  const fenced = /^\s*```[^\r\n]*\r?\n([\s\S]*?)\r?\n```\s*$/.exec(content);
  return fenced?.[1] ?? content;
}

export type ExitPlanRestartHost<
  Session extends ClearContextSession<Turn>,
  Turn extends ClearContextTurn,
> = Omit<
  ClearContextCoordinatorHost<Session, Turn>,
  "publishSessionState" | "continuationMessage"
> & {
  sessionUpdate(notification: SessionNotification): Promise<void>;
  destroyReplacement(sessionId: string, session: Session): void;
  settleCancelledTurn(oldSession: Session, turnSession: Session, turn: Turn): void;
  settleFailedTurn(turnSession: Session, turn: Turn, error: unknown): void;
};

/** Owns the lifetime of accepted-plan context replacements. In particular, a
 * session cancellation invalidates an in-progress async restart so a late
 * restartSession result cannot recreate a closed public session. */
export class ExitPlanCoordinator<
  Session extends ClearContextSession<Turn>,
  Turn extends ClearContextTurn,
> {
  private readonly restarts = new Map<string, AbortController>();

  constructor(private readonly host: ExitPlanRestartHost<Session, Turn>) {}

  cancel(sessionId: string): void {
    this.restarts.get(sessionId)?.abort();
  }

  async restart(sessionId: string, oldSession: Session, reset: ClearContextReset): Promise<void> {
    this.cancel(sessionId);
    const controller = new AbortController();
    this.restarts.set(sessionId, controller);
    try {
      const clearContextHost: ClearContextCoordinatorHost<Session, Turn> = {
        ...this.host,
        publishSessionState: async (id, mode, configOptions) => {
          await this.host.sessionUpdate({
            sessionId: id,
            update: { sessionUpdate: "current_mode_update", currentModeId: mode },
          });
          await this.host.sessionUpdate({
            sessionId: id,
            update: { sessionUpdate: "config_option_update", configOptions },
          });
        },
        continuationMessage: (id, plan, promptUuid) => ({
          type: "user",
          message: {
            role: "user",
            content: [{ type: "text", text: `Implement the following plan:\n\n${plan}` }],
          },
          session_id: id,
          parent_tool_use_id: null,
          origin: { kind: "human" },
          uuid: promptUuid as `${string}-${string}-${string}-${string}-${string}`,
        }),
      };
      await continuePlanInFreshContext(
        sessionId,
        oldSession,
        reset,
        clearContextHost,
        controller.signal,
      );
    } catch (error) {
      const currentSession = this.host.currentSession(sessionId);
      const replacement = currentSession !== oldSession ? currentSession : undefined;
      if (replacement) this.host.destroyReplacement(sessionId, replacement);

      const turn = replacement?.activeTurn ?? oldSession.activeTurn;
      if (turn && !turn.settled) {
        const turnSession = replacement?.activeTurn === turn ? replacement : oldSession;
        if (controller.signal.aborted) {
          this.host.settleCancelledTurn(oldSession, turnSession, turn);
        } else {
          // A provider/session-creation failure is turn-scoped. Settling it
          // here keeps it out of the query consumer's transport-loss catch.
          this.host.settleFailedTurn(turnSession, turn, error);
        }
        oldSession.activeTurn = null;
        oldSession.turnQueue = (oldSession.turnQueue ?? []).filter((queued) => queued !== turn);
        if (replacement) {
          replacement.activeTurn = null;
          replacement.turnQueue = (replacement.turnQueue ?? []).filter((queued) => queued !== turn);
        }
      }
      oldSession.pendingExitPlanContextReset = undefined;
    } finally {
      if (this.restarts.get(sessionId) === controller) {
        this.restarts.delete(sessionId);
      }
    }
  }
}
