/**
 * The `<task-notification>` inputs that Claude Code writes to a transcript
 * when a background task stops. The replay of a session (`acp-agent.ts`) and
 * the session index (`session-index/background-tasks.ts`) read them here, so
 * both read the same fields.
 */

export const TASK_NOTIFICATION_TAG = "task-notification";

/** The text between the first `<tag>` and the next `</tag>` after it. */
export function markerTagText(text: string, tag: string): string | undefined {
  const open = `<${tag}>`;
  const close = `</${tag}>`;
  const start = text.indexOf(open);
  if (start === -1) return undefined;
  const end = text.indexOf(close, start + open.length);
  if (end === -1) return undefined;
  return text.slice(start + open.length, end);
}

/** The fields of a persisted `<task-notification>`, in the shape of the SDK
 *  `task_notification` frame that reported the same stop live. */
export type PersistedTaskNotification = {
  task_id: string;
  status: string;
  tool_use_id?: string;
  summary?: string;
  output_file?: string;
};

/**
 * Returns each `<task-notification>` in user-message content (a string or its
 * text blocks). The `<result>` body is model context that the live frame does
 * not carry, so the scan stops at it and a tag quoted in it cannot match.
 *
 * Only a notification with a `<task-id>` and a `<status>` is returned. A
 * notification without a status comes while its task still runs: the
 * check-in of a quiet shell ("is still running after …") or a `Monitor`
 * event.
 */
export function taskNotificationsOf(content: unknown): PersistedTaskNotification[] {
  const texts =
    typeof content === "string"
      ? [content]
      : Array.isArray(content)
        ? content.flatMap((block) =>
            block?.type === "text" && typeof block.text === "string" ? [block.text as string] : [],
          )
        : [];
  const open = `<${TASK_NOTIFICATION_TAG}>`;
  const close = `</${TASK_NOTIFICATION_TAG}>`;
  const notifications: PersistedTaskNotification[] = [];
  for (const text of texts) {
    let start = text.indexOf(open);
    while (start !== -1) {
      const end = text.indexOf(close, start + open.length);
      if (end === -1) break;
      const body = text.slice(start + open.length, end).split("<result>", 1)[0];
      const field = (tag: string) => markerTagText(body, tag)?.trim() || undefined;
      const taskId = field("task-id");
      const status = field("status");
      if (taskId && status) {
        notifications.push({
          task_id: taskId,
          status,
          tool_use_id: field("tool-use-id"),
          summary: field("summary"),
          output_file: field("output-file"),
        });
      }
      start = text.indexOf(open, end + close.length);
    }
  }
  return notifications;
}
