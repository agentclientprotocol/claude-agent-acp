import {
  McpOverAcpCaller,
  type HasConnectionContext,
  type McpServer,
  type McpServerAcp,
} from "@agentclientprotocol/sdk/unstable";
import { McpOverAcpHttpBridge } from "@agentclientprotocol/sdk/experimental/mcp-http";
import type { McpHttpServerConfig, McpServerConfig } from "@anthropic-ai/claude-agent-sdk";

/**
 * Makes the SDK config of an MCP server that the client serves over the ACP
 * connection (`"type": "acp"`): {@link McpOverAcp.sdkConfig} for a connection.
 */
export type McpOverAcpConfig = (server: McpServerAcp) => Promise<McpHttpServerConfig>;

/**
 * A client MCP server that Claude Code is not given, so it lists no entry for
 * it. This is the entry it would list: `failed`, with the error.
 */
export type UnservedMcpServer = { name: string; status: "failed"; error: string };

/** A session's ACP MCP servers, as {@link sdkMcpServers} sorts them. */
export type SdkMcpServers = {
  /** The SDK configs of the servers that Claude Code gets, by name. */
  configs: Record<string, McpServerConfig>;
  /** The `acp` servers that `overAcp` made no config for. */
  unserved: UnservedMcpServer[];
};

/**
 * The SDK configs of a session's ACP MCP servers. HTTP and SSE servers keep
 * their URL and headers; a server without `type` is stdio; an `acp` server
 * gets the config that `overAcp` makes. When `overAcp` rejects, the server is
 * in `unserved` with the error and the session starts without it, as it
 * starts without a server that Claude Code cannot connect to. A server of any
 * other transport is left out: the session's `initialize` advertises none.
 */
export async function sdkMcpServers(
  servers: readonly McpServer[] | null | undefined,
  overAcp: McpOverAcpConfig,
): Promise<SdkMcpServers> {
  const configs: Record<string, McpServerConfig> = {};
  const unserved: UnservedMcpServer[] = [];
  for (const server of servers ?? []) {
    if ("type" in server && (server.type === "http" || server.type === "sse")) {
      configs[server.name] = {
        type: server.type,
        url: server.url,
        headers: server.headers
          ? Object.fromEntries(server.headers.map((e) => [e.name, e.value]))
          : undefined,
      };
    } else if ("type" in server && server.type === "acp") {
      try {
        configs[server.name] = await overAcp(server);
      } catch (error) {
        unserved.push({
          name: server.name,
          status: "failed",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    } else if (!("type" in server)) {
      configs[server.name] = {
        type: "stdio",
        command: server.command,
        args: server.args,
        env: server.env ? Object.fromEntries(server.env.map((e) => [e.name, e.value])) : undefined,
      };
    }
  }
  return { configs, unserved };
}

/**
 * Serves the MCP servers that a client declares with `"type": "acp"` to Claude
 * Code (MCP-over-ACP). Claude Code's MCP client connects to a command or a
 * URL, so each server gets an MCP 2026-07-28 HTTP endpoint on 127.0.0.1 that
 * sends every MCP request to the client as an `mcp/message` request (the ACP
 * SDK's `McpOverAcpHttpBridge`). The `acp` servers of a connection share one
 * listener, which closes with the connection. A request needs the bearer
 * token of its server, which only that server's config carries.
 *
 * The endpoint takes no `initialize`. Claude Code (2.1.325) sends
 * `server/discover` to an HTTP server first, unless
 * `MCP_PROTOCOL_NEGOTIATION=legacy` or its
 * `tengu_mcp_protocol_negotiation_http` flag turns that off. Then it sends
 * `initialize`, and the server is listed as failed.
 */
export class McpOverAcp {
  private readonly caller = new McpOverAcpCaller();
  private readonly bridge = new McpOverAcpHttpBridge(this.caller);

  /**
   * Hands an `mcp/message` notification of the client (such as the progress
   * of a tool call) to the HTTP response of the MCP request that it names. An
   * agent app registers it for `methods.agent.mcp.message`.
   */
  readonly handleNotification = this.caller.handleNotification;

  /**
   * The SDK config of `server` for the sessions of the connection behind
   * `client`. A server gets the same config every time for as long as the
   * connection lives, so a session that restarts or resumes with the same
   * servers sees no change. Rejects when the listener cannot open (e.g.
   * `listen EPERM` where the process may not open a socket), or the
   * connection is closed. The next call tries to open the listener again.
   */
  async sdkConfig(
    client: HasConnectionContext,
    server: McpServerAcp,
  ): Promise<McpHttpServerConfig> {
    let http;
    try {
      http = await this.bridge.toHttp(client, { ...server, type: "acp" });
    } catch (error) {
      throw new Error(
        `The adapter could not open the local endpoint that serves it to Claude Code (${
          error instanceof Error ? error.message : String(error)
        }). A new session tries again.`,
        { cause: error },
      );
    }
    return {
      type: "http",
      url: http.url,
      headers: Object.fromEntries(http.headers.map((header) => [header.name, header.value])),
    };
  }
}
