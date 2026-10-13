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

  it("forgets the subagent of a tool call once the call ends", async () => {
    const seen: { parent?: string } = {};
    const { prompt, agent } = createTestSession((input, agent) =>
      completedSubagentToolMessages(input, agent, seen),
    );

    await expect(prompt()).resolves.toMatchObject({ stopReason: "end_turn" });

    expect(seen.parent).toBe("parent-agent");
    expect(agent.sessions[sessionId].toolCallParents?.size ?? 0).toBe(0);
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

  it("preserves cancellation, and closes its unfinished tool with the cancelled turn, not the next one", async () => {
    const { prompt, updates } = createTestSession(cancelledThenSuccessfulTurnMessages);
    const failedTool = () =>
      updates.filter((u) => u.toolCallId === toolCallId && u.status === "failed");

    await expect(prompt()).resolves.toMatchObject({ stopReason: "cancelled" });
    // The client has the report before the cancelled response, not as a failure
    // of the next turn.
    expect(failedTool()).toHaveLength(1);
    await expect(prompt()).resolves.toMatchObject({ stopReason: "end_turn" });
    expect(failedTool()).toHaveLength(1);
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

describe("tool calls of a cancelled turn", () => {
  /** The reports that end the tool call `id`. */
  const ends = (updates: any[], id = toolCallId) =>
    updates.filter(
      (u) => u.toolCallId === id && ["completed", "failed", "cancelled"].includes(u.status),
    );
  const textOf = (update: any): string =>
    (update.content ?? []).map((item: any) => item.content?.text).join("");

  it("delivers Claude Code's interrupted result for a running tool before the cancelled response", async () => {
    const { prompt, updates, agent, logError } = createTestSession(interruptedBashMessages);

    await expect(prompt()).resolves.toMatchObject({ stopReason: "cancelled" });

    // Claude Code's own result, with the kind it stamped, not a made-up report.
    const [end, ...more] = ends(updates);
    expect(more).toEqual([]);
    expect(end).toMatchObject({
      status: "failed",
      _meta: { claudeCode: { toolName: "Bash", nonExecutionKind: "user-rejected" } },
    });
    expect(textOf(end)).toContain("doesn't want to proceed with this tool use");
    expect(agent.sessions[sessionId].emittedToolCalls.size).toBe(0);
    expect(logError).not.toHaveBeenCalled();
  });

  it("delivers the result of an Agent call, and closes the tool call of its subagent, which Claude Code reports no result for", async () => {
    const { prompt, updates, agent } = createTestSession(interruptedSubagentMessages);

    await expect(prompt()).resolves.toMatchObject({ stopReason: "cancelled" });

    // Claude Code writes the interrupted result of the subagent's command only
    // to the subagent's own transcript, so the stream carries the Agent call's.
    const [agentEnd, ...agentMore] = ends(updates, "parent-agent");
    expect(agentMore).toEqual([]);
    expect(agentEnd).toMatchObject({
      status: "failed",
      _meta: { claudeCode: { nonExecutionKind: "user-rejected" } },
    });
    const [childEnd, ...childMore] = ends(updates, "child-tool");
    expect(childMore).toEqual([]);
    // It names its subagent, as the call's other updates do, so that a client
    // that groups by it, and the subagent runtime that routes by it, place it.
    expect(childEnd).toMatchObject({
      status: "failed",
      _meta: { claudeCode: { parentToolUseId: "parent-agent" } },
    });
    expect(textOf(childEnd)).toBe(
      "The turn was cancelled before this tool call returned a result.",
    );
    expect(agent.sessions[sessionId].emittedToolCalls.size).toBe(0);
    expect(agent.sessions[sessionId].toolUseCache).toEqual({});
    expect(agent.sessions[sessionId].toolCallParents?.size ?? 0).toBe(0);
  });

  it("names the subagent of a tool call that only a later update attributed to it", async () => {
    const { prompt, updates } = createTestSession(attributedLaterMessages);

    await expect(prompt()).resolves.toMatchObject({ stopReason: "cancelled" });

    // A permission request announced the call before the SDK said which
    // subagent made it; the streamed tool_use named the Agent call afterwards.
    expect(ends(updates, "late-child")).toMatchObject([
      { status: "failed", _meta: { claudeCode: { parentToolUseId: "parent-agent" } } },
    ]);
  });

  it("leaves the tool call of a background subagent open, which the interrupt did not stop, and closes the foreground subagent's", async () => {
    const { prompt, updates, agent } = createTestSession(backgroundSubagentMessages);

    await expect(prompt()).resolves.toMatchObject({ stopReason: "cancelled" });

    expect(ends(updates, "fg-child")).toHaveLength(1);
    // The SDK reported no end for the background subagent, which runs on, and
    // so does its command.
    expect(ends(updates, "bg-child")).toEqual([]);
    expect([...agent.sessions[sessionId].emittedToolCalls]).toEqual(["bg-child"]);
  });

  it("closes every open tool call when the force-cancel backstop ends a turn that gets no results", async () => {
    const { prompt, updates, agent } = createTestSession(wedgedToolMessages);
    agent.forceCancelGraceMs = 20;
    const response = prompt();
    await vi.waitFor(() =>
      expect(updates.some((u) => u.toolCallId === "abandoned-tool")).toBe(true),
    );

    await agent.cancel({ sessionId });

    await expect(response).resolves.toMatchObject({ stopReason: "cancelled" });
    // A tool that ran, and one that Claude abandoned before it ran.
    expect(textOf(ends(updates)[0])).toBe(
      "The turn was cancelled before this tool call returned a result.",
    );
    expect(textOf(ends(updates, "abandoned-tool")[0])).toBe(
      "Claude stopped this tool call before it ran.",
    );
    expect(agent.sessions[sessionId].emittedToolCalls.size).toBe(0);
  });

  it("closes a tool call whose start streams in after the cancel", async () => {
    const { prompt, updates } = createTestSession(startAfterCancelMessages);

    await expect(prompt()).resolves.toMatchObject({ stopReason: "cancelled" });

    expect(textOf(ends(updates)[0])).toBe("Claude stopped this tool call before it ran.");
  });

  it("drops Claude Code's result for a tool call once the cancelled turn has ended", async () => {
    const responded = Promise.withResolvers<void>();
    const { prompt, updates, agent, logError } = createTestSession((input, agent) =>
      lateInterruptedResultMessages(input, agent, responded.promise),
    );

    await expect(prompt().finally(() => responded.resolve())).resolves.toMatchObject({
      stopReason: "cancelled",
    });
    await agent.sessions[sessionId].consumer;

    // The turn's result came first, so the cancel closed the tool call, and the
    // client got nothing after the response.
    const [end, ...more] = ends(updates);
    expect(more).toEqual([]);
    expect(textOf(end)).toBe("The turn was cancelled before this tool call returned a result.");
    expect(logError).not.toHaveBeenCalled();
  });

  it("reports a tool that finished as the cancel landed as completed", async () => {
    const { prompt, updates } = createTestSession(finishedAtCancelMessages);

    await expect(prompt()).resolves.toMatchObject({ stopReason: "cancelled" });

    expect(ends(updates).map((u) => u.status)).toEqual(["completed"]);
  });

  it("sends nothing for a result of a tool call that the client does not hold open", async () => {
    const { prompt, updates, logError } = createTestSession(strayResultMessages);

    await expect(prompt()).resolves.toMatchObject({ stopReason: "cancelled" });

    expect(updates.some((u) => u.toolCallId === "never-announced")).toBe(false);
    expect(logError).not.toHaveBeenCalled();
  });

  it("drops the result of a tool call that a prompt the cancel abandoned runs", async () => {
    const responded = Promise.withResolvers<void>();
    const { prompt, updates, agent } = createTestSession((input, agent) =>
      abandonedPromptToolMessages(input, agent, responded.promise),
    );

    await expect(prompt().finally(() => responded.resolve())).resolves.toMatchObject({
      stopReason: "cancelled",
    });
    await agent.sessions[sessionId].consumer;

    // The permission request of the abandoned prompt's tool still announces it
    // (see the follow-ups of #1313), but its result is not the cancelled turn's.
    expect(ends(updates, "abandoned-tool")).toEqual([]);
  });
});

function toolStart(id = toolCallId, parent: string | null = null, name = "Bash") {
  return {
    type: "stream_event",
    session_id: sessionId,
    uuid: "stream-message",
    parent_tool_use_id: parent,
    event: {
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", id, name, input: {} },
    },
  };
}

/** The complete assistant message that sends the tool_use to the tool runner. */
function toolUse(
  id = toolCallId,
  parent: string | null = null,
  name = "Bash",
  input: Record<string, unknown> = { command: "echo test" },
) {
  return {
    type: "assistant",
    session_id: sessionId,
    parent_tool_use_id: parent,
    message: {
      role: "assistant",
      usage: successfulResultMessage().usage,
      content: [{ type: "tool_use", id, name, input }],
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

function toolResult(id = toolCallId, parent: string | null = null) {
  return {
    type: "user",
    session_id: sessionId,
    parent_tool_use_id: parent,
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

async function* completedSubagentToolMessages(
  input: Pushable<any>,
  agent: ClaudeAcpAgent,
  seen: { parent?: string },
) {
  yield* echoNextPrompt(input);
  yield toolStart("child-tool", "parent-agent");
  yield toolUse("child-tool", "parent-agent");
  // The consumer has recorded the call when it asks for the next message.
  seen.parent = agent.sessions[sessionId].toolCallParents?.get("child-tool");
  yield toolResult("child-tool", "parent-agent");
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

/** The text that Claude Code 2.1.293 gives the result of a tool that an interrupt stopped. */
const rejection =
  "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed.";

/** How Claude Code ends a tool that an interrupt stopped: an error result that the SDK stamps `user-rejected`. */
function interruptedResult(id = toolCallId, parent: string | null = null) {
  return {
    type: "user",
    session_id: sessionId,
    parent_tool_use_id: parent,
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: id, is_error: true, content: rejection }],
    },
    tool_result_meta: [{ id, non_execution_kind: "user-rejected" }],
  };
}

/** The note that Claude Code adds after the tools that an interrupt stopped. */
const interruptNote = {
  type: "user",
  session_id: sessionId,
  parent_tool_use_id: null,
  message: {
    role: "user",
    content: [{ type: "text", text: "[Request interrupted by user for tool use]" }],
  },
};

/** The result that ends a turn that an interrupt stopped while a tool ran. */
function abortedResult() {
  return successfulResultMessage({
    subtype: "error_during_execution",
    is_error: true,
    stop_reason: null,
    terminal_reason: "aborted_tools",
  });
}

/** The task that Claude Code starts for a command, or for a subagent with a `subagentType`. */
function taskStarted(
  taskId: string,
  toolUseId: string,
  subagentType?: string,
  backgrounded?: boolean,
) {
  return {
    type: "system",
    subtype: "task_started",
    session_id: sessionId,
    task_id: taskId,
    tool_use_id: toolUseId,
    description: "work",
    ...(subagentType ? { subagent_type: subagentType } : {}),
    ...(backgrounded ? { is_backgrounded: true } : {}),
  };
}

/** What the SDK reports for a task that the interrupt stopped. */
function taskStopped(taskId: string, toolUseId: string) {
  return {
    type: "system",
    subtype: "task_notification",
    session_id: sessionId,
    task_id: taskId,
    tool_use_id: toolUseId,
    status: "stopped",
    summary: "stopped",
    output_file: "",
  };
}

/** A command that the cancel stops: the stream ends in Claude Code's order. */
async function* interruptedBashMessages(input: Pushable<any>, agent: ClaudeAcpAgent) {
  yield* echoNextPrompt(input);
  yield toolStart();
  yield toolUse();
  yield taskStarted("bash-task", toolCallId);
  await agent.cancel({ sessionId });
  yield taskStopped("bash-task", toolCallId);
  yield interruptedResult();
  yield interruptNote;
  yield abortedResult();
}

/** A foreground Agent call whose subagent runs a command when the cancel stops it. */
async function* interruptedSubagentMessages(input: Pushable<any>, agent: ClaudeAcpAgent) {
  yield* echoNextPrompt(input);
  yield toolStart("parent-agent", null, "Agent");
  yield toolUse("parent-agent", null, "Agent", {
    description: "Run a slow command",
    subagent_type: "general-purpose",
    prompt: "Run it",
  });
  yield taskStarted("agent-1", "parent-agent", "general-purpose");
  yield toolStart("child-tool", "parent-agent");
  yield toolUse("child-tool", "parent-agent");
  yield taskStarted("bash-task", "child-tool");
  await agent.cancel({ sessionId });
  // Only the Agent call gets a result in the stream.
  yield taskStopped("bash-task", "child-tool");
  yield interruptedResult("parent-agent");
  yield taskStopped("agent-1", "parent-agent");
  yield interruptNote;
  yield abortedResult();
}

/** A command that a permission request announced without its subagent, and the stream attributed to it. */
async function* attributedLaterMessages(input: Pushable<any>, agent: ClaudeAcpAgent) {
  yield* echoNextPrompt(input);
  await agent.canUseTool(sessionId)("Bash", { command: "echo test" }, {
    toolUseID: "late-child",
    signal: new AbortController().signal,
    suggestions: [],
  } as any);
  yield toolUse("late-child", "parent-agent");
  await agent.cancel({ sessionId });
  yield abortedResult();
}

/** A foreground and a background subagent, each running a command, when the cancel arrives. */
async function* backgroundSubagentMessages(input: Pushable<any>, agent: ClaudeAcpAgent) {
  yield* echoNextPrompt(input);
  for (const [parent, task, background] of [
    ["fg-agent", "agent-fg", false],
    ["bg-agent", "agent-bg", true],
  ] as const) {
    yield toolStart(parent, null, "Agent");
    yield toolUse(parent, null, "Agent", { description: "Work", prompt: "Work" });
    yield taskStarted(task, parent, "general-purpose", background);
  }
  // The background Agent call is answered when its subagent launches.
  yield toolResult("bg-agent");
  for (const child of ["fg-child", "bg-child"]) {
    const parent = child === "fg-child" ? "fg-agent" : "bg-agent";
    yield toolStart(child, parent);
    yield toolUse(child, parent);
  }
  await agent.cancel({ sessionId });
  // The SDK stops the foreground subagent, and nothing says that the
  // background one ended.
  yield taskStopped("agent-fg", "fg-agent");
  yield interruptedResult("fg-agent");
  yield interruptNote;
  yield abortedResult();
}

/** A turn that the SDK never answers after the cancel, with a tool that ran and one that did not. */
async function* wedgedToolMessages(input: Pushable<any>) {
  yield* echoNextPrompt(input);
  yield toolStart();
  yield toolUse();
  // Claude abandoned this tool_use: no complete message holds it.
  yield toolStart("abandoned-tool");
  await new Promise<never>(() => {});
}

/** The stream still sends a tool_use start after the cancel, and the turn ends at the idle. */
async function* startAfterCancelMessages(input: Pushable<any>, agent: ClaudeAcpAgent) {
  yield* echoNextPrompt(input);
  await agent.cancel({ sessionId });
  yield toolStart();
  yield { type: "system", subtype: "session_state_changed", state: "idle" };
}

/** The result of the turn comes before Claude Code's result for the tool. */
async function* lateInterruptedResultMessages(
  input: Pushable<any>,
  agent: ClaudeAcpAgent,
  responded: Promise<void>,
) {
  yield* echoNextPrompt(input);
  yield toolStart();
  yield toolUse();
  await agent.cancel({ sessionId });
  yield abortedResult();
  await responded;
  yield interruptedResult();
}

async function* finishedAtCancelMessages(input: Pushable<any>, agent: ClaudeAcpAgent) {
  yield* echoNextPrompt(input);
  yield toolStart();
  yield toolUse();
  await agent.cancel({ sessionId });
  yield toolResult();
  yield abortedResult();
}

async function* strayResultMessages(input: Pushable<any>, agent: ClaudeAcpAgent) {
  yield* echoNextPrompt(input);
  await agent.cancel({ sessionId });
  yield interruptedResult("never-announced");
  yield abortedResult();
}

/** After the cancelled response, Claude Code runs a prompt that the cancel abandoned. */
async function* abandonedPromptToolMessages(
  input: Pushable<any>,
  agent: ClaudeAcpAgent,
  responded: Promise<void>,
) {
  yield* echoNextPrompt(input);
  await agent.cancel({ sessionId });
  yield abortedResult();
  await responded;
  await agent.canUseTool(sessionId)("Bash", { command: "echo abandoned" }, {
    toolUseID: "abandoned-tool",
    signal: new AbortController().signal,
    suggestions: [],
  } as any);
  yield toolResult("abandoned-tool");
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
