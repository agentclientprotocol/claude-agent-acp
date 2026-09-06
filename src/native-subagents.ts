import type { AcpSessionNotification, SubagentState } from "./acp-subagents.js";

export type NativeSubagent = {
  sessionId: string;
  parentSessionId: string;
  parentToolUseId?: string;
  name: string;
  task: string;
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
      { parentToolUseId?: string | null; subagent?: true; toolName?: string } | undefined;
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

    // A permission request may have had to create the tool call before native
    // child ownership was known. Keep every later update in that original ACP
    // session; moving a lifecycle after its initial call creates an orphan in
    // both transcripts.
    if (forcedSessionId) return { ...notification, sessionId: forcedSessionId };

    if (this.enabled && claudeMeta?.parentToolUseId) {
      const child = this.childByParentToolUse.get(claudeMeta.parentToolUseId);
      if (!child || !child.announced) {
        this.buffer(claudeMeta.parentToolUseId, notification);
        return null;
      }
      if (child.terminalState !== undefined || child.terminalPromise) {
        this.logger.log(
          `Session ${this.rootSessionId}: ignoring late update for terminal subagent ${child.sessionId}`,
        );
        return null;
      }
      return { ...notification, sessionId: child.sessionId };
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

    const knownParentSessionId = task.toolUseId
      ? this.parentByToolUse.get(task.toolUseId)
      : undefined;
    const identity = task.toolUseId ? this.identityByToolUse.get(task.toolUseId) : undefined;
    const child: NativeSubagent = {
      sessionId: this.nextChildSessionId(task.taskId, previous),
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
    };
    this.children.set(task.taskId, child);
    if (task.toolUseId) {
      this.taskByToolUse.set(task.toolUseId, task.taskId);
      this.childByParentToolUse.set(task.toolUseId, child);
      this.controlByToolUse.delete(task.toolUseId);
    }

    // A nested child must wait for the spawning Agent/Task frame to establish
    // its immediate parent. Root children without a tool id can be announced.
    if (knownParentSessionId || !task.toolUseId) {
      await announceNativeSubagent(child, this.publish);
      for (const pending of task.toolUseId ? this.takePending(task.toolUseId) : []) {
        await deliver(pending);
      }
    }
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

  clear(): void {
    this.children.clear();
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
  const claudeMeta = update._meta?.claudeCode as { subagent?: true; toolName?: string } | undefined;
  return claudeMeta?.subagent === true || isNativeSubagentControlTool(claudeMeta?.toolName);
}

export function isNativeSubagentControlTool(toolName: unknown): boolean {
  return toolName === "Agent" || toolName === "Task";
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
  delete claudeCode.subagent;
  return { ...merged, claudeCode };
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
    prompt: nonBlankString(value.prompt),
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
}

function nonBlankString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}
