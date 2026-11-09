/**
 * How Claude Code's `result` ends the work that it reports: the rules that the
 * ACP v2 core reads every turn's result with (`v2/outcome.ts`).
 */
import type { SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";

export type ResultEnd =
  | { stopReason: "refusal" | "max_tokens" | "end_turn" | "max_turn_requests" }
  /** The result failed the work, with Claude Code's error text. */
  | { error: string };

/**
 * A refusal and the token limit are their stop reasons, also on an error
 * result. Otherwise an error result fails the work. A result that is no
 * error ends the turn, or, at a turn or budget limit, `max_turn_requests`.
 */
export function resultEnd(result: SDKResultMessage): ResultEnd {
  if (result.stop_reason === "refusal") return { stopReason: "refusal" };
  if (result.stop_reason === "max_tokens") return { stopReason: "max_tokens" };
  if (result.is_error) {
    return {
      error:
        result.subtype === "success" ? result.result : result.errors.join(", ") || result.subtype,
    };
  }
  return {
    stopReason:
      result.subtype === "success" || result.subtype === "error_during_execution"
        ? "end_turn"
        : "max_turn_requests",
  };
}
