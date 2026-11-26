/**
 * MCP Apps (SEP-1865) for ACP clients: an MCP tool can declare a `ui://`
 * resource (`_meta.ui.resourceUri`) that a host renders next to the tool's
 * result in a sandboxed frame, and the frame can call the server's tools.
 * Claude Code dials the MCP servers itself, so a client can only reach them
 * through the agent. This module gives the client the three things a host
 * needs (see `docs/mcp-apps.md`):
 *
 * - on the tool call of an app tool, `_meta.mcpApp`: the server, the tool,
 *   the `resourceUri` and the server's own result;
 * - `_session/mcp/resources/read`: the `ui://` resource, read by Claude Code;
 * - `_session/mcp/tools/call`: a tool call for the app, on the live session,
 *   whose result goes to the client and not to the model.
 */
import { RequestError, type ClientCapabilities } from "@agentclientprotocol/sdk/unstable";
import type { McpServerStatus, Query } from "@anthropic-ai/claude-agent-sdk";
import { raceTimeoutAndAbort } from "./utils.js";

export const MCP_APPS_VERSION = 1 as const;
/** The capability key, in the client's and the agent's `initialize` `_meta`. */
export const MCP_APPS_KEY = "mcpApps";
/** The key of an app tool's `tool_call_update._meta`. */
export const MCP_APP_TOOL_CALL_KEY = "mcpApp";
export const MCP_RESOURCES_READ_METHOD = "_session/mcp/resources/read";
export const MCP_TOOLS_CALL_METHOD = "_session/mcp/tools/call";
export const MCP_TOOLS_LIST_METHOD = "_session/mcp/tools/list";

/** Claude Code's capabilities (`system/init` and the initialize response). */
const TOOL_UI_META = "mcp_tool_ui_meta_v1";
const READ_RESOURCE = "mcp_read_resource_v1";
const RESULT_NOT_FOR_MODEL = "mcp_call_result_not_for_model_v1";
const SOFT_ERROR_RESULT = "mcp_call_soft_error_result_v1";
const CHECK_PERMISSIONS = "mcp_call_check_permissions_v1";

/** The time that the server status read for a tool result can take. */
const STATUS_TIMEOUT_MS = 5_000;
/** A `toolResult` longer than this, as JSON, is left out of `_meta.mcpApp`. */
export const MAX_TOOL_RESULT_CHARS = 1_000_000;

/** The agent side of the capability, in `agentCapabilities._meta.mcpApps`. */
export type McpAppsCapability = {
  version: typeof MCP_APPS_VERSION;
  resourcesRead: typeof MCP_RESOURCES_READ_METHOD;
  toolsCall: typeof MCP_TOOLS_CALL_METHOD;
  toolsList: typeof MCP_TOOLS_LIST_METHOD;
};

export function mcpAppsCapability(): McpAppsCapability {
  return {
    version: MCP_APPS_VERSION,
    resourcesRead: MCP_RESOURCES_READ_METHOD,
    toolsCall: MCP_TOOLS_CALL_METHOD,
    toolsList: MCP_TOOLS_LIST_METHOD,
  };
}

/** Whether the client declared `clientCapabilities._meta.mcpApps` with a version of at least 1. */
export function clientSupportsMcpApps(
  capabilities: Pick<ClientCapabilities, "_meta"> | null | undefined,
): boolean {
  const declared = capabilities?._meta?.[MCP_APPS_KEY];
  if (!declared || typeof declared !== "object") return false;
  const { version } = declared as { version?: unknown };
  return typeof version === "number" && Number.isInteger(version) && version >= 1;
}

/** An MCP `CallToolResult`, as the server sent it. */
export type McpCallToolResult = {
  content: unknown[];
  structuredContent?: unknown;
  isError?: true;
  _meta?: Record<string, unknown>;
};

/** `tool_call_update._meta.mcpApp` of an app tool's result. */
export type McpAppToolCallMeta = {
  version: typeof MCP_APPS_VERSION;
  /** The server's name, as the client passes it to the two methods. */
  server: string;
  /** The tool's own name on the server, without the `mcp__<server>__` prefix. */
  tool: string;
  resourceUri: string;
  /** Absent when the result is longer than {@link MAX_TOOL_RESULT_CHARS}. */
  toolResult?: McpCallToolResult;
};

export type McpResourcesReadRequest = { sessionId: string; server: string; uri: string };
export type McpResourcesReadResponse = {
  contents: {
    uri: string;
    mimeType?: string;
    text?: string;
    blob?: string;
    _meta?: Record<string, unknown>;
  }[];
};

export type McpToolsCallRequest = {
  sessionId: string;
  server: string;
  /** The tool's own name on the server. */
  name: string;
  arguments?: Record<string, unknown>;
  /** Decide the call as the model's own call to the tool is decided. */
  checkPermissions?: boolean;
};

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

export function parseMcpResourcesReadRequest(params: unknown): McpResourcesReadRequest {
  if (!params || typeof params !== "object") {
    throw RequestError.invalidParams(undefined, "resources/read params must be an object");
  }
  const { sessionId, server, uri } = params as Record<string, unknown>;
  if (!nonEmptyString(sessionId) || !nonEmptyString(server) || !nonEmptyString(uri)) {
    throw RequestError.invalidParams(
      undefined,
      "resources/read params require a non-empty sessionId, server and uri",
    );
  }
  if (!uri.startsWith("ui://")) {
    throw RequestError.invalidParams(undefined, "Only ui:// resources can be read");
  }
  return { sessionId, server, uri };
}

export type McpToolsListRequest = { sessionId: string; server: string };

/** A tool of `_session/mcp/tools/list`: what a host needs to decide on an app's call to it. */
export type McpAppTool = {
  name: string;
  description?: string;
  /** MCP tool annotations: `readOnlyHint`, `destructiveHint`, `openWorldHint`. */
  annotations?: Record<string, boolean>;
  /** The tool's MCP Apps `_meta.ui` (`resourceUri`, `visibility`). */
  ui?: Record<string, unknown>;
};

export function parseMcpToolsListRequest(params: unknown): McpToolsListRequest {
  const { sessionId, server } = (params ?? {}) as Record<string, unknown>;
  if (!nonEmptyString(sessionId) || !nonEmptyString(server)) {
    throw RequestError.invalidParams(
      undefined,
      "tools/list params require a non-empty sessionId and server",
    );
  }
  return { sessionId, server };
}

/** Claude Code's tool annotations (`readOnly`…) under their MCP names (`readOnlyHint`…). */
export function toAppTools(tools: NonNullable<McpServerStatus["tools"]>): McpAppTool[] {
  return tools.map((tool) => {
    const a = tool.annotations;
    const annotations: Record<string, boolean> = {};
    if (a?.readOnly !== undefined) annotations.readOnlyHint = a.readOnly;
    if (a?.destructive !== undefined) annotations.destructiveHint = a.destructive;
    if (a?.openWorld !== undefined) annotations.openWorldHint = a.openWorld;
    const ui = tool._meta?.ui;
    return {
      name: tool.name,
      ...(tool.description ? { description: tool.description } : {}),
      ...(Object.keys(annotations).length ? { annotations } : {}),
      ...(ui && typeof ui === "object" ? { ui: ui as Record<string, unknown> } : {}),
    };
  });
}

export function parseMcpToolsCallRequest(params: unknown): McpToolsCallRequest {
  if (!params || typeof params !== "object") {
    throw RequestError.invalidParams(undefined, "tools/call params must be an object");
  }
  const {
    sessionId,
    server,
    name,
    arguments: args,
    checkPermissions,
  } = params as Record<string, unknown>;
  if (!nonEmptyString(sessionId) || !nonEmptyString(server) || !nonEmptyString(name)) {
    throw RequestError.invalidParams(
      undefined,
      "tools/call params require a non-empty sessionId, server and name",
    );
  }
  if (args !== undefined && (args === null || typeof args !== "object" || Array.isArray(args))) {
    throw RequestError.invalidParams(undefined, "tools/call arguments must be an object");
  }
  if (checkPermissions !== undefined && typeof checkPermissions !== "boolean") {
    throw RequestError.invalidParams(undefined, "tools/call checkPermissions must be a boolean");
  }
  return {
    sessionId,
    server,
    name,
    ...(args !== undefined ? { arguments: args as Record<string, unknown> } : {}),
    ...(checkPermissions !== undefined ? { checkPermissions } : {}),
  };
}

/** The name Claude Code gives a server's tool: `mcp__<server>__<tool>`, with
 *  each character of the server name outside `[a-zA-Z0-9_-]` replaced by `_`. */
export function claudeMcpToolName(server: string, tool: string): string {
  return `mcp__${server.replace(/[^a-zA-Z0-9_-]/g, "_")}__${tool}`;
}

type StatusTool = NonNullable<McpServerStatus["tools"]>[number];

/**
 * The connected server and tool that Claude Code calls `toolName`. Undefined
 * when none matches, or when two do: servers `a` and `a__b` both make
 * `mcp__a__b__c` a possible name.
 */
export function findMcpTool(
  statuses: readonly McpServerStatus[],
  toolName: string,
): { server: string; tool: StatusTool } | undefined {
  let found: { server: string; tool: StatusTool } | undefined;
  for (const status of statuses) {
    if (status.status !== "connected") continue;
    for (const tool of status.tools ?? []) {
      if (claudeMcpToolName(status.name, tool.name) !== toolName) continue;
      if (found) return undefined;
      found = { server: status.name, tool };
    }
  }
  return found;
}

/** The `ui://` resource of a tool's `_meta`: `ui.resourceUri`, else the deprecated flat `ui/resourceUri`. */
export function mcpAppResourceUri(meta: Record<string, unknown> | undefined): string | undefined {
  const ui = meta?.ui;
  const nested =
    ui && typeof ui === "object" ? (ui as { resourceUri?: unknown }).resourceUri : undefined;
  const uri = nested ?? meta?.["ui/resourceUri"];
  return typeof uri === "string" && uri.startsWith("ui://") ? uri : undefined;
}

/**
 * A `CallToolResult` from what Claude Code reports: the `tool_use_result` of a
 * model turn's MCP result (`{content, structuredContent?}`, where a text-only
 * `content` is one string), or an `mcp_call` reply. Undefined for anything
 * else.
 */
export function mcpCallToolResult(value: unknown): McpCallToolResult | undefined {
  if (typeof value === "string") return { content: [{ type: "text", text: value }] };
  if (Array.isArray(value)) return { content: value };
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const content =
    typeof record.content === "string"
      ? [{ type: "text", text: record.content }]
      : Array.isArray(record.content)
        ? record.content
        : undefined;
  if (!content && record.structuredContent === undefined) return undefined;
  return {
    content: content ?? [],
    ...(record.structuredContent !== undefined
      ? { structuredContent: record.structuredContent }
      : {}),
    ...(record.isError === true ? { isError: true as const } : {}),
    ...(record._meta && typeof record._meta === "object"
      ? { _meta: record._meta as Record<string, unknown> }
      : {}),
  };
}

/**
 * The control request for `mcp_call`. SDK 0.3.331 types the request
 * (`SDKControlMcpCallRequest`) but has no `Query` method for it, so it goes
 * through the query's own `request`, as `readMcpResource` does inside the SDK.
 */
async function mcpCall(query: Query, request: Record<string, unknown>): Promise<unknown> {
  const send: unknown = Reflect.get(query, "request");
  if (typeof send !== "function") {
    throw RequestError.internalError(
      undefined,
      "This Claude Agent SDK cannot call MCP tools for an app. Update the adapter.",
    );
  }
  const reply: unknown = await Reflect.apply(send, query, [{ subtype: "mcp_call", ...request }]);
  return reply && typeof reply === "object" ? (reply as { response?: unknown }).response : reply;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A tool result of an MCP tool: its tool call and the tool's Claude Code name. */
export type McpToolResult = { toolCallId: string; toolName: string };

/** The results in `content` of the `mcp__*` tool uses that `toolUseCache` holds. */
export function mcpToolResults(
  content: unknown,
  toolUseCache: Readonly<Record<string, { name: string }>>,
): McpToolResult[] {
  if (!Array.isArray(content)) return [];
  return content.flatMap((block: { type?: unknown; tool_use_id?: unknown }) => {
    if (block?.type !== "tool_result" || typeof block.tool_use_id !== "string") return [];
    const toolName = toolUseCache[block.tool_use_id]?.name;
    return toolName?.startsWith("mcp__") ? [{ toolCallId: block.tool_use_id, toolName }] : [];
  });
}

/**
 * The MCP Apps state of one session: the capabilities that its Claude Code
 * reported. The query is passed to each call, because a session's query can
 * be replaced (a restart, a provider change).
 */
export class McpAppsSession {
  private readonly cli = new Set<string>();

  /** `initialize` lists only some capabilities, `system/init` the rest: both add to the set. */
  constructor(initializeCapabilities?: unknown) {
    this.cliReported(initializeCapabilities);
  }

  /** The capabilities of an `initialize` response or a `system/init` message (untyped on the former). */
  cliReported(capabilities: unknown): void {
    if (!Array.isArray(capabilities)) return;
    for (const capability of capabilities) {
      if (typeof capability === "string") this.cli.add(capability);
    }
  }

  /**
   * `_meta.mcpApp` for the result of `toolName`, or undefined when the tool
   * has no `ui://` resource, Claude Code cannot report or read one, or the
   * status read fails or takes longer than {@link STATUS_TIMEOUT_MS}.
   * `toolUseResult` is the SDK user message's `tool_use_result`.
   */
  async toolCallMeta(
    query: Query,
    toolName: string,
    toolUseResult: unknown,
    signal: AbortSignal,
    logError: (message: string) => void,
  ): Promise<McpAppToolCallMeta | undefined> {
    if (!toolName.startsWith("mcp__")) return undefined;
    // Without these, tools carry no `_meta.ui`, and the client could not read the resource.
    if (!this.cli.has(TOOL_UI_META) || !this.cli.has(READ_RESOURCE)) return undefined;
    let statuses: McpServerStatus[];
    try {
      const outcome = await raceTimeoutAndAbort(query.mcpServerStatus(), STATUS_TIMEOUT_MS, signal);
      if (outcome.type !== "done") return undefined;
      statuses = outcome.value;
    } catch (error) {
      logError(`The MCP server status read for ${toolName} failed: ${errorMessage(error)}`);
      return undefined;
    }
    const match = findMcpTool(statuses, toolName);
    const resourceUri = mcpAppResourceUri(match?.tool._meta);
    if (!match || !resourceUri) return undefined;
    const toolResult = mcpCallToolResult(toolUseResult);
    const fits = toolResult && JSON.stringify(toolResult).length <= MAX_TOOL_RESULT_CHARS;
    return {
      version: MCP_APPS_VERSION,
      server: match.server,
      tool: match.tool.name,
      resourceUri,
      ...(fits ? { toolResult } : {}),
    };
  }

  /**
   * The `tool_call_update`s that add `_meta.mcpApp` to the app tools of
   * `results`, after their own reports. `toolUseResult` is the message's
   * `tool_use_result`, which describes its one tool result: a message with
   * more results gives no `toolResult`.
   */
  async toolCallUpdates(
    query: Query,
    results: readonly McpToolResult[],
    toolUseResult: unknown,
    signal: AbortSignal,
    logError: (message: string) => void,
  ): Promise<
    { sessionUpdate: "tool_call_update"; toolCallId: string; _meta: Record<string, unknown> }[]
  > {
    const updates = [];
    for (const { toolCallId, toolName } of results) {
      const meta = await this.toolCallMeta(
        query,
        toolName,
        results.length === 1 ? toolUseResult : undefined,
        signal,
        logError,
      );
      if (meta) {
        updates.push({
          sessionUpdate: "tool_call_update" as const,
          toolCallId,
          _meta: { [MCP_APP_TOOL_CALL_KEY]: meta },
        });
      }
    }
    return updates;
  }

  /** `_session/mcp/tools/list`: the tools of one connected server, with their annotations. */
  async listTools(query: Query, request: McpToolsListRequest): Promise<{ tools: McpAppTool[] }> {
    const statuses = await query.mcpServerStatus();
    const status = statuses.find((s) => s.name === request.server && s.status === "connected");
    if (!status) {
      throw RequestError.invalidParams(
        undefined,
        `No connected MCP server named ${request.server}`,
      );
    }
    return { tools: toAppTools(status.tools ?? []) };
  }

  /** `_session/mcp/resources/read`: Claude Code reads the resource from the server it dialed. */
  async readResource(
    query: Query,
    request: McpResourcesReadRequest,
  ): Promise<McpResourcesReadResponse> {
    try {
      const { contents } = await query.readMcpResource(request.server, request.uri);
      return { contents };
    } catch (error) {
      throw RequestError.internalError(
        undefined,
        `Claude Code could not read ${request.uri} from ${request.server}: ${errorMessage(error)}`,
      );
    }
  }

  /**
   * `_session/mcp/tools/call`: the tool runs on the session's own MCP
   * connection, without a model turn, and its result stays out of the
   * model's context. A tool error comes back as a result with `isError`
   * where Claude Code supports it.
   */
  async callTool(query: Query, request: McpToolsCallRequest): Promise<McpCallToolResult> {
    // Without it, Claude Code would hand back the model-shaped result, without `structuredContent`.
    if (!this.cli.has(RESULT_NOT_FOR_MODEL)) {
      throw RequestError.invalidRequest(
        undefined,
        "This Claude Code cannot call a tool for an app. Update Claude Code.",
      );
    }
    // An older Claude Code ignores `check_permissions` and runs the tool unchecked.
    if (request.checkPermissions && !this.cli.has(CHECK_PERMISSIONS)) {
      throw RequestError.invalidRequest(
        undefined,
        "This Claude Code cannot check the permissions of an app's tool call. Update Claude Code, or check the call in the client.",
      );
    }
    let reply: unknown;
    try {
      reply = await mcpCall(query, {
        tool: claudeMcpToolName(request.server, request.name),
        arguments: request.arguments ?? {},
        result_not_for_model: true,
        ...(this.cli.has(SOFT_ERROR_RESULT) ? { soft_error_result: true } : {}),
        ...(request.checkPermissions ? { check_permissions: true } : {}),
      });
    } catch (error) {
      if (error instanceof RequestError) throw error;
      throw RequestError.internalError(
        undefined,
        `Claude Code could not call ${request.name} on ${request.server}: ${errorMessage(error)}`,
      );
    }
    const result = mcpCallToolResult(reply);
    if (!result) {
      throw RequestError.internalError(
        undefined,
        `Claude Code sent no result for ${request.name} on ${request.server}`,
      );
    }
    return result;
  }
}
