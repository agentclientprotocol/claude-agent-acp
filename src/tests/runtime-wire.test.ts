import { PROTOCOL_VERSION as V2_PROTOCOL_VERSION } from "@agentclientprotocol/sdk/experimental/v2";
import type { Query } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it, vi } from "vitest";
import { v1AgentApp, type ClaudeAcpAgent, type Session } from "../acp-agent.js";
import { v2AgentApp } from "../v2/agent.js";
import type { RuntimeQuery } from "../desktop-runtime.js";

/** Real ACP routers, with only the native Query replaced. No subprocess or prompt. */
async function connect(version: 1 | 2) {
  const incoming = new TransformStream();
  const outgoing = new TransformStream();
  let agent!: ClaudeAcpAgent;
  const updates: unknown[] = [];
  const request = vi.fn();
  const supportedCommands = vi.fn(async () => []);
  const query = {
    supportedCommands,
    supportedAgents: vi.fn(async () => []),
    cancelAsyncMessage: vi.fn(async () => true),
    getContextUsage: vi.fn(async () => ({ totalTokens: 42, categories: [] })),
    mcpServerStatus: vi.fn(async () => []),
    close: vi.fn(),
    transport: { waitForExit: async () => {} },
    interrupt: vi.fn(async () => undefined),
    request,
  } as unknown as Query & RuntimeQuery;
  const session = {
    query,
    cwd: "/workspace",
    creationParams: { cwd: "/workspace", mcpServers: [] },
    settingsManager: { dispose: vi.fn() },
    input: { end: vi.fn() },
    abortController: new AbortController(),
    turnQueue: [],
    liveBackgroundTasks: new Map(),
    configOptions: [],
    agents: [],
    currentAgent: "default",
    modes: { currentModeId: "default", availableModes: [] },
    models: { currentModelId: "default", availableModels: [] },
    modelInfos: [],
  } as unknown as Session;
  const logger = { log: () => {}, error: () => {} };
  const app = (version === 1 ? v1AgentApp : v2AgentApp)(logger, (a) => {
    agent = a;
    // initialize's independent account probe is outside the runtime protocol.
    Object.assign(a, { probeCliAuthStatus: () => Promise.resolve() });
    a.sessions.sid = session;
  });
  app.connect({ readable: incoming.readable, writable: outgoing.writable });
  const writer = incoming.writable.getWriter();
  const reader = outgoing.readable.getReader();
  let id = 0;
  const pending = new Map<
    number,
    { resolve(value: unknown): void; reject(error: unknown): void }
  >();
  void (async () => {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value.id !== undefined) {
        const waiter = pending.get(value.id);
        pending.delete(value.id);
        if (value.error) waiter?.reject(value.error);
        else waiter?.resolve(value.result);
      } else updates.push(value);
    }
  })();
  const connection = {
    session,
    query,
    updates,
    agent: () => agent,
    send(method: string, params: unknown): Promise<unknown> {
      const requestId = ++id;
      const result = new Promise((resolve, reject) => pending.set(requestId, { resolve, reject }));
      void writer.write({ jsonrpc: "2.0", id: requestId, method, params });
      return result;
    },
    close: () => writer.close(),
  };
  const initialized = await connection.send(
    "initialize",
    version === 1
      ? { protocolVersion: 1, clientCapabilities: {} }
      : {
          protocolVersion: V2_PROTOCOL_VERSION,
          info: { name: "wire-test", version: "1" },
          capabilities: {},
        },
  );
  return { ...connection, initialized };
}

function pendingTurn(messageId: string) {
  return {
    promptUuid: messageId,
    settled: false,
    resolve: vi.fn(),
    reject: vi.fn(),
  } as unknown as NonNullable<Session["turnQueue"]>[number];
}

describe.each([1, 2] as const)("ACP v%s runtime wire", (version) => {
  it("advertises full context and single queued-message operations", async () => {
    const c = await connect(version);
    try {
      expect(c.initialized).toMatchObject({
        _meta: {
          runtime: {
            version: 1,
            reads: expect.arrayContaining(["context", "queuedMessages"]),
            controls: expect.arrayContaining(["cancelQueuedMessage"]),
            context: {
              details: ["summary", "full"],
              defaultDetail: "summary",
              fullMayUseNetwork: true,
            },
            queuedMessages: { runtimeSupport: "checked_on_request", scope: "adapter_prompts" },
          },
        },
      });
      for (const detail of [undefined, "summary", "full"]) {
        expect(
          await c.send("_session/runtime/read", {
            sessionId: "sid",
            resource: "context",
            ...(detail ? { detail } : {}),
          }),
        ).toMatchObject({ status: "ok", data: { totalTokens: 42 } });
        expect(c.query.getContextUsage).toHaveBeenLastCalledWith({ detail: detail ?? "summary" });
      }
      await expect(
        c.send("_session/runtime/read", { sessionId: "sid", resource: "context", detail: null }),
      ).rejects.toMatchObject({ code: -32602 });
      expect(c.query.getContextUsage).toHaveBeenCalledTimes(3);
    } finally {
      await c.close();
    }
  });
  it("discovers and cancels just one pending prompt while another runs", async () => {
    const c = await connect(version);
    const active = pendingTurn("active");
    const one = pendingTurn("one");
    const two = pendingTurn("two");
    c.session.activeTurn = active;
    c.session.turnQueue = [active, one, two];
    try {
      expect(
        await c.send("_session/runtime/read", { sessionId: "sid", resource: "queuedMessages" }),
      ).toEqual({
        version: 1,
        status: "ok",
        data: { messages: [{ messageId: "one" }, { messageId: "two" }] },
      });
      expect(
        await c.send("_session/runtime/control", {
          sessionId: "sid",
          action: "cancelQueuedMessage",
          messageId: "one",
        }),
      ).toEqual({ version: 1, status: "ok", data: { messageId: "one", cancelled: true } });
      expect(c.query.cancelAsyncMessage).toHaveBeenCalledExactlyOnceWith("one");
      expect(one.resolve).toHaveBeenCalledExactlyOnceWith({ stopReason: "cancelled" });
      expect(c.session.turnQueue).toEqual([active, two]);
      expect(active.resolve).not.toHaveBeenCalled();
      expect(two.resolve).not.toHaveBeenCalled();
      expect(c.query.interrupt).not.toHaveBeenCalled();
      expect(c.session.cancelled).toBeUndefined();
    } finally {
      await c.close();
    }
  });
  it.each(["unknown", "started", "inserted", "settled", "steered"])(
    "refuses %s targets before native control",
    async (state) => {
      const c = await connect(version);
      const target = pendingTurn("one");
      if (state === "started") target.commandStarted = true;
      if (state === "inserted") target.insertedReported = true;
      if (state === "settled") target.settled = true;
      if (state === "steered") target.steeredUuids = new Set(["steer"]);
      c.session.turnQueue = state === "unknown" ? [] : [target];
      try {
        await expect(
          c.send("_session/runtime/control", {
            sessionId: "sid",
            action: "cancelQueuedMessage",
            messageId: "one",
          }),
        ).rejects.toMatchObject({ code: -32602 });
        expect(c.query.cancelAsyncMessage).not.toHaveBeenCalled();
      } finally {
        await c.close();
      }
    },
  );
  it("leaves a dequeued prompt running when native cancellation loses the race", async () => {
    const c = await connect(version);
    const target = pendingTurn("one");
    c.session.turnQueue = [target];
    vi.mocked(c.query.cancelAsyncMessage!).mockImplementation(async () => {
      target.commandStarted = true;
      c.session.activeTurn = target;
      return false;
    });
    try {
      expect(
        await c.send("_session/runtime/control", {
          sessionId: "sid",
          action: "cancelQueuedMessage",
          messageId: "one",
        }),
      ).toMatchObject({ data: { cancelled: false } });
      expect(target.resolve).not.toHaveBeenCalled();
      expect(target.settled).toBe(false);
      expect(c.session.turnQueue).toEqual([target]);
    } finally {
      await c.close();
    }
  });
  it("rejects contradictory success after execution starts", async () => {
    const c = await connect(version);
    const target = pendingTurn("one");
    c.session.turnQueue = [target];
    vi.mocked(c.query.cancelAsyncMessage!).mockImplementation(async () => {
      target.commandStarted = true;
      return true;
    });
    try {
      await expect(
        c.send("_session/runtime/control", {
          sessionId: "sid",
          action: "cancelQueuedMessage",
          messageId: "one",
        }),
      ).rejects.toMatchObject({ code: -32603 });
      expect(target.resolve).not.toHaveBeenCalled();
      expect(target.settled).toBe(true);
      expect(target.reject).toHaveBeenCalledOnce();
      expect(c.query.close).toHaveBeenCalledOnce();
    } finally {
      await c.close();
    }
  });
  it("serializes duplicate cancellations and revalidates the target after the first ACK", async () => {
    const c = await connect(version);
    const target = pendingTurn("one");
    c.session.turnQueue = [target];
    const ack = Promise.withResolvers<boolean>();
    vi.mocked(c.query.cancelAsyncMessage!).mockReturnValue(ack.promise);
    const params = { sessionId: "sid", action: "cancelQueuedMessage", messageId: "one" };
    try {
      const first = c.send("_session/runtime/control", params);
      await vi.waitFor(() => expect(c.query.cancelAsyncMessage).toHaveBeenCalledOnce());
      const second = c.send("_session/runtime/control", params).catch((error) => error);
      ack.resolve(true);
      expect(await first).toMatchObject({ data: { cancelled: true } });
      expect(await second).toMatchObject({ code: -32602 });
      expect(c.query.cancelAsyncMessage).toHaveBeenCalledOnce();
      expect(target.resolve).toHaveBeenCalledOnce();
    } finally {
      await c.close();
    }
  });
  it("aborts pending cancellation through the shared shutdown guard", async () => {
    const c = await connect(version);
    const target = pendingTurn("one");
    c.session.turnQueue = [target];
    const ack = Promise.withResolvers<boolean>();
    vi.mocked(c.query.cancelAsyncMessage!).mockReturnValue(ack.promise);
    const controller = new AbortController();
    try {
      const result = c
        .agent()
        .controlSessionRuntime(
          { sessionId: "sid", action: "cancelQueuedMessage", messageId: "one" },
          controller.signal,
        )
        .catch((error: Error) => error);
      await vi.waitFor(() => expect(c.query.cancelAsyncMessage).toHaveBeenCalledOnce());
      controller.abort();
      expect(await result).toBeInstanceOf(Error);
      expect(c.query.close).toHaveBeenCalledOnce();
      ack.resolve(true);
      await Promise.resolve();
      expect(target.resolve).not.toHaveBeenCalled();
    } finally {
      await c.close();
    }
  });
  it.each(["settled", "replaced", "closed"])(
    "does not settle again after %s during cancellation",
    async (state) => {
      const c = await connect(version);
      const target = pendingTurn("one");
      c.session.turnQueue = [target];
      const ack = Promise.withResolvers<boolean>();
      vi.mocked(c.query.cancelAsyncMessage!).mockReturnValue(ack.promise);
      try {
        const result = c.send("_session/runtime/control", {
          sessionId: "sid",
          action: "cancelQueuedMessage",
          messageId: "one",
        });
        await vi.waitFor(() => expect(c.query.cancelAsyncMessage).toHaveBeenCalled());
        if (state === "settled") target.settled = true;
        if (state === "replaced") c.session.query = {} as Query;
        if (state === "closed") c.session.queryClosed = true;
        ack.resolve(true);
        expect(await result).toMatchObject(
          state === "settled" ? { status: "ok" } : { status: "unavailable", reason: "stale" },
        );
        expect(target.resolve).not.toHaveBeenCalled();
      } finally {
        await c.close();
      }
    },
  );
  it("leaves unsupported queries intact", async () => {
    const c = await connect(version);
    const target = pendingTurn("one");
    c.session.turnQueue = [target];
    c.query.cancelAsyncMessage = undefined;
    try {
      expect(
        await c.send("_session/runtime/control", {
          sessionId: "sid",
          action: "cancelQueuedMessage",
          messageId: "one",
        }),
      ).toMatchObject({ reason: "unsupported" });
      expect(target.settled).toBe(false);
      expect(c.query.close).not.toHaveBeenCalled();
    } finally {
      await c.close();
    }
  });
  it.each([undefined, { cancelled: true }, "reject"])(
    "fences unknown native outcomes (%j)",
    async (ack) => {
      const c = await connect(version);
      const target = pendingTurn("one");
      c.session.turnQueue = [target];
      c.query.cancelAsyncMessage = async () => {
        if (ack === "reject") throw new Error("lost ACK");
        return ack;
      };
      try {
        await expect(
          c.send("_session/runtime/control", {
            sessionId: "sid",
            action: "cancelQueuedMessage",
            messageId: "one",
          }),
        ).rejects.toMatchObject({ code: -32603 });
        expect(target.settled).toBe(true);
        expect(target.reject).toHaveBeenCalledOnce();
        expect(target.resolve).not.toHaveBeenCalled();
        expect(c.query.close).toHaveBeenCalledOnce();
        expect(c.session.queryClosed).toBe(true);
      } finally {
        await c.close();
      }
    },
  );
  it("times out native cancellation, closes its query and ignores a late success", async () => {
    const c = await connect(version);
    c.agent().nativeMutationTimeoutMs = 10;
    const target = pendingTurn("one");
    c.session.turnQueue = [target];
    const ack = Promise.withResolvers<boolean>();
    vi.mocked(c.query.cancelAsyncMessage!).mockReturnValue(ack.promise);
    try {
      await expect(
        c.send("_session/runtime/control", {
          sessionId: "sid",
          action: "cancelQueuedMessage",
          messageId: "one",
        }),
      ).rejects.toMatchObject({ code: -32603 });
      expect(c.query.close).toHaveBeenCalledOnce();
      expect(c.session.queryClosed).toBe(true);
      ack.resolve(true);
      await Promise.resolve();
      expect(target.resolve).not.toHaveBeenCalled();
    } finally {
      await c.close();
    }
  });
  it("allows cancellation while a provider update waits for the pending turns", async () => {
    const c = await connect(version);
    c.session.turnQueue = [pendingTurn("one")];
    const provider = Promise.withResolvers<void>();
    Object.assign(c.agent(), { providerUpdate: provider.promise });
    try {
      expect(
        await c.send("_session/runtime/read", { sessionId: "sid", resource: "queuedMessages" }),
      ).toMatchObject({ data: { messages: [{ messageId: "one" }] } });
      expect(
        await c.send("_session/runtime/control", {
          sessionId: "sid",
          action: "cancelQueuedMessage",
          messageId: "one",
        }),
      ).toMatchObject({ data: { cancelled: true } });
    } finally {
      provider.resolve();
      await c.close();
    }
  });
  it.each(["startTurn", "steer", "resumeSession", "loadSession"])(
    "reserves %s behind a pending native control",
    async (method) => {
      const c = await connect(version);
      c.session.turnQueue = [pendingTurn("one")];
      const ack = Promise.withResolvers<boolean>();
      c.query.cancelAsyncMessage = vi.fn(() => ack.promise);
      const admitted = vi.fn(async () => ({}));
      Object.assign(c.agent(), { [method + "UnderMutation"]: admitted });
      try {
        const control = c.send("_session/runtime/control", {
          sessionId: "sid",
          action: "cancelQueuedMessage",
          messageId: "one",
        });
        await vi.waitFor(() => expect(c.query.cancelAsyncMessage).toHaveBeenCalledOnce());
        const api = c.agent() as unknown as Record<
          string,
          (params: unknown, events?: unknown) => Promise<unknown>
        >;
        const waiting = api[method]({ sessionId: "sid" }, {});
        await new Promise((resolve) => setTimeout(resolve, 5));
        expect(admitted).not.toHaveBeenCalled();
        ack.resolve(false);
        await Promise.all([control, waiting]);
        expect(admitted).toHaveBeenCalledOnce();
      } finally {
        ack.resolve(false);
        await c.close();
      }
    },
  );
  it.each(["closeSession", "dispose"])(
    "holds %s until native exit after aborting a control",
    async (method) => {
      const c = await connect(version);
      c.session.turnQueue = [pendingTurn("one")];
      const ack = Promise.withResolvers<boolean>();
      const exit = Promise.withResolvers<void>();
      c.query.cancelAsyncMessage = vi.fn(() => ack.promise);
      Object.assign(c.query, { transport: { waitForExit: () => exit.promise } });
      const tornDown = vi.fn(async () => {
        delete c.agent().sessions.sid;
      });
      Object.assign(c.agent(), { teardownSession: tornDown });
      const control = c
        .send("_session/runtime/control", {
          sessionId: "sid",
          action: "cancelQueuedMessage",
          messageId: "one",
        })
        .catch((error) => error);
      await vi.waitFor(() => expect(c.query.cancelAsyncMessage).toHaveBeenCalledOnce());
      const closing =
        method === "dispose" ? c.agent().dispose() : c.agent().closeSession({ sessionId: "sid" });
      await vi.waitFor(() => expect(c.query.close).toHaveBeenCalledOnce());
      expect(tornDown).not.toHaveBeenCalled();
      exit.resolve();
      await closing;
      expect(await control).toMatchObject({ code: -32603 });
      expect(tornDown).toHaveBeenCalledOnce();
      ack.resolve(true);
      await c.close();
    },
  );
  it("refuses a same-ID reload after unconfirmed native shutdown", async () => {
    const c = await connect(version);
    c.session.turnQueue = [pendingTurn("one")];
    Object.assign(c.query, {
      transport: {
        waitForExit: () => {
          throw new Error("no exit observer");
        },
      },
    });
    c.query.cancelAsyncMessage = async () => undefined;
    try {
      await expect(
        c.send("_session/runtime/control", {
          sessionId: "sid",
          action: "cancelQueuedMessage",
          messageId: "one",
        }),
      ).rejects.toMatchObject({ code: -32603 });
      await expect(
        c.agent().resumeSession({ sessionId: "sid", cwd: "/workspace", mcpServers: [] }),
      ).rejects.toThrow("shutdown unconfirmed");
    } finally {
      await c.close();
    }
  });
  it.each(["ack-first", "receipt-first"])(
    "reconciles cancellation and interrupt without consuming another orphan (%s)",
    async (order) => {
      const c = await connect(version);
      const target = pendingTurn("one"),
        survivor = pendingTurn("two");
      c.session.turnQueue = [target, survivor];
      const ack = Promise.withResolvers<boolean>();
      const receipt = Promise.withResolvers<{ still_queued: string[] }>();
      let calls = 0;
      c.query.cancelAsyncMessage = vi.fn(async () => (++calls === 1 ? ack.promise : false));
      Object.assign(c.query, { interrupt: vi.fn(() => receipt.promise) });
      try {
        const control = c.send("_session/runtime/control", {
          sessionId: "sid",
          action: "cancelQueuedMessage",
          messageId: "one",
        });
        await vi.waitFor(() => expect(c.query.cancelAsyncMessage).toHaveBeenCalledOnce());
        const cancel = c.agent().cancel({ sessionId: "sid" });
        await vi.waitFor(() => expect(c.query.interrupt).toHaveBeenCalledOnce());
        expect(c.session.pendingOrphanResults).toBe(2);
        if (order === "ack-first") {
          ack.resolve(true);
          await control;
          receipt.resolve({ still_queued: ["two"] });
          await cancel;
        } else {
          receipt.resolve({ still_queued: ["two"] });
          await cancel;
          ack.resolve(true);
          await control;
        }
        expect(c.session.pendingOrphanResults).toBe(1);
      } finally {
        ack.resolve(true);
        receipt.resolve({ still_queued: [] });
        await c.close();
      }
    },
  );
});
