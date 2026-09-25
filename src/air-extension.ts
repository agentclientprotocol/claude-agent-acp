export const AIR_NATIVE_SUBAGENT_SESSIONS_CAPABILITY = "nativeSubagentSessions";
export const AIR_ASYNC_TASKS_CAPABILITY = "asyncTasks";
export const AIR_SESSION_FAILURE_CAPABILITY = "sessionFailure";
export const AIR_RECOMMENDED_CONFIG_VALUE_CAPABILITY = "recommendedValue";
export const AIR_DIFF_PATCH_CAPABILITY = "diffPatch";
/** AIR renders `rawInput` itself and needs no display copy of the input. */
export const AIR_RAW_INPUT_RENDERING_CAPABILITY = "rawInputRendering";
/**
 * The plan of an ExitPlanMode is a file. `rawInput.planFilePath` names the
 * file, and AIR reads the plan from it.
 */
export const AIR_PLAN_FILE_CAPABILITY = "planFile";

/** The `_meta.jetbrains.air` keys that the ACP tool call contract defines. */
export const AIR_COMMAND_TITLE_KEY = "commandTitle";
export const AIR_SUBAGENT_KEY = "subagent";
export const AIR_SKILL_KEY = "skill";
export const AIR_CONTEXT_COMPACTION_KEY = "contextCompaction";
export const AIR_GOAL_KEY = "goal";
export const AIR_KIND_KEY = "kind";
export const AIR_PERMISSION_KEY = "permission";
export const AIR_CUSTOM_ANSWER_KEY = "customAnswer";

const JETBRAINS_META_KEY = "jetbrains";
const AIR_META_KEY = "air";
const AIR_EXTENSION_VERSION_KEY = "version";
const AIR_EXTENSION_CAPABILITIES_KEY = "capabilities";
const AIR_EXTENSION_VERSION = 1;

/** The capability list this side advertises, as its own `_meta` object. */
export function airCapabilityMeta(...capabilities: string[]) {
  return withAirMeta(undefined, AIR_EXTENSION_CAPABILITIES_KEY, capabilities);
}

/**
 * Merges one AIR extension payload into an existing `_meta`.
 *
 * Every other namespace is preserved: an update can carry both agent-native
 * `claudeCode` metadata and an AIR payload, and two AIR payloads can share the
 * same `air` object. Pass `undefined` to build a fresh `_meta`.
 */
export function withAirMeta(
  meta: Record<string, unknown> | null | undefined,
  capability: string,
  payload: unknown,
): Record<string, unknown> {
  const jetbrains = asRecord(meta?.[JETBRAINS_META_KEY]);
  const air = asRecord(jetbrains[AIR_META_KEY]);
  return {
    ...meta,
    [JETBRAINS_META_KEY]: {
      ...jetbrains,
      [AIR_META_KEY]: {
        ...air,
        [AIR_EXTENSION_VERSION_KEY]: AIR_EXTENSION_VERSION,
        [capability]: payload,
      },
    },
  };
}

/**
 * Whether the client is JetBrains AIR: it declared `_meta.jetbrains.air` in
 * its capabilities.
 *
 * Only AIR gets the AIR extensions of `docs/air-extensions.md`. Every other
 * client, Zed too, gets the fields and the upstream `_meta` keys of the
 * upstream adapter, and no key that exists only for AIR.
 */
export function isAirClient(capabilities: unknown): boolean {
  return airExtensionMeta(asRecord(capabilities)._meta) !== undefined;
}

/**
 * The `_meta` of an AIR client with one more AIR payload, or undefined for
 * every other client: a client that is not AIR gets no AIR key.
 */
export function airOnlyMeta(
  airClient: boolean,
  capability: string,
  payload: unknown,
  meta?: Record<string, unknown> | null,
): Record<string, unknown> | undefined {
  return airClient ? withAirMeta(meta, capability, payload) : (meta ?? undefined);
}

/** The `air` object inside a `_meta`, or undefined when the peer sent no AIR extension. */
export function airExtensionMeta(meta: unknown): Record<string, unknown> | undefined {
  const air = asRecord(asRecord(meta)[JETBRAINS_META_KEY])[AIR_META_KEY];
  return air && typeof air === "object" && !Array.isArray(air)
    ? (air as Record<string, unknown>)
    : undefined;
}

/**
 * Whether the peer advertised `capability`.
 *
 * Takes `unknown` because every caller is reading wire data: an ACP
 * `ClientCapabilities`, or a bag whose `_meta` was never validated.
 */
export function clientSupportsAirCapability(capabilities: unknown, capability: string): boolean {
  const air = airExtensionMeta(asRecord(capabilities)._meta);
  const version = air?.[AIR_EXTENSION_VERSION_KEY];
  const advertised = air?.[AIR_EXTENSION_CAPABILITIES_KEY];
  return (
    typeof version === "number" &&
    Number.isFinite(version) &&
    Number.isInteger(version) &&
    version >= AIR_EXTENSION_VERSION &&
    Array.isArray(advertised) &&
    advertised.includes(capability)
  );
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
