import { afterEach, describe, expect, it, vi } from "vitest";
import * as acp from "@agentclientprotocol/sdk/unstable";
import {
  McpOverAcp,
  mcpServerNames,
  refusedMcpServers,
  sdkMcpServers,
  startAroundRefusedMcpServers,
} from "../mcp-servers.js";
import { startupFailureError } from "../startup-failure.js";
import {
  claudeCodeMcpRequest,
  mcpRefusalMessage,
  runMcpToolHooks,
  sideloadRefusal,
  startupFailure,
} from "./helpers.js";

describe("sdkMcpServers", () => {
  it("maps each transport to its SDK config, and leaves out an unknown one", async () => {
    const overAcp = { type: "http" as const, url: "http://127.0.0.1:1/mcp-tools" };
    const servers = [
      { name: "files", command: "/bin/files", args: ["--stdio"], env: [{ name: "A", value: "1" }] },
      {
        type: "http",
        name: "linear",
        url: "https://mcp.linear.app/mcp",
        headers: [{ name: "Authorization", value: "Bearer token" }],
      },
      { type: "sse", name: "events", url: "https://example.com/sse", headers: [] },
      { type: "acp", name: "tools", serverId: "tools:1" },
      { type: "_custom", name: "custom" },
    ] as acp.McpServer[];

    const acpServers: acp.McpServerAcp[] = [];
    const configs = await sdkMcpServers(servers, async (server) => {
      acpServers.push(server);
      return overAcp;
    });

    expect(configs).toEqual({
      configs: {
        files: { type: "stdio", command: "/bin/files", args: ["--stdio"], env: { A: "1" } },
        linear: {
          type: "http",
          url: "https://mcp.linear.app/mcp",
          headers: { Authorization: "Bearer token" },
        },
        events: { type: "sse", url: "https://example.com/sse", headers: {} },
        tools: overAcp,
      },
      unserved: [],
    });
    expect(acpServers).toEqual([{ type: "acp", name: "tools", serverId: "tools:1" }]);
  });

  it("leaves out an acp server that gets no config, and keeps the others", async () => {
    const servers = [
      { type: "acp", name: "tools", serverId: "tools:1" },
      { name: "files", command: "/bin/files", args: [], env: [] },
    ] as acp.McpServer[];

    const served = await sdkMcpServers(servers, async () => {
      throw new Error("listen EPERM");
    });

    expect(served).toEqual({
      configs: { files: { type: "stdio", command: "/bin/files", args: [], env: {} } },
      unserved: [{ name: "tools", status: "failed", error: "listen EPERM" }],
    });
  });
});

describe("startAroundRefusedMcpServers", () => {
  /** What a core throws for Claude Code's refusal. */
  const refusal = startupFailureError(sideloadRefusal())!;

  it("starts again without the MCP servers when Claude Code refuses them", async () => {
    const starts: boolean[] = [];
    const session = await startAroundRefusedMcpServers(true, async (withoutMcpServers) => {
      starts.push(withoutMcpServers);
      if (!withoutMcpServers) throw refusal;
      return "session";
    });

    expect(session).toBe("session");
    expect(starts).toEqual([false, true]);
  });

  it.each([
    { name: "a refused start that has no MCP servers", hasMcpServers: false, error: refusal },
    {
      name: "a start that fails for another reason",
      hasMcpServers: true,
      error: startupFailureError(startupFailure("proxy_invalid", "Invalid proxy URL"))!,
    },
    {
      name: "a start that fails without a reason",
      hasMcpServers: true,
      error: new Error("Claude Code process exited with code 1"),
    },
  ])("does not repeat $name", async ({ hasMcpServers, error }) => {
    const starts: boolean[] = [];
    await expect(
      startAroundRefusedMcpServers(hasMcpServers, async (withoutMcpServers) => {
        starts.push(withoutMcpServers);
        throw error;
      }),
    ).rejects.toBe(error);

    expect(starts).toEqual([false]);
  });

  it("throws the error of a second start that is refused too", async () => {
    // As for a client's plugins: "--plugin-dir is disabled by …".
    const second = startupFailureError(startupFailure("sideload_flags_disabled", "plugins"))!;
    await expect(
      startAroundRefusedMcpServers(true, async (withoutMcpServers) => {
        throw withoutMcpServers ? second : refusal;
      }),
    ).rejects.toBe(second);
  });
});

describe("refusedMcpServers", () => {
  it("gives Claude Code no server, and has each of the session's servers unserved once", () => {
    const names = mcpServerNames(
      [
        { name: "files", command: "/bin/files", args: [], env: [] },
        { type: "acp", name: "tools", serverId: "tools:1" },
        // A v2 server of an extension transport has no name.
        { type: "_custom" },
      ],
      { linear: { type: "http", url: "https://mcp.linear.app/mcp" }, files: {} },
    );

    expect(refusedMcpServers(names)).toEqual({
      configs: {},
      unserved: ["files", "tools", "linear"].map((name) => ({
        name,
        status: "failed",
        error: expect.stringContaining("disableSideloadFlags"),
      })),
    });
  });
});

describe("McpOverAcp", () => {
  const connections: Array<{ close(): void }> = [];

  afterEach(() => {
    for (const connection of connections.splice(0)) connection.close();
  });

  /**
   * An agent connection that serves `mcp`, and a client that provides MCP
   * servers over it, or answers each `mcp/message` request with `answer`.
   */
  function connect(answer?: acp.McpOverAcpProvider["handleRequest"]) {
    const mcp = new McpOverAcp();
    const provider = new acp.McpOverAcpProvider();
    const toAgent = new TransformStream<Uint8Array, Uint8Array>();
    const toClient = new TransformStream<Uint8Array, Uint8Array>();
    const agent = acp
      .agent()
      .onNotification(acp.methods.agent.mcp.message, mcp.handleNotification)
      .connect(acp.ndJsonStream(toClient.writable, toAgent.readable));
    const client = acp
      .client()
      .onRequest(acp.methods.client.mcp.message, answer ?? provider.handleRequest)
      .connect(acp.ndJsonStream(toAgent.writable, toClient.readable));
    connections.push(agent, client);
    /** Registers a server on the client, and returns its declaration. */
    const serve = (name: string, handler: acp.McpRequestHandler) =>
      provider.registerServer(client.agent, { name, handler }).declaration;
    return { mcp, agent, serve };
  }

  it("sends a request of Claude Code to the client, and its progress and result back", async () => {
    const { mcp, agent, serve } = connect();
    const requests: acp.McpOperationContext[] = [];
    const tools = serve("tools", async (request) => {
      requests.push(request);
      await request.notify("notifications/progress", { progressToken: 1, progress: 1, total: 2 });
      return { result: { resultType: "complete", content: [{ type: "text", text: "hello" }] } };
    });

    const config = await mcp.sdkConfig(agent.client, tools);
    const call = { name: "echo", arguments: { message: "hello" } };
    const response = await claudeCodeMcpRequest(config, "tools/call", call);

    expect(config).toEqual({
      type: "http",
      url: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\//),
      headers: { Authorization: expect.stringMatching(/^Bearer \S+$/) },
    });
    expect(requests).toMatchObject([
      { serverId: tools.serverId, method: "tools/call", params: call },
    ]);
    expect(response.messages).toEqual([
      {
        jsonrpc: "2.0",
        method: "notifications/progress",
        params: { progressToken: 1, progress: 1, total: 2 },
      },
      {
        jsonrpc: "2.0",
        id: 1,
        result: { resultType: "complete", content: [{ type: "text", text: "hello" }] },
      },
    ]);
  });

  it("gives a server one config on one listener for as long as the connection lives", async () => {
    const { mcp, agent, serve } = connect();
    const tools = serve("tools", () => ({ result: {} }));
    const docs = serve("docs", () => ({ result: {} }));

    const config = await mcp.sdkConfig(agent.client, tools);
    const other = await mcp.sdkConfig(agent.client, docs);

    expect(await mcp.sdkConfig(agent.client, tools)).toEqual(config);
    expect(new URL(other.url).origin).toBe(new URL(config.url).origin);
    expect(other.url).not.toBe(config.url);

    agent.close();
    await agent.closed;
    await expect(claudeCodeMcpRequest(config, "tools/list")).rejects.toThrow();
    await expect(mcp.sdkConfig(agent.client, tools)).rejects.toThrow(
      "The adapter could not open the local endpoint that serves it to Claude Code " +
        "(ACP connection is closed). A new session tries again.",
    );
  });

  it.each([
    {
      refused: "a request with the token of another server",
      method: "tools/list",
      token: "other" as const,
      status: 401,
    },
    { refused: "an initialize request", method: "initialize", token: "own" as const, status: 404 },
  ])("refuses $refused", async ({ method, token, status }) => {
    const { mcp, agent, serve } = connect();
    const requests: string[] = [];
    const record = (request: acp.McpOperationContext) => {
      requests.push(request.method);
      return { result: {} };
    };
    const config = await mcp.sdkConfig(agent.client, serve("tools", record));
    const other = await mcp.sdkConfig(agent.client, serve("docs", record));

    const response = await claudeCodeMcpRequest(
      config,
      method,
      {},
      token === "own" ? config.headers : other.headers,
    );

    expect(response.status).toBe(status);
    expect(requests).toEqual([]);
  });

  describe("the session and tool call that a request names", () => {
    const ROOT = "session-root";
    const TOOL = "mcp__tools__echo";
    type Sent = Parameters<McpOverAcp["sending"]>[0];
    type Agents = Parameters<McpOverAcp["toolUseHooks"]>[2];
    /** An agent that runs a tool: its id and, when it is no `general-purpose` subagent, its type. */
    type Agent = { id: string; type?: string };

    /** The announcement of the child session `child` on the session `parent`. */
    const announcement = (parent: string, child: string): Sent => ({
      sessionId: parent,
      update: { sessionUpdate: "subagent_update", sessionId: child },
    });
    /** The first report of the tool call `toolCallId` on the session `sessionId`. */
    const toolCall = (sessionId: string, toolCallId: string): Sent => ({
      sessionId,
      update: { sessionUpdate: "tool_call", toolCallId, status: "pending" },
    });

    /**
     * A core of a client with child sessions that `subagent_update` announces:
     * each subagent's child session has its agent id, and the core has
     * announced it.
     */
    const CHILD_SESSIONS: Agents = {
      childSessions: true,
      reporting: (agentId) => agentId,
      childSessionId: (agentId) => agentId,
      definesAgent: () => false,
    };
    /** That core, for an agent that it does not know: it has not read its `task_started`. */
    const UNKNOWN_AGENT: Agents = { ...CHILD_SESSIONS, reporting: () => undefined };
    /** A core of a client with the child sessions of AIR's draft, which no `subagent_update` announces. */
    const AIR_DRAFT: Agents = { ...CHILD_SESSIONS, childSessionId: () => undefined };
    /** A core of a client without child sessions, for a subagent that it knows or not. */
    const noChildSessions = (known: boolean): Agents => ({
      ...CHILD_SESSIONS,
      childSessions: false,
      reporting: () => (known ? ROOT : undefined),
      childSessionId: () => undefined,
    });
    const WORKFLOW_AGENT: Agent = { id: "agent-w", type: "workflow-subagent" };

    /** The requests that wait for an announcement, by tool use id. */
    const waiting = (mcp: McpOverAcp) =>
      (mcp as unknown as { waiting: Map<string, unknown> }).waiting;

    /**
     * A connection with the active session {@link ROOT}, whose query started
     * with the `tools` server, and the core `agents` behind it. A request
     * waits a minute for an announcement, so a case whose request waits when
     * it should not, or for an announcement that does not come, times out.
     */
    async function rootSession(agents: Agents = CHILD_SESSIONS) {
      const { mcp, agent, serve } = connect();
      mcp.announcementWaitMs = 60_000;
      const named: Array<{ sessionId?: string; toolCallId?: string }> = [];
      const tools = serve("tools", ({ sessionId, toolCallId }) => {
        named.push({ sessionId, toolCallId });
        return { result: { resultType: "complete", content: [] } };
      });
      const config = await mcp.sdkConfig(agent.client, tools);
      const hooks = mcp.toolUseHooks(ROOT, [tools], agents)!;
      mcp.sessionStarted(ROOT, [tools]);
      /** Claude Code runs the hooks of `event` for the tool use `id` of `agent`. */
      const hook = (
        event: "PreToolUse" | "PostToolUse" | "PostToolUseFailure",
        id: string,
        agent?: Agent,
      ) =>
        runMcpToolHooks({ [event]: [hooks[event]] }, event, {
          id,
          tool: TOOL,
          agentId: agent?.id,
          agentType: agent?.type,
        });
      /** Claude Code sends `method` for the tool use `id`: what its `mcp/message` request named. */
      const request = async (id: string, method = "tools/call") => {
        await claudeCodeMcpRequest(config, method, { name: "echo" }, undefined, id);
        return named.at(-1);
      };
      return { mcp, tools, hook, request };
    }
    type RootSession = Awaited<ReturnType<typeof rootSession>>;

    it.each<{
      names: string;
      agents?: Agents;
      agent?: Agent;
      sending?: Sent[];
      named: { sessionId: string; toolCallId?: string };
    }>([
      {
        names: "the root session and the tool call for the main conversation",
        named: { sessionId: ROOT, toolCallId: "toolu_01" },
      },
      {
        names: "the child session and the tool call for an announced subagent",
        agent: { id: "agent-1" },
        sending: [announcement(ROOT, "agent-1")],
        named: { sessionId: "agent-1", toolCallId: "toolu_01" },
      },
      {
        names: "the child session of a child session, whose root declared the server,",
        agent: { id: "agent-2" },
        sending: [announcement(ROOT, "agent-1"), announcement("agent-1", "agent-2")],
        named: { sessionId: "agent-2", toolCallId: "toolu_01" },
      },
      {
        names:
          "the root session and the tool call for a subagent whose tool calls the root reports",
        agents: noChildSessions(true),
        agent: { id: "agent-1" },
        named: { sessionId: ROOT, toolCallId: "toolu_01" },
      },
      {
        names: "the root session and no tool call for an agent that a workflow runs",
        agents: UNKNOWN_AGENT,
        agent: WORKFLOW_AGENT,
        named: { sessionId: ROOT },
      },
      {
        // Its `task_started` is not read, or it is an agent that gets none.
        names: "the root session and no tool call for an unknown agent without child sessions",
        agents: noChildSessions(false),
        agent: { id: "agent-1" },
        named: { sessionId: ROOT },
      },
      {
        // As v1 reports the tool call of a workflow agent's permission request.
        names: "the session and the tool call of the report, for an agent without a session",
        agents: UNKNOWN_AGENT,
        agent: WORKFLOW_AGENT,
        sending: [toolCall(ROOT, "toolu_01")],
        named: { sessionId: ROOT, toolCallId: "toolu_01" },
      },
      {
        names: "the agent's session, when another root session replays the tool call's id,",
        sending: [toolCall("session-fork", "toolu_01")],
        named: { sessionId: ROOT, toolCallId: "toolu_01" },
      },
    ])("names $names", async ({ agents, agent, sending = [], named }) => {
      const { mcp, tools, hook, request } = await rootSession(agents);
      // A fork of the session, active on the connection too.
      mcp.sessionStarted("session-fork", [tools]);
      await hook("PreToolUse", "toolu_01", agent);
      for (const notification of sending) mcp.sending(notification);

      expect(await request("toolu_01")).toEqual(named);
    });

    it.each<{
      of: string;
      agents?: Agents;
      toolUse: (session: RootSession) => Promise<void>;
      method?: string;
    }>([
      {
        of: "a request without a tool use id",
        toolUse: ({ hook }) => hook("PreToolUse", "toolu_01"),
        method: "tools/list",
      },
      {
        of: "a tool use that no PreToolUse hook reported",
        toolUse: ({ hook }) => hook("PreToolUse", "toolu_other"),
      },
      {
        of: "a server that the session's last setup request did not declare",
        toolUse: async ({ mcp, hook }) => {
          await hook("PreToolUse", "toolu_01");
          mcp.sessionServersChanged(ROOT, [{ type: "acp", name: "docs", serverId: "docs:1" }]);
        },
      },
      {
        // The core forgot the child at a conversation reset: nothing reports its tool calls.
        of: "a subagent whose announced child session the core no longer knows",
        agents: UNKNOWN_AGENT,
        toolUse: async ({ mcp, hook }) => {
          mcp.sending(announcement(ROOT, "agent-1"));
          await hook("PreToolUse", "toolu_01", { id: "agent-1" });
        },
      },
      {
        // Its agent can be a child session that is not announced yet.
        of: "an agent of the workflow agents' type, which the session defines an agent of",
        agents: { ...UNKNOWN_AGENT, definesAgent: (name) => name === "workflow-subagent" },
        toolUse: ({ hook }) => hook("PreToolUse", "toolu_01", WORKFLOW_AGENT),
      },
      {
        of: "a child session of AIR's draft, which no subagent_update announces",
        agents: AIR_DRAFT,
        toolUse: async ({ mcp, hook }) => {
          mcp.sending({
            sessionId: ROOT,
            update: { sessionUpdate: "subagent_spawned", subagentSessionId: "agent-1" },
          } as Sent);
          await hook("PreToolUse", "toolu_01", { id: "agent-1" });
          mcp.sending(toolCall("agent-1", "toolu_01"));
        },
      },
    ])("names no session, without a wait, for $of", async ({ agents, toolUse, method }) => {
      const session = await rootSession(agents);
      await toolUse(session);

      expect(await session.request("toolu_01", method)).toEqual({});
    });

    describe("of a subagent whose child session is not announced yet", () => {
      it.each<{
        subagent: string;
        agents: Agents;
        sending: Sent[];
        named: { sessionId: string; toolCallId: string };
      }>([
        {
          subagent: "one whose start the core has not read, once its child is announced",
          agents: UNKNOWN_AGENT,
          // The announcement of another child ends no wait.
          sending: [announcement(ROOT, "agent-2"), announcement(ROOT, "agent-1")],
          named: { sessionId: "agent-1", toolCallId: "toolu_01" },
        },
        {
          subagent: "one whose announcement a replay holds, once it goes out",
          agents: CHILD_SESSIONS,
          sending: [announcement(ROOT, "agent-1")],
          named: { sessionId: "agent-1", toolCallId: "toolu_01" },
        },
        {
          // An agent that stays unexposed: the root reports its tool calls.
          subagent: "one whose tool call another session reports, once it is reported",
          agents: UNKNOWN_AGENT,
          sending: [toolCall(ROOT, "toolu_01")],
          named: { sessionId: ROOT, toolCallId: "toolu_01" },
        },
      ])("waits, and names the session of $subagent", async ({ agents, sending, named }) => {
        const { mcp, hook, request } = await rootSession(agents);
        await hook("PreToolUse", "toolu_01", { id: "agent-1" });

        const requested = request("toolu_01");
        await vi.waitFor(() => expect([...waiting(mcp).keys()]).toEqual(["toolu_01"]));
        for (const notification of sending.slice(0, -1)) {
          mcp.sending(notification);
          await new Promise((resolve) => setImmediate(resolve));
          expect(waiting(mcp).size).toBe(1);
        }
        mcp.sending(sending.at(-1)!);

        expect(await requested).toEqual(named);
        expect(waiting(mcp).size).toBe(0);
      });

      it("names no session when the announcement does not go out in time", async () => {
        const { mcp, hook, request } = await rootSession(UNKNOWN_AGENT);
        mcp.announcementWaitMs = 30;
        await hook("PreToolUse", "toolu_01", { id: "agent-1" });

        const started = performance.now();
        // Not the root session in the child's place.
        expect(await request("toolu_01")).toEqual({});

        expect(performance.now() - started).toBeGreaterThanOrEqual(25);
        expect(waiting(mcp).size).toBe(0);
        // A later announcement finds no request to release.
        mcp.sending(announcement(ROOT, "agent-1"));
        expect(await request("toolu_01")).toEqual({ sessionId: "agent-1", toolCallId: "toolu_01" });
      });

      it.each<{ ended: string; end: (session: RootSession) => Promise<void> }>([
        {
          // As when Claude Code gives the request up.
          ended: "its tool use ends",
          end: ({ hook }) => hook("PostToolUseFailure", "toolu_01", { id: "agent-1" }),
        },
        { ended: "the client closes its session", end: async ({ mcp }) => mcp.sessionClosed(ROOT) },
      ])("stops waiting, and names no session, when $ended", async ({ end }) => {
        const session = await rootSession(UNKNOWN_AGENT);
        const { mcp, hook, request } = session;
        await hook("PreToolUse", "toolu_01", { id: "agent-1" });

        const requested = request("toolu_01");
        await vi.waitFor(() => expect(waiting(mcp).size).toBe(1));
        await end(session);

        expect(await requested).toEqual({});
        const held = mcp as unknown as Record<"toolUses" | "waiting", Map<string, unknown>>;
        expect([held.toolUses.size, held.waiting.size]).toEqual([0, 0]);
      });
    });

    it.each<{ ended: string; end: (session: RootSession) => Promise<void> }>([
      {
        ended: "the tool returned (PostToolUse)",
        end: ({ hook }) => hook("PostToolUse", "toolu_01"),
      },
      {
        ended: "the tool failed (PostToolUseFailure)",
        end: ({ hook }) => hook("PostToolUseFailure", "toolu_01"),
      },
      {
        // A tool use that Claude Code never ran, such as a denied one, gets no hook.
        ended: "its tool call got a final status",
        end: async ({ mcp }) =>
          mcp.sending({
            sessionId: ROOT,
            update: { sessionUpdate: "tool_call_update", toolCallId: "toolu_01", status: "failed" },
          }),
      },
      {
        ended: "the client closed its session",
        end: async ({ mcp }) => mcp.sessionClosed(ROOT),
      },
    ])("forgets a tool use and its tool call once $ended", async ({ end }) => {
      const session = await rootSession();
      await session.hook("PreToolUse", "toolu_01");
      session.mcp.sending(toolCall(ROOT, "toolu_01"));
      await end(session);

      expect(await session.request("toolu_01")).toEqual({});
      const held = session.mcp as unknown as Record<"toolUses" | "toolCalls", Map<string, unknown>>;
      expect([held.toolUses.size, held.toolCalls.size]).toEqual([0, 0]);
    });

    it("forgets the tool uses and tool calls of a closed session's children, and its servers", async () => {
      const { mcp, hook } = await rootSession();
      mcp.sending(announcement(ROOT, "agent-1"));
      await hook("PreToolUse", "toolu_01", { id: "agent-1" });
      mcp.sending(toolCall("agent-1", "toolu_01"));

      mcp.sessionClosed(ROOT);

      const held = mcp as unknown as Record<
        "toolUses" | "toolCalls" | "sessions",
        Map<string, unknown>
      >;
      expect([held.toolUses.size, held.toolCalls.size, held.sessions.size]).toEqual([0, 0, 0]);
      // The child is no longer announced: a tool call of it is not kept.
      mcp.sending(toolCall("agent-1", "toolu_02"));
      expect(held.toolCalls.size).toBe(0);
    });

    it("keeps no tool call of a session without acp servers", () => {
      const { mcp } = connect();
      mcp.sessionStarted(ROOT, [{ name: "files", command: "/bin/files", args: [], env: [] }]);

      mcp.sending(toolCall(ROOT, "toolu_01"));

      expect((mcp as unknown as { toolCalls: Map<string, unknown> }).toolCalls.size).toBe(0);
    });
  });

  describe("the hooks of a query", () => {
    const AGENTS = {
      childSessions: true,
      reporting: () => undefined,
      childSessionId: () => undefined,
      definesAgent: () => false,
    };
    const TOOLS = { type: "acp" as const, name: "my tools.v2", serverId: "tools:1" };
    const DOCS = { type: "acp" as const, name: "docs", serverId: "docs:1" };
    const FILES = { name: "files", command: "/bin/files", args: [], env: [] };

    it("are none for a query without acp servers", () => {
      const { mcp } = connect();

      expect(mcp.toolUseHooks("session-root", [FILES], AGENTS)).toBeUndefined();
    });

    it.each([
      // Claude Code names the tools of `my tools.v2` with `_` for the space and the dot.
      { tool: "mcp__my_tools_v2__echo", runs: true },
      { tool: "mcp__docs__search", runs: true },
      { tool: "mcp__files__read", runs: false },
      { tool: "mcp__docs_old__search", runs: false },
      { tool: "Bash", runs: false },
    ])("run for the tools of the acp servers only: $tool", async ({ tool, runs }) => {
      const { mcp } = connect();
      const hooks = mcp.toolUseHooks("session-root", [TOOLS, FILES, DOCS], AGENTS)!;

      for (const event of ["PreToolUse", "PostToolUseFailure"] as const) {
        const ran = vi.fn();
        const matcher = {
          ...hooks[event],
          hooks: [async () => (ran(), { continue: true })],
        };
        await runMcpToolHooks({ [event]: [matcher] }, event, { id: "toolu_01", tool });
        expect(ran).toHaveBeenCalledTimes(runs ? 1 : 0);
      }
    });

    it("names the acp servers that a running query did not start with", () => {
      const { mcp } = connect();
      mcp.sessionStarted("session-root", [TOOLS, FILES]);

      // Its hooks report the tool uses of `my tools.v2` alone.
      expect(mcp.sessionServersChanged("session-root", [TOOLS, DOCS, FILES])).toEqual(["docs"]);
      expect(mcp.sessionServersChanged("session-root", [])).toEqual([]);
      expect(mcp.sessionServersChanged("session-root", [TOOLS])).toEqual([]);
      // The session's next query starts with its servers.
      mcp.sessionStarted("session-root", [DOCS]);
      expect(mcp.sessionServersChanged("session-root", [TOOLS, DOCS])).toEqual(["my tools.v2"]);
    });
  });

  it("answers Claude Code with an error when the client rejects a request for its missing session", async () => {
    const tools = { type: "acp" as const, name: "tools", serverId: "tools:1" };
    // A client that runs each request in its session answers -32602 without one.
    const { mcp, agent } = connect(async ({ params }) => {
      if (params.sessionId == null) {
        throw acp.RequestError.invalidParams(
          { serverId: params.serverId },
          "the tools server needs a sessionId",
        );
      }
      return { result: { resultType: "complete", content: [] } };
    });
    const config = await mcp.sdkConfig(agent.client, tools);
    mcp.sessionStarted("session-root", [tools]);

    // No hook reported the tool use: the request names no session.
    const rejected = await claudeCodeMcpRequest(config, "tools/call", { name: "echo" });
    // Not -32602 or "Invalid params", which would blame the tool arguments of
    // Claude Code. Its tool call fails with the client's reason.
    expect(rejected).toEqual({
      status: 200,
      messages: [
        {
          jsonrpc: "2.0",
          id: 1,
          error: {
            code: -33002,
            message: mcpRefusalMessage("the tools server needs a sessionId"),
          },
        },
      ],
    });

    // The endpoint serves the next request, which names its session.
    const hooks = mcp.toolUseHooks("session-root", [tools], {
      childSessions: true,
      reporting: () => undefined,
      childSessionId: () => undefined,
      definesAgent: () => false,
    })!;
    await runMcpToolHooks({ PreToolUse: [hooks.PreToolUse] }, "PreToolUse", {
      id: "toolu_01",
      tool: "mcp__tools__echo",
    });
    const served = await claudeCodeMcpRequest(config, "tools/call", { name: "echo" });
    expect(served.messages).toEqual([
      { jsonrpc: "2.0", id: 1, result: { resultType: "complete", content: [] } },
    ]);
  });
});
