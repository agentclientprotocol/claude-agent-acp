/**
 * The v2 form of the session updates that `ClaudeAcpAgent` sends as v1
 * updates.
 */
import * as v2 from "@agentclientprotocol/sdk/experimental/v2";
import type { AcpSessionNotification } from "../acp-subagents.js";
import { v2AvailableCommands, v2ConfigOptions } from "./session.js";
import { v2ToolCallUpdate } from "./tool-call.js";

/**
 * The id of the plan of a session. v1 has one plan per session, which every
 * plan update replaces whole, from TodoWrite and from the Task tools alike.
 * v2 tracks plans by id, so that plan gets one.
 */
export const SESSION_PLAN_ID = "plan";

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
    case "compaction_update":
    case "compaction_summary_chunk":
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
    case "plan":
      // A v2 plan of items is replaced whole as well.
      return {
        sessionUpdate: "plan_update",
        plan: { type: "items", planId: SESSION_PLAN_ID, entries: update.entries },
        ...(update._meta != null ? { _meta: update._meta } : {}),
      };
    case "plan_update":
    case "plan_removed":
      // v1's draft plan operations have v2's shape.
      return update;
    case "subagent_update": {
      // The subagents RFD gives it the same shape in v1 and v2. One that
      // reports a state also has a copy on the child's stream (see
      // `v2ChildStateUpdate`).
      const { state, ...association } = update;
      return { ...association, ...(state != null ? { state: v2SubagentState(state) } : {}) };
    }
    case "session_message":
    case "session_message_chunk":
      // The subagents RFD gives these the same shape in v1 and v2.
      return update;
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

/**
 * The child's own `state_update` for a v1 `subagent_update` that reports the
 * child's work state, or `undefined` when it reports none.
 *
 * v1 reports a child's work state only on its parent, as the `state` of the
 * `subagent_update`. v2 reports it on the child's own stream, as for any
 * session, and mirrors it on the parent (the subagents RFD). The child's copy
 * goes right after the parent's: never before the announcement, and both
 * copies of a state before any later state.
 */
export function v2ChildStateUpdate(
  update: AcpSessionNotification["update"],
): v2.UpdateSessionNotification | undefined {
  if (update.sessionUpdate !== "subagent_update" || update.state == null) return undefined;
  return {
    sessionId: update.sessionId,
    update: { sessionUpdate: "state_update", ...v2SubagentState(update.state) },
  };
}

type V1SubagentState = NonNullable<
  Extract<AcpSessionNotification["update"], { sessionUpdate: "subagent_update" }>["state"]
>;

/** The work states of the subagents RFD, and the stop reasons of its `idle`. */
const SUBAGENT_STATES: ReadonlySet<unknown> = new Set([
  "running",
  "requires_action",
  "unknown",
  "idle",
]);
const IDLE_STOP_REASONS: ReadonlySet<unknown> = new Set([
  undefined,
  null,
  "end_turn",
  "max_tokens",
  "max_turn_requests",
  "refusal",
  "cancelled",
  "error",
]);

/**
 * The v2 form of a subagent's v1 work state.
 *
 * The RFD's states have the same shape in v1 and v2. Each version also types
 * an open member for states and stop reasons it does not know, and those two
 * members are typed apart. So the state is checked to be one of the RFD's, and
 * any other throws, as an update kind that this surface does not translate
 * does.
 */
function v2SubagentState(state: V1SubagentState): v2.StateUpdate {
  const stopReason = (state as { stopReason?: unknown }).stopReason;
  if (
    !SUBAGENT_STATES.has(state.state) ||
    (state.state === "idle" && !IDLE_STOP_REASONS.has(stopReason))
  ) {
    throw new Error(
      `The ACP v2 surface does not translate the subagent state ${state.state}${
        state.state === "idle" ? ` with the stop reason ${String(stopReason)}` : ""
      }`,
    );
  }
  return state as v2.StateUpdate;
}
