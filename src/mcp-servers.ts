import {
  isMcpServerAcp,
  McpOverAcpCaller,
  type HasConnectionContext,
  type McpServer,
  type McpServerAcp,
  type ToolCallStatus,
} from "@agentclientprotocol/sdk/unstable";
import {
  McpOverAcpHttpBridge,
  type McpHttpRequestAttribution,
  type McpHttpRequestInfo,
} from "@agentclientprotocol/sdk/experimental/mcp-http";
import type {
  HookCallbackMatcher,
  McpHttpServerConfig,
  McpServerConfig,
} from "@anthropic-ai/claude-agent-sdk";
import { AnnouncedChildren } from "./acp-subagents.js";
import { isFinalToolCallStatus } from "./tool-calls/renderer.js";

/**
 * Where Claude Code's MCP client (2.1.330) puts the id of the tool use in the
 * `params._meta` of the `tools/call` that it sends for it. Its other requests,
 * such as `server/discover` and `tools/list`, have none.
 */
const TOOL_USE_ID_META = "claudecode/toolUseId";

/**
 * The `agent_type` in the hooks of an agent that a workflow runs (Claude Code
 * 2.1.330). Such an agent gets no `task_started` and never a child session,
 * and its tool uses do not stream: the root session shows its work on the
 * Workflow call. A user can give an agent definition the same name: its
 * agents are ordinary subagents.
 */
const WORKFLOW_AGENT_TYPE = "workflow-subagent";

/**
 * The hook matcher of the tools of the MCP servers `names`. Claude Code
 * (2.1.330) matches it against the whole name of a tool, which is
 * `mcp__<server>__<tool>` with `_` for each character of the server's name
 * outside `[A-Za-z0-9_-]`: `mcp__my_tools__echo` for the server `my tools`.
 */
function mcpToolsMatcher(names: readonly string[]): string {
  const servers = names.map((name) => name.replace(/[^A-Za-z0-9_-]+/g, "_+"));
  return `mcp__(?:${servers.join("|")})__.*`;
}

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
 *
 * An `mcp/message` request names the ACP session and the tool call that it is
 * sent for (`sessionId` and `toolCallId`), when the adapter knows them. An
 * HTTP request does not say them. It carries the id of its tool use (see
 * {@link TOOL_USE_ID_META}), and the adapter learns each tool use of an `acp`
 * server's tool from a PreToolUse hook, before Claude Code runs the tool
 * ({@link toolUseHooks}). Both cores report a tool call under the id of its
 * tool use, so that id is the `toolCallId`.
 *
 * When a `session/update` reported a tool call of that id ({@link sending}),
 * the request names the session of that report, and the tool call. Before
 * the report, and without one, it names by the agent that runs the tool:
 *
 * - the main conversation: the root session, and the tool call;
 * - a subagent with an announced child session: that session, and the tool
 *   call;
 * - a subagent of a client without child sessions: the root session, which
 *   reports the subagent's tool calls, and the tool call;
 * - an agent that never gets a child session: the root session, whose work
 *   it does, and no tool call, since no session reports one. These are an
 *   agent that a workflow runs, and any agent of a client without child
 *   sessions that the core does not know as a subagent;
 * - any other agent: nothing. Its child session is not announced yet, or its
 *   core does not know it. The root session never stands in for a child
 *   session.
 *
 * A request names neither when one of these holds:
 *
 * - it has no tool use id, as `server/discover` and `tools/list` have none;
 * - no PreToolUse hook reported its tool use, as for a server that a resume
 *   gave the session's running query ({@link sessionServersChanged}), or the
 *   tool use ended;
 * - the client closed the root session, or its last setup request did not
 *   declare the request's server;
 * - the session of the agent is a child session that no `subagent_update`
 *   announced to the client, such as one of AIR's draft;
 * - the agent has the type of a workflow's agents, the client gets child
 *   sessions, and the session defines an agent of that name: the agent can
 *   be a subagent whose child session is not announced yet.
 *
 * Nothing orders the tool call's report before the request. Claude Code
 * streams a tool use before it runs the tool, but the session can read its
 * stream after the HTTP request arrives. The request then names a tool call
 * that the client does not hold yet.
 */
export class McpOverAcp {
  private readonly caller = new McpOverAcpCaller();
  private readonly bridge = new McpOverAcpHttpBridge(this.caller, {
    attribution: (request) => this.attribution(request),
  });
  /** The `acp` servers of each active session that has any, or whose query started with any. */
  private readonly sessions = new Map<string, SessionServers>();
  /** The child sessions that a `subagent_update` announced to the client (see {@link sending}). */
  private readonly children = new AnnouncedChildren();
  /** The tool uses of `acp` servers' tools that Claude Code runs, by id (see {@link toolUseHooks}). */
  private readonly toolUses = new Map<string, ToolUse>();
  /**
   * The session of each tool call that the client holds without a final
   * status, by tool call id (see {@link sending}).
   */
  private readonly toolCalls = new Map<string, string>();

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

  /**
   * A setup request (`session/new`, `load`, `resume` or `fork`) made the
   * session `sessionId` active with `servers`, on a query that started with
   * the hooks of {@link toolUseHooks} for them.
   */
  sessionStarted(sessionId: string, servers: readonly McpServer[] | null | undefined): void {
    const acp = (servers ?? []).filter(isMcpServerAcp);
    if (acp.length === 0) {
      this.sessions.delete(sessionId);
      return;
    }
    this.sessions.set(sessionId, {
      declared: new Set(acp.map((server) => server.serverId)),
      hooked: new Set(acp.map((server) => server.name)),
    });
  }

  /**
   * A setup request gave the active session `sessionId` the servers
   * `servers` in place of its earlier ones, on its running query. Returns
   * the names of the `acp` servers among them that the query did not start
   * with. Its hooks cannot change, so no hook reports the tool uses of these
   * servers, and their requests name no session until the session's next
   * query starts.
   */
  sessionServersChanged(
    sessionId: string,
    servers: readonly McpServer[] | null | undefined,
  ): string[] {
    const acp = (servers ?? []).filter(isMcpServerAcp);
    const hooked = this.sessions.get(sessionId)?.hooked ?? new Set<string>();
    if (acp.length === 0 && hooked.size === 0) this.sessions.delete(sessionId);
    else {
      this.sessions.set(sessionId, {
        declared: new Set(acp.map((server) => server.serverId)),
        hooked,
      });
    }
    return acp.flatMap((server) => (hooked.has(server.name) ? [] : [server.name]));
  }

  /**
   * The client ended the session `sessionId` (`session/close`, or a request
   * that closes it too, such as `session/delete`): its requests and those of
   * its child sessions name no session from now on. Forgets its servers, its
   * announced children, its tool uses and its tool calls.
   */
  sessionClosed(sessionId: string): void {
    for (const [toolUseId, toolUse] of this.toolUses) {
      if (toolUse.rootSessionId === sessionId) this.toolUses.delete(toolUseId);
    }
    for (const [toolCallId, session] of this.toolCalls) {
      if (this.rootOf(session) === sessionId) this.toolCalls.delete(toolCallId);
    }
    this.children.rootClosed(sessionId);
    this.sessions.delete(sessionId);
  }

  /**
   * Takes a session update that goes to the client. A `subagent_update`
   * announces a child session. A `tool_call`, or a `tool_call_update` with a
   * status, reports a tool call of its session, which is kept until an update
   * of that session or of another one under the same root gives the tool call
   * a final status. That update also ends the tool use of the same id.
   *
   * Only the tool calls of an active session with `acp` servers
   * ({@link sessionStarted}) and of its announced child sessions are kept. The
   * tool calls of a child session of AIR's draft, which a `subagent_spawned`
   * announces, are not.
   */
  sending(notification: SentUpdate): void {
    this.children.sending(notification);
    const { sessionId, update } = notification;
    const { sessionUpdate, toolCallId, status } = update;
    if (sessionUpdate !== "tool_call" && sessionUpdate !== "tool_call_update") return;
    if (typeof toolCallId !== "string") return;
    const root = this.rootOf(sessionId);
    if (isFinalToolCallStatus(status as ToolCallStatus | null | undefined)) {
      this.toolEnded(toolCallId, root);
    } else if ((sessionUpdate === "tool_call" || status != null) && this.sessions.has(root)) {
      this.toolCalls.set(toolCallId, sessionId);
    }
  }

  /**
   * The hooks of the query of the root session `sessionId`, which starts with
   * `servers`, or undefined when none of them is an `acp` server: such a
   * query has no MCP request to name a session for. They record each tool
   * use of a tool of the `acp` servers before Claude Code runs it
   * (PreToolUse), with the session of the agent that runs it (see the class
   * doc), until the tool returned or failed (PostToolUse,
   * PostToolUseFailure). Claude Code runs them for no other tool, and they
   * make no decision.
   *
   * A tool use that neither hook ends, such as one that Claude Code does not
   * run after all, stays until its tool call gets a final status
   * ({@link sending}) or the client closes the session
   * ({@link sessionClosed}).
   */
  toolUseHooks(
    sessionId: string,
    servers: readonly McpServer[] | null | undefined,
    agents: SessionAgents,
  ): Record<"PreToolUse" | "PostToolUse" | "PostToolUseFailure", HookCallbackMatcher> | undefined {
    const acp = (servers ?? []).filter(isMcpServerAcp);
    if (acp.length === 0) return undefined;
    const matcher = mcpToolsMatcher(acp.map((server) => server.name));
    const starts: HookCallbackMatcher = {
      matcher,
      hooks: [
        async (input, toolUseId) => {
          if (toolUseId !== undefined) {
            this.toolUses.set(toolUseId, {
              rootSessionId: sessionId,
              ...agentSession(sessionId, input, agents),
            });
          }
          return { continue: true };
        },
      ],
    };
    const ends: HookCallbackMatcher = {
      matcher,
      hooks: [
        async (_input, toolUseId) => {
          if (toolUseId !== undefined) this.toolEnded(toolUseId, sessionId);
          return { continue: true };
        },
      ],
    };
    return { PreToolUse: starts, PostToolUse: ends, PostToolUseFailure: ends };
  }

  /** The root session of the announced child session `sessionId`, or `sessionId` itself. */
  private rootOf(sessionId: string): string {
    return this.children.rootOf(sessionId) ?? sessionId;
  }

  /**
   * Forgets the tool use `id` and its tool call, when they are of the root
   * session `root`. A fork replays the tool calls of its original under their
   * ids: its updates leave those of the original alone.
   */
  private toolEnded(id: string, root: string): void {
    if (this.toolUses.get(id)?.rootSessionId === root) this.toolUses.delete(id);
    const reportedIn = this.toolCalls.get(id);
    if (reportedIn !== undefined && this.rootOf(reportedIn) === root) this.toolCalls.delete(id);
  }

  /**
   * The session and tool call that the `mcp/message` request of the MCP
   * request `request` names, or undefined when it names none (see the class
   * doc). It does not throw: the bridge would answer Claude Code with HTTP
   * 500 instead of sending the request.
   */
  private attribution({
    serverId,
    params,
  }: McpHttpRequestInfo): McpHttpRequestAttribution | undefined {
    const meta = params?._meta;
    const toolUseId =
      typeof meta === "object" && meta !== null
        ? (meta as Record<string, unknown>)[TOOL_USE_ID_META]
        : undefined;
    if (typeof toolUseId !== "string") return undefined;
    const toolUse = this.toolUses.get(toolUseId);
    if (!toolUse) return undefined;
    const root = toolUse.rootSessionId;
    if (!this.sessions.get(root)?.declared.has(serverId)) return undefined;
    // The session that reported the tool call names it. A tool call of
    // another root has the same id in a fork's replayed history.
    const reportedIn = this.toolCalls.get(toolUseId);
    if (reportedIn !== undefined && this.rootOf(reportedIn) === root) {
      return { sessionId: reportedIn, toolCallId: toolUseId };
    }
    const { sessionId } = toolUse;
    // Not the root, and no announced child of it: an unannounced child session.
    if (sessionId === undefined || this.rootOf(sessionId) !== root) return undefined;
    return toolUse.reportsToolCall ? { sessionId, toolCallId: toolUseId } : { sessionId };
  }
}

/**
 * What {@link McpOverAcp.toolUseHooks} asks the core of a session about the
 * agents of its query.
 */
export type SessionAgents = {
  /**
   * Whether the client gets a child session per subagent. Without child
   * sessions, the root session's updates carry the work of every agent.
   */
  childSessions: boolean;
  /**
   * The session whose updates report the tool calls of the subagent `agentId`
   * as the core routes them now: its announced child session, or the root
   * session for a client without child sessions. Undefined for an agent that
   * the core does not know as a subagent (it has not read its
   * `task_started`, which an agent that a workflow runs never gets), and for
   * one whose child session is not announced.
   */
  reporting(agentId: string): string | undefined;
  /** Whether the session had an agent definition of the name `name` when its query started. */
  definesAgent(name: string): boolean;
};

/**
 * The session of the agent that runs the tool use of the PreToolUse hook
 * `input`, for a query of the root session `root`, and whether that session
 * reports the tool use as a tool call (see the class doc of
 * {@link McpOverAcp}).
 */
function agentSession(
  root: string,
  input: { agent_id?: string; agent_type?: string },
  agents: SessionAgents,
): Pick<ToolUse, "sessionId" | "reportsToolCall"> {
  // A session reports the tool calls of the messages that it reads, but for
  // the work that a cancel stopped: it drops that work's tool uses, and its
  // tool can run all the same. Nothing tells that at this point, so the
  // request of such a tool use names a tool call that the client never gets.
  if (input.agent_id === undefined) return { sessionId: root, reportsToolCall: true };
  const reporting = agents.reporting(input.agent_id);
  if (reporting !== undefined) return { sessionId: reporting, reportsToolCall: true };
  // No session reports the tool calls of this agent. Its work is the root's
  // when it cannot be a child session: the client gets none, or a workflow
  // runs it. An agent definition of the workflow agents' type makes that
  // type say nothing: its agent can be a child that is not announced yet.
  const rootWork =
    !agents.childSessions ||
    (input.agent_type === WORKFLOW_AGENT_TYPE && !agents.definesAgent(WORKFLOW_AGENT_TYPE));
  return { sessionId: rootWork ? root : undefined, reportsToolCall: false };
}

/** The `acp` servers of an active session. */
type SessionServers = {
  /** The `serverId`s of the session's last setup request. */
  declared: ReadonlySet<string>;
  /** The names of the ones that its query started with, whose tool uses its hooks report. */
  hooked: ReadonlySet<string>;
};

/** A tool use that Claude Code runs. */
type ToolUse = {
  /** The root session whose query runs it. */
  rootSessionId: string;
  /** The session of the agent that runs it, when it has one that a request can name. */
  sessionId: string | undefined;
  /** Whether that session reports it as a tool call, under its id. */
  reportsToolCall: boolean;
};

/** A session update that goes to the client, as far as {@link McpOverAcp.sending} reads it. */
type SentUpdate = {
  sessionId: string;
  update: { sessionUpdate: string; sessionId?: unknown; toolCallId?: unknown; status?: unknown };
};
