import { describe, it, expect, vi } from "vitest";
import { RequestError } from "@agentclientprotocol/sdk/unstable";
import { ClaudeAcpAgent, type AcpClient } from "../acp-agent.js";
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

  describe("steering", () => {
    const cliCommand = { name: "remote-control", description: "", argumentHint: "" };

    function createSteeringAgent(
      query: Record<string, unknown>,
      sessionOverrides: Record<string, any> = {},
    ) {
      const push = vi.fn();
      const turn = { settled: false };
      return {
        ...createAgent(query, { input: { push }, turnQueue: [turn], ...sessionOverrides }),
        push,
        turn,
      };
    }

    it.each(["/remote-control", "/remote-control My laptop session", "/remote-control off"])(
      "refuses %s while a turn is still running",
      async (command) => {
        const enableRemoteControl = vi.fn(async () => ({}));
        const { agent, sessionUpdate, push } = createSteeringAgent({ enableRemoteControl });

        const steering = agent.steer(prompt(command));

        await expect(steering).rejects.toBeInstanceOf(RequestError);
        await expect(steering).rejects.toThrow(
          "Remote Control can't be changed while Claude is working. Try again when the turn ends.",
        );
        expect(push).not.toHaveBeenCalled();
        expect(enableRemoteControl).not.toHaveBeenCalled();
        expect(sessionUpdate).not.toHaveBeenCalled();
      },
    );

    it("leaves a command offered by Claude Code to the running turn", async () => {
      const enableRemoteControl = vi.fn();
      const { agent, push } = createSteeringAgent({
        enableRemoteControl,
        supportedCommands: async () => [cliCommand],
      });

      await expect(agent.steer(prompt("/remote-control"))).resolves.toEqual({
        outcome: "injected",
      });

      expect(push).toHaveBeenCalledOnce();
      expect(push.mock.calls[0][0].message.content).toEqual([
        { type: "text", text: "/remote-control" },
      ]);
      expect(enableRemoteControl).not.toHaveBeenCalled();
    });

    it("refuses the command when Claude Code lists it as terminal-only", async () => {
      const enableRemoteControl = vi.fn();
      const { agent, push } = createSteeringAgent(
        { enableRemoteControl, supportedCommands: async () => [cliCommand] },
        { terminalSlashCommands: ["remote-control"] },
      );

      await expect(agent.steer(prompt("/remote-control"))).rejects.toThrow(
        /while Claude is working/,
      );

      expect(push).not.toHaveBeenCalled();
      expect(enableRemoteControl).not.toHaveBeenCalled();
    });

    it("leaves the command to Claude Code when the SDK lacks Remote Control", async () => {
      const supportedCommands = vi.fn(async () => []);
      const { agent, push } = createSteeringAgent({ supportedCommands });

      await expect(agent.steer(prompt("/remote-control"))).resolves.toEqual({
        outcome: "injected",
      });

      expect(push).toHaveBeenCalledOnce();
      expect(supportedCommands).not.toHaveBeenCalled();
    });

    it.each(["hello", "/rc", "/remote-controller"])(
      "injects %s without checking supported commands",
      async (text) => {
        const supportedCommands = vi.fn();
        const enableRemoteControl = vi.fn();
        const { agent, push } = createSteeringAgent({ supportedCommands, enableRemoteControl });

        await expect(agent.steer(prompt(text))).resolves.toEqual({ outcome: "injected" });

        expect(push).toHaveBeenCalledOnce();
        expect(supportedCommands).not.toHaveBeenCalled();
        expect(enableRemoteControl).not.toHaveBeenCalled();
      },
    );

    it("does not treat a command in a multi-block prompt as an adapter command", async () => {
      const supportedCommands = vi.fn();
      const enableRemoteControl = vi.fn();
      const { agent, push } = createSteeringAgent({ supportedCommands, enableRemoteControl });

      await expect(
        agent.steer({
          sessionId: "session-1",
          prompt: [
            { type: "text", text: "/remote-control" },
            { type: "text", text: "another block" },
          ],
        }),
      ).resolves.toEqual({ outcome: "injected" });

      expect(push).toHaveBeenCalledOnce();
      expect(supportedCommands).not.toHaveBeenCalled();
      expect(enableRemoteControl).not.toHaveBeenCalled();
    });

    it.each([{ turnQueue: [] }, { turnQueue: [{ settled: true }] }])(
      "leaves an opted-in idle prompt untouched with queue %j",
      async ({ turnQueue }) => {
        const supportedCommands = vi.fn(() => new Promise<never>(() => {}));
        const enableRemoteControl = vi.fn();
        const { agent, push } = createSteeringAgent(
          { supportedCommands, enableRemoteControl },
          { turnQueue },
        );
        const detachedPrompt = vi.spyOn(agent, "prompt");

        await expect(
          agent.steer({
            ...prompt("/remote-control"),
            _meta: { steering: { idleBehavior: "promptRequired" } },
          }),
        ).resolves.toEqual({ outcome: "promptRequired", reason: "noRunningTurn" });

        expect(supportedCommands).not.toHaveBeenCalled();
        expect(detachedPrompt).not.toHaveBeenCalled();
        expect(push).not.toHaveBeenCalled();
        expect(enableRemoteControl).not.toHaveBeenCalled();
        expect(agent.sessions["session-1"].turnQueue).toBe(turnQueue);
      },
    );

    it("runs an idle command through the existing detached prompt by default", async () => {
      const enableRemoteControl = vi.fn(async () => ({ session_url: "https://claude.ai/code/s" }));
      const supportedCommands = vi.fn(async () => []);
      const { agent, push } = createSteeringAgent(
        { enableRemoteControl, supportedCommands },
        { turnQueue: [] },
      );
      const detachedPrompt = vi.spyOn(agent, "prompt");
      const request = prompt("/remote-control off");

      await expect(agent.steer(request)).resolves.toEqual({ outcome: "startedNewTurn" });
      expect(detachedPrompt).toHaveBeenCalledExactlyOnceWith(request);
      await detachedPrompt.mock.results[0].value;

      expect(enableRemoteControl).toHaveBeenCalledExactlyOnceWith(false);
      expect(supportedCommands).toHaveBeenCalledOnce();
      expect(push).not.toHaveBeenCalled();
    });

    describe("while checking command ownership", () => {
      function pendingCommands() {
        const commands = Promise.withResolvers<(typeof cliCommand)[]>();
        const supportedCommands = vi.fn(() => commands.promise);
        const enableRemoteControl = vi.fn(async () => ({
          session_url: "https://claude.ai/code/s",
        }));
        return {
          ...createSteeringAgent({ supportedCommands, enableRemoteControl }),
          supportedCommands,
          enableRemoteControl,
          finish: commands.resolve,
        };
      }

      it.each([{ commands: [] }, { commands: [cliCommand] }])(
        "returns promptRequired if the turn ends before discovery returns %j",
        async ({ commands }) => {
          const { agent, push, turn, supportedCommands, enableRemoteControl, finish } =
            pendingCommands();
          const detachedPrompt = vi.spyOn(agent, "prompt");
          const steering = agent.steer({
            ...prompt("/remote-control"),
            _meta: { steering: { idleBehavior: "promptRequired" } },
          });
          expect(supportedCommands).toHaveBeenCalledOnce();

          turn.settled = true;
          finish(commands);

          await expect(steering).resolves.toEqual({
            outcome: "promptRequired",
            reason: "noRunningTurn",
          });
          expect(detachedPrompt).not.toHaveBeenCalled();
          expect(push).not.toHaveBeenCalled();
          expect(enableRemoteControl).not.toHaveBeenCalled();
          expect(turn).not.toHaveProperty("steeredUuids");
        },
      );

      it("uses the default idle prompt if the original turn ends during discovery", async () => {
        const { agent, push, turn, enableRemoteControl, supportedCommands, finish } =
          pendingCommands();
        const detachedPrompt = vi.spyOn(agent, "prompt");
        const request = prompt("/remote-control");
        const steering = agent.steer(request);
        expect(supportedCommands).toHaveBeenCalledOnce();

        turn.settled = true;
        finish([]);

        await expect(steering).resolves.toEqual({ outcome: "startedNewTurn" });
        expect(detachedPrompt).toHaveBeenCalledExactlyOnceWith(request);
        await detachedPrompt.mock.results[0].value;
        expect(enableRemoteControl).toHaveBeenCalledExactlyOnceWith(true, undefined);
        expect(push).not.toHaveBeenCalled();
        expect(turn).not.toHaveProperty("steeredUuids");
      });

      it("injects a CLI command into the replacement turn instead of the settled one", async () => {
        const { agent, push, turn, enableRemoteControl, supportedCommands, finish } =
          pendingCommands();
        const steering = agent.steer(prompt("/remote-control"));
        expect(supportedCommands).toHaveBeenCalledOnce();

        turn.settled = true;
        const replacement = { settled: false };
        agent.sessions["session-1"].turnQueue = [replacement as any];
        finish([cliCommand]);

        await expect(steering).resolves.toEqual({ outcome: "injected" });
        expect(push).toHaveBeenCalledOnce();
        expect(replacement).toMatchObject({
          steeredUuids: new Set([push.mock.calls[0][0].uuid]),
        });
        expect(turn).not.toHaveProperty("steeredUuids");
        expect(enableRemoteControl).not.toHaveBeenCalled();
      });

      it("refuses the adapter command if another turn starts during discovery", async () => {
        const { agent, push, turn, enableRemoteControl, supportedCommands, finish } =
          pendingCommands();
        const steering = agent.steer(prompt("/remote-control"));
        expect(supportedCommands).toHaveBeenCalledOnce();

        turn.settled = true;
        const replacement = { settled: false };
        agent.sessions["session-1"].turnQueue = [replacement as any];
        finish([]);

        await expect(steering).rejects.toThrow(/while Claude is working/);
        expect(push).not.toHaveBeenCalled();
        expect(enableRemoteControl).not.toHaveBeenCalled();
        expect(turn).not.toHaveProperty("steeredUuids");
        expect(replacement).not.toHaveProperty("steeredUuids");
      });

      it.each(["closed", "replaced"])(
        "does not inject into a session that was %s during discovery",
        async (state) => {
          const { agent, push, supportedCommands, enableRemoteControl, finish } = pendingCommands();
          const steering = agent.steer(prompt("/remote-control"));
          expect(supportedCommands).toHaveBeenCalledOnce();

          if (state === "closed") agent.sessions["session-1"].queryClosed = true;
          else agent.sessions["session-1"] = mockSessionState();
          finish([cliCommand]);

          await expect(steering).rejects.toBeInstanceOf(RequestError);
          expect(push).not.toHaveBeenCalled();
          expect(enableRemoteControl).not.toHaveBeenCalled();
        },
      );

      it("does not inject a CLI command while the session is closing", async () => {
        const commands = Promise.withResolvers<(typeof cliCommand)[]>();
        const interrupted = Promise.withResolvers<void>();
        const supportedCommands = vi.fn(() => commands.promise);
        const interruptCompaction = vi.fn(() => interrupted.promise);
        const push = vi.fn();
        const { agent } = createAgent(
          { supportedCommands, enableRemoteControl: vi.fn(), interrupt: vi.fn(), close: vi.fn() },
          {
            input: { push, end: vi.fn() },
            turnQueue: [{ settled: false, promptUuid: "turn-1", resolve: vi.fn() }],
            contextCompaction: { interrupt: interruptCompaction },
          },
        );
        const session = agent.sessions["session-1"];
        const steering = agent.steer(prompt("/remote-control"));
        expect(supportedCommands).toHaveBeenCalledOnce();

        const closing = agent.closeSession({ sessionId: "session-1" });
        try {
          expect(interruptCompaction).toHaveBeenCalledOnce();
          expect(agent.sessions["session-1"]).toBe(session);
          expect(session.tornDown).toBe(true);
          expect(session.queryClosed).not.toBe(true);
          commands.resolve([cliCommand]);

          await expect(steering).rejects.toBeInstanceOf(RequestError);
          expect(push).not.toHaveBeenCalled();
        } finally {
          interrupted.resolve();
          await closing;
        }
      });
    });

    it("reports command discovery failures without injecting the command", async () => {
      const failure = new Error("Command discovery failed");
      const supportedCommands = vi.fn(async () => {
        throw failure;
      });
      const enableRemoteControl = vi.fn();
      const { agent, push } = createSteeringAgent({ supportedCommands, enableRemoteControl });

      await expect(agent.steer(prompt("/remote-control"))).rejects.toBe(failure);

      expect(push).not.toHaveBeenCalled();
      expect(enableRemoteControl).not.toHaveBeenCalled();
    });
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

    function createPendingAgent() {
      const request = pendingRequest();
      const push = vi.fn();
      const created = createAgent(
        { enableRemoteControl: request.enableRemoteControl },
        { input: { push } },
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
