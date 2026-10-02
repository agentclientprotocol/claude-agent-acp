/**
 * The ACP v2 session lifecycle, expressed through the v1 session methods of
 * `ClaudeAcpAgent`: v2 requests become the v1 requests that the agent serves,
 * and its v1 responses become v2 responses.
 */
import {
  RequestError,
  type AvailableCommand,
  type LoadSessionRequest,
  type McpServer,
  type NewSessionRequest,
  type NewSessionResponse,
  type ResumeSessionRequest,
  type ResumeSessionResponse,
  type SessionConfigOption,
  type SessionConfigSelectGroup,
  type SessionConfigSelectOptions,
  type SetSessionConfigOptionRequest,
} from "@agentclientprotocol/sdk";
import * as v2 from "@agentclientprotocol/sdk/experimental/v2";

export function v1NewSessionRequest(params: v2.NewSessionRequest): NewSessionRequest {
  const { mcpServers, ...request } = params;
  // v1 requires the list; v2 treats an omitted list as an empty one.
  return { ...request, mcpServers: (mcpServers ?? []).map(v1McpServer) };
}

/**
 * The v1 request that a v2 `session/resume` means.
 *
 * v2 restores a session with `session/resume` and replays its history only
 * when `replayFrom` asks for it. v1 has two methods: `session/resume`, which
 * never replays, and `session/load`, which replays the whole history before it
 * responds. `replayFrom: { type: "start" }` is the second; a cursor that
 * starts elsewhere is rejected.
 */
export function v1RestoreSessionRequest(
  params: v2.ResumeSessionRequest,
):
  | { method: "resume"; request: ResumeSessionRequest }
  | { method: "load"; request: LoadSessionRequest } {
  const { replayFrom, mcpServers, ...request } = params;
  if (replayFrom == null) {
    return {
      method: "resume",
      request: { ...request, ...(mcpServers ? { mcpServers: mcpServers.map(v1McpServer) } : {}) },
    };
  }
  if (replayFrom.type !== "start") {
    throw RequestError.invalidParams(
      { replayFrom },
      `Replaying from a ${replayFrom.type} cursor is not supported`,
    );
  }
  return {
    method: "load",
    request: { ...request, mcpServers: (mcpServers ?? []).map(v1McpServer) },
  };
}

/** v2 drops `modes`: the session mode is the `mode` config option, which the agent always lists. */
export function v2NewSessionResponse(response: NewSessionResponse): v2.NewSessionResponse {
  return { sessionId: response.sessionId, ...v2ResumeSessionResponse(response) };
}

export function v2ResumeSessionResponse(response: ResumeSessionResponse): v2.ResumeSessionResponse {
  return {
    ...v2ConfigOptionsField(response.configOptions),
    ...(response._meta != null ? { _meta: response._meta } : {}),
  };
}

/** v2 tags a select value with `type: "id"`; v1 leaves it untagged. */
export function v1SetSessionConfigOptionRequest(
  params: v2.SetSessionConfigOptionRequest,
): SetSessionConfigOptionRequest {
  const request = {
    sessionId: params.sessionId,
    configId: params.configId,
    ...(params._meta != null ? { _meta: params._meta } : {}),
  };
  if (v2.SetSessionConfigOptionRequest.isId(params)) {
    return { ...request, value: params.value };
  }
  if (v2.SetSessionConfigOptionRequest.isBoolean(params)) {
    return { ...request, type: "boolean", value: params.value };
  }
  throw RequestError.invalidParams(
    { type: params.type },
    `Config option values of type ${params.type} are not supported`,
  );
}

/** v2 names the id of an option `configId` and the id of a select group `groupId`. */
export function v2ConfigOptions(options: SessionConfigOption[]): v2.SessionConfigOption[] {
  return options.map((option) => {
    const { id, ...rest } = option;
    if (rest.type === "select") {
      return { ...rest, configId: id, options: v2SelectOptions(rest.options) };
    }
    return { ...rest, configId: id };
  });
}

function v2SelectOptions(options: SessionConfigSelectOptions): v2.SessionConfigSelectOptions {
  if (!isGrouped(options)) return options;
  return options.map(({ group, ...selectGroup }) => ({ ...selectGroup, groupId: group }));
}

function isGrouped(options: SessionConfigSelectOptions): options is SessionConfigSelectGroup[] {
  return options.some((entry) => "group" in entry);
}

/** v2 tags the free-text input of a command with `type: "text"`. */
export function v2AvailableCommands(commands: AvailableCommand[]): v2.AvailableCommand[] {
  return commands.map(({ input, ...command }) => ({
    ...command,
    ...(input != null ? { input: { type: "text", ...input } } : {}),
  }));
}

/** v1 responses may send `null`; v2 omits the field instead. */
function v2ConfigOptionsField(options: SessionConfigOption[] | null | undefined): {
  configOptions?: v2.SessionConfigOption[];
} {
  return options != null ? { configOptions: v2ConfigOptions(options) } : {};
}

/**
 * v2 requires a `type` on every transport and makes the empty lists optional.
 * The agent recognizes a v1 stdio server by its missing `type`, so the v2 tag
 * is dropped. A transport that v1 cannot express is rejected rather than
 * silently left out of the session.
 */
function v1McpServer(server: v2.McpServer): McpServer {
  if (v2.McpServer.isStdio(server)) {
    const { name, command, args, env, _meta } = server;
    return { name, command, args: args ?? [], env: env ?? [], ...(_meta != null ? { _meta } : {}) };
  }
  if (v2.McpServer.isHttp(server)) {
    return { ...server, headers: server.headers ?? [] };
  }
  if (v2.McpServer.isAcp(server)) {
    return server;
  }
  throw RequestError.invalidParams(
    { type: server.type },
    `MCP servers of type ${server.type} are not supported`,
  );
}
