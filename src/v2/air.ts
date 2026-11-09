/**
 * The JetBrains AIR extensions (`docs/air-extensions.md`) that the v2
 * core serves, and their negotiation. Only a client that declares
 * `_meta.jetbrains.air` in `initialize` gets them, with the wire output that
 * the v1 core gives AIR. The extensions that ACP v2 covers on its own are
 * not served (see "ACP v2" in docs/air-extensions.md).
 */
import type * as v2 from "@agentclientprotocol/sdk/experimental/v2/unstable";
import {
  AIR_RECOMMENDED_CONFIG_VALUE_CAPABILITY,
  airCapabilityMeta,
  clientSupportsAirCapability,
  isAirClient,
} from "../air-extension.js";
import {
  AGENT_FILE_CHANGE_REPORT_CAPABILITY,
  supportsAgentFileChangeReport,
} from "../file-change-audit.js";

/** What the connection's client takes of the AIR extensions. */
export interface AirSupport {
  /**
   * The client is AIR. It gets the permission presentation, the AIR
   * permission tool call `_meta`, AskUserQuestion's custom answer marker and
   * the predicted follow-up prompt.
   */
  readonly client: boolean;
  /** `recommendedValue`: concrete model and effort rows with a recommendation. */
  readonly recommendedValue: boolean;
  /** `agentFileChangeReport`: the changed files of a prompt's turn. */
  readonly fileChangeReport: boolean;
}

/** A client that is not AIR. */
export const NO_AIR: AirSupport = {
  client: false,
  recommendedValue: false,
  fileChangeReport: false,
};

/** What the client declared in `initialize`. */
export function airSupport(capabilities: v2.ClientCapabilities | null | undefined): AirSupport {
  if (!isAirClient(capabilities)) return NO_AIR;
  return {
    client: true,
    recommendedValue: clientSupportsAirCapability(
      capabilities,
      AIR_RECOMMENDED_CONFIG_VALUE_CAPABILITY,
    ),
    fileChangeReport: supportsAgentFileChangeReport(capabilities),
  };
}

/**
 * The `initialize` response `_meta` of an AIR client: the capabilities this
 * core serves, which the v1 core advertises too. `loadReplayEnd` is served
 * (see `setup.ts`) but not listed: the client declares it, and the agent does
 * not advertise it. Undefined for every other client.
 */
export function airInitializeMeta(air: AirSupport): Record<string, unknown> | undefined {
  if (!air.client) return undefined;
  return airCapabilityMeta(
    AGENT_FILE_CHANGE_REPORT_CAPABILITY,
    AIR_RECOMMENDED_CONFIG_VALUE_CAPABILITY,
  );
}
