/**
 * Turns the v1 session updates that the shared SDK-to-ACP mapping produces
 * (`toAcpNotifications`) into the v2 updates of one connection.
 *
 * The v2 core (`src/v2-native/`) uses it for every update that it maps from
 * the SDK stream. It holds the per-connection state that the translation
 * needs: the display terminals of commands and the `_meta` the client stores
 * for each tool call.
 */
import type * as v2 from "@agentclientprotocol/sdk/experimental/v2/unstable";
import type { AcpSessionNotification } from "../acp-subagents.js";
import { v2SessionUpdate } from "./session-update.js";
import { V2Terminals } from "./terminal.js";
import { V2ToolCallMeta } from "./tool-call-meta.js";
import { v2RestartedToolCall } from "./tool-call.js";

export class V2UpdateTranslator {
  /** The display terminals of the commands that the agent runs. */
  readonly terminals = new V2Terminals();

  /** The `_meta` that the client stores for each tool call. */
  readonly toolCallMeta = new V2ToolCallMeta();

  /**
   * The v2 updates of a v1 update: for a tool call report, the updates of its
   * terminal first (see {@link V2Terminals}), then the report itself, with the
   * `_meta` keys that it changes (see {@link V2ToolCallMeta}), and during a
   * replay the `_meta` of a tool call that the report cleared.
   */
  updates(
    sessionId: string,
    update: AcpSessionNotification["update"],
    replaying = false,
  ): v2.SessionUpdate[] {
    if (update.sessionUpdate !== "tool_call" && update.sessionUpdate !== "tool_call_update") {
      const v2Update = v2SessionUpdate(update);
      return v2Update ? [v2Update] : [];
    }
    const { terminal, report } = this.terminals.split(sessionId, update);
    if (!report) return terminal;
    const starts = report.sessionUpdate === "tool_call";
    // A v1 `tool_call` starts the tool call afresh, but v2 only has updates,
    // which keep each field they leave out. The client may already hold this
    // id: from an earlier report on this connection, or, during a replay, from
    // before it (a client that resumes a session it showed before).
    const restarts =
      starts && (replaying || this.toolCallMeta.reported(sessionId, report.toolCallId));
    const [reported, metaPatch] = this.toolCallMeta.apply(sessionId, report, starts, replaying);
    const reportUpdate = restarts ? v2RestartedToolCall(reported) : v2SessionUpdate(reported);
    const metaUpdate = metaPatch
      ? v2SessionUpdate({ sessionUpdate: "tool_call_update", ...metaPatch })
      : undefined;
    return [
      ...terminal,
      ...(reportUpdate ? [reportUpdate] : []),
      ...(metaUpdate ? [metaUpdate] : []),
    ];
  }

  /** Forgets the terminals and tool calls of a session, when it closes. */
  forget(sessionId: string): void {
    this.terminals.forget(sessionId);
    this.toolCallMeta.forget(sessionId);
  }
}

/**
 * The update that clears the message of a replayed chunk, when it is the
 * first replayed chunk of that message: a v2 client may still hold a message
 * that a replay sends again, and chunks append to it. `cleared` holds the
 * messages that the replay has cleared so far, and gains this one.
 */
export function replayClear(
  cleared: Set<string>,
  update: v2.SessionUpdate,
): v2.SessionUpdate | undefined {
  const kind = MESSAGE_OF_CHUNK.get(update.sessionUpdate);
  if (!kind) return undefined;
  const { messageId } = update as { messageId: string };
  const key = `${kind} ${messageId}`;
  if (cleared.has(key)) return undefined;
  cleared.add(key);
  return emptyMessage(kind, messageId);
}

/** The message update of each message chunk. */
const MESSAGE_OF_CHUNK = new Map<string, "user_message" | "agent_message" | "agent_thought">([
  ["user_message_chunk", "user_message"],
  ["agent_message_chunk", "agent_message"],
  ["agent_thought_chunk", "agent_thought"],
]);

function emptyMessage(
  kind: "user_message" | "agent_message" | "agent_thought",
  messageId: string,
): v2.SessionUpdate {
  const message = { messageId, content: [] };
  switch (kind) {
    case "user_message":
      return { ...message, sessionUpdate: kind };
    case "agent_message":
      return { ...message, sessionUpdate: kind };
    default:
      return { ...message, sessionUpdate: kind };
  }
}
