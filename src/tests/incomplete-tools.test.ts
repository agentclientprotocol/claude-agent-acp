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

// The agent reads the CLI's auth status on each prompt. Answer it, so that the
// tests checking `logError` don't see "claude auth status failed". The answer
// makes the agent send an auth status `extNotification`; the client stubs it.
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
          // A background subagent holds the turn open, and its command runs on.
          yield toolStart("bg-agent", null, "Agent");
          yield toolUse("bg-agent", null, "Agent", { description: "Work", prompt: "Work" });
          yield taskStarted("agent-bg", "bg-agent", "general-purpose", true);
          yield toolResult("bg-agent");
          yield toolStart("bg-child", "bg-agent");
          yield toolUse("bg-child", "bg-agent");
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
          updates.some((u) => u.toolCallId === "completed-tool" && u.status === "failed"),
        ).toBe(false);
        if (settlement === "deferred") {
          // The cancel did not stop the background subagent, so its command stays open.
          expect(updates.some((u) => u.toolCallId === "bg-child" && u.status === "failed")).toBe(
            false,
          );
          expect(agent.sessions[sessionId].emittedToolCalls.has("bg-child")).toBe(true);
        }
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

  it("closes each tool call once, before the response, when a cancel settles a held turn that the consumer is closing", async () => {
    let releasePublication!: () => void;
    const publicationGate = new Promise<void>((resolve) => (releasePublication = resolve));
    let firstHeld!: () => void;
    const publicationHeld = new Promise<void>((resolve) => (firstHeld = resolve));
    const { agent, prompt, updates, logError } = createTestSession(async function* (input, agent) {
      yield* echoNextPrompt(input);
      // A background subagent holds the turn open after its result.
      yield toolStart("bg-agent", null, "Agent");
      yield toolUse("bg-agent", null, "Agent", { description: "Work", prompt: "Work" });
      yield taskStarted("agent-bg", "bg-agent", "general-purpose", true);
      yield toolResult("bg-agent");
      yield successfulResultMessage();
      // The first cancel lands while a follow-up cycle runs two commands, so it
      // leaves the turn to the consumer, which settles it at the idle.
      yield { type: "system", subtype: "session_state_changed", state: "running" };
      yield toolStart();
      yield toolUse();
      yield toolStart("second-tool");
      yield toolUse("second-tool");
      await agent.cancel({ sessionId });
      yield { type: "system", subtype: "session_state_changed", state: "idle" };
    });
    const events: string[] = [];
    const publish = agent.client.sessionUpdate.bind(agent.client);
    agent.client.sessionUpdate = async (notification) => {
      const update = notification.update;
      if (update.sessionUpdate === "tool_call_update" && update.status === "failed") {
        if (update.toolCallId === toolCallId) {
          firstHeld();
          await publicationGate;
        }
        events.push(`end ${update.toolCallId}`);
      }
      await publish(notification);
    };

    try {
      const response = prompt().then((outcome) => {
        events.push("response");
        return outcome;
      });
      await publicationHeld;
      // The session now reads idle, so the second cancel settles the held turn
      // itself, while the consumer's first report is in flight.
      const cancel = agent.cancel({ sessionId });
      await vi.waitFor(() => expect(agent.sessions[sessionId].activeTurn).toBeNull());
      releasePublication();
      await cancel;
      await expect(response).resolves.toMatchObject({ stopReason: "cancelled" });
      expect(events).toEqual([`end ${toolCallId}`, "end second-tool", "response"]);
      expect(logError).not.toHaveBeenCalled();
      await agent.sessions[sessionId].consumer;
      expect(updates.filter((u) => u.status === "failed")).toHaveLength(2);
    } finally {
      releasePublication();
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

describe("the display terminal of a command that ends without a result", () => {
  const TERMINAL_CLIENT = { _meta: { terminal_output: true } };
  const AIR_TERMINAL_CLIENT = {
    _meta: { terminal_output: true, jetbrains: { air: { version: 1, capabilities: [] } } },
  };
  /** The reports that end the tool call `id`. */
  const endsOf = (updates: any[], id = toolCallId) =>
    updates.filter(
      (u) => u.toolCallId === id && ["completed", "failed", "cancelled"].includes(u.status),
    );

  /** Runs the cancelled turn of `interruptedSubagentMessages` for a client with `capabilities`. */
  async function cancelledSubagentCommand(capabilities: Record<string, unknown>) {
    const session = createTestSession(interruptedSubagentMessages);
    await session.agent.initialize({ protocolVersion: 1, clientCapabilities: capabilities });
    await expect(session.prompt()).resolves.toMatchObject({ stopReason: "cancelled" });
    return endsOf(session.updates, "child-tool");
  }

  it("ends the terminal of a command that a cancel closes", async () => {
    const [end, ...more] = await cancelledSubagentCommand(TERMINAL_CLIENT);

    expect(more).toEqual([]);
    // The report that ends the call ends its terminal too, and still names the subagent.
    expect(end).toMatchObject({
      status: "failed",
      _meta: {
        terminal_exit: { terminal_id: "child-tool", exit_code: null, signal: null },
        claudeCode: { parentToolUseId: "parent-agent" },
      },
    });
  });

  it("gives an AIR client the number that it reads for a command that did not succeed", async () => {
    const [end] = await cancelledSubagentCommand(AIR_TERMINAL_CLIENT);

    expect(end._meta.terminal_exit).toEqual({
      terminal_id: "child-tool",
      exit_code: 1,
      signal: null,
    });
  });

  it("sends no terminal exit to a client that renders no terminals", async () => {
    const [end] = await cancelledSubagentCommand({});

    expect(end._meta?.terminal_exit).toBeUndefined();
  });

  it("sends no terminal exit for a tool that is not a command", async () => {
    const session = createTestSession(interruptedSubagentReadMessages);
    await session.agent.initialize({ protocolVersion: 1, clientCapabilities: TERMINAL_CLIENT });

    await expect(session.prompt()).resolves.toMatchObject({ stopReason: "cancelled" });

    const [end] = endsOf(session.updates, "child-tool");
    expect(end.status).toBe("failed");
    expect(end._meta.terminal_exit).toBeUndefined();
  });

  it("ends the terminal of a command that ran, but got no result by the end of the turn", async () => {
    const session = createTestSession((input) => unfinishedToolMessages(input, "result"));
    await session.agent.initialize({ protocolVersion: 1, clientCapabilities: TERMINAL_CLIENT });

    await expect(session.prompt()).rejects.toMatchObject({
      data: { errorKind: "incomplete_tool_call" },
    });

    const [end] = endsOf(session.updates);
    expect(end.content[0].content.text).toContain("without returning a result");
    expect(end._meta.terminal_exit).toEqual({
      terminal_id: toolCallId,
      exit_code: null,
      signal: null,
    });
  });

  it("ends the terminal of a command that Claude abandoned before it ran", async () => {
    const session = createTestSession(abandonedToolMessages);
    await session.agent.initialize({ protocolVersion: 1, clientCapabilities: TERMINAL_CLIENT });

    await expect(session.prompt()).resolves.toMatchObject({ stopReason: "end_turn" });

    const [end] = endsOf(session.updates);
    expect(end.content[0].content.text).toBe("Claude stopped this tool call before it ran.");
    expect(end._meta.terminal_exit).toMatchObject({ terminal_id: toolCallId });
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

  describe("of a cycle that Claude Code started on its own, which v1 does not report", () => {
    it("delivers Claude Code's interrupted result for the cycle's command", async () => {
      const { prompt, updates, agent, logError } = createTestSession(cancelledCycleMessages);

      await expect(prompt()).resolves.toMatchObject({ stopReason: "end_turn" });
      await agent.sessions[sessionId].consumer;

      // v1 reports nothing for the cycle, so it ends at its result: until then,
      // Claude Code's result for its command still reaches the client.
      const [end, ...more] = ends(updates, "cycle-tool");
      expect(more).toEqual([]);
      expect(end).toMatchObject({
        status: "failed",
        _meta: { claudeCode: { nonExecutionKind: "user-rejected" } },
      });
      expect(textOf(end)).toContain("doesn't want to proceed with this tool use");
      expect(agent.sessions[sessionId].emittedToolCalls.size).toBe(0);
      expect(logError).not.toHaveBeenCalled();
    });

    it("delivers the result of its Agent call, and closes the command of the subagent, which Claude Code reports no result for", async () => {
      const { prompt, updates, agent, logError } = createTestSession(cancelledCycleAgentMessages);

      await expect(prompt()).resolves.toMatchObject({ stopReason: "end_turn" });
      await agent.sessions[sessionId].consumer;

      const [agentEnd, ...moreAgentEnds] = ends(updates, "cycle-agent");
      expect(moreAgentEnds).toEqual([]);
      expect(textOf(agentEnd)).toContain("doesn't want to proceed with this tool use");
      const [childEnd, ...moreChildEnds] = ends(updates, "cycle-child");
      expect(moreChildEnds).toEqual([]);
      expect(childEnd).toMatchObject({
        status: "failed",
        _meta: { claudeCode: { parentToolUseId: "cycle-agent" } },
      });
      expect(textOf(childEnd)).toBe(
        "The turn was cancelled before this tool call returned a result.",
      );
      expect(agent.sessions[sessionId].emittedToolCalls.size).toBe(0);
      expect(logError).not.toHaveBeenCalled();
    });

    it("closes a call that gets no result at the idle that ends the cycle, and drops what comes after", async () => {
      const { prompt, updates, agent, logError } = createTestSession(cycleEndedByIdleMessages);

      await expect(prompt()).resolves.toMatchObject({ stopReason: "end_turn" });
      await agent.sessions[sessionId].consumer;

      // Claude Code's result comes only after the idle that ended the cycle, so
      // the call was closed at the idle, and the late result is dropped.
      const [end, ...more] = ends(updates, "cycle-tool");
      expect(more).toEqual([]);
      expect(textOf(end)).toBe("The turn was cancelled before this tool call returned a result.");
      expect(agent.sessions[sessionId].emittedToolCalls.size).toBe(0);
      expect(logError).not.toHaveBeenCalled();
    });
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

describe("tool calls of a background subagent that a cancel stops", () => {
  /** The reports that end the tool call `id`. */
  const ends = (updates: any[], id: string) =>
    updates.filter(
      (u) => u.toolCallId === id && ["completed", "failed", "cancelled"].includes(u.status),
    );
  const textOf = (update: any): string =>
    (update.content ?? []).map((item: any) => item.content?.text).join("");

  /**
   * Runs the fixture until two background subagents each run a command, and
   * the cancel (if any) came. `settlement` is what the cancel finds: a turn
   * that v1 holds open for the subagents, which the cancel settles at once, or
   * no turn, because it ended earlier. Then the SDK reports how the first
   * subagent ended (`reports`). Returns the updates that its reports caused.
   */
  async function endFirstSubagent(
    settlement: "held turn" | "no turn",
    options: { cancel?: boolean; reports?: SubagentEndReports } = {},
  ) {
    const { cancel = true, reports = "both" } = options;
    const reported = Promise.withResolvers<void>();
    const session = createTestSession((input) =>
      backgroundSubagentsEndMessages(input, settlement, reported.promise, reports),
    );
    const { agent, updates } = session;
    const first = session.prompt();
    await vi.waitFor(() => {
      const state = agent.sessions[sessionId];
      expect(state.emittedToolCalls.has("bg-child-2")).toBe(true);
      if (settlement === "held turn") expect(state.activeTurn?.deferredSettle).toBeDefined();
    });
    if (cancel) await agent.cancel({ sessionId });
    if (settlement === "held turn" && cancel) {
      await expect(first).resolves.toMatchObject({ stopReason: "cancelled" });
    }
    const before = updates.length;
    reported.resolve();
    await agent.sessions[sessionId].consumer;
    return { ...session, before, afterReports: updates.slice(before) };
  }

  it.each([
    ["held turn", "both"],
    ["no turn", "both"],
    // Each report alone ends the subagent, and the SDK can send either.
    ["no turn", "update only"],
    ["no turn", "notification only"],
  ] as const)(
    "closes the command of a subagent that the SDK reports stopped after the cancel (%s, %s)",
    async (settlement, reports) => {
      const { updates, agent, logError, before, afterReports } = await endFirstSubagent(
        settlement,
        { reports },
      );

      // The cancel left the command open, since its subagent ran. The SDK then
      // stopped the subagent, and Claude Code's result for the command came after
      // the work's end, which is dropped like all output after it.
      expect(ends(updates.slice(0, before), "bg-child-1")).toEqual([]);
      const [end, ...more] = ends(afterReports, "bg-child-1");
      expect(more).toEqual([]);
      expect(end).toMatchObject({
        status: "failed",
        _meta: { claudeCode: { parentToolUseId: "bg-agent-1" } },
      });
      expect(textOf(end)).toBe("The turn was cancelled before this tool call returned a result.");
      expect(logError).not.toHaveBeenCalled();
      // The other subagent runs on, and so does its command.
      expect(ends(updates, "bg-child-2")).toEqual([]);
      expect([...agent.sessions[sessionId].emittedToolCalls]).toEqual(["bg-child-2"]);
      expect([...(agent.sessions[sessionId].toolCallParents ?? [])]).toEqual([
        ["bg-child-2", "bg-agent-2"],
      ]);
    },
  );

  it("leaves the command of a subagent that completed after the cancel as it is", async () => {
    const { afterReports } = await endFirstSubagent("no turn", { reports: "completed" });

    // The subagent was not stopped, so nothing says that its command was cancelled.
    expect(ends(afterReports, "bg-child-1")).toEqual([]);
  });

  it("leaves a subagent that stopped without a cancel to Claude Code's result", async () => {
    const { updates, logError } = await endFirstSubagent("no turn", { cancel: false });

    // For example, the model stops the subagent. Its command gets Claude Code's
    // own result, and no report is made up for it first.
    const [end, ...more] = ends(updates, "bg-child-1");
    expect(more).toEqual([]);
    expect(textOf(end)).toContain("doesn't want to proceed with this tool use");
    expect(logError).not.toHaveBeenCalled();
  });

  it("leaves the command of a subagent that stopped before the work's end to Claude Code's result", async () => {
    const { prompt, updates, logError } = createTestSession(stoppedMidTurnSubagentMessages);

    await expect(prompt()).resolves.toMatchObject({ stopReason: "cancelled" });

    // The turn still runs, so the result of the command reaches the client.
    const [end, ...more] = ends(updates, "bg-child-1");
    expect(more).toEqual([]);
    expect(textOf(end)).toContain("doesn't want to proceed with this tool use");
    expect(logError).not.toHaveBeenCalled();
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

/** Like `interruptedSubagentMessages`, but the subagent reads a file, not runs a command. */
async function* interruptedSubagentReadMessages(input: Pushable<any>, agent: ClaudeAcpAgent) {
  yield* echoNextPrompt(input);
  yield toolStart("parent-agent", null, "Agent");
  yield toolUse("parent-agent", null, "Agent", {
    description: "Read a file",
    subagent_type: "general-purpose",
    prompt: "Read it",
  });
  yield taskStarted("agent-1", "parent-agent", "general-purpose");
  yield toolStart("child-tool", "parent-agent", "Read");
  yield toolUse("child-tool", "parent-agent", "Read", { file_path: "/test/file.txt" });
  await agent.cancel({ sessionId });
  yield taskStopped("agent-1", "parent-agent");
  yield interruptedResult("parent-agent");
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

/** The reports with which the SDK ends a subagent: a patch and a notification, or one of them. */
type SubagentEndReports = "both" | "update only" | "notification only" | "completed";

/**
 * Two background subagents each run a command. With a "held turn", the turn's
 * result came while they run, so v1 holds the turn for them; with "no turn",
 * Claude Code's own follow-up started them after the turn ended, and that
 * follow-up ended too. After `reported`, the SDK reports how the first
 * subagent ended, and Claude Code's result for its command.
 */
async function* backgroundSubagentsEndMessages(
  input: Pushable<any>,
  settlement: "held turn" | "no turn",
  reported: Promise<void>,
  reports: SubagentEndReports,
) {
  yield* echoNextPrompt(input);
  if (settlement === "no turn") {
    yield successfulResultMessage();
    yield { type: "system", subtype: "session_state_changed", state: "idle" };
  }
  for (const n of [1, 2]) {
    yield toolStart(`bg-agent-${n}`, null, "Agent");
    yield toolUse(`bg-agent-${n}`, null, "Agent", { description: "Work", prompt: "Work" });
    yield taskStarted(`agent-bg-${n}`, `bg-agent-${n}`, "general-purpose", true);
    yield toolResult(`bg-agent-${n}`);
    yield toolStart(`bg-child-${n}`, `bg-agent-${n}`);
    yield toolUse(`bg-child-${n}`, `bg-agent-${n}`);
  }
  if (settlement === "held turn") yield successfulResultMessage();
  else {
    yield successfulResultMessage({ origin: { kind: "task-notification" } });
    yield { type: "system", subtype: "session_state_changed", state: "idle" };
  }
  await reported;
  const done = { type: "system", session_id: sessionId, task_id: "agent-bg-1" };
  if (reports === "completed") {
    yield { ...done, subtype: "task_updated", patch: { status: "completed" } };
    yield {
      ...done,
      subtype: "task_notification",
      tool_use_id: "bg-agent-1",
      status: "completed",
      summary: "done",
      output_file: "",
    };
  } else {
    if (reports !== "notification only") {
      yield { ...done, subtype: "task_updated", patch: { status: "killed" } };
    }
    if (reports !== "update only") yield taskStopped("agent-bg-1", "bg-agent-1");
    // Claude Code's result for the command comes after the stop.
    yield interruptedResult("bg-child-1", "bg-agent-1");
  }
  yield { type: "system", subtype: "session_state_changed", state: "idle" };
}

/** A background subagent stops while the cancelled turn still runs, and Claude Code sends the result of its command. */
async function* stoppedMidTurnSubagentMessages(input: Pushable<any>, agent: ClaudeAcpAgent) {
  yield* echoNextPrompt(input);
  yield toolStart("bg-agent-1", null, "Agent");
  yield toolUse("bg-agent-1", null, "Agent", { description: "Work", prompt: "Work" });
  yield taskStarted("agent-bg-1", "bg-agent-1", "general-purpose", true);
  yield toolResult("bg-agent-1");
  yield toolStart("bg-child-1", "bg-agent-1");
  yield toolUse("bg-child-1", "bg-agent-1");
  await agent.cancel({ sessionId });
  yield taskStopped("agent-bg-1", "bg-agent-1");
  yield interruptedResult("bg-child-1", "bg-agent-1");
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

/** After the turn ended, Claude Code's own follow-up starts a command, and the cancel stops it. */
async function* cancelledCycleMessages(input: Pushable<any>, agent: ClaudeAcpAgent) {
  yield* echoNextPrompt(input);
  yield successfulResultMessage();
  yield { type: "system", subtype: "session_state_changed", state: "idle" };
  yield toolStart("cycle-tool");
  yield toolUse("cycle-tool");
  await agent.cancel({ sessionId });
  yield interruptedResult("cycle-tool");
  yield { ...abortedResult(), origin: { kind: "task-notification" } };
  yield { type: "system", subtype: "session_state_changed", state: "idle" };
}

/**
 * After the turn ended, Claude Code's own follow-up runs a foreground subagent
 * that runs a command, and the cancel stops both. As seen live: the SDK reports
 * the subagent stopped, and Claude Code sends the Agent call's interrupted
 * result, but none for the subagent's command.
 */
async function* cancelledCycleAgentMessages(input: Pushable<any>, agent: ClaudeAcpAgent) {
  yield* echoNextPrompt(input);
  yield successfulResultMessage();
  yield { type: "system", subtype: "session_state_changed", state: "idle" };
  yield toolStart("cycle-agent", null, "Agent");
  yield toolUse("cycle-agent", null, "Agent", { description: "Work", prompt: "Work" });
  yield taskStarted("agent-fg", "cycle-agent", "general-purpose");
  yield toolStart("cycle-child", "cycle-agent");
  yield toolUse("cycle-child", "cycle-agent");
  await agent.cancel({ sessionId });
  yield taskStopped("agent-fg", "cycle-agent");
  yield interruptedResult("cycle-agent");
  yield interruptNote;
  yield { ...abortedResult(), origin: { kind: "task-notification" } };
  yield { type: "system", subtype: "session_state_changed", state: "idle" };
}

/** A cancelled follow-up ends at an idle with no result, and Claude Code's result for its command comes after. */
async function* cycleEndedByIdleMessages(input: Pushable<any>, agent: ClaudeAcpAgent) {
  yield* echoNextPrompt(input);
  yield successfulResultMessage();
  yield { type: "system", subtype: "session_state_changed", state: "idle" };
  yield toolStart("cycle-tool");
  yield toolUse("cycle-tool");
  await agent.cancel({ sessionId });
  yield { type: "system", subtype: "session_state_changed", state: "idle" };
  yield interruptedResult("cycle-tool");
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
