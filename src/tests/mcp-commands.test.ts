import { describe, it, expect, vi } from "vitest";
import { randomUUID } from "crypto";
import type { SessionNotification } from "@agentclientprotocol/sdk";
import { ClaudeAcpAgent, type AcpClient } from "../acp-agent.js";
import { parseMcpServerCommand, runMcpServerCommand } from "../mcp-commands.js";
import { Pushable } from "../utils.js";
import {
  mockSessionState,
  successfulResultMessage,
  userEcho,
  wrapQuery,
} from "./session-doubles.js";

/** A query whose control requests move servers between states the way the CLI
 *  does: a reconnect or enable lands on `next` (connected unless told otherwise),
 *  a disable on disabled. */
function fakeQuery(initial: Record<string, string>, next: Record<string, string> = {}) {
  const statuses = { ...initial };
  return {
    statuses,
    mcpServerStatus: vi.fn(
      async () => Object.entries(statuses).map(([name, status]) => ({ name, status })) as any,
    ),
    reconnectMcpServer: vi.fn(async (name: string) => {
      statuses[name] = next[name] ?? "connected";
    }),
    toggleMcpServer: vi.fn(async (name: string, enabled: boolean) => {
      statuses[name] = enabled ? (next[name] ?? "connected") : "disabled";
    }),
  };
}

const run = (query: ReturnType<typeof fakeQuery>, text: string) =>
  runMcpServerCommand(query, parseMcpServerCommand(text)!);

describe("parseMcpServerCommand", () => {
  it("takes the three actions, with no name meaning all", () => {
    expect(parseMcpServerCommand("/mcp reconnect linear")).toEqual({
      action: "reconnect",
      serverName: "linear",
    });
    expect(parseMcpServerCommand(" /mcp Enable  my server ")).toEqual({
      action: "enable",
      serverName: "my server",
    });
    expect(parseMcpServerCommand("/mcp disable")).toEqual({
      action: "disable",
      serverName: "all",
    });
  });

  it("leaves everything else to the CLI", () => {
    expect(parseMcpServerCommand("/mcp")).toBeNull();
    expect(parseMcpServerCommand("/mcp list")).toBeNull();
    expect(parseMcpServerCommand("/mcp disconnect linear")).toBeNull();
    expect(parseMcpServerCommand("/mcp:linear:issue 42")).toBeNull();
    expect(parseMcpServerCommand("please /mcp reconnect linear")).toBeNull();
  });
});

describe("runMcpServerCommand", () => {
  it("says when nothing is configured or the name is unknown", async () => {
    expect(await run(fakeQuery({}), "/mcp reconnect")).toBe(
      "No MCP servers are configured. Add one with `claude mcp add`.",
    );
    // the CLI's IDE bridge and the adapter's own audit server are not servers the user configured
    const internal = fakeQuery({ ide: "connected", claude_agent_acp: "connected" });
    expect(await run(internal, "/mcp disable all")).toBe(
      "No MCP servers are configured. Add one with `claude mcp add`.",
    );
    expect(await run(internal, "/mcp disable claude_agent_acp")).toBe(
      'There\'s no MCP server named "claude_agent_acp". Run `/mcp` in the terminal to see configured servers.',
    );
    expect(internal.toggleMcpServer).not.toHaveBeenCalled();
    expect(await run(fakeQuery({ linear: "connected" }), "/mcp reconnect nope")).toBe(
      'There\'s no MCP server named "nope". Run `/mcp` in the terminal to see configured servers.',
    );
  });

  it("folds a status read failure into the reply", async () => {
    const query = fakeQuery({});
    query.mcpServerStatus.mockRejectedValueOnce(new Error("no session"));
    expect(await run(query, "/mcp enable linear")).toBe(
      'Couldn\'t enable "linear" — no session. Run `/mcp` in the terminal to check.',
    );
  });

  describe("reconnect <server>", () => {
    it("reconnects a server and reports the state it lands in", async () => {
      expect(await run(fakeQuery({ linear: "failed" }), "/mcp reconnect linear")).toBe(
        'Reconnected "linear".',
      );
      expect(
        await run(
          fakeQuery({ linear: "failed" }, { linear: "needs-auth" }),
          "/mcp reconnect linear",
        ),
      ).toBe(
        'Couldn\'t reconnect "linear" (needs authentication). Authenticate with `/mcp` in the terminal.',
      );
      expect(
        await run(fakeQuery({ linear: "failed" }, { linear: "failed" }), "/mcp reconnect linear"),
      ).toBe(
        'Couldn\'t reconnect "linear" (not connected). Check its config with `/mcp` in the terminal.',
      );
    });

    it("does not retry a disabled or already reconnecting server", async () => {
      const query = fakeQuery({ off: "disabled", slow: "pending" });
      expect(await run(query, "/mcp reconnect off")).toBe(
        '"off" is disabled. Run `/mcp enable off` to bring it back.',
      );
      expect(await run(query, "/mcp reconnect slow")).toBe(
        '"slow" is already reconnecting — retries can take a few minutes when a server keeps failing.',
      );
      expect(query.reconnectMcpServer).not.toHaveBeenCalled();
    });

    it("leaves out the command to retype when the name is not one plain argument", async () => {
      expect(await run(fakeQuery({ "my server": "disabled" }), "/mcp reconnect my server")).toBe(
        '"my server" is disabled.',
      );
      expect(await run(fakeQuery({ "my server": "failed" }), "/mcp enable my server")).toBe(
        '"my server" is already enabled but not connected.',
      );
    });

    it("reports a refused request with its reason", async () => {
      const query = fakeQuery({ linear: "failed" });
      query.reconnectMcpServer.mockRejectedValueOnce(new Error("spawn ENOENT"));
      expect(await run(query, "/mcp reconnect linear")).toBe(
        'Couldn\'t reconnect "linear" — spawn ENOENT. Run `/mcp` in the terminal to check.',
      );
    });
  });

  describe("reconnect all", () => {
    it("retries failed and needs-auth servers, in parallel, and counts what came up", async () => {
      const query = fakeQuery(
        { a: "connected", b: "failed", c: "needs-auth", d: "pending", off: "disabled" },
        { c: "needs-auth" },
      );
      expect(await run(query, "/mcp reconnect all")).toBe(
        "Reconnected 1 of 2 MCP server(s). Run `/mcp` in the terminal to see status.",
      );
      expect(query.reconnectMcpServer.mock.calls).toEqual([["b"], ["c"]]);
    });

    it("says when there is nothing to retry", async () => {
      expect(await run(fakeQuery({ a: "connected", off: "disabled" }), "/mcp reconnect")).toBe(
        "1 MCP server(s) are disabled. Run `/mcp enable all` to bring them back.",
      );
      expect(await run(fakeQuery({ a: "connected", d: "pending" }), "/mcp reconnect")).toBe(
        "All enabled MCP servers are already connected or connecting.",
      );
    });
  });

  describe("enable and disable <server>", () => {
    it("toggles one server", async () => {
      const query = fakeQuery({ db: "connected", off: "disabled" });
      expect(await run(query, "/mcp disable db")).toBe('Disabled "db".');
      expect(await run(query, "/mcp enable off")).toBe('Enabled "off".');
      expect(query.toggleMcpServer.mock.calls).toEqual([
        ["db", false],
        ["off", true],
      ]);
    });

    it("says when the server is already in that state", async () => {
      const query = fakeQuery({ linear: "connected", db: "failed", off: "disabled" });
      expect(await run(query, "/mcp enable linear")).toBe('"linear" is already enabled.');
      expect(await run(query, "/mcp enable db")).toBe(
        '"db" is already enabled but not connected. Run `/mcp reconnect db` to retry.',
      );
      expect(await run(query, "/mcp disable off")).toBe('"off" is already disabled.');
      expect(query.toggleMcpServer).not.toHaveBeenCalled();
    });

    it("says when an enabled server has not connected", async () => {
      expect(await run(fakeQuery({ off: "disabled" }, { off: "pending" }), "/mcp enable off")).toBe(
        'Enabled "off", but it isn\'t connected yet (connecting). Check its config with `/mcp` in the terminal.',
      );
      expect(await run(fakeQuery({ off: "disabled" }, { off: "failed" }), "/mcp enable off")).toBe(
        'Enabled "off", but it isn\'t connected yet. Check its config with `/mcp` in the terminal.',
      );
    });

    it("reports a refused request", async () => {
      const query = fakeQuery({ db: "connected", off: "disabled" });
      query.toggleMcpServer.mockRejectedValueOnce(new Error("gone"));
      expect(await run(query, "/mcp disable db")).toBe(
        "Couldn't disable \"db\" — it may have been removed, or its configuration couldn't be read. Run `/mcp` in the terminal to check.",
      );
      query.toggleMcpServer.mockRejectedValueOnce(new Error("gone"));
      expect(await run(query, "/mcp enable off")).toBe(
        'Couldn\'t enable "off" — gone. Run `/mcp` in the terminal to check.',
      );
    });
  });

  describe("enable and disable all", () => {
    it("counts what changed, what failed, and what has not connected", async () => {
      const query = fakeQuery(
        { a: "connected", x: "disabled", y: "disabled", z: "disabled" },
        {
          y: "pending",
        },
      );
      query.toggleMcpServer.mockRejectedValueOnce(new Error("boom"));
      expect(await run(query, "/mcp enable all")).toBe(
        "Enabled 2 MCP server(s) (1 enabled but not yet connected) (1 couldn't be changed). Run `/mcp` in the terminal to see status.",
      );
      expect(query.toggleMcpServer.mock.calls).toEqual([
        ["x", true],
        ["y", true],
        ["z", true],
      ]);
      expect(await run(fakeQuery({ a: "connected", b: "failed" }), "/mcp disable")).toBe(
        "Disabled 2 MCP server(s). Run `/mcp` in the terminal to see status.",
      );
    });

    it("says when every server is already there", async () => {
      expect(await run(fakeQuery({ a: "connected" }), "/mcp enable all")).toBe(
        "All MCP servers are already enabled.",
      );
      expect(await run(fakeQuery({ a: "connected", b: "failed" }), "/mcp enable all")).toBe(
        "All MCP servers are already enabled, but 1 isn't connected — reply `/mcp reconnect all` here to retry.",
      );
      expect(await run(fakeQuery({ off: "disabled" }), "/mcp disable all")).toBe(
        "All MCP servers are already disabled.",
      );
    });
  });
});

describe("prompt with /mcp server commands", () => {
  const REFUSAL = "Reconnect, enable, and disable aren't available in this session.";

  const localCommandOutput = (content: string) => ({
    type: "system",
    subtype: "local_command_output",
    content,
    uuid: randomUUID(),
    session_id: "test-session",
  });

  const syntheticAssistant = (text: string) => ({
    type: "assistant",
    parent_tool_use_id: null,
    uuid: randomUUID(),
    session_id: "test-session",
    message: {
      id: randomUUID(),
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
  });

  /** A session whose CLI answers each prompt with the frames `cli` returns for
   *  its text, the way Claude Code runs a local slash command. */
  function setup(cli: (text: string) => any[]) {
    const updates: SessionNotification[] = [];
    const agent = new ClaudeAcpAgent(
      {
        sessionUpdate: async (notification: SessionNotification) => updates.push(notification),
      } as unknown as AcpClient,
      { log: () => {}, error: () => {} },
    );
    const forwarded: string[] = [];
    const input = new Pushable<any>();
    async function* messages() {
      for await (const user of input) {
        const text = user.message.content[0].text;
        forwarded.push(text);
        yield userEcho(user);
        yield* cli(text);
        yield successfulResultMessage();
      }
    }
    const controls = fakeQuery({ linear: "failed" });
    const query = Object.assign(wrapQuery(messages()), controls);
    agent.sessions["test-session"] = mockSessionState({ query, input });
    const replies = () =>
      updates
        .filter((u) => u.update.sessionUpdate === "agent_message_chunk")
        .map((u) => (u.update as any).content.text);
    return { agent, controls, forwarded, replies };
  }

  const prompt = (agent: ClaudeAcpAgent, text: string) =>
    agent.prompt({ sessionId: "test-session", prompt: [{ type: "text", text }] });

  it("sends the command to the CLI and replaces its refusal with the action's reply", async () => {
    const { agent, controls, forwarded, replies } = setup(() => [localCommandOutput(REFUSAL)]);
    const response = await prompt(agent, "/mcp reconnect linear");
    expect(response.stopReason).toBe("end_turn");
    expect(forwarded).toEqual(["/mcp reconnect linear"]);
    expect(controls.reconnectMcpServer).toHaveBeenCalledOnce();
    expect(replies()).toEqual(['Reconnected "linear".']);
  });

  it("runs the action once when the refusal arrives in more than one message shape", async () => {
    const { agent, controls, replies } = setup(() => [
      localCommandOutput(REFUSAL),
      syntheticAssistant(REFUSAL),
    ]);
    await prompt(agent, "/mcp disable linear");
    expect(controls.toggleMcpServer.mock.calls).toEqual([["linear", false]]);
    expect(replies()).toEqual(['Disabled "linear".']);
  });

  it("keeps the CLI's own output when it does not refuse", async () => {
    const { agent, controls, replies } = setup(() => [localCommandOutput('Reconnected "linear".')]);
    await prompt(agent, "/mcp reconnect linear");
    expect(controls.reconnectMcpServer).not.toHaveBeenCalled();
    expect(replies()).toEqual(['Reconnected "linear".']);
  });

  it("leaves a plain /mcp and its output alone", async () => {
    const summary = "1 MCP server(s): 0 connected, 1 not connected, 0 disabled.";
    const { agent, controls, forwarded, replies } = setup(() => [localCommandOutput(summary)]);
    await prompt(agent, "/mcp");
    expect(forwarded).toEqual(["/mcp"]);
    expect(replies()).toEqual([summary]);
    expect(controls.mcpServerStatus).not.toHaveBeenCalled();
  });
});
