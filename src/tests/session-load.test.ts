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
});
