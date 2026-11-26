import { describe, it, expect, vi, beforeEach } from "vitest";
import { ClaudeAcpAgent } from "../../v1/acp-agent.js";
import type { AcpClient } from "../../acp-client.js";
import type { PluginCommandDeps, PluginCommandResult } from "../../plugin-command.js";
import { mockSessionState } from "./session-doubles.js";

const runner = vi.hoisted(() => ({ run: vi.fn() }));

vi.mock("../../plugin-command.js", async () => ({
  ...(await vi.importActual<typeof import("../../plugin-command.js")>("../../plugin-command.js")),
  runPluginCommand: runner.run,
}));

/** A stream that stays open, like the real one: a consumer that reaches its end
 *  closes the session. */
async function* openStream(): AsyncGenerator<never> {
  await new Promise<never>(() => {});
  yield* [];
}

const reply = (message: string): PluginCommandResult => ({
  ok: false,
  operation: "install",
  message,
});

function createAgent(
  query: Record<string, unknown> = {},
  sessionOverrides: Record<string, any> = {},
) {
  const sessionUpdate = vi.fn(async () => {});
  const client = { sessionUpdate } as unknown as AcpClient;
  const agent = new ClaudeAcpAgent(client, { log: () => {}, error: () => {} });
  const push = vi.fn();
  agent.sessions["session-1"] = mockSessionState({
    query: Object.assign(openStream(), { supportedCommands: async () => [] }, query),
    input: { push },
    ...sessionOverrides,
  });
  return { agent, sessionUpdate, push };
}

const prompt = (text: string) => ({
  sessionId: "session-1",
  prompt: [{ type: "text" as const, text }],
});

const events = { inserted() {}, ended() {}, failed() {} };

/** A runner call that stays open until `finish`, and records its signal. */
function pendingRun() {
  let finish!: (result: PluginCommandResult) => void;
  let signal!: AbortSignal;
  runner.run.mockImplementation(
    (_command: unknown, deps: PluginCommandDeps) =>
      new Promise<PluginCommandResult>((resolve) => {
        finish = resolve;
        signal = deps.signal!;
      }),
  );
  return { finish: (result: PluginCommandResult) => finish(result), signal: () => signal };
}

const messages = (sessionUpdate: ReturnType<typeof createAgent>["sessionUpdate"]) =>
  (sessionUpdate.mock.calls as any[][]).map(([notification]) => notification.update);

/** A `supportedCommands` that stays open until `settle`. */
function pendingDecision(offered: { name: string }[] = []) {
  let settle!: () => void;
  const gate = new Promise<void>((resolve) => (settle = resolve));
  return { supportedCommands: async () => (await gate, offered), settle };
}

const steerFailures = (logged: { mock: { calls: unknown[][] } }) =>
  logged.mock.calls.filter(([message]) => String(message).includes("steered new turn failed"));

beforeEach(() => {
  runner.run.mockReset();
  runner.run.mockResolvedValue(reply("INSTALLED"));
});

describe("/plugin", () => {
  it("runs the command itself and replies as an agent message", async () => {
    const { agent, sessionUpdate, push } = createAgent();

    const response = await agent.prompt(prompt("/plugin list"));

    expect(response.stopReason).toBe("end_turn");
    expect(push).not.toHaveBeenCalled();
    expect(runner.run).toHaveBeenCalledOnce();
    expect(runner.run.mock.calls[0][0]).toMatchObject({ operation: "list" });
    const [update] = messages(sessionUpdate);
    expect(update.sessionUpdate).toBe("agent_message_chunk");
    expect(update.content.text).toContain("INSTALLED");
  });

  it("refuses the command while Claude is working", async () => {
    const { agent, sessionUpdate } = createAgent({}, { turnQueue: [{ settled: false }] });

    await expect(agent.prompt(prompt("/plugin list"))).rejects.toThrow(
      "/plugin can't run while Claude is working. Try again when the turn ends.",
    );

    expect(runner.run).not.toHaveBeenCalled();
    expect(sessionUpdate).not.toHaveBeenCalled();
  });

  it.each([
    ["Claude Code offers it", [{ name: "plugin", description: "", argumentHint: "" }], {}],
    ["the session is remote", [], { creationParams: remoteParams() }],
  ])("forwards the command to Claude Code when %s", async (_name, advertised, overrides) => {
    const { agent, push } = createAgent({ supportedCommands: async () => advertised }, overrides);

    await agent.startTurn(prompt("/plugin list"), events);

    expect(runner.run).not.toHaveBeenCalled();
    expect(push).toHaveBeenCalledOnce();
  });

  describe("while the command runs", () => {
    it("refuses a second command and holds a following prompt until the reply is sent", async () => {
      const run = pendingRun();
      const { agent, sessionUpdate, push } = createAgent();

      const command = agent.startTurn(prompt("/plugin install a@b"), events);
      await vi.waitFor(() => expect(runner.run).toHaveBeenCalled());
      await expect(agent.startTurn(prompt("/plugin list"), events)).rejects.toThrow(
        "Another command is still running. Try again in a moment.",
      );
      const following = agent.startTurn(prompt("hello"), events);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(push).not.toHaveBeenCalled();

      run.finish(reply("INSTALLED"));
      await Promise.all([command, following]);

      expect(runner.run).toHaveBeenCalledOnce();
      expect(push).toHaveBeenCalledOnce();
      expect(sessionUpdate.mock.invocationCallOrder[0]).toBeLessThan(
        push.mock.invocationCallOrder[0],
      );
    });

    it("aborts on session/cancel, sends no reply and ends the prompt cancelled", async () => {
      const run = pendingRun();
      const { agent, sessionUpdate } = createAgent({ interrupt: vi.fn(async () => {}) });

      const command = agent.prompt(prompt("/plugin install a@b"));
      await vi.waitFor(() => expect(runner.run).toHaveBeenCalled());
      await agent.cancel({ sessionId: "session-1" });
      expect(run.signal().aborted).toBe(true);
      run.finish(reply("INSTALLED"));

      expect((await command).stopReason).toBe("cancelled");
      expect(sessionUpdate).not.toHaveBeenCalled();
      expect(agent.sessions["session-1"].adapterCommands?.busy).toBeFalsy();
    });
  });

  describe("close while the command runs", () => {
    it("ends the prompt cancelled before the close response", async () => {
      // The child exits a macrotask after its signal aborts.
      runner.run.mockImplementation(
        (_command: unknown, deps: PluginCommandDeps) =>
          new Promise<PluginCommandResult>((resolve) => {
            deps.signal!.addEventListener("abort", () =>
              setTimeout(() => resolve(reply("INSTALLED")), 20),
            );
          }),
      );
      const { agent } = createAgent(
        { interrupt: vi.fn(async () => {}), close: vi.fn() },
        { input: { push: vi.fn(), end: vi.fn() } },
      );
      const order: string[] = [];

      const command = agent.prompt(prompt("/plugin install x")).then((response) => {
        order.push(`prompt:${response.stopReason}`);
      });
      await vi.waitFor(() => expect(runner.run).toHaveBeenCalled());
      await agent.closeSession({ sessionId: "session-1" }).then(() => order.push("close"));
      await command;

      expect(order).toEqual(["prompt:cancelled", "close"]);
    });
  });

  describe("cancel or close before the command starts", () => {
    /** `supportedCommands()` is the dispatch decision; `settle` releases it. */
    it("ends the prompt cancelled without running the command after session/cancel", async () => {
      const decision = pendingDecision();
      const { agent, sessionUpdate } = createAgent({
        supportedCommands: decision.supportedCommands,
        interrupt: vi.fn(async () => {}),
      });

      const command = agent.prompt(prompt("/plugin install a@b"));
      await new Promise((resolve) => setTimeout(resolve, 10));
      await agent.cancel({ sessionId: "session-1" });
      decision.settle();

      expect((await command).stopReason).toBe("cancelled");
      expect(runner.run).not.toHaveBeenCalled();
      expect(
        messages(sessionUpdate).filter((u) => u.sessionUpdate === "agent_message_chunk"),
      ).toEqual([]);
    });

    it("rejects a steer cancelled during the lookup without running the command", async () => {
      const decision = pendingDecision();
      const push = vi.fn();
      const { agent } = createAgent(
        { supportedCommands: decision.supportedCommands, interrupt: vi.fn(async () => {}) },
        { input: { push } },
      );

      const steered = agent.steer(prompt("/plugin install a@b"));
      const outcome = expect(steered).rejects.toThrow(
        "The command was cancelled before it started.",
      );
      await new Promise((resolve) => setTimeout(resolve, 10));
      await agent.cancel({ sessionId: "session-1" });
      decision.settle();

      await outcome;
      expect(runner.run).not.toHaveBeenCalled();
      expect(push).not.toHaveBeenCalled();
    });

    it("rejects a steer of a command that Claude Code serves when the query closed during the lookup", async () => {
      const decision = pendingDecision([{ name: "plugin" }]);
      const { agent, push } = createAgent({ supportedCommands: decision.supportedCommands });

      const steered = agent.steer({
        ...prompt("/plugin list"),
        _meta: { steering: { idleBehavior: "promptRequired" } },
      });
      const outcome = expect(steered).rejects.toThrow("The Claude Agent session has ended");
      await new Promise((resolve) => setTimeout(resolve, 10));
      agent.sessions["session-1"].queryClosed = true;
      decision.settle();

      await outcome;
      expect(push).not.toHaveBeenCalled();
    });

    it("does not run the command after session/close", async () => {
      const decision = pendingDecision();
      const { agent, sessionUpdate } = createAgent(
        {
          supportedCommands: decision.supportedCommands,
          interrupt: vi.fn(async () => {}),
          close: vi.fn(),
        },
        { input: { push: vi.fn(), end: vi.fn() } },
      );

      const command = agent.prompt(prompt("/plugin install a@b"));
      await new Promise((resolve) => setTimeout(resolve, 10));
      await agent.closeSession({ sessionId: "session-1" });
      decision.settle();

      expect((await command).stopReason).toBe("cancelled");
      expect(runner.run).not.toHaveBeenCalled();
      expect(sessionUpdate).not.toHaveBeenCalled();
    });

    it("rejects a steer and injects nothing after session/close", async () => {
      const decision = pendingDecision();
      const push = vi.fn();
      const { agent } = createAgent(
        {
          supportedCommands: decision.supportedCommands,
          interrupt: vi.fn(async () => {}),
          close: vi.fn(),
        },
        { input: { push, end: vi.fn() } },
      );

      const steered = agent.steer(prompt("/plugin list"));
      const outcome = expect(steered).rejects.toThrow();
      await new Promise((resolve) => setTimeout(resolve, 10));
      await agent.closeSession({ sessionId: "session-1" });
      decision.settle();

      await outcome;
      expect(push).not.toHaveBeenCalled();
      expect(runner.run).not.toHaveBeenCalled();
    });
  });

  describe("steered while a turn runs", () => {
    it.each(["/plugin list", "/remote-control"])(
      "refuses %s instead of injecting it",
      async (command) => {
        const { agent, push } = createAgent(
          { enableRemoteControl: vi.fn(async () => ({})) },
          { turnQueue: [{ settled: false }] },
        );

        await expect(agent.steer(prompt(command))).rejects.toThrow(/while Claude is working/);

        expect(push).not.toHaveBeenCalled();
        expect(runner.run).not.toHaveBeenCalled();
      },
    );
  });

  describe("steered while no turn runs", () => {
    it("refuses /plugin while another command is in flight", async () => {
      const run = pendingRun();
      const { agent, push } = createAgent();

      const first = agent.startTurn(prompt("/plugin install a@b"), events);
      await vi.waitFor(() => expect(runner.run).toHaveBeenCalled());
      await expect(agent.steer(prompt("/plugin list"))).rejects.toThrow(
        "Another command is still running. Try again in a moment.",
      );
      run.finish(reply("INSTALLED"));
      await first;

      expect(runner.run).toHaveBeenCalledOnce();
      expect(push).not.toHaveBeenCalled();
    });

    it("starts the command in steer's own section and holds a following prompt behind it", async () => {
      const run = pendingRun();
      const { agent, sessionUpdate, push } = createAgent();
      const logged = vi.spyOn((agent as any).logger, "error");

      const steered = await agent.steer(prompt("/plugin list"));
      expect(steered).toEqual({ outcome: "startedNewTurn" });
      expect(runner.run).toHaveBeenCalledOnce();
      const following = agent.startTurn(prompt("hello"), events);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(push).not.toHaveBeenCalled();

      run.finish(reply("INSTALLED"));
      await following;

      expect(runner.run).toHaveBeenCalledOnce();
      expect(messages(sessionUpdate)[0].content.text).toContain("INSTALLED");
      expect(sessionUpdate.mock.invocationCallOrder[0]).toBeLessThan(
        push.mock.invocationCallOrder[0],
      );
      expect(steerFailures(logged)).toEqual([]);
    });

    it("runs the command it reported as started when a turn is enqueued right after", async () => {
      const run = pendingRun();
      let asked = 0;
      const { agent, sessionUpdate, push } = createAgent({
        // Only a second ask, as a detached `prompt()` made, lets the turn in first.
        supportedCommands: async () => {
          if (asked++ > 0) await new Promise((resolve) => setTimeout(resolve, 20));
          return [];
        },
      });
      const logged = vi.spyOn((agent as any).logger, "error");

      expect(await agent.steer(prompt("/plugin list"))).toEqual({ outcome: "startedNewTurn" });
      (agent.sessions["session-1"] as any).turnQueue = [{ settled: false }];
      await new Promise((resolve) => setTimeout(resolve, 40));
      run.finish(reply("INSTALLED"));
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(runner.run).toHaveBeenCalledOnce();
      expect(messages(sessionUpdate)[0].content.text).toContain("INSTALLED");
      expect(push).not.toHaveBeenCalled();
      expect(steerFailures(logged)).toEqual([]);
    });

    it("rejects with the busy message when a turn is enqueued during the command lookup", async () => {
      const decision = pendingDecision();
      const { agent, push } = createAgent({ supportedCommands: decision.supportedCommands });
      const logged = vi.spyOn((agent as any).logger, "error");

      const steered = agent.steer(prompt("/plugin list"));
      const outcome = expect(steered).rejects.toThrow(
        "/plugin can't run while Claude is working. Try again when the turn ends.",
      );
      await new Promise((resolve) => setTimeout(resolve, 10));
      (agent.sessions["session-1"] as any).turnQueue = [{ settled: false }];
      decision.settle();

      await outcome;
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(runner.run).not.toHaveBeenCalled();
      expect(push).not.toHaveBeenCalled();
      expect(steerFailures(logged)).toEqual([]);
    });

    it("rejects instead of reporting a start when the session is being torn down", async () => {
      const { agent, push } = createAgent({}, { tornDown: true });

      await expect(agent.steer(prompt("/plugin list"))).rejects.toThrow(
        "The Claude Agent session has ended. Please start a new session.",
      );

      expect(runner.run).not.toHaveBeenCalled();
      expect(push).not.toHaveBeenCalled();
    });

    it("refuses /plugin during foreground work that no turn owns", async () => {
      const { agent, push } = createAgent();
      (agent as any).foregroundWork.set("session-1", {});

      await expect(agent.steer(prompt("/plugin list"))).rejects.toThrow(
        "/plugin can't run while Claude is working.",
      );

      expect(runner.run).not.toHaveBeenCalled();
      expect(push).not.toHaveBeenCalled();
    });
  });
});

function remoteParams() {
  return {
    cwd: "/test",
    mcpServers: [],
    _meta: { claudeCode: { options: { extraArgs: { "sdk-url": "wss://example.test" } } } },
  };
}
