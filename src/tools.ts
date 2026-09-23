import type {
  PlanEntry,
  ToolCallContent,
  ToolCallLocation,
  ToolKind,
} from "@agentclientprotocol/sdk";
import { HookCallback } from "@anthropic-ai/claude-agent-sdk";
import type {
  TaskCreateInput,
  TaskCreateOutput,
  TaskListOutput,
  TaskUpdateInput,
  TaskUpdateOutput,
} from "@anthropic-ai/claude-agent-sdk/sdk-tools.js";
import { ClientCapabilities } from "./tool-calls/client-capabilities.js";
import type { ToolResultBlock } from "./tool-calls/content.js";
import { AcpToolCallRenderer, type RenderedResult } from "./tool-calls/renderer.js";

export { markdownEscape, toDisplayPath, toolResponseMarkers } from "./tool-calls/content.js";

/**
 * The title, kind, content, and locations of a tool use, for a client with the
 * given terminal and patch capabilities. The {@link AcpToolCallRenderer} builds
 * them from the facts of the tool reporter.
 */
export function toolInfoFromToolUse(
  toolUse: any,
  supportsTerminalOutput: boolean = false,
  cwd?: string,
  supportsDiffPatch: boolean = false,
): {
  title: string;
  kind: ToolKind;
  content: ToolCallContent[];
  locations?: ToolCallLocation[];
} {
  const renderer = new AcpToolCallRenderer(
    new ClientCapabilities(supportsTerminalOutput, false, supportsDiffPatch),
  );
  return renderer.toolInfo({ id: toolUse?.id, name: toolUse?.name, input: toolUse?.input }, cwd);
}

/**
 * The result fields of a tool result, for a client with the given terminal
 * capabilities. The {@link AcpToolCallRenderer} builds them from the facts of
 * the tool reporter.
 */
export function toolUpdateFromToolResult(
  toolResult: ToolResultBlock,
  toolUse: any | undefined,
  supportsTerminalOutput: boolean = false,
  toolUseResult?: unknown,
  preferTerminalOutputDelta: boolean = false,
): RenderedResult {
  const renderer = new AcpToolCallRenderer(
    new ClientCapabilities(supportsTerminalOutput, preferTerminalOutputDelta),
  );
  return renderer.resultFields(
    { id: toolUse?.id, name: toolUse?.name ?? "", input: toolUse?.input },
    toolResult as Parameters<AcpToolCallRenderer["resultFields"]>[1],
    toolUseResult,
  );
}

export type ClaudePlanEntry = {
  content: string;
  status: "pending" | "in_progress" | "completed";
  activeForm: string;
};

export function planEntries(input: { todos: ClaudePlanEntry[] } | undefined): PlanEntry[] {
  return (input?.todos ?? []).map((todo) => ({
    content: todo.status === "in_progress" && todo.activeForm ? todo.activeForm : todo.content,
    status: todo.status,
    priority: "medium",
  }));
}

/**
 * Per-session task list accumulated from Task* tool calls (TaskCreate /
 * TaskUpdate). The headless/SDK session emits these as incremental tool
 * calls keyed by task ID, replacing the snapshot-style TodoWrite tool.
 * Iteration order is insertion order (Map semantics), matching the order
 * tasks are created.
 */
export type TaskEntry = {
  subject: string;
  status: "pending" | "in_progress" | "completed";
  activeForm?: string;
  description?: string;
};
export type TaskState = Map<string, TaskEntry>;

/**
 * Best-effort parse of a structured Task* tool_result. The SDK delivers tool
 * outputs either as a string or as an array of TextBlockParam-like blocks
 * containing JSON text; try both.
 */
function parseJsonToolOutput<T>(
  content: unknown,
  isExpectedOutput: (value: unknown) => value is T,
): T | undefined {
  const tryParse = (text: string): T | undefined => {
    try {
      const parsed: unknown = JSON.parse(text);
      return isExpectedOutput(parsed) ? parsed : undefined;
    } catch {
      return undefined;
    }
  };

  if (typeof content === "string") {
    return tryParse(content);
  }
  if (content && typeof content === "object" && !Array.isArray(content)) {
    return isExpectedOutput(content) ? content : undefined;
  }
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block && typeof block === "object" && "type" in block && block.type === "text") {
        const text = (block as { text?: unknown }).text;
        if (typeof text === "string") {
          const parsed = tryParse(text);
          if (parsed) return parsed;
        }
      }
    }
  }
  return undefined;
}

function toolOutputTexts(content: unknown): string[] {
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return [];
  return content.flatMap((block) =>
    block &&
    typeof block === "object" &&
    "type" in block &&
    block.type === "text" &&
    "text" in block &&
    typeof block.text === "string"
      ? [block.text]
      : [],
  );
}

export function parseTaskCreateOutput(content: unknown): TaskCreateOutput | undefined {
  const structured = parseJsonToolOutput(content, (parsed): parsed is TaskCreateOutput =>
    Boolean(
      parsed &&
      typeof parsed === "object" &&
      "task" in parsed &&
      parsed.task &&
      typeof parsed.task === "object" &&
      "id" in parsed.task &&
      typeof parsed.task.id === "string",
    ),
  );
  if (structured) return structured;

  for (const text of toolOutputTexts(content)) {
    const match = /^Task #(\S+) created successfully: (.+)$/.exec(text.trim());
    if (match) return { task: { id: match[1], subject: match[2] } };
  }
  return undefined;
}

export function parseTaskListOutput(content: unknown): TaskListOutput | undefined {
  const validStatuses = new Set(["pending", "in_progress", "completed"]);
  const structured = parseJsonToolOutput(content, (parsed): parsed is TaskListOutput =>
    Boolean(
      parsed &&
      typeof parsed === "object" &&
      "tasks" in parsed &&
      Array.isArray(parsed.tasks) &&
      parsed.tasks.every(
        (task) =>
          task &&
          typeof task === "object" &&
          typeof task.id === "string" &&
          typeof task.subject === "string" &&
          typeof task.status === "string" &&
          validStatuses.has(task.status),
      ),
    ),
  );
  if (structured) return structured;

  for (const text of toolOutputTexts(content)) {
    if (text.trim() === "No tasks found") return { tasks: [] };

    const tasks: TaskListOutput["tasks"] = [];
    const lines = text.trim().split("\n");
    for (const line of lines) {
      const match = /^#(\S+) \[(pending|in_progress|completed)\] (.+)$/.exec(line);
      if (!match) {
        tasks.length = 0;
        break;
      }

      let subject = match[3];
      let owner: string | undefined;
      let blockedBy: string[] = [];

      const blockedMarker = " [blocked by ";
      const blockedStart = subject.lastIndexOf(blockedMarker);
      if (blockedStart > 0 && subject.endsWith("]")) {
        const dependencies = subject.slice(blockedStart + blockedMarker.length, -1).split(", ");
        if (
          dependencies.every(
            (dependency) =>
              dependency.length > 1 &&
              dependency.startsWith("#") &&
              !dependency.includes(",") &&
              !dependency.includes("]"),
          )
        ) {
          subject = subject.slice(0, blockedStart);
          blockedBy = dependencies.map((dependency) => dependency.slice(1));
        }
      }

      const ownerStart = subject.lastIndexOf(" (");
      if (ownerStart > 0 && subject.endsWith(")")) {
        const candidate = subject.slice(ownerStart + 2, -1);
        if (!candidate.includes("(") && !candidate.includes(")")) {
          subject = subject.slice(0, ownerStart);
          owner = candidate || undefined;
        }
      }

      tasks.push({
        id: match[1],
        subject,
        status: match[2] as TaskListOutput["tasks"][number]["status"],
        ...(owner ? { owner } : {}),
        blockedBy,
      });
    }
    if (tasks.length > 0) return { tasks };
  }
  return undefined;
}

export function parseTaskUpdateOutput(
  content: unknown,
  expectedTaskId?: string,
): TaskUpdateOutput | undefined {
  const structured = parseJsonToolOutput(content, (parsed): parsed is TaskUpdateOutput =>
    Boolean(
      parsed &&
      typeof parsed === "object" &&
      "success" in parsed &&
      typeof parsed.success === "boolean" &&
      "taskId" in parsed &&
      typeof parsed.taskId === "string" &&
      "updatedFields" in parsed &&
      Array.isArray(parsed.updatedFields) &&
      parsed.updatedFields.every((field) => typeof field === "string"),
    ),
  );
  if (structured) return structured;

  for (const text of toolOutputTexts(content)) {
    const notFound = /^Task #(\S+) not found$/.exec(text.trim());
    const taskId = notFound?.[1] ?? expectedTaskId;
    if (taskId && (notFound || text.trim() === "Failed to delete task")) {
      return { success: false, taskId, updatedFields: [], error: text.trim() };
    }
  }
  return undefined;
}

export function applyTaskCreate(
  state: TaskState,
  input: TaskCreateInput | undefined,
  output: TaskCreateOutput | undefined,
): void {
  const taskId = output?.task?.id;
  if (!taskId || !input) return;
  state.set(taskId, {
    subject: input.subject,
    status: "pending",
    activeForm: input.activeForm,
    description: input.description,
  });
}

export function applyTaskUpdate(state: TaskState, input: TaskUpdateInput | undefined): void {
  if (!input?.taskId) return;
  if (input.status === "deleted") {
    state.delete(input.taskId);
    return;
  }
  const existing = state.get(input.taskId);
  // Without a subject from either the existing entry or the update payload,
  // we'd produce a plan entry with empty `content` — drop the update.
  const subject = input.subject ?? existing?.subject;
  if (!subject) return;
  state.set(input.taskId, {
    subject,
    status: input.status ?? existing?.status ?? "pending",
    activeForm: input.activeForm ?? existing?.activeForm,
    description: input.description ?? existing?.description,
  });
}

export function applyTaskList(state: TaskState, output: TaskListOutput): void {
  const previous = new Map(state);
  state.clear();
  for (const task of output.tasks) {
    const existing = previous.get(task.id);
    state.set(task.id, {
      subject: task.subject,
      status: task.status,
      activeForm: existing?.activeForm,
      description: existing?.description,
    });
  }
}

export function taskStateToPlanEntries(state: TaskState): PlanEntry[] {
  return Array.from(state.values()).map((task) => ({
    content: task.status === "in_progress" && task.activeForm ? task.activeForm : task.subject,
    status: task.status,
    priority: "medium",
  }));
}

/** The plan entries that the client holds for each task list, as JSON. */
const publishedTaskPlans = new WeakMap<TaskState, string>();

/**
 * The plan entries of the task list, or undefined when the client already
 * holds the same entries. The TaskCreated and TaskCompleted hooks and the
 * Task* tool results report the same change, so the second report of a
 * change has nothing new.
 *
 * Only an AIR client skips the repeated plan. Every other client gets every
 * plan, like upstream: pass `airClient` false.
 */
export function changedTaskPlanEntries(
  state: TaskState,
  airClient = true,
): PlanEntry[] | undefined {
  const entries = taskStateToPlanEntries(state);
  if (!airClient) return entries;
  const json = JSON.stringify(entries);
  if (publishedTaskPlans.get(state) === json) return undefined;
  publishedTaskPlans.set(state, json);
  return entries;
}

/** Forgets the plan that the client holds, so that the next plan goes out, for example on replay. */
export function forgetPublishedTaskPlan(state: TaskState): void {
  publishedTaskPlans.delete(state);
}

/* Callbacks are keyed globally because the SDK hook is process-wide, but each
 * entry retains its owning ACP session so cancellation/teardown can release it. */
const toolUseCallbacks = new Map<
  string,
  {
    ownerId?: string;
    cleanupTimer?: ReturnType<typeof setTimeout>;
    onPostToolUseHook?: (
      toolUseID: string,
      toolInput: unknown,
      toolResponse: unknown,
    ) => Promise<void>;
    onRelease?: () => void;
  }
>();

/* Setup callbacks that will be called when receiving hooks from Claude Code.
 * `onRelease` runs once when the callback leaves the registry: after the hook
 * fired, after the grace period, or at session teardown. */
export const registerHookCallback = (
  toolUseID: string,
  {
    onPostToolUseHook,
    onRelease,
  }: {
    onPostToolUseHook?: (
      toolUseID: string,
      toolInput: unknown,
      toolResponse: unknown,
    ) => Promise<void>;
    onRelease?: () => void;
  },
  ownerId?: string,
) => {
  unregisterHookCallback(toolUseID);
  toolUseCallbacks.set(toolUseID, {
    ownerId,
    onPostToolUseHook,
    onRelease,
  });
};

export function unregisterHookCallback(toolUseID: string): void {
  const callback = toolUseCallbacks.get(toolUseID);
  if (callback?.cleanupTimer) clearTimeout(callback.cleanupTimer);
  toolUseCallbacks.delete(toolUseID);
  callback?.onRelease?.();
}

/** Whether a PostToolUse callback for the tool use is still registered. */
export function hasHookCallback(toolUseID: string): boolean {
  return toolUseCallbacks.has(toolUseID);
}

/** PostToolUse normally follows tool_result, so keep the callback for a short
 * grace period while still bounding retention when the hook never arrives. */
export function completeHookCallback(toolUseID: string): void {
  const callback = toolUseCallbacks.get(toolUseID);
  if (!callback || callback.cleanupTimer) return;
  callback.cleanupTimer = setTimeout(() => unregisterHookCallback(toolUseID), 30_000);
  callback.cleanupTimer.unref?.();
}

export function clearHookCallbacks(ownerId: string): void {
  for (const [toolUseID, callback] of toolUseCallbacks) {
    if (callback.ownerId === ownerId) unregisterHookCallback(toolUseID);
  }
}

/* A callback for Claude Code that is called when receiving a PostToolUse hook */
export const createPostToolUseHook =
  (options?: { onEnterPlanMode?: () => Promise<void> }): HookCallback =>
  async (input: any, toolUseID: string | undefined): Promise<{ continue: boolean }> => {
    if (input.hook_event_name === "PostToolUse") {
      // Handle EnterPlanMode tool - notify client of mode change after successful execution
      if (input.tool_name === "EnterPlanMode" && options?.onEnterPlanMode) {
        await options.onEnterPlanMode();
      }

      if (toolUseID) {
        const onPostToolUseHook = toolUseCallbacks.get(toolUseID)?.onPostToolUseHook;
        try {
          if (onPostToolUseHook) {
            await onPostToolUseHook(toolUseID, input.tool_input, input.tool_response);
          }
        } finally {
          unregisterHookCallback(toolUseID);
        }
      }
    }
    return { continue: true };
  };

/**
 * Hook callback for `TaskCreated` / `TaskCompleted` events. The SDK fires
 * these for both user-facing TaskCreate tool calls and subagent task
 * creation, giving us `task_id` + `task_subject` without having to parse
 * tool_result payloads.
 *
 * Populating `taskState` from the hook means a later `TaskUpdate` (which
 * typically only carries `taskId` + `status`) finds an existing entry with
 * a real subject, instead of synthesizing a placeholder with empty content.
 */
export const createTaskHook =
  (options: { taskState: TaskState; onChange?: () => Promise<void> }): HookCallback =>
  async (input): Promise<{ continue: boolean }> => {
    const taskId =
      "task_id" in input && typeof input.task_id === "string" ? input.task_id : undefined;
    if (!taskId) return { continue: true };

    if (input.hook_event_name === "TaskCreated") {
      if (!input.task_subject) return { continue: true };
      if (options.taskState.has(taskId)) return { continue: true };
      options.taskState.set(taskId, {
        subject: input.task_subject,
        status: "pending",
        description: input.task_description,
      });
      if (options.onChange) await options.onChange();
    } else if (input.hook_event_name === "TaskCompleted") {
      const existing = options.taskState.get(taskId);
      if (!existing || existing.status === "completed") return { continue: true };
      options.taskState.set(taskId, { ...existing, status: "completed" });
      if (options.onChange) await options.onChange();
    }
    return { continue: true };
  };
