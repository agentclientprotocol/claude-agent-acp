import { RequestError } from "@agentclientprotocol/sdk";
import type { McpServerStatus, Query } from "@anthropic-ai/claude-agent-sdk";
import { raceTimeoutAndAbort } from "./utils.js";

export const RUNTIME_READ_METHOD = "_session/runtime/read";
export const RUNTIME_CONTROL_METHOD = "_session/runtime/control";
export const RUNTIME_READS = [
  "context",
  "usage",
  "mcp",
  "commands",
  "agents",
  "queuedMessages",
] as const;
export const RUNTIME_CONTROLS = [
  "reloadSkills",
  "reloadPlugins",
  "reloadOutputStyles",
  "reconnectMcp",
  "toggleMcp",
  "backgroundTask",
  "cancelQueuedMessage",
] as const;

export type RuntimeReadRequest = { sessionId: string } & (
  | { resource: "context"; detail?: "summary" | "full" }
  | { resource: "queuedMessages" }
  | { resource: Exclude<(typeof RUNTIME_READS)[number], "context" | "queuedMessages"> }
);
export type RuntimeControlRequest = { sessionId: string } & (
  | { action: "reloadSkills" | "reloadOutputStyles" }
  | { action: "reloadPlugins"; holdOnCacheImpact: boolean }
  | { action: "reconnectMcp"; serverName: string }
  | { action: "toggleMcp"; serverName: string; enabled: boolean }
  | { action: "backgroundTask"; toolUseId: string }
  | { action: "cancelQueuedMessage"; messageId: string }
);
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
    if (params.detail !== undefined && params.detail !== "summary" && params.detail !== "full")
      throw RequestError.invalidParams(undefined, "detail must be summary or full");
    return { sessionId, resource: "context", detail: params.detail ?? "summary" };
  }
  if (params.resource === "queuedMessages") return { sessionId, resource: "queuedMessages" };
  return {
    sessionId,
    resource: params.resource as Exclude<
      RuntimeReadRequest["resource"],
      "context" | "queuedMessages"
    >,
  };
}

export function parseRuntimeControlRequest(value: unknown): RuntimeControlRequest {
  const params = record(value);
  const sessionId = identifier(params.sessionId, "sessionId");
  switch (params.action) {
    case "cancelQueuedMessage":
      keys(params, ["sessionId", "action", "messageId"]);
      return {
        sessionId,
        action: params.action,
        messageId: identifier(params.messageId, "messageId"),
      };
    case "reloadSkills":
    case "reloadOutputStyles":
      keys(params, ["sessionId", "action"]);
      return { sessionId, action: params.action };
    case "reloadPlugins":
      keys(params, ["sessionId", "action", "holdOnCacheImpact"]);
      if (params.holdOnCacheImpact !== undefined && typeof params.holdOnCacheImpact !== "boolean") {
        throw RequestError.invalidParams(undefined, "holdOnCacheImpact must be a boolean");
      }
      return {
        sessionId,
        action: params.action,
        holdOnCacheImpact: params.holdOnCacheImpact ?? true,
      };
    case "reconnectMcp":
      keys(params, ["sessionId", "action", "serverName"]);
      return {
        sessionId,
        action: params.action,
        serverName: identifier(params.serverName, "serverName"),
      };
    case "toggleMcp":
      keys(params, ["sessionId", "action", "serverName", "enabled"]);
      if (typeof params.enabled !== "boolean") {
        throw RequestError.invalidParams(undefined, "enabled must be a boolean");
      }
      return {
        sessionId,
        action: params.action,
        serverName: identifier(params.serverName, "serverName"),
        enabled: params.enabled,
      };
    case "backgroundTask":
      keys(params, ["sessionId", "action", "toolUseId"]);
      return {
        sessionId,
        action: params.action,
        toolUseId: identifier(params.toolUseId, "toolUseId"),
      };
    default:
      throw RequestError.invalidParams(undefined, "Unknown runtime action");
  }
}

const READ_METHODS = {
  context: "getContextUsage",
  usage: "usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET",
  mcp: "mcpServerStatus",
  commands: "supportedCommands",
  agents: "supportedAgents",
} as const;
const CONTROL_METHODS = {
  reloadSkills: "reloadSkills",
  reloadPlugins: "reloadPlugins",
  reloadOutputStyles: "reloadOutputStyles",
  reconnectMcp: "reconnectMcpServer",
  toggleMcp: "toggleMcpServer",
  backgroundTask: "backgroundTasks",
  cancelQueuedMessage: "cancelAsyncMessage",
} as const;
export type RuntimeQuery = Partial<
  Pick<
    Query,
    | (typeof READ_METHODS)[keyof typeof READ_METHODS]
    | Exclude<(typeof CONTROL_METHODS)[keyof typeof CONTROL_METHODS], "cancelAsyncMessage">
  >
> & {
  /** SDK 0.3.293 implements this outside its public Query type. */
  cancelAsyncMessage?: (uuid: string) => Promise<unknown>;
};

/** MCP launch configuration can contain environment credentials and headers.
 * Only presentation fields cross this status boundary. */
export function runtimeMcpStatus(servers: McpServerStatus[]) {
  return servers.map((server) => ({
    name: server.name,
    status: server.status,
    ...(server.scope === undefined ? {} : { scope: server.scope }),
    ...(server.source === undefined ? {} : { source: server.source }),
    ...(server.serverInfo === undefined ? {} : { serverInfo: server.serverInfo }),
    toolNames: server.tools?.map((tool) => tool.name) ?? [],
  }));
}

export async function readRuntime(
  query: RuntimeQuery,
  request: Exclude<RuntimeReadRequest, { resource: "queuedMessages" }>,
  signal: AbortSignal,
  isCurrent: () => boolean = () => true,
  timeoutMs = 5000,
): Promise<RuntimeResponse> {
  if (signal.aborted) return { version: 1, status: "unavailable", reason: "cancelled" };
  if (!isCurrent()) return { version: 1, status: "unavailable", reason: "stale" };
  if (typeof query[READ_METHODS[request.resource]] !== "function") {
    return { version: 1, status: "unavailable", reason: "unsupported" };
  }
  const operation = async (): Promise<unknown> => {
    switch (request.resource) {
      case "context":
        return query.getContextUsage!({ detail: request.detail ?? "summary" });
      case "usage": {
        const usage = await query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET!({
          skipBehaviors: true,
        });
        return {
          session: usage.session,
          subscription_type: usage.subscription_type,
          rate_limits_available: usage.rate_limits_available,
          rate_limits: usage.rate_limits,
        };
      }
      case "mcp":
        return runtimeMcpStatus(await query.mcpServerStatus!());
      case "commands":
        return query.supportedCommands!();
      case "agents":
        return query.supportedAgents!();
      default:
        throw RequestError.invalidParams(undefined, "Unknown runtime resource");
    }
  };
  const outcome = await raceTimeoutAndAbort(operation(), timeoutMs, signal);
  if (outcome.type !== "done") {
    return {
      version: 1,
      status: "unavailable",
      reason: outcome.type === "timeout" ? "timeout" : "cancelled",
    };
  }
  if (!isCurrent()) return { version: 1, status: "unavailable", reason: "stale" };
  return { version: 1, status: "ok", data: outcome.value };
}

/** Caller holds the session lifecycle reservation until this promise settles.
 * A client timeout does not undo or cancel a native mutation. Do not race this
 * promise against a timer and release the reservation while it still runs. */
export async function controlRuntime(
  query: RuntimeQuery,
  request: RuntimeControlRequest,
): Promise<RuntimeResponse> {
  if (typeof query[CONTROL_METHODS[request.action]] !== "function") {
    return { version: 1, status: "unavailable", reason: "unsupported" };
  }
  let data: unknown;
  switch (request.action) {
    case "reloadSkills":
      data = await query.reloadSkills!();
      break;
    case "reloadOutputStyles":
      data = await query.reloadOutputStyles!();
      break;
    case "reloadPlugins": {
      const result = await query.reloadPlugins!({ holdOnCacheImpact: request.holdOnCacheImpact });
      data = { ...result, mcpServers: runtimeMcpStatus(result.mcpServers) };
      break;
    }
    case "reconnectMcp":
      await query.reconnectMcpServer!(request.serverName);
      data = { completed: true };
      break;
    case "toggleMcp":
      await query.toggleMcpServer!(request.serverName, request.enabled);
      data = { completed: true };
      break;
    case "cancelQueuedMessage": {
      const cancelled = await query.cancelAsyncMessage!(request.messageId);
      if (typeof cancelled !== "boolean")
        throw RequestError.internalError(
          undefined,
          "Invalid native cancellation acknowledgement; outcome unknown",
        );
      data = { messageId: request.messageId, cancelled };
      break;
    }
    case "backgroundTask":
      data = { backgrounded: await query.backgroundTasks!(request.toolUseId) };
      break;
    default:
      throw RequestError.invalidParams(undefined, "Unknown runtime action");
  }
  return { version: 1, status: "ok", data };
}
