import type { AcpSessionNotification, SubagentState } from "./acp-subagents.js";
import { AIR_SUBAGENT_KEY, airExtensionMeta } from "./air-extension.js";

export type NativeSubagent = {
  sessionId: string;
  parentSessionId: string;
  parentToolUseId?: string;
  name: string;
  task: string;
  /**
   * The exact prompt of this generation, sent as `prompt` in
   * `subagent_spawned`. It is absent when the adapter has no prompt.
   */
  prompt?: string;
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
  private readonly generationByTaskId = new Map<string, number>();
  private readonly pending = new Map<string, AcpSessionNotification[]>();
  private pendingCount = 0;

  constructor(
    enabled: boolean,
    private readonly rootSessionId: string,
    private readonly session: NativeSubagentSession,
    private readonly publish: Publish,
    private readonly logger: Logger,
  ) {
    this.enabled = enabled;
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
        await announceNativeSubagent(child, this.publish);
        for (const pending of this.takePending(toolCallId)) await deliver(pending);
      }
      if (!child && isFailedToolCallUpdate(update)) {
        this.takePending(toolCallId);
        const initial = this.controlByToolUse.get(toolCallId);
        this.cleanupControl(toolCallId);
        if (forcedSessionId) {
          return { ...notification, sessionId: forcedSessionId };
        }
        return failedControlFallback(initial, notification, parentSessionId ?? this.rootSessionId);
      }
      return forcedSessionId ? { ...notification, sessionId: forcedSessionId } : null;
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
   */
  async taskResumed(taskId: string, deliver: Publish, prompt?: string): Promise<void> {
    if (!this.enabled) return;
    const previous = this.children.get(taskId);
    if (!previous) return;
    const finishing = this.taskFinishPromises.get(taskId) ?? previous.terminalPromise;
    if (finishing) await finishing.catch(() => {});
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

  async finishTask(
    taskId: string,
    status: unknown,
    deliver: Publish,
    toolUseId?: string | null,
  ): Promise<void> {
    if (!this.enabled) return;
    const state = nativeSubagentState(status);
    const child = toolUseId ? this.childByParentToolUse.get(toolUseId) : this.children.get(taskId);
    if (child && toolUseId && this.taskByToolUse.get(toolUseId) !== taskId) return;
    if (!state || !child || child.terminalState !== undefined) return;
    const existing = this.taskFinishPromises.get(taskId);
    if (existing) return existing;

    const finish = Promise.resolve().then(async () => {
      try {
        await announceNativeSubagent(child, this.publish);
        if (child.parentToolUseId) {
          for (const pending of this.takePending(child.parentToolUseId)) await deliver(pending);
        }
        await finishNativeSubagent(this.session, taskId, state, this.publish);
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

  async finishAll(state: SubagentState, deliver: Publish): Promise<void> {
    const errors: unknown[] = [];
    try {
      for (const taskId of [...this.children.keys()].reverse()) {
        try {
          await this.finishTask(taskId, state, deliver);
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

  discardPending(parentToolUseId: string): void {
    this.takePending(parentToolUseId);
  }

  /**
   * Routes an update to the child session. An update of a finished child is
   * dropped: it never goes to the root session.
   */
  private toChild(
    child: NativeSubagent,
    notification: AcpSessionNotification,
    toolCallId: string | undefined,
  ): AcpSessionNotification | null {
    if (child.terminalState !== undefined || child.terminalPromise) {
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
   * `async_task_state_update` to the child generation after it finished. The route drops every other update
   * after the child finished. `undefined` means that the root session owns the
   * tool call. `eagerSessionId` is the session where a permission request
   * created the tool call before the stream routed it.
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
      "parentSessionId" | "parentToolUseId" | "name" | "task" | "prompt"
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
    await announceNativeSubagent(child, this.publish);
    for (const pending of toolUseId ? this.takePending(toolUseId) : []) await deliver(pending);
  }

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

export async function announceNativeSubagent(
  child: NativeSubagent,
  publish: Publish,
): Promise<void> {
  if (child.announced) return;
  if (child.announcePromise) return child.announcePromise;
  const announce = Promise.resolve().then(async () => {
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
    await announceNativeSubagent(child, publish);
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
  for (const toolUseId of resultToolUseIds) {
    const toolUse = toolUses[toolUseId];
    if (toolUse?.name !== "SendMessage") continue;
    const text = promptText((toolUse.input as { message?: unknown } | null)?.message);
    if (text) return text;
  }
  if (resultToolUseIds.length > 0) return undefined;
  for (const toolUse of Object.values(toolUses).reverse()) {
    if (toolUse?.name !== "SendMessage") continue;
    const input = toolUse.input as { to?: unknown; message?: unknown } | null;
    if (input?.to === agentId) return promptText(input.message);
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
