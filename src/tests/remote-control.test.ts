import { describe, it, expect, vi } from "vitest";
import { ClaudeAcpAgent, type AcpClient } from "../acp-agent.js";
import { startsWithRemoteControl } from "../remote-control.js";
import { mockSessionState } from "./session-doubles.js";

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
        remoteControlAtStartup: true,
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

describe("startsWithRemoteControl", () => {
  /** The Remote Control fields of the `initialize` result of Claude Code
   *  2.1.303 with `remoteControlAtStartup: true` in the user settings. */
  const reported = {
    remote_control_auto_enable: true,
    remote_control_auto_connect_default: false,
    remote_control_available: true,
    remote_control_auto_on_by_default: false,
  };

  it.each([
    [true, "asks for it", reported],
    [
      false,
      "does not ask for it",
      { ...reported, remote_control_auto_enable: false, remote_control_auto_on_by_default: true },
    ],
    [false, "predates the field", {}],
  ])("is %s when Claude Code %s", (expected, _case, fields) => {
    expect(startsWithRemoteControl({ models: [], ...fields } as any)).toBe(expected);
  });
});

describe("Remote Control at session start", () => {
  const startsWith = { remoteControlAtStartup: true };

  it.each([
    [
      { session_url: "https://claude.ai/code/session_123" },
      "**Remote Control connected:** Continue this session from claude.ai/code or the Claude mobile app: https://claude.ai/code/session_123\nRun /remote-control off to disconnect.",
    ],
    [
      {},
      "**Remote Control connected:** Claude Code did not return a session URL.\nRun /remote-control off to disconnect.",
    ],
  ])("connects and reports %j in a notice", async (result, expected) => {
    const enableRemoteControl = vi.fn(async () => result);
    const { agent, sessionUpdate } = createAgent({ enableRemoteControl }, startsWith);

    await agent.connectRemoteControlAtStartup("session-1");

    expect(enableRemoteControl).toHaveBeenCalledExactlyOnceWith(true);
    expect(messageText(sessionUpdate)).toBe(expected);
  });

  it("reports a refusal in a warning", async () => {
    const enableRemoteControl = vi.fn(async () => {
      throw new Error("Remote Control is disabled by policy");
    });
    const { agent, sessionUpdate } = createAgent({ enableRemoteControl }, startsWith);

    await agent.connectRemoteControlAtStartup("session-1");

    expect(messageText(sessionUpdate)).toBe(
      "**Could not start Remote Control:** Remote Control is disabled by policy",
    );
  });

  it.each([
    ["Claude Code did not ask for it", { remoteControlAtStartup: false }, true],
    ["the query has no Remote Control", startsWith, false],
    ["a turn is running", { ...startsWith, turnQueue: [{ settled: false }] }, true],
    [
      "a /remote-control command runs",
      { ...startsWith, remoteControlCommand: new Promise(() => {}) },
      true,
    ],
  ])("starts nothing when %s", async (_case, overrides, supported) => {
    const enableRemoteControl = vi.fn(async () => ({ session_url: "https://claude.ai/code/s" }));
    const { agent, sessionUpdate } = createAgent(
      supported ? { enableRemoteControl } : {},
      overrides,
    );

    await agent.connectRemoteControlAtStartup("session-1");

    expect(enableRemoteControl).not.toHaveBeenCalled();
    expect(sessionUpdate).not.toHaveBeenCalled();
  });

  it("starts nothing while Claude Code runs a cycle of its own", async () => {
    const enableRemoteControl = vi.fn(async () => ({ session_url: "https://claude.ai/code/s" }));
    const { agent, sessionUpdate } = createAgent({ enableRemoteControl }, startsWith);
    (agent as any).startForeground("session-1", "autonomous-cycle");

    await agent.connectRemoteControlAtStartup("session-1");

    expect(enableRemoteControl).not.toHaveBeenCalled();
    expect(sessionUpdate).not.toHaveBeenCalled();
  });

  it("starts Remote Control once per session", async () => {
    const enableRemoteControl = vi.fn(async () => ({ session_url: "https://claude.ai/code/s" }));
    const { agent } = createAgent({ enableRemoteControl }, startsWith);

    await agent.connectRemoteControlAtStartup("session-1");
    await agent.connectRemoteControlAtStartup("session-1");

    expect(enableRemoteControl).toHaveBeenCalledOnce();
  });

  it("starts reading the query stream so other clients' messages reach this one", async () => {
    const { agent } = createAgent(
      { enableRemoteControl: vi.fn(async () => ({ session_url: "https://claude.ai/code/s" })) },
      startsWith,
    );

    await agent.connectRemoteControlAtStartup("session-1");

    expect(agent.sessions["session-1"].consumer).toBeDefined();
  });

  it("logs a notice the client failed to take and lets prompts through", async () => {
    const { agent, sessionUpdate } = createAgent(
      { enableRemoteControl: vi.fn(async () => ({ session_url: "https://claude.ai/code/s" })) },
      startsWith,
    );
    sessionUpdate.mockRejectedValueOnce(new Error("connection closed"));
    const error = vi.spyOn((agent as any).logger, "error");

    await agent.connectRemoteControlAtStartup("session-1");

    expect(error).toHaveBeenCalledWith(
      "Session session-1: failed to send the Remote Control notice:",
      expect.objectContaining({ message: "connection closed" }),
    );
    expect(agent.sessions["session-1"].remoteControlCommand).toBeUndefined();
  });
});
