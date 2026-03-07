import { describe, it, expect, beforeEach, vi } from "vitest";
import { AgentSideConnection, SessionNotification } from "@agentclientprotocol/sdk";
import type { ClaudeAcpAgent as ClaudeAcpAgentType } from "../acp-agent.js";

vi.mock("../tools.js", async () => {
  const actual = await vi.importActual<typeof import("../tools.js")>("../tools.js");
  return {
    ...actual,
    registerHookCallback: vi.fn(),
  };
});

const SESSION_ID = "test-session-id";
const UUID = "00000000-0000-0000-0000-000000000000";

// Minimal messages matching SDK types
function taskNotification(taskId: string) {
  return {
    type: "system" as const,
    subtype: "task_notification" as const,
    task_id: taskId,
    status: "completed" as const,
    output_file: `/tmp/tasks/${taskId}.output`,
    summary: `Background task ${taskId} completed`,
    uuid: UUID,
    session_id: SESSION_ID,
  };
}

function initMessage() {
  return {
    type: "system" as const,
    subtype: "init" as const,
    apiKeySource: "api_key" as const,
    claude_code_version: "1.0.0",
    cwd: "/tmp",
    tools: [],
    mcp_servers: [],
    model: "claude-haiku-4-5",
    permissionMode: "default" as const,
    slash_commands: [],
    output_style: "text",
    skills: [],
    plugins: [],
    uuid: UUID,
    session_id: SESSION_ID,
  };
}

function streamEvent(text: string) {
  return {
    type: "stream_event" as const,
    event: {
      type: "content_block_delta" as const,
      index: 0,
      delta: { type: "text_delta" as const, text },
    },
    parent_tool_use_id: null,
    uuid: UUID,
    session_id: SESSION_ID,
  };
}

function assistantMessage(text: string) {
  return {
    type: "assistant" as const,
    message: {
      content: [{ type: "text" as const, text }],
      model: "claude-haiku-4-5",
    },
    parent_tool_use_id: null,
    uuid: UUID,
    session_id: SESSION_ID,
  };
}

function resultSuccess(text: string) {
  return {
    type: "result" as const,
    subtype: "success" as const,
    duration_ms: 100,
    duration_api_ms: 50,
    is_error: false,
    num_turns: 1,
    result: text,
    stop_reason: "end_turn",
    total_cost_usd: 0.001,
    usage: {
      input_tokens: 10,
      output_tokens: 5,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
    modelUsage: {
      "claude-haiku-4-5": {
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        contextWindow: 200000,
      },
    },
    permission_denials: [],
    uuid: UUID,
    session_id: SESSION_ID,
  };
}

describe("background task drain", () => {
  let agent: ClaudeAcpAgentType;
  let ClaudeAcpAgent: typeof ClaudeAcpAgentType;
  let sessionUpdates: SessionNotification[];

  function createMockClient(): AgentSideConnection {
    return {
      sessionUpdate: async (notification: SessionNotification) => {
        sessionUpdates.push(notification);
      },
      requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
      readTextFile: async () => ({ content: "" }),
      writeTextFile: async () => ({}),
    } as unknown as AgentSideConnection;
  }

  beforeEach(async () => {
    sessionUpdates = [];
    vi.resetModules();
    const acpAgent = await import("../acp-agent.js");
    ClaudeAcpAgent = acpAgent.ClaudeAcpAgent;
    agent = new ClaudeAcpAgent(createMockClient());
  });

  function populateSession(generatorMessages: unknown[]) {
    const input = { push: vi.fn() };
    const query = (async function* () {
      for (const msg of generatorMessages) {
        yield msg;
      }
    })();

    (agent as unknown as { sessions: Record<string, unknown> }).sessions[SESSION_ID] = {
      query,
      input,
      cancelled: false,
      promptRunning: false,
      pendingMessages: new Map(),
      nextPendingOrder: 0,
      accumulatedUsage: {
        inputTokens: 0,
        outputTokens: 0,
        cachedReadTokens: 0,
        cachedWriteTokens: 0,
      },
    };
  }

  it("skips background task turn and processes real response", async () => {
    // Generator yields: background task turn, then real response
    populateSession([
      // Background task turn
      taskNotification("bg-task-1"),
      initMessage(),
      streamEvent("background output"),
      assistantMessage("background output"),
      resultSuccess("background output"),
      // Real response
      initMessage(),
      streamEvent("HELLO"),
      assistantMessage("HELLO"),
      resultSuccess("HELLO"),
    ]);

    const response = await agent.prompt({
      sessionId: SESSION_ID,
      prompt: [{ type: "text", text: "say hello" }],
    });

    expect(response.stopReason).toBe("end_turn");

    // Only the real response's stream events should have been sent
    const textChunks = sessionUpdates
      .filter((n) => n.update.sessionUpdate === "agent_message_chunk")
      .map((n) => (n.update as any).content?.text)
      .filter(Boolean);

    expect(textChunks).not.toContain("background output");
    expect(textChunks.join("")).toContain("HELLO");
  });

  it("drains multiple background task turns", async () => {
    populateSession([
      // Background task 1
      taskNotification("bg-1"),
      initMessage(),
      streamEvent("task 1 done"),
      resultSuccess("task 1 done"),
      // Background task 2
      taskNotification("bg-2"),
      initMessage(),
      streamEvent("task 2 done"),
      resultSuccess("task 2 done"),
      // Background task 3
      taskNotification("bg-3"),
      initMessage(),
      streamEvent("task 3 done"),
      resultSuccess("task 3 done"),
      // Real response
      initMessage(),
      streamEvent("HELLO"),
      resultSuccess("HELLO"),
    ]);

    const response = await agent.prompt({
      sessionId: SESSION_ID,
      prompt: [{ type: "text", text: "say hello" }],
    });

    expect(response.stopReason).toBe("end_turn");

    const textChunks = sessionUpdates
      .filter((n) => n.update.sessionUpdate === "agent_message_chunk")
      .map((n) => (n.update as any).content?.text)
      .filter(Boolean);

    expect(textChunks).not.toContain("task 1 done");
    expect(textChunks).not.toContain("task 2 done");
    expect(textChunks).not.toContain("task 3 done");
    expect(textChunks.join("")).toContain("HELLO");
  });

  it("works normally when no background tasks are pending", async () => {
    populateSession([
      // Just a normal response, no background tasks
      initMessage(),
      streamEvent("HELLO"),
      resultSuccess("HELLO"),
    ]);

    const response = await agent.prompt({
      sessionId: SESSION_ID,
      prompt: [{ type: "text", text: "say hello" }],
    });

    expect(response.stopReason).toBe("end_turn");

    const textChunks = sessionUpdates
      .filter((n) => n.update.sessionUpdate === "agent_message_chunk")
      .map((n) => (n.update as any).content?.text)
      .filter(Boolean);

    expect(textChunks.join("")).toContain("HELLO");
  });
});
