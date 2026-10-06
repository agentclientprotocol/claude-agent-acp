import { randomUUID } from "node:crypto";
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

/** The SDK message shapes that carry the text of a local command. Claude
 *  Code 2.1.286 sends `assistant` and then `result`. `system` is the
 *  dedicated shape of other builds. `idle` ends the turn with an idle state
 *  and no result, as after an interrupt. */
type OutputShape = "system" | "assistant" | "result" | "idle";

/** The text that Claude Code 2.1.286 sends in SDK mode for an action. */
const UNAVAILABLE = "Reconnect, enable, and disable aren't available in this session.";

/** The text of Claude Code in SDK mode for the prompt `text`. Claude Code
 *  does not run an action. It only refuses it. */
function cliText(text: string, statuses: McpServerStatus[]): string {
  const [command, action, ...rest] = text.split(/\s+/);
  if (command !== "/mcp" || !/^(reconnect|enable|disable)?$/.test(action ?? "")) {
    return `CLI output of ${text}.`;
  }
  if (action === undefined) {
    return `${statuses.length} MCP server(s): ${statuses.map((status) => status.name).join(", ")}. Use \`/mcp\` in the terminal for details.`;
  }
  const server = rest.join(" ");
  if (server !== "" && server !== "all" && !statuses.some((status) => status.name === server)) {
    return `There's no MCP server named "${server}". Run \`/mcp\` in the terminal to see configured servers.`;
  }
  return UNAVAILABLE;
}

function syntheticAssistant(text: string) {
  return {
    type: "assistant",
    parent_tool_use_id: null,
    uuid: randomUUID(),
    session_id: "test-session",
    message: {
      id: `local-${randomUUID()}`,
      type: "message",
      role: "assistant",
      model: "<synthetic>",
      content: [{ type: "text", text }],
      stop_reason: "stop_sequence",
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    },
  };
}

/** An agent with one session. Its fake Claude Code answers each prompt as
 *  Claude Code does in SDK mode: it changes nothing and sends its text in
 *  each of `shapes`. `beforeShape` can hold a shape back. The query reports
 *  `statuses`, and its control API changes them, unless `query` replaces a
 *  method. `acpServers` are the MCP servers of the ACP session request.
 *  `events` records the CLI runs, the status reads, the control calls, and
 *  the answers in order. */
function setup(
  options: {
    query?: Record<string, unknown>;
    client?: Record<string, unknown>;
    shapes?: OutputShape[];
    beforeShape?: (shape: OutputShape) => Promise<void>;
    acpServers?: string[];
  } = {},
) {
  const shapes = options.shapes ?? ["assistant", "result"];
  const statuses = SERVERS.map((status) => ({ ...status }));
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
      ...options.client,
    } as unknown as AcpClient,
    { log: () => {}, error: () => {} },
  );
  const input = new Pushable<any>();
  const forwarded: string[] = [];
  async function* messages() {
    for await (const user of input) {
      const text = user.message.content.map((block: any) => block.text).join(" ");
      forwarded.push(text);
      yield userEcho(user);
      events.push(`run ${text}`);
      const output = cliText(text, statuses);
      for (const shape of shapes) {
        await options.beforeShape?.(shape);
        if (shape === "system") {
          yield {
            type: "system",
            subtype: "local_command_output",
            content: output,
            uuid: randomUUID(),
            session_id: "test-session",
          };
        } else if (shape === "assistant") {
          yield syntheticAssistant(output);
        } else if (shape === "idle") {
          yield { type: "system", subtype: "session_state_changed", state: "idle" };
        } else {
          yield successfulResultMessage({ result: output });
        }
      }
      if (!shapes.includes("result") && !shapes.includes("idle")) {
        yield successfulResultMessage();
      }
    }
  }
  const find = (name: string) => {
    const status = statuses.find((candidate) => candidate.name === name);
    if (!status) throw new Error(`Server not found: ${name}`);
    return status;
  };
  const sdkQuery = Object.assign(wrapQuery(messages()), {
    mcpServerStatus: vi.fn(async () => {
      events.push("status");
      return statuses.map((status) => ({ ...status }));
    }),
    reconnectMcpServer: vi.fn(async (name: string) => {
      events.push(`reconnect ${name}`);
      const status = find(name);
      if (status.status !== "needs-auth") status.status = "connected";
    }),
    toggleMcpServer: vi.fn(async (name: string, enabled: boolean) => {
      events.push(`${enabled ? "enable" : "disable"} ${name}`);
      find(name).status = enabled ? "connected" : "disabled";
    }),
    ...options.query,
  });
  agent.sessions["test-session"] = mockSessionState({
    query: sdkQuery,
    input,
    creationParams: {
      cwd: "/test",
      mcpServers: (options.acpServers ?? []).map((name) => ({
        name,
        command: "server",
        args: [],
        env: [],
      })),
    },
  });
  const text = () =>
    updates
      .filter((update) => update.update.sessionUpdate === "agent_message_chunk")
      .map((update) => (update.update as any).content.text)
      .join("");
  const prompt = (command: string) =>
    agent.prompt({ sessionId: "test-session", prompt: [{ type: "text", text: command }] });
  return { agent, sdkQuery, statuses, forwarded, events, text, prompt };
}

/** The server list after a change of `changes` to {@link SERVERS}. */
function listAfter(changes: Record<string, McpServerStatus["status"]>): string {
  return formatMcpStatus(
    SERVERS.map((status) =>
      changes[status.name] ? { ...status, status: changes[status.name]! } : status,
    ),
  );
}

describe("parseMcpCommand", () => {
  it("parses the action, the server, and all", () => {
    expect(parseMcpCommand("/mcp")).toEqual({ action: "status" });
    expect(parseMcpCommand("/mcp reconnect")).toEqual({ action: "reconnect", all: true });
    expect(parseMcpCommand("/mcp reconnect all")).toEqual({ action: "reconnect", all: true });
    expect(parseMcpCommand("/mcp Reconnect my server")).toEqual({
      action: "reconnect",
      all: false,
      server: "my server",
    });
    expect(parseMcpCommand("/mcp disable all")).toEqual({ action: "disable", all: true });
    expect(parseMcpCommand("/mcp enable")).toEqual({ action: "enable", all: false });
    expect(parseMcpCommand(" /mcp ")).toEqual({ action: "status" });
  });

  it("rejects every other prompt", () => {
    for (const text of [
      "/mcp:github:prompt",
      "/mcp help",
      "/mcp list",
      "/mcpx",
      "please run /mcp",
    ]) {
      expect(parseMcpCommand(text)).toBeNull();
    }
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
  it("sends /mcp to Claude Code and replaces its text with the list", async () => {
    const { sdkQuery, forwarded, text, prompt } = setup();

    const response = await prompt("/mcp");

    expect(response.stopReason).toBe("end_turn");
    expect(forwarded).toEqual(["/mcp"]);
    expect(text()).toBe(formatMcpStatus(SERVERS));
    expect(text()).not.toContain("terminal");
    expect(sdkQuery.reconnectMcpServer).not.toHaveBeenCalled();
    expect(sdkQuery.toggleMcpServer).not.toHaveBeenCalled();
  });

  it("says when no MCP server is configured", async () => {
    const { text, prompt } = setup({ query: { mcpServerStatus: vi.fn(async () => []) } });

    await prompt("/mcp");

    expect(text()).toBe("No MCP servers are configured.");
  });

  it("reconnects a server through the control API after the text of Claude Code", async () => {
    const { sdkQuery, forwarded, events, text, prompt } = setup();

    await prompt("/mcp reconnect db");

    expect(forwarded).toEqual(["/mcp reconnect db"]);
    expect(events).toEqual(["run /mcp reconnect db", "status", "reconnect db", "status", "answer"]);
    expect(sdkQuery.reconnectMcpServer).toHaveBeenCalledWith("db");
    expect(text()).toBe(`- Reconnected \`db\`\n\n${listAfter({ db: "connected" })}`);
    expect(text()).not.toContain("aren't available");
  });

  it.each([
    ["disable github", "github", false, "- Disabled `github`", { github: "disabled" }],
    ["enable old", "old", true, "- Enabled `old`", { old: "connected" }],
  ] as const)(
    "runs /mcp %s through the control API",
    async (args, server, enabled, line, changes) => {
      const { sdkQuery, text, prompt } = setup();

      await prompt(`/mcp ${args}`);

      expect(sdkQuery.toggleMcpServer).toHaveBeenCalledExactlyOnceWith(server, enabled);
      expect(text()).toBe(`${line}\n\n${listAfter(changes)}`);
    },
  );

  it.each(["/mcp reconnect all", "/mcp reconnect"])(
    "%s reconnects every server that is not connected and not disabled",
    async (command) => {
      const { sdkQuery, text, prompt } = setup();

      await prompt(command);

      expect(sdkQuery.reconnectMcpServer.mock.calls).toEqual([["linear"], ["db"], ["docs"]]);
      expect(text()).toBe(
        [
          "- Reconnected `linear`\n- Reconnected `db`\n- Reconnected `docs`",
          listAfter({ db: "connected", docs: "connected" }),
        ].join("\n\n"),
      );
    },
  );

  it("disables every enabled server and enables every disabled server for all", async () => {
    const { sdkQuery, prompt } = setup();

    await prompt("/mcp disable all");
    expect(sdkQuery.toggleMcpServer.mock.calls).toEqual([
      ["github", false],
      ["linear", false],
      ["db", false],
      ["docs", false],
    ]);

    sdkQuery.toggleMcpServer.mockClear();
    await prompt("/mcp enable all");
    expect(sdkQuery.toggleMcpServer.mock.calls).toEqual([
      ["github", true],
      ["linear", true],
      ["db", true],
      ["docs", true],
      ["old", true],
    ]);
  });

  it("says when a reconnect of all has nothing to reconnect", async () => {
    const { sdkQuery, text, prompt } = setup({
      query: {
        mcpServerStatus: vi.fn(async () => [{ name: "github", status: "connected" }]),
      },
    });

    await prompt("/mcp reconnect all");

    expect(sdkQuery.reconnectMcpServer).not.toHaveBeenCalled();
    expect(text()).toBe(
      "Every MCP server is connected or disabled. There is nothing to reconnect.\n\n" +
        formatMcpStatus([{ name: "github", status: "connected" }]),
    );
  });

  it("asks for a server name for an enable without a name", async () => {
    const { sdkQuery, text, prompt } = setup();

    await prompt("/mcp disable");

    expect(sdkQuery.toggleMcpServer).not.toHaveBeenCalled();
    expect(text()).toBe(
      `Name a server or \`all\`, for example \`/mcp disable <server>\`.\n\n${formatMcpStatus(SERVERS)}`,
    );
  });

  it("keeps the unknown-server sentence of Claude Code and drops the terminal sentence", async () => {
    const { sdkQuery, text, prompt } = setup();

    await prompt("/mcp reconnect nosuch");

    expect(sdkQuery.reconnectMcpServer).not.toHaveBeenCalled();
    expect(text()).toBe(`There's no MCP server named "nosuch".\n\n${formatMcpStatus(SERVERS)}`);
  });

  it("isolates a control API error to its server", async () => {
    const { text, prompt } = setup({
      query: {
        reconnectMcpServer: vi.fn(async (name: string) => {
          if (name === "db") throw new Error("MCP startup failed: spawn db-mcp ENOENT");
        }),
      },
    });

    await prompt("/mcp reconnect all");

    expect(text()).toBe(
      [
        "- Reconnected `linear`\n- Couldn't reconnect `db`: spawn db-mcp ENOENT\n- Reconnected `docs`",
        formatMcpStatus(SERVERS),
      ].join("\n\n"),
    );
  });

  it.each(["/mcp", "/mcp reconnect db"])(
    "keeps the text of Claude Code for %s when the status read fails",
    async (command) => {
      const { sdkQuery, text, prompt } = setup({
        query: {
          mcpServerStatus: vi.fn(async () => {
            throw new Error("control channel closed");
          }),
        },
      });

      const response = await prompt(command);

      expect(response.stopReason).toBe("end_turn");
      expect(text()).toBe(cliText(command, SERVERS));
      expect(sdkQuery.reconnectMcpServer).not.toHaveBeenCalled();
    },
  );

  it.each([
    [["system", "assistant"]],
    [["assistant", "system"]],
    [["system", "result"]],
    [["assistant", "result"]],
  ] as OutputShape[][][])(
    "runs the action and sends the result once when Claude Code mirrors its text as %j",
    async (shapes) => {
      const { sdkQuery, text, prompt } = setup({ shapes });

      await prompt("/mcp reconnect db");

      expect(text()).toBe(`- Reconnected \`db\`\n\n${listAfter({ db: "connected" })}`);
      expect(sdkQuery.reconnectMcpServer).toHaveBeenCalledOnce();
      expect(sdkQuery.mcpServerStatus).toHaveBeenCalledTimes(2);
    },
  );

  it("replaces the result text when no other shape carries it", async () => {
    const { text, prompt } = setup({ shapes: ["result"] });

    await prompt("/mcp");

    expect(text()).toBe(formatMcpStatus(SERVERS));
  });

  it("leaves the text of other /mcp prompts unchanged", async () => {
    const { agent, sdkQuery, forwarded, text, prompt } = setup();

    await prompt("/mcp:github:prompt");
    await prompt("/mcp help");
    await agent.prompt({
      sessionId: "test-session",
      prompt: [
        { type: "text", text: "/mcp" },
        { type: "text", text: "more" },
      ],
    });

    // The adapter rewrites an MCP prompt command into the Claude Code form.
    expect(forwarded).toEqual(["/github:prompt (MCP)", "/mcp help", "/mcp more"]);
    expect(text()).toBe(
      ["/github:prompt (MCP)", "/mcp help", "/mcp more"]
        .map((command) => cliText(command, SERVERS))
        .join(""),
    );
    expect(sdkQuery.mcpServerStatus).not.toHaveBeenCalled();
  });

  // Claude Code ends an interrupted turn with an idle state.
  it.each([[["assistant", "result", "idle"]], [["result", "idle"]]] as OutputShape[][][])(
    "publishes nothing when a cancel comes during the status read with %j",
    async (shapes) => {
      let started!: () => void;
      const reading = new Promise<void>((resolve) => (started = resolve));
      const { agent, text, prompt } = setup({
        shapes,
        query: {
          mcpServerStatus: vi.fn(
            () =>
              new Promise<McpServerStatus[]>(() => {
                started();
              }),
          ),
        },
      });

      const response = prompt("/mcp");
      await reading;
      await agent.cancel({ sessionId: "test-session" });

      expect((await response).stopReason).toBe("cancelled");
      expect(text()).toBe("");
    },
  );

  it("stops the actions and publishes nothing when a cancel comes during a reconnect", async () => {
    let started!: () => void;
    const reconnecting = new Promise<void>((resolve) => (started = resolve));
    const reconnectMcpServer = vi.fn(
      () =>
        new Promise<void>(() => {
          started();
        }),
    );
    const { agent, text, prompt } = setup({
      shapes: ["assistant", "result", "idle"],
      query: { reconnectMcpServer },
    });

    const response = prompt("/mcp reconnect all");
    await reconnecting;
    await agent.cancel({ sessionId: "test-session" });

    expect((await response).stopReason).toBe("cancelled");
    expect(text()).toBe("");
    expect(reconnectMcpServer).toHaveBeenCalledOnce();
  });
});

describe("/mcp and MCP OAuth", () => {
  const authenticated = () =>
    vi.fn(async (_server: string) => ({ requiresUserAction: false, callbackExpected: false }));

  async function oauthSetup(options: Parameters<typeof setup>[0] = {}) {
    const mcpAuthenticate = authenticated();
    const harness = setup({ ...options, query: { mcpAuthenticate, ...options.query } });
    await initializeClient(harness.agent, { elicitation: { url: {} } } as any);
    return { ...harness, mcpAuthenticate };
  }

  it("starts the MCP OAuth flow after an explicit reconnect of an ACP server", async () => {
    const { mcpAuthenticate, text, prompt } = await oauthSetup({ acpServers: ["linear"] });

    await prompt("/mcp reconnect linear");

    await vi.waitFor(() => expect(mcpAuthenticate).toHaveBeenCalledOnce());
    expect(mcpAuthenticate).toHaveBeenCalledWith("linear");
    expect(text()).toBe(`- Reconnected \`linear\`\n\n${formatMcpStatus(SERVERS)}`);
  });

  it("starts the MCP OAuth flow only for the ACP servers of a reconnect of all", async () => {
    const statuses: McpServerStatus[] = [
      { name: "acp", status: "needs-auth" },
      { name: "user", status: "needs-auth" },
    ];
    const { mcpAuthenticate, prompt } = await oauthSetup({
      acpServers: ["acp"],
      query: { mcpServerStatus: vi.fn(async () => statuses), reconnectMcpServer: vi.fn() },
    });

    await prompt("/mcp reconnect all");

    await vi.waitFor(() => expect(mcpAuthenticate).toHaveBeenCalledOnce());
    expect(mcpAuthenticate).toHaveBeenCalledWith("acp");
  });

  it("does not start the MCP OAuth flow for a plain /mcp", async () => {
    const { mcpAuthenticate, sdkQuery, prompt } = await oauthSetup({ acpServers: ["linear"] });

    await prompt("/mcp");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(sdkQuery.mcpServerStatus).toHaveBeenCalledOnce();
    expect(mcpAuthenticate).not.toHaveBeenCalled();
  });

  it("does not start the MCP OAuth flow for a server that is not from the ACP request", async () => {
    const { mcpAuthenticate, prompt } = await oauthSetup();

    await prompt("/mcp reconnect linear");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(mcpAuthenticate).not.toHaveBeenCalled();
  });

  it("does not start the MCP OAuth flow when the turn was cancelled", async () => {
    let releaseResult!: () => void;
    const resultHeld = new Promise<void>((resolve) => (releaseResult = resolve));
    const { agent, mcpAuthenticate, text, prompt } = await oauthSetup({
      acpServers: ["linear"],
      shapes: ["assistant", "result", "idle"],
      beforeShape: (shape) => (shape === "result" ? resultHeld : Promise.resolve()),
    });

    const response = prompt("/mcp reconnect linear");
    await vi.waitFor(() => expect(text()).toContain("Reconnected `linear`"));
    await agent.cancel({ sessionId: "test-session" });
    releaseResult();

    expect((await response).stopReason).toBe("cancelled");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mcpAuthenticate).not.toHaveBeenCalled();
  });

  it("does not hold the turn while the MCP OAuth flow runs", async () => {
    const mcpAuthenticate = vi.fn(() => new Promise<never>(() => {}));
    const { agent, prompt } = setup({ query: { mcpAuthenticate }, acpServers: ["linear"] });
    await initializeClient(agent, { elicitation: { url: {} } } as any);

    const response = await prompt("/mcp reconnect linear");

    expect(response.stopReason).toBe("end_turn");
    await vi.waitFor(() => expect(mcpAuthenticate).toHaveBeenCalledOnce());
  });

  it("does not start the MCP OAuth flow without URL elicitation", async () => {
    const mcpAuthenticate = authenticated();
    const { prompt } = setup({ query: { mcpAuthenticate }, acpServers: ["linear"] });

    await prompt("/mcp reconnect linear");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(mcpAuthenticate).not.toHaveBeenCalled();
  });

  it("does not start the MCP OAuth flow when the result fell back to the CLI text", async () => {
    const { mcpAuthenticate, prompt } = await oauthSetup({
      acpServers: ["linear"],
      query: {
        mcpServerStatus: vi.fn(async () => {
          throw new Error("control channel closed");
        }),
      },
    });

    await prompt("/mcp reconnect linear");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(mcpAuthenticate).not.toHaveBeenCalled();
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
