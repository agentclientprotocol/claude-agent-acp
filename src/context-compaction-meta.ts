import { AIR_CONTEXT_COMPACTION_KEY, withAirMeta } from "./air-extension.js";

export const CONTEXT_COMPACTION_META_VERSION = 1;

export type ContextCompactionTrigger = "manual" | "automatic";

export interface ContextCompactionMetadata {
  version: typeof CONTEXT_COMPACTION_META_VERSION;
  trigger?: ContextCompactionTrigger;
  preTokens?: number;
  postTokens?: number;
  durationMs?: number;
  error?: string;
}

/**
 * The `_meta` of a context compaction report:
 * `_meta.jetbrains.air.contextCompaction`, as `docs/air-extensions.md`
 * defines. The standard toolCallId and status fields own lifecycle identity
 * and phase; this extension carries only compaction-specific facts. Only AIR
 * gets it.
 */
export function createContextCompactionMeta(
  metadata: Omit<ContextCompactionMetadata, "version"> = {},
): Record<string, unknown> {
  return withAirMeta(undefined, AIR_CONTEXT_COMPACTION_KEY, {
    version: CONTEXT_COMPACTION_META_VERSION,
    ...metadata,
  } satisfies ContextCompactionMetadata);
}
