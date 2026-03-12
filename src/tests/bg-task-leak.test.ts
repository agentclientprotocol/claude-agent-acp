/**
 * Tests for background task notification leak across prompt turns.
 *
 * Bug: when a subagent launches a background Bash task (run_in_background),
 * and the background task completes after the main turn's `result` message,
 * the SDK yields additional messages (task_notification, assistant response,
 * second result) that belong to an "internal turn." The adapter's prompt()
 * currently returns at the first `result`, leaving the internal turn's
 * messages in the iterator buffer. The next prompt() call picks them up,
 * causing the model to respond to the background task output instead of
 * the user's actual message.
 *
 * Evidence: captured from x.sdk-trace-bg-leak.ndjson (real SDK output).
 *
 * The SDK iterator yields this sequence for one ACP prompt turn:
 *
 *   [0..146]  system/init, stream_events, assistant, user messages (normal turn)
 *   [147]     stream_event/message_stop (end of streaming)
 *   [148]     result/success         ← USER TURN ENDS (prompt() returns here today)
 *   [149]     system/task_notification ← bg bash task completed
 *   [150]     system/init            ← internal turn starts
 *   [151-167] stream_event deltas    ← model responding to task_notification
 *   [168]     assistant message      ← "The background task completed..."
 *   [169-171] stream_event stop      ← streaming ends
 *   [172]     result/success         ← INTERNAL TURN ENDS
 *
 * The fix should NOT return the prompt response until the iterator is truly
 * idle — meaning all internal turns (task_notification → assistant → result)
 * have been consumed. Intermediate messages should be forwarded as ACP
 * session/update notifications.
 */

import { describe, it, expect, vi } from "vitest";
import { ClaudeAcpAgent } from "../acp-agent.js";
import type { AgentSideConnection } from "@agentclientprotocol/sdk";
import type { Query, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { Pushable } from "../utils.js";

// ── Mock helpers ─────────────────────────────────────────────────────

/**
 * Creates a mock Query (AsyncGenerator) that yields messages in sequence.
 * After all messages are consumed, next() blocks forever (simulates idle SDK).
 */
function createMockQuery(messages: any[]): Query {
  // Simulate the SDK's internal queue structure (q4.queue in cli.js).
  // The real SDK's Query wraps an inputStream with a queue array.
  // Messages are pre-loaded into the queue so that
  // `query.inputStream.queue.length` returns the number of unconsumed
  // messages — this is how prompt() detects internal turns without
  // consuming from the iterator.
  const queue = [...messages];
  const gen = {
    async next(): Promise<IteratorResult<any, void>> {
      if (queue.length > 0) {
        return { value: queue.shift(), done: false };
      }
      // Block forever — simulates SDK waiting for next user input
      return new Promise(() => {});
    },
    async return(): Promise<IteratorResult<any, void>> {
      return { value: undefined, done: true };
    },
    async throw(e: any): Promise<IteratorResult<any, void>> {
      throw e;
    },
    [Symbol.asyncIterator]() {
      return gen;
    },
    // Expose inputStream.queue to match SDK internals
    inputStream: { queue },
    interrupt: vi.fn(async () => {}),
    setPermissionMode: vi.fn(async () => {}),
    setModel: vi.fn(async () => {}),
  } as unknown as Query;
  return gen;
}

/** Creates a mock AgentSideConnection that records sessionUpdate calls. */
function createMockClient() {
  const updates: any[] = [];
  const client = {
    sessionUpdate: vi.fn(async (params: any) => {
      updates.push(params);
    }),
  } as unknown as AgentSideConnection;
  return { client, updates };
}

/** Creates a ClaudeAcpAgent with a fake session backed by the mock query. */
function createAgentWithSession(
  mockQuery: Query,
  mockClient: AgentSideConnection,
  sessionId = "test-session",
) {
  const agent = new ClaudeAcpAgent(mockClient);
  // Inject a fake session directly
  (agent as any).sessions[sessionId] = {
    query: mockQuery,
    input: new Pushable<SDKUserMessage>(),
    cancelled: false,
    cwd: "/test",
    permissionMode: "default",
    settingsManager: { getSettings: () => ({}) },
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
  };
  return agent;
}

// ── Fixtures from real SDK trace ─────────────────────────────────────
// Extracted from x.sdk-trace-bg-leak.ndjson

const SESSION_ID = "test-session";

/** Minimal result message (from SDK trace line 148). */
function makeResultMessage(text: string, inputTokens = 10, outputTokens = 5): any {
  return {
    type: "result",
    subtype: "success",
    is_error: false,
    stop_reason: null,
    duration_ms: 100,
    result: text,
    session_id: SESSION_ID,
    total_cost_usd: 0.001,
    usage: {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
      server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
      service_tier: "standard",
    },
    modelUsage: {
      "test-model": {
        inputTokens,
        outputTokens,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        webSearchRequests: 0,
        costUSD: 0.001,
        contextWindow: 200000,
        maxOutputTokens: 4096,
      },
    },
  };
}

/** Normal turn: init → streaming → assistant → result. No bg tasks. */
function makeNormalTurnMessages(text = "Hello"): any[] {
  return [
    { type: "system", subtype: "init", session_id: SESSION_ID },
    {
      type: "stream_event",
      event: { type: "message_start", message: { model: "test", role: "assistant", content: [] } },
      parent_tool_use_id: null,
      session_id: SESSION_ID,
    },
    {
      type: "stream_event",
      event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      parent_tool_use_id: null,
      session_id: SESSION_ID,
    },
    {
      type: "stream_event",
      event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
      parent_tool_use_id: null,
      session_id: SESSION_ID,
    },
    {
      type: "stream_event",
      event: { type: "content_block_stop", index: 0 },
      parent_tool_use_id: null,
      session_id: SESSION_ID,
    },
    {
      type: "stream_event",
      event: { type: "message_stop" },
      parent_tool_use_id: null,
      session_id: SESSION_ID,
    },
    {
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "text", text }],
        model: "test",
        id: "msg_1",
        type: "message",
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
      },
      parent_tool_use_id: null,
      session_id: SESSION_ID,
    },
    makeResultMessage(text),
  ];
}

/**
 * Internal turn messages that follow the first result when a bg task completes.
 * Extracted from SDK trace lines 149-172.
 */
function makeBgTaskInternalTurnMessages(): any[] {
  const bgText =
    "\n\nThe background task from the subagent completed. Still waiting on your answer.";
  return [
    // task_notification: bg bash completed
    {
      type: "system",
      subtype: "task_notification",
      task_id: "bmugj42hj",
      tool_use_id: "toolu_013dxfKLvos4vXxWcSvDsGiw",
      status: "completed",
      output_file: "/tmp/tasks/bmugj42hj.output",
      summary: 'Background command "Sleep 8 seconds then print message" completed (exit code 0)',
      session_id: SESSION_ID,
    },
    // init: internal turn begins
    {
      type: "system",
      subtype: "init",
      cwd: "/test",
      session_id: SESSION_ID,
      tools: [],
      model: "test",
    },
    // streaming
    {
      type: "stream_event",
      event: {
        type: "message_start",
        message: { model: "test", role: "assistant", content: [], id: "msg_internal" },
      },
      parent_tool_use_id: null,
      session_id: SESSION_ID,
    },
    {
      type: "stream_event",
      event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      parent_tool_use_id: null,
      session_id: SESSION_ID,
    },
    {
      type: "stream_event",
      event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: bgText } },
      parent_tool_use_id: null,
      session_id: SESSION_ID,
    },
    // assistant message
    {
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "text", text: bgText }],
        model: "test",
        id: "msg_internal",
        type: "message",
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: 3,
          output_tokens: 31,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
      },
      parent_tool_use_id: null,
      session_id: SESSION_ID,
    },
    {
      type: "stream_event",
      event: { type: "content_block_stop", index: 0 },
      parent_tool_use_id: null,
      session_id: SESSION_ID,
    },
    {
      type: "stream_event",
      event: {
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: { output_tokens: 31 },
      },
      parent_tool_use_id: null,
      session_id: SESSION_ID,
    },
    {
      type: "stream_event",
      event: { type: "message_stop" },
      parent_tool_use_id: null,
      session_id: SESSION_ID,
    },
    // result: internal turn ends
    makeResultMessage(bgText, 3, 31),
  ];
}

/** Full sequence: normal user turn (with task_started) + bg task internal turn. */
function makeFullBgTaskSequence() {
  const normalTurn = makeNormalTurnMessages("Shall I create a summary?");
  // Insert task_started before the result (matches SDK trace line 105:
  // task_started arrives during the turn, before result at line 148).
  const resultIdx = normalTurn.findIndex((m: any) => m.type === "result");
  normalTurn.splice(resultIdx, 0, {
    type: "system",
    subtype: "task_started",
    task_id: "bmugj42hj",
    tool_use_id: "toolu_013dxfKLvos4vXxWcSvDsGiw",
    description: "Sleep 8 seconds then print message",
    task_type: "local_bash",
    session_id: SESSION_ID,
  });
  return [...normalTurn, ...makeBgTaskInternalTurnMessages()];
}

// ── Tests ────────────────────────────────────────────────────────────

describe("Background task notification leak", () => {
  describe("fixture structure verification", () => {
    it("full sequence has exactly two result messages", () => {
      const msgs = makeFullBgTaskSequence();
      const results = msgs.filter((m: any) => m.type === "result");
      expect(results.length).toBe(2);
    });

    it("task_notification appears between the two results", () => {
      const msgs = makeFullBgTaskSequence();
      const firstResultIdx = msgs.findIndex((m: any) => m.type === "result");
      const taskNotifIdx = msgs.findIndex(
        (m: any) => m.type === "system" && m.subtype === "task_notification",
      );
      const secondResultIdx = msgs.findIndex(
        (m: any, i: number) => i !== firstResultIdx && m.type === "result",
      );

      expect(firstResultIdx).toBeLessThan(taskNotifIdx);
      expect(taskNotifIdx).toBeLessThan(secondResultIdx);
    });

    it("internal turn starts with task_notification, not user input", () => {
      const internalTurn = makeBgTaskInternalTurnMessages();
      expect(internalTurn[0].type).toBe("system");
      expect((internalTurn[0] as any).subtype).toBe("task_notification");
      expect((internalTurn[0] as any).status).toBe("completed");
    });
  });

  describe("prompt() behavior with background task internal turns", () => {
    it("prompt() should consume the full sequence including internal turn before returning", async () => {
      const allMessages = makeFullBgTaskSequence();
      const mockQuery = createMockQuery(allMessages);
      const { client, updates } = createMockClient();
      const agent = createAgentWithSession(mockQuery, client);

      // With the fix, prompt() should consume all 18+ messages before returning.
      // It should forward the task_notification and assistant text as notifications.
      const result = await agent.prompt({
        sessionId: SESSION_ID,
        prompt: [{ type: "text", text: "test" }],
      });

      expect(result.stopReason).toBe("end_turn");

      // The client should have received the bg task notification content
      const allText = updates
        .filter((u: any) => u.update?.sessionUpdate === "agent_message_chunk")
        .map((u: any) => u.update?.content?.text ?? "")
        .join("");

      // Fixed: bg task completion should be forwarded as notification
      expect(allText).toContain("background task from the subagent completed");
    });

    it("subsequent prompt() should NOT see stale internal turn messages", async () => {
      const firstTurnMessages = makeFullBgTaskSequence();
      const secondTurnMessages = makeNormalTurnMessages("Created summary file.");
      const allMessages = [...firstTurnMessages, ...secondTurnMessages];

      const mockQuery = createMockQuery(allMessages);
      const { client, updates } = createMockClient();
      const agent = createAgentWithSession(mockQuery, client);

      // First prompt consumes everything including internal turn
      await agent.prompt({
        sessionId: SESSION_ID,
        prompt: [{ type: "text", text: "do the task" }],
      });

      updates.length = 0;

      // Second prompt gets clean "yes" response
      const result2 = await agent.prompt({
        sessionId: SESSION_ID,
        prompt: [{ type: "text", text: "yes" }],
      });

      expect(result2.stopReason).toBe("end_turn");

      const secondPromptText = updates
        .filter((u: any) => u.update?.sessionUpdate === "agent_message_chunk")
        .map((u: any) => u.update?.content?.text ?? "")
        .join("");

      // Fixed: no bg task leak in second prompt
      expect(secondPromptText).not.toContain("background task");
      expect(secondPromptText).toContain("Created summary file");
    });

    it("local_agent task_started should NOT trigger internal turn detection", async () => {
      // The SDK already defers results for local_agent tasks, so agent
      // subagent task_started events should be ignored by our workaround.
      // This was a real bug found in E2E: agent task IDs were inflating
      // pendingTaskIds and were never resolved (no task_notification).
      const normalTurn = makeNormalTurnMessages("Done.");
      const resultIdx = normalTurn.findIndex((m: any) => m.type === "result");
      normalTurn.splice(resultIdx, 0, {
        type: "system",
        subtype: "task_started",
        task_id: "agent-task-123",
        tool_use_id: "toolu_agent_1",
        description: "Subagent exploring codebase",
        task_type: "local_agent",
        session_id: SESSION_ID,
      });

      const mockQuery = createMockQuery(normalTurn);
      const { client } = createMockClient();
      const agent = createAgentWithSession(mockQuery, client);

      // Should return promptly at the result — local_agent task_started
      // must NOT cause the code to peek for task_notification.
      const result = await agent.prompt({
        sessionId: SESSION_ID,
        prompt: [{ type: "text", text: "explore" }],
      });

      expect(result.stopReason).toBe("end_turn");
    });

    it("consumes internal turn when task_notification arrives during event loop yield", async () => {
      // Simulates the real-world race: task_notification isn't in the
      // queue at peek time but arrives during the setTimeout(0) yield.
      // This was the primary failure mode in E2E testing.
      //
      // Uses fake timers so both the production setTimeout(0) yield and
      // the test's deferred message push are deterministic.
      vi.useFakeTimers();
      try {
        const normalTurn = makeNormalTurnMessages("Shall I proceed?");
        const resultIdx = normalTurn.findIndex((m: any) => m.type === "result");
        normalTurn.splice(resultIdx, 0, {
          type: "system",
          subtype: "task_started",
          task_id: "delayed-task",
          tool_use_id: "toolu_delayed_1",
          description: "Sleep then print",
          task_type: "local_bash",
          session_id: SESSION_ID,
        });

        const internalTurnMessages = makeBgTaskInternalTurnMessages();
        (internalTurnMessages[0] as any).task_id = "delayed-task";

        const mockQuery = createMockQuery(normalTurn);
        const { client, updates } = createMockClient();
        const agent = createAgentWithSession(mockQuery, client);

        // Schedule internal turn messages to arrive during the yield.
        const queue = (mockQuery as any).inputStream.queue as any[];
        setTimeout(() => {
          for (const msg of internalTurnMessages) {
            queue.push(msg);
          }
        }, 0);

        // Start prompt (don't await yet — it will block at setTimeout(0))
        const promptPromise = agent.prompt({
          sessionId: SESSION_ID,
          prompt: [{ type: "text", text: "run it" }],
        });

        // Flush microtasks first so the production code's setTimeout(0)
        // is registered, then advance fake timers to fire both callbacks.
        await Promise.resolve();
        await vi.advanceTimersByTimeAsync(0);

        const result = await promptPromise;

        expect(result.stopReason).toBe("end_turn");

        const allText = updates
          .filter((u: any) => u.update?.sessionUpdate === "agent_message_chunk")
          .map((u: any) => u.update?.content?.text ?? "")
          .join("");
        expect(allText).toContain("background task from the subagent completed");
      } finally {
        vi.useRealTimers();
      }
    });

    it("logs warning and returns when task_notification never arrives (the race)", async () => {
      // When the bg task hasn't finished by the time we peek the queue
      // after the yield, prompt() should return with a warning — not
      // hang. This is the acknowledged race condition documented in the
      // code and codex reviews.
      const normalTurn = makeNormalTurnMessages("Done.");
      const resultIdx = normalTurn.findIndex((m: any) => m.type === "result");
      normalTurn.splice(resultIdx, 0, {
        type: "system",
        subtype: "task_started",
        task_id: "never-completes",
        tool_use_id: "toolu_never_1",
        description: "Very long running task",
        task_type: "local_bash",
        session_id: SESSION_ID,
      });
      // No internal turn messages appended — task_notification never arrives.

      const mockQuery = createMockQuery(normalTurn);
      const logs: string[] = [];
      const spyLogger = {
        log: (...args: any[]) => logs.push(args.join(" ")),
        error: () => {},
      };
      const { client } = createMockClient();
      const agent = createAgentWithSession(mockQuery, client);
      (agent as any).logger = spyLogger;

      const result = await agent.prompt({
        sessionId: SESSION_ID,
        prompt: [{ type: "text", text: "run it" }],
      });

      // Should still return (not hang)
      expect(result.stopReason).toBe("end_turn");
      // Should have logged the warning about unresolved tasks
      expect(logs.some((l) => l.includes("[bg-task-leak]") && l.includes("never-completes"))).toBe(
        true,
      );
    });

    it("clears pendingTaskIds when task_notification reports failed status", async () => {
      // A task_notification with status "failed" should still clear the
      // pending task, preventing false-positive internal turn detection.
      const normalTurn = makeNormalTurnMessages("Task failed.");
      const resultIdx = normalTurn.findIndex((m: any) => m.type === "result");
      // Insert task_started, then a failed task_notification BEFORE the result
      normalTurn.splice(resultIdx, 0, {
        type: "system",
        subtype: "task_started",
        task_id: "fail-task-1",
        tool_use_id: "toolu_fail_1",
        description: "Will fail",
        task_type: "local_bash",
        session_id: SESSION_ID,
      });
      // Re-find resultIdx since we just spliced
      const newResultIdx = normalTurn.findIndex((m: any) => m.type === "result");
      normalTurn.splice(newResultIdx, 0, {
        type: "system",
        subtype: "task_notification",
        task_id: "fail-task-1",
        tool_use_id: "toolu_fail_1",
        status: "failed",
        summary: "Command failed with exit code 1",
        session_id: SESSION_ID,
      });

      const mockQuery = createMockQuery(normalTurn);
      const { client } = createMockClient();
      const agent = createAgentWithSession(mockQuery, client);

      // Should return cleanly — task was resolved by the failed notification
      const result = await agent.prompt({
        sessionId: SESSION_ID,
        prompt: [{ type: "text", text: "go" }],
      });

      expect(result.stopReason).toBe("end_turn");
    });

    it("clears pendingTaskIds when task_notification reports stopped status", async () => {
      // Same as the failed test above but with "stopped" status —
      // verifies all terminal statuses clear the set.
      const normalTurn = makeNormalTurnMessages("Stopped.");
      const resultIdx = normalTurn.findIndex((m: any) => m.type === "result");
      normalTurn.splice(resultIdx, 0, {
        type: "system",
        subtype: "task_started",
        task_id: "stop-task-1",
        tool_use_id: "toolu_stop_1",
        description: "Will be stopped",
        task_type: "local_bash",
        session_id: SESSION_ID,
      });
      const newResultIdx = normalTurn.findIndex((m: any) => m.type === "result");
      normalTurn.splice(newResultIdx, 0, {
        type: "system",
        subtype: "task_notification",
        task_id: "stop-task-1",
        tool_use_id: "toolu_stop_1",
        status: "stopped",
        summary: "Task was cancelled",
        session_id: SESSION_ID,
      });

      const mockQuery = createMockQuery(normalTurn);
      const { client } = createMockClient();
      const agent = createAgentWithSession(mockQuery, client);

      const result = await agent.prompt({
        sessionId: SESSION_ID,
        prompt: [{ type: "text", text: "go" }],
      });

      expect(result.stopReason).toBe("end_turn");
    });

    it("error_during_execution result does NOT drain internal turns (known limitation)", async () => {
      // The internal turn drain only runs for result/success. If the
      // prompt errors while a bg task is pending, internal turn messages
      // can still leak. This test documents the current behavior.
      const messages = [
        { type: "system", subtype: "init", session_id: SESSION_ID },
        {
          type: "system",
          subtype: "task_started",
          task_id: "err-task-1",
          tool_use_id: "toolu_err_1",
          description: "bg task during error",
          task_type: "local_bash",
          session_id: SESSION_ID,
        },
        {
          type: "result",
          subtype: "error_during_execution",
          is_error: true,
          stop_reason: null,
          duration_ms: 50,
          result: "something broke",
          errors: ["tool execution failed"],
          session_id: SESSION_ID,
          total_cost_usd: 0.001,
          usage: {
            input_tokens: 5,
            output_tokens: 2,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
            server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
            service_tier: "standard",
          },
          modelUsage: {
            "test-model": {
              inputTokens: 5,
              outputTokens: 2,
              cacheReadInputTokens: 0,
              cacheCreationInputTokens: 0,
              webSearchRequests: 0,
              costUSD: 0.001,
              contextWindow: 200000,
              maxOutputTokens: 4096,
            },
          },
        },
        // These would be the internal turn — left in the queue
        ...makeBgTaskInternalTurnMessages(),
      ];

      const mockQuery = createMockQuery(messages);
      const { client } = createMockClient();
      const agent = createAgentWithSession(mockQuery, client);

      // error_during_execution with is_error throws
      await expect(
        agent.prompt({
          sessionId: SESSION_ID,
          prompt: [{ type: "text", text: "go" }],
        }),
      ).rejects.toThrow("tool execution failed");

      // The internal turn messages are still in the queue (known limitation).
      // This documents the behavior rather than asserting a fix.
      const queue = (mockQuery as any).inputStream.queue as any[];
      expect(0 < queue.length).toBe(true);
    });

    it("multiple back-to-back bg task internal turns are all consumed", async () => {
      // Two background tasks complete after the first result, each
      // producing its own internal turn (task_notification → assistant → result).
      const normalTurn = makeNormalTurnMessages("Two tasks launched.");
      const resultIdx = normalTurn.findIndex((m: any) => m.type === "result");

      // Insert two task_started messages
      normalTurn.splice(resultIdx, 0, {
        type: "system",
        subtype: "task_started",
        task_id: "bg-task-a",
        tool_use_id: "toolu_a",
        description: "First bg task",
        task_type: "local_bash",
        session_id: SESSION_ID,
      });
      const resultIdx2 = normalTurn.findIndex((m: any) => m.type === "result");
      normalTurn.splice(resultIdx2, 0, {
        type: "system",
        subtype: "task_started",
        task_id: "bg-task-b",
        tool_use_id: "toolu_b",
        description: "Second bg task",
        task_type: "local_bash",
        session_id: SESSION_ID,
      });

      // First internal turn (task A completes)
      const internalTurnA = makeBgTaskInternalTurnMessages();
      (internalTurnA[0] as any).task_id = "bg-task-a";

      // Second internal turn (task B completes)
      const bgTextB = "\n\nSecond background task also completed.";
      const internalTurnB = [
        {
          type: "system",
          subtype: "task_notification",
          task_id: "bg-task-b",
          tool_use_id: "toolu_b",
          status: "completed",
          output_file: "/tmp/tasks/bg-task-b.output",
          summary: "Second background command completed",
          session_id: SESSION_ID,
        },
        {
          type: "system",
          subtype: "init",
          cwd: "/test",
          session_id: SESSION_ID,
          tools: [],
          model: "test",
        },
        {
          type: "stream_event",
          event: {
            type: "message_start",
            message: { model: "test", role: "assistant", content: [], id: "msg_b" },
          },
          parent_tool_use_id: null,
          session_id: SESSION_ID,
        },
        {
          type: "stream_event",
          event: {
            type: "content_block_start",
            index: 0,
            content_block: { type: "text", text: "" },
          },
          parent_tool_use_id: null,
          session_id: SESSION_ID,
        },
        {
          type: "stream_event",
          event: {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: bgTextB },
          },
          parent_tool_use_id: null,
          session_id: SESSION_ID,
        },
        {
          type: "assistant",
          message: {
            role: "assistant",
            content: [{ type: "text", text: bgTextB }],
            model: "test",
            id: "msg_b",
            type: "message",
            stop_reason: null,
            stop_sequence: null,
            usage: {
              input_tokens: 3,
              output_tokens: 10,
              cache_read_input_tokens: 0,
              cache_creation_input_tokens: 0,
            },
          },
          parent_tool_use_id: null,
          session_id: SESSION_ID,
        },
        {
          type: "stream_event",
          event: { type: "content_block_stop", index: 0 },
          parent_tool_use_id: null,
          session_id: SESSION_ID,
        },
        {
          type: "stream_event",
          event: { type: "message_stop" },
          parent_tool_use_id: null,
          session_id: SESSION_ID,
        },
        makeResultMessage(bgTextB, 3, 10),
      ];

      const allMessages = [...normalTurn, ...internalTurnA, ...internalTurnB];
      const mockQuery = createMockQuery(allMessages);
      const { client, updates } = createMockClient();
      const agent = createAgentWithSession(mockQuery, client);

      const result = await agent.prompt({
        sessionId: SESSION_ID,
        prompt: [{ type: "text", text: "launch both" }],
      });

      expect(result.stopReason).toBe("end_turn");

      // Both internal turns should have been consumed and forwarded
      const allText = updates
        .filter((u: any) => u.update?.sessionUpdate === "agent_message_chunk")
        .map((u: any) => u.update?.content?.text ?? "")
        .join("");

      expect(allText).toContain("background task from the subagent completed");
      expect(allText).toContain("Second background task also completed");

      // Queue should be empty (all consumed)
      const queue = (mockQuery as any).inputStream.queue as any[];
      expect(queue.length).toBe(0);
    });

    it("normal turns without bg tasks should be unaffected", async () => {
      const messages = makeNormalTurnMessages("Hello");
      const mockQuery = createMockQuery(messages);
      const { client } = createMockClient();
      const agent = createAgentWithSession(mockQuery, client);

      const result = await agent.prompt({
        sessionId: SESSION_ID,
        prompt: [{ type: "text", text: "hi" }],
      });

      expect(result.stopReason).toBe("end_turn");
      // No hang, no extra consumption — returns cleanly at first result
    });
  });
});
