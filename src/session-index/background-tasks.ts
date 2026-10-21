/**
 * The background tasks of a session that did not end yet, from its transcript.
 *
 * A Claude Code session can start a background shell command or a background
 * sub-agent and end its turn at once. When the task ends, Claude Code wakes
 * the session with a `<task-notification>` input for a short turn. So a turn
 * end with an open task is no end of the work: the session list keeps such a
 * session `running` (see `activity.ts`).
 *
 * The records, as Claude Code 2.1.299 writes them, in the rules of AIR's
 * native Claude provider:
 *
 * - a tool result opens a task when its `toolUseResult` has a
 *   `backgroundTaskId` (a shell command), or `isAsync: true` with an
 *   `agentId` (a sub-agent);
 * - a task closes when its notification reaches the session: as a user
 *   record, or as a `queue-operation` `remove` when a running turn takes it
 *   in. A notification that waits in the queue (`enqueue`) keeps the task
 *   open, because the session still runs a turn for it;
 * - a `TaskStop` result closes the task of its `toolUseResult.task_id`:
 *   Claude Code writes no notification for it. The result does not name its
 *   tool, so its `tool_use_id` must match a `TaskStop` call. A `task_id` in
 *   the result of another tool keeps the task open;
 * - a resumed CLI writes a `stopped` notification for each task of the
 *   previous process;
 * - a sidechain record belongs to a sub-agent and opens or closes no task of
 *   the session.
 *
 * A background shell that does not end, for example a dev server, keeps its
 * task open, so its session stays `running` while the CLI holds it.
 *
 * A task that a sub-agent starts is not seen. Its start record is only in the
 * transcript of the sub-agent, so the session can be `idle` while the
 * sub-agent waits for it.
 */

import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

export type BackgroundTasks = {
  /** The ids of the tasks that started and did not end, in start order. */
  open: string[];
  /** The `tool_use` ids of the `TaskStop` calls without a result. */
  stopCalls: string[];
  /** Whether the sets hold the records of the whole file. A set from the
   *  tail window only does not know a task that started before it. */
  complete: boolean;
};

/** The fields of a transcript record that bear on a task. */
type TranscriptRecord = {
  type?: string;
  isSidechain?: boolean;
  /** Of a `queue-operation` record: `enqueue`, `remove`, ... */
  operation?: string;
  /** Of a `queue-operation` record: the queued input. */
  content?: string;
  message?: { content?: string | ContentBlock[] };
  toolUseResult?: ToolUseResult;
};

type ContentBlock = {
  type?: string;
  text?: string;
  /** Of a `tool_use` block. */
  id?: string;
  name?: string;
  /** Of a `tool_result` block. */
  tool_use_id?: string;
};

type ToolUseResult = {
  /** The task of a background shell command. */
  backgroundTaskId?: string;
  /** With `agentId`: an async sub-agent. */
  isAsync?: boolean;
  agentId?: string;
  /** The task that a `TaskStop` call stopped. Another tool can give one. */
  task_id?: string;
};

/** Text that a line must hold to bear on a task, so that the other lines
 *  are not parsed. */
const TASK_MARKERS = [
  "backgroundTaskId",
  '"isAsync"',
  "<task-notification>",
  "TaskStop",
  "task_id",
];

const NOTIFICATION_TAG = "<task-notification>";
const TASK_ID_PATTERN = /<task-id>([\s\S]*?)<\/task-id>/;
/** A notification states its task id at its start; a large sub-agent result
 *  follows it. */
const NOTIFICATION_HEAD_CHARS = 4096;

function parseRecord(line: string): TranscriptRecord | undefined {
  try {
    return JSON.parse(line) as TranscriptRecord;
  } catch {
    return undefined;
  }
}

function blocksOf(record: TranscriptRecord): ContentBlock[] {
  const content = record.message?.content;
  return Array.isArray(content) ? content : [];
}

/** The input of a user record: its string content, else its first text
 *  block. */
function inputTextOf(record: TranscriptRecord): string | undefined {
  const content = record.message?.content;
  if (typeof content === "string") return content;
  return blocksOf(record).find((block) => block.type === "text")?.text;
}

/** The task id of a `<task-notification>` input, as AIR's `TaskNotification`
 *  reads it: only an input that starts with the tag, after whitespace. */
export function notifiedTaskId(input: string | undefined): string | undefined {
  const notification = input?.trimStart();
  if (!notification?.startsWith(NOTIFICATION_TAG)) return undefined;
  const head = notification.slice(0, NOTIFICATION_HEAD_CHARS);
  const taskId = TASK_ID_PATTERN.exec(head)?.[1]?.trim();
  return taskId || undefined;
}

/** The task that a tool result started: a background shell command, or an
 *  async sub-agent. */
function startedTaskId(record: TranscriptRecord): string | undefined {
  if (record.type !== "user") return undefined;
  const result = record.toolUseResult;
  if (result?.backgroundTaskId) return result.backgroundTaskId;
  if (result?.isAsync) return result.agentId;
  return undefined;
}

/** The task whose notification reached the session: as a user record, or
 *  as a queue `remove` when a running turn takes it in. */
function deliveredTaskId(record: TranscriptRecord): string | undefined {
  if (record.type === "user") return notifiedTaskId(inputTextOf(record));
  if (record.type === "queue-operation" && record.operation === "remove") {
    return notifiedTaskId(record.content);
  }
  return undefined;
}

/** Collects the tasks of the lines it is given, in file order. */
class TaskTracker {
  private readonly open: Set<string>;
  private readonly stopCalls: Set<string>;

  constructor(after?: BackgroundTasks) {
    this.open = new Set(after?.open);
    this.stopCalls = new Set(after?.stopCalls);
  }

  add(line: string): void {
    const mayBearOnTask = TASK_MARKERS.some((marker) => line.includes(marker));
    if (!mayBearOnTask) return;
    const record = parseRecord(line);
    // A sidechain record belongs to a sub-agent, which receives the
    // notifications of its own tasks.
    if (!record || record.isSidechain) return;
    this.apply(record);
  }

  result({ complete }: { complete: boolean }): BackgroundTasks {
    return { open: [...this.open], stopCalls: [...this.stopCalls], complete };
  }

  private apply(record: TranscriptRecord): void {
    const started = startedTaskId(record);
    if (started) this.open.add(started);
    const delivered = deliveredTaskId(record);
    if (delivered) this.open.delete(delivered);
    this.applyTaskStop(record);
  }

  /** A `task_id` stops its task only in the result of a `TaskStop` call:
   *  another tool can give a `task_id` too. */
  private applyTaskStop(record: TranscriptRecord): void {
    let isTaskStopResult = false;
    for (const block of blocksOf(record)) {
      if (block.type === "tool_use" && block.name === "TaskStop" && block.id) {
        this.stopCalls.add(block.id);
      }
      const resultId = block.tool_use_id;
      if (resultId && this.stopCalls.has(resultId)) {
        this.stopCalls.delete(resultId);
        isTaskStopResult = true;
      }
    }
    const stopped = record.toolUseResult?.task_id;
    if (isTaskStopResult && stopped) this.open.delete(stopped);
  }
}

/**
 * The tasks of the lines of `text`, applied on the tasks `after`.
 *
 * `after` can be what an earlier scan found for a shorter copy of the file,
 * and `text` can repeat records of that copy. The result is still the same:
 * the last record that opens or closes a task decides, and `text` holds the
 * last records.
 */
export function backgroundTasksOf(
  text: string,
  options: { complete: boolean; after?: BackgroundTasks },
): BackgroundTasks {
  const tracker = new TaskTracker(options.after);
  for (const line of text.split("\n")) tracker.add(line);
  return tracker.result({ complete: options.complete });
}

/** The tasks of the first `size` bytes of `filePath`, from all its records.
 *  Reads the whole file, so only for a session that a live process holds. */
export async function searchBackgroundTasks(
  filePath: string,
  size: number,
): Promise<BackgroundTasks> {
  const tracker = new TaskTracker();
  if (size === 0) return tracker.result({ complete: true });
  const stream = createReadStream(filePath, { start: 0, end: size - 1, encoding: "utf8" });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of lines) tracker.add(line);
  return tracker.result({ complete: true });
}
