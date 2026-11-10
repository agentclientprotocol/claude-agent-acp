import type { SessionConfigOption } from "@agentclientprotocol/sdk/unstable";
import type { EffortLevel, ModelInfo, Settings } from "@anthropic-ai/claude-agent-sdk";
import { AIR_RECOMMENDED_CONFIG_VALUE_CAPABILITY, withAirMeta } from "./air-extension.js";
import { EFFORT_CONFIG_ID } from "./session-config-ids.js";

export { EFFORT_CONFIG_ID } from "./session-config-ids.js";

// The SDK drops `undefined` during JSON transport and only clears a flag-layer
// setting when it receives an explicit `null`. Map both an absent picker and
// the legacy "default" row to null so a previously applied effort is cleared.
export function toSdkEffortLevel(value: string | undefined): EffortLevel | null {
  return value === undefined || value === "default" ? null : (value as EffortLevel);
}

// Since CLI 2.1.284 an `effortLevel` that changes the level, sent without an
// `ultracode` key, turns ultracode off. The CLI's own effort control keeps
// ultracode on at any level, so send `ultracode: true` with every effort apply
// while the session has ultracode on. When it is off, the key is omitted: an
// effort change then leaves ultracode off, as it already was.
export function effortFlagSettings(
  value: string | undefined,
  ultracode: boolean,
): { effortLevel: EffortLevel | null; ultracode?: true } {
  const effortLevel = toSdkEffortLevel(value);
  return ultracode ? { effortLevel, ultracode: true } : { effortLevel };
}

/**
 * `params` without `_meta.claudeCode.options.effort`, for a restart of the
 * session's query: the restart restores the current effort pin instead of
 * the one the session was created with.
 */
export function withoutEffort<T extends { _meta?: unknown }>(params: T): T {
  const meta = params._meta as
    { claudeCode?: { options?: { effort?: unknown } } } | null | undefined;
  if (meta?.claudeCode?.options?.effort === undefined) {
    return params;
  }
  const options = { ...meta.claudeCode.options };
  delete options.effort;
  return { ...params, _meta: { ...meta, claudeCode: { ...meta.claudeCode, options } } };
}

function canonicalizeModelSettingsKey(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/-(\d+m)$/i, "[$1]");
}

/** Resolve the effort the CLI will use: per-model settings first, then the
 *  legacy top-level effort setting. Model settings are keyed by canonical
 *  model name, so try the resolved SDK model before picker and raw IDs. */
export function settingsEffortForModel(
  settings: Settings,
  modelInfo: ModelInfo | undefined,
  modelId?: string,
): string | undefined {
  const modelSettings = settings.modelSettings;
  if (modelSettings) {
    for (const key of [modelInfo?.resolvedModel, modelInfo?.value, modelId]) {
      if (key === undefined) continue;
      const exact = modelSettings[key]?.effortLevel;
      if (typeof exact === "string") return exact;
      const canonicalKey = canonicalizeModelSettingsKey(key);
      const matchingEntry = Object.entries(modelSettings).find(
        ([candidate]) => canonicalizeModelSettingsKey(candidate) === canonicalKey,
      );
      const perModel = matchingEntry?.[1]?.effortLevel;
      if (typeof perModel === "string") return perModel;
    }
  }
  return settings.effortLevel;
}

/** Programmatic query settings have higher priority than file-backed settings,
 * matching the SDK. Keep unrelated per-model entries from lower tiers while
 * replacing entries supplied at the programmatic tier. */
export function mergeEffortSettings(base: Settings, override: Settings | undefined): Settings {
  if (!override) return base;
  const overriddenModelKeys = new Set(
    Object.keys(override.modelSettings ?? {}).map(canonicalizeModelSettingsKey),
  );
  const unshadowedBaseModelSettings = Object.fromEntries(
    Object.entries(base.modelSettings ?? {}).filter(
      ([key]) => !overriddenModelKeys.has(canonicalizeModelSettingsKey(key)),
    ),
  );
  return {
    ...base,
    ...override,
    modelSettings:
      base.modelSettings || override.modelSettings
        ? { ...unshadowedBaseModelSettings, ...override.modelSettings }
        : undefined,
  };
}

export function effortLevelName(level: string): string {
  return level
    .split(/[_-]/)
    .map((part) => (part ? part.charAt(0).toUpperCase() + part.slice(1) : part))
    .join(" ");
}

export function buildEffortConfigOption(
  modelInfos: ModelInfo[],
  currentModelId: string,
  currentEffortLevel: string | undefined,
  useRecommendedValue: boolean,
): SessionConfigOption | undefined {
  const currentModelInfo = modelInfos.find((model) => model.value === currentModelId);
  const supportedLevels = currentModelInfo?.supportsEffort
    ? (currentModelInfo.supportedEffortLevels ?? [])
    : [];
  if (supportedLevels.length === 0) return undefined;

  const recommendedEffort = (supportedLevels as string[]).includes("medium")
    ? "medium"
    : supportedLevels[0];
  const options = [
    ...(useRecommendedValue ? [] : [{ value: "default", name: "Default" }]),
    ...supportedLevels.map((level) => ({
      value: level,
      name: effortLevelName(level),
    })),
  ];
  const includes = (level: string) =>
    (!useRecommendedValue && level === "default") || (supportedLevels as string[]).includes(level);
  const currentValue =
    currentEffortLevel && includes(currentEffortLevel)
      ? currentEffortLevel
      : useRecommendedValue
        ? recommendedEffort
        : "default";

  return {
    id: EFFORT_CONFIG_ID,
    name: "Effort",
    description: "Available effort levels for this model",
    category: "thought_level",
    type: "select",
    currentValue,
    options,
    ...(useRecommendedValue
      ? {
          _meta: withAirMeta(undefined, AIR_RECOMMENDED_CONFIG_VALUE_CAPABILITY, recommendedEffort),
        }
      : {}),
  };
}

/** A session's effort bookkeeping: the level the user pinned through the
 *  picker, and the level last applied to the SDK's flag layer. */
export type EffortState = {
  pinned: string | undefined;
  applied: string | undefined;
};

/** The effort after a switch to `newModelInfo`, before the option is rebuilt
 *  (see {@link settleEffortAfterModelSwitch}). */
export type EffortSwitch = {
  /** The effort to build the new model's option with. */
  seed: string | undefined;
  /** Whether the user's pin is one of the new model's levels. */
  pinnedForNewModel: boolean;
  before: EffortState;
  /** The level applied before the switch, restored if the sync fails. */
  appliedBeforeSwitch: string | undefined;
};

/** The effort seed of a model switch. It depends on who owns the choice: a
 *  user pin made through the ACP picker this session lives at the SDK's flag
 *  layer and follows the session across switches, so it carries forward.
 *  Otherwise the CLI resolves effort itself from the persisted settings — the
 *  NEW model's `modelSettings` entry first (the CLI persists /effort per
 *  model), then the legacy top-level value — so the option shows what it
 *  will actually run instead of dragging the old model's value along. */
export function effortForModelSwitch(input: {
  state: EffortState;
  /** The current value of the effort option, if it is shown. */
  displayed: string | undefined;
  newModelInfo: ModelInfo | undefined;
  modelId: string;
  /** The merged effort settings (see {@link mergeEffortSettings}). */
  settings: Settings;
  useRecommendedValue: boolean;
}): EffortSwitch {
  const { state, displayed, newModelInfo, useRecommendedValue } = input;
  const pinned = state.pinned;
  const pinnedForNewModel =
    pinned !== undefined &&
    newModelInfo?.supportsEffort === true &&
    newModelInfo.supportedEffortLevels?.some((level) => level === pinned) === true;
  return {
    seed: pinnedForNewModel
      ? pinned
      : settingsEffortForModel(input.settings, newModelInfo, input.modelId),
    pinnedForNewModel,
    before: state,
    appliedBeforeSwitch:
      state.applied ??
      (useRecommendedValue && typeof displayed === "string" && displayed !== "default"
        ? displayed
        : pinned),
  };
}

/**
 * Applies the effort of a model switch to the SDK's flag layer, once the new
 * model's effort `option` is built from `change.seed`. Returns the new state
 * and the option to show (undefined to hide it).
 *
 * Opted-in clients (`useRecommendedValue`) apply the concrete displayed effort
 * on every switch, including settings-derived values, so a previous automatic
 * flag cannot shadow the new model's settings. This does not create a user
 * pin. For other clients, the flag is synced only when a user pin is lost
 * across the switch — the new model clamped it away, where the flag must be
 * cleared too or the SDK would keep running the old pin invisibly.
 * Settings-derived seeds are display-only: the CLI resolves persisted effort
 * itself, and pinning it at the flag layer would shadow the per-model values
 * on every later switch.
 *
 * The model switch already succeeded, so a failed sync is returned as
 * `error`, not thrown. The old bookkeeping stays, and the unapplied value is
 * never shown: the option shows the last applied value when the new model can
 * select it, else it is hidden until a later switch rebuilds it.
 */
export async function settleEffortAfterModelSwitch(
  change: EffortSwitch,
  option: SessionConfigOption | undefined,
  ultracode: boolean,
  useRecommendedValue: boolean,
  applyFlagSettings: (settings: ReturnType<typeof effortFlagSettings>) => Promise<void>,
): Promise<{ state: EffortState; option: SessionConfigOption | undefined; error?: unknown }> {
  const { pinnedForNewModel, before } = change;
  const sync = useRecommendedValue || (before.pinned !== undefined && !pinnedForNewModel);
  if (!sync) {
    return {
      state: pinnedForNewModel ? { pinned: before.pinned, applied: before.pinned } : before,
      option,
    };
  }
  const newEffort = typeof option?.currentValue === "string" ? option.currentValue : undefined;
  try {
    // A legacy client's unpinned effort is display-only: the CLI resolves the
    // persisted value for the new model. When an old user pin is no longer
    // supported, clear the flag layer instead of replacing it with that
    // displayed value. Opted-in clients deliberately apply their concrete
    // displayed effort.
    await applyFlagSettings(
      effortFlagSettings(useRecommendedValue ? newEffort : undefined, ultracode),
    );
    return {
      state: {
        pinned: pinnedForNewModel ? before.pinned : undefined,
        applied: useRecommendedValue && newEffort !== "default" ? newEffort : undefined,
      },
      option,
    };
  } catch (error) {
    const applied = change.appliedBeforeSwitch;
    const selectable =
      applied !== undefined &&
      option?.type === "select" &&
      option.options.some((entry) =>
        "value" in entry
          ? entry.value === applied
          : entry.options.some((nested) => nested.value === applied),
      );
    return {
      state: { pinned: before.pinned, applied },
      option:
        selectable && option?.type === "select" ? { ...option, currentValue: applied } : undefined,
      error,
    };
  }
}
