/**
 * The context window of a session's model, as both the v1 core and the
 * v2 core report it in `usage_update.size`: seeded without IPC when the
 * session starts or switches models, refined by a background
 * `getContextUsage`, and learned from each result's `modelUsage`.
 */
import type { ModelInfo, Query } from "@anthropic-ai/claude-agent-sdk";
import { DEFAULT_CONTEXT_WINDOW, inferContextWindowFromModel } from "./session-usage.js";

/** Cross-session cache of authoritative context windows, keyed by
 *  `${providerCacheKey}\0${modelId}` (see {@link contextWindowCacheKey}).
 *  The window is a property of (model id, backend): the same resolved model id
 *  (e.g. "claude-sonnet-5[1m]", the spelling of the `result.modelUsage` keys)
 *  can name different context lanes behind different base URLs, routing
 *  headers, or credentials, so the key carries both. Caching it module-level
 *  lets a later session/new or switch that resolves to the same (backend,
 *  model) — in this session or any other, within the adapter's lifetime — seed
 *  the correct window synchronously with no IPC. Keying on the resolved id
 *  (rather than the picker value) means aliases that resolve to the same
 *  concrete model share one entry; the result handler additionally writes the
 *  bare assistant-message spelling so seed-time reads that fall back to a
 *  verbatim live id (rows without `resolvedModel`) can hit too.
 *
 *  Populated authoritatively by each `result.modelUsage` a turn confirms (see
 *  the consumer's result handler). We deliberately never populate it from
 *  `getContextUsage`: its `model` spelling and `rawMaxTokens` can differ from
 *  the `result.modelUsage` key and window (e.g. 967000 vs 1000000 for sonnet),
 *  so it only refines the live session (`refreshContextWindowInBackground`).
 *  Cleared on `logout`: 1M-context entitlement can differ per account/tier, so
 *  windows learned under one login must not seed sessions under the next. */
const contextWindowCache = new Map<string, number>();

/** The env vars that determine which LLM backend — and which context lane on
 *  it — a query's API traffic reaches: endpoint selection (base URLs and the
 *  Bedrock/Vertex switches with their project/region), routing/beta headers
 *  (an `anthropic-beta: context-1m-…` header flips the same model id at the
 *  same endpoint between context lanes), and credential identity (extended
 *  context is entitlement-gated per account). Used to derive the
 *  provider-cache key from the exact env a query is created with, so
 *  `providers/set` config, per-session `_meta` env overrides, and ambient
 *  process env are all distinguished exactly as the CLI will see them. */
const PROVIDER_ROUTING_ENV_VARS = [
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_BEDROCK_BASE_URL",
  "ANTHROPIC_VERTEX_BASE_URL",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "ANTHROPIC_VERTEX_PROJECT_ID",
  "CLOUD_ML_REGION",
  "AWS_REGION",
  "ANTHROPIC_CUSTOM_HEADERS",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
] as const;

/** Stable identifier for the LLM backend a session's query is created against,
 *  used to scope {@link contextWindowCache} per backend. Positional `\0`-join
 *  of {@link PROVIDER_ROUTING_ENV_VARS} values, so no segment can masquerade
 *  as another and unset vars everywhere yield one stable "default" bucket.
 *  Header/credential values can be secrets; the key only ever lives as an
 *  in-memory Map key and is never logged or surfaced. Over-keying is the safe
 *  side: a var change that didn't really change the backend costs one cache
 *  miss (heuristic seed until the next result), while under-keying would serve
 *  one backend's window for another's. */
export function providerCacheKeyFor(env: Record<string, string | undefined>): string {
  return PROVIDER_ROUTING_ENV_VARS.map((name) => env[name] ?? "").join("\0");
}

/** Compose the `contextWindowCache` key from a session's provider key and a
 *  model id. `\0`-joined so the model segment can't collide with a provider
 *  segment. */
export function contextWindowCacheKey(providerCacheKey: string, modelId: string): string {
  return `${providerCacheKey}\0${modelId}`;
}

function cacheContextWindow(modelKey: string, window: number): void {
  if (window > 0) {
    contextWindowCache.set(modelKey, window);
  }
}

/** Caches the window that a result's `modelUsage` reported, keyed on (the
 *  session's provider, the resolved model id — the `modelUsage` key, e.g.
 *  "claude-sonnet-5[1m]") so a later session/new or switch on the same
 *  provider that resolves to this model seeds the correct window
 *  synchronously, with no getContextUsage IPC.
 *
 *  Also caches it under the assistant message's own (bare) spelling. Seed-time
 *  reads fall back to a picker value / verbatim live id when a row carries no
 *  resolvedModel (the synthesized out-of-allowlist resume row sets it
 *  undefined on purpose), and those spellings match `.model` from the
 *  assistant message, not the decorated modelUsage key — without this entry
 *  such rows could never hit the cache. A non-positive window is not cached. */
export function cacheResultContextWindow(
  providerCacheKey: string,
  modelUsageKey: string,
  assistantModel: string | null | undefined,
  window: number,
): void {
  cacheContextWindow(contextWindowCacheKey(providerCacheKey, modelUsageKey), window);
  if (assistantModel && assistantModel !== modelUsageKey) {
    cacheContextWindow(contextWindowCacheKey(providerCacheKey, assistantModel), window);
  }
}

/** The context window to report *right now* for a model, with NO IPC on the
 *  critical path: the cached authoritative value if we've learned it (from a
 *  prior turn's `result.modelUsage`, this or any session on the same backend),
 *  else the text heuristic over the model row's identity strings, else the
 *  default. Derives the cache key itself — `modelInfo?.resolvedModel ?? modelId`,
 *  the same rule at every seed site — so read keys can't drift from the write
 *  site's spelling. `authoritative` reports whether the value came from the
 *  cache: an authoritative window can legitimately equal
 *  DEFAULT_CONTEXT_WINDOW, so the value alone can't tell the caller. */
export function immediateContextWindow(
  providerCacheKey: string,
  modelId: string,
  modelInfo?: Pick<ModelInfo, "resolvedModel" | "displayName" | "description">,
): { size: number; authoritative: boolean } {
  const cached = contextWindowCache.get(
    contextWindowCacheKey(providerCacheKey, modelInfo?.resolvedModel ?? modelId),
  );
  if (cached !== undefined) return { size: cached, authoritative: true };
  return {
    size:
      inferContextWindowFromModel(
        modelId,
        modelInfo?.resolvedModel,
        modelInfo?.displayName,
        modelInfo?.description,
      ) ?? DEFAULT_CONTEXT_WINDOW,
    authoritative: false,
  };
}

/** Forgets the learned windows, as a logout asks: 1M-context entitlement is
 *  gated per org/tier, and an OAuth re-login is invisible to the env-derived
 *  provider cache key, so windows learned under the old login must not seed
 *  sessions under the next. */
export function clearContextWindowCache(): void {
  contextWindowCache.clear();
}

/**
 * Reads the window of the query's current model with
 * `getContextUsage().rawMaxTokens`. Undefined when Claude Code reports none.
 *
 * Requests the `summary` detail instead of the default `full` breakdown,
 * which issues one `messages/count_tokens` call per category (~18 for a bare
 * session) and hit rate limits on every model switch; `summary` answers
 * locally with the same `rawMaxTokens`. Callers never await it on the setup
 * or switch path: SDK control requests are serialized, so awaiting would
 * delay session/new or a model switch (~15s on older CLIs, issues
 * #886/#880; ~0.5s on 2.1.283).
 *
 * The result does not go into the cross-session cache: its `rawMaxTokens` can
 * differ from the `result.modelUsage` window (e.g. 967000 vs 1000000 for
 * sonnet), so it only refines the live session.
 */
export async function readContextWindow(
  query: Pick<Query, "getContextUsage">,
): Promise<number | undefined> {
  const usage = await query.getContextUsage({ detail: "summary" });
  return usage.rawMaxTokens > 0 ? usage.rawMaxTokens : undefined;
}
