/**
 * The Fast mode toggle of a session: its config option, the value a
 * `session/set_config_option` request sets, and the state Claude Code reports
 * (`fast_mode_state` and `fast_mode_disabled_reason`, on `system`/init and on
 * results). Shared by the v1 core and the native v2 core.
 */
import { RequestError } from "@agentclientprotocol/sdk/unstable";
import type {
  SessionConfigOption,
  SetSessionConfigOptionRequest,
} from "@agentclientprotocol/sdk/unstable";
import type { FastModeDisabledReason, FastModeState } from "@anthropic-ai/claude-agent-sdk";
import { sentenceCase } from "./session-notices.js";

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
const FAST_MODE_UNAVAILABLE_EXPLANATIONS: Partial<Record<FastModeDisabledReason, string>> = {
  free: "not available on the free plan",
  extra_usage_disabled: "requires extra usage to be enabled for this account",
  model_not_allowed: "not available for the selected model",
  not_first_party: "not available on this API provider",
  disabled_by_env: "disabled by environment configuration",
  network_error: "eligibility could not be verified (network error)",
};

/** Normalize an SDK-reported `fast_mode_disabled_reason` to the one we retain:
 *  a reason we have an explanation for, else `undefined`. Keeping only
 *  explainable reasons means state comparisons (see `fastModeStateChange`) track
 *  exactly what the user can see, so routine reports like
 *  `sdk_opt_in_required` never churn the config option. */
export function normalizeFastModeDisabledReason(
  reason: FastModeDisabledReason | undefined,
): FastModeDisabledReason | undefined {
  return reason && FAST_MODE_UNAVAILABLE_EXPLANATIONS[reason] ? reason : undefined;
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

/** Per-model Fast mode state threaded into `buildConfigOptions`. The
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

/** What a reported `fast_mode_state` changes in a Fast mode toggle that the
 *  current model shows. The SDK can flip fast mode independently of the
 *  user — e.g. back to `on` once a rate-limit `cooldown` clears — so
 *  definitive on/off changes are mirrored into the option.
 *
 *  Undefined when nothing changes: an absent state, a `cooldown` (a transient
 *  suspension of an already-enabled fast mode: the toggle stays as-is rather
 *  than flapping, and a stray cooldown never enables a toggle the user has
 *  off), or the same state with the same explainable reason.
 *
 *  `reason` is the SDK's `fast_mode_disabled_reason`, reported alongside the
 *  state. Only explainable reasons are retained (see
 *  {@link normalizeFastModeDisabledReason}), so a routine
 *  `sdk_opt_in_required` report on every turn's result can't churn the
 *  option, while a real blocker updates the description even when the
 *  toggle's own value is unchanged.
 *
 *  `notice` is set when the user had Fast mode on and the SDK turned it off
 *  for an explainable reason: the description carries the same explanation,
 *  but a toggle silently snapping back is worth saying out loud once. */
export function fastModeStateChange(
  current: { enabled: boolean; disabledReason?: FastModeDisabledReason },
  state: FastModeState | undefined,
  reason: FastModeDisabledReason | undefined,
):
  | { enabled: boolean; disabledReason?: FastModeDisabledReason; notice?: FastModeOffNotice }
  | undefined {
  if (state === undefined || state === "cooldown") return undefined;
  const enabled = state === "on";
  // A reason only describes an off state; drop any that rides an `on` report
  // so it can't decorate the option the next time fast mode goes off.
  const disabledReason = enabled ? undefined : normalizeFastModeDisabledReason(reason);
  if (enabled === current.enabled && disabledReason === current.disabledReason) return undefined;
  const explanation =
    disabledReason !== undefined ? FAST_MODE_UNAVAILABLE_EXPLANATIONS[disabledReason] : undefined;
  if (!current.enabled || enabled || explanation === undefined) {
    return { enabled, disabledReason };
  }
  return {
    enabled,
    disabledReason,
    notice: {
      notice: {
        severity: "warning",
        title: "Fast mode turned off",
        description: `${sentenceCase(explanation)}.`,
      },
      transcript: `**Fast mode turned off:** ${explanation}.`,
    },
  };
}

/** The notice of Fast mode that the SDK turned off, and its transcript line
 *  for a client without `notice` updates. */
export type FastModeOffNotice = {
  notice: { severity: "warning"; title: string; description: string };
  transcript: string;
};
