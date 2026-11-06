/**
 * The background work of a session: the work that Claude Code keeps running
 * independently of the session's foreground work, which ACP v2 lists on every
 * `state_update` of the session as `background` (the v2 prompt lifecycle,
 * "Background work").
 *
 * The lists are built from Claude Code's live background task set
 * (`background_tasks_changed`). Claude Code marks `ambient` its own
 * housekeeping and every live-update watcher; those are left out, except a
 * task that a tool call started, such as a `Monitor` call's. The root session and each
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
import { type BackgroundOutput, BackgroundOutputTail } from "./background-output.js";

/** An item of a `background` list. */
export type BackgroundItem =
  | { type: "terminal"; terminalId: string }
  | { type: "tool_call"; toolCallId: string }
  | { type: "subagent"; sessionId: string }
  | { type: "_claude/task"; taskId: string; description: string };

/** The display terminal of a command that went to the background (see `Session.backgroundTerminals`). */
export interface BackgroundTerminal {
  /** The Bash tool call, whose id names the terminal. */
  toolCallId: string;
  /** The subagent tool call that ran the command, if any. */
  parentToolUseId?: string;
  /** The file that Claude Code writes the command's output to, from the Bash result. */
  outputFilePath?: string;
  /** Reads that file into the terminal while the command runs. */
  output?: BackgroundOutputTail;
}

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

/**
 * The state of a session that other modules own, and that the background
 * work reads: Claude Code's tasks as the consumer tracks them, the subagent
 * sessions, and the query that stops a task.
 */
export interface BackgroundOwner {
  liveBackgroundTasks: Map<string, { parentToolUseId?: string; isSubagent: boolean }>;
  nativeSubagentsByTaskId?: Map<string, NativeSubagent>;
  query: { stopTask(taskId: string): Promise<void> };
}

/** A task of a `background_tasks_changed` payload. */
export type LevelTask = {
  task_id: string;
  task_type: string;
  description: string;
  parent_task_id?: string;
  ambient?: boolean;
};

/** The most returned tool calls that {@link SessionBackgroundWork} remembers. */
const MAX_RETURNED_CALLS = 1024;

/** The tools whose structured result names the task that the call started. */
const TASK_TOOLS = new Set(["Monitor", "Workflow"]);

/**
 * The background work of one root session, and of its subagent sessions: the
 * terminals and tool calls of the tasks that run in the background, and what
 * the client is told of them.
 *
 * Terminals are kept for every client that renders them, as before the
 * background lists. The rest is kept only when `reported`.
 */
export class SessionBackgroundWork {
  /** Claude Code's live background task set, from its last `background_tasks_changed`. */
  private level: BackgroundLevel = new Map();
  /** The terminals of the commands that went to the background, by task id. */
  private readonly terminals = new Map<string, BackgroundTerminal>();
  /** The tool calls whose tasks went on in the background, by task id. */
  private readonly toolCalls = new Map<string, BackgroundToolCall>();
  /**
   * The tool calls that returned, oldest first. A task that a call started
   * is part of that call until it returns, and the foreground work waits on
   * it. The task's `task_started` can come after the call returned. Bounded
   * by {@link MAX_RETURNED_CALLS}: a task joins the level around the time its
   * call returns.
   */
  private readonly returned = new Set<string>();

  /**
   * `reported`: whether the client gets the lists. Only when Claude Code's
   * interrupt spares background tasks, as `perTaskStopAffordance` makes it.
   */
  constructor(
    private readonly sessionId: string,
    readonly reported: boolean,
  ) {}

  /**
   * Keeps the display terminal of the command `taskId` running after its Bash
   * result, until its task ends (see `withRunningTerminal`).
   */
  terminalStarted(taskId: string, terminal: BackgroundTerminal): void {
    this.terminals.set(taskId, terminal);
  }

  /**
   * Reads what a tool result message tells of the background tasks:
   *
   * - The returned calls no longer hold the tasks that they started.
   * - Each call whose task goes on in the background is registered: a
   *   `Monitor` or `Workflow` call, whose structured result names its task,
   *   or a call that a live task names as its tool use, such as a
   *   backgrounded MCP call. The task must be in the level: one that ended
   *   already leaves its call as it is. Claude Code marks every live-update
   *   watcher `ambient`, including the task of a `Monitor` call; a call
   *   started it, so it is work the client can see and stop, and is
   *   registered all the same. Ambient tasks without a call of their own,
   *   such as watchers Claude Code starts by itself, are never registered.
   *
   * Returns the ids of the registered calls, whose result then reports
   * `in_progress` (see `withRunningToolCall`).
   */
  toolResults(
    owner: BackgroundOwner,
    content: unknown,
    toolUseResult: unknown,
    toolUses: Record<string, { name: string; input: unknown }>,
    parentToolUseId: string | null,
  ): Set<string> {
    const registered = new Set<string>();
    if (!this.reported || !Array.isArray(content)) return registered;
    const results = content.filter(
      (block): block is { type: "tool_result"; tool_use_id: string; is_error?: boolean } =>
        typeof block === "object" &&
        block !== null &&
        block.type === "tool_result" &&
        typeof block.tool_use_id === "string",
    );
    for (const { tool_use_id: toolCallId } of results) {
      this.returned.add(toolCallId);
      if (this.returned.size > MAX_RETURNED_CALLS) {
        this.returned.delete(this.returned.values().next().value!);
      }
    }
    const succeeded = results.filter((block) => block.is_error !== true);
    const structuredTaskId =
      succeeded.length === 1 &&
      typeof toolUseResult === "object" &&
      toolUseResult !== null &&
      typeof (toolUseResult as { taskId?: unknown }).taskId === "string"
        ? (toolUseResult as { taskId: string }).taskId
        : undefined;
    for (const { tool_use_id: toolCallId } of succeeded) {
      const toolUse = toolUses[toolCallId];
      if (!toolUse) continue;
      const taskId =
        (TASK_TOOLS.has(toolUse.name) ? structuredTaskId : undefined) ??
        [...owner.liveBackgroundTasks].find(
          ([, task]) => task.parentToolUseId === toolCallId && !task.isSubagent,
        )?.[0];
      const task = taskId === undefined ? undefined : this.level.get(taskId);
      if (!task || task.taskType === "local_bash" || task.taskType === "local_agent") {
        continue;
      }
      this.toolCalls.set(taskId!, {
        toolCallId,
        toolUse,
        ...(parentToolUseId ? { parentToolUseId } : {}),
      });
      registered.add(toolCallId);
    }
    return registered;
  }

  /**
   * Starts reading the output of the background command `taskId` into its
   * terminal, when the client gets the lists and the Bash result named the
   * command's output file. `send` sends an update of the terminal's tool
   * call, routed as the call's other updates. Called once the Bash result's
   * own updates are sent: the first output replaces the placeholder that they
   * gave the terminal.
   */
  followOutput(taskId: string, send: Send): void {
    const terminal = this.terminals.get(taskId);
    if (!this.reported || !terminal?.outputFilePath || terminal.output) return;
    terminal.output = new BackgroundOutputTail(terminal.outputFilePath, (output) =>
      send(terminalOutputUpdate(this.sessionId, terminal, output)),
    );
  }

  /**
   * The task `taskId` ended. Reads the rest of its command's output, then
   * exits its terminal, and gives a tool call whose task it was its final
   * status: `cancelled` for a task that Claude Code stopped, and `completed`
   * for one that ended without saying how, such as one that the level
   * dropped: it no longer runs, and reported no failure. Claude Code reports
   * no exit code for a command, and `completed` does not mean 0: Claude Code
   * accepts some non-zero codes as a success, such as grep's 1.
   */
  async taskEnded(taskId: string, end: BackgroundTaskEnd, send: Send): Promise<void> {
    const terminal = this.terminals.get(taskId);
    if (terminal) {
      await terminal.output?.finish();
      this.terminals.delete(taskId);
      await send(terminalExit(this.sessionId, terminal));
    }
    const toolCall = this.toolCalls.get(taskId);
    if (toolCall) {
      this.toolCalls.delete(taskId);
      await send(
        toolCallStatusUpdate(
          this.sessionId,
          toolCall,
          end === "stopped" ? V2_CANCELLED : end === "failed" ? "failed" : "completed",
        ),
      );
    }
  }

  /**
   * The update that reports the background tool call of the task `taskId` as
   * `paused`, or as `in_progress` again, when `paused` changes it. Claude Code
   * pauses a workflow this way.
   */
  taskPaused(taskId: string, paused: boolean): AcpSessionNotification | undefined {
    const toolCall = this.toolCalls.get(taskId);
    if (!toolCall || (toolCall.paused ?? false) === paused) return undefined;
    toolCall.paused = paused;
    return toolCallStatusUpdate(this.sessionId, toolCall, paused ? V2_PAUSED : "in_progress");
  }

  /**
   * Takes Claude Code's new live background task set. The terminals and tool
   * calls whose tasks it no longer holds end first, before a list drops them,
   * as v2 requires. A terminal or tool call is registered at its tool result,
   * after its task joined the level, so a later level without the task means
   * that it ended. Claude Code usually sends a task's end before that level,
   * which ends them first, but the SDK does not promise that order.
   */
  async levelChanged(tasks: LevelTask[], send: Send): Promise<void> {
    if (!this.reported) return;
    const level: BackgroundLevel = new Map(
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
    for (const taskId of [...this.terminals.keys(), ...this.toolCalls.keys()]) {
      if (!level.has(taskId)) await this.taskEnded(taskId, undefined, send);
    }
    this.level = level;
  }

  /**
   * The query closed: Claude Code's background tasks end with its process.
   * Stops reading output, and returns the updates that exit the root
   * session's terminals and cancel its tool calls. The level empties, so the
   * next lists are empty. A subagent's command or tool call is left as it
   * was: it is on the child's stream, which the closed query's routing owned.
   */
  queryClosed(): AcpSessionNotification[] {
    for (const terminal of this.terminals.values()) terminal.output?.stop();
    if (!this.reported) return [];
    const updates: AcpSessionNotification[] = [];
    for (const [taskId, terminal] of this.terminals) {
      if (terminal.parentToolUseId) continue;
      this.terminals.delete(taskId);
      updates.push(terminalExit(this.sessionId, terminal));
    }
    for (const [taskId, toolCall] of this.toolCalls) {
      if (toolCall.parentToolUseId) continue;
      this.toolCalls.delete(taskId);
      updates.push(toolCallStatusUpdate(this.sessionId, toolCall, V2_CANCELLED));
    }
    this.level = new Map();
    this.returned.clear();
    return updates;
  }

  /**
   * The `background` list of the root session and of each of its announced
   * subagent sessions, with what their repeated states need, deeper sessions
   * first and the root last: a child's own list goes out before its parent's
   * list drops it. Each list is empty while the level has not been reported:
   * Claude Code sends none before the first background task starts.
   */
  reports(owner: BackgroundOwner, rootState: WorkStateName): BackgroundReport[] {
    const children = [...(owner.nativeSubagentsByTaskId ?? [])].filter(
      ([, child]) => child.announced,
    );
    const childByTask = new Map(children);
    const childByToolUse = new Map(
      children.flatMap(([, child]) =>
        child.parentToolUseId ? [[child.parentToolUseId, child] as const] : [],
      ),
    );
    const lists = new Map<string, BackgroundItem[]>([
      [this.sessionId, []],
      ...children.map(([, child]): [string, BackgroundItem[]] => [child.sessionId, []]),
    ]);
    // A subagent's command or tool call runs on the child's stream.
    const ownerOf = (parentToolUseId: string | undefined) =>
      parentToolUseId ? childByToolUse.get(parentToolUseId)?.sessionId : this.sessionId;
    for (const [taskId, task] of this.level) {
      // A registered call's task is listed even when ambient, as a `Monitor`
      // call's is (see `toolResults`).
      const toolCall = this.toolCalls.get(taskId);
      if (toolCall) {
        const session = ownerOf(toolCall.parentToolUseId);
        if (session)
          lists.get(session)!.push({ type: "tool_call", toolCallId: toolCall.toolCallId });
        continue;
      }
      if (task.ambient) continue;
      const terminal = this.terminals.get(taskId);
      if (terminal) {
        const session = ownerOf(terminal.parentToolUseId);
        if (session)
          lists.get(session)!.push({ type: "terminal", terminalId: terminal.toolCallId });
        continue;
      }
      // A command without a terminal yet is one that foreground work waits on.
      // A subagent is listed below, as its session.
      if (task.taskType === "local_bash" || task.taskType === "local_agent") continue;
      // A task joins the level before its `task_started`, and before the tool
      // call that starts it returns. Until both, the task is unknown or part
      // of that tool call.
      const live = owner.liveBackgroundTasks.get(taskId);
      if (!live || (live.parentToolUseId && !this.returned.has(live.parentToolUseId))) continue;
      const parent = task.parentTaskId ? childByTask.get(task.parentTaskId) : undefined;
      lists
        .get(parent?.sessionId ?? this.sessionId)!
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
    const ordered = children.sort(([, a], [, b]) => depth(b) - depth(a));
    for (const [taskId, child] of ordered) {
      const task = this.level.get(taskId);
      const working =
        child.workState !== undefined &&
        child.workState !== "idle" &&
        task !== undefined &&
        !task.ambient;
      if (working || lists.get(child.sessionId)!.length > 0) {
        lists.get(child.parentSessionId)?.push({ type: "subagent", sessionId: child.sessionId });
      }
    }
    return [
      ...ordered.map(([, child]) => ({
        sessionId: child.sessionId,
        items: lists.get(child.sessionId)!,
        state: workStateName(child.workState),
        parentSessionId: child.parentSessionId,
      })),
      { sessionId: this.sessionId, items: lists.get(this.sessionId)!, state: rootState },
    ];
  }

  /**
   * The current state of each background tool call in `toolCallIds`: the
   * call as `renderer` shows its tool use, with its status now (see
   * `ClaudeAcpAgent.publishBackgroundToolCalls`).
   */
  toolCallStates(
    toolCallIds: string[],
    renderer: AcpToolCallRenderer,
    cwd: string,
  ): AcpSessionNotification[] {
    return [...this.toolCalls.values()]
      .filter((toolCall) => toolCallIds.includes(toolCall.toolCallId))
      .map((toolCall) => {
        const update = renderer.toolCall({ id: toolCall.toolCallId, ...toolCall.toolUse }, { cwd });
        const status = toolCall.paused ? V2_PAUSED : "in_progress";
        return {
          sessionId: this.sessionId,
          update: { ...update, status } as AcpSessionNotification["update"],
        };
      });
  }

  /**
   * The task of the terminal or tool call `target` that the session
   * `sessionId` lists, or undefined when it lists no such item.
   */
  listedTask(
    owner: BackgroundOwner,
    sessionId: string,
    target: BackgroundTarget,
  ): string | undefined {
    if (!this.reported) return undefined;
    const listed = this.reports(owner, "idle")
      .find((report) => report.sessionId === sessionId)
      ?.items.some((item) =>
        "terminalId" in target
          ? item.type === "terminal" && item.terminalId === target.terminalId
          : item.type === "tool_call" && item.toolCallId === target.toolCallId,
      );
    if (!listed) return undefined;
    const id = "terminalId" in target ? target.terminalId : target.toolCallId;
    const entries = "terminalId" in target ? this.terminals : this.toolCalls;
    return [...entries].find(([, entry]) => entry.toolCallId === id)?.[0];
  }
}

type Send = (notification: AcpSessionNotification) => Promise<void>;

/** A terminal or tool call that `terminal/cancel` or `tool_call/cancel` names. */
export type BackgroundTarget = { terminalId: string } | { toolCallId: string };

/**
 * Stops the task of a terminal or tool call that the session `sessionId`
 * lists (v2 `terminal/cancel` and `tool_call/cancel`). `sessions` are the
 * root sessions: a subagent session's list is built with its root's. The
 * terminal exits, or the tool call gets its final status, when Claude Code
 * reports the task stopped.
 */
export async function cancelBackgroundWork(
  sessions: Array<BackgroundOwner & { background?: SessionBackgroundWork }>,
  sessionId: string,
  target: BackgroundTarget,
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
  for (const session of sessions) {
    const taskId = session.background?.listedTask(session, sessionId, target);
    if (taskId === undefined) continue;
    try {
      await session.query.stopTask(taskId);
    } catch (error) {
      // The task ended meanwhile: it has ended on the client too, or is about to.
      if (session.background?.listedTask(session, sessionId, target) === undefined) {
        throw notCancellable();
      }
      throw error;
    }
    return;
  }
  throw notCancellable();
}

/** The update that gives the terminal of `terminal` the text `output`. */
function terminalOutputUpdate(
  sessionId: string,
  terminal: BackgroundTerminal,
  output: BackgroundOutput,
): AcpSessionNotification {
  const data = { terminal_id: terminal.toolCallId, data: output.text };
  return {
    sessionId,
    update: {
      sessionUpdate: "tool_call_update",
      toolCallId: terminal.toolCallId,
      _meta: {
        ...(terminal.parentToolUseId
          ? { claudeCode: { parentToolUseId: terminal.parentToolUseId } }
          : {}),
        ...(output.replaces ? { terminal_output: data } : { terminal_output_delta: data }),
      },
    },
  };
}

/** The update that exits the terminal of `terminal`, with no exit code. */
function terminalExit(sessionId: string, terminal: BackgroundTerminal): AcpSessionNotification {
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
  sync(
    rootSessionId: string,
    session: BackgroundOwner & { background?: SessionBackgroundWork },
    rootState: WorkStateName,
  ): void {
    if (!this.sink || !session.background?.reported) return;
    for (const report of session.background.reports(session, rootState)) {
      const json = JSON.stringify(report.items);
      if (this.published.get(report.sessionId)?.json === json) continue;
      this.published.set(report.sessionId, { json, root: rootSessionId });
      this.sink.changed(report);
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
