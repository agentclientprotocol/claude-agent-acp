import { describe, expect, it, vi } from "vitest";
import type { AcpSessionNotification } from "../acp-subagents.js";
import {
  announceNativeSubagent,
  finishNativeSubagent,
  type HistoricalSubagent,
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
  /** The final update of the Agent call `toolCallId`, showing `text` as the
   *  reporter renders the result, under the SDK's raw output and its trailer. */
  const launchResult = (
    toolCallId: string,
    status: "completed" | "failed",
    text: string,
    parentToolUseId?: string,
  ): AcpSessionNotification =>
    ({
      sessionId: "root",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId,
        status,
        content: [{ type: "content", content: { type: "text", text } }],
        rawOutput: [{ type: "text", text: `${text}\nagentId: a1 (use SendMessage to continue)` }],
        _meta: {
          claudeCode: { toolName: "Agent", ...(parentToolUseId ? { parentToolUseId } : {}) },
        },
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

  it("reports only the observed child model and refreshes it on a model change", async () => {
    const { runtime, published } = await runningWorker({ model: "inherit" });
    const deliver = async (notification: AcpSessionNotification) => {
      const routed = await runtime.route(notification, deliver);
      if (routed) published.push(routed);
    };
    await runtime.reportModel(null, "parent-model", deliver);
    await runtime.reportModel("launch-1", "<synthetic>", deliver);
    expect(published.some(({ update }) => update.sessionUpdate === "config_option_update")).toBe(
      false,
    );

    await runtime.reportModel("launch-1", "child-model", deliver);
    await runtime.reportModel("launch-1", "child-model", deliver);
    await runtime.finishTask("worker-1", "completed", deliver, "launch-1");
    await runtime.taskStarted(
      { taskId: "worker-1", toolUseId: "resume-1", prompt: "Continue" },
      deliver,
    );
    await runtime.reportModel("resume-1", "fallback-model", deliver);

    const configs = published.filter(
      ({ update }) => update.sessionUpdate === "config_option_update",
    );
    expect(configs).toHaveLength(2);
    for (const [index, model] of ["child-model", "fallback-model"].entries()) {
      expect(configs[index]).toMatchObject({
        sessionId: "worker-1",
        update: {
          sessionUpdate: "config_option_update",
          configOptions: [
            {
              id: "model",
              category: "model",
              type: "select",
              currentValue: model,
              options: [{ value: model, name: model }],
            },
          ],
        },
      });
    }
  });

  it("buffers model observations until the child is announced", async () => {
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
    const deliver = async (notification: AcpSessionNotification) => {
      const routed = await runtime.route(notification, deliver);
      if (routed) published.push(routed);
    };
    await runtime.reportModel("launch-1", "child-model", deliver);
    expect(published).toEqual([]);
    await runtime.taskStarted(
      { taskId: "worker-1", toolUseId: "launch-1", subagentType: "Explore" },
      deliver,
    );
    expect(published).toEqual([]);
    await deliver(launch("launch-1", {}));
    expect(published.map(({ update }) => update.sessionUpdate)).toEqual([
      "subagent_update",
      "config_option_update",
    ]);
    expect(published[1]?.sessionId).toBe("worker-1");
  });

  const effortOption = (level: string) => ({
    id: "effort",
    name: "Effort",
    category: "thought_level",
    type: "select" as const,
    currentValue: level,
    options: [{ value: level, name: level }],
  });

  it("merges hook observations with model snapshots without inheriting other sessions", async () => {
    const { runtime, published } = await runningWorker();
    const deliver = async (notification: AcpSessionNotification) => {
      const routed = await runtime.route(notification, deliver);
      if (routed) published.push(routed);
    };
    await runtime.reportConfiguration("worker-1", [
      effortOption("high"),
      {
        id: "mode",
        name: "Mode",
        category: "mode",
        type: "select",
        currentValue: "plan",
        options: [{ value: "plan", name: "Plan" }],
      },
    ]);
    await runtime.reportModel("launch-1", "child-model", deliver);
    await runtime.reportConfiguration("worker-1", [effortOption("low")]);
    await runtime.reportModel("launch-1", "fallback-model", deliver);
    const configs = published.flatMap(({ update }) =>
      update.sessionUpdate === "config_option_update" ? [update.configOptions] : [],
    );
    expect(configs).toHaveLength(4);
    expect(configs.at(-1)?.map((option) => [option.id, option.currentValue])).toEqual([
      ["mode", "plan"],
      ["model", "fallback-model"],
      ["effort", "low"],
    ]);
    expect(
      configs.at(-1)?.every((option) => option.type === "select" && option.options.length === 1),
    ).toBe(true);
    await runtime.reportConfiguration("root", [effortOption("max")]);
    expect(
      published.filter(({ update }) => update.sessionUpdate === "config_option_update"),
    ).toHaveLength(4);
  });

  it("keeps hook observations pending until truthful parentage is announced", async () => {
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
    await runtime.reportConfiguration("worker-1", [effortOption("high")]);
    expect(published).toEqual([]);
    await runtime.taskStarted(
      { taskId: "worker-1", toolUseId: "launch-1", subagentType: "Explore" },
      async () => {},
    );
    expect(published).toEqual([]);
    await runtime.route(launch("launch-1", {}), async () => {});
    expect(published.map(({ sessionId, update }) => [sessionId, update.sessionUpdate])).toEqual([
      ["root", "subagent_update"],
      ["worker-1", "config_option_update"],
    ]);
  });

  it("serializes concurrent config publications and retries a failed snapshot", async () => {
    const started = deferred();
    const release = deferred();
    const published: AcpSessionNotification[] = [];
    const value = child({ announced: true });
    let fail = false;
    const runtime = new NativeSubagentRuntime(
      "rfd",
      "root",
      sessionWith(value),
      async (notification) => {
        if (fail) throw new Error("transport failed");
        published.push(notification);
        if (published.length === 1) {
          started.resolve();
          await release.promise;
        }
      },
      { log: () => {} },
    );
    const first = runtime.reportConfiguration(value.sessionId, [effortOption("high")]);
    await started.promise;
    const second = runtime.reportConfiguration(value.sessionId, [effortOption("low")]);
    release.resolve();
    await Promise.all([first, second]);
    expect(
      published.flatMap(({ update }) =>
        update.sessionUpdate === "config_option_update"
          ? update.configOptions.map((option) => option.currentValue)
          : [],
      ),
    ).toEqual(["high", "low"]);
    fail = true;
    await expect(
      runtime.reportConfiguration(value.sessionId, [effortOption("max")]),
    ).rejects.toThrow("transport failed");
    fail = false;
    await runtime.reportConfiguration(value.sessionId, [effortOption("max")]);
    expect(published).toHaveLength(3);
  });

  it("forgets unannounced configuration when the runtime is cleared", async () => {
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
    await runtime.reportConfiguration("worker-1", [effortOption("high")]);
    runtime.clear();
    await runtime.taskStarted({ taskId: "worker-1", subagentType: "Explore" }, async () => {});
    expect(published.map(({ update }) => update.sessionUpdate)).toEqual(["subagent_update"]);
  });

  it.each(["air", undefined] as const)(
    "does not report child config in the %s form",
    async (form) => {
      const deliver = vi.fn(async () => {});
      const runtime = new NativeSubagentRuntime(form, "root", {}, deliver, { log: () => {} });
      await runtime.reportModel("launch-1", "child-model", deliver);
      await runtime.reportConfiguration("worker-1", [effortOption("high")]);
      expect(deliver).not.toHaveBeenCalled();
    },
  );

  it("hides the Agent tool call, which the parent's session messages replace", async () => {
    const { runtime, control } = await runningWorker();

    expect(control).toBeNull();
    // So is a nested launch, in the child that made it.
    await expect(
      runtime.route(launch("launch-2", { description: "Dig" }, "launch-1"), async () => {}),
    ).resolves.toBeNull();
  });

  it("announces the child with the parent's labels, then sends the prompt to both transcripts", async () => {
    const { published } = await runningWorker({ name: "builder" });

    expect(published).toEqual([
      {
        sessionId: "root",
        update: {
          sessionUpdate: "subagent_update",
          sessionId: "worker-1",
          title: "builder (Explore)",
          description: "Fix the build",
          capabilities: { cancel: {} },
          state: { state: "running" },
        },
      },
      {
        sessionId: "root",
        update: {
          sessionUpdate: "session_message",
          messageId: "launch-1",
          senderSessionId: "root",
          recipientSessionId: "worker-1",
          recipientMessageId: "launch-1",
          content: [{ type: "text", text: "Make it pass" }],
        },
      },
      {
        sessionId: "worker-1",
        update: {
          sessionUpdate: "session_message",
          messageId: "launch-1",
          senderSessionId: "root",
          recipientSessionId: "worker-1",
          senderMessageId: "launch-1",
          content: [{ type: "text", text: "Make it pass" }],
        },
      },
    ]);
  });

  it("sends a foreground child's answer to its parent as the child's reply", async () => {
    const { runtime, published } = await runningWorker();

    await expect(
      runtime.route(launchResult("launch-1", "completed", "The build passes."), async () => {}),
    ).resolves.toBeNull();

    expect(published.at(-1)).toEqual({
      sessionId: "root",
      update: {
        sessionUpdate: "session_message",
        messageId: "launch-1:reply",
        senderSessionId: "worker-1",
        recipientSessionId: "root",
        content: [{ type: "text", text: "The build passes." }],
      },
    });
  });

  describe("a child's SubagentHandback call", () => {
    /** An update of the child's hand-back call. Only its first update names the tool. */
    const handback = (
      status: "pending" | "completed" | "failed",
      rawInput?: Record<string, unknown>,
    ): AcpSessionNotification =>
      ({
        sessionId: "root",
        update: {
          sessionUpdate: status === "pending" ? "tool_call" : "tool_call_update",
          toolCallId: "handback-1",
          status,
          ...(status === "pending" ? { title: "SubagentHandback" } : {}),
          ...(rawInput ? { rawInput } : {}),
          _meta: {
            claudeCode: {
              parentToolUseId: "launch-1",
              ...(status === "pending" ? { toolName: "SubagentHandback" } : {}),
            },
          },
        },
      }) as AcpSessionNotification;
    const pointer = "This agent's report was delivered to you as a message.";

    it("is the child's message to its parent, which replaces the launch's reply", async () => {
      const { runtime, published } = await runningWorker();
      const before = published.length;

      // The streamed call starts without input; a refinement brings the report.
      const refinement = {
        sessionId: "root",
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "handback-1",
          rawInput: { message: "PONG" },
          _meta: { claudeCode: { parentToolUseId: "launch-1" } },
        },
      } as AcpSessionNotification;
      for (const update of [
        handback("pending", {}),
        refinement,
        handback("completed"),
        launchResult("launch-1", "completed", pointer),
      ]) {
        await expect(runtime.route(update, async () => {})).resolves.toBeNull();
      }

      const message = {
        sessionUpdate: "session_message",
        messageId: "handback-1",
        senderSessionId: "worker-1",
        recipientSessionId: "root",
        content: [{ type: "text", text: "PONG" }],
      };
      expect(published.slice(before)).toEqual([
        { sessionId: "worker-1", update: { ...message, recipientMessageId: "handback-1" } },
        { sessionId: "root", update: { ...message, senderMessageId: "handback-1" } },
      ]);
    });

    it("stays a tool call of the child when it fails, and the launch's result is the reply", async () => {
      const { runtime, published } = await runningWorker();

      await runtime.route(handback("pending", { message: "PONG" }), async () => {});
      await expect(runtime.route(handback("failed"), async () => {})).resolves.toMatchObject({
        sessionId: "worker-1",
        update: { sessionUpdate: "tool_call", toolCallId: "handback-1", status: "failed" },
      });
      await runtime.route(launchResult("launch-1", "completed", "PONG"), async () => {});

      expect(published.at(-1)).toMatchObject({
        sessionId: "root",
        update: { messageId: "launch-1:reply", content: [{ type: "text", text: "PONG" }] },
      });
    });
  });

  it("reports no reply for a failed launch, whose child's idle state reports the failure", async () => {
    const { runtime, published } = await runningWorker();
    const before = published.length;

    await expect(
      runtime.route(launchResult("launch-1", "failed", "The build still fails."), async () => {}),
    ).resolves.toBeNull();

    expect(published).toHaveLength(before);
  });

  it("reports no reply for a background launch, which completes before its child works", async () => {
    const { runtime, published } = await runningWorker({ run_in_background: true });
    const before = published.length;

    await expect(
      runtime.route(
        launchResult("launch-1", "completed", "Async agent launched successfully."),
        async () => {},
      ),
    ).resolves.toBeNull();

    expect(published).toHaveLength(before);
  });

  it("recognizes the adapter's report that closes a hidden launch, which has no tool name", async () => {
    const { runtime, published } = await runningWorker();
    // The report that closes a call the cancel left open, for a v2 client.
    const close = (toolCallId: string): AcpSessionNotification => ({
      sessionId: "root",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId,
        status: "cancelled" as "failed",
        content: [],
      },
    });
    const before = published.length;

    // The child was exposed, so its idle state reports the stop.
    await expect(runtime.route(close("launch-1"), async () => {})).resolves.toBeNull();
    expect(published).toHaveLength(before);
    // A launch whose child never started is shown after all.
    await runtime.route(launch("launch-9", { description: "Dig" }), async () => {});
    await expect(runtime.route(close("launch-9"), async () => {})).resolves.toMatchObject({
      sessionId: "root",
      update: { sessionUpdate: "tool_call", toolCallId: "launch-9", status: "cancelled" },
    });
  });

  it("keeps a launch whose child never started as a tool call with its final status", async () => {
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
    for (const [toolCallId, status] of [
      ["launch-ok", "completed"],
      ["launch-bad", "failed"],
    ] as const) {
      await expect(
        runtime.route(launch(toolCallId, { description: "Dig" }), async () => {}),
      ).resolves.toBeNull();
      await expect(
        runtime.route(launchResult(toolCallId, status, "Done"), async () => {}),
      ).resolves.toMatchObject({
        sessionId: "root",
        update: { sessionUpdate: "tool_call", toolCallId, status },
      });
    }
    // A background launch completes before its child starts, so it stays hidden.
    await runtime.route(launch("launch-bg", { run_in_background: true }), async () => {});
    await expect(
      runtime.route(launchResult("launch-bg", "completed", "Async agent launched"), async () => {}),
    ).resolves.toBeNull();
    expect(published).toEqual([]);
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
    // The SendMessage call stays a tool call of its sender, so its message has
    // only the child's view, with no reference.
    expect(published.filter(({ update }) => update.sessionUpdate === "session_message")).toEqual([
      expect.objectContaining({ sessionId: "root" }),
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
        .map(
          ({ sessionId, update }) => `${sessionId} ${(update as { messageId: string }).messageId}`,
        ),
    ).toEqual(["root launch-1", "worker-1 launch-1", "worker-1 send-1"]);
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
      { state: "idle", stopReason: "error" },
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
      published.filter(
        ({ sessionId, update }) =>
          sessionId === "worker-1" && update.sessionUpdate === "session_message",
      ),
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

  describe("an agent from before a load or resume", () => {
    const echoer: HistoricalSubagent = {
      agentId: "echoer-1",
      launchId: "launch-1",
      name: "echoer",
      agentType: "Explore",
      description: "Echo a word",
    };
    const coordinator: HistoricalSubagent = {
      agentId: "coordinator-1",
      launchId: "launch-c",
      name: "coordinator",
      agentType: "general-purpose",
      description: "Coordinate",
    };
    const nestedEchoer: HistoricalSubagent = { ...echoer, parentAgentId: "coordinator-1" };

    /** A runtime that knows no child, with the session history's lineage of each agent. */
    function reloaded(lineages: Record<string, readonly HistoricalSubagent[]>) {
      const published: AcpSessionNotification[] = [];
      const log = vi.fn();
      const lineage = vi.fn(async (agentId: string) => lineages[agentId] ?? []);
      const runtime = new NativeSubagentRuntime(
        "rfd",
        "root",
        {},
        async (notification) => {
          published.push(notification);
        },
        { log },
        lineage,
      );
      return { runtime, published, lineage, log };
    }
    const announcements = (published: AcpSessionNotification[]) =>
      published.flatMap(({ sessionId, update }) =>
        update.sessionUpdate === "subagent_update" && update.title
          ? [`${sessionId} -> ${update.sessionId} ${JSON.stringify(update.state ?? null)}`]
          : [],
      );

    it("restores the agent that a SendMessage call resumes under its id, and routes its run to it", async () => {
      const { runtime, published } = reloaded({ "echoer-1": [echoer] });
      await runtime.route(sendMessage("send-1"), async () => {});
      await runtime.taskStarted(
        { taskId: "echoer-1", toolUseId: "send-1", subagentType: "Explore", prompt: "Say PING" },
        async () => {},
      );
      // Claude Code sends the resumed run's messages under the call that
      // launched the agent.
      await expect(runtime.route(output("launch-1"), async () => {})).resolves.toMatchObject({
        sessionId: "echoer-1",
      });
      await runtime.finishTask("echoer-1", "completed", async () => {}, "send-1");

      expect(published).toEqual([
        {
          sessionId: "root",
          update: {
            sessionUpdate: "subagent_update",
            sessionId: "echoer-1",
            title: "echoer (Explore)",
            description: "Echo a word",
            capabilities: { cancel: {} },
            state: { state: "running" },
          },
        },
        {
          sessionId: "echoer-1",
          update: {
            sessionUpdate: "session_message",
            messageId: "send-1",
            senderSessionId: "root",
            recipientSessionId: "echoer-1",
            content: [{ type: "text", text: "Say PING" }],
          },
        },
        {
          sessionId: "root",
          update: {
            sessionUpdate: "subagent_update",
            sessionId: "echoer-1",
            state: { state: "idle", stopReason: "end_turn" },
          },
        },
      ]);
    });

    it("announces the agent's ancestors first, parent before child, with no work state", async () => {
      const { runtime, published } = reloaded({ "echoer-1": [coordinator, nestedEchoer] });
      await runtime.route(sendMessage("send-1"), async () => {});
      await runtime.taskStarted(
        { taskId: "echoer-1", toolUseId: "send-1", prompt: "Say PING" },
        async () => {},
      );

      expect(announcements(published)).toEqual([
        "root -> coordinator-1 null",
        'coordinator-1 -> echoer-1 {"state":"running"}',
      ]);
      expect(published[0]?.update).toEqual({
        sessionUpdate: "subagent_update",
        sessionId: "coordinator-1",
        title: "coordinator (general-purpose)",
        description: "Coordinate",
      });
    });

    it("announces an ancestor once, for each agent under it that resumes", async () => {
      const sibling: HistoricalSubagent = {
        agentId: "sibling-1",
        launchId: "launch-s",
        name: "sibling",
        parentAgentId: "coordinator-1",
      };
      const { runtime, published } = reloaded({
        "echoer-1": [coordinator, nestedEchoer],
        "sibling-1": [coordinator, sibling],
      });
      await runtime.route(sendMessage("send-1"), async () => {});
      await runtime.taskStarted({ taskId: "echoer-1", toolUseId: "send-1" }, async () => {});
      await runtime.route(sendMessage("send-2"), async () => {});
      await runtime.taskStarted({ taskId: "sibling-1", toolUseId: "send-2" }, async () => {});

      expect(announcements(published)).toEqual([
        "root -> coordinator-1 null",
        'coordinator-1 -> echoer-1 {"state":"running"}',
        'coordinator-1 -> sibling-1 {"state":"running"}',
      ]);
    });

    it("delivers the output that waited for the agent once it is restored", async () => {
      const { runtime } = reloaded({ "echoer-1": [echoer] });
      await runtime.route(sendMessage("send-1"), async () => {});
      await expect(runtime.route(output("launch-1"), async () => {})).resolves.toBeNull();

      const delivered: AcpSessionNotification[] = [];
      await runtime.taskStarted({ taskId: "echoer-1", toolUseId: "send-1" }, async (update) => {
        delivered.push(update);
      });

      expect(delivered).toEqual([output("launch-1")]);
    });

    it("restores the agent at the SendMessage result when no task_started came", async () => {
      const { runtime, published } = reloaded({ "echoer-1": [echoer] });
      await runtime.route(sendMessage("send-1"), async () => {});
      await runtime.sendMessageResumed("echoer-1", async () => {}, "Say PING", "send-1");

      expect(
        published.map(({ sessionId, update }) => `${sessionId} ${update.sessionUpdate}`),
      ).toEqual(["root subagent_update", "echoer-1 session_message"]);
    });

    it("keeps an agent that the history cannot place, or not read, unexposed", async () => {
      const { runtime, published, lineage, log } = reloaded({});
      lineage.mockRejectedValueOnce(new Error("EACCES"));
      for (const [taskId, toolUseId] of [
        ["unreadable-1", "send-1"],
        ["lost-1", "send-2"],
      ] as const) {
        await runtime.route(sendMessage(toolUseId), async () => {});
        await runtime.taskStarted(
          { taskId, toolUseId, subagentType: "Explore", prompt: "Hi" },
          async () => {},
        );
        await expect(runtime.route(output(toolUseId), async () => {})).resolves.toBeNull();
        await runtime.finishTask(taskId, "completed", async () => {}, toolUseId);
      }

      expect(lineage.mock.calls).toEqual([["unreadable-1"], ["lost-1"]]);
      expect(log).toHaveBeenCalledWith(expect.stringContaining("EACCES"));
      expect(published).toEqual([]);
    });

    it("reads no history for a new launch, or for a child it knows", async () => {
      const { runtime, lineage } = reloaded({});
      await runtime.route(launch("launch-1", { description: "Fix the build" }), async () => {});
      await runtime.taskStarted(
        { taskId: "worker-1", toolUseId: "launch-1", subagentType: "Explore" },
        async () => {},
      );
      await runtime.finishTask("worker-1", "completed", async () => {}, "launch-1");
      await runtime.route(sendMessage("send-1"), async () => {});
      await runtime.taskStarted({ taskId: "worker-1", toolUseId: "send-1" }, async () => {});

      expect(lineage).not.toHaveBeenCalled();
    });
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
    // The frame arrives late, and the launch stays hidden while it runs. Its
    // child was never exposed, so its result makes it a tool call of worker-1.
    await expect(
      runtime.route(launch("launch-2", { description: "Dig" }, "launch-1"), async () => {}),
    ).resolves.toBeNull();
    await expect(
      runtime.route(launchResult("launch-2", "completed", "Dug", "launch-1"), async () => {}),
    ).resolves.toMatchObject({
      sessionId: "worker-1",
      update: { sessionUpdate: "tool_call", toolCallId: "launch-2", status: "completed" },
    });

    expect(
      published.some(
        ({ update }) =>
          (update.sessionUpdate === "subagent_update" && update.sessionId === "worker-2") ||
          (update.sessionUpdate === "session_message" && update.recipientSessionId === "worker-2"),
      ),
    ).toBe(false);
    expect(published.some(({ sessionId }) => sessionId === "worker-2")).toBe(false);
  });

  describe("a nested child whose own parent is not announced yet", () => {
    /** A runtime, the updates it sends in order, and the deliver function of
     *  the agent, which routes a buffered update again (as `sendUpdate` does). */
    function setup() {
      const sent: AcpSessionNotification[] = [];
      const runtime: NativeSubagentRuntime = new NativeSubagentRuntime(
        "rfd",
        "root",
        {},
        async (notification) => {
          sent.push(notification);
        },
        { log: () => {} },
      );
      const deliver = async (notification: AcpSessionNotification): Promise<void> => {
        const routed = await runtime.route(notification, deliver);
        if (routed) sent.push(routed);
      };
      return { runtime, sent, deliver };
    }
    /** The announcements, as [parent, child], and the sessions that got
     *  traffic before each was announced. */
    function check(sent: AcpSessionNotification[]) {
      const announced = new Set(["root"]);
      const early: string[] = [];
      const announcements: [string, string][] = [];
      for (const { sessionId, update } of sent) {
        if (!announced.has(sessionId)) early.push(sessionId);
        if (update.sessionUpdate === "subagent_update" && !announced.has(update.sessionId)) {
          announced.add(update.sessionId);
          announcements.push([sessionId, update.sessionId]);
        }
      }
      return { announcements, early };
    }

    it("announces it after that parent, when the parent's task started before its launch frame", async () => {
      const { runtime, sent, deliver } = setup();
      // worker-1 is known, but its launch frame has not come: not announced.
      await runtime.taskStarted(
        { taskId: "worker-1", toolUseId: "launch-1", subagentType: "Explore" },
        deliver,
      );
      await deliver(launch("launch-2", { description: "Dig" }, "launch-1"));
      await runtime.taskStarted(
        { taskId: "worker-2", toolUseId: "launch-2", subagentType: "Explore" },
        deliver,
      );
      await deliver(launch("launch-1", { description: "Fix the build" }));

      expect(check(sent)).toEqual({
        announcements: [
          ["root", "worker-1"],
          ["worker-1", "worker-2"],
        ],
        early: [],
      });
    });

    it("never announces it under the root, when its parent is not known yet", async () => {
      const { runtime, sent, deliver } = setup();
      await deliver(launch("launch-2", { description: "Dig" }, "launch-1"));
      await runtime.taskStarted(
        { taskId: "worker-2", toolUseId: "launch-2", subagentType: "Explore" },
        deliver,
      );
      await deliver(launch("launch-1", { description: "Fix the build" }));
      await runtime.taskStarted(
        { taskId: "worker-1", toolUseId: "launch-1", subagentType: "Explore" },
        deliver,
      );

      expect(check(sent)).toEqual({
        announcements: [
          ["root", "worker-1"],
          ["worker-1", "worker-2"],
        ],
        early: [],
      });
    });
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

  describe("a cancel of one child by the client", () => {
    it("stops the child's task, and leaves its end to the SDK", async () => {
      const { runtime, published } = await runningWorker();
      const stop = vi.fn(async (_taskId: string) => {});

      await expect(runtime.cancelChild("worker-1", stop)).resolves.toBe(true);

      expect(stop).toHaveBeenCalledExactlyOnceWith("worker-1");
      // Accepting the stop is no evidence that the child stopped.
      expect(states(published)).toEqual([{ state: "running" }]);
      await runtime.finishTask("worker-1", "killed", async () => {});
      expect(states(published)).toEqual([
        { state: "running" },
        { state: "idle", stopReason: "cancelled" },
      ]);
    });

    it("stops nothing for a session that is no child, or for AIR, which grants no cancel", async () => {
      const { runtime } = await runningWorker();
      const stop = vi.fn(async (_taskId: string) => {});
      const air = new NativeSubagentRuntime("air", "root", {}, async () => {}, { log: () => {} });
      await air.route(control("tool_call"), async () => {});
      await air.taskStarted(
        { taskId: "child-1", toolUseId: "agent-tool", subagentType: "Explore" },
        async () => {},
      );

      await expect(runtime.cancelChild("root", stop)).resolves.toBe(false);
      await expect(runtime.cancelChild("other-1", stop)).resolves.toBe(false);
      await expect(air.cancelChild("child-1", stop)).resolves.toBe(false);
      expect(stop).not.toHaveBeenCalled();
    });
  });

  describe("a request that Claude Code withdraws", () => {
    /**
     * A request of `sessionId` (`worker-1` by default) that fails once
     * `withdrawal` aborts, as the agent's requests do. It resolves with how
     * it ended.
     */
    const withdrawable = (
      runtime: NativeSubagentRuntime,
      withdrawal: AbortController,
      sessionId = "worker-1",
    ) =>
      runtime
        .awaitingUser(
          sessionId,
          () =>
            new Promise<string>((_answer, reject) => {
              const fail = () => reject(new Error("Tool use aborted"));
              if (withdrawal.signal.aborted) fail();
              else withdrawal.signal.addEventListener("abort", fail);
            }),
          withdrawal.signal,
        )
        .catch((error: Error) => error.message);

    it("does not report running for a request that a cancel withdraws, and leaves the child's end to the SDK", async () => {
      const { runtime, published } = await runningWorker();
      const withdrawal = new AbortController();
      const request = withdrawable(runtime, withdrawal);
      await vi.waitFor(() => expect(states(published)).toHaveLength(2));

      // Claude Code's interrupt withdraws the request of the child it stops,
      // then the SDK reports that it killed the child.
      await runtime.parentCancelled(async () => {});
      withdrawal.abort();
      await expect(request).resolves.toBe("Tool use aborted");
      expect(states(published)).toEqual([{ state: "running" }, { state: "requires_action" }]);

      await runtime.finishTask("worker-1", "killed", async () => {});
      expect(states(published)).toEqual([
        { state: "running" },
        { state: "requires_action" },
        { state: "idle", stopReason: "cancelled" },
      ]);
    });

    it("does not report running for a request that the client's cancel of the child withdraws", async () => {
      const { runtime, published } = await runningWorker();
      const withdrawal = new AbortController();
      const request = withdrawable(runtime, withdrawal);
      await vi.waitFor(() => expect(states(published)).toHaveLength(2));

      await runtime.cancelChild("worker-1", async () => withdrawal.abort());
      await expect(request).resolves.toBe("Tool use aborted");

      expect(states(published)).toEqual([{ state: "running" }, { state: "requires_action" }]);
    });

    it("does not report running for a request of a foreground subagent that the cancel of its parent stops", async () => {
      const { runtime, published } = await runningWorker();
      // worker-1 runs a foreground subagent, which asks.
      await runtime.route(launch("launch-2", { description: "Dig" }, "launch-1"), async () => {});
      await runtime.taskStarted(
        { taskId: "digger-1", toolUseId: "launch-2", subagentType: "Explore" },
        async () => {},
      );
      const withdrawal = new AbortController();
      const request = withdrawable(runtime, withdrawal, "digger-1");
      await vi.waitFor(() =>
        expect(published.at(-1)?.update).toMatchObject({
          sessionId: "digger-1",
          state: { state: "requires_action" },
        }),
      );

      // Claude Code also stops the subagent that worker-1 waits on.
      await runtime.cancelChild("worker-1", async () => withdrawal.abort());
      await expect(request).resolves.toBe("Tool use aborted");

      expect(published.at(-1)?.update).toMatchObject({
        sessionId: "digger-1",
        state: { state: "requires_action" },
      });
    });

    it("reports running for a request that Claude Code withdraws without a cancel, since the child goes on", async () => {
      const { runtime, published } = await runningWorker();
      const withdrawal = new AbortController();
      const request = withdrawable(runtime, withdrawal);
      await vi.waitFor(() => expect(states(published)).toHaveLength(2));

      // A hook answered the request in the user's place.
      withdrawal.abort();
      await expect(request).resolves.toBe("Tool use aborted");

      expect(states(published)).toEqual([
        { state: "running" },
        { state: "requires_action" },
        { state: "running" },
      ]);
    });

    it("keeps the open request of a child that outlives a cancel, and reports running once the user answers it", async () => {
      const { runtime, published } = await runningWorker();
      const answer = Promise.withResolvers<string>();
      const request = runtime.awaitingUser("worker-1", () => answer.promise);
      await vi.waitFor(() => expect(states(published)).toHaveLength(2));

      await runtime.parentCancelled(async () => {});
      expect(states(published)).toEqual([{ state: "running" }, { state: "requires_action" }]);

      // The cancel did not resolve the request: the user can still answer it.
      answer.resolve("allow");
      await request;
      expect(states(published)).toEqual([
        { state: "running" },
        { state: "requires_action" },
        { state: "running" },
      ]);
    });

    it("does not count a cancel that came before the request opened", async () => {
      const { runtime, published } = await runningWorker();
      await runtime.parentCancelled(async () => {});
      const withdrawal = new AbortController();
      const request = withdrawable(runtime, withdrawal);
      await vi.waitFor(() => expect(states(published)).toHaveLength(2));

      withdrawal.abort();
      await request;

      expect(states(published).at(-1)).toEqual({ state: "running" });
    });

    it.each([
      { first: "withdrawn", last: "answered", running: true },
      { first: "answered", last: "withdrawn", running: false },
      { first: "withdrawn", last: "withdrawn", running: false },
    ])(
      "lets the last of two requests decide: $first, then $last",
      async ({ first, last, running }) => {
        const { runtime, published } = await runningWorker();
        const withdrawals = [new AbortController(), new AbortController()];
        const answers = [Promise.withResolvers<string>(), Promise.withResolvers<string>()];
        const requests = withdrawals.map((withdrawal, index) =>
          runtime
            .awaitingUser("worker-1", () => answers[index].promise, withdrawal.signal)
            .catch((error: Error) => error.message),
        );
        await vi.waitFor(() => expect(states(published)).toHaveLength(2));
        await runtime.parentCancelled(async () => {});

        const end = async (index: number, how: string) => {
          if (how === "answered") {
            answers[index].resolve("allow");
          } else {
            withdrawals[index].abort();
            answers[index].reject(new Error("Tool use aborted"));
          }
          await requests[index];
        };
        await end(0, first);
        // Only the last request to end reports.
        expect(states(published)).toHaveLength(2);
        await end(1, last);

        expect(states(published).at(-1)).toEqual({
          state: running ? "running" : "requires_action",
        });
      },
    );
  });
});

describe("NativeSubagentRuntime in the AIR form, for an agent from before a load or resume", () => {
  const worker: HistoricalSubagent = {
    agentId: "worker-1",
    launchId: "launch-1",
    name: "worker",
    agentType: "Explore",
    description: "Inspect",
  };
  const coordinator: HistoricalSubagent = {
    agentId: "coordinator-1",
    launchId: "launch-c",
    name: "coordinator",
    agentType: "general-purpose",
    description: "Coordinate",
  };
  const NOW = 1_760_000_000_000;

  const output = (parentToolUseId: string, text = "working"): AcpSessionNotification =>
    ({
      sessionId: "root",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text },
        _meta: { claudeCode: { parentToolUseId } },
      },
    }) as AcpSessionNotification;
  const agentCall = (toolCallId: string): AcpSessionNotification => {
    const launch = control("tool_call", "pending");
    return { ...launch, update: { ...launch.update, toolCallId } } as AcpSessionNotification;
  };
  const spawned = (published: AcpSessionNotification[]) =>
    published.flatMap(({ sessionId, update }) =>
      update.sessionUpdate === "subagent_spawned"
        ? [`${sessionId} -> ${update.subagentSessionId}`]
        : [],
    );

  /** A runtime that knows no child, with the history's lineages and launches. */
  function reloaded(
    lineages: Record<string, readonly HistoricalSubagent[]>,
    { lookUpLaunches = true } = {},
  ) {
    const published: AcpSessionNotification[] = [];
    const log = vi.fn();
    const lineage = vi.fn(async (agentId: string) => lineages[agentId] ?? []);
    const launchedAgent = vi.fn(
      async (launchId: string) =>
        Object.values(lineages)
          .flat()
          .find((entry) => entry.launchId === launchId)?.agentId,
    );
    const runtime = new NativeSubagentRuntime(
      "air",
      "root",
      {},
      async (notification) => {
        published.push(notification);
      },
      { log },
      lineage,
      lookUpLaunches ? launchedAgent : undefined,
    );
    return { runtime, published, lineage, launchedAgent, log };
  }

  /** Runs `test` with the clock at {@link NOW}. */
  async function atNow(test: () => Promise<void>) {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    try {
      await test();
    } finally {
      vi.useRealTimers();
    }
  }

  /** Output waits under the launch id; a resume signal restores the agent and a later resume numbers on from the first id. */
  it("restores the agent on a resume signal, delivers its buffered output, and numbers later generations from it", async () => {
    await atNow(async () => {
      const { runtime, published } = reloaded({ "worker-1": [worker] }, { lookUpLaunches: false });
      const delivered: AcpSessionNotification[] = [];
      const deliver = async (n: AcpSessionNotification) => void delivered.push(n);

      await expect(runtime.route(output("launch-1", "early"), deliver)).resolves.toBeNull();
      await runtime.taskResumed("worker-1", deliver, "Say PING");

      expect(spawned(published)).toEqual([`root -> worker-1:generation:${NOW}`]);
      expect(published[0]?.update).toMatchObject({
        sessionUpdate: "subagent_spawned",
        subagentSessionId: `worker-1:generation:${NOW}`,
        name: "worker",
        task: "Inspect",
        prompt: "Say PING",
      });
      expect(delivered).toHaveLength(1);
      await expect(runtime.route(output("launch-1"), deliver)).resolves.toMatchObject({
        sessionId: `worker-1:generation:${NOW}`,
      });

      await runtime.finishTask("worker-1", "completed", deliver);
      await runtime.taskResumed("worker-1", deliver);
      expect(spawned(published)).toEqual([
        `root -> worker-1:generation:${NOW}`,
        `root -> worker-1:generation:${NOW + 1}`,
      ]);
    });
  });

  /** A message under a launch id that the history knows restores the agent with no resume signal. */
  it("restores the agent from a message under an unknown parent_tool_use_id alone, and routes it", async () => {
    const { runtime, published, launchedAgent } = reloaded({ "worker-1": [worker] });
    const delivered: AcpSessionNotification[] = [];
    const deliver = async (n: AcpSessionNotification) => void delivered.push(n);

    await expect(runtime.route(output("launch-1"), deliver)).resolves.toBeNull();

    expect(launchedAgent).toHaveBeenCalledWith("launch-1");
    expect(spawned(published)).toHaveLength(1);
    expect(delivered).toHaveLength(1);
    await expect(runtime.route(output("launch-1"), deliver)).resolves.toMatchObject({
      sessionId: expect.stringMatching(/^worker-1:generation:\d+$/),
    });
  });

  /** An Agent call seen in this process waits for its task_started and is never looked up. */
  it("buffers a new Agent call of this process until its task_started, with no history lookup", async () => {
    const { runtime, published, launchedAgent } = reloaded({});
    const delivered: AcpSessionNotification[] = [];
    const deliver = async (n: AcpSessionNotification) => void delivered.push(n);

    await runtime.route(agentCall("launch-2"), deliver);
    await expect(runtime.route(output("launch-2"), deliver)).resolves.toBeNull();
    expect(launchedAgent).not.toHaveBeenCalled();
    expect(published).toEqual([]);

    await runtime.taskStarted(
      { taskId: "fresh-1", toolUseId: "launch-2", subagentType: "Explore" },
      deliver,
    );
    expect(spawned(published)).toEqual(["root -> fresh-1"]);
    expect(delivered).toHaveLength(1);
  });

  /** A launch id that resolves to no agent is looked up once. */
  it("looks up a launch id that the history does not know only once", async () => {
    const { runtime, published, launchedAgent } = reloaded({});

    await runtime.route(output("launch-9"), async () => {});
    await runtime.route(output("launch-9"), async () => {});

    expect(launchedAgent).toHaveBeenCalledTimes(1);
    expect(published).toEqual([]);
  });

  /** An agent launched by a live restored agent opens under it. */
  it("opens a nested agent under its parent while the parent is live", async () => {
    const { runtime, published } = reloaded({
      "coordinator-1": [coordinator],
      "worker-1": [coordinator, { ...worker, parentAgentId: "coordinator-1" }],
    });
    await runtime.taskResumed("coordinator-1", async () => {});
    await runtime.taskResumed("worker-1", async () => {});

    const parentId = (published[0]?.update as { subagentSessionId: string }).subagentSessionId;
    expect(published[1]?.sessionId).toBe(parentId);
    expect(spawned(published)).toEqual([
      `root -> ${parentId}`,
      expect.stringMatching(/^coordinator-1:generation:\d+ -> worker-1:generation:\d+$/),
    ]);
  });

  /** An agent whose parent is not live opens under the root. */
  it("opens a nested agent under the root when its parent is not live", async () => {
    const { runtime, published } = reloaded({
      "worker-1": [coordinator, { ...worker, parentAgentId: "coordinator-1" }],
    });
    await runtime.taskResumed("worker-1", async () => {});

    expect(published[0]?.sessionId).toBe("root");
  });

  /** An agent that the history cannot place is not announced. */
  it("opens nothing when the history cannot place the agent", async () => {
    const { runtime, published, lineage } = reloaded({});

    await runtime.taskResumed("worker-1", async () => {});

    expect(lineage).toHaveBeenCalledWith("worker-1");
    expect(published).toEqual([]);
  });

  /** After clear(), a resume signal restores the agent again. */
  it("restores the agent again after the runtime was cleared", async () => {
    const { runtime, published } = reloaded({ "worker-1": [worker] });
    await runtime.taskResumed("worker-1", async () => {});
    runtime.clear();
    await runtime.taskResumed("worker-1", async () => {});

    const ids = spawned(published);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  });

  /** After every child ended, a launch id that resolved to nothing is looked up again. */
  it("looks up an unknown launch again after the runtime ended every child", async () => {
    const { runtime, launchedAgent } = reloaded({});
    await runtime.route(output("launch-9"), async () => {});
    await runtime.finishAll("cancelled", async () => {});
    await runtime.route(output("launch-9"), async () => {});

    expect(launchedAgent).toHaveBeenCalledTimes(2);
  });

  /** Three signals for one agent in flight together open a single generation. */
  it("opens one generation for a message, a resumedAgentId and a task_updated that arrive together", async () => {
    const { runtime, published, lineage } = reloaded({ "worker-1": [worker] });
    const delivered: AcpSessionNotification[] = [];
    const deliver = async (n: AcpSessionNotification) => void delivered.push(n);

    await Promise.all([
      runtime.route(output("launch-1"), deliver),
      runtime.sendMessageResumed("worker-1", deliver, "Say PING", "send-1"),
      runtime.taskResumed("worker-1", deliver),
    ]);

    expect(spawned(published)).toHaveLength(1);
    expect(lineage).toHaveBeenCalledTimes(1);
    expect(delivered).toHaveLength(1);
  });

  /** After a lineage that places no agent, every later message skips the history. */
  it("reads the history once for a launch whose agent cannot be placed", async () => {
    const published: AcpSessionNotification[] = [];
    const lineage = vi.fn(async () => []);
    const launchedAgent = vi.fn(async () => "worker-1");
    const runtime = new NativeSubagentRuntime(
      "air",
      "root",
      {},
      async (notification) => void published.push(notification),
      { log: vi.fn() },
      lineage,
      launchedAgent,
    );

    for (let i = 0; i < 5; i++) await runtime.route(output("launch-1"), async () => {});

    expect(launchedAgent).toHaveBeenCalledTimes(1);
    expect(lineage).toHaveBeenCalledTimes(1);
    expect(published).toEqual([]);
  });

  /** A clear() while the lineage is read leaves the stale restore announcing nothing. */
  it("announces nothing for a restore that a clear() overtook", async () => {
    const release = deferred();
    const published: AcpSessionNotification[] = [];
    const runtime = new NativeSubagentRuntime(
      "air",
      "root",
      {},
      async (notification) => void published.push(notification),
      { log: vi.fn() },
      async () => {
        await release.promise;
        return [worker];
      },
    );

    const resumed = runtime.taskResumed("worker-1", async () => {});
    runtime.clear();
    release.resolve();
    await resumed;

    expect(published).toEqual([]);
  });

  const sendMessage = (toolCallId: string): AcpSessionNotification =>
    ({
      sessionId: "root",
      update: {
        sessionUpdate: "tool_call",
        toolCallId,
        title: "SendMessage",
        status: "pending",
        _meta: { claudeCode: { toolName: "SendMessage" } },
      },
    }) as AcpSessionNotification;

  /** A SendMessage task_started restores the agent, and its id and the launch id both route. */
  it("restores the agent from a task_started under a SendMessage id", async () => {
    const { runtime, published } = reloaded({ "worker-1": [worker] }, { lookUpLaunches: false });
    const deliver = async () => {};

    await runtime.route(sendMessage("send-1"), deliver);
    await runtime.taskStarted(
      { taskId: "worker-1", toolUseId: "send-1", subagentType: "Explore", prompt: "Say PING" },
      deliver,
    );
    await expect(runtime.route(output("launch-1"), deliver)).resolves.toMatchObject({
      sessionId: expect.stringMatching(/^worker-1:generation:\d+$/),
    });
    await runtime.finishTask("worker-1", "completed", deliver, "send-1");

    expect(spawned(published)).toHaveLength(1);
    expect(published[0]?.update).toMatchObject({ prompt: "Say PING" });
    expect(published.at(-1)?.update.sessionUpdate).toBe("subagent_state_update");
  });

  /** A task_started without a subagent type, such as a background shell, reads no history. */
  it("does not read the history for a task_started without a subagent type", async () => {
    const { runtime, lineage } = reloaded({ "worker-1": [worker] });

    await runtime.route(sendMessage("send-1"), async () => {});
    await runtime.taskStarted({ taskId: "shell-1", toolUseId: "send-1" }, async () => {});

    expect(lineage).not.toHaveBeenCalled();
  });

  /** A new Agent whose task_started precedes its tool call frame opens under its bare id and waits. */
  it("opens a new Agent whose task_started comes before its frame as the bare id, unannounced", async () => {
    const { runtime, published, lineage } = reloaded({ "worker-1": [worker] });

    await runtime.taskStarted(
      { taskId: "worker-1", toolUseId: "launch-1", subagentType: "Explore" },
      async () => {},
    );

    expect(lineage).not.toHaveBeenCalled();
    expect(published).toEqual([]);
    await runtime.route(agentCall("launch-1"), async () => {});
    expect(spawned(published)).toEqual(["root -> worker-1"]);
  });
});
