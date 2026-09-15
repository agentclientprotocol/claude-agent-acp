/**
 * Readiness for the async task lifecycle.
 *
 * `AsyncTaskRuntime` publishes background work as `async_task_*` updates, but
 * whether anything can reach that stream depends on the Claude binary the
 * adapter spawned. `claudeCliPath()` resolves either an operator-configured
 * `CLAUDE_CODE_EXECUTABLE` or the platform binary bundled with
 * `@anthropic-ai/claude-agent-sdk`, and a binary that emits no task lifecycle
 * produces an empty stream that a client cannot distinguish from a session in
 * which no background task ever ran. Silence carries two meanings on one
 * channel; this splits them apart.
 *
 * Two independent facts, at the altitudes they actually live at:
 *
 * - **Provenance** is connection-scoped. Which of the two resolution paths
 *   `claudeCliPath()` takes is fixed for the adapter process, so it is
 *   advertised once, on `initialize`. Only the *source* goes on the wire: the
 *   resolved path is an operator's filesystem layout, and nothing else in this
 *   adapter puts it in a protocol frame.
 * - **Readiness** is session-scoped and monotone. It starts `unconfirmed` and
 *   latches to `confirmed` the first time this adapter observes a task
 *   lifecycle event for the session.
 *
 * The latch is worth sending because the adapter observes strictly more
 * lifecycle than the client does: `AsyncTaskRuntime.taskStarted()` marks
 * subagent tasks `ignored` and publishes nothing for them, so a session whose
 * background work is entirely subagents proves the lifecycle is live to the
 * adapter while the client's async-task stream stays empty for its whole
 * lifetime. `confirmed` is the only way that client learns its silence is real.
 *
 * Deliberately not reported: a CLI version. It is knowable without spawning
 * the binary only for the bundled case, and a field that is accurate for one
 * source and a guess for the other is worse than its absence.
 */

/** Whether a task lifecycle event has been observed for a session yet. */
export type AsyncTaskReadiness = "unconfirmed" | "confirmed";

/** Which branch of `claudeCliPath()` this process resolves through. */
export type AsyncTaskCliSource = "configured" | "bundled";

export type AsyncTaskCliProvenance = { source: AsyncTaskCliSource };

/** `initialize` carries provenance; `session_info_update` carries the latch. */
export type AsyncTaskReadinessMeta = {
  readiness?: AsyncTaskReadiness;
  cli?: AsyncTaskCliProvenance;
};

/**
 * Mirrors `claudeCliPath()`'s own branch exactly, including its truthiness
 * test: an empty `CLAUDE_CODE_EXECUTABLE` falls through to the bundled binary
 * there, so it must report `bundled` here. Resolution is deliberately not
 * performed — reporting the source needs no filesystem lookup, so this cannot
 * fail or slow `initialize` down.
 */
export function asyncTaskCliSource(): AsyncTaskCliSource {
  return process.env.CLAUDE_CODE_EXECUTABLE ? "configured" : "bundled";
}

/**
 * Fail-closed reader for clients: anything malformed returns null rather than
 * a partly-trusted snapshot, so a garbled frame can never be read as proof
 * that the lifecycle is live.
 */
export function normalizeAsyncTaskReadiness(value: unknown): AsyncTaskReadinessMeta | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const result: AsyncTaskReadinessMeta = {};
  if (raw.readiness !== undefined) {
    if (raw.readiness !== "unconfirmed" && raw.readiness !== "confirmed") return null;
    result.readiness = raw.readiness;
  }
  if (raw.cli !== undefined) {
    if (typeof raw.cli !== "object" || raw.cli === null || Array.isArray(raw.cli)) return null;
    const source = (raw.cli as Record<string, unknown>).source;
    if (source !== "configured" && source !== "bundled") return null;
    result.cli = { source };
  }
  return result.readiness === undefined && result.cli === undefined ? null : result;
}
