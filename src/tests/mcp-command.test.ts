import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { McpServerStatus } from "@anthropic-ai/claude-agent-sdk";
import type { SessionNotification } from "@agentclientprotocol/sdk";
import { ClaudeAcpAgent, stripLocalCommandMetadata, type AcpClient } from "../acp-agent.js";
import {
  cleanMcpError,
  formatMcpStatus,
  isMcpCommandText,
  MCP_AVAILABLE_COMMAND,
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

/** The SDK message shapes that carry the text of a local command. `idle`
 *  ends the turn with an idle state and no result, as after an interrupt. */
type OutputShape = "system" | "assistant" | "result" | "idle";

/** The terminal text of the Claude Code `/mcp` for the prompt `text`. */
const cliText = (text: string) =>
  `CLI output of ${text}. Use \`/mcp\` in the terminal for details.`;

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

/** An agent with one session. Its fake Claude Code runs each prompt as a
 *  local command: it applies the command to `statuses`, then sends the CLI
 *  text in each of `shapes`. The query reports `statuses`, unless `query`
 *  replaces a method. `events` records the command runs, the status reads,
 *  and the answers in order. */
function setup(
  options: {
    query?: Record<string, unknown>;
    client?: Record<string, unknown>;
    shapes?: OutputShape[];
  } = {},
) {
  const shapes = options.shapes ?? ["system"];
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
      // Claude Code runs the command before it sends the text.
      const [, action, server] = text.split(/\s+/);
      const target = statuses.find((status) => status.name === server);
      if (target && action === "reconnect") target.status = "connected";
      if (target && action === "disable") target.status = "disabled";
      events.push(`run ${text}`);
      for (const shape of shapes) {
        if (shape === "system") {
          yield {
            type: "system",
            subtype: "local_command_output",
            content: cliText(text),
            uuid: randomUUID(),
            session_id: "test-session",
          };
        } else if (shape === "assistant") {
          yield syntheticAssistant(cliText(text));
        } else if (shape === "idle") {
          yield { type: "system", subtype: "session_state_changed", state: "idle" };
        } else {
          yield successfulResultMessage({ result: cliText(text) });
        }
      }
      if (!shapes.includes("result") && !shapes.includes("idle")) {
        yield successfulResultMessage();
      }
    }
  }
  const sdkQuery = Object.assign(wrapQuery(messages()), {
    mcpServerStatus: vi.fn(async () => {
      events.push("status");
      return statuses.map((status) => ({ ...status }));
    }),
    ...options.query,
  });
  agent.sessions["test-session"] = mockSessionState({ query: sdkQuery, input });
  const text = () =>
    updates
      .filter((update) => update.update.sessionUpdate === "agent_message_chunk")
      .map((update) => (update.update as any).content.text)
      .join("");
  const prompt = (command: string) =>
    agent.prompt({ sessionId: "test-session", prompt: [{ type: "text", text: command }] });
  return { agent, sdkQuery, statuses, forwarded, events, text, prompt };
}

describe("isMcpCommandText", () => {
  it("accepts the forms that Claude Code runs itself", () => {
    expect(isMcpCommandText(" /mcp ")).toBe(true);
    expect(isMcpCommandText("/mcp reconnect")).toBe(true);
    expect(isMcpCommandText("/mcp reconnect all")).toBe(true);
    expect(isMcpCommandText("/mcp Reconnect github")).toBe(true);
    expect(isMcpCommandText("/mcp enable github")).toBe(true);
    expect(isMcpCommandText("/mcp disable all")).toBe(true);
  });

  it("rejects every other prompt", () => {
    expect(isMcpCommandText("/mcp:github:prompt")).toBe(false);
    expect(isMcpCommandText("/mcp help")).toBe(false);
    expect(isMcpCommandText("/mcp list")).toBe(false);
    expect(isMcpCommandText("/mcpx")).toBe(false);
    expect(isMcpCommandText("please run /mcp")).toBe(false);
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
  it("sends /mcp to Claude Code and replaces its text with the list", async () => {
    const { forwarded, text, prompt } = setup();

    const response = await prompt("/mcp");

    expect(response.stopReason).toBe("end_turn");
    expect(forwarded).toEqual(["/mcp"]);
    expect(text()).toBe(formatMcpStatus(SERVERS));
    expect(text()).not.toContain("terminal");
  });

  it("says when no MCP server is configured", async () => {
    const { text, prompt } = setup({ query: { mcpServerStatus: vi.fn(async () => []) } });

    await prompt("/mcp");

    expect(text()).toBe("No MCP servers are configured.");
  });

  it.each(["reconnect db", "enable db", "disable db", "reconnect all"])(
    "sends /mcp %s to Claude Code and reads the list after the command",
    async (args) => {
      const { forwarded, events, text, prompt, statuses } = setup();

      await prompt(`/mcp ${args}`);

      expect(forwarded).toEqual([`/mcp ${args}`]);
      expect(events).toEqual([`run /mcp ${args}`, "status", "answer"]);
      expect(text()).toBe(formatMcpStatus(statuses));
    },
  );

  it("shows the state that the CLI command made", async () => {
    const { text, prompt } = setup();

    await prompt("/mcp reconnect db");

    expect(text()).toContain("**Connected**\n- `github`: 2 tools\n- `db`");
    expect(text()).not.toContain("**Failed**");
  });

  it("keeps the text of Claude Code when the status read fails", async () => {
    const { text, prompt } = setup({
      query: {
        mcpServerStatus: vi.fn(async () => {
          throw new Error("control channel closed");
        }),
      },
    });

    const response = await prompt("/mcp");

    expect(response.stopReason).toBe("end_turn");
    expect(text()).toBe(cliText("/mcp"));
  });

  it.each([
    [["system", "assistant"]],
    [["assistant", "system"]],
    [["system", "result"]],
    [["assistant", "result"]],
  ] as OutputShape[][][])(
    "sends the list once when Claude Code mirrors its text as %j",
    async (shapes) => {
      const { sdkQuery, text, prompt } = setup({ shapes });

      await prompt("/mcp");

      expect(text()).toBe(formatMcpStatus(SERVERS));
      expect(sdkQuery.mcpServerStatus).toHaveBeenCalledOnce();
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
      [cliText("/github:prompt (MCP)"), cliText("/mcp help"), cliText("/mcp more")].join(""),
    );
    expect(sdkQuery.mcpServerStatus).not.toHaveBeenCalled();
  });

  it("publishes nothing when a cancel comes during the status read", async () => {
    let started!: () => void;
    const reading = new Promise<void>((resolve) => (started = resolve));
    const { agent, text, prompt } = setup({
      shapes: ["system", "idle"],
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
  });
});

describe("/mcp and MCP OAuth", () => {
  it("starts the MCP OAuth flow once for a server that needs authentication", async () => {
    const mcpAuthenticate = vi.fn(async () => ({
      requiresUserAction: false,
      callbackExpected: false,
    }));
    const { agent, text, prompt } = setup({
      query: { mcpAuthenticate },
      shapes: ["system", "assistant", "result"],
    });
    await initializeClient(agent, { elicitation: { url: {} } } as any);

    await prompt("/mcp");

    await vi.waitFor(() => expect(mcpAuthenticate).toHaveBeenCalledOnce());
    expect(mcpAuthenticate).toHaveBeenCalledWith("linear");
    expect(text()).toBe(formatMcpStatus(SERVERS));
  });

  it("does not hold the turn while the MCP OAuth flow runs", async () => {
    const mcpAuthenticate = vi.fn(() => new Promise<never>(() => {}));
    const { agent, prompt } = setup({ query: { mcpAuthenticate } });
    await initializeClient(agent, { elicitation: { url: {} } } as any);

    const response = await prompt("/mcp");

    expect(response.stopReason).toBe("end_turn");
    await vi.waitFor(() => expect(mcpAuthenticate).toHaveBeenCalledOnce());
  });

  it("does not start the MCP OAuth flow without URL elicitation", async () => {
    const mcpAuthenticate = vi.fn(async () => ({
      requiresUserAction: false,
      callbackExpected: false,
    }));
    const { prompt, sdkQuery } = setup({ query: { mcpAuthenticate } });

    await prompt("/mcp");
    await Promise.resolve();

    expect(sdkQuery.mcpServerStatus).toHaveBeenCalledOnce();
    expect(mcpAuthenticate).not.toHaveBeenCalled();
  });

  it("does not start the MCP OAuth flow when the list fell back to the CLI text", async () => {
    const mcpAuthenticate = vi.fn();
    const { agent, prompt } = setup({
      query: {
        mcpAuthenticate,
        mcpServerStatus: vi.fn(async () => {
          throw new Error("control channel closed");
        }),
      },
    });
    await initializeClient(agent, { elicitation: { url: {} } } as any);

    await prompt("/mcp");
    await Promise.resolve();

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
