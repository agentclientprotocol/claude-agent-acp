import { describe, it, expect, vi } from "vitest";
import { ClaudeAcpAgent } from "../../v1/acp-agent.js";
import type { AcpClient } from "../../acp-client.js";
import { RemoteControlAtStartup } from "../../remote-control.js";
import { mockSessionState, runningAdapterCommands } from "./session-doubles.js";

/** A stream that stays open, like the real one: a consumer that reaches its end
 *  closes the session. */
async function* openStream(): AsyncGenerator<never> {
  await new Promise<never>(() => {});
  yield* [];
}

function createAgent(query: Record<string, unknown>, sessionOverrides: Record<string, any> = {}) {
  const sessionUpdate = vi.fn(async () => {});
  const client = { sessionUpdate } as unknown as AcpClient;
  const agent = new ClaudeAcpAgent(client, { log: () => {}, error: () => {} });
  agent.sessions["session-1"] = mockSessionState({
    query: Object.assign(openStream(), { supportedCommands: async () => [] }, query),
    ...sessionOverrides,
  });
  return { agent, sessionUpdate };
}

const prompt = (text: string) => ({
  sessionId: "session-1",
  prompt: [{ type: "text" as const, text }],
});

const messageText = (sessionUpdate: ReturnType<typeof createAgent>["sessionUpdate"]) =>
  (sessionUpdate.mock.calls as any[][]).at(-1)?.[0].update.content.text;

describe("/remote-control", () => {
  it("starts Remote Control and reports the URL", async () => {
    const enableRemoteControl = vi.fn(async () => ({
      session_url: "https://claude.ai/code/session_123",
    }));
    const { agent, sessionUpdate } = createAgent({ enableRemoteControl });

    const response = await agent.prompt(prompt("/remote-control"));

    expect(response.stopReason).toBe("end_turn");
    expect(enableRemoteControl).toHaveBeenCalledWith(true, undefined);
    expect(messageText(sessionUpdate)).toContain("https://claude.ai/code/session_123");
  });

  it("passes the argument as the session name", async () => {
    const enableRemoteControl = vi.fn(async () => ({ session_url: "https://claude.ai/code/s" }));
    const { agent } = createAgent({ enableRemoteControl });

    await agent.prompt(prompt("/remote-control My laptop session"));

    expect(enableRemoteControl).toHaveBeenCalledWith(true, "My laptop session");
  });

  it("reconnects and renames on every run instead of toggling", async () => {
    const enableRemoteControl = vi.fn(async () => ({ session_url: "https://claude.ai/code/s" }));
    const { agent } = createAgent({ enableRemoteControl });

    await agent.prompt(prompt("/remote-control"));
    await agent.prompt(prompt("/remote-control new-name"));

    expect(enableRemoteControl).toHaveBeenNthCalledWith(1, true, undefined);
    expect(enableRemoteControl).toHaveBeenNthCalledWith(2, true, "new-name");
  });

  it("disconnects with `off`", async () => {
    const enableRemoteControl = vi.fn(async () => ({}));
    const { agent, sessionUpdate } = createAgent({ enableRemoteControl });

    const response = await agent.prompt(prompt("/remote-control off"));

    expect(response.stopReason).toBe("end_turn");
    expect(enableRemoteControl).toHaveBeenCalledExactlyOnceWith(false);
    expect(messageText(sessionUpdate)).toContain("Remote Control is off");
  });

  it.each([
    ["/remote-control", "Could not start Remote Control"],
    ["/remote-control off", "Could not stop Remote Control"],
  ])("reports the failure of %s to the user", async (command, expected) => {
    const enableRemoteControl = vi.fn(async () => {
      throw new Error("Remote Control is disabled by policy");
    });
    const { agent, sessionUpdate } = createAgent({ enableRemoteControl });

    const response = await agent.prompt(prompt(command));

    expect(response.stopReason).toBe("end_turn");
    expect(messageText(sessionUpdate)).toContain(expected);
    expect(messageText(sessionUpdate)).toContain("Remote Control is disabled by policy");
  });

  it.each(["/remote-control", "/remote-control off"])(
    "refuses %s while a turn is still running",
    async (command) => {
      const enableRemoteControl = vi.fn(async () => ({}));
      const { agent, sessionUpdate } = createAgent(
        { enableRemoteControl },
        { turnQueue: [{ settled: false }] },
      );

      await expect(agent.prompt(prompt(command))).rejects.toThrow(/while Claude is working/);

      expect(enableRemoteControl).not.toHaveBeenCalled();
      expect(sessionUpdate).not.toHaveBeenCalled();
    },
  );

  it("refuses the command while Claude Code runs a cycle of its own", async () => {
    const enableRemoteControl = vi.fn(async () => ({}));
    const { agent, sessionUpdate } = createAgent({ enableRemoteControl });
    (agent as any).startForeground("session-1", "autonomous-cycle");

    await expect(agent.prompt(prompt("/remote-control"))).rejects.toThrow(
      /while Claude is working/,
    );

    expect(enableRemoteControl).not.toHaveBeenCalled();
    expect(sessionUpdate).not.toHaveBeenCalled();
  });

  it("answers while only settled turns remain in the queue", async () => {
    const enableRemoteControl = vi.fn(async () => ({ session_url: "https://claude.ai/code/s" }));
    const { agent } = createAgent({ enableRemoteControl }, { turnQueue: [{ settled: true }] });

    await agent.prompt(prompt("/remote-control"));

    expect(enableRemoteControl).toHaveBeenCalledOnce();
  });

  it.each([
    ["/rc", []],
    ["/remote-control", [{ name: "remote-control", description: "", argumentHint: "" }]],
  ])("leaves %s to Claude Code", async (command, advertised) => {
    const enableRemoteControl = vi.fn(async () => ({}));
    const push = vi.fn();
    async function* noMessages() {}
    const { agent } = createAgent(
      Object.assign(noMessages(), {
        enableRemoteControl,
        supportedCommands: async () => advertised,
      }) as any,
      { input: { push } },
    );

    await agent.startTurn(prompt(command), {
      inserted() {},
      ended() {},
      failed() {},
    });

    expect(enableRemoteControl).not.toHaveBeenCalled();
    expect(push).toHaveBeenCalledOnce();
  });

  it("handles the command when Claude Code lists it as terminal-only", async () => {
    const enableRemoteControl = vi.fn(async () => ({ session_url: "https://claude.ai/code/s" }));
    const supportedCommands = async () => [
      { name: "remote-control", description: "", argumentHint: "" },
    ];
    const { agent, sessionUpdate } = createAgent(
      { enableRemoteControl, supportedCommands },
      { terminalSlashCommands: ["remote-control"] },
    );

    await agent.prompt(prompt("/remote-control"));
    await (agent as any).sendAvailableCommandsUpdate("session-1");

    expect(enableRemoteControl).toHaveBeenCalledOnce();
    const advertised = (sessionUpdate.mock.calls as any[][])
      .map(([notification]) => notification.update.availableCommands)
      .find(Boolean);
    expect(advertised.filter((command: any) => command.name === "remote-control")).toHaveLength(1);
  });

  describe("while the request is in flight", () => {
    const events = { inserted() {}, ended() {}, failed() {} };

    function pendingRequest() {
      let finish!: (result: { session_url: string }) => void;
      const enableRemoteControl = vi.fn(
        () =>
          new Promise<{ session_url: string }>((resolve) => {
            finish = resolve;
          }),
      );
      return { enableRemoteControl, finish: (result: { session_url: string }) => finish(result) };
    }

    function createPendingAgent(sessionOverrides: Record<string, any> = {}) {
      const request = pendingRequest();
      const push = vi.fn();
      const created = createAgent(
        { enableRemoteControl: request.enableRemoteControl },
        { input: { push }, ...sessionOverrides },
      );
      return { ...created, ...request, push };
    }

    it("holds a following prompt back until the reply is sent", async () => {
      const { agent, sessionUpdate, enableRemoteControl, finish, push } = createPendingAgent();

      const command = agent.startTurn(prompt("/remote-control"), events);
      await vi.waitFor(() => expect(enableRemoteControl).toHaveBeenCalled());
      const following = agent.startTurn(prompt("hello"), events);
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(push).not.toHaveBeenCalled();

      finish({ session_url: "https://claude.ai/code/s" });
      await Promise.all([command, following]);

      expect(sessionUpdate).toHaveBeenCalledOnce();
      expect(push).toHaveBeenCalledOnce();
      expect(sessionUpdate.mock.invocationCallOrder[0]).toBeLessThan(
        push.mock.invocationCallOrder[0],
      );
    });

    it("refuses a second command", async () => {
      const { agent, enableRemoteControl, finish } = createPendingAgent();

      const command = agent.startTurn(prompt("/remote-control"), events);
      await vi.waitFor(() => expect(enableRemoteControl).toHaveBeenCalled());

      await expect(agent.startTurn(prompt("/remote-control off"), events)).rejects.toThrow(
        /already being changed/,
      );
      expect(enableRemoteControl).toHaveBeenCalledOnce();

      finish({ session_url: "https://claude.ai/code/s" });
      await command;
    });

    it("lets prompts through again once the command is done", async () => {
      const { agent, finish, enableRemoteControl, push } = createPendingAgent();

      const command = agent.startTurn(prompt("/remote-control"), events);
      await vi.waitFor(() => expect(enableRemoteControl).toHaveBeenCalled());
      finish({ session_url: "https://claude.ai/code/s" });
      await command;
      await agent.startTurn(prompt("hello"), events);

      expect(push).toHaveBeenCalledOnce();
    });

    it("holds a prompt back until the notice of Remote Control at session start is sent", async () => {
      const { agent, sessionUpdate, enableRemoteControl, finish, push } = createPendingAgent({
        remoteControlAtStartup: new RemoteControlAtStartup(true),
      });

      const start = agent.connectRemoteControlAtStartup("session-1");
      await vi.waitFor(() => expect(enableRemoteControl).toHaveBeenCalled());
      const following = agent.startTurn(prompt("hello"), events);
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(push).not.toHaveBeenCalled();

      finish({ session_url: "https://claude.ai/code/s" });
      await Promise.all([start, following]);

      expect(sessionUpdate).toHaveBeenCalledOnce();
      expect(push).toHaveBeenCalledOnce();
      expect(sessionUpdate.mock.invocationCallOrder[0]).toBeLessThan(
        push.mock.invocationCallOrder[0],
      );
    });

    it("holds a prompt that waits for a sign-out respawn until its query's notice is sent", async () => {
      const { enableRemoteControl, finish } = pendingRequest();
      const push = vi.fn();
      // A sign-out closed the query: the next prompt starts it again.
      const { agent, sessionUpdate } = createAgent(
        {},
        {
          needsSignOutRespawn: true,
          queryClosed: true,
          creationParams: { cwd: "/test", mcpServers: [] },
        },
      );
      vi.spyOn(agent as any, "createSession").mockImplementation(async () => {
        agent.sessions["session-1"] = mockSessionState({
          query: Object.assign(openStream(), {
            supportedCommands: async () => [],
            enableRemoteControl,
          }),
          input: { push },
          remoteControlAtStartup: new RemoteControlAtStartup(true),
        });
      });

      const following = agent.startTurn(prompt("hello"), events);
      await vi.waitFor(() => expect(enableRemoteControl).toHaveBeenCalled());
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(push).not.toHaveBeenCalled();

      finish({ session_url: "https://claude.ai/code/s" });
      await following;

      const notice = (sessionUpdate.mock.calls as any[][]).findIndex(([{ update }]) =>
        JSON.stringify(update).includes("Remote Control connected"),
      );
      expect(push).toHaveBeenCalledOnce();
      expect(sessionUpdate.mock.invocationCallOrder[notice]).toBeLessThan(
        push.mock.invocationCallOrder[0],
      );
    });

    it("refuses a /remote-control that comes while Remote Control starts with the query", async () => {
      const { agent, enableRemoteControl, finish } = createPendingAgent({
        remoteControlAtStartup: new RemoteControlAtStartup(true),
      });

      const start = agent.connectRemoteControlAtStartup("session-1");
      await vi.waitFor(() => expect(enableRemoteControl).toHaveBeenCalled());

      await expect(agent.startTurn(prompt("/remote-control off"), events)).rejects.toThrow(
        /already being changed/,
      );
      expect(enableRemoteControl).toHaveBeenCalledOnce();

      finish({ session_url: "https://claude.ai/code/s" });
      await start;
    });

    it("still sends the notice when a session/cancel comes while Remote Control starts", async () => {
      const request = pendingRequest();
      const { agent, sessionUpdate } = createAgent(
        { enableRemoteControl: request.enableRemoteControl, interrupt: vi.fn() },
        { remoteControlAtStartup: new RemoteControlAtStartup(true), input: { end: vi.fn() } },
      );
      const { enableRemoteControl, finish } = request;

      const start = agent.connectRemoteControlAtStartup("session-1");
      await vi.waitFor(() => expect(enableRemoteControl).toHaveBeenCalled());
      await agent.cancel({ sessionId: "session-1" });
      finish({ session_url: "https://claude.ai/code/s" });
      await start;

      expect(messageText(sessionUpdate)).toContain("Remote Control connected");
    });

    it("closes without waiting for a Remote Control request that never answers", async () => {
      const { agent } = createAgent(
        {
          enableRemoteControl: vi.fn(() => new Promise<never>(() => {})),
          interrupt: vi.fn(),
          close: vi.fn(),
        },
        { remoteControlAtStartup: new RemoteControlAtStartup(true), input: { end: vi.fn() } },
      );
      const error = vi.spyOn((agent as any).logger, "error");

      void agent.connectRemoteControlAtStartup("session-1");
      await vi.waitFor(() => expect(agent.sessions["session-1"].adapterCommands?.busy).toBe(true));
      const started = Date.now();
      await agent.closeSession({ sessionId: "session-1" });

      expect(Date.now() - started).toBeLessThan(1000);
      expect(error).not.toHaveBeenCalledWith(expect.stringContaining("did not end"));
    });

    it("sends no notice when the query closed while Remote Control was starting", async () => {
      const { agent, sessionUpdate, enableRemoteControl, finish } = createPendingAgent({
        remoteControlAtStartup: new RemoteControlAtStartup(true),
      });

      const start = agent.connectRemoteControlAtStartup("session-1");
      await vi.waitFor(() => expect(enableRemoteControl).toHaveBeenCalled());
      // A restart or a close ended the query, and its Remote Control with it.
      agent.sessions["session-1"].queryClosed = true;
      finish({ session_url: "https://claude.ai/code/s" });
      await start;

      expect(sessionUpdate).not.toHaveBeenCalled();
    });
  });

  it("starts reading the query stream so other clients' messages reach this one", async () => {
    const { agent } = createAgent({
      enableRemoteControl: vi.fn(async () => ({ session_url: "https://claude.ai/code/s" })),
    });

    await agent.prompt(prompt("/remote-control"));

    expect(agent.sessions["session-1"].consumer).toBeDefined();
  });

  it("advertises the command only when the query supports it", async () => {
    const supportedCommands = async () => [{ name: "compact", description: "", argumentHint: "" }];
    const supported = createAgent({ enableRemoteControl: vi.fn(), supportedCommands });
    const unsupported = createAgent({ supportedCommands });

    await (supported.agent as any).sendAvailableCommandsUpdate("session-1");
    await (unsupported.agent as any).sendAvailableCommandsUpdate("session-1");

    const names = (update: ReturnType<typeof createAgent>["sessionUpdate"]) =>
      (update.mock.calls as any[][])[0][0].update.availableCommands.map((c: any) => c.name);
    expect(names(supported.sessionUpdate)).toContain("remote-control");
    expect(names(unsupported.sessionUpdate)).not.toContain("remote-control");
  });
});

describe("Remote Control at session start", () => {
  /** The fields of a session whose query Claude Code asked to start Remote
   *  Control with. New for each test, as the first connect spends the request. */
  const startsWith = () => ({ remoteControlAtStartup: new RemoteControlAtStartup(true) });

  it("connects and reports it in a notice, as a transcript line to a client without notices", async () => {
    const enableRemoteControl = vi.fn(async () => ({
      session_url: "https://claude.ai/code/session_123",
    }));
    const { agent, sessionUpdate } = createAgent({ enableRemoteControl }, startsWith());

    await agent.connectRemoteControlAtStartup("session-1");

    expect(enableRemoteControl).toHaveBeenCalledExactlyOnceWith(true);
    expect(messageText(sessionUpdate)).toBe(
      "\n\n> **Remote Control connected:** Continue this session from claude.ai/code or the Claude mobile app: https://claude.ai/code/session_123\n> Run /remote-control off to disconnect.\n\n",
    );
  });

  // What v1 counts as busy, and its closed query. The steps both cores share
  // are tested in `src/tests/remote-control.test.ts`.
  it.each<[string, () => Record<string, unknown>, ((agent: ClaudeAcpAgent) => void)?]>([
    ["the query is closed", () => ({ ...startsWith(), queryClosed: true })],
    ["a turn is running", () => ({ ...startsWith(), turnQueue: [{ settled: false }] })],
    [
      "Claude Code runs a cycle of its own",
      startsWith,
      (agent) => (agent as any).startForeground("session-1", "autonomous-cycle"),
    ],
    [
      "a /remote-control command runs",
      () => ({
        ...startsWith(),
        adapterCommands: runningAdapterCommands(new Promise<void>(() => {}), { abortable: true }),
      }),
    ],
    // A close before the setup response's timer ran.
    [
      "the session is gone",
      startsWith,
      (agent) => {
        delete agent.sessions["session-1"];
      },
    ],
  ])("starts nothing when %s", async (_case, overrides, setup) => {
    const enableRemoteControl = vi.fn(async () => ({ session_url: "https://claude.ai/code/s" }));
    const { agent, sessionUpdate } = createAgent({ enableRemoteControl }, overrides());
    setup?.(agent);

    await agent.connectRemoteControlAtStartup("session-1");

    expect(enableRemoteControl).not.toHaveBeenCalled();
    expect(sessionUpdate).not.toHaveBeenCalled();
  });

  it("spends the request of a fresh context for an approved plan, which starts while Claude works", async () => {
    const enableRemoteControl = vi.fn(async () => ({ session_url: "https://claude.ai/code/s" }));
    const turn = { promptUuid: "prompt-1", settled: false, resolve: vi.fn(), reject: vi.fn() };
    const { agent } = createAgent(
      { enableRemoteControl, close: vi.fn() },
      {
        activeTurn: turn,
        turnQueue: [turn],
        creationParams: { cwd: "/test", mcpServers: [] },
        input: { push: vi.fn(), end: vi.fn() },
      },
    );
    // The fresh query asks for Remote Control too.
    const fresh = mockSessionState({
      query: Object.assign(openStream(), {
        supportedCommands: async () => [],
        enableRemoteControl,
      }),
      input: { push: vi.fn() },
      ...startsWith(),
    });
    vi.spyOn(agent as any, "createSession").mockImplementation(async () => {
      agent.sessions["session-1"] = fresh;
    });
    const error = vi.spyOn((agent as any).logger, "error");

    // No foreground work is set: the turn that the fresh query carries is what
    // makes Claude work when the restart connects.
    await (agent as any).exitPlan.restart("session-1", agent.sessions["session-1"], {
      toolUseId: "tool-plan",
      plan: "Ship it",
      mode: "auto",
    });
    // The plan's turn ends, then a resume of the live session runs the setup's connect.
    turn.settled = true;
    await agent.connectRemoteControlAtStartup("session-1");

    expect(error).not.toHaveBeenCalled();
    expect(turn.reject).not.toHaveBeenCalled();
    expect(agent.sessions["session-1"]).toBe(fresh);
    expect(fresh.turnQueue).toEqual([turn]);
    expect(enableRemoteControl).not.toHaveBeenCalled();
  });

  it("keeps a /remote-control off through the fresh context of an approved plan", async () => {
    const enableRemoteControl = vi.fn(async () => ({ session_url: "https://claude.ai/code/s" }));
    const { agent } = createAgent(
      { enableRemoteControl, close: vi.fn() },
      {
        ...startsWith(),
        creationParams: { cwd: "/test", mcpServers: [] },
        input: { push: vi.fn(), end: vi.fn() },
      },
    );
    await agent.prompt(prompt("/remote-control off"));
    const old = agent.sessions["session-1"];
    const turn = { promptUuid: "prompt-1", settled: false, resolve: vi.fn(), reject: vi.fn() };
    Object.assign(old, { activeTurn: turn, turnQueue: [turn] });
    const fresh = mockSessionState({
      query: Object.assign(openStream(), {
        supportedCommands: async () => [],
        enableRemoteControl,
      }),
      input: { push: vi.fn() },
      ...startsWith(),
    });
    vi.spyOn(agent as any, "createSession").mockImplementation(async () => {
      agent.sessions["session-1"] = fresh;
    });

    await (agent as any).exitPlan.restart("session-1", old, {
      toolUseId: "tool-plan",
      plan: "Ship it",
      mode: "auto",
    });
    // A later restart of the fresh query, such as a provider switch.
    const later = new RemoteControlAtStartup(true);
    later.restartedFrom(fresh.remoteControlAtStartup);
    await later.connect({
      sessionId: "session-1",
      logger: { log: vi.fn(), error: vi.fn() },
      query: () => fresh.query,
      working: () => false,
    });

    expect(agent.sessions["session-1"]).toBe(fresh);
    expect(enableRemoteControl.mock.calls).toEqual([[false]]);
  });

  it("starts reading the query stream so other clients' messages reach this one", async () => {
    const { agent } = createAgent(
      { enableRemoteControl: vi.fn(async () => ({ session_url: "https://claude.ai/code/s" })) },
      startsWith(),
    );

    await agent.connectRemoteControlAtStartup("session-1");

    expect(agent.sessions["session-1"].consumer).toBeDefined();
  });

  it("logs a notice the client failed to take and lets prompts through", async () => {
    const { agent, sessionUpdate } = createAgent(
      { enableRemoteControl: vi.fn(async () => ({ session_url: "https://claude.ai/code/s" })) },
      startsWith(),
    );
    sessionUpdate.mockRejectedValueOnce(new Error("connection closed"));
    const error = vi.spyOn((agent as any).logger, "error");

    await agent.connectRemoteControlAtStartup("session-1");

    expect(error).toHaveBeenCalledWith(
      "Session session-1: failed to send the Remote Control notice:",
      expect.objectContaining({ message: "connection closed" }),
    );
    expect(agent.sessions["session-1"].adapterCommands?.busy).toBeFalsy();
  });
});
