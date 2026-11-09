/**
 * The config options of a native v2 session: its permission mode and its
 * model. Claude Code owns both. The session sets each on the query when the
 * client picks a value, and follows the changes it learns of (an approved
 * plan's mode).
 */
import {
  RequestError,
  type SessionConfigOption,
  type SessionModeState,
} from "@agentclientprotocol/sdk/unstable";
import type * as v2 from "@agentclientprotocol/sdk/experimental/v2/unstable";
import type { ModelInfo, PermissionMode, Query } from "@anthropic-ai/claude-agent-sdk";
import type { SubagentModels } from "../native-subagents.js";
import {
  buildModelConfigOption,
  MODEL_CONFIG_ID,
  modelDisplayName,
  modelEntryFor,
  type SessionModelState,
} from "../session-model.js";
import { MODE_CONFIG_ID, SessionModeManager } from "../session-mode.js";
import { v2ConfigOptions } from "../v2/session.js";

export class SessionConfig {
  constructor(
    private readonly query: Pick<Query, "setPermissionMode" | "setModel">,
    private modes: SessionModeState,
    private models: SessionModelState,
    /** What Claude Code reports of each model, for the option's descriptions. */
    private readonly modelInfos: ModelInfo[],
  ) {}

  /** The options, built as the v1 core builds its mode and model options. */
  options(): v2.SessionConfigOption[] {
    return v2ConfigOptions(this.v1Options());
  }

  /** The entries of the `model` option, for the `model` of a subagent's session. */
  subagentModels(): SubagentModels {
    return {
      entry: (model) => modelEntryFor(this.v1Options(), this.modelInfos, model),
      name: (model) => modelDisplayName(this.modelInfos, model),
    };
  }

  private v1Options(): SessionConfigOption[] {
    return [
      SessionModeManager.configOption(this.modes),
      // A gateway that lists none of the SDK's models leaves no model option.
      ...(this.models.availableModels.length > 0
        ? [buildModelConfigOption(this.models, this.modelInfos, false)]
        : []),
    ];
  }

  availableModeIds(): string[] {
    return this.modes.availableModes.map((mode) => mode.id);
  }

  /**
   * Sets `value` on the query, and records it once Claude Code took it. Both
   * options are selects, which take an `id` value.
   */
  async set(configId: string, type: string | undefined, value: unknown): Promise<void> {
    if (type !== "id" || typeof value !== "string") {
      throw RequestError.invalidParams(
        { configId, type },
        `${configId} is a select option: set it with an \`id\` value`,
      );
    }
    switch (configId) {
      case MODE_CONFIG_ID: {
        if (!this.availableModeIds().includes(value)) {
          throw RequestError.invalidParams({ value }, `Unknown mode: ${value}`);
        }
        await this.query.setPermissionMode(value as PermissionMode);
        this.modes = { ...this.modes, currentModeId: value };
        return;
      }
      case MODEL_CONFIG_ID: {
        if (!this.models.availableModels.some((model) => model.modelId === value)) {
          throw RequestError.invalidParams({ value }, `Unknown model: ${value}`);
        }
        await this.query.setModel(value);
        this.models = { ...this.models, currentModelId: value };
        return;
      }
      default:
        throw RequestError.invalidParams({ configId }, `Unknown config option: ${configId}`);
    }
  }

  /** Claude Code switched the mode itself. Returns whether the option changed. */
  modeChanged(mode: PermissionMode): boolean {
    if (this.modes.currentModeId === mode || !this.availableModeIds().includes(mode)) return false;
    this.modes = { ...this.modes, currentModeId: mode };
    return true;
  }
}
