import { describe, it, expect } from "vitest";
import { AgentSideConnection, ClientCapabilities } from "@agentclientprotocol/sdk";
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
import { toAcpNotifications, ToolUseCache, Logger } from "../acp-agent.js";
import {
  toolUpdateFromToolResult,
  createPostToolUseHook,
  createTaskHook,
  toolInfoFromToolUse,
  planEntries,
  applyTaskCreate,
  applyTaskUpdate,
  parseTaskCreateOutput,
  taskStateToPlanEntries,
  TaskState,
} from "../tools.js";

describe("rawOutput in tool call updates", () => {
  const mockClient = {} as AgentSideConnection;
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
  const mockClient = {} as AgentSideConnection;
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

    it("should include exit_code from return_code in terminal_exit", () => {
      const toolResult = makeBashResult("", "command not found", 127);
      const update = toolUpdateFromToolResult(toolResult, bashToolUse, true);

      expect(update._meta?.terminal_exit).toEqual({
        terminal_id: "toolu_bash",
        exit_code: 127,
        signal: null,
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

      it("should use error handler when is_error is true (early return before Bash case)", () => {
        const toolResult = makeStringBashResult("command not found: bad_cmd", true);
        const update = toolUpdateFromToolResult(toolResult, bashToolUse, true);

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
  });

  describe("toAcpNotifications with clientCapabilities", () => {
    const toolUseCache: ToolUseCache = {
      toolu_bash: {
        type: "tool_use",
        id: "toolu_bash",
        name: "Bash",
        input: { command: "ls -la" },
      },
    };

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

      const withoutSupport = toAcpNotifications(
        [toolResult],
        "assistant",
        "test-session",
        toolUseCache,
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

  describe("post-tool-use hook sends diff content for Edit tool", () => {
    it("should include content and locations from structuredPatch in hook update", async () => {
      const toolUseCache: ToolUseCache = {};

      const hookUpdates: any[] = [];
      const mockClientWithUpdate = {
        sessionUpdate: async (notification: any) => {
          hookUpdates.push(notification);
        },
      } as unknown as AgentSideConnection;

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
      );

      // Fire PostToolUse hook with a structuredPatch in tool_response
      const hook = createPostToolUseHook(mockLogger);
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
      } as unknown as AgentSideConnection;

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

      const hook = createPostToolUseHook(mockLogger);
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
      } as unknown as AgentSideConnection;

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

      const hook = createPostToolUseHook(mockLogger);
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
      } as unknown as AgentSideConnection;

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

      const hook = createPostToolUseHook(mockLogger);
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
      } as unknown as AgentSideConnection;

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

      const hook = createPostToolUseHook(mockLogger);
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
      } as unknown as AgentSideConnection;

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
      const hook = createPostToolUseHook(mockLogger);
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
      } as unknown as AgentSideConnection;

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
      const hook = createPostToolUseHook(mockLogger);
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
    expect(info.title).toBe("Ready to code?");
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

  it("TodoWrite with undefined input should not throw", () => {
    const toolUse = { name: "TodoWrite", id: "toolu_todo_undef", input: undefined };
    const info = toolInfoFromToolUse(toolUse, false);
    expect(info.title).toBe("Update TODOs");
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
});

describe("toAcpNotifications - TodoWrite with undefined input regression", () => {
  const mockClient = {} as AgentSideConnection;
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
    applyTaskCreate(state, { subject: "A", description: "" }, { task: { id: "1", subject: "A" } });
    applyTaskCreate(state, { subject: "B", description: "" }, { task: { id: "2", subject: "B" } });
    applyTaskUpdate(state, { taskId: "1", status: "in_progress" });
    expect(taskStateToPlanEntries(state)).toEqual([
      { content: "A", status: "in_progress", priority: "medium" },
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
});

describe("toAcpNotifications - Task* tools", () => {
  const mockClient = {} as AgentSideConnection;
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

  it("suppresses TaskList and TaskGet tool_result without touching task state", () => {
    const toolUseCache: ToolUseCache = {
      "list-1": { type: "tool_use", id: "list-1", name: "TaskList", input: {} },
      "get-1": { type: "tool_use", id: "get-1", name: "TaskGet", input: { taskId: "1" } },
    };
    const taskState: TaskState = new Map([
      ["1", { subject: "Existing", status: "in_progress" as const }],
    ]);

    const notifications = toAcpNotifications(
      [
        { type: "tool_result", tool_use_id: "list-1", content: "...", is_error: false },
        { type: "tool_result", tool_use_id: "get-1", content: "...", is_error: false },
      ] as any,
      "user",
      "test-session",
      toolUseCache,
      mockClient,
      mockLogger,
      { taskState },
    );

    expect(notifications).toHaveLength(0);
    expect(taskState.get("1")).toEqual({ subject: "Existing", status: "in_progress" });
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
