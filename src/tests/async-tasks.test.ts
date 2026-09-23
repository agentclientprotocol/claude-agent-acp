import { describe, expect, it } from "vitest";
import type { AcpSessionNotification } from "../acp-subagents.js";
import {
  AsyncTaskRuntime,
  backgroundBashTaskFromToolResult,
  clientSupportsAsyncTasks,
} from "../async-tasks.js";

describe("AsyncTaskRuntime", () => {
  it("recovers a background Bash task from its structured tool result", async () => {
    const updates: AcpSessionNotification[] = [];
    const runtime = new AsyncTaskRuntime(true, "root", async (notification) => {
      updates.push(notification);
    });
    const task = backgroundBashTaskFromToolResult(
      [
        {
          type: "tool_result",
          tool_use_id: "bash-tool",
          content:
            "Command running in background with ID: bpux8xmfg. Output is being written to: /private/tmp/claude/tasks/bpux8xmfg.output. You will be notified when it completes.",
        },
      ],
      { backgroundTaskId: "bpux8xmfg", stdout: "", stderr: "" },
      {
        "bash-tool": {
          name: "Bash",
          input: { command: "npm run build", run_in_background: true },
        },
      },
    );

    expect(task).toEqual({
      taskId: "bpux8xmfg",
      taskType: "local_bash",
      description: "npm run build",
      isBackgrounded: true,
      outputFilePath: "/private/tmp/claude/tasks/bpux8xmfg.output",
      toolCallId: "bash-tool",
    });
    // The SDK can report local_bash before the Bash result proves that it was
    // backgrounded. The structured result must promote that existing task.
    await runtime.taskStarted({
      taskId: "bpux8xmfg",
      taskType: "local_bash",
      description: "Shell",
    });
    await runtime.taskBackgrounded(task!);
    await runtime.taskNotification("bpux8xmfg", "completed", "Build finished");

    expect(updates.map((notification) => notification.update.sessionUpdate)).toEqual([
      "async_task_spawned",
      "async_task_state_update",
    ]);
    expect(updates[0].update).toMatchObject({
      asyncTaskId: "bpux8xmfg",
      name: "npm run build",
      taskType: "shell",
      description: "npm run build",
      showInTranscript: true,
      canStop: true,
      outputFilePath: "/private/tmp/claude/tasks/bpux8xmfg.output",
      toolCallId: "bash-tool",
    });
  });

  it("publishes a stopped terminal after a task-specific stop", async () => {
    const published: AcpSessionNotification[] = [];
    const runtime = new AsyncTaskRuntime(true, "session", async (notification) => {
      published.push(notification);
    });

    await runtime.taskStarted({
      taskId: "task-1",
      taskType: "local_workflow",
      description: "Build generated assets",
      toolCallId: "workflow-tool",
    });
    expect(runtime.canStop("task-1")).toBe(true);
    expect(runtime.claimStop("task-1")).toBe(true);
    expect(runtime.claimStop("task-1")).toBe(false);

    await runtime.taskStopped("task-1");
    await runtime.taskStopped("task-1");

    expect(runtime.canStop("task-1")).toBe(false);
    expect(published.map(({ update }) => update.sessionUpdate)).toEqual([
      "async_task_spawned",
      "async_task_state_update",
      "agent_message_chunk",
    ]);
    expect(published[1]?.update).toMatchObject({
      asyncTaskId: "task-1",
      state: "stopped",
    });
    // The panel drops a stopped task immediately; a summary there is unread.
    expect(published[1]?.update).not.toHaveProperty("summary");
    expect(published.at(-1)?.update).toMatchObject({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "**Task stopped by user:** Build generated assets." },
    });
  });

  it("acknowledges a stop as a live notice for a client on the notice contract", async () => {
    const published: AcpSessionNotification[] = [];
    const runtime = new AsyncTaskRuntime(
      true,
      "session",
      async (notification) => {
        published.push(notification);
      },
      { notices: true },
    );

    await runtime.taskStarted({
      taskId: "task-1",
      taskType: "local_workflow",
      description: "Build generated assets",
      toolCallId: "workflow-tool",
    });
    await runtime.taskStopped("task-1");
    await runtime.taskStopped("task-1");

    // The acknowledgement of a user action is transient by nature: it need not
    // become conversation history when the client can show it live.
    expect(published.map(({ update }) => update.sessionUpdate)).toEqual([
      "async_task_spawned",
      "async_task_state_update",
      "notice",
    ]);
    expect(published.at(-1)?.update).toEqual({
      sessionUpdate: "notice",
      severity: "info",
      title: "Task stopped by user",
      description: "Build generated assets.",
    });
  });

  it("still announces a stop whose SDK notification landed first", async () => {
    const published: AcpSessionNotification[] = [];
    const runtime = new AsyncTaskRuntime(true, "session", async (notification) => {
      published.push(notification);
    });

    await runtime.taskStarted({
      taskId: "task-1",
      taskType: "local_bash",
      description: "npm run build",
      isBackgrounded: true,
      toolCallId: "bash-tool",
    });
    expect(runtime.claimStop("task-1")).toBe(true);
    // The SDK kills the process and reports it before `stopTask` resolves, so
    // the task is already terminal by the time the stop path resumes. The
    // acknowledgement is still owed to the user who clicked.
    await runtime.taskNotification({ taskId: "task-1", status: "killed" });
    await runtime.taskStopped("task-1");

    expect(published.map(({ update }) => update.sessionUpdate)).toEqual([
      "async_task_spawned",
      "async_task_state_update",
      "agent_message_chunk",
    ]);
    expect(published.at(-1)?.update).toMatchObject({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "**Task stopped by user:** npm run build." },
    });
  });

  it("announces a stop for a panel-only task too", async () => {
    const published: AcpSessionNotification[] = [];
    const runtime = new AsyncTaskRuntime(true, "session", async (notification) => {
      published.push(notification);
    });

    // A background Bash task is panel-only because its tool call already draws
    // it in the transcript. That must not swallow the stop acknowledgement --
    // it is the only signal the user gets that their click landed.
    await runtime.taskStarted({
      taskId: "task-1",
      taskType: "local_bash",
      description: "npm run build",
      isBackgrounded: true,
      skipTranscript: true,
      toolCallId: "bash-tool",
    });
    expect(runtime.claimStop("task-1")).toBe(true);
    await runtime.taskStopped("task-1");

    expect(published[0]?.update).toMatchObject({
      sessionUpdate: "async_task_spawned",
      showInTranscript: false,
    });
    expect(published.at(-1)?.update).toMatchObject({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "**Task stopped by user:** npm run build." },
    });
  });

  it("correlates a background Bash result inside a batched structured message", () => {
    const toolUseResult = { backgroundTaskId: "task-1" };
    const tools = {
      read: { name: "Read", input: { file_path: "package.json" } },
      bash: { name: "Bash", input: { command: "npm run build" } },
    };

    expect(
      backgroundBashTaskFromToolResult(
        [
          { type: "tool_result", tool_use_id: "read", content: "package" },
          {
            type: "tool_result",
            tool_use_id: "bash",
            content: [
              { type: "text", text: "Command running. Output is being written to: " },
              {
                type: "text",
                text: "/private/tmp/claude/tasks/task-1.output. You will be notified when done.",
              },
            ],
          },
        ],
        toolUseResult,
        tools,
      ),
    ).toMatchObject({
      taskId: "task-1",
      toolCallId: "bash",
      description: "npm run build",
      outputFilePath: "/private/tmp/claude/tasks/task-1.output",
    });
  });

  it("recovers a background Bash task when the structured result omits its id", () => {
    const tools = {
      bash: { name: "Bash", input: { command: "npm run build" } },
    };

    expect(
      backgroundBashTaskFromToolResult(
        [
          {
            type: "tool_result",
            tool_use_id: "bash",
            content:
              "Command running in background with ID: task-1. Output is being written to: " +
              "/private/tmp/claude/tasks/task-1.output. You will be notified when done.",
          },
        ],
        undefined,
        tools,
      ),
    ).toMatchObject({
      taskId: "task-1",
      toolCallId: "bash",
      description: "npm run build",
      outputFilePath: "/private/tmp/claude/tasks/task-1.output",
    });
  });

  it("does not infer a background task without an unambiguous Bash result", () => {
    const toolUseResult = { backgroundTaskId: "task-1" };
    const bash = { bash: { name: "Bash", input: { command: "npm run build" } } };

    expect(backgroundBashTaskFromToolResult([], toolUseResult, bash)).toBeUndefined();
    expect(
      backgroundBashTaskFromToolResult(
        [
          { type: "tool_result", tool_use_id: "bash-1" },
          { type: "tool_result", tool_use_id: "bash-2" },
        ],
        toolUseResult,
        {
          "bash-1": { name: "Bash", input: { command: "first" } },
          "bash-2": { name: "Bash", input: { command: "second" } },
        },
      ),
    ).toBeUndefined();
    expect(
      backgroundBashTaskFromToolResult(
        [{ type: "tool_result", tool_use_id: "read" }],
        toolUseResult,
        { read: { name: "Read", input: {} } },
      ),
    ).toBeUndefined();
    expect(
      backgroundBashTaskFromToolResult(
        [
          {
            type: "tool_result",
            tool_use_id: "bash",
            content:
              "Output is being written to: /private/tmp/claude/tasks/not-task-1.output. You will be notified",
          },
        ],
        toolUseResult,
        bash,
      )?.outputFilePath,
    ).toBeUndefined();
    expect(
      backgroundBashTaskFromToolResult(
        [{ type: "tool_result", tool_use_id: "bash" }],
        [{ backgroundTaskId: "task-1" }, { backgroundTaskId: "task-2" }],
        bash,
      ),
    ).toBeUndefined();
  });

  it("uses a structured result tool id to disambiguate batched Bash results", () => {
    expect(
      backgroundBashTaskFromToolResult(
        [
          { type: "tool_result", tool_use_id: "bash-1", content: "first" },
          { type: "tool_result", tool_use_id: "bash-2", content: "second" },
        ],
        { tool_use_id: "bash-2", background_task_id: "task-2" },
        {
          "bash-1": { name: "Bash", input: { command: "first" } },
          "bash-2": { name: "Bash", input: { command: "second" } },
        },
      ),
    ).toMatchObject({ taskId: "task-2", toolCallId: "bash-2", description: "second" });

    expect(
      backgroundBashTaskFromToolResult(
        [{ type: "tool_result", tool_use_id: "bash-1", content: "first" }],
        { tool_use_id: "read", background_task_id: "task-2" },
        {
          "bash-1": { name: "Bash", input: { command: "first" } },
          read: { name: "Read", input: {} },
        },
      ),
    ).toBeUndefined();
  });

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
      toolCallId: "bash-tool",
    });
    await runtime.taskStarted({
      taskId: "agent",
      taskType: "local_agent",
      description: "Research",
      subagentType: "Explore",
    });
    await runtime.taskStarted({
      task_id: "agent-without-subtype",
      task_type: "local_agent",
      description: "Research",
      is_backgrounded: true,
    });
    expect(published).toEqual([]);

    await runtime.taskUpdated("shell", { isBackgrounded: true });
    expect(published).toHaveLength(1);
    expect(published[0]?.update).toMatchObject({ asyncTaskId: "shell", taskType: "shell" });
  });

  it("normalizes snake_case SDK task events and propagates a late output file", async () => {
    const published: AcpSessionNotification[] = [];
    const runtime = new AsyncTaskRuntime(true, "session", async (notification) => {
      published.push(notification);
    });

    await runtime.taskStarted({
      task_id: "shell",
      task_type: "local_bash",
      description: "Run build",
      is_backgrounded: true,
      tool_use_id: "bash-tool",
    });
    await runtime.taskProgress({
      task_id: "shell",
      last_tool_name: "Bash",
      usage: { totalTokens: 2, toolUses: 1, durationMs: 50 },
    });
    await runtime.taskNotification({
      task_id: "shell",
      status: "completed",
      summary: "Done",
      output_file: "/tmp/tasks/shell.output",
    });

    expect(published[0]?.update).toMatchObject({
      asyncTaskId: "shell",
      taskType: "shell",
      toolCallId: "bash-tool",
    });
    expect(published[1]?.update).toMatchObject({
      lastToolName: "Bash",
      usage: { totalTokens: 2, toolUses: 1, durationMs: 50 },
    });
    expect(published[2]?.update).toMatchObject({
      state: "completed",
      summary: "Done",
      outputFilePath: "/tmp/tasks/shell.output",
    });
  });

  it("keeps a terminal tombstone until a late Bash result proves the task was backgrounded", async () => {
    const published: AcpSessionNotification[] = [];
    const runtime = new AsyncTaskRuntime(true, "session", async (notification) => {
      published.push(notification);
    });

    await runtime.taskNotification({
      task_id: "fast-shell",
      status: "completed",
      summary: "Already done",
      output_file: "/tmp/tasks/fast-shell.output",
    });
    expect(published).toEqual([]);

    await runtime.taskBackgrounded({
      taskId: "fast-shell",
      taskType: "local_bash",
      description: "Fast build",
      isBackgrounded: true,
      toolCallId: "bash-tool",
    });
    await runtime.taskUpdated("fast-shell", { status: "running" });

    expect(published.map((notification) => notification.update.sessionUpdate)).toEqual([
      "async_task_spawned",
      "async_task_state_update",
    ]);
    expect(published[0]?.update).toMatchObject({
      description: "Fast build",
      outputFilePath: "/tmp/tasks/fast-shell.output",
    });
    // The spawn carried the output path and the tool call. The state does not repeat them.
    expect(published[1]?.update).toEqual({
      sessionUpdate: "async_task_state_update",
      asyncTaskId: "fast-shell",
      state: "completed",
      summary: "Already done",
    });
  });

  it("sends only the progress fields that changed", async () => {
    const published: AcpSessionNotification[] = [];
    const runtime = new AsyncTaskRuntime(true, "session", async (notification) => {
      published.push(notification);
    });
    await runtime.taskStarted({
      task_id: "shell",
      task_type: "local_bash",
      description: "Build",
      isBackgrounded: true,
      tool_use_id: "bash-tool",
    } as any);
    await runtime.taskProgress({ task_id: "shell", description: "Build", summary: "Step 1" });
    await runtime.taskProgress({ task_id: "shell", description: "Build", summary: "Step 1" });
    await runtime.taskProgress({ task_id: "shell", description: "Build", summary: "Step 2" });

    expect(published.slice(1).map((notification) => notification.update)).toEqual([
      { sessionUpdate: "async_task_progress", asyncTaskId: "shell", summary: "Step 1" },
      { sessionUpdate: "async_task_progress", asyncTaskId: "shell", summary: "Step 2" },
    ]);
  });

  it("retains a terminal task_updated tombstone until background promotion", async () => {
    const published: AcpSessionNotification[] = [];
    const runtime = new AsyncTaskRuntime(true, "session", async (notification) => {
      published.push(notification);
    });

    await runtime.taskUpdated({
      task_id: "fast-shell",
      patch: { status: "failed", error: "boom" },
    });
    await runtime.taskBackgrounded({
      task_id: "fast-shell",
      task_type: "local_bash",
      description: "Fast build",
      is_backgrounded: true,
    });

    expect(published.map((notification) => notification.update.sessionUpdate)).toEqual([
      "async_task_spawned",
      "async_task_state_update",
    ]);
    expect(published[1]?.update).toMatchObject({ state: "failed", summary: "boom" });
  });

  it("publishes a mutable output path after an already announced task", async () => {
    const published: AcpSessionNotification[] = [];
    const runtime = new AsyncTaskRuntime(true, "session", async (notification) => {
      published.push(notification);
    });

    await runtime.taskStarted({
      taskId: "shell",
      taskType: "local_bash",
      description: "Build",
      isBackgrounded: true,
      toolCallId: "bash-tool",
    });
    await runtime.taskUpdated("shell", { output_file: "/tmp/tasks/one.output" });
    await runtime.taskUpdated("shell", { outputFilePath: "/tmp/tasks/two.output" });

    expect(published.slice(1).map((notification) => notification.update)).toEqual([
      expect.objectContaining({
        sessionUpdate: "async_task_progress",
        outputFilePath: "/tmp/tasks/one.output",
      }),
      expect.objectContaining({
        sessionUpdate: "async_task_progress",
        outputFilePath: "/tmp/tasks/two.output",
      }),
    ]);
  });

  it("holds the spawn until the Bash result brings the tool id", async () => {
    const published: AcpSessionNotification[] = [];
    const runtime = new AsyncTaskRuntime(true, "session", async (notification) => {
      published.push(notification);
    });

    await runtime.taskStarted({
      task_id: "shell",
      task_type: "local_bash",
      description: "Build",
      is_backgrounded: true,
    });
    expect(published).toEqual([]);
    await runtime.taskBackgrounded({
      task_id: "shell",
      task_type: "local_bash",
      description: "Build",
      is_backgrounded: true,
      tool_use_id: "bash-tool",
    });

    expect(published.map(({ update }) => update)).toEqual([
      expect.objectContaining({ sessionUpdate: "async_task_spawned", toolCallId: "bash-tool" }),
    ]);
  });

  it("publishes a tool id that arrives after the turn released the spawn", async () => {
    const published: AcpSessionNotification[] = [];
    const runtime = new AsyncTaskRuntime(true, "session", async (notification) => {
      published.push(notification);
    });

    await runtime.taskStarted({
      task_id: "shell",
      task_type: "local_bash",
      description: "Build",
      is_backgrounded: true,
    });
    await runtime.releaseHeld();
    await runtime.taskBackgrounded({
      task_id: "shell",
      task_type: "local_bash",
      description: "Build",
      is_backgrounded: true,
      tool_use_id: "bash-tool",
    });

    expect(published[0]?.update).not.toHaveProperty("toolCallId");
    expect(published[1]?.update).toMatchObject({
      sessionUpdate: "async_task_progress",
      asyncTaskId: "shell",
      toolCallId: "bash-tool",
    });
  });

  it("reconciles foreground promotion and a lost terminal edge from the live task level", async () => {
    const published: AcpSessionNotification[] = [];
    const runtime = new AsyncTaskRuntime(true, "session", async (notification) => {
      published.push(notification);
    });

    await runtime.taskStarted({
      task_id: "shell",
      task_type: "local_bash",
      description: "Build",
      is_backgrounded: false,
    });
    await runtime.backgroundTasksChanged({
      tasks: [{ task_id: "shell", task_type: "local_bash", description: "Build" }],
    });
    await runtime.backgroundTasksChanged([]);

    expect(published.map((notification) => notification.update.sessionUpdate)).toEqual([
      "async_task_spawned",
      "async_task_state_update",
    ]);
    expect(published[1]?.update).toMatchObject({ state: "stopped" });

    // The level is deliberately best-effort: an authoritative edge that was
    // merely ordered after it may correct the terminal state.
    await runtime.taskNotification("shell", "completed", "Done");
    expect(published[2]?.update).toMatchObject({ state: "completed", summary: "Done" });
  });

  it("lets the terminal edge win when the live level is ordered before it", async () => {
    const published: AcpSessionNotification[] = [];
    const runtime = new AsyncTaskRuntime(true, "session", async (notification) => {
      published.push(notification);
    });

    await runtime.taskStarted({
      task_id: "shell",
      task_type: "local_bash",
      description: "Build",
      is_backgrounded: true,
    });
    await runtime.backgroundTasksChanged([]);
    await runtime.taskNotification("shell", "completed", "Done");

    expect(published.map((notification) => notification.update.sessionUpdate)).toEqual([
      "async_task_spawned",
      "async_task_state_update",
      "async_task_state_update",
    ]);
    expect(published[1]?.update).toMatchObject({ state: "stopped" });
    expect(published[2]?.update).toMatchObject({ state: "completed", summary: "Done" });
  });

  it("heals a lone lost terminal edge at the replace-level boundary", async () => {
    const published: AcpSessionNotification[] = [];
    const runtime = new AsyncTaskRuntime(true, "session", async (notification) => {
      published.push(notification);
    });

    await runtime.taskStarted({
      task_id: "shell",
      task_type: "local_bash",
      description: "Build",
      is_backgrounded: true,
    });
    await runtime.backgroundTasksChanged([]);

    expect(published.at(-1)?.update).toMatchObject({
      sessionUpdate: "async_task_state_update",
      asyncTaskId: "shell",
      state: "stopped",
    });
  });

  it("recovers a live task whose task_started edge was lost", async () => {
    const published: AcpSessionNotification[] = [];
    const runtime = new AsyncTaskRuntime(true, "session", async (notification) => {
      published.push(notification);
    });

    await runtime.backgroundTasksChanged([
      { task_id: "lost-start", task_type: "local_bash", description: "Build" },
    ]);
    // The level carries no tool call id. The spawn waits for the end of the turn.
    expect(published).toEqual([]);
    await runtime.releaseHeld();

    expect(published[0]?.update).toMatchObject({
      sessionUpdate: "async_task_spawned",
      asyncTaskId: "lost-start",
      taskType: "shell",
      description: "Build",
      showInTranscript: false,
    });
  });

  it("keeps level-only recovery panel-only when task_started arrives late", async () => {
    const published: AcpSessionNotification[] = [];
    const runtime = new AsyncTaskRuntime(true, "session", async (notification) => {
      published.push(notification);
    });

    await runtime.backgroundTasksChanged([
      { task_id: "lost-start", task_type: "local_workflow", description: "Build assets" },
    ]);
    await runtime.taskStarted({
      task_id: "lost-start",
      task_type: "local_workflow",
      workflow_name: "assets",
      description: "Build generated assets",
      skip_transcript: true,
      is_backgrounded: true,
    });
    await runtime.releaseHeld();

    expect(published).toHaveLength(1);
    expect(published[0]?.update).toMatchObject({
      sessionUpdate: "async_task_spawned",
      asyncTaskId: "lost-start",
      // The held spawn takes the name of the late task_started.
      name: "assets",
      showInTranscript: false,
    });
  });

  it("sends the changed fields again when a retry follows a failed send", async () => {
    const published: AcpSessionNotification[] = [];
    let failNext = false;
    const runtime = new AsyncTaskRuntime(true, "session", async (notification) => {
      if (failNext) {
        failNext = false;
        throw new Error("client disconnected");
      }
      published.push(notification);
    });
    await runtime.taskStarted({
      task_id: "build",
      task_type: "local_bash",
      description: "build",
      is_backgrounded: true,
      tool_use_id: "bash-tool",
    });

    failNext = true;
    await expect(
      runtime.taskNotification("build", "completed", "Done", "/tmp/build.output"),
    ).rejects.toThrow("client disconnected");
    await runtime.taskNotification("build", "completed", "Done", "/tmp/build.output");

    expect(published.at(-1)?.update).toMatchObject({
      sessionUpdate: "async_task_state_update",
      state: "completed",
      outputFilePath: "/tmp/build.output",
    });
  });

  it("finishes remaining tasks and can retry a task whose terminal publication failed", async () => {
    const published: AcpSessionNotification[] = [];
    let failFirstTask = true;
    const runtime = new AsyncTaskRuntime(true, "session", async (notification) => {
      if (
        failFirstTask &&
        notification.update.sessionUpdate === "async_task_state_update" &&
        notification.update.asyncTaskId === "first"
      ) {
        failFirstTask = false;
        throw new Error("client disconnected");
      }
      published.push(notification);
    });
    for (const taskId of ["first", "second"]) {
      await runtime.taskStarted({
        task_id: taskId,
        task_type: "local_bash",
        description: taskId,
        is_backgrounded: true,
      });
    }

    await expect(runtime.finishAll("failed")).rejects.toThrow("client disconnected");
    expect(published).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          update: expect.objectContaining({
            sessionUpdate: "async_task_state_update",
            asyncTaskId: "second",
            state: "failed",
          }),
        }),
      ]),
    );

    await expect(runtime.finishAll("failed")).resolves.toBeUndefined();
    const terminalIds = published.flatMap(({ update }) =>
      update.sessionUpdate === "async_task_state_update" ? [update.asyncTaskId] : [],
    );
    expect(terminalIds).toEqual(["second", "first"]);
  });

  it("keeps the updates of a held task behind its spawn", async () => {
    const published: AcpSessionNotification[] = [];
    const runtime = new AsyncTaskRuntime(true, "session", async (notification) => {
      published.push(notification);
    });

    await runtime.taskStarted({
      task_id: "monitor",
      task_type: "local_monitor",
      description: "Watch the logs",
    });
    await runtime.taskProgress({ task_id: "monitor", summary: "First line" });
    await runtime.taskUpdated("monitor", { status: "paused" });
    expect(published).toEqual([]);

    await runtime.taskProgress({
      task_id: "monitor",
      summary: "Second line",
      tool_use_id: "monitor-tool",
    });

    expect(published.map(({ update }) => update)).toEqual([
      expect.objectContaining({
        sessionUpdate: "async_task_spawned",
        asyncTaskId: "monitor",
        toolCallId: "monitor-tool",
      }),
      { sessionUpdate: "async_task_progress", asyncTaskId: "monitor", summary: "First line" },
      { sessionUpdate: "async_task_state_update", asyncTaskId: "monitor", state: "paused" },
      { sessionUpdate: "async_task_progress", asyncTaskId: "monitor", summary: "Second line" },
    ]);
  });

  it("sends the spawn without a tool id when a held task ends first", async () => {
    const published: AcpSessionNotification[] = [];
    const runtime = new AsyncTaskRuntime(true, "session", async (notification) => {
      published.push(notification);
    });

    await runtime.taskStarted({
      task_id: "workflow",
      task_type: "local_workflow",
      description: "Build assets",
    });
    await runtime.taskProgress({ task_id: "workflow", summary: "Half done" });
    await runtime.taskNotification({ task_id: "workflow", status: "completed", summary: "Done" });

    expect(published.map(({ update }) => update)).toEqual([
      expect.objectContaining({ sessionUpdate: "async_task_spawned", asyncTaskId: "workflow" }),
      { sessionUpdate: "async_task_progress", asyncTaskId: "workflow", summary: "Half done" },
      {
        sessionUpdate: "async_task_state_update",
        asyncTaskId: "workflow",
        state: "completed",
        summary: "Done",
      },
    ]);
    expect(published[0]?.update).not.toHaveProperty("toolCallId");
    await runtime.releaseHeld();
    expect(published).toHaveLength(3);
  });

  it("takes the tool id of the terminal notification of a held task", async () => {
    const published: AcpSessionNotification[] = [];
    const runtime = new AsyncTaskRuntime(true, "session", async (notification) => {
      published.push(notification);
    });

    await runtime.taskStarted({
      task_id: "workflow",
      task_type: "local_workflow",
      description: "Build assets",
    });
    await runtime.taskNotification({
      task_id: "workflow",
      status: "failed",
      tool_use_id: "workflow-tool",
    });

    expect(published.map(({ update }) => update.sessionUpdate)).toEqual([
      "async_task_spawned",
      "async_task_state_update",
    ]);
    expect(published[0]?.update).toMatchObject({ toolCallId: "workflow-tool" });
  });

  it("finishes a held task at shutdown", async () => {
    const published: AcpSessionNotification[] = [];
    const runtime = new AsyncTaskRuntime(true, "session", async (notification) => {
      published.push(notification);
    });

    await runtime.taskStarted({
      task_id: "workflow",
      task_type: "local_workflow",
      description: "Build assets",
    });
    await runtime.finishAll("stopped");

    expect(published.map(({ update }) => update.sessionUpdate)).toEqual([
      "async_task_spawned",
      "async_task_state_update",
    ]);
    expect(published[1]?.update).toMatchObject({ state: "stopped" });
  });
});
