import { RequestError, type McpServer } from "@agentclientprotocol/sdk";
import type { McpServerConfig, Query } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

export const SESSION_MCP_SET_METHOD = "_session/mcp/set";
export const SESSION_MCP_STATE_METHOD = "_session/mcp/state";
const name = z
  .string()
  .min(1)
  .max(256)
  .refine(
    (value) =>
      value.trim().length > 0 &&
      !["__proto__", "prototype", "constructor"].includes(value) &&
      !Array.from(value).some((char) => char.charCodeAt(0) < 32),
  );
const pair = z.object({ name, value: z.string().max(16384) }).strict();
const pairs = z
  .array(pair)
  .max(128)
  .refine((values) => new Set(values.map((v) => v.name)).size === values.length);
const remote = z
  .object({
    name,
    type: z.enum(["http", "sse"]),
    url: z
      .string()
      .max(16384)
      .url()
      .refine((value) => ["https:", "http:"].includes(new URL(value).protocol)),
    headers: pairs,
  })
  .strict();
const stdio = z
  .object({
    name,
    command: z.string().min(1).max(4096),
    args: z.array(z.string().max(16384)).max(256),
    env: pairs,
  })
  .strict();
const server = z.union([remote, stdio]);
const request = z
  .object({
    sessionId: name,
    expectedRevision: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER - 1),
    mcpServers: z
      .array(server)
      .max(128)
      .refine((servers) => new Set(servers.map((s) => s.name)).size === servers.length),
  })
  .strict();
export type SessionMcpSetRequest = z.infer<typeof request>;
export function parseSessionMcpSetRequest(value: unknown): SessionMcpSetRequest {
  const parsed = request.safeParse(value);
  // Do not put credentials, commands or headers into JSON-RPC error data.
  if (!parsed.success)
    throw RequestError.invalidParams(undefined, "Invalid MCP replacement request");
  return parsed.data;
}
export function parseSessionMcpStateRequest(value: unknown): { sessionId: string } {
  const parsed = z.object({ sessionId: name }).strict().safeParse(value);
  if (!parsed.success) throw RequestError.invalidParams(undefined, "Invalid MCP state request");
  return parsed.data;
}
export function sessionMcpCapability() {
  return {
    version: 1,
    setMethod: SESSION_MCP_SET_METHOD,
    stateMethod: SESSION_MCP_STATE_METHOD,
    scope: "acpServers",
    replacesSettingsServers: false,
    replacesPluginServers: false,
  };
}
export type SessionMcpState = {
  revision: number;
  hostServers: McpServer[];
  protectedServers: Record<string, McpServerConfig>;
  uncertain?: boolean;
};
export function sessionMcpState(state: SessionMcpState) {
  return {
    version: 1,
    revision: state.revision,
    uncertain: state.uncertain === true,
    servers: state.hostServers.map((s) => ({ name: s.name, type: "type" in s ? s.type : "stdio" })),
  };
}
export function toSdkMcpServers(servers: McpServer[]): Record<string, McpServerConfig> {
  return Object.fromEntries(
    servers.map((s): [string, McpServerConfig] => {
      if ("type" in s) {
        if (s.type === "acp") {
          throw RequestError.invalidParams(undefined, "ACP MCP transport is not supported");
        }
        return [
          s.name,
          {
            type: s.type,
            url: s.url,
            headers: Object.fromEntries(s.headers.map((h) => [h.name, h.value])),
          },
        ];
      }
      return [
        s.name,
        {
          type: "stdio",
          command: s.command,
          args: s.args,
          env: Object.fromEntries(s.env.map((e) => [e.name, e.value])),
        },
      ];
    }),
  );
}

/** The integrator holds its exclusive session reservation. The protected map
 * is the actual non-ACP SDK configuration from query creation, including any
 * in-process servers. It must never be reconstructed from untrusted names. */
export async function setSessionMcpServers(
  query: Pick<Query, "setMcpServers" | "mcpServerStatus">,
  state: SessionMcpState,
  value: SessionMcpSetRequest,
  boundSessionId: string,
  invalidate: () => void,
  isCurrent: () => boolean = () => true,
) {
  const params = parseSessionMcpSetRequest(value);
  if (params.sessionId !== boundSessionId)
    throw RequestError.invalidParams(undefined, "Session mismatch");
  if (state.uncertain)
    throw RequestError.invalidRequest(undefined, "MCP outcome is uncertain; reload the session");
  if (params.expectedRevision !== state.revision)
    throw RequestError.invalidParams({ revision: state.revision }, "MCP revision changed");
  if (typeof query.setMcpServers !== "function")
    return { version: 1, status: "unsupported" as const };
  const previousNames = new Set(state.hostServers.map((s) => s.name));
  const statuses = await query.mcpServerStatus();
  if (!isCurrent())
    throw RequestError.invalidRequest(undefined, "Session changed; reload required");
  const foreign = new Set(
    statuses
      .filter((s) => !previousNames.has(s.name) || s.source === "plugin" || s.source === "settings")
      .map((s) => s.name),
  );
  if (
    params.mcpServers.some(
      (s) => Object.hasOwn(state.protectedServers, s.name) || foreign.has(s.name),
    )
  ) {
    throw RequestError.invalidParams(
      undefined,
      "Cannot replace an SDK, plugin or settings-owned MCP server",
    );
  }
  try {
    const result = await query.setMcpServers({
      ...state.protectedServers,
      ...toSdkMcpServers(params.mcpServers),
    });
    if (!isCurrent()) throw new Error("Session changed during MCP replacement");
    // Errors can coexist with removals and successful additions. The requested
    // configuration is committed, and the client gets partial rather than an
    // error that would falsely imply no mutation occurred.
    state.hostServers = params.mcpServers;
    state.revision++;
    const failedServers = Object.keys(result.errors);
    return {
      version: 1,
      status: failedServers.length ? ("partial" as const) : ("ok" as const),
      revision: state.revision,
      added: result.added,
      removed: result.removed,
      failedServers,
    };
  } catch {
    state.uncertain = true;
    invalidate();
    throw RequestError.internalError(
      undefined,
      "MCP replacement outcome is uncertain; reload before retrying",
    );
  }
}
