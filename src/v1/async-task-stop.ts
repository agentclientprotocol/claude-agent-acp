import { RequestError } from "@agentclientprotocol/sdk/unstable";

/** Stops one Claude background task without cancelling the parent prompt turn. */
export const ASYNC_TASK_STOP_METHOD = "_session/async_task/stop";

export type AsyncTaskStopRequest = {
  sessionId: string;
  asyncTaskId: string;
};

export type AsyncTaskStopResponse = {
  stopped: boolean;
};

export function parseAsyncTaskStopRequest(value: unknown): AsyncTaskStopRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw RequestError.invalidParams(undefined, "async task stop params must be an object");
  }
  const params = value as Record<string, unknown>;
  const sessionId = typeof params.sessionId === "string" ? params.sessionId.trim() : "";
  const asyncTaskId = typeof params.asyncTaskId === "string" ? params.asyncTaskId.trim() : "";
  if (!sessionId) {
    throw RequestError.invalidParams(
      undefined,
      "async task stop params require a non-empty sessionId",
    );
  }
  if (!asyncTaskId) {
    throw RequestError.invalidParams(
      undefined,
      "async task stop params require a non-empty asyncTaskId",
    );
  }
  return { sessionId, asyncTaskId };
}
