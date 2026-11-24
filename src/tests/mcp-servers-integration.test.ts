import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as v1 from "@agentclientprotocol/sdk/unstable";
import * as v2 from "@agentclientprotocol/sdk/experimental/v2/unstable";
import { McpOverAcp } from "../mcp-servers.js";
import { acpProtocolRouter } from "../serve.js";
import { mcpRefusalMessage } from "./helpers.js";

/**
 * The session and tool call that the adapter names in `mcp/message` (see
 * `McpOverAcp` in `mcp-servers.ts`), with the bundled Claude Code CLI behind a
 * v1 and a v2 client. The doubles of `mcp-servers.test.ts` and
 * `v2/acp-v2.test.ts` run Claude Code's hooks and send its MCP requests
 * themselves. These cases check that the real CLI still does what they copy:
 * it runs a PreToolUse hook whose matcher matches the tool's name, with the
 * tool use id, and with the `agent_id` and `agent_type` of a subagent or of
 * an agent inside a workflow, before it runs an MCP tool, and its MCP client
 * sends that id in `params._meta["claudecode/toolUseId"]` of `tools/call`.
 *
 * Only the model is scripted: Claude Code talks to a server on 127.0.0.1, in
 * an empty home directory. The cases need no account and cost no API usage.
 */
describe.skipIf(!process.env.RUN_INTEGRATION_TESTS)("MCP over ACP with Claude Code", () => {
  /**
   * The `ping` tool of the client's `client tools` server, as Claude Code
   * names it. The session's hooks have to match that name.
   */
  const PING = "mcp__client_tools__ping";

  /** A client of one protocol version, with the capabilities that it declares. */
  type Client = { version: 1; capabilities?: v1.ClientCapabilities } | { version: 2 };
  const V1: Client = { version: 1 };
  const V1_SUBAGENTS: Client = { version: 1, capabilities: { subagents: {} } as never };
  const V2: Client = { version: 2 };

  /** An MCP request that the client's server got, with what its `mcp/message` request named. */
  type McpRequest = { method: string; sessionId?: string; toolCallId?: string };

  /** A session update of either protocol version, as far as the cases read it. */
  type Update = {
    sessionId: string;
    update: { sessionUpdate: string; sessionId?: unknown; toolCallId?: unknown; status?: unknown };
  };

  let home: string;
  let cwd: string;
  let model: Server;
  /** Resolves once the model is told that the workflow of the case ended. */
  let workflowEnded: Promise<void>;
  const closing: Array<() => Promise<unknown> | void> = [];

  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), "acp-mcp-integration-"));
    cwd = path.join(home, "workspace");
    await mkdir(cwd);
    ({ server: model, workflowEnded } = scriptedModel(PING));
    await new Promise<void>((resolve) => model.listen(0, "127.0.0.1", resolve));
    // No account, model endpoint, user settings or project config of the machine.
    vi.stubEnv("HOME", home);
    vi.stubEnv("CLAUDE_CONFIG_DIR", path.join(home, ".claude"));
    vi.stubEnv("ANTHROPIC_BASE_URL", `http://127.0.0.1:${(model.address() as AddressInfo).port}`);
    vi.stubEnv("ANTHROPIC_API_KEY", randomUUID());
    vi.stubEnv("CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "1");
    vi.stubEnv("CLAUDE_CODE_DISABLE_BACKGROUND_TASKS", "1");
    // Claude Code then gives the model the MCP tool itself, not a search for it.
    vi.stubEnv("ENABLE_TOOL_SEARCH", "false");
    for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY"]) {
      vi.stubEnv(name, "http://127.0.0.1:9");
    }
    vi.stubEnv("NO_PROXY", "127.0.0.1,localhost");
  });

  afterEach(async () => {
    for (const close of closing.splice(0).reverse()) await close();
    model.closeAllConnections();
    model.close();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await rm(home, { recursive: true, force: true, maxRetries: 10 });
  });

  /**
   * A session of `client` with the `acp` servers `client tools`, which has
   * the `ping` tool, and `docs`, which has no tool, in the `default` mode, in
   * which `ping`, Agent and Workflow calls need no permission. `prompt`
   * resolves with the stop reason of the turn that it runs. The server
   * answers the second and the third `tools/call` only once it has both.
   * While `rejects` is set, the client answers each `tools/call` with
   * `-32602`.
   */
  async function sessionWithTools(client: Client) {
    const requests: McpRequest[] = [];
    const updates: Update[] = [];
    const state = { rejects: false };
    const pair = Promise.withResolvers<void>();
    let calls = 0;
    const provider = new v1.McpOverAcpProvider();
    const ping = {
      name: "ping",
      description: "Return pong",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    };
    /** The handler of a server with `tools`. */
    const serving =
      (tools: object[]): v1.McpRequestHandler =>
      async ({ method, sessionId, toolCallId }) => {
        requests.push({ method, sessionId, toolCallId });
        switch (method) {
          case "server/discover":
            return {
              result: {
                resultType: "complete",
                supportedVersions: ["2026-07-28"],
                capabilities: { tools: {} },
                _meta: { "io.modelcontextprotocol/serverInfo": { name: "tools", version: "1" } },
              },
            };
          case "tools/list":
            return { result: { resultType: "complete", tools } };
          case "tools/call":
            // Claude Code runs the root's call first, then its two subagents at once.
            if (++calls === 3) pair.resolve();
            if (calls > 1) await pair.promise;
            return {
              result: { resultType: "complete", content: [{ type: "text", text: "pong" }] },
            };
          default:
            throw new v1.McpProtocolError(-32601, `Method not found: ${method}`);
        }
      };
    /** The declarations of the client's two servers, registered for `agent`. */
    const servers = (agent: Parameters<typeof provider.registerServer>[0]) => [
      provider.registerServer(agent, { name: "client tools", handler: serving([ping]) })
        .declaration,
      provider.registerServer(agent, { name: "docs", handler: serving([]) }).declaration,
    ];
    /** `mcp/message`, as a client that refuses the session of a `tools/call` answers it. */
    const answer: typeof provider.handleRequest = (context) => {
      if (state.rejects && context.params.method === "tools/call") {
        requests.push({
          method: "tools/call",
          sessionId: context.params.sessionId ?? undefined,
          toolCallId: context.params.toolCallId ?? undefined,
        });
        throw v1.RequestError.invalidParams(
          { serverId: context.params.serverId },
          "the tools server does not serve this session",
        );
      }
      return provider.handleRequest(context);
    };

    const toAgent = new TransformStream<v2.AnyMessage, v2.AnyMessage>();
    const toClient = new TransformStream<v2.AnyMessage, v2.AnyMessage>();
    const dispose = (agent: { dispose(): Promise<void> }) => closing.push(() => agent.dispose());
    acpProtocolRouter(undefined, dispose, "auto", { onV2Agent: dispose }).connect({
      readable: toAgent.readable,
      writable: toClient.writable,
    });
    const stream = { readable: toClient.readable, writable: toAgent.writable };
    const options = { allowedTools: [PING, "Agent", "Workflow"] };
    /** Claude Code listed the tools of both servers. */
    const listed = () =>
      vi.waitFor(
        () => expect(requests.filter(({ method }) => method === "tools/list")).toHaveLength(2),
        { timeout: 15_000 },
      );

    if (client.version === 1) {
      const connection = v1
        .client({ name: "mcp-integration" })
        .onNotification(v1.methods.client.session.update, ({ params }) => {
          updates.push(params as Update);
        })
        .onRequest(v1.methods.client.mcp.message, answer)
        .connect(stream as unknown as v1.Stream);
      closing.push(() => connection.close());
      const agent = connection.agent;
      await agent.request(v1.methods.agent.initialize, {
        protocolVersion: v1.PROTOCOL_VERSION,
        clientCapabilities: client.capabilities,
      });
      const setup: v1.NewSessionRequest = {
        cwd,
        mcpServers: servers(agent),
        _meta: { claudeCode: { options } },
      };
      const { sessionId } = await agent.request(v1.methods.agent.session.new, setup);
      await listed();
      await agent.request(v1.methods.agent.session.setMode, { sessionId, modeId: "default" });
      const prompt = async (text: string) => {
        const response = await agent.request(v1.methods.agent.session.prompt, {
          sessionId,
          prompt: [{ type: "text", text }],
        });
        return response.stopReason as string;
      };
      return { root: sessionId, requests, updates, state, prompt };
    }

    const connection = v2
      .client({ name: "mcp-integration" })
      .onNotification(v2.methods.client.session.update, ({ params }) => {
        updates.push(params as Update);
      })
      .onRequest(v2.methods.client.mcp.message, answer)
      .connect(stream);
    closing.push(() => connection.close());
    const agent = connection.agent;
    await agent.request(v2.methods.agent.initialize, {
      protocolVersion: v2.PROTOCOL_VERSION,
      info: { name: "mcp-integration", version: "1" },
      capabilities: {},
    });
    const { sessionId } = await agent.request(v2.methods.agent.session.new, {
      cwd,
      mcpServers: servers(agent),
      _meta: { claudeCode: { options } },
    });
    await listed();
    await agent.request(v2.methods.agent.session.setConfigOption, {
      sessionId,
      configId: "mode",
      type: "id",
      value: "default",
    });
    /**
     * The stop reasons of the ends of the root session's work so far. An
     * idle state without one only changes the list of its background work.
     */
    const idles = () =>
      updates.flatMap(({ sessionId: id, update }) => {
        const { state: work, stopReason } = update as { state?: string; stopReason?: string };
        return id === sessionId &&
          update.sessionUpdate === "state_update" &&
          work === "idle" &&
          stopReason != null
          ? [stopReason]
          : [];
      });
    const prompt = async (text: string) => {
      const before = idles().length;
      await agent.request(v2.methods.agent.session.prompt, {
        sessionId,
        prompt: [{ type: "text", text }],
      });
      await vi.waitFor(() => expect(idles().length).toBeGreaterThan(before), { timeout: 20_000 });
      return idles().at(-1) as string;
    };
    return { root: sessionId, requests, updates, state, prompt };
  }

  /** The session that the client got the first report of each tool call on, by tool call id. */
  const reportedOn = (updates: Update[]): Record<string, string> =>
    Object.fromEntries(
      [...updates]
        .reverse()
        .flatMap(({ sessionId, update }) =>
          typeof update.toolCallId === "string" ? [[update.toolCallId, sessionId]] : [],
        ),
    );

  /** The statuses that the client got for the tool call `toolCallId`, in order. */
  const statuses = (updates: Update[], toolCallId: string) =>
    updates.flatMap(({ update }) =>
      update.toolCallId === toolCallId && typeof update.status === "string" ? [update.status] : [],
    );

  /**
   * Prompts a session of `client` so that the main conversation and two
   * subagents, which run at once, each call `ping`, and checks what the three
   * requests named. `children` is the number of child sessions that the
   * client gets for the two subagents.
   */
  async function rootAndTwoSubagentsPing(client: Client, children: number) {
    const { root, requests, updates, prompt } = await sessionWithTools(client);

    expect(await prompt("PING_root DELEGATE")).toBe("end_turn");

    const ids = ["toolu_root", "toolu_left", "toolu_right"];
    const on = reportedOn(updates);
    const announced = updates.flatMap(({ update }) =>
      update.sessionUpdate === "subagent_update" ? [update.sessionId] : [],
    );
    expect(new Set(announced).size).toBe(children);
    // The root reports its own tool call, and each child session its subagent's.
    expect(on.toolu_root).toBe(root);
    expect(new Set([on.toolu_left, on.toolu_right])).toEqual(
      new Set(children ? announced : [root]),
    );
    // Each request names the session and tool call that the client got the report on.
    const calls = requests.filter(({ method }) => method === "tools/call");
    expect(calls).toHaveLength(ids.length);
    expect(calls).toEqual(
      expect.arrayContaining(
        ids.map((id) => ({ method: "tools/call", sessionId: on[id], toolCallId: id })),
      ),
    );
    // Claude Code's requests outside a tool use name none.
    const others = requests.filter(({ method }) => method !== "tools/call");
    expect(new Set(others.map(({ method }) => method))).toEqual(
      new Set(["server/discover", "tools/list"]),
    );
    expect(others.filter(({ sessionId, toolCallId }) => sessionId ?? toolCallId)).toEqual([]);
  }

  it.each([
    { client: V1, of: "a v1 session, which reports them itself", children: 0 },
    { client: V1_SUBAGENTS, of: "a v1 session with child sessions", children: 2 },
    { client: V2, of: "a v2 session", children: 2 },
  ])(
    "names the session and tool call of the root and of two subagents of $of that call one tool",
    ({ client, children }) => rootAndTwoSubagentsPing(client, children),
    60_000,
  );

  it.each([
    { client: V1_SUBAGENTS, of: "a v1 session with child sessions" },
    { client: V2, of: "a v2 session" },
  ])(
    "holds the requests of two subagents of $of until it knows their announcements went out",
    async ({ client }) => {
      // The session reads Claude Code's stream ahead of Claude Code's requests
      // here, so nothing waits. The lag is made up: the adapter's record gets
      // each session update 100 ms after it went out, well within its wait.
      const sending = McpOverAcp.prototype.sending;
      vi.spyOn(McpOverAcp.prototype, "sending").mockImplementation(function (
        this: McpOverAcp,
        notification,
      ) {
        setTimeout(() => sending.call(this, notification), 100);
      });
      const held = vi.spyOn(McpOverAcp.prototype as never, "held");

      await rootAndTwoSubagentsPing(client, 2);

      // The root's request named its session at once.
      expect(held).toHaveBeenCalledTimes(2);
    },
    60_000,
  );

  it.each([
    { client: V1, of: "a v1 session" },
    { client: V1_SUBAGENTS, of: "a v1 session with child sessions" },
    { client: V2, of: "a v2 session" },
  ])(
    "names the root session of $of, and no tool call, for an agent that a workflow runs",
    async ({ client }) => {
      const { root, requests, updates, prompt } = await sessionWithTools(client);

      // The workflow runs in the background, after the turn that launched it.
      expect(await prompt("WORKFLOW")).toBe("end_turn");
      await workflowEnded;

      // Its agent gets no child session, and no session reports its tool call.
      expect(updates.filter(({ update }) => update.sessionUpdate === "subagent_update")).toEqual(
        [],
      );
      expect(reportedOn(updates)).not.toHaveProperty("toolu_inside");
      expect(requests.filter(({ method }) => method === "tools/call")).toEqual([
        { method: "tools/call", sessionId: root },
      ]);
    },
    60_000,
  );

  it.each([
    { client: V1, of: "a v1 session" },
    { client: V2, of: "a v2 session" },
  ])(
    "fails the tool call of $of whose request the client rejects, and runs the next one",
    async ({ client }) => {
      const { root, requests, updates, state, prompt } = await sessionWithTools(client);

      state.rejects = true;
      expect(await prompt("PING_refused")).toBe("end_turn");
      state.rejects = false;
      expect(await prompt("PING_served")).toBe("end_turn");

      expect(requests.filter(({ method }) => method === "tools/call")).toEqual([
        { method: "tools/call", sessionId: root, toolCallId: "toolu_refused" },
        { method: "tools/call", sessionId: root, toolCallId: "toolu_served" },
      ]);
      // The tool call fails with the client's reason, in the words of the SDK's
      // bridge and not as "Invalid params", and the next one runs.
      const refused = updates.filter(({ update }) => update.toolCallId === "toolu_refused").at(-1);
      expect(refused?.update).toMatchObject({
        status: "failed",
        rawOutput: mcpRefusalMessage("the tools server does not serve this session"),
      });
      expect(statuses(updates, "toolu_served").at(-1)).toBe("completed");
    },
    60_000,
  );
});

/** A workflow whose one agent gets `PING_inside`. */
const WORKFLOW_SCRIPT = `export const meta = {
  name: "ping",
  description: "Ping from inside a workflow",
  phases: [{ title: "Ping" }],
};
return await agent("PING_inside");
`;

/**
 * A model that Claude Code talks to in place of the Anthropic API. It answers
 * a conversation whose last `PING_<name>` it has not answered yet with the
 * tool use `toolu_<name>` of `tool`. When the message also says `DELEGATE`, it
 * adds two Agent calls, whose subagents get `PING_left` and `PING_right`. It
 * answers `WORKFLOW` once with a Workflow call of {@link WORKFLOW_SCRIPT}.
 * Every other request gets the text "done". `workflowEnded` resolves when
 * Claude Code sends the task notification of a workflow's end.
 */
function scriptedModel(tool: string): { server: Server; workflowEnded: Promise<void> } {
  const answered = new Set<string>();
  const workflowEnded = Promise.withResolvers<void>();
  type Block =
    | { type: "text"; text: string }
    | { type: "tool_use"; id: string; name: string; input: Record<string, string> };
  const server = createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    const json = (value: unknown) => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(value));
    };
    if (request.url?.includes("count_tokens")) return json({ input_tokens: 100 });
    if (request.url?.split("?")[0] !== "/v1/messages") return json({});
    const texts: string[] = (body.messages ?? [])
      .filter((message: { role: string }) => message.role === "user")
      .flatMap((message: { content: string | Array<{ type: string; text: string }> }) =>
        Array.isArray(message.content)
          ? message.content.filter((block) => block.type === "text").map((block) => block.text)
          : [message.content],
      );
    if (texts.some((text) => text.includes("<task-notification>"))) workflowEnded.resolve();
    const offers = (name: string) =>
      body.tools?.some((offered: { name: string }) => offered.name === name) === true;
    const prompt = texts.filter((text) => /\bPING_\w+/.test(text)).at(-1);
    const name = prompt?.match(/\bPING_(\w+)/)?.[1];
    let blocks: Block[] = [{ type: "text", text: "done" }];
    if (
      texts.some((text) => /\bWORKFLOW\b/.test(text)) &&
      !answered.has("WORKFLOW") &&
      offers("Workflow")
    ) {
      answered.add("WORKFLOW");
      blocks = [
        {
          type: "tool_use",
          id: "toolu_workflow",
          name: "Workflow",
          input: { script: WORKFLOW_SCRIPT },
        },
      ];
    } else if (name && !answered.has(name) && offers(tool)) {
      answered.add(name);
      blocks = [{ type: "tool_use", id: `toolu_${name}`, name: tool, input: {} }];
      if (prompt?.includes("DELEGATE")) {
        for (const side of ["left", "right"]) {
          blocks.push({
            type: "tool_use",
            id: `toolu_agent_${side}`,
            name: "Agent",
            input: {
              description: `Ping ${side}`,
              subagent_type: "general-purpose",
              prompt: `PING_${side}`,
            },
          });
        }
      }
    }
    const stopReason = blocks[0].type === "tool_use" ? "tool_use" : "end_turn";
    const message = {
      type: "message",
      id: `msg_${randomUUID()}`,
      model: body.model,
      role: "assistant",
      stop_sequence: null,
      usage: { input_tokens: 100, output_tokens: 20 },
      content: blocks,
      stop_reason: stopReason,
    };
    if (!body.stream) return json(message);
    response.writeHead(200, { "content-type": "text/event-stream" });
    const send = (type: string, fields: Record<string, unknown> = {}) =>
      response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`);
    send("message_start", { message: { ...message, content: [], stop_reason: null } });
    blocks.forEach((block, index) => {
      send("content_block_start", {
        index,
        content_block: block.type === "tool_use" ? { ...block, input: {} } : { ...block, text: "" },
      });
      send("content_block_delta", {
        index,
        delta:
          block.type === "tool_use"
            ? { type: "input_json_delta", partial_json: JSON.stringify(block.input) }
            : { type: "text_delta", text: block.text },
      });
      send("content_block_stop", { index });
    });
    send("message_delta", {
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { output_tokens: 20 },
    });
    send("message_stop");
    response.end();
  });
  return { server, workflowEnded: workflowEnded.promise };
}
