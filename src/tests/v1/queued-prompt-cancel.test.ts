import { describe, expect, it, vi } from "vitest";
import { ClaudeAcpAgent, runPromptWithCancellation } from "../../v1/acp-agent.js";
import type { AcpClient } from "../../acp-client.js";
import { Pushable } from "../../utils.js";
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

const idle = { type: "system", subtype: "session_state_changed", state: "idle" };

function text(t: string) {
  return { sessionId: "test-session", prompt: [{ type: "text" as const, text: t }] };
}

/**
 * A session running prompt A, with prompt B queued behind it. Claude Code
 * answers `cancel_async_message` with `withdrawable`; B runs after A unless
 * withdrawn.
 */
function setup(withdrawable: boolean) {
  const agent = new ClaudeAcpAgent({ sessionUpdate: async () => {} } as unknown as AcpClient, {
    log: () => {},
    error: () => {},
  });
  const input = new Pushable<any>();
  const echoed = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  const withdrawnUuids = new Set<string>();
  async function* messages() {
    const iter = input[Symbol.asyncIterator]();
    const { value: first } = await iter.next();
    yield userEcho(first);
    echoed.resolve();
    await release.promise;
    yield successfulResultMessage({ user_message_uuid: first.uuid });
    yield idle;
    const { value: second } = await iter.next();
    if (!withdrawnUuids.has(second.uuid)) {
      yield userEcho(second);
      yield successfulResultMessage({ user_message_uuid: second.uuid });
      yield idle;
    }
    await finish.promise;
  }
  const query = wrapQuery(messages());
  query.cancelAsyncMessage = vi.fn(async (uuid: string) => {
    if (withdrawable) withdrawnUuids.add(uuid);
    return withdrawable;
  });
  const session = mockSessionState({ input, query });
  agent.sessions["test-session"] = session;
  const cancel = vi.spyOn(agent, "cancel");
  return { agent, session, query, cancel, echoed, release, finish };
}

describe("$/cancel_request on a queued session/prompt", () => {
  it("withdraws the queued prompt alone; the running turn goes on", async () => {
    const t = setup(true);
    const a = runPromptWithCancellation(t.agent, text("A"), new AbortController().signal);
    await untilDone(t.echoed.promise);
    const bCancel = new AbortController();
    const b = runPromptWithCancellation(t.agent, text("B"), bCancel.signal);
    await vi.waitFor(() => expect(t.session.turnQueue).toHaveLength(2));
    const bUuid = t.session.turnQueue[1].promptUuid;

    bCancel.abort();
    await expect(untilDone(b)).resolves.toEqual({ stopReason: "cancelled" });
    expect(t.query.cancelAsyncMessage).toHaveBeenCalledWith(bUuid);
    expect(t.cancel).not.toHaveBeenCalled();
    expect(t.query.interrupt).not.toHaveBeenCalled();
    expect(t.session.turnQueue).toHaveLength(1);

    t.release.resolve();
    await expect(untilDone(a)).resolves.toMatchObject({ stopReason: "end_turn" });
    t.finish.resolve();
  });

  it("leaves a prompt Claude Code already took to run, without cancelling the turn", async () => {
    const t = setup(false);
    const a = runPromptWithCancellation(t.agent, text("A"), new AbortController().signal);
    await untilDone(t.echoed.promise);
    const bCancel = new AbortController();
    const b = runPromptWithCancellation(t.agent, text("B"), bCancel.signal);
    await vi.waitFor(() => expect(t.session.turnQueue).toHaveLength(2));

    bCancel.abort();
    await vi.waitFor(() => expect(t.query.cancelAsyncMessage).toHaveBeenCalled());
    expect(t.cancel).not.toHaveBeenCalled();

    t.release.resolve();
    await expect(untilDone(a)).resolves.toMatchObject({ stopReason: "end_turn" });
    await expect(untilDone(b)).resolves.toMatchObject({ stopReason: "end_turn" });
    t.finish.resolve();
  });

  it("keeps a prompt cancelled before it was queued out of the queue", async () => {
    const t = setup(true);
    const a = runPromptWithCancellation(t.agent, text("A"), new AbortController().signal);
    await untilDone(t.echoed.promise);
    const bCancel = new AbortController();
    bCancel.abort(); // before agent.prompt queues it
    const b = runPromptWithCancellation(t.agent, text("B"), bCancel.signal);
    await expect(untilDone(b)).resolves.toEqual({ stopReason: "cancelled" });
    expect(t.session.turnQueue).toHaveLength(1);
    expect(t.query.cancelAsyncMessage).not.toHaveBeenCalled();
    expect(t.cancel).not.toHaveBeenCalled();
    t.release.resolve();
    await expect(untilDone(a)).resolves.toMatchObject({ stopReason: "end_turn" });
    t.finish.resolve();
  });

  it("ends an idle prompt cancelled before it was queued, without a session cancel", async () => {
    const t = setup(true);
    const aCancel = new AbortController();
    aCancel.abort();
    const a = runPromptWithCancellation(t.agent, text("A"), aCancel.signal);
    await expect(untilDone(a)).resolves.toEqual({ stopReason: "cancelled" });
    expect(t.cancel).not.toHaveBeenCalled();
    expect(t.session.turnQueue ?? []).toHaveLength(0);
    t.release.resolve();
    t.finish.resolve();
  });

  it("withdraws a queued prompt that starts with a path", async () => {
    const t = setup(true);
    const a = runPromptWithCancellation(t.agent, text("A"), new AbortController().signal);
    await untilDone(t.echoed.promise);
    const bCancel = new AbortController();
    const b = runPromptWithCancellation(t.agent, text("/tmp/notes.md looks off"), bCancel.signal);
    await vi.waitFor(() => expect(t.session.turnQueue).toHaveLength(2));
    bCancel.abort();
    await expect(untilDone(b)).resolves.toEqual({ stopReason: "cancelled" });
    t.release.resolve();
    await untilDone(a);
    t.finish.resolve();
  });

  it("does not withdraw a queued /goal", async () => {
    const t = setup(true);
    const a = runPromptWithCancellation(t.agent, text("A"), new AbortController().signal);
    await untilDone(t.echoed.promise);
    const bCancel = new AbortController();
    const b = runPromptWithCancellation(t.agent, text("/goal ship it"), bCancel.signal);
    await vi.waitFor(() => expect(t.session.turnQueue).toHaveLength(2));
    bCancel.abort();
    await new Promise((r) => setTimeout(r, 20));
    expect(t.query.cancelAsyncMessage).not.toHaveBeenCalled();
    expect(t.cancel).not.toHaveBeenCalled();
    t.release.resolve();
    await expect(untilDone(a)).resolves.toMatchObject({ stopReason: "end_turn" });
    await expect(untilDone(b)).resolves.toMatchObject({ stopReason: "end_turn" });
    t.finish.resolve();
  });

  it("leaves a queued prompt to run when Claude Code cannot withdraw it", async () => {
    const t = setup(true);
    t.query.cancelAsyncMessage = vi.fn(async () => {
      throw new Error("Unsupported control request subtype: cancel_async_message");
    });
    const a = runPromptWithCancellation(t.agent, text("A"), new AbortController().signal);
    await untilDone(t.echoed.promise);
    const bCancel = new AbortController();
    const b = runPromptWithCancellation(t.agent, text("B"), bCancel.signal);
    await vi.waitFor(() => expect(t.session.turnQueue).toHaveLength(2));
    bCancel.abort();
    await vi.waitFor(() => expect(t.query.cancelAsyncMessage).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20));
    expect(t.cancel).not.toHaveBeenCalled();
    t.release.resolve();
    await untilDone(a);
    await expect(untilDone(b)).resolves.toMatchObject({ stopReason: "end_turn" });
    t.finish.resolve();
  });

  it("withdraws a foreground prompt Claude Code still holds, without a session cancel", async () => {
    const t = setup(true);
    // Queued with nothing of ours running (as during a cycle Claude Code
    // started), so it counts as foreground, but Claude Code still holds it.
    const aCancel = new AbortController();
    const a = runPromptWithCancellation(t.agent, text("A"), aCancel.signal);
    await vi.waitFor(() => expect(t.session.turnQueue).toHaveLength(1));
    aCancel.abort();
    await expect(untilDone(a)).resolves.toEqual({ stopReason: "cancelled" });
    expect(t.cancel).not.toHaveBeenCalled();
    t.release.resolve();
    t.finish.resolve();
  });

  it("leaves the session alone when withdrawal fails for another reason", async () => {
    const t = setup(true);
    t.query.cancelAsyncMessage = vi.fn(async () => {
      throw new Error("Query closed before response received");
    });
    const a = runPromptWithCancellation(t.agent, text("A"), new AbortController().signal);
    await untilDone(t.echoed.promise);
    const bCancel = new AbortController();
    void runPromptWithCancellation(t.agent, text("B"), bCancel.signal);
    await vi.waitFor(() => expect(t.session.turnQueue).toHaveLength(2));
    bCancel.abort();
    await vi.waitFor(() => expect(t.query.cancelAsyncMessage).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20));
    expect(t.cancel).not.toHaveBeenCalled();
    t.release.resolve();
    await untilDone(a);
    t.finish.resolve();
  });

  it("cancels the session when the request is the running prompt", async () => {
    const t = setup(true);
    const aCancel = new AbortController();
    const a = runPromptWithCancellation(t.agent, text("A"), aCancel.signal);
    await untilDone(t.echoed.promise);

    aCancel.abort();
    await vi.waitFor(() => expect(t.cancel).toHaveBeenCalledWith({ sessionId: "test-session" }));
    expect(t.query.cancelAsyncMessage).not.toHaveBeenCalled();
    t.release.resolve();
    await untilDone(a);
    t.finish.resolve();
  });
});
