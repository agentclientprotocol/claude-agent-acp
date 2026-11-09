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
 *   it again under the same `task_id`). It is announced on the session that
 *   made the Agent or Task call that launched it, once both its `task_started`
 *   and that call came, with `subagent_update`, before any of its traffic.
 *   Its messages carry the `parent_tool_use_id` of that call, also after a
 *   resume, and go to its stream; those that come before the announcement
 *   wait for it. A child that ends before it is announced stays unexposed.
 *   Each run of it is the child's foreground work: `running` from its start
 *   to its end, on its stream and mirrored on the parent's `subagent_update`.
 * - The parent is not shown the Agent call of an announced child: the call's
 *   prompt is the parent's outgoing `session_message` and the child's
 *   incoming one, and a foreground child's answer is its reply to the parent.
 *   The call of a child that was never exposed is shown with its final
 *   status.
 * - The work waits on a subagent that is not `is_backgrounded`, and on the
 *   ones that it waits on: their requests block it (`requires_action`), and
 *   a cancel of it withdraws them. A subagent in the background is listed in
 *   its parent's `background` while it works.
 * - A command that went to the background is its display terminal, kept
 *   running from its Bash result until its task ends, with its output read
 *   from the file Claude Code writes it to.
 * - A task that a tool call started, such as a `Monitor` or `Workflow` call,
 *   is that tool call, kept `in_progress` (or `paused`) until the task ends.
 * - Any other background task is a `_claude/task` item.
 *
 * Claude Code's interrupt spares background tasks (`perTaskStopAffordance`),
 * so `session/cancel` leaves listed work running, as v2 asks. A session
 * started without it reports no lists.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { RequestError } from "@agentclientprotocol/sdk/unstable";
import type * as v2 from "@agentclientprotocol/sdk/experimental/v2/unstable";
import type { SDKMessage, SDKUserMessage, SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import type { Logger } from "../acp-agent.js";
import type { AcpSessionNotification } from "../acp-subagents.js";
import { backgroundBashTaskFromToolResult } from "../async-tasks.js";
import { BackgroundOutputTail, type BackgroundOutput } from "../background-output.js";
import type { BackgroundItem, WorkStateName } from "../background-work.js";
import {
  childModelOption,
  isNativeSubagentControlTool,
  launchReply,
  linkedSessionMessages,
  mergeSubagentIdentity,
  responseModelEntry,
  rfdLabels,
  subagentIdentity,
  unexposedControlFallback,
  type SubagentIdentity,
  type SubagentModels,
} from "../native-subagents.js";
import { withRunningTerminal, withRunningToolCall } from "../tool-calls/background.js";
import { ClientCapabilities } from "../tool-calls/client-capabilities.js";
import { AcpToolCallRenderer } from "../tool-calls/renderer.js";
import type { V2Background } from "../v2/background.js";
import type { V2UpdateTranslator } from "../v2/update-translator.js";
import { SessionOutput } from "./stream.js";
import { SubagentReplay } from "./subagent-replay.js";

/** What the tasks need of their root session. */
export interface TaskHost {
  readonly sessionId: string;
  readonly cwd: string;
  readonly logger: Logger;
  readonly translator: V2UpdateTranslator;
  readonly background: V2Background;
  /**
   * Whether the session reports its background work: only when Claude Code's
   * interrupt spares background tasks (`perTaskStopAffordance`).
   */
  readonly reportsBackground: boolean;
  /** Sends an update of the root session or one of its children. */
  send(notification: v2.UpdateSessionNotification): void;
  /** The root session's foreground state now. */
  rootState(): WorkStateName;
  /** A subagent's open requests changed, which can block the root's foreground work. */
  foregroundRequestsChanged(): void;
  /** The entries of the root session's `model` option, for a child's `model`. */
  models(): SubagentModels;
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
  | { stopReason: "error"; error?: { code: number; message: string } };

/** An Agent or Task call, which launches or resumes a subagent. */
type Launch = {
  toolUseId: string;
  /** The output of the session that made the call. */
  output: SessionOutput;
  identity: SubagentIdentity | undefined;
  /** Whether the call ran its child in the background (`run_in_background`). */
  background: boolean;
  /** The call's first report, for the call of a child that is never exposed. */
  initial: AcpSessionNotification | undefined;
  /** Whether the call reached its final status. */
  ended: boolean;
};

/** A live subagent task, as the work that waits on it needs it. */
type AgentTask = { parentTaskId: string | undefined; background: boolean };

type Child = {
  /** The child's session id: its agent id. */
  sessionId: string;
  /** The session that made its launch call, once it is announced. */
  parentSessionId: string;
  /** The Agent call of its current run, whose id its messages carry. */
  launchToolUseId: string | undefined;
  /** What `task_started` said of it. */
  task: { description?: string; prompt?: string; subagentType?: string };
  announced: boolean;
  /** Its messages that came before its announcement. */
  pending: SDKMessage[];
  title: string | undefined;
  description: string | undefined;
  /** Whether a run of it is going on: its foreground work. */
  working: boolean;
  /** The state its stream was told last. */
  reportedState: ChildState | undefined;
  /** How its last run ended. */
  outcome: IdleOutcome | undefined;
  openRequests: number;
  /** The working directory it was announced with, when not its parent's. */
  cwd: string | undefined;
  /** Its output, once it is announced. */
  output: SessionOutput | undefined;
  /** The `model` option the client holds for it, as JSON. */
  model: string | undefined;
  /** The ids of the messages delegated to it. */
  promptIds: Set<string>;
  /** Its tool calls that ended with a stop of its run: Claude Code's later results are dropped. */
  stopped: Set<string>;
};

type ToolResultBlock = { type: "tool_result"; tool_use_id: string; is_error?: boolean };

/** A task of `background_tasks_changed`. */
type LevelTask = { ambient: boolean; taskType: string; description: string; parentTaskId?: string };

/** What `task_started` said of a task that is not a subagent. */
type StartedTask = { toolUseId?: string; parentTaskId?: string; taskType?: string };

/** The tools whose structured result names the task that the call started. */
const TASK_TOOLS = new Set(["Monitor", "Workflow"]);

/** The most messages that wait for the announcement of one child. */
const MAX_PENDING_MESSAGES = 256;

const FINAL_STATUSES = new Set<unknown>(["completed", "failed", "cancelled"]);

const V2_RENDERER = new AcpToolCallRenderer(ClientCapabilities.from(undefined, { v2: true }));

export class SessionTasks {
  /** The subagents, by agent id. */
  private readonly children = new Map<string, Child>();
  /** The child of each Agent call that launched or resumed one. */
  private readonly childByToolUse = new Map<string, Child>();
  /** The Agent and Task calls, by tool use id. */
  private readonly launches = new Map<string, Launch>();
  /** The messages of a launch whose child has not started, by launch id. */
  private readonly pendingByLaunch = new Map<string, SDKMessage[]>();
  /** The live subagent tasks, by agent id, announced or not. */
  private readonly agents = new Map<string, AgentTask>();
  /** The open permission requests of each subagent, by agent id. */
  private readonly agentRequests = new Map<string, Set<AbortController>>();
  /** The subagents whose runs a cancel stops, by agent id, until their runs end. */
  private readonly cancelledAgents = new Set<string>();
  /** The session that made each SendMessage call: the sender of a resumed child's prompt. */
  private readonly senderByToolUse = new Map<string, string>();
  /** The other tasks that `task_started` reported, until they end. */
  private readonly started = new Map<string, StartedTask>();
  /** Claude Code's live background tasks, from its last `background_tasks_changed`. */
  private level = new Map<string, LevelTask>();
  /** The terminals of the commands that went to the background, by task id. */
  private readonly terminals = new Map<
    string,
    {
      toolCallId: string;
      output: SessionOutput;
      tail?: BackgroundOutputTail;
      ending?: boolean;
      /** Whether Claude Code's live background task set held its task. */
      leveled?: boolean;
    }
  >();
  /** The tool calls whose tasks go on in the background, by task id. */
  private readonly toolCalls = new Map<
    string,
    {
      toolCallId: string;
      output: SessionOutput;
      toolUse: { name: string; input: unknown };
      paused: boolean;
    }
  >();
  /** The tool calls that returned: their tasks no longer hold their work. */
  private readonly returned = new Set<string>();
  /** What a `SubagentStart` hook reported before the child was announced, by agent id. */
  private readonly startedHooks = new Map<string, { cwd: string; agentType: string }>();

  constructor(
    private readonly host: TaskHost,
    /** The root session's output, which owns its tool calls. */
    private readonly rootOutput: SessionOutput,
  ) {
    rootOutput.route = (notification) => this.route(rootOutput, notification, undefined);
    // Every state of a session that reports its background work carries a list.
    if (host.reportsBackground) {
      host.background.changed({ sessionId: host.sessionId, items: [], state: undefined });
    }
  }

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
            this.taskNotification(message);
            return true;
          case "background_tasks_changed":
            this.levelChanged(message.tasks);
            return true;
          default:
            return false;
        }
      case "stream_event":
      case "assistant":
      case "user":
        return this.childMessage(message);
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
      this.terminals.set(command.taskId, {
        toolCallId: command.toolCallId,
        output,
        leveled: this.level.get(command.taskId)?.ambient === false,
      });
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
    // A tool call's task is kept only for a session that lists it.
    for (const { tool_use_id: toolCallId } of this.host.reportsBackground ? succeeded : []) {
      const toolUse = toolUses[toolCallId];
      if (!toolUse || toolUse.name === "Bash" || isNativeSubagentControlTool(toolUse.name)) {
        continue;
      }
      const taskId =
        (TASK_TOOLS.has(toolUse.name) ? structuredTaskId : undefined) ??
        [...this.started].find(([, task]) => task.toolUseId === toolCallId)?.[0];
      const task = taskId === undefined ? undefined : this.level.get(taskId);
      if (!task || task.taskType === "local_bash" || task.taskType === "local_agent") continue;
      this.toolCalls.set(taskId!, {
        toolCallId,
        output,
        toolUse: { name: toolUse.name, input: toolUse.input },
        paused: false,
      });
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

  /** Reads the subagents that the history `messages` launched, for its replay. */
  loadReplay(messages: SessionMessage[]): Promise<SubagentReplay | undefined> {
    return SubagentReplay.load(this.host, messages);
  }

  /** Whether `sessionId` is an announced child session of this root. */
  hasChild(sessionId: string): boolean {
    return this.children.get(sessionId)?.announced === true;
  }

  /**
   * The session that a permission request of the agent `agentId` goes to:
   * its child session once it is announced, else the root. A request can
   * come before its subagent's `task_started`: it blocks the root's work once
   * that shows the subagent runs in the foreground.
   */
  async target(agentId: string | undefined, root: RequestTarget): Promise<RequestTarget> {
    if (agentId === undefined) return root;
    const child = this.children.get(agentId);
    const announced = child?.announced ? child : undefined;
    return {
      sessionId: announced?.sessionId ?? root.sessionId,
      cwd: announced ? this.cwdOf(announced.sessionId) : root.cwd,
      output: announced?.output ?? root.output,
      cancelling: () => this.cancelledAgents.has(agentId),
      requestPermission: (request, toolSignal) =>
        this.agentRequest(agentId, toolSignal, async (signal) => {
          try {
            return await this.hostRequest(request, signal);
          } catch (error) {
            if (signal.aborted) return { outcome: { outcome: "cancelled" } };
            throw error;
          }
        }),
      openRequest: (signal, send) => this.agentRequest(agentId, signal, send),
    };
  }

  /**
   * Whether the root's foreground work waits on a subagent that waits on the
   * user: one it does not run in the background, or one that such a
   * subagent waits on.
   */
  foregroundBlocked(): boolean {
    return [...this.agentRequests].some(
      ([agentId, requests]) => requests.size > 0 && this.waitsOn(agentId, undefined),
    );
  }

  /**
   * The root's foreground work is cancelled: so is the work of the subagents
   * that it waits on. Their open requests are withdrawn. Claude Code's
   * interrupt stops their runs, which then end `cancelled`.
   */
  cancelForeground(): void {
    for (const agentId of this.agents.keys()) {
      if (this.waitsOn(agentId, undefined)) this.withdraw(agentId);
    }
  }

  /** The root session closes: every subagent's open request is withdrawn. */
  withdrawAll(): void {
    for (const agentId of this.agentRequests.keys()) this.withdraw(agentId);
  }

  /**
   * `session/cancel` of a child: stops its run, and the work of the subagents
   * that it waits on. Its idle reports `cancelled` once Claude Code reports
   * the task stopped. A child that does not work has nothing to stop.
   */
  async cancelChild(sessionId: string): Promise<void> {
    const child = this.children.get(sessionId);
    if (!child?.announced || !child.working) return;
    for (const agentId of this.agents.keys()) {
      if (this.waitsOn(agentId, sessionId)) this.withdraw(agentId);
    }
    try {
      await this.host.stopTask(child.sessionId);
    } catch (error) {
      // The run ended meanwhile, or Claude Code refused: it reports how it ends.
      this.cancelledAgents.delete(sessionId);
      this.host.logger.error(`Subagent ${sessionId}: stopping it failed`, error);
    }
  }

  /** A `SubagentStart` hook: the child's working directory and type. */
  subagentStarted(agentId: string, cwd: string, agentType: string): void {
    const child = this.children.get(agentId);
    if (!child?.announced) {
      this.startedHooks.set(agentId, { cwd, agentType });
      return;
    }
    this.reportCwd(child, cwd);
  }

  // --- Background work ----------------------------------------------------------

  /**
   * Stops the listed terminal or tool call of `sessionId` (`terminal/cancel`
   * and `tool_call/cancel`). It ends when Claude Code reports its task
   * stopped. Returns false when the session does not list it, also when it
   * ended while Claude Code tried to stop it.
   */
  async cancelItem(
    sessionId: string,
    target: { terminalId: string } | { toolCallId: string },
  ): Promise<boolean> {
    const taskId = this.listedTask(sessionId, target);
    if (taskId === undefined) return false;
    try {
      await this.host.stopTask(taskId);
    } catch (error) {
      if (this.listedTask(sessionId, target) === undefined) return false;
      throw error;
    }
    return true;
  }

  /**
   * The current state of the listed work, for a resume of the active
   * session: each subagent that the root lists, with its labels and state
   * (also on its own stream), each tool call that it lists as its tool use
   * shows it now, and each listed item's `cancel` capability.
   */
  currentState(): v2.UpdateSessionNotification[] {
    const updates: v2.UpdateSessionNotification[] = [];
    const listed = this.lists().get(this.host.sessionId) ?? [];
    for (const item of listed) {
      if (item.type !== "subagent") continue;
      const child = this.children.get(item.sessionId);
      if (!child) continue;
      const state = stateObject(this.childState(child), undefined);
      updates.push(
        this.host.background.stamp({
          sessionId: child.parentSessionId,
          update: { ...this.announcement(child), state },
        }),
        this.host.background.stamp({
          sessionId: child.sessionId,
          update: { sessionUpdate: "state_update", ...state } as v2.SessionUpdate,
        }),
      );
    }
    for (const item of listed) {
      if (item.type !== "tool_call") continue;
      const toolCall = [...this.toolCalls.values()].find((t) => t.toolCallId === item.toolCallId);
      if (!toolCall) continue;
      const update = V2_RENDERER.toolCall(
        { id: toolCall.toolCallId, ...toolCall.toolUse },
        { cwd: this.host.cwd },
      );
      const status = toolCall.paused ? "paused" : "in_progress";
      for (const v2Update of this.host.translator.updates(this.host.sessionId, {
        ...update,
        status,
      } as AcpSessionNotification["update"])) {
        updates.push({ sessionId: this.host.sessionId, update: v2Update });
      }
    }
    updates.push(...this.host.background.currentItems(this.host.sessionId));
    return updates;
  }

  /** The tool calls of `sessionId` whose tasks go on in the background: a cancel leaves them. */
  backgroundCalls(sessionId: string): Set<string> {
    return new Set(
      [...this.toolCalls.values()]
        .filter((toolCall) => toolCall.output.sessionId === sessionId)
        .map((toolCall) => toolCall.toolCallId),
    );
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
      if (child.announced && child.working) {
        child.output!.finishUnfinished("failed");
        this.endRun(child, { stopReason: "error", error });
      }
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
    if (!this.host.reportsBackground) return;
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
      this.publish();
      return;
    }
    // A subagent that Claude Code does not run in the background blocks the
    // work that waits on it, also before it is announced.
    this.agents.set(message.task_id, {
      parentTaskId: message.parent_task_id,
      background: message.is_backgrounded === true,
    });
    const toolUseId = message.tool_use_id ?? undefined;
    const prompt = nonBlank(message.prompt);
    let child = this.children.get(message.task_id);
    if (child) {
      // A resume: the same child, again, under the call that resumed it.
      if (toolUseId !== undefined) {
        this.childByToolUse.set(toolUseId, child);
        child.launchToolUseId = toolUseId;
      }
      this.startRun(child, prompt, toolUseId);
    } else {
      // A child's parent is the subagent that launched it. One Claude Code
      // no longer tracks, such as one from before a restart, cannot be
      // placed: the child stays unexposed, its traffic the root's.
      if (message.parent_task_id !== undefined && !this.children.has(message.parent_task_id)) {
        this.host.foregroundRequestsChanged();
        return;
      }
      child = {
        sessionId: message.task_id,
        parentSessionId: this.host.sessionId,
        launchToolUseId: toolUseId,
        task: {
          ...(nonBlank(message.description) ? { description: message.description } : {}),
          ...(prompt ? { prompt } : {}),
          ...(nonBlank(message.subagent_type) ? { subagentType: message.subagent_type } : {}),
        },
        announced: false,
        pending: toolUseId !== undefined ? (this.pendingByLaunch.get(toolUseId) ?? []) : [],
        title: undefined,
        description: undefined,
        working: true,
        reportedState: undefined,
        outcome: undefined,
        openRequests: 0,
        cwd: undefined,
        output: undefined,
        model: undefined,
        promptIds: new Set(),
        stopped: new Set(),
      };
      this.children.set(child.sessionId, child);
      if (toolUseId !== undefined) {
        this.pendingByLaunch.delete(toolUseId);
        this.childByToolUse.set(toolUseId, child);
        // The launch call names the parent. Without one, it is the parent task.
        const launch = this.launches.get(toolUseId);
        if (launch) this.announce(child, launch.output.sessionId);
      } else {
        const parent = message.parent_task_id ?? this.host.sessionId;
        this.announce(child, parent);
      }
    }
    this.host.foregroundRequestsChanged();
    this.publish();
  }

  private taskUpdated(message: Extract<SDKMessage, { subtype: "task_updated" }>): void {
    const { task_id: taskId, patch } = message;
    const child = this.children.get(taskId);
    const agent = this.agents.get(taskId);
    if (patch.is_backgrounded !== undefined && agent) {
      agent.background = patch.is_backgrounded;
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
        if (patch.status === "running" && child && !child.working) {
          this.agents.set(taskId, { parentTaskId: agent?.parentTaskId, background: true });
          this.startRun(child, undefined, undefined);
        }
        return;
      }
      default:
        return;
    }
  }

  private taskNotification(message: Extract<SDKMessage, { subtype: "task_notification" }>): void {
    const child = this.children.get(message.task_id);
    // The end of an earlier delegation to a resumed child ends nothing: the
    // child and its task belong to the new run.
    const toolUseId = message.tool_use_id ?? undefined;
    if (
      child &&
      toolUseId !== undefined &&
      toolUseId !== child.launchToolUseId &&
      this.childByToolUse.get(toolUseId) === child
    ) {
      return;
    }
    this.taskEnded(message.task_id, message.status);
  }

  /**
   * The task `taskId` ended. Claude Code can report one end twice (a
   * terminal `task_updated` and a `task_notification`), so a second is a
   * no-op, unless it gives the error text of a failure that the first lacked.
   */
  private taskEnded(
    taskId: string,
    status: "completed" | "failed" | "stopped",
    error?: string,
  ): void {
    const child = this.children.get(taskId);
    if (this.agents.delete(taskId)) this.host.foregroundRequestsChanged();
    if (child && !child.announced) {
      this.withdrawChild(child);
    } else if (child) {
      this.endRun(
        child,
        status === "completed"
          ? { stopReason: "end_turn" }
          : status === "stopped"
            ? { stopReason: "cancelled" }
            : {
                stopReason: "error",
                ...(error
                  ? { error: { code: RequestError.internalError().code, message: error } }
                  : {}),
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
    for (const [taskId, terminal] of this.terminals) {
      if (this.level.get(taskId)?.ambient === false) terminal.leveled = true;
    }
    for (const taskId of [...this.terminals.keys(), ...this.toolCalls.keys()]) {
      if (!this.level.has(taskId)) this.taskEnded(taskId, "completed");
    }
    this.publish();
  }

  // --- Children ---------------------------------------------------------------------

  /**
   * A message of a subagent, by its `parent_tool_use_id`: it goes to the
   * child's stream, or waits for the child's announcement. A message of an
   * agent that no known call launched is the root's.
   */
  private childMessage(message: SDKMessage & { parent_tool_use_id: string | null }): boolean {
    const launchId = message.parent_tool_use_id;
    if (launchId === null) return false;
    const child = this.childByToolUse.get(launchId);
    if (child?.announced) {
      this.deliver(child, message);
      return true;
    }
    if (!child && !this.launches.has(launchId)) return false;
    const pending = child?.pending ?? this.pendingByLaunch.get(launchId) ?? [];
    if (!child) this.pendingByLaunch.set(launchId, pending);
    if (pending.length < MAX_PENDING_MESSAGES) pending.push(message);
    else this.host.logger.error(`Subagent of ${launchId}: dropping a message before its start`);
    return true;
  }

  /** Sends a message of the announced `child` to its stream. */
  private deliver(child: Child, message: SDKMessage): void {
    const output = child.output!;
    switch (message.type) {
      case "stream_event":
        if (message.event.type === "message_start") {
          this.reportModel(child, message.event.message.model);
        }
        output.streamEvent(message);
        return;
      case "assistant":
        this.reportModel(child, message.message.model);
        output.assistant(message);
        return;
      case "user": {
        // Its prompts are the delegations, which go out as session messages.
        // Its other text is Claude Code's, such as "[Request interrupted by
        // user]", which the child's session does not show.
        const content = message.message.content;
        if (Array.isArray(content) && content.some((block) => block.type === "tool_result")) {
          this.toolResults(output, message);
        }
        return;
      }
      default:
        return;
    }
  }

  /**
   * Announces `child` on `parentSessionId`, running, with its parent's
   * labels for it, then sends its prompt as the parent's message to it, and
   * the messages that came before.
   */
  private announce(child: Child, parentSessionId: string): void {
    const launch =
      child.launchToolUseId !== undefined ? this.launches.get(child.launchToolUseId) : undefined;
    const identity = launch?.identity;
    const hook = this.startedHooks.get(child.sessionId);
    this.startedHooks.delete(child.sessionId);
    const labels = rfdLabels(
      identity?.name,
      identity?.subagentType ?? child.task.subagentType ?? hook?.agentType,
      identity?.description ?? child.task.description,
    );
    child.parentSessionId = parentSessionId;
    child.title = labels.title;
    child.description = labels.description;
    const parentCwd = this.cwdOf(parentSessionId);
    child.cwd = hook && !sameDirectory(hook.cwd, parentCwd) ? hook.cwd : undefined;
    const output = new SessionOutput(
      child.sessionId,
      child.cwd ?? parentCwd,
      this.host.translator,
      (update) => this.host.send({ sessionId: child.sessionId, update }),
      this.host.logger,
      true,
    );
    output.route = (notification) => this.route(output, notification, child);
    child.output = output;
    child.announced = true;
    child.reportedState = "running";
    const state = stateObject("running", undefined);
    this.host.send({ sessionId: parentSessionId, update: { ...this.announcement(child), state } });
    this.host.send({
      sessionId: child.sessionId,
      update: { sessionUpdate: "state_update", ...state } as v2.SessionUpdate,
    });
    const prompt = child.task.prompt ?? identity?.prompt;
    if (prompt) this.sendPrompt(child, prompt, child.launchToolUseId, parentSessionId, true);
    const pending = child.pending;
    child.pending = [];
    for (const message of pending) this.deliver(child, message);
  }

  /**
   * A message delegated to `child`, with the id of the call that sent it. A
   * launch's prompt replaces its call (`linked`): it goes out as the
   * sender's outgoing message and the child's incoming one.
   */
  private sendPrompt(
    child: Child,
    text: string,
    toolUseId: string | undefined,
    sender: string | undefined,
    linked: boolean,
  ): void {
    const messageId = toolUseId ?? `${child.sessionId}:prompt:${child.promptIds.size + 1}`;
    if (child.promptIds.has(messageId)) return;
    child.promptIds.add(messageId);
    if (linked && toolUseId !== undefined && sender !== undefined) {
      const [outgoing, incoming] = linkedSessionMessages(toolUseId, sender, child.sessionId, text);
      this.outputOf(sender)?.emitV1([outgoing!]);
      child.output!.emitV1([incoming!]);
      return;
    }
    child.output!.emitV1([
      {
        sessionId: child.sessionId,
        update: {
          sessionUpdate: "session_message",
          messageId,
          ...(sender !== undefined ? { senderSessionId: sender } : {}),
          recipientSessionId: child.sessionId,
          content: [{ type: "text", text }],
        },
      },
    ]);
  }

  /**
   * Rewrites an update of `output`, the output of the root or of `child`: an
   * update of an Agent or Task call goes out as {@link launchUpdate} says,
   * and Claude Code's late result of a call that the child's stop ended
   * goes nowhere.
   */
  private route(
    output: SessionOutput,
    notification: AcpSessionNotification,
    child: Child | undefined,
  ): AcpSessionNotification[] {
    const { update } = notification;
    if (update.sessionUpdate !== "tool_call" && update.sessionUpdate !== "tool_call_update") {
      return [notification];
    }
    if (child?.stopped.has(update.toolCallId)) return [];
    const toolName = (update._meta?.claudeCode as { toolName?: unknown } | undefined)?.toolName;
    if (toolName === "SendMessage") this.senderByToolUse.set(update.toolCallId, output.sessionId);
    let launch = this.launches.get(update.toolCallId);
    if (!launch) {
      if (!isNativeSubagentControlTool(toolName)) return [notification];
      launch = {
        toolUseId: update.toolCallId,
        output,
        identity: undefined,
        background: false,
        initial: undefined,
        ended: false,
      };
      this.launches.set(launch.toolUseId, launch);
    }
    return this.launchUpdate(launch, notification);
  }

  /**
   * An update of an Agent or Task call. Its child, if it started, is
   * announced at the call's first update. The call goes out only once it
   * ends without an announced child, except a background launch that
   * completed: its child starts after it. A foreground child's answer, the
   * completed result, is its reply to the parent.
   */
  private launchUpdate(
    launch: Launch,
    notification: AcpSessionNotification,
  ): AcpSessionNotification[] {
    const update = notification.update as Extract<
      AcpSessionNotification["update"],
      { sessionUpdate: "tool_call" | "tool_call_update" }
    >;
    if (update.sessionUpdate === "tool_call") launch.initial ??= notification;
    const identity = subagentIdentity(update.rawInput);
    if (identity) launch.identity = mergeSubagentIdentity(launch.identity, identity);
    if ((update.rawInput as { run_in_background?: unknown } | null)?.run_in_background === true) {
      launch.background = true;
    }
    const child = this.childByToolUse.get(launch.toolUseId);
    if (child && !child.announced) this.announce(child, launch.output.sessionId);
    if (!FINAL_STATUSES.has(update.status) || launch.ended) return [];
    launch.ended = true;
    if (child?.announced) {
      if (update.status !== "completed" || launch.background) return [];
      const reply = launchReply(launch.toolUseId, child.sessionId, child.parentSessionId, update);
      return reply ? [reply] : [];
    }
    // No child came, or it ended unexposed: its messages are dropped with it.
    this.pendingByLaunch.delete(launch.toolUseId);
    if (launch.background && update.status === "completed") return [];
    return [unexposedControlFallback(launch.initial, notification, launch.output.sessionId)];
  }

  /** A child that ended before its announcement stays unexposed, and is forgotten. */
  private withdrawChild(child: Child): void {
    this.children.delete(child.sessionId);
    for (const [toolUseId, owner] of this.childByToolUse) {
      if (owner === child) this.childByToolUse.delete(toolUseId);
    }
    this.cancelledAgents.delete(child.sessionId);
  }

  /** A new run of the announced `child`, with the prompt that the call `toolUseId` sent it. */
  private startRun(child: Child, prompt: string | undefined, toolUseId: string | undefined): void {
    if (!child.announced) return;
    if (!child.working) {
      child.working = true;
      child.outcome = undefined;
      this.cancelledAgents.delete(child.sessionId);
      this.reportChild(child);
    }
    if (prompt && toolUseId !== undefined) {
      this.sendPrompt(child, prompt, toolUseId, this.senderByToolUse.get(toolUseId), false);
    }
    this.publish();
  }

  /**
   * A run of `child` ended: its idle goes out, then a stopped run's
   * unfinished tool calls end `cancelled`, except its background work.
   */
  private endRun(child: Child, outcome: IdleOutcome): void {
    if (!child.working) {
      // A later report of the same failure can give its error text.
      if (
        outcome.stopReason === "error" &&
        outcome.error &&
        child.outcome?.stopReason === "error" &&
        !child.outcome.error
      ) {
        child.outcome = outcome;
        this.sendChildState(child, "idle");
      }
      return;
    }
    child.working = false;
    child.outcome = outcome;
    this.reportChild(child);
    this.cancelledAgents.delete(child.sessionId);
    if (outcome.stopReason === "cancelled") {
      const keep = this.backgroundCalls(child.sessionId);
      const ended = child.output!.finishUnfinished("cancelled", keep, { exitTerminals: true });
      for (const toolCallId of ended) child.stopped.add(toolCallId);
    }
  }

  private childState(child: Child): ChildState {
    if (!child.working) return "idle";
    return child.openRequests > 0 ? "requires_action" : "running";
  }

  /** Sends the child's state on its stream and in its parent's mirror, when it changed. */
  private reportChild(child: Child): void {
    if (!child.announced) return;
    const state = this.childState(child);
    if (state === child.reportedState) return;
    // A cancel withdrew the open requests: the run is stopping, and its idle follows.
    if (
      child.reportedState === "requires_action" &&
      state === "running" &&
      this.cancelledAgents.has(child.sessionId)
    ) {
      return;
    }
    this.sendChildState(child, state);
  }

  private sendChildState(child: Child, state: ChildState): void {
    child.reportedState = state;
    const snapshot = stateObject(state, state === "idle" ? child.outcome : undefined);
    this.host.send({
      sessionId: child.parentSessionId,
      update: { sessionUpdate: "subagent_update", sessionId: child.sessionId, state: snapshot },
    });
    this.host.send({
      sessionId: child.sessionId,
      update: { sessionUpdate: "state_update", ...snapshot } as v2.SessionUpdate,
    });
  }

  /**
   * Runs `send` as an open request of the agent `agentId` (see
   * {@link RequestTarget.openRequest}). While it is open, an announced child
   * is `requires_action`, and the work that waits on the agent is too.
   */
  private async agentRequest<T>(
    agentId: string,
    toolSignal: AbortSignal,
    send: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const child = this.children.get(agentId);
    const announced = child?.announced ? child : undefined;
    const abort = new AbortController();
    const signal = AbortSignal.any([toolSignal, abort.signal]);
    const requests = this.agentRequests.get(agentId) ?? new Set();
    this.agentRequests.set(agentId, requests);
    requests.add(abort);
    if (announced) {
      announced.openRequests++;
      this.reportChild(announced);
    }
    this.host.foregroundRequestsChanged();
    try {
      return await send(signal);
    } finally {
      requests.delete(abort);
      if (requests.size === 0) this.agentRequests.delete(agentId);
      this.host.foregroundRequestsChanged();
      if (announced) {
        announced.openRequests--;
        this.reportChild(announced);
      }
    }
  }

  /** Set by the session: sends a permission request to the client. */
  hostRequest!: (
    request: v2.RequestPermissionRequest,
    signal: AbortSignal,
  ) => Promise<v2.RequestPermissionResponse>;

  /** Withdraws the open requests of the agent `agentId`, whose run a cancel stops. */
  private withdraw(agentId: string): void {
    this.cancelledAgents.add(agentId);
    for (const abort of this.agentRequests.get(agentId) ?? []) abort.abort();
  }

  /**
   * Whether the work of `sessionId` (the root when undefined) waits on the
   * agent `agentId`: the agent is that session's, or each agent from it up to
   * that session runs in the foreground of its parent.
   */
  private waitsOn(agentId: string, sessionId: string | undefined): boolean {
    const seen = new Set<string>();
    for (let id: string | undefined = agentId; id !== undefined && !seen.has(id);) {
      if (id === sessionId) return true;
      seen.add(id);
      const task = this.agents.get(id);
      if (!task || task.background) return false;
      id = task.parentTaskId;
    }
    return sessionId === undefined;
  }

  /**
   * Reports the model of a child response as the entry of the root's `model`
   * option that matches it, else as the id. The child gets no model before
   * its first response, and the client gets it again only when it changes.
   */
  private reportModel(child: Child, model: string | undefined): void {
    const entry = responseModelEntry(model, this.host.models());
    if (!entry) return;
    const options = [childModelOption(entry)];
    const json = JSON.stringify(options);
    if (child.model === json) return;
    child.model = json;
    child.output!.emitV1([
      {
        sessionId: child.sessionId,
        update: {
          sessionUpdate: "config_option_update",
          configOptions: options,
          ...(child.launchToolUseId !== undefined
            ? { _meta: { claudeCode: { parentToolUseId: child.launchToolUseId } } }
            : {}),
        },
      },
    ]);
  }

  private reportCwd(child: Child, cwd: string): void {
    const parentCwd = this.cwdOf(child.parentSessionId);
    const next = sameDirectory(cwd, parentCwd) ? undefined : cwd;
    if (next === child.cwd) return;
    child.cwd = next;
    this.host.send({
      sessionId: child.parentSessionId,
      update: { sessionUpdate: "subagent_update", sessionId: child.sessionId, cwd: next ?? null },
    });
  }

  /** The working directory of the root or of an announced child. */
  private cwdOf(sessionId: string): string {
    const child = this.children.get(sessionId);
    if (!child?.announced) return this.host.cwd;
    return child.cwd ?? this.cwdOf(child.parentSessionId);
  }

  private outputOf(sessionId: string): SessionOutput | undefined {
    if (sessionId === this.host.sessionId) return this.rootOutput;
    return this.children.get(sessionId)?.output;
  }

  private announcement(
    child: Child,
  ): Extract<v2.SessionUpdate, { sessionUpdate: "subagent_update" }> {
    return {
      sessionUpdate: "subagent_update",
      sessionId: child.sessionId,
      ...(child.title !== undefined ? { title: child.title } : {}),
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
        if (!child.announced || child.parentSessionId !== sessionId) continue;
        ordered.push(child);
        visit(child.sessionId);
      }
    };
    visit(this.host.sessionId);
    return ordered;
  }

  // --- Lists ------------------------------------------------------------------------

  /**
   * The `background` list of each session, from Claude Code's live background
   * tasks: its background terminals, tool calls and other tasks, and its
   * children that work in the background or have background work of their
   * own. Claude Code marks its housekeeping `ambient`, which is left out,
   * except a task that a tool call started. A task that a tool call started
   * is part of that call until the call returns, and is not listed.
   */
  private lists(): Map<string, BackgroundItem[]> {
    const lists = new Map<string, BackgroundItem[]>([[this.host.sessionId, []]]);
    const children = this.parentsFirst();
    for (const child of children) lists.set(child.sessionId, []);
    const sessionOfTask = (taskId: string | undefined) => {
      const child = taskId !== undefined ? this.children.get(taskId) : undefined;
      return child?.announced ? child.sessionId : this.host.sessionId;
    };
    for (const [taskId, task] of this.level) {
      const toolCall = this.toolCalls.get(taskId);
      if (toolCall) {
        lists
          .get(toolCall.output.sessionId)
          ?.push({ type: "tool_call", toolCallId: toolCall.toolCallId });
        continue;
      }
      if (task.ambient) continue;
      const terminal = this.terminals.get(taskId);
      if (terminal) {
        lists
          .get(terminal.output.sessionId)
          ?.push({ type: "terminal", terminalId: terminal.toolCallId });
        continue;
      }
      if (task.taskType === "local_bash" || task.taskType === "local_agent") continue;
      const started = this.started.get(taskId);
      if (!started || (started.toolUseId && !this.returned.has(started.toolUseId))) continue;
      lists
        .get(sessionOfTask(task.parentTaskId))
        ?.push({ type: "_claude/task", taskId, description: task.description });
    }
    // A terminal whose task left the level is listed until its exit, which
    // waits for the rest of its output.
    for (const [taskId, terminal] of this.terminals) {
      if (terminal.ending && terminal.leveled && !this.level.has(taskId)) {
        lists
          .get(terminal.output.sessionId)
          ?.push({ type: "terminal", terminalId: terminal.toolCallId });
      }
    }
    // Deeper children first: a child's own list is whole before its parent's reads it.
    for (const child of [...children].reverse()) {
      const task = this.level.get(child.sessionId);
      const inBackground = child.working && task !== undefined && !task.ambient;
      if (inBackground || (lists.get(child.sessionId)?.length ?? 0) > 0) {
        lists.get(child.parentSessionId)?.push({ type: "subagent", sessionId: child.sessionId });
      }
    }
    return lists;
  }

  /** The task of the terminal or tool call `target` that `sessionId` lists. */
  private listedTask(
    sessionId: string,
    target: { terminalId: string } | { toolCallId: string },
  ): string | undefined {
    if (!this.host.reportsBackground) return undefined;
    const listed = this.lists().get(sessionId) ?? [];
    return "terminalId" in target
      ? listed.some((item) => item.type === "terminal" && item.terminalId === target.terminalId)
        ? [...this.terminals].find(([, t]) => t.toolCallId === target.terminalId)?.[0]
        : undefined
      : listed.some((item) => item.type === "tool_call" && item.toolCallId === target.toolCallId)
        ? [...this.toolCalls].find(([, t]) => t.toolCallId === target.toolCallId)?.[0]
        : undefined;
  }

  private followOutput(taskId: string, outputFilePath: string | undefined): void {
    const terminal = this.terminals.get(taskId);
    if (!terminal || !outputFilePath || !this.host.reportsBackground) return;
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
export function sameDirectory(left: string, right: string): boolean {
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

function nonBlank(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
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
