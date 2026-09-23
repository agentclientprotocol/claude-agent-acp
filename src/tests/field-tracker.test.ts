import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AcpClient,
  StreamedToolInputCache,
  streamEventToAcpNotifications,
  toAcpNotifications,
  ToolUseCache,
} from "../acp-agent.js";
import { ToolCallFieldTracker } from "../tool-calls/field-tracker.js";
import { createPostToolUseHook } from "../tools.js";

const logger = { log: () => {}, error: () => {} };
const patchCapabilities = {
  _meta: { jetbrains: { air: { version: 1, capabilities: ["diffPatch"] } } },
};

function recordingClient(updates: any[]): AcpClient {
  return {
    sessionUpdate: async (notification: any) => {
      updates.push(notification.update);
    },
  } as unknown as AcpClient;
}

async function firePostToolUse(toolUseId: string, toolName: string, toolResponse: unknown) {
  await createPostToolUseHook()(
    {
      hook_event_name: "PostToolUse",
      tool_name: toolName,
      tool_input: {},
      tool_response: toolResponse,
      tool_use_id: toolUseId,
      session_id: "test-session",
      transcript_path: "/tmp/test",
      cwd: "/tmp",
    } as any,
    toolUseId,
    { signal: new AbortController().signal },
  );
}

const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe("ToolCallFieldTracker", () => {
  it("removes unchanged fields and drops an update with nothing new", () => {
    const tracker = new ToolCallFieldTracker();
    tracker.apply({
      sessionUpdate: "tool_call",
      toolCallId: "t",
      title: "Read a.ts",
      kind: "read",
      rawInput: { file_path: "/a.ts" },
      _meta: { claudeCode: { toolName: "Read" } },
    });

    const repeated: any = {
      sessionUpdate: "tool_call_update",
      toolCallId: "t",
      title: "Read a.ts",
      kind: "read",
      rawInput: { file_path: "/a.ts" },
      _meta: { claudeCode: { toolName: "Read" } },
    };
    expect(tracker.apply(repeated)).toBe(false);
    expect(repeated).toEqual({
      sessionUpdate: "tool_call_update",
      toolCallId: "t",
      _meta: { claudeCode: { toolName: "Read" } },
    });

    const changed: any = {
      sessionUpdate: "tool_call_update",
      toolCallId: "t",
      title: "Read a.ts (1 - 10)",
      kind: "read",
      rawInput: { file_path: "/a.ts", limit: 10 },
    };
    expect(tracker.apply(changed)).toBe(true);
    expect(changed).toEqual({
      sessionUpdate: "tool_call_update",
      toolCallId: "t",
      title: "Read a.ts (1 - 10)",
      rawInput: { file_path: "/a.ts", limit: 10 },
    });
  });

  it("keeps an update whose _meta carries more than claudeCode", () => {
    const tracker = new ToolCallFieldTracker();
    tracker.apply({ sessionUpdate: "tool_call", toolCallId: "t", title: "ls" });
    const delta: any = {
      sessionUpdate: "tool_call_update",
      toolCallId: "t",
      _meta: { terminal_output_delta: { terminal_id: "t", data: "." } },
    };

    expect(tracker.apply(delta)).toBe(true);
    expect(tracker.apply({ ...delta })).toBe(true);
  });

  it("merges _meta.jetbrains.air keys like claudeCode keys", () => {
    const tracker = new ToolCallFieldTracker();
    const meta = {
      claudeCode: { toolName: "Bash" },
      jetbrains: { air: { version: 1, commandTitle: "List files" } },
    };
    tracker.apply({ sessionUpdate: "tool_call", toolCallId: "t", title: "ls", _meta: meta });

    expect(
      tracker.apply({ sessionUpdate: "tool_call_update", toolCallId: "t", _meta: meta } as any),
    ).toBe(false);
    expect(
      tracker.apply({
        sessionUpdate: "tool_call_update",
        toolCallId: "t",
        _meta: { ...meta, jetbrains: { air: { version: 1, commandTitle: "List all files" } } },
      } as any),
    ).toBe(true);
  });

  it("keeps pinned content until the final result replaces it", () => {
    const tracker = new ToolCallFieldTracker();
    const patch = [{ type: "diff" as const, path: "/a.ts", oldText: null, newText: "" }];
    tracker.apply({ sessionUpdate: "tool_call", toolCallId: "t", title: "Edit a.ts" });
    tracker.pinContent("t", patch);
    const snippet = [{ type: "diff", path: "/a.ts", oldText: "a", newText: "b" }];

    const refine: any = { sessionUpdate: "tool_call_update", toolCallId: "t", content: snippet };
    expect(tracker.apply(refine)).toBe(false);
    expect(refine).not.toHaveProperty("content");

    const final: any = { sessionUpdate: "tool_call_update", toolCallId: "t", content: snippet };
    expect(tracker.apply(final, { replacePinnedContent: true })).toBe(true);
    expect(final.content).toEqual(snippet);
  });

  it("ends an entry after both the tool_result and the hook", () => {
    const tracker = new ToolCallFieldTracker();
    tracker.apply({ sessionUpdate: "tool_call", toolCallId: "a", title: "A" });
    tracker.apply({ sessionUpdate: "tool_call", toolCallId: "b", title: "B" });
    tracker.apply({ sessionUpdate: "tool_call", toolCallId: "c", title: "C" });

    tracker.finishResult("a", false);
    tracker.finishResult("b", true);
    tracker.finishHook("c");
    expect(tracker.size).toBe(2);

    tracker.finishHook("b");
    tracker.finishResult("c", false);
    expect(tracker.size).toBe(0);
  });
});

describe("tool call refinements", () => {
  function streamed(toolCallFields: ToolCallFieldTracker) {
    const toolUseCache: ToolUseCache = {};
    const options = {
      cwd: "/work",
      emittedToolCalls: new Set<string>(),
      streamedToolInputs: new Map() as StreamedToolInputCache,
      toolCallFields,
      // AIR gets no rawInput until the input is complete.
      clientCapabilities: patchCapabilities,
    };
    const base = {
      type: "stream_event",
      parent_tool_use_id: null,
      uuid: randomUUID(),
      session_id: "test-session",
    };
    const send = (event: unknown) =>
      streamEventToAcpNotifications(
        { ...base, event } as Parameters<typeof streamEventToAcpNotifications>[0],
        "test-session",
        toolUseCache,
        {} as AcpClient,
        logger,
        options,
      );
    return { toolUseCache, options, send };
  }

  it("sends only the fields that each streamed refinement changes", () => {
    const { send } = streamed(new ToolCallFieldTracker());
    send({
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", id: "toolu_grep", name: "Grep", input: {} },
    });
    const first = send({
      type: "content_block_delta",
      index: 0,
      delta: { type: "input_json_delta", partial_json: '{"pattern":"todo",' },
    });
    const second = send({
      type: "content_block_delta",
      index: 0,
      delta: { type: "input_json_delta", partial_json: '"glob":"*.ts",' },
    });

    // No rawInput travels until the input is complete.
    expect(first[0].update).toMatchObject({ title: 'grep "todo"' });
    expect(first[0].update).not.toHaveProperty("rawInput");
    expect(first[0].update).not.toHaveProperty("kind");
    expect(second[0].update).toMatchObject({
      title: 'grep --include="*.ts" "todo"',
    });
    expect(second[0].update).not.toHaveProperty("rawInput");
    expect(second[0].update).not.toHaveProperty("kind");
  });

  it("does not resend a Write file that the tool call already carries", async () => {
    const tracker = new ToolCallFieldTracker();
    const toolUseCache: ToolUseCache = {};
    const emittedToolCalls = new Set<string>();
    const updates: any[] = [];
    const directory = await mkdtemp(path.join(os.tmpdir(), "claude-acp-fields-"));
    tempDirectories.push(directory);
    const filePath = path.join(directory, "new.ts");
    const content = "export const big = 1;\n".repeat(100);
    const toolUse = {
      type: "tool_use" as const,
      id: "toolu_write",
      name: "Write",
      input: { file_path: filePath, content },
    };
    const map = (chunk: unknown, role: "assistant" | "user" = "assistant") =>
      toAcpNotifications(
        [chunk] as any,
        role,
        "test-session",
        toolUseCache,
        recordingClient(updates),
        logger,
        {
          clientCapabilities: patchCapabilities,
          emittedToolCalls,
          toolCallFields: tracker,
        },
      );

    const call = map(toolUse);
    const refine = map(toolUse);
    await writeFile(filePath, content);
    const result = map(
      {
        type: "tool_result",
        tool_use_id: "toolu_write",
        content: `File created successfully at: ${filePath}`,
      },
      "user",
    );
    await firePostToolUse("toolu_write", "Write", {
      type: "create",
      filePath,
      content,
      structuredPatch: [],
      originalFile: null,
    });

    // The diff holds the file text once. rawInput leaves it out.
    expect(JSON.stringify(call).split("export const big").length - 1).toBe(100);
    expect((call[0].update as any).rawInput).toEqual({ file_path: filePath });
    expect(refine).toEqual([]);
    expect(result[0].update).not.toHaveProperty("content");
    // The hook builds the same creation patch, so it has nothing new to send.
    expect(updates).toEqual([]);
    expect(tracker.size).toBe(0);
  });

  it("lets the error of a rejected Edit replace a pinned approval patch", () => {
    const tracker = new ToolCallFieldTracker();
    const preview = [{ type: "diff" as const, path: "/a.ts", oldText: null, newText: "" }];
    tracker.apply({ sessionUpdate: "tool_call", toolCallId: "toolu_rejected", title: "Edit" });
    tracker.pinContent("toolu_rejected", preview);

    const result = toAcpNotifications(
      [
        {
          type: "tool_result",
          tool_use_id: "toolu_rejected",
          is_error: true,
          content: "The user doesn't want to proceed with this tool use.",
        },
      ],
      "user",
      "test-session",
      {
        toolu_rejected: {
          type: "tool_use",
          id: "toolu_rejected",
          name: "Edit",
          input: { file_path: "/a.ts", old_string: "a", new_string: "b" },
        },
      },
      {} as AcpClient,
      logger,
      { registerHooks: false, toolCallFields: tracker },
    );

    expect(result[0].update).toMatchObject({
      status: "failed",
      content: [{ type: "content", content: { type: "text" } }],
    });
  });

  it("keeps an approval patch against the snippet refinement until the hook", async () => {
    const tracker = new ToolCallFieldTracker();
    const toolUseCache: ToolUseCache = {};
    const emittedToolCalls = new Set<string>(["toolu_edit"]);
    const updates: any[] = [];
    const preview = [
      {
        type: "diff" as const,
        path: "/a.ts",
        oldText: null,
        newText: "",
        _meta: { jetbrains: { air: { version: 1, diffPatch: { text: "exact" } } } },
      },
    ];
    // The permission flow emitted the tool call with the exact patch.
    tracker.apply({
      sessionUpdate: "tool_call",
      toolCallId: "toolu_edit",
      title: "Edit /a.ts",
      content: preview,
    });
    tracker.pinContent("toolu_edit", preview);

    const refine = toAcpNotifications(
      [
        {
          type: "tool_use",
          id: "toolu_edit",
          name: "Edit",
          input: { file_path: "/a.ts", old_string: "a", new_string: "b" },
        },
      ],
      "assistant",
      "test-session",
      toolUseCache,
      recordingClient(updates),
      logger,
      { emittedToolCalls, toolCallFields: tracker },
    );
    await firePostToolUse("toolu_edit", "Edit", {
      filePath: "/a.ts",
      oldString: "a",
      newString: "b",
      originalFile: "a\n",
      structuredPatch: [
        { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ["-a", "+b"] },
      ],
    });

    expect(refine[0].update).not.toHaveProperty("content");
    expect(updates).toHaveLength(1);
    expect(updates[0].content).toEqual([
      { type: "diff", path: "/a.ts", oldText: "a", newText: "b" },
    ]);
  });
});
