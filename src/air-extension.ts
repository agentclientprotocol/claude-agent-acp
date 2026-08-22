import type { ClientCapabilities } from "@agentclientprotocol/sdk";

export const AIR_NATIVE_SUBAGENT_SESSIONS_CAPABILITY = "nativeSubagentSessions";
export const AIR_ASYNC_TASKS_CAPABILITY = "asyncTasks";
export const AIR_SESSION_FAILURE_CAPABILITY = "sessionFailure";

export const JETBRAINS_META_KEY = "jetbrains";
export const AIR_META_KEY = "air";
export const AIR_EXTENSION_VERSION_KEY = "version";
const AIR_EXTENSION_CAPABILITIES_KEY = "capabilities";
export const AIR_EXTENSION_VERSION = 1;

export function airCapabilityMeta(...capabilities: string[]) {
  return {
    [JETBRAINS_META_KEY]: {
      [AIR_META_KEY]: {
        [AIR_EXTENSION_VERSION_KEY]: AIR_EXTENSION_VERSION,
        [AIR_EXTENSION_CAPABILITIES_KEY]: capabilities,
      },
    },
  };
}

export function clientSupportsAirCapability(
  capabilities: ClientCapabilities | null | undefined,
  capability: string,
): boolean {
  const jetbrains = capabilities?._meta?.[JETBRAINS_META_KEY] as
    Record<string, unknown> | undefined;
  const air = jetbrains?.[AIR_META_KEY] as Record<string, unknown> | undefined;
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
