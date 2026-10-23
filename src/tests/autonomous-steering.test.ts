import { afterEach, describe, expect, it, vi } from "vitest";
import { ClaudeAcpAgent, type AcpClient, type SteerRequest } from "../acp-agent.js";
import { Pushable } from "../utils.js";
import {
  mockSessionState,
  successfulResultMessage,
  userEcho,
  wrapQuery,
} from "./session-doubles.js";

vi.mock("@anthropic-ai/claude-agent-sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@anthropic-ai/claude-agent-sdk")>();
  return {
    ...actual,
    query: vi.fn(() => {
      throw new Error("Unexpected real SDK query");
    }),
  };
});

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

function state(state: "idle" | "running" | "requires_action") {
  return { type: "system", subtype: "session_state_changed", state };
}

function request(text = "also handle this"): SteerRequest {
  return {
    sessionId: "test-session",
    prompt: [{ type: "text", text }],
    _meta: { steering: { idleBehavior: "promptRequired" } },
  };
}

async function setup(onUpdate?: (notification: any) => void | Promise<void>, asyncTasks = false) {
  const updates: any[] = [];
  const foreground: string[] = [];
  const agent = new ClaudeAcpAgent(
    {
      sessionUpdate: async (notification: any) => {
        updates.push(notification);
        await onUpdate?.(notification);
      },
    } as AcpClient,
    { log() {}, error() {} },
    {
      foreground: () => ({
        running: () => foreground.push("running"),
        awaitingUser: () => foreground.push("awaitingUser"),
        ended: (outcome) => foreground.push(`ended ${outcome.stopReason}`),
        failed: () => foreground.push("failed"),
      }),
    },
  );
  if (asyncTasks) {
    agent.clientCapabilities = {
      _meta: { jetbrains: { air: { version: 1, capabilities: ["asyncTasks"] } } },
    };
  }
  const input = new Pushable<any>();
  const outgoing = input[Symbol.asyncIterator]();
  const frames = new Pushable<{ message: any; consumed: () => void } | { error: Error }>();
  async function* messages() {
    for await (const frame of frames) {
      if ("error" in frame) throw frame.error;
      yield frame.message;
      frame.consumed();
    }
  }
  const session = mockSessionState({ input, query: wrapQuery(messages()) });
  agent.sessions["test-session"] = session;
  const send = (message: any) =>
    new Promise<void>((consumed) => frames.push({ message, consumed }));
  const initial = agent.prompt(request("start"));
  const original = (await outgoing.next()).value;
  await send(userEcho(original));
  await send(successfulResultMessage({ user_message_uuid: original.uuid }));
  await initial;
  await send(state("idle"));
  const close = async () => {
    frames.end();
    await session.consumer;
  };
  const fail = async (error = new Error("Query stream failed")) => {
    frames.push({ error });
    await session.consumer;
  };
  cleanups.push(close);
  const prompt = vi.spyOn(agent, "prompt");
  const inputPush = vi.spyOn(input, "push");
  foreground.length = 0;
  return { agent, session, send, outgoing, prompt, inputPush, updates, close, fail, foreground };
}

describe("steering an autonomous cycle", () => {
  it("injects with priority now while no user prompt is in flight", async () => {
    const { agent, session, send, inputPush, prompt } = await setup();
    await send(state("running"));
    expect(session.turnQueue).toEqual([]);
    expect(session.activeTurn).toBeNull();
    await expect(agent.steer(request())).resolves.toEqual({ outcome: "injected" });
    expect(prompt).not.toHaveBeenCalled();
    expect(inputPush).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        type: "user",
        priority: "now",
        uuid: expect.any(String),
      }),
    );
    expect(session.turnQueue).toEqual([]);
    expect(session.activeTurn).toBeNull();
  });

  it("does not present an autonomous steer's human-origin echo as a remote message", async () => {
    const { agent, session, send, outgoing, updates } = await setup();
    await send(state("running"));
    await agent.steer(request());
    const steered = (await outgoing.next()).value;
    expect(session.sentUserUuids.has(steered.uuid)).toBe(true);
    await send({ ...userEcho(steered), origin: { kind: "human" } });
    expect(session.sentUserUuids.has(steered.uuid)).toBe(false);
    expect(updates.filter(({ update }) => update.sessionUpdate === "user_message_chunk")).toEqual(
      [],
    );
  });

  it.each([false, true])(
    "ends the async task at a steer-owned result (error: %s)",
    async (isError) => {
      const { agent, send, outgoing, updates } = await setup(undefined, true);
      await send(state("running"));
      const spawned = updates.find(
        ({ update }) => update.sessionUpdate === "async_task_spawned",
      )!.update;
      await agent.steer(request());
      const steered = (await outgoing.next()).value;
      await send(successfulResultMessage({ origin: { kind: "task-notification" }, num_turns: 0 }));
      expect(
        updates.filter(({ update }) => update.sessionUpdate === "async_task_state_update"),
      ).toEqual([]);
      await send(
        successfulResultMessage({
          origin: { kind: "human" },
          user_message_uuid: steered.uuid,
          is_error: isError,
          result: isError ? "Steered request failed" : "",
        }),
      );
      expect(
        updates
          .filter(({ update }) => update.sessionUpdate === "async_task_state_update")
          .map(({ update }) => update),
      ).toEqual([
        {
          sessionUpdate: "async_task_state_update",
          asyncTaskId: spawned.asyncTaskId,
          state: isError ? "failed" : "completed",
        },
      ]);
    },
  );

  it("closes autonomous steering before awaiting an async-task stop", async () => {
    const { agent, session, send, outgoing, updates } = await setup(undefined, true);
    session.requestMarkerListsV1 = true;
    await send(state("running"));
    const task = updates.find(
      ({ update }) => update.sessionUpdate === "async_task_spawned",
    )!.update;
    await agent.steer(request());
    const steered = (await outgoing.next()).value;
    let release = () => {};
    const interrupted = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.mocked(session.query.interrupt).mockImplementationOnce(() => interrupted);
    const stop = agent.stopAsyncTask({ sessionId: "test-session", asyncTaskId: task.asyncTaskId });
    try {
      await send({
        type: "system",
        subtype: "status",
        status: "requesting",
        user_message_uuids: [steered.uuid],
      });
      await send(state("running"));
      await expect(agent.steer(request())).resolves.toEqual({
        outcome: "promptRequired",
        reason: "noRunningTurn",
      });
    } finally {
      release();
    }
    await expect(stop).resolves.toEqual({ stopped: true });
    const transcriptBeforeResult = updates.filter(
      ({ update }) => update.sessionUpdate === "agent_message_chunk",
    );
    await send(
      successfulResultMessage({
        origin: { kind: "human" },
        user_message_uuid: steered.uuid,
        is_error: true,
        result: "Expected interrupted steer failure",
      }),
    );
    expect(updates.filter(({ update }) => update.sessionUpdate === "agent_message_chunk")).toEqual(
      transcriptBeforeResult,
    );
    expect(session.lastTurnFailed).not.toBe(true);
    expect(session.query.stopTask).not.toHaveBeenCalled();
    await send({ type: "system", subtype: "status", status: "requesting", user_message_uuids: [] });
    await expect(agent.steer(request())).resolves.toEqual({ outcome: "injected" });
    expect(
      updates
        .filter(({ update }) => update.sessionUpdate === "async_task_state_update")
        .map(({ update }) => update.state),
    ).toEqual(["stopped"]);
  });

  it("recovers steering on fresh work after an async-task interrupt rejects", async () => {
    const { agent, session, send, outgoing, updates } = await setup(undefined, true);
    session.requestMarkerListsV1 = true;
    await send(state("running"));
    const task = updates.find(
      ({ update }) => update.sessionUpdate === "async_task_spawned",
    )!.update;
    await agent.steer(request());
    const steered = (await outgoing.next()).value;
    vi.mocked(session.query.interrupt).mockRejectedValueOnce(
      new Error("Interrupt transport failed"),
    );
    await expect(
      agent.stopAsyncTask({ sessionId: "test-session", asyncTaskId: task.asyncTaskId }),
    ).rejects.toThrow("Interrupt transport failed");
    // A rejected interrupt has an uncertain outcome. Do not inject into its
    // old work; a fresh request that names no cancelled command reopens it.
    await send({
      type: "system",
      subtype: "status",
      status: "requesting",
      user_message_uuids: [steered.uuid],
    });
    await expect(agent.steer(request())).resolves.toEqual({
      outcome: "promptRequired",
      reason: "noRunningTurn",
    });
    await send(successfulResultMessage({ user_message_uuid: steered.uuid }));
    await send({ type: "system", subtype: "status", status: "requesting", user_message_uuids: [] });
    await expect(agent.steer(request())).resolves.toEqual({ outcome: "injected" });
  });

  it("leaves steering ownership untouched when an async-task stop refuses a queued prompt", async () => {
    const { agent, session, send, outgoing, updates } = await setup(undefined, true);
    await send(state("running"));
    const task = updates.find(
      ({ update }) => update.sessionUpdate === "async_task_spawned",
    )!.update;
    await agent.steer(request());
    const steered = (await outgoing.next()).value;
    const prompt = agent.prompt(request("next prompt"));
    const queued = (await outgoing.next()).value;
    await expect(
      agent.stopAsyncTask({ sessionId: "test-session", asyncTaskId: task.asyncTaskId }),
    ).resolves.toEqual({ stopped: false });
    expect(session.cancelled).toBe(false);
    expect(session.cancelledPrompts).toBeUndefined();
    expect(session.autonomousSteering.isRunning).toBe(true);
    expect(session.autonomousSteering.owns(steered.uuid)).toBe(true);
    expect(session.query.interrupt).not.toHaveBeenCalled();
    await send(userEcho(queued));
    await send(successfulResultMessage({ user_message_uuid: queued.uuid }));
    await prompt;
  });

  it.each([undefined, "promptRequired"] as const)(
    "keeps autonomous steering out of prompt() with idle behavior %s",
    async (idleBehavior) => {
      const { agent, session, send, prompt, inputPush } = await setup();
      await send(state("running"));
      const steer = request();
      steer._meta = idleBehavior ? { steering: { idleBehavior } } : undefined;
      await expect(agent.steer(steer)).resolves.toEqual({ outcome: "injected" });
      await expect(agent.steer(steer)).resolves.toEqual({ outcome: "injected" });
      expect(prompt).not.toHaveBeenCalled();
      expect(session.turnQueue).toEqual([]);
      expect(new Set(inputPush.mock.calls.map(([message]) => message.uuid)).size).toBe(2);
    },
  );

  it("uses later while an autonomous cycle awaits user input", async () => {
    const { agent, session, send, inputPush } = await setup();
    await send(state("running"));
    session.openUserInputs = new Set([{}]);
    await send(state("requires_action"));
    await expect(agent.steer(request())).resolves.toEqual({ outcome: "injected" });
    expect(inputPush.mock.calls[0][0].priority).toBe("later");
    expect(session.openUserInputs.size).toBe(1);
  });

  it.each(["idle", "result", "cancel", "abort", "no-consumer"])(
    "does not inject from stale running state after %s",
    async (boundary) => {
      const { agent, session, send, prompt, inputPush } = await setup();
      await send(state("running"));
      const consumer = session.consumer;
      if (boundary === "idle") await send(state("idle"));
      if (boundary === "result") {
        await send(successfulResultMessage({ origin: { kind: "task-notification" } }));
        expect(session.lastSessionState).toBe("running");
      }
      if (boundary === "cancel") await agent.cancel({ sessionId: "test-session" });
      if (boundary === "abort") session.abortController.abort();
      if (boundary === "no-consumer") session.consumer = undefined;
      try {
        await expect(agent.steer(request())).resolves.toEqual({
          outcome: "promptRequired",
          reason: "noRunningTurn",
        });
        expect(prompt).not.toHaveBeenCalled();
        expect(inputPush).not.toHaveBeenCalled();
      } finally {
        session.consumer = consumer;
      }
    },
  );

  it("preserves the detached prompt fallback after autonomous work goes idle", async () => {
    const { agent, send, prompt, inputPush } = await setup();
    await send(state("running"));
    await send(state("idle"));
    prompt.mockResolvedValue({ stopReason: "end_turn" });
    const steer = request();
    delete steer._meta;
    await expect(agent.steer(steer)).resolves.toEqual({ outcome: "startedNewTurn" });
    expect(prompt).toHaveBeenCalledExactlyOnceWith(steer);
    expect(inputPush).not.toHaveBeenCalled();
  });

  it.each([
    ["singular", false],
    ["plural", false],
    ["both", false],
    ["singular", true],
    ["plural", true],
    ["both", true],
  ] as const)(
    "keeps a %s-stamped steer result off the next prompt (echo: %s)",
    async (fields, echo) => {
      const { agent, session, send, outgoing } = await setup();
      await send(state("running"));
      await agent.steer(request());
      const steered = (await outgoing.next()).value;
      // Priority-now can abort the autonomous predecessor before the echo.
      await send(successfulResultMessage({ origin: { kind: "task-notification" } }));
      await send(state("idle"));
      if (echo) await send(userEcho(steered));
      const responses: unknown[] = [];
      const next = agent.prompt(request("next prompt")).then((response) => {
        responses.push(response);
        return response;
      });
      const nextMessage = (await outgoing.next()).value;
      // The steer's result can lag behind the next prompt's echo.
      await send(userEcho(nextMessage));
      await send(
        successfulResultMessage({
          origin: { kind: "human" },
          ...(fields !== "plural" ? { user_message_uuid: steered.uuid } : {}),
          ...(fields !== "singular" ? { user_message_uuids: [steered.uuid] } : {}),
          usage: {
            input_tokens: 900,
            output_tokens: 100,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
        }),
      );
      await send(state("idle"));
      expect(responses).toEqual([]);
      expect(session.turnQueue).toHaveLength(1);
      expect(session.activeTurn.promptUuid).toBe(nextMessage.uuid);
      await send(
        successfulResultMessage({
          user_message_uuid: nextMessage.uuid,
          usage: {
            input_tokens: 10,
            output_tokens: 5,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
        }),
      );
      await expect(next).resolves.toMatchObject({
        stopReason: "end_turn",
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      });
      await send(state("idle"));
      expect(session.turnQueue).toEqual([]);
      expect(session.activeTurn).toBeNull();
      expect(session.owedTrailingIdles).toBe(0);
    },
  );

  it("attributes a folded result naming a user prompt and the autonomous steer to the prompt", async () => {
    const { agent, send, outgoing, session } = await setup();
    await send(state("running"));
    await agent.steer(request());
    const steered = (await outgoing.next()).value;
    const next = agent.prompt(request("fold this in too"));
    const nextMessage = (await outgoing.next()).value;
    await send(
      successfulResultMessage({
        origin: { kind: "task-notification" },
        user_message_uuid: nextMessage.uuid,
        user_message_uuids: [steered.uuid, nextMessage.uuid],
        stop_reason: "max_tokens",
        usage: {
          input_tokens: 20,
          output_tokens: 7,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
      }),
    );
    await expect(next).resolves.toMatchObject({
      stopReason: "max_tokens",
      usage: { inputTokens: 20, outputTokens: 7 },
    });
    await send(state("idle"));
    expect(session.turnQueue).toEqual([]);
  });

  it("keeps a cancelled autonomous steer's late error off a replacement prompt", async () => {
    const { agent, session, send, outgoing } = await setup();
    const cancelAsyncMessage = vi.fn(async () => {});
    session.query.cancelAsyncMessage = cancelAsyncMessage;
    await send(state("running"));
    await agent.steer(request());
    const steered = (await outgoing.next()).value;
    await agent.cancel({ sessionId: "test-session" });
    expect(cancelAsyncMessage).toHaveBeenCalledExactlyOnceWith(steered.uuid);
    expect(session.query.interrupt).toHaveBeenCalledOnce();
    const responses: unknown[] = [];
    const next = agent.prompt(request("replacement")).then((response) => {
      responses.push(response);
      return response;
    });
    const nextMessage = (await outgoing.next()).value;
    await send(userEcho(nextMessage));
    await send(
      successfulResultMessage({
        subtype: "error_during_execution",
        is_error: true,
        errors: ["cancelled cycle failed"],
        user_message_uuid: steered.uuid,
        user_message_uuids: [steered.uuid],
      }),
    );
    await send(state("idle"));
    expect(responses).toEqual([]);
    await send(successfulResultMessage({ user_message_uuid: nextMessage.uuid }));
    await expect(next).resolves.toMatchObject({ stopReason: "end_turn" });
    await send(state("idle"));
    expect(session.turnQueue).toEqual([]);
  });

  it("protects a queued prompt from an unstamped steer result after the steer echo", async () => {
    const { agent, send, outgoing, session } = await setup();
    await send(state("running"));
    await agent.steer(request());
    const steered = (await outgoing.next()).value;
    await send(userEcho(steered));
    const responses: unknown[] = [];
    const next = agent.prompt(request("queued prompt")).then((response) => {
      responses.push(response);
      return response;
    });
    const nextMessage = (await outgoing.next()).value;
    await send(successfulResultMessage());
    await send(state("idle"));
    expect(responses).toEqual([]);
    expect(session.activeTurn).toBeNull();
    await send(userEcho(nextMessage));
    await send(successfulResultMessage({ user_message_uuid: nextMessage.uuid }));
    await expect(next).resolves.toMatchObject({ stopReason: "end_turn" });
  });

  it("does not consume an echo-less prompt's result after its command started", async () => {
    const { agent, send, outgoing } = await setup();
    await send(state("running"));
    await agent.steer(request());
    const steered = (await outgoing.next()).value;
    await send(userEcho(steered));
    const next = agent.prompt(request("/compact"));
    const nextMessage = (await outgoing.next()).value;
    await send({ type: "command_lifecycle", state: "started", command_uuid: nextMessage.uuid });
    await send(successfulResultMessage());
    await expect(next).resolves.toMatchObject({ stopReason: "end_turn" });
  });

  it("keeps ownership when a folded steer completes before its result", async () => {
    const { agent, send, outgoing, session } = await setup();
    await send(state("running"));
    await agent.steer(request());
    const steered = (await outgoing.next()).value;
    await send({ type: "command_lifecycle", state: "started", command_uuid: steered.uuid });
    await send({ type: "command_lifecycle", state: "completed", command_uuid: steered.uuid });
    await send(successfulResultMessage({ user_message_uuid: steered.uuid }));
    await send(state("idle"));
    expect(session.turnQueue).toEqual([]);
    expect(session.autonomousSteering.cancel()).toEqual([]);
  });

  it.each(["cancelled", "discarded", "refused"])(
    "retires a pending command reported %s",
    async (terminal) => {
      const { agent, send, outgoing, session } = await setup();
      await send(state("running"));
      await agent.steer(request());
      const steered = (await outgoing.next()).value;
      await send({ type: "command_lifecycle", state: terminal, command_uuid: steered.uuid });
      expect(session.autonomousSteering.cancel()).toEqual([]);
    },
  );

  it("can steer again after the interrupted cycle's result and the continuation's echo", async () => {
    const { agent, send, outgoing, prompt } = await setup();
    await send(state("running"));
    await agent.steer(request());
    const first = (await outgoing.next()).value;
    await send(successfulResultMessage({ origin: { kind: "task-notification" } }));
    await send(userEcho(first));
    await expect(agent.steer(request("one more thing"))).resolves.toEqual({ outcome: "injected" });
    expect(prompt).not.toHaveBeenCalled();
  });

  it("does not re-arm unstamped attribution from a late completion after prompt handoff", async () => {
    const { agent, send, outgoing } = await setup();
    await send(state("running"));
    await agent.steer(request());
    const steered = (await outgoing.next()).value;
    await send(userEcho(steered));
    const next = agent.prompt(request("/compact"));
    const nextMessage = (await outgoing.next()).value;
    await send({ type: "command_lifecycle", state: "started", command_uuid: nextMessage.uuid });
    await send({ type: "command_lifecycle", state: "completed", command_uuid: steered.uuid });
    await send(successfulResultMessage());
    await expect(next).resolves.toMatchObject({ stopReason: "end_turn" });
  });

  it.each([false, true])("rolls back a failed autonomous goal command (echo: %s)", async (echo) => {
    const { agent, send, outgoing, session } = await setup();
    const previous = { objective: "original goal", status: "active" };
    session.lastPublishedGoal = previous;
    await send(state("running"));
    await agent.steer(request("/goal replacement goal"));
    const steered = (await outgoing.next()).value;
    expect(session.lastPublishedGoal.objective).toBe("replacement goal");
    if (echo) await send(userEcho(steered));
    await send(
      successfulResultMessage({
        user_message_uuid: steered.uuid,
        is_error: true,
        result: "Goal command failed",
      }),
    );
    expect(session.pendingGoalUpdate).toBeUndefined();
    expect(session.lastPublishedGoal).toEqual(previous);
  });

  it("closes autonomous injection before awaiting result handling", async () => {
    const { agent, send, session } = await setup();
    await send(state("running"));
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    vi.spyOn(session.asyncTaskRuntime, "releaseHeld").mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
    });
    const result = send(successfulResultMessage({ origin: { kind: "task-notification" } }));
    await entered.promise;
    try {
      await expect(agent.steer(request())).resolves.toEqual({
        outcome: "promptRequired",
        reason: "noRunningTurn",
      });
    } finally {
      release.resolve();
      await result;
    }
  });

  it.each(["running", "requesting"])(
    "does not trust buffered %s frames after worker shutdown",
    async (frame) => {
      const { agent, session, send, prompt } = await setup();
      session.requestMarkerListsV1 = true;
      await send(state("running"));
      await send({ type: "system", subtype: "worker_shutting_down" });
      await send(
        frame === "running"
          ? state("running")
          : { type: "system", subtype: "status", status: "requesting", user_message_uuids: [] },
      );
      await expect(agent.steer(request())).resolves.toEqual({
        outcome: "promptRequired",
        reason: "noRunningTurn",
      });
      expect(prompt).not.toHaveBeenCalled();
    },
  );

  it("rejects after the consumer disconnects and releases command ownership", async () => {
    const { agent, send, session, close } = await setup();
    await send(state("running"));
    await agent.steer(request());
    await close();
    expect(session.queryClosed).toBe(true);
    expect(session.autonomousSteering.cancel()).toEqual([]);
    await expect(agent.steer(request())).rejects.toThrow();
  });

  it("delivers result-only steering output without suppressing the next prompt's answer", async () => {
    const { agent, send, outgoing, updates } = await setup();
    await send(state("running"));
    await agent.steer(request());
    const steered = (await outgoing.next()).value;
    const next = agent.prompt(request("next"));
    const nextMessage = (await outgoing.next()).value;
    await send(
      successfulResultMessage({ user_message_uuid: steered.uuid, result: "Steered answer" }),
    );
    await send(state("idle"));
    await send(userEcho(nextMessage));
    await send(
      successfulResultMessage({ user_message_uuid: nextMessage.uuid, result: "Next answer" }),
    );
    await next;
    expect(
      updates
        .filter(({ update }) => update.sessionUpdate === "agent_message_chunk")
        .map(({ update }) => update.content.text),
    ).toEqual(["Steered answer", "Next answer"]);
  });

  it("reports a result-only steer failure without ending a queued prompt", async () => {
    const { agent, send, outgoing, updates, session } = await setup();
    await send(state("running"));
    await agent.steer(request());
    const steered = (await outgoing.next()).value;
    const next = agent.prompt(request("next"));
    const nextMessage = (await outgoing.next()).value;
    await send(
      successfulResultMessage({
        user_message_uuid: steered.uuid,
        is_error: true,
        result: "Steer failed",
      }),
    );
    expect(updates.some(({ update }) => update.content?.text === "Steer failed")).toBe(true);
    expect(session.turnQueue).toHaveLength(1);
    await send(userEcho(nextMessage));
    await send(successfulResultMessage({ user_message_uuid: nextMessage.uuid }));
    await expect(next).resolves.toMatchObject({ stopReason: "end_turn" });
  });

  it("does not let an unrelated prompt result roll back an outstanding autonomous goal", async () => {
    const { agent, send, outgoing, session } = await setup();
    session.lastPublishedGoal = { objective: "original", status: "active" };
    await send(state("running"));
    await agent.steer(request("/goal replacement"));
    const steered = (await outgoing.next()).value;
    await send(userEcho(steered));
    const next = agent.prompt(request("next")).catch(() => undefined);
    const nextMessage = (await outgoing.next()).value;
    await send(userEcho(nextMessage));
    await send(
      successfulResultMessage({
        user_message_uuid: nextMessage.uuid,
        is_error: true,
        result: "Next failed",
      }),
    );
    await next;
    expect(session.pendingGoalUpdate.commandUuid).toBe(steered.uuid);
    expect(session.lastPublishedGoal.objective).toBe("replacement");
    await send(successfulResultMessage({ user_message_uuid: steered.uuid }));
    expect(session.pendingGoalUpdate).toBeUndefined();
  });

  it("does not roll back an autonomous goal for a newer prompt's unstamped error", async () => {
    const { agent, send, outgoing, session } = await setup();
    session.lastPublishedGoal = { objective: "original", status: "active" };
    await send(state("running"));
    await agent.steer(request("/goal replacement"));
    const steered = (await outgoing.next()).value;
    await send(userEcho(steered));
    const next = agent.prompt(request("next")).catch(() => undefined);
    const nextMessage = (await outgoing.next()).value;
    await send(userEcho(nextMessage));
    await send(successfulResultMessage({ is_error: true, result: "Next failed" }));
    await next;
    expect(session.pendingGoalUpdate?.commandUuid).toBe(steered.uuid);
    expect(session.lastPublishedGoal.objective).toBe("replacement");
    await send(successfulResultMessage({ user_message_uuid: steered.uuid }));
    expect(session.pendingGoalUpdate).toBeUndefined();
  });

  it("does not present an expected cancelled-steer error during the replacement prompt", async () => {
    const { agent, send, outgoing, updates } = await setup();
    await send(state("running"));
    await agent.steer(request());
    const steered = (await outgoing.next()).value;
    await agent.cancel({ sessionId: "test-session" });
    const next = agent.prompt(request("replacement"));
    const nextMessage = (await outgoing.next()).value;
    await send(userEcho(nextMessage));
    await send(
      successfulResultMessage({
        user_message_uuid: steered.uuid,
        is_error: true,
        result: "Expected interruption",
      }),
    );
    expect(updates.some(({ update }) => update.content?.text === "Expected interruption")).toBe(
      false,
    );
    await send(successfulResultMessage({ user_message_uuid: nextMessage.uuid }));
    await next;
  });

  it.each(["empty", "unrelated", "next"])(
    "uses the %s plural stamp instead of a conflicting singular steer UUID",
    async (plural) => {
      const { agent, send, outgoing, session } = await setup();
      await send(state("running"));
      await agent.steer(request());
      const steered = (await outgoing.next()).value;
      const next = agent.prompt(request("next"));
      const nextMessage = (await outgoing.next()).value;
      await send(userEcho(nextMessage));
      await send(
        successfulResultMessage({
          user_message_uuid: steered.uuid,
          user_message_uuids:
            plural === "empty" ? [] : [plural === "next" ? nextMessage.uuid : "unrelated"],
          stop_reason: "max_tokens",
        }),
      );
      await expect(next).resolves.toMatchObject({ stopReason: "max_tokens" });
      expect(session.autonomousSteering.cancel()).toContain(steered.uuid);
    },
  );

  it("reports an autonomous steer failure and cost to the session index", async () => {
    const { agent, send, outgoing, session } = await setup();
    const changed = vi.spyOn((agent as any).sessionIndex, "onOwnSessionChanged");
    await send(state("running"));
    await agent.steer(request());
    const steered = (await outgoing.next()).value;
    await send(
      successfulResultMessage({
        user_message_uuid: steered.uuid,
        is_error: true,
        result: "Steer failed",
        total_cost_usd: 2.5,
      }),
    );
    await send(state("idle"));
    expect(session.lastTurnFailed).toBe(true);
    expect(session.lastTotalCostUsd).toBe(2.5);
    expect(session.lastTurnEndedAt).toEqual(expect.any(Number));
    expect(changed).toHaveBeenCalledWith("test-session");
    await send(state("running"));
    expect(session.lastTurnFailed).toBe(false);
    await agent.steer(request("retry"));
    const retry = (await outgoing.next()).value;
    await send(successfulResultMessage({ user_message_uuid: retry.uuid, total_cost_usd: 3 }));
    expect(session.lastTurnFailed).toBe(false);
    expect(session.lastTotalCostUsd).toBe(3);
  });

  it.each([false, true])(
    "keeps the newer prompt's index outcome when a superseded steer reports error=%s",
    async (steerError) => {
      const { agent, send, outgoing, session } = await setup();
      await send(state("running"));
      await agent.steer(request());
      const steered = (await outgoing.next()).value;
      const next = agent.prompt(request("next")).catch(() => undefined);
      const nextMessage = (await outgoing.next()).value;
      await send(userEcho(nextMessage));
      await send(
        successfulResultMessage({
          user_message_uuid: nextMessage.uuid,
          is_error: !steerError,
          result: "Newer prompt outcome",
          total_cost_usd: 2,
        }),
      );
      await next;
      expect(session.lastTurnFailed).toBe(!steerError);
      await send(
        successfulResultMessage({
          user_message_uuid: steered.uuid,
          is_error: steerError,
          result: "Late steer outcome",
          total_cost_usd: 3,
        }),
      );
      expect(session.lastTurnFailed).toBe(!steerError);
      expect(session.lastTotalCostUsd).toBe(3);
    },
  );

  it("does not mark a refused autonomous steer as a provider error in the index", async () => {
    const { agent, send, outgoing, session } = await setup();
    await send(state("running"));
    await agent.steer(request());
    const steered = (await outgoing.next()).value;
    await send(
      successfulResultMessage({
        user_message_uuid: steered.uuid,
        is_error: true,
        stop_reason: "refusal",
        result: "Refused",
      }),
    );
    await send(state("idle"));
    expect(session.lastTurnFailed).toBe(false);
  });

  it("does not publish a stale consumer's steer result into a replacement session", async () => {
    const { agent, send, outgoing, session, updates } = await setup();
    session.lastPublishedGoal = { objective: "Old goal", status: "active" };
    await send(state("running"));
    await agent.steer(request("/goal Old replacement"));
    const steered = (await outgoing.next()).value;
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    vi.spyOn(session.asyncTaskRuntime, "releaseHeld").mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
    });
    const result = send(
      successfulResultMessage({
        user_message_uuid: steered.uuid,
        is_error: true,
        result: "Stale error",
      }),
    );
    await entered.promise;
    const replacementGoal = { objective: "Current goal", status: "active" };
    const replacement = mockSessionState({ lastPublishedGoal: replacementGoal });
    agent.sessions["test-session"] = replacement;
    release.resolve();
    await result;
    expect(replacement.lastPublishedGoal).toEqual(replacementGoal);
    expect(updates.some(({ update }) => update.content?.text === "Stale error")).toBe(false);
  });

  it("keeps foreground ownership with a prompt that takes over an autonomous steer", async () => {
    const { agent, send, outgoing, foreground } = await setup();
    await send(state("running"));
    await send({
      type: "stream_event",
      parent_tool_use_id: null,
      uuid: "autonomous-output",
      session_id: "test-session",
      event: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "Autonomous work" },
      },
    });
    await agent.steer(request());
    const steered = (await outgoing.next()).value;
    await send(userEcho(steered));
    const next = agent.prompt(request("next"));
    const nextMessage = (await outgoing.next()).value;
    await send(userEcho(nextMessage));
    expect(foreground).toEqual(["running"]);
    await send(successfulResultMessage({ user_message_uuid: steered.uuid }));
    await send(state("idle"));
    expect(foreground).toEqual(["running"]);
    await send(successfulResultMessage({ user_message_uuid: nextMessage.uuid }));
    await next;
    expect(foreground).toEqual(["running", "ended end_turn"]);
  });

  it("does not end replacement foreground work at a stale steer result or old consumer EOF", async () => {
    const { agent, send, outgoing, session, foreground, close } = await setup();
    await send(state("running"));
    await agent.steer(request());
    const steered = (await outgoing.next()).value;
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    vi.spyOn(session.asyncTaskRuntime, "releaseHeld").mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
    });
    const result = send(successfulResultMessage({ user_message_uuid: steered.uuid }));
    await entered.promise;
    const replacement = mockSessionState();
    agent.sessions["test-session"] = replacement;
    // The replacement consumer's first main-conversation output starts its cycle.
    (agent as any).startAutonomousCycle("test-session", replacement, {
      type: "stream_event",
      parent_tool_use_id: null,
    });
    release.resolve();
    await result;
    expect(foreground).toEqual(["running"]);
    await close();
    expect(foreground).toEqual(["running"]);
    (agent as any).endAutonomousCycle("test-session", { outcome: { stopReason: "end_turn" } });
    expect(foreground).toEqual(["running", "ended end_turn"]);
  });

  it.each([false, true])(
    "ends an autonomous cycle after stream death with cancelled=%s",
    async (cancelled) => {
      const { agent, session, send, fail, foreground } = await setup();
      await send(state("running"));
      (agent as any).startAutonomousCycle("test-session", session, {
        type: "stream_event",
        parent_tool_use_id: null,
      });
      // Hold cancel before it ends the cycle, so the stream error owns settlement.
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      let cancel: Promise<void> | undefined;
      if (cancelled) {
        vi.spyOn(session.contextCompaction, "interrupt").mockImplementationOnce(async () => {
          entered.resolve();
          await release.promise;
        });
        cancel = agent.cancel({ sessionId: "test-session" });
        await entered.promise;
      }
      try {
        await fail();
        expect(session.queryClosed).toBe(true);
        expect(foreground).toEqual(["running", cancelled ? "ended cancelled" : "failed"]);
      } finally {
        release.resolve();
        await cancel;
      }
      expect(foreground).toEqual(["running", cancelled ? "ended cancelled" : "failed"]);
    },
  );

  it("preserves the cancelled active turn when stream-death settlement fails", async () => {
    const { agent, session, send, outgoing, fail } = await setup();
    const active = agent.prompt(request("active"));
    const activeMessage = (await outgoing.next()).value;
    await send(userEcho(activeMessage));
    await agent.cancel({ sessionId: "test-session" });
    // This prompt arrived after cancel's queue sweep and was never cancelled.
    const queued = agent.prompt(request("after cancel"));
    await outgoing.next();
    const queuedFailure = expect(queued).rejects.toThrow("Query stream failed");
    session.fileChangeReporter = {
      finish: vi.fn().mockImplementationOnce(() => {
        throw new Error("Checkpoint finalization failed");
      }),
    };
    await fail();
    await queuedFailure;
    await expect(active).resolves.toMatchObject({ stopReason: "cancelled" });
    expect(session.fileChangeReporter.finish).toHaveBeenCalledTimes(3);
    expect(session.activeTurn).toBeNull();
    expect(session.turnQueue).toEqual([]);
  });

  it.each([false, true])(
    "does not end replacement foreground work when a stale consumer fails (cancelled=%s)",
    async (cancelled) => {
      const { agent, session, fail, foreground } = await setup();
      session.cancelled = cancelled;
      const replacement = mockSessionState();
      agent.sessions["test-session"] = replacement;
      (agent as any).startAutonomousCycle("test-session", replacement, {
        type: "stream_event",
        parent_tool_use_id: null,
      });
      await fail();
      expect(session.queryClosed).toBe(true);
      expect(agent.sessions["test-session"]).toBe(replacement);
      expect(foreground).toEqual(["running"]);
      (agent as any).endAutonomousCycle("test-session", { outcome: { stopReason: "end_turn" } });
      expect(foreground).toEqual(["running", "ended end_turn"]);
    },
  );

  it.each(["idle", "result"])(
    "keeps replacement foreground work running when %s tool cleanup yields",
    async (boundary) => {
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const { agent, session, send, outgoing, foreground } = await setup(async ({ update }) => {
        if (update.sessionUpdate === "tool_call_update" && update.toolCallId === "unfinished") {
          entered.resolve();
          await release.promise;
        }
      });
      await send(state("running"));
      await agent.steer(request());
      const steered = (await outgoing.next()).value;
      await send({
        type: "stream_event",
        parent_tool_use_id: null,
        uuid: "autonomous-output",
        session_id: "test-session",
        event: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "Autonomous work" },
        },
      });
      // A streamed tool that never ran must close before the cycle ends.
      session.emittedToolCalls.add("unfinished");
      const ending = send(
        boundary === "idle"
          ? state("idle")
          : successfulResultMessage({ user_message_uuid: steered.uuid }),
      );
      await entered.promise;
      expect(foreground).toEqual(["running"]);
      expect(session.emittedToolCalls.has("unfinished")).toBe(false);
      // Teardown replaces the query while its last tool report is in flight.
      (agent as any).endAutonomousCycle("test-session", { outcome: { stopReason: "cancelled" } });
      const replacement = mockSessionState();
      agent.sessions["test-session"] = replacement;
      (agent as any).startAutonomousCycle("test-session", replacement, {
        type: "stream_event",
        parent_tool_use_id: null,
      });
      release.resolve();
      await ending;
      expect(foreground).toEqual(["running", "ended cancelled", "running"]);
      (agent as any).endAutonomousCycle("test-session", { outcome: { stopReason: "end_turn" } });
      expect(foreground).toEqual(["running", "ended cancelled", "running", "ended end_turn"]);
    },
  );

  it("records cancelled autonomous UUIDs before awaiting compaction interruption", async () => {
    const { agent, session, send, outgoing } = await setup();
    session.requestMarkerListsV1 = true;
    await send(state("running"));
    await agent.steer(request());
    const steered = (await outgoing.next()).value;
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    vi.spyOn(session.contextCompaction, "interrupt").mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
    });
    const openInput = {};
    session.openUserInputs = new Set([openInput]);
    const cancel = agent.cancel({ sessionId: "test-session" });
    await entered.promise;
    expect(openInput).toEqual({ cancelled: true });
    try {
      await send({
        type: "system",
        subtype: "status",
        status: "requesting",
        user_message_uuids: [steered.uuid],
      });
      expect(session.cancelled).toBe(true);
      expect(session.cancelledPrompts).toContain(steered.uuid);
    } finally {
      release.resolve();
      await cancel;
    }
  });

  it("can steer a fresh autonomous request after cancellation without a repeated running state", async () => {
    const { agent, session, send, outgoing, prompt } = await setup();
    session.requestMarkerListsV1 = true;
    await send(state("running"));
    await agent.steer(request());
    const steered = (await outgoing.next()).value;
    await agent.cancel({ sessionId: "test-session" });
    await send(successfulResultMessage({ user_message_uuid: steered.uuid }));
    // Claude Code may stay running while background tasks remain alive.
    expect(session.lastSessionState).toBe("running");
    await send({
      type: "system",
      subtype: "status",
      status: "requesting",
      user_message_uuids: [],
    });
    expect(session.cancelled).toBe(false);
    await expect(agent.steer(request("steer recovered follow-up"))).resolves.toEqual({
      outcome: "injected",
    });
    expect(prompt).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "filters cancelled steering output and gates autonomous recovery on request markers (%s)",
    async (requestMarkers) => {
      const { agent, session, send, outgoing, updates, foreground } = await setup();
      session.requestMarkerListsV1 = requestMarkers;
      const output = async (text: string) => {
        await send({
          type: "stream_event",
          parent_tool_use_id: null,
          uuid: `start-${text}`,
          session_id: "test-session",
          event: {
            type: "message_start",
            message: {
              id: `message-${text}`,
              role: "assistant",
              content: [],
              model: "claude-sonnet-4-20250514",
              usage: { input_tokens: 0, output_tokens: 0 },
            },
          },
        });
        await send({
          type: "stream_event",
          parent_tool_use_id: null,
          uuid: `delta-${text}`,
          session_id: "test-session",
          event: {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text },
          },
        });
      };
      await send(state("running"));
      await agent.steer(request());
      const steered = (await outgoing.next()).value;
      await output("Before cancellation");
      await agent.cancel({ sessionId: "test-session" });
      await send(successfulResultMessage({ user_message_uuid: steered.uuid }));
      await send({
        type: "system",
        subtype: "status",
        status: "requesting",
        user_message_uuids: [steered.uuid],
      });
      await output("Cancelled command output");
      expect(session.cancelled).toBe(true);
      await expect(agent.steer(request())).resolves.toEqual({
        outcome: "promptRequired",
        reason: "noRunningTurn",
      });
      await send({
        type: "system",
        subtype: "status",
        status: "requesting",
        user_message_uuids: [],
      });
      await output("Fresh follow-up output");
      expect(session.cancelled).toBe(!requestMarkers);
      expect(
        updates
          .filter(({ update }) => update.sessionUpdate === "agent_message_chunk")
          .map(({ update }) => update.content.text),
      ).toEqual(
        requestMarkers
          ? ["Before cancellation", "Fresh follow-up output"]
          : ["Before cancellation"],
      );
      expect(foreground).toEqual(
        requestMarkers ? ["running", "ended cancelled", "running"] : ["running", "ended cancelled"],
      );
    },
  );

  it("can steer a subsequent autonomous model request without a repeated running state", async () => {
    const { agent, session, send } = await setup();
    session.requestMarkerListsV1 = true;
    await send(state("running"));
    await send(successfulResultMessage({ origin: { kind: "task-notification" } }));
    await send({
      type: "system",
      subtype: "status",
      status: "requesting",
      user_message_uuids: [],
    });
    await expect(agent.steer(request())).resolves.toEqual({ outcome: "injected" });
  });

  it("processes cancellation during an autonomous buffered backlog before accepting another steer", async () => {
    const cancelled = Promise.withResolvers<void>();
    let chunks = 0;
    let chunksAtCancel = 0;
    let timerArmed = false;
    const { agent, send, outgoing, session } = await setup(({ update }) => {
      if (update.sessionUpdate !== "agent_message_chunk") return;
      chunks++;
      if (!timerArmed) {
        timerArmed = true;
        setImmediate(() => {
          chunksAtCancel = chunks;
          void agent.cancel({ sessionId: "test-session" }).then(() => cancelled.resolve());
        });
      }
      const until = performance.now() + 2;
      while (performance.now() < until) {
        /* Make the buffered slice exceed its budget. */
      }
    });
    await send(state("running"));
    await agent.steer(request());
    const steered = (await outgoing.next()).value;
    await send(userEcho(steered));
    const backlog = Promise.all(
      Array.from({ length: 30 }, (_, index) =>
        send({
          type: "stream_event",
          parent_tool_use_id: null,
          uuid: `delta-${index}`,
          session_id: "test-session",
          event: {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: `chunk-${index} ` },
          },
        }),
      ),
    );
    await cancelled.promise;
    expect(chunksAtCancel).toBeGreaterThan(0);
    expect(chunksAtCancel).toBeLessThan(30);
    await expect(agent.steer(request("after cancel"))).resolves.toEqual({
      outcome: "promptRequired",
      reason: "noRunningTurn",
    });
    await backlog;
    await send(successfulResultMessage({ user_message_uuid: steered.uuid, is_error: true }));
    await send(state("idle"));
    expect(session.lastTurnFailed).toBe(false);
    expect(session.turnQueue).toEqual([]);
  });
});
