import { describe, expect, it, vi } from "vitest";
import type { McpServerStatus } from "@anthropic-ai/claude-agent-sdk";
import type { SessionNotification } from "@agentclientprotocol/sdk";
import { ClaudeAcpAgent, stripLocalCommandMetadata, type AcpClient } from "../acp-agent.js";
import {
  cleanMcpError,
  formatMcpStatus,
  MCP_AVAILABLE_COMMAND,
  parseMcpCommand,
} from "../mcp-command.js";
import { Pushable } from "../utils.js";
import { initializeClient } from "./helpers.js";
import {
  mockSessionState,
  successfulResultMessage,
  userEcho,
  wrapQuery,
} from "./session-doubles.js";

const SERVERS: McpServerStatus[] = [
  {
    name: "github",
    status: "connected",
    scope: "user",
    tools: [{ name: "search" }, { name: "issue" }],
  },
  { name: "linear", status: "needs-auth", scope: "project", source: "plugin" },
  { name: "db", status: "failed", error: "spawn db-mcp ENOENT", scope: "local" },
  { name: "docs", status: "pending", scope: "user" },
  { name: "old", status: "disabled", scope: "user" },
];

/** An agent with one session. Its query reports `SERVERS`, unless `query`
 *  replaces a method, and records every prompt that reaches Claude Code.
 *  `events` records each forwarded prompt and each `/mcp` answer in order. */
function setup(query: Record<string, unknown> = {}, client: Record<string, unknown> = {}) {
  const updates: SessionNotification[] = [];
  const events: string[] = [];
  const agent = new ClaudeAcpAgent(
    {
      sessionUpdate: async (notification: SessionNotification) => {
        updates.push(notification);
        if (notification.update.sessionUpdate === "agent_message_chunk") events.push("answer");
      },
      createElicitation: vi.fn(async () => ({ action: "accept" })),
      completeElicitation: vi.fn(async () => {}),
      ...client,
    } as unknown as AcpClient,
    { log: () => {}, error: () => {} },
  );
  const input = new Pushable<any>();
  const forwarded: string[] = [];
  async function* messages() {
    for await (const user of input) {
      const text = user.message.content.map((block: any) => block.text).join(" ");
      forwarded.push(text);
      events.push(`forward ${text}`);
      yield userEcho(user);
      yield successfulResultMessage();
    }
  }
  const sdkQuery = Object.assign(wrapQuery(messages()), {
    mcpServerStatus: vi.fn(async () => SERVERS),
    reconnectMcpServer: vi.fn(async () => {}),
    ...query,
  });
  agent.sessions["test-session"] = mockSessionState({ query: sdkQuery, input });
  const text = () =>
    updates
      .filter((update) => update.update.sessionUpdate === "agent_message_chunk")
      .map((update) => (update.update as any).content.text)
      .join("");
  const prompt = (command: string) =>
    agent.prompt({ sessionId: "test-session", prompt: [{ type: "text", text: command }] });
  return { agent, sdkQuery, forwarded, events, text, prompt };
}

/** A status read that waits until the test calls the returned `release`. */
function blockedStatus() {
  const releases: (() => void)[] = [];
  const read = vi.fn(
    () => new Promise<McpServerStatus[]>((resolve) => releases.push(() => resolve(SERVERS))),
  );
  return { read, release: () => releases.shift()?.() };
}

describe("parseMcpCommand", () => {
  it("parses the status and reconnect forms", () => {
    expect(parseMcpCommand(" /mcp ")).toEqual({ action: "status" });
    expect(parseMcpCommand("/mcp reconnect")).toEqual({ action: "reconnect" });
    expect(parseMcpCommand("/mcp reconnect all")).toEqual({ action: "reconnect" });
    expect(parseMcpCommand("/mcp Reconnect github")).toEqual({
      action: "reconnect",
      server: "github",
    });
  });

  it("leaves every other prompt to Claude Code", () => {
    expect(parseMcpCommand("/mcp enable github")).toBeNull();
    expect(parseMcpCommand("/mcp:github:prompt")).toBeNull();
    expect(parseMcpCommand("/mcpx")).toBeNull();
    expect(parseMcpCommand("please run /mcp")).toBeNull();
  });
});

const LONG_ERROR =
  'MCP startup failed: handshaking with MCP server failed: JSON-RPC error: -32603: No IDE found. Install the "MCP Server" plugin and ensure it is enabled. Probed ports: 64342: JSON-RPC error: -32603: No IDE found. Install the "MCP Server" plugin and ensure it is enabled.';

describe("formatMcpStatus", () => {
  it("renders the summary, the groups, the disabled line, and the hint", () => {
    expect(formatMcpStatus(SERVERS)).toBe(
      [
        "**MCP servers:** 5 (1 failed, 1 needs authentication, 1 connecting, 1 connected, 1 disabled)",
        "",
        "**Failed**",
        "- `db`: spawn db-mcp ENOENT",
        "",
        "**Needs authentication**",
        "- `linear`",
        "",
        "**Connecting**",
        "- `docs`",
        "",
        "**Connected**",
        "- `github`: 2 tools",
        "",
        "**Disabled:** `old`",
        "",
        "Run `/mcp reconnect <server>` to reconnect one server, or `/mcp reconnect` to reconnect every server that is not connected and not disabled.",
      ].join("\n"),
    );
  });

  it("keeps the SDK order inside a group and omits an empty group", () => {
    const markdown = formatMcpStatus([
      { name: "b", status: "failed", error: "boom" },
      { name: "c", status: "connected" },
      { name: "a", status: "failed", error: "bang" },
      { name: "x", status: "disabled" },
      { name: "y", status: "disabled" },
    ]);
    expect(markdown).toContain("**Failed**\n- `b`: boom\n- `a`: bang");
    expect(markdown).toContain("**Connected**\n- `c`\n");
    expect(markdown).toContain("**Disabled:** `x`, `y`");
    expect(markdown).not.toContain("**Connecting**");
    expect(markdown).not.toContain("**Needs authentication**");
    expect(markdown).toContain("2 failed");
  });

  it("uses the singular and the plural for the tool count", () => {
    const markdown = formatMcpStatus([
      { name: "one", status: "connected", tools: [{ name: "t" }] },
      { name: "none", status: "connected", tools: [] },
      { name: "many", status: "connected", tools: [{ name: "a" }, { name: "b" }] },
    ]);
    expect(markdown).toContain("- `one`: 1 tool\n- `none`: 0 tools\n- `many`: 2 tools");
    expect(markdown).toContain("**MCP servers:** 3 (3 connected)");
  });

  it("uses the plural for more than one server that needs authentication", () => {
    const markdown = formatMcpStatus([
      { name: "a", status: "needs-auth" },
      { name: "b", status: "needs-auth" },
    ]);
    expect(markdown).toContain("**MCP servers:** 2 (2 need authentication)");
  });

  it("shows the hint only when a server can be reconnected", () => {
    const hint = "Run `/mcp reconnect <server>`";
    expect(
      formatMcpStatus([
        { name: "a", status: "connected" },
        { name: "b", status: "disabled" },
      ]),
    ).not.toContain(hint);
    expect(formatMcpStatus([{ name: "a", status: "failed" }])).toContain(hint);
    expect(formatMcpStatus([{ name: "a", status: "needs-auth" }])).toContain(hint);
    expect(formatMcpStatus([{ name: "a", status: "pending" }])).toContain(hint);
  });

  it("drops the scope and the source of a server", () => {
    const markdown = formatMcpStatus(SERVERS);
    expect(markdown).not.toContain("Scope");
    expect(markdown).not.toContain("plugin");
  });

  it("shows the scope when two servers have the same name", () => {
    const markdown = formatMcpStatus([
      { name: "ctx", status: "connected", scope: "user" },
      { name: "ctx", status: "failed", scope: "project", error: "boom" },
      { name: "solo", status: "connected", scope: "user" },
    ]);
    expect(markdown).toContain("- `ctx` (project): boom");
    expect(markdown).toContain("- `ctx` (user)\n- `solo`");
  });

  it("shortens a long multi-segment error", () => {
    const markdown = formatMcpStatus([{ name: "ide", status: "failed", error: LONG_ERROR }]);
    expect(markdown).toContain(
      '- `ide`: No IDE found. Install the "MCP Server" plugin and ensure it is enabled.\n',
    );
  });

  it("escapes the Markdown syntax in an error and keeps one line", () => {
    const markdown = formatMcpStatus([
      { name: "my_server", status: "failed", error: "<html> *bad*\n`x` | y" },
    ]);
    expect(markdown).toContain("- `my_server`: \\<html\\> \\*bad\\* \\`x\\` \\| y\n");
  });

  it("counts a status that the adapter does not know", () => {
    const markdown = formatMcpStatus([
      { name: "a", status: "connected" },
      { name: "b", status: "sleeping" as McpServerStatus["status"] },
    ]);
    expect(markdown).toContain("**MCP servers:** 2 (1 connected, 1 sleeping)");
    expect(markdown).toContain("**Connected**\n- `a`\n\n**Sleeping**\n- `b`");
  });

  it("orders the summary counts as the groups, with an unknown status before the disabled ones", () => {
    const markdown = formatMcpStatus([
      { name: "a", status: "connected" },
      { name: "b", status: "disabled" },
      { name: "c", status: "sleeping" as McpServerStatus["status"] },
      { name: "d", status: "pending" },
      { name: "e", status: "failed" },
    ]);
    expect(markdown).toContain(
      "**MCP servers:** 5 (1 failed, 1 connecting, 1 connected, 1 sleeping, 1 disabled)",
    );
    expect(markdown).toMatch(
      /\*\*Failed\*\*[\s\S]*\*\*Connecting\*\*[\s\S]*\*\*Connected\*\*[\s\S]*\*\*Sleeping\*\*[\s\S]*\*\*Disabled:\*\*/,
    );
  });

  it("shows no error detail for an error with only whitespace", () => {
    const markdown = formatMcpStatus([
      { name: "x", status: "failed", error: "  \n ", tools: [{ name: "a" }, { name: "b" }] },
      { name: "y", status: "failed", error: "\t" },
    ]);
    expect(markdown).toContain("- `x`: 2 tools\n- `y`\n");
  });

  it("shows a server name with a backtick unchanged in a longer fence", () => {
    const markdown = formatMcpStatus([
      { name: "a`b", status: "connected" },
      { name: "`edge", status: "disabled" },
    ]);
    expect(markdown).toContain("- ``a`b``\n");
    expect(markdown).toContain("**Disabled:** `` `edge ``");
  });

  it("puts a label above the reconnect results", () => {
    const markdown = formatMcpStatus([{ name: "db", status: "connected" }], {
      results: [
        { server: "db", outcome: "reconnected" },
        { server: "ws", outcome: "failed", error: " " },
      ],
    });
    expect(markdown).toMatch(
      /^\*\*Reconnect:\*\*\n- `db`: reconnected\.\n- `ws`: the reconnect failed\.\n\n\*\*MCP servers:\*\*/,
    );
  });
});

describe("cleanMcpError", () => {
  it("keeps the real error of a wrapped, repeated error", () => {
    expect(cleanMcpError(LONG_ERROR)).toBe(
      'No IDE found. Install the "MCP Server" plugin and ensure it is enabled.',
    );
  });

  it("keeps a short error as it is", () => {
    expect(cleanMcpError("spawn db-mcp ENOENT")).toBe("spawn db-mcp ENOENT");
    expect(cleanMcpError("Failed to connect to the server: timeout")).toBe(
      "Failed to connect to the server: timeout",
    );
  });

  it("drops a type path and a long generic", () => {
    expect(
      cleanMcpError("rmcp::service::ServiceError: Transport closed: connection reset by peer"),
    ).toBe("Transport closed: connection reset by peer");
    expect(
      cleanMcpError(
        "Result<ServerInfo, TransportError<std::io::Error>>: the server exited with code 1",
      ),
    ).toBe("the server exited with code 1");
  });

  it("keeps at most two sentences", () => {
    expect(cleanMcpError("One. Two! Three? Four.")).toBe("One. Two!");
  });

  it("cuts a long error with an ellipsis", () => {
    const cleaned = cleanMcpError(`${"word ".repeat(60)}end`);
    expect(cleaned.length).toBeLessThanOrEqual(160);
    expect(cleaned.endsWith("word…")).toBe(true);
  });

  it("keeps the type name when only wrappers and a type path remain", () => {
    expect(cleanMcpError("Error: rmcp::service::ServerInitializeError")).toBe(
      "ServerInitializeError",
    );
    expect(cleanMcpError("rmcp::service::ServerInitializeError")).toBe("ServerInitializeError");
  });

  it("never keeps an error code alone", () => {
    expect(cleanMcpError("error: 401")).toBe("error: 401");
    expect(cleanMcpError("Error: 12345")).toBe("Error: 12345");
    expect(cleanMcpError("Error 401")).toBe("Error 401");
    expect(cleanMcpError("MCP startup failed: JSON-RPC error: -32603")).toBe(
      "JSON-RPC error: -32603",
    );
  });

  it("drops the MCP SDK wrapper", () => {
    expect(cleanMcpError("McpError: MCP error -32001: Request timed out")).toBe(
      "Request timed out",
    );
  });

  it("drops a wrapper segment at any position", () => {
    expect(cleanMcpError("spawn npx ENOENT: Error: spawn npx ENOENT")).toBe("spawn npx ENOENT");
    expect(cleanMcpError("Transport closed: McpError: connection reset")).toBe(
      "Transport closed: connection reset",
    );
  });

  it("cuts a long error at a code point boundary", () => {
    const cleaned = cleanMcpError("😀".repeat(200));
    expect(cleanMcpError("😀".repeat(100))).toBe("😀".repeat(100));
    const chars = Array.from(cleaned);
    expect(chars.length).toBeLessThanOrEqual(160);
    expect(chars.every((char) => char === "😀" || char === "…")).toBe(true);
    expect(cleaned.endsWith("😀…")).toBe(true);
  });

  it("gives an empty text for an error with only whitespace", () => {
    expect(cleanMcpError(" \n\t ")).toBe("");
  });
});

describe("/mcp", () => {
  it("answers in the adapter without a Claude Code turn", async () => {
    const { forwarded, text, prompt } = setup();

    const response = await prompt("/mcp");

    expect(response.stopReason).toBe("end_turn");
    expect(forwarded).toEqual([]);
    expect(text()).toBe(formatMcpStatus(SERVERS));
    expect(text()).not.toContain("terminal");
  });

  it("says when no MCP server is configured", async () => {
    const { text, prompt } = setup({ mcpServerStatus: vi.fn(async () => []) });

    await prompt("/mcp");

    expect(text()).toBe("No MCP servers are configured.");
  });

  it("reports a status read failure in the chat", async () => {
    const { text, prompt } = setup({
      mcpServerStatus: vi.fn(async () => {
        throw new Error("control channel closed");
      }),
    });

    const response = await prompt("/mcp");

    expect(response.stopReason).toBe("end_turn");
    expect(text()).toContain("The MCP server status is not available. control channel closed");
  });

  it("waits for an earlier turn, so the answer follows its output", async () => {
    const { agent, forwarded, text, prompt } = setup();
    const order: string[] = [];

    const first = prompt("hello").then(() => order.push("hello"));
    const status = prompt("/mcp").then(() => order.push("/mcp"));
    await Promise.all([first, status]);

    expect(forwarded).toEqual(["hello"]);
    expect(order).toEqual(["hello", "/mcp"]);
    expect(text()).toContain("**MCP servers:** 5");
    expect(agent.sessions["test-session"].turnQueue?.every((turn) => turn.settled)).toBe(true);
  });

  it("leaves other /mcp prompts to Claude Code", async () => {
    const { agent, forwarded, prompt } = setup();

    await prompt("/mcp enable github");
    await prompt("/mcp:github:prompt");
    await agent.prompt({
      sessionId: "test-session",
      prompt: [
        { type: "text", text: "/mcp" },
        { type: "text", text: "more" },
      ],
    });

    // The adapter rewrites an MCP prompt command into the Claude Code form.
    expect(forwarded).toEqual(["/mcp enable github", "/github:prompt (MCP)", "/mcp more"]);
  });

  it("cancels a prompt that waits behind /mcp", async () => {
    const status = blockedStatus();
    const { agent, forwarded, prompt } = setup({ mcpServerStatus: status.read });

    const mcp = prompt("/mcp");
    await vi.waitFor(() => expect(status.read).toHaveBeenCalled());
    const later = prompt("hello");
    await agent.cancel({ sessionId: "test-session" });
    status.release();

    expect((await mcp).stopReason).toBe("cancelled");
    expect((await later).stopReason).toBe("cancelled");
    expect(forwarded).toEqual([]);
  });

  it("cancels at once while the status read is still blocked", async () => {
    const status = blockedStatus();
    const { agent, forwarded, text, prompt } = setup({ mcpServerStatus: status.read });

    const mcp = prompt("/mcp");
    await vi.waitFor(() => expect(status.read).toHaveBeenCalled());
    const waiting = prompt("hello");
    await agent.cancel({ sessionId: "test-session" });

    // The status read does not return here. The cancel alone ends both prompts.
    expect((await waiting).stopReason).toBe("cancelled");
    expect((await mcp).stopReason).toBe("cancelled");

    // A prompt sent after the cancel goes to Claude Code at once.
    expect((await prompt("after")).stopReason).toBe("end_turn");
    expect(forwarded).toEqual(["after"]);

    status.release();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(text()).toBe("");
  });

  it("answers from the query of a session that a provider update replaced", async () => {
    const answers: string[] = [];
    let replace = () => {};
    const { agent, sdkQuery, prompt } = setup(
      {},
      {
        sessionUpdate: async (notification: SessionNotification) => {
          // The first update is the fallback warning, which waits for the client.
          replace();
          replace = () => {};
          if (notification.update.sessionUpdate === "agent_message_chunk") {
            answers.push((notification.update.content as any).text);
          }
        },
      },
    );
    const replacementStatus = vi.fn(async (): Promise<McpServerStatus[]> => [
      { name: "replacement", status: "connected" },
    ]);
    // The fallback warning is an await between the provider wait and the /mcp answer.
    agent.sessions["test-session"].autoModeFallbackWarningPending = true;
    replace = () => {
      agent.sessions["test-session"] = mockSessionState({
        query: Object.assign(wrapQuery((async function* () {})()), {
          mcpServerStatus: replacementStatus,
        }),
        input: new Pushable<any>(),
      });
    };

    expect((await prompt("/mcp")).stopReason).toBe("end_turn");

    expect(sdkQuery.mcpServerStatus).not.toHaveBeenCalled();
    expect(replacementStatus).toHaveBeenCalledOnce();
    expect(answers.join("")).toContain("replacement");
  });

  it("answers two /mcp prompts and a later prompt in order", async () => {
    const status = blockedStatus();
    const { events, prompt } = setup({ mcpServerStatus: status.read });

    const first = prompt("/mcp");
    await vi.waitFor(() => expect(status.read).toHaveBeenCalledTimes(1));
    const second = prompt("/mcp");
    const later = prompt("hello");
    await new Promise((resolve) => setTimeout(resolve, 10));
    // The second /mcp waits for the first one.
    expect(status.read).toHaveBeenCalledTimes(1);
    status.release();
    await vi.waitFor(() => expect(status.read).toHaveBeenCalledTimes(2));
    await new Promise((resolve) => setTimeout(resolve, 10));
    // The later prompt waits for the second /mcp.
    expect(events).toEqual(["answer"]);
    status.release();
    await Promise.all([first, second, later]);

    expect(events).toEqual(["answer", "answer", "forward hello"]);
  });

  it("holds a provider update until the /mcp answer ends", async () => {
    const status = blockedStatus();
    const { agent, prompt } = setup({ mcpServerStatus: status.read });

    const mcp = prompt("/mcp");
    await vi.waitFor(() => expect(status.read).toHaveBeenCalled());
    let updated = false;
    const update = agent
      .unstable_setProvider({
        providerId: "main",
        apiType: "anthropic",
        baseUrl: "https://gateway.example.com",
      } as any)
      .then(() => (updated = true));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(updated).toBe(false);
    status.release();

    expect((await mcp).stopReason).toBe("end_turn");
    await update;
    expect(updated).toBe(true);
  });
});

describe("/mcp reconnect", () => {
  it("reconnects the named server and shows the updated list", async () => {
    let reconnected = false;
    const { sdkQuery, forwarded, text, prompt } = setup({
      mcpServerStatus: vi.fn(async () =>
        SERVERS.map((server) =>
          server.name === "db" && reconnected
            ? { ...server, status: "connected", error: undefined, tools: [{ name: "query" }] }
            : server,
        ),
      ),
      reconnectMcpServer: vi.fn(async () => {
        reconnected = true;
      }),
    });

    const response = await prompt("/mcp reconnect db");

    expect(response.stopReason).toBe("end_turn");
    expect(forwarded).toEqual([]);
    expect(sdkQuery.reconnectMcpServer).toHaveBeenCalledExactlyOnceWith("db");
    expect(text()).toContain("- `db`: reconnected.");
    expect(text()).toContain("**Reconnect:**\n- `db`: reconnected.\n\n**MCP servers:** 5");
    expect(text()).toContain("**Connected**\n- `github`: 2 tools\n- `db`: 1 tool");
  });

  it("reconnects every server that is not connected and not disabled", async () => {
    const { sdkQuery, text, prompt } = setup();

    await prompt("/mcp reconnect");

    // The client has no URL elicitation, so `linear` gets a plain reconnect.
    expect(sdkQuery.reconnectMcpServer.mock.calls.map(([name]: [string]) => name)).toEqual([
      "linear",
      "db",
      "docs",
    ]);
    expect(text()).toContain(
      "- `linear`: reconnected.\n- `db`: reconnected.\n- `docs`: reconnected.",
    );
    expect(text()).toContain("**Failed**\n- `db`: spawn db-mcp ENOENT");
  });

  it("says when there is nothing to reconnect", async () => {
    const { sdkQuery, text, prompt } = setup({
      mcpServerStatus: vi.fn(async () => SERVERS.filter((server) => server.name === "github")),
    });

    await prompt("/mcp reconnect");

    expect(sdkQuery.reconnectMcpServer).not.toHaveBeenCalled();
    expect(text()).toContain(
      "Every MCP server is connected or disabled. There is nothing to reconnect.",
    );
  });

  it("names the known servers for an unknown server", async () => {
    const { sdkQuery, text, prompt } = setup();

    const response = await prompt("/mcp reconnect nope");

    expect(response.stopReason).toBe("end_turn");
    expect(sdkQuery.reconnectMcpServer).not.toHaveBeenCalled();
    expect(text()).toBe(
      "There is no MCP server named `nope`.\n" +
        "Known servers: `github`, `linear`, `db`, `docs`, `old`.",
    );
  });

  it("does not reconnect a disabled server", async () => {
    const { sdkQuery, text, prompt } = setup();

    await prompt("/mcp reconnect old");

    expect(sdkQuery.reconnectMcpServer).not.toHaveBeenCalled();
    expect(text()).toContain("`old` is disabled. A reconnect does not apply to a disabled server.");
  });

  it("keeps going after one server fails", async () => {
    const { sdkQuery, text, prompt } = setup({
      reconnectMcpServer: vi.fn(async (name: string) => {
        if (name === "db") throw new Error("spawn db-mcp ENOENT");
      }),
    });

    const response = await prompt("/mcp reconnect");

    expect(response.stopReason).toBe("end_turn");
    expect(sdkQuery.reconnectMcpServer).toHaveBeenCalledTimes(3);
    expect(text()).toContain("- `db`: the reconnect failed. spawn db-mcp ENOENT");
    expect(text()).toContain("- `docs`: reconnected.");
  });

  it("runs a prompt sent during a reconnect after the reconnect", async () => {
    let release!: () => void;
    const { events, prompt } = setup({
      reconnectMcpServer: vi.fn(() => new Promise<void>((resolve) => (release = resolve))),
    });

    const reconnect = prompt("/mcp reconnect db");
    await vi.waitFor(() => expect(release).toBeDefined());
    const later = prompt("hello");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(events).toEqual([]);
    release();
    await Promise.all([reconnect, later]);

    expect(events).toEqual(["answer", "forward hello"]);
  });

  it("runs the MCP OAuth flow for a server that needs authentication", async () => {
    const mcpAuthenticate = vi.fn(async () => ({
      requiresUserAction: false,
      callbackExpected: false,
    }));
    const { agent, sdkQuery, text, prompt } = setup({ mcpAuthenticate });
    await initializeClient(agent, { elicitation: { url: {} } } as any);

    await prompt("/mcp reconnect linear");

    expect(mcpAuthenticate).toHaveBeenCalledExactlyOnceWith("linear");
    expect(sdkQuery.reconnectMcpServer).not.toHaveBeenCalled();
    expect(text()).toContain("- `linear`: authenticated.");
  });

  it("says when the user declines the MCP OAuth flow", async () => {
    const mcpAuthenticate = vi.fn(async () => ({
      requiresUserAction: true,
      callbackExpected: true,
      authUrl: "https://auth.example.com/authorize",
    }));
    const createElicitation = vi.fn(async () => ({ action: "decline" }));
    const { agent, text, prompt } = setup({ mcpAuthenticate }, { createElicitation });
    await initializeClient(agent, { elicitation: { url: {} } } as any);

    const response = await prompt("/mcp reconnect linear");

    expect(response.stopReason).toBe("end_turn");
    expect(createElicitation).toHaveBeenCalledOnce();
    expect(text()).toContain(
      "- `linear`: not authenticated. The authentication flow did not finish.",
    );
  });

  it("stops on cancel and answers cancelled", async () => {
    let release!: () => void;
    const { agent, text, prompt } = setup({
      reconnectMcpServer: vi.fn(() => new Promise<void>((resolve) => (release = resolve))),
    });

    const response = prompt("/mcp reconnect db");
    await vi.waitFor(() => expect(release).toBeDefined());
    await agent.cancel({ sessionId: "test-session" });
    release();

    expect((await response).stopReason).toBe("cancelled");
    expect(text()).toBe("");
  });
});

describe("/mcp in available_commands_update", () => {
  it("advertises one mcp entry when Claude Code also has one", async () => {
    const { agent, sdkQuery } = setup();
    const sessionUpdate = vi.fn(async () => {});
    agent.client = { sessionUpdate } as unknown as AcpClient;
    Object.assign(sdkQuery, {
      supportedCommands: vi.fn(async () => [
        { name: "mcp", description: "Manage MCP servers" },
        { name: "compact", description: "Compact the conversation" },
      ]),
    });

    await (agent as any).sendAvailableCommandsUpdate("test-session");

    const update = (sessionUpdate.mock.calls[0] as any[])[0].update;
    const mcpEntries = update.availableCommands.filter(
      (command: { name: string }) => command.name === "mcp",
    );
    expect(mcpEntries).toEqual([MCP_AVAILABLE_COMMAND]);
  });
});

describe("/mcp replay", () => {
  it("hides a persisted /mcp invocation", () => {
    expect(stripLocalCommandMetadata("<command-name>/mcp</command-name>")).toBeNull();
    expect(
      stripLocalCommandMetadata(
        "<command-name>/mcp</command-name><command-args>reconnect db</command-args>",
      ),
    ).toBeNull();
  });
});
