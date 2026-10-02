/**
 * The turn lifecycle that the agent reports through `TurnEvents`, which each
 * ACP version maps to its own messages. A scripted SDK query stands in for
 * Claude Code: it echoes each prompt, then runs the turn's script.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RequestPermissionRequest, SessionNotification } from "@agentclientprotocol/sdk";
import type { AcpClient, ClaudeAcpAgent } from "../acp-agent.js";
import type { TurnEvents } from "../turn-events.js";
import { DEFAULT_CONTEXT_USAGE } from "./helpers.js";
import { randomUUID } from "node:crypto";

const mockQuery = vi.hoisted(() => vi.fn());

vi.mock("@anthropic-ai/claude-agent-sdk", async () => ({
  ...(await vi.importActual<typeof import("@anthropic-ai/claude-agent-sdk")>(
    "@anthropic-ai/claude-agent-sdk",
  )),
  query: mockQuery,
}));

// The agent reads the CLI's auth status on each prompt; keep it off the real CLI.
vi.mock("node:child_process", async () => ({
  ...(await vi.importActual<typeof import("node:child_process")>("node:child_process")),
  execFile: (...args: unknown[]) =>
    (args[args.length - 1] as (error: Error) => void)(new Error("no CLI in tests")),
}));

vi.mock("../tools.js", async () => ({
  ...(await vi.importActual<typeof import("../tools.js")>("../tools.js")),
  registerHookCallback: vi.fn(),
}));

type QueryOptions = {
  sessionId?: string;
  canUseTool: (
    toolName: string,
    input: Record<string, unknown>,
    extra: Record<string, unknown>,
  ) => Promise<unknown>;
};

/** The SDK side of one turn, after the echo of its prompt. */
type TurnScript = (options: QueryOptions) => AsyncGenerator<Record<string, unknown>>;

function result(sessionId: string) {
  return {
    type: "result",
    subtype: "success",
    stop_reason: "end_turn",
    is_error: false,
    result: "done",
    errors: [],
    duration_ms: 0,
    duration_api_ms: 0,
    num_turns: 1,
    total_cost_usd: 0,
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
    modelUsage: {},
    permission_denials: [],
    uuid: randomUUID(),
    session_id: sessionId,
  };
}

/** Claude Code's echo of a prompt it took in. */
function echo(prompt: { uuid: string; message: unknown }, sessionId: string) {
  return {
    type: "user",
    message: prompt.message,
    parent_tool_use_id: null,
    uuid: prompt.uuid,
    session_id: sessionId,
    isReplay: true,
  };
}

/** Scripts the query of the next session: each prompt runs the next turn script. */
function scriptTurns(turns: TurnScript[], end: "stay open" | "end stream" = "stay open") {
  const promptUuids: string[] = [];
  scriptQuery(async function* (input, options) {
    for (const turn of turns) {
      const { value, done } = await input.next();
      if (done) return;
      promptUuids.push(value.uuid);
      yield echo(value, options.sessionId!);
      for await (const message of turn(options)) yield message;
    }
    if (end === "stay open") await input.next();
  });
  return promptUuids;
}

/**
 * Scripts the query of the next session as `run`, which reads the prompts.
 * `controls` override the query's control requests, such as `interrupt`.
 */
function scriptQuery(
  run: (
    input: AsyncIterator<any>,
    options: QueryOptions,
  ) => AsyncGenerator<Record<string, unknown>>,
  controls: Record<string, unknown> = {},
) {
  mockQuery.mockImplementation(
    ({ prompt, options }: { prompt: AsyncIterable<any>; options: QueryOptions }) => {
      const sessionOptions = { ...options, sessionId: options.sessionId ?? "session" };
      return Object.assign(run(prompt[Symbol.asyncIterator](), sessionOptions), {
        initializationResult: async () => ({
          models: [{ value: "default", displayName: "Default", description: "" }],
        }),
        setModel: async () => {},
        setPermissionMode: async () => {},
        supportedCommands: async () => [],
        mcpServerStatus: async () => [],
        getContextUsage: async () => DEFAULT_CONTEXT_USAGE,
        close: () => {},
        interrupt: async () => {},
        stopTask: async () => {},
        ...controls,
      });
    },
  );
}

/**
 * Records the events of one turn as readable strings, into `log` when given,
 * so several turns and the client's updates share one ordered trace.
 */
function recordEvents(log: string[] = [], label?: string) {
  const done = Promise.withResolvers<void>();
  const push = (entry: string) => log.push(label ? `${label} ${entry}` : entry);
  const events: TurnEvents = {
    inserted: (messageId) => push(`inserted ${messageId}`),
    awaitingUser: () => push("awaitingUser"),
    resumed: () => push("resumed"),
    ended: (outcome) => {
      push(`ended ${outcome.stopReason}`);
      done.resolve();
    },
    failed: (error) => {
      push(`failed ${error instanceof Error ? error.message : String(error)}`);
      done.resolve();
    },
  };
  return { log, events, done: done.promise };
}

function lifecycle(commandUuid: string, state: string, sessionId: string) {
  return {
    type: "command_lifecycle",
    command_uuid: commandUuid,
    state,
    uuid: randomUUID(),
    session_id: sessionId,
  };
}

function stream(event: Record<string, unknown>, sessionId: string) {
  return {
    type: "stream_event",
    event,
    parent_tool_use_id: null,
    uuid: randomUUID(),
    session_id: sessionId,
  };
}

/** The start of an answer that streams one text delta. */
function streamedText(messageId: string, text: string, sessionId: string) {
  return [
    stream(
      {
        type: "message_start",
        message: { id: messageId, role: "assistant", content: [], usage: {} },
      },
      sessionId,
    ),
    stream(
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
      sessionId,
    ),
  ];
}

function system(subtype: string, sessionId: string, fields: Record<string, unknown> = {}) {
  return { type: "system", subtype, uuid: randomUUID(), session_id: sessionId, ...fields };
}

describe("turn events", () => {
  let agent: ClaudeAcpAgent;
  let permissionRequests: RequestPermissionRequest[];
  /** The user answers a request for this tool call only once it resolves. */
  let backgroundAnswer: PromiseWithResolvers<void>;
  /** Sees each session update; the agent waits until it returns. */
  let onSessionUpdate: (notification: SessionNotification) => Promise<void> | void;

  beforeEach(async () => {
    vi.resetModules();
    permissionRequests = [];
    backgroundAnswer = Promise.withResolvers<void>();
    onSessionUpdate = () => {};
    const { ClaudeAcpAgent } = await import("../acp-agent.js");
    agent = new ClaudeAcpAgent({
      sessionUpdate: async (notification: SessionNotification) => onSessionUpdate(notification),
      extNotification: async () => {},
      requestPermission: async (request: RequestPermissionRequest) => {
        permissionRequests.push(request);
        await new Promise((resolve) => setTimeout(resolve, 1));
        if (request.toolCall.toolCallId === "toolu_background") await backgroundAnswer.promise;
        const allow = request.options.find((option) => option.kind === "allow_once");
        return { outcome: { outcome: "selected", optionId: allow!.optionId } };
      },
    } as unknown as AcpClient);
  });

  afterEach(async () => {
    await agent.dispose();
  });

  async function newSession() {
    const { sessionId } = await agent.newSession({ cwd: process.cwd(), mcpServers: [] });
    return sessionId;
  }

  const prompt = (sessionId: string, text: string) => ({
    sessionId,
    prompt: [{ type: "text" as const, text }],
  });

  it("reports a turn as inserted under the uuid of its user message, then ended", async () => {
    const promptUuids = scriptTurns([
      async function* (options) {
        yield result(options.sessionId!);
      },
    ]);
    const sessionId = await newSession();
    const turn = recordEvents();

    await agent.startTurn(prompt(sessionId, "hello"), turn.events);
    await turn.done;

    expect(turn.log).toEqual([`inserted ${promptUuids[0]}`, "ended end_turn"]);
  });

  it("reports a turn inserted when Claude Code starts it, before output that comes before its echo", async () => {
    const trace: string[] = [];
    onSessionUpdate = ({ update }) => {
      // The turn's answer; the session also sends advisories as chunks.
      if (update.sessionUpdate === "agent_message_chunk" && update.messageId === "msg_answer") {
        trace.push("chunk");
      }
    };
    let promptUuid = "";
    scriptQuery(async function* (input, options) {
      const { value } = await input.next();
      promptUuid = value.uuid;
      // A fresh turn reports "started" before anything it produces; its
      // answer can then stream before the echo of its prompt.
      yield lifecycle(value.uuid, "started", options.sessionId!);
      yield* streamedText("msg_answer", "Hello", options.sessionId!);
      yield echo(value, options.sessionId!);
      yield result(options.sessionId!);
      await input.next();
    });
    const sessionId = await newSession();
    const turn = recordEvents(trace);

    await agent.startTurn(prompt(sessionId, "hello"), turn.events);
    await turn.done;

    expect(trace).toEqual([`inserted ${promptUuid}`, "chunk", "ended end_turn"]);
  });

  it("reports a turn inserted only after a held turn before it ended", async () => {
    const trace: string[] = [];
    scriptQuery(async function* (input, options) {
      const sessionId = options.sessionId!;
      const first = (await input.next()).value;
      yield lifecycle(first.uuid, "started", sessionId);
      yield echo(first, sessionId);
      yield system("task_started", sessionId, {
        task_id: "agent-1",
        tool_use_id: "toolu_agent-1",
        description: "Explore the project",
        subagent_type: "Explore",
      });
      // The result is held for the live background subagent.
      yield result(sessionId);
      yield system("session_state_changed", sessionId, { state: "idle" });
      const second = (await input.next()).value;
      // The next prompt starts a turn while the first is still held.
      yield lifecycle(second.uuid, "started", sessionId);
      yield echo(second, sessionId);
      yield result(sessionId);
      await input.next();
    });
    const sessionId = await newSession();
    const first = recordEvents(trace, "first");
    const second = recordEvents(trace, "second");

    await agent.startTurn(prompt(sessionId, "explore"), first.events);
    await vi.waitFor(() =>
      expect(agent.sessions[sessionId]?.activeTurn?.deferredSettle).toBeDefined(),
    );
    await agent.startTurn(prompt(sessionId, "next"), second.events);
    await Promise.all([first.done, second.done]);

    expect(trace).toEqual([
      expect.stringMatching(/^first inserted /),
      "first ended end_turn",
      expect.stringMatching(/^second inserted /),
      "second ended end_turn",
    ]);
  });

  it("reports waiting on a permission request, then resuming", async () => {
    scriptTurns([
      async function* (options) {
        await options.canUseTool(
          "Bash",
          { command: "ls" },
          { signal: new AbortController().signal, suggestions: [], toolUseID: "toolu_ls" },
        );
        yield {
          type: "user",
          message: {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "toolu_ls", content: "README.md" }],
          },
          parent_tool_use_id: null,
          uuid: randomUUID(),
          session_id: options.sessionId!,
        };
        yield result(options.sessionId!);
      },
    ]);
    const sessionId = await newSession();
    const turn = recordEvents();

    await agent.startTurn(prompt(sessionId, "list files"), turn.events);
    await turn.done;

    expect(permissionRequests).toHaveLength(1);
    expect(turn.log.slice(1)).toEqual(["awaitingUser", "resumed", "ended end_turn"]);
  });

  it("awaits the user while any request in the session is open, also one opened before the turn", async () => {
    const first = recordEvents();
    const second = recordEvents();
    let backgroundRequest: Promise<unknown> | undefined;
    let atStart: string[] = [];
    let afterOwnAnswer: string[] | undefined;
    scriptTurns([
      async function* (options) {
        yield result(options.sessionId!);
        await first.done;
        // A request that no active turn opened, such as a background task's.
        backgroundRequest = options.canUseTool(
          "Bash",
          { command: "sleep 60" },
          { signal: new AbortController().signal, suggestions: [], toolUseID: "toolu_background" },
        );
      },
      async function* (options) {
        atStart = [...second.log];
        await options.canUseTool(
          "Bash",
          { command: "ls" },
          { signal: new AbortController().signal, suggestions: [], toolUseID: "toolu_ls" },
        );
        afterOwnAnswer = [...second.log];
        await backgroundRequest;
        yield {
          type: "user",
          message: {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "toolu_ls", content: "README.md" }],
          },
          parent_tool_use_id: null,
          uuid: randomUUID(),
          session_id: options.sessionId!,
        };
        yield result(options.sessionId!);
      },
    ]);
    const sessionId = await newSession();

    await agent.startTurn(prompt(sessionId, "start a background task"), first.events);
    await vi.waitFor(() => expect(permissionRequests).toHaveLength(1));
    await agent.startTurn(prompt(sessionId, "list files"), second.events);
    await vi.waitFor(() => expect(afterOwnAnswer).toBeDefined());
    backgroundAnswer.resolve();
    await second.done;

    expect(first.log.slice(1)).toEqual(["ended end_turn"]);
    // Waiting from insertion, through its own answered request, until the
    // earlier request is answered too.
    expect(atStart.slice(1)).toEqual(["awaitingUser"]);
    expect(afterOwnAnswer!.slice(1)).toEqual(["awaitingUser"]);
    expect(second.log.slice(1)).toEqual(["awaitingUser", "resumed", "ended end_turn"]);
  });

  it("ends a queued turn that is cancelled before it is inserted, without inserting it", async () => {
    const release = Promise.withResolvers<void>();
    scriptTurns([
      async function* (options) {
        // Claude Code is busy with the first prompt when the cancel arrives.
        yield {
          type: "assistant",
          message: {
            id: "msg_working",
            type: "message",
            role: "assistant",
            model: "default",
            content: [{ type: "text", text: "Working on it" }],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 1, output_tokens: 1 },
          },
          parent_tool_use_id: null,
          uuid: randomUUID(),
          session_id: options.sessionId!,
        };
        await release.promise;
      },
    ]);
    agent.forceCancelGraceMs = 10;
    const sessionId = await newSession();
    const first = recordEvents();
    const queued = recordEvents();

    await agent.startTurn(prompt(sessionId, "first"), first.events);
    await vi.waitFor(() => expect(first.log).toHaveLength(1));
    await agent.startTurn(prompt(sessionId, "second"), queued.events);
    await agent.cancel({ sessionId });
    await Promise.all([first.done, queued.done]);
    release.resolve();

    expect(first.log).toEqual([expect.stringMatching(/^inserted /), "ended cancelled"]);
    expect(queued.log).toEqual(["ended cancelled"]);
  });

  it("drops a queued prompt that a cancel ends from Claude Code's queue, so it does not run", async () => {
    const trace: string[] = [];
    onSessionUpdate = ({ update }) => {
      // The turns' answers; the session also sends advisories as chunks.
      if (
        update.sessionUpdate === "agent_message_chunk" &&
        update.content.type === "text" &&
        update.messageId?.startsWith("msg_")
      ) {
        trace.push(`chunk ${update.content.text}`);
      }
    };
    // Claude Code keeps queued messages through an interrupt, and runs them
    // next unless they are dropped first.
    const dropped = new Set<string>();
    const interrupted = Promise.withResolvers<void>();
    const controls = {
      cancelAsyncMessage: async (uuid: string) => {
        trace.push("drop queued prompt");
        dropped.add(uuid);
        return true;
      },
      interrupt: async () => {
        trace.push("interrupt");
        interrupted.resolve();
      },
    };
    scriptQuery(async function* (input, options) {
      const sessionId = options.sessionId!;
      const first = (await input.next()).value;
      yield echo(first, sessionId);
      yield* streamedText("msg_first", "Working", sessionId);
      await interrupted.promise;
      yield result(sessionId);
      yield system("session_state_changed", sessionId, { state: "idle" });
      for (;;) {
        const { value, done } = await input.next();
        if (done) return;
        if (dropped.has(value.uuid)) continue;
        // Not dropped: Claude Code runs the queued prompt after all.
        yield* streamedText("msg_orphan", "Answer to a cancelled prompt", sessionId);
        yield echo(value, sessionId);
        yield result(sessionId);
        yield system("session_state_changed", sessionId, { state: "idle" });
      }
    }, controls);
    const sessionId = await newSession();
    const first = recordEvents(trace, "first");
    const queued = recordEvents(trace, "queued");

    await agent.startTurn(prompt(sessionId, "first"), first.events);
    await vi.waitFor(() => expect(trace).toContain("chunk Working"));
    await agent.startTurn(prompt(sessionId, "second"), queued.events);
    await agent.cancel({ sessionId });
    await Promise.all([first.done, queued.done]);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(trace).toEqual([
      expect.stringMatching(/^first inserted /),
      "chunk Working",
      "queued ended cancelled",
      "drop queued prompt",
      "interrupt",
      "first ended cancelled",
    ]);
  });

  it("ends a cancelled turn when the force-cancel fires while an update is being sent", async () => {
    // Claude Code streams an answer, then wedges: no result, no idle, even
    // after the interrupt (issue #680). Only the force-cancel can end the turn.
    const promptUuids = scriptTurns([
      async function* (options) {
        for (const message of streamedText("msg_answer", "Hi", options.sessionId!)) {
          yield message;
        }
        await new Promise(() => {});
      },
    ]);
    const sessionId = await newSession();
    agent.forceCancelGraceMs = 10;
    const turn = recordEvents();
    // The client takes the answer's text slowly, so the consumer is still
    // sending it when the force-cancel fires.
    const chunkSeen = Promise.withResolvers<void>();
    onSessionUpdate = async ({ update }) => {
      if (update.sessionUpdate !== "agent_message_chunk" || update.messageId !== "msg_answer") {
        return;
      }
      chunkSeen.resolve();
      await new Promise((resolve) => setTimeout(resolve, 50));
    };

    await agent.startTurn(prompt(sessionId, "hello"), turn.events);
    await chunkSeen.promise;
    await agent.cancel({ sessionId });
    await Promise.race([turn.done, new Promise((resolve) => setTimeout(resolve, 1_000))]);

    expect(turn.log).toEqual([`inserted ${promptUuids[0]}`, "ended cancelled"]);
  });

  it("ends a held turn cancelled mid-followup after the output its interrupt flushes", async () => {
    const trace: string[] = [];
    onSessionUpdate = ({ update }) => {
      if (
        update.sessionUpdate === "agent_message_chunk" &&
        update.content.type === "text" &&
        update.messageId?.startsWith("msg_")
      ) {
        trace.push(`chunk ${update.content.text}`);
      }
    };
    const interrupted = Promise.withResolvers<void>();
    const controls = {
      interrupt: async () => {
        trace.push("interrupt");
        interrupted.resolve();
      },
    };
    scriptQuery(async function* (input, options) {
      const sessionId = options.sessionId!;
      const idle = () => system("session_state_changed", sessionId, { state: "idle" });
      const running = () => system("session_state_changed", sessionId, { state: "running" });
      const first = (await input.next()).value;
      yield echo(first, sessionId);
      yield running();
      yield system("task_started", sessionId, {
        task_id: "agent-1",
        tool_use_id: "toolu_agent-1",
        description: "Explore the project",
        subagent_type: "Explore",
      });
      yield result(sessionId); // held for the subagent
      yield idle();
      yield system("task_notification", sessionId, {
        task_id: "agent-1",
        tool_use_id: "toolu_agent-1",
        status: "completed",
        output_file: "",
        summary: "done",
      });
      // The followup cycle writes the promised summary when the cancel comes.
      yield running();
      yield* streamedText("msg_followup", "Summary so far", sessionId);
      await interrupted.promise;
      yield stream(
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: ", stopped" } },
        sessionId,
      );
      yield { ...result(sessionId), origin: { kind: "task-notification" } };
      yield idle();
      // A wedged next turn: an idle without a result is the issue #825 signal,
      // which a leaked trailer debt would absorb.
      const second = (await input.next()).value;
      yield echo(second, sessionId);
      yield idle();
      yield result(sessionId);
      await input.next();
    }, controls);
    const sessionId = await newSession();
    const first = recordEvents(trace, "first");
    const second = recordEvents(trace, "second");

    await agent.startTurn(prompt(sessionId, "explore"), first.events);
    await vi.waitFor(() => expect(trace).toContain("chunk Summary so far"));
    await agent.cancel({ sessionId });
    await first.done;
    await agent.startTurn(prompt(sessionId, "next"), second.events);
    await second.done;

    expect(trace).toEqual([
      expect.stringMatching(/^first inserted /),
      "chunk Summary so far",
      "interrupt",
      "chunk , stopped",
      "first ended cancelled",
      expect.stringMatching(/^second inserted /),
      expect.stringMatching(/^second failed /),
    ]);
  });

  it("does not insert a turn that a cancel ended while the previous turn was handed off", async () => {
    scriptTurns([
      async function* (options) {
        // The turn ends with a tool call that never got its result.
        yield {
          type: "assistant",
          message: {
            id: "msg_tool",
            type: "message",
            role: "assistant",
            model: "default",
            content: [
              { type: "tool_use", id: "toolu_open", name: "Bash", input: { command: "ls" } },
            ],
            stop_reason: "tool_use",
            stop_sequence: null,
            usage: { input_tokens: 1, output_tokens: 1 },
          },
          parent_tool_use_id: null,
          uuid: randomUUID(),
          session_id: options.sessionId!,
        };
      },
      async function* () {},
    ]);
    agent.forceCancelGraceMs = 10;
    // The hand-off to the second turn fails the open tool call; hold that update.
    const failedToolCall = Promise.withResolvers<void>();
    const releaseUpdate = Promise.withResolvers<void>();
    onSessionUpdate = async ({ update }) => {
      if (update.sessionUpdate === "tool_call_update" && update.status === "failed") {
        failedToolCall.resolve();
        await releaseUpdate.promise;
      }
    };
    const sessionId = await newSession();
    const first = recordEvents();
    const second = recordEvents();

    await agent.startTurn(prompt(sessionId, "first"), first.events);
    await vi.waitFor(() => expect(first.log).toHaveLength(1));
    await agent.startTurn(prompt(sessionId, "second"), second.events);
    await failedToolCall.promise;
    const cancelling = agent.cancel({ sessionId });
    await vi.waitFor(() => expect(second.log).toEqual(["ended cancelled"]));
    releaseUpdate.resolve();
    await Promise.all([cancelling, first.done]);
    // The hand-off then activates the second turn in promise continuations,
    // which all run before a timer.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(second.log).toEqual(["ended cancelled"]);
  });

  it("fails a queued turn without inserting it when the query ends", async () => {
    scriptTurns(
      [
        async function* (options) {
          yield result(options.sessionId!);
        },
      ],
      "end stream",
    );
    const sessionId = await newSession();
    const first = recordEvents();
    const queued = recordEvents();

    await agent.startTurn(prompt(sessionId, "first"), first.events);
    await agent.startTurn(prompt(sessionId, "second"), queued.events);
    await Promise.all([first.done, queued.done]);

    expect(first.log).toEqual([expect.stringMatching(/^inserted /), "ended end_turn"]);
    expect(queued.log).toEqual([expect.stringMatching(/^failed /)]);
  });

  it("rejects a prompt that it refuses before starting a turn, and reports nothing", async () => {
    const turn = recordEvents();

    await expect(agent.startTurn(prompt("no-such-session", "hello"), turn.events)).rejects.toThrow(
      "Session not found",
    );

    expect(turn.log).toEqual([]);
  });
});
