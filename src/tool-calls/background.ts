import type { SessionNotification } from "@agentclientprotocol/sdk";
import { AIR_ASYNC_TASKS_CAPABILITY, withAirMeta } from "../air-extension.js";

/**
 * Marks the Bash `tool_call_update` whose command detached into the background.
 *
 * A backgrounded Bash call returns as soon as the command is handed off, so the
 * card reaches `completed` while the command itself runs on for minutes. ACP has
 * no tool-call status for "still running elsewhere", so this marker is what lets
 * a client render the card as backgrounded work instead of finished work. It
 * rides the update the tool result already emits, so it costs no extra
 * notification and cannot arrive out of order.
 *
 * Only structured data marks a call: the `backgroundTaskId` of the tool
 * result, an SDK task of the call that went to the background, or a
 * `run_in_background` input. The text of the result never marks a call.
 *
 * The command's own lifecycle -- progress, completion, the stop control -- is
 * published separately as an async task; this says only that the card has one.
 * Hence the AIR namespace rather than `claudeCode`: to a client without the
 * `asyncTasks` capability, which is never sent that lifecycle, the marker would
 * promise a card state it has no way to ever resolve.
 */
export function backgroundedBashToolCall(
  notification: SessionNotification,
  backgroundedToolCallIds: ReadonlySet<string>,
  asyncTasksSupported: boolean,
): SessionNotification {
  const update = notification.update;
  if (
    !asyncTasksSupported ||
    update.sessionUpdate !== "tool_call_update" ||
    !backgroundedToolCallIds.has(update.toolCallId)
  ) {
    return notification;
  }
  return {
    ...notification,
    update: {
      ...update,
      _meta: withAirMeta(update._meta, AIR_ASYNC_TASKS_CAPABILITY, { backgrounded: true }),
    },
  };
}
