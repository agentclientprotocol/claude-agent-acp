import type {
  ModelUsage,
  SDKMessageOrigin,
  SDKResultMessage,
} from "@anthropic-ai/claude-agent-sdk";

export const ACCOUNTING_USAGE_METHOD = "_claude/accountingUsage";
export const ACCOUNTING_USAGE_VERSION = 1;

export type AccountingUsageScope = "user_turn" | "autonomous";

export type AccountingTokenUsage = {
  inputTokens: number;
  outputTokens: number;
  cachedReadTokens: number;
  cachedWriteTokens: number;
  totalTokens: number;
};

export type AccountingUsageNotification = {
  sessionId: string;
  version: 1;
  resultId: string;
  resultSubtype: SDKResultMessage["subtype"];
  isError: boolean;
  scope: AccountingUsageScope;
  origin?: SDKMessageOrigin;
  source: "model_usage_delta" | "result_usage_fallback";
  snapshotReset: boolean;
  usage: AccountingTokenUsage;
  resultUsage: AccountingTokenUsage;
  modelUsage: Record<string, ModelUsage>;
  modelUsageSemantics: "sdk_session_cumulative_snapshot";
};

export type AccountingUsageState = {
  previousModelUsageTotals: AccountingTokenUsage | null;
  /** Fallback tokens already emitted but not yet observed in a valid cumulative snapshot. */
  unreconciledFallbackUsage: AccountingTokenUsage;
  emittedResultIds: Set<string>;
};

/** Normalizes provider counters so malformed optional values never propagate as NaN. */
function token(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

/** Adds the derived total without dropping any cache bucket. */
function withTotal(usage: Omit<AccountingTokenUsage, "totalTokens">): AccountingTokenUsage {
  return {
    ...usage,
    totalTokens:
      usage.inputTokens + usage.outputTokens + usage.cachedReadTokens + usage.cachedWriteTokens,
  };
}

/** Creates an empty four-bucket usage value for state initialization and reconciliation. */
function zeroUsage(): AccountingTokenUsage {
  return withTotal({
    inputTokens: 0,
    outputTokens: 0,
    cachedReadTokens: 0,
    cachedWriteTokens: 0,
  });
}

/** Adds two usage values while deriving the total from their four provider buckets. */
function addUsage(left: AccountingTokenUsage, right: AccountingTokenUsage): AccountingTokenUsage {
  return withTotal({
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    cachedReadTokens: left.cachedReadTokens + right.cachedReadTokens,
    cachedWriteTokens: left.cachedWriteTokens + right.cachedWriteTokens,
  });
}

/** Checks whether one model row can participate in an authoritative aggregate snapshot. */
function isValidModelUsage(value: unknown): value is ModelUsage {
  if (typeof value !== "object" || value === null) return false;
  const row = value as Record<string, unknown>;
  return [
    row.inputTokens,
    row.outputTokens,
    row.cacheReadInputTokens,
    row.cacheCreationInputTokens,
  ].every((counter) => typeof counter === "number" && Number.isFinite(counter) && counter >= 0);
}

/** Normalizes the per-result SDK usage used for auditing and fallback events. */
function resultTokenUsage(result: SDKResultMessage): AccountingTokenUsage {
  const usage = result.usage as unknown as Record<string, unknown>;
  return withTotal({
    inputTokens: token(usage.input_tokens),
    outputTokens: token(usage.output_tokens),
    cachedReadTokens: token(usage.cache_read_input_tokens),
    cachedWriteTokens: token(usage.cache_creation_input_tokens),
  });
}

/** Aggregates model rows before differencing so model key changes cannot alter accounting. */
function aggregateModelUsage(modelUsage: Record<string, ModelUsage>): AccountingTokenUsage | null {
  const rows = Object.values(modelUsage);
  if (rows.length === 0 || !rows.every(isValidModelUsage)) return null;

  return withTotal(
    rows.reduce(
      (sum, row) => ({
        inputTokens: sum.inputTokens + token(row.inputTokens),
        outputTokens: sum.outputTokens + token(row.outputTokens),
        cachedReadTokens: sum.cachedReadTokens + token(row.cacheReadInputTokens),
        cachedWriteTokens: sum.cachedWriteTokens + token(row.cacheCreationInputTokens),
      }),
      { inputTokens: 0, outputTokens: 0, cachedReadTokens: 0, cachedWriteTokens: 0 },
    ),
  );
}

/**
 * Removes fallback tokens that were already emitted from the next monotonic provider delta.
 * A reset starts a new accounting epoch, so fallback debt from the prior epoch is cleared.
 */
function reconcileFallbackUsage(
  delta: { usage: AccountingTokenUsage; snapshotReset: boolean },
  pending: AccountingTokenUsage,
): { usage: AccountingTokenUsage; remaining: AccountingTokenUsage } {
  if (delta.snapshotReset) return { usage: delta.usage, remaining: zeroUsage() };

  const applied = {
    inputTokens: Math.min(delta.usage.inputTokens, pending.inputTokens),
    outputTokens: Math.min(delta.usage.outputTokens, pending.outputTokens),
    cachedReadTokens: Math.min(delta.usage.cachedReadTokens, pending.cachedReadTokens),
    cachedWriteTokens: Math.min(delta.usage.cachedWriteTokens, pending.cachedWriteTokens),
  };
  return {
    usage: withTotal({
      inputTokens: delta.usage.inputTokens - applied.inputTokens,
      outputTokens: delta.usage.outputTokens - applied.outputTokens,
      cachedReadTokens: delta.usage.cachedReadTokens - applied.cachedReadTokens,
      cachedWriteTokens: delta.usage.cachedWriteTokens - applied.cachedWriteTokens,
    }),
    remaining: withTotal({
      inputTokens: pending.inputTokens - applied.inputTokens,
      outputTokens: pending.outputTokens - applied.outputTokens,
      cachedReadTokens: pending.cachedReadTokens - applied.cachedReadTokens,
      cachedWriteTokens: pending.cachedWriteTokens - applied.cachedWriteTokens,
    }),
  };
}

/** Computes one additive delta and explicitly marks any cumulative snapshot reset. */
function diffSnapshot(
  current: AccountingTokenUsage,
  previous: AccountingTokenUsage | null,
): { usage: AccountingTokenUsage; snapshotReset: boolean } {
  if (previous === null) return { usage: current, snapshotReset: false };

  const snapshotReset =
    current.inputTokens < previous.inputTokens ||
    current.outputTokens < previous.outputTokens ||
    current.cachedReadTokens < previous.cachedReadTokens ||
    current.cachedWriteTokens < previous.cachedWriteTokens;
  if (snapshotReset) return { usage: current, snapshotReset: true };

  return {
    usage: withTotal({
      inputTokens: current.inputTokens - previous.inputTokens,
      outputTokens: current.outputTokens - previous.outputTokens,
      cachedReadTokens: current.cachedReadTokens - previous.cachedReadTokens,
      cachedWriteTokens: current.cachedWriteTokens - previous.cachedWriteTokens,
    }),
    snapshotReset: false,
  };
}

/** Creates isolated accounting state for one SDK query process. */
export function createAccountingUsageState(): AccountingUsageState {
  return {
    previousModelUsageTotals: null,
    unreconciledFallbackUsage: zeroUsage(),
    emittedResultIds: new Set(),
  };
}

/** Converts one SDK result into an at-most-once accounting event. */
export function recordAccountingResult(
  state: AccountingUsageState,
  sessionId: string,
  result: SDKResultMessage,
  scope: AccountingUsageScope,
): AccountingUsageNotification | null {
  if (state.emittedResultIds.has(result.uuid)) return null;
  state.emittedResultIds.add(result.uuid);

  const resultUsage = resultTokenUsage(result);
  const modelUsage =
    typeof result.modelUsage === "object" && result.modelUsage !== null ? result.modelUsage : {};
  const currentSnapshot = aggregateModelUsage(modelUsage);
  const delta = currentSnapshot
    ? diffSnapshot(currentSnapshot, state.previousModelUsageTotals)
    : { usage: resultUsage, snapshotReset: false };

  let accountingUsage = delta.usage;
  if (currentSnapshot) {
    const reconciled = reconcileFallbackUsage(delta, state.unreconciledFallbackUsage);
    accountingUsage = reconciled.usage;
    state.unreconciledFallbackUsage = reconciled.remaining;
    state.previousModelUsageTotals = currentSnapshot;
  } else {
    state.unreconciledFallbackUsage = addUsage(state.unreconciledFallbackUsage, resultUsage);
  }

  return {
    sessionId,
    version: ACCOUNTING_USAGE_VERSION,
    resultId: result.uuid,
    resultSubtype: result.subtype,
    isError: result.is_error,
    scope,
    ...(result.origin ? { origin: result.origin } : {}),
    source: currentSnapshot ? "model_usage_delta" : "result_usage_fallback",
    snapshotReset: delta.snapshotReset,
    usage: accountingUsage,
    resultUsage,
    modelUsage,
    modelUsageSemantics: "sdk_session_cumulative_snapshot",
  };
}
