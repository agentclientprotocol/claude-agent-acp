import type { AcpSessionNotification, SubagentState } from "./acp-subagents.js";

export type NativeSubagent = {
  sessionId: string;
  parentSessionId: string;
  parentToolUseId?: string;
  name: string;
  description: string;
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
  private readonly childTaskByParentToolUse = new Map<string, string>();
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
    for (const [taskId, child] of this.children) {
      if (child.parentToolUseId) this.childTaskByParentToolUse.set(child.parentToolUseId, taskId);
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
    const isControl =
      (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") &&
      (claudeMeta?.subagent === true ||
        claudeMeta?.toolName === "Agent" ||
        claudeMeta?.toolName === "Task");

    if (!this.enabled) return notification;

    if (this.enabled && isControl) {
      const identity = subagentIdentity(update.rawInput);
      if (identity) {
        this.identityByToolUse.set(
          update.toolCallId,
          mergeSubagentIdentity(this.identityByToolUse.get(update.toolCallId), identity),
        );
      }
      const parentTaskId = claudeMeta.parentToolUseId
        ? this.taskByToolUse.get(claudeMeta.parentToolUseId)
        : undefined;
      const parentSessionId = parentTaskId
        ? this.children.get(parentTaskId)?.sessionId
        : this.rootSessionId;
      this.parentByToolUse.set(update.toolCallId, parentSessionId ?? this.rootSessionId);

      const childTaskId = this.childTaskByParentToolUse.get(update.toolCallId);
      const child = childTaskId ? this.children.get(childTaskId) : undefined;
      if (child && !child.announced) {
        child.parentSessionId = parentSessionId ?? this.rootSessionId;
        applySubagentIdentity(child, this.identityByToolUse.get(update.toolCallId));
        await announceNativeSubagent(child, this.publish);
        for (const pending of this.takePending(update.toolCallId)) await deliver(pending);
      }
      return forcedSessionId ? { ...notification, sessionId: forcedSessionId } : null;
    }

    // A permission request may have had to create the tool call before native
    // child ownership was known. Keep every later update in that original ACP
    // session; moving a lifecycle after its initial call creates an orphan in
    // both transcripts.
    if (forcedSessionId) return { ...notification, sessionId: forcedSessionId };

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
    const identity = task.toolUseId ? this.identityByToolUse.get(task.toolUseId) : undefined;
    const child: NativeSubagent = {
      sessionId: task.taskId,
      parentSessionId: knownParentSessionId ?? this.rootSessionId,
      parentToolUseId: task.toolUseId ?? undefined,
      name: subagentDisplayName(
        identity?.name,
        identity?.description ?? task.description,
        identity?.subagentType ?? task.subagentType,
        task.taskId,
      ),
      description: subagentDescription(
        identity?.prompt ?? task.prompt,
        identity?.description ?? task.description,
      ),
    };
    this.children.set(task.taskId, child);
    if (task.toolUseId) {
      this.taskByToolUse.set(task.toolUseId, task.taskId);
      this.childTaskByParentToolUse.set(task.toolUseId, task.taskId);
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
    if (child.parentToolUseId) {
      this.identityByToolUse.delete(child.parentToolUseId);
      this.parentByToolUse.delete(child.parentToolUseId);
      this.childTaskByParentToolUse.delete(child.parentToolUseId);
    }
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
    this.identityByToolUse.clear();
    this.childTaskByParentToolUse.clear();
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
      description: child.description,
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
    child.description = subagentDescription(identity.prompt, identity.description);
  }
}

function nonBlankString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}
