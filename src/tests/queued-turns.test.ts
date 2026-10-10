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

  it.each([true, false])(
    "settles a queued prompt correctly after cancellation ACK %s without ending other prompts",
    async (cancelled) => {
      const releaseFirst = Promise.withResolvers<void>();
      const dropped = new Set<string>();
      const interrupt = vi.fn(async () => {});
      const cancelAsyncMessage = vi.fn(async (uuid: string) => {
        if (cancelled) dropped.add(uuid);
        return cancelled;
      });
      scriptQuery(
        async function* (input, options) {
          const sessionId = options.sessionId!;
          const first = (await input.next()).value;
          yield echo(first, sessionId);
          await releaseFirst.promise;
          yield result(sessionId);
          yield system("session_state_changed", sessionId, { state: "idle" });
          for (;;) {
            const next = await input.next();
            if (next.done) return;
            if (dropped.has(next.value.uuid)) {
              yield lifecycle(next.value.uuid, "cancelled", sessionId);
              continue;
            }
            yield echo(next.value, sessionId);
            yield result(sessionId);
            yield system("session_state_changed", sessionId, { state: "idle" });
          }
        },
        { cancelAsyncMessage, interrupt },
      );
      const sessionId = await newSession();
      const first = recordEvents();
      const removed = recordEvents();
      const last = recordEvents();
      await agent.startTurn(prompt(sessionId, "first"), first.events);
      await vi.waitFor(() => expect(first.log).toHaveLength(1));
      await agent.startTurn(prompt(sessionId, "remove"), removed.events);
      await agent.startTurn(prompt(sessionId, "last"), last.events);
      const listing = await agent.readSessionRuntime(
        { sessionId, resource: "queuedMessages" },
        new AbortController().signal,
      );
      if (listing.status !== "ok") throw new Error("queue unavailable");
      const messages = (listing.data as { messages: { messageId: string }[] }).messages;
      expect(messages).toHaveLength(2);
      const acknowledgement = await agent.controlSessionRuntime({
        sessionId,
        action: "cancelQueuedMessage",
        messageId: messages[0].messageId,
      });
      expect(acknowledgement).toMatchObject({ status: "ok", data: { cancelled } });
      expect(removed.log).toEqual(cancelled ? ["ended cancelled"] : []);
      expect(first.log).toHaveLength(1);
      expect(last.log).toEqual([]);
      expect(interrupt).not.toHaveBeenCalled();
      releaseFirst.resolve();
      await Promise.all([first.done, removed.done, last.done]);
      expect(first.log).toEqual([expect.stringMatching(/^inserted /), "ended end_turn"]);
      expect(last.log).toEqual([`inserted ${messages[1].messageId}`, "ended end_turn"]);
      expect(removed.log).toEqual(
        cancelled ? ["ended cancelled"] : [`inserted ${messages[0].messageId}`, "ended end_turn"],
      );
      expect(agent.sessions[sessionId].orphanCommands?.size ?? 0).toBe(0);
    },
  );
});
