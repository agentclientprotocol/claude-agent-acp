/**
 * The v2 form of the session updates that `ClaudeAcpAgent` sends as v1
 * updates.
 */
import * as v2 from "@agentclientprotocol/sdk/experimental/v2";
import type { AcpSessionNotification } from "../acp-subagents.js";
import { v2AvailableCommands, v2ConfigOptions } from "./session.js";
import { v2ToolCallUpdate } from "./tool-call.js";

/**
 * The v2 form of a v1 session update, or `undefined` when v2 has no
 * counterpart and the update tells a v2 client nothing new.
 *
 * Update kinds that the v2 surface does not translate yet throw, so a gap is
 * an error rather than a silently missing update.
 */
export function v2SessionUpdate(
  update: AcpSessionNotification["update"],
): v2.SessionUpdate | undefined {
  switch (update.sessionUpdate) {
    case "available_commands_update":
      return { ...update, availableCommands: v2AvailableCommands(update.availableCommands) };
    case "config_option_update":
      return { ...update, configOptions: v2ConfigOptions(update.configOptions) };
    case "session_info_update":
    case "usage_update":
    case "notice":
      return update;
    case "agent_message_chunk":
    case "agent_thought_chunk":
    case "user_message_chunk": {
      // v2 requires the id of the message a chunk belongs to; v1 allows none.
      const { messageId, ...chunk } = update;
      if (!messageId) {
        throw new Error(`An ACP v2 ${update.sessionUpdate} needs a messageId`);
      }
      return { ...chunk, messageId };
    }
    case "tool_call":
    case "tool_call_update":
      return v2ToolCallUpdate(update);
    case "current_mode_update":
      // v2 has no modes: the mode is the `mode` config option. Every mode
      // change also reaches the client as a `config_option_update` or in the
      // `configOptions` of a `session/set_config_option` response.
      return undefined;
    default:
      throw new Error(
        `The ACP v2 surface does not translate ${update.sessionUpdate} session updates yet`,
      );
  }
}
