import type { ClientCapabilities as AcpClientCapabilities } from "@agentclientprotocol/sdk";
import {
  AIR_DIFF_PATCH_CAPABILITY,
  AIR_PLAN_CONTENT_DELTA_CAPABILITY,
  AIR_PLAN_FILE_CAPABILITY,
  AIR_RAW_INPUT_RENDERING_CAPABILITY,
  clientSupportsAirCapability,
  isAirClient,
} from "../air-extension.js";

/**
 * The client choices that decide the shape of a tool call report.
 *
 * The agent reads them once from `initialize.clientCapabilities`. The public
 * `toAcpNotifications` functions take the ACP capabilities and read them on
 * each call. The {@link AcpToolCallRenderer} reads nothing else, so one object
 * holds every capability choice of a tool call report.
 */
export class ClientCapabilities {
  constructor(
    /** The client renders a terminal from `_meta.terminal_info`, `terminal_output`, and `terminal_exit`. */
    readonly terminalOutput: boolean = false,
    /** The client appends `_meta.terminal_output_delta` instead of `terminal_output` chunks. */
    readonly terminalOutputDelta: boolean = false,
    /** The client accepts an exact git patch in a diff (`jetbrains.air` `diffPatch`). */
    readonly diffPatch: boolean = false,
    /** The capabilities that only JetBrains AIR declares. */
    readonly air: AirCapabilities = NO_AIR,
  ) {}

  static from(capabilities: AcpClientCapabilities | null | undefined): ClientCapabilities {
    const meta = capabilities?._meta;
    const terminalOutputDelta = meta?.["terminal_output_delta"] === true;
    return new ClientCapabilities(
      terminalOutputDelta || meta?.["terminal_output"] === true,
      terminalOutputDelta,
      clientSupportsAirCapability(capabilities, AIR_DIFF_PATCH_CAPABILITY),
      {
        client: isAirClient(capabilities),
        rawInputRendering: clientSupportsAirCapability(
          capabilities,
          AIR_RAW_INPUT_RENDERING_CAPABILITY,
        ),
        planContentDelta: clientSupportsAirCapability(
          capabilities,
          AIR_PLAN_CONTENT_DELTA_CAPABILITY,
        ),
        planFile: clientSupportsAirCapability(capabilities, AIR_PLAN_FILE_CAPABILITY),
      },
    );
  }
}

/** The capabilities of JetBrains AIR, read from `_meta.jetbrains.air`. */
export interface AirCapabilities {
  /**
   * The client declared `_meta.jetbrains.air`. Only then does a report follow
   * the tool call contract of `docs/air-extensions.md`. Every other client
   * gets the fields of the upstream adapter, and only the unchanged fields of
   * an update are left out.
   */
  readonly client: boolean;
  /**
   * AIR renders `rawInput` itself. A tool call report for AIR then carries no
   * display copy of the input in `content`.
   */
  readonly rawInputRendering: boolean;
  /**
   * AIR appends `_meta.jetbrains.air.contentDelta` of a streamed plan. Claude
   * does not stream a plan, so the adapter does not use it.
   */
  readonly planContentDelta: boolean;
  /**
   * AIR reads the plan of an ExitPlanMode from the file that
   * `rawInput.planFilePath` names. A report then carries the path and not the
   * plan text, when the plan file exists.
   */
  readonly planFile: boolean;
}

const NO_AIR: AirCapabilities = {
  client: false,
  rawInputRendering: false,
  planContentDelta: false,
  planFile: false,
};
