/**
 * The v1 form of the v2 session setup and config requests, which the shared
 * session modules take (`sdkMcpServers`, `forkSession`, `configOptionValue`),
 * and the v2 form of the config options and commands that they build.
 */
import {
  RequestError,
  type AvailableCommand,
  type ForkSessionRequest,
  type McpServer,
  type NewSessionRequest,
  type SessionConfigOption,
  type SessionConfigSelectGroup,
  type SessionConfigSelectOptions,
  type SetSessionConfigOptionRequest,
  type SystemPrompt,
} from "@agentclientprotocol/sdk/unstable";
import * as v2 from "@agentclientprotocol/sdk/experimental/v2/unstable";
import { initialConfigOptions } from "../initial-config-options.js";
import { V2_SESSION_CAPABILITIES } from "./initialize.js";
import { v1ContentBlock } from "./prompt.js";

/**
 * Without `configOptions`: the session applies them once it started (see
 * {@link initialConfigRequests}).
 */
export function v1NewSessionRequest(params: v2.NewSessionRequest): NewSessionRequest {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { mcpServers, systemPrompt, configOptions, ...request } = params;
  // v1 requires the list; v2 treats an omitted list as an empty one.
  return {
    ...request,
    mcpServers: v1McpServers(mcpServers) ?? [],
    ...v1SystemPromptField(systemPrompt),
  };
}

/** The v1 request of a v2 `session/fork`. */
export function v1ForkSessionRequest(params: v2.ForkSessionRequest): ForkSessionRequest {
  const { mcpServers, systemPrompt, ...request } = params;
  return {
    ...request,
    ...(mcpServers ? { mcpServers: v1McpServers(mcpServers) } : {}),
    ...v1SystemPromptField(systemPrompt),
  };
}

/**
 * The v1 `systemPrompt`. Its content converts like prompt content: a v2
 * annotation audience can be any string, and v1 takes only `user` or `assistant`.
 */
function v1SystemPromptField(systemPrompt: v2.SystemPrompt | null | undefined): {
  systemPrompt?: SystemPrompt;
} {
  if (systemPrompt == null) return {};
  return { systemPrompt: { ...systemPrompt, content: systemPrompt.content.map(v1ContentBlock) } };
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

/**
 * The `configOptions` of a setup request, as the `session/set_config_option`
 * requests of `sessionId` that set them. Fails with invalid params (-32602)
 * for two entries with the same `configId`, and for an entry of a value type
 * that `session/set_config_option` does not take: any but `id` and `boolean`.
 */
export function initialConfigRequests(
  sessionId: string,
  entries: v2.InitialSessionConfigOption[] | null | undefined,
): v2.SetSessionConfigOptionRequest[] {
  return initialConfigOptions(entries).map((entry) => {
    const request = { ...entry, sessionId };
    v1SetSessionConfigOptionRequest(request);
    return request;
  });
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

/**
 * v2 tags each command with `type: "command"` and its free-text input with
 * `type: "text"`. A receiver drops a command without the `type` tag.
 */
export function v2AvailableCommands(commands: AvailableCommand[]): v2.AvailableCommand[] {
  return commands.map(({ input, ...command }) => ({
    type: "command",
    ...command,
    ...(input != null ? { input: { type: "text", ...input } } : {}),
  }));
}

/**
 * The v1 list of the MCP servers of a v2 setup request, or undefined for no
 * list. A request with two servers of the same `name`, or with a transport
 * that the agent does not advertise in `session.mcp` (such as `acp` or a
 * custom `_` type), fails with invalid params (-32602): `sdkMcpServers` would
 * otherwise drop the server without telling the client.
 */
function v1McpServers(servers: v2.McpServer[] | null | undefined): McpServer[] | undefined {
  if (servers == null) return undefined;
  v2.assertSupportedMcpServers(servers, V2_SESSION_CAPABILITIES.mcp);
  return servers.map(v1McpServer);
}

/**
 * v2 requires a `type` on every transport and makes the empty lists optional.
 * `sdkMcpServers` recognizes a v1 stdio server by its missing `type`, so the
 * v2 tag is dropped. {@link v1McpServers} has already rejected every other transport.
 */
function v1McpServer(server: v2.McpServer): McpServer {
  if (v2.McpServer.isStdio(server)) {
    const { name, command, args, env, _meta } = server;
    return { name, command, args: args ?? [], env: env ?? [], ...(_meta != null ? { _meta } : {}) };
  }
  if (v2.McpServer.isHttp(server)) {
    return { ...server, headers: server.headers ?? [] };
  }
  throw new Error(`Unreachable: MCP server of type ${server.type} passed the transport check`);
}
