export const AIR_NATIVE_SUBAGENT_SESSIONS_CAPABILITY = "nativeSubagentSessions";
export const AIR_ASYNC_TASKS_CAPABILITY = "asyncTasks";
export const AIR_SESSION_FAILURE_CAPABILITY = "sessionFailure";

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
