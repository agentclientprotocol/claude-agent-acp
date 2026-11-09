/**
 * Claude Code's tasks of one root session, as ACP v2 reports them: its
 * subagents as child sessions (the subagents RFD), and the work that runs in
 * the background as the `background` list of each session's states.
 *
 * Claude Code reports each task with `task_started`, then `task_updated`
 * patches, and its end with `task_notification` (or a terminal `task_updated`
 * patch, the only one it promises per transition). `background_tasks_changed`
 * is its live set of background tasks. From those:
 *
 * - A subagent (`local_agent`) is a child session whose id is its agent id,
 *   the same session for every delegation to it (a SendMessage resume starts
 *   it again under the same `task_id`). It is announced on its parent's
 *   stream (`parent_task_id`, or the root) with `subagent_update`, before
 *   any of its traffic. Its messages carry the `parent_tool_use_id` of the
 *   Agent call that launched it, also after a resume, and go to its stream.
 *   Each run of it is the child's foreground work: `running` from its start
 *   to its end, on its stream and mirrored on the parent's `subagent_update`.
 *   The parent's turn waits on a child that is not `is_backgrounded`; one in
 *   the background is listed in its parent's `background` while it works.
 * - A command that went to the background is its display terminal, kept
 *   running from its Bash result until its task ends, with its output read
 *   from the file Claude Code writes it to.
 * - A task that a tool call started, such as a `Monitor` or `Workflow` call,
 *   is that tool call, kept `in_progress` (or `paused`) until the task ends.
 * - Any other background task is a `_claude/task` item.
 *
 * Claude Code's interrupt spares background tasks (`perTaskStopAffordance`),
 * so `session/cancel` leaves listed work running, as v2 asks.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { RequestError } from "@agentclientprotocol/sdk/unstable";
import type * as v2 from "@agentclientprotocol/sdk/experimental/v2/unstable";
import type {
  SDKAssistantMessage,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { Logger } from "../acp-agent.js";
import type { AcpSessionNotification } from "../acp-subagents.js";
import { backgroundBashTaskFromToolResult } from "../async-tasks.js";
import { BackgroundOutputTail, type BackgroundOutput } from "../background-output.js";
import type { BackgroundItem, WorkStateName } from "../background-work.js";
import { withRunningTerminal, withRunningToolCall } from "../tool-calls/background.js";
import type { V2Background } from "../v2/background.js";
import type { V2UpdateTranslator } from "../v2/update-translator.js";
import { SessionOutput } from "./stream.js";

/** What the tasks need of their root session. */
export interface TaskHost {
  readonly sessionId: string;
  readonly cwd: string;
  readonly logger: Logger;
  readonly translator: V2UpdateTranslator;
  readonly background: V2Background;
  /** Sends an update of the root session or one of its children. */
  send(notification: v2.UpdateSessionNotification): void;
  /** The root session's foreground state now. */
  rootState(): WorkStateName;
  /** A child's open requests changed, which can block the root's foreground work. */
  foregroundRequestsChanged(): void;
  stopTask(taskId: string): Promise<void>;
}

/** Where a permission request or elicitation goes: the root session or a child. */
export interface RequestTarget {
  readonly sessionId: string;
  readonly cwd: string;
  /** The output of the session, which holds its tool calls. */
  readonly output: SessionOutput;
  /** Whether a cancel stops the work that the request belongs to. */
  cancelling(): boolean;
  requestPermission(
    request: v2.RequestPermissionRequest,
    signal: AbortSignal,
  ): Promise<v2.RequestPermissionResponse>;
  /**
   * Runs `send` as an open request of the target (`requires_action`) until it
   * settles. Its signal aborts with `signal`, or when a cancel or close
   * withdraws the target's requests.
   */
  openRequest<T>(signal: AbortSignal, send: (signal: AbortSignal) => Promise<T>): Promise<T>;
}

type ChildState = "idle" | "running" | "requires_action";

type IdleOutcome =
  | { stopReason: "end_turn" }
  | { stopReason: "cancelled" }
  | { stopReason: "error"; error: { code: number; message: string } };

type Child = {
  /** The child's session id: its agent id. */
  sessionId: string;
  parentSessionId: string;
  /** The Agent call that launched it, whose id its messages carry. */
  launchToolUseId: string | undefined;
  title: string;
  description: string | undefined;
  /** Whether its parent's work waits on its run (`is_backgrounded: false`). */
  foreground: boolean;
  /** Whether a run of it is going on: its foreground work. */
  working: boolean;
  /** The state its stream was told last. */
  reportedState: ChildState | undefined;
  /** How its last run ended. */
  outcome: IdleOutcome | undefined;
  /** Whether a cancel of it, or of the work waiting on it, stops its run. */
  cancelled: boolean;
  /** Whether its run's delegation went out as an incoming `session_message`. */
  delegationReported: boolean;
  openRequests: number;
  readonly requestAborts: Set<AbortController>;
  /** The working directory it was announced with, when not its parent's. */
  cwd: string | undefined;
  output: SessionOutput;
};

type ToolResultBlock = { type: "tool_result"; tool_use_id: string; is_error?: boolean };

/** A task of `background_tasks_changed`. */
type LevelTask = { ambient: boolean; taskType: string; description: string; parentTaskId?: string };

/** What `task_started` said of a task that is not a subagent. */
type StartedTask = { toolUseId?: string; parentTaskId?: string; taskType?: string };

/** How long a subagent's permission request waits for the subagent's `task_started`. */
const ANNOUNCE_WAIT_MS = 2000;

/** The tools whose structured result names the task that the call started. */
const TASK_TOOLS = new Set(["Monitor", "Workflow"]);

export class SessionTasks {
  /** The subagents, by agent id. */
  private readonly children = new Map<string, Child>();
  /** The child of each Agent call that launched or resumed one. */
  private readonly childByToolUse = new Map<string, Child>();
  /** The other tasks that `task_started` reported, until they end. */
  private readonly started = new Map<string, StartedTask>();
  /** Claude Code's live background tasks, from its last `background_tasks_changed`. */
  private level = new Map<string, LevelTask>();
  /** The terminals of the commands that went to the background, by task id. */
  private readonly terminals = new Map<
    string,
    { toolCallId: string; output: SessionOutput; tail?: BackgroundOutputTail; ending?: boolean }
  >();
  /** The tool calls whose tasks go on in the background, by task id. */
  private readonly toolCalls = new Map<
    string,
    { toolCallId: string; output: SessionOutput; paused: boolean }
  >();
  /** The tool calls that returned: their tasks no longer hold their work. */
  private readonly returned = new Set<string>();
  /** What a `SubagentStart` hook reported before the child was announced, by agent id. */
  private readonly startedHooks = new Map<string, { cwd: string; agentType: string }>();
  /** Permission requests waiting for their subagent's announcement, by agent id. */
  private readonly announceWaiters = new Map<string, Array<() => void>>();

  constructor(
    private readonly host: TaskHost,
    /** The root session's output, which owns its tool calls. */
    private readonly rootOutput: SessionOutput,
  ) {}

  // --- Claude Code's messages ---------------------------------------------

  /**
   * Takes a message of the query that concerns the tasks. Returns whether it
   * was a child's, which then goes to the child's stream only.
   */
  handle(message: SDKMessage): boolean {
    switch (message.type) {
      case "system":
        switch (message.subtype) {
          case "task_started":
            this.taskStarted(message);
            return true;
          case "task_updated":
            this.taskUpdated(message);
            return true;
          case "task_notification":
            this.taskEnded(message.task_id, message.status);
            return true;
          case "background_tasks_changed":
            this.levelChanged(message.tasks);
            return true;
          default:
            return false;
        }
      case "stream_event": {
        // A child's text comes whole, in its consolidated messages.
        return message.parent_tool_use_id !== null && this.childOf(message) !== undefined;
      }
      case "assistant": {
        const child = this.childOf(message);
        if (!child) return false;
        child.output.assistant({ ...message, parent_tool_use_id: null } as SDKAssistantMessage);
        return true;
      }
      case "user": {
        const child = this.childOf(message);
        if (!child) return false;
        this.childUserMessage(child, message);
        return true;
      }
      default:
        return false;
    }
  }

  /**
   * The tool results of the root session, or of a child (`output`): a
   * background command's terminal and a background task's tool call keep
   * running past them.
   */
  toolResults(output: SessionOutput, message: SDKUserMessage): void {
    const content = message.message.content;
    if (!Array.isArray(content)) return;
    const results = content.filter(
      (block) => block.type === "tool_result",
    ) as unknown as ToolResultBlock[];
    for (const { tool_use_id } of results) this.returned.add(tool_use_id);
    const toolUses = output.toolUses();

    const command = backgroundBashTaskFromToolResult(
      content,
      message.tool_use_result,
      toolUses,
      (toolUseId) =>
        [...this.started].find(
          ([, task]) => task.toolUseId === toolUseId && task.taskType === "local_bash",
        )?.[0],
    );
    // A fast command can end before its result: then its terminal exits with it.
    const runningTerminal =
      command && this.started.has(command.taskId) ? command.toolCallId : undefined;
    if (command && runningTerminal) {
      this.terminals.set(command.taskId, { toolCallId: command.toolCallId, output });
    }

    const runningToolCalls = new Set<string>();
    const succeeded = results.filter((block) => block.is_error !== true);
    const structuredTaskId =
      succeeded.length === 1 &&
      typeof message.tool_use_result === "object" &&
      message.tool_use_result !== null &&
      typeof (message.tool_use_result as { taskId?: unknown }).taskId === "string"
        ? (message.tool_use_result as { taskId: string }).taskId
        : undefined;
    for (const { tool_use_id: toolCallId } of succeeded) {
      const toolUse = toolUses[toolCallId];
      if (!toolUse || toolUse.name === "Bash" || toolUse.name === "Agent") continue;
      const taskId =
        (TASK_TOOLS.has(toolUse.name) ? structuredTaskId : undefined) ??
        [...this.started].find(([, task]) => task.toolUseId === toolCallId)?.[0];
      const task = taskId === undefined ? undefined : this.level.get(taskId);
      if (!task || task.taskType === "local_bash" || task.taskType === "local_agent") continue;
      this.toolCalls.set(taskId!, { toolCallId, output, paused: false });
      runningToolCalls.add(toolCallId);
    }

    // The helpers are typed for the SDK's notification; they only rewrite a tool call update.
    type Notification = Parameters<typeof withRunningTerminal>[0];
    output.toolResults(
      message,
      (notification) =>
        withRunningToolCall(
          withRunningTerminal(notification as Notification, runningTerminal),
          runningToolCalls,
        ) as AcpSessionNotification,
    );
    // After the result's own updates: the output replaces their placeholder.
    if (command && runningTerminal) {
      this.followOutput(
        command.taskId,
        typeof command.outputFilePath === "string" ? command.outputFilePath : undefined,
      );
    }
    this.publish();
  }

  // --- Subagent sessions ----------------------------------------------------

  /** Whether `sessionId` is a child session of this root. */
  hasChild(sessionId: string): boolean {
    return this.childSession(sessionId) !== undefined;
  }

  /**
   * The session that a permission request of the agent `agentId` goes to:
   * its child session, once announced, else the root. A request can come
   * before its subagent's `task_started`, so it waits for it a little.
   */
  async target(agentId: string | undefined, root: RequestTarget): Promise<RequestTarget> {
    if (agentId === undefined) return root;
    if (!this.children.has(agentId)) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, ANNOUNCE_WAIT_MS);
        const waiters = this.announceWaiters.get(agentId) ?? [];
        waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
        this.announceWaiters.set(agentId, waiters);
      });
    }
    const child = this.children.get(agentId);
    // Not announced: its request stays the root's, as its other traffic does.
    if (!child) return root;
    return {
      sessionId: child.sessionId,
      cwd: child.cwd ?? this.host.cwd,
      output: child.output,
      cancelling: () => child.cancelled,
      requestPermission: (request, toolSignal) =>
        this.childRequest(child, toolSignal, async (signal) => {
          try {
            return await this.hostRequest(request, signal);
          } catch (error) {
            if (signal.aborted) return { outcome: { outcome: "cancelled" } };
            throw error;
          }
        }),
      openRequest: (signal, send) => this.childRequest(child, signal, send),
    };
  }

  /**
   * Whether the root's foreground work waits on a child that waits on the
   * user: a child it does not run in the background, or one of that child's.
   */
  foregroundBlocked(): boolean {
    return this.foregroundChildren(this.host.sessionId).some((child) => child.openRequests > 0);
  }

  /**
   * The root's foreground work is cancelled: so is the work of the children
   * that it waits on. Their open requests are withdrawn. Claude Code's
   * interrupt stops their runs, which then end `cancelled`.
   */
  cancelForeground(): void {
    for (const child of this.foregroundChildren(this.host.sessionId)) this.withdraw(child);
  }

  /** The root session closes: every child's open request is withdrawn. */
  withdrawAll(): void {
    for (const child of this.children.values()) this.withdraw(child);
  }

  /**
   * `session/cancel` of a child: stops its run, and the work of the children
   * that it waits on. Its idle reports `cancelled` once Claude Code reports
   * the task stopped. A child that does not work has nothing to stop.
   */
  async cancelChild(sessionId: string): Promise<void> {
    const child = this.childSession(sessionId);
    if (!child?.working) return;
    this.withdraw(child);
    for (const waited of this.foregroundChildren(child.sessionId)) this.withdraw(waited);
    try {
      await this.host.stopTask(child.sessionId);
    } catch (error) {
      // The run ended meanwhile, or Claude Code refused: it reports how it ends.
      child.cancelled = false;
      this.host.logger.error(`Subagent ${sessionId}: stopping it failed`, error);
    }
  }

  /** A `SubagentStart` hook: the child's working directory and type. */
  subagentStarted(agentId: string, cwd: string, agentType: string): void {
    const child = this.children.get(agentId);
    if (!child) {
      this.startedHooks.set(agentId, { cwd, agentType });
      return;
    }
    this.reportCwd(child, cwd);
  }

  // --- Background work ----------------------------------------------------------

  /**
   * Stops the listed terminal or tool call of `sessionId` (`terminal/cancel`
   * and `tool_call/cancel`). It ends when Claude Code reports its task stopped.
   */
  async cancelItem(
    sessionId: string,
    target: { terminalId: string } | { toolCallId: string },
  ): Promise<boolean> {
    const listed = this.lists().get(sessionId) ?? [];
    const taskId =
      "terminalId" in target
        ? listed.some((item) => item.type === "terminal" && item.terminalId === target.terminalId)
          ? [...this.terminals].find(([, t]) => t.toolCallId === target.terminalId)?.[0]
          : undefined
        : listed.some((item) => item.type === "tool_call" && item.toolCallId === target.toolCallId)
          ? [...this.toolCalls].find(([, t]) => t.toolCallId === target.toolCallId)?.[0]
          : undefined;
    if (taskId === undefined) return false;
    await this.host.stopTask(taskId);
    return true;
  }

  /**
   * The current state of the children and of the listed work, for a resume
   * of the active session: each child's announcement, parent before child,
   * with its current state, and each listed item's current update.
   */
  currentState(): v2.UpdateSessionNotification[] {
    const updates: v2.UpdateSessionNotification[] = [];
    for (const child of this.parentsFirst()) {
      updates.push({
        sessionId: child.parentSessionId,
        update: {
          ...this.announcement(child),
          state: stateObject(this.childState(child), child.outcome),
        },
      });
    }
    for (const sessionId of [this.host.sessionId, ...this.parentsFirst().map((c) => c.sessionId)]) {
      updates.push(...this.host.background.currentItems(sessionId));
    }
    return updates;
  }

  /**
   * Claude Code's query ended: its tasks ended with its process. Terminals
   * exit and background tool calls are cancelled; a child that worked ends
   * `error`, as the root's work does.
   */
  queryEnded(error: { code: number; message: string } | undefined): void {
    for (const [taskId, terminal] of this.terminals) {
      terminal.tail?.stop();
      if (error) this.exitTerminal(taskId);
    }
    if (!error) return;
    for (const [taskId] of this.toolCalls) this.endToolCall(taskId, "stopped");
    for (const child of this.children.values()) {
      if (child.working) this.endRun(child, { stopReason: "error", error });
    }
    this.level = new Map();
    this.publish();
  }

  /**
   * Publishes the `background` list of each session that changed, deeper
   * sessions first, so a child's own list is current before its parent's
   * list names or drops it.
   */
  publish(): void {
    const lists = this.lists();
    for (const child of [...this.parentsFirst()].reverse()) {
      this.sendAll(
        this.host.background.changed({
          sessionId: child.sessionId,
          items: lists.get(child.sessionId) ?? [],
          state: this.childState(child),
          parentSessionId: child.parentSessionId,
        }),
      );
    }
    this.sendAll(
      this.host.background.changed({
        sessionId: this.host.sessionId,
        items: lists.get(this.host.sessionId) ?? [],
        state: this.host.rootState(),
      }),
    );
  }

  // --- Task events ----------------------------------------------------------------

  private taskStarted(message: Extract<SDKMessage, { subtype: "task_started" }>): void {
    const isAgent = message.task_type === "local_agent" || message.subagent_type !== undefined;
    if (!isAgent) {
      this.started.set(message.task_id, {
        ...(message.tool_use_id !== undefined ? { toolUseId: message.tool_use_id } : {}),
        ...(message.parent_task_id !== undefined ? { parentTaskId: message.parent_task_id } : {}),
        ...(message.task_type !== undefined ? { taskType: message.task_type } : {}),
      });
      return;
    }
    let child = this.children.get(message.task_id);
    if (!child) {
      // A child's parent is the subagent that launched it. One Claude Code
      // no longer tracks, such as one from before a restart, cannot be
      // placed: the child stays unexposed, its traffic the root's.
      const parent =
        message.parent_task_id !== undefined
          ? this.children.get(message.parent_task_id)
          : undefined;
      if (message.parent_task_id !== undefined && !parent) return;
      const hook = this.startedHooks.get(message.task_id);
      this.startedHooks.delete(message.task_id);
      const parentCwd = parent ? (parent.cwd ?? this.host.cwd) : this.host.cwd;
      const cwd = hook && !sameDirectory(hook.cwd, parentCwd) ? hook.cwd : undefined;
      child = {
        sessionId: message.task_id,
        parentSessionId: parent?.sessionId ?? this.host.sessionId,
        launchToolUseId: message.tool_use_id,
        title: message.description,
        description: message.subagent_type ?? hook?.agentType,
        foreground: message.is_backgrounded === false,
        working: false,
        reportedState: undefined,
        outcome: undefined,
        cancelled: false,
        delegationReported: false,
        openRequests: 0,
        requestAborts: new Set(),
        cwd,
        output: new SessionOutput(
          message.task_id,
          cwd ?? parentCwd,
          this.host.translator,
          (update) => this.host.send({ sessionId: message.task_id, update }),
          this.host.logger,
        ),
      };
      this.children.set(child.sessionId, child);
      this.host.send({ sessionId: child.parentSessionId, update: this.announcement(child) });
      for (const waiter of this.announceWaiters.get(child.sessionId) ?? []) waiter();
      this.announceWaiters.delete(child.sessionId);
    } else {
      // A resume: the same child, again. A resumed subagent runs in the background.
      child.foreground = message.is_backgrounded === false;
    }
    if (message.tool_use_id !== undefined) this.childByToolUse.set(message.tool_use_id, child);
    this.startRun(child);
  }

  private taskUpdated(message: Extract<SDKMessage, { subtype: "task_updated" }>): void {
    const { task_id: taskId, patch } = message;
    const child = this.children.get(taskId);
    if (patch.is_backgrounded !== undefined && child) {
      child.foreground = !patch.is_backgrounded;
      this.host.foregroundRequestsChanged();
      this.publish();
    }
    switch (patch.status) {
      case "completed":
      case "failed":
        this.taskEnded(taskId, patch.status, patch.error);
        return;
      case "killed":
        this.taskEnded(taskId, "stopped");
        return;
      case "paused":
      case "running":
      case "pending": {
        const paused = patch.status === "paused";
        const toolCall = this.toolCalls.get(taskId);
        if (toolCall && toolCall.paused !== paused) {
          toolCall.paused = paused;
          toolCall.output.toolCallStatus(toolCall.toolCallId, paused ? "paused" : "in_progress");
        }
        // Claude Code can resume a subagent that ended without a new `task_started`.
        if (patch.status === "running" && child && !child.working) this.startRun(child);
        return;
      }
      default:
        return;
    }
  }

  /**
   * The task `taskId` ended. Claude Code can report one end twice (a
   * terminal `task_updated` and a `task_notification`), so a second is a
   * no-op.
   */
  private taskEnded(
    taskId: string,
    status: "completed" | "failed" | "stopped",
    error?: string,
  ): void {
    const child = this.children.get(taskId);
    if (child) {
      this.endRun(
        child,
        status === "completed"
          ? { stopReason: "end_turn" }
          : status === "stopped"
            ? { stopReason: "cancelled" }
            : {
                stopReason: "error",
                error: { code: -32603, message: error ?? "The subagent failed" },
              },
      );
    }
    this.started.delete(taskId);
    const terminal = this.terminals.get(taskId);
    if (terminal && !terminal.ending) {
      terminal.ending = true;
      // The rest of the output goes out before the exit, and the list drops
      // the terminal only after its exit.
      void (terminal.tail?.finish() ?? Promise.resolve()).then(() => {
        this.exitTerminal(taskId);
        this.publish();
      });
    }
    if (this.toolCalls.has(taskId)) this.endToolCall(taskId, status);
    this.publish();
  }

  /**
   * Claude Code's live background task set changed. Terminals and tool calls
   * whose tasks it no longer holds ended, without saying how.
   */
  private levelChanged(
    tasks: Array<{
      task_id: string;
      task_type: string;
      description: string;
      parent_task_id?: string;
      ambient?: boolean;
    }>,
  ): void {
    this.level = new Map(
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
      if (!this.level.has(taskId)) this.taskEnded(taskId, "completed");
    }
    this.publish();
  }

  // --- Children ---------------------------------------------------------------------

  private childOf(message: { parent_tool_use_id: string | null }): Child | undefined {
    return message.parent_tool_use_id !== null
      ? this.childByToolUse.get(message.parent_tool_use_id)
      : undefined;
  }

  private childSession(sessionId: string): Child | undefined {
    return this.children.get(sessionId);
  }

  /**
   * A user message of a child's transcript: its tool results, or, first in
   * a run, the delegation that its parent sent it, which goes out as an
   * incoming `session_message`.
   */
  private childUserMessage(child: Child, message: SDKUserMessage): void {
    const content = message.message.content;
    const blocks =
      typeof content === "string" ? [{ type: "text" as const, text: content }] : content;
    if (blocks.some((block) => block.type === "tool_result")) {
      this.toolResults(child.output, { ...message, parent_tool_use_id: null });
      return;
    }
    if (child.delegationReported) return;
    const text = blocks.flatMap((block) =>
      block.type === "text" ? [{ type: "text" as const, text: block.text }] : [],
    );
    if (text.length === 0) return;
    child.delegationReported = true;
    this.host.send({
      sessionId: child.sessionId,
      update: {
        sessionUpdate: "session_message",
        messageId: message.uuid ?? `${child.sessionId}:delegation`,
        senderSessionId: child.parentSessionId,
        recipientSessionId: child.sessionId,
        content: text,
      } as v2.SessionUpdate,
    });
  }

  private startRun(child: Child): void {
    if (child.working) return;
    child.working = true;
    child.cancelled = false;
    child.delegationReported = false;
    child.outcome = undefined;
    this.reportChild(child);
    this.publish();
  }

  /** A run of `child` ended: its unfinished tool calls end with it, then its idle. */
  private endRun(child: Child, outcome: IdleOutcome): void {
    if (!child.working) return;
    if (outcome.stopReason !== "end_turn") {
      child.output.finishUnfinished(outcome.stopReason === "cancelled" ? "cancelled" : "failed");
    }
    child.working = false;
    child.outcome = outcome;
    child.cancelled = false;
    this.withdraw(child);
    this.reportChild(child);
    this.host.foregroundRequestsChanged();
  }

  private childState(child: Child): ChildState {
    if (!child.working) return "idle";
    return child.openRequests > 0 ? "requires_action" : "running";
  }

  /** Sends the child's state on its stream and in its parent's mirror, when it changed. */
  private reportChild(child: Child): void {
    const state = this.childState(child);
    if (state === child.reportedState) return;
    // A cancel withdrew the open requests: the run is stopping, and its idle follows.
    if (child.reportedState === "requires_action" && state === "running" && child.cancelled) {
      return;
    }
    child.reportedState = state;
    const snapshot = stateObject(state, child.outcome);
    this.host.send({
      sessionId: child.parentSessionId,
      update: { sessionUpdate: "subagent_update", sessionId: child.sessionId, state: snapshot },
    });
    this.host.send({
      sessionId: child.sessionId,
      update: { sessionUpdate: "state_update", ...snapshot } as v2.SessionUpdate,
    });
  }

  /** Runs `send` as an open request of `child` (see {@link RequestTarget.openRequest}). */
  private async childRequest<T>(
    child: Child,
    toolSignal: AbortSignal,
    send: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const abort = new AbortController();
    const signal = AbortSignal.any([toolSignal, abort.signal]);
    child.requestAborts.add(abort);
    child.openRequests++;
    this.reportChild(child);
    this.host.foregroundRequestsChanged();
    try {
      return await send(signal);
    } finally {
      child.requestAborts.delete(abort);
      child.openRequests--;
      this.reportChild(child);
      this.host.foregroundRequestsChanged();
    }
  }

  /** Set by the session: sends a permission request to the client. */
  hostRequest!: (
    request: v2.RequestPermissionRequest,
    signal: AbortSignal,
  ) => Promise<v2.RequestPermissionResponse>;

  /** Withdraws the open requests of a child whose run stops. */
  private withdraw(child: Child): void {
    if (child.working) child.cancelled = true;
    for (const abort of child.requestAborts) abort.abort();
  }

  /** The children whose runs the work of `sessionId` waits on, transitively. */
  private foregroundChildren(sessionId: string): Child[] {
    const direct = [...this.children.values()].filter(
      (child) => child.parentSessionId === sessionId && child.working && child.foreground,
    );
    return direct.flatMap((child) => [child, ...this.foregroundChildren(child.sessionId)]);
  }

  private reportCwd(child: Child, cwd: string): void {
    const parent = this.children.get(child.parentSessionId);
    const parentCwd = parent ? (parent.cwd ?? this.host.cwd) : this.host.cwd;
    const next = sameDirectory(cwd, parentCwd) ? undefined : cwd;
    if (next === child.cwd) return;
    child.cwd = next;
    this.host.send({
      sessionId: child.parentSessionId,
      update: { sessionUpdate: "subagent_update", sessionId: child.sessionId, cwd: next ?? null },
    });
  }

  private announcement(
    child: Child,
  ): Extract<v2.SessionUpdate, { sessionUpdate: "subagent_update" }> {
    return {
      sessionUpdate: "subagent_update",
      sessionId: child.sessionId,
      title: child.title,
      ...(child.description !== undefined ? { description: child.description } : {}),
      ...(child.cwd !== undefined ? { cwd: child.cwd } : {}),
      // `session/cancel` of the child stops its run (`stopTask`).
      capabilities: { cancel: {} },
    };
  }

  /** The announced children, each after its parent. */
  private parentsFirst(): Child[] {
    const ordered: Child[] = [];
    const visit = (sessionId: string) => {
      for (const child of this.children.values()) {
        if (child.parentSessionId !== sessionId) continue;
        ordered.push(child);
        visit(child.sessionId);
      }
    };
    visit(this.host.sessionId);
    return ordered;
  }

  // --- Lists ------------------------------------------------------------------------

  /**
   * The `background` list of each session: its background terminals, tool
   * calls and other tasks, and its children that work in the background or
   * have background work of their own. A task that a tool call started is
   * part of that call until the call returns, and is not listed.
   */
  private lists(): Map<string, BackgroundItem[]> {
    const lists = new Map<string, BackgroundItem[]>([[this.host.sessionId, []]]);
    for (const child of this.children.values()) lists.set(child.sessionId, []);
    const sessionOfTask = (taskId: string | undefined) =>
      (taskId !== undefined ? this.children.get(taskId)?.sessionId : undefined) ??
      this.host.sessionId;
    // Listed until they end: a terminal's exit, or a tool call's final
    // status, goes out before the list that drops it.
    for (const terminal of this.terminals.values()) {
      lists.get(terminal.output.sessionId)?.push({
        type: "terminal",
        terminalId: terminal.toolCallId,
      });
    }
    for (const toolCall of this.toolCalls.values()) {
      lists.get(toolCall.output.sessionId)?.push({
        type: "tool_call",
        toolCallId: toolCall.toolCallId,
      });
    }
    for (const [taskId, task] of this.level) {
      if (this.terminals.has(taskId) || this.toolCalls.has(taskId)) continue;
      if (task.ambient || task.taskType === "local_bash" || task.taskType === "local_agent") {
        continue;
      }
      const started = this.started.get(taskId);
      if (!started || (started.toolUseId && !this.returned.has(started.toolUseId))) continue;
      lists
        .get(sessionOfTask(task.parentTaskId))
        ?.push({ type: "_claude/task", taskId, description: task.description });
    }
    // Deeper children first: a child's own list is whole before its parent's reads it.
    for (const child of [...this.parentsFirst()].reverse()) {
      const inBackground = child.working && !child.foreground;
      if (inBackground || (lists.get(child.sessionId)?.length ?? 0) > 0) {
        lists.get(child.parentSessionId)?.push({ type: "subagent", sessionId: child.sessionId });
      }
    }
    return lists;
  }

  private followOutput(taskId: string, outputFilePath: string | undefined): void {
    const terminal = this.terminals.get(taskId);
    if (!terminal || !outputFilePath) return;
    terminal.tail = new BackgroundOutputTail(outputFilePath, async (output) =>
      terminal.output.emitV1([
        terminalOutput(terminal.output.sessionId, terminal.toolCallId, output),
      ]),
    );
  }

  private exitTerminal(taskId: string): void {
    const terminal = this.terminals.get(taskId);
    if (!terminal) return;
    this.terminals.delete(taskId);
    terminal.output.emitV1([
      {
        sessionId: terminal.output.sessionId,
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: terminal.toolCallId,
          _meta: {
            terminal_exit: { terminal_id: terminal.toolCallId, exit_code: null, signal: null },
          },
        },
      },
    ]);
  }

  private endToolCall(taskId: string, status: "completed" | "failed" | "stopped"): void {
    const toolCall = this.toolCalls.get(taskId);
    if (!toolCall) return;
    this.toolCalls.delete(taskId);
    toolCall.output.toolCallStatus(
      toolCall.toolCallId,
      status === "stopped" ? "cancelled" : status,
    );
  }

  private sendAll(notifications: v2.UpdateSessionNotification[]): void {
    for (const notification of notifications) this.host.send(notification);
  }
}

/**
 * Whether two paths name one directory, also through a symlink: a hook's
 * `cwd` is the real path, such as `/private/tmp/project` for `/tmp/project`.
 */
function sameDirectory(left: string, right: string): boolean {
  const real = (directory: string) => {
    try {
      return fs.realpathSync.native(directory);
    } catch {
      return path.resolve(directory);
    }
  };
  return path.resolve(left) === path.resolve(right) || real(left) === real(right);
}

/** A child's state as a `StateUpdate`: an idle with how its last run ended. */
function stateObject(state: ChildState, outcome: IdleOutcome | undefined): v2.StateUpdate {
  switch (state) {
    case "running":
      return { state: "running" };
    case "requires_action":
      return { state: "requires_action" };
    default:
      return { state: "idle", ...(outcome ?? {}) } as v2.StateUpdate;
  }
}

/** The v1 update that gives a background command's terminal its output. */
function terminalOutput(
  sessionId: string,
  terminalId: string,
  output: BackgroundOutput,
): AcpSessionNotification {
  const data = { terminal_id: terminalId, data: output.text };
  return {
    sessionId,
    update: {
      sessionUpdate: "tool_call_update",
      toolCallId: terminalId,
      _meta: output.replaces ? { terminal_output: data } : { terminal_output_delta: data },
    },
  };
}

/** The error of a request on a child session: the client can only watch a child. */
export function restrictedChild(sessionId: string, method: string): RequestError {
  return RequestError.invalidParams(
    { sessionId },
    `${sessionId} is a subagent session: the client cannot ${method} it. Its parent session runs it.`,
  );
}
