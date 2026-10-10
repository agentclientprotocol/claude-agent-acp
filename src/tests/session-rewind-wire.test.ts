import type { ClientCapabilities } from "@agentclientprotocol/sdk";
import { createHash } from "node:crypto";
import { PROTOCOL_VERSION as V2_PROTOCOL_VERSION } from "@agentclientprotocol/sdk/experimental/v2";
import type { Query, SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { v1AgentApp, type ClaudeAcpAgent, type Session } from "../acp-agent.js";
import { v2AgentApp } from "../v2/agent.js";
import { readSessionHistory } from "../session-history.js";

vi.mock("../session-history.js", () => ({ readSessionHistory: vi.fn() }));

const requestParams = {
  sessionId: "sid",
  beforeMessage: {
    messageId: "user-1",
    messageFingerprint: "sha256:" + createHash("sha256").update("original").digest("hex"),
    messageOccurrence: 1,
  },
};

beforeEach(() => {
  vi.mocked(readSessionHistory).mockResolvedValue([
    {
      uuid: "user-1",
      type: "user",
      message: { role: "user", content: "original" },
    } as SessionMessage,
  ]);
});

/** Exercise both ACP routers; replace only native history and the query. */
async function connect(version: 1 | 2, clientCapabilities: ClientCapabilities = {}) {
  const incoming = new TransformStream();
  const outgoing = new TransformStream();
  let agent!: ClaudeAcpAgent;
  const request = vi.fn(async () => ({
    response: { rewound: true, targetMessageUuid: "user-1" },
  }));
  const query = {
    request,
    close: vi.fn(),
    transport: { waitForExit: async () => {} },
  } as unknown as Query;
  const session = {
    query,
    cwd: "/workspace",
    creationParams: { cwd: "/workspace", mcpServers: [] },
    settingsManager: { dispose: vi.fn() },
    input: { end: vi.fn() },
    abortController: new AbortController(),
    turnQueue: [],
    liveBackgroundTasks: new Map(),
    messageIdToUuid: new Map(),
    taskState: new Map(),
    modes: { currentModeId: "default", availableModes: [] },
  } as unknown as Session;
  const app = (version === 1 ? v1AgentApp : v2AgentApp)({ log: () => {}, error: () => {} }, (a) => {
    agent = a;
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
      const waiter = pending.get(value.id);
      pending.delete(value.id);
      if (value.error) waiter?.reject(value.error);
      else waiter?.resolve(value.result);
    }
  })();
  const send = (method: string, params: unknown): Promise<unknown> => {
    const requestId = ++id;
    const result = new Promise((resolve, reject) => pending.set(requestId, { resolve, reject }));
    void writer.write({ jsonrpc: "2.0", id: requestId, method, params });
    return result;
  };
  const initialized = await send(
    "initialize",
    version === 1
      ? { protocolVersion: 1, clientCapabilities }
      : {
          protocolVersion: V2_PROTOCOL_VERSION,
          info: { name: "rewind-wire-test", version: "1" },
          capabilities: {},
        },
  );
  return {
    agent: () => agent,
    session,
    query,
    request,
    initialized,
    send,
    close: () => writer.close(),
  };
}

describe.each([1, 2] as const)("ACP v%s core rewind wire", (version) => {
  it("rewinds through the router with the same session and no new control endpoints", async () => {
    const c = await connect(version);
    try {
      expect(JSON.stringify(c.initialized)).toContain("sessionRewind");
      for (const key of ["sessionRewindFiles", "sessionMcp", '"runtime"'])
        expect(JSON.stringify(c.initialized)).not.toContain(key);
      expect(await c.send("_session/rewind", requestParams)).toEqual({
        rewound: true,
        sessionId: "sid",
      });
      expect(c.agent().sessions.sid).toBe(c.session);
      expect(c.query.close).not.toHaveBeenCalled();
      expect(c.request).toHaveBeenCalledWith({
        subtype: "rewind_conversation",
        target_message_uuid: "user-1",
        last_seen_user_message_uuid: "user-1",
        interrupt_if_running: false,
      });
      for (const method of [
        "_session/runtime/read",
        "_session/runtime/control",
        "_session/mcp/state",
        "_session/mcp/set",
        "_session/rewind_files",
      ])
        await expect(c.send(method, { sessionId: "sid" })).rejects.toMatchObject({
          code: -32601,
        });
    } finally {
      await c.close();
    }
  });

  it.each(["plain", "air-without-index"])(
    "rejects unsupported archive without aborting a native control (%s)",
    async (client) => {
      const capabilities =
        client === "plain"
          ? {}
          : {
              _meta: { jetbrains: { air: { version: 1, capabilities: ["sessionArchive"] } } },
            };
      const c = await connect(version, capabilities);
      const ack = Promise.withResolvers<{
        response: { rewound: boolean; targetMessageUuid: string };
      }>();
      c.request.mockReturnValue(ack.promise);
      let settled = false;
      const control = c.send("_session/rewind", requestParams).then(
        (result) => {
          settled = true;
          return { result };
        },
        (error) => {
          settled = true;
          return { error };
        },
      );
      try {
        await vi.waitFor(() => expect(c.request).toHaveBeenCalledOnce());
        await expect(c.send("_session/archive", { sessionId: "sid" })).rejects.toMatchObject({
          code: -32601,
        });
        expect(c.query.close).not.toHaveBeenCalled();
        expect(c.session.queryClosed).not.toBe(true);
        expect(settled).toBe(false);
        ack.resolve({ response: { rewound: true, targetMessageUuid: "user-1" } });
        await expect(control).resolves.toMatchObject({
          result: { rewound: true, sessionId: "sid" },
        });
        expect(c.query.close).not.toHaveBeenCalled();
      } finally {
        ack.resolve({ response: { rewound: true, targetMessageUuid: "user-1" } });
        await control;
        await c.close();
      }
    },
  );

  it("holds dispose until the interrupted rewind's native process exits", async () => {
    const c = await connect(version);
    c.request.mockReturnValue(new Promise(() => {}));
    let exited!: () => void;
    Object.assign(c.query, {
      transport: {
        waitForExit: () =>
          new Promise<void>((resolve) => {
            exited = resolve;
          }),
      },
    });
    const pending = c.send("_session/rewind", requestParams).catch((e) => e);
    await vi.waitFor(() => expect(c.request).toHaveBeenCalledOnce());
    let disposed = false;
    const dispose = c
      .agent()
      .dispose()
      .then(() => {
        disposed = true;
      });
    await vi.waitFor(() => expect(c.query.close).toHaveBeenCalled());
    expect(disposed).toBe(false);
    exited();
    await dispose;
    expect(await pending).toMatchObject({ code: -32603 });
    expect(c.agent().sessions.sid).toBeUndefined();
    await c.close();
  });

  it("keeps a title change behind an in-flight rewind", async () => {
    const c = await connect(version);
    let finish!: (value: { response: { rewound: boolean; targetMessageUuid: string } }) => void;
    c.request.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    const rename = vi.fn(async () => ({}));
    Object.assign(c.agent(), {
      sessionIndex: { rename, dispose: vi.fn(), onTeardown: vi.fn(), onOwnSessionChanged: vi.fn() },
    });
    try {
      const pending = c.send("_session/rewind", requestParams);
      await vi.waitFor(() => expect(c.request).toHaveBeenCalledOnce());
      const renamed = c.agent().renameSessionTitle({ sessionId: "sid", title: "Kept title" });
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(rename).not.toHaveBeenCalled();
      finish({ response: { rewound: true, targetMessageUuid: "user-1" } });
      await expect(pending).resolves.toMatchObject({ rewound: true });
      await renamed;
      expect(rename).toHaveBeenCalledWith({ sessionId: "sid", title: "Kept title" });
    } finally {
      await c.close();
    }
  });

  it.each(["archiveSession", "deleteSession"] as const)(
    "%s waits for uncertain rewind exit before changing storage",
    async (method) => {
      const c = await connect(version);
      c.request.mockReturnValue(new Promise(() => {}));
      let exited!: () => void;
      Object.assign(c.query, {
        transport: { waitForExit: () => new Promise<void>((resolve) => (exited = resolve)) },
      });
      const mutate = vi.fn(async () => ({}));
      Object.assign(c.agent(), {
        sessionIndex: {
          assertArchiveSupported: vi.fn(),
          archive: mutate,
          deleteSession: mutate,
          dispose: vi.fn(),
          onTeardown: vi.fn(),
          onOwnSessionChanged: vi.fn(),
        },
      });
      try {
        const pending = c.send("_session/rewind", requestParams).catch((error) => error);
        await vi.waitFor(() => expect(c.request).toHaveBeenCalledOnce());
        const changed = c.agent()[method]({ sessionId: "sid" });
        await vi.waitFor(() => expect(c.query.close).toHaveBeenCalled());
        expect(mutate).not.toHaveBeenCalled();
        exited();
        await changed;
        expect(await pending).toMatchObject({ code: -32603 });
        expect(mutate).toHaveBeenCalledWith({ sessionId: "sid" });
      } finally {
        await c.close();
      }
    },
  );

  it("times out without accepting a late native acknowledgement or retrying", async () => {
    const c = await connect(version);
    c.agent().nativeMutationTimeoutMs = 20;
    let finish!: (value: { response: { rewound: boolean; targetMessageUuid: string } }) => void;
    c.request.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    try {
      await expect(c.send("_session/rewind", requestParams)).rejects.toMatchObject({
        code: -32603,
      });
      expect(c.query.close).toHaveBeenCalledOnce();
      expect(c.session.queryClosed).toBe(true);
      finish({ response: { rewound: true, targetMessageUuid: "user-1" } });
      await expect(c.send("_session/rewind", requestParams)).resolves.toMatchObject({
        rewound: false,
        reason: "session_closed",
      });
      expect(c.request).toHaveBeenCalledOnce();
    } finally {
      await c.close();
    }
  });

  it("keeps same-ID recreation fenced when native exit cannot be confirmed", async () => {
    const c = await connect(version, {
      _meta: { jetbrains: { air: { version: 1, capabilities: ["sessionIndex"] } } },
    });
    c.agent().nativeMutationTimeoutMs = 20;
    Object.assign(c.query, { transport: undefined, [Symbol.asyncDispose]: async () => {} });
    c.request.mockReturnValue(new Promise(() => {}));
    try {
      await expect(c.send("_session/rewind", requestParams)).rejects.toMatchObject({
        code: -32603,
      });
      await expect(
        c.agent().resumeSession({ sessionId: "sid", cwd: "/workspace", mcpServers: [] }),
      ).rejects.toThrow("shutdown unconfirmed");
      await expect(c.send("_session/rewind", requestParams)).rejects.toMatchObject({
        code: -32600,
      });
      for (const change of [
        () => c.agent().renameSessionTitle({ sessionId: "sid", title: "Unsafe rename" }),
        () => c.agent().unarchiveSession({ sessionId: "sid" }),
        () => c.agent().deleteSession({ sessionId: "sid" }),
      ]) {
        await expect(change()).rejects.toThrow("shutdown unconfirmed");
      }
      if (version === 1) {
        await expect(c.send("_session/archive", { sessionId: "sid" })).rejects.toMatchObject({
          code: -32600,
          message: expect.stringContaining("shutdown unconfirmed"),
        });
      } else {
        await expect(c.agent().archiveSession({ sessionId: "sid" })).rejects.toMatchObject({
          code: -32601,
        });
      }
      expect(c.request).toHaveBeenCalledOnce();
    } finally {
      await c.close();
    }
  });
});
