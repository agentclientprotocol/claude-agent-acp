import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { spawn, spawnSync } from "child_process";
import {
  Agent,
  AgentSideConnection,
  AvailableCommand,
  Client,
  ClientSideConnection,
  ndJsonStream,
  NewSessionResponse,
  ReadTextFileRequest,
  ReadTextFileResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionNotification,
  WriteTextFileRequest,
  WriteTextFileResponse,
} from "@agentclientprotocol/sdk";
import { nodeToWebWritable, nodeToWebReadable } from "../utils.js";
import {
  markdownEscape,
  toolInfoFromToolUse,
  toDisplayPath,
  toolUpdateFromToolResult,
  toolUpdateFromEditToolResponse,
} from "../tools.js";
import { toAcpNotifications, promptToClaude, ClaudeAcpAgent, claudeCliPath } from "../acp-agent.js";
import { Pushable } from "../utils.js";
import { query, SDKAssistantMessage } from "@anthropic-ai/claude-agent-sdk";
import { randomUUID } from "crypto";
import type {
  BetaToolResultBlockParam,
  BetaToolSearchToolResultBlockParam,
  BetaWebSearchToolResultBlockParam,
  BetaWebFetchToolResultBlockParam,
  BetaCodeExecutionToolResultBlockParam,
} from "@anthropic-ai/sdk/resources/beta.mjs";

describe.skipIf(!process.env.RUN_INTEGRATION_TESTS)("ACP subprocess integration", () => {
  let child: ReturnType<typeof spawn>;

  beforeAll(async () => {
    const valid = spawnSync("tsc", { stdio: "inherit" });
    if (valid.status) {
      throw new Error("failed to compile");
    }
    // Start the subprocess
    child = spawn("npm", ["run", "--silent", "dev"], {
      stdio: ["pipe", "pipe", "inherit"],
      env: process.env,
    });
    child.on("error", (error) => {
      console.error("Error starting subprocess:", error);
    });
    child.on("exit", (exit) => {
      console.error("Exited with", exit);
    });
  });

  afterAll(() => {
    child.kill();
  });

  class TestClient implements Client {
    agent: Agent;
    files: Map<string, string> = new Map();
    receivedText: string = "";
    resolveAvailableCommands: (commands: AvailableCommand[]) => void;
    availableCommandsPromise: Promise<AvailableCommand[]>;

    constructor(agent: Agent) {
      this.agent = agent;
      this.resolveAvailableCommands = () => {};
      this.availableCommandsPromise = new Promise((resolve) => {
        this.resolveAvailableCommands = resolve;
      });
    }

    takeReceivedText() {
      const text = this.receivedText;
      this.receivedText = "";
      return text;
    }

    async requestPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
      const optionId = params.options.find((p) => p.kind === "allow_once")!.optionId;

      return { outcome: { outcome: "selected", optionId } };
    }

    async sessionUpdate(params: SessionNotification): Promise<void> {
      console.error("RECEIVED", JSON.stringify(params, null, 4));

      switch (params.update.sessionUpdate) {
        case "agent_message_chunk": {
          if (params.update.content.type === "text") {
            this.receivedText += params.update.content.text;
          }
          break;
        }
        case "available_commands_update":
          this.resolveAvailableCommands(params.update.availableCommands);
          break;
        default:
          break;
      }
    }

    async writeTextFile(params: WriteTextFileRequest): Promise<WriteTextFileResponse> {
      this.files.set(params.path, params.content);
      return {};
    }

    async readTextFile(params: ReadTextFileRequest): Promise<ReadTextFileResponse> {
      const content = this.files.get(params.path) ?? "";
      return {
        content,
      };
    }
  }

  async function setupTestSession(cwd: string): Promise<{
    client: TestClient;
    connection: ClientSideConnection;
    newSessionResponse: NewSessionResponse;
  }> {
    let client;
    const input = nodeToWebWritable(child.stdin!);
    const output = nodeToWebReadable(child.stdout!);
    const stream = ndJsonStream(input, output);
    const connection = new ClientSideConnection((agent) => {
      client = new TestClient(agent);
      return client;
    }, stream);

    await connection.initialize({
      protocolVersion: 1,
      clientCapabilities: {
        fs: {
          readTextFile: true,
          writeTextFile: true,
        },
      },
    });

    const newSessionResponse = await connection.newSession({
      cwd,
      mcpServers: [],
    });

    return { client: client!, connection, newSessionResponse };
  }

  it("should connect to the ACP subprocess", async () => {
    const { client, connection, newSessionResponse } = await setupTestSession("./");

    await connection.prompt({
      prompt: [
        {
          type: "text",
          text: "Hello",
        },
      ],
      sessionId: newSessionResponse.sessionId,
    });

    expect(client.takeReceivedText()).not.toEqual("");
  }, 30000);

  it("should include available commands", async () => {
    const { client, connection, newSessionResponse } = await setupTestSession(__dirname);

    const commands = await client.availableCommandsPromise;

    expect(commands).toContainEqual({
      name: "quick-math",
      description: "10 * 3 = 30 (project)",
      input: null,
    });
    expect(commands).toContainEqual({
      name: "say-hello",
      description: "Say hello (project)",
      input: { hint: "name" },
    });

    await connection.prompt({
      prompt: [
        {
          type: "text",
          text: "/quick-math",
        },
      ],
      sessionId: newSessionResponse.sessionId,
    });

    expect(client.takeReceivedText()).toContain("30");

    await connection.prompt({
      prompt: [
        {
          type: "text",
          text: "/say-hello GPT-5",
        },
      ],
      sessionId: newSessionResponse.sessionId,
    });

    expect(client.takeReceivedText()).toContain("Hello GPT-5");
  }, 30000);

  it("/compact works", async () => {
    const { client, connection, newSessionResponse } = await setupTestSession(__dirname);

    const commands = await client.availableCommandsPromise;

    expect(commands).toContainEqual({
      description: "Free up context by summarizing the conversation so far",
      input: {
        hint: "<optional custom summarization instructions>",
      },
      name: "compact",
    });

    // Send something
    await connection.prompt({
      prompt: [{ type: "text", text: "Hi" }],
      sessionId: newSessionResponse.sessionId,
    });
    // Clear response
    client.takeReceivedText();

    await connection.prompt({
      prompt: [
        {
          type: "text",
          text: "/compact",
        },
      ],
      sessionId: newSessionResponse.sessionId,
    });

    expect(client.takeReceivedText()).toContain("Compacting...\n\nCompacting completed.");
  }, 30000);
});

describe("tool conversions", () => {
  it("should handle Bash nicely", () => {
    const tool_use = {
      type: "tool_use",
      id: "toolu_01VtsS2mxUFwpBJZYd7BmbC9",
      name: "Bash",
      input: {
        command: "rm README.md.rm",
        description: "Delete README.md.rm file",
      },
    };

    expect(toolInfoFromToolUse(tool_use)).toStrictEqual({
      kind: "execute",
      title: "rm README.md.rm",
      content: [
        {
          content: {
            text: "Delete README.md.rm file",
            type: "text",
          },
          type: "content",
        },
      ],
    });
  });

  it("should handle Glob nicely", () => {
    const tool_use = {
      type: "tool_use",
      id: "toolu_01VtsS2mxUFwpBJZYd7BmbC9",
      name: "Glob",
      input: {
        pattern: "*/**.ts",
      },
    };

    expect(toolInfoFromToolUse(tool_use)).toStrictEqual({
      kind: "search",
      title: "Find `*/**.ts`",
      content: [],
      locations: [],
    });
  });

  it("should handle Task tool calls", () => {
    const tool_use = {
      type: "tool_use",
      id: "toolu_01ANYHYDsXcDPKgxhg7us9bj",
      name: "Task",
      input: {
        description: "Handle user's work request",
        prompt:
          'The user has asked me to "Create a Task to do the work!" but hasn\'t specified what specific work they want done. I need to:\n\n1. First understand what work needs to be done by examining the current state of the repository\n2. Look at the git status to see what files have been modified\n3. Check if there are any obvious tasks that need completion based on the current state\n4. If the work isn\'t clear from the context, ask the user to specify what work they want accomplished\n\nThe git status shows: "M src/tests/acp-agent.test.ts" - there\'s a modified test file that might need attention.\n\nPlease examine the repository state and determine what work needs to be done, then either complete it or ask the user for clarification on the specific task they want accomplished.',
        subagent_type: "general-purpose",
      },
    };

    expect(toolInfoFromToolUse(tool_use)).toStrictEqual({
      kind: "think",
      title: "Handle user's work request",
      content: [
        {
          content: {
            text: 'The user has asked me to "Create a Task to do the work!" but hasn\'t specified what specific work they want done. I need to:\n\n1. First understand what work needs to be done by examining the current state of the repository\n2. Look at the git status to see what files have been modified\n3. Check if there are any obvious tasks that need completion based on the current state\n4. If the work isn\'t clear from the context, ask the user to specify what work they want accomplished\n\nThe git status shows: "M src/tests/acp-agent.test.ts" - there\'s a modified test file that might need attention.\n\nPlease examine the repository state and determine what work needs to be done, then either complete it or ask the user for clarification on the specific task they want accomplished.',
            type: "text",
          },
          type: "content",
        },
      ],
    });
  });

  it("should handle Grep tool calls", () => {
    const tool_use = {
      type: "tool_use",
      id: "toolu_016j8oGSD3eAZ9KT62Y7Jsjb",
      name: "Grep",
      input: {
        pattern: ".*",
      },
    };

    expect(toolInfoFromToolUse(tool_use)).toStrictEqual({
      kind: "search",
      title: 'grep ".*"',
      content: [],
    });
  });

  it("should handle Write tool calls", () => {
    const tool_use = {
      type: "tool_use",
      id: "toolu_01ABC123XYZ789",
      name: "Write",
      input: {
        file_path: "/Users/test/project/example.txt",
        content: "Hello, World!\nThis is test content.",
      },
    };

    expect(toolInfoFromToolUse(tool_use)).toStrictEqual({
      kind: "edit",
      title: "Write /Users/test/project/example.txt",
      content: [
        {
          type: "diff",
          path: "/Users/test/project/example.txt",
          oldText: null,
          newText: "Hello, World!\nThis is test content.",
        },
      ],
      locations: [{ path: "/Users/test/project/example.txt" }],
    });
  });

  it("should handle Write tool calls", () => {
    const tool_use = {
      type: "tool_use",
      id: "toolu_01GHI789JKL456",
      name: "Write",
      input: {
        file_path: "/Users/test/project/config.json",
        content: '{"version": "1.0.0"}',
      },
    };

    expect(toolInfoFromToolUse(tool_use)).toStrictEqual({
      kind: "edit",
      title: "Write /Users/test/project/config.json",
      content: [
        {
          type: "diff",
          path: "/Users/test/project/config.json",
          oldText: null,
          newText: '{"version": "1.0.0"}',
        },
      ],
      locations: [{ path: "/Users/test/project/config.json" }],
    });
  });

  it("should handle Edit tool calls", () => {
    const tool_use = {
      type: "tool_use",
      id: "toolu_01EDIT123",
      name: "Edit",
      input: {
        file_path: "/Users/test/project/test.txt",
        old_string: "old text",
        new_string: "new text",
      },
    };

    expect(toolInfoFromToolUse(tool_use)).toStrictEqual({
      kind: "edit",
      title: "Edit /Users/test/project/test.txt",
      content: [
        {
          type: "diff",
          path: "/Users/test/project/test.txt",
          oldText: "old text",
          newText: "new text",
        },
      ],
      locations: [{ path: "/Users/test/project/test.txt" }],
    });
  });

  it("should handle Edit tool calls with replace_all", () => {
    const tool_use = {
      type: "tool_use",
      id: "toolu_01EDIT456",
      name: "Edit",
      input: {
        replace_all: false,
        file_path: "/Users/benbrandt/github/codex-acp/src/thread.rs",
        old_string:
          "struct PromptState {\n    active_command: Option<ActiveCommand>,\n    active_web_search: Option<String>,\n}",
        new_string:
          "struct PromptState {\n    active_commands: HashMap<String, ActiveCommand>,\n    active_web_search: Option<String>,\n}",
      },
    };

    expect(toolInfoFromToolUse(tool_use)).toStrictEqual({
      kind: "edit",
      title: "Edit /Users/benbrandt/github/codex-acp/src/thread.rs",
      content: [
        {
          type: "diff",
          path: "/Users/benbrandt/github/codex-acp/src/thread.rs",
          oldText:
            "struct PromptState {\n    active_command: Option<ActiveCommand>,\n    active_web_search: Option<String>,\n}",
          newText:
            "struct PromptState {\n    active_commands: HashMap<String, ActiveCommand>,\n    active_web_search: Option<String>,\n}",
        },
      ],
      locations: [{ path: "/Users/benbrandt/github/codex-acp/src/thread.rs" }],
    });
  });

  it("should handle Edit tool calls without file_path", () => {
    const tool_use = {
      type: "tool_use",
      id: "toolu_01EDIT789",
      name: "Edit",
      input: {},
    };

    expect(toolInfoFromToolUse(tool_use)).toStrictEqual({
      kind: "edit",
      title: "Edit",
      content: [],
      locations: [],
    });
  });

  it("should handle Read tool calls", () => {
    const tool_use = {
      type: "tool_use",
      id: "toolu_01MNO456PQR789",
      name: "Read",
      input: {
        file_path: "/Users/test/project/readme.md",
      },
    };

    expect(toolInfoFromToolUse(tool_use)).toStrictEqual({
      kind: "read",
      title: "Read /Users/test/project/readme.md",
      content: [],
      locations: [{ path: "/Users/test/project/readme.md", line: 1 }],
    });
  });

  it("should handle Read tool calls", () => {
    const tool_use = {
      type: "tool_use",
      id: "toolu_01YZA789BCD123",
      name: "Read",
      input: {
        file_path: "/Users/test/project/data.json",
      },
    };

    expect(toolInfoFromToolUse(tool_use)).toStrictEqual({
      kind: "read",
      title: "Read /Users/test/project/data.json",
      content: [],
      locations: [{ path: "/Users/test/project/data.json", line: 1 }],
    });
  });

  it("should handle Read with limit", () => {
    const tool_use = {
      type: "tool_use",
      id: "toolu_01EFG456HIJ789",
      name: "Read",
      input: {
        file_path: "/Users/test/project/large.txt",
        limit: 100,
      },
    };

    expect(toolInfoFromToolUse(tool_use)).toStrictEqual({
      kind: "read",
      title: "Read /Users/test/project/large.txt (1 - 100)",
      content: [],
      locations: [{ path: "/Users/test/project/large.txt", line: 1 }],
    });
  });

  it("should handle Read with offset and limit", () => {
    const tool_use = {
      type: "tool_use",
      id: "toolu_01KLM789NOP456",
      name: "Read",
      input: {
        file_path: "/Users/test/project/large.txt",
        offset: 50,
        limit: 100,
      },
    };

    expect(toolInfoFromToolUse(tool_use)).toStrictEqual({
      kind: "read",
      title: "Read /Users/test/project/large.txt (50 - 149)",
      content: [],
      locations: [{ path: "/Users/test/project/large.txt", line: 50 }],
    });
  });

  it("should handle Read with only offset", () => {
    const tool_use = {
      type: "tool_use",
      id: "toolu_01QRS123TUV789",
      name: "Read",
      input: {
        file_path: "/Users/test/project/large.txt",
        offset: 200,
      },
    };

    expect(toolInfoFromToolUse(tool_use)).toStrictEqual({
      kind: "read",
      title: "Read /Users/test/project/large.txt (from line 200)",
      content: [],
      locations: [{ path: "/Users/test/project/large.txt", line: 200 }],
    });
  });

  it("should use relative path in title when cwd is provided", () => {
    const tool_use = {
      type: "tool_use",
      id: "toolu_01READ_CWD",
      name: "Read",
      input: { file_path: "/Users/test/project/src/main.ts" },
    };

    const result = toolInfoFromToolUse(tool_use, false, "/Users/test/project");
    expect(result.title).toBe("Read src/main.ts");
    // locations.path stays absolute for navigation
    expect(result.locations).toStrictEqual([{ path: "/Users/test/project/src/main.ts", line: 1 }]);
  });

  it("should handle plan entries", () => {
    const received: SDKAssistantMessage = {
      type: "assistant",
      message: {
        id: "msg_017eNosJgww7F5qD4a8BcAcx",
        type: "message",
        role: "assistant",
        container: null,
        model: "claude-sonnet-4-20250514",
        content: [
          {
            type: "tool_use",
            id: "toolu_01HaXZ4LfdchSeSR8ygt4zyq",
            name: "TodoWrite",
            input: {
              todos: [
                {
                  content: "Analyze existing test coverage and identify gaps",
                  status: "in_progress",
                  activeForm: "Analyzing existing test coverage",
                },
                {
                  content: "Add comprehensive edge case tests",
                  status: "pending",
                  activeForm: "Adding comprehensive edge case tests",
                },
                {
                  content: "Add performance and timing tests",
                  status: "pending",
                  activeForm: "Adding performance and timing tests",
                },
                {
                  content: "Add error handling and panic behavior tests",
                  status: "pending",
                  activeForm: "Adding error handling tests",
                },
                {
                  content: "Add concurrent access and race condition tests",
                  status: "pending",
                  activeForm: "Adding concurrent access tests",
                },
                {
                  content: "Add tests for Each function with various data types",
                  status: "pending",
                  activeForm: "Adding Each function tests",
                },
                {
                  content: "Add benchmark tests for performance measurement",
                  status: "pending",
                  activeForm: "Adding benchmark tests",
                },
                {
                  content: "Improve test organization and helper functions",
                  status: "pending",
                  activeForm: "Improving test organization",
                },
              ],
            },
          },
        ],
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: 6,
          cache_creation_input_tokens: 326,
          cache_read_input_tokens: 17265,
          cache_creation: {
            ephemeral_5m_input_tokens: 326,
            ephemeral_1h_input_tokens: 0,
          },
          output_tokens: 1,
          service_tier: "standard",
          server_tool_use: null,
          inference_geo: null,
          iterations: null,
          speed: null,
        },
        context_management: null,
      },
      parent_tool_use_id: null,
      session_id: "d056596f-e328-41e9-badd-b07122ae5227",
      uuid: "b7c3330c-de8f-4bba-ac53-68c7f76ffeb5",
    };
    expect(
      toAcpNotifications(
        received.message.content,
        received.message.role,
        "test",
        {},
        {} as AgentSideConnection,
        console,
      ),
    ).toStrictEqual([
      {
        sessionId: "test",
        update: {
          sessionUpdate: "plan",
          entries: [
            {
              content: "Analyze existing test coverage and identify gaps",
              priority: "medium",
              status: "in_progress",
            },
            {
              content: "Add comprehensive edge case tests",
              priority: "medium",
              status: "pending",
            },
            {
              content: "Add performance and timing tests",
              priority: "medium",
              status: "pending",
            },
            {
              content: "Add error handling and panic behavior tests",
              priority: "medium",
              status: "pending",
            },
            {
              content: "Add concurrent access and race condition tests",
              priority: "medium",
              status: "pending",
            },
            {
              content: "Add tests for Each function with various data types",
              priority: "medium",
              status: "pending",
            },
            {
              content: "Add benchmark tests for performance measurement",
              priority: "medium",
              status: "pending",
            },
            {
              content: "Improve test organization and helper functions",
              priority: "medium",
              status: "pending",
            },
          ],
        },
      },
    ]);
  });

  it("should return empty update for successful edit result", () => {
    const toolUse = {
      type: "tool_use",
      id: "toolu_01MNO345",
      name: "Edit",
      input: {
        file_path: "/Users/test/project/test.txt",
        old_string: "old",
        new_string: "new",
      },
    };

    const toolResult = {
      content: [
        {
          type: "text" as const,
          text: "not valid json",
        },
      ],
      tool_use_id: "test",
      is_error: false,
      type: "tool_result" as const,
    };

    const update = toolUpdateFromToolResult(toolResult, toolUse);

    // Should return empty object when parsing fails
    expect(update).toEqual({});
  });

  it("should return content update for edit failure", () => {
    const toolUse = {
      type: "tool_use",
      id: "toolu_01MNO345",
      name: "Edit",
      input: {
        file_path: "/Users/test/project/test.txt",
        old_string: "old",
        new_string: "new",
      },
    };

    const toolResult = {
      content: [
        {
          type: "text" as const,
          text: "Failed to find `old_string`",
        },
      ],
      tool_use_id: "test",
      is_error: true,
      type: "tool_result" as const,
    };

    const update = toolUpdateFromToolResult(toolResult, toolUse);

    // Should return empty object when parsing fails
    expect(update).toEqual({
      content: [
        {
          content: { type: "text", text: "```\nFailed to find `old_string`\n```" },
          type: "content",
        },
      ],
    });
  });

  it("should transform tool_reference content to valid ACP content", () => {
    const toolUse = {
      type: "tool_use",
      id: "toolu_01MNO345",
      name: "ToolSearch",
      input: { query: "test" },
    };

    const toolResult: BetaToolResultBlockParam = {
      content: [
        {
          type: "tool_reference",
          tool_name: "some_discovered_tool",
        },
      ],
      tool_use_id: "toolu_01MNO345",
      is_error: false,
      type: "tool_result",
    };

    const update = toolUpdateFromToolResult(toolResult, toolUse);

    expect(update).toEqual({
      content: [
        {
          type: "content",
          content: { type: "text", text: "Tool: some_discovered_tool" },
        },
      ],
    });
  });

  it("should transform web_search_result content to valid ACP content", () => {
    const toolUse = {
      type: "tool_use",
      id: "toolu_01MNO345",
      name: "WebSearch",
      input: { query: "test" },
    };

    const toolResult: BetaWebSearchToolResultBlockParam = {
      content: [
        {
          type: "web_search_result",
          title: "Test Result",
          url: "https://example.com",
          encrypted_content: "...",
          page_age: null,
        },
      ],
      tool_use_id: "toolu_01MNO345",
      type: "web_search_tool_result",
    };

    const update = toolUpdateFromToolResult(toolResult, toolUse);

    expect(update).toEqual({
      content: [
        {
          type: "content",
          content: { type: "text", text: "Test Result (https://example.com)" },
        },
      ],
    });
  });

  it("should transform web_search_tool_result_error to valid ACP content", () => {
    const toolUse = {
      type: "tool_use",
      id: "toolu_01MNO345",
      name: "WebSearch",
      input: { query: "test" },
    };

    const toolResult: BetaWebSearchToolResultBlockParam = {
      content: {
        type: "web_search_tool_result_error",
        error_code: "unavailable",
      },
      tool_use_id: "toolu_01MNO345",
      type: "web_search_tool_result",
    };

    const update = toolUpdateFromToolResult(toolResult, toolUse);

    expect(update).toEqual({
      content: [
        {
          type: "content",
          content: { type: "text", text: "Error: unavailable" },
        },
      ],
    });
  });

  it("should transform code_execution_result content to valid ACP content", () => {
    const toolUse = {
      type: "tool_use",
      id: "toolu_01MNO345",
      name: "CodeExecution",
      input: {},
    };

    const toolResult: BetaCodeExecutionToolResultBlockParam = {
      content: {
        type: "code_execution_result",
        stdout: "Hello World",
        stderr: "",
        return_code: 0,
        content: [],
      },
      tool_use_id: "toolu_01MNO345",
      type: "code_execution_tool_result",
    };

    const update = toolUpdateFromToolResult(toolResult, toolUse);

    expect(update).toEqual({
      content: [
        {
          type: "content",
          content: { type: "text", text: "Output: Hello World" },
        },
      ],
    });
  });

  it("should transform web_fetch_result content to valid ACP content", () => {
    const toolUse = {
      type: "tool_use",
      id: "toolu_01MNO345",
      name: "WebFetch",
      input: { url: "https://example.com" },
    };

    const toolResult: BetaWebFetchToolResultBlockParam = {
      content: {
        type: "web_fetch_result",
        url: "https://example.com",
        content: {
          type: "document",
          citations: null,
          title: null,
          source: { type: "text", media_type: "text/plain", data: "Page content here" },
        },
      },
      tool_use_id: "toolu_01MNO345",
      type: "web_fetch_tool_result",
    };

    const update = toolUpdateFromToolResult(toolResult, toolUse);

    expect(update).toEqual({
      content: [
        {
          type: "content",
          content: { type: "text", text: "Fetched: https://example.com" },
        },
      ],
    });
  });

  it("should transform tool_search_tool_search_result to valid ACP content", () => {
    const toolUse = {
      type: "tool_use",
      id: "toolu_01MNO345",
      name: "ToolSearch",
      input: { query: "test" },
    };

    const toolResult: BetaToolSearchToolResultBlockParam = {
      content: {
        type: "tool_search_tool_search_result",
        tool_references: [
          { type: "tool_reference", tool_name: "tool_a" },
          { type: "tool_reference", tool_name: "tool_b" },
        ],
      },
      tool_use_id: "toolu_01MNO345",
      type: "tool_search_tool_result",
    };

    const update = toolUpdateFromToolResult(toolResult, toolUse);

    expect(update).toEqual({
      content: [
        {
          type: "content",
          content: { type: "text", text: "Tools found: tool_a, tool_b" },
        },
      ],
    });
  });
});

describe("toDisplayPath", () => {
  it("should relativize paths inside cwd and keep absolute paths outside", () => {
    expect(toDisplayPath("/Users/test/project/src/main.ts", "/Users/test/project")).toBe(
      "src/main.ts",
    );
    expect(toDisplayPath("/etc/hosts", "/Users/test/project")).toBe("/etc/hosts");
    expect(toDisplayPath("/Users/test/project/src/main.ts")).toBe(
      "/Users/test/project/src/main.ts",
    );
    // Partial directory name match should not be treated as inside cwd
    expect(toDisplayPath("/Users/test/project-other/file.ts", "/Users/test/project")).toBe(
      "/Users/test/project-other/file.ts",
    );
  });
});

describe("toolUpdateFromEditToolResponse", () => {
  it("should return empty for non-object input", () => {
    expect(toolUpdateFromEditToolResponse(null)).toEqual({});
    expect(toolUpdateFromEditToolResponse(undefined)).toEqual({});
    expect(toolUpdateFromEditToolResponse("string")).toEqual({});
  });

  it("should return empty when filePath or structuredPatch is missing", () => {
    expect(toolUpdateFromEditToolResponse({})).toEqual({});
    expect(toolUpdateFromEditToolResponse({ filePath: "/foo.ts" })).toEqual({});
    expect(toolUpdateFromEditToolResponse({ structuredPatch: [] })).toEqual({});
  });

  it("should build diff content from a single-hunk structuredPatch", () => {
    const toolResponse = {
      filePath: "/Users/test/project/test.txt",
      structuredPatch: [
        {
          oldStart: 1,
          oldLines: 3,
          newStart: 1,
          newLines: 3,
          lines: [" context before", "-old line", "+new line", " context after"],
        },
      ],
    };

    expect(toolUpdateFromEditToolResponse(toolResponse)).toEqual({
      content: [
        {
          type: "diff",
          path: "/Users/test/project/test.txt",
          oldText: "context before\nold line\ncontext after",
          newText: "context before\nnew line\ncontext after",
        },
      ],
      locations: [{ path: "/Users/test/project/test.txt", line: 1 }],
    });
  });

  it("should build multiple diff content blocks for replaceAll with multiple hunks", () => {
    const toolResponse = {
      filePath: "/Users/test/project/file.ts",
      structuredPatch: [
        {
          oldStart: 5,
          oldLines: 1,
          newStart: 5,
          newLines: 1,
          lines: ["-oldValue", "+newValue"],
        },
        {
          oldStart: 20,
          oldLines: 1,
          newStart: 20,
          newLines: 1,
          lines: ["-oldValue", "+newValue"],
        },
      ],
    };

    expect(toolUpdateFromEditToolResponse(toolResponse)).toEqual({
      content: [
        {
          type: "diff",
          path: "/Users/test/project/file.ts",
          oldText: "oldValue",
          newText: "newValue",
        },
        {
          type: "diff",
          path: "/Users/test/project/file.ts",
          oldText: "oldValue",
          newText: "newValue",
        },
      ],
      locations: [
        { path: "/Users/test/project/file.ts", line: 5 },
        { path: "/Users/test/project/file.ts", line: 20 },
      ],
    });
  });

  it("should handle deletion (newText becomes empty string)", () => {
    const toolResponse = {
      filePath: "/Users/test/project/file.ts",
      structuredPatch: [
        {
          oldStart: 10,
          oldLines: 2,
          newStart: 10,
          newLines: 1,
          lines: [" context", "-removed line"],
        },
      ],
    };

    expect(toolUpdateFromEditToolResponse(toolResponse)).toEqual({
      content: [
        {
          type: "diff",
          path: "/Users/test/project/file.ts",
          oldText: "context\nremoved line",
          newText: "context",
        },
      ],
      locations: [{ path: "/Users/test/project/file.ts", line: 10 }],
    });
  });

  it("should return empty for empty structuredPatch array", () => {
    const toolResponse = {
      filePath: "/Users/test/project/file.ts",
      structuredPatch: [],
    };

    expect(toolUpdateFromEditToolResponse(toolResponse)).toEqual({});
  });
});

describe("escape markdown", () => {
  it("should escape markdown characters", () => {
    let text = "Hello *world*!";
    let escaped = markdownEscape(text);
    expect(escaped).toEqual("```\nHello *world*!\n```");

    text = "for example:\n```markdown\nHello *world*!\n```\n";
    escaped = markdownEscape(text);
    expect(escaped).toEqual("````\nfor example:\n```markdown\nHello *world*!\n```\n````");
  });
});

describe("prompt conversion", () => {
  it("should not change built-in slash commands", () => {
    const message = promptToClaude({
      sessionId: "test",
      prompt: [
        {
          type: "text",
          text: "/compact args",
        },
      ],
    });
    expect(message.message.content).toEqual([
      {
        text: "/compact args",
        type: "text",
      },
    ]);
  });

  it("should remove MCP prefix from MCP slash commands", () => {
    const message = promptToClaude({
      sessionId: "test",
      prompt: [
        {
          type: "text",
          text: "/mcp:server:name args",
        },
      ],
    });
    expect(message.message.content).toEqual([
      {
        text: "/server:name (MCP) args",
        type: "text",
      },
    ]);
  });
});

describe.skipIf(!process.env.RUN_INTEGRATION_TESTS)("SDK behavior", () => {
  it("finds vendored cli path", async () => {
    const path = await claudeCliPath();
    expect(path).toMatch(/@anthropic-ai\/claude-agent-sdk-[^/]+\/claude(\.exe)?$/);
  });

  it("query has a 'default' model", async () => {
    const q = query({ prompt: "hi" });
    const models = await q.supportedModels();
    const defaultModel = models.find((m) => m.value === "default");
    expect(defaultModel).toBeDefined();
  }, 10000);

  it("custom session id", async () => {
    const sessionId = randomUUID();
    const q = query({
      prompt: "hi",
      options: {
        systemPrompt: { type: "preset", preset: "claude_code" },
        sessionId,
        settingSources: ["user", "project", "local"],
        includePartialMessages: true,
      },
    });

    const { value } = await q.next();
    expect(value).toMatchObject({ type: "system", session_id: sessionId });
  }, 10000);
});

describe("permission requests", () => {
  it("should include title field in tool permission request structure", () => {
    // Test various tool types to ensure title is correctly generated
    const testCases = [
      {
        toolUse: {
          type: "tool_use" as const,
          id: "test-1",
          name: "Write",
          input: { file_path: "/test/file.txt", content: "test" },
        },
        expectedTitlePart: "/test/file.txt",
      },
      {
        toolUse: {
          type: "tool_use" as const,
          id: "test-2",
          name: "Bash",
          input: { command: "ls -la", description: "List files" },
        },
        expectedTitlePart: "ls -la",
      },
      {
        toolUse: {
          type: "tool_use" as const,
          id: "test-3",
          name: "Read",
          input: { file_path: "/test/data.json" },
        },
        expectedTitlePart: "/test/data.json",
      },
    ];

    for (const testCase of testCases) {
      // Get the tool info that would be used in requestPermission
      const toolInfo = toolInfoFromToolUse(testCase.toolUse);

      // Verify toolInfo has a title
      expect(toolInfo.title).toBeDefined();
      expect(toolInfo.title).toContain(testCase.expectedTitlePart);

      // Verify the structure that our fix creates for requestPermission
      // We now spread the full toolInfo (title, kind, content, locations)
      const requestStructure = {
        toolCall: {
          toolCallId: testCase.toolUse.id,
          rawInput: testCase.toolUse.input,
          ...toolInfo,
        },
      };

      // Ensure the title field is present and populated
      expect(requestStructure.toolCall.title).toBeDefined();
      expect(requestStructure.toolCall.title).toContain(testCase.expectedTitlePart);

      // Ensure kind is included so the client can render appropriate UI
      expect(requestStructure.toolCall.kind).toBeDefined();
      expect(typeof requestStructure.toolCall.kind).toBe("string");

      // Ensure content is included so the client always has tool call details
      expect(requestStructure.toolCall.content).toBeDefined();
      expect(Array.isArray(requestStructure.toolCall.content)).toBe(true);
    }
  });
});

describe("stop reason propagation", () => {
  function createMockAgent() {
    const mockClient = {
      sessionUpdate: async () => {},
    } as unknown as AgentSideConnection;
    return new ClaudeAcpAgent(mockClient, { log: () => {}, error: () => {} });
  }

  function createResultMessage(overrides: {
    subtype: "success" | "error_during_execution";
    stop_reason: string | null;
    is_error: boolean;
    result?: string;
    errors?: string[];
  }) {
    return {
      type: "result" as const,
      subtype: overrides.subtype,
      stop_reason: overrides.stop_reason,
      is_error: overrides.is_error,
      result: overrides.result ?? "",
      errors: overrides.errors ?? [],
      duration_ms: 0,
      duration_api_ms: 0,
      num_turns: 1,
      total_cost_usd: 0,
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
      modelUsage: {},
      permission_denials: [],
      uuid: randomUUID(),
      session_id: "test-session",
    };
  }

  function injectSession(agent: ClaudeAcpAgent, messages: any[]) {
    const input = new Pushable<any>();
    async function* messageGenerator() {
      // Wait for the prompt to push its user message so we can replay it
      const iter = input[Symbol.asyncIterator]();
      const { value: userMessage, done } = await iter.next();
      if (!done && userMessage) {
        yield {
          type: "user",
          message: userMessage.message,
          parent_tool_use_id: null,
          uuid: userMessage.uuid,
          session_id: "test-session",
          isReplay: true,
        };
      }
      yield* messages;
    }
    agent.sessions["test-session"] = {
      query: messageGenerator() as any,
      input,
      cancelled: false,
      cwd: "/test",
      sessionFingerprint: JSON.stringify({ cwd: "/test", mcpServers: [] }),
      modes: {
        currentModeId: "default",
        availableModes: [],
      },
      models: {
        currentModelId: "default",
        availableModels: [],
      },
      modelInfos: [],
      settingsManager: { dispose: vi.fn() } as any,
      accumulatedUsage: {
        inputTokens: 0,
        outputTokens: 0,
        cachedReadTokens: 0,
        cachedWriteTokens: 0,
      },
      configOptions: [],
      promptRunning: false,
      pendingMessages: new Map(),
      nextPendingOrder: 0,
      abortController: new AbortController(),
      emitRawSDKMessages: false,
      contextWindowSize: 200000,
    };
  }

  it("should return max_tokens when success result has stop_reason max_tokens", async () => {
    const agent = createMockAgent();
    injectSession(agent, [
      createResultMessage({ subtype: "success", stop_reason: "max_tokens", is_error: false }),
      { type: "system", subtype: "session_state_changed", state: "idle" },
    ]);

    const response = await agent.prompt({
      sessionId: "test-session",
      prompt: [{ type: "text", text: "test" }],
    });

    expect(response.stopReason).toBe("max_tokens");
  });

  it("should return max_tokens when success result has stop_reason max_tokens and is_error true", async () => {
    const agent = createMockAgent();
    injectSession(agent, [
      createResultMessage({
        subtype: "success",
        stop_reason: "max_tokens",
        is_error: true,
        result: "Token limit reached",
      }),
      { type: "system", subtype: "session_state_changed", state: "idle" },
    ]);

    const response = await agent.prompt({
      sessionId: "test-session",
      prompt: [{ type: "text", text: "test" }],
    });

    expect(response.stopReason).toBe("max_tokens");
  });

  it("should return max_tokens when error_during_execution has stop_reason max_tokens", async () => {
    const agent = createMockAgent();
    injectSession(agent, [
      createResultMessage({
        subtype: "error_during_execution",
        stop_reason: "max_tokens",
        is_error: true,
        errors: ["some error"],
      }),
      { type: "system", subtype: "session_state_changed", state: "idle" },
    ]);

    const response = await agent.prompt({
      sessionId: "test-session",
      prompt: [{ type: "text", text: "test" }],
    });

    expect(response.stopReason).toBe("max_tokens");
  });

  it("should return end_turn for success with null stop_reason", async () => {
    const agent = createMockAgent();
    injectSession(agent, [
      createResultMessage({ subtype: "success", stop_reason: null, is_error: false }),
      { type: "system", subtype: "session_state_changed", state: "idle" },
    ]);

    const response = await agent.prompt({
      sessionId: "test-session",
      prompt: [{ type: "text", text: "test" }],
    });

    expect(response.stopReason).toBe("end_turn");
  });

  it("should consume background task results and return the prompt's own result", async () => {
    const agent = createMockAgent();
    const input = new Pushable<any>();

    const backgroundTaskResult = createResultMessage({
      subtype: "success",
      stop_reason: null,
      is_error: false,
    });
    // Background task used some tokens
    backgroundTaskResult.usage.input_tokens = 100;
    backgroundTaskResult.usage.output_tokens = 50;

    const promptResult = createResultMessage({
      subtype: "success",
      stop_reason: null,
      is_error: false,
    });

    async function* messageGenerator() {
      // Background task init + result arrive before our prompt's replay
      yield { type: "system", subtype: "init", session_id: "test-session" };
      yield backgroundTaskResult;

      // Now the prompt's user message replay arrives
      const iter = input[Symbol.asyncIterator]();
      const { value: userMessage } = await iter.next();
      yield {
        type: "user",
        message: userMessage.message,
        parent_tool_use_id: null,
        uuid: userMessage.uuid,
        session_id: "test-session",
        isReplay: true,
      };

      // Then the prompt's own result
      yield promptResult;
      yield { type: "system", subtype: "session_state_changed", state: "idle" };
    }

    agent.sessions["test-session"] = {
      query: messageGenerator() as any,
      input,
      cwd: "/tmp/test",
      sessionFingerprint: JSON.stringify({ cwd: "/tmp/test", mcpServers: [] }),
      cancelled: false,
      modes: {
        currentModeId: "default",
        availableModes: [],
      },
      models: {
        currentModelId: "default",
        availableModels: [],
      },
      modelInfos: [],
      settingsManager: { dispose: vi.fn() } as any,
      accumulatedUsage: {
        inputTokens: 0,
        outputTokens: 0,
        cachedReadTokens: 0,
        cachedWriteTokens: 0,
      },
      abortController: new AbortController(),
      configOptions: [],
      promptRunning: false,
      pendingMessages: new Map(),
      nextPendingOrder: 0,
      emitRawSDKMessages: false,
      contextWindowSize: 200000,
    };

    const response = await agent.prompt({
      sessionId: "test-session",
      prompt: [{ type: "text", text: "test" }],
    });

    expect(response.stopReason).toBe("end_turn");
    // Usage should include both background task and prompt result tokens
    expect(response.usage?.inputTokens).toBe(
      backgroundTaskResult.usage.input_tokens + promptResult.usage.input_tokens,
    );
    expect(response.usage?.outputTokens).toBe(
      backgroundTaskResult.usage.output_tokens + promptResult.usage.output_tokens,
    );
  });

  it("should throw internal error for success with is_error true and no max_tokens", async () => {
    const agent = createMockAgent();
    injectSession(agent, [
      createResultMessage({
        subtype: "success",
        stop_reason: "end_turn",
        is_error: true,
        result: "Something went wrong",
      }),
    ]);

    await expect(
      agent.prompt({
        sessionId: "test-session",
        prompt: [{ type: "text", text: "test" }],
      }),
    ).rejects.toThrow("Internal error");
  });
});

describe("session/close", () => {
  function createMockAgent() {
    const mockClient = {
      sessionUpdate: async () => {},
    } as unknown as AgentSideConnection;
    return new ClaudeAcpAgent(mockClient, { log: () => {}, error: () => {} });
  }

  function injectSession(agent: ClaudeAcpAgent, sessionId: string) {
    function* empty() {}
    const gen = Object.assign(empty(), { interrupt: vi.fn(), close: vi.fn() });
    agent.sessions[sessionId] = {
      query: gen as any,
      input: new Pushable(),
      cancelled: false,
      cwd: "/test",
      sessionFingerprint: JSON.stringify({ cwd: "/test", mcpServers: [] }),
      modes: {
        currentModeId: "default",
        availableModes: [],
      },
      models: {
        currentModelId: "default",
        availableModels: [],
      },
      modelInfos: [],
      settingsManager: { dispose: vi.fn() } as any,
      accumulatedUsage: {
        inputTokens: 0,
        outputTokens: 0,
        cachedReadTokens: 0,
        cachedWriteTokens: 0,
      },
      configOptions: [],
      promptRunning: false,
      pendingMessages: new Map(),
      nextPendingOrder: 0,
      abortController: new AbortController(),
      emitRawSDKMessages: false,
      contextWindowSize: 200000,
    };
    return agent.sessions[sessionId]!;
  }

  it("should close an existing session and remove it", async () => {
    const agent = createMockAgent();
    const session = injectSession(agent, "session-1");

    expect(agent.sessions["session-1"]).toBeDefined();

    const result = await agent.closeSession({ sessionId: "session-1" });

    expect(result).toEqual({});
    expect(agent.sessions["session-1"]).toBeUndefined();
    expect(session.query.interrupt).toHaveBeenCalled();
    expect(session.settingsManager.dispose).toHaveBeenCalled();
  });

  it("should abort the session's abort controller", async () => {
    const agent = createMockAgent();
    const session = injectSession(agent, "session-2");

    expect(session.abortController.signal.aborted).toBe(false);

    await agent.closeSession({ sessionId: "session-2" });

    expect(session.abortController.signal.aborted).toBe(true);
  });

  it("should throw when closing a non-existent session", async () => {
    const agent = createMockAgent();

    await expect(agent.closeSession({ sessionId: "non-existent" })).rejects.toThrow(
      "Session not found",
    );
  });

  it("should not affect other sessions when closing one", async () => {
    const agent = createMockAgent();
    injectSession(agent, "session-a");
    injectSession(agent, "session-b");

    await agent.closeSession({ sessionId: "session-a" });

    expect(agent.sessions["session-a"]).toBeUndefined();
    expect(agent.sessions["session-b"]).toBeDefined();
  });
});

describe("getOrCreateSession param change detection", () => {
  function createMockAgent() {
    const mockClient = {
      sessionUpdate: async () => {},
    } as unknown as AgentSideConnection;
    return new ClaudeAcpAgent(mockClient, { log: () => {}, error: () => {} });
  }

  function injectSession(
    agent: ClaudeAcpAgent,
    sessionId: string,
    opts: { cwd?: string; mcpServers?: { name: string }[] } = {},
  ) {
    const cwd = opts.cwd ?? "/test";
    const mcpServers = (opts.mcpServers ?? []) as any[];
    function* empty() {}
    const gen = Object.assign(empty(), {
      interrupt: vi.fn(),
      close: vi.fn(),
      supportedCommands: vi.fn().mockResolvedValue([]),
    });
    agent.sessions[sessionId] = {
      query: gen as any,
      input: new Pushable(),
      cancelled: false,
      cwd,
      sessionFingerprint: JSON.stringify({
        cwd,
        mcpServers: [...mcpServers].sort((a: any, b: any) => a.name.localeCompare(b.name)),
      }),
      modes: { currentModeId: "default", availableModes: [] },
      models: { currentModelId: "default", availableModels: [] },
      modelInfos: [],
      settingsManager: { dispose: vi.fn() } as any,
      accumulatedUsage: {
        inputTokens: 0,
        outputTokens: 0,
        cachedReadTokens: 0,
        cachedWriteTokens: 0,
      },
      configOptions: [],
      promptRunning: false,
      pendingMessages: new Map(),
      nextPendingOrder: 0,
      abortController: new AbortController(),
      emitRawSDKMessages: false,
      contextWindowSize: 200000,
    };
    return agent.sessions[sessionId]!;
  }

  it("returns cached session when params are unchanged", async () => {
    const agent = createMockAgent();
    const session = injectSession(agent, "s1", { cwd: "/project" });

    await agent.resumeSession({
      sessionId: "s1",
      cwd: "/project",
      mcpServers: [],
    });

    // Session object should be the exact same reference (not recreated)
    expect(agent.sessions["s1"]).toBe(session);
    expect(session.settingsManager.dispose).not.toHaveBeenCalled();
  });

  it("tears down existing session when cwd changes", async () => {
    const agent = createMockAgent();
    const session = injectSession(agent, "s1", { cwd: "/old" });

    // Mock createSession to avoid spawning a real process.
    // It will throw, but we can catch that — we only need to verify
    // the old session was torn down before createSession was attempted.
    const createSessionSpy = vi
      .spyOn(agent as any, "createSession")
      .mockRejectedValue(new Error("mock"));

    await expect(
      agent.resumeSession({ sessionId: "s1", cwd: "/new", mcpServers: [] }),
    ).rejects.toThrow("mock");

    // Old session should have been fully torn down
    expect(session.settingsManager.dispose).toHaveBeenCalled();
    expect(session.abortController.signal.aborted).toBe(true);
    expect(session.query.interrupt).toHaveBeenCalled();
    expect(agent.sessions["s1"]).toBeUndefined();

    // createSession should have been called with the new cwd
    expect(createSessionSpy).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: "/new" }),
      expect.objectContaining({ resume: "s1" }),
    );
  });

  it("tears down existing session when mcpServers change", async () => {
    const agent = createMockAgent();
    const session = injectSession(agent, "s1", { cwd: "/project" });

    const createSessionSpy = vi
      .spyOn(agent as any, "createSession")
      .mockRejectedValue(new Error("mock"));

    await expect(
      agent.resumeSession({
        sessionId: "s1",
        cwd: "/project",
        mcpServers: [{ name: "new-server", command: "node", args: ["server.js"], env: [] }],
      }),
    ).rejects.toThrow("mock");

    expect(session.settingsManager.dispose).toHaveBeenCalled();
    expect(session.abortController.signal.aborted).toBe(true);
    expect(agent.sessions["s1"]).toBeUndefined();
    expect(createSessionSpy).toHaveBeenCalled();
  });

  it("treats mcpServers in different order as unchanged", async () => {
    const agent = createMockAgent();
    const servers = [
      { name: "b-server", command: "node", args: ["b.js"], env: [] },
      { name: "a-server", command: "node", args: ["a.js"], env: [] },
    ] as const;
    const session = injectSession(agent, "s1", {
      cwd: "/project",
      mcpServers: servers as any,
    });

    // Same servers but reversed order — should NOT trigger teardown
    await agent.resumeSession({
      sessionId: "s1",
      cwd: "/project",
      mcpServers: [...servers].reverse() as any,
    });

    expect(agent.sessions["s1"]).toBe(session);
    expect(session.settingsManager.dispose).not.toHaveBeenCalled();
  });
});

describe("usage_update computation", () => {
  function createAssistantMessage(overrides: {
    model: string;
    usage?: {
      input_tokens: number;
      output_tokens: number;
      cache_read_input_tokens: number;
      cache_creation_input_tokens: number;
    };
  }) {
    return {
      type: "assistant" as const,
      parent_tool_use_id: null,
      uuid: randomUUID(),
      session_id: "test-session",
      message: {
        model: overrides.model,
        content: [{ type: "text", text: "hello" }],
        usage: overrides.usage ?? {
          input_tokens: 100,
          output_tokens: 50,
          cache_read_input_tokens: 20,
          cache_creation_input_tokens: 10,
        },
      },
    };
  }

  function createResultMessageWithModel(overrides: {
    modelUsage: Record<
      string,
      {
        inputTokens: number;
        outputTokens: number;
        cacheReadInputTokens: number;
        cacheCreationInputTokens: number;
        webSearchRequests: number;
        costUSD: number;
        contextWindow: number;
        maxOutputTokens: number;
      }
    >;
  }) {
    return {
      type: "result" as const,
      subtype: "success" as const,
      stop_reason: "end_turn",
      is_error: false,
      result: "",
      errors: [],
      duration_ms: 0,
      duration_api_ms: 0,
      num_turns: 1,
      total_cost_usd: 0.01,
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
      modelUsage: overrides.modelUsage,
      permission_denials: [],
      uuid: randomUUID(),
      session_id: "test-session",
    };
  }

  function createStreamEvent(
    eventType: "message_start" | "message_delta",
    payload: Record<string, unknown>,
    parentToolUseId: string | null = null,
  ) {
    return {
      type: "stream_event" as const,
      parent_tool_use_id: parentToolUseId,
      uuid: randomUUID(),
      session_id: "test-session",
      event:
        eventType === "message_start"
          ? { type: "message_start" as const, message: payload }
          : { type: "message_delta" as const, ...payload },
    };
  }

  function createMockAgentWithCapture() {
    const updates: any[] = [];
    const mockClient = {
      sessionUpdate: async (notification: any) => {
        updates.push(notification);
      },
    } as unknown as AgentSideConnection;
    const agent = new ClaudeAcpAgent(mockClient, { log: () => {}, error: () => {} });
    return { agent, updates };
  }

  function injectSession(agent: ClaudeAcpAgent, messages: any[]) {
    const input = new Pushable<any>();
    async function* messageGenerator() {
      // Wait for the prompt to push its user message so we can replay it
      const iter = input[Symbol.asyncIterator]();
      const { value: userMessage, done } = await iter.next();
      if (!done && userMessage) {
        yield {
          type: "user",
          message: userMessage.message,
          parent_tool_use_id: null,
          uuid: userMessage.uuid,
          session_id: "test-session",
          isReplay: true,
        };
      }
      yield* messages;
    }
    agent.sessions["test-session"] = {
      query: messageGenerator() as any,
      input,
      cancelled: false,
      cwd: "/test",
      sessionFingerprint: JSON.stringify({ cwd: "/test", mcpServers: [] }),
      modes: {
        currentModeId: "default",
        availableModes: [],
      },
      models: {
        currentModelId: "default",
        availableModels: [],
      },
      modelInfos: [],
      settingsManager: {} as any,
      accumulatedUsage: {
        inputTokens: 0,
        outputTokens: 0,
        cachedReadTokens: 0,
        cachedWriteTokens: 0,
      },
      configOptions: [],
      promptRunning: false,
      pendingMessages: new Map(),
      nextPendingOrder: 0,
      abortController: new AbortController(),
      emitRawSDKMessages: false,
      contextWindowSize: 200000,
    };
  }

  it("used sums all token types as post-turn context occupancy proxy", async () => {
    const { agent, updates } = createMockAgentWithCapture();
    injectSession(agent, [
      createAssistantMessage({
        model: "claude-opus-4-20250514",
        usage: {
          input_tokens: 1000,
          output_tokens: 500,
          cache_read_input_tokens: 200,
          cache_creation_input_tokens: 100,
        },
      }),
      createResultMessageWithModel({
        modelUsage: {
          "claude-opus-4-20250514": {
            inputTokens: 1000,
            outputTokens: 500,
            cacheReadInputTokens: 200,
            cacheCreationInputTokens: 100,
            webSearchRequests: 0,
            costUSD: 0.01,
            contextWindow: 1000000,
            maxOutputTokens: 16384,
          },
        },
      }),
      { type: "system", subtype: "session_state_changed", state: "idle" },
    ]);

    await agent.prompt({ sessionId: "test-session", prompt: [{ type: "text", text: "test" }] });

    const usageUpdate = updates.find((u: any) => u.update?.sessionUpdate === "usage_update");
    expect(usageUpdate).toBeDefined();
    // used = input(1000) + output(500) + cache_read(200) + cache_creation(100) = 1800
    expect(usageUpdate.update.used).toBe(1800);
  });

  it("coerces null input/output tokens so wire `used` is never null", async () => {
    // Synthetic or third-party-backend stream events have been observed
    // emitting input_tokens/output_tokens as null. Without coercion the
    // snapshot leaks NaN into totalTokens(), and JSON.stringify(NaN) === "null"
    // produces a malformed `used: null` that schema-validating ACP clients reject.
    const { agent, updates } = createMockAgentWithCapture();
    injectSession(agent, [
      createAssistantMessage({
        model: "claude-opus-4-20250514",
        usage: {
          input_tokens: null,
          output_tokens: null,
          cache_read_input_tokens: 200,
          cache_creation_input_tokens: 100,
        } as unknown as {
          input_tokens: number;
          output_tokens: number;
          cache_read_input_tokens: number;
          cache_creation_input_tokens: number;
        },
      }),
      createResultMessageWithModel({
        modelUsage: {
          "claude-opus-4-20250514": {
            inputTokens: 0,
            outputTokens: 0,
            cacheReadInputTokens: 200,
            cacheCreationInputTokens: 100,
            webSearchRequests: 0,
            costUSD: 0.01,
            contextWindow: 1000000,
            maxOutputTokens: 16384,
          },
        },
      }),
      { type: "system", subtype: "session_state_changed", state: "idle" },
    ]);

    await agent.prompt({ sessionId: "test-session", prompt: [{ type: "text", text: "test" }] });

    const usageUpdates = updates.filter((u: any) => u.update?.sessionUpdate === "usage_update");
    expect(usageUpdates.length).toBeGreaterThan(0);
    for (const u of usageUpdates) {
      expect(u.update.used).not.toBeNull();
      expect(Number.isFinite(u.update.used)).toBe(true);
      // Round-trip through JSON to catch the NaN -> "null" serialization bug.
      const wire = JSON.parse(JSON.stringify(u.update));
      expect(wire.used).not.toBeNull();
      expect(typeof wire.used).toBe("number");
    }
  });

  it("stream_event message_start emits usage_update before result", async () => {
    const { agent, updates } = createMockAgentWithCapture();
    injectSession(agent, [
      createStreamEvent("message_start", {
        model: "claude-opus-4-20250514",
        usage: {
          input_tokens: 1000,
          output_tokens: 500,
          cache_read_input_tokens: 200,
          cache_creation_input_tokens: 100,
        },
      }),
      createResultMessageWithModel({
        modelUsage: {
          "claude-opus-4-20250514": {
            inputTokens: 1000,
            outputTokens: 500,
            cacheReadInputTokens: 200,
            cacheCreationInputTokens: 100,
            webSearchRequests: 0,
            costUSD: 0.01,
            contextWindow: 1000000,
            maxOutputTokens: 16384,
          },
        },
      }),
      { type: "system", subtype: "session_state_changed", state: "idle" },
    ]);

    await agent.prompt({ sessionId: "test-session", prompt: [{ type: "text", text: "test" }] });

    const usageUpdates = updates.filter((u: any) => u.update?.sessionUpdate === "usage_update");
    expect(usageUpdates).toHaveLength(2);
    expect(usageUpdates[0].update.used).toBe(1800);
    // First prompt of a session has no prior result to learn the window from,
    // so the mid-stream update falls back to the default context window.
    expect(usageUpdates[0].update.size).toBe(200000);
    expect(usageUpdates[0].update.cost).toBeUndefined();
    expect(usageUpdates[1].update.used).toBe(1800);
    expect(usageUpdates[1].update.size).toBe(1000000);
    expect(usageUpdates[1].update.cost).toBeDefined();
  });

  it("stream_event message_delta patches previous snapshot", async () => {
    const { agent, updates } = createMockAgentWithCapture();
    injectSession(agent, [
      createStreamEvent("message_start", {
        model: "claude-opus-4-20250514",
        usage: {
          input_tokens: 1000,
          output_tokens: 0,
          cache_read_input_tokens: 200,
          cache_creation_input_tokens: 100,
        },
      }),
      createStreamEvent("message_delta", {
        usage: { output_tokens: 500 },
      }),
      createResultMessageWithModel({
        modelUsage: {
          "claude-opus-4-20250514": {
            inputTokens: 1000,
            outputTokens: 500,
            cacheReadInputTokens: 200,
            cacheCreationInputTokens: 100,
            webSearchRequests: 0,
            costUSD: 0.01,
            contextWindow: 1000000,
            maxOutputTokens: 16384,
          },
        },
      }),
      { type: "system", subtype: "session_state_changed", state: "idle" },
    ]);

    await agent.prompt({ sessionId: "test-session", prompt: [{ type: "text", text: "test" }] });

    const usageUpdates = updates.filter((u: any) => u.update?.sessionUpdate === "usage_update");
    expect(usageUpdates).toHaveLength(3);
    expect(usageUpdates[0].update.used).toBe(1300);
    expect(usageUpdates[0].update.cost).toBeUndefined();
    expect(usageUpdates[1].update.used).toBe(1800);
    expect(usageUpdates[1].update.cost).toBeUndefined();
    expect(usageUpdates[2].update.used).toBe(1800);
    expect(usageUpdates[2].update.cost).toBeDefined();
  });

  it("mid-stream size is inferred from a 1M model name before the first result", async () => {
    // On the very first prompt there is no learned context window yet, so the
    // mid-stream update would otherwise fall back to 200k. A "-1m" suffix in
    // the SDK model ID is enough signal to emit 1_000_000 up front.
    const { agent, updates } = createMockAgentWithCapture();
    injectSession(agent, [
      createStreamEvent("message_start", {
        model: "claude-opus-4-6-1m",
        usage: {
          input_tokens: 2000,
          output_tokens: 1000,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
      }),
      createResultMessageWithModel({
        modelUsage: {
          "claude-opus-4-6-1m": {
            inputTokens: 2000,
            outputTokens: 1000,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
            webSearchRequests: 0,
            costUSD: 0.02,
            contextWindow: 1000000,
            maxOutputTokens: 16384,
          },
        },
      }),
      { type: "system", subtype: "session_state_changed", state: "idle" },
    ]);

    await agent.prompt({ sessionId: "test-session", prompt: [{ type: "text", text: "test" }] });

    const usageUpdates = updates.filter((u: any) => u.update?.sessionUpdate === "usage_update");
    expect(usageUpdates).toHaveLength(2);
    expect(usageUpdates[0].update.size).toBe(1000000);
    expect(usageUpdates[1].update.size).toBe(1000000);
  });

  it("duplicate stream_event totals do not re-emit usage_update", async () => {
    // A message_delta whose cumulative totals match the prior snapshot should
    // not trigger a duplicate usage_update — only the result adds cost on top.
    const { agent, updates } = createMockAgentWithCapture();
    injectSession(agent, [
      createStreamEvent("message_start", {
        model: "claude-opus-4-20250514",
        usage: {
          input_tokens: 1000,
          output_tokens: 500,
          cache_read_input_tokens: 200,
          cache_creation_input_tokens: 100,
        },
      }),
      createStreamEvent("message_delta", {
        usage: { output_tokens: 500 },
      }),
      createResultMessageWithModel({
        modelUsage: {
          "claude-opus-4-20250514": {
            inputTokens: 1000,
            outputTokens: 500,
            cacheReadInputTokens: 200,
            cacheCreationInputTokens: 100,
            webSearchRequests: 0,
            costUSD: 0.01,
            contextWindow: 1000000,
            maxOutputTokens: 16384,
          },
        },
      }),
      { type: "system", subtype: "session_state_changed", state: "idle" },
    ]);

    await agent.prompt({ sessionId: "test-session", prompt: [{ type: "text", text: "test" }] });

    const usageUpdates = updates.filter((u: any) => u.update?.sessionUpdate === "usage_update");
    expect(usageUpdates).toHaveLength(2);
    expect(usageUpdates[0].update.used).toBe(1800);
    expect(usageUpdates[0].update.cost).toBeUndefined();
    expect(usageUpdates[1].update.used).toBe(1800);
    expect(usageUpdates[1].update.cost).toBeDefined();
  });

  it("mid-stream size uses the session's learned context window", async () => {
    // Session state persists the model's context window across prompts, so a
    // mid-stream update in a later prompt reports the real size immediately
    // instead of snapping back to the 200k default before the result arrives.
    const { agent, updates } = createMockAgentWithCapture();
    injectSession(agent, [
      createStreamEvent("message_start", {
        model: "claude-opus-4-20250514",
        usage: {
          input_tokens: 2000,
          output_tokens: 1000,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
      }),
      createResultMessageWithModel({
        modelUsage: {
          "claude-opus-4-20250514": {
            inputTokens: 2000,
            outputTokens: 1000,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
            webSearchRequests: 0,
            costUSD: 0.02,
            contextWindow: 1000000,
            maxOutputTokens: 16384,
          },
        },
      }),
      { type: "system", subtype: "session_state_changed", state: "idle" },
    ]);
    // Simulate a prior prompt having learned the 1M window for this model.
    agent.sessions["test-session"].contextWindowSize = 1000000;

    await agent.prompt({ sessionId: "test-session", prompt: [{ type: "text", text: "test" }] });

    const usageUpdates = updates.filter((u: any) => u.update?.sessionUpdate === "usage_update");
    expect(usageUpdates).toHaveLength(2);
    expect(usageUpdates[0].update.size).toBe(1000000);
    expect(usageUpdates[1].update.size).toBe(1000000);
  });

  it("switching to a 1M model seeds the context window from the heuristic", async () => {
    // The heuristic runs at config-change time so mid-stream updates in the
    // next prompt already report 1M — without waiting for message_start or
    // the next `result` to correct us.
    const { agent, updates } = createMockAgentWithCapture();
    injectSession(agent, [
      createStreamEvent("message_start", {
        model: "claude-opus-4-6-1m",
        usage: {
          input_tokens: 2000,
          output_tokens: 1000,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
      }),
      createResultMessageWithModel({
        modelUsage: {
          "claude-opus-4-6-1m": {
            inputTokens: 2000,
            outputTokens: 1000,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
            webSearchRequests: 0,
            costUSD: 0.02,
            contextWindow: 1000000,
            maxOutputTokens: 16384,
          },
        },
      }),
      { type: "system", subtype: "session_state_changed", state: "idle" },
    ]);
    const session = agent.sessions["test-session"];
    expect(session.contextWindowSize).toBe(200000);

    await (agent as any).applyConfigOptionValue(session, "model", "claude-opus-4-6-1m");
    expect(session.contextWindowSize).toBe(1000000);

    await agent.prompt({ sessionId: "test-session", prompt: [{ type: "text", text: "test" }] });

    const usageUpdates = updates.filter((u: any) => u.update?.sessionUpdate === "usage_update");
    expect(usageUpdates).toHaveLength(2);
    expect(usageUpdates[0].update.size).toBe(1000000);
    expect(usageUpdates[1].update.size).toBe(1000000);
  });

  it("result with no matching modelUsage preserves the learned window", async () => {
    // A turn whose `result.modelUsage` doesn't contain the current top-level
    // model (e.g. no top-level assistant message, or only a subagent ran) must
    // not clobber the window learned on a prior turn — otherwise the next
    // prompt's mid-stream updates regress to the 200k default.
    const { agent, updates } = createMockAgentWithCapture();
    injectSession(agent, [
      createResultMessageWithModel({
        modelUsage: {
          "claude-haiku-4-5-20251001": {
            inputTokens: 100,
            outputTokens: 50,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
            webSearchRequests: 0,
            costUSD: 0.001,
            contextWindow: 200000,
            maxOutputTokens: 8192,
          },
        },
      }),
      { type: "system", subtype: "session_state_changed", state: "idle" },
    ]);
    const session = agent.sessions["test-session"];
    session.contextWindowSize = 1000000;

    await agent.prompt({ sessionId: "test-session", prompt: [{ type: "text", text: "test" }] });

    expect(session.contextWindowSize).toBe(1000000);
    // The emit itself falls back to session.contextWindowSize, which is
    // unchanged from the learned value.
    const usageUpdates = updates.filter((u: any) => u.update?.sessionUpdate === "usage_update");
    // No lastAssistantTotalUsage was set (no top-level assistant / stream
    // event), so the result branch skips its emit entirely.
    expect(usageUpdates).toHaveLength(0);
  });

  it("switching the session's model invalidates the learned context window", async () => {
    // When the user switches models mid-session, the window learned for the
    // previous model would otherwise persist into the next prompt's first
    // mid-stream update. applyConfigOptionValue should reset it so the next
    // turn's first update falls back to the heuristic (here: 200k default).
    const { agent, updates } = createMockAgentWithCapture();
    injectSession(agent, [
      createStreamEvent("message_start", {
        model: "claude-sonnet-4-6",
        usage: {
          input_tokens: 1000,
          output_tokens: 500,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
      }),
      createResultMessageWithModel({
        modelUsage: {
          "claude-sonnet-4-6": {
            inputTokens: 1000,
            outputTokens: 500,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
            webSearchRequests: 0,
            costUSD: 0.01,
            contextWindow: 200000,
            maxOutputTokens: 16384,
          },
        },
      }),
      { type: "system", subtype: "session_state_changed", state: "idle" },
    ]);
    const session = agent.sessions["test-session"];
    session.contextWindowSize = 1000000;
    session.models = { ...session.models, currentModelId: "claude-opus-4-6-1m" };

    // User flips the selector to a 200k model.
    await (agent as any).applyConfigOptionValue(session, "model", "claude-sonnet-4-6");

    await agent.prompt({ sessionId: "test-session", prompt: [{ type: "text", text: "test" }] });

    const usageUpdates = updates.filter((u: any) => u.update?.sessionUpdate === "usage_update");
    expect(usageUpdates).toHaveLength(2);
    expect(usageUpdates[0].update.size).toBe(200000);
    expect(usageUpdates[1].update.size).toBe(200000);
  });

  it("non-usage stream events do not re-emit usage_update", async () => {
    // content_block_* and message_stop carry no usage fields; they must not
    // trigger duplicate emits between the real message_start / message_delta
    // / result updates.
    const { agent, updates } = createMockAgentWithCapture();
    injectSession(agent, [
      createStreamEvent("message_start", {
        model: "claude-opus-4-20250514",
        usage: {
          input_tokens: 1000,
          output_tokens: 0,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
      }),
      {
        type: "stream_event" as const,
        parent_tool_use_id: null,
        uuid: randomUUID(),
        session_id: "test-session",
        event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      },
      {
        type: "stream_event" as const,
        parent_tool_use_id: null,
        uuid: randomUUID(),
        session_id: "test-session",
        event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } },
      },
      {
        type: "stream_event" as const,
        parent_tool_use_id: null,
        uuid: randomUUID(),
        session_id: "test-session",
        event: { type: "content_block_stop", index: 0 },
      },
      createStreamEvent("message_delta", {
        usage: { output_tokens: 200 },
      }),
      {
        type: "stream_event" as const,
        parent_tool_use_id: null,
        uuid: randomUUID(),
        session_id: "test-session",
        event: { type: "message_stop" },
      },
      createResultMessageWithModel({
        modelUsage: {
          "claude-opus-4-20250514": {
            inputTokens: 1000,
            outputTokens: 200,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
            webSearchRequests: 0,
            costUSD: 0.01,
            contextWindow: 1000000,
            maxOutputTokens: 16384,
          },
        },
      }),
      { type: "system", subtype: "session_state_changed", state: "idle" },
    ]);

    await agent.prompt({ sessionId: "test-session", prompt: [{ type: "text", text: "test" }] });

    const usageUpdates = updates.filter((u: any) => u.update?.sessionUpdate === "usage_update");
    // Exactly three: message_start (1000), message_delta (1200), result (1200 + cost).
    expect(usageUpdates).toHaveLength(3);
    expect(usageUpdates[0].update.used).toBe(1000);
    expect(usageUpdates[1].update.used).toBe(1200);
    expect(usageUpdates[2].update.used).toBe(1200);
    expect(usageUpdates[2].update.cost).toBeDefined();
  });

  it("subagent stream_event does not emit usage_update", async () => {
    const { agent, updates } = createMockAgentWithCapture();
    injectSession(agent, [
      createStreamEvent(
        "message_start",
        {
          model: "claude-haiku-4-5-20251001",
          usage: {
            input_tokens: 500,
            output_tokens: 100,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
        },
        "tool_use_123",
      ),
      createResultMessageWithModel({
        modelUsage: {
          "claude-haiku-4-5-20251001": {
            inputTokens: 500,
            outputTokens: 100,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
            webSearchRequests: 0,
            costUSD: 0.001,
            contextWindow: 200000,
            maxOutputTokens: 8192,
          },
        },
      }),
      { type: "system", subtype: "session_state_changed", state: "idle" },
    ]);

    await agent.prompt({ sessionId: "test-session", prompt: [{ type: "text", text: "test" }] });

    const usageUpdates = updates.filter((u: any) => u.update?.sessionUpdate === "usage_update");
    expect(usageUpdates).toHaveLength(0);
  });

  it("size reflects the current model's context window, not min across all", async () => {
    const { agent, updates } = createMockAgentWithCapture();
    injectSession(agent, [
      createAssistantMessage({ model: "claude-opus-4-20250514" }),
      createResultMessageWithModel({
        modelUsage: {
          "claude-opus-4-20250514": {
            inputTokens: 100,
            outputTokens: 50,
            cacheReadInputTokens: 20,
            cacheCreationInputTokens: 10,
            webSearchRequests: 0,
            costUSD: 0.01,
            contextWindow: 1000000,
            maxOutputTokens: 16384,
          },
          "claude-sonnet-4-20250514": {
            inputTokens: 50,
            outputTokens: 25,
            cacheReadInputTokens: 10,
            cacheCreationInputTokens: 5,
            webSearchRequests: 0,
            costUSD: 0.005,
            contextWindow: 200000,
            maxOutputTokens: 16384,
          },
        },
      }),
      { type: "system", subtype: "session_state_changed", state: "idle" },
    ]);

    await agent.prompt({ sessionId: "test-session", prompt: [{ type: "text", text: "test" }] });

    const usageUpdate = updates.find((u: any) => u.update?.sessionUpdate === "usage_update");
    expect(usageUpdate).toBeDefined();
    // size should be 1000000 (Opus), not 200000 (min of both)
    expect(usageUpdate.update.size).toBe(1000000);
  });

  it("after model switch, size updates to the new model's window", async () => {
    const { agent, updates } = createMockAgentWithCapture();
    // Simulate: assistant on Sonnet with both models in modelUsage
    injectSession(agent, [
      createAssistantMessage({ model: "claude-sonnet-4-20250514" }),
      createResultMessageWithModel({
        modelUsage: {
          "claude-opus-4-20250514": {
            inputTokens: 100,
            outputTokens: 50,
            cacheReadInputTokens: 20,
            cacheCreationInputTokens: 10,
            webSearchRequests: 0,
            costUSD: 0.01,
            contextWindow: 1000000,
            maxOutputTokens: 16384,
          },
          "claude-sonnet-4-20250514": {
            inputTokens: 50,
            outputTokens: 25,
            cacheReadInputTokens: 10,
            cacheCreationInputTokens: 5,
            webSearchRequests: 0,
            costUSD: 0.005,
            contextWindow: 200000,
            maxOutputTokens: 16384,
          },
        },
      }),
      { type: "system", subtype: "session_state_changed", state: "idle" },
    ]);

    await agent.prompt({ sessionId: "test-session", prompt: [{ type: "text", text: "test" }] });

    const usageUpdate = updates.find((u: any) => u.update?.sessionUpdate === "usage_update");
    expect(usageUpdate).toBeDefined();
    // size should be 200000 (Sonnet - the current model)
    expect(usageUpdate.update.size).toBe(200000);
  });

  it("after switching back to original model, size returns to original window", async () => {
    const { agent, updates } = createMockAgentWithCapture();
    // Last assistant message is Opus again
    injectSession(agent, [
      createAssistantMessage({ model: "claude-sonnet-4-20250514" }),
      createAssistantMessage({ model: "claude-opus-4-20250514" }),
      createResultMessageWithModel({
        modelUsage: {
          "claude-opus-4-20250514": {
            inputTokens: 200,
            outputTokens: 100,
            cacheReadInputTokens: 40,
            cacheCreationInputTokens: 20,
            webSearchRequests: 0,
            costUSD: 0.02,
            contextWindow: 1000000,
            maxOutputTokens: 16384,
          },
          "claude-sonnet-4-20250514": {
            inputTokens: 50,
            outputTokens: 25,
            cacheReadInputTokens: 10,
            cacheCreationInputTokens: 5,
            webSearchRequests: 0,
            costUSD: 0.005,
            contextWindow: 200000,
            maxOutputTokens: 16384,
          },
        },
      }),
      { type: "system", subtype: "session_state_changed", state: "idle" },
    ]);

    await agent.prompt({ sessionId: "test-session", prompt: [{ type: "text", text: "test" }] });

    const usageUpdate = updates.find((u: any) => u.update?.sessionUpdate === "usage_update");
    expect(usageUpdate).toBeDefined();
    // size should be 1000000 (Opus - switched back)
    expect(usageUpdate.update.size).toBe(1000000);
  });

  it("subagent assistant messages do not affect size (top-level model is used)", async () => {
    const { agent, updates } = createMockAgentWithCapture();
    // Top-level assistant on Opus, then subagent on Haiku (parent_tool_use_id set)
    injectSession(agent, [
      createAssistantMessage({ model: "claude-opus-4-20250514" }),
      {
        type: "assistant" as const,
        parent_tool_use_id: "tool_use_123",
        uuid: randomUUID(),
        session_id: "test-session",
        message: {
          model: "claude-haiku-4-5-20251001",
          content: [{ type: "text", text: "subagent response" }],
          usage: {
            input_tokens: 50,
            output_tokens: 25,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
        },
      },
      createResultMessageWithModel({
        modelUsage: {
          "claude-opus-4-20250514": {
            inputTokens: 100,
            outputTokens: 50,
            cacheReadInputTokens: 20,
            cacheCreationInputTokens: 10,
            webSearchRequests: 0,
            costUSD: 0.01,
            contextWindow: 1000000,
            maxOutputTokens: 16384,
          },
          "claude-haiku-4-5-20251001": {
            inputTokens: 50,
            outputTokens: 25,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
            webSearchRequests: 0,
            costUSD: 0.001,
            contextWindow: 200000,
            maxOutputTokens: 8192,
          },
        },
      }),
      { type: "system", subtype: "session_state_changed", state: "idle" },
    ]);

    await agent.prompt({ sessionId: "test-session", prompt: [{ type: "text", text: "test" }] });

    const usageUpdate = updates.find((u: any) => u.update?.sessionUpdate === "usage_update");
    expect(usageUpdate).toBeDefined();
    // size should be 1000000 (Opus - the top-level model), NOT 200000 (Haiku subagent)
    expect(usageUpdate.update.size).toBe(1000000);
  });

  it("prefix-matches when assistant model has date suffix but modelUsage key does not", async () => {
    const { agent, updates } = createMockAgentWithCapture();
    // The API response has the full versioned model ID on assistant messages,
    // but the SDK's streaming path may key modelUsage by the shorter alias.
    injectSession(agent, [
      createAssistantMessage({ model: "claude-opus-4-6-20250514" }),
      createResultMessageWithModel({
        modelUsage: {
          "claude-opus-4-6": {
            inputTokens: 100,
            outputTokens: 50,
            cacheReadInputTokens: 20,
            cacheCreationInputTokens: 10,
            webSearchRequests: 0,
            costUSD: 0.01,
            contextWindow: 1000000,
            maxOutputTokens: 16384,
          },
        },
      }),
      { type: "system", subtype: "session_state_changed", state: "idle" },
    ]);

    await agent.prompt({ sessionId: "test-session", prompt: [{ type: "text", text: "test" }] });

    const usageUpdate = updates.find((u: any) => u.update?.sessionUpdate === "usage_update");
    expect(usageUpdate).toBeDefined();
    // Should match via prefix: "claude-opus-4-6-20250514".startsWith("claude-opus-4-6")
    expect(usageUpdate.update.size).toBe(1000000);
  });

  it("prefix-matches when modelUsage key has date suffix but assistant model does not", async () => {
    const { agent, updates } = createMockAgentWithCapture();
    injectSession(agent, [
      createAssistantMessage({ model: "claude-opus-4-6" }),
      createResultMessageWithModel({
        modelUsage: {
          "claude-opus-4-6-20250514": {
            inputTokens: 100,
            outputTokens: 50,
            cacheReadInputTokens: 20,
            cacheCreationInputTokens: 10,
            webSearchRequests: 0,
            costUSD: 0.01,
            contextWindow: 1000000,
            maxOutputTokens: 16384,
          },
        },
      }),
      { type: "system", subtype: "session_state_changed", state: "idle" },
    ]);

    await agent.prompt({ sessionId: "test-session", prompt: [{ type: "text", text: "test" }] });

    const usageUpdate = updates.find((u: any) => u.update?.sessionUpdate === "usage_update");
    expect(usageUpdate).toBeDefined();
    expect(usageUpdate.update.size).toBe(1000000);
  });

  it("synthetic assistant messages do not override lastAssistantModel", async () => {
    const { agent, updates } = createMockAgentWithCapture();
    // Real assistant on Opus, then a synthetic message (e.g. from /compact)
    injectSession(agent, [
      createAssistantMessage({ model: "claude-opus-4-20250514" }),
      {
        type: "assistant" as const,
        parent_tool_use_id: null,
        uuid: randomUUID(),
        session_id: "test-session",
        message: {
          model: "<synthetic>",
          content: [{ type: "text", text: "compacted" }],
          usage: {
            input_tokens: 0,
            output_tokens: 0,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
        },
      },
      createResultMessageWithModel({
        modelUsage: {
          "claude-opus-4-20250514": {
            inputTokens: 100,
            outputTokens: 50,
            cacheReadInputTokens: 20,
            cacheCreationInputTokens: 10,
            webSearchRequests: 0,
            costUSD: 0.01,
            contextWindow: 1000000,
            maxOutputTokens: 16384,
          },
        },
      }),
      { type: "system", subtype: "session_state_changed", state: "idle" },
    ]);

    await agent.prompt({ sessionId: "test-session", prompt: [{ type: "text", text: "test" }] });

    const usageUpdate = updates.find((u: any) => u.update?.sessionUpdate === "usage_update");
    expect(usageUpdate).toBeDefined();
    // size should be 1000000 (Opus), not 200000 (the fallback if <synthetic> overrode the model)
    expect(usageUpdate.update.size).toBe(1000000);
  });
});

describe("emitRawSDKMessages", () => {
  function createMockAgentWithExtNotification() {
    const updates: any[] = [];
    const extNotifications: { method: string; params: any }[] = [];
    const mockClient = {
      sessionUpdate: async (notification: any) => {
        updates.push(notification);
      },
      extNotification: async (method: string, params: any) => {
        extNotifications.push({ method, params });
      },
    } as unknown as AgentSideConnection;
    const agent = new ClaudeAcpAgent(mockClient, { log: () => {}, error: () => {} });
    return { agent, updates, extNotifications };
  }

  function injectSession(
    agent: ClaudeAcpAgent,
    messages: any[],
    emitRawSDKMessages: boolean | { type: string; subtype?: string }[],
  ) {
    const input = new Pushable<any>();
    async function* messageGenerator() {
      const iter = input[Symbol.asyncIterator]();
      const { value: userMessage, done } = await iter.next();
      if (!done && userMessage) {
        yield {
          type: "user",
          message: userMessage.message,
          parent_tool_use_id: null,
          uuid: userMessage.uuid,
          session_id: "test-session",
          isReplay: true,
        };
      }
      yield* messages;
    }
    agent.sessions["test-session"] = {
      query: messageGenerator() as any,
      input,
      cancelled: false,
      cwd: "/test",
      sessionFingerprint: JSON.stringify({ cwd: "/test", mcpServers: [] }),
      modes: { currentModeId: "default", availableModes: [] },
      models: { currentModelId: "default", availableModels: [] },
      modelInfos: [],
      settingsManager: { dispose: vi.fn() } as any,
      accumulatedUsage: {
        inputTokens: 0,
        outputTokens: 0,
        cachedReadTokens: 0,
        cachedWriteTokens: 0,
      },
      configOptions: [],
      promptRunning: false,
      pendingMessages: new Map(),
      nextPendingOrder: 0,
      abortController: new AbortController(),
      emitRawSDKMessages,
      contextWindowSize: 200000,
    };
  }

  function createResultMessage() {
    return {
      type: "result" as const,
      subtype: "success" as const,
      is_error: false,
      result: "",
      errors: [],
      stop_reason: "end_turn" as const,
      cost_usd: 0,
      duration_ms: 0,
      duration_api_ms: 0,
      num_turns: 1,
      total_cost_usd: 0,
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
      modelUsage: {},
      permission_denials: [],
      uuid: randomUUID(),
      session_id: "test-session",
    };
  }

  it("emits all raw messages when set to true", async () => {
    const { agent, extNotifications } = createMockAgentWithExtNotification();
    const systemMsg = {
      type: "system",
      subtype: "status",
      status: "compacting",
      session_id: "test-session",
    };
    injectSession(
      agent,
      [
        systemMsg,
        createResultMessage(),
        { type: "system", subtype: "session_state_changed", state: "idle" },
      ],
      true,
    );

    await agent.prompt({ sessionId: "test-session", prompt: [{ type: "text", text: "test" }] });

    // Should have emitted extNotifications for all messages (user replay + system + result + session_state_changed)
    expect(extNotifications.length).toBeGreaterThanOrEqual(3);
    expect(extNotifications.every((n) => n.method === "_claude/sdkMessage")).toBe(true);
  });

  it("does not emit when set to false", async () => {
    const { agent, extNotifications } = createMockAgentWithExtNotification();
    injectSession(
      agent,
      [
        { type: "system", subtype: "status", status: "compacting", session_id: "test-session" },
        createResultMessage(),
        { type: "system", subtype: "session_state_changed", state: "idle" },
      ],
      false,
    );

    await agent.prompt({ sessionId: "test-session", prompt: [{ type: "text", text: "test" }] });

    expect(extNotifications).toHaveLength(0);
  });

  it("emits only messages matching a filter array", async () => {
    const { agent, extNotifications } = createMockAgentWithExtNotification();
    injectSession(
      agent,
      [
        { type: "system", subtype: "compact_boundary", session_id: "test-session" },
        { type: "system", subtype: "status", status: "compacting", session_id: "test-session" },
        createResultMessage(),
        { type: "system", subtype: "session_state_changed", state: "idle" },
      ],
      [{ type: "system", subtype: "compact_boundary" }],
    );

    await agent.prompt({ sessionId: "test-session", prompt: [{ type: "text", text: "test" }] });

    // Only the compact_boundary message should have been emitted
    const sdkMessages = extNotifications.filter((n) => n.method === "_claude/sdkMessage");
    expect(sdkMessages).toHaveLength(1);
    expect(sdkMessages[0].params.sessionId).toBe("test-session");
    expect(sdkMessages[0].params.message.type).toBe("system");
    expect(sdkMessages[0].params.message.subtype).toBe("compact_boundary");
  });

  it("filter without subtype matches all messages of that type", async () => {
    const { agent, extNotifications } = createMockAgentWithExtNotification();
    injectSession(
      agent,
      [
        { type: "system", subtype: "compact_boundary", session_id: "test-session" },
        { type: "system", subtype: "status", status: "compacting", session_id: "test-session" },
        createResultMessage(),
        { type: "system", subtype: "session_state_changed", state: "idle" },
      ],
      [{ type: "system" }],
    );

    await agent.prompt({ sessionId: "test-session", prompt: [{ type: "text", text: "test" }] });

    const sdkMessages = extNotifications.filter((n) => n.method === "_claude/sdkMessage");
    // All system messages should match (compact_boundary + status + session_state_changed)
    const systemMessages = sdkMessages.filter((n) => n.params.message.type === "system");
    expect(systemMessages).toHaveLength(3);
  });

  it("supports multiple filters", async () => {
    const { agent, extNotifications } = createMockAgentWithExtNotification();
    injectSession(
      agent,
      [
        { type: "system", subtype: "compact_boundary", session_id: "test-session" },
        { type: "system", subtype: "status", status: "compacting", session_id: "test-session" },
        createResultMessage(),
        { type: "system", subtype: "session_state_changed", state: "idle" },
      ],
      [{ type: "system", subtype: "compact_boundary" }, { type: "result" }],
    );

    await agent.prompt({ sessionId: "test-session", prompt: [{ type: "text", text: "test" }] });

    const sdkMessages = extNotifications.filter((n) => n.method === "_claude/sdkMessage");
    expect(sdkMessages).toHaveLength(2);
    expect(sdkMessages[0].params.message.type).toBe("system");
    expect(sdkMessages[0].params.message.subtype).toBe("compact_boundary");
    expect(sdkMessages[1].params.message.type).toBe("result");
  });
});
