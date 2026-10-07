import { describe, expect, it, vi } from "vitest";
import type { AcpSessionNotification } from "../acp-subagents.js";
import {
  announceNativeSubagent,
  finishNativeSubagent,
  NativeSubagent,
  NativeSubagentRuntime,
  NativeSubagentSession,
  resumedNativeSubagentId,
  sendMessageResume,
  sendMessageResumePrompt,
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
  it("publishes a raced spawn exactly once", async () => {
    const release = deferred();
    const published: AcpSessionNotification[] = [];
    const value = child();
    const publish = vi.fn(async (notification: AcpSessionNotification) => {
      published.push(notification);
      await release.promise;
    });

    const first = announceNativeSubagent(value, publish, "air");
    const second = announceNativeSubagent(value, publish, "air");

    await Promise.resolve();
    expect(publish).toHaveBeenCalledTimes(1);
    release.resolve();
    await Promise.all([first, second]);
    expect(published.map(({ update }) => update.sessionUpdate)).toEqual(["subagent_spawned"]);
  });

  it("publishes a raced terminal exactly once after the spawn", async () => {
    const releaseSpawn = deferred();
    const published: AcpSessionNotification[] = [];
    const value = child();
    const session = sessionWith(value);
    const publish = vi.fn(async (notification: AcpSessionNotification) => {
      published.push(notification);
      if (notification.update.sessionUpdate === "subagent_spawned") await releaseSpawn.promise;
    });

    const first = finishNativeSubagent(session, value.sessionId, "completed", publish);
    const second = finishNativeSubagent(session, value.sessionId, "cancelled", publish);
    releaseSpawn.resolve();
    await Promise.all([first, second]);

    expect(published.map(({ update }) => update.sessionUpdate)).toEqual([
      "subagent_spawned",
      "subagent_state_update",
    ]);
    expect(published[1]?.update).toMatchObject({ state: "completed" });
  });

  it("falls back to one ordinary failed tool call when no child ever starts", async () => {
    const runtime = new NativeSubagentRuntime("air", "root", {}, async () => {}, { log: () => {} });

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
    const runtime = new NativeSubagentRuntime("air", "root", {}, async () => {}, { log: () => {} });

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
      "air",
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

    expect(published.at(-1)).toMatchObject({
      sessionId: "root",
      update: {
        sessionUpdate: "subagent_spawned",
        subagentSessionId: "reused-child",
        name: "Fresh identity",
      },
    });
  });

  it("discards unknown pending child updates during finishAll", async () => {
    const published: AcpSessionNotification[] = [];
    const delivered: AcpSessionNotification[] = [];
    const runtime = new NativeSubagentRuntime(
      "air",
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
    expect(published).toHaveLength(1);
  });

  it("creates a distinct ACP lifecycle when the SDK restarts the same task id", async () => {
    const published: AcpSessionNotification[] = [];
    const runtime = new NativeSubagentRuntime(
      "air",
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
    ).resolves.toMatchObject({ sessionId: "worker-1:generation:2" });
    await runtime.finishTask("worker-1", "failed", async () => {}, "launch-1");
    expect(
      published.filter(({ update }) => update.sessionUpdate === "subagent_state_update"),
    ).toHaveLength(1);
    await expect(
      runtime.route(output("launch-2", "still running"), async () => {}),
    ).resolves.toMatchObject({ sessionId: "worker-1:generation:2" });
    await expect(runtime.route(output("launch-1", "late"), async () => {})).resolves.toBeNull();
    await runtime.finishTask("worker-1", "completed", async () => {}, "launch-2");

    const spawnedIds = published.flatMap(({ update }) =>
      update.sessionUpdate === "subagent_spawned" ? [update.subagentSessionId] : [],
    );
    const terminalIds = published.flatMap(({ update }) =>
      update.sessionUpdate === "subagent_state_update" ? [update.subagentSessionId] : [],
    );
    expect(spawnedIds).toEqual(["worker-1", "worker-1:generation:2"]);
    expect(terminalIds).toEqual(spawnedIds);
  });

  it("announces resumed subagent generation immediately when SendMessage restarts the task (#1158)", async () => {
    const published: AcpSessionNotification[] = [];
    const runtime = new NativeSubagentRuntime(
      "air",
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
      "subagent_spawned",
      "subagent_state_update",
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
      update.sessionUpdate === "subagent_spawned" ? [update.subagentSessionId] : [],
    );
    expect(spawnedIds).toEqual(["worker-1", "worker-1:generation:2"]);

    // Terminal state then ends generation 2
    await runtime.finishTask("worker-1", "completed", async () => {}, "launch-1");
    const terminalIds = published.flatMap(({ update }) =>
      update.sessionUpdate === "subagent_state_update" ? [update.subagentSessionId] : [],
    );
    expect(terminalIds).toEqual(["worker-1", "worker-1:generation:2"]);
  });

  it("announces a resumed nested subagent under a live ancestor when its parent has finished", async () => {
    const published: AcpSessionNotification[] = [];
    const runtime = new NativeSubagentRuntime(
      "air",
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

    // The root resumes B with SendMessage after A, B's original parent, is gone.
    await runtime.taskStarted(
      { taskId: "agent-b", toolUseId: "launch-b", subagentType: "Explore" },
      async () => {},
    );

    expect(published.at(-1)).toMatchObject({
      sessionId: "root",
      update: { sessionUpdate: "subagent_spawned", subagentSessionId: "agent-b:generation:2" },
    });
  });

  describe("the subagent prompt in subagent_spawned", () => {
    async function spawned(
      task: { prompt?: string },
      rawInput?: Record<string, unknown>,
    ): Promise<Record<string, unknown>> {
      const published: AcpSessionNotification[] = [];
      const runtime = new NativeSubagentRuntime(
        "air",
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
      const update = published.find(({ update }) => update.sessionUpdate === "subagent_spawned");
      return update!.update as unknown as Record<string, unknown>;
    }

    it("carries the exact task_started prompt", async () => {
      const update = await spawned(
        { prompt: "  Trace the crash.\n\nReport the stack.\n" },
        { description: "Investigate failure", prompt: "Find the cause" },
      );

      expect(update.prompt).toBe("  Trace the crash.\n\nReport the stack.\n");
    });

    it("falls back to the prompt of the Agent tool input", async () => {
      const update = await spawned(
        {},
        { description: "Investigate failure", prompt: "Find the cause" },
      );

      expect(update.prompt).toBe("Find the cause");
    });

    it("omits the prompt when the adapter has none", async () => {
      const update = await spawned({ prompt: "   " }, { description: "Investigate failure" });

      expect(update).not.toHaveProperty("prompt");
      expect(update.task).toBe("Investigate failure");
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
        "air",
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

    const lifecycle = (published: AcpSessionNotification[]) =>
      published.map(({ sessionId, update }) => [
        sessionId,
        update.sessionUpdate,
        "subagentSessionId" in update ? update.subagentSessionId : undefined,
      ]);

    it("opens a new generation when a failed child runs again", async () => {
      const { runtime, published } = await finishedWorker("failed");

      await runtime.taskResumed("worker-1", async () => {});
      await expect(runtime.route(output("resumed"), async () => {})).resolves.toMatchObject({
        sessionId: "worker-1:generation:2",
      });
      await runtime.taskResumed("worker-1", async () => {});
      await runtime.finishTask("worker-1", "completed", async () => {});

      expect(lifecycle(published)).toEqual([
        ["root", "subagent_spawned", "worker-1"],
        ["root", "subagent_state_update", "worker-1"],
        ["root", "subagent_spawned", "worker-1:generation:2"],
        ["root", "subagent_state_update", "worker-1:generation:2"],
      ]);
      expect(published[2]?.update).toMatchObject({
        name: "Investigate failure",
        task: "Find the cause",
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
        sessionId: "worker-1:generation:2",
      });
      expect(lifecycle(published).at(-1)).toEqual([
        "root",
        "subagent_spawned",
        "worker-1:generation:2",
      ]);
      expect(resumedNativeSubagentId({ success: false, resumedAgentId: "worker-1" })).toBe(
        undefined,
      );
    });

    it("sends the SendMessage text as the prompt of the new generation", async () => {
      const { runtime, published } = await finishedWorker("completed");

      await runtime.taskResumed("worker-1", async () => {}, "Check the tests too");

      expect(published.at(-1)?.update).toMatchObject({
        sessionUpdate: "subagent_spawned",
        subagentSessionId: "worker-1:generation:2",
        prompt: "Check the tests too",
      });
    });

    it("omits the prompt of a new generation without a SendMessage text", async () => {
      const { runtime, published } = await finishedWorker("completed");

      await runtime.taskResumed("worker-1", async () => {});

      expect(published.at(-1)?.update).not.toHaveProperty("prompt");
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

    it("names the SendMessage call that resumed the agent even without a text", () => {
      const toolUses = {
        blank: { name: "SendMessage", input: { to: "worker-1", message: " " } },
        bash: { name: "Bash", input: { command: "ls" } },
      };

      expect(sendMessageResume(toolUses, "worker-1", ["blank"])).toEqual({ toolUseId: "blank" });
      expect(sendMessageResume(toolUses, "worker-1")).toEqual({ toolUseId: "blank" });
      expect(sendMessageResume(toolUses, "worker-1", ["bash"])).toBeUndefined();
      expect(sendMessageResumePrompt(toolUses, "worker-1", ["blank"])).toBeUndefined();
    });

    it("keeps the work of a child tool call in the generation that started it", async () => {
      const published: AcpSessionNotification[] = [];
      const runtime = new NativeSubagentRuntime(
        "air",
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

      // The task started in the first generation: it never moves to the second.
      expect(lifecycle(published).at(-1)).toEqual([
        "root",
        "subagent_spawned",
        "worker-1:generation:2",
      ]);
      // The task outlives the first generation: its updates still reach it.
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
      // Every other late update of the finished generation is dropped.
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
        ["root", "subagent_spawned", "worker-1"],
        ["root", "subagent_state_update", "worker-1"],
      ]);
      expect(logged).toEqual(["Session root: ignoring late update for terminal subagent worker-1"]);
    });
  });
});

/**
 * The subagents RFD (agentclientprotocol/agent-client-protocol#1992, as
 * revised), for a client that declares `subagents` and is not AIR.
 */
describe("NativeSubagentRuntime in the RFD form", () => {
  const launch = (
    toolCallId: string,
    input: Record<string, unknown>,
    parentToolUseId?: string,
  ): AcpSessionNotification =>
    ({
      sessionId: "root",
      update: {
        sessionUpdate: "tool_call",
        toolCallId,
        title: "Agent",
        status: "pending",
        rawInput: input,
        _meta: {
          claudeCode: { toolName: "Agent", ...(parentToolUseId ? { parentToolUseId } : {}) },
        },
      },
    }) as AcpSessionNotification;
  const output = (parentToolUseId: string): AcpSessionNotification =>
    ({
      sessionId: "root",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "working" },
        _meta: { claudeCode: { parentToolUseId } },
      },
    }) as AcpSessionNotification;
  /** A SendMessage call, of the root or of the child that `parentToolUseId` launched. */
  const sendMessage = (toolCallId: string, parentToolUseId?: string): AcpSessionNotification =>
    ({
      sessionId: "root",
      update: {
        sessionUpdate: "tool_call",
        toolCallId,
        title: "SendMessage",
        status: "pending",
        _meta: {
          claudeCode: {
            toolName: "SendMessage",
            ...(parentToolUseId ? { parentToolUseId } : {}),
          },
        },
      },
    }) as AcpSessionNotification;

  /** A runtime whose child `worker-1` was launched by `launch-1` and runs. */
  async function runningWorker(input: Record<string, unknown> = {}) {
    const published: AcpSessionNotification[] = [];
    const runtime = new NativeSubagentRuntime(
      "rfd",
      "root",
      {},
      async (notification) => {
        published.push(notification);
      },
      { log: () => {} },
    );
    const control = await runtime.route(
      launch("launch-1", { description: "Fix the build", prompt: "Make it pass", ...input }),
      async () => {},
    );
    await runtime.taskStarted(
      { taskId: "worker-1", toolUseId: "launch-1", subagentType: "Explore" },
      async () => {},
    );
    return { runtime, published, control };
  }
  const states = (published: AcpSessionNotification[]) =>
    published.flatMap(({ update }) =>
      update.sessionUpdate === "subagent_update" && update.state ? [update.state] : [],
    );

  it("keeps the Agent tool call as a tool call of the session that made it", async () => {
    const { runtime, control } = await runningWorker();

    expect(control).toMatchObject({ sessionId: "root", update: { toolCallId: "launch-1" } });
    // A nested launch is a tool call of the child that made it.
    await expect(
      runtime.route(launch("launch-2", { description: "Dig" }, "launch-1"), async () => {}),
    ).resolves.toMatchObject({ sessionId: "worker-1", update: { toolCallId: "launch-2" } });
  });

  it("announces the child with the parent's labels, then sends it the prompt", async () => {
    const { published } = await runningWorker({ name: "builder" });

    expect(published).toEqual([
      {
        sessionId: "root",
        update: {
          sessionUpdate: "subagent_update",
          sessionId: "worker-1",
          title: "builder (Explore)",
          description: "Fix the build",
          state: { state: "running" },
        },
      },
      {
        sessionId: "worker-1",
        update: {
          sessionUpdate: "session_message",
          messageId: "launch-1",
          senderSessionId: "root",
          recipientSessionId: "worker-1",
          content: [{ type: "text", text: "Make it pass" }],
        },
      },
    ]);
  });

  it("titles a child without a name by its role", async () => {
    const { published } = await runningWorker();

    expect(published[0]?.update).toMatchObject({ title: "Explore", description: "Fix the build" });
  });

  it("keeps the session of an idle child, which a resume runs again", async () => {
    const { runtime, published } = await runningWorker();
    await runtime.finishTask("worker-1", "completed", async () => {});

    // An idle child is reusable, so its updates still go to it.
    await expect(runtime.route(output("launch-1"), async () => {})).resolves.toMatchObject({
      sessionId: "worker-1",
    });
    await runtime.route(sendMessage("send-1"), async () => {});
    await runtime.sendMessageResumed("worker-1", async () => {}, "Check the tests too", "send-1");
    // A repeated resume signal of the running child changes nothing.
    await runtime.sendMessageResumed("worker-1", async () => {}, "Check the tests too", "send-1");
    await runtime.finishTask("worker-1", "completed", async () => {});

    expect(states(published)).toEqual([
      { state: "running" },
      { state: "idle", stopReason: "end_turn" },
      { state: "running" },
      { state: "idle", stopReason: "end_turn" },
    ]);
    expect(published.filter(({ update }) => update.sessionUpdate === "session_message")).toEqual([
      expect.objectContaining({ sessionId: "worker-1" }),
      {
        sessionId: "worker-1",
        update: {
          sessionUpdate: "session_message",
          messageId: "send-1",
          senderSessionId: "root",
          recipientSessionId: "worker-1",
          content: [{ type: "text", text: "Check the tests too" }],
        },
      },
    ]);
    expect(
      published.some(({ update }) => "sessionId" in update && update.sessionId !== "worker-1"),
    ).toBe(false);
  });

  it("moves the work of a resume to the child, under the id of the call that resumed it", async () => {
    const { runtime, published } = await runningWorker();
    await runtime.finishTask("worker-1", "completed", async () => {}, "launch-1");
    await runtime.route(sendMessage("send-1"), async () => {});
    // The resumed run's output can arrive before the SDK's task_started.
    await expect(runtime.route(output("send-1"), async () => {})).resolves.toBeNull();

    const delivered: AcpSessionNotification[] = [];
    await runtime.taskStarted(
      { taskId: "worker-1", toolUseId: "send-1", prompt: "Check the tests too" },
      async (notification) => {
        delivered.push(notification);
      },
    );
    // The resume signal of the SendMessage result repeats it, and changes nothing.
    await runtime.sendMessageResumed("worker-1", async () => {}, "Check the tests too", "send-1");

    // The waiting output is delivered for routing again, which now finds the child.
    expect(delivered).toEqual([output("send-1")]);
    await expect(runtime.route(output("send-1"), async () => {})).resolves.toMatchObject({
      sessionId: "worker-1",
    });
    // The end of the first delegation, again, does not end the second.
    await runtime.finishTask("worker-1", "completed", async () => {}, "launch-1");
    expect(states(published).at(-1)).toEqual({ state: "running" });
    await runtime.finishTask("worker-1", "completed", async () => {}, "send-1");
    expect(states(published)).toEqual([
      { state: "running" },
      { state: "idle", stopReason: "end_turn" },
      { state: "running" },
      { state: "idle", stopReason: "end_turn" },
    ]);
    expect(
      published
        .filter(({ update }) => update.sessionUpdate === "session_message")
        .map(({ update }) => (update as { messageId: string }).messageId),
    ).toEqual(["launch-1", "send-1"]);
  });

  it("ignores a SendMessage result that arrives after the run it started ended", async () => {
    const { runtime, published } = await runningWorker();
    await runtime.finishTask("worker-1", "completed", async () => {}, "launch-1");
    await runtime.taskStarted(
      { taskId: "worker-1", toolUseId: "send-1", prompt: "Check the tests too" },
      async () => {},
    );
    // The terminal patch carries no tool id; the notification repeats it.
    await runtime.finishTask("worker-1", "failed", async () => {});
    await runtime.finishTask("worker-1", "failed", async () => {}, "send-1");

    expect(runtime.isEndedDelegation("worker-1", "send-1")).toBe(true);
    await runtime.sendMessageResumed("worker-1", async () => {}, "Check the tests too", "send-1");
    expect(states(published)).toEqual([
      { state: "running" },
      { state: "idle", stopReason: "end_turn" },
      { state: "running" },
      { state: "idle" },
    ]);
  });

  it("ends a run under an id the child used before, which the SDK falls back to", async () => {
    const { runtime, published } = await runningWorker();
    await runtime.finishTask("worker-1", "completed", async () => {}, "launch-1");
    await runtime.taskStarted({ taskId: "worker-1", toolUseId: "send-1" }, async () => {});
    await runtime.finishTask("worker-1", "completed", async () => {}, "send-1");
    // A resume that no call made runs under the launch's id again.
    await runtime.taskStarted({ taskId: "worker-1", toolUseId: "launch-1" }, async () => {});

    expect(runtime.isStaleEnd("worker-1", "send-1")).toBe(true);
    expect(runtime.isStaleEnd("worker-1", "launch-1")).toBe(false);
    await runtime.finishTask("worker-1", "completed", async () => {}, "launch-1");
    expect(states(published).at(-1)).toEqual({ state: "idle", stopReason: "end_turn" });
    expect(states(published)).toHaveLength(6);
  });

  it("reports a running patch as running, without its guessed prompt or call", async () => {
    const { runtime, published } = await runningWorker();
    await runtime.finishTask("worker-1", "completed", async () => {}, "launch-1");
    await runtime.taskResumed("worker-1", async () => {}, "An old message");

    expect(states(published).at(-1)).toEqual({ state: "running" });
    expect(
      published.filter(({ update }) => update.sessionUpdate === "session_message"),
    ).toHaveLength(1);
    expect(runtime.isStaleEnd("worker-1", "launch-1")).toBe(false);
  });

  it("resumes a child with an open request as requires_action", async () => {
    const { runtime, published } = await runningWorker();
    let answer!: () => void;
    const request = runtime.awaitingUser(
      "worker-1",
      () => new Promise<void>((resolve) => (answer = resolve)),
    );
    await Promise.resolve();
    // The work ends while the request is open; then a resume runs it again.
    await runtime.finishTask("worker-1", "completed", async () => {}, "launch-1");
    await runtime.taskStarted({ taskId: "worker-1", toolUseId: "send-1" }, async () => {});
    answer();
    await request;

    expect(states(published)).toEqual([
      { state: "running" },
      { state: "requires_action" },
      { state: "idle", stopReason: "end_turn" },
      { state: "requires_action" },
      { state: "running" },
    ]);
  });

  it("names the session that sent a resume's prompt, and no sender when it is unknown", async () => {
    const { runtime, published } = await runningWorker();
    // worker-1 launches worker-2, which the root then resumes.
    await runtime.route(launch("launch-2", { description: "Dig" }, "launch-1"), async () => {});
    await runtime.taskStarted(
      { taskId: "worker-2", toolUseId: "launch-2", subagentType: "Explore" },
      async () => {},
    );
    await runtime.finishTask("worker-2", "completed", async () => {}, "launch-2");
    await runtime.route(sendMessage("send-root"), async () => {});
    await runtime.sendMessageResumed("worker-2", async () => {}, "From the root", "send-root");
    await runtime.finishTask("worker-2", "completed", async () => {}, "send-root");
    // worker-1 resumes it too.
    await runtime.route(sendMessage("send-worker", "launch-1"), async () => {});
    await runtime.sendMessageResumed("worker-2", async () => {}, "From worker-1", "send-worker");
    await runtime.finishTask("worker-2", "completed", async () => {}, "send-worker");
    // A call the runtime never routed has no known sender.
    await runtime.sendMessageResumed("worker-2", async () => {}, "From someone", "send-unknown");

    const senders = published.flatMap(({ sessionId, update }) =>
      sessionId === "worker-2" && update.sessionUpdate === "session_message"
        ? [[update.messageId, update.senderSessionId]]
        : [],
    );
    expect(senders).toEqual([
      ["send-root", "root"],
      ["send-worker", "worker-1"],
      ["send-unknown", undefined],
    ]);
  });

  it("keeps a nested child that ends before its parent is known unexposed", async () => {
    const { runtime, published } = await runningWorker();
    // worker-2's spawning frame has not arrived, so its parent is unknown.
    await runtime.taskStarted(
      { taskId: "worker-2", toolUseId: "launch-2", subagentType: "Explore" },
      async () => {},
    );
    await expect(runtime.route(output("launch-2"), async () => {})).resolves.toBeNull();
    // A resume signal does not give the unexposed child another call.
    await runtime.taskStarted({ taskId: "worker-2", toolUseId: "send-9" }, async () => {});
    await runtime.finishTask("worker-2", "completed", async () => {});
    // The frame arrives late: it is the tool call of worker-1 that made it.
    await expect(
      runtime.route(launch("launch-2", { description: "Dig" }, "launch-1"), async () => {}),
    ).resolves.toMatchObject({ sessionId: "worker-1" });

    expect(
      published.some(
        ({ update }) =>
          (update.sessionUpdate === "subagent_update" && update.sessionId === "worker-2") ||
          (update.sessionUpdate === "session_message" && update.recipientSessionId === "worker-2"),
      ),
    ).toBe(false);
    expect(published.some(({ sessionId }) => sessionId === "worker-2")).toBe(false);
  });

  it("keeps the role in the title when a late frame names the child", async () => {
    const published: AcpSessionNotification[] = [];
    const runtime = new NativeSubagentRuntime(
      "rfd",
      "root",
      {},
      async (notification) => {
        published.push(notification);
      },
      { log: () => {} },
    );
    await runtime.taskStarted(
      { taskId: "worker-1", toolUseId: "launch-1", subagentType: "Explore" },
      async () => {},
    );
    await runtime.route(launch("launch-1", { name: "builder" }), async () => {});

    expect(published[0]?.update).toMatchObject({ title: "builder (Explore)" });
  });

  it("reports nothing when the parent is cancelled, until the SDK ends the child", async () => {
    const { runtime, published } = await runningWorker();

    await runtime.parentCancelled(async () => {});
    expect(states(published)).toEqual([{ state: "running" }]);
    await runtime.finishTask("worker-1", "killed", async () => {});
    expect(states(published).at(-1)).toEqual({ state: "idle", stopReason: "cancelled" });
  });

  it("ends the children that still run with the stream as idle, with no reason it did not see", async () => {
    // After a cancel, a child that still runs is a background child that
    // outlived it: the stream's end is no evidence that it was cancelled.
    const cancelled = await runningWorker();
    await cancelled.runtime.finishAll("cancelled", async () => {});
    expect(states(cancelled.published).at(-1)).toEqual({ state: "idle" });

    const failed = await runningWorker();
    await failed.runtime.finishAll("failed", async () => {});
    expect(states(failed.published).at(-1)).toEqual({ state: "idle" });
    // A later error event does not turn that end into a failure.
    await failed.runtime.finishTask("worker-1", "failed", async () => {}, undefined, {
      error: "boom",
    });
    expect(states(failed.published)).toHaveLength(2);
  });

  it("keeps a SendMessage result without a text from resuming a run that ended", async () => {
    const { runtime, published } = await runningWorker();
    await runtime.finishTask("worker-1", "completed", async () => {}, "launch-1");
    await runtime.taskStarted({ taskId: "worker-1", toolUseId: "send-1" }, async () => {});
    await runtime.finishTask("worker-1", "completed", async () => {}, "send-1");

    expect(runtime.isEndedDelegation("worker-1", "send-1")).toBe(true);
    await runtime.sendMessageResumed("worker-1", async () => {}, undefined, "send-1");
    expect(states(published).at(-1)).toEqual({ state: "idle", stopReason: "end_turn" });
  });

  it("reports a child that can no longer be observed as unknown", async () => {
    const { runtime, published } = await runningWorker();

    await runtime.finishTask("worker-1", "disconnected", async () => {});
    expect(states(published).at(-1)).toEqual({ state: "unknown" });
  });

  it("reports a child as requires_action while its requests are open", async () => {
    const { runtime, published } = await runningWorker();
    const first = Promise.withResolvers<string>();
    const second = Promise.withResolvers<string>();

    const answers = Promise.all([
      runtime.awaitingUser("worker-1", () => first.promise),
      runtime.awaitingUser("worker-1", () => second.promise),
    ]);
    await vi.waitFor(() => expect(states(published)).toHaveLength(2));
    first.resolve("allow");
    await first.promise;
    expect(states(published).at(-1)).toEqual({ state: "requires_action" });
    second.resolve("deny");
    await expect(answers).resolves.toEqual(["allow", "deny"]);

    expect(states(published)).toEqual([
      { state: "running" },
      { state: "requires_action" },
      { state: "running" },
    ]);
    // The root session's own requests change no child.
    await runtime.awaitingUser("root", async () => "allow");
    expect(states(published)).toHaveLength(3);
  });

  it("does not report running again for a child that ended while it waited", async () => {
    const { runtime, published } = await runningWorker();
    const answer = Promise.withResolvers<string>();

    const request = runtime.awaitingUser("worker-1", () => answer.promise);
    await vi.waitFor(() => expect(states(published)).toHaveLength(2));
    await runtime.finishTask("worker-1", "completed", async () => {});
    answer.resolve("allow");
    await request;

    expect(states(published).at(-1)).toEqual({ state: "idle", stopReason: "end_turn" });
  });
});
