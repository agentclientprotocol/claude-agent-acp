/**
 * How Claude Code's `result` ends the work that it reports, and whether that
 * work was the user's turn or a cycle Claude Code started on its own: the
 * rules that both cores read a turn's result with (the v1 prompt loop in
 * `v1/acp-agent.ts` and `v2/`). Each core adds its own side effects, such as v1's
 * session failure category.
 */
import type {
  SDKMessage,
  SDKMessageOrigin,
  SDKResultMessage,
} from "@anthropic-ai/claude-agent-sdk";

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

/** Result-message origin kinds that mark an AUTONOMOUS cycle — work the
 *  model did on its own (a task-notification followup, a peer/coordinator/
 *  observer message it handled) rather than the user's prompt. Absent,
 *  `human`, and `channel` origins are the user's own turn (this adapter's
 *  prompts arrive as the ACP channel on some CLI configurations — ALL
 *  channel servers are treated as user, so a foreign channel integration's
 *  autonomously-handled result is misclassified as the user's; accepted,
 *  see below), and `auto-continuation` continues the user's turn, so its
 *  result is the turn's real terminal.
 *
 *  Deliberately fail-OPEN: an unknown future kind defaults to the user
 *  lane — including `unclassified` (SDK 0.3.232+), the CLI's own "couldn't
 *  attribute this" marker, which gets the same safe default. Misrouting a
 *  USER result into the autonomous lane hangs the prompt un-detectably
 *  (the result is skipped, its trailing idle absorbed as owed, so the
 *  #825 detector can't fire); misrouting an autonomous result into the
 *  user lane is the bounded misattribution class this set exists to
 *  reduce.
 *
 *  Exception: a result from one of these origins that names a pending prompt
 *  in `user_message_uuids` consumed that folded prompt and takes the user
 *  lane (see the result handler of each core). */
export const AUTONOMOUS_RESULT_ORIGINS: ReadonlySet<SDKMessageOrigin["kind"]> = new Set([
  "task-notification",
  "peer",
  "coordinator",
  "observer",
  "observer-activity",
]);

/** Whether Claude Code ended the work of `result` because an interrupt
 *  stopped it, while the model streamed or while a tool ran. */
export function isAbortedResult(result: Extract<SDKMessage, { type: "result" }>): boolean {
  return (
    result.terminal_reason === "aborted_streaming" || result.terminal_reason === "aborted_tools"
  );
}
