/**
 * The background work of a session: the work that Claude Code keeps running
 * independently of the session's foreground work, which ACP v2 lists on every
 * `state_update` of the session as `background` (the v2 prompt lifecycle,
 * "Background work").
 *
 * The lists are built from Claude Code's live background task set
 * (`background_tasks_changed`), without the tasks it marks `ambient`, which
 * are housekeeping that it started on its own. The root session and each
 * announced subagent session (the subagents RFD form) has its own list. Each
 * task is listed once, in the list of the session that runs it:
 *
 * - A command that went to the background: its display terminal, from the
 *   Bash tool result until its task ends (`Session.backgroundTerminals`).
 * - A detached subagent: its child session, in its parent's list, while it
 *   works, and while it is idle with background work of its own.
 * - Any other task, such as a `Monitor` or a `Workflow`: a `_claude/task`
 *   item with the task's id and description. Its tool call ended at its tool
 *   result, so it cannot be listed as a tool call.
 *
 * Only a session whose interrupt spares background tasks reports its lists
 * (`Session.reportsBackground`): `session/cancel` must leave listed work
 * running.
 */
import { RequestError } from "@agentclientprotocol/sdk/unstable";
import type { AcpSessionNotification } from "./acp-subagents.js";
import type { NativeSubagent } from "./native-subagents.js";

/** An item of a `background` list. */
export type BackgroundItem =
  | { type: "terminal"; terminalId: string }
  | { type: "subagent"; sessionId: string }
  | { type: "_claude/task"; taskId: string; description: string };

/** The live background task set of `background_tasks_changed`, by task id. */
export type BackgroundLevel = Map<
  string,
  { ambient: boolean; taskType: string; description: string; parentTaskId?: string }
>;

/** The work state of a session, as its `state_update` names it. */
export type WorkStateName = "idle" | "running" | "requires_action" | "unknown";

/** A new list of the session `sessionId`, with what its repeated state needs. */
export interface BackgroundReport {
  sessionId: string;
  items: BackgroundItem[];
  /** The session's work state now, or undefined when it has none yet. */
  state: WorkStateName | undefined;
  /** The parent of a subagent session, which mirrors the child's state. */
  parentSessionId?: string;
}

/** Where the agent reports the lists (see the agent's `background` option). */
export interface BackgroundSink {
  /** The list of a session changed, or is reported for the first time. */
  changed(report: BackgroundReport): void;
  /** The session ended: its list is no longer reported. */
  forget(sessionId: string): void;
}

/** The state of a session that its lists are built from. */
export interface BackgroundWorkSession {
  reportsBackground?: boolean;
  backgroundLevel?: BackgroundLevel;
  backgroundTerminals?: Map<string, { toolCallId: string; parentToolUseId?: string }>;
  nativeSubagentsByTaskId?: Map<string, NativeSubagent>;
  query: { stopTask(taskId: string): Promise<void> };
}

/** The level of a `background_tasks_changed` payload. */
export function backgroundLevel(
  tasks: {
    task_id: string;
    task_type: string;
    description: string;
    parent_task_id?: string;
    ambient?: boolean;
  }[],
): BackgroundLevel {
  return new Map(
    tasks.map((task) => [
      task.task_id,
      {
        ambient: task.ambient === true,
        taskType: task.task_type,
        description: task.description,
        ...(task.parent_task_id !== undefined ? { parentTaskId: task.parent_task_id } : {}),
      },
    ]),
  );
}

/**
 * The `background` list of the root session `rootSessionId` and of each of
 * its announced subagent sessions, by session id, deeper sessions first and
 * the root last. Each list is empty while
 * the level has not been reported: Claude Code sends none before the first
 * background task starts.
 */
export function backgroundLists(
  session: BackgroundWorkSession,
  rootSessionId: string,
): Map<string, BackgroundItem[]> {
  const children = [...(session.nativeSubagentsByTaskId ?? [])].filter(
    ([, child]) => child.announced,
  );
  const childByTask = new Map(children);
  const childByToolUse = new Map(
    children.flatMap(([, child]) =>
      child.parentToolUseId ? [[child.parentToolUseId, child] as const] : [],
    ),
  );
  const lists = new Map<string, BackgroundItem[]>([
    [rootSessionId, []],
    ...children.map(([, child]): [string, BackgroundItem[]] => [child.sessionId, []]),
  ]);
  const level: BackgroundLevel = session.backgroundLevel ?? new Map();
  for (const [taskId, task] of level) {
    if (task.ambient) continue;
    const terminal = session.backgroundTerminals?.get(taskId);
    if (terminal) {
      // A subagent's command runs on the child's stream.
      const owner = terminal.parentToolUseId
        ? childByToolUse.get(terminal.parentToolUseId)?.sessionId
        : rootSessionId;
      if (owner) lists.get(owner)!.push({ type: "terminal", terminalId: terminal.toolCallId });
      continue;
    }
    // A command without a terminal yet is one that foreground work waits on.
    // A subagent is listed below, as its session.
    if (task.taskType === "local_bash" || task.taskType === "local_agent") continue;
    const parent = task.parentTaskId ? childByTask.get(task.parentTaskId) : undefined;
    lists
      .get(parent?.sessionId ?? rootSessionId)!
      .push({ type: "_claude/task", taskId, description: task.description });
  }
  // A child is listed in its parent's list while it works in the background,
  // and while it is idle with background work of its own. Deeper children
  // first, so a child's list is whole before its parent's reads it.
  const sessions = new Map(children.map(([, child]) => [child.sessionId, child]));
  const depth = (child: NativeSubagent): number => {
    const parent = sessions.get(child.parentSessionId);
    return parent ? depth(parent) + 1 : 0;
  };
  for (const [taskId, child] of children.sort(([, a], [, b]) => depth(b) - depth(a))) {
    const task = level.get(taskId);
    const working =
      child.workState !== undefined &&
      child.workState !== "idle" &&
      task !== undefined &&
      !task.ambient;
    if (working || lists.get(child.sessionId)!.length > 0) {
      lists.get(child.parentSessionId)?.push({ type: "subagent", sessionId: child.sessionId });
    }
  }
  // In the same order, the root last: a child's own list goes out before its
  // parent's list drops it.
  return new Map([
    ...children.map(([, child]): [string, BackgroundItem[]] => [
      child.sessionId,
      lists.get(child.sessionId)!,
    ]),
    [rootSessionId, lists.get(rootSessionId)!],
  ]);
}

/**
 * The tasks of the terminals that `level` does not hold: Claude Code no
 * longer runs them, so their terminals exit before a list drops them, as v2
 * requires. A terminal is registered at its Bash result, after its task
 * joined the level, so a later level without the task means that it ended.
 * Claude Code usually sends a task's end before that level, which ends the
 * terminal first, but the SDK does not promise that order.
 */
export function droppedTerminalTasks(
  session: BackgroundWorkSession,
  level: BackgroundLevel,
): string[] {
  return [...(session.backgroundTerminals?.keys() ?? [])].filter((taskId) => !level.has(taskId));
}

/**
 * Removes the terminal of the background command `taskId` of the session
 * `sessionId`, and returns the update that exits it, or undefined when the
 * command has no terminal. Claude Code reports no exit code for it, and
 * `completed` does not mean 0: Claude Code accepts some non-zero codes as a
 * success, such as grep's 1.
 */
export function takeBackgroundTerminalExit(
  session: BackgroundWorkSession,
  sessionId: string,
  taskId: string,
): AcpSessionNotification | undefined {
  const terminal = session.backgroundTerminals?.get(taskId);
  if (!terminal) return undefined;
  session.backgroundTerminals!.delete(taskId);
  return {
    sessionId,
    update: {
      sessionUpdate: "tool_call_update",
      toolCallId: terminal.toolCallId,
      _meta: {
        ...(terminal.parentToolUseId
          ? { claudeCode: { parentToolUseId: terminal.parentToolUseId } }
          : {}),
        terminal_exit: { terminal_id: terminal.toolCallId, exit_code: null, signal: null },
      },
    },
  };
}

/**
 * Ends the background work of a session whose query closed: Claude Code's
 * background tasks end with its process. Returns the updates that exit the
 * root session's terminals, and empties the level, so the next lists are
 * empty. A subagent's command is left as it was: its terminal is on the
 * child's stream, which the closed query's routing owned.
 */
export function endBackgroundWork(
  session: BackgroundWorkSession,
  sessionId: string,
): AcpSessionNotification[] {
  if (!session.reportsBackground) return [];
  const exits = [...(session.backgroundTerminals ?? [])].flatMap(([taskId, terminal]) => {
    const exit = terminal.parentToolUseId
      ? undefined
      : takeBackgroundTerminalExit(session, sessionId, taskId);
    return exit ? [exit] : [];
  });
  session.backgroundLevel = undefined;
  return exits;
}

/**
 * Stops the background command whose terminal `terminalId` the session
 * `sessionId` lists (v2 `terminal/cancel`). `sessions` are the root sessions,
 * by id: a subagent session's list is built with its root's. The terminal
 * exits when Claude Code reports the task stopped.
 */
export async function cancelBackgroundTerminal(
  sessions: Record<string, BackgroundWorkSession>,
  sessionId: string,
  terminalId: string,
): Promise<void> {
  const notCancellable = () =>
    RequestError.invalidParams(
      { sessionId, terminalId },
      `Terminal ${terminalId} is not a command running in the background, so it cannot be cancelled.`,
    );
  const listed = (root: string, session: BackgroundWorkSession) =>
    session.reportsBackground === true &&
    (backgroundLists(session, root)
      .get(sessionId)
      ?.some((item) => item.type === "terminal" && item.terminalId === terminalId) ??
      false);
  const owner = Object.entries(sessions).find(([root, session]) => listed(root, session));
  if (!owner) throw notCancellable();
  const [root, session] = owner;
  const taskId = [...(session.backgroundTerminals ?? [])].find(
    ([, terminal]) => terminal.toolCallId === terminalId,
  )![0];
  try {
    await session.query.stopTask(taskId);
  } catch (error) {
    // The command ended meanwhile: it has exited, or is about to.
    if (!listed(root, session)) throw notCancellable();
    throw error;
  }
}

/**
 * Publishes the lists of each session that reports them, each time one
 * changes. The sink sends them to the client synchronously, so a list follows
 * the updates sent before it.
 */
export class BackgroundWorkReporter {
  /** The list last published for each session, as JSON, and the root session it is built with. */
  private readonly published = new Map<string, { json: string; root: string }>();

  constructor(private readonly sink?: BackgroundSink) {}

  /** Whether the lists are reported at all. */
  get enabled(): boolean {
    return this.sink !== undefined;
  }

  /**
   * Publishes each list of the root session `rootSessionId` that changed. The
   * first call for a session publishes its list, also when it is empty.
   * `rootState` is the root session's state now.
   */
  sync(rootSessionId: string, session: BackgroundWorkSession, rootState: WorkStateName): void {
    if (!this.sink || !session.reportsBackground) return;
    const children = new Map(
      [...(session.nativeSubagentsByTaskId?.values() ?? [])].map((child) => [
        child.sessionId,
        child,
      ]),
    );
    for (const [sessionId, items] of backgroundLists(session, rootSessionId)) {
      const json = JSON.stringify(items);
      if (this.published.get(sessionId)?.json === json) continue;
      this.published.set(sessionId, { json, root: rootSessionId });
      const child = children.get(sessionId);
      this.sink.changed({
        sessionId,
        items,
        state: child ? workStateName(child.workState) : rootState,
        ...(child ? { parentSessionId: child.parentSessionId } : {}),
      });
    }
  }

  /** The root session `rootSessionId` ended, and its subagent sessions with it. */
  forget(rootSessionId: string): void {
    for (const [sessionId, { root }] of this.published) {
      if (root !== rootSessionId) continue;
      this.published.delete(sessionId);
      this.sink?.forget(sessionId);
    }
  }
}

/** A child's work state, when it is one that v2 names. */
function workStateName(state: string | undefined): WorkStateName | undefined {
  return state === "idle" ||
    state === "running" ||
    state === "requires_action" ||
    state === "unknown"
    ? state
    : undefined;
}
