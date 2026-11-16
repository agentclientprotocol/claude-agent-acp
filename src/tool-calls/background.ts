import type { SessionNotification } from "@agentclientprotocol/sdk/unstable";
import { AIR_ASYNC_TASKS_CAPABILITY, withAirMeta } from "../air-extension.js";
import { parseToolResultMeta } from "../tool-result-meta.js";

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

/**
 * Keeps the display terminal of a command that went to the background running:
 * drops `terminal_exit` from the tool result update of `toolCallId`.
 *
 * The Bash call returns as soon as the command detaches, so that exit would
 * mark the terminal as ended while the command still runs. The consumer sends
 * the exit when the command's task ends (see `Session.backgroundTerminals`).
 */
export function withRunningTerminal(
  notification: SessionNotification,
  toolCallId: string | undefined,
): SessionNotification {
  const update = notification.update;
  if (
    toolCallId === undefined ||
    update.sessionUpdate !== "tool_call_update" ||
    update.toolCallId !== toolCallId ||
    !update._meta ||
    !("terminal_exit" in update._meta)
  ) {
    return notification;
  }
  const meta = { ...update._meta };
  delete meta.terminal_exit;
  const next: typeof update = { ...update, _meta: meta };
  // An empty `_meta` would clear what a v2 client stores for the tool call.
  if (Object.keys(meta).length === 0) delete next._meta;
  return { ...notification, update: next };
}

/**
 * How the tool result of each command whose terminal got output as the command
 * ran reaches that terminal, by tool call id (see `withStreamedTerminal`).
 */
export type StreamedTerminals = ReadonlyMap<string, "replace" | "append">;

/**
 * How the tool results of the commands `shown`, whose terminals got output as
 * they ran, reach those terminals. A result that carries the command's whole
 * output replaces what the terminal showed. Two results carry a text of Claude
 * Code instead, so that text is appended to what the terminal showed:
 * - the result of `backgrounded`, the command that went to the background:
 *   "Command running in background";
 * - a result that `toolResultMeta` (the `tool_result_meta` of the result's
 *   message) stamps as not executed. CLI 2.1.325 stamps the command that a
 *   `session/cancel` stopped `user-rejected`, and its result is the notice
 *   "The user doesn't want to proceed with this tool use".
 */
export function streamedTerminals(
  shown: readonly string[],
  backgrounded: string | undefined,
  toolResultMeta: unknown,
): StreamedTerminals {
  const notExecuted = parseToolResultMeta(toolResultMeta);
  return new Map(
    shown.map((toolCallId) => [
      toolCallId,
      toolCallId === backgrounded || notExecuted?.has(toolCallId) ? "append" : "replace",
    ]),
  );
}

/**
 * Makes the output of the tool result update of a command in `streamed` reach
 * its terminal as `streamed` says. The terminal showed the command's output as
 * it ran (see `SessionBackgroundWork.followForeground`):
 * - `replace`: the output goes as `terminal_output`. The result carries the
 *   whole output again, also the end that the last read missed.
 * - `append`: the output goes as `terminal_output_delta`, after what the
 *   terminal showed.
 *
 * Without this, the client's kind decides: the result of a client that appends
 * chunks would repeat the output, and the result of any other client, such as
 * a v2 client, would replace it also with a notice.
 */
export function withStreamedTerminal(
  notification: SessionNotification,
  streamed: StreamedTerminals,
): SessionNotification {
  const update = notification.update;
  const how = update.sessionUpdate === "tool_call_update" && streamed.get(update.toolCallId);
  if (update.sessionUpdate !== "tool_call_update" || !how || !update._meta) return notification;
  const { terminal_output_delta: delta, terminal_output: whole, ...meta } = update._meta;
  const output: unknown = delta ?? whole;
  if (output === undefined) return notification;
  return {
    ...notification,
    update: {
      ...update,
      _meta: {
        ...meta,
        ...(how === "replace" ? { terminal_output: output } : { terminal_output_delta: output }),
      },
    },
  };
}

/**
 * Keeps the tool call of a task that went on in the background running: the
 * tool result update of a tool call in `toolCallIds` reports `in_progress`
 * instead of `completed`.
 *
 * A Monitor or Workflow call returns as soon as its task starts. The consumer
 * reports the task's end, or its pause, on the tool call (see
 * `Session.backgroundToolCalls`).
 */
export function withRunningToolCall(
  notification: SessionNotification,
  toolCallIds: ReadonlySet<string>,
): SessionNotification {
  const update = notification.update;
  if (
    update.sessionUpdate !== "tool_call_update" ||
    !toolCallIds.has(update.toolCallId) ||
    update.status !== "completed"
  ) {
    return notification;
  }
  return { ...notification, update: { ...update, status: "in_progress" } };
}
