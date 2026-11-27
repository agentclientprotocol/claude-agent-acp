import { RequestError } from "@agentclientprotocol/sdk/unstable";
import type {
  SessionConfigOption,
  SetSessionConfigOptionRequest,
} from "@agentclientprotocol/sdk/unstable";
import type { ModelInfo, Query, SDKSettingsParseError } from "@anthropic-ai/claude-agent-sdk";
import { ULTRACODE_CONFIG_ID } from "./session-config-ids.js";

export { ULTRACODE_CONFIG_ID } from "./session-config-ids.js";

/** Select-fallback values for clients without boolean config options. */
export const ULTRACODE_ON = "on";
export const ULTRACODE_OFF = "off";
const ULTRACODE_DESCRIPTION = "Dynamic workflows on every task, at any effort level";

/** Ultracode state from the CLI's `get_settings` control response
 *  (`applied.ultracodeAvailable` / `applied.ultracodeRequested`). Each field is
 *  undefined when the CLI does not report it. */
export type UltracodeSettingsReport = {
  /** Workflows are enabled and the current model supports ultracode. */
  available?: boolean;
  /** Ultracode is turned on for the session, whether or not it can take
   *  effect on the current model. */
  requested?: boolean;
};

/** The CLI's `get_settings` control response, as far as the adapter reads it. */
type GetSettingsResponse = {
  applied?: { ultracodeAvailable?: unknown; ultracodeRequested?: unknown };
  errors?: Array<Partial<SDKSettingsParseError> | null>;
};

// `Query.getSettings()` exists at runtime (sdk.mjs) but is missing from the
// SDK's type declarations as of 0.3.319.
type GetSettingsQuery = Query & { getSettings?: () => Promise<GetSettingsResponse | undefined> };

/** What the CLI's `get_settings` control response says about the session. */
export type SettingsReport = {
  /** Undefined when the SDK has no `getSettings` or the request fails; callers
   *  then fall back to {@link modelSupportsUltracode}. */
  ultracode: UltracodeSettingsReport | undefined;
  /** Settings files that the CLI skipped, e.g. `{ file: "/home/u/.claude/settings.json",
   *  path: "", message: "Invalid or malformed JSON" }`. Empty when the CLI
   *  reports none or cannot be asked. */
  settingsErrors: SDKSettingsParseError[];
};

const NO_REPORT: SettingsReport = { ultracode: undefined, settingsErrors: [] };

/** Ask the CLI whether ultracode is available and requested for the session,
 *  and which settings files it skipped. */
export async function readSettingsReport(query: Query): Promise<SettingsReport> {
  const getSettings = (query as GetSettingsQuery).getSettings;
  if (typeof getSettings !== "function") return NO_REPORT;
  let response: GetSettingsResponse | undefined;
  try {
    response = await getSettings.call(query);
  } catch {
    return NO_REPORT;
  }
  return {
    ultracode: { available: parseAvailable(response), requested: parseRequested(response) },
    settingsErrors: parseSettingsErrors(response),
  };
}

function parseAvailable(response: GetSettingsResponse | undefined): boolean | undefined {
  const value = response?.applied?.ultracodeAvailable;
  return typeof value === "boolean" ? value : undefined;
}

function parseRequested(response: GetSettingsResponse | undefined): boolean | undefined {
  const value = response?.applied?.ultracodeRequested;
  return typeof value === "boolean" ? value : undefined;
}

/** Every entry counts, so a malformed one still refuses the start. */
function parseSettingsErrors(response: GetSettingsResponse | undefined): SDKSettingsParseError[] {
  if (!Array.isArray(response?.errors)) return [];
  return response.errors.map((entry) => {
    const error: SDKSettingsParseError = {
      path: typeof entry?.path === "string" ? entry.path : "",
      message: typeof entry?.message === "string" ? entry.message : "invalid settings",
    };
    if (typeof entry?.file === "string") error.file = entry.file;
    return error;
  });
}

/** The CLI supports ultracode on exactly the models that support `xhigh`
 *  effort (both use the same capability check), and `supportedEffortLevels`
 *  lists `xhigh` only for those models. E.g. Opus 4.7+, Sonnet 5+ and Haiku
 *  5.5 qualify; Opus 4.6 and Haiku 4.5 do not. */
export function modelSupportsUltracode(modelInfo: ModelInfo | undefined): boolean {
  return (
    modelInfo?.supportsEffort === true &&
    modelInfo.supportedEffortLevels?.includes("xhigh") === true
  );
}

/** Whether dynamic workflows are enabled for the session, inferred from the
 *  CLI's `ultracodeAvailable` for the model the session started on. This is
 *  the part of availability that does not change with the model: the plan
 *  default (off on Pro), `enableWorkflows`/`disableWorkflows` and org policy.
 *  Undefined when the report can't tell, e.g. `ultracodeAvailable: false` on a
 *  model that lacks ultracode support anyway. */
export function ultracodeWorkflowsEnabled(
  report: UltracodeSettingsReport | undefined,
  modelInfo: ModelInfo | undefined,
): boolean | undefined {
  if (report?.available === true) return true;
  if (report?.available === false && modelSupportsUltracode(modelInfo)) return false;
  return undefined;
}

/** Whether to offer the ultracode toggle for `modelInfo`. An unknown workflows
 *  state shows the toggle: the CLI keeps an unavailable request without
 *  error, so the toggle is merely inert there. */
export function ultracodeSupported(
  workflowsEnabled: boolean | undefined,
  modelInfo: ModelInfo | undefined,
): boolean {
  return workflowsEnabled !== false && modelSupportsUltracode(modelInfo);
}

/** Ultracode state threaded into `buildConfigOptions`. The option is only
 *  surfaced while `supported`. */
export type UltracodeOptionState = {
  supported: boolean;
  enabled: boolean;
  /** Whether the client opted into boolean config options. */
  useBooleanOption: boolean;
};

/** Build the ultracode toggle: a native boolean for clients that opted into
 *  boolean config options, otherwise an "on"/"off" select. */
export function createUltracodeConfigOption(
  enabled: boolean,
  useBooleanOption: boolean,
): SessionConfigOption {
  const base = {
    id: ULTRACODE_CONFIG_ID,
    name: "Ultracode",
    description: ULTRACODE_DESCRIPTION,
    category: "model_config",
  } as const;

  if (useBooleanOption) {
    return { ...base, type: "boolean", currentValue: enabled };
  }

  return {
    ...base,
    type: "select",
    currentValue: enabled ? ULTRACODE_ON : ULTRACODE_OFF,
    options: [
      { value: ULTRACODE_ON, name: "On" },
      { value: ULTRACODE_OFF, name: "Off" },
    ],
  };
}

/** Read the requested ultracode value from a `session/set_config_option`
 *  request: a boolean, or the "on"/"off" select-fallback strings. */
export function resolveUltracodeEnabled(params: SetSessionConfigOptionRequest): boolean {
  const value = params.value;
  if (typeof value === "boolean") return value;
  if (value === ULTRACODE_ON) return true;
  if (value === ULTRACODE_OFF) return false;
  throw RequestError.invalidParams(
    undefined,
    `Invalid value for config option ${ULTRACODE_CONFIG_ID}: ${value}`,
  );
}
