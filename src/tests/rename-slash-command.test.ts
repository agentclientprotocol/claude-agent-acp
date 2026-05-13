import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { AgentSideConnection, SessionNotification } from "@agentclientprotocol/sdk";

const { mockRenameSession } = vi.hoisted(() => ({
  mockRenameSession: vi.fn(async () => {}),
}));

vi.mock("@anthropic-ai/claude-agent-sdk", async () => {
  const actual = await vi.importActual<Record<string, unknown>>(
    "@anthropic-ai/claude-agent-sdk",
  );
  return {
    ...actual,
    renameSession: mockRenameSession,
  };
});

vi.mock("../tools.js", async () => ({
  createPostToolUseHook: () => () => {},
  registerHookCallback: () => {},
  toolInfoFromToolUse: () => ({}),
  toolUpdateFromDiffToolResponse: () => ({}),
  toolUpdateFromToolResult: () => ({}),
  planEntries: () => [],
}));

import { ClaudeAcpAgent } from "../acp-agent.js";
import { Pushable } from "../utils.js";

type AnyAgent = ClaudeAcpAgent & {
  sessions: Record<string, any>;
};

function createAgent(updates: SessionNotification[]): ClaudeAcpAgent {
  const mockClient = {
    sessionUpdate: async (notification: SessionNotification) => {
      updates.push(notification);
    },
  } as unknown as AgentSideConnection;
  return new ClaudeAcpAgent(mockClient, { log: () => {}, error: () => {} });
}

function injectSession(agent: AnyAgent, sessionId: string, cwd: string): Pushable<any> {
  const input = new Pushable<any>();
  async function* never(): AsyncGenerator<any> {
    // Intentionally yields nothing — if /rename short-circuits correctly, the
    // SDK loop should never advance.
    yield* [];
  }
  agent.sessions[sessionId] = {
    query: never() as any,
    input,
    cancelled: false,
    cwd,
    sessionFingerprint: JSON.stringify({ cwd, mcpServers: [] }),
    modes: { currentModeId: "default", availableModes: [] },
    models: { currentModelId: "default", availableModels: [] },
    modelInfos: [],
    settingsManager: { dispose: vi.fn() } as any,
    accumulatedUsage: {
      inputTokens: 0,
      outputTokens: 0,
      cachedReadTokens: 0,
      cachedWriteTokens: 0,
    },
    configOptions: [],
    promptRunning: false,
    pendingMessages: new Map(),
    nextPendingOrder: 0,
    abortController: new AbortController(),
    emitRawSDKMessages: false,
    contextWindowSize: 200000,
  };
  return input;
}

describe("/rename slash command", () => {
  beforeEach(() => {
    mockRenameSession.mockClear();
    mockRenameSession.mockImplementation(async () => {});
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  it("calls renameSession and confirms the new title", async () => {
    const updates: SessionNotification[] = [];
    const agent = createAgent(updates) as AnyAgent;
    injectSession(agent, "test-session", "/tmp/project");

    const response = await agent.prompt({
      sessionId: "test-session",
      prompt: [{ type: "text", text: "/rename Quarterly review notes" }],
    });

    expect(response.stopReason).toBe("end_turn");
    expect(mockRenameSession).toHaveBeenCalledExactlyOnceWith(
      "test-session",
      "Quarterly review notes",
      { dir: "/tmp/project" },
    );

    const texts = updates
      .map((u) => (u.update as any))
      .filter((u) => u.sessionUpdate === "agent_message_chunk")
      .map((u) => u.content?.text ?? "");
    expect(texts.some((t) => t.includes("Renamed session to") && t.includes("Quarterly review notes")))
      .toBe(true);
  });

  it("emits a usage hint when no title is supplied", async () => {
    const updates: SessionNotification[] = [];
    const agent = createAgent(updates) as AnyAgent;
    injectSession(agent, "test-session", "/tmp/project");

    const response = await agent.prompt({
      sessionId: "test-session",
      prompt: [{ type: "text", text: "/rename" }],
    });

    expect(response.stopReason).toBe("end_turn");
    expect(mockRenameSession).not.toHaveBeenCalled();

    const texts = updates
      .map((u) => (u.update as any))
      .filter((u) => u.sessionUpdate === "agent_message_chunk")
      .map((u) => u.content?.text ?? "");
    expect(texts.some((t) => t.includes("Usage: /rename"))).toBe(true);
  });

  it("surfaces SDK errors as a chat message rather than throwing", async () => {
    const updates: SessionNotification[] = [];
    const agent = createAgent(updates) as AnyAgent;
    injectSession(agent, "test-session", "/tmp/project");

    mockRenameSession.mockImplementation(async () => {
      throw new Error("session JSONL not found");
    });

    const response = await agent.prompt({
      sessionId: "test-session",
      prompt: [{ type: "text", text: "/rename Untitled" }],
    });

    expect(response.stopReason).toBe("end_turn");
    const texts = updates
      .map((u) => (u.update as any))
      .filter((u) => u.sessionUpdate === "agent_message_chunk")
      .map((u) => u.content?.text ?? "");
    expect(texts.some((t) => t.includes("Failed to rename session"))).toBe(true);
  });

  it("does not match /renamed or other prefixes", async () => {
    const updates: SessionNotification[] = [];
    const agent = createAgent(updates) as AnyAgent;
    injectSession(agent, "test-session", "/tmp/project");

    // The fake SDK generator yields nothing, so `agent.prompt` will surface
    // a "Session did not end in result" error from the normal loop. That's
    // fine — what we want to confirm is that we *reached* that loop instead
    // of being intercepted as a /rename call.
    await expect(
      agent.prompt({
        sessionId: "test-session",
        prompt: [{ type: "text", text: "/renamed something" }],
      }),
    ).rejects.toThrow();
    expect(mockRenameSession).not.toHaveBeenCalled();
  });
});
