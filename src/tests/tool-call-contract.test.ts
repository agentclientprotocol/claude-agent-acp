import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ClientCapabilities } from "@agentclientprotocol/sdk";
import { AcpClient, toAcpNotifications, ToolUseCache } from "../acp-agent.js";
import { ClientCapabilities as ToolCallCapabilities } from "../tool-calls/client-capabilities.js";
import { backgroundedBashToolCall } from "../tool-calls/background.js";
import { ChangedMetaFilter } from "../tool-calls/changed-meta-filter.js";
import { ToolCallFieldTracker } from "../tool-calls/field-tracker.js";
import { AcpToolCallRenderer } from "../tool-calls/renderer.js";
import { changedTaskPlanEntries, createTaskHook, type TaskState } from "../tools.js";

const logger = { log: () => {}, error: () => {} };

/**
 * An AIR client with terminal snapshots and no AIR capabilities: it gets the
 * contract and a display copy of the input. A client without `_meta.jetbrains.air`
 * gets the upstream shape instead (see `acp-scenarios.test.ts`).
 */
const terminalAir: ClientCapabilities = {
  _meta: { terminal_output: true, jetbrains: { air: { version: 1, capabilities: [] } } },
};

/** AIR: terminal deltas, and it renders rawInput itself. */
const air: ClientCapabilities = {
  _meta: {
    terminal_output: true,
    terminal_output_delta: true,
    jetbrains: {
      air: {
        version: 1,
        capabilities: ["diffPatch", "rawInputRendering", "planFile"],
      },
    },
  },
};

/** An AIR client with neither a terminal nor AIR capabilities. */
const plainAir: ClientCapabilities = {
  _meta: { jetbrains: { air: { version: 1, capabilities: [] } } },
};

function report(
  capabilities: ClientCapabilities,
  name: string,
  input: Record<string, unknown>,
  result?: { content: unknown; is_error?: boolean; structured?: unknown },
) {
  const cache: ToolUseCache = {};
  const map = (chunk: unknown, role: "assistant" | "user", toolUseResult?: unknown) =>
    toAcpNotifications([chunk] as any, role, "s", cache, {} as AcpClient, logger, {
      registerHooks: false,
      clientCapabilities: capabilities,
      cwd: "/work",
      toolUseResult,
    }).map((notification) => notification.update as any);
  const call = map({ type: "tool_use", id: "t", name, input }, "assistant");
  const updates = result
    ? map(
        {
          type: "tool_result",
          tool_use_id: "t",
          content: result.content,
          ...(result.is_error ? { is_error: true } : {}),
        },
        "user",
        result.structured,
      )
    : [];
  return { call: call[0], updates };
}

describe("ClientCapabilities", () => {
  it("reads the AIR capabilities only from _meta.jetbrains.air.capabilities", () => {
    expect(ToolCallCapabilities.from(air)).toMatchObject({
      terminalOutput: true,
      terminalOutputDelta: true,
      diffPatch: true,
      air: { client: true, rawInputRendering: true, planFile: true },
    });
    expect(
      ToolCallCapabilities.from({ _meta: { rawInputRendering: true } } as ClientCapabilities).air,
    ).toEqual({
      client: false,
      rawInputRendering: false,
      planFile: false,
    });
  });
});

describe("the ACP tool call contract", () => {
  describe("Bash", () => {
    const input = { command: "ls", description: "List files" };

    it("keeps the Zed terminal conventions for AIR", () => {
      const { call, updates } = report(terminalAir, "Bash", input, { content: "a\nb" });
      expect(call).toMatchObject({
        title: "ls",
        kind: "execute",
        content: [{ type: "terminal", terminalId: "t" }],
        rawInput: input,
        _meta: {
          terminal_info: { terminal_id: "t" },
          jetbrains: { air: { commandTitle: "List files" } },
        },
      });
      expect(updates).toEqual([
        {
          sessionUpdate: "tool_call_update",
          toolCallId: "t",
          _meta: { terminal_output: { terminal_id: "t", data: "a\nb" } },
        },
        {
          sessionUpdate: "tool_call_update",
          toolCallId: "t",
          status: "completed",
          _meta: {
            claudeCode: { toolName: "Bash" },
            terminal_exit: { terminal_id: "t", exit_code: 0, signal: null },
          },
        },
      ]);
    });

    it("appends output deltas for AIR", () => {
      const { updates } = report(air, "Bash", input, { content: "a" });
      expect(updates[0]._meta).toEqual({
        terminal_output_delta: { terminal_id: "t", data: "a" },
      });
    });

    it("shows one display copy of the description without a terminal", () => {
      const { call, updates } = report(plainAir, "Bash", input, { content: "a" });
      expect(call.content).toEqual([
        { type: "content", content: { type: "text", text: "List files" } },
      ]);
      expect(updates[0].content).toEqual([
        { type: "content", content: { type: "text", text: "```console\na\n```" } },
      ]);
      expect(updates[0]).not.toHaveProperty("rawOutput");
    });
  });

  it("sends the Read text once, in content", () => {
    const { call, updates } = report(
      terminalAir,
      "Read",
      { file_path: "/work/a.ts" },
      { content: "x" },
    );
    expect(call).toMatchObject({ title: "Read a.ts", kind: "read", content: [] });
    expect(updates[0].content).toEqual([
      { type: "content", content: { type: "text", text: "```\nx\n```" } },
    ]);
    expect(updates[0]).not.toHaveProperty("rawOutput");
  });

  it("keeps the Write file text only in the diff", () => {
    const input = { file_path: "/work/a.ts", content: "text" };
    for (const capabilities of [terminalAir, plainAir]) {
      const { call } = report(capabilities, "Write", input);
      expect(call.rawInput).toEqual({ file_path: "/work/a.ts" });
      expect(call.content).toEqual([
        { type: "diff", path: "/work/a.ts", oldText: null, newText: "text" },
      ]);
    }
  });

  it("keeps the Write file text of an alias key only in the diff", () => {
    for (const input of [
      { path: "/work/a.ts", file_text: "text" },
      { path: "/work/a.ts", file_content: "text" },
    ]) {
      const { call } = report(plainAir, "Write", input);
      expect(call.title).toBe("Write a.ts");
      expect(call.locations).toEqual([{ path: "/work/a.ts" }]);
      expect(call.rawInput).toEqual({ path: "/work/a.ts" });
      expect(call.content).toEqual([
        { type: "diff", path: "/work/a.ts", oldText: null, newText: "text" },
      ]);
    }
  });

  it("keeps the Edit text only in the diff", () => {
    const input = { file_path: "/work/a.ts", old_string: "a", new_string: "b", replace_all: true };
    const { call, updates } = report(terminalAir, "Edit", input, {
      content: "The file was updated",
    });
    expect(call.rawInput).toEqual({ file_path: "/work/a.ts", replace_all: true });
    expect(call.content).toEqual([
      { type: "diff", path: "/work/a.ts", oldText: "a", newText: "b" },
    ]);
    // The confirmation has no display form.
    expect(updates[0].rawOutput).toBe("The file was updated");
  });

  it("keeps the NotebookEdit source in rawInput with one display copy for Zed", () => {
    const input = { notebook_path: "/work/a.ipynb", cell_id: "c", new_source: "x = 1" };
    const zedReport = report(terminalAir, "NotebookEdit", input, {
      content: "Updated c with x = 1",
    });
    expect(zedReport.call.rawInput).toEqual(input);
    expect(zedReport.call.content).toEqual([
      { type: "content", content: { type: "text", text: "```\nx = 1\n```" } },
    ]);
    expect(zedReport.updates[0]).not.toHaveProperty("content");
    expect(zedReport.updates[0]).not.toHaveProperty("rawOutput");

    const airReport = report(air, "NotebookEdit", input);
    expect(airReport.call.content).toEqual([]);
    expect(airReport.call.rawInput).toEqual(input);
  });

  it("reports Grep and Glob hits as content", () => {
    const grep = report(
      terminalAir,
      "Grep",
      { pattern: "todo", path: "src" },
      { content: "a.ts:1" },
    );
    expect(grep.call.title).toBe('grep "todo" src');
    expect(grep.updates[0].content).toEqual([
      { type: "content", content: { type: "text", text: "a.ts:1" } },
    ]);
    const glob = report(terminalAir, "Glob", { pattern: "*.ts" }, { content: "a.ts" });
    expect(glob.call.title).toBe("Find `*.ts`");
    expect(glob.updates[0]).not.toHaveProperty("rawOutput");
  });

  it("shows the WebFetch prompt once to Zed and never to AIR", () => {
    const input = { url: "https://e.com", prompt: "Summarize" };
    expect(report(terminalAir, "WebFetch", input).call.content).toEqual([
      { type: "content", content: { type: "text", text: "Summarize" } },
    ]);
    expect(report(air, "WebFetch", input).call.content).toEqual([]);
  });

  it("reports WebSearch hits from the structured result", () => {
    const { updates } = report(
      terminalAir,
      "WebSearch",
      { query: "acp" },
      {
        content: "Web search results: ...",
        structured: { results: [{ content: [{ title: "ACP", url: "https://acp" }] }] },
      },
    );
    expect(updates[0].content).toEqual([
      { type: "content", content: { type: "text", text: "ACP (https://acp)" } },
    ]);
  });

  it("marks an Agent as a subagent and shows its prompt only to Zed", () => {
    const input = { description: "Explore", prompt: "Inspect the project" };
    const zedCall = report(terminalAir, "Agent", input).call;
    expect(zedCall).toMatchObject({
      title: "Explore",
      content: [{ type: "content", content: { type: "text", text: "Inspect the project" } }],
      _meta: { claudeCode: { toolName: "Agent" }, jetbrains: { air: { subagent: true } } },
    });
    expect(zedCall._meta.claudeCode).not.toHaveProperty("subagent");
    expect(report(air, "Task", input).call.content).toEqual([]);
  });

  it("reports TodoWrite as a plan, not as a tool call", () => {
    const { call } = report(terminalAir, "TodoWrite", {
      todos: [{ content: "Test", status: "pending", activeForm: "Testing" }],
    });
    expect(call).toEqual({
      sessionUpdate: "plan",
      entries: [{ content: "Test", status: "pending", priority: "medium" }],
    });
  });

  describe("ExitPlanMode", () => {
    const input = { plan: "1. Do it" };

    it("shows the plan once and sends no approval text", () => {
      const { call, updates } = report(terminalAir, "ExitPlanMode", input, {
        content: "User has approved your plan.\n\n## Approved Plan:\n1. Do it",
      });
      expect(call.content).toEqual([
        { type: "content", content: { type: "text", text: "1. Do it" } },
      ]);
      expect(updates[0]).toMatchObject({ status: "completed", title: "Exited Plan Mode" });
      expect(updates[0]).not.toHaveProperty("rawOutput");
      expect(updates[0]).not.toHaveProperty("content");
      expect(report(air, "ExitPlanMode", input).call.content).toEqual([]);
    });

    it("sends the rejection reason once, unfenced, in rawOutput", () => {
      const { updates } = report(terminalAir, "ExitPlanMode", input, {
        content: "```\nKeep the tests\n```",
        is_error: true,
      });
      expect(updates[0]).toMatchObject({ status: "failed", rawOutput: "Keep the tests" });
      expect(updates[0]).not.toHaveProperty("content");
    });

    describe("with a plan file", () => {
      let dir: string;
      let planFilePath: string;
      const planFileAir: ClientCapabilities = {
        _meta: { jetbrains: { air: { version: 1, capabilities: ["planFile"] } } },
      };

      beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), "plan-file-"));
        planFilePath = path.join(dir, "plan.md");
        fs.writeFileSync(planFilePath, "1. Do it");
      });

      afterEach(() => {
        fs.rmSync(dir, { recursive: true, force: true });
      });

      it("sends the plan file path and no plan text to a planFile client", () => {
        const { call, updates } = report(
          planFileAir,
          "ExitPlanMode",
          { plan: "1. Do it", planFilePath },
          { content: "User has approved your plan.\n\n## Approved Plan:\n1. Do it" },
        );
        expect(call.rawInput).toEqual({ planFilePath });
        expect(call.content).toEqual([]);
        expect(updates[0]).toMatchObject({
          status: "completed",
          title: "Exited Plan Mode",
          rawInput: { planFilePath },
        });
        expect(JSON.stringify([call, updates])).not.toContain("Do it");
      });

      it("sends the plan file path with the rejection reason", () => {
        const { updates } = report(
          planFileAir,
          "ExitPlanMode",
          { plan: "1. Do it", planFilePath },
          { content: "```\nKeep the tests\n```", is_error: true },
        );
        expect(updates[0]).toMatchObject({
          status: "failed",
          rawOutput: "Keep the tests",
          rawInput: { planFilePath },
        });
      });

      it("sends the plan file of the structured result when the input names none", () => {
        const { call, updates } = report(planFileAir, "ExitPlanMode", input, {
          content: "User has approved your plan.",
          structured: { plan: "1. Do it", isAgent: false, filePath: planFilePath },
        });
        expect(call.rawInput).toEqual(input);
        expect(updates[0]).toMatchObject({ rawInput: { planFilePath } });
      });

      it("sends the plan text when the plan file does not exist", () => {
        const missing = { plan: "1. Do it", planFilePath: path.join(dir, "missing.md") };
        const { call, updates } = report(planFileAir, "ExitPlanMode", missing, {
          content: "User has approved your plan.",
        });
        expect(call.rawInput).toEqual(missing);
        expect(call.content).toEqual([
          { type: "content", content: { type: "text", text: "1. Do it" } },
        ]);
        expect(updates[0]).not.toHaveProperty("rawInput");
      });

      it("sends the plan text to an AIR client without planFile", () => {
        const withFile = { plan: "1. Do it", planFilePath };
        const { call } = report(terminalAir, "ExitPlanMode", withFile);
        expect(call.rawInput).toEqual(withFile);
        expect(call.content).toEqual([
          { type: "content", content: { type: "text", text: "1. Do it" } },
        ]);
      });

      it("sends the whole input to a client that is not AIR", () => {
        const withFile = { plan: "1. Do it", planFilePath };
        const { call, updates } = report({}, "ExitPlanMode", withFile, {
          content: "User has approved your plan.",
          structured: { plan: "1. Do it", isAgent: false, filePath: planFilePath },
        });
        expect(call.rawInput).toEqual(withFile);
        expect(updates.every((update) => !("rawInput" in update))).toBe(true);
      });
    });
  });

  it("keeps the AskUserQuestion question out of the title", () => {
    const input = { questions: [{ question: "Which mode?", header: "Mode", options: [] }] };
    const { call } = report(terminalAir, "AskUserQuestion", input);
    expect(call.title).toBe("Asking for your input");
    expect(call.content).toEqual([
      { type: "content", content: { type: "text", text: "Which mode?" } },
    ]);
    expect(report(air, "AskUserQuestion", input).call.content).toEqual([]);
  });

  it("sends the Skill under jetbrains.air.skill and its confirmation as rawOutput", () => {
    const { call, updates } = report(
      terminalAir,
      "Skill",
      { skill: "commits" },
      { content: "Launching skill: commits" },
    );
    expect(call._meta).toEqual({
      claudeCode: { toolName: "Skill" },
      jetbrains: { air: { version: 1, skill: { name: "commits" } } },
    });
    expect(updates[0].rawOutput).toBe("Launching skill: commits");
  });

  it("marks an MCP tool call and shows its text result once", () => {
    const { call, updates } = report(
      terminalAir,
      "mcp__github__list",
      { repo: "acp" },
      {
        content: [{ type: "text", text: "3 issues" }],
      },
    );
    expect(call._meta).toMatchObject({ is_mcp_tool_call: true });
    expect(updates[0].content).toEqual([
      { type: "content", content: { type: "text", text: "3 issues" } },
    ]);
    expect(updates[0]).not.toHaveProperty("rawOutput");
  });

  it.each(["TaskOutput", "TaskStop"])("reports %s through the generic reporter", (name) => {
    const { call, updates } = report(terminalAir, name, { task_id: "b1" }, { content: "done" });
    expect(call).toMatchObject({ title: name, kind: "other", content: [] });
    expect(updates[0].content).toEqual([
      { type: "content", content: { type: "text", text: "done" } },
    ]);
  });
});

describe("tool call reports outside the tool_use stream", () => {
  const renderer = AcpToolCallRenderer.for(terminalAir);

  it("reports a memory recall as a completed read", () => {
    expect(
      renderer.memoryRecall({ uuid: "m", mode: "select", memories: [{ path: "/mem/a.md" }] }),
    ).toEqual({
      sessionUpdate: "tool_call",
      toolCallId: "m",
      title: "Recalled 1 memory",
      kind: "read",
      status: "completed",
      locations: [{ path: "/mem/a.md" }],
      _meta: { claudeCode: { toolName: "memory_recall", toolResponse: { mode: "select" } } },
    });
    expect(
      renderer.memoryRecall({
        uuid: "m",
        mode: "synthesize",
        memories: [{ path: "/mem/a.md", content: "Use pnpm" }],
      }),
    ).toMatchObject({
      title: "Recalled synthesized memory",
      content: [{ type: "content", content: { type: "text", text: "Use pnpm" } }],
    });
  });

  it("sends the denial reason once", () => {
    const denied = renderer.permissionDenied({
      toolCallId: "t",
      toolName: "Bash",
      decisionReasonType: "rule",
      decisionReason: "Denied by rule Bash(rm:*)",
      message: "Denied by rule Bash(rm:*)",
    }) as any;
    expect(denied.content).toEqual([
      {
        type: "content",
        content: { type: "text", text: "Permission denied: Denied by rule Bash(rm:*)" },
      },
    ]);
    expect(denied._meta.claudeCode.toolResponse).toEqual({ decisionReasonType: "rule" });
  });

  it("sends the in_progress status of progress beats once", () => {
    const tracker = new ToolCallFieldTracker();
    tracker.apply(renderer.toolCall({ id: "t", name: "Agent", input: {} }));
    const beat = (elapsedTimeSeconds: number) => {
      const update = renderer.progress({
        toolCallId: "t",
        toolName: "Agent",
        elapsedTimeSeconds,
        subagentType: "Explore",
      }) as any;
      tracker.apply(update);
      return update;
    };
    expect(beat(1).status).toBe("in_progress");
    const second = beat(2);
    expect(second).not.toHaveProperty("status");
    expect(second._meta.claudeCode.toolResponse).toEqual({
      elapsedTimeSeconds: 2,
      subagentType: "Explore",
    });
  });
});

describe("ChangedMetaFilter", () => {
  it("sends each _meta key of a tool call only when it changes", () => {
    const filter = new ChangedMetaFilter();
    filter.apply({
      sessionUpdate: "tool_call",
      toolCallId: "t",
      title: "ls",
      _meta: {
        claudeCode: { toolName: "Bash" },
        jetbrains: { air: { version: 1, commandTitle: "List" } },
        terminal_info: { terminal_id: "t" },
      },
    });

    expect(
      filter.apply({
        sessionUpdate: "tool_call_update",
        toolCallId: "t",
        _meta: {
          claudeCode: { toolName: "Bash" },
          jetbrains: { air: { version: 1, commandTitle: "List" } },
        },
      }),
    ).toBeNull();
    expect(
      filter.apply({
        sessionUpdate: "tool_call_update",
        toolCallId: "t",
        status: "completed",
        _meta: {
          claudeCode: { toolName: "Bash", toolResponse: { status: "completed" } },
          terminal_exit: { terminal_id: "t", exit_code: 0, signal: null },
        },
      }),
    ).toEqual({
      sessionUpdate: "tool_call_update",
      toolCallId: "t",
      status: "completed",
      _meta: {
        claudeCode: { toolResponse: { status: "completed" } },
        terminal_exit: { terminal_id: "t", exit_code: 0, signal: null },
      },
    });
  });

  it("never compares appended terminal output", () => {
    const filter = new ChangedMetaFilter();
    filter.apply({ sessionUpdate: "tool_call", toolCallId: "t", title: "ls" });
    const chunk = {
      sessionUpdate: "tool_call_update" as const,
      toolCallId: "t",
      _meta: { terminal_output: { terminal_id: "t", data: "." } },
    };
    expect(filter.apply(chunk)).toEqual(chunk);
    expect(filter.apply(chunk)).toEqual(chunk);
  });
});

describe("task plans", () => {
  it("publishes a Task* change once when the hook reports it first", async () => {
    const taskState: TaskState = new Map();
    const plans: unknown[] = [];
    const hook = createTaskHook({
      taskState,
      onChange: async () => {
        const entries = changedTaskPlanEntries(taskState);
        if (entries) plans.push(entries);
      },
    });
    await hook(
      {
        hook_event_name: "TaskCreated",
        task_id: "1",
        task_subject: "Write tests",
      } as any,
      undefined,
      { signal: new AbortController().signal },
    );
    const cache: ToolUseCache = {
      t: { type: "tool_use", id: "t", name: "TaskCreate", input: { subject: "Write tests" } },
    } as any;
    const updates = toAcpNotifications(
      [
        {
          type: "tool_result",
          tool_use_id: "t",
          content: "Task #1 created successfully: Write tests",
        },
      ],
      "user",
      "s",
      cache,
      {} as AcpClient,
      logger,
      { taskState, clientCapabilities: air },
    );

    expect(plans).toHaveLength(1);
    expect(updates).toEqual([]);
  });
});

describe("background Bash", () => {
  const completed = {
    sessionId: "s",
    update: {
      sessionUpdate: "tool_call_update" as const,
      toolCallId: "t",
      status: "completed" as const,
    },
  };

  it("marks the tool call of a command that became an async task", () => {
    expect(backgroundedBashToolCall(completed, { task_id: "b1", tool_use_id: "t" }, true)).toEqual({
      ...completed,
      update: {
        ...completed.update,
        _meta: { jetbrains: { air: { version: 1, asyncTasks: { backgrounded: true } } } },
      },
    });
  });

  it("sends no marker to a client without the asyncTasks capability", () => {
    expect(backgroundedBashToolCall(completed, { task_id: "b1", tool_use_id: "t" }, false)).toBe(
      completed,
    );
  });
});
