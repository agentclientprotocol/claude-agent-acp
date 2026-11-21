/**
 * The config options of a session, as both the v1 core and the v2 core
 * build them: model, effort, Fast mode, ultracode, mode and the main-thread
 * agent. A client gets them in that order (`orderedConfigOptions`), for a
 * root session and for a subagent's session.
 */
import {
  RequestError,
  type ClientCapabilities,
  type SessionConfigOption,
  type SessionModeState,
  type SetSessionConfigOptionRequest,
} from "@agentclientprotocol/sdk/unstable";
import type { AgentInfo, ModelInfo, Query } from "@anthropic-ai/claude-agent-sdk";
import {
  AIR_MODEL_REASONING_EFFORTS_CAPABILITY,
  AIR_RECOMMENDED_CONFIG_VALUE_CAPABILITY,
  clientSupportsAirCapability,
} from "./air-extension.js";
import { AGENT_CONFIG_ID, DEFAULT_AGENT_ID, EFFORT_CONFIG_ID } from "./session-config-ids.js";
import { buildEffortConfigOption } from "./session-effort.js";
import {
  createFastModeConfigOption,
  FAST_MODE_CONFIG_ID,
  resolveFastModeEnabled,
  type FastModeOptionState,
} from "./session-fast-mode.js";
import { MODE_CONFIG_ID, SessionModeManager } from "./session-mode.js";
import {
  buildModelConfigOption,
  MODEL_CONFIG_ID,
  resolveModelPreference,
  type SessionModelState,
} from "./session-model.js";
import {
  createUltracodeConfigOption,
  resolveUltracodeEnabled,
  ULTRACODE_CONFIG_ID,
  type UltracodeOptionState,
} from "./session-ultracode.js";

// `supportedAgents()` always returns Claude Code's built-in subagents — the
// ones used for Task-tool delegation (Explore, Plan, etc.) — even when the user
// has configured none of their own. Those aren't meaningful *main-thread*
// personas, so we filter them out and only surface the Agent picker when the
// user (or a plugin/project) has configured custom agents. Update this set if
// the SDK's built-in roster changes.
//
// The set is matched by name because `AgentInfo` does not say where an agent
// comes from. `getContextUsage().agents` lists only the agents that are not
// built in, but session setup does not wait for that request (see
// `readContextWindow`).
//
// Claude Code does not list two of them in every session: `web-fetch` only
// where its staged rollout or `CLAUDE_CODE_WEB_FETCH_AGENT=1` turns it on, and
// `claude-code-guide` only where the adapter's environment sets
// `CLAUDE_CODE_ENTRYPOINT` (the SDK sets `sdk-ts` when it is unset, and Claude
// Code leaves the agent out for that value).
export const BUILTIN_AGENT_NAMES = new Set([
  "claude",
  "claude-code-guide",
  "general-purpose",
  "Explore",
  "Plan",
  "statusline-setup",
  "web-fetch",
]);

// Value of the synthetic "Default" entry in the agent picker, which maps to the
// standard Claude Code agent (`applyFlagSettings({ agent: null })`). It is a
// reserved sentinel: a custom agent named exactly this would collide with it
// (two options sharing the value, selection silently routing to `null`), so we
// exclude that name from discovery.
/** Discover user/plugin/project-configured main-thread agents, excluding the
 *  built-in subagents and the reserved "default" sentinel. Returns an empty
 *  list if discovery fails so a flaky control request never blocks session
 *  creation. */
export async function discoverCustomAgents(q: Query): Promise<AgentInfo[]> {
  try {
    return customAgents(await q.supportedAgents());
  } catch {
    return [];
  }
}

/** The configured agents of `agents`: neither a built-in subagent nor the "default" sentinel. */
export function customAgents(agents: readonly AgentInfo[]): AgentInfo[] {
  return agents.filter((a) => !BUILTIN_AGENT_NAMES.has(a.name) && a.name !== DEFAULT_AGENT_ID);
}

/** Stable ids for the session config options surfaced via `configOptions`.
 *  Centralized so the option declarations in `buildConfigOptions` and the
 *  handlers in `setSessionConfigOption`/`applyConfigOptionValue` reference the
 *  same identifiers and can't drift apart. */
export { MODE_CONFIG_ID };
export { AGENT_CONFIG_ID };

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

/** Whether the Client advertised the AIR `modelReasoningEfforts` capability:
 *  each `model` option entry then names its model's effort levels. */
export function clientSupportsModelReasoningEfforts(
  clientCapabilities?: ClientCapabilities | null,
): boolean {
  return clientSupportsAirCapability(clientCapabilities, AIR_MODEL_REASONING_EFFORTS_CAPABILITY);
}

export type ConfigOptionPresentation = {
  /** Replace ambiguous `default` rows with concrete values and advertise the
   *  SDK/adapter recommendation as `_meta.jetbrains.air.recommendedValue`. */
  useRecommendedValue: boolean;
  /** Give each `model` option entry the effort levels of its model at
   *  `_meta.jetbrains.air.reasoningEfforts`. */
  modelReasoningEfforts?: boolean;
};

/**
 * The ids of a session's config options, in the order a client gets them.
 * An option is ranked by its id and not by its `category`, which the agent
 * option lacks.
 */
const CONFIG_OPTION_ORDER: readonly string[] = [
  MODEL_CONFIG_ID,
  EFFORT_CONFIG_ID,
  FAST_MODE_CONFIG_ID,
  ULTRACODE_CONFIG_ID,
  MODE_CONFIG_ID,
  AGENT_CONFIG_ID,
];

/**
 * `options` as a client gets them, for a root session and for a subagent's
 * session: in {@link CONFIG_OPTION_ORDER}'s order, then each option with
 * another id, in the order it came.
 */
export function orderedConfigOptions(
  options: Iterable<SessionConfigOption>,
): SessionConfigOption[] {
  const rank = (option: SessionConfigOption) => {
    const index = CONFIG_OPTION_ORDER.indexOf(option.id);
    return index < 0 ? CONFIG_OPTION_ORDER.length : index;
  };
  return [...options].sort((left, right) => rank(left) - rank(right));
}

/** The config options of a root session, in the order a client gets them. */
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
  const options: SessionConfigOption[] = [];
  // A gateway that lists none of the SDK's models leaves no model to offer, so
  // there is no model option at all.
  if (models.availableModels.length > 0) {
    options.push(
      buildModelConfigOption(
        models,
        modelInfos,
        presentation?.useRecommendedValue === true,
        presentation?.modelReasoningEfforts === true,
      ),
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

  options.push(SessionModeManager.configOption(modes));

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

  // The statements above already follow CONFIG_OPTION_ORDER. Sorting by it
  // keeps this list and a subagent's list on the one definition.
  return orderedConfigOptions(options);
}

/**
 * The value that a `session/set_config_option` request sets on `option`, the
 * option as the session advertised it. The value must match the option's
 * type: a `type: "boolean"` option takes `true`/`false`, not "on"/"off", and a
 * `type: "select"` option takes one of its values.
 *
 * Fast mode and ultracode give `enabled`: a boolean, or the "on"/"off" select
 * fallback for clients without boolean config options. A model takes an alias
 * too, such as "opus" or "sonnet" for a full model id. It is resolved against
 * `modelInfos` first: those entries carry `resolvedModel`, so a full model id
 * (in either hint spelling) lands on the right row via the exact tier instead
 * of a fuzzier one picking a same-family sibling from a different context
 * lane. The option's own entries (which never carry `resolvedModel`) remain as
 * a fallback for resolutions that don't map back onto a selectable option
 * (e.g. a fuzzy hit on an out-of-picker verbatim entry). `value` is then the
 * canonical option value, the model id rather than the alias.
 *
 * With `passUnlisted`, a model value that resolves to none of the entries is
 * returned as it is, marked `unlisted`, for Claude Code to decide: the CLI's
 * picker leaves out models it runs, such as `claude-fable-5-2` before a CLI
 * lists it, or `claude-opus-4-6` once a newer Opus replaces it.
 * {@link setSelectedModel} refuses it with invalid params when Claude Code
 * does. Without it, such a value is refused here.
 */
export function configOptionValue(
  option: SessionConfigOption,
  params: SetSessionConfigOptionRequest,
  modelInfos: ModelInfo[],
  passUnlisted = false,
): { enabled: boolean } | { value: string; unlisted?: true } {
  const expectedType = option.type === "boolean" ? "boolean" : "string";
  if (typeof params.value !== expectedType) {
    throw RequestError.invalidParams(
      { configId: params.configId, value: params.value },
      `Config option ${params.configId} takes a ${expectedType} value, but received: ${JSON.stringify(params.value)}`,
    );
  }
  if (params.configId === FAST_MODE_CONFIG_ID) return { enabled: resolveFastModeEnabled(params) };
  if (params.configId === ULTRACODE_CONFIG_ID) {
    return { enabled: resolveUltracodeEnabled(params) };
  }
  if (typeof params.value !== "string") {
    throw RequestError.invalidParams(
      undefined,
      `Invalid value for config option ${params.configId}: ${params.value}`,
    );
  }
  const requested = params.value;
  const allValues =
    "options" in option && Array.isArray(option.options)
      ? option.options.flatMap((o) => ("options" in o ? o.options : [o]))
      : [];
  let validValue = allValues.find((o) => o.value === requested);
  if (!validValue && params.configId === MODEL_CONFIG_ID) {
    const toOptionValue = (resolved: ModelInfo | null) =>
      resolved ? allValues.find((o) => o.value === resolved.value) : undefined;
    validValue = toOptionValue(resolveModelPreference(modelInfos, requested));
    if (!validValue) {
      const optionInfos: ModelInfo[] = allValues.map((o) => ({
        value: o.value,
        displayName: o.name,
        description: o.description ?? "",
      }));
      validValue = toOptionValue(resolveModelPreference(optionInfos, requested));
    }
    if (!validValue && passUnlisted && requested.trim() !== "") {
      return { value: requested.trim(), unlisted: true };
    }
  }
  if (!validValue) {
    throw RequestError.invalidParams(
      undefined,
      `Invalid value for config option ${params.configId}: ${requested}`,
    );
  }
  return { value: validValue.value };
}

/**
 * The codes with which Claude Code's `setModel` refuses a model id that the
 * session cannot use: an id it does not know (`not_found`,
 * `catalog_unknown`), one that settings restrict (`restricted_by_org`: an
 * `availableModels` allowlist, a managed `deniedModels` entry), one the
 * account or this CLI does not offer, and a `[1m]` form that is turned off or
 * that the model lacks.
 *
 * Claude Code sends the code as `error_code` of its answer and the SDK
 * (0.3.325) copies it to `errorCode` of the error that `setModel()` rejects
 * with. The SDK's types do not declare it.
 */
const UNUSABLE_MODEL_ERROR_CODES: ReadonlySet<string> = new Set([
  "not_found",
  "catalog_unknown",
  "restricted_by_org",
  "unavailable_for_account",
  "not_offered",
  "alias_1m_disabled",
  "alias_1m_unsupported",
]);

/** Whether `setModel()` rejected with `error` because the session cannot use the model id. */
function refusesModelId(error: unknown): error is Error {
  if (!(error instanceof Error)) return false;
  const code = (error as { errorCode?: unknown }).errorCode;
  return typeof code === "string" && UNUSABLE_MODEL_ERROR_CODES.has(code);
}

/**
 * Switches `query` to the model that {@link configOptionValue} selected.
 *
 * When Claude Code refuses an `unlisted` id as one the session cannot use
 * (see {@link UNUSABLE_MODEL_ERROR_CODES}), that is invalid params with Claude
 * Code's reason ("Model 'gpt-4' not found"), as for a value the option lacks.
 * Every other failure is thrown as it is and reaches the client as an
 * internal error: a failed switch to a listed value, and a failure that does
 * not judge the id, such as `auth_failed`, `rate_limit`, `check_unreachable`
 * (the API did not answer), `blocked_by_hook`, a closed query, or a refusal
 * without a code.
 */
export async function setSelectedModel(
  query: Pick<Query, "setModel">,
  selected: { value: string; unlisted?: true },
): Promise<void> {
  try {
    await query.setModel(selected.value);
  } catch (error) {
    if (!selected.unlisted || !refusesModelId(error)) throw error;
    throw RequestError.invalidParams(
      undefined,
      `Invalid value for config option ${MODEL_CONFIG_ID}: ${selected.value}. ${error.message}`,
    );
  }
}
