/**
 * How Claude Code's `result` ends the work that it reports: the rules that
 * both cores read a turn's result with (the v1 prompt loop in `acp-agent.ts`
 * and `v2/outcome.ts`). Each core adds its own side effects, such as v1's
 * session failure category.
 */
import type { SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";

export type ResultEnd =
  | { stopReason: "refusal" | "max_tokens" | "end_turn" | "max_turn_requests" }
  /**
   * The result failed the work, with Claude Code's error text. `loginRequired`:
   * the text of a `success` result tells the user to run `/login`.
   */
  | { error: string; loginRequired: boolean };

/**
 * True when CLI error text tells the user to sign in with `/login`. The CLI
 * words this several ways — "Not logged in · Please run /login", "Not logged
 * in · Run /login", "Login expired · Run /login to sign in again, or
 * re-authenticate your Anthropic profile" — so match the "run /login"
 * instruction rather than one sentence.
 */
export function isLoginRequiredText(text: string): boolean {
  return /\brun \/login\b/i.test(text);
}

/**
 * - Any subtype with `stop_reason: "refusal"`: `refusal`, also on an error.
 * - `success`: an error with the `/login` text fails the work, then
 *   `stop_reason: "max_tokens"` is `max_tokens`, then any other error fails
 *   the work. Otherwise `end_turn`.
 * - `error_during_execution`: `max_tokens` as for `success`, then an error
 *   fails the work. Otherwise `end_turn`.
 * - `error_max_turns`, `error_max_budget_usd` and
 *   `error_max_structured_output_retries`: an error fails the work, whatever
 *   the stop reason. Otherwise `max_turn_requests`.
 */
export function resultEnd(result: SDKResultMessage): ResultEnd {
  if (result.stop_reason === "refusal") return { stopReason: "refusal" };
  switch (result.subtype) {
    case "success":
      if (result.is_error && isLoginRequiredText(result.result)) {
        return { error: result.result, loginRequired: true };
      }
      if (result.stop_reason === "max_tokens") return { stopReason: "max_tokens" };
      if (result.is_error) return { error: result.result, loginRequired: false };
      return { stopReason: "end_turn" };
    case "error_during_execution":
      if (result.stop_reason === "max_tokens") return { stopReason: "max_tokens" };
      if (result.is_error) return failed(result);
      return { stopReason: "end_turn" };
    default:
      // `error_max_turns`, `error_max_budget_usd`, `error_max_structured_output_retries`.
      if (result.is_error) return failed(result);
      return { stopReason: "max_turn_requests" };
  }
}

function failed(result: Exclude<SDKResultMessage, { subtype: "success" }>): ResultEnd {
  return { error: result.errors.join(", ") || result.subtype, loginRequired: false };
}
