import { RequestError } from "@agentclientprotocol/sdk/unstable";
import type { Query } from "@anthropic-ai/claude-agent-sdk";

/** Moves blocking tool calls (Bash commands, subagents) to the background, as
 *  Ctrl+B does in the Claude Code terminal. */
export const BACKGROUND_TASK_METHOD = "_session/async_task/background";

export type BackgroundTaskRequest = {
  sessionId: string;
  /** The ACP tool call id, which is the SDK `tool_use` id. Without it, every
   *  foreground task of the session goes to the background. */
  toolCallId?: string;
};

export type BackgroundTaskResponse = {
  backgrounded: boolean;
};

export function parseBackgroundTaskRequest(value: unknown): BackgroundTaskRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw RequestError.invalidParams(undefined, "async task background params must be an object");
  }
  const params = value as Record<string, unknown>;
  const sessionId = typeof params.sessionId === "string" ? params.sessionId.trim() : "";
  if (!sessionId) {
    throw RequestError.invalidParams(
      undefined,
      "async task background params require a non-empty sessionId",
    );
  }
  if (params.toolCallId === undefined || params.toolCallId === null) return { sessionId };
  const toolCallId = typeof params.toolCallId === "string" ? params.toolCallId.trim() : "";
  if (!toolCallId) {
    throw RequestError.invalidParams(
      undefined,
      "async task background toolCallId must be a non-empty string when present",
    );
  }
  return { sessionId, toolCallId };
}

/**
 * Asks Claude Code to background the foreground task of `toolCallId`, or all
 * foreground tasks. The task's async task, the `backgrounded` marker and the
 * rest of the lifecycle come from the SDK messages that follow, through the
 * same path as a command that started in the background.
 */
export async function backgroundForegroundTasks(
  query: Pick<Query, "backgroundTasks">,
  params: Pick<BackgroundTaskRequest, "toolCallId">,
): Promise<BackgroundTaskResponse> {
  try {
    return { backgrounded: await query.backgroundTasks(params.toolCallId) };
  } catch (error) {
    // The SDK throws when background tasks are disabled for the session
    // (`CLAUDE_CODE_DISABLE_BACKGROUND_TASKS`). It has no typed error for it.
    const cause = error instanceof Error ? error.message : String(error);
    throw RequestError.invalidRequest(
      undefined,
      `Claude Code could not background the task, so it keeps running in the foreground. Background tasks may be disabled for this session (CLAUDE_CODE_DISABLE_BACKGROUND_TASKS). Cause: ${cause}`,
    );
  }
}
