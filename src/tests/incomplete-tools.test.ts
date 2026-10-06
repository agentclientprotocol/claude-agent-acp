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

vi.mock("node:child_process", async () => ({
  ...(await vi.importActual<typeof import("node:child_process")>("node:child_process")),
  execFile: (...args: unknown[]) =>
    (args[args.length - 1] as (...values: unknown[]) => void)(null, {
      stdout: JSON.stringify({ loggedIn: false, authMethod: "none", apiProvider: "firstParty" }),
      stderr: "",
    }),
}));

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
    // The cancelled turn's tool start must get a terminal at the cancel
    // boundary, not be left open for a client's in-flight ledger to inherit
    // (issue #1061). It is a cancellation, not an incomplete-tool failure.
    const terminals = updates.filter((u) => u.toolCallId === toolCallId && u.status === "failed");
    expect(terminals).toHaveLength(1);
    expect(terminals[0].content[0].content.text).toContain("cancelled");
    const terminalsBeforeNextTurn = terminals.length;
    await expect(prompt()).resolves.toMatchObject({ stopReason: "end_turn" });
    // ...and the next turn neither re-fails it nor reports an incomplete tool.
    expect(
      updates.filter((u) => u.toolCallId === toolCallId && u.status === "failed"),
    ).toHaveLength(terminalsBeforeNextTurn);
  });

  it("terminates a tool whose start streams in after the cancel", async () => {
    const { prompt, updates, agent } = createTestSession(cancelThenLateToolStartMessages);

    await expect(prompt()).resolves.toMatchObject({ stopReason: "cancelled" });
    expect(agent.sessions[sessionId].emittedToolCalls.size).toBe(0);
    expect(
      updates.filter((u) => u.toolCallId === toolCallId && u.status === "failed"),
    ).toHaveLength(1);
  });

  it.each(["deferred", "checkpoint"] as const)(
    "terminates unfinished tools when cancel settles a %s turn inline",
    async (settlement) => {
      let releaseStream!: () => void;
      const streamGate = new Promise<void>((resolve) => (releaseStream = resolve));
      const { agent, prompt, updates, logError } = createTestSession(async function* (input) {
        yield* echoNextPrompt(input);
        if (settlement === "deferred") {
          yield toolStart();
          yield toolUse();
          yield toolStart("second-tool");
          yield toolUse("second-tool");
          yield toolStart("completed-tool");
          yield toolResult("completed-tool");
          yield toolStart("background-tool");
          yield toolUse("background-tool");
          yield {
            type: "system",
            subtype: "task_started",
            session_id: sessionId,
            task_id: "background-shell",
            tool_use_id: "background-tool",
            description: "dev server",
          };
          yield {
            type: "system",
            subtype: "task_started",
            session_id: sessionId,
            task_id: "child",
            tool_use_id: "parent-agent",
            subagent_type: "Explore",
            description: "investigate",
          };
        }
        yield successfulResultMessage();
        await streamGate;
        yield { type: "system", subtype: "session_state_changed", state: "idle" };
        yield* echoNextPrompt(input);
        yield successfulResultMessage();
      });
      if (settlement === "checkpoint") {
        agent.sessions[sessionId].fileChangeReporter = {
          request: vi.fn(),
          report: vi.fn(() => streamGate),
          finish: vi.fn(),
        } as any;
      }

      try {
        const first = prompt();
        await vi.waitFor(() => {
          const active = agent.sessions[sessionId].activeTurn;
          expect(
            settlement === "deferred" ? active?.deferredSettle : active?.settlingOutcome,
          ).toBeDefined();
        });
        if (settlement === "checkpoint") {
          for (const id of [toolCallId, "second-tool"]) {
            await agent.canUseTool(sessionId)("Bash", { command: "echo test" }, {
              toolUseID: id,
              signal: new AbortController().signal,
              suggestions: [],
            } as any);
          }
        }
        const active = agent.sessions[sessionId].activeTurn!;
        const pendingOutcome = active.deferredSettle ?? active.settlingOutcome!;
        await agent.cancel({ sessionId });
        await expect(first).resolves.toEqual({
          ...pendingOutcome,
          stopReason: "cancelled",
        });
        for (const id of [toolCallId, "second-tool"]) {
          const terminals = updates.filter((u) => u.toolCallId === id && u.status === "failed");
          expect(terminals).toHaveLength(1);
          expect(terminals[0].content[0].content.text).toContain("cancelled");
          expect(agent.sessions[sessionId].emittedToolCalls.has(id)).toBe(false);
          expect(agent.sessions[sessionId].toolUseCache).not.toHaveProperty(id);
          expect(agent.sessions[sessionId].dispatchedToolCalls?.has(id)).not.toBe(true);
          expect(hasHookCallback(id)).toBe(false);
        }
        expect(
          updates.some(
            (u) =>
              ["completed-tool", "background-tool"].includes(u.toolCallId) && u.status === "failed",
          ),
        ).toBe(false);
        await agent.cancel({ sessionId });
        releaseStream();
        await expect(prompt()).resolves.toMatchObject({ stopReason: "end_turn" });
        expect(updates.filter((u) => u.status === "failed")).toHaveLength(2);
        expect(logError).not.toHaveBeenCalled();
        await agent.sessions[sessionId].consumer;
      } finally {
        releaseStream();
      }
    },
  );

  it.each(["overlapping", "simultaneous"] as const)(
    "does not duplicate tool terminals with %s cancellations",
    async (ordering) => {
      let releaseStream!: () => void;
      const streamGate = new Promise<void>((resolve) => (releaseStream = resolve));
      let releasePublication!: () => void;
      const publicationGate = new Promise<void>((resolve) => (releasePublication = resolve));
      let firstPublished!: () => void;
      const publicationStarted = new Promise<void>((resolve) => (firstPublished = resolve));
      const { agent, prompt, updates } = createTestSession(async function* (input) {
        yield* echoNextPrompt(input);
        yield toolStart();
        yield toolStart("second-tool");
        yield {
          type: "system",
          subtype: "task_started",
          session_id: sessionId,
          task_id: "child",
          tool_use_id: "parent-agent",
          subagent_type: "Explore",
          description: "investigate",
        };
        yield successfulResultMessage();
        await streamGate;
      });
      const publish = agent.client.sessionUpdate.bind(agent.client);
      agent.client.sessionUpdate = async (notification) => {
        await publish(notification);
        const update = notification.update;
        if (
          update.sessionUpdate === "tool_call_update" &&
          update.toolCallId === toolCallId &&
          update.status === "failed"
        ) {
          firstPublished();
          await publicationGate;
        }
      };

      try {
        const first = prompt();
        await vi.waitFor(() => {
          expect(agent.sessions[sessionId].activeTurn?.deferredSettle).toBeDefined();
        });
        if (ordering === "simultaneous") {
          const cancel = Promise.all([agent.cancel({ sessionId }), agent.cancel({ sessionId })]);
          await publicationStarted;
          releasePublication();
          await cancel;
        } else {
          const cancel = agent.cancel({ sessionId });
          await publicationStarted;
          await agent.cancel({ sessionId });
          releasePublication();
          await cancel;
        }
        await expect(first).resolves.toMatchObject({ stopReason: "cancelled" });
        for (const id of [toolCallId, "second-tool"]) {
          expect(updates.filter((u) => u.toolCallId === id && u.status === "failed")).toHaveLength(
            1,
          );
        }
        expect(agent.sessions[sessionId].emittedToolCalls.size).toBe(0);
        releaseStream();
        await agent.sessions[sessionId].consumer;
      } finally {
        releasePublication();
        releaseStream();
      }
    },
  );

  it("still interrupts the SDK when inline tool terminal publication fails", async () => {
    let releaseCheckpoint!: () => void;
    const checkpointGate = new Promise<void>((resolve) => (releaseCheckpoint = resolve));
    const { agent, prompt, logError } = createTestSession(async function* (input) {
      yield* echoNextPrompt(input);
      yield successfulResultMessage();
    });
    agent.sessions[sessionId].fileChangeReporter = {
      request: vi.fn(),
      report: vi.fn(() => checkpointGate),
      finish: vi.fn(),
    } as any;
    const publish = agent.client.sessionUpdate.bind(agent.client);
    const error = new Error("terminal publication failed");
    agent.client.sessionUpdate = async (notification) => {
      const update = notification.update;
      if (update.sessionUpdate === "tool_call_update" && update.status === "failed") {
        throw error;
      }
      await publish(notification);
    };
    try {
      const first = prompt();
      await vi.waitFor(() => {
        expect(agent.sessions[sessionId].activeTurn?.settlingOutcome).toBeDefined();
      });
      await agent.canUseTool(sessionId)("Bash", { command: "echo test" }, {
        toolUseID: toolCallId,
        signal: new AbortController().signal,
        suggestions: [],
      } as any);
      await expect(agent.cancel({ sessionId })).resolves.toBeUndefined();
      await expect(first).resolves.toMatchObject({ stopReason: "cancelled" });
      expect(agent.sessions[sessionId].query.interrupt).toHaveBeenCalledTimes(1);
      expect(logError).toHaveBeenCalledExactlyOnceWith(
        `Session ${sessionId}: failed to publish cancelled tool state`,
        error,
      );
      releaseCheckpoint();
      await agent.sessions[sessionId].consumer;
    } finally {
      releaseCheckpoint();
    }
  });

  it("keeps cancellation authoritative when a checkpoint finishes during tool cleanup", async () => {
    let releaseCheckpoint!: () => void;
    const checkpointGate = new Promise<void>((resolve) => (releaseCheckpoint = resolve));
    let checkpointDrained!: () => void;
    const consumerAdvanced = new Promise<void>((resolve) => (checkpointDrained = resolve));
    let releaseStream!: () => void;
    const streamGate = new Promise<void>((resolve) => (releaseStream = resolve));
    let releasePublication!: () => void;
    const publicationGate = new Promise<void>((resolve) => (releasePublication = resolve));
    let firstPublished!: () => void;
    const publicationStarted = new Promise<void>((resolve) => (firstPublished = resolve));
    const { agent, prompt } = createTestSession(async function* (input) {
      yield* echoNextPrompt(input);
      yield successfulResultMessage();
      checkpointDrained();
      await streamGate;
    });
    agent.sessions[sessionId].fileChangeReporter = {
      request: vi.fn(),
      report: vi.fn(() => checkpointGate),
      finish: vi.fn(),
    } as any;
    const publish = agent.client.sessionUpdate.bind(agent.client);
    agent.client.sessionUpdate = async (notification) => {
      await publish(notification);
      const update = notification.update;
      if (
        update.sessionUpdate === "tool_call_update" &&
        update.toolCallId === toolCallId &&
        update.status === "failed"
      ) {
        firstPublished();
        await publicationGate;
      }
    };

    try {
      let responded = false;
      const first = prompt().then((response) => {
        responded = true;
        return response;
      });
      await vi.waitFor(() => {
        expect(agent.sessions[sessionId].activeTurn?.settlingOutcome).toBeDefined();
      });
      await agent.canUseTool(sessionId)("Bash", { command: "echo test" }, {
        toolUseID: toolCallId,
        signal: new AbortController().signal,
        suggestions: [],
      } as any);
      const cancel = agent.cancel({ sessionId });
      await publicationStarted;
      releaseCheckpoint();
      await consumerAdvanced;
      expect(responded).toBe(false);
      releasePublication();
      await cancel;
      await expect(first).resolves.toMatchObject({ stopReason: "cancelled" });
      releaseStream();
      await agent.sessions[sessionId].consumer;
    } finally {
      releaseCheckpoint();
      releasePublication();
      releaseStream();
    }
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
      extNotification: async () => {},
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

async function* cancelThenLateToolStartMessages(input: Pushable<any>, agent: ClaudeAcpAgent) {
  const messages = input[Symbol.asyncIterator]();
  yield userEcho((await messages.next()).value);
  await agent.cancel({ sessionId });
  // The late SDK flush: a tool start that streams in after the cancel but
  // before the turn's trailing idle settles it. No tool_result will follow.
  yield toolStart();
  yield { type: "system", subtype: "session_state_changed", state: "idle" };
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
