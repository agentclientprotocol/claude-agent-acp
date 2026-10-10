import { RequestError } from "@agentclientprotocol/sdk";
import type { Query } from "@anthropic-ai/claude-agent-sdk";
import { raceTimeoutAndAbort } from "./utils.js";
export const RUNTIME_READ_METHOD = "_session/runtime/read";
export const RUNTIME_CONTROL_METHOD = "_session/runtime/control";
export const RUNTIME_READS = ["context", "queuedMessages"] as const;
export const RUNTIME_CONTROLS = ["cancelQueuedMessage"] as const;
export type RuntimeReadRequest = { sessionId: string } & (
  { resource: "context"; detail?: "summary" | "full" } | { resource: "queuedMessages" }
);
export type RuntimeControlRequest = {
  sessionId: string;
  action: "cancelQueuedMessage";
  messageId: string;
};
export type RuntimeResponse =
  | { version: 1; status: "ok"; data: unknown }
  | {
      version: 1;
      status: "unavailable";
      reason: "unsupported" | "timeout" | "cancelled" | "stale";
    };

/** Versioned discovery, independent of the client's rendering contract. */
export function runtimeCapability() {
  return {
    version: 1,
    readMethod: RUNTIME_READ_METHOD,
    controlMethod: RUNTIME_CONTROL_METHOD,
    reads: [...RUNTIME_READS],
    controls: [...RUNTIME_CONTROLS],
    context: { details: ["summary", "full"], defaultDetail: "summary", fullMayUseNetwork: true },
    queuedMessages: {
      scope: "adapter_prompts",
      runtimeSupport: "checked_on_request",
      cancellation: "pending_only",
    },
  };
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw RequestError.invalidParams(undefined, "runtime params must be an object");
  }
  return value as Record<string, unknown>;
}

function identifier(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > 4096 ||
    Array.from(value).some((character) => character.charCodeAt(0) < 32)
  ) {
    throw RequestError.invalidParams(undefined, `${field} must be a non-empty identifier`);
  }
  return value;
}

function keys(params: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(params).some((key) => !allowed.includes(key))) {
    throw RequestError.invalidParams(undefined, "Unknown runtime request field");
  }
}

export function parseRuntimeReadRequest(value: unknown): RuntimeReadRequest {
  const params = record(value);
  keys(
    params,
    params.resource === "context" ? ["sessionId", "resource", "detail"] : ["sessionId", "resource"],
  );
  const sessionId = identifier(params.sessionId, "sessionId");
  if (!RUNTIME_READS.includes(params.resource as RuntimeReadRequest["resource"])) {
    throw RequestError.invalidParams(undefined, "Unknown runtime resource");
  }
  if (params.resource === "context") {
    if (params.detail !== undefined && params.detail !== "summary" && params.detail !== "full") {
      throw RequestError.invalidParams(undefined, "detail must be summary or full");
    }
    return { sessionId, resource: "context", detail: params.detail ?? "summary" };
  }
  return {
    sessionId,
    resource: params.resource as Exclude<RuntimeReadRequest["resource"], "context">,
  };
}

export function parseRuntimeControlRequest(value: unknown): RuntimeControlRequest {
  const params = record(value);
  keys(params, ["sessionId", "action", "messageId"]);
  if (params.action !== "cancelQueuedMessage")
    throw RequestError.invalidParams(undefined, "Unknown runtime action");
  return {
    sessionId: identifier(params.sessionId, "sessionId"),
    action: params.action,
    messageId: identifier(params.messageId, "messageId"),
  };
}
export type RuntimeQuery = Partial<Pick<Query, "getContextUsage">> & {
  /** SDK 0.3.293 implements this outside its public Query type. */
  cancelAsyncMessage?: (uuid: string) => Promise<unknown>;
};
export async function readRuntime(
  query: RuntimeQuery,
  request: Exclude<RuntimeReadRequest, { resource: "queuedMessages" }>,
  signal: AbortSignal,
  isCurrent: () => boolean = () => true,
  timeoutMs = 5000,
): Promise<RuntimeResponse> {
  if (signal.aborted) return { version: 1, status: "unavailable", reason: "cancelled" };
  if (!isCurrent()) return { version: 1, status: "unavailable", reason: "stale" };
  if (typeof query.getContextUsage !== "function")
    return { version: 1, status: "unavailable", reason: "unsupported" };
  const outcome = await raceTimeoutAndAbort(
    query.getContextUsage({ detail: request.detail ?? "summary" }),
    timeoutMs,
    signal,
  );
  if (outcome.type !== "done")
    return {
      version: 1,
      status: "unavailable",
      reason: outcome.type === "timeout" ? "timeout" : "cancelled",
    };
  if (!isCurrent()) return { version: 1, status: "unavailable", reason: "stale" };
  return { version: 1, status: "ok", data: outcome.value };
}
export async function controlRuntime(
  query: RuntimeQuery,
  request: RuntimeControlRequest,
): Promise<RuntimeResponse> {
  if (typeof query.cancelAsyncMessage !== "function")
    return { version: 1, status: "unavailable", reason: "unsupported" };
  const cancelled = await query.cancelAsyncMessage(request.messageId);
  if (typeof cancelled !== "boolean")
    throw RequestError.internalError(
      undefined,
      "Invalid native cancellation acknowledgement; outcome unknown",
    );
  return { version: 1, status: "ok", data: { messageId: request.messageId, cancelled } };
}
