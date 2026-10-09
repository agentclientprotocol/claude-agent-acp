export type ToolResultMeta = {
  nonExecutionKind: string;
  userFeedback?: string;
};

/**
 * Whether Claude Code stamped the result because the tool's run was aborted:
 * `interrupted` when the turn was interrupted, `cancelled` when the call's own
 * run was stopped, for example as it moved to the background. The other kinds
 * (`user-rejected`, `permission-rule`, `automode-*`) mean the tool was refused.
 */
export function isAbortedToolResult(meta: ToolResultMeta | undefined): boolean {
  return meta?.nonExecutionKind === "interrupted" || meta?.nonExecutionKind === "cancelled";
}

/** Validate the SDK's currently untyped tool_result_meta sidecar. Unknown
 * non-execution kinds are preserved so newer CLIs remain forward-compatible. */
export function parseToolResultMeta(raw: unknown): Map<string, ToolResultMeta> | undefined {
  if (!Array.isArray(raw)) return undefined;

  let byToolUseId: Map<string, ToolResultMeta> | undefined;
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) continue;
    const { id, non_execution_kind, user_feedback } = entry as Record<string, unknown>;
    if (typeof id !== "string" || typeof non_execution_kind !== "string") continue;
    (byToolUseId ??= new Map()).set(id, {
      nonExecutionKind: non_execution_kind,
      ...(typeof user_feedback === "string" ? { userFeedback: user_feedback } : {}),
    });
  }
  return byToolUseId;
}
