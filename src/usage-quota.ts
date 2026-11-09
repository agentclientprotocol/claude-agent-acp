/**
 * Token usage of Claude Code results, and the `_meta.quota` breakdown that a
 * turn's end reports, shared by the v1 core and the native ACP v2 core.
 */
import type { ModelUsage } from "@anthropic-ai/claude-agent-sdk";

export type AccumulatedUsage = {
  inputTokens: number;
  outputTokens: number;
  cachedReadTokens: number;
  cachedWriteTokens: number;
};

/** Per-model token tallies keyed by the model id the SDK reported them under
 *  (its resolved spelling, e.g. "claude-opus-5[1m]"). */
export type ModelTokenTally = Record<string, AccumulatedUsage>;

/** `_meta.quota` for work that spent `usage` in its main agent loop and
 *  `modelUsage` by model, shaped like codex-acp's (snake_case container keys,
 *  camelCase counters). The halves need not add up: `usage` is the main agent
 *  loop's, while `result.modelUsage` also counts subagents and compaction. */
export function quotaMeta(usage: AccumulatedUsage, modelUsage: ModelTokenTally | undefined) {
  return {
    quota: {
      token_count: quotaTokenCount(usage),
      model_usage: Object.entries(modelUsage ?? {}).map(([model, usage]) => ({
        model,
        token_count: quotaTokenCount(usage),
      })),
    },
  };
}

/** One `token_count` object. `cachedInputTokens` is cache reads, matching
 *  codex's field; Claude also reports cache writes, which codex has no slot
 *  for, so those ride along in an extra sibling (the same name the ACP `usage`
 *  field already uses) and are counted in `totalTokens`. `reasoningOutputTokens`
 *  is always 0: Claude bills thinking inside its output tokens and never breaks
 *  it out — the key is kept so the shape stays uniform across agents. */
export function quotaTokenCount(usage: AccumulatedUsage) {
  return {
    totalTokens: tallyTotal(usage),
    inputTokens: usage.inputTokens,
    cachedInputTokens: usage.cachedReadTokens,
    cachedWriteTokens: usage.cachedWriteTokens,
    outputTokens: usage.outputTokens,
    reasoningOutputTokens: 0,
  };
}

/** Sum a tally's four counters. Per the Anthropic API `inputTokens` excludes
 *  the cache counters, so this is not double-counting. */
export function tallyTotal(usage: AccumulatedUsage): number {
  return usage.inputTokens + usage.outputTokens + usage.cachedReadTokens + usage.cachedWriteTokens;
}

/** Project `result.modelUsage` into our tally shape. Counters are coerced the
 *  way `snapshotFromUsage` coerces the stream's: third-party backends have been
 *  observed omitting fields, and a missing or NaN counter must not reach the
 *  wire as NaN (which `JSON.stringify` writes as `null`). */
export function normalizeModelUsage(
  modelUsage: Record<string, ModelUsage> | undefined,
): ModelTokenTally {
  const tally: ModelTokenTally = {};
  for (const [model, usage] of Object.entries(modelUsage ?? {})) {
    tally[model] = {
      inputTokens: finiteCount(usage?.inputTokens),
      outputTokens: finiteCount(usage?.outputTokens),
      cachedReadTokens: finiteCount(usage?.cacheReadInputTokens),
      cachedWriteTokens: finiteCount(usage?.cacheCreationInputTokens),
    };
  }
  return tally;
}

function finiteCount(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** `current - previous` per model, dropping models with nothing to report so a
 *  turn only lists the models it actually ran on. A reading that fell BELOW the
 *  previous one means the running total restarted under us (a mid-session
 *  /clear, a zeroed crash result): there is no usable reference left to
 *  subtract, so the reading itself is the increment. */
export function modelUsageIncrement(
  current: ModelTokenTally,
  previous: ModelTokenTally,
): ModelTokenTally {
  const increment: ModelTokenTally = {};
  for (const [model, usage] of Object.entries(current)) {
    const base = previous[model];
    const subtracted: AccumulatedUsage = base
      ? {
          inputTokens: usage.inputTokens - base.inputTokens,
          outputTokens: usage.outputTokens - base.outputTokens,
          cachedReadTokens: usage.cachedReadTokens - base.cachedReadTokens,
          cachedWriteTokens: usage.cachedWriteTokens - base.cachedWriteTokens,
        }
      : usage;
    const rewound = Object.values(subtracted).some((count) => count < 0);
    const resolved = rewound ? usage : subtracted;
    if (tallyTotal(resolved) > 0) {
      increment[model] = resolved;
    }
  }
  return increment;
}

/** The per-model rows for the first result of a resumed session. Its
 *  `modelUsage` reading continues from the totals the transcript saved (SDK
 *  0.3.277+; older transcripts may hold none), so there is no earlier reading
 *  to subtract from, and taking the reading itself would charge the whole
 *  pre-resume history to this one turn. The result's own `usage` is per-turn
 *  (main agent loop only, like the response's `usage`), so it stands in under
 *  the turn's top-level model — `key` is that model's `modelUsage` spelling
 *  when the reading has one, else the assistant message's own. Any subagent
 *  spend on this one turn goes unlisted rather than over-listed. */
export function resumedFirstResultModelUsage(
  usage: {
    input_tokens?: number | null;
    output_tokens?: number | null;
    cache_read_input_tokens?: number | null;
    cache_creation_input_tokens?: number | null;
  },
  key: string | null,
): ModelTokenTally {
  if (key === null) {
    return {};
  }
  const row: AccumulatedUsage = {
    inputTokens: finiteCount(usage.input_tokens),
    outputTokens: finiteCount(usage.output_tokens),
    cachedReadTokens: finiteCount(usage.cache_read_input_tokens),
    cachedWriteTokens: finiteCount(usage.cache_creation_input_tokens),
  };
  return tallyTotal(row) > 0 ? { [key]: row } : {};
}

/** Fold `increment` into `base` per model — the per-model counterpart of the
 *  `+=` the turn's flat accumulator uses. */
export function addModelUsage(base: ModelTokenTally, increment: ModelTokenTally): ModelTokenTally {
  const merged: ModelTokenTally = { ...base };
  for (const [model, usage] of Object.entries(increment)) {
    const existing = merged[model];
    merged[model] = existing
      ? {
          inputTokens: existing.inputTokens + usage.inputTokens,
          outputTokens: existing.outputTokens + usage.outputTokens,
          cachedReadTokens: existing.cachedReadTokens + usage.cachedReadTokens,
          cachedWriteTokens: existing.cachedWriteTokens + usage.cachedWriteTokens,
        }
      : usage;
  }
  return merged;
}
