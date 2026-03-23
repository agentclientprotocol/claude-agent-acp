import { afterEach, describe, it, expect } from "vitest";
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
  registerHookCallback,
  stashedHookInputs,
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
          hook_event_name: "PostToolUse" as const,
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
          hook_event_name: "PostToolUse" as const,
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
          hook_event_name: "PostToolUse" as const,
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
          hook_event_name: "PostToolUse" as const,
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
          hook_event_name: "PostToolUse" as const,
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

  describe("PostToolUse callback execution contract (fire-and-stash)", () => {
    // These tests verify the observable contract between PostToolUse
    // hooks and registerHookCallback using the non-blocking
    // fire-and-stash model:
    //
    //   1. Callback registered THEN hook fires → callback executes synchronously
    //   2. Hook fires THEN callback registered → input is stashed, callback
    //      executes when registration arrives (no blocking, no timeout)
    //   3. No errors logged in either ordering
    //   4. Callback receives correct toolInput and toolResponse
    //   5. Multiple hooks with mixed ordering don't interfere
    //   6. Hook NEVER blocks — always returns { continue: true } immediately
    //   7. Subagent child tool uses (callback arrives much later) work correctly
    //
    // The fire-and-forget callbacks use .then() chains (microtasks).
    // Flush them deterministically instead of using real setTimeout delays.
    // Depth 5 covers: async callback execution (1-2) + .then cleanup (1)
    // + .catch chain (1) + headroom (1). If future changes add awaits
    // to registerHookCallback's fire-and-forget path, increase this.
    async function flushMicrotasks() {
      for (let i = 0; i < 5; i++) await Promise.resolve();
    }
    //
    function postToolUseInput(
      toolUseId: string,
      toolName: string,
      toolInput: unknown = {},
      toolResponse: unknown = "",
    ) {
      return {
        hook_event_name: "PostToolUse" as const,
        tool_name: toolName,
        tool_input: toolInput,
        tool_response: toolResponse,
        tool_use_id: toolUseId,
        session_id: "test-session",
        transcript_path: "/tmp/test",
        cwd: "/tmp",
      };
    }

    // Clean up stashed state between tests to avoid cross-contamination.
    afterEach(() => {
      for (const key of Object.keys(stashedHookInputs)) {
        delete stashedHookInputs[key];
      }
    });

    it("executes callback immediately when registered before hook fires", async () => {
      const received: { id: string; input: unknown; response: unknown }[] = [];

      registerHookCallback("toolu_before_1", {
        onPostToolUseHook: async (id, input, response) => {
          received.push({ id, input, response });
        },
      });

      const hook = createPostToolUseHook(mockLogger);
      const result = await hook(
        postToolUseInput("toolu_before_1", "Bash", { command: "ls" }, "file.txt"),
        "toolu_before_1",
        { signal: AbortSignal.abort() },
      );

      expect(result).toEqual({ continue: true });
      expect(received).toHaveLength(1);
      expect(received[0]).toEqual({
        id: "toolu_before_1",
        input: { command: "ls" },
        response: "file.txt",
      });
      // Stash should be empty — happy path doesn't use it.
      expect(stashedHookInputs["toolu_before_1"]).toBeUndefined();
    });

    it("stashes input and executes callback when registered after hook fires (42ms race condition)", async () => {
      // This is the original bug from PR #353: the SDK fires PostToolUse
      // ~42ms before the streaming handler processes the tool_use block.
      const received: { id: string; input: unknown; response: unknown }[] = [];
      const hook = createPostToolUseHook(mockLogger);

      // Hook fires first — no callback registered yet.
      const result = await hook(
        postToolUseInput("toolu_race_1", "Read", { file_path: "/tmp/f" }, "contents"),
        "toolu_race_1",
        { signal: AbortSignal.abort() },
      );

      // Hook returns immediately (non-blocking).
      expect(result).toEqual({ continue: true });

      // Input should be stashed.
      expect(stashedHookInputs["toolu_race_1"]).toBeDefined();
      expect(stashedHookInputs["toolu_race_1"].toolInput).toEqual({ file_path: "/tmp/f" });
      expect(stashedHookInputs["toolu_race_1"].toolResponse).toBe("contents");

      // Registration arrives on the next tick (simulates streaming lag).
      registerHookCallback("toolu_race_1", {
        onPostToolUseHook: async (id, input, response) => {
          received.push({ id, input, response });
        },
      });

      // The callback fires asynchronously — flush microtasks.
      await flushMicrotasks();

      expect(received).toHaveLength(1);
      expect(received[0]).toEqual({
        id: "toolu_race_1",
        input: { file_path: "/tmp/f" },
        response: "contents",
      });
      // Stash should be cleaned up after execution.
      expect(stashedHookInputs["toolu_race_1"]).toBeUndefined();
    });

    it("does not log errors regardless of registration ordering", async () => {
      const errors: string[] = [];
      const spyLogger: Logger = {
        log: () => {},
        error: (...args: any[]) => {
          errors.push(args.map(String).join(" "));
        },
      };

      const hook = createPostToolUseHook(spyLogger);

      // Case A: register-then-fire
      registerHookCallback("toolu_noerr_a", {
        onPostToolUseHook: async () => {},
      });
      await hook(postToolUseInput("toolu_noerr_a", "Bash"), "toolu_noerr_a", {
        signal: AbortSignal.abort(),
      });

      // Case B: fire-then-register
      await hook(postToolUseInput("toolu_noerr_b", "Grep"), "toolu_noerr_b", {
        signal: AbortSignal.abort(),
      });
      registerHookCallback(
        "toolu_noerr_b",
        {
          onPostToolUseHook: async () => {},
        },
        spyLogger,
      );
      await flushMicrotasks();

      expect(errors).toHaveLength(0);
    });

    it("keeps hooks independent when some are pre-registered and some are late", async () => {
      const callOrder: string[] = [];
      const hook = createPostToolUseHook(mockLogger);

      // Register callback A upfront.
      registerHookCallback("toolu_indep_a", {
        onPostToolUseHook: async (id) => {
          callOrder.push(id);
        },
      });

      // Fire hook B first (no registration yet), then hook A.
      await hook(postToolUseInput("toolu_indep_b", "Read"), "toolu_indep_b", {
        signal: AbortSignal.abort(),
      });

      await hook(postToolUseInput("toolu_indep_a", "Bash"), "toolu_indep_a", {
        signal: AbortSignal.abort(),
      });

      // A should have executed immediately (happy path).
      expect(callOrder).toEqual(["toolu_indep_a"]);

      // Now register B — it should find the stash and execute.
      registerHookCallback("toolu_indep_b", {
        onPostToolUseHook: async (id) => {
          callOrder.push(id);
        },
      });

      await flushMicrotasks();
      expect(callOrder).toEqual(["toolu_indep_a", "toolu_indep_b"]);
    });

    it("hook NEVER blocks — returns { continue: true } immediately even when callback is missing", async () => {
      // This is the critical regression test.  The old blocking model
      // waited up to 5 seconds; the new model must return instantly.
      const hook = createPostToolUseHook(mockLogger);

      const start = Date.now();
      const result = await hook(
        postToolUseInput("toolu_noblock_1", "Bash", { command: "slow" }, "output"),
        "toolu_noblock_1",
        { signal: AbortSignal.abort() },
      );
      const elapsed = Date.now() - start;

      expect(result).toEqual({ continue: true });
      // Must complete in well under 1 second — the old code would take 5s.
      expect(elapsed).toBeLessThan(100);
      // Input should be stashed for later.
      expect(stashedHookInputs["toolu_noblock_1"]).toBeDefined();
    });

    it("subagent child tool uses: callback arrives much later and still executes", async () => {
      // Reproduces the real-world scenario from protocol logs: the SDK
      // fires PostToolUse for subagent child tool uses, but the callback
      // isn't registered until the subagent finishes (potentially tens
      // of seconds later).
      const received: { id: string; input: unknown; response: unknown }[] = [];
      const hook = createPostToolUseHook(mockLogger);

      // Subagent child tools fire their hooks.
      await hook(
        postToolUseInput("toolu_sub_1", "Bash", { command: "ls" }, "file.txt"),
        "toolu_sub_1",
        { signal: AbortSignal.abort() },
      );
      await hook(
        postToolUseInput("toolu_sub_2", "Glob", { pattern: "*.ts" }, "found.ts"),
        "toolu_sub_2",
        { signal: AbortSignal.abort() },
      );
      await hook(
        postToolUseInput("toolu_sub_3", "Read", { file_path: "/f" }, "data"),
        "toolu_sub_3",
        { signal: AbortSignal.abort() },
      );

      // All three should be stashed (no blocking).
      expect(Object.keys(stashedHookInputs)).toContain("toolu_sub_1");
      expect(Object.keys(stashedHookInputs)).toContain("toolu_sub_2");
      expect(Object.keys(stashedHookInputs)).toContain("toolu_sub_3");

      // Simulate delay — subagent finishes and messages are relayed.
      // (In real life this could be 30+ seconds.)
      // No real delay needed — just flush microtasks after registration.

      // Now registration arrives for all three.
      for (const id of ["toolu_sub_1", "toolu_sub_2", "toolu_sub_3"]) {
        registerHookCallback(id, {
          onPostToolUseHook: async (toolId, input, response) => {
            received.push({ id: toolId, input, response });
          },
        });
      }

      await flushMicrotasks();

      expect(received).toHaveLength(3);
      expect(received.map((r) => r.id).sort()).toEqual([
        "toolu_sub_1",
        "toolu_sub_2",
        "toolu_sub_3",
      ]);
      expect(received.find((r) => r.id === "toolu_sub_1")!.input).toEqual({ command: "ls" });
      expect(received.find((r) => r.id === "toolu_sub_2")!.response).toBe("found.ts");
      expect(received.find((r) => r.id === "toolu_sub_3")!.input).toEqual({ file_path: "/f" });

      // All stashes should be cleaned up.
      expect(stashedHookInputs["toolu_sub_1"]).toBeUndefined();
      expect(stashedHookInputs["toolu_sub_2"]).toBeUndefined();
      expect(stashedHookInputs["toolu_sub_3"]).toBeUndefined();
    });

    it("stale callbacks from earlier turns are not consumed by later hooks for different IDs", async () => {
      // Verifies that a PostToolUse hook for ID X does not accidentally
      // consume a callback registered for ID Y, even though Y's callback
      // sits in the map.
      const callbackCalled: string[] = [];
      const hook = createPostToolUseHook(mockLogger);

      // Register callback for "stale" ID — its hook will never fire.
      registerHookCallback("toolu_stale_iso_1", {
        onPostToolUseHook: async (id) => {
          callbackCalled.push(id);
        },
      });

      // Fire hook for a completely different ID.
      await hook(postToolUseInput("toolu_diff_iso_1", "Bash"), "toolu_diff_iso_1", {
        signal: AbortSignal.abort(),
      });

      await flushMicrotasks();

      // The stale callback should NOT have been invoked.
      expect(callbackCalled).toHaveLength(0);
      // The different ID should be stashed.
      expect(stashedHookInputs["toolu_diff_iso_1"]).toBeDefined();
    });

    it("batch of subagent hooks all stash and resolve correctly when callbacks arrive", async () => {
      // Protocol logs show hooks arriving in batches (e.g., 3 Bash + 2
      // Glob from a single Agent subagent call).
      const received: string[] = [];
      const hook = createPostToolUseHook(mockLogger);

      // Fire 3 hooks in quick succession — none have callbacks yet.
      const resultA = await hook(postToolUseInput("toolu_bat_a", "Bash"), "toolu_bat_a", {
        signal: AbortSignal.abort(),
      });
      const resultB = await hook(postToolUseInput("toolu_bat_b", "Glob"), "toolu_bat_b", {
        signal: AbortSignal.abort(),
      });
      const resultC = await hook(postToolUseInput("toolu_bat_c", "Read"), "toolu_bat_c", {
        signal: AbortSignal.abort(),
      });

      // All return immediately.
      expect(resultA).toEqual({ continue: true });
      expect(resultB).toEqual({ continue: true });
      expect(resultC).toEqual({ continue: true });

      // All stashed.
      expect(Object.keys(stashedHookInputs).sort()).toEqual([
        "toolu_bat_a",
        "toolu_bat_b",
        "toolu_bat_c",
      ]);

      // Register callbacks (simulating subagent message relay).
      for (const id of ["toolu_bat_a", "toolu_bat_b", "toolu_bat_c"]) {
        registerHookCallback(id, {
          onPostToolUseHook: async (toolId) => {
            received.push(toolId);
          },
        });
      }

      await flushMicrotasks();

      expect(received.sort()).toEqual(["toolu_bat_a", "toolu_bat_b", "toolu_bat_c"]);
    });

    it("always returns { continue: true } even in the stash case", async () => {
      const hook = createPostToolUseHook(mockLogger);

      // Fire without registration — should stash and return immediately.
      const result = await hook(postToolUseInput("toolu_cont_1", "Agent"), "toolu_cont_1", {
        signal: AbortSignal.abort(),
      });

      expect(result).toEqual({ continue: true });
    });

    it("callback error in stash path is caught and logged, not thrown", async () => {
      const errors: string[] = [];
      const spyLogger: Logger = {
        log: () => {},
        error: (...args: any[]) => {
          errors.push(args.map(String).join(" "));
        },
      };

      const hook = createPostToolUseHook(spyLogger);

      // Fire hook — stash input.
      await hook(postToolUseInput("toolu_err_1", "Bash", {}, ""), "toolu_err_1", {
        signal: AbortSignal.abort(),
      });

      // Register a callback that throws.
      registerHookCallback(
        "toolu_err_1",
        {
          onPostToolUseHook: async () => {
            throw new Error("callback boom");
          },
        },
        spyLogger,
      );

      await flushMicrotasks();

      // Error should be logged, not thrown.
      expect(
        errors.some((e) => e.includes("stashed hook callback error") && e.includes("toolu_err_1")),
      ).toBe(true);
    });
  });
});
