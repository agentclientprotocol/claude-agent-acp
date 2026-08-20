import type { AcpSessionNotification, SubagentState } from "./acp-subagents.js";

export type NativeSubagent = {
  sessionId: string;
  parentSessionId: string;
  parentToolUseId?: string;
  name: string;
  task: string;
  announced?: boolean;
  terminalState?: SubagentState;
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
  }

  async route(
    notification: AcpSessionNotification,
    deliver: Publish,
  ): Promise<AcpSessionNotification | null> {
    const { update } = notification;
    const claudeMeta = update._meta?.claudeCode as
      { parentToolUseId?: string | null; subagent?: true; toolName?: string } | undefined;
    const isControl =
      (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") &&
      (claudeMeta?.subagent === true ||
        claudeMeta?.toolName === "Agent" ||
        claudeMeta?.toolName === "Task");

    if (!this.enabled && (isControl || claudeMeta?.parentToolUseId)) return null;

    if (this.enabled && isControl) {
      const parentTaskId = claudeMeta.parentToolUseId
        ? this.taskByToolUse.get(claudeMeta.parentToolUseId)
        : undefined;
      const parentSessionId = parentTaskId
        ? this.children.get(parentTaskId)?.sessionId
        : this.rootSessionId;
      this.parentByToolUse.set(update.toolCallId, parentSessionId ?? this.rootSessionId);

      for (const child of this.children.values()) {
        if (child.parentToolUseId !== update.toolCallId || child.announced) continue;
        child.parentSessionId = parentSessionId ?? this.rootSessionId;
        await announceNativeSubagent(child, this.publish);
        for (const pending of this.takePending(update.toolCallId)) await deliver(pending);
      }
      return null;
    }

    if (this.enabled && claudeMeta?.parentToolUseId) {
      const taskId = this.taskByToolUse.get(claudeMeta.parentToolUseId);
      const child = taskId ? this.children.get(taskId) : undefined;
      if (!child || !child.announced) {
        this.buffer(claudeMeta.parentToolUseId, notification);
        return null;
      }
      if (child.terminalState !== undefined) {
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
      if (task.toolUseId) this.takePending(task.toolUseId);
      return;
    }
    if (this.children.has(task.taskId)) return;

    const knownParentSessionId = task.toolUseId
      ? this.parentByToolUse.get(task.toolUseId)
      : undefined;
    const child: NativeSubagent = {
      sessionId: task.taskId,
      parentSessionId: knownParentSessionId ?? this.rootSessionId,
      parentToolUseId: task.toolUseId ?? undefined,
      name: subagentDisplayName(task.subagentType, task.taskId),
      task: subagentTask(task.description),
    };
    this.children.set(task.taskId, child);
    if (task.toolUseId) this.taskByToolUse.set(task.toolUseId, task.taskId);

    // A nested child must wait for the spawning Agent/Task frame to establish
    // its immediate parent. Root children without a tool id can be announced.
    if (knownParentSessionId || !task.toolUseId) {
      await announceNativeSubagent(child, this.publish);
      for (const pending of task.toolUseId ? this.takePending(task.toolUseId) : []) {
        await deliver(pending);
      }
    }
  }

  async finishTask(taskId: string, status: unknown, deliver: Publish): Promise<void> {
    if (!this.enabled) return;
    const state = nativeSubagentState(status);
    const child = this.children.get(taskId);
    if (!state || !child || child.terminalState !== undefined) return;

    await announceNativeSubagent(child, this.publish);
    if (child.parentToolUseId) {
      for (const pending of this.takePending(child.parentToolUseId)) await deliver(pending);
    }
    await finishNativeSubagent(this.session, taskId, state, this.publish);
  }

  async finishAll(state: SubagentState, deliver: Publish): Promise<void> {
    for (const taskId of [...this.children.keys()].reverse()) {
      await this.finishTask(taskId, state, deliver);
    }
    this.pending.clear();
    this.pendingCount = 0;
  }

  discardPending(parentToolUseId: string): void {
    this.takePending(parentToolUseId);
  }

  clear(): void {
    this.children.clear();
    this.taskByToolUse.clear();
    this.parentByToolUse.clear();
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
}

export async function announceNativeSubagent(
  child: NativeSubagent,
  publish: Publish,
): Promise<void> {
  if (child.announced) return;
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
}

export async function finishNativeSubagent(
  session: NativeSubagentSession,
  taskId: string,
  state: SubagentState,
  publish: Publish,
): Promise<void> {
  const child = session.nativeSubagentsByTaskId?.get(taskId);
  if (!child || child.terminalState !== undefined) return;
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
}

export async function finishNativeSubagents(
  session: NativeSubagentSession,
  state: SubagentState,
  publish: Publish,
): Promise<void> {
  for (const taskId of [...(session.nativeSubagentsByTaskId?.keys() ?? [])].reverse()) {
    await finishNativeSubagent(session, taskId, state, publish);
  }
}

function nativeSubagentState(status: unknown): SubagentState | undefined {
  if (status === "completed") return "completed";
  if (status === "failed") return "failed";
  if (status === "killed" || status === "cancelled" || status === "stopped") return "cancelled";
  return undefined;
}

function subagentDisplayName(type: unknown, taskId: string): string {
  if (typeof type === "string" && type.trim().length > 0) return type.trim();
  const suffix = taskId.length > 8 ? taskId.slice(-8) : taskId;
  return `Agent ${suffix}`;
}

function subagentTask(description: unknown): string {
  return typeof description === "string" && description.trim().length > 0
    ? description.trim()
    : "Delegated task";
}
