import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { ClientCapabilities } from "@agentclientprotocol/sdk";
import { ImageBlockParam, ToolResultBlockParam } from "@anthropic-ai/sdk/resources";
import {
  BetaMCPToolResultBlock,
  BetaTextBlock,
  BetaWebSearchResultBlock,
  BetaWebSearchToolResultBlock,
  BetaBashCodeExecutionToolResultBlock,
  BetaBashCodeExecutionResultBlock,
  BetaBashCodeExecutionToolResultBlockParam,
} from "@anthropic-ai/sdk/resources/beta.mjs";
import { AcpClient, toAcpNotifications, ToolUseCache, Logger } from "../acp-agent.js";
import {
  toolUpdateFromToolResult,
  createPostToolUseHook,
  createTaskHook,
  clearHookCallbacks,
  registerHookCallback,
  toolInfoFromToolUse,
  planEntries,
  applyTaskCreate,
  applyTaskList,
  applyTaskUpdate,
  parseTaskCreateOutput,
  parseTaskListOutput,
  taskStateToPlanEntries,
  TaskState,
} from "../tools.js";

describe("PostToolUse callback ownership", () => {
  it("clears only callbacks owned by the cancelled session", async () => {
    const first = vi.fn(async () => {});
    const second = vi.fn(async () => {});
    registerHookCallback("owned-first", { onPostToolUseHook: first }, "session-one");
    registerHookCallback("owned-second", { onPostToolUseHook: second }, "session-two");

    clearHookCallbacks("session-one");
    const hook = createPostToolUseHook();
    const context = { signal: new AbortController().signal };
    await hook(
      { hook_event_name: "PostToolUse", tool_input: {}, tool_response: {} } as any,
      "owned-first",
      context,
    );
    await hook(
      { hook_event_name: "PostToolUse", tool_input: {}, tool_response: {} } as any,
      "owned-second",
      context,
    );

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledOnce();
  });
});

describe("rawOutput in tool call updates", () => {
  const mockClient = {} as AcpClient;
  const mockLogger: Logger = { log: () => {}, error: () => {} };

  it("should include rawOutput with string content for tool_result", () => {
    const toolUseCache: ToolUseCache = {
      toolu_123: {
        type: "tool_use",
        id: "toolu_123",
        name: "Bash",
        input: { command: "echo hello" },
      },
    };

    const toolResult: ToolResultBlockParam = {
      type: "tool_result",
      tool_use_id: "toolu_123",
      content: "hello\n",
      is_error: false,
    };

    const notifications = toAcpNotifications(
      [toolResult],
      "assistant",
      "test-session",
      toolUseCache,
      mockClient,
      mockLogger,
    );

    expect(notifications).toHaveLength(1);
    expect(notifications[0].update).toMatchObject({
      sessionUpdate: "tool_call_update",
      toolCallId: "toolu_123",
      status: "completed",
      rawOutput: "hello\n",
    });
  });

  it("should include rawOutput with array content for tool_result", () => {
    const toolUseCache: ToolUseCache = {
      toolu_456: {
        type: "tool_use",
        id: "toolu_456",
        name: "Read",
        input: { file_path: "/test/file.txt" },
      },
    };

    // ToolResultBlockParam content can be string or array of TextBlockParam
    const toolResult: ToolResultBlockParam = {
      type: "tool_result",
      tool_use_id: "toolu_456",
      content: [{ type: "text", text: "Line 1\nLine 2\nLine 3" }],
      is_error: false,
    };

    const notifications = toAcpNotifications(
      [toolResult],
      "assistant",
      "test-session",
      toolUseCache,
      mockClient,
      mockLogger,
    );

    expect(notifications).toHaveLength(1);
    expect(notifications[0].update).toMatchObject({
      sessionUpdate: "tool_call_update",
      toolCallId: "toolu_456",
      status: "completed",
      rawOutput: [{ type: "text", text: "Line 1\nLine 2\nLine 3" }],
    });
  });

  it("should include rawOutput for mcp_tool_result with string content", () => {
    const toolUseCache: ToolUseCache = {
      toolu_789: {
        type: "tool_use",
        id: "toolu_789",
        name: "mcp__server__tool",
        input: { query: "test" },
      },
    };

    // BetaMCPToolResultBlock content can be string or Array<BetaTextBlock>
    const toolResult: BetaMCPToolResultBlock = {
      type: "mcp_tool_result",
      tool_use_id: "toolu_789",
      content: '{"result": "success", "data": [1, 2, 3]}',
      is_error: false,
    };

    const notifications = toAcpNotifications(
      [toolResult],
      "assistant",
      "test-session",
      toolUseCache,
      mockClient,
      mockLogger,
    );

    expect(notifications).toHaveLength(1);
    expect(notifications[0].update).toMatchObject({
      sessionUpdate: "tool_call_update",
      toolCallId: "toolu_789",
      status: "completed",
      rawOutput: '{"result": "success", "data": [1, 2, 3]}',
    });
  });

  it("should include rawOutput for mcp_tool_result with array content", () => {
    const toolUseCache: ToolUseCache = {
      toolu_abc: {
        type: "tool_use",
        id: "toolu_abc",
        name: "mcp__server__search",
        input: { term: "test" },
      },
    };

    // BetaTextBlock requires citations field
    const arrayContent: BetaTextBlock[] = [
      { type: "text", text: "Result 1", citations: null },
      { type: "text", text: "Result 2", citations: null },
    ];

    const toolResult: BetaMCPToolResultBlock = {
      type: "mcp_tool_result",
      tool_use_id: "toolu_abc",
      content: arrayContent,
      is_error: false,
    };

    const notifications = toAcpNotifications(
      [toolResult],
      "assistant",
      "test-session",
      toolUseCache,
      mockClient,
      mockLogger,
    );

    expect(notifications).toHaveLength(1);
    expect(notifications[0].update).toMatchObject({
      sessionUpdate: "tool_call_update",
      toolCallId: "toolu_abc",
      status: "completed",
      rawOutput: arrayContent,
    });
  });

  it("should include rawOutput for web_search_tool_result", () => {
    const toolUseCache: ToolUseCache = {
      toolu_web: {
        type: "tool_use",
        id: "toolu_web",
        name: "WebSearch",
        input: { query: "test search" },
      },
    };

    // BetaWebSearchResultBlock from SDK
    const searchResults: BetaWebSearchResultBlock[] = [
      {
        type: "web_search_result",
        url: "https://example.com",
        title: "Example",
        encrypted_content: "encrypted content here",
        page_age: "2 days ago",
      },
    ];

    const toolResult: BetaWebSearchToolResultBlock = {
      type: "web_search_tool_result",
      tool_use_id: "toolu_web",
      content: searchResults,
    };

    const notifications = toAcpNotifications(
      [toolResult],
      "assistant",
      "test-session",
      toolUseCache,
      mockClient,
      mockLogger,
    );

    expect(notifications).toHaveLength(1);
    expect(notifications[0].update).toMatchObject({
      sessionUpdate: "tool_call_update",
      toolCallId: "toolu_web",
      status: "completed",
      rawOutput: searchResults,
    });
  });

  it("should include rawOutput for bash_code_execution_tool_result", () => {
    const toolUseCache: ToolUseCache = {
      toolu_bash: {
        type: "tool_use",
        id: "toolu_bash",
        name: "Bash",
        input: { command: "ls -la" },
      },
    };

    // BetaBashCodeExecutionResultBlock from SDK
    const bashResult: BetaBashCodeExecutionResultBlock = {
      type: "bash_code_execution_result",
      stdout: "file1.txt\nfile2.txt",
      stderr: "",
      return_code: 0,
      content: [],
    };

    const toolResult: BetaBashCodeExecutionToolResultBlock = {
      type: "bash_code_execution_tool_result",
      tool_use_id: "toolu_bash",
      content: bashResult,
    };

    const notifications = toAcpNotifications(
      [toolResult],
      "assistant",
      "test-session",
      toolUseCache,
      mockClient,
      mockLogger,
    );

    expect(notifications).toHaveLength(1);
    expect(notifications[0].update).toMatchObject({
      sessionUpdate: "tool_call_update",
      toolCallId: "toolu_bash",
      status: "completed",
      rawOutput: bashResult,
    });
  });

  it("should set status to failed when is_error is true", () => {
    const toolUseCache: ToolUseCache = {
      toolu_err: {
        type: "tool_use",
        id: "toolu_err",
        name: "Bash",
        input: { command: "invalid_command" },
      },
    };

    const toolResult: ToolResultBlockParam = {
      type: "tool_result",
      tool_use_id: "toolu_err",
      content: "command not found: invalid_command",
      is_error: true,
    };

    const notifications = toAcpNotifications(
      [toolResult],
      "assistant",
      "test-session",
      toolUseCache,
      mockClient,
      mockLogger,
    );

    expect(notifications).toHaveLength(1);
    expect(notifications[0].update).toMatchObject({
      sessionUpdate: "tool_call_update",
      toolCallId: "toolu_err",
      status: "failed",
      rawOutput: "command not found: invalid_command",
    });
  });

  it("should not emit tool_call_update for TodoWrite (emits plan instead)", () => {
    const toolUseCache: ToolUseCache = {
      toolu_todo: {
        type: "tool_use",
        id: "toolu_todo",
        name: "TodoWrite",
        input: { todos: [{ content: "Test task", status: "pending" }] },
      },
    };

    const toolResult: ToolResultBlockParam = {
      type: "tool_result",
      tool_use_id: "toolu_todo",
      content: "Todos updated successfully",
      is_error: false,
    };

    const notifications = toAcpNotifications(
      [toolResult],
      "assistant",
      "test-session",
      toolUseCache,
      mockClient,
      mockLogger,
    );

    // TodoWrite should not emit tool_call_update - it emits plan updates instead
    expect(notifications).toHaveLength(0);
  });

  it("should convert Read tool base64 image content to ACP image format", () => {
    const toolUseCache: ToolUseCache = {
      toolu_img: {
        type: "tool_use",
        id: "toolu_img",
        name: "Read",
        input: { file_path: "/test/image.png" },
      },
    };

    const imageBlock: ImageBlockParam = {
      type: "image",
      source: { type: "base64", data: "iVBORw0KGgo=", media_type: "image/png" },
    };

    const toolResult: ToolResultBlockParam = {
      type: "tool_result",
      tool_use_id: "toolu_img",
      content: [imageBlock],
      is_error: false,
    };

    const notifications = toAcpNotifications(
      [toolResult],
      "assistant",
      "test-session",
      toolUseCache,
      mockClient,
      mockLogger,
    );

    expect(notifications).toHaveLength(1);
    expect(notifications[0].update).toMatchObject({
      sessionUpdate: "tool_call_update",
      toolCallId: "toolu_img",
      status: "completed",
      content: [
        {
          type: "content",
          content: { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
        },
      ],
    });
  });

  it("should handle Read tool with mixed text and image content", () => {
    const toolUseCache: ToolUseCache = {
      toolu_mix: {
        type: "tool_use",
        id: "toolu_mix",
        name: "Read",
        input: { file_path: "/test/image.png" },
      },
    };

    const imageBlock: ImageBlockParam = {
      type: "image",
      source: { type: "base64", data: "iVBORw0KGgo=", media_type: "image/png" },
    };

    const toolResult: ToolResultBlockParam = {
      type: "tool_result",
      tool_use_id: "toolu_mix",
      content: [{ type: "text", text: "File preview:" }, imageBlock],
      is_error: false,
    };

    const notifications = toAcpNotifications(
      [toolResult],
      "assistant",
      "test-session",
      toolUseCache,
      mockClient,
      mockLogger,
    );

    expect(notifications).toHaveLength(1);
    expect(notifications[0].update).toMatchObject({
      sessionUpdate: "tool_call_update",
      toolCallId: "toolu_mix",
      status: "completed",
      content: [
        {
          type: "content",
          content: { type: "text", text: "```\nFile preview:\n```" },
        },
        {
          type: "content",
          content: { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
        },
      ],
    });
  });
});

describe("Bash terminal output", () => {
  const mockClient = {} as AcpClient;
  const mockLogger: Logger = { log: () => {}, error: () => {} };

  const bashToolUse = {
    type: "tool_use",
    id: "toolu_bash",
    name: "Bash",
    input: { command: "ls -la" },
  };

  const makeBashResult = (
    stdout: string,
    stderr: string,
    return_code: number,
  ): BetaBashCodeExecutionToolResultBlockParam => ({
    type: "bash_code_execution_tool_result",
    tool_use_id: "toolu_bash",
    content: {
      type: "bash_code_execution_result",
      stdout,
      stderr,
      return_code,
      content: [],
    },
  });

  describe("toolUpdateFromToolResult", () => {
    it("should return formatted content without _meta when supportsTerminalOutput is false", () => {
      const toolResult = makeBashResult("file1.txt\nfile2.txt", "", 0);
      const update = toolUpdateFromToolResult(toolResult, bashToolUse, false);

      expect(update).toEqual({
        content: [
          {
            type: "content",
            content: {
              type: "text",
              text: "```console\nfile1.txt\nfile2.txt\n```",
            },
          },
        ],
      });
      expect(update._meta).toBeUndefined();
    });

    it("should return no content with _meta when supportsTerminalOutput is true", () => {
      const toolResult = makeBashResult("file1.txt\nfile2.txt", "", 0);
      const update = toolUpdateFromToolResult(toolResult, bashToolUse, true);

      expect(update.content).toEqual([{ type: "terminal", terminalId: "toolu_bash" }]);
      expect(update._meta).toEqual({
        terminal_info: {
          terminal_id: "toolu_bash",
        },
        terminal_output: {
          terminal_id: "toolu_bash",
          data: "file1.txt\nfile2.txt",
        },
        terminal_exit: {
          terminal_id: "toolu_bash",
          exit_code: 0,
          signal: null,
        },
      });
    });

    it("keys the terminal metas off the tool_use id, which is what was announced", () => {
      // `toolInfoFromToolUse` announces the terminal as `toolUse.id`, so the
      // result's metas have to use the same value for the client to match them
      // up. A result block that disagrees (or omits `tool_use_id`) must not be
      // allowed to retarget them.
      const toolResult = {
        ...makeBashResult("out", "", 0),
        tool_use_id: "toolu_something_else",
      };
      const update = toolUpdateFromToolResult(toolResult, bashToolUse, true);

      expect(update.content).toEqual([{ type: "terminal", terminalId: "toolu_bash" }]);
      expect(update._meta).toEqual({
        terminal_info: { terminal_id: "toolu_bash" },
        terminal_output: { terminal_id: "toolu_bash", data: "out" },
        terminal_exit: { terminal_id: "toolu_bash", exit_code: 0, signal: null },
      });
    });

    it("falls back to the result's tool_use_id when the tool_use is unavailable", () => {
      const toolResult = makeBashResult("out", "", 0);
      const update = toolUpdateFromToolResult(toolResult, { name: "Bash" }, true);

      expect(update.content).toEqual([{ type: "terminal", terminalId: "toolu_bash" }]);
      expect(update._meta).toEqual({
        terminal_info: { terminal_id: "toolu_bash" },
        terminal_output: { terminal_id: "toolu_bash", data: "out" },
        terminal_exit: { terminal_id: "toolu_bash", exit_code: 0, signal: null },
      });
    });

    it("renders a code block instead of a dangling terminal when no id is available", () => {
      // Previously this emitted `terminal_id: ""` for all three metas. Nothing
      // on the client has a terminal under that id, so the output was stranded
      // (Zed buffers output/exit for unknown terminals indefinitely) and the
      // user saw an empty terminal. Degrade to the non-terminal rendering.
      // `tool_use_id` is required on every result-block type, so a block without
      // it can only arrive at runtime (an older or non-conforming emitter). The
      // source guards for it with `"tool_use_id" in toolResult`, so exercise that
      // path with a cast rather than pretending the type allows it.
      const { content, type } = makeBashResult("out", "", 0);
      const update = toolUpdateFromToolResult(
        { content, type } as unknown as Parameters<typeof toolUpdateFromToolResult>[0],
        { name: "Bash" },
        true,
      );

      expect(update._meta).toBeUndefined();
      expect(update.content).toEqual([
        {
          type: "content",
          content: { type: "text", text: "```console\nout\n```" },
        },
      ]);
    });

    it("treats an empty tool_use id as no id and falls back to the result block", () => {
      const toolResult = makeBashResult("out", "", 0);
      const update = toolUpdateFromToolResult(toolResult, { id: "", name: "Bash" }, true);

      expect(update.content).toEqual([{ type: "terminal", terminalId: "toolu_bash" }]);
      expect(update._meta).toEqual({
        terminal_info: { terminal_id: "toolu_bash" },
        terminal_output: { terminal_id: "toolu_bash", data: "out" },
        terminal_exit: { terminal_id: "toolu_bash", exit_code: 0, signal: null },
      });
    });

    it("renders a code block when neither id is a usable string", () => {
      // A present-but-undefined `tool_use_id` still satisfies an `in` check, and
      // stringifying it would key all three metas on the literal "undefined" — an
      // id no client ever created a terminal for, so the output strands exactly as
      // it did under the old empty-string id.
      const toolResult = {
        ...makeBashResult("out", "", 0),
        tool_use_id: undefined,
      } as unknown as Parameters<typeof toolUpdateFromToolResult>[0];
      const update = toolUpdateFromToolResult(toolResult, { id: "", name: "Bash" }, true);

      expect(update._meta).toBeUndefined();
      expect(update.content).toEqual([
        {
          type: "content",
          content: { type: "text", text: "```console\nout\n```" },
        },
      ]);
    });

    it("should include exit_code from return_code in terminal_exit", () => {
      const toolResult = makeBashResult("", "command not found", 127);
      const update = toolUpdateFromToolResult(toolResult, bashToolUse, true);

      expect(update._meta?.terminal_exit).toEqual({
        terminal_id: "toolu_bash",
        exit_code: 127,
        signal: null,
      });
    });

    it("should route failed commands through the terminal when supportsTerminalOutput is true", () => {
      const toolResult: ToolResultBlockParam = {
        type: "tool_result",
        tool_use_id: "toolu_bash",
        content: "some error output",
        is_error: true,
      };
      const update = toolUpdateFromToolResult(toolResult, bashToolUse, true);

      expect(update.content).toEqual([{ type: "terminal", terminalId: "toolu_bash" }]);
      expect(update._meta).toEqual({
        terminal_info: { terminal_id: "toolu_bash" },
        terminal_output: { terminal_id: "toolu_bash", data: "some error output" },
        terminal_exit: { terminal_id: "toolu_bash", exit_code: 1, signal: null },
      });
    });

    it("should fall back to stderr when stdout is empty", () => {
      const toolResult = makeBashResult("", "some error output", 1);
      const update = toolUpdateFromToolResult(toolResult, bashToolUse, false);

      expect(update.content).toEqual([
        {
          type: "content",
          content: {
            type: "text",
            text: "```console\nsome error output\n```",
          },
        },
      ]);
    });

    it("should return no content with _meta when output is empty and supportsTerminalOutput is true", () => {
      const toolResult = makeBashResult("", "", 0);
      const update = toolUpdateFromToolResult(toolResult, bashToolUse, true);

      expect(update.content).toEqual([{ type: "terminal", terminalId: "toolu_bash" }]);
      expect(update._meta).toEqual({
        terminal_info: {
          terminal_id: "toolu_bash",
        },
        terminal_output: {
          terminal_id: "toolu_bash",
          data: "",
        },
        terminal_exit: {
          terminal_id: "toolu_bash",
          exit_code: 0,
          signal: null,
        },
      });
    });

    it("should return empty object when output is empty and supportsTerminalOutput is false", () => {
      const toolResult = makeBashResult("", "", 0);
      const update = toolUpdateFromToolResult(toolResult, bashToolUse, false);

      expect(update).toEqual({});
    });

    it("should default supportsTerminalOutput to false when not provided", () => {
      const toolResult = makeBashResult("hello", "", 0);
      const update = toolUpdateFromToolResult(toolResult, bashToolUse);

      expect(update._meta).toBeUndefined();
      expect(update.content).toEqual([
        {
          type: "content",
          content: {
            type: "text",
            text: "```console\nhello\n```",
          },
        },
      ]);
    });

    it("should preserve trailing whitespace in _meta data when supportsTerminalOutput is true", () => {
      const toolResult = makeBashResult("hello\n\n\n", "", 0);
      const update = toolUpdateFromToolResult(toolResult, bashToolUse, true);

      expect(update.content).toEqual([{ type: "terminal", terminalId: "toolu_bash" }]);
      expect(update._meta?.terminal_output?.data).toBe("hello\n\n\n");
    });

    describe("with plain string tool_result (production format)", () => {
      const makeStringBashResult = (
        content: string,
        is_error: boolean = false,
      ): ToolResultBlockParam => ({
        type: "tool_result",
        tool_use_id: "toolu_bash",
        content,
        is_error,
      });

      it("should format string content as sh code block without _meta when supportsTerminalOutput is false", () => {
        const toolResult = makeStringBashResult("Cargo.lock\nCargo.toml\nREADME.md");
        const update = toolUpdateFromToolResult(toolResult, bashToolUse, false);

        expect(update).toEqual({
          content: [
            {
              type: "content",
              content: {
                type: "text",
                text: "```console\nCargo.lock\nCargo.toml\nREADME.md\n```",
              },
            },
          ],
        });
        expect(update._meta).toBeUndefined();
      });

      it("should return no content with _meta when supportsTerminalOutput is true", () => {
        const toolResult = makeStringBashResult("Cargo.lock\nCargo.toml\nREADME.md");
        const update = toolUpdateFromToolResult(toolResult, bashToolUse, true);

        expect(update.content).toEqual([{ type: "terminal", terminalId: "toolu_bash" }]);
        expect(update._meta).toEqual({
          terminal_info: { terminal_id: "toolu_bash" },
          terminal_output: { terminal_id: "toolu_bash", data: "Cargo.lock\nCargo.toml\nREADME.md" },
          terminal_exit: { terminal_id: "toolu_bash", exit_code: 0, signal: null },
        });
      });

      it("should route is_error through the terminal when supportsTerminalOutput is true", () => {
        const toolResult = makeStringBashResult("command not found: bad_cmd", true);
        const update = toolUpdateFromToolResult(toolResult, bashToolUse, true);

        // Failed Bash commands skip the early error return and reach the Bash
        // case so the client receives terminal output with a non-zero exit code
        // instead of plain markdown details.
        expect(update.content).toEqual([{ type: "terminal", terminalId: "toolu_bash" }]);
        expect(update._meta).toEqual({
          terminal_info: { terminal_id: "toolu_bash" },
          terminal_output: { terminal_id: "toolu_bash", data: "command not found: bad_cmd" },
          terminal_exit: { terminal_id: "toolu_bash", exit_code: 1, signal: null },
        });
      });

      it("should use error handler when is_error is true and terminal output is unsupported", () => {
        const toolResult = makeStringBashResult("command not found: bad_cmd", true);
        const update = toolUpdateFromToolResult(toolResult, bashToolUse, false);

        // is_error with content hits the early error return at the top of
        // toolUpdateFromToolResult, before reaching the Bash switch case.
        // So there's no terminal _meta, just error-formatted content.
        expect(update._meta).toBeUndefined();
        expect(update.content).toEqual([
          {
            type: "content",
            content: {
              type: "text",
              text: "```\ncommand not found: bad_cmd\n```",
            },
          },
        ]);
      });

      it("should return empty object for empty string content without terminal support", () => {
        const toolResult = makeStringBashResult("");
        const update = toolUpdateFromToolResult(toolResult, bashToolUse, false);

        expect(update).toEqual({});
      });

      it("should return no content with _meta for empty string content with terminal support", () => {
        const toolResult = makeStringBashResult("");
        const update = toolUpdateFromToolResult(toolResult, bashToolUse, true);

        expect(update.content).toEqual([{ type: "terminal", terminalId: "toolu_bash" }]);
        expect(update._meta).toEqual({
          terminal_info: { terminal_id: "toolu_bash" },
          terminal_output: { terminal_id: "toolu_bash", data: "" },
          terminal_exit: { terminal_id: "toolu_bash", exit_code: 0, signal: null },
        });
      });

      it("should handle array content with text blocks", () => {
        const toolResult: ToolResultBlockParam = {
          type: "tool_result",
          tool_use_id: "toolu_bash",
          content: [{ type: "text", text: "line1\nline2" }],
          is_error: false,
        };
        const update = toolUpdateFromToolResult(toolResult, bashToolUse, false);

        expect(update).toEqual({
          content: [
            {
              type: "content",
              content: {
                type: "text",
                text: "```console\nline1\nline2\n```",
              },
            },
          ],
        });
      });
    });

    describe("with image array tool_result (local Bash image output path)", () => {
      // The local Bash tool emits image content as
      // `[{ type: "image", source: { type: "base64", ... } }]` when a
      // command produces an image (e.g. piping a base64 data URI).
      const makeImageBashResult = (
        data: string,
        media_type: "image/png" | "image/jpeg" | "image/gif" | "image/webp" = "image/png",
      ): ToolResultBlockParam => ({
        type: "tool_result",
        tool_use_id: "toolu_bash",
        content: [
          {
            type: "image",
            source: { type: "base64", media_type, data },
          } as ImageBlockParam,
        ],
      });

      it("should surface image content as ACP image content (terminal disabled)", () => {
        const toolResult = makeImageBashResult("iVBORw0KGgo=");
        const update = toolUpdateFromToolResult(toolResult, bashToolUse, false);

        expect(update.content).toEqual([
          {
            type: "content",
            content: { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
          },
        ]);
        expect(update._meta).toBeUndefined();
      });

      it("should bypass terminal _meta even when supportsTerminalOutput is true", () => {
        // Binary content cannot be streamed through the terminal-output
        // _meta channel, so the fix returns ACP content directly and skips
        // the terminal info/output/exit triple.
        const toolResult = makeImageBashResult("iVBORw0KGgo=", "image/jpeg");
        const update = toolUpdateFromToolResult(toolResult, bashToolUse, true);

        expect(update.content).toEqual([
          {
            type: "content",
            content: { type: "image", data: "iVBORw0KGgo=", mimeType: "image/jpeg" },
          },
        ]);
        expect(update._meta).toBeUndefined();
      });

      it("should still surface multi-block content with text + image mixed", () => {
        const toolResult: ToolResultBlockParam = {
          type: "tool_result",
          tool_use_id: "toolu_bash",
          content: [
            { type: "text", text: "generated:" },
            {
              type: "image",
              source: { type: "base64", media_type: "image/png", data: "AAAA" },
            } as ImageBlockParam,
          ],
        };
        const update = toolUpdateFromToolResult(toolResult, bashToolUse, false);

        expect(update.content).toEqual([
          { type: "content", content: { type: "text", text: "generated:" } },
          {
            type: "content",
            content: { type: "image", data: "AAAA", mimeType: "image/png" },
          },
        ]);
      });
    });
  });

  describe("toAcpNotifications with clientCapabilities", () => {
    // Reset before each test: toAcpNotifications prunes the cache entry once it
    // maps the tool_result, so a shared object would be empty by the 2nd test.
    let toolUseCache: ToolUseCache;
    beforeEach(() => {
      toolUseCache = {
        toolu_bash: {
          type: "tool_use",
          id: "toolu_bash",
          name: "Bash",
          input: { command: "ls -la" },
        },
      };
    });

    const bashResult: BetaBashCodeExecutionResultBlock = {
      type: "bash_code_execution_result",
      stdout: "file1.txt\nfile2.txt",
      stderr: "",
      return_code: 0,
      content: [],
    };

    const toolResult: BetaBashCodeExecutionToolResultBlock = {
      type: "bash_code_execution_tool_result",
      tool_use_id: "toolu_bash",
      content: bashResult,
    };

    it("should include terminal _meta when client declares terminal_output support", () => {
      const clientCapabilities: ClientCapabilities = {
        _meta: { terminal_output: true },
      };

      const notifications = toAcpNotifications(
        [toolResult],
        "assistant",
        "test-session",
        toolUseCache,
        mockClient,
        mockLogger,
        { clientCapabilities },
      );

      // Split into 2 notifications: terminal_output, then terminal_exit + completion
      expect(notifications).toHaveLength(2);

      // First notification: terminal_output only
      const outputUpdate = notifications[0].update;
      expect(outputUpdate).toMatchObject({
        sessionUpdate: "tool_call_update",
        toolCallId: "toolu_bash",
      });
      expect((outputUpdate as any)._meta).toEqual({
        terminal_output: { terminal_id: "toolu_bash", data: "file1.txt\nfile2.txt" },
      });
      expect((outputUpdate as any).status).toBeUndefined();

      // Second notification: terminal_exit + status + content
      const exitUpdate = notifications[1].update;
      expect(exitUpdate).toMatchObject({
        sessionUpdate: "tool_call_update",
        toolCallId: "toolu_bash",
        status: "completed",
      });
      expect((exitUpdate as any)._meta).toMatchObject({
        terminal_exit: { terminal_id: "toolu_bash", exit_code: 0, signal: null },
      });
      // terminal_info and terminal_output should NOT be on the exit notification
      expect((exitUpdate as any)._meta).not.toHaveProperty("terminal_info");
      expect((exitUpdate as any)._meta).not.toHaveProperty("terminal_output");
      expect(exitUpdate).not.toHaveProperty("rawOutput");
    });

    it("should not include terminal _meta when client does not declare terminal_output support", () => {
      const notifications = toAcpNotifications(
        [toolResult],
        "assistant",
        "test-session",
        toolUseCache,
        mockClient,
        mockLogger,
      );

      expect(notifications).toHaveLength(1);
      const update = notifications[0].update;
      expect(update).toMatchObject({
        sessionUpdate: "tool_call_update",
        toolCallId: "toolu_bash",
        status: "completed",
      });
      expect((update as any)._meta).not.toHaveProperty("terminal_info");
      expect((update as any)._meta).not.toHaveProperty("terminal_output");
      expect((update as any)._meta).not.toHaveProperty("terminal_exit");
      expect(update).toHaveProperty("rawOutput", bashResult);
    });

    it("should not include terminal _meta when _meta.terminal_output is false", () => {
      const clientCapabilities: ClientCapabilities = {
        _meta: { terminal_output: false },
      };

      const notifications = toAcpNotifications(
        [toolResult],
        "assistant",
        "test-session",
        toolUseCache,
        mockClient,
        mockLogger,
        { clientCapabilities },
      );

      expect(notifications).toHaveLength(1);
      expect((notifications[0].update as any)._meta).not.toHaveProperty("terminal_output");
    });

    it("should include formatted content only when terminal_output is not supported", () => {
      const withSupport = toAcpNotifications(
        [toolResult],
        "assistant",
        "test-session",
        toolUseCache,
        mockClient,
        mockLogger,
        { clientCapabilities: { _meta: { terminal_output: true } } },
      );

      // Fresh cache: the withSupport call above already consumed the entry,
      // since toAcpNotifications prunes the tool_use once it maps the result.
      const toolUseCacheWithoutSupport: ToolUseCache = {
        toolu_bash: {
          type: "tool_use",
          id: "toolu_bash",
          name: "Bash",
          input: { command: "ls -la" },
        },
      };
      const withoutSupport = toAcpNotifications(
        [toolResult],
        "assistant",
        "test-session",
        toolUseCacheWithoutSupport,
        mockClient,
        mockLogger,
      );

      // With support: output is delivered via terminal_output _meta, content references the terminal widget
      expect(withSupport).toHaveLength(2);
      expect((withSupport[1].update as any).content).toEqual([
        { type: "terminal", terminalId: "toolu_bash" },
      ]);

      // Without support: content is on the only notification
      expect((withoutSupport[0].update as any).content).toEqual([
        {
          type: "content",
          content: {
            type: "text",
            text: "```console\nfile1.txt\nfile2.txt\n```",
          },
        },
      ]);
    });

    it("should preserve claudeCode in _meta alongside terminal_exit on completion notification", () => {
      const clientCapabilities: ClientCapabilities = {
        _meta: { terminal_output: true },
      };

      const notifications = toAcpNotifications(
        [toolResult],
        "assistant",
        "test-session",
        toolUseCache,
        mockClient,
        mockLogger,
        { clientCapabilities },
      );

      expect(notifications).toHaveLength(2);

      // First notification (terminal_output) has no claudeCode
      const outputMeta = (notifications[0].update as any)._meta;
      expect(outputMeta.terminal_output).toBeDefined();
      expect(outputMeta.claudeCode).toBeUndefined();

      // Second notification (completion) has claudeCode + terminal_exit
      const exitMeta = (notifications[1].update as any)._meta;
      expect(exitMeta.claudeCode).toEqual({ toolName: "Bash" });
      expect(exitMeta.terminal_exit).toBeDefined();
    });
  });

  describe("toolUseCache pruning", () => {
    it("retains the tool_use entry until its result, then prunes it", () => {
      const toolUseCache: ToolUseCache = {};
      const toolUse = {
        type: "tool_use" as const,
        id: "toolu_read",
        name: "Read",
        input: { file_path: "/tmp/x.txt" },
      };

      // tool_use is cached and kept (the matching result hasn't arrived yet).
      toAcpNotifications([toolUse], "assistant", "s", toolUseCache, mockClient, mockLogger);
      expect(toolUseCache.toolu_read).toBeDefined();

      // tool_result resolves it, so the entry is pruned to bound memory.
      const toolResult: ToolResultBlockParam = {
        type: "tool_result",
        tool_use_id: "toolu_read",
        content: [{ type: "text", text: "hello" }],
      };
      toAcpNotifications([toolResult], "assistant", "s", toolUseCache, mockClient, mockLogger);
      expect(toolUseCache.toolu_read).toBeUndefined();
    });
  });

  describe("post-tool-use hook sends diff content for Edit tool", () => {
    it("should include content and locations from structuredPatch in hook update", async () => {
      const toolUseCache: ToolUseCache = {};

      const hookUpdates: any[] = [];
      const mockClientWithUpdate = {
        sessionUpdate: async (notification: any) => {
          hookUpdates.push(notification);
        },
      } as unknown as AcpClient;

      // Register hook callback by processing tool_use
      toAcpNotifications(
        [
          {
            type: "tool_use" as const,
            id: "toolu_edit_hook",
            name: "Edit",
            input: {
              file_path: "/Users/test/project/file.ts",
              old_string: "old text",
              new_string: "new text",
            },
          },
        ],
        "assistant",
        "test-session",
        toolUseCache,
        mockClientWithUpdate,
        mockLogger,
        { parentToolUseId: "parent-agent-tool" },
      );

      // Fire PostToolUse hook with a structuredPatch in tool_response
      const hook = createPostToolUseHook();
      await hook(
        {
          hook_event_name: "PostToolUse",
          tool_name: "Edit",
          tool_input: {
            file_path: "/Users/test/project/file.ts",
            old_string: "old text",
            new_string: "new text",
          },
          tool_response: {
            filePath: "/Users/test/project/file.ts",
            oldString: "old text",
            newString: "new text",
            structuredPatch: [
              {
                oldStart: 5,
                oldLines: 3,
                newStart: 5,
                newLines: 3,
                lines: [" context before", "-old text", "+new text", " context after"],
              },
            ],
          },
          tool_use_id: "toolu_edit_hook",
          session_id: "test-session",
          transcript_path: "/tmp/test",
          cwd: "/tmp",
        },
        "toolu_edit_hook",
        { signal: AbortSignal.abort() },
      );

      expect(hookUpdates).toHaveLength(1);
      const hookUpdate = hookUpdates[0].update;
      expect(hookUpdate._meta.claudeCode.toolName).toBe("Edit");
      expect(hookUpdate._meta.claudeCode.parentToolUseId).toBe("parent-agent-tool");
      expect(hookUpdate.content).toEqual([
        {
          type: "diff",
          path: "/Users/test/project/file.ts",
          oldText: "context before\nold text\ncontext after",
          newText: "context before\nnew text\ncontext after",
        },
      ]);
      expect(hookUpdate.locations).toEqual([{ path: "/Users/test/project/file.ts", line: 5 }]);
    });

    it("should include multiple diff blocks for replaceAll with multiple hunks", async () => {
      const toolUseCache: ToolUseCache = {};

      const hookUpdates: any[] = [];
      const mockClientWithUpdate = {
        sessionUpdate: async (notification: any) => {
          hookUpdates.push(notification);
        },
      } as unknown as AcpClient;

      toAcpNotifications(
        [
          {
            type: "tool_use" as const,
            id: "toolu_edit_replace_all",
            name: "Edit",
            input: {
              file_path: "/Users/test/project/file.ts",
              old_string: "foo",
              new_string: "bar",
              replace_all: true,
            },
          },
        ],
        "assistant",
        "test-session",
        toolUseCache,
        mockClientWithUpdate,
        mockLogger,
      );

      const hook = createPostToolUseHook();
      await hook(
        {
          hook_event_name: "PostToolUse",
          tool_name: "Edit",
          tool_input: {
            file_path: "/Users/test/project/file.ts",
            old_string: "foo",
            new_string: "bar",
            replace_all: true,
          },
          tool_response: {
            filePath: "/Users/test/project/file.ts",
            oldString: "foo",
            newString: "bar",
            replaceAll: true,
            structuredPatch: [
              {
                oldStart: 3,
                oldLines: 1,
                newStart: 3,
                newLines: 1,
                lines: ["-foo", "+bar"],
              },
              {
                oldStart: 15,
                oldLines: 1,
                newStart: 15,
                newLines: 1,
                lines: ["-foo", "+bar"],
              },
            ],
          },
          tool_use_id: "toolu_edit_replace_all",
          session_id: "test-session",
          transcript_path: "/tmp/test",
          cwd: "/tmp",
        },
        "toolu_edit_replace_all",
        { signal: AbortSignal.abort() },
      );

      expect(hookUpdates).toHaveLength(1);
      const hookUpdate = hookUpdates[0].update;
      expect(hookUpdate.content).toEqual([
        { type: "diff", path: "/Users/test/project/file.ts", oldText: "foo", newText: "bar" },
        { type: "diff", path: "/Users/test/project/file.ts", oldText: "foo", newText: "bar" },
      ]);
      expect(hookUpdate.locations).toEqual([
        { path: "/Users/test/project/file.ts", line: 3 },
        { path: "/Users/test/project/file.ts", line: 15 },
      ]);
    });

    it("should not include content/locations for non-Edit tools", async () => {
      const toolUseCache: ToolUseCache = {};

      const hookUpdates: any[] = [];
      const mockClientWithUpdate = {
        sessionUpdate: async (notification: any) => {
          hookUpdates.push(notification);
        },
      } as unknown as AcpClient;

      toAcpNotifications(
        [
          {
            type: "tool_use" as const,
            id: "toolu_bash_no_diff",
            name: "Bash",
            input: { command: "echo hi" },
          },
        ],
        "assistant",
        "test-session",
        toolUseCache,
        mockClientWithUpdate,
        mockLogger,
      );

      const hook = createPostToolUseHook();
      await hook(
        {
          hook_event_name: "PostToolUse",
          tool_name: "Bash",
          tool_input: { command: "echo hi" },
          tool_response: "hi",
          tool_use_id: "toolu_bash_no_diff",
          session_id: "test-session",
          transcript_path: "/tmp/test",
          cwd: "/tmp",
        },
        "toolu_bash_no_diff",
        { signal: AbortSignal.abort() },
      );

      expect(hookUpdates).toHaveLength(1);
      const hookUpdate = hookUpdates[0].update;
      expect(hookUpdate.content).toBeUndefined();
      expect(hookUpdate.locations).toBeUndefined();
    });

    // Regression for issue #889: tool uses that never register a callback
    // (TodoWrite/Task* are rendered as plan updates, not tool_calls) fire the
    // PostToolUse hook too. That's expected — the hook must stay silent
    // instead of spamming "No onPostToolUseHook found" to stderr.
    it("should not log an error when no callback is registered for the tool use", async () => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        const hook = createPostToolUseHook();
        const result = await hook(
          {
            hook_event_name: "PostToolUse",
            tool_name: "TodoWrite",
            tool_input: { todos: [] },
            tool_response: { success: true },
            tool_use_id: "toolu_todo_no_callback",
            session_id: "test-session",
            transcript_path: "/tmp/test",
            cwd: "/tmp",
          },
          "toolu_todo_no_callback",
          { signal: AbortSignal.abort() },
        );

        expect(result).toEqual({ continue: true });
        expect(errorSpy).not.toHaveBeenCalled();
      } finally {
        errorSpy.mockRestore();
      }
    });
  });

  describe("post-tool-use hook sends diff content for Write tool", () => {
    // Regression: previously the dispatch only invoked
    // toolUpdateFromDiffToolResponse for `Edit`, so a Write that
    // overwrote an existing file (FileWriteOutput.type === "update")
    // showed a "creation" diff (oldText: null, full new content) at
    // tool_use time and was never corrected after the tool ran.
    it("should emit a real diff for Write of an existing file (type: update)", async () => {
      const toolUseCache: ToolUseCache = {};
      const hookUpdates: any[] = [];
      const mockClientWithUpdate = {
        sessionUpdate: async (notification: any) => {
          hookUpdates.push(notification);
        },
      } as unknown as AcpClient;

      toAcpNotifications(
        [
          {
            type: "tool_use" as const,
            id: "toolu_write_update",
            name: "Write",
            input: {
              file_path: "/Users/test/project/file.ts",
              content: "line1\nNEW line2\nline3",
            },
          },
        ],
        "assistant",
        "test-session",
        toolUseCache,
        mockClientWithUpdate,
        mockLogger,
      );

      const hook = createPostToolUseHook();
      await hook(
        {
          hook_event_name: "PostToolUse",
          tool_name: "Write",
          tool_input: {
            file_path: "/Users/test/project/file.ts",
            content: "line1\nNEW line2\nline3",
          },
          tool_response: {
            type: "update",
            filePath: "/Users/test/project/file.ts",
            content: "line1\nNEW line2\nline3",
            originalFile: "line1\nold line2\nline3",
            structuredPatch: [
              {
                oldStart: 1,
                oldLines: 3,
                newStart: 1,
                newLines: 3,
                lines: [" line1", "-old line2", "+NEW line2", " line3"],
              },
            ],
            userModified: false,
          },
          tool_use_id: "toolu_write_update",
          session_id: "test-session",
          transcript_path: "/tmp/test",
          cwd: "/tmp",
        },
        "toolu_write_update",
        { signal: AbortSignal.abort() },
      );

      expect(hookUpdates).toHaveLength(1);
      const hookUpdate = hookUpdates[0].update;
      expect(hookUpdate._meta.claudeCode.toolName).toBe("Write");
      expect(hookUpdate.content).toEqual([
        {
          type: "diff",
          path: "/Users/test/project/file.ts",
          oldText: "line1\nold line2\nline3",
          newText: "line1\nNEW line2\nline3",
        },
      ]);
      expect(hookUpdate.locations).toEqual([{ path: "/Users/test/project/file.ts", line: 1 }]);
    });

    it("should still emit a sensible diff for Write of a brand-new file (type: create)", async () => {
      const toolUseCache: ToolUseCache = {};
      const hookUpdates: any[] = [];
      const mockClientWithUpdate = {
        sessionUpdate: async (notification: any) => {
          hookUpdates.push(notification);
        },
      } as unknown as AcpClient;

      toAcpNotifications(
        [
          {
            type: "tool_use" as const,
            id: "toolu_write_create",
            name: "Write",
            input: {
              file_path: "/Users/test/project/new.ts",
              content: "first\nsecond",
            },
          },
        ],
        "assistant",
        "test-session",
        toolUseCache,
        mockClientWithUpdate,
        mockLogger,
      );

      const hook = createPostToolUseHook();
      await hook(
        {
          hook_event_name: "PostToolUse",
          tool_name: "Write",
          tool_input: {
            file_path: "/Users/test/project/new.ts",
            content: "first\nsecond",
          },
          tool_response: {
            type: "create",
            filePath: "/Users/test/project/new.ts",
            content: "first\nsecond",
            originalFile: null,
            structuredPatch: [
              {
                oldStart: 0,
                oldLines: 0,
                newStart: 1,
                newLines: 2,
                lines: ["+first", "+second"],
              },
            ],
          },
          tool_use_id: "toolu_write_create",
          session_id: "test-session",
          transcript_path: "/tmp/test",
          cwd: "/tmp",
        },
        "toolu_write_create",
        { signal: AbortSignal.abort() },
      );

      expect(hookUpdates).toHaveLength(1);
      const hookUpdate = hookUpdates[0].update;
      expect(hookUpdate.content).toEqual([
        {
          type: "diff",
          path: "/Users/test/project/new.ts",
          oldText: null,
          newText: "first\nsecond",
        },
      ]);
    });
  });

  describe("post-tool-use hook preserves terminal _meta", () => {
    it("should send terminal_output and terminal_exit as separate notifications, and hook should only have claudeCode", async () => {
      const clientCapabilities: ClientCapabilities = {
        _meta: { terminal_output: true },
      };

      const toolUseCache: ToolUseCache = {};

      // Capture session updates sent by the hook callback
      const hookUpdates: any[] = [];
      const mockClientWithUpdate = {
        sessionUpdate: async (notification: any) => {
          hookUpdates.push(notification);
        },
      } as unknown as AcpClient;

      // Step 1: Process tool_use chunk — registers the PostToolUse hook callback
      const toolUseChunk = {
        type: "tool_use" as const,
        id: "toolu_bash_hook",
        name: "Bash",
        input: { command: "ls -la" },
      };
      const toolUseNotifications = toAcpNotifications(
        [toolUseChunk],
        "assistant",
        "test-session",
        toolUseCache,
        mockClientWithUpdate,
        mockLogger,
        { clientCapabilities },
      );

      // The initial tool_call should include terminal_info in _meta
      expect(toolUseNotifications).toHaveLength(1);
      expect((toolUseNotifications[0].update as any)._meta).toMatchObject({
        terminal_info: { terminal_id: "toolu_bash_hook" },
      });

      // Step 2: Process bash result — produces separate terminal_output and terminal_exit notifications
      const bashResult: BetaBashCodeExecutionResultBlock = {
        type: "bash_code_execution_result",
        stdout: "file1.txt",
        stderr: "",
        return_code: 0,
        content: [],
      };
      const toolResult: BetaBashCodeExecutionToolResultBlock = {
        type: "bash_code_execution_tool_result",
        tool_use_id: "toolu_bash_hook",
        content: bashResult,
      };
      const resultNotifications = toAcpNotifications(
        [toolResult],
        "assistant",
        "test-session",
        toolUseCache,
        mockClientWithUpdate,
        mockLogger,
        { clientCapabilities },
      );

      // Should produce 2 notifications: terminal_output, then terminal_exit + completion
      expect(resultNotifications).toHaveLength(2);

      // First: terminal_output only
      expect((resultNotifications[0].update as any)._meta).toEqual({
        terminal_output: { terminal_id: "toolu_bash_hook", data: "file1.txt" },
      });

      // Second: terminal_exit + status
      expect((resultNotifications[1].update as any)._meta).toMatchObject({
        terminal_exit: { terminal_id: "toolu_bash_hook", exit_code: 0, signal: null },
      });
      expect((resultNotifications[1].update as any).status).toBe("completed");

      // Step 3: Fire the PostToolUse hook (simulates what Claude Code SDK does)
      const hook = createPostToolUseHook();
      await hook(
        {
          hook_event_name: "PostToolUse",
          tool_name: "Bash",
          tool_input: { command: "ls -la" },
          tool_response: "file1.txt",
          tool_use_id: "toolu_bash_hook",
          session_id: "test-session",
          transcript_path: "/tmp/test",
          cwd: "/tmp",
        },
        "toolu_bash_hook",
        { signal: AbortSignal.abort() },
      );

      // Step 4: Hook update should only have claudeCode, no terminal fields
      // (terminal events were already sent as separate notifications)
      expect(hookUpdates).toHaveLength(1);
      const hookMeta = hookUpdates[0].update._meta;
      expect(hookMeta.claudeCode).toMatchObject({
        toolName: "Bash",
        toolResponse: "file1.txt",
      });
      expect(hookMeta.terminal_info).toBeUndefined();
      expect(hookMeta.terminal_output).toBeUndefined();
      expect(hookMeta.terminal_exit).toBeUndefined();
    });

    it("should not include terminal _meta in hook update when client lacks terminal_output support", async () => {
      const toolUseCache: ToolUseCache = {};

      const hookUpdates: any[] = [];
      const mockClientWithUpdate = {
        sessionUpdate: async (notification: any) => {
          hookUpdates.push(notification);
        },
      } as unknown as AcpClient;

      // Process tool_use (registers hook)
      toAcpNotifications(
        [
          {
            type: "tool_use" as const,
            id: "toolu_bash_no_term",
            name: "Bash",
            input: { command: "echo hi" },
          },
        ],
        "assistant",
        "test-session",
        toolUseCache,
        mockClientWithUpdate,
        mockLogger,
        // No clientCapabilities — terminal_output not supported
      );

      // Process bash result
      const bashResult: BetaBashCodeExecutionResultBlock = {
        type: "bash_code_execution_result",
        stdout: "hi",
        stderr: "",
        return_code: 0,
        content: [],
      };
      toAcpNotifications(
        [
          {
            type: "bash_code_execution_tool_result",
            tool_use_id: "toolu_bash_no_term",
            content: bashResult,
          } as BetaBashCodeExecutionToolResultBlock,
        ],
        "assistant",
        "test-session",
        toolUseCache,
        mockClientWithUpdate,
        mockLogger,
      );

      // Fire hook
      const hook = createPostToolUseHook();
      await hook(
        {
          hook_event_name: "PostToolUse",
          tool_name: "Bash",
          tool_input: { command: "echo hi" },
          tool_response: "hi",
          tool_use_id: "toolu_bash_no_term",
          session_id: "test-session",
          transcript_path: "/tmp/test",
          cwd: "/tmp",
        },
        "toolu_bash_no_term",
        { signal: AbortSignal.abort() },
      );

      // Hook update should only have claudeCode, no terminal fields
      expect(hookUpdates).toHaveLength(1);
      const hookMeta = hookUpdates[0].update._meta;
      expect(hookMeta.claudeCode).toBeDefined();
      expect(hookMeta.terminal_info).toBeUndefined();
      expect(hookMeta.terminal_output).toBeUndefined();
      expect(hookMeta.terminal_exit).toBeUndefined();
    });
  });
});

describe("toolInfoFromToolUse - ExitPlanMode", () => {
  it("should include plan text in content when input.plan is provided", () => {
    const toolUse = {
      name: "ExitPlanMode",
      id: "toolu_plan_1",
      input: {
        plan: "# My Plan\n\n## Step 1\nDo something",
        planFilePath: "/tmp/plan.md",
      },
    };

    const info = toolInfoFromToolUse(toolUse, false);

    expect(info.kind).toBe("switch_mode");
    expect(info.title).toBe("Approve Plan");
    expect(info.content).toHaveLength(1);
    expect(info.content![0]).toEqual({
      type: "content",
      content: { type: "text", text: "# My Plan\n\n## Step 1\nDo something" },
    });
  });

  it("should return empty content when input.plan is not provided", () => {
    const toolUse = {
      name: "ExitPlanMode",
      id: "toolu_plan_2",
      input: {},
    };

    const info = toolInfoFromToolUse(toolUse, false);

    expect(info.kind).toBe("switch_mode");
    expect(info.content).toEqual([]);
  });
});

describe("toolInfoFromToolUse - undefined input regression", () => {
  it("Read with undefined input should not throw", () => {
    const toolUse = { name: "Read", id: "toolu_read_undef", input: undefined };
    const info = toolInfoFromToolUse(toolUse, false);
    expect(info.title).toBe("Read File");
    expect(info.locations).toEqual([]);
  });

  it("Grep with undefined input should not throw", () => {
    const toolUse = { name: "Grep", id: "toolu_grep_undef", input: undefined };
    const info = toolInfoFromToolUse(toolUse, false);
    expect(info.title).toBe("grep");
  });

  it("Glob with undefined input should not throw", () => {
    const toolUse = { name: "Glob", id: "toolu_glob_undef", input: undefined };
    const info = toolInfoFromToolUse(toolUse, false);
    expect(info.title).toBe("Find");
    expect(info.locations).toEqual([]);
  });

  it("WebSearch with undefined input should not throw", () => {
    const toolUse = { name: "WebSearch", id: "toolu_ws_undef", input: undefined };
    const info = toolInfoFromToolUse(toolUse, false);
    expect(info.title).toBe("Web search");
  });

  it("shows a WebSearch query in the tool title", () => {
    const toolUse = {
      name: "WebSearch",
      id: "toolu_ws_query",
      input: { query: "Agent Client Protocol ACP specification subagents v2" },
    };
    const info = toolInfoFromToolUse(toolUse, false);
    expect(info.title).toBe('Search "Agent Client Protocol ACP specification subagents v2"');
  });

  it("TodoWrite with undefined input should not throw", () => {
    const toolUse = { name: "TodoWrite", id: "toolu_todo_undef", input: undefined };
    const info = toolInfoFromToolUse(toolUse, false);
    expect(info.title).toBe("Update TODOs");
  });

  it("ReportFindings with undefined input should not throw", () => {
    const toolUse = { name: "ReportFindings", id: "toolu_findings_undef", input: undefined };
    const info = toolInfoFromToolUse(toolUse, false);
    expect(info.title).toBe("Report findings: none found");
    expect(info.content).toEqual([]);
  });
});

describe("toolInfoFromToolUse - ReportFindings", () => {
  it("should summarize findings count and list each in content", () => {
    const toolUse = {
      name: "ReportFindings",
      id: "toolu_findings_1",
      input: {
        findings: [
          {
            file: "src/foo.ts",
            line: 42,
            summary: "Off-by-one in loop bound",
            failure_scenario: "Empty array → index out of bounds crash",
          },
          {
            file: "src/bar.ts",
            summary: "Unhandled promise rejection",
            failure_scenario: "Network failure → unhandled rejection",
          },
        ],
      },
    };

    const info = toolInfoFromToolUse(toolUse, false);

    expect(info.kind).toBe("think");
    expect(info.title).toBe("Report 2 findings");
    expect(info.content).toEqual([
      {
        type: "content",
        content: { type: "text", text: "**src/foo.ts:42** — Off-by-one in loop bound" },
      },
      {
        type: "content",
        content: { type: "text", text: "**src/bar.ts** — Unhandled promise rejection" },
      },
    ]);
  });

  it("should report a singular title and empty findings array", () => {
    const oneFinding = {
      name: "ReportFindings",
      id: "toolu_findings_2",
      input: { findings: [{ file: "src/baz.ts", summary: "Leak", failure_scenario: "..." }] },
    };
    expect(toolInfoFromToolUse(oneFinding, false).title).toBe("Report 1 finding");

    const noFindings = {
      name: "ReportFindings",
      id: "toolu_findings_3",
      input: { findings: [] },
    };
    expect(toolInfoFromToolUse(noFindings, false).title).toBe("Report findings: none found");
  });
});

describe("planEntries - undefined input regression", () => {
  it("should return empty array when input is undefined", () => {
    expect(planEntries(undefined)).toEqual([]);
  });

  it("should return empty array when input has no todos", () => {
    expect(planEntries({} as any)).toEqual([]);
  });

  it("should still map valid todos correctly", () => {
    const result = planEntries({
      todos: [
        { content: "Task 1", status: "pending", activeForm: "" },
        { content: "Task 2", status: "completed", activeForm: "" },
      ],
    });
    expect(result).toEqual([
      { content: "Task 1", status: "pending", priority: "medium" },
      { content: "Task 2", status: "completed", priority: "medium" },
    ]);
  });

  it("uses activeForm while a todo is in progress", () => {
    expect(
      planEntries({
        todos: [{ content: "Run tests", status: "in_progress", activeForm: "Running tests" }],
      }),
    ).toEqual([{ content: "Running tests", status: "in_progress", priority: "medium" }]);
  });
});

describe("toAcpNotifications - TodoWrite with undefined input regression", () => {
  const mockClient = {} as AcpClient;
  const mockLogger: Logger = { log: () => {}, error: () => {} };

  it("should not throw when TodoWrite tool_use has undefined input", () => {
    const toolUseCache: ToolUseCache = {};

    const notifications = toAcpNotifications(
      [
        {
          type: "tool_use" as const,
          id: "toolu_todo_undef",
          name: "TodoWrite",
          input: undefined as any,
        },
      ],
      "assistant",
      "test-session",
      toolUseCache,
      mockClient,
      mockLogger,
    );

    // TodoWrite with undefined input should not crash, and should not emit plan update
    const planUpdates = notifications.filter((n) => (n.update as any).sessionUpdate === "plan");
    expect(planUpdates).toHaveLength(0);
  });

  it("should still emit plan update when TodoWrite has valid input", () => {
    const toolUseCache: ToolUseCache = {};

    const notifications = toAcpNotifications(
      [
        {
          type: "tool_use" as const,
          id: "toolu_todo_valid",
          name: "TodoWrite",
          input: { todos: [{ content: "Do X", status: "pending" }] },
        },
      ],
      "assistant",
      "test-session",
      toolUseCache,
      mockClient,
      mockLogger,
    );

    const planUpdates = notifications.filter((n) => (n.update as any).sessionUpdate === "plan");
    expect(planUpdates).toHaveLength(1);
  });
});

describe("parseTaskCreateOutput", () => {
  it("parses JSON-string content", () => {
    const parsed = parseTaskCreateOutput(JSON.stringify({ task: { id: "1", subject: "X" } }));
    expect(parsed).toEqual({ task: { id: "1", subject: "X" } });
  });

  it("parses array-of-text-block content", () => {
    const parsed = parseTaskCreateOutput([
      { type: "text", text: JSON.stringify({ task: { id: "2", subject: "Y" } }) },
    ]);
    expect(parsed).toEqual({ task: { id: "2", subject: "Y" } });
  });

  it("continues past unrelated JSON blocks", () => {
    const parsed = parseTaskCreateOutput([
      { type: "text", text: JSON.stringify({ metadata: "unrelated" }) },
      { type: "text", text: JSON.stringify({ task: { id: "2", subject: "Y" } }) },
    ]);
    expect(parsed).toEqual({ task: { id: "2", subject: "Y" } });
  });

  it("parses the human-readable TaskCreate format used in session history", () => {
    expect(parseTaskCreateOutput("Task #42 created successfully: Run tests")).toEqual({
      task: { id: "42", subject: "Run tests" },
    });
  });

  it("returns undefined for non-JSON content", () => {
    expect(parseTaskCreateOutput("not json")).toBeUndefined();
    expect(parseTaskCreateOutput([{ type: "text", text: "not json" }])).toBeUndefined();
  });

  it("returns undefined when task.id is missing", () => {
    expect(parseTaskCreateOutput(JSON.stringify({ task: { subject: "X" } }))).toBeUndefined();
  });
});

describe("applyTaskCreate / applyTaskUpdate", () => {
  it("creates an entry on TaskCreate when both input and output are present", () => {
    const state: TaskState = new Map();
    applyTaskCreate(
      state,
      { subject: "Write tests", description: "Cover Task* flow", activeForm: "Writing tests" },
      { task: { id: "1", subject: "Write tests" } },
    );
    expect(state.get("1")).toEqual({
      subject: "Write tests",
      status: "pending",
      activeForm: "Writing tests",
      description: "Cover Task* flow",
    });
  });

  it("is a no-op when the output has no task ID", () => {
    const state: TaskState = new Map();
    applyTaskCreate(state, { subject: "X", description: "Y" }, undefined);
    expect(state.size).toBe(0);
  });

  it("updates fields by task ID and keeps insertion order in plan entries", () => {
    const state: TaskState = new Map();
    applyTaskCreate(
      state,
      { subject: "A", description: "", activeForm: "Working on A" },
      { task: { id: "1", subject: "A" } },
    );
    applyTaskCreate(state, { subject: "B", description: "" }, { task: { id: "2", subject: "B" } });
    applyTaskUpdate(state, { taskId: "1", status: "in_progress" });
    expect(taskStateToPlanEntries(state)).toEqual([
      { content: "Working on A", status: "in_progress", priority: "medium" },
      { content: "B", status: "pending", priority: "medium" },
    ]);
  });

  it("removes entries when status is 'deleted'", () => {
    const state: TaskState = new Map();
    applyTaskCreate(state, { subject: "A", description: "" }, { task: { id: "1", subject: "A" } });
    applyTaskUpdate(state, { taskId: "1", status: "deleted" });
    expect(state.size).toBe(0);
  });

  it("creates a placeholder entry when TaskUpdate carries a subject for an unseen task", () => {
    const state: TaskState = new Map();
    applyTaskUpdate(state, { taskId: "5", subject: "Late arrival", status: "in_progress" });
    expect(state.get("5")).toEqual({
      subject: "Late arrival",
      status: "in_progress",
      activeForm: undefined,
      description: undefined,
    });
  });

  it("skips TaskUpdate for an unseen task when no subject is available", () => {
    const state: TaskState = new Map();
    applyTaskUpdate(state, { taskId: "5", status: "in_progress" });
    // Without a subject we'd render an empty-content plan entry, so the
    // update is dropped instead of synthesizing a blank placeholder.
    expect(state.has("5")).toBe(false);
  });

  it("rebuilds task state from TaskList while preserving richer local fields", () => {
    const state: TaskState = new Map([
      [
        "1",
        {
          subject: "Old subject",
          status: "pending",
          activeForm: "Running the task",
          description: "Details",
        },
      ],
      ["deleted", { subject: "Stale", status: "pending" }],
    ]);
    const output = parseTaskListOutput(
      JSON.stringify({
        tasks: [
          { id: "1", subject: "Current subject", status: "in_progress", blockedBy: [] },
          { id: "2", subject: "New task", status: "pending", blockedBy: [] },
        ],
      }),
    );

    expect(output).toBeDefined();
    applyTaskList(state, output!);

    expect([...state.entries()]).toEqual([
      [
        "1",
        {
          subject: "Current subject",
          status: "in_progress",
          activeForm: "Running the task",
          description: "Details",
        },
      ],
      [
        "2",
        {
          subject: "New task",
          status: "pending",
          activeForm: undefined,
          description: undefined,
        },
      ],
    ]);
  });

  it("finds a TaskList snapshot after an unrelated JSON block", () => {
    expect(
      parseTaskListOutput([
        { type: "text", text: JSON.stringify({ metadata: "unrelated" }) },
        {
          type: "text",
          text: JSON.stringify({
            tasks: [{ id: "1", subject: "Recovered", status: "pending", blockedBy: [] }],
          }),
        },
      ]),
    ).toEqual({
      tasks: [{ id: "1", subject: "Recovered", status: "pending", blockedBy: [] }],
    });
  });

  it("parses the human-readable TaskList format used in session history", () => {
    expect(
      parseTaskListOutput(
        "#1 [in_progress] Run tests\n#2 [pending] Write release notes [blocked by #1]",
      ),
    ).toEqual({
      tasks: [
        { id: "1", subject: "Run tests", status: "in_progress", blockedBy: [] },
        { id: "2", subject: "Write release notes", status: "pending", blockedBy: ["1"] },
      ],
    });

    expect(parseTaskListOutput("No tasks found")).toEqual({ tasks: [] });
  });
});

describe("toAcpNotifications - Task* tools", () => {
  const mockClient = {} as AcpClient;
  const mockLogger: Logger = { log: () => {}, error: () => {} };

  it("suppresses tool_call for TaskCreate/TaskUpdate/TaskList/TaskGet on tool_use", () => {
    const toolUseCache: ToolUseCache = {};
    const taskState: TaskState = new Map();

    const notifications = toAcpNotifications(
      [
        { type: "tool_use", id: "1", name: "TaskCreate", input: { subject: "A", description: "" } },
        {
          type: "tool_use",
          id: "2",
          name: "TaskUpdate",
          input: { taskId: "1", status: "in_progress" },
        },
        { type: "tool_use", id: "3", name: "TaskList", input: {} },
        { type: "tool_use", id: "4", name: "TaskGet", input: { taskId: "1" } },
      ] as any,
      "assistant",
      "test-session",
      toolUseCache,
      mockClient,
      mockLogger,
      { taskState },
    );

    expect(notifications).toHaveLength(0);
    expect(taskState.size).toBe(0);
  });

  it("emits a plan snapshot after a TaskCreate tool_result and accumulates state", () => {
    const toolUseCache: ToolUseCache = {};
    const taskState: TaskState = new Map();

    toAcpNotifications(
      [
        {
          type: "tool_use",
          id: "1",
          name: "TaskCreate",
          input: { subject: "First", description: "" },
        },
      ] as any,
      "assistant",
      "test-session",
      toolUseCache,
      mockClient,
      mockLogger,
      { taskState },
    );

    const created = toAcpNotifications(
      [
        {
          type: "tool_result",
          tool_use_id: "1",
          content: JSON.stringify({ task: { id: "1", subject: "First" } }),
          is_error: false,
        },
      ] as any,
      "user",
      "test-session",
      toolUseCache,
      mockClient,
      mockLogger,
      { taskState },
    );

    expect(created).toHaveLength(1);
    expect(created[0].update).toMatchObject({
      sessionUpdate: "plan",
      entries: [{ content: "First", status: "pending", priority: "medium" }],
    });

    // A second TaskCreate accumulates rather than replacing.
    toAcpNotifications(
      [
        {
          type: "tool_use",
          id: "2",
          name: "TaskCreate",
          input: { subject: "Second", description: "" },
        },
      ] as any,
      "assistant",
      "test-session",
      toolUseCache,
      mockClient,
      mockLogger,
      { taskState },
    );

    const second = toAcpNotifications(
      [
        {
          type: "tool_result",
          tool_use_id: "2",
          content: JSON.stringify({ task: { id: "2", subject: "Second" } }),
          is_error: false,
        },
      ] as any,
      "user",
      "test-session",
      toolUseCache,
      mockClient,
      mockLogger,
      { taskState },
    );

    expect(second[0].update).toMatchObject({
      sessionUpdate: "plan",
      entries: [
        { content: "First", status: "pending", priority: "medium" },
        { content: "Second", status: "pending", priority: "medium" },
      ],
    });
  });

  it("emits a plan snapshot reflecting status changes after a TaskUpdate tool_result", () => {
    const toolUseCache: ToolUseCache = {};
    const taskState: TaskState = new Map([["1", { subject: "First", status: "pending" as const }]]);
    toolUseCache["update-1"] = {
      type: "tool_use",
      id: "update-1",
      name: "TaskUpdate",
      input: { taskId: "1", status: "completed" },
    };

    const notifications = toAcpNotifications(
      [
        {
          type: "tool_result",
          tool_use_id: "update-1",
          content: JSON.stringify({
            success: true,
            taskId: "1",
            updatedFields: ["status"],
          }),
          is_error: false,
        },
      ] as any,
      "user",
      "test-session",
      toolUseCache,
      mockClient,
      mockLogger,
      { taskState },
    );

    expect(notifications).toHaveLength(1);
    expect(notifications[0].update).toMatchObject({
      sessionUpdate: "plan",
      entries: [{ content: "First", status: "completed", priority: "medium" }],
    });
  });

  it("uses the structured TaskList result as an authoritative plan snapshot", () => {
    const toolUseCache: ToolUseCache = {
      "list-1": { type: "tool_use", id: "list-1", name: "TaskList", input: {} },
    };
    const taskState: TaskState = new Map([
      ["1", { subject: "Existing", status: "in_progress" as const }],
    ]);

    const notifications = toAcpNotifications(
      [
        {
          type: "tool_result",
          tool_use_id: "list-1",
          content: "#2 [pending] Recovered",
          is_error: false,
        },
      ] as any,
      "user",
      "test-session",
      toolUseCache,
      mockClient,
      mockLogger,
      {
        taskState,
        toolUseResult: {
          tasks: [{ id: "2", subject: "Recovered", status: "pending", blockedBy: [] }],
        },
      },
    );

    expect(notifications).toHaveLength(1);
    expect(notifications[0].update).toMatchObject({
      sessionUpdate: "plan",
      entries: [{ content: "Recovered", status: "pending", priority: "medium" }],
    });
    expect([...taskState.keys()]).toEqual(["2"]);
  });

  it("does not apply a logically failed TaskUpdate", () => {
    const toolUseCache: ToolUseCache = {
      "update-1": {
        type: "tool_use",
        id: "update-1",
        name: "TaskUpdate",
        input: { taskId: "1", status: "completed" },
      },
    };
    const taskState: TaskState = new Map([["1", { subject: "Existing", status: "pending" }]]);

    const notifications = toAcpNotifications(
      [
        {
          type: "tool_result",
          tool_use_id: "update-1",
          content: "Task #1 not found",
          is_error: false,
        },
      ] as any,
      "user",
      "test-session",
      toolUseCache,
      mockClient,
      mockLogger,
      {
        taskState,
        toolUseResult: {
          success: false,
          taskId: "1",
          updatedFields: [],
          error: "Task not found",
        },
      },
    );

    expect(notifications).toHaveLength(0);
    expect(taskState.get("1")).toEqual({ subject: "Existing", status: "pending" });
  });

  it("does not apply a replayed TaskUpdate failure without structured output", () => {
    const toolUseCache: ToolUseCache = {
      "update-1": {
        type: "tool_use",
        id: "update-1",
        name: "TaskUpdate",
        input: { taskId: "1", status: "completed" },
      },
    };
    const taskState: TaskState = new Map([["1", { subject: "Existing", status: "pending" }]]);

    const notifications = toAcpNotifications(
      [
        {
          type: "tool_result",
          tool_use_id: "update-1",
          content: "Task #1 not found",
          is_error: false,
        },
      ] as any,
      "user",
      "test-session",
      toolUseCache,
      mockClient,
      mockLogger,
      { taskState },
    );

    expect(notifications).toHaveLength(0);
    expect(taskState.get("1")).toEqual({ subject: "Existing", status: "pending" });
  });

  it("does not apply TaskCreate/TaskUpdate when the tool_result reports an error", () => {
    const toolUseCache: ToolUseCache = {
      "create-1": {
        type: "tool_use",
        id: "create-1",
        name: "TaskCreate",
        input: { subject: "A", description: "" },
      },
    };
    const taskState: TaskState = new Map();

    const notifications = toAcpNotifications(
      [
        {
          type: "tool_result",
          tool_use_id: "create-1",
          content: "task creation failed",
          is_error: true,
        },
      ] as any,
      "user",
      "test-session",
      toolUseCache,
      mockClient,
      mockLogger,
      { taskState },
    );

    expect(notifications).toHaveLength(0);
    expect(taskState.size).toBe(0);
  });
});

describe("createTaskHook", () => {
  it("registers a task on TaskCreated and fires onChange", async () => {
    const taskState: TaskState = new Map();
    let changes = 0;
    const hook = createTaskHook({
      taskState,
      onChange: async () => {
        changes++;
      },
    });

    await hook(
      {
        hook_event_name: "TaskCreated",
        task_id: "t-1",
        task_subject: "Investigate flaky test",
        task_description: "Repro and fix",
      } as any,
      undefined,
      { signal: new AbortController().signal },
    );

    expect(taskState.get("t-1")).toEqual({
      subject: "Investigate flaky test",
      status: "pending",
      description: "Repro and fix",
    });
    expect(changes).toBe(1);
  });

  it("does not clobber an existing entry on TaskCreated", async () => {
    const taskState: TaskState = new Map([
      ["t-1", { subject: "Investigate flaky test", status: "in_progress" as const }],
    ]);
    let changes = 0;
    const hook = createTaskHook({
      taskState,
      onChange: async () => {
        changes++;
      },
    });

    await hook(
      {
        hook_event_name: "TaskCreated",
        task_id: "t-1",
        task_subject: "Investigate flaky test",
      } as any,
      undefined,
      { signal: new AbortController().signal },
    );

    expect(taskState.get("t-1")?.status).toBe("in_progress");
    expect(changes).toBe(0);
  });

  it("marks a task completed on TaskCompleted", async () => {
    const taskState: TaskState = new Map([
      ["t-1", { subject: "Investigate flaky test", status: "in_progress" as const }],
    ]);
    let changes = 0;
    const hook = createTaskHook({
      taskState,
      onChange: async () => {
        changes++;
      },
    });

    await hook(
      {
        hook_event_name: "TaskCompleted",
        task_id: "t-1",
        task_subject: "Investigate flaky test",
      } as any,
      undefined,
      { signal: new AbortController().signal },
    );

    expect(taskState.get("t-1")?.status).toBe("completed");
    expect(changes).toBe(1);
  });

  it("is a no-op for unrelated hook events", async () => {
    const taskState: TaskState = new Map();
    let changes = 0;
    const hook = createTaskHook({
      taskState,
      onChange: async () => {
        changes++;
      },
    });

    await hook({ hook_event_name: "PostToolUse", tool_name: "Read" } as any, undefined, {
      signal: new AbortController().signal,
    });

    expect(taskState.size).toBe(0);
    expect(changes).toBe(0);
  });
});

describe("empty message content is not emitted", () => {
  const mockClient = {} as AcpClient;
  const mockLogger: Logger = { log: () => {}, error: () => {} };

  it("drops an empty string content instead of emitting an empty agent_message_chunk", () => {
    const notifications = toAcpNotifications(
      "",
      "assistant",
      "test-session",
      {},
      mockClient,
      mockLogger,
    );
    expect(notifications).toHaveLength(0);
  });

  it("still emits non-empty string content", () => {
    const notifications = toAcpNotifications(
      "hello",
      "assistant",
      "test-session",
      {},
      mockClient,
      mockLogger,
    );
    expect(notifications).toHaveLength(1);
    expect(notifications[0].update).toMatchObject({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "hello" },
    });
  });

  it("drops an empty streamed text block but keeps a non-empty one", () => {
    const notifications = toAcpNotifications(
      [
        { type: "text", text: "" },
        { type: "text", text: "real" },
      ] as any,
      "assistant",
      "test-session",
      {},
      mockClient,
      mockLogger,
    );
    expect(notifications).toHaveLength(1);
    expect(notifications[0].update).toMatchObject({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "real" },
    });
  });
});

describe("Agent/Task tool_result rendering from tool_use_result", () => {
  const mockClient = {} as AcpClient;
  const mockLogger: Logger = { log: () => {}, error: () => {} };

  const TRAILER =
    "\nagentId: a0e1eff08fcb6e2e8 (use SendMessage with to: 'a0e1eff08fcb6e2e8', summary: '<5-10 word recap>' to continue this agent)\n<usage>subagent_tokens: 11735\ntool_uses: 2\nduration_ms: 21237</usage>";

  const agentToolUse = {
    type: "tool_use" as const,
    id: "toolu_agent",
    name: "Task",
    input: { description: "Explore", prompt: "look around" },
  };

  const rawResult: ToolResultBlockParam = {
    type: "tool_result",
    tool_use_id: "toolu_agent",
    content: [{ type: "text", text: `The report.${TRAILER}` }],
  };

  const structured = {
    status: "completed",
    agentId: "a0e1eff08fcb6e2e8",
    content: [{ type: "text", text: "The structured report." }],
    totalTokens: 11735,
    totalToolUseCount: 2,
    totalDurationMs: 21237,
  };

  it("renders the structured subagent report instead of the raw trailer text", () => {
    const update = toolUpdateFromToolResult(rawResult, agentToolUse, false, structured);

    expect(update).toEqual({
      content: [{ type: "content", content: { type: "text", text: "The structured report." } }],
    });
  });

  it("strips the trailer from the raw fallback when tool_use_result is absent", () => {
    // Replayed sessions and older CLIs have no structured report; the
    // tail-anchored strip is the only cleanup available there.
    const update = toolUpdateFromToolResult(rawResult, agentToolUse, false);

    expect(update).toEqual({
      content: [{ type: "content", content: { type: "text", text: "The report." } }],
    });
  });

  it("strips only matching trailer parts and leaves unrecognized text alone", () => {
    const oddResult: ToolResultBlockParam = {
      type: "tool_result",
      tool_use_id: "toolu_agent",
      content: [
        { type: "text", text: "Report A.\n<usage>subagent_tokens: 5</usage>" },
        { type: "text", text: "Report B.\nagentId: abc-123 (for resuming)" },
        { type: "text", text: "agentId mentioned mid-text (not a trailer) stays.\nDone." },
      ],
    };
    const update = toolUpdateFromToolResult(oddResult, agentToolUse, false);

    expect(update.content).toEqual([
      { type: "content", content: { type: "text", text: "Report A." } },
      { type: "content", content: { type: "text", text: "Report B." } },
      {
        type: "content",
        content: { type: "text", text: "agentId mentioned mid-text (not a trailer) stays.\nDone." },
      },
    ]);
  });

  it("leaves malformed trailers alone", () => {
    // Incomplete trailers are ordinary report text, not metadata to strip.
    const malformedResult: ToolResultBlockParam = {
      type: "tool_result",
      tool_use_id: "toolu_agent",
      content: [
        { type: "text", text: "Report.\n<usage>missing closing tag" },
        { type: "text", text: "Report.\nagentId: abc-123 (missing closing paren" },
      ],
    };

    const update = toolUpdateFromToolResult(malformedResult, agentToolUse, false);

    expect(update.content).toEqual([
      { type: "content", content: { type: "text", text: "Report.\n<usage>missing closing tag" } },
      {
        type: "content",
        content: { type: "text", text: "Report.\nagentId: abc-123 (missing closing paren" },
      },
    ]);
  });

  it("strips only the trailer when the report itself mentions <usage>", () => {
    const result: ToolResultBlockParam = {
      type: "tool_result",
      tool_use_id: "toolu_agent",
      content: "Grep for <usage> found 3 hits.\n<usage>subagent_tokens: 5</usage>",
    };
    const update = toolUpdateFromToolResult(result, agentToolUse, false);

    expect(update.content).toEqual([
      { type: "content", content: { type: "text", text: "Grep for <usage> found 3 hits." } },
    ]);
  });

  it("handles adversarial trailer-shaped input in linear time", () => {
    // Regression: the old regex-based strip backtracked quadratically on
    // these shapes (CodeQL js/polynomial-redos) — at this size it would
    // blow the test timeout rather than merely run slow.
    const result: ToolResultBlockParam = {
      type: "tool_result",
      tool_use_id: "toolu_agent",
      content: [
        { type: "text", text: "agentId: - (".repeat(20000) },
        { type: "text", text: "<usage>".repeat(30000) },
      ],
    };
    const update = toolUpdateFromToolResult(result, agentToolUse, false);

    // Neither is a real trailer, so both come through unchanged.
    expect(update.content).toEqual([
      { type: "content", content: { type: "text", text: "agentId: - (".repeat(20000) } },
      { type: "content", content: { type: "text", text: "<usage>".repeat(30000) } },
    ]);
  });

  it("falls back (trailer-stripped) when tool_use_result is the async_launched variant", () => {
    const update = toolUpdateFromToolResult(rawResult, agentToolUse, false, {
      status: "async_launched",
      agentId: "a0e1eff08fcb6e2e8",
      description: "Explore",
    });

    expect(update.content).toEqual([
      { type: "content", content: { type: "text", text: "The report." } },
    ]);
  });

  it("falls back (trailer-stripped) when the structured content array is empty", () => {
    // A completed subagent can end with zero text blocks — an empty
    // structured render must not beat the raw fallback.
    const update = toolUpdateFromToolResult(rawResult, agentToolUse, false, {
      ...structured,
      content: [],
    });

    expect(update.content).toEqual([
      { type: "content", content: { type: "text", text: "The report." } },
    ]);
  });

  it("threads options.toolUseResult through toAcpNotifications for a lone tool_result", () => {
    const toolUseCache: ToolUseCache = { toolu_agent: agentToolUse };

    const notifications = toAcpNotifications(
      [rawResult] as any,
      "user",
      "test-session",
      toolUseCache,
      mockClient,
      mockLogger,
      { toolUseResult: structured },
    );

    expect(notifications).toHaveLength(1);
    expect(notifications[0].update).toMatchObject({
      sessionUpdate: "tool_call_update",
      toolCallId: "toolu_agent",
      status: "completed",
      content: [{ type: "content", content: { type: "text", text: "The structured report." } }],
    });
  });

  it("ignores options.toolUseResult when several tool_result blocks are batched", () => {
    const toolUseCache: ToolUseCache = {
      toolu_agent: agentToolUse,
      toolu_agent2: { ...agentToolUse, id: "toolu_agent2" },
    };

    const notifications = toAcpNotifications(
      [rawResult, { ...rawResult, tool_use_id: "toolu_agent2" }] as any,
      "user",
      "test-session",
      toolUseCache,
      mockClient,
      mockLogger,
      { toolUseResult: structured },
    );

    expect(notifications).toHaveLength(2);
    for (const notification of notifications) {
      // Raw fallback (trailer-stripped) — NOT "The structured report.", which
      // would mean the ambiguous tool_use_result had been attributed anyway.
      expect(notification.update).toMatchObject({
        content: [{ type: "content", content: { type: "text", text: "The report." } }],
      });
    }
  });
});

describe("tool_result_meta non-execution stamping", () => {
  const mockClient = {} as AcpClient;
  const mockLogger: Logger = { log: () => {}, error: () => {} };

  const bashToolUse = {
    type: "tool_use" as const,
    id: "toolu_bash",
    name: "Bash",
    input: { command: "rm -rf build" },
  };

  const deniedResult: ToolResultBlockParam = {
    type: "tool_result",
    tool_use_id: "toolu_bash",
    is_error: true,
    content: "The user doesn't want to proceed with this tool use.",
  };

  it("removes Claude's outer fence from a rejected ExitPlanMode explanation only", () => {
    const toolUseCache: ToolUseCache = {
      toolu_plan: {
        type: "tool_use",
        id: "toolu_plan",
        name: "ExitPlanMode",
        input: { plan: "Implement it" },
      },
    };

    const notifications = toAcpNotifications(
      [
        {
          type: "tool_result",
          tool_use_id: "toolu_plan",
          is_error: true,
          content: "```\nThe user chose to keep planning.\n```",
        },
      ] as any,
      "user",
      "test-session",
      toolUseCache,
      mockClient,
      mockLogger,
      { toolResultMeta: [{ id: "toolu_plan", non_execution_kind: "user-rejected" }] },
    );

    expect(notifications).toHaveLength(1);
    expect(notifications[0].update).toMatchObject({
      sessionUpdate: "tool_call_update",
      toolCallId: "toolu_plan",
      status: "failed",
      rawOutput: "The user chose to keep planning.",
    });
  });

  it("preserves fenced output from tools other than ExitPlanMode", () => {
    const fenced = "```text\ncommand output\n```";
    const notifications = toAcpNotifications(
      [
        {
          type: "tool_result",
          tool_use_id: "toolu_bash",
          content: fenced,
        },
      ] as any,
      "user",
      "test-session",
      { toolu_bash: bashToolUse },
      mockClient,
      mockLogger,
    );

    expect(notifications[0].update).toMatchObject({ rawOutput: fenced });
  });

  it("stamps nonExecutionKind and userFeedback on the failed tool_call_update", () => {
    const toolUseCache: ToolUseCache = { toolu_bash: bashToolUse };

    const notifications = toAcpNotifications(
      [deniedResult] as any,
      "user",
      "test-session",
      toolUseCache,
      mockClient,
      mockLogger,
      {
        toolResultMeta: [
          { id: "toolu_bash", non_execution_kind: "user-rejected", user_feedback: "use npm" },
        ],
      },
    );

    expect(notifications).toHaveLength(1);
    expect(notifications[0].update).toMatchObject({
      sessionUpdate: "tool_call_update",
      toolCallId: "toolu_bash",
      status: "failed",
      _meta: {
        claudeCode: {
          toolName: "Bash",
          nonExecutionKind: "user-rejected",
          userFeedback: "use npm",
        },
      },
    });
  });

  it("attributes entries by tool_use_id, so only the flagged result in a batch is stamped", () => {
    const toolUseCache: ToolUseCache = {
      toolu_bash: bashToolUse,
      toolu_bash2: { ...bashToolUse, id: "toolu_bash2" },
    };

    const notifications = toAcpNotifications(
      [
        deniedResult,
        {
          type: "tool_result",
          tool_use_id: "toolu_bash2",
          content: "ok",
        },
      ] as any,
      "user",
      "test-session",
      toolUseCache,
      mockClient,
      mockLogger,
      { toolResultMeta: [{ id: "toolu_bash", non_execution_kind: "user-rejected" }] },
    );

    expect(notifications).toHaveLength(2);
    const [denied, ran] = notifications.map((n) => n.update) as any[];
    expect(denied._meta.claudeCode).toMatchObject({ nonExecutionKind: "user-rejected" });
    // No user_feedback on the wire entry → no userFeedback key at all.
    expect(denied._meta.claudeCode).not.toHaveProperty("userFeedback");
    expect(ran._meta.claudeCode).not.toHaveProperty("nonExecutionKind");
  });

  it("ignores a malformed sidecar and malformed entries", () => {
    for (const malformed of [
      "user-rejected", // not an array
      [{ non_execution_kind: "user-rejected" }], // entry missing id
      [{ id: "toolu_bash", non_execution_kind: 7 }], // kind not a string
      [null, 42], // entries not objects
    ]) {
      const toolUseCache: ToolUseCache = { toolu_bash: bashToolUse };
      const notifications = toAcpNotifications(
        [deniedResult] as any,
        "user",
        "test-session",
        toolUseCache,
        mockClient,
        mockLogger,
        { toolResultMeta: malformed },
      );

      expect(notifications).toHaveLength(1);
      expect((notifications[0].update as any)._meta.claudeCode).not.toHaveProperty(
        "nonExecutionKind",
      );
    }
  });

  it("stamps the resolve of a permission-surfaced suppressed tool (Task*)", () => {
    // A TaskGet surfaced as a real tool_call by the permission flow never gets
    // a tool_call_update from the suppressed Task* branch; the wasEmitted
    // resolve must carry the denial kind too.
    const taskGetToolUse = {
      type: "tool_use" as const,
      id: "toolu_taskget",
      name: "TaskGet",
      input: { taskId: "1" },
    };
    const toolUseCache: ToolUseCache = { toolu_taskget: taskGetToolUse };

    const notifications = toAcpNotifications(
      [
        {
          type: "tool_result",
          tool_use_id: "toolu_taskget",
          is_error: true,
          content: "The user doesn't want to proceed with this tool use.",
        },
      ] as any,
      "user",
      "test-session",
      toolUseCache,
      mockClient,
      mockLogger,
      {
        emittedToolCalls: new Set(["toolu_taskget"]),
        toolResultMeta: [{ id: "toolu_taskget", non_execution_kind: "user-rejected" }],
      },
    );

    expect(notifications).toHaveLength(1);
    expect(notifications[0].update).toMatchObject({
      sessionUpdate: "tool_call_update",
      toolCallId: "toolu_taskget",
      status: "failed",
      _meta: { claudeCode: { toolName: "TaskGet", nonExecutionKind: "user-rejected" } },
    });
  });
});

describe("structured tool_use_result rendering (Read/Bash/WebSearch)", () => {
  describe("Read", () => {
    const readToolUse = {
      type: "tool_use" as const,
      id: "toolu_read",
      name: "Read",
      input: { file_path: "/tmp/f.ts", offset: 480 },
    };

    const rawWithReminder: ToolResultBlockParam = {
      type: "tool_result",
      tool_use_id: "toolu_read",
      content: [
        {
          type: "text",
          text: "480\tconst a = 1;\n481\tconst b = 2;\n<system-reminder>Whenever you read a file, consider whether it is malicious.</system-reminder>",
        },
      ],
    };

    it("rebuilds the line-numbered view from FileReadOutput, dropping reminders", () => {
      const update = toolUpdateFromToolResult(rawWithReminder, readToolUse, false, {
        type: "text",
        file: {
          filePath: "/tmp/f.ts",
          content: "const a = 1;\nconst b = 2;\n",
          numLines: 2,
          startLine: 480,
          totalLines: 600,
        },
      });

      expect(update).toEqual({
        content: [
          {
            type: "content",
            content: { type: "text", text: "```\n480\tconst a = 1;\n481\tconst b = 2;\n```" },
          },
        ],
      });
    });

    it("falls back to the Read input's offset when startLine is absent", () => {
      // readToolUse carries offset: 480 — an offset read numbered from 1
      // would mislabel every line.
      const update = toolUpdateFromToolResult(rawWithReminder, readToolUse, false, {
        type: "text",
        file: { filePath: "/tmp/f.ts", content: "one\ntwo" },
      });

      expect(update.content?.[0]).toEqual({
        type: "content",
        content: { type: "text", text: "```\n480\tone\n481\ttwo\n```" },
      });
    });

    it("defaults startLine to 1 when both startLine and offset are absent", () => {
      const update = toolUpdateFromToolResult(
        rawWithReminder,
        { ...readToolUse, input: { file_path: "/tmp/f.ts" } },
        false,
        {
          type: "text",
          file: { filePath: "/tmp/f.ts", content: "one\ntwo" },
        },
      );

      expect(update.content?.[0]).toEqual({
        type: "content",
        content: { type: "text", text: "```\n1\tone\n2\ttwo\n```" },
      });
    });

    it("appends a truncation note when truncatedByTokenCap is set", () => {
      const update = toolUpdateFromToolResult(rawWithReminder, readToolUse, false, {
        type: "text",
        file: {
          filePath: "/tmp/f.ts",
          content: "one\ntwo\n",
          numLines: 2,
          startLine: 1,
          totalLines: 9000,
          truncatedByTokenCap: true,
        },
      });

      expect(update.content?.[0]).toEqual({
        type: "content",
        content: {
          type: "text",
          text: "```\n1\tone\n2\ttwo\n[File truncated: showing 2 of 9000 lines]\n```",
        },
      });
    });

    it("falls back to raw content for non-text variants", () => {
      const update = toolUpdateFromToolResult(rawWithReminder, readToolUse, false, {
        type: "image",
        file: { base64: "aGk=", type: "image/png", originalSize: 3 },
      });

      // Raw path: markdown-escaped raw text (reminder included — image reads
      // don't carry reminders in practice).
      expect(update.content).toHaveLength(1);
      expect((update.content?.[0] as any).content.text).toContain("const a = 1;");
    });
  });

  describe("Bash", () => {
    const bashToolUse = {
      type: "tool_use" as const,
      id: "toolu_bash",
      name: "Bash",
      input: { command: "git push" },
    };

    const HINT =
      "\n[This command modified 1 file you've previously read: src/foo.ts. Call Read before editing.]";

    const rawWithHint: ToolResultBlockParam = {
      type: "tool_result",
      tool_use_id: "toolu_bash",
      content: `pushed ok${HINT}`,
    };

    const structured = {
      stdout: "pushed ok",
      stderr: "",
      interrupted: false,
      isImage: false,
    };

    it("prefers structured stdout/stderr over raw text with model-directed hints", () => {
      const update = toolUpdateFromToolResult(rawWithHint, bashToolUse, true, structured);

      expect(update._meta?.terminal_output).toEqual({
        terminal_id: "toolu_bash",
        data: "pushed ok",
      });
      expect(update._meta?.terminal_exit).toEqual({
        terminal_id: "toolu_bash",
        exit_code: 0,
        signal: null,
      });
    });

    it("joins stderr after stdout like the code-execution path", () => {
      const update = toolUpdateFromToolResult(rawWithHint, bashToolUse, false, {
        ...structured,
        stderr: "warning: something",
      });

      expect(update.content).toEqual([
        {
          type: "content",
          content: { type: "text", text: "```console\npushed ok\nwarning: something\n```" },
        },
      ]);
    });

    it("falls back to raw text for backgrounded commands", () => {
      const update = toolUpdateFromToolResult(rawWithHint, bashToolUse, true, {
        ...structured,
        stdout: "",
        backgroundTaskId: "bash_1",
      });

      expect(update._meta?.terminal_output?.data).toBe(`pushed ok${HINT}`);
    });

    it("falls back to the raw content array for image output", () => {
      const imageResult: ToolResultBlockParam = {
        type: "tool_result",
        tool_use_id: "toolu_bash",
        content: [
          { type: "image", source: { type: "base64", data: "aGk=", media_type: "image/png" } },
        ],
      };
      const update = toolUpdateFromToolResult(imageResult, bashToolUse, true, {
        ...structured,
        isImage: true,
      });

      expect(update.content).toEqual([
        {
          type: "content",
          content: { type: "image", data: "aGk=", mimeType: "image/png" },
        },
      ]);
    });

    it("re-establishes the abort notice and a failing exit code for interrupted commands", () => {
      const update = toolUpdateFromToolResult(rawWithHint, bashToolUse, true, {
        ...structured,
        stdout: "partial output",
        interrupted: true,
      });

      expect(update._meta?.terminal_output).toEqual({
        terminal_id: "toolu_bash",
        data: "partial output\n[Command was aborted before completion]",
      });
      expect(update._meta?.terminal_exit).toEqual({
        terminal_id: "toolu_bash",
        exit_code: 1,
        signal: null,
      });
    });

    it("re-establishes the truncation note and persisted path for too-large outputs", () => {
      const update = toolUpdateFromToolResult(rawWithHint, bashToolUse, true, {
        ...structured,
        stdout: "clipped stdout",
        persistedOutputPath: "/tmp/tool-results/abc.txt",
        persistedOutputSize: 38100,
      });

      expect(update._meta?.terminal_output).toEqual({
        terminal_id: "toolu_bash",
        data: "clipped stdout\n[Output truncated (38100 bytes total): full output saved to /tmp/tool-results/abc.txt]",
      });
    });
  });

  describe("WebSearch", () => {
    const searchToolUse = {
      type: "tool_use" as const,
      id: "toolu_search",
      name: "WebSearch",
      input: { query: "npm sigstore bug" },
    };

    const rawDump: ToolResultBlockParam = {
      type: "tool_result",
      tool_use_id: "toolu_search",
      content:
        'Web search results for query: "npm sigstore bug"\n\nLinks: [{"title":"Issue #9722","url":"https://github.com/npm/cli/issues/9722"}]',
    };

    it("renders hits as Title (url) lines from WebSearchOutput", () => {
      const update = toolUpdateFromToolResult(rawDump, searchToolUse, false, {
        query: "npm sigstore bug",
        durationSeconds: 5.5,
        results: [
          "I found one relevant issue:",
          {
            tool_use_id: "srvtoolu_1",
            content: [
              { title: "Issue #9722", url: "https://github.com/npm/cli/issues/9722" },
              { title: "sigstore-js", url: "https://github.com/sigstore/sigstore-js" },
            ],
          },
        ],
      });

      expect(update).toEqual({
        content: [
          {
            type: "content",
            content: {
              type: "text",
              text: "I found one relevant issue:\nIssue #9722 (https://github.com/npm/cli/issues/9722)\nsigstore-js (https://github.com/sigstore/sigstore-js)",
            },
          },
        ],
      });
    });

    it("falls back to the raw dump when tool_use_result is absent", () => {
      const update = toolUpdateFromToolResult(rawDump, searchToolUse, false);

      expect((update.content?.[0] as any).content.text).toContain("Web search results for query");
    });

    it("skips off-spec hits instead of rendering undefined fields", () => {
      const update = toolUpdateFromToolResult(rawDump, searchToolUse, false, {
        query: "npm sigstore bug",
        durationSeconds: 5.5,
        results: [
          {
            tool_use_id: "srvtoolu_1",
            content: [
              { error_code: "provider_error" },
              { title: "Issue #9722", url: "https://github.com/npm/cli/issues/9722" },
            ],
          },
        ],
      });

      expect(update).toEqual({
        content: [
          {
            type: "content",
            content: {
              type: "text",
              text: "Issue #9722 (https://github.com/npm/cli/issues/9722)",
            },
          },
        ],
      });
    });

    it("falls back to the raw dump when every hit is off-spec", () => {
      const update = toolUpdateFromToolResult(rawDump, searchToolUse, false, {
        query: "npm sigstore bug",
        durationSeconds: 5.5,
        results: [{ tool_use_id: "srvtoolu_1", content: [{ error_code: "provider_error" }] }],
      });

      expect((update.content?.[0] as any).content.text).toContain("Web search results for query");
    });
  });
});

describe("Skill tool rendering", () => {
  const mockLogger: Logger = { log: () => {}, error: () => {} };

  describe("toolInfoFromToolUse", () => {
    it("sets title to 'Load skill: <name>' and returns empty content", () => {
      const info = toolInfoFromToolUse(
        { name: "Skill", id: "toolu_1", input: { skill: "commits" } },
        false,
      );
      expect(info.title).toBe("Load skill: commits");
      expect(info.kind).toBe("other");
      expect(info.content).toEqual([]);
    });

    it("falls back to 'Load skill' when skill name is absent", () => {
      const info = toolInfoFromToolUse({ name: "Skill", id: "toolu_2", input: {} }, false);
      expect(info.title).toBe("Load skill");
      expect(info.content).toEqual([]);
    });

    it("does not throw when input is undefined", () => {
      const info = toolInfoFromToolUse({ name: "Skill", id: "toolu_3", input: undefined }, false);
      expect(info.title).toBe("Load skill");
      expect(info.content).toEqual([]);
    });
  });

  describe("toolUpdateFromToolResult", () => {
    it("suppresses the raw 'Launching skill' result text", () => {
      const toolUse = {
        type: "tool_use",
        id: "toolu_4",
        name: "Skill",
        input: { skill: "commits" },
      };
      const toolResult = {
        type: "tool_result" as const,
        tool_use_id: "toolu_4",
        content: "Launching skill: commits",
        is_error: false,
      };
      const update = toolUpdateFromToolResult(toolResult, toolUse, false);
      expect(update).toEqual({});
    });
  });

  describe("_meta.claudeCode.skill in tool_call notification", () => {
    it("includes skill name in _meta.claudeCode when Skill tool is invoked", () => {
      const notifications = toAcpNotifications(
        [
          { type: "tool_use", id: "toolu_5", name: "Skill", input: { skill: "commits", args: "" } },
        ] as any,
        "assistant",
        "test-session",
        {},
        {} as AcpClient,
        mockLogger,
      );
      expect(notifications[0]?.update).toMatchObject({
        sessionUpdate: "tool_call",
        _meta: { claudeCode: { toolName: "Skill", skill: "commits" } },
      });
    });

    it("omits skill from _meta.claudeCode when skill name is missing", () => {
      const notifications = toAcpNotifications(
        [{ type: "tool_use", id: "toolu_6", name: "Skill", input: {} }] as any,
        "assistant",
        "test-session",
        {},
        {} as AcpClient,
        mockLogger,
      );
      const meta = (notifications[0]?.update as any)?._meta?.claudeCode;
      expect(meta).toBeDefined();
      expect(meta.skill).toBeUndefined();
    });
  });

  describe("_meta.claudeCode.skillPath", () => {
    const skillMeta = (skill: string, cwd?: string) =>
      (
        toAcpNotifications(
          [{ type: "tool_use", id: "toolu_skill_path", name: "Skill", input: { skill } }] as any,
          "assistant",
          "test-session",
          {},
          {} as AcpClient,
          mockLogger,
          cwd ? { cwd } : undefined,
        )[0]?.update as any
      )?._meta?.claudeCode;

    let root: string;

    beforeEach(() => {
      root = mkdtempSync(path.join(tmpdir(), "acp-skill-path-"));
    });

    afterEach(() => {
      rmSync(root, { recursive: true, force: true });
    });

    const writeSkill = (relativeDir: string) => {
      const dir = path.join(root, relativeDir);
      mkdirSync(dir, { recursive: true });
      const file = path.join(dir, "SKILL.md");
      writeFileSync(file, "# skill\n");
      return file;
    };

    it("resolves a project-level .claude/skills skill", () => {
      const file = writeSkill(".claude/skills/commits");
      expect(skillMeta("commits", root).skillPath).toBe(file);
    });

    it("resolves a project-level .agents/skills skill", () => {
      const file = writeSkill(".agents/skills/commits");
      expect(skillMeta("commits", root).skillPath).toBe(file);
    });

    it("resolves a directory-scoped skill spelled prefix:name", () => {
      const file = writeSkill("apps/web/.claude/skills/deploy");
      expect(skillMeta("apps/web:deploy", root).skillPath).toBe(file);
    });

    it("resolves a plugin skill spelled plugin:name", () => {
      const file = writeSkill(".claude/plugins/reviewer/skills/audit");
      expect(skillMeta("reviewer:audit", root).skillPath).toBe(file);
    });

    it("omits skillPath when no known layout holds the skill", () => {
      const meta = skillMeta("nonexistent", root);
      expect(meta.skill).toBe("nonexistent");
      expect(meta.skillPath).toBeUndefined();
    });

    it("omits skillPath when the session has no cwd", () => {
      writeSkill(".claude/skills/commits");
      expect(skillMeta("commits").skillPath).toBeUndefined();
    });
  });
});
