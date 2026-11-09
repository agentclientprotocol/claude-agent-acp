/**
 * Token usage as Claude Code reports it: the context window figures of
 * `usage_update` and the `_meta.quota` of a turn. Shared by the v1 core and
 * the native v2 core.
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

export type UsageSnapshot = {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
};

export const ZERO_USAGE = Object.freeze({
  input_tokens: 0,
  output_tokens: 0,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
});

export const DEFAULT_CONTEXT_WINDOW = 200000;

/** `_meta.quota` for work that spent `usage` in its main agent loop and
 *  `modelUsage` by model (see `turnQuotaMeta` in `acp-agent.ts`). */
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
function quotaTokenCount(usage: AccumulatedUsage) {
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
 *  the cache counters, so this is not double-counting (see `totalTokens`). */
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

/** Sum all four fields as a proxy for post-turn context occupancy: the current
 *  turn's output becomes next turn's input. Per the Anthropic API, input_tokens
 *  excludes cache tokens — cache_read and cache_creation are reported
 *  separately — so summing all four is not double-counting. */
export function totalTokens(usage: UsageSnapshot): number {
  return (
    usage.input_tokens +
    usage.output_tokens +
    usage.cache_read_input_tokens +
    usage.cache_creation_input_tokens
  );
}

/** Project a nullable API usage object into our non-null snapshot shape.
 *  Both SDK message_start and assistant message `usage` have `number | null`
 *  cache fields; we coerce absent values to 0 so `totalTokens` never hits
 *  NaN. `input_tokens`/`output_tokens` are typed `number` by the SDK but
 *  synthetic or third-party-backend stream events have been observed emitting
 *  them as null/undefined — coerce those too so a malformed upstream event
 *  can't leak NaN into the wire `used` field. Delta events have different
 *  semantics (cumulative + prev fallback) and are handled inline. */
export function snapshotFromUsage(usage: {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}): UsageSnapshot {
  return {
    input_tokens: usage.input_tokens ?? 0,
    output_tokens: usage.output_tokens ?? 0,
    cache_read_input_tokens: usage.cache_read_input_tokens ?? 0,
    cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
  };
}

function commonPrefixLength(a: string, b: string) {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) {
    i++;
  }
  return i;
}

/** Best-effort first guess of a model's context window, used to seed the
 *  window synchronously (via `immediateContextWindow`) until a `result` message
 *  arrives with the authoritative `modelUsage` value.
 *
 *  Anthropic 1M-context variants encode "1m" as a distinct token in the SDK
 *  model ID (e.g., "claude-opus-4-6-1m"), which `\b1m\b` catches without also
 *  matching things like "10m" or embedded substrings. Semantic aliases like
 *  `default` carry no such token in the ID, but their `resolvedModel` and the
 *  SDK's human-facing `displayName`/`description` can (e.g.
 *  "claude-opus-4-8[1m]", "Opus 4.7 (1M context)"), so callers pass those too.
 *  This text scan can't catch every model — some resolve to extended-context
 *  models with no "1m" anywhere (e.g. `sonnet` → claude-sonnet-5, natively
 *  ~1M). Such a miss falls back to the default window, is refined by the
 *  background `getContextUsage` (`refreshContextWindowInBackground`), and is
 *  corrected by `result.modelUsage` (and cached) within one turn. */
export function inferContextWindowFromModel(...texts: Array<string | undefined>): number | null {
  if (texts.some((text) => text != null && /\b1m\b/i.test(text))) return 1_000_000;
  return null;
}

export function getMatchingModelUsage(
  modelUsage: Record<string, ModelUsage>,
  currentModel: string,
) {
  let bestKey: string | null = null;
  let bestLen = 0;

  for (const key of Object.keys(modelUsage)) {
    const len = commonPrefixLength(key, currentModel);
    if (len > bestLen) {
      bestLen = len;
      bestKey = key;
    }
  }

  if (bestKey) {
    // `bestKey` is the SDK's resolved model id (e.g. "claude-sonnet-5[1m]"),
    // the same spelling as ModelInfo.resolvedModel — the primary key the
    // window is cached under. `currentModel` (the assistant message's
    // `.model`) can be the bare form (e.g. "claude-sonnet-5"); the result
    // handler caches under that spelling too, for seed-time reads that fall
    // back to a bare id (rows without `resolvedModel`).
    return { key: bestKey, usage: modelUsage[bestKey] };
  }
}
