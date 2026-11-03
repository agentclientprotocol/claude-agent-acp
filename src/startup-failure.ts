import { RequestError } from "@agentclientprotocol/sdk/unstable";
import type { SDKStartupFailureReason } from "@anthropic-ai/claude-agent-sdk";

/** Makes the CLI write an `error_during_execution` result with a
 *  `startup_failure_reason` before it exits on a known startup failure. Without
 *  it, some failures (e.g. `proxy_invalid`) end with stderr and an exit code
 *  alone. The SDK then rejects `initializationResult()` with an error that
 *  carries the reason as `startupFailureReason`. */
export const STARTUP_FAILURE_RESULTS_ENV = { CLAUDE_CODE_STARTUP_FAILURE_RESULTS: "1" };

/** The SDK's prefix on the message of an error built from an error result. */
const ERROR_RESULT_PREFIX = "Claude Code returned an error result: ";

/** Reasons that signing in again, or with another account, can fix. */
const AUTH_REQUIRED_REASONS: ReadonlySet<SDKStartupFailureReason> = new Set([
  "gateway_signin_required",
  "org_pin_mismatch",
  "org_config_refused",
]);

/** The ACP error for a CLI that refused to start, or `undefined` when `error`
 *  carries no `startupFailureReason` (older CLIs, failures without a known
 *  cause). The message is the CLI's own, which says what to fix, e.g.
 *  `Invalid proxy URL in HTTPS_PROXY: … Fix or unset HTTPS_PROXY and restart
 *  Claude Code.`; `data.startupFailureReason` carries the reason. */
export function startupFailureError(error: unknown): RequestError | undefined {
  if (!(error instanceof Error)) return undefined;
  const reason = (error as { startupFailureReason?: unknown }).startupFailureReason;
  if (typeof reason !== "string" || reason === "") return undefined;

  const message = error.message.startsWith(ERROR_RESULT_PREFIX)
    ? error.message.slice(ERROR_RESULT_PREFIX.length)
    : error.message;
  const data = { startupFailureReason: reason };
  if (AUTH_REQUIRED_REASONS.has(reason as SDKStartupFailureReason)) {
    return RequestError.authRequired(data, message);
  }
  if (reason === "cwd_unavailable") {
    return RequestError.invalidParams(data, message);
  }
  return RequestError.internalError(data, message);
}
