import { describe, expect, it, vi } from "vitest";
import type { AcpSessionNotification } from "../acp-subagents.js";
import {
  announceNativeSubagent,
  finishNativeSubagent,
  NativeSubagent,
  NativeSubagentRuntime,
  NativeSubagentSession,
  resumedNativeSubagentId,
  sendMessageResumePrompt,
  toSubagentWorkState,
} from "../native-subagents.js";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function child(overrides: Partial<NativeSubagent> = {}): NativeSubagent {
  return {
    sessionId: "child-1",
    parentSessionId: "root",
    parentToolUseId: "agent-tool",
    name: "Explore",
    task: "Inspect the project",
    ...overrides,
  };
}

function sessionWith(value: NativeSubagent): NativeSubagentSession {
  return {
    nativeSubagentsByTaskId: new Map([[value.sessionId, value]]),
    nativeSubagentTaskIdByToolUseId: new Map([[value.parentToolUseId!, value.sessionId]]),
    nativeSubagentParentByToolUseId: new Map(),
  };
}

function control(
  sessionUpdate: "tool_call" | "tool_call_update",
  status?: "pending" | "failed",
  parentToolUseId?: string,
): AcpSessionNotification {
  return {
    sessionId: "root",
    update: {
      sessionUpdate,
      toolCallId: "agent-tool",
      title: "Investigate failure",
      status,
      rawInput: { description: "Investigate failure", prompt: "Find the cause" },
      _meta: {
        claudeCode: { toolName: "Agent", parentToolUseId },
        jetbrains: { air: { version: 1, subagent: true } },
      },
    },
  } as AcpSessionNotification;
}

describe("NativeSubagentRuntime lifecycle", () => {
  it.each([
    ["completed", { state: "idle", stopReason: "end_turn" }],
    ["cancelled", { state: "idle", stopReason: "cancelled" }],
    ["failed", { state: "idle", stopReason: "error" }],
    ["disconnected", { state: "unknown" }],
  ] as const)("maps %s to the current RFD work state", (state, expected) => {
    expect(toSubagentWorkState(state)).toEqual(expected);
  });

  it("publishes a raced spawn exactly once", async () => {
    const release = deferred();
    const published: AcpSessionNotification[] = [];
    const value = child();
    const publish = vi.fn(async (notification: AcpSessionNotification) => {
      published.push(notification);
      await release.promise;
    });

    const first = announceNativeSubagent(value, publish);
    const second = announceNativeSubagent(value, publish);

    await Promise.resolve();
    expect(publish).toHaveBeenCalledTimes(1);
    release.resolve();
    await Promise.all([first, second]);
    expect(published.map(({ update }) => update.sessionUpdate)).toEqual(["subagent_update"]);
    expect(published[0]?.update).toMatchObject({ state: { state: "running" } });
  });

  it("publishes a raced terminal exactly once after the spawn", async () => {
    const releaseSpawn = deferred();
    const published: AcpSessionNotification[] = [];
    const value = child();
    const session = sessionWith(value);
    const publish = vi.fn(async (notification: AcpSessionNotification) => {
      published.push(notification);
      if (
        notification.update.sessionUpdate === "subagent_update" &&
        "title" in notification.update
      ) {
        await releaseSpawn.promise;
      }
    });

    const first = finishNativeSubagent(session, value.sessionId, "completed", publish);
    const second = finishNativeSubagent(session, value.sessionId, "cancelled", publish);
    releaseSpawn.resolve();
    await Promise.all([first, second]);

    expect(published.map(({ update }) => update.sessionUpdate)).toEqual([
      "subagent_update",
      "subagent_update",
    ]);
    expect(published[1]?.update).toMatchObject({
      state: { state: "idle", stopReason: "end_turn" },
    });
  });

  it("falls back to one ordinary failed tool call when no child ever starts", async () => {
    const runtime = new NativeSubagentRuntime(true, "root", {}, async () => {}, { log: () => {} });

    await expect(
      runtime.route(control("tool_call", "pending"), async () => {}),
    ).resolves.toBeNull();
    const fallback = await runtime.route(control("tool_call_update", "failed"), async () => {});

    expect(fallback).toMatchObject({
      sessionId: "root",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "agent-tool",
        title: "Investigate failure",
        status: "failed",
        _meta: { claudeCode: { toolName: "Agent" } },
      },
    });
    expect(
      (fallback?.update._meta?.claudeCode as Record<string, unknown>).subagent,
    ).toBeUndefined();
  });

  it("creates a schema-valid non-native failed tool call without a cached initial call", async () => {
    const runtime = new NativeSubagentRuntime(true, "root", {}, async () => {}, { log: () => {} });

    const fallback = await runtime.route(
      {
        sessionId: "root",
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "agent-tool",
          status: "failed",
          _meta: {
            claudeCode: { toolName: "Agent" },
            jetbrains: { air: { version: 1, subagent: true } },
          },
        },
      } as AcpSessionNotification,
      async () => {},
    );

    expect(fallback).toMatchObject({
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "agent-tool",
        name: "Agent",
        title: "Agent",
        status: "failed",
        _meta: { claudeCode: { toolName: "Agent" } },
      },
    });
    expect(
      (fallback?.update._meta?.claudeCode as Record<string, unknown>).subagent,
    ).toBeUndefined();
  });

  it("clears failed-control identity and parent affinity before an id is reused", async () => {
    const outer = child({
      sessionId: "outer-child",
      parentToolUseId: "outer-tool",
      announced: true,
    });
    const session = sessionWith(outer);
    const published: AcpSessionNotification[] = [];
    const runtime = new NativeSubagentRuntime(
      true,
      "root",
      session,
      async (notification) => {
        published.push(notification);
      },
      { log: () => {} },
    );

    await runtime.route(control("tool_call", "pending", "outer-tool"), async () => {});
    await runtime.route(control("tool_call_update", "failed", "outer-tool"), async () => {});
    await runtime.taskStarted(
      {
        taskId: "reused-child",
        toolUseId: "agent-tool",
        subagentType: "Review",
        description: "Fresh identity",
      },
      async () => {},
    );
    await runtime.route(
      {
        ...control("tool_call", "pending"),
        update: {
          ...control("tool_call", "pending").update,
          rawInput: { description: "Fresh identity", prompt: "Review again" },
        },
      } as AcpSessionNotification,
      async () => {},
    );

    // -2, not -1: the rawInput's "Review again" prompt also sends a
    // session_message to the child right after this announce.
    expect(published.at(-2)).toMatchObject({
      sessionId: "root",
      update: {
        sessionUpdate: "subagent_update",
        sessionId: "reused-child",
        title: "Fresh identity",
      },
    });
  });

  it("discards unknown pending child updates during finishAll", async () => {
    const published: AcpSessionNotification[] = [];
    const delivered: AcpSessionNotification[] = [];
    const runtime = new NativeSubagentRuntime(
      true,
      "root",
      {},
      async (notification) => {
        published.push(notification);
      },
      { log: () => {} },
    );
    const pending = {
      sessionId: "root",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "stale" },
        _meta: { claudeCode: { parentToolUseId: "agent-tool" } },
      },
    } as AcpSessionNotification;

    await expect(
      runtime.route(pending, async (value) => {
        delivered.push(value);
      }),
    ).resolves.toBeNull();
    await runtime.finishAll("cancelled", async (value) => {
      delivered.push(value);
    });
    await runtime.taskStarted(
      {
        taskId: "child-1",
        toolUseId: "agent-tool",
        subagentType: "Explore",
        description: "New child",
      },
      async (value) => {
        delivered.push(value);
      },
    );
    await runtime.route(control("tool_call", "pending"), async (value) => {
      delivered.push(value);
    });

    expect(delivered).toEqual([]);
    // Announce + the session_message prompt delivery (control()'s default
    // rawInput always carries a prompt).
    expect(published).toHaveLength(2);
  });

  it("reuses the ACP conversation when the SDK restarts the same task id", async () => {
    const published: AcpSessionNotification[] = [];
    const runtime = new NativeSubagentRuntime(
      true,
      "root",
      {},
      async (notification) => {
        published.push(notification);
      },
      { log: () => {} },
    );
    const launch = (toolCallId: string) =>
      ({
        ...control("tool_call", "pending"),
        update: { ...control("tool_call", "pending").update, toolCallId },
      }) as AcpSessionNotification;
    const output = (parentToolUseId: string, text: string) =>
      ({
        sessionId: "root",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text },
          _meta: { claudeCode: { parentToolUseId } },
        },
      }) as AcpSessionNotification;

    await runtime.route(launch("launch-1"), async () => {});
    await runtime.taskStarted(
      {
        taskId: "worker-1",
        toolUseId: "launch-1",
        subagentType: "Explore",
        description: "First run",
      },
      async () => {},
    );
    await expect(runtime.route(output("launch-1", "first"), async () => {})).resolves.toMatchObject(
      { sessionId: "worker-1" },
    );
    await runtime.finishTask("worker-1", "completed", async () => {});

    await runtime.route(launch("launch-2"), async () => {});
    await runtime.taskStarted(
      {
        taskId: "worker-1",
        toolUseId: "launch-2",
        subagentType: "Explore",
        description: "Second run",
      },
      async () => {},
    );
    await expect(
      runtime.route(output("launch-2", "second"), async () => {}),
    ).resolves.toMatchObject({ sessionId: "worker-1" });
    await runtime.finishTask("worker-1", "failed", async () => {}, "launch-1");
    expect(
      published.filter(
        ({ update }) =>
          update.sessionUpdate === "subagent_update" && update.state?.state === "idle",
      ),
    ).toHaveLength(1);
    await expect(
      runtime.route(output("launch-2", "still running"), async () => {}),
    ).resolves.toMatchObject({ sessionId: "worker-1" });
    await expect(runtime.route(output("launch-1", "late"), async () => {})).resolves.toBeNull();
    await runtime.finishTask("worker-1", "completed", async () => {}, "launch-2");

    const spawnedIds = published.flatMap(({ update }) =>
      update.sessionUpdate === "subagent_update" && "title" in update ? [update.sessionId] : [],
    );
    const terminalIds = published.flatMap(({ update }) =>
      update.sessionUpdate === "subagent_update" && update.state?.state === "idle"
        ? [update.sessionId]
        : [],
    );
    expect(spawnedIds).toEqual(["worker-1", "worker-1"]);
    expect(terminalIds).toEqual(spawnedIds);
  });

  it("reports running immediately when SendMessage restarts the task (#1158)", async () => {
    const published: AcpSessionNotification[] = [];
    const runtime = new NativeSubagentRuntime(
      true,
      "root",
      {},
      async (notification) => {
        published.push(notification);
      },
      { log: () => {} },
    );
    const launch = (toolCallId: string) =>
      ({
        ...control("tool_call", "pending"),
        update: { ...control("tool_call", "pending").update, toolCallId },
      }) as AcpSessionNotification;

    // First generation starts from Agent tool call
    await runtime.route(launch("launch-1"), async () => {});
    await runtime.taskStarted(
      {
        taskId: "worker-1",
        toolUseId: "launch-1",
        subagentType: "Explore",
        description: "First run",
      },
      async () => {},
    );
    // Generation 1 finishes, which cleans up parentByToolUse for launch-1
    await runtime.finishTask("worker-1", "completed", async () => {}, "launch-1");

    expect(published.map(({ update }) => update.sessionUpdate)).toEqual([
      "subagent_update",
      // `launch()`'s default `control()` rawInput always carries a prompt.
      "session_message",
      "subagent_update",
    ]);

    // SendMessage resumes the subagent with the same toolUseId and taskId without a new Agent control frame
    await runtime.taskStarted(
      {
        taskId: "worker-1",
        toolUseId: "launch-1",
        subagentType: "Explore",
        description: "Resumed run",
      },
      async () => {},
    );

    // Generation 2 must be announced immediately at taskStarted, not held until finishTask
    const spawnedIds = published.flatMap(({ update }) =>
      update.sessionUpdate === "subagent_update" && "title" in update ? [update.sessionId] : [],
    );
    expect(spawnedIds).toEqual(["worker-1", "worker-1"]);
    expect(published.at(-1)?.update).toMatchObject({ state: { state: "running" } });

    // Terminal state then ends generation 2
    await runtime.finishTask("worker-1", "completed", async () => {}, "launch-1");
    const terminalIds = published.flatMap(({ update }) =>
      update.sessionUpdate === "subagent_update" && update.state?.state === "idle"
        ? [update.sessionId]
        : [],
    );
    expect(terminalIds).toEqual(["worker-1", "worker-1"]);
  });

  it("keeps a resumed nested subagent under its original parent after that parent finishes", async () => {
    const published: AcpSessionNotification[] = [];
    const runtime = new NativeSubagentRuntime(
      true,
      "root",
      {},
      async (notification) => {
        published.push(notification);
      },
      { log: () => {} },
    );
    const launch = (toolCallId: string, parentToolUseId?: string) =>
      ({
        ...control("tool_call", "pending", parentToolUseId),
        update: { ...control("tool_call", "pending", parentToolUseId).update, toolCallId },
      }) as AcpSessionNotification;

    await runtime.route(launch("launch-a"), async () => {});
    await runtime.taskStarted(
      { taskId: "agent-a", toolUseId: "launch-a", subagentType: "Explore" },
      async () => {},
    );
    await runtime.route(launch("launch-b", "launch-a"), async () => {});
    await runtime.taskStarted(
      { taskId: "agent-b", toolUseId: "launch-b", subagentType: "Explore" },
      async () => {},
    );
    await runtime.finishTask("agent-b", "completed", async () => {}, "launch-b");
    await runtime.finishTask("agent-a", "completed", async () => {}, "launch-a");

    // The root resumes B with SendMessage after A finishes; ownership stays with A.
    await runtime.taskStarted(
      { taskId: "agent-b", toolUseId: "launch-b", subagentType: "Explore" },
      async () => {},
    );

    expect(published.at(-1)).toMatchObject({
      sessionId: "agent-a",
      update: {
        sessionUpdate: "subagent_update",
        sessionId: "agent-b",
        title: expect.any(String),
        state: { state: "running" },
      },
    });
  });

  describe("the subagent prompt as a session_message to the child", () => {
    // RFD #1992's rework dropped the `subagent_spawned.prompt` adapter
    // extension; "Session-directed messages" is the replacement, so the
    // prompt now arrives as a `session_message` on the child's own stream,
    // sent right after the announcing `subagent_update`.
    async function spawned(
      task: { prompt?: string },
      rawInput?: Record<string, unknown>,
    ): Promise<{
      announce: Record<string, unknown>;
      message: Record<string, unknown> | undefined;
    }> {
      const published: AcpSessionNotification[] = [];
      const runtime = new NativeSubagentRuntime(
        true,
        "root",
        {},
        async (notification) => {
          published.push(notification);
        },
        { log: () => {} },
      );
      const launch = control("tool_call", "pending");
      await runtime.route(
        { ...launch, update: { ...launch.update, rawInput } } as AcpSessionNotification,
        async () => {},
      );
      await runtime.taskStarted(
        {
          taskId: "worker-1",
          toolUseId: "agent-tool",
          subagentType: "Explore",
          description: "Investigate failure",
          ...task,
        },
        async () => {},
      );
      const announce = published.find(
        ({ update }) => update.sessionUpdate === "subagent_update" && "title" in update,
      );
      const message = published.find(({ update }) => update.sessionUpdate === "session_message");
      return {
        announce: announce!.update as unknown as Record<string, unknown>,
        message: message?.update as unknown as Record<string, unknown> | undefined,
      };
    }

    it("carries the exact task_started prompt", async () => {
      const { message } = await spawned(
        { prompt: "  Trace the crash.\n\nReport the stack.\n" },
        { description: "Investigate failure", prompt: "Find the cause" },
      );

      expect(message).toMatchObject({
        sessionUpdate: "session_message",
        senderSessionId: "root",
        recipientSessionId: "worker-1",
        content: [{ type: "text", text: "  Trace the crash.\n\nReport the stack.\n" }],
      });
    });

    it("falls back to the prompt of the Agent tool input", async () => {
      const { message } = await spawned(
        {},
        { description: "Investigate failure", prompt: "Find the cause" },
      );

      expect(message).toMatchObject({ content: [{ type: "text", text: "Find the cause" }] });
    });

    it("sends no session_message when the adapter has no prompt, but still announces a description", async () => {
      const { announce, message } = await spawned(
        { prompt: "   " },
        { description: "Investigate failure" },
      );

      expect(message).toBeUndefined();
      expect(announce.description).toBe("Investigate failure");
    });
  });

  describe("resume after a terminal state", () => {
    const output = (text: string) =>
      ({
        sessionId: "root",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text },
          _meta: { claudeCode: { parentToolUseId: "launch-1" } },
        },
      }) as AcpSessionNotification;

    async function finishedWorker(state: "failed" | "completed") {
      const published: AcpSessionNotification[] = [];
      const logged: string[] = [];
      const runtime = new NativeSubagentRuntime(
        true,
        "root",
        {},
        async (notification) => {
          published.push(notification);
        },
        { log: (message) => logged.push(message) },
      );
      await runtime.route(
        {
          ...control("tool_call", "pending"),
          update: { ...control("tool_call", "pending").update, toolCallId: "launch-1" },
        } as AcpSessionNotification,
        async () => {},
      );
      await runtime.taskStarted(
        {
          taskId: "worker-1",
          toolUseId: "launch-1",
          subagentType: "Explore",
          description: "First run",
        },
        async () => {},
      );
      await runtime.finishTask("worker-1", state, async () => {});
      return { runtime, published, logged };
    }

    // Both announcement and stop use `subagent_update`; the title identifies
    // the metadata upsert that also reports running.
    const lifecycle = (published: AcpSessionNotification[]) =>
      published.map(({ sessionId, update }) => [
        sessionId,
        update.sessionUpdate === "subagent_update"
          ? "title" in update
            ? "subagent_update:running"
            : "subagent_update:idle"
          : update.sessionUpdate,
        "sessionId" in update ? update.sessionId : undefined,
      ]);

    it("continues the same conversation when a failed child runs again", async () => {
      const { runtime, published } = await finishedWorker("failed");

      await runtime.taskResumed("worker-1", async () => {});
      await expect(runtime.route(output("resumed"), async () => {})).resolves.toMatchObject({
        sessionId: "worker-1",
      });
      await runtime.taskResumed("worker-1", async () => {});
      await runtime.finishTask("worker-1", "completed", async () => {});

      expect(lifecycle(published)).toEqual([
        ["root", "subagent_update:running", "worker-1"],
        // `finishedWorker`'s default `control()` rawInput always carries a
        // prompt, so generation 1 also gets a `session_message` delivery.
        // Generation 2 resumes via `taskResumed` with no prompt argument, so
        // it gets none.
        ["worker-1", "session_message", undefined],
        ["root", "subagent_update:idle", "worker-1"],
        ["root", "subagent_update:running", "worker-1"],
        ["root", "subagent_update:idle", "worker-1"],
      ]);
      expect(published[3]?.update).toMatchObject({
        title: "Investigate failure",
        description: "Find the cause",
      });
    });

    it("routes the first update after a SendMessage resume to the new generation", async () => {
      const { runtime, published } = await finishedWorker("failed");

      const resumed = resumedNativeSubagentId({
        success: true,
        message: "Resuming agent worker-1",
        resumedAgentId: "worker-1",
      });
      expect(resumed).toBe("worker-1");
      await runtime.taskResumed(resumed!, async () => {});

      await expect(runtime.route(output("resumed"), async () => {})).resolves.toMatchObject({
        sessionId: "worker-1",
      });
      expect(lifecycle(published).at(-1)).toEqual(["root", "subagent_update:running", "worker-1"]);
      expect(resumedNativeSubagentId({ success: false, resumedAgentId: "worker-1" })).toBe(
        undefined,
      );
    });

    it("sends each resume prompt as a distinct message in the same child session", async () => {
      const { runtime, published } = await finishedWorker("completed");

      await runtime.taskResumed("worker-1", async () => {}, "Check the tests too");

      expect(published.at(-1)?.update).toMatchObject({
        sessionUpdate: "session_message",
        senderSessionId: "root",
        recipientSessionId: "worker-1",
        content: [{ type: "text", text: "Check the tests too" }],
      });
      await runtime.finishTask("worker-1", "completed", async () => {});
      await runtime.taskResumed("worker-1", async () => {}, "Check the docs too");

      const messages = published.filter(({ update }) => update.sessionUpdate === "session_message");
      expect(messages).toHaveLength(3);
      expect(
        new Set(
          messages.map(({ update }) => ("messageId" in update ? update.messageId : undefined)),
        ).size,
      ).toBe(3);
      expect(messages.at(-1)?.update).toMatchObject({
        recipientSessionId: "worker-1",
        content: [{ type: "text", text: "Check the docs too" }],
      });
    });

    it("sends no session_message for a new generation without a SendMessage text", async () => {
      // `finishedWorker`'s own first generation does get one (its default
      // `control()` rawInput carries a prompt) -- only the resumed
      // generation below is under test, so compare what the resume itself
      // adds, not the total count.
      const { runtime, published } = await finishedWorker("completed");
      const beforeResume = published.length;

      await runtime.taskResumed("worker-1", async () => {});

      expect(published.at(-1)?.update.sessionUpdate).toBe("subagent_update");
      expect(
        published
          .slice(beforeResume)
          .filter(({ update }) => update.sessionUpdate === "session_message"),
      ).toHaveLength(0);
    });

    it("finds the SendMessage text that resumed the agent", () => {
      const toolUses = {
        old: { name: "SendMessage", input: { to: "worker-1", message: "First" } },
        other: { name: "SendMessage", input: { to: "worker-2", message: "Other" } },
        latest: { name: "SendMessage", input: { to: "worker-1", message: "Second" } },
        bash: { name: "Bash", input: { command: "ls" } },
      };

      expect(sendMessageResumePrompt(toolUses, "worker-1")).toBe("Second");
      expect(sendMessageResumePrompt(toolUses, "worker-1", ["old"])).toBe("First");
      expect(sendMessageResumePrompt(toolUses, "worker-1", ["bash"])).toBeUndefined();
      expect(sendMessageResumePrompt(toolUses, "worker-3")).toBeUndefined();
    });

    it("keeps the work of a child tool call in the generation that started it", async () => {
      const published: AcpSessionNotification[] = [];
      const runtime = new NativeSubagentRuntime(
        true,
        "root",
        {},
        async (notification) => {
          published.push(notification);
        },
        { log: () => {} },
      );
      await runtime.route(
        {
          ...control("tool_call", "pending"),
          update: { ...control("tool_call", "pending").update, toolCallId: "launch-1" },
        } as AcpSessionNotification,
        async () => {},
      );
      await runtime.taskStarted(
        { taskId: "worker-1", toolUseId: "launch-1", subagentType: "Explore" },
        async () => {},
      );
      const childToolCall = {
        sessionId: "root",
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "child-bash",
          title: "npm test",
          _meta: { claudeCode: { toolName: "Bash", parentToolUseId: "launch-1" } },
        },
      } as AcpSessionNotification;
      await expect(runtime.route(childToolCall, async () => {})).resolves.toMatchObject({
        sessionId: "worker-1",
      });
      const taskUpdate = {
        sessionId: "root",
        update: { sessionUpdate: "async_task_progress", asyncTaskId: "shell-1" },
      } as AcpSessionNotification;

      const route = runtime.routeOfToolCall("child-bash");
      expect(route?.(taskUpdate)).toMatchObject({ sessionId: "worker-1" });
      expect(runtime.routeOfToolCall("root-bash")).toBeUndefined();
      // A permission request created this tool call in the child session.
      expect(runtime.routeOfToolCall("eager-bash", "worker-1")?.(taskUpdate)).toMatchObject({
        sessionId: "worker-1",
      });
      expect(runtime.routeOfToolCall("eager-bash", "root")).toBeUndefined();

      await runtime.finishTask("worker-1", "completed", async () => {});
      await runtime.taskResumed("worker-1", async () => {});

      // Resuming keeps the conversation ID, but the background task retains its owner.
      expect(lifecycle(published).at(-1)).toEqual(["root", "subagent_update:running", "worker-1"]);
      // Background task updates still reach the child after foreground work ends.
      expect(route?.(taskUpdate)).toMatchObject({ sessionId: "worker-1" });
      const taskState = {
        sessionId: "root",
        update: {
          sessionUpdate: "async_task_state_update",
          asyncTaskId: "shell-1",
          state: "completed",
        },
      } as AcpSessionNotification;
      expect(route?.(taskState)).toMatchObject({ sessionId: "worker-1" });
      // A held task can get its tool call id, and so its spawn, after the child finished.
      const taskSpawned = {
        sessionId: "root",
        update: {
          sessionUpdate: "async_task_spawned",
          asyncTaskId: "shell-2",
          name: "npm start",
          taskType: "shell",
          description: "npm start",
          showInTranscript: true,
          canStop: true,
        },
      } as AcpSessionNotification;
      expect(route?.(taskSpawned)).toMatchObject({ sessionId: "worker-1" });
      // Every other late update from the previous delegation is dropped.
      const lateOutput = {
        sessionId: "root",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "late" },
        },
      } as AcpSessionNotification;
      expect(route?.(lateOutput)).toBeNull();
    });

    it("ignores a late update of a completed child without a resume signal", async () => {
      const { runtime, published, logged } = await finishedWorker("completed");

      await expect(runtime.route(output("late"), async () => {})).resolves.toBeNull();
      await runtime.taskResumed("unknown-task", async () => {});

      expect(lifecycle(published)).toEqual([
        ["root", "subagent_update:running", "worker-1"],
        ["worker-1", "session_message", undefined],
        ["root", "subagent_update:idle", "worker-1"],
      ]);
      expect(logged).toEqual(["Session root: ignoring late update for terminal subagent worker-1"]);
    });
  });
});
