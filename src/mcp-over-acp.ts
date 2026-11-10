/**
 * MCP servers that the ACP client provides over the ACP connection
 * (`"type": "acp"` in a session's `mcpServers`).
 *
 * Claude Code reaches each one as an in-process SDK MCP server. Claude Code
 * speaks the MCP handshake of 2025 (`initialize`, then requests on one
 * connection), and `mcp/message` carries MCP 2026-07-28 only, which has no
 * handshake. So {@link AcpMcpServer} answers `initialize` and `ping` itself and
 * sends every other request to the client as its own `mcp/message` request.
 */
import {
  McpOverAcpCaller,
  RequestError,
  type HasConnectionContext,
  type McpNotification,
  type McpOutcome,
  type McpServer,
  type McpServerAcpDeclaration,
} from "@agentclientprotocol/sdk/unstable";
import type { McpSdkServerConfigWithInstance, Settings } from "@anthropic-ai/claude-agent-sdk";
import packageJson from "../package.json" with { type: "json" };

/** Sends one MCP request to a server that the client declared with `"type": "acp"`. */
export type McpOverAcpRequest = (
  serverId: string,
  method: string,
  params: Record<string, unknown> | undefined,
  options: { signal: AbortSignal; onNotification: (notification: McpNotification) => void },
) => Promise<McpOutcome>;

/**
 * The caller of every connection. It keeps its in-flight requests per
 * connection. Each agent app registers {@link McpOverAcpCaller.handleNotification}
 * for `mcp/message` notifications, so progress reaches the request it belongs to.
 */
export const mcpOverAcpCaller = new McpOverAcpCaller({
  clientInfo: { name: packageJson.name, version: packageJson.version },
});

/** The {@link McpOverAcpRequest} of the connection behind `context`. */
export function mcpOverAcpRequest(context: HasConnectionContext): McpOverAcpRequest {
  return (serverId, method, params, options) =>
    mcpOverAcpCaller.request(context, serverId, method, params, options);
}

/** Whether `server` is provided by the client over the ACP connection. */
export function isAcpMcpServer(server: McpServer): server is McpServer & McpServerAcpDeclaration {
  return "type" in server && server.type === "acp";
}

/** The Claude Agent SDK configuration that serves `server` through `request`. */
export function acpMcpServerConfig(
  server: McpServerAcpDeclaration,
  request: McpOverAcpRequest,
): McpSdkServerConfigWithInstance {
  return {
    type: "sdk",
    name: server.name,
    // The SDK only calls `connect` on the instance, with the transport that
    // carries Claude Code's JSON-RPC messages. A real `McpServer` fixes its
    // capabilities when it is constructed; this one reads them from the
    // client's server on each `initialize`.
    instance: new AcpMcpServer(
      server,
      request,
    ) as unknown as McpSdkServerConfigWithInstance["instance"],
  };
}

/**
 * `settings` with the servers of `servers` that the client provides over ACP
 * preferred to a server of the same name from the user's Claude Code
 * configuration (`~/.claude.json`, `.mcp.json`, a plugin), or `settings`
 * unchanged when there is none.
 *
 * Claude Code connects the configured server when an in-process SDK server
 * has the same name, and the client's server never starts. (An `http` or
 * `stdio` server from the client already wins such a clash.) Denying the
 * name blocks the configured server only: `deniedMcpServers` does not apply
 * to in-process SDK servers.
 */
export function preferAcpMcpServers(
  settings: Settings | undefined,
  servers: readonly McpServer[],
): Settings | undefined {
  const denied = servers.filter(isAcpMcpServer).map((server) => ({ serverName: server.name }));
  if (denied.length === 0) return settings;
  return { ...settings, deniedMcpServers: [...(settings?.deniedMcpServers ?? []), ...denied] };
}

type JsonRpcId = string | number;

type JsonRpcMessage = {
  jsonrpc: "2.0";
  id?: JsonRpcId | null;
  method?: string;
  params?: Record<string, unknown>;
};

/** The part of the SDK's in-process MCP transport that {@link AcpMcpServer} uses. */
type SdkMcpTransport = {
  onmessage?: (message: JsonRpcMessage) => void;
  onclose?: () => void;
  send(message: Record<string, unknown>): Promise<void>;
};

/** JSON-RPC "Internal error": the request did not produce an MCP outcome. */
const INTERNAL_ERROR = -32603;

/**
 * The capabilities to report when the client's server does not answer
 * `server/discover`, for example an MCP server from before 2026-07-28 that
 * the client forwards to. Tools are what every such server is declared for.
 */
const FALLBACK_CAPABILITIES = { tools: {} };

class AcpMcpServer {
  /** The requests Claude Code is waiting on, by JSON-RPC id. */
  private readonly active = new Map<JsonRpcId, AbortController>();

  constructor(
    private readonly server: McpServerAcpDeclaration,
    private readonly request: McpOverAcpRequest,
  ) {}

  async connect(transport: SdkMcpTransport): Promise<void> {
    transport.onmessage = (message) => {
      if (message.method === undefined) return;
      if (message.id === undefined || message.id === null) {
        this.notified(message.method, message.params);
        return;
      }
      const id = message.id;
      void this.respond(id, message.method, message.params, transport).then((response) =>
        // The transport rejects once the session's query has closed. No one
        // waits for the answer then.
        transport.send({ jsonrpc: "2.0", id, ...response }).catch(() => {}),
      );
    };
    transport.onclose = () => {
      for (const controller of this.active.values()) controller.abort();
      this.active.clear();
    };
  }

  private notified(method: string, params: Record<string, unknown> | undefined): void {
    if (method !== "notifications/cancelled") return;
    const id = params?.requestId;
    if (typeof id === "string" || typeof id === "number") this.active.get(id)?.abort();
  }

  private async respond(
    id: JsonRpcId,
    method: string,
    params: Record<string, unknown> | undefined,
    transport: SdkMcpTransport,
  ): Promise<{ result: unknown } | { error: unknown }> {
    if (method === "ping") return { result: {} };
    if (method === "initialize") return { result: await this.initialize(params) };

    const controller = new AbortController();
    this.active.set(id, controller);
    try {
      const outcome = await this.request(this.server.serverId, method, params, {
        signal: controller.signal,
        // The notifications of a request (`notifications/progress`) carry
        // the token Claude Code sent in the request's `_meta`.
        onNotification: ({ method, params }) => {
          void transport
            .send({ jsonrpc: "2.0", method, ...(params ? { params } : {}) })
            .catch(() => {});
        },
      });
      if ("error" in outcome) return { error: outcome.error };
      if (isInputRequired(outcome.result)) {
        return {
          error: {
            code: INTERNAL_ERROR,
            message: `MCP server "${this.server.name}" asked for more input to finish ${method}, which Claude Code can't provide. Try again with the input in the request.`,
          },
        };
      }
      return { result: outcome.result };
    } catch (error) {
      return {
        error: {
          code: error instanceof RequestError ? error.code : INTERNAL_ERROR,
          message: `MCP server "${this.server.name}" could not be reached through the ACP client: ${error instanceof Error ? error.message : String(error)}`,
        },
      };
    } finally {
      this.active.delete(id);
    }
  }

  /**
   * The `initialize` result, from the server's `server/discover`. MCP
   * 2026-07-28 has no `initialize`, so this request never reaches the client.
   */
  private async initialize(params: Record<string, unknown> | undefined): Promise<unknown> {
    const discovered = await this.discover();
    return {
      protocolVersion: params?.protocolVersion,
      capabilities: isRecord(discovered?.capabilities)
        ? discovered.capabilities
        : FALLBACK_CAPABILITIES,
      serverInfo: isRecord(discovered?.serverInfo)
        ? discovered.serverInfo
        : { name: this.server.name, version: "unknown" },
      ...(typeof discovered?.instructions === "string"
        ? { instructions: discovered.instructions }
        : {}),
    };
  }

  private async discover(): Promise<Record<string, unknown> | undefined> {
    try {
      const outcome = await this.request(this.server.serverId, "server/discover", undefined, {
        signal: new AbortController().signal,
        onNotification: () => {},
      });
      return "result" in outcome && isRecord(outcome.result) ? outcome.result : undefined;
    } catch {
      return undefined;
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Whether an MCP 2026-07-28 result asks the caller to repeat the request with more input. */
function isInputRequired(result: unknown): boolean {
  return isRecord(result) && result.resultType === "input_required";
}
