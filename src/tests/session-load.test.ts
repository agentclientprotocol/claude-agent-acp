import { describe, it, expect } from "vitest";
import { randomUUID } from "crypto";
import { AgentSideConnection, RequestError, SessionNotification } from "@agentclientprotocol/sdk";
import { query, getSessionMessages } from "@anthropic-ai/claude-agent-sdk";
import { ClaudeAcpAgent } from "../acp-agent.js";
import { Pushable } from "../utils.js";
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

function createMockClient(): AgentSideConnection {
  return {
    sessionUpdate: async (_notification: SessionNotification) => {},
    requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
    readTextFile: async () => ({ content: "" }),
    writeTextFile: async () => ({}),
  } as unknown as AgentSideConnection;
}

describe.skipIf(!process.env.RUN_INTEGRATION_TESTS)("session load/resume lifecycle", () => {
  it("SDK: session created but never prompted has no messages and is not resumable", async () => {
    // Create a session via the SDK, initialize it, but never send a prompt
    const sessionId = randomUUID();
    const input = new Pushable<SDKUserMessage>();

    const q = query({
      prompt: input,
      options: {
        systemPrompt: { type: "preset", preset: "claude_code" },
        sessionId,
        settingSources: ["user", "project", "local"],
        includePartialMessages: true,
      },
    });

    // initializationResult() works without needing a prompt pushed
    const initResult = await q.initializationResult();
    expect(initResult).toBeDefined();

    // Close without ever prompting
    input.end();
    q.return(undefined);

    // Verify no messages were stored
    const messages = await getSessionMessages(sessionId);
    expect(messages).toEqual([]);

    // Verify the session is not resumable
    const input2 = new Pushable<SDKUserMessage>();
    const q2 = query({
      prompt: input2,
      options: {
        systemPrompt: { type: "preset", preset: "claude_code" },
        resume: sessionId,
        settingSources: ["user", "project", "local"],
        includePartialMessages: true,
      },
    });

    await expect(q2.initializationResult()).rejects.toThrow(
      /No conversation found with session ID/,
    );

    input2.end();
    q2.return(undefined);
  }, 30000);

  it("ACP: loadSession throws resourceNotFound for a non-existent session", async () => {
    const agent = new ClaudeAcpAgent(createMockClient());
    const bogusSessionId = randomUUID();

    try {
      await expect(
        agent.loadSession({
          sessionId: bogusSessionId,
          cwd: process.cwd(),
          mcpServers: [],
        }),
      ).rejects.toThrow(RequestError);
    } finally {
      await agent.dispose();
    }
  }, 30000);

  it("ACP: resumeSession throws resourceNotFound for a non-existent session", async () => {
    const agent = new ClaudeAcpAgent(createMockClient());
    const bogusSessionId = randomUUID();

    try {
      await expect(
        agent.resumeSession({
          sessionId: bogusSessionId,
          cwd: process.cwd(),
          mcpServers: [],
        }),
      ).rejects.toThrow(RequestError);
    } finally {
      await agent.dispose();
    }
  }, 30000);

  it("ACP: newSession without prompt, then loadSession on fresh agent throws resourceNotFound", async () => {
    // Step 1: Create a real session via ACP, never prompt, dispose
    const agentA = new ClaudeAcpAgent(createMockClient());
    const { sessionId } = await agentA.newSession({
      cwd: process.cwd(),
      mcpServers: [],
    });
    expect(sessionId).toBeDefined();
    await agentA.dispose();

    // Step 2: Fresh agent tries to load that session
    const agentB = new ClaudeAcpAgent(createMockClient());

    try {
      await expect(
        agentB.loadSession({
          sessionId,
          cwd: process.cwd(),
          mcpServers: [],
        }),
      ).rejects.toThrow(RequestError);
    } finally {
      await agentB.dispose();
    }
  }, 30000);

  it("ACP: newSession without prompt, then resumeSession on fresh agent throws resourceNotFound", async () => {
    const agentA = new ClaudeAcpAgent(createMockClient());
    const { sessionId } = await agentA.newSession({
      cwd: process.cwd(),
      mcpServers: [],
    });
    await agentA.dispose();

    const agentB = new ClaudeAcpAgent(createMockClient());

    try {
      await expect(
        agentB.resumeSession({
          sessionId,
          cwd: process.cwd(),
          mcpServers: [],
        }),
      ).rejects.toThrow(RequestError);
    } finally {
      await agentB.dispose();
    }
  }, 30000);

  // Regression test for https://github.com/zed-industries/claude-code-acp/issues/579
  // The client (Zed) renders its own local slash commands — e.g. `/model` —
  // by injecting user-message prompts whose text is wrapped in
  // `<command-name>` / `<local-command-stdout>` markers. The Claude SDK
  // persists those messages verbatim in the session transcript. Without
  // filtering, `loadSession` replays the markers as user_message_chunks
  // ahead of the real prompt, leaking CLI internals into the transcript.
  it("ACP: loadSession does not replay local-command metadata user messages", async () => {
    const recordedUserChunks: string[] = [];
    const client = {
      sessionUpdate: async (notification: SessionNotification) => {
        if (notification.update.sessionUpdate === "user_message_chunk") {
          const content = notification.update.content;
          if (content.type === "text") recordedUserChunks.push(content.text);
        }
      },
      requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
      readTextFile: async () => ({ content: "" }),
      writeTextFile: async () => ({}),
    } as unknown as AgentSideConnection;

    const commandName =
      "<command-name>/model</command-name>\n            <command-message>model</command-message>\n            <command-args>opus</command-args>";
    const commandStdout =
      "<local-command-stdout>Set model to opus (claude-opus-4-7)</local-command-stdout>";

    // Step 1: create a session via the SDK, push the marker user messages
    // followed by a real "hi" prompt. We bypass the ACP agent's prompt loop
    // so we're only testing what the loadSession replay path does, not how
    // prompts get routed.
    const sessionId = randomUUID();
    const input = new Pushable<SDKUserMessage>();
    const q = query({
      prompt: input,
      options: {
        systemPrompt: { type: "preset", preset: "claude_code" },
        sessionId,
        settingSources: ["user", "project", "local"],
        includePartialMessages: true,
      },
    });
    await q.initializationResult();

    // Zed renders its local slash commands by mixing the marker blocks into
    // the user's prompt content array alongside the real text. The Claude
    // SDK persists the message verbatim — including the marker blocks —
    // which is what loadSession must filter when it replays.
    input.push({
      type: "user",
      message: {
        role: "user",
        content: [
          { type: "text", text: commandName },
          { type: "text", text: commandStdout },
          { type: "text", text: "hi" },
        ],
      },
      session_id: sessionId,
      parent_tool_use_id: null,
    });

    for await (const msg of q) {
      if (msg.type === "result") break;
    }
    input.end();
    q.return(undefined);

    // Sanity check: the SDK transcript contains the metadata we're filtering.
    const sdkMessages = await getSessionMessages(sessionId);
    const sdkTexts = sdkMessages
      .map((m) => {
        const c = (m as { message?: { content?: unknown } }).message?.content;
        if (typeof c === "string") return c;
        if (Array.isArray(c))
          return c
            .map((b) =>
              b && typeof b === "object" && "text" in b
                ? String((b as { text: unknown }).text)
                : "",
            )
            .join("");
        return "";
      })
      .join("\n");
    expect(sdkTexts).toContain("<command-name>");
    expect(sdkTexts).toContain("<local-command-stdout>");
    expect(sdkTexts).toContain("hi");

    // Step 2: load the session through the ACP agent and confirm the markers
    // never reach the client as user_message_chunks, while the real "hi"
    // prompt does.
    const agent = new ClaudeAcpAgent(client);
    try {
      await agent.loadSession({
        sessionId,
        cwd: process.cwd(),
        mcpServers: [],
      });
    } finally {
      await agent.dispose();
    }

    for (const chunk of recordedUserChunks) {
      expect(chunk).not.toContain("<command-name>");
      expect(chunk).not.toContain("<command-message>");
      expect(chunk).not.toContain("<command-args>");
      expect(chunk).not.toContain("<local-command-stdout>");
      expect(chunk).not.toContain("<local-command-stderr>");
    }
    expect(recordedUserChunks.some((c) => c.includes("hi"))).toBe(true);
  }, 60000);

  // Second regression: the original issue showed the markers and the real
  // "hi" prompt all concatenated into a single string ending with "hi".
  // loadSession must strip the marker tags in-place rather than dropping the
  // whole message.
  it("ACP: loadSession strips marker tags from a concatenated single-string prompt", async () => {
    const recordedUserChunks: string[] = [];
    const client = {
      sessionUpdate: async (notification: SessionNotification) => {
        if (notification.update.sessionUpdate === "user_message_chunk") {
          const content = notification.update.content;
          if (content.type === "text") recordedUserChunks.push(content.text);
        }
      },
      requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
      readTextFile: async () => ({ content: "" }),
      writeTextFile: async () => ({}),
    } as unknown as AgentSideConnection;

    // Exact shape from https://github.com/zed-industries/claude-code-acp/issues/579.
    const concatenated =
      "<command-name>/model</command-name>\n            <command-message>model</command-message>\n            <command-args>opus</command-args>" +
      "<local-command-stdout>Set model to opus (claude-opus-4-7)</local-command-stdout>\n" +
      "<command-name>/model</command-name>\n            <command-message>model</command-message>\n            <command-args>opus[1m]</command-args>" +
      "<local-command-stdout>Set model to opus[1m] (claude-opus-4-7[1m])</local-command-stdout>" +
      "hi";

    const sessionId = randomUUID();
    const input = new Pushable<SDKUserMessage>();
    const q = query({
      prompt: input,
      options: {
        systemPrompt: { type: "preset", preset: "claude_code" },
        sessionId,
        settingSources: ["user", "project", "local"],
        includePartialMessages: true,
      },
    });
    await q.initializationResult();

    input.push({
      type: "user",
      message: { role: "user", content: concatenated },
      session_id: sessionId,
      parent_tool_use_id: null,
    });
    for await (const msg of q) {
      if (msg.type === "result") break;
    }
    input.end();
    q.return(undefined);

    const agent = new ClaudeAcpAgent(client);
    try {
      await agent.loadSession({
        sessionId,
        cwd: process.cwd(),
        mcpServers: [],
      });
    } finally {
      await agent.dispose();
    }

    expect(recordedUserChunks.length).toBeGreaterThan(0);
    for (const chunk of recordedUserChunks) {
      expect(chunk).not.toContain("<command-name>");
      expect(chunk).not.toContain("<command-message>");
      expect(chunk).not.toContain("<command-args>");
      expect(chunk).not.toContain("<local-command-stdout>");
      expect(chunk).not.toContain("<local-command-stderr>");
    }
    expect(recordedUserChunks.some((c) => c.includes("hi"))).toBe(true);
  }, 60000);
});
