/**
 * The configuration of a subagent's session, as its hooks report it. Both
 * the v1 core (`ClaudeAcpAgent.subagentConfigurationHook`, for both forms of
 * subagent sessions) and the native v2 core (`v2-native/child-config.ts`)
 * build a child's config options with these.
 */
import type { SessionConfigOption, SessionModeState } from "@agentclientprotocol/sdk/unstable";
import type { AgentInfo, HookInput } from "@anthropic-ai/claude-agent-sdk";
import { childModelOption, responseModelEntry, type SubagentModels } from "./native-subagents.js";
import { AGENT_CONFIG_ID, EFFORT_CONFIG_ID } from "./session-config-ids.js";
import { effortLevelName } from "./session-effort.js";
import { SessionModeManager } from "./session-mode.js";

/** What the root session knows that a child's options name. */
export type SubagentConfigurationContext = {
  /** The root session's modes, for the name of the child's mode. */
  availableModes: SessionModeState["availableModes"];
  /** The root session's `model` entries, for the child's model. */
  models: SubagentModels | undefined;
  /** The custom agents of the session, for the description of the child's agent type. */
  agents: readonly AgentInfo[];
};

/**
 * The config options that a hook of a subagent (`agent_id`) reports of it:
 * its permission mode, its model after a `PostModelSwitch`, its effort, and
 * its agent type. Each option lists only the child's current value. Empty
 * for a hook of the root session, and for one that reports none of these.
 */
export function subagentHookOptions(
  input: HookInput,
  context: SubagentConfigurationContext,
): SessionConfigOption[] {
  if (!input.agent_id) return [];
  const options: SessionConfigOption[] = [];
  if (input.permission_mode) {
    const mode = context.availableModes.find((mode) => mode.id === input.permission_mode);
    options.push(
      SessionModeManager.configOption({
        currentModeId: input.permission_mode,
        availableModes: [mode ?? { id: input.permission_mode, name: input.permission_mode }],
      }),
    );
  }
  const switchedModel =
    input.hook_event_name === "PostModelSwitch"
      ? responseModelEntry(input.to_model, context.models)
      : undefined;
  // The entry of the root session's `model` option, as for a child response.
  if (switchedModel) options.push(childModelOption(switchedModel));
  if (input.effort?.level) {
    options.push({
      id: EFFORT_CONFIG_ID,
      name: "Effort",
      description: "Current reasoning effort",
      category: "thought_level",
      type: "select",
      currentValue: input.effort.level,
      options: [{ value: input.effort.level, name: effortLevelName(input.effort.level) }],
    });
  }
  if (input.agent_type) {
    const agent = context.agents.find((agent) => agent.name === input.agent_type);
    options.push({
      id: AGENT_CONFIG_ID,
      name: "Agent",
      description: "Subagent type",
      type: "select",
      currentValue: input.agent_type,
      options: [
        {
          value: input.agent_type,
          name: input.agent_type,
          ...(agent?.description ? { description: agent.description } : {}),
        },
      ],
    });
  }
  return options;
}

/**
 * A child's configuration, as it goes to the client: every option it holds,
 * the mode first, then the model, the effort and the model config, then the
 * rest in the order they came.
 */
export function orderedSubagentConfiguration(
  options: Iterable<SessionConfigOption>,
): SessionConfigOption[] {
  const priority = ["mode", "model", "thought_level", "model_config"];
  const rank = (option: SessionConfigOption) => {
    const index = priority.indexOf(option.category ?? "");
    return index < 0 ? priority.length : index;
  };
  return [...options].sort((left, right) => rank(left) - rank(right));
}
