import type { SessionNotification } from "@agentclientprotocol/sdk";
import { AIR_ASYNC_TASKS_CAPABILITY, withAirMeta } from "../air-extension.js";
import type { AsyncTaskStarted } from "../async-tasks.js";

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
 * The command's own lifecycle -- progress, completion, the stop control -- is
 * published separately as an async task; this says only that the card has one.
 * Hence the AIR namespace rather than `claudeCode`: to a client without the
 * `asyncTasks` capability, which is never sent that lifecycle, the marker would
 * promise a card state it has no way to ever resolve.
 */
export function backgroundedBashToolCall(
  notification: SessionNotification,
  task: AsyncTaskStarted | undefined,
  asyncTasksSupported: boolean,
): SessionNotification {
  const update = notification.update;
  const toolCallId = task ? nonBlankTaskField(task.toolCallId ?? task.tool_use_id) : undefined;
  if (
    !asyncTasksSupported ||
    !toolCallId ||
    update.sessionUpdate !== "tool_call_update" ||
    update.toolCallId !== toolCallId
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

/** The task fields arrive as `unknown` off the wire; only non-blank strings carry a link. */
function nonBlankTaskField(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}
