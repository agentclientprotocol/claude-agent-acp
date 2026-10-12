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
        transport: { waitForExit: async () => {} },
        [Symbol.asyncDispose]: async () => {},
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

  it("does not attribute the survivor's echo-less result to a natively dropped prompt after an unknown ACK", async () => {
    const releaseFirst = Promise.withResolvers<void>();
    const dropped = new Set<string>();
    const droppedFrame = Promise.withResolvers<void>();
    scriptQuery(
      async function* (input, options) {
        const sid = options.sessionId!;
        const first = (await input.next()).value;
        yield echo(first, sid);
        await releaseFirst.promise;
        yield result(sid);
        yield system("session_state_changed", sid, { state: "idle" });
        for (;;) {
          const next = await input.next();
          if (next.done) return;
          if (dropped.has(next.value.uuid)) {
            yield lifecycle(next.value.uuid, "cancelled", sid);
            droppedFrame.resolve();
            continue;
          }
          // Native local commands legitimately return a result without an echo.
          yield result(sid);
          yield system("session_state_changed", sid, { state: "idle" });
        }
      },
      {
        cancelAsyncMessage: async (uuid: string) => {
          dropped.add(uuid);
          return undefined;
        },
      },
    );
    const sid = await newSession();
    const first = recordEvents();
    const removed = recordEvents();
    const survivor = recordEvents();
    await agent.startTurn(prompt(sid, "first"), first.events);
    await vi.waitFor(() => expect(first.log).toHaveLength(1));
    await agent.startTurn(prompt(sid, "drop"), removed.events);
    await agent.startTurn(prompt(sid, "/context"), survivor.events);
    const target = agent.sessions[sid].turnQueue![1];
    await expect(
      agent.controlSessionRuntime({
        sessionId: sid,
        action: "cancelQueuedMessage",
        messageId: target.promptUuid,
      }),
    ).rejects.toThrow("outcome unknown");
    releaseFirst.resolve();
    await Promise.all([removed.done, survivor.done]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    // An uncertain cancellation must invalidate the query, or reconcile the
    // definitive pending-only cancelled lifecycle frame before consuming results.
    expect(removed.log).not.toContain("ended end_turn");
    expect(
      survivor.log.some((entry) => entry.startsWith("ended ") || entry.startsWith("failed ")),
    ).toBe(true);
  });

  it("retires count-lane orphan debt when session/cancel races a true single-message ACK", async () => {
    const ack = Promise.withResolvers<boolean>();
    const entered = Promise.withResolvers<void>();
    const interrupt = vi.fn(async () => undefined);
    let calls = 0;
    scriptQuery(
      async function* (input) {
        await input.next();
        const next = await input.next();
        if (!next.done) yield {};
      },
      {
        cancelAsyncMessage: async () => {
          calls++;
          if (calls === 1) {
            entered.resolve();
            return ack.promise;
          }
          return false;
        },
        interrupt,
      },
    );
    const sid = await newSession();
    const targetEvents = recordEvents();
    await agent.startTurn(prompt(sid, "drop"), targetEvents.events);
    const target = agent.sessions[sid].turnQueue![0];
    const control = agent.controlSessionRuntime({
      sessionId: sid,
      action: "cancelQueuedMessage",
      messageId: target.promptUuid,
    });
    await entered.promise;
    await agent.cancel({ sessionId: sid });
    expect(agent.sessions[sid].pendingOrphanResults).toBe(1);
    ack.resolve(true);
    expect(await control).toMatchObject({ data: { cancelled: true } });
    expect(agent.sessions[sid].pendingOrphanResults).toBe(0);
  });
  it("settles a dropped prompt before a delayed true ACK when its cancelled frame precedes another result", async () => {
    const releaseFirst = Promise.withResolvers<void>();
    const ack = Promise.withResolvers<boolean>();
    const entered = Promise.withResolvers<void>();
    let dropped = "";
    const consumed = Promise.withResolvers<void>();
    scriptQuery(
      async function* (input, options) {
        const sid = options.sessionId!;
        const first = (await input.next()).value;
        yield echo(first, sid);
        await releaseFirst.promise;
        yield result(sid);
        yield system("session_state_changed", sid, { state: "idle" });
        const removed = (await input.next()).value;
        expect(removed.uuid).toBe(dropped);
        yield lifecycle(removed.uuid, "cancelled", sid);
        await input.next();
        yield result(sid);
        yield system("session_state_changed", sid, { state: "idle" });
        consumed.resolve();
        await input.next();
      },
      {
        cancelAsyncMessage: async (uuid: string) => {
          dropped = uuid;
          entered.resolve();
          return ack.promise;
        },
      },
    );
    const sid = await newSession();
    const first = recordEvents(),
      removed = recordEvents(),
      survivor = recordEvents();
    await agent.startTurn(prompt(sid, "first"), first.events);
    await vi.waitFor(() => expect(first.log).toHaveLength(1));
    await agent.startTurn(prompt(sid, "drop"), removed.events);
    await agent.startTurn(prompt(sid, "/context"), survivor.events);
    const target = agent.sessions[sid].turnQueue![1];
    const control = agent.controlSessionRuntime({
      sessionId: sid,
      action: "cancelQueuedMessage",
      messageId: target.promptUuid,
    });
    await entered.promise;
    releaseFirst.resolve();
    await consumed.promise;
    ack.resolve(true);
    await control;
    expect(removed.log).toEqual(["ended cancelled"]);
    expect(survivor.log).toEqual([expect.stringMatching(/^inserted /), "ended end_turn"]);
  });
});
