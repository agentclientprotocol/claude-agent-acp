import { describe, expect, it } from "vitest";
import type { AcpSessionNotification } from "../acp-subagents.js";
import { AsyncTaskRuntime, clientSupportsAsyncTasks } from "../async-tasks.js";

describe("AsyncTaskRuntime", () => {
  it("detects the negotiated AIR capability", () => {
    expect(
      clientSupportsAsyncTasks({
        _meta: { jetbrains: { air: { version: 1, capabilities: ["asyncTasks"] } } },
      }),
    ).toBe(true);
    expect(clientSupportsAsyncTasks({})).toBe(false);
  });

  it("publishes one durable lifecycle with progress and a terminal state", async () => {
    const published: AcpSessionNotification[] = [];
    const runtime = new AsyncTaskRuntime(true, "session", async (notification) => {
      published.push(notification);
    });

    await runtime.taskStarted({
      taskId: "task-1",
      taskType: "local_workflow",
      description: "Build generated assets",
      workflowName: "assets",
    });
    await runtime.taskProgress({
      taskId: "task-1",
      summary: "Generated 3 files",
      lastToolName: "Write",
      usage: { total_tokens: 12, tool_uses: 3, duration_ms: 500 },
    });
    await runtime.taskUpdated("task-1", { status: "paused" });
    await runtime.taskUpdated("task-1", { status: "running" });
    await runtime.taskNotification("task-1", "completed", "Done");
    await runtime.taskProgress({ taskId: "task-1", summary: "late" });
    await runtime.taskNotification("task-1", "failed", "duplicate terminal");

    expect(published.map((notification) => notification.update.sessionUpdate)).toEqual([
      "async_task_spawned",
      "async_task_progress",
      "async_task_state_update",
      "async_task_state_update",
      "async_task_state_update",
    ]);
    expect(published[0]?.update).toMatchObject({
      asyncTaskId: "task-1",
      name: "assets",
      taskType: "workflow",
      showInTranscript: true,
    });
    expect(published[1]?.update).toMatchObject({
      summary: "Generated 3 files",
      usage: { totalTokens: 12, toolUses: 3, durationMs: 500 },
    });
    expect(published.at(-1)?.update).toMatchObject({ state: "completed", summary: "Done" });
  });

  it("waits until foreground shell work is backgrounded and excludes subagents", async () => {
    const published: AcpSessionNotification[] = [];
    const runtime = new AsyncTaskRuntime(true, "session", async (notification) => {
      published.push(notification);
    });

    await runtime.taskStarted({
      taskId: "foreground-shell",
      taskType: "local_bash",
      description: "Read one file",
    });
    await runtime.taskNotification("foreground-shell", "completed", "Done");
    await runtime.taskStarted({
      taskId: "shell",
      taskType: "local_bash",
      description: "Run tests",
    });
    await runtime.taskStarted({
      taskId: "agent",
      taskType: "local_agent",
      description: "Research",
      subagentType: "Explore",
    });
    expect(published).toEqual([]);

    await runtime.taskUpdated("shell", { isBackgrounded: true });
    expect(published).toHaveLength(1);
    expect(published[0]?.update).toMatchObject({ asyncTaskId: "shell", taskType: "shell" });
  });
});
