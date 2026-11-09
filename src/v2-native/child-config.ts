/**
 * The configuration of each child session, as the v1 core reports it
 * (`NativeSubagentRuntime.reportConfiguration`): the options that the
 * child's hooks report (its mode, model after a `PostModelSwitch`, effort and
 * agent type, see `subagentHookOptions`) and the model of its responses. Each
 * report merges into the child's options, by id, and the client gets all of
 * them again when any changed, in `orderedSubagentConfiguration`'s order.
 *
 * A hook can come before the child's announcement: its options wait for it.
 */
import type { SessionConfigOption, SessionModeState } from "@agentclientprotocol/sdk/unstable";
import type { AgentInfo, HookCallbackMatcher, HookInput } from "@anthropic-ai/claude-agent-sdk";
import type { SubagentModels } from "../native-subagents.js";
import { orderedSubagentConfiguration, subagentHookOptions } from "../subagent-configuration.js";

/** The most children not announced yet whose options wait. */
const MAX_PENDING_CHILDREN = 64;

/** What the configurations need of their root session. */
export interface ConfigurationHost {
  /** The root's modes, for the name of a child's mode. */
  modes(): SessionModeState["availableModes"];
  /** The entries of the root's `model` option, for a child's `model`. */
  models(): SubagentModels;
  /** Whether `agentId` is an announced child session. */
  announced(agentId: string): boolean;
}

export class ChildConfigurations {
  /** Each child's options, by id, and the snapshot that the client last got. */
  private readonly children = new Map<
    string,
    { options: Map<string, SessionConfigOption>; published?: string }
  >();
  /** The custom agents of the session, for the description of a child's agent type. */
  private agents: readonly AgentInfo[] = [];

  constructor(private readonly host: ConfigurationHost) {}

  /** The session's custom agents, from Claude Code's initialization (see `customAgents`). */
  configureAgents(agents: readonly AgentInfo[]): void {
    this.agents = agents;
  }

  /** The options that a hook of a subagent reports of it. */
  hookOptions(input: HookInput): SessionConfigOption[] {
    return subagentHookOptions(input, {
      availableModes: this.host.modes(),
      models: this.host.models(),
      agents: this.agents,
    });
  }

  /**
   * Takes options of the child `agentId`. Those of a child that is not
   * announced wait for it, for at most {@link MAX_PENDING_CHILDREN} children.
   * Returns whether they were kept.
   */
  take(agentId: string, options: SessionConfigOption[]): boolean {
    if (options.length === 0) return false;
    let config = this.children.get(agentId);
    if (!config) {
      const pending = [...this.children.keys()].filter((id) => !this.host.announced(id)).length;
      if (!this.host.announced(agentId) && pending >= MAX_PENDING_CHILDREN) return false;
      config = { options: new Map() };
      this.children.set(agentId, config);
    }
    for (const option of options) config.options.set(option.id, option);
    return true;
  }

  /**
   * The child's configuration to send, or undefined when the client holds it
   * already. It counts as sent.
   */
  unsent(agentId: string): SessionConfigOption[] | undefined {
    const config = this.children.get(agentId);
    if (!config) return undefined;
    const options = orderedSubagentConfiguration(config.options.values());
    const snapshot = JSON.stringify(options);
    if (config.published === snapshot) return undefined;
    config.published = snapshot;
    return options;
  }

  /** The configuration that the client last got for the child `agentId`, if any. */
  published(agentId: string): SessionConfigOption[] | undefined {
    const published = this.children.get(agentId)?.published;
    return published === undefined ? undefined : (JSON.parse(published) as SessionConfigOption[]);
  }

  /** A child that stays unexposed: its options go nowhere. */
  forget(agentId: string): void {
    this.children.delete(agentId);
  }
}

/**
 * The hook that reports a subagent's hooks to `report`, for each hook event
 * that reports them. The hook makes no decision.
 */
export function subagentHooks(
  report: (input: HookInput) => void,
): Record<
  | "SubagentStart"
  | "SubagentStop"
  | "PreToolUse"
  | "PostToolUse"
  | "PostToolUseFailure"
  | "PostModelSwitch",
  HookCallbackMatcher
> {
  const matcher: HookCallbackMatcher = {
    hooks: [
      async (input) => {
        if (input.agent_id) report(input);
        return { continue: true };
      },
    ],
  };
  return {
    SubagentStart: matcher,
    SubagentStop: matcher,
    PreToolUse: matcher,
    PostToolUse: matcher,
    PostToolUseFailure: matcher,
    PostModelSwitch: matcher,
  };
}
