import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import type { ModelInfo, Query, Settings } from "@anthropic-ai/claude-agent-sdk";
import { AIR_RECOMMENDED_CONFIG_VALUE_CAPABILITY, withAirMeta } from "./air-extension.js";

export const MODEL_CONFIG_ID = "model";

export type SessionModelState = {
  availableModels: Array<{ modelId: string; name: string; description?: string }>;
  currentModelId: string;
};

type ModelLogger = {
  log: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
};
type ModelSettingsSource = { getSettings(): Settings };

const MODEL_CONTEXT_HINT_PATTERN = /\[(\d+m)\]$/i;
const CONTEXT_HINT_SUFFIX_PATTERN = /-(\d+m)$/i;
const MODEL_FAMILY_VERSION_PATTERN = /\b(\d+)(?:[-.](\d+))?\b/;
const VERSIONABLE_MODEL_DISPLAY_PATTERN =
  /^(?:Claude\s+)?([a-z][a-z0-9-]*)(?:\s+\d+(?:\.\d+)?)?(?:\s+\(\d+[mk]\s+context\))?$/i;
const DISPLAY_CONTEXT_SUFFIX_PATTERN = /\s+\((\d+[mk])\s+context\)$/i;

function stripContextHints(value: string): string {
  return value.replace(/\[\d+m\]/gi, "").replace(CONTEXT_HINT_SUFFIX_PATTERN, "");
}

function canonicalizeModelId(value: string): string {
  return value.trim().toLowerCase().replace(CONTEXT_HINT_SUFFIX_PATTERN, "[$1]");
}

function contextHintOf(value: string): string | null {
  return canonicalizeModelId(value).match(MODEL_CONTEXT_HINT_PATTERN)?.[1] ?? null;
}

function extractModelFamilyVersion(value: string): string | null {
  const match = stripContextHints(value).match(MODEL_FAMILY_VERSION_PATTERN);
  if (!match) return null;
  return match[2] ? `${match[1]}.${match[2]}` : match[1];
}

function modelVersionsCompatible(preference: string, candidate: ModelInfo): boolean {
  const preferred = extractModelFamilyVersion(preference);
  if (!preferred) return true;
  const candidateVersion =
    extractModelFamilyVersion(candidate.value) ??
    extractModelFamilyVersion(candidate.displayName) ??
    extractModelFamilyVersion(candidate.description);
  return candidateVersion ? preferred === candidateVersion : true;
}

function displayModelVersion(model: ModelInfo, family: string): string | undefined {
  const familyVersion = new RegExp(`\\b${family}[-\\s]+(\\d+)(?:[-.](\\d+))?`, "i");
  // The display name is the value we are deciding whether to rewrite, so it
  // cannot validate its own normalization. Require independent SDK metadata.
  for (const source of [model.resolvedModel, model.description, model.value]) {
    const match = source?.match(familyVersion);
    if (match) return match[2] ? `${match[1]}.${match[2]}` : match[1];
  }
  return undefined;
}

/** Add concrete versions when a terse SDK label names the same family as the
 * underlying model metadata. Multi-word/custom labels remain untouched.
 * Context size remains in the option description; if normalization would
 * collide, callers fall back to the original labels. */
function versionedModelDisplayName(model: ModelInfo): string {
  const versionable = model.displayName.match(VERSIONABLE_MODEL_DISPLAY_PATTERN);
  if (!versionable) return model.displayName;
  const version = displayModelVersion(model, versionable[1]);
  if (!version) return model.displayName;
  const contextSuffix = model.displayName.match(DISPLAY_CONTEXT_SUFFIX_PATTERN);
  const descriptionKeepsContext =
    contextSuffix !== null &&
    new RegExp(`\\b${contextSuffix[1]}\\s+context\\b`, "i").test(model.description);
  const withoutContext = model.displayName.replace(DISPLAY_CONTEXT_SUFFIX_PATTERN, "");
  if (/\b\d+(?:\.\d+)?\b/.test(withoutContext)) {
    return descriptionKeepsContext ? withoutContext : model.displayName;
  }
  if (descriptionKeepsContext || contextSuffix === null) return `${withoutContext} ${version}`;
  // Keep the suffix in its original spelling and insert the version before it.
  return `${withoutContext} ${version}${contextSuffix[0]}`;
}

function tokenizeModelPreference(model: string): { tokens: string[]; contextHint?: string } {
  const lower = model.trim().toLowerCase();
  const contextHint = lower.match(MODEL_CONTEXT_HINT_PATTERN)?.[1]?.toLowerCase();
  const tokens = lower
    .replace(MODEL_CONTEXT_HINT_PATTERN, " $1 ")
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .map((token) => {
      if (token === "opusplan") return "opus";
      if (token === "best" || token === "default") return "";
      return token;
    })
    .filter((token) => token && token !== "claude")
    .filter((token) => /[a-z]/.test(token) || token.endsWith("m"));
  return { tokens, contextHint };
}

function scoreModelMatch(model: ModelInfo, tokens: string[], contextHint?: string): number {
  const haystack = `${model.value} ${model.displayName}`.toLowerCase();
  let score = 0;
  let nonHintMatched = false;
  for (const token of tokens) {
    if (!haystack.includes(token)) continue;
    if (token !== contextHint) nonHintMatched = true;
    score += token === contextHint ? 3 : 1;
  }
  return contextHint && !nonHintMatched ? 0 : score;
}

export function resolveModelPreference(models: ModelInfo[], preference: string): ModelInfo | null {
  const trimmed = preference.trim();
  if (!trimmed) return null;
  const lower = trimmed.toLowerCase();
  const canonicalPreference = canonicalizeModelId(trimmed);
  const directMatch = models.find(
    (model) =>
      model.value === trimmed ||
      canonicalizeModelId(model.value) === canonicalPreference ||
      model.displayName.toLowerCase() === lower,
  );
  if (directMatch) return directMatch;

  const matchesResolved = (model: ModelInfo) =>
    model.resolvedModel != null && canonicalizeModelId(model.resolvedModel) === canonicalPreference;
  const resolvedMatch =
    models.find((model) => model.value !== "default" && matchesResolved(model)) ??
    models.find(matchesResolved);
  if (resolvedMatch) return resolvedMatch;

  const preferenceHint = contextHintOf(trimmed);
  const includesMatch = models.find((model) => {
    if (!modelVersionsCompatible(trimmed, model)) return false;
    if (contextHintOf(model.value) !== preferenceHint) return false;
    const value = model.value.toLowerCase();
    const display = model.displayName.toLowerCase();
    return value.includes(lower) || display.includes(lower) || lower.includes(value);
  });
  if (includesMatch) return includesMatch;

  const { tokens, contextHint } = tokenizeModelPreference(trimmed);
  if (tokens.length === 0) return null;
  let bestMatch: ModelInfo | null = null;
  let bestScore = 0;
  for (const model of models) {
    if (!modelVersionsCompatible(trimmed, model)) continue;
    const score = scoreModelMatch(model, tokens, contextHint);
    if (score > 0 && (!bestMatch || score > bestScore)) {
      bestMatch = model;
      bestScore = score;
    }
  }
  return bestMatch;
}

export function matchResumedModel(models: ModelInfo[], liveModel: string): ModelInfo {
  const live = canonicalizeModelId(liveModel);
  const defaultEntry = models.find((model) => model.value === "default");
  const defaultResolved = defaultEntry?.resolvedModel
    ? canonicalizeModelId(defaultEntry.resolvedModel)
    : undefined;
  if (defaultEntry && defaultResolved === live) return defaultEntry;
  const exactMatch = models.find(
    (model) => model.resolvedModel && canonicalizeModelId(model.resolvedModel) === live,
  );
  if (exactMatch) return exactMatch;
  if (
    defaultEntry &&
    defaultResolved &&
    stripContextHints(defaultResolved) === stripContextHints(live)
  ) {
    return defaultEntry;
  }
  return (
    resolveModelPreference(models, liveModel) ?? {
      value: liveModel,
      displayName: liveModel,
      description: "",
    }
  );
}

export function buildModelConfigOption(
  models: SessionModelState,
  modelInfos: ModelInfo[],
  useRecommendedValue: boolean,
): SessionConfigOption {
  const defaultInfo = modelInfos.find((model) => model.value === "default");
  const selectableIds = new Set(models.availableModels.map((model) => model.modelId));
  const concreteInfos = modelInfos.filter(
    (model) => model.value !== "default" && selectableIds.has(model.value),
  );
  // Recommendations describe the running default, so fuzzy family matching
  // must never substitute a different generation or context window.
  const defaultResolved = defaultInfo?.resolvedModel;
  const recommended = defaultResolved
    ? (concreteInfos.find(
        (model) =>
          canonicalizeModelId(model.resolvedModel ?? model.value) ===
          canonicalizeModelId(defaultResolved),
      ) ?? null)
    : null;
  const concreteRecommendation = useRecommendedValue && recommended !== null;
  const available = concreteRecommendation
    ? models.availableModels.filter((model) => model.modelId !== "default")
    : models.availableModels;

  return {
    id: MODEL_CONFIG_ID,
    name: "Model",
    description: "AI model to use",
    category: "model",
    type: "select",
    currentValue:
      concreteRecommendation && models.currentModelId === "default"
        ? recommended.value
        : models.currentModelId,
    ...(concreteRecommendation
      ? {
          _meta: withAirMeta(undefined, AIR_RECOMMENDED_CONFIG_VALUE_CAPABILITY, recommended.value),
        }
      : {}),
    options: available.map((model) => {
      if (model.modelId === "default" && defaultInfo?.resolvedModel) {
        const named = modelInfos.find(
          (info) => info.value !== "default" && info.resolvedModel === defaultInfo.resolvedModel,
        );
        return {
          value: model.modelId,
          name: model.name,
          description: named?.displayName ?? defaultInfo.resolvedModel,
        };
      }
      return {
        value: model.modelId,
        name: model.name,
        description: model.description ?? undefined,
      };
    }),
  };
}

function resolveSettingsModel(
  models: ModelInfo[],
  settingsModel: unknown,
  logger: ModelLogger,
): ModelInfo | null {
  if (settingsModel === undefined) {
    return null;
  }
  if (typeof settingsModel !== "string") {
    const typeLabel = settingsModel === null ? "null" : typeof settingsModel;
    logger.error(`Ignoring model from settings: expected a string, got ${typeLabel}.`);
    return null;
  }
  return resolveModelPreference(models, settingsModel);
}

/**
 * Restrict the SDK's model list to the user's `availableModels` allowlist
 * (already merged-and-deduped across settings sources by `SettingsManager`).
 * The user's exact entries become the model IDs surfaced via configOptions
 * and passed to `setModel`, which prevents Claude Code from silently
 * substituting a date-pinned variant (e.g. `haiku` →
 * `claude-haiku-4-5-20251001`) that the user may not have access to.
 *
 * Display info and capability flags are copied from the closest SDK match so
 * the UI still renders sensible names and effort levels.
 *
 * Semantics from https://code.claude.com/docs/en/model-config#restrict-model-selection:
 * - `undefined` is handled by the caller (no allowlist applied).
 * - The Default option is unaffected by `availableModels` — it always remains
 *   available, even when the allowlist is `[]`.
 */
export function applyAvailableModelsAllowlist(
  sdkModels: ModelInfo[],
  allowlist: string[],
  settingsModelOverrides?: Record<string, string>,
): ModelInfo[] {
  // Default is always preserved per the docs. Synthesize one if the SDK
  // didn't surface it so downstream code (e.g. `getAvailableModels` picking
  // `models[0]` as a fallback) still has something to work with.
  const defaultModel = sdkModels.find((m) => m.value === "default") ?? {
    value: "default",
    displayName: "Default",
    description: "",
  };
  const result: ModelInfo[] = [defaultModel];
  const seen = new Set<string>([defaultModel.value]);

  const sdkModelsWithoutDefault = sdkModels.filter((m) => m.value !== "default");

  // Bedrock/Vertex deployments enforce short aliases (e.g. "claude-opus-4-6")
  // in availableModels but require provider-specific IDs at the API. We still
  // resolve `sdkMatch` against the alias (`trimmed`) — that's what the
  // matching heuristics above are built for, and override targets (ARNs,
  // opaque provider IDs) often won't textually resemble anything in
  // `sdkModelsWithoutDefault`. Only the entry's surfaced `value` becomes the
  // override target, so it's what `setModel` ends up passing to the API.
  for (const entry of allowlist) {
    const trimmed = entry.trim();
    if (!trimmed || seen.has(trimmed)) continue;

    const overridden = settingsModelOverrides?.[trimmed];
    const effective = overridden ?? trimmed;
    if (seen.has(effective)) continue;

    const sdkMatch = resolveModelPreference(sdkModelsWithoutDefault, trimmed);
    if (sdkMatch) {
      result.push({ ...sdkMatch, value: effective });
    } else {
      result.push({ value: effective, displayName: trimmed, description: "" });
    }
    seen.add(effective);
  }

  // The custom model option (ANTHROPIC_CUSTOM_MODEL_OPTION) is exempt from the
  // allowlist, the same way Default is. Per the model-config docs it adds an
  // entry "without replacing the built-in aliases" and "appears at the bottom of
  // the /model picker", so we append it last and skip the allowlist filter; this
  // keeps a slim alias allowlist from hiding the custom model row.
  // https://code.claude.com/docs/en/model-config#add-a-custom-model-option
  const customModelOption = process.env.ANTHROPIC_CUSTOM_MODEL_OPTION?.trim();
  if (customModelOption && !seen.has(customModelOption)) {
    const customModel = sdkModels.find((m) => m.value === customModelOption);
    if (customModel) {
      result.push(customModel);
      seen.add(customModel.value);
    }
  }

  return result;
}

/** Whether a rejected `setModel` was vetoed by a user-configured
 *  PreModelSwitch hook. The CLI's rejection message is the stable,
 *  distinguishable marker ("Model switch blocked by a PreModelSwitch hook:
 *  <reason>"); a format change makes this stop matching and the failure
 *  falls back to the ordinary fail-loud path, no worse than before. */
function isPreModelSwitchHookBlock(error: unknown): boolean {
  return error instanceof Error && error.message.includes("blocked by a PreModelSwitch hook");
}

export async function getAvailableModels(
  query: Query,
  models: ModelInfo[],
  sdkModels: ModelInfo[],
  settingsManager: ModelSettingsSource,
  logger: ModelLogger,
  isResumedSession: boolean,
  sessionId: string,
  resumedModelHint?: string,
): Promise<SessionModelState> {
  const settings = settingsManager.getSettings();

  let currentModel = models[0];
  let resolvedFromInput: string | undefined;
  // Model priority (highest to lowest):
  // 1. ANTHROPIC_MODEL environment variable
  // 2. settings.model (user configuration)
  // 3. the resumed session's live model (resumed sessions only)
  // 4. models[0] (default first model)
  if (process.env.ANTHROPIC_MODEL) {
    const match = resolveModelPreference(models, process.env.ANTHROPIC_MODEL);
    if (match) {
      currentModel = match;
      resolvedFromInput = process.env.ANTHROPIC_MODEL;
    }
  } else if (typeof settings.model === "string") {
    const match = resolveSettingsModel(models, settings.model, logger);
    if (match) {
      currentModel = match;
      resolvedFromInput = settings.model;
    }
  }

  // A resumed session restores the model from its last real assistant
  // transcript record. Use that same local record instead of getContextUsage:
  // the latter is a control request to the live CLI process and can add tens
  // of seconds to session/load before its first turn. No `setModel` here: the
  // SDK is already running this model, and pushing a picker alias back (e.g.
  // "opus[1m]") could change the live model rather than describe it.
  if (resolvedFromInput === undefined && isResumedSession) {
    currentModel = resumedModelHint ? matchResumedModel(models, resumedModelHint) : currentModel;
  }

  // Skip the setModel round-trip when we can prove the SDK has already landed
  // on the same model. Two cases qualify:
  //  (a) No override applied — currentModel is the SDK's own default (or, on
  //      resume, the live model read back from the SDK above); nothing to sync.
  //  (b) The resolver returned the user's input verbatim AND that value exists
  //      in the SDK's original model list — meaning no fuzzy match or
  //      allowlist rewrite was involved, and the SDK (which reads the same
  //      ANTHROPIC_MODEL / settings.json) will have arrived at the same entry.
  //      This only holds for fresh sessions: a resumed session lands on the
  //      transcript's model regardless of env/settings, so the override must
  //      be re-asserted to keep the reported model truthful.
  // Anything else (fuzzy match, allowlist-synthesized value, alias) gets a
  // setModel call so we don't drift from the user's intended pin.
  const sdkSawSameValue = sdkModels.some((m) => m.value === currentModel.value);
  const skipSetModel =
    resolvedFromInput === undefined ||
    (!isResumedSession && currentModel.value === resolvedFromInput && sdkSawSameValue);
  if (!skipSetModel) {
    const setModelStartedAt = performance.now();
    try {
      await query.setModel(currentModel.value);
      logger.log(
        `[session/models] sessionId=${sessionId} phase=set-model durationMs=${Math.round(performance.now() - setModelStartedAt)} model=${currentModel.value} outcome=success`,
      );
    } catch (error) {
      logger.log(
        `[session/models] sessionId=${sessionId} phase=set-model durationMs=${Math.round(performance.now() - setModelStartedAt)} model=${currentModel.value} outcome=error`,
      );
      // On a fresh session the pin is a defining option — fail loudly. A
      // resumed session already runs fine on the transcript's model, so
      // failing the whole session/load over the re-assert would be worse
      // than loading with the pin unapplied (mirrors the setPermissionMode
      // containment in createSession). The SDK then stayed on the
      // transcript's model, so read that back rather than reporting the
      // pin the session isn't running.
      //
      // One fresh-session failure is advisory, not defining: a
      // user-configured PreModelSwitch hook can veto the pin (CLI 2.1.251+;
      // 'deny', or 'ask' — which headless sessions refuse), and the SDK
      // rejects setModel with "Model switch blocked by a PreModelSwitch
      // hook: …". Terminal Claude Code never lets a hook veto its startup
      // model (the spawn model isn't a switch), so failing session/new here
      // would make the same hook config fatal only over ACP. The session
      // stays on the SDK's own default — report that. We can't read the
      // live model back on this path: getContextUsage isn't serviced on a
      // fresh session until the first prompt turn (issues #886/#880).
      if (!isResumedSession) {
        if (!isPreModelSwitchHookBlock(error)) throw error;
        logger.error(
          `Model pin "${currentModel.value}" was vetoed by a PreModelSwitch hook; staying on the default model:`,
          error,
        );
        currentModel = models[0];
      } else {
        logger.error(`Failed to re-assert model "${currentModel.value}" on resume:`, error);
        currentModel = resumedModelHint ? matchResumedModel(models, resumedModelHint) : models[0];
      }
    }
  }

  const displayNames = models.map(versionedModelDisplayName);
  const displayNameCounts = new Map<string, number>();
  for (const name of displayNames) {
    displayNameCounts.set(name, (displayNameCounts.get(name) ?? 0) + 1);
  }

  return {
    availableModels: models.map((model, index) => ({
      modelId: model.value,
      name:
        displayNameCounts.get(displayNames[index]) === 1 ? displayNames[index] : model.displayName,
      description: model.description,
    })),
    currentModelId: currentModel.value,
  };
}
