import type { ClientCapabilities } from "@agentclientprotocol/sdk";
import type { AcpSessionNotification, AsyncTaskState } from "./acp-subagents.js";
import { AIR_ASYNC_TASKS_CAPABILITY, clientSupportsAirCapability } from "./air-extension.js";

type Publish = (notification: AcpSessionNotification) => Promise<void>;

type AsyncTask = {
  id: string;
  name: string;
  taskType: string;
  description: string;
  showInTranscript: boolean;
  announced: boolean;
  state: AsyncTaskState;
};

export type AsyncTaskStarted = {
  taskId: string;
  taskType?: unknown;
  description?: unknown;
  subagentType?: unknown;
  isBackgrounded?: unknown;
  workflowName?: unknown;
  skipTranscript?: unknown;
};

type TaskProgress = {
  taskId: string;
  description?: unknown;
  summary?: unknown;
  lastToolName?: unknown;
  usage?: unknown;
};

export function clientSupportsAsyncTasks(capabilities?: ClientCapabilities | null): boolean {
  return clientSupportsAirCapability(capabilities, AIR_ASYNC_TASKS_CAPABILITY);
}

/** Publishes Claude's non-agent background work as a separate AIR task lifecycle. */
export class AsyncTaskRuntime {
  private readonly tasks = new Map<string, AsyncTask>();

  constructor(
    readonly enabled: boolean,
    private readonly sessionId: string,
    private readonly publish: Publish,
  ) {}

  async taskStarted(message: AsyncTaskStarted): Promise<void> {
    if (!this.enabled || message.subagentType || this.tasks.has(message.taskId)) return;
    const taskType = friendlyTaskType(message.taskType);
    const description = nonBlankString(message.description) ?? defaultDescription(taskType);
    const task: AsyncTask = {
      id: message.taskId,
      name: nonBlankString(message.workflowName) ?? description,
      taskType,
      description,
      showInTranscript: message.skipTranscript !== true,
      announced: false,
      state: "running",
    };
    this.tasks.set(task.id, task);
    if (isBackgroundTask(message.isBackgrounded, message.taskType)) await this.announce(task);
  }

  async taskUpdated(
    taskId: string,
    patch: { status?: unknown; description?: unknown; isBackgrounded?: unknown; error?: unknown },
  ): Promise<void> {
    const task = this.tasks.get(taskId);
    if (!this.enabled || !task) return;
    const description = nonBlankString(patch.description);
    if (description) {
      task.description = description;
      task.name = description;
    }
    if (patch.isBackgrounded === true) await this.announce(task);
    const state = taskState(patch.status);
    if (!state) return;
    if (state === "running" || state === "paused") {
      if (!task.announced || task.state === state) return;
      task.state = state;
      await this.publishState(task, state, nonBlankString(patch.error));
      return;
    }
    await this.finish(task, state, nonBlankString(patch.error));
  }

  async taskProgress(message: TaskProgress): Promise<void> {
    const task = this.tasks.get(message.taskId);
    if (!this.enabled || !task || !task.announced || isTerminal(task.state)) return;
    const usage = taskUsage(message.usage);
    await this.publish({
      sessionId: this.sessionId,
      update: {
        sessionUpdate: "async_task_progress",
        asyncTaskId: task.id,
        ...(nonBlankString(message.description)
          ? { description: nonBlankString(message.description) }
          : {}),
        ...(nonBlankString(message.summary) ? { summary: nonBlankString(message.summary) } : {}),
        ...(nonBlankString(message.lastToolName)
          ? { lastToolName: nonBlankString(message.lastToolName) }
          : {}),
        ...(usage ? { usage } : {}),
      },
    });
  }

  async taskNotification(taskId: string, status: unknown, summary?: unknown): Promise<void> {
    const task = this.tasks.get(taskId);
    if (!this.enabled || !task) return;
    const state = taskState(status);
    if (!state || state === "running" || state === "paused") return;
    await this.finish(task, state, nonBlankString(summary));
  }

  async finishAll(state: Extract<AsyncTaskState, "failed" | "stopped">): Promise<void> {
    for (const task of this.tasks.values()) {
      if (task.announced && !isTerminal(task.state)) await this.finish(task, state);
    }
  }

  clear(): void {
    this.tasks.clear();
  }

  private async announce(task: AsyncTask): Promise<void> {
    if (task.announced) return;
    await this.publish({
      sessionId: this.sessionId,
      update: {
        sessionUpdate: "async_task_spawned",
        asyncTaskId: task.id,
        name: task.name,
        taskType: task.taskType,
        description: task.description,
        showInTranscript: task.showInTranscript,
      },
    });
    task.announced = true;
  }

  private async finish(task: AsyncTask, state: AsyncTaskState, summary?: string): Promise<void> {
    if (isTerminal(task.state)) return;
    if (!task.announced) {
      this.tasks.delete(task.id);
      return;
    }
    task.state = state;
    await this.publishState(task, state, summary);
  }

  private async publishState(
    task: AsyncTask,
    state: AsyncTaskState,
    summary?: string,
  ): Promise<void> {
    await this.publish({
      sessionId: this.sessionId,
      update: {
        sessionUpdate: "async_task_state_update",
        asyncTaskId: task.id,
        state,
        ...(summary ? { summary } : {}),
      },
    });
  }
}

/**
 * Recovers the lifecycle edge that current Claude CLI versions expose only on
 * the Bash tool result. Background Bash does not consistently emit the SDK's
 * task_started/task_updated system messages, but its structured result carries
 * the stable task id after the process has actually been backgrounded.
 */
export function backgroundBashTaskFromToolResult(
  content: unknown,
  toolUseResult: unknown,
  toolUses: Record<string, { name: string; input: unknown }>,
): AsyncTaskStarted | undefined {
  if (!Array.isArray(content) || !isRecord(toolUseResult)) return undefined;
  const taskId = nonBlankString(toolUseResult.backgroundTaskId);
  if (!taskId) return undefined;

  const toolResults = content.filter(
    (item): item is { type: "tool_result"; tool_use_id: string } =>
      isRecord(item) &&
      item.type === "tool_result" &&
      typeof item.tool_use_id === "string" &&
      item.tool_use_id.length > 0,
  );
  if (toolResults.length !== 1) return undefined;

  const toolUse = toolUses[toolResults[0].tool_use_id];
  if (toolUse?.name !== "Bash") return undefined;
  const input = isRecord(toolUse.input) ? toolUse.input : undefined;
  const description = nonBlankString(input?.command);
  return {
    taskId,
    taskType: "local_bash",
    description,
    isBackgrounded: true,
  };
}

function friendlyTaskType(value: unknown): string {
  if (value === "local_bash") return "shell";
  if (value === "local_workflow") return "workflow";
  if (value === "local_monitor" || value === "mcp") return "monitor";
  return nonBlankString(value) ?? "task";
}

function defaultDescription(taskType: string): string {
  return taskType === "task" ? "Background task" : taskType[0].toUpperCase() + taskType.slice(1);
}

function isBackgroundTask(isBackgrounded: unknown, taskType: unknown): boolean {
  if (isBackgrounded === true) return true;
  if (isBackgrounded === false) return false;
  return taskType !== "local_bash" && taskType !== "local_agent";
}

function taskState(value: unknown): AsyncTaskState | undefined {
  if (value === "pending" || value === "running") return "running";
  if (value === "paused") return "paused";
  if (value === "completed") return "completed";
  if (value === "failed") return "failed";
  if (value === "killed" || value === "cancelled" || value === "stopped") return "stopped";
  return undefined;
}

function isTerminal(state: AsyncTaskState): boolean {
  return state === "completed" || state === "failed" || state === "stopped";
}

function taskUsage(
  value: unknown,
): { totalTokens: number; toolUses: number; durationMs: number } | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const usage = value as Record<string, unknown>;
  if (
    typeof usage.total_tokens !== "number" ||
    typeof usage.tool_uses !== "number" ||
    typeof usage.duration_ms !== "number"
  )
    return undefined;
  return {
    totalTokens: usage.total_tokens,
    toolUses: usage.tool_uses,
    durationMs: usage.duration_ms,
  };
}

function nonBlankString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
