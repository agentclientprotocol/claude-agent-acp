import { afterEach, describe, expect, it } from "vitest";
import * as acp from "@agentclientprotocol/sdk/unstable";
import { McpOverAcp, sdkMcpServers } from "../mcp-servers.js";
import { claudeCodeMcpRequest } from "./helpers.js";

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

describe("McpOverAcp", () => {
  const connections: Array<{ close(): void }> = [];

  afterEach(() => {
    for (const connection of connections.splice(0)) connection.close();
  });

  /** An agent connection that serves `mcp`, and a client that provides MCP servers over it. */
  function connect() {
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
      .onRequest(acp.methods.client.mcp.message, provider.handleRequest)
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
});
