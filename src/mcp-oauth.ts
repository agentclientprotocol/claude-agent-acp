/**
 * OAuth for the MCP servers that Claude Code reports as `needs-auth`, as an
 * ACP URL elicitation. Protocol-neutral: the v1 core and the native v2 core
 * both start it once a session's setup response is sent.
 */
import { randomUUID } from "node:crypto";
import type {
  CompleteElicitationNotification,
  CreateElicitationRequest,
  CreateElicitationResponse,
} from "@agentclientprotocol/sdk/unstable";
import type { McpServerStatus, Query } from "@anthropic-ai/claude-agent-sdk";

/** Claude Code keeps the OAuth callback listener open in the background after
 *  `mcpAuthenticate` returns the authorization URL. The SDK does not expose
 *  that listener's completion promise, so watch the server status while the
 *  ACP client has the URL elicitation open. */
const MCP_OAUTH_STATUS_POLL_MS = 1_000;
const MCP_OAUTH_TIMEOUT_MS = 10 * 60_000;

/** Runtime MCP OAuth control exposed by the pinned Agent SDK. It is not yet in
 *  the public `Query` declaration, even though the method is present on the
 *  SDK query object and backed by Claude Code's `mcp_authenticate` control. */
type McpOAuthQuery = Query & {
  mcpAuthenticate(
    serverName: string,
    redirectUri?: string,
  ): Promise<{
    authUrl?: string;
    requiresUserAction: boolean;
    callbackExpected: boolean;
    redirectScheme?: "localhost" | "custom";
    callbackPort?: number;
    state?: string;
  }>;
};

export function supportsMcpOAuth(query: Query): query is McpOAuthQuery {
  return typeof (query as Partial<McpOAuthQuery>).mcpAuthenticate === "function";
}

/** What an OAuth run needs of the client connection. */
export type McpOAuthClient = {
  /** Whether the client advertised URL elicitation. Without it, OAuth does not start. */
  readonly urlElicitation: boolean;
  createElicitation(
    params: CreateElicitationRequest,
    signal: AbortSignal,
  ): Promise<CreateElicitationResponse>;
  completeElicitation(params: CompleteElicitationNotification): Promise<void>;
  readonly logger: { error: (...args: unknown[]) => void };
};

/** What an OAuth run needs of the session. */
export type McpOAuthSession = {
  /** One OAuth run at a time per key: the session object. */
  readonly key: object;
  readonly sessionId: string;
  /** The session's query now, or `undefined` once the session is gone. */
  currentQuery(): Query | undefined;
  /** Aborts when the session closes. */
  readonly closed: AbortSignal;
};

const mcpAuthentications = new WeakMap<object, Promise<void>>();

/** Start OAuth in the background for the servers in `requestedServers` that
 *  Claude reports as needing authentication. It does nothing while another
 *  OAuth run of the session is in progress. */
export function startMcpServerAuthentication(
  client: McpOAuthClient,
  session: McpOAuthSession,
  requestedServers: Set<string>,
): void {
  if (!client.urlElicitation || requestedServers.size === 0) return;
  const query = session.currentQuery();
  if (!query || mcpAuthentications.has(session.key)) return;

  const authentication = authenticateMcpServers(client, session, query, requestedServers)
    .catch((error) => {
      if (!session.closed.aborted) {
        client.logger.error(`Failed to inspect MCP servers for OAuth: ${error}`);
      }
    })
    .finally(() => {
      if (mcpAuthentications.get(session.key) === authentication) {
        mcpAuthentications.delete(session.key);
      }
    });
  mcpAuthentications.set(session.key, authentication);
}

async function authenticateMcpServers(
  client: McpOAuthClient,
  session: McpOAuthSession,
  query: Query,
  requestedServers: Set<string>,
): Promise<void> {
  if (!supportsMcpOAuth(query)) {
    client.logger.error("The Claude Agent SDK does not expose MCP OAuth authentication.");
    return;
  }

  const statuses = await query.mcpServerStatus();
  for (const status of statuses) {
    if (status.status !== "needs-auth" || !requestedServers.has(status.name)) continue;
    try {
      await authenticateMcpServer(client, session, query, status.name);
    } catch (error) {
      if (session.currentQuery() && !session.closed.aborted) {
        client.logger.error(`Failed to authenticate MCP server ${status.name}: ${error}`);
      }
    }
  }
}

/** Bridge Claude Code's startup MCP OAuth control to ACP URL elicitation.
 *  Claude opens and owns the localhost callback listener; the ACP client only
 *  needs to present the returned authorization URL. */
async function authenticateMcpServer(
  client: McpOAuthClient,
  session: McpOAuthSession,
  query: McpOAuthQuery,
  serverName: string,
): Promise<void> {
  if (!session.currentQuery()) return;

  const login = await query.mcpAuthenticate(serverName);
  if (!login.requiresUserAction) return;
  if (!login.authUrl) {
    throw new Error("Claude Code requested user action without returning an authorization URL");
  }

  const elicitationId = `mcp-oauth-${randomUUID()}`;
  const flowAbort = new AbortController();
  const abortFlow = () => flowAbort.abort(session.closed.reason);
  session.closed.addEventListener("abort", abortFlow, { once: true });
  if (session.closed.aborted) abortFlow();

  try {
    const completed = waitForMcpAuthentication(session, query, serverName, flowAbort.signal);
    const elicitation = client.createElicitation(
      {
        mode: "url",
        sessionId: session.sessionId,
        message: `Authenticate with MCP server ${serverName}`,
        url: login.authUrl,
        elicitationId,
      },
      flowAbort.signal,
    );
    const first = await Promise.race([
      completed.then((authenticated) => ({ type: "completed" as const, authenticated })),
      elicitation.then((response) => ({ type: "elicitation" as const, response })),
    ]);

    // A url-mode accept carries no content to check. The guard
    // `CreateElicitationResponse.isAccept` would also reject an accept whose
    // `content` holds a v2-only value, such as an object.
    if (first.type === "elicitation" && first.response.action !== "accept") {
      return;
    }

    if (first.type === "elicitation") {
      await completed;
    }
    try {
      await client.completeElicitation({ elicitationId });
    } catch (error) {
      if (!flowAbort.signal.aborted) {
        client.logger.error(`Failed to complete MCP OAuth elicitation: ${error}`);
      }
    }
  } finally {
    flowAbort.abort();
    session.closed.removeEventListener("abort", abortFlow);
  }
}

async function waitForMcpAuthentication(
  session: McpOAuthSession,
  query: Query,
  serverName: string,
  signal: AbortSignal,
): Promise<boolean> {
  const deadline = Date.now() + MCP_OAUTH_TIMEOUT_MS;
  while (!signal.aborted && Date.now() < deadline) {
    if (session.currentQuery() !== query) return false;

    const status: McpServerStatus | undefined = (await query.mcpServerStatus()).find(
      (server) => server.name === serverName,
    );
    if (!status || status.status === "failed" || status.status === "disabled") return false;
    if (status.status === "connected") return true;
    if (!(await waitUnlessAborted(MCP_OAUTH_STATUS_POLL_MS, signal))) return false;
  }
  return false;
}

/** Wait for a polling interval, resolving false when the session is aborted. */
export function waitUnlessAborted(milliseconds: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve(true);
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
