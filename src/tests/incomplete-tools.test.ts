import { afterEach, describe, expect, it, vi } from "vitest";
import { ClaudeAcpAgent, type AcpClient } from "../acp-agent.js";
import { clearHookCallbacks, createPostToolUseHook, hasHookCallback } from "../tools.js";
import { Pushable } from "../utils.js";
import {
  mockSessionState,
  successfulResultMessage,
  userEcho,
  wrapQuery,
} from "./session-doubles.js";

const sessionId = "test-session";
const toolCallId = "unfinished-bash";

afterEach(() => clearHookCallbacks(sessionId));

describe("incomplete foreground tools", () => {
  it.each(["result", "EOF"] as const)(
    "fails the tool and prompt at %s even after the input stream closes",
    async (ending) => {
      const { prompt, updates, logError } = createTestSession((input) =>
        unfinishedToolMessages(input, ending),
      );

      await expect(prompt()).rejects.toMatchObject({ data: { errorKind: "incomplete_tool_call" } });
      expect(updates).toContainEqual(
        expect.objectContaining({
          sessionUpdate: "tool_call_update",
          toolCallId,
          status: "failed",
        }),
      );
      expect(logError).toHaveBeenCalledExactlyOnceWith(
        expect.stringMatching(
          /Session test-session, turn .+, stopReason=end_turn:.*unfinished-bash/,
        ),
      );
      const failed = updates.find((u) => u.toolCallId === toolCallId && u.status === "failed");
      expect(failed.content[0].content.text).toContain("without returning a result");
      expect(failed).not.toHaveProperty("rawOutput");
      expect(hasHookCallback(toolCallId)).toBe(false);
    },
  );

  it("detects a tool emitted before the user echo", async () => {
    const { prompt } = createTestSession(toolBeforeUserEchoMessages);

    await expect(prompt()).rejects.toMatchObject({ data: { errorKind: "incomplete_tool_call" } });
  });

  it("detects a permission tool whose streamed tool_use never arrived", async () => {
    const { prompt, updates } = createTestSession(permissionOnlyToolMessages);

    await expect(prompt()).rejects.toMatchObject({ data: { errorKind: "incomplete_tool_call" } });
    expect(updates).toContainEqual(expect.objectContaining({ toolCallId, status: "failed" }));
  });

  it("allows a completed tool with a late PostToolUse hook", async () => {
    const { prompt, logError } = createTestSession(completedToolMessages);

    await expect(prompt()).resolves.toMatchObject({ stopReason: "end_turn" });
    expect(hasHookCallback(toolCallId)).toBe(true);
    await createPostToolUseHook()(
      {
        hook_event_name: "PostToolUse",
        tool_name: "Bash",
        tool_input: { command: "echo test" },
        tool_response: { stdout: "test", stderr: "", interrupted: false },
      } as any,
      toolCallId,
      { signal: new AbortController().signal },
    );
    expect(logError).not.toHaveBeenCalled();
  });

  it.each([
    { type: "advisor_result", text: "Check the queue ordering." },
    { type: "advisor_redacted_result", encrypted_content: "opaque-advice" },
    { type: "advisor_tool_result_error", error_code: "overloaded" },
  ])("settles an advisor call with a $type result", async (content) => {
    const advisorId = "srvtoolu_advisor";
    const { prompt, updates, logError } = createTestSession(async function* (input) {
      yield* echoNextPrompt(input);
      const start = toolStart(advisorId);
      start.event.content_block = {
        type: "server_tool_use",
        id: advisorId,
        name: "advisor",
        input: {},
      };
      yield start;
      yield {
        type: "assistant",
        parent_tool_use_id: null,
        message: {
          role: "assistant",
          usage: successfulResultMessage().usage,
          content: [{ type: "advisor_tool_result", tool_use_id: advisorId, content }],
        },
      };
      yield successfulResultMessage();
    });

    await expect(prompt()).resolves.toMatchObject({ stopReason: "end_turn" });
    const terminal = updates.find(
      (u) => u.toolCallId === advisorId && ["completed", "failed"].includes(u.status),
    );
    expect(terminal).toMatchObject({
      sessionUpdate: "tool_call_update",
      status: content.type === "advisor_tool_result_error" ? "failed" : "completed",
    });
    const rendered = JSON.stringify(terminal);
    if (content.type === "advisor_result") expect(rendered).toContain(content.text);
    if (content.type === "advisor_tool_result_error")
      expect(rendered).toContain(content.error_code);
    expect(rendered).not.toContain("opaque-advice");
    expect(hasHookCallback(advisorId)).toBe(false);
    expect(logError).not.toHaveBeenCalled();
  });

  it("still fails an advisor call without a result", async () => {
    const { prompt } = createTestSession(async function* (input) {
      yield* echoNextPrompt(input);
      const start = toolStart("srvtoolu_advisor");
      start.event.content_block = {
        type: "server_tool_use",
        id: "srvtoolu_advisor",
        name: "advisor",
        input: {},
      };
      yield start;
      yield successfulResultMessage();
    });

    await expect(prompt()).rejects.toMatchObject({ data: { errorKind: "incomplete_tool_call" } });
  });

  it("allows a tool explicitly handed off to a background task", async () => {
    const { prompt, updates } = createTestSession(backgroundToolMessages);

    await expect(prompt()).resolves.toMatchObject({ stopReason: "end_turn" });
    expect(updates.some((u) => u.toolCallId === toolCallId && u.status === "failed")).toBe(false);
  });

  it("does not claim a subagent's tool as a foreground tool", async () => {
    const { prompt } = createTestSession(subagentToolMessages);

    await expect(prompt()).resolves.toMatchObject({ stopReason: "end_turn" });
  });

  it("does not treat a request to run in the background as a confirmed handoff", async () => {
    const { prompt } = createTestSession(unconfirmedBackgroundToolMessages);

    await expect(prompt()).rejects.toMatchObject({ data: { errorKind: "incomplete_tool_call" } });
  });

  it("waits for deferred settlement before checking unfinished tools", async () => {
    const { prompt, logError } = createTestSession(deferredSettlementMessages);

    await expect(prompt()).resolves.toMatchObject({ stopReason: "end_turn" });
    expect(logError).not.toHaveBeenCalled();
  });

  it("fails every unfinished tool and allows a later prompt to succeed", async () => {
    const { prompt, updates, agent } = createTestSession(incompleteThenSuccessfulTurnMessages);

    await expect(prompt()).rejects.toMatchObject({ data: { errorKind: "incomplete_tool_call" } });
    expect(updates.filter((u) => u.status === "failed").map((u) => u.toolCallId)).toEqual([
      toolCallId,
      "second-tool",
    ]);
    expect(agent.sessions[sessionId].emittedToolCalls.size).toBe(0);
    expect(agent.sessions[sessionId].toolUseCache).toEqual({});
    await expect(prompt()).resolves.toMatchObject({ stopReason: "end_turn" });
  });

  it("preserves cancellation and does not attribute its unfinished tool to the next turn", async () => {
    const { prompt, updates } = createTestSession(cancelledThenSuccessfulTurnMessages);

    await expect(prompt()).resolves.toMatchObject({ stopReason: "cancelled" });
    await expect(prompt()).resolves.toMatchObject({ stopReason: "end_turn" });
    expect(updates.some((u) => u.toolCallId === toolCallId && u.status === "failed")).toBe(false);
  });

  it("closes a streamed tool_use that never reached a complete message without a failure", async () => {
    const { prompt, updates, logError, agent } = createTestSession(abandonedToolMessages);

    await expect(prompt()).resolves.toMatchObject({ stopReason: "end_turn" });
    const failed = updates.filter((u) => u.toolCallId === toolCallId && u.status === "failed");
    expect(failed).toHaveLength(1);
    expect(failed[0].content[0].content.text).toBe("Claude stopped this tool call before it ran.");
    expect(logError).not.toHaveBeenCalled();
    expect(hasHookCallback(toolCallId)).toBe(false);
    expect(agent.sessions[sessionId].emittedToolCalls.size).toBe(0);
    expect(agent.sessions[sessionId].toolUseCache).toEqual({});
  });

  it("closes an abandoned tool_use and still fails the turn for an unfinished tool", async () => {
    const { prompt, updates } = createTestSession(abandonedAndUnfinishedToolMessages);

    await expect(prompt()).rejects.toMatchObject({
      data: { errorKind: "incomplete_tool_call" },
      message: expect.stringMatching(/second-tool/),
    });
    const failedText = (id: string) =>
      updates.find((u) => u.toolCallId === id && u.status === "failed")?.content[0].content.text;
    expect(failedText(toolCallId)).toBe("Claude stopped this tool call before it ran.");
    expect(failedText("second-tool")).toContain("without returning a result");
  });

  it("closes a tool_use that Claude abandoned for a steering message", async () => {
    const { prompt, updates, logError } = createTestSession(steeredAbandonedToolMessages);

    await expect(prompt()).resolves.toMatchObject({ stopReason: "end_turn" });
    expect(updates).toContainEqual(expect.objectContaining({ toolCallId, status: "failed" }));
    expect(logError).not.toHaveBeenCalled();
  });

  it("preserves an existing SDK failure", async () => {
    const { prompt } = createTestSession(sdkFailureMessages);

    await expect(prompt()).rejects.toThrow("original failure");
  });
});

function toolStart(id = toolCallId, parent: string | null = null) {
  return {
    type: "stream_event",
    session_id: sessionId,
    uuid: "stream-message",
    parent_tool_use_id: parent,
    event: {
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", id, name: "Bash", input: {} },
    },
  };
}

/** The complete assistant message that sends the tool_use to the tool runner. */
function toolUse(id = toolCallId) {
  return {
    type: "assistant",
    session_id: sessionId,
    parent_tool_use_id: null,
    message: {
      role: "assistant",
      usage: successfulResultMessage().usage,
      content: [{ type: "tool_use", id, name: "Bash", input: { command: "echo test" } }],
    },
  };
}

function assistantText(text: string) {
  return {
    type: "assistant",
    session_id: sessionId,
    parent_tool_use_id: null,
    message: {
      role: "assistant",
      usage: successfulResultMessage().usage,
      content: [{ type: "text", text }],
    },
  };
}

function toolResult(id = toolCallId) {
  return {
    type: "user",
    session_id: sessionId,
    parent_tool_use_id: null,
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: id, content: "done" }],
    },
  };
}

function createTestSession(
  createSdkMessages: (input: Pushable<any>, agent: ClaudeAcpAgent) => AsyncGenerator<any>,
) {
  const updates: any[] = [];
  const logError = vi.fn();
  const input = new Pushable<any>();
  const agent = new ClaudeAcpAgent(
    {
      sessionUpdate: async (notification: any) => {
        updates.push(notification.update);
      },
      requestPermission: async () => ({ outcome: { outcome: "selected", optionId: "allow-once" } }),
    } as unknown as AcpClient,
    { log: () => {}, error: logError },
  );
  agent.sessions[sessionId] = mockSessionState({
    input,
    // The real consumer reads the scripted SDK events from this generator.
    query: wrapQuery(createSdkMessages(input, agent)),
  });
  const prompt = () => agent.prompt({ sessionId, prompt: [{ type: "text", text: "continue" }] });
  return { agent, updates, logError, prompt };
}

// Wait for prompt() to submit input, then echo it as the SDK would.
async function* echoNextPrompt(input: Pushable<any>) {
  const { value } = await input[Symbol.asyncIterator]().next();
  yield userEcho(value);
}

async function* unfinishedToolMessages(input: Pushable<any>, ending: "result" | "EOF") {
  yield* echoNextPrompt(input);
  yield toolStart();
  yield {
    ...toolStart(),
    event: { type: "content_block_stop", index: 0 },
  };
  yield toolUse();
  // The tool ran, but no tool_result arrived. Returning ends the stream.
  if (ending === "result") yield successfulResultMessage();
}

async function* toolBeforeUserEchoMessages(input: Pushable<any>) {
  const { value } = await input[Symbol.asyncIterator]().next();
  yield toolStart();
  yield userEcho(value);
  yield toolUse();
  yield successfulResultMessage();
}

async function* permissionOnlyToolMessages(input: Pushable<any>, agent: ClaudeAcpAgent) {
  yield* echoNextPrompt(input);
  await agent.canUseTool(sessionId)("Bash", { command: "echo test" }, {
    toolUseID: toolCallId,
    signal: new AbortController().signal,
    suggestions: [],
  } as any);
  yield successfulResultMessage();
}

async function* completedToolMessages(input: Pushable<any>) {
  yield* echoNextPrompt(input);
  yield toolStart();
  yield toolResult();
  yield successfulResultMessage();
}

async function* backgroundToolMessages(input: Pushable<any>) {
  yield* echoNextPrompt(input);
  yield toolStart();
  yield {
    type: "system",
    subtype: "task_started",
    session_id: sessionId,
    task_id: "background-shell",
    tool_use_id: toolCallId,
    description: "dev server",
  };
  yield successfulResultMessage();
}

async function* subagentToolMessages(input: Pushable<any>) {
  yield* echoNextPrompt(input);
  yield toolStart("child-tool", "parent-agent");
  yield successfulResultMessage();
}

async function* unconfirmedBackgroundToolMessages(input: Pushable<any>) {
  yield* echoNextPrompt(input);
  yield {
    type: "assistant",
    parent_tool_use_id: null,
    message: {
      role: "assistant",
      usage: successfulResultMessage().usage,
      content: [
        {
          type: "tool_use",
          id: toolCallId,
          name: "Bash",
          input: { command: "sleep 100", run_in_background: true },
        },
      ],
    },
  };
  yield successfulResultMessage();
}

async function* deferredSettlementMessages(input: Pushable<any>) {
  yield* echoNextPrompt(input);
  yield toolStart();
  yield {
    type: "system",
    subtype: "task_started",
    session_id: sessionId,
    task_id: "child",
    tool_use_id: "parent-agent",
    subagent_type: "Explore",
    description: "investigate",
  };
  // The result arrives while the subagent is still running, so settlement waits.
  yield successfulResultMessage();
  yield toolResult();
  yield {
    type: "system",
    subtype: "task_notification",
    session_id: sessionId,
    task_id: "child",
    tool_use_id: "parent-agent",
    status: "completed",
    summary: "done",
  };
  yield { type: "system", subtype: "session_state_changed", state: "idle" };
}

async function* incompleteThenSuccessfulTurnMessages(input: Pushable<any>) {
  const messages = input[Symbol.asyncIterator]();
  yield userEcho((await messages.next()).value);
  yield toolStart();
  yield toolStart("second-tool");
  yield toolUse();
  yield toolUse("second-tool");
  yield successfulResultMessage();
  yield { type: "system", subtype: "session_state_changed", state: "idle" };

  // Keep the SDK stream open for the next prompt in the same session.
  yield userEcho((await messages.next()).value);
  yield successfulResultMessage();
}

async function* cancelledThenSuccessfulTurnMessages(input: Pushable<any>, agent: ClaudeAcpAgent) {
  const messages = input[Symbol.asyncIterator]();
  yield userEcho((await messages.next()).value);
  yield toolStart();
  await agent.cancel({ sessionId });
  yield { type: "system", subtype: "session_state_changed", state: "idle" };

  yield userEcho((await messages.next()).value);
  yield successfulResultMessage();
}

async function* sdkFailureMessages(input: Pushable<any>) {
  yield* echoNextPrompt(input);
  yield toolStart();
  yield successfulResultMessage({
    subtype: "error_during_execution",
    is_error: true,
    errors: ["original failure"],
  });
}

async function* abandonedToolMessages(input: Pushable<any>) {
  yield* echoNextPrompt(input);
  // Claude starts a tool_use, but no complete message ever holds it.
  yield toolStart();
  yield assistantText("Here is the answer.");
  yield successfulResultMessage();
}

async function* abandonedAndUnfinishedToolMessages(input: Pushable<any>) {
  yield* echoNextPrompt(input);
  yield toolStart();
  yield toolStart("second-tool");
  yield toolUse("second-tool");
  yield successfulResultMessage();
}

async function* steeredAbandonedToolMessages(input: Pushable<any>, agent: ClaudeAcpAgent) {
  const messages = input[Symbol.asyncIterator]();
  yield userEcho((await messages.next()).value);
  yield toolStart();
  await expect(
    agent.steer({ sessionId, prompt: [{ type: "text", text: "answer first" }] }),
  ).resolves.toEqual({ outcome: "injected" });
  yield userEcho((await messages.next()).value);
  yield assistantText("Done as you asked.");
  yield successfulResultMessage();
}
