import { describe, it, expect } from "vitest";
import { randomUUID } from "crypto";
import type { PromptResponse } from "@agentclientprotocol/sdk";
import { ClaudeAcpAgent, type AcpClient } from "../acp-agent.js";
import { mockSessionState, wrapQuery } from "./session-doubles.js";
import { Pushable } from "../utils.js";

/**
 * Which assistant message a prompt ended on.
 *
 * `resumeSessionAt` keys on an `SDKAssistantMessage.uuid`, so a client that
 * keeps this one can later re-enter the conversation at exactly the point this
 * prompt reached — rather than at wherever the session has since got to. Every
 * case here compares the uuid the SDK emitted with the uuid the response
 * returned: the claim is that they are the same string.
 *
 * The Anthropic API message id (`msg_…`) is a different identity and is what the
 * ACP `messageId` already carries; the prompt's own uuid names the question
 * rather than the answer. Neither is what this reports.
 */

function createMockAgent(): ClaudeAcpAgent {
  const mockClient = { sessionUpdate: async () => {} } as unknown as AcpClient;
  return new ClaudeAcpAgent(mockClient, { log: () => {}, error: () => {} });
}

/** One top-level assistant message, with the uuid a caller wants back. */
function assistantMessage(uuid: string, text: string, parentToolUseId: string | null = null) {
  return {
    type: "assistant" as const,
    parent_tool_use_id: parentToolUseId,
    error: null,
    uuid,
    session_id: "test-session",
    message: {
      id: `msg-${uuid}`,
      type: "message",
      role: "assistant",
      container: null,
      model: "claude-sonnet-4-20250514",
      content: [{ type: "text", text, citations: null }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: {
        input_tokens: 1,
        output_tokens: 1,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
        server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
        service_tier: null,
        cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 },
      },
    },
  } as any;
}

function resultMessage(overrides: Record<string, unknown> = {}) {
  return {
    type: "result" as const,
    subtype: "success",
    stop_reason: null,
    is_error: false,
    result: "",
    errors: [],
    duration_ms: 0,
    duration_api_ms: 0,
    num_turns: 1,
    total_cost_usd: 0,
    usage: {
      input_tokens: 10,
      output_tokens: 5,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
    modelUsage: {},
    permission_denials: [],
    uuid: randomUUID(),
    session_id: "test-session",
    ...overrides,
  };
}

const IDLE = { type: "system", subtype: "session_state_changed", state: "idle" };

/**
 * Install a session that replays this prompt's echo and then `messages`.
 *
 * The echo is what promotes the turn to active, so anything after it is
 * attributed to that turn — which is the attribution these cases are about.
 */
function injectSession(agent: ClaudeAcpAgent, sessionId: string, messages: any[]) {
  const input = new Pushable<any>();
  async function* messageGenerator() {
    const iter = input[Symbol.asyncIterator]();
    const { value: userMessage, done } = await iter.next();
    if (!done && userMessage) {
      yield {
        type: "user",
        message: userMessage.message,
        parent_tool_use_id: null,
        uuid: userMessage.uuid,
        session_id: sessionId,
        isReplay: true,
      };
    }
    yield* messages;
  }
  agent.sessions[sessionId] = mockSessionState({
    query: wrapQuery(messageGenerator()),
    input,
  });
}

function checkpointOf(response: PromptResponse): unknown {
  return (response._meta as any)?.claudeCode?.assistantMessageUuid;
}

describe("prompt checkpoint metadata", () => {
  it("returns the exact uuid of the assistant message the turn ended on", async () => {
    const agent = createMockAgent();
    const emitted = randomUUID();
    injectSession(agent, "test-session", [
      assistantMessage(emitted, "the answer"),
      resultMessage(),
      IDLE,
    ]);

    const response = await agent.prompt({
      sessionId: "test-session",
      prompt: [{ type: "text", text: "test" }],
    });

    expect(response.stopReason).toBe("end_turn");
    expect(checkpointOf(response)).toBe(emitted);
  });

  it("reports the last assistant message when a turn produced several", async () => {
    const agent = createMockAgent();
    const first = randomUUID();
    const last = randomUUID();
    injectSession(agent, "test-session", [
      assistantMessage(first, "thinking about it"),
      assistantMessage(last, "the answer"),
      resultMessage(),
      IDLE,
    ]);

    const response = await agent.prompt({
      sessionId: "test-session",
      prompt: [{ type: "text", text: "test" }],
    });

    // Where the turn ENDED, not where it started. Resuming from the first would
    // re-enter the conversation before work this turn had already done.
    expect(checkpointOf(response)).toBe(last);
    expect(checkpointOf(response)).not.toBe(first);
  });

  it("ignores subagent messages", async () => {
    const agent = createMockAgent();
    const top = randomUUID();
    const subagent = randomUUID();
    injectSession(agent, "test-session", [
      assistantMessage(top, "the answer"),
      assistantMessage(subagent, "a subagent talking", "tool-use-1"),
      resultMessage(),
      IDLE,
    ]);

    const response = await agent.prompt({
      sessionId: "test-session",
      prompt: [{ type: "text", text: "test" }],
    });

    // A subagent's message is not this turn's answer, and resuming from one
    // would re-enter the conversation inside a tool call.
    expect(checkpointOf(response)).toBe(top);
  });

  it("reports the SDK uuid, not the Anthropic API message id", async () => {
    const agent = createMockAgent();
    const emitted = randomUUID();
    injectSession(agent, "test-session", [
      assistantMessage(emitted, "the answer"),
      resultMessage(),
      IDLE,
    ]);

    const response = await agent.prompt({
      sessionId: "test-session",
      prompt: [{ type: "text", text: "test" }],
    });

    // Two different identities on one message. `resumeSessionAt` keys on the
    // SDK uuid; the `msg_...` id is what the ACP `messageId` already carries,
    // and reporting it here would give a client something it cannot resume
    // from.
    expect(checkpointOf(response)).toBe(emitted);
    expect(checkpointOf(response)).not.toBe(`msg-${emitted}`);
  });

  it("names no message when the turn produced none", async () => {
    const agent = createMockAgent();
    injectSession(agent, "test-session", [resultMessage(), IDLE]);

    const response = await agent.prompt({
      sessionId: "test-session",
      prompt: [{ type: "text", text: "test" }],
    });

    expect(response.stopReason).toBe("end_turn");
    // Nothing was said, so there is no point to resume from — and an empty
    // `claudeCode.assistantMessageUuid` would be an answer this adapter does
    // not have.
    expect(checkpointOf(response)).toBeUndefined();
  });

  it("gives interleaved sessions their own uuids", async () => {
    // Two sessions answering at once. A response built from a session-global
    // "last assistant message" would hand one of them the other's answer.
    const agent = createMockAgent();
    const alpha = randomUUID();
    const beta = randomUUID();
    injectSession(agent, "session-alpha", [
      assistantMessage(alpha, "alpha answer"),
      resultMessage({ session_id: "session-alpha" }),
      IDLE,
    ]);
    injectSession(agent, "session-beta", [
      assistantMessage(beta, "beta answer"),
      resultMessage({ session_id: "session-beta" }),
      IDLE,
    ]);

    const [first, second] = await Promise.all([
      agent.prompt({ sessionId: "session-alpha", prompt: [{ type: "text", text: "a" }] }),
      agent.prompt({ sessionId: "session-beta", prompt: [{ type: "text", text: "b" }] }),
    ]);

    expect(checkpointOf(first)).toBe(alpha);
    expect(checkpointOf(second)).toBe(beta);
  });
});
