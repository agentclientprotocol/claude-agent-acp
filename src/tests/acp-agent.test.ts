import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import { spawn, spawnSync } from "child_process";
import {
  Agent,
  AgentSideConnection,
  AvailableCommand,
  Client,
  ClientSideConnection,
  CreateElicitationRequest,
  CreateElicitationResponse,
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
  toolUpdateFromDiffToolResponse,
} from "../tools.js";
import {
  toAcpNotifications,
  promptToClaude,
  isLocalCommandMetadata,
  stripLocalCommandMetadata,
  ClaudeAcpAgent,
  claudeCliPath,
  describeAlwaysAllow,
  streamEventToAcpNotifications,
  messageIdForGrouping,
  type SDKMessageFilter,
} from "../acp-agent.js";
import { Pushable } from "../utils.js";
import {
  deleteSession,
  getSessionMessages,
  query,
  SDKAssistantMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { randomUUID } from "crypto";

vi.mock("@anthropic-ai/claude-agent-sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@anthropic-ai/claude-agent-sdk")>();
  return {
    ...actual,
    deleteSession: vi.fn(),
  };
});
import type {
  BetaToolResultBlockParam,
  BetaToolSearchToolResultBlockParam,
  BetaWebSearchToolResultBlockParam,
  BetaWebFetchToolResultBlockParam,
  BetaCodeExecutionToolResultBlockParam,
} from "@anthropic-ai/sdk/resources/beta.mjs";

/** Build the replayed `user` message the SDK echoes back for a pushed prompt,
 *  used by mock generators to promote a turn to active. */
function userEcho(u: any) {
  return {
    type: "user",
    message: u.message,
    parent_tool_use_id: null,
    uuid: u.uuid,
    session_id: "test-session",
    isReplay: true,
  };
}

/** Wrap a mock async generator with the `Query` methods the agent calls outside
 *  of iteration — `close()` (teardown/closeQueryStream), `interrupt()` (cancel),
 *  and `setModel()` — so a bare generator doesn't trip "x is not a function". */
function wrapQuery(generator: AsyncGenerator<any>) {
  return Object.assign(generator, {
    interrupt: vi.fn(async () => {}),
    close: vi.fn(),
    setModel: vi.fn(async () => {}),
  }) as any;
}

/** The common `Session` mock fields, with per-test overrides spread on top.
 *  Centralizes the boilerplate (usage accumulator, caches, controllers) so a new
 *  Session field is added in one place rather than every inline literal. */
function mockSessionState(overrides: Record<string, any> = {}) {
  return {
    cancelled: false,
    cwd: "/test",
    sessionFingerprint: JSON.stringify({ cwd: "/test", mcpServers: [] }),
    modes: { currentModeId: "default", availableModes: [] },
    models: { currentModelId: "default", availableModels: [] },
    modelInfos: [],
    settingsManager: { dispose: vi.fn() },
    accumulatedUsage: {
      inputTokens: 0,
      outputTokens: 0,
      cachedReadTokens: 0,
      cachedWriteTokens: 0,
    },
    configOptions: [],
    abortController: new AbortController(),
    emitRawSDKMessages: false,
    contextWindowSize: 200000,
    taskState: new Map(),
    toolUseCache: {},
    messageIdToUuid: new Map(),
    ...overrides,
  } as any;
}

/** Install a mock session whose query is a caller-supplied async generator
 *  driven by the session's streaming input. Returns the input Pushable so the
 *  test can push additional turns. Centralizes the Session literal so tests that
 *  need bespoke message ordering don't each re-declare it. */
function injectGeneratorSession(
  agent: ClaudeAcpAgent,
  makeGenerator: (input: Pushable<any>) => AsyncGenerator<any>,
  overrides: Record<string, any> = {},
) {
  const input = new Pushable<any>();
  agent.sessions["test-session"] = mockSessionState({
    query: wrapQuery(makeGenerator(input)),
    input,
    ...overrides,
  });
  return input;
}

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
    // Records for the AskUserQuestion elicitation test.
    elicitations: CreateElicitationRequest[] = [];
    permissionToolInputs: unknown[] = [];
    chosenAnswers: Record<string, string | string[]> = {};
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
      // Record what asked for permission so a test can assert that
      // AskUserQuestion did NOT fall back to a generic permission prompt.
      this.permissionToolInputs.push(params.toolCall?.rawInput);
      const optionId = params.options.find((p) => p.kind === "allow_once")!.optionId;

      return { outcome: { outcome: "selected", optionId } };
    }

    async unstable_createElicitation(
      params: CreateElicitationRequest,
    ): Promise<CreateElicitationResponse> {
      this.elicitations.push(params);
      if (params.mode !== "form") {
        return { action: "decline" };
      }
      // Accept the first option of every choice field (skip the free-text one).
      const content: Record<string, string | string[]> = {};
      for (const [key, prop] of Object.entries(params.requestedSchema.properties ?? {})) {
        if (key === "customAnswer") continue;
        const p = prop as {
          oneOf?: Array<{ const: string }>;
          items?: { anyOf?: Array<{ const: string }> };
        };
        if (p.oneOf?.length) {
          content[key] = p.oneOf[0].const;
        } else if (p.items?.anyOf?.length) {
          content[key] = [p.items.anyOf[0].const];
        }
      }
      this.chosenAnswers = content;
      return { action: "accept", content };
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
        elicitation: {
          form: {},
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
    const { client, connection, newSessionResponse } = await setupTestSession(process.cwd());

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

    // Build up enough conversation that there's something to compact. The SDK
    // refuses to compact a conversation with too few message groups.
    for (let i = 0; i < 6; i++) {
      await connection.prompt({
        prompt: [{ type: "text", text: `Reply with just the number ${i}.` }],
        sessionId: newSessionResponse.sessionId,
      });
      client.takeReceivedText();
    }

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
  }, 60000);

  // Regression guard for the SDK's AskUserQuestion routing. The built-in
  // AskUserQuestion tool is delivered to us through `canUseTool` (not the
  // interactive `onUserDialog` path), where we intercept it and render an ACP
  // form elicitation, returning the answer via `updatedInput`. If a future SDK
  // changes that routing — e.g. stops calling `canUseTool` for it, or no longer
  // reads answers back from `updatedInput` — this test fails: either no
  // elicitation arrives, the tool falls back to a permission prompt, or the
  // answer never reaches the model's reply.
  it("routes AskUserQuestion through ACP form elicitation and round-trips the answer", async () => {
    const { client, connection, newSessionResponse } = await setupTestSession(process.cwd());

    await connection.prompt({
      prompt: [
        {
          type: "text",
          text:
            "Use the AskUserQuestion tool right now to ask me to choose a favorite color. " +
            "Offer exactly two options: 'Red' and 'Blue'. Do not use any other tool and do " +
            "not ask in plain text. After I answer, reply with one short sentence naming the " +
            "color I picked.",
        },
      ],
      sessionId: newSessionResponse.sessionId,
    });

    // The tool surfaced as an ACP form elicitation...
    expect(client.elicitations.length).toBeGreaterThan(0);
    const elicitation = client.elicitations[0];
    expect(elicitation.mode).toBe("form");

    // ...built by our converter (indexed field key + free-text "Other" field),
    // which confirms our interception path produced it rather than some other
    // mechanism.
    const properties =
      elicitation.mode === "form" ? Object.keys(elicitation.requestedSchema.properties ?? {}) : [];
    expect(properties).toContain("question_0");
    expect(properties).toContain("question_0_custom");

    // AskUserQuestion must NOT fall back to a generic permission prompt: no
    // permission request should have carried AskUserQuestion's `questions`.
    const fellBackToPermission = client.permissionToolInputs.some(
      (input) =>
        !!input &&
        typeof input === "object" &&
        Array.isArray((input as { questions?: unknown }).questions),
    );
    expect(fellBackToPermission).toBe(false);

    // The chosen answer round-trips: the model's reply names the picked option.
    const picked = String(Object.values(client.chosenAnswers)[0] ?? "");
    expect(picked).not.toEqual("");
    expect(client.takeReceivedText().toLowerCase()).toContain(picked.toLowerCase());
  }, 60000);
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
        stop_details: null,
        diagnostics: null,
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
          output_tokens_details: null,
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

describe("toolUpdateFromDiffToolResponse", () => {
  it("should return empty for non-object input", () => {
    expect(toolUpdateFromDiffToolResponse(null)).toEqual({});
    expect(toolUpdateFromDiffToolResponse(undefined)).toEqual({});
    expect(toolUpdateFromDiffToolResponse("string")).toEqual({});
  });

  it("should return empty when filePath or structuredPatch is missing", () => {
    expect(toolUpdateFromDiffToolResponse({})).toEqual({});
    expect(toolUpdateFromDiffToolResponse({ filePath: "/foo.ts" })).toEqual({});
    expect(toolUpdateFromDiffToolResponse({ structuredPatch: [] })).toEqual({});
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

    expect(toolUpdateFromDiffToolResponse(toolResponse)).toEqual({
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

    expect(toolUpdateFromDiffToolResponse(toolResponse)).toEqual({
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

    expect(toolUpdateFromDiffToolResponse(toolResponse)).toEqual({
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

    expect(toolUpdateFromDiffToolResponse(toolResponse)).toEqual({});
  });
});

describe("stripLocalCommandMetadata", () => {
  it("returns null for strings that are pure marker metadata", () => {
    expect(stripLocalCommandMetadata("<command-name>/model</command-name>")).toBeNull();
    expect(
      stripLocalCommandMetadata("<local-command-stdout>out</local-command-stdout>"),
    ).toBeNull();
    expect(
      stripLocalCommandMetadata("<local-command-stderr>err</local-command-stderr>"),
    ).toBeNull();
    expect(
      stripLocalCommandMetadata(
        "<command-name>/model</command-name>\n            <command-message>model</command-message>\n            <command-args>opus</command-args>",
      ),
    ).toBeNull();
  });

  it("returns the string unchanged for real content", () => {
    expect(stripLocalCommandMetadata("hi")).toBe("hi");
    expect(stripLocalCommandMetadata("please run /model with args")).toBe(
      "please run /model with args",
    );
  });

  // Regression: in the original bug report the entire /model preamble and
  // the user's real "hi" prompt were concatenated into a single message.
  // We want to strip the marker tags and preserve the real prose, not drop
  // the whole message.
  it("strips marker tags from mixed-content strings, preserving real prose", () => {
    const mixed =
      "<command-name>/model</command-name>\n            <command-message>model</command-message>\n            <command-args>opus</command-args>" +
      "<local-command-stdout>Set model to opus (claude-opus-4-7)</local-command-stdout>" +
      "<command-name>/model</command-name>\n            <command-message>model</command-message>\n            <command-args>opus[1m]</command-args>" +
      "<local-command-stdout>Set model to opus[1m] (claude-opus-4-7[1m])</local-command-stdout>" +
      "hi";
    const stripped = stripLocalCommandMetadata(mixed);
    expect(typeof stripped).toBe("string");
    expect(stripped as string).not.toContain("<command-name>");
    expect(stripped as string).not.toContain("<command-message>");
    expect(stripped as string).not.toContain("<command-args>");
    expect(stripped as string).not.toContain("<local-command-stdout>");
    expect((stripped as string).trimEnd()).toMatch(/hi$/);
  });

  it("drops marker-only blocks from mixed arrays, keeping real blocks", () => {
    const result = stripLocalCommandMetadata([
      { type: "text", text: "<command-name>/model</command-name>" },
      { type: "text", text: "<local-command-stdout>ok</local-command-stdout>" },
      { type: "text", text: "hi" },
    ]);
    expect(result).toEqual([{ type: "text", text: "hi" }]);
  });

  it("returns null when every block is a marker", () => {
    expect(
      stripLocalCommandMetadata([
        { type: "text", text: "<command-name>/model</command-name>" },
        { type: "text", text: "<local-command-stdout>ok</local-command-stdout>" },
      ]),
    ).toBeNull();
  });

  it("strips tags inside a text block while keeping the trailing prose", () => {
    const result = stripLocalCommandMetadata([
      {
        type: "text",
        text: "<command-name>/model</command-name><local-command-stdout>ok</local-command-stdout>hi",
      },
    ]);
    expect(result).toEqual([{ type: "text", text: "hi" }]);
  });

  it("leaves non-text blocks alone", () => {
    const image = { type: "image", source: { type: "base64", data: "", media_type: "image/png" } };
    const result = stripLocalCommandMetadata([
      { type: "text", text: "<command-name>/model</command-name>" },
      image,
    ]);
    expect(result).toEqual([image]);
  });

  it("handles null/undefined/non-container shapes", () => {
    expect(stripLocalCommandMetadata(null)).toBeNull();
    expect(stripLocalCommandMetadata(undefined)).toBeUndefined();
    expect(stripLocalCommandMetadata({ arbitrary: "object" })).toEqual({ arbitrary: "object" });
  });
});

describe("isLocalCommandMetadata", () => {
  it("is true when stripping leaves nothing", () => {
    expect(isLocalCommandMetadata("<command-name>/model</command-name>")).toBe(true);
    expect(
      isLocalCommandMetadata([{ type: "text", text: "<command-name>/model</command-name>" }]),
    ).toBe(true);
  });

  it("is false when real content survives stripping", () => {
    expect(isLocalCommandMetadata("hi")).toBe(false);
    expect(isLocalCommandMetadata("<command-name>/model</command-name>hi")).toBe(false);
    expect(
      isLocalCommandMetadata([
        { type: "text", text: "<command-name>/model</command-name>" },
        { type: "text", text: "hi" },
      ]),
    ).toBe(false);
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

  // Pins the SDK invariant our `messageId` plumbing relies on: the Anthropic
  // API message id is available at `message_start` (before any delta), is the
  // same on the consolidated assistant message, and is recoverable from the
  // persisted transcript — so a turn keeps one stable id across streaming and
  // replay. The per-`stream_event` uuid is NOT used because it is unique per
  // event and never persisted; this test would fail if a future SDK regressed
  // any of those properties.
  it("uses the API message id as a stable anchor across streaming and replay", async () => {
    const sessionId = randomUUID();
    const q = query({
      prompt: "Reply with exactly these words and nothing else: hello there my friend",
      options: {
        systemPrompt: { type: "preset", preset: "claude_code" },
        sessionId,
        includePartialMessages: true,
        maxTurns: 1,
        allowedTools: [],
      },
    });

    let messageStartApiId: string | undefined;
    let consolidatedApiId: string | undefined;
    let sawDelta = false;
    let allPartialsTopLevel = true;

    for await (const message of q) {
      if (message.type === "assistant") {
        consolidatedApiId = message.message.id;
      }
      if (message.type !== "stream_event") continue;
      // Every streaming partial must belong to the top-level agent
      // (parent_tool_use_id === null). Subagent work is folded into tool-result
      // messages rather than surfaced as partial streams, which is what lets us
      // track a single anchor without keying by parent_tool_use_id.
      if (message.parent_tool_use_id !== null) allPartialsTopLevel = false;
      if (message.event.type === "message_start") {
        messageStartApiId = message.event.message.id;
      } else if (message.event.type === "content_block_delta") {
        sawDelta = true;
      }
    }

    // The API message id is present at message_start (before deltas), so we can
    // tag every streamed chunk with it, and it is identical on the consolidated
    // assistant message.
    expect(messageStartApiId).toBeTruthy();
    expect(sawDelta).toBe(true);
    expect(allPartialsTopLevel).toBe(true);
    expect(consolidatedApiId).toBe(messageStartApiId);

    // ...and the SAME id is recoverable from the persisted transcript, so chunks
    // grouped live keep their id when the session is replayed.
    const persisted = await getSessionMessages(sessionId);
    const replayedAssistant = persisted.find((m) => m.type === "assistant");
    expect(replayedAssistant).toBeDefined();
    expect((replayedAssistant!.message as { id?: string }).id).toBe(messageStartApiId);
    // The helper used in production must derive that same id from the replayed
    // message.
    expect(messageIdForGrouping(replayedAssistant!)).toBe(messageStartApiId);
  }, 30000);

  // Pins the two SDK invariants the persistent consumer's lifecycle relies on
  // (see runConsumer's `done` handling and Session.queryClosed):
  //   1. A streaming-input query does NOT yield `done` between turns — it stays
  //      open for the session's life, so a second pushed message starts a
  //      second turn rather than ending the stream. If this regressed, the
  //      consumer would tear the session down after the first turn's idle.
  //   2. Ending the input stream drives the iterator to `done`, and once `done`
  //      it stays `done` (the iterator is not revivable) — which is what lets us
  //      treat a `done` as a permanent stream close and reject later prompts
  //      instead of restarting a consumer over an exhausted query.
  it("keeps the streaming query open across turns and stays done after input ends", async () => {
    const sessionId = randomUUID();
    const input = new Pushable<any>();
    const q = query({
      prompt: input,
      options: {
        systemPrompt: { type: "preset", preset: "claude_code" },
        sessionId,
        includePartialMessages: false,
        allowedTools: [],
      },
    });

    const pushPrompt = (text: string) => {
      const msg = promptToClaude({ sessionId, prompt: [{ type: "text", text }] });
      msg.uuid = randomUUID();
      input.push(msg);
    };

    // Drain one turn up to its terminal `result`, asserting the stream stays
    // open (never `done`) meanwhile. We delimit by `result` — NOT by the
    // trailing `session_state_changed: idle` — because some CLI binaries don't
    // emit session-state events (issue #497); waiting on idle would hang there.
    // This also matches how the consumer itself settles a turn (at the result).
    const drainToResult = async () => {
      while (true) {
        const { value, done } = await q.next();
        // Invariant 1: the streaming query must not end while a turn is live.
        expect(done).toBe(false);
        if ((value as { type?: string }).type === "result") return;
      }
    };

    try {
      pushPrompt("Reply with exactly this word and nothing else: one");
      await drainToResult();

      // The query stays open across turns: a second pushed message yields a
      // second turn (its own `result`) rather than ending the stream.
      pushPrompt("Reply with exactly this word and nothing else: two");
      await drainToResult();

      // Invariant 2: ending the input terminates the iterator. Drain any trailing
      // messages (e.g. a final idle) until it reports `done`.
      input.end();
      let done = false;
      for (let i = 0; i < 20 && !done; i++) {
        done = (await q.next()).done ?? false;
      }
      expect(done).toBe(true);

      // ...and it stays terminated — a later next() does not revive the stream.
      const again = await q.next();
      expect(again.done).toBe(true);
    } finally {
      // Ensure the live CLI subprocess is torn down even if an assertion above
      // throws before input.end() — otherwise it would outlive the test run.
      input.end();
      await q.close?.();
    }
  }, 60000);
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

  describe("describeAlwaysAllow", () => {
    it("falls back to naming the whole tool when no suggestions are provided", () => {
      expect(describeAlwaysAllow(undefined, "Bash")).toBe("Always Allow all Bash");
      expect(describeAlwaysAllow([], "Read")).toBe("Always Allow all Read");
    });

    it("includes the scoped rule content from a suggestion", () => {
      const label = describeAlwaysAllow(
        [
          {
            type: "addRules",
            rules: [{ toolName: "Bash", ruleContent: "npm test:*" }],
            behavior: "allow",
            destination: "session",
          },
        ],
        "Bash",
      );
      expect(label).toBe("Always Allow Bash(npm test:*)");
    });

    it("indicates a tool-wide rule when the suggestion has no ruleContent", () => {
      const label = describeAlwaysAllow(
        [
          {
            type: "addRules",
            rules: [{ toolName: "Read" }],
            behavior: "allow",
            destination: "session",
          },
        ],
        "Read",
      );
      expect(label).toBe("Always Allow all Read");
    });

    it("joins multiple rules and directory suggestions", () => {
      const label = describeAlwaysAllow(
        [
          {
            type: "addRules",
            rules: [
              { toolName: "Bash", ruleContent: "git status" },
              { toolName: "Bash", ruleContent: "git diff:*" },
            ],
            behavior: "allow",
            destination: "session",
          },
          {
            type: "addDirectories",
            directories: ["/tmp/work"],
            destination: "session",
          },
        ],
        "Bash",
      );
      expect(label).toBe("Always Allow Bash(git status), Bash(git diff:*) and access to /tmp/work");
    });

    it("ignores non-allow rules and falls back when nothing is left", () => {
      const label = describeAlwaysAllow(
        [
          {
            type: "addRules",
            rules: [{ toolName: "Bash", ruleContent: "rm -rf:*" }],
            behavior: "deny",
            destination: "session",
          },
        ],
        "Bash",
      );
      expect(label).toBe("Always Allow all Bash");
    });
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
    agent.sessions["test-session"] = mockSessionState({
      query: wrapQuery(messageGenerator()),
      input,
    });
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
    // Background task used some tokens. Real autonomous followups carry a
    // task-notification origin, which keeps them out of the user turn's result
    // and usage.
    backgroundTaskResult.usage.input_tokens = 100;
    backgroundTaskResult.usage.output_tokens = 50;
    (backgroundTaskResult as { origin?: unknown }).origin = { kind: "task-notification" };

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

    agent.sessions["test-session"] = mockSessionState({
      query: wrapQuery(messageGenerator()),
      input,
      cwd: "/tmp/test",
      sessionFingerprint: JSON.stringify({ cwd: "/tmp/test", mcpServers: [] }),
    });

    const response = await agent.prompt({
      sessionId: "test-session",
      prompt: [{ type: "text", text: "test" }],
    });

    expect(response.stopReason).toBe("end_turn");
    // The prompt resolves with its OWN result's usage; the background
    // task-notification result's tokens are reported separately (via
    // usage_update), not folded into the user turn's response.
    expect(response.usage?.inputTokens).toBe(promptResult.usage.input_tokens);
    expect(response.usage?.outputTokens).toBe(promptResult.usage.output_tokens);
  });

  it("does not fold a task-notification result's tokens into an already-active turn's usage", async () => {
    const agent = createMockAgent();

    // A task-notification followup that interleaves AFTER the user turn is
    // active (its echo seen) but BEFORE the turn's own result. Its tokens must
    // not leak into the user turn's usage even though the accumulator is only
    // reset on activation.
    const backgroundTaskResult = createResultMessage({
      subtype: "success",
      stop_reason: null,
      is_error: false,
    });
    backgroundTaskResult.usage.input_tokens = 100;
    backgroundTaskResult.usage.output_tokens = 50;
    (backgroundTaskResult as { origin?: unknown }).origin = { kind: "task-notification" };

    const promptResult = createResultMessage({
      subtype: "success",
      stop_reason: null,
      is_error: false,
    });

    injectGeneratorSession(agent, (input) => {
      async function* messageGenerator() {
        const iter = input[Symbol.asyncIterator]();
        const { value: userMessage } = await iter.next();
        // User echo first → the turn is now active and its accumulator reset.
        yield userEcho(userMessage);
        // Task-notification result lands mid-turn...
        yield backgroundTaskResult;
        // ...then the user turn's own result settles it.
        yield promptResult;
        yield { type: "system", subtype: "session_state_changed", state: "idle" };
      }
      return messageGenerator();
    });

    const response = await agent.prompt({
      sessionId: "test-session",
      prompt: [{ type: "text", text: "test" }],
    });

    expect(response.stopReason).toBe("end_turn");
    expect(response.usage?.inputTokens).toBe(promptResult.usage.input_tokens);
    expect(response.usage?.outputTokens).toBe(promptResult.usage.output_tokens);
  });

  it("settles a no-echo command result (e.g. /compact) by promoting the head turn", async () => {
    // Regression: /compact never echoes a user message carrying the prompt's
    // uuid (its only user messages are the generated summary and a
    // <local-command-stdout> replay), so the turn is never activated by an echo.
    // Its result must still settle the turn — otherwise prompt() hangs forever.
    const agent = createMockAgent();
    let releaseIdle!: () => void;
    const idleGate = new Promise<void>((resolve) => (releaseIdle = resolve));

    injectGeneratorSession(agent, (input) => {
      async function* messageGenerator() {
        const iter = input[Symbol.asyncIterator]();
        await iter.next(); // consume the pushed message but do NOT echo its uuid
        yield {
          type: "system",
          subtype: "status",
          status: "compacting",
          session_id: "test-session",
        };
        yield createResultMessage({ subtype: "success", stop_reason: "end_turn", is_error: false });
        // Hold the stream open past the result so the turn must settle at the
        // result itself, not via the stream-end (done) fallback or a real idle.
        await idleGate;
        yield { type: "system", subtype: "session_state_changed", state: "idle" };
      }
      return messageGenerator();
    });

    const response = await agent.prompt({
      sessionId: "test-session",
      prompt: [{ type: "text", text: "/compact" }],
    });
    expect(response.stopReason).toBe("end_turn");

    releaseIdle();
    await agent.sessions["test-session"]?.consumer;
  });

  it("resolves at the terminal result without waiting for a lagging idle (issue #773)", async () => {
    const agent = createMockAgent();
    const input = new Pushable<any>();
    // The SDK's trailing `idle` can lag far behind the result while it flushes
    // held-back results / drains background agents. prompt() must resolve from
    // the result so the composer unlocks immediately, not block until idle.
    let releaseIdle!: () => void;
    const idleGate = new Promise<void>((resolve) => (releaseIdle = resolve));
    let idleYielded = false;

    async function* messageGenerator() {
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
      yield createResultMessage({ subtype: "success", stop_reason: "end_turn", is_error: false });
      await idleGate;
      idleYielded = true;
      yield { type: "system", subtype: "session_state_changed", state: "idle" };
    }

    agent.sessions["test-session"] = mockSessionState({
      query: wrapQuery(messageGenerator()),
      input,
    });

    const response = await agent.prompt({
      sessionId: "test-session",
      prompt: [{ type: "text", text: "test" }],
    });

    // Resolved from the result while idle is still gated.
    expect(response.stopReason).toBe("end_turn");
    expect(idleYielded).toBe(false);

    // Releasing the idle lets the consumer drain cleanly without double-settling.
    releaseIdle();
    await agent.sessions["test-session"]?.consumer;
  });

  it("forwards background output that arrives after the turn resolves (issue #679)", async () => {
    const sessionUpdates: any[] = [];
    const mockClient = {
      sessionUpdate: async (u: any) => {
        sessionUpdates.push(u);
      },
    } as unknown as AgentSideConnection;
    const agent = new ClaudeAcpAgent(mockClient, { log: () => {}, error: () => {} });

    const input = new Pushable<any>();
    async function* messageGenerator() {
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
      // The user turn completes here — prompt() resolves — and the turn goes
      // idle. The old per-prompt loop returned at this idle, so anything after
      // it was not consumed until the next prompt (issue #679).
      yield createResultMessage({ subtype: "success", stop_reason: "end_turn", is_error: false });
      yield { type: "system", subtype: "session_state_changed", state: "idle" };
      // Between-turn background output: a top-level assistant message arriving
      // with no prompt awaiting. The persistent consumer must still forward it.
      yield {
        type: "assistant",
        parent_tool_use_id: null,
        uuid: randomUUID(),
        session_id: "test-session",
        message: {
          role: "assistant",
          model: "claude-sonnet-4-5",
          stop_reason: "end_turn",
          usage: {
            input_tokens: 1,
            output_tokens: 1,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
          content: [{ type: "text", text: "between-turn background note" }],
        },
      };
    }

    agent.sessions["test-session"] = mockSessionState({
      query: wrapQuery(messageGenerator()),
      input,
    });

    const response = await agent.prompt({
      sessionId: "test-session",
      prompt: [{ type: "text", text: "test" }],
    });
    expect(response.stopReason).toBe("end_turn");

    // Drain the consumer so the post-resolution message is processed.
    await agent.sessions["test-session"]?.consumer;

    const chunkTexts = sessionUpdates
      .filter((u) => u.update?.sessionUpdate === "agent_message_chunk")
      .map((u) => u.update.content?.text);
    expect(chunkTexts).toContain("between-turn background note");
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

  it("forwards SDKAssistantMessage.error as structured data on internal errors", async () => {
    const agent = createMockAgent();
    const assistantMessage: SDKAssistantMessage = {
      type: "assistant",
      parent_tool_use_id: null,
      error: "rate_limit",
      uuid: randomUUID(),
      session_id: "test-session",
      message: {
        id: "msg-1",
        type: "message",
        role: "assistant",
        container: null,
        model: "claude-sonnet-4-20250514",
        content: [],
        stop_reason: "stop_sequence",
        stop_sequence: null,
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
          server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
          service_tier: null,
          cache_creation: {
            ephemeral_1h_input_tokens: 0,
            ephemeral_5m_input_tokens: 0,
          },
        } as any,
      } as any,
    };

    injectSession(agent, [
      assistantMessage,
      createResultMessage({
        subtype: "success",
        stop_reason: "end_turn",
        is_error: true,
        result: "You've hit your limit · resets 8pm",
      }),
    ]);

    const err = await agent
      .prompt({
        sessionId: "test-session",
        prompt: [{ type: "text", text: "test" }],
      })
      .then(
        () => null,
        (e) => e,
      );

    expect(err).not.toBeNull();
    expect((err as { data: unknown }).data).toEqual({ errorKind: "rate_limit" });
  });

  it("omits errorKind data when no SDKAssistantMessage.error was observed", async () => {
    const agent = createMockAgent();
    injectSession(agent, [
      createResultMessage({
        subtype: "success",
        stop_reason: "end_turn",
        is_error: true,
        result: "Something went wrong",
      }),
    ]);

    const err = await agent
      .prompt({
        sessionId: "test-session",
        prompt: [{ type: "text", text: "test" }],
      })
      .then(
        () => null,
        (e) => e,
      );

    expect(err).not.toBeNull();
    expect((err as { data: unknown }).data).toBeUndefined();
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
      abortController: new AbortController(),
      emitRawSDKMessages: false,
      contextWindowSize: 200000,
      taskState: new Map(),
      toolUseCache: {},
      messageIdToUuid: new Map(),
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

describe("session/delete", () => {
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
      abortController: new AbortController(),
      emitRawSDKMessages: false,
      contextWindowSize: 200000,
      taskState: new Map(),
      toolUseCache: {},
      messageIdToUuid: new Map(),
    };
    return agent.sessions[sessionId]!;
  }

  beforeEach(() => {
    vi.mocked(deleteSession).mockReset();
    vi.mocked(deleteSession).mockResolvedValue(undefined);
  });

  it("tears down the active session and deletes it from disk", async () => {
    const agent = createMockAgent();
    const session = injectSession(agent, "session-1");

    const result = await agent.deleteSession({ sessionId: "session-1" });

    expect(result).toEqual({});
    expect(agent.sessions["session-1"]).toBeUndefined();
    expect(session.query.interrupt).toHaveBeenCalled();
    expect(session.settingsManager.dispose).toHaveBeenCalled();
    expect(session.abortController.signal.aborted).toBe(true);
    expect(deleteSession).toHaveBeenCalledWith("session-1");
  });

  it("deletes a session from disk that is not currently active", async () => {
    const agent = createMockAgent();

    const result = await agent.deleteSession({ sessionId: "not-active" });

    expect(result).toEqual({});
    expect(deleteSession).toHaveBeenCalledWith("not-active");
  });

  it("propagates errors from the SDK delete call", async () => {
    const agent = createMockAgent();
    vi.mocked(deleteSession).mockRejectedValueOnce(new Error("Session not found on disk"));

    await expect(agent.deleteSession({ sessionId: "missing" })).rejects.toThrow(
      "Session not found on disk",
    );
  });

  it("does not affect other sessions when deleting one", async () => {
    const agent = createMockAgent();
    injectSession(agent, "session-a");
    injectSession(agent, "session-b");

    await agent.deleteSession({ sessionId: "session-a" });

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
      abortController: new AbortController(),
      emitRawSDKMessages: false,
      contextWindowSize: 200000,
      taskState: new Map(),
      toolUseCache: {},
      messageIdToUuid: new Map(),
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
    agent.sessions["test-session"] = mockSessionState({
      query: wrapQuery(messageGenerator()),
      input,
    });
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

    await (agent as any).applyConfigOptionValue(
      "test-session",
      session,
      "model",
      "claude-opus-4-6-1m",
    );
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
    await (agent as any).applyConfigOptionValue(
      "test-session",
      session,
      "model",
      "claude-sonnet-4-6",
    );

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

  it("compact_boundary uses authoritative getContextUsage for used, keeps session window for size", async () => {
    const { agent, updates } = createMockAgentWithCapture();
    injectSession(agent, [
      { type: "system", subtype: "compact_boundary", session_id: "test-session" },
      { type: "system", subtype: "session_state_changed", state: "idle" },
    ]);
    const session = agent.sessions["test-session"];
    // A 1M window learned earlier (e.g. from modelUsage) must survive compaction
    // — getContextUsage's window field under-reports it, so we don't use it.
    session.contextWindowSize = 1000000;
    (session.query as any).getContextUsage = vi
      .fn()
      .mockResolvedValue({ totalTokens: 12345, rawMaxTokens: 200000 });

    await agent.prompt({ sessionId: "test-session", prompt: [{ type: "text", text: "test" }] });

    const usageUpdate = updates.find((u: any) => u.update?.sessionUpdate === "usage_update");
    expect(usageUpdate).toBeDefined();
    expect(usageUpdate.update.used).toBe(12345);
    // size stays at the session's learned window, NOT getContextUsage's value.
    expect(usageUpdate.update.size).toBe(1000000);
    expect(session.contextWindowSize).toBe(1000000);
  });

  it("compact_boundary falls back to used:0 when getContextUsage fails", async () => {
    const { agent, updates } = createMockAgentWithCapture();
    injectSession(agent, [
      { type: "system", subtype: "compact_boundary", session_id: "test-session" },
      { type: "system", subtype: "session_state_changed", state: "idle" },
    ]);
    const session = agent.sessions["test-session"];
    session.contextWindowSize = 200000;
    (session.query as any).getContextUsage = vi.fn().mockRejectedValue(new Error("boom"));

    await agent.prompt({ sessionId: "test-session", prompt: [{ type: "text", text: "test" }] });

    const usageUpdate = updates.find((u: any) => u.update?.sessionUpdate === "usage_update");
    expect(usageUpdate).toBeDefined();
    expect(usageUpdate.update.used).toBe(0);
    expect(usageUpdate.update.size).toBe(200000);
    expect(session.contextWindowSize).toBe(200000);
  });
});

describe("assembled assistant text fallback", () => {
  const ZERO_USAGE = {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  };

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

  function messageStart(apiId: string) {
    return {
      type: "stream_event" as const,
      parent_tool_use_id: null,
      uuid: randomUUID(),
      session_id: "test-session",
      event: {
        type: "message_start" as const,
        message: { id: apiId, model: "claude-sonnet-4-20250514", usage: ZERO_USAGE },
      },
    };
  }

  function textDelta(text: string) {
    return {
      type: "stream_event" as const,
      parent_tool_use_id: null,
      uuid: randomUUID(),
      session_id: "test-session",
      event: {
        type: "content_block_delta" as const,
        index: 0,
        delta: { type: "text_delta" as const, text },
      },
    };
  }

  function assistantMessage(apiId: string, content: any[], parentToolUseId: string | null = null) {
    return {
      type: "assistant" as const,
      parent_tool_use_id: parentToolUseId,
      uuid: randomUUID(),
      session_id: "test-session",
      message: {
        id: apiId,
        role: "assistant" as const,
        model: "claude-sonnet-4-20250514",
        content,
        usage: ZERO_USAGE,
      },
    };
  }

  function result() {
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
      total_cost_usd: 0,
      usage: ZERO_USAGE,
      modelUsage: {},
      permission_denials: [],
      uuid: randomUUID(),
      session_id: "test-session",
    };
  }

  const idle = { type: "system", subtype: "session_state_changed", state: "idle" };

  function injectSession(agent: ClaudeAcpAgent, messages: any[]) {
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
    agent.sessions["test-session"] = mockSessionState({
      query: wrapQuery(messageGenerator()),
      input,
    });
  }

  // Like injectSession, but the user-message echo is yielded at the position of
  // the "ECHO" sentinel in `messages` rather than always first — so a test can
  // reproduce the production ordering where the assistant stream arrives before
  // the SDK replays the user message.
  function injectSessionEchoAt(agent: ClaudeAcpAgent, messages: any[]) {
    const input = new Pushable<any>();
    async function* messageGenerator() {
      const iter = input[Symbol.asyncIterator]();
      const { value: userMessage } = await iter.next();
      for (const m of messages) {
        if (m === "ECHO") {
          yield {
            type: "user",
            message: userMessage.message,
            parent_tool_use_id: null,
            uuid: userMessage.uuid,
            session_id: "test-session",
            isReplay: true,
          };
        } else {
          yield m;
        }
      }
    }
    agent.sessions["test-session"] = mockSessionState({
      query: wrapQuery(messageGenerator()),
      input,
    });
  }

  function messageChunkTexts(updates: any[]): string[] {
    return updates
      .filter((u) => u.update?.sessionUpdate === "agent_message_chunk")
      .map((u) => u.update.content.text);
  }

  function thoughtChunkTexts(updates: any[]): string[] {
    return updates
      .filter((u) => u.update?.sessionUpdate === "agent_thought_chunk")
      .map((u) => u.update.content.text);
  }

  it("emits the assembled text when no content_block_delta was streamed", async () => {
    const { agent, updates } = createMockAgentWithCapture();
    // Gateway delivers a fully assembled message with no preceding deltas.
    injectSession(agent, [
      assistantMessage("msg-no-stream", [{ type: "text", text: "the final answer" }]),
      result(),
      idle,
    ]);

    await agent.prompt({ sessionId: "test-session", prompt: [{ type: "text", text: "hi" }] });

    expect(messageChunkTexts(updates)).toEqual(["the final answer"]);
  });

  it("does not re-emit text already streamed via content_block_delta", async () => {
    const { agent, updates } = createMockAgentWithCapture();
    // Normal streaming: deltas arrive, then the consolidated message repeats them.
    injectSession(agent, [
      messageStart("msg-streamed"),
      textDelta("hello "),
      textDelta("world"),
      assistantMessage("msg-streamed", [{ type: "text", text: "hello world" }]),
      result(),
      idle,
    ]);

    await agent.prompt({ sessionId: "test-session", prompt: [{ type: "text", text: "hi" }] });

    // Only the two streamed deltas — the assembled block is filtered out.
    expect(messageChunkTexts(updates)).toEqual(["hello ", "world"]);
  });

  it("dedupes streamed text even when the stream arrives before the user echo", async () => {
    const { agent, updates } = createMockAgentWithCapture();
    // Production ordering: the SDK emits the assistant's stream events before it
    // replays the user message that activates the turn. The streamed-id tracking
    // must survive activation, or the consolidated block is re-emitted as a
    // duplicate (regression from the persistent-consumer rework).
    injectSessionEchoAt(agent, [
      messageStart("msg-streamed"),
      textDelta("hello "),
      textDelta("world"),
      "ECHO",
      assistantMessage("msg-streamed", [{ type: "text", text: "hello world" }]),
      result(),
      idle,
    ]);

    await agent.prompt({ sessionId: "test-session", prompt: [{ type: "text", text: "hi" }] });

    // Still just the two streamed deltas — no duplicated assembled block.
    expect(messageChunkTexts(updates)).toEqual(["hello ", "world"]);
  });

  it("dedupes per block type: streamed text is dropped but an un-streamed thinking block in the same message is forwarded", async () => {
    const { agent, updates } = createMockAgentWithCapture();
    // Gateway streams the text live but delivers the thinking block only in the
    // assembled message (no thinking_delta). The dedupe must be per-type so the
    // thinking survives. This also makes the test non-vacuous: if the fallback
    // were removed (text/thinking always dropped) the thought chunk disappears.
    injectSession(agent, [
      messageStart("msg-mixed"),
      textDelta("streamed text"),
      assistantMessage("msg-mixed", [
        { type: "text", text: "streamed text" },
        { type: "thinking", thinking: "private reasoning" },
      ]),
      result(),
      idle,
    ]);

    await agent.prompt({ sessionId: "test-session", prompt: [{ type: "text", text: "hi" }] });

    // Streamed text appears once (delta only — assembled copy deduped).
    expect(messageChunkTexts(updates)).toEqual(["streamed text"]);
    // The un-streamed thinking block is forwarded despite text having streamed.
    expect(thoughtChunkTexts(updates)).toEqual(["private reasoning"]);
  });

  it("does not leak subagent assistant text into the top-level feed", async () => {
    const { agent, updates } = createMockAgentWithCapture();
    // Subagent assistant messages (parent_tool_use_id !== null) are never
    // streamed live; their text/thinking is internal to the tool call and must
    // stay filtered out, not surface as a fallback chunk.
    injectSession(agent, [
      assistantMessage(
        "msg-subagent",
        [{ type: "text", text: "subagent internal prose" }],
        "tool_use_1",
      ),
      result(),
      idle,
    ]);

    await agent.prompt({ sessionId: "test-session", prompt: [{ type: "text", text: "hi" }] });

    expect(messageChunkTexts(updates)).toEqual([]);
    expect(thoughtChunkTexts(updates)).toEqual([]);
  });

  it("forwards distinct blocks that a gateway splits across same-id messages", async () => {
    const { agent, updates } = createMockAgentWithCapture();
    // Observed with OpenAI-compatible gateways: one response id split into an
    // empty thinking block, then the real text — both with no deltas.
    injectSession(agent, [
      assistantMessage("msg-split", [{ type: "thinking", thinking: "" }]),
      assistantMessage("msg-split", [{ type: "text", text: "the real answer" }]),
      result(),
      idle,
    ]);

    await agent.prompt({ sessionId: "test-session", prompt: [{ type: "text", text: "hi" }] });

    // The text survives even though an earlier same-id message already triggered
    // the fallback for a different (thinking) block.
    expect(messageChunkTexts(updates)).toEqual(["the real answer"]);
    // The empty thinking block carries nothing and must not produce a stray
    // empty thought chunk.
    expect(thoughtChunkTexts(updates)).toEqual([]);
  });

  it("re-forwards a block a gateway re-delivers (no content-keyed dedupe)", async () => {
    const { agent, updates } = createMockAgentWithCapture();
    // The fallback intentionally keys only on whether the id streamed live, not
    // on block content — so a gateway re-delivering the same assembled block
    // emits it twice. This is the accepted, cosmetic tradeoff for not caching
    // every fallback block's full text; see `streamedTextMessageIds`.
    injectSession(agent, [
      assistantMessage("msg-dup", [{ type: "text", text: "answer" }]),
      assistantMessage("msg-dup", [{ type: "text", text: "answer" }]),
      result(),
      idle,
    ]);

    await agent.prompt({ sessionId: "test-session", prompt: [{ type: "text", text: "hi" }] });

    expect(messageChunkTexts(updates)).toEqual(["answer", "answer"]);
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
    emitRawSDKMessages: boolean | SDKMessageFilter[],
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
    agent.sessions["test-session"] = mockSessionState({
      query: wrapQuery(messageGenerator()),
      input,
      emitRawSDKMessages,
    });
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
    // prompt() resolves at the turn's result; the trailing idle is forwarded by
    // the consumer afterward, so wait for it to drain before asserting.
    await agent.sessions["test-session"]?.consumer;

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

  it("filter by origin kind only emits matching results", async () => {
    const { agent, extNotifications } = createMockAgentWithExtNotification();
    injectSession(
      agent,
      [
        { ...createResultMessage(), origin: { kind: "channel", server: "acp" } },
        { ...createResultMessage(), origin: { kind: "task-notification" } },
        { type: "system", subtype: "session_state_changed", state: "idle" },
      ],
      [{ type: "result", origin: "task-notification" }],
    );

    await agent.prompt({ sessionId: "test-session", prompt: [{ type: "text", text: "test" }] });
    // The task-notification result arrives after the user-turn result that
    // resolves prompt(); wait for the consumer to drain it before asserting.
    await agent.sessions["test-session"]?.consumer;

    const sdkMessages = extNotifications.filter((n) => n.method === "_claude/sdkMessage");
    expect(sdkMessages).toHaveLength(1);
    expect(sdkMessages[0].params.message.origin.kind).toBe("task-notification");
  });

  it("filter without origin matches results regardless of origin", async () => {
    const { agent, extNotifications } = createMockAgentWithExtNotification();
    injectSession(
      agent,
      [
        { ...createResultMessage(), origin: { kind: "channel", server: "acp" } },
        { ...createResultMessage(), origin: { kind: "task-notification" } },
        { type: "system", subtype: "session_state_changed", state: "idle" },
      ],
      [{ type: "result" }],
    );

    await agent.prompt({ sessionId: "test-session", prompt: [{ type: "text", text: "test" }] });
    // The second (task-notification) result arrives after the one that resolves
    // prompt(); wait for the consumer to drain it before asserting.
    await agent.sessions["test-session"]?.consumer;

    const sdkMessages = extNotifications.filter((n) => n.method === "_claude/sdkMessage");
    expect(sdkMessages).toHaveLength(2);
  });
});

describe("result origin handling", () => {
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
    agent.sessions["test-session"] = mockSessionState({
      query: wrapQuery(messageGenerator()),
      input,
    });
  }

  function createAssistantMessage() {
    return {
      type: "assistant" as const,
      parent_tool_use_id: null,
      uuid: randomUUID(),
      session_id: "test-session",
      message: {
        model: "claude-sonnet-4-6",
        content: [{ type: "text", text: "hello" }],
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
      },
    };
  }

  function createResult(overrides: Record<string, unknown> = {}) {
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
      modelUsage: {},
      permission_denials: [],
      uuid: randomUUID(),
      session_id: "test-session",
      ...overrides,
    };
  }

  it("forwards origin in usage_update _meta", async () => {
    const { agent, updates } = createMockAgentWithCapture();
    injectSession(agent, [
      createAssistantMessage(),
      createResult({ origin: { kind: "channel", server: "acp" } }),
      { type: "system", subtype: "session_state_changed", state: "idle" },
    ]);

    await agent.prompt({ sessionId: "test-session", prompt: [{ type: "text", text: "test" }] });

    const usageUpdate = updates.find((u: any) => u.update?.sessionUpdate === "usage_update");
    expect(usageUpdate).toBeDefined();
    expect(usageUpdate.update._meta).toEqual({
      "_claude/origin": { kind: "channel", server: "acp" },
    });
  });

  it("omits _meta when origin is absent", async () => {
    const { agent, updates } = createMockAgentWithCapture();
    injectSession(agent, [
      createAssistantMessage(),
      createResult(),
      { type: "system", subtype: "session_state_changed", state: "idle" },
    ]);

    await agent.prompt({ sessionId: "test-session", prompt: [{ type: "text", text: "test" }] });

    const usageUpdate = updates.find((u: any) => u.update?.sessionUpdate === "usage_update");
    expect(usageUpdate).toBeDefined();
    expect(usageUpdate.update._meta).toBeUndefined();
  });

  it("task-notification result with max_tokens does not override the user-turn stopReason", async () => {
    const { agent } = createMockAgentWithCapture();
    injectSession(agent, [
      createAssistantMessage(),
      // User-turn result completes normally
      createResult({ origin: { kind: "channel", server: "acp" } }),
      // Task-notification followup hits max_tokens — must not bleed into the user's stopReason
      createResult({
        stop_reason: "max_tokens",
        origin: { kind: "task-notification" },
      }),
      { type: "system", subtype: "session_state_changed", state: "idle" },
    ]);

    const response = await agent.prompt({
      sessionId: "test-session",
      prompt: [{ type: "text", text: "test" }],
    });

    expect(response.stopReason).toBe("end_turn");
  });

  it("user-prompted result with max_tokens still sets stopReason", async () => {
    const { agent } = createMockAgentWithCapture();
    injectSession(agent, [
      createAssistantMessage(),
      createResult({
        stop_reason: "max_tokens",
        origin: { kind: "channel", server: "acp" },
      }),
      { type: "system", subtype: "session_state_changed", state: "idle" },
    ]);

    const response = await agent.prompt({
      sessionId: "test-session",
      prompt: [{ type: "text", text: "test" }],
    });

    expect(response.stopReason).toBe("max_tokens");
  });
});

describe("memory_recall handling", () => {
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
    agent.sessions["test-session"] = mockSessionState({
      query: wrapQuery(messageGenerator()),
      input,
    });
  }

  function createResult() {
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

  it("emits a synthetic tool_call for select mode with one location per memory", async () => {
    const { agent, updates } = createMockAgentWithCapture();
    const recallUuid = randomUUID();
    injectSession(agent, [
      {
        type: "system",
        subtype: "memory_recall",
        mode: "select",
        memories: [
          { path: "/Users/test/.claude/memory/user_role.md", scope: "personal" },
          { path: "/Users/test/.claude/memory/feedback_testing.md", scope: "personal" },
          { path: "/Users/test/.claude/team/conventions.md", scope: "team" },
        ],
        uuid: recallUuid,
        session_id: "test-session",
      },
      createResult(),
      { type: "system", subtype: "session_state_changed", state: "idle" },
    ]);

    await agent.prompt({ sessionId: "test-session", prompt: [{ type: "text", text: "hi" }] });

    const toolCall = updates.find((u: any) => u.update?.sessionUpdate === "tool_call");
    expect(toolCall).toBeDefined();
    expect(toolCall.update).toMatchObject({
      sessionUpdate: "tool_call",
      toolCallId: recallUuid,
      title: "Recalled 3 memories",
      kind: "read",
      status: "completed",
      locations: [
        { path: "/Users/test/.claude/memory/user_role.md" },
        { path: "/Users/test/.claude/memory/feedback_testing.md" },
        { path: "/Users/test/.claude/team/conventions.md" },
      ],
      _meta: {
        claudeCode: { toolName: "memory_recall", toolResponse: { mode: "select" } },
      },
    });
    expect(toolCall.update.content).toBeUndefined();
  });

  it("uses singular 'memory' in title when exactly one entry", async () => {
    const { agent, updates } = createMockAgentWithCapture();
    injectSession(agent, [
      {
        type: "system",
        subtype: "memory_recall",
        mode: "select",
        memories: [{ path: "/Users/test/.claude/memory/user_role.md", scope: "personal" }],
        uuid: randomUUID(),
        session_id: "test-session",
      },
      createResult(),
      { type: "system", subtype: "session_state_changed", state: "idle" },
    ]);

    await agent.prompt({ sessionId: "test-session", prompt: [{ type: "text", text: "hi" }] });

    const toolCall = updates.find((u: any) => u.update?.sessionUpdate === "tool_call");
    expect(toolCall.update.title).toBe("Recalled 1 memory");
  });

  it("emits synthesis content and no locations for synthesize mode", async () => {
    const { agent, updates } = createMockAgentWithCapture();
    injectSession(agent, [
      {
        type: "system",
        subtype: "memory_recall",
        mode: "synthesize",
        memories: [
          {
            path: "<synthesis:/Users/test/.claude/memory>",
            scope: "personal",
            content: "The user prefers terse responses and writes Go.",
          },
        ],
        uuid: randomUUID(),
        session_id: "test-session",
      },
      createResult(),
      { type: "system", subtype: "session_state_changed", state: "idle" },
    ]);

    await agent.prompt({ sessionId: "test-session", prompt: [{ type: "text", text: "hi" }] });

    const toolCall = updates.find((u: any) => u.update?.sessionUpdate === "tool_call");
    expect(toolCall).toBeDefined();
    expect(toolCall.update.title).toBe("Recalled synthesized memory");
    expect(toolCall.update.locations).toBeUndefined();
    expect(toolCall.update.content).toEqual([
      {
        type: "content",
        content: { type: "text", text: "The user prefers terse responses and writes Go." },
      },
    ]);
    expect(toolCall.update._meta.claudeCode.toolResponse).toEqual({ mode: "synthesize" });
  });
});

describe("post-error recovery", () => {
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

  // Two-turn generator: turn 1 yields the caller-supplied `firstTurn`
  // messages (including a trailing idle that the drain must consume).
  // Turn 2 yields a clean success + idle, used to verify the next prompt
  // sees real messages rather than the stale idle.
  function injectTwoTurnSession(agent: ClaudeAcpAgent, firstTurn: unknown[]) {
    const input = new Pushable<any>();
    const interrupt = vi.fn(async () => {});
    const close = vi.fn();
    async function* messageGenerator() {
      const iter = input[Symbol.asyncIterator]();

      const first = await iter.next();
      if (!first.done && first.value) {
        yield {
          type: "user",
          message: first.value.message,
          parent_tool_use_id: null,
          uuid: first.value.uuid,
          session_id: "test-session",
          isReplay: true,
        };
      }
      yield* firstTurn;

      const second = await iter.next();
      if (!second.done && second.value) {
        yield {
          type: "user",
          message: second.value.message,
          parent_tool_use_id: null,
          uuid: second.value.uuid,
          session_id: "test-session",
          isReplay: true,
        };
      }
      yield createResultMessage({ subtype: "success", stop_reason: null, is_error: false });
      yield { type: "system", subtype: "session_state_changed", state: "idle" };
    }
    const gen = Object.assign(messageGenerator(), { interrupt, close });
    agent.sessions["test-session"] = {
      query: gen as any,
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
      abortController: new AbortController(),
      emitRawSDKMessages: false,
      contextWindowSize: 200000,
      taskState: new Map(),
      toolUseCache: {},
      messageIdToUuid: new Map(),
    };
    return { interrupt };
  }

  it("drains a failed turn's trailing idle so the next prompt is not short-circuited", async () => {
    const agent = createMockAgent();
    injectTwoTurnSession(agent, [
      createResultMessage({
        subtype: "success",
        stop_reason: "end_turn",
        is_error: true,
        result: "boom",
      }),
      // Trailing idle from the failed turn. The persistent consumer keeps
      // reading and absorbs this idle (no active turn to settle), so the next
      // prompt starts clean rather than consuming a stale idle (issue #654).
      { type: "system", subtype: "session_state_changed", state: "idle" },
    ]);

    await expect(
      agent.prompt({
        sessionId: "test-session",
        prompt: [{ type: "text", text: "first" }],
      }),
    ).rejects.toThrow();

    const second = await agent.prompt({
      sessionId: "test-session",
      prompt: [{ type: "text", text: "second" }],
    });
    expect(second.stopReason).toBe("end_turn");
    expect(second.usage?.inputTokens).toBe(10);
    expect(second.usage?.outputTokens).toBe(5);
  });

  it("rejects only the failed turn; a queued prompt still runs", async () => {
    const agent = createMockAgent();
    injectTwoTurnSession(agent, [
      createResultMessage({
        subtype: "success",
        stop_reason: "end_turn",
        is_error: true,
        result: "boom",
      }),
      { type: "system", subtype: "session_state_changed", state: "idle" },
    ]);

    // With a persistent consumer a turn-level error no longer poisons the
    // stream, so a prompt queued behind the failing one runs to completion
    // instead of being cancelled.
    const first = agent.prompt({
      sessionId: "test-session",
      prompt: [{ type: "text", text: "first" }],
    });
    const second = agent.prompt({
      sessionId: "test-session",
      prompt: [{ type: "text", text: "second" }],
    });

    await expect(first).rejects.toThrow();
    await expect(second).resolves.toEqual(expect.objectContaining({ stopReason: "end_turn" }));
  });

  it("hands off to a queued prompt when the next turn starts without a trailing idle", async () => {
    const agent = createMockAgent();
    // turn 1 produces a result but NO trailing idle — the SDK goes straight to
    // echoing turn 2. The consumer must settle turn 1 (end_turn) on that echo
    // (the hand-off path) rather than letting it hang until turn 2's idle.
    injectTwoTurnSession(agent, [
      createResultMessage({ subtype: "success", stop_reason: "end_turn", is_error: false }),
    ]);

    const first = agent.prompt({
      sessionId: "test-session",
      prompt: [{ type: "text", text: "first" }],
    });
    const second = agent.prompt({
      sessionId: "test-session",
      prompt: [{ type: "text", text: "second" }],
    });

    await expect(first).resolves.toEqual(expect.objectContaining({ stopReason: "end_turn" }));
    await expect(second).resolves.toEqual(expect.objectContaining({ stopReason: "end_turn" }));
  });

  it("does not let a settled turn's lagging idle resolve the next turn early (issue #773 race)", async () => {
    const agent = createMockAgent();
    injectGeneratorSession(agent, (input) => {
      async function* messageGenerator() {
        const iter = input[Symbol.asyncIterator]();
        const u1 = await iter.next();
        yield userEcho(u1.value);
        // Turn 1's terminal result settles its prompt() immediately (#773).
        yield createResultMessage({ subtype: "success", stop_reason: "end_turn", is_error: false });
        // Turn 2 is echoed and activated BEFORE turn 1's trailing idle arrives.
        const u2 = await iter.next();
        yield userEcho(u2.value);
        // This lagging idle belongs to turn 1, not turn 2. It must be absorbed,
        // not used to settle the freshly-activated turn 2 (which would resolve
        // turn 2 with end_turn and the reset, zero usage before its result).
        yield { type: "system", subtype: "session_state_changed", state: "idle" };
        // Turn 2's own result is what should settle it, carrying real usage.
        yield createResultMessage({ subtype: "success", stop_reason: "end_turn", is_error: false });
        yield { type: "system", subtype: "session_state_changed", state: "idle" };
      }
      return messageGenerator();
    });

    const first = await agent.prompt({
      sessionId: "test-session",
      prompt: [{ type: "text", text: "first" }],
    });
    expect(first.stopReason).toBe("end_turn");

    const second = await agent.prompt({
      sessionId: "test-session",
      prompt: [{ type: "text", text: "second" }],
    });
    expect(second.stopReason).toBe("end_turn");
    // If turn 1's lagging idle had settled turn 2, it would have resolved with
    // the reset (zero) usage before turn 2's result accumulated; turn 2's real
    // result carries 10 input tokens.
    expect(second.usage?.inputTokens).toBe(10);
  });

  it("rejects later prompts after the query stream errors instead of hanging on a dead consumer", async () => {
    const agent = createMockAgent();
    injectGeneratorSession(agent, (input) => {
      async function* messageGenerator() {
        const iter = input[Symbol.asyncIterator]();
        const u1 = await iter.next();
        yield userEcho(u1.value);
        yield createResultMessage({ subtype: "success", stop_reason: "end_turn", is_error: false });
        // The next prompt drives the stream, which then errors with a
        // transport failure that is NOT a process death.
        await iter.next();
        throw new Error("stream decode error");
      }
      return messageGenerator();
    });

    const first = await agent.prompt({
      sessionId: "test-session",
      prompt: [{ type: "text", text: "first" }],
    });
    expect(first.stopReason).toBe("end_turn");

    // The in-flight prompt rejects when the stream errors rather than hanging.
    await expect(
      agent.prompt({ sessionId: "test-session", prompt: [{ type: "text", text: "second" }] }),
    ).rejects.toThrow();

    // A subsequent prompt rejects up front (the dead consumer is not restarted
    // on the exhausted stream, which would otherwise hang or fake an end_turn).
    await expect(
      agent.prompt({ sessionId: "test-session", prompt: [{ type: "text", text: "third" }] }),
    ).rejects.toThrow(/start a new session/);

    // The broken stream's resources are released even though the session husk
    // stays in the map for the clear error above: the subprocess/query is closed
    // and the settings watchers disposed. The abortController is left alone — it
    // may be client-owned, so we don't abort it on a spontaneous stream end (only
    // teardownSession does, on explicit close).
    const session = agent.sessions["test-session"];
    expect(session.query.close).toHaveBeenCalled();
    expect(session.settingsManager.dispose).toHaveBeenCalled();
    expect(session.abortController.signal.aborted).toBe(false);
  });

  // Poll a condition across microtask/timer turns, so a test can wait for the
  // persistent consumer to reach a particular state (e.g. a turn became active,
  // or the stream closed) without coupling to its internal scheduling.
  const waitFor = async (cond: () => boolean) => {
    for (let i = 0; i < 200; i++) {
      if (cond()) return;
      await new Promise((r) => setTimeout(r, 0));
    }
    throw new Error("waitFor timed out");
  };

  it("settles a cancelled turn as 'cancelled' even when the next prompt's echo arrives first", async () => {
    const agent = createMockAgent();
    injectGeneratorSession(agent, (input) => {
      async function* messageGenerator() {
        const iter = input[Symbol.asyncIterator]();
        const u1 = await iter.next();
        yield userEcho(u1.value); // turn 1 active
        // Turn 1's trailing idle never arrives (the cancel's interrupt is a
        // no-op here); instead the SDK echoes turn 2 first, forcing the hand-off
        // path to settle turn 1.
        const u2 = await iter.next();
        yield userEcho(u2.value); // turn 2's echo hands off turn 1
        yield createResultMessage({ subtype: "success", stop_reason: "end_turn", is_error: false });
        yield { type: "system", subtype: "session_state_changed", state: "idle" };
      }
      return messageGenerator();
    });

    const first = agent.prompt({
      sessionId: "test-session",
      prompt: [{ type: "text", text: "first" }],
    });
    await waitFor(() => !!agent.sessions["test-session"]?.activeTurn);

    // Cancel turn 1 while it is the active turn, then send turn 2. Turn 2's echo
    // hands off turn 1 — which must settle "cancelled", not "end_turn".
    await agent.cancel({ sessionId: "test-session" });
    const second = agent.prompt({
      sessionId: "test-session",
      prompt: [{ type: "text", text: "second" }],
    });

    await expect(first).resolves.toEqual({ stopReason: "cancelled" });
    await expect(second).resolves.toEqual(expect.objectContaining({ stopReason: "end_turn" }));
  });

  it("ignores cancel() after the query stream has closed (no interrupt on a dead query)", async () => {
    const agent = createMockAgent();
    injectGeneratorSession(agent, (input) => {
      async function* messageGenerator() {
        const iter = input[Symbol.asyncIterator]();
        const u1 = await iter.next();
        yield userEcho(u1.value);
        yield createResultMessage({ subtype: "success", stop_reason: "end_turn", is_error: false });
        yield { type: "system", subtype: "session_state_changed", state: "idle" };
        // generator returns → done → closeQueryStream marks queryClosed.
      }
      return messageGenerator();
    });

    const first = await agent.prompt({
      sessionId: "test-session",
      prompt: [{ type: "text", text: "first" }],
    });
    expect(first.stopReason).toBe("end_turn");

    await waitFor(() => agent.sessions["test-session"]?.queryClosed === true);

    // cancel() must be a no-op and must NOT interrupt the finished query.
    await expect(agent.cancel({ sessionId: "test-session" })).resolves.toBeUndefined();
    expect(agent.sessions["test-session"].query.interrupt).not.toHaveBeenCalled();
    // A normal stream end closes the query but does NOT abort the (possibly
    // client-owned) abort controller — only explicit teardown does.
    expect(agent.sessions["test-session"].query.close).toHaveBeenCalled();
    expect(agent.sessions["test-session"].abortController.signal.aborted).toBe(false);
  });

  it("settles a turn that ends via the stream-done path even if releasing resources throws", async () => {
    const agent = createMockAgent();
    // The turn is activated by its echo but the stream then ends with NO terminal
    // result — so it settles in the consumer's `done` branch, not at a result.
    // settingsManager.dispose() throws during closeQueryStream; because the done
    // branch settles the turn BEFORE releasing resources, the prompt still
    // resolves end_turn rather than being rejected when the cleanup failure lands
    // in the consumer's catch (release-before-settle would reject it).
    injectGeneratorSession(
      agent,
      (input) => {
        async function* messageGenerator() {
          const iter = input[Symbol.asyncIterator]();
          const u1 = await iter.next();
          yield userEcho(u1.value);
          // generator returns → done (no result/idle) → done branch settles the
          // active turn, then closeQueryStream → dispose() throws.
        }
        return messageGenerator();
      },
      {
        settingsManager: {
          dispose: vi.fn(() => {
            throw new Error("dispose boom");
          }),
        },
      },
    );

    const response = await agent.prompt({
      sessionId: "test-session",
      prompt: [{ type: "text", text: "first" }],
    });
    expect(response.stopReason).toBe("end_turn");
  });

  it("rejects (not 'cancelled') a prompt enqueued after a cancel when the stream then ends", async () => {
    const agent = createMockAgent();
    let releaseEnd!: () => void;
    const endGate = new Promise<void>((resolve) => (releaseEnd = resolve));
    injectGeneratorSession(agent, (input) => {
      async function* messageGenerator() {
        const iter = input[Symbol.asyncIterator]();
        const u1 = await iter.next();
        yield userEcho(u1.value); // turn 1 active
        // Hold the stream open until the test has cancelled turn 1 and enqueued
        // turn 2, then end it WITHOUT ever echoing turn 2.
        await endGate;
      }
      return messageGenerator();
    });

    const first = agent.prompt({
      sessionId: "test-session",
      prompt: [{ type: "text", text: "first" }],
    });
    await waitFor(() => !!agent.sessions["test-session"]?.activeTurn);

    await agent.cancel({ sessionId: "test-session" });
    // Turn 2 is enqueued AFTER the cancel — it was not part of the cancellation.
    const second = agent.prompt({
      sessionId: "test-session",
      prompt: [{ type: "text", text: "second" }],
    });

    releaseEnd(); // stream ends -> done branch settles turn 1 + rejects turn 2

    await expect(first).resolves.toEqual({ stopReason: "cancelled" });
    await expect(second).rejects.toThrow(/start a new session/);
  });

  it("settles a no-echo command (/compact) submitted right after a cancel", async () => {
    // Regression: after cancelling turn 1, session.cancelled lingers until the
    // next activation. A /compact submitted next never echoes its uuid, so it
    // can only be settled by head-promotion — which the old `!session.cancelled`
    // gate blocked, hanging the prompt. The orphan-count gate promotes it (no
    // orphans are expected since the cancel removed no queued turns).
    const agent = createMockAgent();
    let releaseAfterCancel!: () => void;
    const afterCancel = new Promise<void>((resolve) => (releaseAfterCancel = resolve));
    injectGeneratorSession(agent, (input) => {
      async function* messageGenerator() {
        const iter = input[Symbol.asyncIterator]();
        const u1 = await iter.next();
        yield userEcho(u1.value); // turn 1 active
        await afterCancel; // wait until the test has cancelled turn 1
        yield { type: "system", subtype: "session_state_changed", state: "idle" }; // settles turn 1 cancelled
        await iter.next(); // /compact's pushed message — never echoed
        yield {
          type: "system",
          subtype: "status",
          status: "compacting",
          session_id: "test-session",
        };
        yield createResultMessage({ subtype: "success", stop_reason: "end_turn", is_error: false });
        yield { type: "system", subtype: "session_state_changed", state: "idle" };
      }
      return messageGenerator();
    });

    const first = agent.prompt({
      sessionId: "test-session",
      prompt: [{ type: "text", text: "first" }],
    });
    await waitFor(() => !!agent.sessions["test-session"]?.activeTurn);

    await agent.cancel({ sessionId: "test-session" });
    releaseAfterCancel();
    await expect(first).resolves.toEqual({ stopReason: "cancelled" });

    // session.cancelled is still true here (turn 1 settled, nothing re-activated).
    // The /compact result must still settle via head-promotion.
    const compact = await agent.prompt({
      sessionId: "test-session",
      prompt: [{ type: "text", text: "/compact" }],
    });
    expect(compact.stopReason).toBe("end_turn");
    await agent.sessions["test-session"]?.consumer;
  });

  it("skips the orphan result of a cancelled queued turn instead of misattributing it", async () => {
    // Turn 1 active, turn 2 queued. cancel() settles+removes turn 2 but its
    // message was already pushed, so the SDK still emits turn 2's result (an
    // orphan). That orphan must be SKIPPED — not promoted onto the next prompt —
    // so a later turn 3 resolves with its OWN usage, not the orphan's.
    const agent = createMockAgent();
    let afterCancelAndQueue!: () => void;
    const gate = new Promise<void>((resolve) => (afterCancelAndQueue = resolve));

    const orphanResult = createResultMessage({
      subtype: "success",
      stop_reason: "end_turn",
      is_error: false,
    });
    orphanResult.usage.input_tokens = 999; // distinct so misattribution is visible

    injectGeneratorSession(agent, (input) => {
      async function* messageGenerator() {
        const iter = input[Symbol.asyncIterator]();
        const u1 = await iter.next();
        yield userEcho(u1.value); // turn 1 active
        await iter.next(); // turn 2's pushed message (will be cancelled+removed)
        await gate; // wait until the test cancels (removing turn 2) and queues turn 3
        yield { type: "system", subtype: "session_state_changed", state: "idle" }; // turn 1 settles cancelled
        yield orphanResult; // turn 2's orphan result — must be skipped, not promote turn 3
        const u3 = await iter.next();
        yield userEcho(u3.value); // turn 3 echo activates it
        yield createResultMessage({ subtype: "success", stop_reason: "end_turn", is_error: false }); // usage 10
        yield { type: "system", subtype: "session_state_changed", state: "idle" };
      }
      return messageGenerator();
    });

    const first = agent.prompt({
      sessionId: "test-session",
      prompt: [{ type: "text", text: "first" }],
    });
    await waitFor(() => !!agent.sessions["test-session"]?.activeTurn);
    const second = agent.prompt({
      sessionId: "test-session",
      prompt: [{ type: "text", text: "second" }],
    });
    await waitFor(() => (agent.sessions["test-session"]?.turnQueue?.length ?? 0) >= 2);

    await agent.cancel({ sessionId: "test-session" }); // removes turn 2 -> pendingOrphanResults = 1
    const third = agent.prompt({
      sessionId: "test-session",
      prompt: [{ type: "text", text: "third" }],
    });
    afterCancelAndQueue();

    await expect(first).resolves.toEqual({ stopReason: "cancelled" });
    await expect(second).resolves.toEqual({ stopReason: "cancelled" });
    const thirdResult = await third;
    expect(thirdResult.stopReason).toBe("end_turn");
    // Turn 3's own result carries 10 input tokens; the orphan's 999 must not leak.
    expect(thirdResult.usage?.inputTokens).toBe(10);
    await agent.sessions["test-session"]?.consumer;
  });

  it("drains the orphan count, then promotes a no-echo /compact while still cancelled", async () => {
    // The case that ONLY the orphan-count gate handles (the old `!cancelled`
    // gate would hang it): cancel removes a queued turn (count=1), its orphan
    // result drains the count to 0, and THEN a no-echo /compact result arrives
    // while session.cancelled is still true. The count is 0, so /compact is
    // promoted (and activating it clears `cancelled`) rather than skipped.
    const agent = createMockAgent();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));

    const orphanResult = createResultMessage({
      subtype: "success",
      stop_reason: "end_turn",
      is_error: false,
    });
    orphanResult.usage.input_tokens = 999;

    injectGeneratorSession(agent, (input) => {
      async function* messageGenerator() {
        const iter = input[Symbol.asyncIterator]();
        const u1 = await iter.next();
        yield userEcho(u1.value); // turn 1 active
        await iter.next(); // turn 2's pushed message (cancelled + removed)
        await gate; // wait until the test cancels (count=1) and sends /compact
        yield { type: "system", subtype: "session_state_changed", state: "idle" }; // turn 1 settles cancelled
        yield orphanResult; // turn 2's orphan — drains the count to 0
        await iter.next(); // /compact's pushed message — never echoes its uuid
        yield {
          type: "system",
          subtype: "status",
          status: "compacting",
          session_id: "test-session",
        };
        // session.cancelled is STILL true here; the drained count (0) lets this
        // promote rather than the `!cancelled` gate blocking it.
        yield createResultMessage({ subtype: "success", stop_reason: "end_turn", is_error: false });
        yield { type: "system", subtype: "session_state_changed", state: "idle" };
      }
      return messageGenerator();
    });

    const first = agent.prompt({
      sessionId: "test-session",
      prompt: [{ type: "text", text: "first" }],
    });
    await waitFor(() => !!agent.sessions["test-session"]?.activeTurn);
    const second = agent.prompt({
      sessionId: "test-session",
      prompt: [{ type: "text", text: "second" }],
    });
    await waitFor(() => (agent.sessions["test-session"]?.turnQueue?.length ?? 0) >= 2);

    await agent.cancel({ sessionId: "test-session" }); // removes turn 2 -> pendingOrphanResults = 1
    const compact = agent.prompt({
      sessionId: "test-session",
      prompt: [{ type: "text", text: "/compact" }],
    });
    release();

    await expect(first).resolves.toEqual({ stopReason: "cancelled" });
    await expect(second).resolves.toEqual({ stopReason: "cancelled" });
    const compactResult = await compact;
    expect(compactResult.stopReason).toBe("end_turn");
    // /compact settled with its OWN result (10 tokens), proving the orphan was
    // skipped — not promoted onto the /compact turn (which would leak its 999).
    expect(compactResult.usage?.inputTokens).toBe(10);
    await agent.sessions["test-session"]?.consumer;
  });
});

describe("session/cancel wedge recovery (issue #680)", () => {
  function createMockAgent() {
    const mockClient = {
      sessionUpdate: async () => {},
    } as unknown as AgentSideConnection;
    return new ClaudeAcpAgent(mockClient, { log: () => {}, error: () => {} });
  }

  // Generator that replays the prompt's user message and then blocks forever,
  // simulating the SDK wedged in a `TaskOutput { block: true }` poll against a
  // hung background task. `interrupt()` is a no-op — it does NOT unblock the
  // generator, matching the SDK behavior described in the issue.
  function injectWedgedSession(agent: ClaudeAcpAgent, opts: { interruptUnblocks?: boolean } = {}) {
    const input = new Pushable<any>();
    const interrupt = vi.fn(async () => {});
    const close = vi.fn();
    // A promise the wedged poll awaits. When `interruptUnblocks` is set, the
    // mocked interrupt() resolves it so the generator yields a trailing idle —
    // the normal, healthy interrupt path.
    let releaseBlock!: () => void;
    const blocked = new Promise<void>((resolve) => {
      releaseBlock = resolve;
    });
    if (opts.interruptUnblocks) {
      interrupt.mockImplementation(async () => {
        releaseBlock();
      });
    }

    async function* messageGenerator() {
      const iter = input[Symbol.asyncIterator]();
      const first = await iter.next();
      if (!first.done && first.value) {
        yield {
          type: "user",
          message: first.value.message,
          parent_tool_use_id: null,
          uuid: first.value.uuid,
          session_id: "test-session",
          isReplay: true,
        };
      }
      // Wedge: never yield again unless interrupt() releases us.
      await blocked;
      yield { type: "system", subtype: "session_state_changed", state: "idle" };
    }

    const gen = Object.assign(messageGenerator(), { interrupt, close });
    agent.sessions["test-session"] = {
      query: gen as any,
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
      abortController: new AbortController(),
      emitRawSDKMessages: false,
      contextWindowSize: 200000,
      taskState: new Map(),
      toolUseCache: {},
      messageIdToUuid: new Map(),
    };
    return { interrupt };
  }

  it("resolves the pending prompt with cancelled when the SDK never yields after interrupt", async () => {
    const agent = createMockAgent();
    // Shrink the grace period so the test doesn't wait the production default.
    agent.forceCancelGraceMs = 20;
    const { interrupt } = injectWedgedSession(agent);

    const promptPromise = agent.prompt({
      sessionId: "test-session",
      prompt: [{ type: "text", text: "run cargo test" }],
    });

    // Let the loop consume the replay and block on the wedged query.next().
    await new Promise((r) => setTimeout(r, 5));

    await agent.cancel({ sessionId: "test-session" });

    const response = await promptPromise;
    expect(response.stopReason).toBe("cancelled");
    expect(interrupt).toHaveBeenCalled();
  });

  it("returns cancelled through the normal idle path without waiting the grace period when interrupt works", async () => {
    const agent = createMockAgent();
    // Large grace so that if the test ever falls through to the backstop it
    // would hang past the test timeout instead of passing by accident.
    agent.forceCancelGraceMs = 60_000;
    const { interrupt } = injectWedgedSession(agent, { interruptUnblocks: true });

    const promptPromise = agent.prompt({
      sessionId: "test-session",
      prompt: [{ type: "text", text: "run cargo test" }],
    });

    await new Promise((r) => setTimeout(r, 5));

    await agent.cancel({ sessionId: "test-session" });

    const response = await promptPromise;
    expect(response.stopReason).toBe("cancelled");
    expect(interrupt).toHaveBeenCalled();
    // Backstop timer must have been cleared so it can't fire later.
    expect(agent.sessions["test-session"].forceCancelTimer).toBeUndefined();
  });

  it("does not arm the backstop when no prompt is running", async () => {
    const agent = createMockAgent();
    injectWedgedSession(agent);

    await agent.cancel({ sessionId: "test-session" });

    const session = agent.sessions["test-session"];
    expect(session.cancelled).toBe(true);
    expect(session.forceCancelTimer).toBeUndefined();
  });

  it("does not reset the force-cancel floor on repeated cancels", async () => {
    const agent = createMockAgent();
    // Long floor so the timer handle stays observable across both cancels.
    agent.forceCancelGraceMs = 60_000;
    injectWedgedSession(agent);

    const promptPromise = agent.prompt({
      sessionId: "test-session",
      prompt: [{ type: "text", text: "run cargo test" }],
    });
    await new Promise((r) => setTimeout(r, 5));

    await agent.cancel({ sessionId: "test-session" });
    const firstTimer = agent.sessions["test-session"].forceCancelTimer;
    expect(firstTimer).toBeDefined();

    await agent.cancel({ sessionId: "test-session" });
    // Same handle: the second cancel did not clear-and-rearm (which would push
    // the floor out). The deadline stays anchored to the first cancel.
    expect(agent.sessions["test-session"].forceCancelTimer).toBe(firstTimer);

    // Clean up the wedged prompt + long timer.
    await agent.closeSession({ sessionId: "test-session" });
    await expect(promptPromise).resolves.toEqual({ stopReason: "cancelled" });
  });

  it("resolves an in-flight wedged prompt immediately when the session is closed", async () => {
    const agent = createMockAgent();
    // Large floor: if closeSession relied on the force-cancel timer this would
    // hang past the test timeout. Teardown must wake the loop via
    // cancelController instead.
    agent.forceCancelGraceMs = 60_000;
    injectWedgedSession(agent);

    const promptPromise = agent.prompt({
      sessionId: "test-session",
      prompt: [{ type: "text", text: "run cargo test" }],
    });
    await new Promise((r) => setTimeout(r, 5));

    await agent.closeSession({ sessionId: "test-session" });

    await expect(promptPromise).resolves.toEqual({ stopReason: "cancelled" });
    expect(agent.sessions["test-session"]).toBeUndefined();
  });
});

describe("streamEventToAcpNotifications", () => {
  it("treats `ping` keep-alive events as no-ops without logging to stderr", () => {
    const errors: unknown[][] = [];
    const logger = {
      log: () => {},
      error: (...args: unknown[]) => {
        errors.push(args);
      },
    };
    const pingMessage = {
      type: "stream_event",
      parent_tool_use_id: null,
      uuid: randomUUID(),
      session_id: "test-session",
      // The SDK's typed `BetaRawMessageStreamEvent` union doesn't include
      // `ping`, but the API emits it on the wire and the SDK passes it
      // through. Cast through `unknown` to feed the realistic runtime shape.
      event: { type: "ping" } as unknown,
    } as Parameters<typeof streamEventToAcpNotifications>[0];

    const result = streamEventToAcpNotifications(
      pingMessage,
      "test-session",
      {},
      { sessionUpdate: async () => {} } as unknown as Parameters<
        typeof streamEventToAcpNotifications
      >[3],
      logger,
    );

    expect(result).toEqual([]);
    expect(errors).toEqual([]);
  });

  it("attaches the supplied messageId to streamed text chunks", () => {
    const messageId = randomUUID();
    const message = {
      type: "stream_event",
      parent_tool_use_id: null,
      uuid: randomUUID(),
      session_id: "test-session",
      event: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "hello" },
      },
    } as Parameters<typeof streamEventToAcpNotifications>[0];

    const result = streamEventToAcpNotifications(
      message,
      "test",
      {},
      {} as AgentSideConnection,
      console,
      { messageId },
    );

    expect(result).toEqual([
      {
        sessionId: "test",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "hello" },
          messageId,
        },
      },
    ]);
  });
});

describe("toAcpNotifications messageId", () => {
  const messageId = "11111111-2222-3333-4444-555555555555";

  it("sets messageId on agent message chunks from string content", () => {
    const result = toAcpNotifications(
      "hello world",
      "assistant",
      "test",
      {},
      {} as AgentSideConnection,
      console,
      { messageId },
    );

    expect(result).toEqual([
      {
        sessionId: "test",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "hello world" },
          messageId,
        },
      },
    ]);
  });

  it("sets messageId on user message chunks and thought chunks", () => {
    const userResult = toAcpNotifications(
      [{ type: "text", text: "hi" }],
      "user",
      "test",
      {},
      {} as AgentSideConnection,
      console,
      { messageId },
    );
    expect(userResult[0].update).toMatchObject({
      sessionUpdate: "user_message_chunk",
      messageId,
    });

    const thoughtResult = toAcpNotifications(
      [{ type: "thinking", thinking: "hmm", signature: "" }],
      "assistant",
      "test",
      {},
      {} as AgentSideConnection,
      console,
      { messageId },
    );
    expect(thoughtResult[0].update).toMatchObject({
      sessionUpdate: "agent_thought_chunk",
      messageId,
    });
  });

  it("omits messageId when none is supplied", () => {
    const result = toAcpNotifications(
      "hello",
      "assistant",
      "test",
      {},
      {} as AgentSideConnection,
      console,
    );
    expect(result[0].update).not.toHaveProperty("messageId");
  });

  it("never sets messageId on non-chunk updates (tool_call)", () => {
    const result = toAcpNotifications(
      [
        {
          type: "tool_use",
          id: "toolu_abc",
          name: "Read",
          input: { file_path: "/tmp/x" },
        },
      ],
      "assistant",
      "test",
      {},
      {} as AgentSideConnection,
      console,
      { messageId, registerHooks: false },
    );
    expect(result[0].update.sessionUpdate).toBe("tool_call");
    expect(result[0].update).not.toHaveProperty("messageId");
  });
});

describe("messageIdForGrouping", () => {
  it("uses the Anthropic API message id for assistant messages", () => {
    const message = {
      type: "assistant",
      uuid: "de242400-cdb3-4af7-9856-d3b114b20af9",
      message: { id: "msg_018DQGVuZbGYwVnvDakAP9Do", role: "assistant" },
    };
    // The API id is identical at message_start, on the consolidated message,
    // and in the persisted transcript — so it stays stable across replay,
    // unlike the per-message uuid.
    expect(messageIdForGrouping(message)).toBe("msg_018DQGVuZbGYwVnvDakAP9Do");
  });

  it("falls back to the uuid for assistant messages without an API id", () => {
    const message = {
      type: "assistant",
      uuid: "de242400-cdb3-4af7-9856-d3b114b20af9",
      message: { role: "assistant" },
    };
    expect(messageIdForGrouping(message)).toBe("de242400-cdb3-4af7-9856-d3b114b20af9");
  });

  it("uses the uuid for user messages (they carry no API id and aren't streamed)", () => {
    const message = {
      type: "user",
      uuid: "11111111-2222-3333-4444-555555555555",
      message: { id: "msg_should_be_ignored", role: "user" },
    };
    expect(messageIdForGrouping(message)).toBe("11111111-2222-3333-4444-555555555555");
  });

  it("returns undefined when there is no usable id", () => {
    expect(messageIdForGrouping({ type: "system", message: {} })).toBeUndefined();
    expect(messageIdForGrouping({ type: "assistant", uuid: "", message: {} })).toBeUndefined();
  });
});
