import { describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { ClaudeAcpAgent, type AcpClient } from "../acp-agent.js";
import { Pushable } from "../utils.js";
import {
  mockSessionState,
  successfulResultMessage,
  userEcho,
  wrapQuery,
} from "./session-doubles.js";

vi.mock("@anthropic-ai/claude-agent-sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@anthropic-ai/claude-agent-sdk")>();
  const refused = () => {
    throw new Error("Unexpected real SDK call");
  };
  return {
    ...actual,
    query: vi.fn(refused),
    getSessionMessages: vi.fn(async () => []),
    getSubagentMessages: vi.fn(async () => []),
    listSessions: vi.fn(async () => []),
    getSessionInfo: vi.fn(async () => undefined),
    deleteSession: vi.fn(refused),
    forkSession: vi.fn(refused),
    importSessionToStore: vi.fn(refused),
  };
});

async function untilDone<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Prompt did not settle")), 3000);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function createAgent() {
  const client = { sessionUpdate: async () => {} } as unknown as AcpClient;
  return new ClaudeAcpAgent(client, { log: () => {}, error: () => {} });
}

function usage(inputTokens: number, outputTokens: number) {
  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  };
}

function modelUsage(inputTokens: number, outputTokens: number) {
  return {
    "claude-sonnet-4-6": {
      inputTokens,
      outputTokens,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      webSearchRequests: 0,
      costUSD: 0,
      contextWindow: 200000,
    },
  };
}

function stamp(uuid: string, fields: string) {
  return {
    ...(fields !== "plural" ? { user_message_uuid: uuid } : {}),
    ...(fields !== "singular" ? { user_message_uuids: [uuid] } : {}),
  };
}

const idle = { type: "system", subtype: "session_state_changed", state: "idle" };

describe("a steer folded into an autonomous cycle", () => {
  it.each([
    ["singular", true],
    ["plural", true],
    ["both", true],
    ["singular", false],
    ["plural", false],
    ["both", false],
  ] as const)("settles from its own %s UUID stamp (echo: %s)", async (fields, echo) => {
    const agent = createAgent();
    const input = new Pushable<any>();
    const echoed = Promise.withResolvers<void>();
    const interrupted = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const processed = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    async function* messages() {
      const iter = input[Symbol.asyncIterator]();
      const { value: original } = await iter.next();
      yield userEcho(original);
      echoed.resolve();
      const { value: steered } = await iter.next();
      yield successfulResultMessage({
        origin: { kind: "human" },
        ...stamp(original.uuid, "both"),
        queued_turn_count: 1,
        stop_reason: "tool_use",
        usage: usage(10, 5),
        modelUsage: modelUsage(10, 5),
      });
      interrupted.resolve();
      await resume.promise;
      if (echo) yield userEcho(steered);
      // Only the steer's UUID is named; it has no queued Turn of its own.
      yield successfulResultMessage({
        origin: { kind: "task-notification" },
        ...stamp(steered.uuid, fields),
        queued_turn_count: 0,
        stop_reason: "max_tokens",
        usage: usage(20, 7),
        modelUsage: modelUsage(30, 12),
      });
      yield idle;
      processed.resolve();
      // Stream shutdown must not supply the prompt's response.
      await finish.promise;
    }
    const session = mockSessionState({ input, query: wrapQuery(messages()) });
    agent.sessions["test-session"] = session;
    let response: unknown;
    const prompt = agent
      .prompt({ sessionId: "test-session", prompt: [{ type: "text", text: "original" }] })
      .then((value) => (response = value));
    try {
      await untilDone(echoed.promise);
      await expect(
        agent.steer({
          sessionId: "test-session",
          prompt: [{ type: "text", text: "also handle this" }],
        }),
      ).resolves.toEqual({ outcome: "injected" });
      await untilDone(interrupted.promise);
      expect(response).toBeUndefined();
      resume.resolve();
      await untilDone(processed.promise);
      await untilDone(prompt);
      const tokenCount = {
        totalTokens: 42,
        inputTokens: 30,
        cachedInputTokens: 0,
        cachedWriteTokens: 0,
        outputTokens: 12,
        reasoningOutputTokens: 0,
      };
      expect(response).toEqual({
        stopReason: "max_tokens",
        usage: {
          inputTokens: 30,
          outputTokens: 12,
          cachedReadTokens: 0,
          cachedWriteTokens: 0,
          totalTokens: 42,
        },
        _meta: {
          quota: {
            token_count: tokenCount,
            model_usage: [{ model: "claude-sonnet-4-6", token_count: tokenCount }],
          },
        },
      });
      expect(session.activeTurn).toBeNull();
      expect(session.turnQueue).toHaveLength(0);
      expect(session.owedTrailingIdles).toBe(0);
    } finally {
      resume.resolve();
      finish.resolve();
      await untilDone(session.consumer);
      await untilDone(prompt);
    }
  });

  it.each(["unrelated", "held", "settled", "plural-unrelated", "plural-empty"] as const)(
    "does not attribute a result to a steer in the %s state",
    async (state) => {
      const agent = createAgent();
      const input = new Pushable<any>();
      const echoed = Promise.withResolvers<void>();
      const processed = Promise.withResolvers<void>();
      const resume = Promise.withResolvers<void>();
      const finish = Promise.withResolvers<void>();
      let response: unknown;
      let owner: any;
      let steerUuid = "";
      const heldOutcome = { stopReason: "end_turn" };
      async function* messages() {
        const iter = input[Symbol.asyncIterator]();
        const { value: original } = await iter.next();
        yield userEcho(original);
        echoed.resolve();
        const { value: steered } = await iter.next();
        steerUuid = steered.uuid;
        const session = agent.sessions["test-session"];
        owner = session.activeTurn;
        // Constructed defensive states: these do not model normal settlement.
        if (state === "held") {
          owner.deferredSettle = heldOutcome;
          owner.spawnedTaskIds = new Set(["still-running"]);
          session.liveBackgroundTasks.set("still-running", { isSubagent: true });
        } else if (state === "settled") {
          owner.settled = true;
        }
        const unrelated = randomUUID();
        yield successfulResultMessage({
          origin: { kind: "task-notification" },
          user_message_uuid: state === "unrelated" ? unrelated : steerUuid,
          user_message_uuids:
            state === "plural-empty" ? [] : [state.includes("unrelated") ? unrelated : steerUuid],
          stop_reason: "refusal",
          usage: usage(100, 50),
          modelUsage: modelUsage(100, 50),
        });
        processed.resolve();
        await resume.promise;
        owner.settled = false;
        owner.deferredSettle = undefined;
        owner.spawnedTaskIds = undefined;
        session.liveBackgroundTasks.clear();
        yield successfulResultMessage({
          origin: { kind: "human" },
          ...stamp(steerUuid, "both"),
          usage: usage(10, 5),
        });
        yield idle; // the excluded autonomous result's trailer
        yield idle; // the human result's trailer
        await finish.promise;
      }
      const session = mockSessionState({ input, query: wrapQuery(messages()) });
      agent.sessions["test-session"] = session;
      const prompt = agent
        .prompt({ sessionId: "test-session", prompt: [{ type: "text", text: "original" }] })
        .then((value) => (response = value));
      try {
        await untilDone(echoed.promise);
        await expect(
          agent.steer({
            sessionId: "test-session",
            prompt: [{ type: "text", text: "also handle this" }],
          }),
        ).resolves.toEqual({ outcome: "injected" });
        await untilDone(processed.promise);
        expect(response).toBeUndefined();
        expect(session.activeTurn).toBe(owner);
        expect(session.accumulatedUsage).toEqual({
          inputTokens: 0,
          outputTokens: 0,
          cachedReadTokens: 0,
          cachedWriteTokens: 0,
        });
        expect(session.accumulatedModelUsage).toEqual({});
        expect(owner.steeredUuids).toEqual(new Set([steerUuid]));
        expect(owner.steeredEchoes).toEqual(new Set([steerUuid]));
        expect(owner.steeredSettle).toBeUndefined();
        if (state === "held") expect(owner.deferredSettle).toBe(heldOutcome);
        if (state === "settled") expect(owner.settled).toBe(true);
        resume.resolve();
        await untilDone(prompt);
        expect(response).toEqual({
          stopReason: "end_turn",
          usage: {
            inputTokens: 10,
            outputTokens: 5,
            cachedReadTokens: 0,
            cachedWriteTokens: 0,
            totalTokens: 15,
          },
          _meta: {
            quota: {
              token_count: {
                totalTokens: 15,
                inputTokens: 10,
                cachedInputTokens: 0,
                cachedWriteTokens: 0,
                outputTokens: 5,
                reasoningOutputTokens: 0,
              },
              model_usage: [],
            },
          },
        });
      } finally {
        resume.resolve();
        finish.resolve();
        await untilDone(session.consumer);
        await untilDone(prompt);
      }
    },
  );
});
