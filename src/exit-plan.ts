import type { SessionNotification } from "@agentclientprotocol/sdk";
import type { SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  type ClearContextCoordinatorHost,
  type ClearContextReset,
  type ClearContextSession,
  type ClearContextTurn,
  continuePlanInFreshContext,
} from "./clear-context-coordinator.js";

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

export function containsToolResultFor(content: unknown, toolUseId: string): boolean {
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
> = ClearContextCoordinatorHost<Session, Turn> & {
  destroyReplacement(sessionId: string, session: Session): void;
  settleCancelledTurn(oldSession: Session, turnSession: Session, turn: Turn): void;
};

/** Owns the lifetime of accepted-plan context replacements. In particular, a
 * session cancellation invalidates an in-progress async restart so a late
 * restartSession result cannot recreate a closed public session. */
export class ExitPlanCoordinator<
  Session extends ClearContextSession<Turn>,
  Turn extends ClearContextTurn,
> {
  private readonly restarts = new Map<string, AbortController>();

  cancel(sessionId: string): void {
    this.restarts.get(sessionId)?.abort();
  }

  async restart(
    sessionId: string,
    oldSession: Session,
    reset: ClearContextReset,
    host: ExitPlanRestartHost<Session, Turn>,
  ): Promise<void> {
    this.cancel(sessionId);
    const controller = new AbortController();
    this.restarts.set(sessionId, controller);
    try {
      await continuePlanInFreshContext(sessionId, oldSession, reset, host, controller.signal);
    } catch (error) {
      if (!controller.signal.aborted) throw error;

      const currentSession = host.currentSession(sessionId);
      const replacement = currentSession !== oldSession ? currentSession : undefined;
      if (replacement) host.destroyReplacement(sessionId, replacement);

      const turn = replacement?.activeTurn ?? oldSession.activeTurn;
      if (turn && !turn.settled) {
        const turnSession = replacement?.activeTurn === turn ? replacement : oldSession;
        host.settleCancelledTurn(oldSession, turnSession, turn);
        oldSession.activeTurn = null;
        oldSession.turnQueue = (oldSession.turnQueue ?? []).filter((queued) => queued !== turn);
        if (replacement) {
          replacement.activeTurn = null;
          replacement.turnQueue = (replacement.turnQueue ?? []).filter((queued) => queued !== turn);
        }
      }
    } finally {
      if (this.restarts.get(sessionId) === controller) {
        this.restarts.delete(sessionId);
      }
    }
  }
}
