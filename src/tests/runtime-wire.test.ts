import type { ClientCapabilities } from "@agentclientprotocol/sdk";
import { PROTOCOL_VERSION as V2_PROTOCOL_VERSION } from "@agentclientprotocol/sdk/experimental/v2";
import type { Query } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it, vi } from "vitest";
import { v1AgentApp, type ClaudeAcpAgent, type Session } from "../acp-agent.js";
import { v2AgentApp } from "../v2/agent.js";

/** Real ACP routers, with only the native Query replaced. No subprocess or prompt. */
async function connect(version: 1 | 2, clientCapabilities: ClientCapabilities = {}) {
  const incoming = new TransformStream();
  const outgoing = new TransformStream();
  let agent!: ClaudeAcpAgent;
  const updates: unknown[] = [];
  const request = vi.fn();
  const supportedCommands = vi.fn(async () => []);
  const query = {
    supportedCommands,
    supportedAgents: vi.fn(async () => []),
    reloadSkills: vi.fn(async () => ({})),
    backgroundTasks: vi.fn(async () => true),
    mcpServerStatus: vi.fn(async () => []),
    setMcpServers: vi.fn(async () => ({ added: ["host"], removed: [], errors: {} })),
    close: vi.fn(),
    transport: { waitForExit: async () => {} },
    interrupt: vi.fn(async () => undefined),
    request,
  } as unknown as Query;
  const session = {
    query,
    cwd: "/workspace",
    creationParams: { cwd: "/workspace", mcpServers: [] },
    mcpState: { revision: 0, hostServers: [], protectedServers: {} },
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
  await connection.send(
    "initialize",
    version === 1
      ? { protocolVersion: 1, clientCapabilities }
      : {
          protocolVersion: V2_PROTOCOL_VERSION,
          info: { name: "wire-test", version: "1" },
          capabilities: {},
        },
  );
  return connection;
}

describe.each([1, 2] as const)("ACP v%s runtime wire", (version) => {
  it("replaces MCP configuration on the wire and fences revisions", async () => {
    const c = await connect(version);
    const mcpServers = [
      { name: "host", command: "node", args: [], env: [{ name: "TOKEN", value: "secret" }] },
    ];
    try {
      expect(await c.send("_session/mcp/state", { sessionId: "sid" })).toMatchObject({
        revision: 0,
        servers: [],
      });
      expect(
        await c.send("_session/mcp/set", { sessionId: "sid", expectedRevision: 0, mcpServers }),
      ).toMatchObject({ status: "ok", revision: 1 });
      expect(c.session.creationParams?.mcpServers).toEqual(mcpServers);
      expect(c.session.sessionFingerprint).toBeTruthy();
      expect(
        JSON.stringify(await c.send("_session/mcp/state", { sessionId: "sid" })),
      ).not.toContain("secret");
      await expect(
        c.send("_session/mcp/set", { sessionId: "sid", expectedRevision: 0, mcpServers: [] }),
      ).rejects.toMatchObject({ code: -32602 });
      c.session.activeTurn = {} as Session["activeTurn"];
      await expect(
        c.send("_session/mcp/set", { sessionId: "sid", expectedRevision: 1, mcpServers: [] }),
      ).rejects.toMatchObject({ code: -32600 });
      expect(c.query.setMcpServers).toHaveBeenCalledTimes(1);
    } finally {
      await c.close();
    }
  });

  it.each(["runtime", "mcp"])(
    "closes a hung %s query before dispose releases its mutation",
    async (kind) => {
      const c = await connect(version);
      vi.mocked(c.query.reloadSkills).mockReturnValue(new Promise(() => {}));
      vi.mocked(c.query.mcpServerStatus).mockReturnValue(new Promise(() => {}));
      let exited!: () => void;
      Object.assign(c.query, {
        transport: {
          waitForExit: () =>
            new Promise<void>((resolve) => {
              exited = resolve;
            }),
        },
      });
      const pending = (
        kind === "runtime"
          ? c.send("_session/runtime/control", { sessionId: "sid", action: "reloadSkills" })
          : c.send("_session/mcp/set", { sessionId: "sid", expectedRevision: 0, mcpServers: [] })
      ).catch((e) => e);
      await vi.waitFor(() =>
        expect(
          kind === "runtime" ? c.query.reloadSkills : c.query.mcpServerStatus,
        ).toHaveBeenCalled(),
      );
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
    },
  );

  it("times out a native mutation, closes its query, and rejects further mutation on it", async () => {
    const c = await connect(version);
    c.agent().nativeMutationTimeoutMs = 20;
    vi.mocked(c.query.reloadSkills).mockReturnValue(new Promise(() => {}));
    try {
      await expect(
        c.send("_session/runtime/control", { sessionId: "sid", action: "reloadSkills" }),
      ).rejects.toMatchObject({ code: -32603 });
      expect(c.query.close).toHaveBeenCalledOnce();
      expect(c.session.queryClosed).toBe(true);
      expect(
        await c.send("_session/runtime/control", { sessionId: "sid", action: "reloadSkills" }),
      ).toMatchObject({ status: "unavailable" });
    } finally {
      await c.close();
    }
  });

  it("keeps recovery fenced when native exit cannot be observed", async () => {
    const c = await connect(version);
    c.agent().nativeMutationTimeoutMs = 10;
    Object.assign(c.query, { transport: undefined, [Symbol.asyncDispose]: async () => {} });
    vi.mocked(c.query.reloadSkills).mockReturnValue(new Promise(() => {}));
    try {
      await expect(
        c.send("_session/runtime/control", { sessionId: "sid", action: "reloadSkills" }),
      ).rejects.toMatchObject({ code: -32603 });
      await expect(
        c.agent().resumeSession({ sessionId: "sid", cwd: "/workspace", mcpServers: [] }),
      ).rejects.toThrow("shutdown unconfirmed");
      await expect(
        c.send("_session/runtime/control", { sessionId: "sid", action: "reloadOutputStyles" }),
      ).rejects.toMatchObject({ code: -32600 });
    } finally {
      await c.close();
    }
  });

  it("serves reads without submitting a prompt and validates resource names", async () => {
    const c = await connect(version);
    try {
      expect(
        await c.send("_session/runtime/read", { sessionId: "sid", resource: "commands" }),
      ).toEqual({ version: 1, status: "ok", data: [] });
      await expect(
        c.send("_session/runtime/read", { sessionId: "sid", resource: "request" }),
      ).rejects.toMatchObject({ code: -32602 });
      expect(c.query.supportedCommands).toHaveBeenCalledOnce();
      expect(c.query).not.toHaveProperty("streamInput");
    } finally {
      await c.close();
    }
  });
  it("refuses busy mutations but allows one explicitly named background task", async () => {
    const c = await connect(version);
    c.session.activeTurn = {} as Session["activeTurn"];
    try {
      await expect(
        c.send("_session/runtime/control", { sessionId: "sid", action: "reloadSkills" }),
      ).rejects.toMatchObject({ code: -32602 });
      expect(c.query.reloadSkills).not.toHaveBeenCalled();
      expect(
        await c.send("_session/runtime/control", {
          sessionId: "sid",
          action: "backgroundTask",
          toolUseId: "tool-1",
        }),
      ).toEqual({ version: 1, status: "ok", data: { backgrounded: true } });
      expect(c.query.backgroundTasks).toHaveBeenCalledWith("tool-1");
    } finally {
      await c.close();
    }
  });
  it("does not publish a late read belonging to a replaced Query", async () => {
    const c = await connect(version);
    let finish!: (value: []) => void;
    vi.mocked(c.query.supportedCommands).mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    try {
      const result = c.send("_session/runtime/read", { sessionId: "sid", resource: "commands" });
      await vi.waitFor(() => expect(c.query.supportedCommands).toHaveBeenCalled());
      c.session.query = {} as Query;
      finish([]);
      expect(await result).toEqual({ version: 1, status: "unavailable", reason: "stale" });
    } finally {
      await c.close();
    }
  });
  it.each(["plain", "air-without-index"])(
    "rejects unsupported archive without aborting a native reload (%s)",
    async (client) => {
      const capabilities =
        client === "plain"
          ? {}
          : {
              _meta: { jetbrains: { air: { version: 1, capabilities: ["sessionArchive"] } } },
            };
      const c = await connect(version, capabilities);
      const ack = Promise.withResolvers<never>();
      vi.mocked(c.query.reloadSkills).mockReturnValue(ack.promise);
      let settled = false;
      const control = c
        .send("_session/runtime/control", {
          sessionId: "sid",
          action: "reloadSkills",
        })
        .then(
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
        await vi.waitFor(() => expect(c.query.reloadSkills).toHaveBeenCalledOnce());
        await expect(c.send("_session/archive", { sessionId: "sid" })).rejects.toMatchObject({
          code: -32601,
        });
        expect(c.query.close).not.toHaveBeenCalled();
        expect(c.query.interrupt).not.toHaveBeenCalled();
        expect(c.session.queryClosed).not.toBe(true);
        expect(settled).toBe(false);
        ack.resolve({ commands: [], agents: [] } as never);
        await expect(control).resolves.toMatchObject({ result: { status: "ok" } });
        expect(c.query.close).not.toHaveBeenCalled();
      } finally {
        ack.resolve({ commands: [], agents: [] } as never);
        await control;
        await c.close();
      }
    },
  );

  it("keeps another lifecycle mutation behind a native reload", async () => {
    const c = await connect(version);
    let finish!: () => void;
    vi.mocked(c.query.reloadSkills).mockReturnValue(
      new Promise((resolve) => {
        finish = () => resolve({ commands: [], agents: [] } as never);
      }),
    );
    try {
      const control = c.send("_session/runtime/control", {
        sessionId: "sid",
        action: "reloadSkills",
      });
      await vi.waitFor(() => expect(c.query.reloadSkills).toHaveBeenCalled());
      let readDone = false;
      const read = c
        .send("_session/runtime/read", { sessionId: "sid", resource: "commands" })
        .then((r) => {
          readDone = true;
          return r;
        });
      await Promise.resolve();
      expect(readDone).toBe(false);
      finish();
      expect(await control).toMatchObject({ status: "ok" });
      expect(await read).toMatchObject({ status: "ok" });
      expect(c.updates.some((x) => JSON.stringify(x).includes("available_commands_update"))).toBe(
        true,
      );
    } finally {
      await c.close();
    }
  });
});
