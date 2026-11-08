import { RequestError } from "@agentclientprotocol/sdk/unstable";
import type {
  ClientCapabilities,
  SessionConfigOption,
  SessionModeState,
  SetSessionConfigOptionRequest,
} from "@agentclientprotocol/sdk/unstable";
import type {
  AgentInfo,
  FastModeDisabledReason,
  FastModeState,
  ModelInfo,
} from "@anthropic-ai/claude-agent-sdk";
import {
  AIR_RECOMMENDED_CONFIG_VALUE_CAPABILITY,
  clientSupportsAirCapability,
} from "./air-extension.js";
import { DEFAULT_AGENT_ID } from "./session-config-ids.js";
import { buildEffortConfigOption } from "./session-effort.js";
import { SessionModeManager } from "./session-mode.js";
import { buildModelConfigOption, type SessionModelState } from "./session-model.js";
import { createUltracodeConfigOption, type UltracodeOptionState } from "./session-ultracode.js";

/** Stable ids for the session config options surfaced via `configOptions`.
 *  Centralized so the option declarations in `buildConfigOptions` and the
 *  handlers in `setSessionConfigOption`/`applyConfigOptionValue` reference the
 *  same identifiers and can't drift apart. */
export const AGENT_CONFIG_ID = "agent";
export const FAST_MODE_CONFIG_ID = "fast";

/** Select-fallback values used when the client has not opted into boolean
 *  config options (see {@link createFastModeConfigOption}). */
export const FAST_MODE_ON = "on";
export const FAST_MODE_OFF = "off";
const FAST_MODE_DESCRIPTION = "Faster responses on supported models";

/** Map the SDK's tri-state `fast_mode_state` onto the boolean config toggle.
 *  `cooldown` (fast mode temporarily suspended after a rate limit, per the SDK
 *  docs) keeps the toggle on so it reflects the user's intent — only an
 *  explicit `off` clears it. */
export function fastModeStateEnabled(state: FastModeState): boolean {
  return state !== "off";
}

/** User-facing explanations for the SDK's `fast_mode_disabled_reason` values
 *  that a user can act on (or at least wants to know about). Deliberately
 *  partial — the omitted reasons are not worth surfacing:
 *   - `sdk_opt_in_required`: every SDK session starts here (the toggle IS the
 *     opt-in), so it describes the default, not a problem.
 *   - `preference`: the user turned Fast mode off themselves.
 *   - `pending`: eligibility is still resolving; the next report supersedes it.
 *   - `unknown`: nothing meaningful to say.
 *  Unknown future reasons fall through the same way (open set — the SDK's docs
 *  say to ignore values you don't handle). */
export const FAST_MODE_UNAVAILABLE_EXPLANATIONS: Partial<Record<FastModeDisabledReason, string>> = {
  free: "not available on the free plan",
  extra_usage_disabled: "requires extra usage to be enabled for this account",
  model_not_allowed: "not available for the selected model",
  not_first_party: "not available on this API provider",
  disabled_by_env: "disabled by environment configuration",
  network_error: "eligibility could not be verified (network error)",
};

/** Normalize an SDK-reported `fast_mode_disabled_reason` to the one we retain:
 *  a reason we have an explanation for, else `undefined`. Keeping only
 *  explainable reasons means state comparisons (see `syncFastModeState`) track
 *  exactly what the user can see, so routine reports like
 *  `sdk_opt_in_required` never churn the config option. */
export function normalizeFastModeDisabledReason(
  reason: FastModeDisabledReason | undefined,
): FastModeDisabledReason | undefined {
  return reason && FAST_MODE_UNAVAILABLE_EXPLANATIONS[reason] ? reason : undefined;
}

/** Whether the Client advertised support for boolean session config options
 *  (`session.configOptions.boolean`). Agents MUST only send `type: "boolean"`
 *  config options to Clients that opt in; otherwise we fall back to a `select`.
 *  See https://agentclientprotocol.com/rfds/boolean-config-option. */
export function clientSupportsBooleanConfigOptions(
  clientCapabilities?: ClientCapabilities | null,
): boolean {
  return clientCapabilities?.session?.configOptions?.boolean != null;
}

/** Whether the Client advertised the AIR `recommendedValue` capability for
 *  select-style model and effort options. Missing or malformed AIR metadata
 *  retains the legacy `default` entries. */
export function clientSupportsRecommendedConfigValue(
  clientCapabilities?: ClientCapabilities | null,
): boolean {
  return clientSupportsAirCapability(clientCapabilities, AIR_RECOMMENDED_CONFIG_VALUE_CAPABILITY);
}

/** Build the Fast mode config option. When the Client supports boolean config
 *  options we expose a native `type: "boolean"` toggle; otherwise we degrade to
 *  a two-value `select` ("on"/"off") so older Clients still get a usable
 *  control.
 *
 *  `disabledReason` (the SDK's `fast_mode_disabled_reason`) is folded into the
 *  description while the toggle reads off, so a user whose account or provider
 *  can't serve Fast mode sees why instead of a switch that silently refuses to
 *  stay on. Ignored while enabled: a reason reported alongside an `on`/`cooldown`
 *  state isn't blocking anything right now. */
export function createFastModeConfigOption(
  enabled: boolean,
  useBooleanOption: boolean,
  disabledReason?: FastModeDisabledReason,
): SessionConfigOption {
  const explanation = enabled
    ? undefined
    : disabledReason && FAST_MODE_UNAVAILABLE_EXPLANATIONS[disabledReason];
  const base = {
    id: FAST_MODE_CONFIG_ID,
    name: "Fast mode",
    description: explanation ? `${FAST_MODE_DESCRIPTION} — ${explanation}` : FAST_MODE_DESCRIPTION,
    category: "model_config",
  } as const;

  if (useBooleanOption) {
    return { ...base, type: "boolean", currentValue: enabled };
  }

  return {
    ...base,
    type: "select",
    currentValue: enabled ? FAST_MODE_ON : FAST_MODE_OFF,
    options: [
      { value: FAST_MODE_ON, name: "On" },
      { value: FAST_MODE_OFF, name: "Off" },
    ],
  };
}

/** Resolve the requested Fast mode value from a `session/set_config_option`
 *  request. Accepts a native boolean (boolean-capable Clients) or the
 *  "on"/"off" select-fallback strings. */
export function resolveFastModeEnabled(params: SetSessionConfigOptionRequest): boolean {
  const value = params.value;
  if (typeof value === "boolean") {
    return value;
  }
  if (value === FAST_MODE_ON) {
    return true;
  }
  if (value === FAST_MODE_OFF) {
    return false;
  }
  throw RequestError.invalidParams(
    undefined,
    `Invalid value for config option ${FAST_MODE_CONFIG_ID}: ${value}`,
  );
}

/** Per-model Fast mode state threaded into {@link buildConfigOptions}. The
 *  option is only surfaced when the current model `supported`s fast mode. */
export type FastModeOptionState = {
  supported: boolean;
  enabled: boolean;
  /** Whether the Client opted into boolean config options. */
  useBooleanOption: boolean;
  /** Latest explainable `fast_mode_disabled_reason`, folded into the option's
   *  description while the toggle reads off. */
  disabledReason?: FastModeDisabledReason;
};

export type ConfigOptionPresentation = {
  /** Replace ambiguous `default` rows with concrete values and advertise the
   *  SDK/adapter recommendation as `_meta.jetbrains.air.recommendedValue`. */
  useRecommendedValue: boolean;
};

export function buildConfigOptions(
  modes: SessionModeState,
  models: SessionModelState,
  modelInfos: ModelInfo[],
  currentEffortLevel?: string,
  agents: AgentInfo[] = [],
  currentAgent: string = DEFAULT_AGENT_ID,
  fastMode?: FastModeOptionState,
  presentation?: ConfigOptionPresentation,
  ultracode?: UltracodeOptionState,
): SessionConfigOption[] {
  const options: SessionConfigOption[] = [SessionModeManager.configOption(modes)];
  // A gateway that lists none of the SDK's models leaves no model to offer, so
  // there is no model option at all.
  if (models.availableModels.length > 0) {
    options.push(
      buildModelConfigOption(models, modelInfos, presentation?.useRecommendedValue === true),
    );
  }
  const effort = buildEffortConfigOption(
    modelInfos,
    models.currentModelId,
    currentEffortLevel,
    presentation?.useRecommendedValue === true,
  );
  if (effort) options.push(effort);

  // Surface the Fast mode toggle only when the current model supports it. The
  // option renders as a native boolean toggle for Clients that opted in, and a
  // two-value select otherwise.
  if (fastMode?.supported) {
    options.push(
      createFastModeConfigOption(
        fastMode.enabled,
        fastMode.useBooleanOption,
        fastMode.disabledReason,
      ),
    );
  }

  // Surface the ultracode toggle only while the CLI can run it: dynamic
  // workflows are enabled and the current model supports it.
  if (ultracode?.supported) {
    options.push(createUltracodeConfigOption(ultracode.enabled, ultracode.useBooleanOption));
  }

  // Only surface the Agent picker when there's a real choice — i.e. the user
  // has configured at least one custom agent (built-ins are filtered out in
  // discoverCustomAgents). With none configured, "Default" would be the only
  // entry, so we omit the option entirely.
  if (agents.length > 0) {
    options.push({
      id: AGENT_CONFIG_ID,
      name: "Agent",
      description: "Main-thread agent persona",
      type: "select",
      currentValue: currentAgent,
      options: [
        { value: DEFAULT_AGENT_ID, name: "Default", description: "Standard Claude Code agent" },
        ...agents.map((a) => ({
          value: a.name,
          name: a.name,
          description: a.description || undefined,
        })),
      ],
    });
  }

  return options;
}
