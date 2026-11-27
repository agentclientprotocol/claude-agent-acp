import { RequestError } from "@agentclientprotocol/sdk/unstable";
import type {
  SDKSettingsParseError,
  SDKStartupFailureReason,
} from "@anthropic-ai/claude-agent-sdk";

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

/** The reason that {@link startupFailureError} put into `error`, if it made `error`. */
export function startupFailureReasonOf(error: unknown): string | undefined {
  if (!(error instanceof RequestError)) return undefined;
  const reason = (error.data as { startupFailureReason?: unknown } | undefined)
    ?.startupFailureReason;
  return typeof reason === "string" ? reason : undefined;
}

/** The ACP error for a session whose settings files the CLI skipped, or
 *  `undefined` for an empty list. A skipped file's permission rules, sandbox
 *  and hooks do not apply, so the session does not start. E.g. `Claude Code
 *  skipped the invalid settings file /home/u/.claude/settings.json (Invalid or
 *  malformed JSON), so its permission rules, sandbox settings and hooks would
 *  not apply. Fix the file and start the session again.` */
export function invalidSettingsError(errors: SDKSettingsParseError[]): RequestError | undefined {
  if (errors.length === 0) return undefined;
  const skipped = errors.map((error) => {
    const field = error.path === "" ? "" : `${error.path}: `;
    const file =
      error.file === undefined
        ? "an invalid settings file"
        : `the invalid settings file ${error.file}`;
    return `${file} (${field}${error.message})`;
  });
  const many = errors.length > 1;
  const message =
    `Claude Code skipped ${skipped.join("; ")}, so ${many ? "their" : "its"} permission rules, ` +
    `sandbox settings and hooks would not apply. Fix the ${many ? "files" : "file"} ` +
    `and start the session again.`;
  return RequestError.internalError({ settingsErrors: errors }, message);
}
