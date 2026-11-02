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
 * - A task that a tool call started, such as a `Monitor`, a `Workflow` or a
 *   backgrounded MCP call: that tool call, kept `in_progress` (or `paused`)
 *   from its tool result until its task ends (`Session.backgroundToolCalls`).
 * - Any other task, once its `task_started` came and the tool call that
 *   started it, if any, returned: a `_claude/task` item with the task's id
 *   and description. For example, a task whose tool call ended before the
 *   task joined the level.
 *
 * Only a session whose interrupt spares background tasks reports its lists
 * (`Session.reportsBackground`): `session/cancel` must leave listed work
 * running.
 */
import { RequestError } from "@agentclientprotocol/sdk/unstable";
import type { AcpSessionNotification } from "./acp-subagents.js";
import type { NativeSubagent } from "./native-subagents.js";
import { type AcpToolCallRenderer, V2_CANCELLED, V2_PAUSED } from "./tool-calls/renderer.js";

/** An item of a `background` list. */
export type BackgroundItem =
  | { type: "terminal"; terminalId: string }
  | { type: "tool_call"; toolCallId: string }
  | { type: "subagent"; sessionId: string }
  | { type: "_claude/task"; taskId: string; description: string };

/** A tool call whose task runs on in the background (see `Session.backgroundToolCalls`). */
export interface BackgroundToolCall {
  toolCallId: string;
  /** The tool use of the call, which Claude Code no longer caches after its result. */
  toolUse: { name: string; input: unknown };
  /** The subagent tool call that made the call, if any. */
  parentToolUseId?: string;
  paused?: boolean;
}

/** How a background task ended, as Claude Code reports it. Undefined when it did not say. */
export type BackgroundTaskEnd = "completed" | "failed" | "stopped" | undefined;

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
  backgroundToolCalls?: Map<string, BackgroundToolCall>;
  nativeSubagentsByTaskId?: Map<string, NativeSubagent>;
  liveBackgroundTasks?: Map<string, { parentToolUseId?: string; isSubagent: boolean }>;
  /** The tool uses whose result has not come yet, by id. */
  toolUseCache?: Record<string, unknown>;
  query: { stopTask(taskId: string): Promise<void> };
}

/** The tools whose structured result names the task that the call started. */
const TASK_TOOLS = new Set(["Monitor", "Workflow"]);

/**
 * Registers each tool call of a tool result message whose task goes on in
 * the background: a `Monitor` or `Workflow` call, whose structured result
 * names its task, or a call that a live task names as its tool use, such as
 * a backgrounded MCP call. The task must be in the level: one that ended
 * already, or that Claude Code marks `ambient`, leaves its call as it is.
 * Returns the ids of the calls, whose result then reports `in_progress` (see
 * `withRunningToolCall`).
 */
export function registerBackgroundToolCalls(
  session: BackgroundWorkSession,
  content: unknown,
  toolUseResult: unknown,
  toolUses: Record<string, { name: string; input: unknown }>,
  parentToolUseId: string | null,
): Set<string> {
  const registered = new Set<string>();
  if (!session.reportsBackground || !Array.isArray(content)) return registered;
  const results = content.filter(
    (block): block is { type: "tool_result"; tool_use_id: string; is_error?: boolean } =>
      typeof block === "object" &&
      block !== null &&
      block.type === "tool_result" &&
      typeof block.tool_use_id === "string" &&
      block.is_error !== true,
  );
  const structuredTaskId =
    results.length === 1 &&
    typeof toolUseResult === "object" &&
    toolUseResult !== null &&
    typeof (toolUseResult as { taskId?: unknown }).taskId === "string"
      ? (toolUseResult as { taskId: string }).taskId
      : undefined;
  for (const { tool_use_id: toolCallId } of results) {
    const toolUse = toolUses[toolCallId];
    if (!toolUse) continue;
    const taskId =
      (TASK_TOOLS.has(toolUse.name) ? structuredTaskId : undefined) ??
      [...(session.liveBackgroundTasks ?? [])].find(
        ([, task]) => task.parentToolUseId === toolCallId && !task.isSubagent,
      )?.[0];
    const task = taskId === undefined ? undefined : session.backgroundLevel?.get(taskId);
    if (
      !task ||
      task.ambient ||
      task.taskType === "local_bash" ||
      task.taskType === "local_agent"
    ) {
      continue;
    }
    (session.backgroundToolCalls ??= new Map()).set(taskId!, {
      toolCallId,
      toolUse,
      ...(parentToolUseId ? { parentToolUseId } : {}),
    });
    registered.add(toolCallId);
  }
  return registered;
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
    // A subagent's command or tool call runs on the child's stream.
    const ownerOf = (parentToolUseId: string | undefined) =>
      parentToolUseId ? childByToolUse.get(parentToolUseId)?.sessionId : rootSessionId;
    const terminal = session.backgroundTerminals?.get(taskId);
    if (terminal) {
      const owner = ownerOf(terminal.parentToolUseId);
      if (owner) lists.get(owner)!.push({ type: "terminal", terminalId: terminal.toolCallId });
      continue;
    }
    const toolCall = session.backgroundToolCalls?.get(taskId);
    if (toolCall) {
      const owner = ownerOf(toolCall.parentToolUseId);
      if (owner) lists.get(owner)!.push({ type: "tool_call", toolCallId: toolCall.toolCallId });
      continue;
    }
    // A command without a terminal yet is one that foreground work waits on.
    // A subagent is listed below, as its session.
    if (task.taskType === "local_bash" || task.taskType === "local_agent") continue;
    // A task joins the level before its `task_started`, and before the tool
    // call that starts it returns. Until both, the task is unknown or part of
    // that tool call, which the foreground work waits on. Claude Code drops a
    // tool use from its cache at the tool's result.
    const live = session.liveBackgroundTasks?.get(taskId);
    if (!live || (live.parentToolUseId && session.toolUseCache?.[live.parentToolUseId])) {
      continue;
    }
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
 * The tasks of the terminals and tool calls that `level` does not hold:
 * Claude Code no longer runs them, so they end before a list drops them, as
 * v2 requires. A terminal or tool call is registered at its tool result,
 * after its task joined the level, so a later level without the task means
 * that it ended. Claude Code usually sends a task's end before that level,
 * which ends them first, but the SDK does not promise that order.
 */
export function droppedTasks(session: BackgroundWorkSession, level: BackgroundLevel): string[] {
  return [
    ...(session.backgroundTerminals?.keys() ?? []),
    ...(session.backgroundToolCalls?.keys() ?? []),
  ].filter((taskId) => !level.has(taskId));
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
 * Removes the background tool call of the task `taskId` of the session
 * `sessionId`, and returns the update that gives it its final status, or
 * undefined when the task has no such call. A task that Claude Code stopped
 * is `cancelled`. One that ended without saying how, such as one that the
 * level dropped, is `completed`: it no longer runs, and reported no failure.
 */
export function takeBackgroundToolCallEnd(
  session: BackgroundWorkSession,
  sessionId: string,
  taskId: string,
  end: BackgroundTaskEnd,
): AcpSessionNotification | undefined {
  const toolCall = session.backgroundToolCalls?.get(taskId);
  if (!toolCall) return undefined;
  session.backgroundToolCalls!.delete(taskId);
  return toolCallStatusUpdate(
    sessionId,
    toolCall,
    end === "stopped" ? V2_CANCELLED : end === "failed" ? "failed" : "completed",
  );
}

/**
 * The update that reports the background tool call of the task `taskId` as
 * `paused`, or as `in_progress` again, when `paused` changes it. Claude Code
 * pauses a workflow this way.
 */
export function backgroundToolCallPause(
  session: BackgroundWorkSession,
  sessionId: string,
  taskId: string,
  paused: boolean,
): AcpSessionNotification | undefined {
  const toolCall = session.backgroundToolCalls?.get(taskId);
  if (!toolCall || (toolCall.paused ?? false) === paused) return undefined;
  toolCall.paused = paused;
  return toolCallStatusUpdate(sessionId, toolCall, paused ? V2_PAUSED : "in_progress");
}

/**
 * The current state of each background tool call in `toolCallIds` of the
 * root session `sessionId`: the call as `renderer` shows its tool use, with
 * its status now (see `ClaudeAcpAgent.publishBackgroundToolCalls`).
 */
export function backgroundToolCallStates(
  session: BackgroundWorkSession & { cwd: string },
  sessionId: string,
  toolCallIds: string[],
  renderer: AcpToolCallRenderer,
): AcpSessionNotification[] {
  return [...(session.backgroundToolCalls?.values() ?? [])]
    .filter((toolCall) => toolCallIds.includes(toolCall.toolCallId))
    .map((toolCall) => {
      const update = renderer.toolCall(
        { id: toolCall.toolCallId, ...toolCall.toolUse },
        { cwd: session.cwd },
      );
      const status = toolCall.paused ? V2_PAUSED : "in_progress";
      return { sessionId, update: { ...update, status } as AcpSessionNotification["update"] };
    });
}

function toolCallStatusUpdate(
  sessionId: string,
  toolCall: BackgroundToolCall,
  status: NonNullable<
    Extract<AcpSessionNotification["update"], { sessionUpdate: "tool_call_update" }>["status"]
  >,
): AcpSessionNotification {
  return {
    sessionId,
    update: {
      sessionUpdate: "tool_call_update",
      toolCallId: toolCall.toolCallId,
      status,
      ...(toolCall.parentToolUseId
        ? { _meta: { claudeCode: { parentToolUseId: toolCall.parentToolUseId } } }
        : {}),
    },
  };
}

/**
 * Ends the background work of a session whose query closed: Claude Code's
 * background tasks end with its process. Returns the updates that exit the
 * root session's terminals and cancel its tool calls, and empties the level,
 * so the next lists are empty. A subagent's command or tool call is left as
 * it was: it is on the child's stream, which the closed query's routing
 * owned.
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
  const ends = [...(session.backgroundToolCalls ?? [])].flatMap(([taskId, toolCall]) => {
    const end = toolCall.parentToolUseId
      ? undefined
      : takeBackgroundToolCallEnd(session, sessionId, taskId, "stopped");
    return end ? [end] : [];
  });
  session.backgroundLevel = undefined;
  return [...exits, ...ends];
}

/**
 * Stops the task of a terminal or tool call that the session `sessionId`
 * lists (v2 `terminal/cancel` and `tool_call/cancel`). `sessions` are the
 * root sessions, by id: a subagent session's list is built with its root's.
 * The terminal exits, or the tool call gets its final status, when Claude
 * Code reports the task stopped.
 */
export async function cancelBackgroundWork(
  sessions: Record<string, BackgroundWorkSession>,
  sessionId: string,
  target: { terminalId: string } | { toolCallId: string },
): Promise<void> {
  const notCancellable = () =>
    "terminalId" in target
      ? RequestError.invalidParams(
          { sessionId, terminalId: target.terminalId },
          `Terminal ${target.terminalId} is not a command running in the background, so it cannot be cancelled.`,
        )
      : RequestError.invalidParams(
          { sessionId, toolCallId: target.toolCallId },
          `Tool call ${target.toolCallId} is not running in the background, so it cannot be cancelled.`,
        );
  const isTarget = (item: BackgroundItem) =>
    "terminalId" in target
      ? item.type === "terminal" && item.terminalId === target.terminalId
      : item.type === "tool_call" && item.toolCallId === target.toolCallId;
  const listed = (root: string, session: BackgroundWorkSession) =>
    session.reportsBackground === true &&
    (backgroundLists(session, root).get(sessionId)?.some(isTarget) ?? false);
  const owner = Object.entries(sessions).find(([root, session]) => listed(root, session));
  if (!owner) throw notCancellable();
  const [root, session] = owner;
  const id = "terminalId" in target ? target.terminalId : target.toolCallId;
  const taskId = [
    ...(("terminalId" in target ? session.backgroundTerminals : session.backgroundToolCalls) ?? []),
  ].find(([, entry]) => entry.toolCallId === id)![0];
  try {
    await session.query.stopTask(taskId);
  } catch (error) {
    // The task ended meanwhile: it has ended on the client too, or is about to.
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
