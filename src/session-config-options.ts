/**
 * The config options of a session, as both the v1 core and the native v2 core
 * build them: mode, model, effort, Fast mode, ultracode and the main-thread
 * agent.
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
  AIR_RECOMMENDED_CONFIG_VALUE_CAPABILITY,
  clientSupportsAirCapability,
} from "./air-extension.js";
import { AGENT_CONFIG_ID, DEFAULT_AGENT_ID } from "./session-config-ids.js";
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
export const BUILTIN_AGENT_NAMES = new Set([
  "claude",
  "general-purpose",
  "Explore",
  "Plan",
  "statusline-setup",
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
 */
export function configOptionValue(
  option: SessionConfigOption,
  params: SetSessionConfigOptionRequest,
  modelInfos: ModelInfo[],
): { enabled: boolean } | { value: string } {
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
  }
  if (!validValue) {
    throw RequestError.invalidParams(
      undefined,
      `Invalid value for config option ${params.configId}: ${requested}`,
    );
  }
  return { value: validValue.value };
}
