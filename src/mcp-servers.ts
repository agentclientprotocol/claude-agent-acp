import type { McpServer } from "@agentclientprotocol/sdk/unstable";
import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";

/**
 * The SDK configs of a session's ACP MCP servers, by name. HTTP and SSE
 * servers keep their URL and headers; a server without `type` is stdio. A
 * server of any other transport is left out: the session's `initialize`
 * advertises none.
 */
export function sdkMcpServers(
  servers: readonly McpServer[] | null | undefined,
): Record<string, McpServerConfig> {
  const configs: Record<string, McpServerConfig> = {};
  for (const server of servers ?? []) {
    if ("type" in server && (server.type === "http" || server.type === "sse")) {
      configs[server.name] = {
        type: server.type,
        url: server.url,
        headers: server.headers
          ? Object.fromEntries(server.headers.map((e) => [e.name, e.value]))
          : undefined,
      };
    } else if (!("type" in server)) {
      configs[server.name] = {
        type: "stdio",
        command: server.command,
        args: server.args,
        env: server.env ? Object.fromEntries(server.env.map((e) => [e.name, e.value])) : undefined,
      };
    }
  }
  return configs;
}
