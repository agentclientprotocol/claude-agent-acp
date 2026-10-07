import type { SessionNotification } from "@agentclientprotocol/sdk";
import type { AcpSessionNotification, SubagentForm, SubagentState } from "./acp-subagents.js";
import { AIR_SUBAGENT_KEY, airExtensionMeta } from "./air-extension.js";

/** The work state of a child, as the RFD's `subagent_update.state` carries it. */
type WorkState = NonNullable<
  Extract<SessionNotification["update"], { sessionUpdate: "subagent_update" }>["state"]
>;

export type NativeSubagent = {
  sessionId: string;
  parentSessionId: string;
  parentToolUseId?: string;
  name: string;
  task: string;
  /**
   * The exact prompt of this generation, sent as `prompt` in
   * `subagent_spawned`, or as the child's first `session_message` in the RFD
   * form. It is absent when the adapter has no prompt.
   */
  prompt?: string;
  /** The RFD form: the parent's label for the child, `subagent_update.title`. */
  title?: string;
  /** The RFD form: the child's role, its `subagent_type`, for the title. */
  role?: string;
  /** The RFD form: the child's purpose, `subagent_update.description`. */
  description?: string;
  /**
   * The RFD form: the work state the client holds. The child is reusable, so
   * `idle` is not terminal. AIR's draft uses {@link terminalState} instead.
   */
  workState?: WorkState["state"];
  /**
   * The RFD form: the child's idle snapshot reports a failure without the
   * SDK's error text, which a later event of the same failure may carry.
   */
  missingError?: boolean;
  /** The RFD form: the open permission and question requests of the child. */
  openRequests?: number;
  /** The RFD form: the ids of the prompt messages in the child's transcript. */
  promptIds?: Set<string>;
  /** The RFD form: the calls that delegated to the child, whose runs ended. */
  endedRuns?: Set<string>;
  announced?: boolean;
  terminalState?: SubagentState;
  /** Connection-local single-flight state; never serialized on the wire. */
  announcePromise?: Promise<void>;
  /** Connection-local single-flight state; never serialized on the wire. */
  terminalPromise?: Promise<void>;
};

export type NativeSubagentSession = {
  nativeSubagentsByTaskId?: Map<string, NativeSubagent>;
  nativeSubagentTaskIdByToolUseId?: Map<string, string>;
  nativeSubagentParentByToolUseId?: Map<string, string>;
};

type Publish = (notification: AcpSessionNotification) => Promise<void>;
type Logger = { log(message: string): void };

/** What the SDK says about the end of a task, beyond its status. */
export type TaskEnd = {
  /** The SDK's text for a failure. */
  error?: string;
  /** The SDK's reason for an unusual end, such as `worker_restart`. */
  reason?: string;
  /**
   * The adapter knows that the work ended, but not why: the stream ended, or
   * the conversation was reset, with the task still running.
   */
  unexplained?: boolean;
};

type TaskStarted = {
  taskId: string;
  toolUseId?: string | null;
  subagentType?: unknown;
  description?: unknown;
  prompt?: unknown;
};

type SubagentIdentity = {
  name?: string;
  description?: string;
  prompt?: string;
  subagentType?: string;
};

const MAX_PENDING_PARENTS = 64;
const MAX_PENDING_UPDATES = 256;
const MAX_PENDING_UPDATES_PER_PARENT = 32;
/** The number of child tool calls whose owning child session the runtime remembers. */
const MAX_CHILD_TOOL_CALLS = 2048;

/**
 * Owns the connection-local native subagent registry and all ACP lifecycle
 * ordering. The main agent only supplies SDK facts and delivers routed output.
 */
export class NativeSubagentRuntime {
  readonly enabled: boolean;
  /** The form of the child sessions; see {@link SubagentForm}. */
  readonly form: SubagentForm | undefined;

  private readonly children: Map<string, NativeSubagent>;
  private readonly taskByToolUse: Map<string, string>;
  private readonly parentByToolUse: Map<string, string>;
  private readonly identityByToolUse = new Map<string, SubagentIdentity>();
  private readonly controlByToolUse = new Map<string, AcpSessionNotification>();
  private readonly childByParentToolUse = new Map<string, NativeSubagent>();
  /**
   * The child session of each tool call that went to a child session. A later
   * update of that tool call can lose `parentToolUseId`, for example a progress
   * beat after the child finished. It still belongs to the child session.
   */
  private readonly childByToolCall = new Map<string, NativeSubagent>();
  private readonly taskFinishPromises = new Map<string, Promise<void>>();
  /** The RFD form: the session that made each SendMessage call. */
  private readonly senderByToolUse = new Map<string, string>();
  private readonly generationByTaskId = new Map<string, number>();
  private readonly pending = new Map<string, AcpSessionNotification[]>();
  private pendingCount = 0;

  /** `form` is undefined for a client without native subagent sessions. */
  constructor(
    form: SubagentForm | undefined,
    private readonly rootSessionId: string,
    private readonly session: NativeSubagentSession,
    private readonly publish: Publish,
    private readonly logger: Logger,
  ) {
    this.form = form;
    this.enabled = form !== undefined;
    this.children = session.nativeSubagentsByTaskId ??= new Map();
    this.taskByToolUse = session.nativeSubagentTaskIdByToolUseId ??= new Map();
    this.parentByToolUse = session.nativeSubagentParentByToolUseId ??= new Map();
    for (const child of this.children.values()) {
      if (child.parentToolUseId) {
        this.childByParentToolUse.set(child.parentToolUseId, child);
      }
    }
  }

  async route(
    notification: AcpSessionNotification,
    deliver: Publish,
    forcedSessionId?: string,
  ): Promise<AcpSessionNotification | null> {
    const routed = await this.routeUpdate(notification, deliver, forcedSessionId);
    if (routed && this.form === "rfd") this.rememberSendMessage(routed);
    return routed;
  }

  private async routeUpdate(
    notification: AcpSessionNotification,
    deliver: Publish,
    forcedSessionId?: string,
  ): Promise<AcpSessionNotification | null> {
    const { update } = notification;
    const claudeMeta = update._meta?.claudeCode as
      { parentToolUseId?: string | null; toolName?: string } | undefined;
    const isControl = isNativeSubagentControlUpdate(update);

    if (!this.enabled) return notification;

    if (this.enabled && isControl) {
      const toolCallId = update.toolCallId;
      if (update.sessionUpdate === "tool_call") {
        this.controlByToolUse.set(toolCallId, notification);
      }
      const identity = subagentIdentity(update.rawInput);
      if (identity) {
        this.identityByToolUse.set(
          toolCallId,
          mergeSubagentIdentity(this.identityByToolUse.get(toolCallId), identity),
        );
      }
      const parentSessionId = claudeMeta?.parentToolUseId
        ? this.childByParentToolUse.get(claudeMeta.parentToolUseId)?.sessionId
        : this.rootSessionId;
      this.parentByToolUse.set(toolCallId, parentSessionId ?? this.rootSessionId);

      const child = this.childByParentToolUse.get(toolCallId);
      if (child && !child.announced) {
        child.parentSessionId = parentSessionId ?? this.rootSessionId;
        applySubagentIdentity(child, this.identityByToolUse.get(toolCallId));
        await this.announce(child);
        for (const pending of this.takePending(toolCallId)) await deliver(pending);
      }
      if (this.form === "air") {
        if (!child && isFailedToolCallUpdate(update)) {
          this.takePending(toolCallId);
          const initial = this.controlByToolUse.get(toolCallId);
          this.cleanupControl(toolCallId);
          if (forcedSessionId) {
            return { ...notification, sessionId: forcedSessionId };
          }
          return failedControlFallback(
            initial,
            notification,
            parentSessionId ?? this.rootSessionId,
          );
        }
        return forcedSessionId ? { ...notification, sessionId: forcedSessionId } : null;
      }
      // The RFD form: the Agent/Task tool call is the parent's record of the
      // delegation, so it stays a tool call of the session that made it.
    }

    const toolCallId =
      update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update"
        ? update.toolCallId
        : undefined;

    // A permission request may have had to create the tool call before native
    // child ownership was known. Keep every later update in that original ACP
    // session; moving a lifecycle after its initial call creates an orphan in
    // both transcripts.
    if (forcedSessionId) {
      const forcedChild = this.childOfSession(forcedSessionId);
      if (toolCallId && forcedChild) this.rememberToolCallOwner(toolCallId, forcedChild);
      return { ...notification, sessionId: forcedSessionId };
    }

    const owner = toolCallId ? this.childByToolCall.get(toolCallId) : undefined;
    if (owner) return this.toChild(owner, notification, toolCallId);

    if (this.enabled && claudeMeta?.parentToolUseId) {
      const child = this.childByParentToolUse.get(claudeMeta.parentToolUseId);
      if (!child || !child.announced) {
        this.buffer(claudeMeta.parentToolUseId, notification);
        return null;
      }
      return this.toChild(child, notification, toolCallId);
    }

    return notification;
  }

  async taskStarted(task: TaskStarted, deliver: Publish): Promise<void> {
    if (!this.enabled) return;
    const known = this.form === "rfd" ? this.children.get(task.taskId) : undefined;
    if (known) {
      // A child keeps its session for every delegation to it. The SDK starts
      // a resumed agent again under the id of the call that resumed it.
      await this.resumeChild(
        known,
        task.taskId,
        promptText(task.prompt),
        task.toolUseId ?? undefined,
        deliver,
      );
      return;
    }
    if (!task.subagentType) {
      if (task.toolUseId) {
        this.takePending(task.toolUseId);
        this.cleanupControl(task.toolUseId);
      }
      return;
    }
    const previous = this.children.get(task.taskId);
    if (previous && previous.terminalState === undefined) return;

    // A SendMessage resume reuses the finished generation's tool id, whose
    // control state is already cleaned up.
    const knownParentSessionId =
      (task.toolUseId ? this.parentByToolUse.get(task.toolUseId) : undefined) ??
      (previous && this.resumedParentSessionId(previous));
    const identity = task.toolUseId ? this.identityByToolUse.get(task.toolUseId) : undefined;
    // A nested child must wait for the spawning Agent/Task frame to establish
    // its immediate parent. Root children without a tool id can be announced.
    await this.openGeneration(
      task.taskId,
      previous,
      {
        parentSessionId: knownParentSessionId ?? this.rootSessionId,
        parentToolUseId: task.toolUseId ?? undefined,
        name: subagentDisplayName(
          identity?.name,
          identity?.description ?? task.description,
          identity?.subagentType ?? task.subagentType,
          task.taskId,
        ),
        task: subagentDescription(
          identity?.prompt ?? task.prompt,
          identity?.description ?? task.description,
        ),
        ...promptField(promptText(task.prompt) ?? identity?.prompt),
        ...rfdLabels(
          identity?.name,
          identity?.subagentType ?? task.subagentType,
          identity?.description ?? task.description,
        ),
      },
      !!knownParentSessionId || !task.toolUseId,
      deliver,
    );
  }

  /**
   * Opens a new generation of a finished child when the SDK resumes the same
   * agent id. The SDK can resume a child without a new `task_started`, so a
   * running `task_updated` patch or a SendMessage `resumedAgentId` is the
   * signal. A child that did not finish is not changed. The `prompt` is the
   * SendMessage text that resumed the child, when the adapter knows it.
   *
   * In the RFD form, the running patch only reports that the child runs: its
   * prompt is a guess (the latest SendMessage to the agent), and the
   * `task_started` or the SendMessage result carries the delegation.
   */
  async taskResumed(taskId: string, deliver: Publish, prompt?: string): Promise<void> {
    if (!this.enabled) return;
    const previous = this.children.get(taskId);
    if (!previous) return;
    const finishing = this.taskFinishPromises.get(taskId) ?? previous.terminalPromise;
    if (finishing) await finishing.catch(() => {});
    if (this.form === "rfd") {
      await this.resumeChild(previous, taskId, undefined, undefined, deliver);
      return;
    }
    if (this.children.get(taskId) !== previous || previous.terminalState === undefined) return;
    await this.openGeneration(
      taskId,
      previous,
      {
        parentSessionId: this.resumedParentSessionId(previous),
        parentToolUseId: previous.parentToolUseId,
        name: previous.name,
        task: previous.task,
        ...promptField(promptText(prompt)),
      },
      true,
      deliver,
    );
  }

  /**
   * The SDK reports in a SendMessage result that the call `toolUseId`, with
   * the message `prompt`, resumed the agent `taskId`. AIR's draft treats it as
   * any resume signal. In the RFD form, the call is the delegation, which the
   * child takes unless its run already ended: the result can arrive after it.
   */
  async sendMessageResumed(
    taskId: string,
    deliver: Publish,
    prompt?: string,
    toolUseId?: string,
  ): Promise<void> {
    if (this.form !== "rfd") return this.taskResumed(taskId, deliver, prompt);
    const child = this.children.get(taskId);
    if (!child) return;
    const finishing = this.taskFinishPromises.get(taskId);
    if (finishing) await finishing.catch(() => {});
    if (this.isEndedDelegation(taskId, toolUseId)) return;
    await this.resumeChild(child, taskId, promptText(prompt), toolUseId, deliver);
  }

  /**
   * The RFD form: whether the run of the call `toolUseId` that delegated to
   * the child `taskId` already ended. AIR's draft has no such runs.
   */
  isEndedDelegation(taskId: string, toolUseId: string | null | undefined): boolean {
    if (this.form !== "rfd" || !toolUseId) return false;
    return this.children.get(taskId)?.endedRuns?.has(toolUseId) ?? false;
  }

  /**
   * The RFD form: whether `toolUseId` is an earlier delegation of the child
   * `taskId`, whose end does not end the current one. AIR's draft has no
   * such delegations.
   */
  isStaleEnd(taskId: string, toolUseId: string | null | undefined): boolean {
    if (this.form !== "rfd" || !toolUseId) return false;
    const child = this.children.get(taskId);
    return (
      !!child &&
      child.parentToolUseId !== undefined &&
      toolUseId !== child.parentToolUseId &&
      this.childByParentToolUse.get(toolUseId) === child
    );
  }

  /**
   * Reports that the SDK ended the task's work. `end` has what the SDK says
   * about it: its text for a failure, and its reason for an unusual end.
   */
  async finishTask(
    taskId: string,
    status: unknown,
    deliver: Publish,
    toolUseId?: string | null,
    end?: TaskEnd,
  ): Promise<void> {
    if (!this.enabled) return;
    const state = nativeSubagentState(status);
    const child = toolUseId ? this.childByParentToolUse.get(toolUseId) : this.children.get(taskId);
    if (child && toolUseId && this.taskByToolUse.get(toolUseId) !== taskId) return;
    if (!state || !child) return;
    if (this.form === "rfd") {
      if (this.isStaleEnd(taskId, toolUseId)) return;
      if (!child.announced && !child.announcePromise) {
        this.withdraw(taskId, child);
        return;
      }
    }
    const existing = this.taskFinishPromises.get(taskId);
    if (existing) {
      await existing;
      if (this.form === "rfd") await this.supplyError(child, state, end?.error);
      return;
    }
    if (this.form === "air" ? child.terminalState !== undefined : child.workState === "idle") {
      if (this.form === "rfd") await this.supplyError(child, state, end?.error);
      return;
    }

    const finish = Promise.resolve().then(async () => {
      try {
        await this.announce(child);
        if (child.parentToolUseId) {
          for (const pending of this.takePending(child.parentToolUseId)) await deliver(pending);
        }
        if (this.form === "rfd") {
          await this.reportState(child, rfdEndState(state, end));
          child.missingError = state === "failed" && !end?.error && !end?.unexplained;
          if (child.parentToolUseId) (child.endedRuns ??= new Set()).add(child.parentToolUseId);
        } else {
          await finishNativeSubagent(this.session, taskId, state, this.publish);
        }
      } finally {
        if (child.parentToolUseId) {
          this.cleanupControl(child.parentToolUseId);
        }
      }
    });
    this.taskFinishPromises.set(taskId, finish);
    try {
      await finish;
    } finally {
      if (this.taskFinishPromises.get(taskId) === finish) this.taskFinishPromises.delete(taskId);
    }
  }

  /**
   * Ends every child that still runs, because the stream ended or the
   * conversation was reset. AIR's draft reports `state` for each. In the RFD
   * form the cause of each child's end is unknown, so it is idle with no stop
   * reason: a child that a cancel stopped already reported it from the SDK's
   * events, and a background child that outlived the cancel was not cancelled.
   */
  async finishAll(state: SubagentState, deliver: Publish): Promise<void> {
    const errors: unknown[] = [];
    const end = this.form === "rfd" ? { unexplained: true } : undefined;
    try {
      for (const taskId of [...this.children.keys()].reverse()) {
        try {
          await this.finishTask(taskId, state, deliver, undefined, end);
        } catch (error) {
          errors.push(error);
        }
      }
    } finally {
      this.pending.clear();
      this.pendingCount = 0;
      this.identityByToolUse.clear();
      this.controlByToolUse.clear();
      this.parentByToolUse.clear();
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, "Failed to finish native subagents");
  }

  /**
   * The parent session got `session/cancel`. AIR's draft ends every child as
   * cancelled here. The RFD form reports nothing: acknowledging a cancel is no
   * evidence that a child stopped. The interrupt stops the foreground children
   * that the turn waits on, which the SDK's task events then report as
   * cancelled; a background child keeps running, and keeps its open requests
   * (agentclientprotocol/agent-client-protocol#2308).
   */
  async parentCancelled(deliver: Publish): Promise<void> {
    if (this.form === "air") await this.finishAll("cancelled", deliver);
  }

  /**
   * Runs `request`, a permission or question request of the session
   * `sessionId`. In the RFD form, a child waiting on it is `requires_action`
   * until its last open request ends.
   */
  async awaitingUser<T>(sessionId: string, request: () => Promise<T>): Promise<T> {
    const child = this.form === "rfd" ? this.childOfSession(sessionId) : undefined;
    if (!child?.announced) return request();
    child.openRequests = (child.openRequests ?? 0) + 1;
    if (child.openRequests === 1 && child.workState === "running") {
      await this.reportState(child, { state: "requires_action" }).catch((error) =>
        this.logger.log(`Failed to report that subagent ${child.sessionId} waits: ${error}`),
      );
    }
    try {
      return await request();
    } finally {
      child.openRequests = (child.openRequests ?? 1) - 1;
      if (child.openRequests === 0 && child.workState === "requires_action") {
        await this.reportState(child, { state: "running" }).catch((error) =>
          this.logger.log(`Failed to report that subagent ${child.sessionId} runs: ${error}`),
        );
      }
    }
  }

  discardPending(parentToolUseId: string): void {
    this.takePending(parentToolUseId);
  }

  /**
   * The RFD form: the child runs again, and keeps its session. `toolUseId` is
   * the call that delegated, usually a SendMessage: the SDK runs the resumed
   * work under its id, so it becomes the child's current delegation, whose
   * end ends the run, and its prompt is the message with that id. A child
   * that is already working only takes the delegation; a prompt already in
   * its transcript is not sent again. A child that was never announced is
   * not changed.
   */
  private async resumeChild(
    child: NativeSubagent,
    taskId: string,
    prompt: string | undefined,
    toolUseId: string | undefined,
    deliver: Publish,
  ): Promise<void> {
    if (!child.announced) return;
    if (toolUseId && toolUseId !== child.parentToolUseId) {
      this.taskByToolUse.set(toolUseId, taskId);
      this.childByParentToolUse.set(toolUseId, child);
      child.parentToolUseId = toolUseId;
    }
    if (!isWorking(child)) {
      await this.reportState(child, {
        state: child.openRequests ? "requires_action" : "running",
      });
    }
    if (prompt && toolUseId) {
      await publishPrompt(
        child,
        prompt,
        toolUseId,
        this.senderByToolUse.get(toolUseId),
        this.publish,
      );
    }
    for (const pending of toolUseId ? this.takePending(toolUseId) : []) await deliver(pending);
  }

  /**
   * The RFD form: a child that ends before its parent is known stays
   * unexposed, since the RFD forbids guessing its parent. Its buffered updates
   * are dropped, and it is forgotten, so a late frame does not announce it.
   * (Buffering until that frame would also meet the RFD, but the frame comes
   * before the task in the SDK's order, so a child ending without it is rare.)
   */
  private withdraw(taskId: string, child: NativeSubagent): void {
    this.children.delete(taskId);
    if (child.parentToolUseId) {
      this.takePending(child.parentToolUseId);
      this.cleanupControl(child.parentToolUseId);
      this.childByParentToolUse.delete(child.parentToolUseId);
      this.taskByToolUse.delete(child.parentToolUseId);
    }
  }

  /**
   * The RFD form: a later event of a failure can carry the SDK's error text
   * that the reported idle snapshot lacks.
   */
  private async supplyError(
    child: NativeSubagent,
    state: SubagentState,
    error: string | undefined,
  ): Promise<void> {
    if (state !== "failed" || !error || !child.missingError) return;
    await this.reportState(child, rfdEndState("failed", { error }));
  }

  /** Announces `child` in the client's form. A runtime without one never does. */
  private async announce(child: NativeSubagent): Promise<void> {
    if (this.form) await announceNativeSubagent(child, this.publish, this.form);
  }

  /** The RFD form: publishes the work state of `child` on its parent. */
  private async reportState(child: NativeSubagent, state: WorkState): Promise<void> {
    child.workState = state.state;
    child.missingError = false;
    await this.publish({
      sessionId: child.parentSessionId,
      update: { sessionUpdate: "subagent_update", sessionId: child.sessionId, state },
    });
  }

  /**
   * Routes an update to the child session. It never goes to the root session:
   * in AIR's draft, an update of a finished child is dropped.
   */
  private toChild(
    child: NativeSubagent,
    notification: AcpSessionNotification,
    toolCallId: string | undefined,
  ): AcpSessionNotification | null {
    // AIR's draft ends a child for good. In the RFD form an idle child is
    // reusable, and its background work can still report.
    if (this.form === "air" && (child.terminalState !== undefined || child.terminalPromise)) {
      this.logger.log(
        `Session ${this.rootSessionId}: ignoring late update for terminal subagent ${child.sessionId}`,
      );
      return null;
    }
    if (toolCallId) this.rememberToolCallOwner(toolCallId, child);
    return { ...notification, sessionId: child.sessionId };
  }

  /**
   * The route of the work that a child tool call started, for example an async
   * task. The route sends each update to the child generation that owned the
   * tool call when the work started. An async task can outlive that child: a
   * subagent can start a background command and end its turn. So the route
   * still sends `async_task_spawned`, `async_task_progress` and
   * `async_task_state_update` to the child generation after it finished. In
   * AIR's draft, the route drops every other update after the child finished;
   * in the RFD form, an idle child gets them all. `undefined` means that the
   * root session owns the tool call. `eagerSessionId` is the session where a
   * permission request created the tool call before the stream routed it.
   */
  routeOfToolCall(
    toolCallId: string,
    eagerSessionId?: string,
  ): ((notification: AcpSessionNotification) => AcpSessionNotification | null) | undefined {
    if (!this.enabled) return undefined;
    const owner =
      this.childByToolCall.get(toolCallId) ??
      (eagerSessionId ? this.childOfSession(eagerSessionId) : undefined);
    return (
      owner &&
      ((notification) =>
        isLateAsyncTaskUpdate(notification)
          ? { ...notification, sessionId: owner.sessionId }
          : this.toChild(owner, notification, undefined))
    );
  }

  /**
   * The RFD form: remembers the session that made a SendMessage call, the
   * sender of the prompt when the call resumes a child.
   */
  private rememberSendMessage(notification: AcpSessionNotification): void {
    const { update } = notification;
    if (update.sessionUpdate !== "tool_call") return;
    const claudeMeta = update._meta?.claudeCode as { toolName?: string } | undefined;
    if (claudeMeta?.toolName !== "SendMessage") return;
    this.senderByToolUse.delete(update.toolCallId);
    this.senderByToolUse.set(update.toolCallId, notification.sessionId);
    if (this.senderByToolUse.size > MAX_CHILD_TOOL_CALLS) {
      const oldest = this.senderByToolUse.keys().next().value;
      if (oldest !== undefined) this.senderByToolUse.delete(oldest);
    }
  }

  private rememberToolCallOwner(toolCallId: string, child: NativeSubagent): void {
    this.childByToolCall.delete(toolCallId);
    this.childByToolCall.set(toolCallId, child);
    if (this.childByToolCall.size > MAX_CHILD_TOOL_CALLS) {
      const oldest = this.childByToolCall.keys().next().value;
      if (oldest !== undefined) this.childByToolCall.delete(oldest);
    }
  }

  /** The child generation with the ACP session `sessionId`, if one exists. */
  private childOfSession(sessionId: string): NativeSubagent | undefined {
    if (sessionId === this.rootSessionId) return undefined;
    for (const child of this.children.values()) {
      if (child.sessionId === sessionId) return child;
    }
    return undefined;
  }

  clear(): void {
    this.children.clear();
    this.childByToolCall.clear();
    this.taskByToolUse.clear();
    this.parentByToolUse.clear();
    this.identityByToolUse.clear();
    this.controlByToolUse.clear();
    this.childByParentToolUse.clear();
    this.taskFinishPromises.clear();
    this.senderByToolUse.clear();
    this.generationByTaskId.clear();
    this.pending.clear();
    this.pendingCount = 0;
  }

  private takePending(parentToolUseId: string): AcpSessionNotification[] {
    const updates = this.pending.get(parentToolUseId) ?? [];
    if (updates.length > 0) {
      this.pending.delete(parentToolUseId);
      this.pendingCount -= updates.length;
    }
    return updates;
  }

  private buffer(parentToolUseId: string, notification: AcpSessionNotification): void {
    const updates = this.pending.get(parentToolUseId);
    if (
      this.pendingCount >= MAX_PENDING_UPDATES ||
      (updates === undefined && this.pending.size >= MAX_PENDING_PARENTS) ||
      (updates?.length ?? 0) >= MAX_PENDING_UPDATES_PER_PARENT
    ) {
      this.logger.log(
        `Session ${this.rootSessionId}: dropping unattributed subagent update for ${parentToolUseId}; pending buffer limit reached`,
      );
      return;
    }
    if (updates) updates.push(notification);
    else this.pending.set(parentToolUseId, [notification]);
    this.pendingCount++;
  }

  private cleanupControl(toolUseId: string): void {
    this.identityByToolUse.delete(toolUseId);
    this.controlByToolUse.delete(toolUseId);
    this.parentByToolUse.delete(toolUseId);
  }

  /** The parent of a resumed generation: the old parent while it is live, else the root. */
  private resumedParentSessionId(previous: NativeSubagent): string {
    return this.isLiveSession(previous.parentSessionId)
      ? previous.parentSessionId
      : this.rootSessionId;
  }

  private isLiveSession(sessionId: string): boolean {
    if (sessionId === this.rootSessionId) return true;
    for (const child of this.children.values()) {
      if (child.sessionId === sessionId) return child.terminalState === undefined;
    }
    return false;
  }

  /**
   * Registers a new child session for the task and makes it the owner of its
   * parent tool call. With `announce`, it publishes `subagent_spawned` and
   * delivers the updates that waited for the child.
   */
  private async openGeneration(
    taskId: string,
    previous: NativeSubagent | undefined,
    fields: Pick<
      NativeSubagent,
      | "parentSessionId"
      | "parentToolUseId"
      | "name"
      | "task"
      | "prompt"
      | "title"
      | "role"
      | "description"
    >,
    announce: boolean,
    deliver: Publish,
  ): Promise<void> {
    const child: NativeSubagent = {
      sessionId: this.nextChildSessionId(taskId, previous),
      ...fields,
    };
    const toolUseId = child.parentToolUseId;
    this.children.set(taskId, child);
    if (toolUseId) {
      this.taskByToolUse.set(toolUseId, taskId);
      this.childByParentToolUse.set(toolUseId, child);
      this.controlByToolUse.delete(toolUseId);
    }
    if (!announce) return;
    await this.announce(child);
    for (const pending of toolUseId ? this.takePending(toolUseId) : []) await deliver(pending);
  }

  /**
   * The ACP session id of a child: the SDK agent id, and in AIR's draft a
   * generation suffix for each resume. The RFD needs it unique within the
   * connection and never under two parents. Agent ids are random, and an
   * agent keeps its parent, so only a fork could repeat one under another
   * root. That holds today because the SDK's `forkSession` copies no
   * `subagents/` history, so a fork cannot resume an agent of the original.
   * If a fork ever can, the RFD requires remapping the copied ids, for
   * example by deriving the child id from the root session id.
   */
  private nextChildSessionId(taskId: string, previous: NativeSubagent | undefined): string {
    if (!previous) {
      this.generationByTaskId.set(taskId, 1);
      return taskId;
    }
    const generation = (this.generationByTaskId.get(taskId) ?? 1) + 1;
    this.generationByTaskId.set(taskId, generation);
    return `${taskId}:generation:${generation}`;
  }
}

/**
 * Announces the child on its parent, once, before any update of the child.
 * The RFD form announces it as running and then sends the prompt as the
 * first message of the child. The child gets no capabilities, so the client
 * may not cancel or otherwise change it.
 */
export async function announceNativeSubagent(
  child: NativeSubagent,
  publish: Publish,
  form: SubagentForm,
): Promise<void> {
  if (child.announced) return;
  if (child.announcePromise) return child.announcePromise;
  const announce = Promise.resolve().then(async () => {
    if (form === "rfd") {
      child.workState = "running";
      await publish({
        sessionId: child.parentSessionId,
        update: {
          sessionUpdate: "subagent_update",
          sessionId: child.sessionId,
          ...(child.title ? { title: child.title } : {}),
          ...(child.description ? { description: child.description } : {}),
          state: { state: "running" },
        },
      });
      child.announced = true;
      // The immediate parent made the Agent/Task call that launched the child.
      if (child.prompt) {
        await publishPrompt(
          child,
          child.prompt,
          child.parentToolUseId,
          child.parentSessionId,
          publish,
        );
      }
      return;
    }
    await publish({
      sessionId: child.parentSessionId,
      update: {
        sessionUpdate: "subagent_spawned",
        subagentSessionId: child.sessionId,
        name: child.name,
        task: child.task,
        ...promptField(child.prompt),
        capabilities: {},
      },
    });
    child.announced = true;
  });
  child.announcePromise = announce;
  try {
    await announce;
  } finally {
    if (child.announcePromise === announce) child.announcePromise = undefined;
  }
}

export async function finishNativeSubagent(
  session: NativeSubagentSession,
  taskId: string,
  state: SubagentState,
  publish: Publish,
): Promise<void> {
  const child = session.nativeSubagentsByTaskId?.get(taskId);
  if (!child || child.terminalState !== undefined) return;
  if (child.terminalPromise) return child.terminalPromise;
  const finish = Promise.resolve().then(async () => {
    await announceNativeSubagent(child, publish, "air");
    await publish({
      sessionId: child.parentSessionId,
      update: {
        sessionUpdate: "subagent_state_update",
        subagentSessionId: child.sessionId,
        state,
      },
    });
    child.terminalState = state;
  });
  child.terminalPromise = finish;
  try {
    await finish;
  } finally {
    if (child.terminalPromise === finish) child.terminalPromise = undefined;
  }
}

/**
 * The RFD form: a message to the child, in the child's transcript (its
 * incoming view). Its id is the id of the tool use that sent it, the
 * Agent/Task call or a SendMessage, so a prompt whose id is already in the
 * transcript is the same delegation and is not sent again. `sender` is the
 * session that made that call, when known.
 */
async function publishPrompt(
  child: NativeSubagent,
  prompt: string,
  toolUseId: string | undefined,
  sender: string | undefined,
  publish: Publish,
): Promise<void> {
  child.promptIds ??= new Set();
  const messageId = toolUseId ?? `${child.sessionId}:prompt:${child.promptIds.size + 1}`;
  if (child.promptIds.has(messageId)) return;
  child.promptIds.add(messageId);
  await publish({
    sessionId: child.sessionId,
    update: {
      sessionUpdate: "session_message",
      messageId,
      ...(sender ? { senderSessionId: sender } : {}),
      recipientSessionId: child.sessionId,
      content: [{ type: "text", text: prompt }],
    },
  });
}

/** The RFD form: whether the child's foreground work is in progress. */
function isWorking(child: NativeSubagent): boolean {
  return child.workState === "running" || child.workState === "requires_action";
}

/**
 * The RFD form: the work state at the end of a child's work.
 *
 * A failure has no stop reason yet: the RFD's `error` stop reason, with its
 * JSON-RPC `error`, is newer than SDK 1.7.0's v1 schema, whose `StopReason`
 * is closed. Until the SDK has it, the failure goes in
 * `_meta.claudeCode.error`, as the v2 surface does for a failed turn.
 *
 * A task that a worker restart orphaned, or that was still running when the
 * stream ended, is idle with no stop reason: its work ended, but the adapter
 * did not see a cancellation or a failure, which the RFD forbids claiming.
 */
function rfdEndState(state: SubagentState, end: TaskEnd | undefined): WorkState {
  if (end?.unexplained || end?.reason === "worker_restart") return { state: "idle" };
  switch (state) {
    case "completed":
      return { state: "idle", stopReason: "end_turn" };
    case "cancelled":
      return { state: "idle", stopReason: "cancelled" };
    case "failed":
      return {
        state: "idle",
        ...(end?.error
          ? { _meta: { claudeCode: { error: { code: -32603, message: end.error } } } }
          : {}),
      };
    default:
      // "disconnected": the child can no longer be observed.
      return { state: "unknown" };
  }
}

/**
 * The RFD form: the parent's labels for a child. The title is the agent's
 * name, with its role after it when both are known, else the role. The
 * description is the task's short description, never the prompt.
 */
function rfdLabels(
  name: unknown,
  role: unknown,
  description: unknown,
): { title?: string; role?: string; description?: string } {
  const agentName = nonBlankString(name);
  const agentRole = nonBlankString(role);
  const title =
    agentName && agentRole && agentName !== agentRole
      ? `${agentName} (${agentRole})`
      : (agentName ?? agentRole);
  const text = nonBlankString(description);
  return {
    ...(title ? { title } : {}),
    ...(agentRole ? { role: agentRole } : {}),
    ...(text ? { description: text } : {}),
  };
}

/**
 * The agent id that a successful SendMessage result resumed. The SDK puts it
 * in `tool_use_result.resumedAgentId` when a finished agent runs again.
 */
export function resumedNativeSubagentId(toolUseResult: unknown): string | undefined {
  if (typeof toolUseResult !== "object" || toolUseResult === null) return undefined;
  const result = toolUseResult as { success?: unknown; resumedAgentId?: unknown };
  return result.success === true ? nonBlankString(result.resumedAgentId) : undefined;
}

/**
 * The SendMessage text that resumed the agent `agentId`. The tool uses of
 * `resultToolUseIds` come first: they are the SendMessage calls whose result
 * carried the resume. Otherwise the latest SendMessage call to `agentId` counts.
 */
export function sendMessageResumePrompt(
  toolUses: Record<string, { name: string; input: unknown } | undefined>,
  agentId: string,
  resultToolUseIds: readonly string[] = [],
): string | undefined {
  return sendMessageResume(toolUses, agentId, resultToolUseIds)?.text;
}

/**
 * The SendMessage call that resumed the agent `agentId`, and its text when it
 * has one; see {@link sendMessageResumePrompt}. The call is known even
 * without text, so a late result still names the delegation it reports.
 */
export function sendMessageResume(
  toolUses: Record<string, { name: string; input: unknown } | undefined>,
  agentId: string,
  resultToolUseIds: readonly string[] = [],
): { toolUseId: string; text?: string } | undefined {
  let withoutText: string | undefined;
  for (const toolUseId of resultToolUseIds) {
    const toolUse = toolUses[toolUseId];
    if (toolUse?.name !== "SendMessage") continue;
    const text = promptText((toolUse.input as { message?: unknown } | null)?.message);
    if (text) return { toolUseId, text };
    withoutText ??= toolUseId;
  }
  if (resultToolUseIds.length > 0) return withoutText ? { toolUseId: withoutText } : undefined;
  for (const [toolUseId, toolUse] of Object.entries(toolUses).reverse()) {
    if (toolUse?.name !== "SendMessage") continue;
    const input = toolUse.input as { to?: unknown; message?: unknown } | null;
    if (input?.to !== agentId) continue;
    const text = promptText(input.message);
    return text ? { toolUseId, text } : { toolUseId };
  }
  return undefined;
}

export function nativeSubagentState(status: unknown): SubagentState | undefined {
  if (status === "completed") return "completed";
  if (status === "failed") return "failed";
  if (status === "disconnected") return "disconnected";
  if (status === "killed" || status === "cancelled" || status === "stopped") return "cancelled";
  return undefined;
}

export function isNativeSubagentControlUpdate(
  update: AcpSessionNotification["update"],
): update is Extract<
  AcpSessionNotification["update"],
  { sessionUpdate: "tool_call" | "tool_call_update" }
> {
  if (update.sessionUpdate !== "tool_call" && update.sessionUpdate !== "tool_call_update") {
    return false;
  }
  const claudeMeta = update._meta?.claudeCode as { toolName?: string } | undefined;
  return (
    airExtensionMeta(update._meta)?.[AIR_SUBAGENT_KEY] === true ||
    isNativeSubagentControlTool(claudeMeta?.toolName)
  );
}

export function isNativeSubagentControlTool(toolName: unknown): boolean {
  return toolName === "Agent" || toolName === "Task";
}

/**
 * An async task update that may reach a child generation after it finished.
 * The spawn is one of them: a held task can get its tool call id, and so its
 * spawn, after the child finished.
 */
function isLateAsyncTaskUpdate(notification: AcpSessionNotification): boolean {
  const kind = notification.update.sessionUpdate;
  return (
    kind === "async_task_spawned" ||
    kind === "async_task_progress" ||
    kind === "async_task_state_update"
  );
}

function isFailedToolCallUpdate(update: AcpSessionNotification["update"]): boolean {
  return (
    (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") &&
    update.status === "failed"
  );
}

function failedControlFallback(
  initial: AcpSessionNotification | undefined,
  terminal: AcpSessionNotification,
  sessionId: string,
): AcpSessionNotification {
  if (
    terminal.update.sessionUpdate !== "tool_call" &&
    terminal.update.sessionUpdate !== "tool_call_update"
  ) {
    return { ...terminal, sessionId };
  }
  if (!initial || initial.update.sessionUpdate !== "tool_call") {
    const claudeMeta = terminal.update._meta?.claudeCode as { toolName?: unknown } | undefined;
    return {
      ...terminal,
      sessionId,
      update: {
        ...terminal.update,
        sessionUpdate: "tool_call",
        status: "failed",
        // The synthesized tool_call is this call's first report, so give it
        // the standard `name` the initial one would have carried.
        ...(typeof claudeMeta?.toolName === "string" ? { name: claudeMeta.toolName } : {}),
        title:
          typeof terminal.update.title === "string" && terminal.update.title.length > 0
            ? terminal.update.title
            : claudeMeta?.toolName === "Task"
              ? "Task"
              : "Agent",
        _meta: ordinaryToolMeta(terminal.update._meta),
      } as AcpSessionNotification["update"],
    };
  }
  return {
    ...initial,
    sessionId,
    update: {
      ...initial.update,
      ...terminal.update,
      sessionUpdate: "tool_call",
      status: "failed",
      title:
        typeof terminal.update.title === "string" && terminal.update.title.trim().length > 0
          ? terminal.update.title
          : initial.update.title,
      _meta: {
        ...initial.update._meta,
        ...terminal.update._meta,
        ...ordinaryToolMeta(initial.update._meta, terminal.update._meta),
      },
    } as AcpSessionNotification["update"],
  };
}

function ordinaryToolMeta(
  ...values: Array<Record<string, unknown> | null | undefined>
): Record<string, unknown> {
  const merged = Object.assign({}, ...values);
  const claudeCode = Object.assign(
    {},
    ...values.map(
      (value) => (value?.claudeCode as Record<string, unknown> | null | undefined) ?? {},
    ),
  );
  const result: Record<string, unknown> = { ...merged, claudeCode };
  const air = airExtensionMeta(merged);
  if (air && AIR_SUBAGENT_KEY in air) {
    const rest = { ...air };
    delete rest[AIR_SUBAGENT_KEY];
    result.jetbrains = { ...(merged.jetbrains as Record<string, unknown>), air: rest };
  }
  return result;
}

function subagentDisplayName(
  explicitName: unknown,
  description: unknown,
  type: unknown,
  taskId: string,
): string {
  for (const value of [explicitName, description, type]) {
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  const suffix = taskId.length > 8 ? taskId.slice(-8) : taskId;
  return `Agent ${suffix}`;
}

function subagentDescription(prompt: unknown, description: unknown): string {
  for (const value of [prompt, description]) {
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return "Delegated task";
}

function subagentIdentity(input: unknown): SubagentIdentity | undefined {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return undefined;
  const value = input as Record<string, unknown>;
  const identity: SubagentIdentity = {
    name: nonBlankString(value.name),
    description: nonBlankString(value.description),
    prompt: promptText(value.prompt),
    subagentType: nonBlankString(value.subagent_type),
  };
  return Object.values(identity).some(Boolean) ? identity : undefined;
}

function mergeSubagentIdentity(
  previous: SubagentIdentity | undefined,
  next: SubagentIdentity,
): SubagentIdentity {
  return {
    name: next.name ?? previous?.name,
    description: next.description ?? previous?.description,
    prompt: next.prompt ?? previous?.prompt,
    subagentType: next.subagentType ?? previous?.subagentType,
  };
}

function applySubagentIdentity(
  child: NativeSubagent,
  identity: SubagentIdentity | undefined,
): void {
  if (!identity) return;
  if (identity.name || identity.description) {
    child.name = subagentDisplayName(
      identity.name,
      identity.description,
      identity.subagentType,
      child.sessionId,
    );
  }
  if (identity.prompt || identity.description) {
    child.task = subagentDescription(identity.prompt, identity.description);
  }
  child.prompt ??= identity.prompt;
  const labels = rfdLabels(
    identity.name,
    identity.subagentType ?? child.role,
    identity.description,
  );
  child.title = labels.title ?? child.title;
  child.role = labels.role ?? child.role;
  child.description = labels.description ?? child.description;
}

/** The prompt text unchanged, or `undefined` when it is not a non-blank string. */
function promptText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function promptField(prompt: string | undefined): { prompt?: string } {
  return prompt === undefined ? {} : { prompt };
}

function nonBlankString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}
