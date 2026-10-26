import type { SessionConfigOption } from "@agentclientprotocol/sdk/unstable";
import type { ModelInfo, Query, Settings } from "@anthropic-ai/claude-agent-sdk";
import { AIR_RECOMMENDED_CONFIG_VALUE_CAPABILITY, withAirMeta } from "./air-extension.js";
import { bedrockRegionPrefix } from "./gateway-models.js";

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

const MODEL_FAMILY_ALIASES = new Set(["opus", "sonnet", "haiku", "fable"]);

/** A model id without the spellings that name the same model: provider
 *  prefixes, dates, version suffixes, `:variant` suffixes, dotted versions,
 *  `-fast` and context hints. `deniedModels` and gateway listings both match on
 *  it. OpenRouter lists `anthropic/claude-opus-5.5:batch[1m]`, which normalizes
 *  to `claude-opus-5-5`; `anthropic/openai/gpt-5` keeps its `openai/` prefix and
 *  matches no Claude id. */
function normalizeModelId(value: string): string {
  let id = stripContextHints(value.trim().toLowerCase());
  const providerPrefix = id.lastIndexOf("anthropic.");
  if (providerPrefix !== -1) id = id.slice(providerPrefix + "anthropic.".length);
  return (
    id
      // Only a leading `anthropic/`: OpenRouter's `anthropic/openai/gpt-5` must
      // keep `openai/`, which `lastIndexOf` would strip along with it.
      .replace(/^anthropic\//, "")
      // `:batch`, `:free`. A letter must follow the colon, so Bedrock's `-v1:0`
      // is left for the `-vN:M` step below.
      .replace(/:[a-z][a-z0-9-]*$/, "")
      // `claude-opus-5.5` -> `claude-opus-5-5`; only dots between two digits.
      .replace(/(?<=\d)\.(?=\d)/g, "-")
      .replace(/@.*$/, "")
      .replace(/-v\d+(?::\d+)?$/, "")
      .replace(/-fast$/, "")
      .replace(/-\d{8}$/, "")
  );
}

/**
 * Whether managed `deniedModels` blocks a model id, following the CLI's rules
 * closely enough for the picker: a family alias blocks the whole family, and a
 * model id blocks that version in every spelling plus the later minor versions
 * it prefixes (`claude-opus-5` also blocks `claude-opus-5-5`). Entries share
 * `normalizeModelId`, so `claude-opus-4.5` or `anthropic/claude-opus-4.5` also
 * blocks `claude-opus-4-5`, which the CLI may still allow. The CLI stays the
 * enforcer; this only keeps the picker from offering a refused row.
 */
export function isDeniedModel(modelId: string, deniedModels: readonly string[]): boolean {
  const id = normalizeModelId(modelId);
  if (!id) return false;
  return deniedModels.some((entry) => {
    const denied = normalizeModelId(entry);
    if (!denied) return false;
    if (MODEL_FAMILY_ALIASES.has(denied)) return id === denied || id.includes(`-${denied}`);
    return id === denied || id.startsWith(`${denied}-`);
  });
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
 * - Managed `deniedModels` wins over the allowlist, so a denied entry is
 *   dropped even though the CLI would otherwise leave it unmatched.
 */
export function applyAvailableModelsAllowlist(
  sdkModels: ModelInfo[],
  allowlist: string[],
  settingsModelOverrides?: Record<string, string>,
  deniedModels: readonly string[] = [],
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
    if (
      [trimmed, effective, sdkMatch?.resolvedModel].some(
        (id) => id != null && isDeniedModel(id, deniedModels),
      )
    ) {
      continue;
    }
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

/**
 * Keep the SDK models the `providers/set` gateway listed (`listGatewayModels`,
 * `listBedrockModels`). A row matches when its `resolvedModel` (or
 * its `value` when the SDK gives none) names a listed model in any spelling:
 * `claude-sonnet-5[1m]` matches a listed `claude-sonnet-5-20260101`, and
 * `eu.anthropic.claude-sonnet-5` matches a listed `eu.anthropic.claude-sonnet-5-v1:0`.
 *
 * With a Bedrock `regionPrefix`, a row resolved to another cross-region prefix
 * (`us.anthropic.claude-sonnet-5` under `eu`) is dropped even when the same
 * model is listed under `eu`: the CLI would call it in the other region.
 *
 * A row the SDK gives no `resolvedModel` names its model only by an alias, so
 * it is checked as far as the alias allows: `default` is kept, and a family
 * alias such as `opus` is kept when the gateway lists a model of that family.
 *
 * When no row matches by its model (a `default` row kept only for lacking a
 * `resolvedModel` does not count), the gateway serves none of the SDK's
 * models, and nothing is left: the session offers no model.
 */
export function narrowToGatewayModels(
  models: ModelInfo[],
  listedModelIds: readonly string[],
  regionPrefix?: string,
): ModelInfo[] {
  const listed = new Set(listedModelIds.map(normalizeModelId).filter(Boolean));
  const narrowed = models.filter((model) => {
    const modelId = model.resolvedModel ?? model.value;
    const prefix = bedrockRegionPrefix(modelId);
    if (regionPrefix !== undefined && prefix !== undefined && prefix !== regionPrefix) {
      return false;
    }
    const id = normalizeModelId(modelId);
    if (listed.has(id)) return true;
    if (model.resolvedModel !== undefined) return false;
    if (model.value === "default") return true;
    return MODEL_FAMILY_ALIASES.has(id) && [...listed].some((entry) => entry.includes(`-${id}`));
  });
  return narrowed.some((model) => listed.has(normalizeModelId(model.resolvedModel ?? model.value)))
    ? narrowed
    : [];
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
  narrowedByGateway = false,
): Promise<SessionModelState> {
  // A gateway that lists none of the SDK's models leaves none to offer
  // (`narrowToGatewayModels`). The session stays on the model the SDK runs,
  // and the gateway refuses its requests.
  if (models.length === 0) {
    return {
      availableModels: [],
      currentModelId: (isResumedSession && resumedModelHint) || sdkModels[0]?.value || "default",
    };
  }

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
  // Case (a) does not hold when `narrowToGatewayModels` left the SDK on a
  // model the gateway does not list: the dropped `default` row of a fresh or
  // transcript-less session, or a resumed transcript model outside the list.
  // Such a session switches to models[0].
  const sdkSawSameValue = sdkModels.some((m) => m.value === currentModel.value);
  const sdkDefault = sdkModels.find((m) => m.value === "default");
  const sdkDefaultDropped = sdkDefault !== undefined && !models.some((m) => m.value === "default");
  let switchToListed = false;
  if (resolvedFromInput === undefined) {
    if (!isResumedSession || !resumedModelHint) {
      switchToListed = sdkDefaultDropped;
    } else if (
      narrowedByGateway &&
      (!models.some((m) => m.value === currentModel.value) ||
        // A loose match can map the transcript's model onto a listed row of
        // another version, which the CLI does not resume on.
        (currentModel.resolvedModel !== undefined &&
          normalizeModelId(currentModel.resolvedModel) !== normalizeModelId(resumedModelHint)))
    ) {
      currentModel = models[0];
      switchToListed = true;
    }
  }
  // When the switch fails, the SDK stays on the model it ran before it.
  const modelBeforeSwitch = (): ModelInfo =>
    switchToListed && sdkDefault !== undefined ? sdkDefault : models[0];
  const skipSetModel =
    (resolvedFromInput === undefined && !switchToListed) ||
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
        // A switch onto a listed model is advisory too: the session stays on
        // the model the SDK runs and reports it.
        if (!switchToListed && !isPreModelSwitchHookBlock(error)) throw error;
        logger.error(
          `Model switch to "${currentModel.value}" failed or was vetoed by a PreModelSwitch hook; staying on the default model:`,
          error,
        );
        currentModel = modelBeforeSwitch();
      } else {
        logger.error(`Failed to re-assert model "${currentModel.value}" on resume:`, error);
        currentModel = resumedModelHint
          ? matchResumedModel(models, resumedModelHint)
          : modelBeforeSwitch();
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

/** The display name of the model id `model` in `modelInfos`, if it is there. */
export function modelDisplayName(modelInfos: ModelInfo[], model: string): string | undefined {
  return modelInfos.find((info) => info.value === model || info.resolvedModel === model)
    ?.displayName;
}

/** The flat entries of a session's `model` select option. */
function modelOptionEntries(option: SessionConfigOption): Array<{ value: string; name: string }> {
  if (option.type !== "select") return [];
  return option.options.flatMap((entry) =>
    "value" in entry ? [{ value: entry.value, name: entry.name }] : entry.options,
  );
}

/**
 * The entry of the `model` option among `configOptions` for `model`, a model
 * id that a response reported, so that a client can compare it with the
 * session's own model. Best first:
 *
 * 1. the current entry, when it runs that model up to a context hint: a
 *    session on `opus[1m]` or `default` that answers as `claude-opus-4-6`;
 * 2. the entry whose value or resolved model is that id;
 * 3. an entry that runs that model up to a context hint.
 *
 * Among several entries for one model, a concrete entry comes before
 * `default`, as in {@link resolveModelPreference}. Undefined when no entry
 * matches. A model's resolved id comes from `modelInfos`
 * (`ModelInfo.resolvedModel`), the wire id that a response reports, as for
 * {@link matchResumedModel}. It is compared as it is: a dated id such as
 * `claude-haiku-4-5-20251001` matches only the same dated id.
 */
export function modelEntryFor(
  configOptions: readonly SessionConfigOption[],
  modelInfos: ModelInfo[],
  model: string,
): { value: string; name: string } | undefined {
  const option = configOptions.find((candidate) => candidate.id === MODEL_CONFIG_ID);
  if (option?.type !== "select") return undefined;
  // Concrete entries first; `sort` keeps the list order otherwise.
  const entries = modelOptionEntries(option).sort(
    (left, right) => Number(left.value === "default") - Number(right.value === "default"),
  );
  const observed = canonicalizeModelId(model);
  const resolved = (value: string) =>
    canonicalizeModelId(modelInfos.find((info) => info.value === value)?.resolvedModel ?? value);
  const sameModel = (value: string) =>
    stripContextHints(resolved(value)) === stripContextHints(observed);
  const current = entries.find((entry) => entry.value === option.currentValue);
  if (current && sameModel(current.value)) return current;
  return (
    entries.find((entry) => entry.value === model || resolved(entry.value) === observed) ??
    entries.find((entry) => sameModel(entry.value))
  );
}
