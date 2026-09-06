import type { ClientCapabilities } from "@agentclientprotocol/sdk";
import type { AcpSessionNotification, AsyncTaskState } from "./acp-subagents.js";
import { AIR_ASYNC_TASKS_CAPABILITY, clientSupportsAirCapability } from "./air-extension.js";

type Publish = (notification: AcpSessionNotification) => Promise<void>;
type TerminalSource = "event" | "level" | "shutdown";

type AsyncTask = {
  id: string;
  name: string;
  taskType: string;
  description: string;
  showInTranscript: boolean;
  outputFilePath?: string;
  toolCallId?: string;
  announced: boolean;
  ignored: boolean;
  startedObserved: boolean;
  panelOnlyRecovery: boolean;
  stopping: boolean;
  stopAnnounced: boolean;
  state: AsyncTaskState;
  terminalSummary?: string;
  terminalSource?: TerminalSource;
};

type TaskIdentity = { taskId?: unknown; task_id?: unknown };

export type AsyncTaskStarted = TaskIdentity & {
  taskType?: unknown;
  task_type?: unknown;
  description?: unknown;
  subagentType?: unknown;
  subagent_type?: unknown;
  isBackgrounded?: unknown;
  is_backgrounded?: unknown;
  workflowName?: unknown;
  workflow_name?: unknown;
  skipTranscript?: unknown;
  skip_transcript?: unknown;
  outputFilePath?: unknown;
  output_file?: unknown;
  toolCallId?: unknown;
  tool_use_id?: unknown;
};

export type AsyncTaskUpdated = TaskIdentity & { patch?: TaskPatch };

type TaskPatch = {
  status?: unknown;
  description?: unknown;
  isBackgrounded?: unknown;
  is_backgrounded?: unknown;
  error?: unknown;
  outputFilePath?: unknown;
  output_file?: unknown;
};

export type AsyncTaskNotification = TaskIdentity & {
  status?: unknown;
  summary?: unknown;
  outputFilePath?: unknown;
  output_file?: unknown;
};

type TaskProgress = TaskIdentity & {
  description?: unknown;
  summary?: unknown;
  lastToolName?: unknown;
  last_tool_name?: unknown;
  usage?: unknown;
  outputFilePath?: unknown;
  output_file?: unknown;
};

type BackgroundTaskLevel = TaskIdentity & {
  taskType?: unknown;
  task_type?: unknown;
  description?: unknown;
};

export function clientSupportsAsyncTasks(capabilities?: ClientCapabilities | null): boolean {
  return clientSupportsAirCapability(capabilities, AIR_ASYNC_TASKS_CAPABILITY);
}

/** Publishes Claude's non-agent background work as a separate AIR task lifecycle. */
export class AsyncTaskRuntime {
  /**
   * One registry owns both active tasks and terminal tombstones. Keeping an
   * unannounced terminal record is intentional: the Bash result proving that
   * a command was backgrounded can arrive after its terminal SDK edge.
   */
  private readonly tasks = new Map<string, AsyncTask>();

  constructor(
    readonly enabled: boolean,
    private readonly sessionId: string,
    private readonly publish: Publish,
  ) {}

  async taskStarted(message: AsyncTaskStarted): Promise<void> {
    if (!this.enabled) return;
    const taskId = taskIdOf(message);
    if (!taskId) return;
    const task = this.task(taskId);
    if (isSubagentTask(message)) {
      task.ignored = true;
      return;
    }

    const previousOutputFilePath = task.outputFilePath;
    const previousToolCallId = task.toolCallId;
    const wasAnnounced = task.announced;
    this.mergeStarted(task, message);
    if (
      isBackgroundTask(
        field(message, "isBackgrounded", "is_backgrounded"),
        field(message, "taskType", "task_type"),
      )
    ) {
      await this.announce(task);
    }
    if (
      wasAnnounced &&
      (task.outputFilePath !== previousOutputFilePath || task.toolCallId !== previousToolCallId)
    ) {
      await this.publishMetadata(task);
    }
  }

  async taskBackgrounded(message: AsyncTaskStarted): Promise<void> {
    if (!this.enabled) return;
    const taskId = taskIdOf(message);
    if (!taskId) return;
    const task = this.task(taskId);
    if (isSubagentTask(message)) {
      task.ignored = true;
      return;
    }

    const previousOutputFilePath = task.outputFilePath;
    const previousToolCallId = task.toolCallId;
    const wasAnnounced = task.announced;
    this.mergeStarted(task, message);
    await this.announce(task);
    if (
      wasAnnounced &&
      (task.outputFilePath !== previousOutputFilePath || task.toolCallId !== previousToolCallId)
    ) {
      await this.publishMetadata(task);
    }
  }

  async taskUpdated(message: AsyncTaskUpdated): Promise<void>;
  async taskUpdated(taskId: string, patch: TaskPatch): Promise<void>;
  async taskUpdated(taskOrId: string | AsyncTaskUpdated, legacyPatch?: TaskPatch): Promise<void> {
    if (!this.enabled) return;
    const taskId = typeof taskOrId === "string" ? nonBlankString(taskOrId) : taskIdOf(taskOrId);
    const patch = typeof taskOrId === "string" ? legacyPatch : taskOrId.patch;
    if (!taskId || !patch) return;

    const task = this.task(taskId);
    const previousOutputFilePath = task.outputFilePath;
    this.mergePatch(task, patch);
    if (field(patch, "isBackgrounded", "is_backgrounded") === true) {
      await this.announce(task);
    }

    const state = taskState(patch.status);
    if (!state) {
      if (task.announced && task.outputFilePath !== previousOutputFilePath) {
        await this.publishMetadata(task);
      }
      return;
    }

    if (state === "running" || state === "paused") {
      if (isTerminal(task.state)) {
        if (task.announced && task.outputFilePath !== previousOutputFilePath) {
          await this.publishMetadata(task);
        }
        return;
      }
      if (task.state !== state) {
        task.state = state;
        if (task.announced) await this.publishState(task, state, nonBlankString(patch.error));
      } else if (task.announced && task.outputFilePath !== previousOutputFilePath) {
        await this.publishMetadata(task);
      }
      return;
    }

    await this.finish(task, state, nonBlankString(patch.error), "event");
  }

  async taskProgress(message: TaskProgress): Promise<void> {
    if (!this.enabled) return;
    const taskId = taskIdOf(message);
    if (!taskId) return;
    const task = this.tasks.get(taskId);
    if (!task || !task.announced || task.ignored) return;

    const previousOutputFilePath = task.outputFilePath;
    this.mergeOutputFilePath(task, message);
    const outputChanged = task.outputFilePath !== previousOutputFilePath;
    if (isTerminal(task.state)) {
      if (outputChanged) await this.publishMetadata(task);
      return;
    }

    const usage = taskUsage(message.usage);
    const description = nonBlankString(message.description);
    const summary = nonBlankString(message.summary);
    const lastToolName = nonBlankString(field(message, "lastToolName", "last_tool_name"));
    await this.publishProgress(task, {
      ...(description ? { description } : {}),
      ...(summary ? { summary } : {}),
      ...(lastToolName ? { lastToolName } : {}),
      ...(usage ? { usage } : {}),
      ...(outputChanged && task.outputFilePath ? { outputFilePath: task.outputFilePath } : {}),
    });
  }

  async taskNotification(message: AsyncTaskNotification): Promise<void>;
  async taskNotification(
    taskId: string,
    status: unknown,
    summary?: unknown,
    outputFilePath?: unknown,
  ): Promise<void>;
  async taskNotification(
    taskOrId: string | AsyncTaskNotification,
    legacyStatus?: unknown,
    legacySummary?: unknown,
    legacyOutputFilePath?: unknown,
  ): Promise<void> {
    if (!this.enabled) return;
    const message: AsyncTaskNotification =
      typeof taskOrId === "string"
        ? {
            taskId: taskOrId,
            status: legacyStatus,
            summary: legacySummary,
            outputFilePath: legacyOutputFilePath,
          }
        : taskOrId;
    const taskId = taskIdOf(message);
    const state = taskState(message.status);
    if (!taskId || !state || state === "running" || state === "paused") return;

    const task = this.task(taskId);
    const wasTerminal = isTerminal(task.state);
    const correctsLevelState = wasTerminal && task.terminalSource === "level";
    const previousOutputFilePath = task.outputFilePath;
    this.mergeOutputFilePath(task, message);
    await this.finish(task, state, nonBlankString(message.summary), "event");
    if (
      wasTerminal &&
      !correctsLevelState &&
      task.announced &&
      task.outputFilePath !== previousOutputFilePath
    ) {
      await this.publishMetadata(task);
    }
  }

  /**
   * Reconciles the SDK's replace-semantics background task level. It does not
   * create unknown tasks because this level normally precedes task_started and
   * carries no tool-call attribution. It can, however, promote a known
   * foreground task and terminate an announced task whose edge was lost.
   */
  async backgroundTasksChanged(
    tasksOrMessage: readonly BackgroundTaskLevel[] | { tasks?: unknown },
  ): Promise<void> {
    if (!this.enabled) return;
    const value = Array.isArray(tasksOrMessage)
      ? tasksOrMessage
      : isRecord(tasksOrMessage)
        ? tasksOrMessage.tasks
        : undefined;
    if (!Array.isArray(value)) return;

    const live = new Set<string>();
    for (const item of value) {
      if (!isRecord(item)) continue;
      const taskId = taskIdOf(item);
      if (!taskId) continue;
      live.add(taskId);
      const task = this.task(taskId);
      if (task.ignored || isTerminal(task.state)) continue;
      if (field(item, "taskType", "task_type") === "local_agent") {
        task.ignored = true;
        continue;
      }
      if (!task.startedObserved) {
        // The replace-level proves liveness but carries neither transcript
        // policy nor full identity. Recover it for the Async Tasks panel only;
        // creating a transcript card here would be irreversible if a late
        // task_started says skip_transcript=true.
        task.panelOnlyRecovery = true;
        task.showInTranscript = false;
      }
      this.mergeLevel(task, item);
      await this.announce(task);
    }

    for (const task of this.tasks.values()) {
      if (task.announced && !task.ignored && !isTerminal(task.state) && !live.has(task.id)) {
        // This replace-semantics level is itself the authoritative liveness
        // boundary. Close immediately so a lost terminal edge cannot leave a
        // permanent running card; a following task_notification may correct
        // the best-effort stopped state to completed/failed.
        await this.finish(task, "stopped", undefined, "level");
      }
    }
  }

  async finishAll(state: Extract<AsyncTaskState, "failed" | "stopped">): Promise<void> {
    const errors: unknown[] = [];
    for (const task of this.tasks.values()) {
      if (task.announced && !task.ignored && !isTerminal(task.state)) {
        try {
          await this.finish(task, state, undefined, "shutdown");
        } catch (error) {
          errors.push(error);
        }
      }
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, "Failed to finish async tasks");
  }

  canStop(taskId: string): boolean {
    const task = this.tasks.get(taskId);
    return task?.announced === true && !task.ignored && !task.stopping && !isTerminal(task.state);
  }

  claimStop(taskId: string): boolean {
    if (!this.canStop(taskId)) return false;
    this.tasks.get(taskId)!.stopping = true;
    return true;
  }

  releaseStop(taskId: string): void {
    const task = this.tasks.get(taskId);
    if (task && !isTerminal(task.state)) task.stopping = false;
  }

  async taskStopped(taskId: string): Promise<void> {
    const task = this.tasks.get(taskId);
    if (!task || !task.announced || task.ignored || task.stopAnnounced) return;
    task.stopAnnounced = true;
    // No terminal summary: a stopped task leaves the Async Tasks panel at once,
    // so anything said there is said to nobody.
    await this.finish(task, "stopped", undefined, "event");
    // The transcript is where the acknowledgement has to land, and it is the
    // only one the user gets -- the SDK injects nothing into the model's
    // context for a stopped shell task.
    //
    // Terminal state deliberately does not gate this. The SDK's own
    // `task_notification` routinely wins the race against the `stopTask`
    // response that brought us here, so by now the task is usually already
    // terminal: gating on that would silence the very stop the user asked for.
    // `stopAnnounced` is what keeps this to one line per task.
    //
    // `showInTranscript` does not gate it either: that flag decides whether the
    // task owns a transcript *card* (a background Bash task is already drawn as
    // its tool call), not whether the agent may answer a direct user action.
    await this.publish({
      sessionId: this.sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: `**Task stopped by user:** ${task.name}.` },
      },
    });
  }

  clear(): void {
    this.tasks.clear();
  }

  private task(taskId: string): AsyncTask {
    let task = this.tasks.get(taskId);
    if (task) return task;
    task = {
      id: taskId,
      name: "Background task",
      taskType: "task",
      description: "Background task",
      showInTranscript: true,
      announced: false,
      ignored: false,
      startedObserved: false,
      panelOnlyRecovery: false,
      stopping: false,
      stopAnnounced: false,
      state: "running",
    };
    this.tasks.set(taskId, task);
    return task;
  }

  private mergeStarted(task: AsyncTask, message: AsyncTaskStarted): void {
    task.startedObserved = true;
    const rawTaskType = field(message, "taskType", "task_type");
    if (rawTaskType !== undefined) task.taskType = friendlyTaskType(rawTaskType);
    const description = nonBlankString(message.description);
    if (description) task.description = description;
    else if (task.description === "Background task")
      task.description = defaultDescription(task.taskType);
    task.name = nonBlankString(field(message, "workflowName", "workflow_name")) ?? task.description;
    const skipTranscript = field(message, "skipTranscript", "skip_transcript");
    if (task.panelOnlyRecovery) {
      // A level-only recovery was already announced without a transcript
      // entry. Keep that decision monotonic: a late task_started can enrich
      // the panel, but cannot retroactively create or mutate transcript UI.
      task.showInTranscript = false;
    } else if (skipTranscript !== undefined) {
      task.showInTranscript = skipTranscript !== true;
    }
    this.mergeOutputFilePath(task, message);
    const toolCallId = nonBlankString(field(message, "toolCallId", "tool_use_id"));
    if (toolCallId) task.toolCallId = toolCallId;
  }

  private mergePatch(task: AsyncTask, patch: TaskPatch): void {
    const description = nonBlankString(patch.description);
    if (description) {
      task.description = description;
      task.name = description;
    }
    this.mergeOutputFilePath(task, patch);
  }

  private mergeLevel(task: AsyncTask, level: BackgroundTaskLevel): void {
    const rawTaskType = field(level, "taskType", "task_type");
    if (rawTaskType !== undefined) task.taskType = friendlyTaskType(rawTaskType);
    const description = nonBlankString(level.description);
    if (description) {
      task.description = description;
      task.name = description;
    }
  }

  private mergeOutputFilePath(
    task: AsyncTask,
    value: { outputFilePath?: unknown; output_file?: unknown },
  ): void {
    const outputFilePath = nonBlankString(field(value, "outputFilePath", "output_file"));
    if (outputFilePath) task.outputFilePath = outputFilePath;
  }

  private async announce(task: AsyncTask): Promise<void> {
    if (task.announced || task.ignored) return;
    await this.publish({
      sessionId: this.sessionId,
      update: {
        sessionUpdate: "async_task_spawned",
        asyncTaskId: task.id,
        name: task.name,
        taskType: task.taskType,
        description: task.description,
        showInTranscript: task.showInTranscript,
        canStop: true,
        ...(task.outputFilePath ? { outputFilePath: task.outputFilePath } : {}),
        ...(task.toolCallId ? { toolCallId: task.toolCallId } : {}),
      },
    });
    task.announced = true;
    if (isTerminal(task.state)) {
      await this.publishState(task, task.state, task.terminalSummary);
    }
  }

  private async finish(
    task: AsyncTask,
    state: Extract<AsyncTaskState, "completed" | "failed" | "stopped">,
    summary: string | undefined,
    source: TerminalSource,
  ): Promise<void> {
    if (task.ignored) return;
    if (isTerminal(task.state)) {
      // A level event may precede the authoritative terminal edge. Correct its
      // best-effort stopped state if that edge later arrives.
      if (task.terminalSource !== "level" || source !== "event") return;
    }
    const previous = {
      state: task.state,
      terminalSummary: task.terminalSummary,
      terminalSource: task.terminalSource,
    };
    task.state = state;
    task.terminalSummary = summary;
    task.terminalSource = source;
    try {
      if (task.announced) await this.publishState(task, state, summary);
    } catch (error) {
      task.state = previous.state;
      task.terminalSummary = previous.terminalSummary;
      task.terminalSource = previous.terminalSource;
      throw error;
    }
  }

  private async publishMetadata(task: AsyncTask): Promise<void> {
    if (task.outputFilePath || task.toolCallId) {
      if (isTerminal(task.state)) {
        await this.publishState(task, task.state, task.terminalSummary);
      } else {
        await this.publishProgress(task, {
          ...(task.outputFilePath ? { outputFilePath: task.outputFilePath } : {}),
          ...(task.toolCallId ? { toolCallId: task.toolCallId } : {}),
        });
      }
    }
  }

  private async publishProgress(
    task: AsyncTask,
    update: {
      description?: string;
      summary?: string;
      lastToolName?: string;
      usage?: { totalTokens: number; toolUses: number; durationMs: number };
      outputFilePath?: string;
      toolCallId?: string;
    },
  ): Promise<void> {
    await this.publish({
      sessionId: this.sessionId,
      update: {
        sessionUpdate: "async_task_progress",
        asyncTaskId: task.id,
        ...update,
      },
    });
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
        ...(task.outputFilePath ? { outputFilePath: task.outputFilePath } : {}),
        ...(task.toolCallId ? { toolCallId: task.toolCallId } : {}),
      },
    });
  }
}

/** Recovers background Bash lifecycle data exposed only on its tool result. */
export function backgroundBashTaskFromToolResult(
  content: unknown,
  toolUseResult: unknown,
  toolUses: Record<string, { name: string; input: unknown }>,
): AsyncTaskStarted | undefined {
  if (!Array.isArray(content)) return undefined;
  const toolResults = content.flatMap(toolResultBlock);
  const bashResults = toolResults.filter((result) => toolUses[result.toolUseId]?.name === "Bash");
  if (bashResults.length === 0) return undefined;

  const backgroundResults = structuredBackgroundResults(toolUseResult, toolUses);
  const distinctTaskIds = new Set([
    ...backgroundResults.map((result) => result.taskId),
    ...bashResults
      .map((result) => backgroundTaskIdFromText(result.content))
      .filter((taskId): taskId is string => taskId !== undefined),
  ]);
  if (distinctTaskIds.size !== 1) return undefined;
  const taskId = [...distinctTaskIds][0];
  if (!taskId) return undefined;

  const hintedToolUseIds = new Set(
    backgroundResults
      .filter((result) => result.taskId === taskId && result.toolUseId)
      .map((result) => result.toolUseId!),
  );
  let matches: typeof bashResults;
  if (hintedToolUseIds.size > 0) {
    matches = bashResults.filter((result) => hintedToolUseIds.has(result.toolUseId));
  } else {
    const pathMatches = bashResults.filter(
      (result) => asyncTaskOutputFilePath(result.content, taskId) !== undefined,
    );
    matches = pathMatches.length > 0 ? pathMatches : bashResults.length === 1 ? bashResults : [];
  }
  if (matches.length !== 1) return undefined;

  const match = matches[0];
  const toolUse = toolUses[match.toolUseId];
  const input = isRecord(toolUse?.input) ? toolUse.input : undefined;
  return {
    taskId,
    taskType: "local_bash",
    description: nonBlankString(input?.command),
    isBackgrounded: true,
    outputFilePath: asyncTaskOutputFilePath(match.content, taskId),
    toolCallId: match.toolUseId,
  };
}

function backgroundTaskIdFromText(content: unknown): string | undefined {
  const text = textContent(content);
  if (!text) return undefined;
  const marker = "Command running in background with ID: ";
  const start = text.indexOf(marker);
  if (start < 0) return undefined;
  const valueStart = start + marker.length;
  const valueEnd = text.indexOf(".", valueStart);
  return valueEnd < 0 ? undefined : nonBlankString(text.slice(valueStart, valueEnd));
}

function structuredBackgroundResults(
  value: unknown,
  toolUses: Record<string, { name: string; input: unknown }>,
  hintedToolUseId?: string,
  seen = new Set<unknown>(),
): { taskId: string; toolUseId?: string }[] {
  if (typeof value !== "object" || value === null || seen.has(value)) return [];
  seen.add(value);
  if (Array.isArray(value)) {
    return value.flatMap((item) =>
      structuredBackgroundResults(item, toolUses, hintedToolUseId, seen),
    );
  }

  const directTaskId = nonBlankString(field(value, "backgroundTaskId", "background_task_id"));
  const directToolUseId =
    nonBlankString(field(value, "toolUseId", "tool_use_id")) ?? hintedToolUseId;
  const results: { taskId: string; toolUseId?: string }[] = directTaskId
    ? [{ taskId: directTaskId, toolUseId: directToolUseId }]
    : [];
  for (const [key, child] of Object.entries(value)) {
    if (key === "backgroundTaskId" || key === "background_task_id") continue;
    results.push(
      ...structuredBackgroundResults(child, toolUses, toolUses[key] ? key : directToolUseId, seen),
    );
  }
  return results;
}

function toolResultBlock(value: unknown): { toolUseId: string; content?: unknown }[] {
  if (!isRecord(value) || value.type !== "tool_result") return [];
  const toolUseId = nonBlankString(field(value, "toolUseId", "tool_use_id"));
  return toolUseId ? [{ toolUseId, content: value.content }] : [];
}

function asyncTaskOutputFilePath(content: unknown, taskId: string): string | undefined {
  const text = textContent(content);
  if (!text) return undefined;
  const marker = "Output is being written to: ";
  const start = text.indexOf(marker);
  if (start < 0) return undefined;
  const valueStart = start + marker.length;
  const valueEnd = text.indexOf(". You will be notified", valueStart);
  if (valueEnd < 0) return undefined;
  const path = text.slice(valueStart, valueEnd).trim();
  const expectedPosixSuffix = `/tasks/${taskId}.output`;
  const expectedWindowsSuffix = `\\tasks\\${taskId}.output`;
  return path.endsWith(expectedPosixSuffix) || path.endsWith(expectedWindowsSuffix)
    ? path
    : undefined;
}

function textContent(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    const parts = value.map(textContent).filter((part): part is string => part !== undefined);
    return parts.length > 0 ? parts.join("") : undefined;
  }
  if (!isRecord(value)) return undefined;
  if (typeof value.text === "string") return value.text;
  return value.content === value ? undefined : textContent(value.content);
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

function isSubagentTask(message: AsyncTaskStarted): boolean {
  return (
    field(message, "subagentType", "subagent_type") !== undefined ||
    field(message, "taskType", "task_type") === "local_agent"
  );
}

function taskState(value: unknown): AsyncTaskState | undefined {
  if (value === "pending" || value === "running") return "running";
  if (value === "paused") return "paused";
  if (value === "completed") return "completed";
  if (value === "failed") return "failed";
  if (value === "killed" || value === "cancelled" || value === "stopped") return "stopped";
  return undefined;
}

function isTerminal(state: AsyncTaskState): state is "completed" | "failed" | "stopped" {
  return state === "completed" || state === "failed" || state === "stopped";
}

function taskUsage(
  value: unknown,
): { totalTokens: number; toolUses: number; durationMs: number } | undefined {
  if (!isRecord(value)) return undefined;
  const totalTokens = numberField(value, "totalTokens", "total_tokens");
  const toolUses = numberField(value, "toolUses", "tool_uses");
  const durationMs = numberField(value, "durationMs", "duration_ms");
  if (totalTokens === undefined || toolUses === undefined || durationMs === undefined)
    return undefined;
  return { totalTokens, toolUses, durationMs };
}

function taskIdOf(value: TaskIdentity): string | undefined {
  return nonBlankString(field(value, "taskId", "task_id"));
}

function field(value: object, camelCase: string, snakeCase: string): unknown {
  const record = value as Record<string, unknown>;
  return record[camelCase] !== undefined ? record[camelCase] : record[snakeCase];
}

function numberField(
  value: Record<string, unknown>,
  camelCase: string,
  snakeCase: string,
): number | undefined {
  const result = field(value, camelCase, snakeCase);
  return typeof result === "number" ? result : undefined;
}

function nonBlankString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
