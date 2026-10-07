import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { SessionNotification } from "@agentclientprotocol/sdk";
import { ClaudeAcpAgent, type AcpClient } from "../acp-agent.js";
import { EventLoopYielder, Pushable } from "../utils.js";
import {
  mockSessionState,
  successfulResultMessage,
  userEcho,
  wrapQuery,
} from "./session-doubles.js";

const sessionId = "test-session";

/** Busy-waits, so a test can make one message cost real time. */
function spin(ms: number): void {
  const end = performance.now() + ms;
  while (performance.now() < end) {
    // spin
  }
}

function textDelta(text: string) {
  return {
    type: "stream_event",
    event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
    parent_tool_use_id: null,
    uuid: randomUUID(),
    session_id: sessionId,
  };
}

/** A query whose whole answer is already buffered: every `next()` resolves at
 *  once, as the SDK queue does when the CLI is ahead of the adapter. */
function bufferedAnswer(chunks: string[]) {
  return (input: Pushable<any>) =>
    (async function* () {
      const user = await input[Symbol.asyncIterator]().next();
      yield userEcho(user.value);
      for (const chunk of chunks) yield textDelta(chunk);
      yield successfulResultMessage();
      yield { type: "system", subtype: "session_state_changed", state: "idle" };
    })();
}

function createAgent(
  makeGenerator: (input: Pushable<any>) => AsyncGenerator<any>,
  onUpdate: (notification: SessionNotification) => void,
) {
  const agent = new ClaudeAcpAgent(
    {
      sessionUpdate: async (notification: SessionNotification) => onUpdate(notification),
    } as unknown as AcpClient,
    { log: () => {}, error: () => {} },
  );
  const input = new Pushable<any>();
  agent.sessions[sessionId] = mockSessionState({
    query: wrapQuery(makeGenerator(input)),
    input,
  });
  return agent;
}

function chunkTexts(updates: SessionNotification[]): string[] {
  return updates
    .filter((n) => n.update.sessionUpdate === "agent_message_chunk")
    .map((n) => (n.update as { content: { text: string } }).content.text);
}

describe("EventLoopYielder", () => {
  it("lets a loop run on within its budget", () => {
    let time = 0;
    const yielder = new EventLoopYielder(8, () => time);
    expect(yielder.maybeYield()).toBeUndefined();
    time = 7;
    expect(yielder.maybeYield()).toBeUndefined();
  });

  it("yields to the event loop past its budget", async () => {
    let time = 0;
    const yielder = new EventLoopYielder(8, () => time);
    expect(yielder.maybeYield()).toBeUndefined();
    let timerRan = false;
    setImmediate(() => (timerRan = true));
    time = 8;
    const pause = yielder.maybeYield();
    expect(pause).toBeInstanceOf(Promise);
    await pause;
    expect(timerRan).toBe(true);
  });

  it("starts a new budget once the event loop has turned", async () => {
    let time = 0;
    const yielder = new EventLoopYielder(8, () => time);
    yielder.maybeYield();
    time = 20;
    await yielder.maybeYield();
    // The pause let the event loop turn, so the budget starts again here.
    expect(yielder.maybeYield()).toBeUndefined();
    time = 27;
    expect(yielder.maybeYield()).toBeUndefined();
    time = 28;
    expect(yielder.maybeYield()).toBeInstanceOf(Promise);
  });

  it("does not yield for a loop that waits on I/O between items", async () => {
    let time = 0;
    const yielder = new EventLoopYielder(8, () => time);
    for (let i = 0; i < 5; i++) {
      expect(yielder.maybeYield()).toBeUndefined();
      time += 20;
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
  });
});

describe("consumer under a buffered backlog", () => {
  it("lets timers run while it drains, and keeps every update in order", async () => {
    const chunks = Array.from({ length: 30 }, (_, i) => `chunk-${i} `);
    const updates: SessionNotification[] = [];
    let chunksBeforeTimer: number | undefined;
    let timerArmed = false;
    const agent = createAgent(bufferedAnswer(chunks), (notification) => {
      updates.push(notification);
      if (notification.update.sessionUpdate !== "agent_message_chunk") return;
      if (!timerArmed) {
        timerArmed = true;
        setTimeout(() => (chunksBeforeTimer = chunkTexts(updates).length), 0);
      }
      // Each chunk costs 2 ms: the backlog takes far longer than one budget.
      spin(2);
    });

    const response = await agent.prompt({ sessionId, prompt: [{ type: "text", text: "go" }] });

    expect(response.stopReason).toBe("end_turn");
    expect(chunkTexts(updates)).toEqual(chunks);
    expect(chunksBeforeTimer).toBeDefined();
    expect(chunksBeforeTimer!).toBeLessThan(chunks.length);
  });

  it("runs a cancel that arrives mid-backlog before the backlog ends", async () => {
    const chunks = Array.from({ length: 30 }, (_, i) => `chunk-${i} `);
    const updates: SessionNotification[] = [];
    let chunksAtCancel: number | undefined;
    let cancelScheduled = false;
    const agent = createAgent(bufferedAnswer(chunks), (notification) => {
      updates.push(notification);
      if (notification.update.sessionUpdate !== "agent_message_chunk") return;
      if (!cancelScheduled) {
        cancelScheduled = true;
        // A `session/cancel` arrives as I/O, so it can only run in a new macrotask.
        setImmediate(() => {
          chunksAtCancel = chunkTexts(updates).length;
          void agent.cancel({ sessionId });
        });
      }
      spin(2);
    });
    const query = agent.sessions[sessionId].query as unknown as {
      interrupt: ReturnType<typeof vi.fn>;
    };

    const response = await agent.prompt({ sessionId, prompt: [{ type: "text", text: "go" }] });

    expect(chunksAtCancel).toBeDefined();
    expect(chunksAtCancel!).toBeLessThan(chunks.length);
    expect(query.interrupt).toHaveBeenCalled();
    // The turn ends cancelled. The chunks that were already buffered still
    // reach the client, in order, as they did before the cancel.
    expect(response.stopReason).toBe("cancelled");
    expect(chunkTexts(updates)).toEqual(chunks);
  });
});
