import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import { spawn, spawnSync } from "child_process";
import {
  AvailableCommand,
  client as acpClient,
  CreateElicitationRequest,
  CreateElicitationResponse,
  methods,
  ndJsonStream,
  NewSessionResponse,
  PromptRequest,
  PromptResponse,
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
  isSyntheticLoginMessage,
  stripLocalCommandMetadata,
  ClaudeAcpAgent,
  claudeCliPath,
  describeAlwaysAllow,
  streamEventToAcpNotifications,
  messageIdForGrouping,
  buildConfigOptions,
  createFastModeConfigOption,
  discoverCustomAgents,
  runPromptWithCancellation,
  type AcpClient,
  type SDKMessageFilter,
  type StreamedToolInputCache,
} from "../acp-agent.js";
import { Pushable } from "../utils.js";
import {
  deleteSession,
  getSessionInfo,
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
    getSessionInfo: vi.fn(),
    // Delegates to the real implementation so integration tests that read
    // actual transcripts keep working; unit tests override per-call with
    // `mockResolvedValueOnce`.
    getSessionMessages: vi.fn(actual.getSessionMessages),
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

/** A `system`/init frame advertising the msg_lifecycle_v1 capability, so the
 *  consumer latches `session.msgLifecycleV1` and cancel() routes orphan
 *  accounting through `orphanCommands` (CLIs 2.1.206+). */
const lifecycleInit = {
  type: "system",
  subtype: "init",
  session_id: "test-session",
  capabilities: ["interrupt_receipt_v1", "msg_lifecycle_v1"],
};

/** Build a `command_lifecycle` frame (CLIs 2.1.206+) reporting `state` for the
 *  uuid-stamped command `commandUuid`. One builder for every test so the
 *  @internal wire shape can't drift between suites. */
function lifecycleFrame(commandUuid: string, state: string) {
  return {
    type: "command_lifecycle",
    command_uuid: commandUuid,
    state,
    uuid: randomUUID(),
    session_id: "test-session",
  };
}

/** The `usage` a cancelled active turn settles with when the cancel pre-empted
 *  its result: all zeros, since only a turn's terminal result feeds the
 *  accumulator (issue #844). */
const cancelledTurnUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cachedReadTokens: 0,
  cachedWriteTokens: 0,
  totalTokens: 0,
};

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
    agents: [],
    currentAgent: "default",
    abortController: new AbortController(),
    emitRawSDKMessages: false,
    contextWindowSize: 200000,
    taskState: new Map(),
    toolUseCache: {},
    emittedToolCalls: new Set(),
    liveBackgroundTasks: new Map(),
    emittedAssistantText: false,
    owedTrailingIdles: 0,
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

  class TestClient {
    files: Map<string, string> = new Map();
    receivedText: string = "";
    // Records for the AskUserQuestion elicitation test.
    elicitations: CreateElicitationRequest[] = [];
    permissionToolInputs: unknown[] = [];
    chosenAnswers: Record<string, string | string[]> = {};
    resolveAvailableCommands: (commands: AvailableCommand[]) => void;
    availableCommandsPromise: Promise<AvailableCommand[]>;

    constructor() {
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
      if (!CreateElicitationRequest.isForm(params)) {
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

  type TestConnection = {
    prompt(params: PromptRequest): Promise<PromptResponse>;
  };

  async function setupTestSession(cwd: string): Promise<{
    client: TestClient;
    connection: TestConnection;
    newSessionResponse: NewSessionResponse;
  }> {
    const input = nodeToWebWritable(child.stdin!);
    const output = nodeToWebReadable(child.stdout!);
    const stream = ndJsonStream(input, output);

    const client = new TestClient();
    // `connect(...)` keeps the connection open and exposes the agent-side peer
    // handle as `connection.agent`, valid for the lifetime of the connection.
    const { agent: ctx } = acpClient({ name: "test-client" })
      .onNotification(methods.client.session.update, (c) => client.sessionUpdate(c.params))
      .onRequest(methods.client.session.requestPermission, (c) =>
        client.requestPermission(c.params),
      )
      .onRequest(methods.client.fs.readTextFile, (c) => client.readTextFile(c.params))
      .onRequest(methods.client.fs.writeTextFile, (c) => client.writeTextFile(c.params))
      .onRequest(methods.client.elicitation.create, (c) =>
        client.unstable_createElicitation(c.params),
      )
      .connect(stream);

    await ctx.request(methods.agent.initialize, {
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

    const newSessionResponse = await ctx.request(methods.agent.session.new, {
      cwd,
      mcpServers: [],
    });

    const connection: TestConnection = {
      prompt: (params) => ctx.request(methods.agent.session.prompt, params),
    };

    return { client, connection, newSessionResponse };
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
    const properties = CreateElicitationRequest.isForm(elicitation)
      ? Object.keys(elicitation.requestedSchema.properties ?? {})
      : [];
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
        {} as AcpClient,
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

describe("synthetic login message (issue #863)", () => {
  // The exact shape the CLI persists (and streams) when a turn fails auth:
  // model "<synthetic>", a single text block, structured `error` stripped by
  // getSessionMessages.
  const syntheticLoginApiMessage = {
    id: "0a1dfa6b-1c2f-4aa2-8bff-ae1690acd6e1",
    model: "<synthetic>",
    role: "assistant",
    type: "message",
    stop_reason: "stop_sequence",
    content: [{ type: "text", text: "Not logged in · Please run /login" }],
  };

  it("isSyntheticLoginMessage matches the CLI auth-error message", () => {
    expect(isSyntheticLoginMessage(syntheticLoginApiMessage)).toBe(true);
    expect(
      isSyntheticLoginMessage({
        ...syntheticLoginApiMessage,
        content: [{ type: "text", text: "Session expired. Please run /login to sign in again." }],
      }),
    ).toBe(true);
  });

  it("isSyntheticLoginMessage does not match real assistant messages", () => {
    // Real model output that merely mentions the phrase.
    expect(
      isSyntheticLoginMessage({
        ...syntheticLoginApiMessage,
        model: "claude-sonnet-5",
      }),
    ).toBe(false);
    // Other synthetic error texts (e.g. API errors) still replay as-is.
    expect(
      isSyntheticLoginMessage({
        ...syntheticLoginApiMessage,
        content: [{ type: "text", text: "API Error: 500 Internal Server Error" }],
      }),
    ).toBe(false);
    expect(isSyntheticLoginMessage(undefined)).toBe(false);
    expect(isSyntheticLoginMessage("Not logged in · Please run /login")).toBe(false);
  });

  it("loadSession replay skips the synthetic login message but keeps the rest", async () => {
    const updates: SessionNotification[] = [];
    const client = {
      sessionUpdate: async (u: SessionNotification) => {
        updates.push(u);
      },
    } as unknown as AcpClient;
    const agent = new ClaudeAcpAgent(client, { log: () => {}, error: () => {} });

    vi.mocked(getSessionMessages).mockResolvedValueOnce([
      {
        type: "user",
        uuid: "u1",
        session_id: "s1",
        parent_tool_use_id: null,
        parent_agent_id: null,
        message: { role: "user", content: [{ type: "text", text: "hi, say one word" }] },
      },
      {
        type: "assistant",
        uuid: "a1",
        session_id: "s1",
        parent_tool_use_id: null,
        parent_agent_id: null,
        message: syntheticLoginApiMessage,
      },
    ] as Awaited<ReturnType<typeof getSessionMessages>>);

    await (
      agent as unknown as { replaySessionHistory(sessionId: string): Promise<void> }
    ).replaySessionHistory("s1");

    // The user's prompt still replays…
    expect(
      updates.some(
        (u) =>
          u.update.sessionUpdate === "user_message_chunk" &&
          u.update.content.type === "text" &&
          u.update.content.text.includes("hi, say one word"),
      ),
    ).toBe(true);
    // …but the TUI-specific "/login" instruction never reaches the client.
    expect(JSON.stringify(updates)).not.toContain("/login");
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

describe("permission request cancellation", () => {
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
      agents: [],
      currentAgent: "default",
      fastModeEnabled: false,
      abortController: new AbortController(),
      emitRawSDKMessages: false,
      contextWindowSize: 200000,
      taskState: new Map(),
      toolUseCache: {},
      emittedToolCalls: new Set(),
      liveBackgroundTasks: new Map(),
      emittedAssistantText: false,
      owedTrailingIdles: 0,
      messageIdToUuid: new Map(),
    } as any;
    return agent.sessions[sessionId]!;
  }

  it("forwards the tool-call signal so a pending permission request is cancelled on abort", async () => {
    let receivedSignal: AbortSignal | undefined;
    const mockClient = {
      sessionUpdate: async () => {},
      // A `$/cancel_request`-aware client settles the request once the agent
      // aborts it; model that by rejecting when the forwarded signal fires.
      requestPermission: (_params: RequestPermissionRequest, signal?: AbortSignal) => {
        receivedSignal = signal;
        return new Promise<RequestPermissionResponse>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(new Error("Request cancelled")), {
            once: true,
          });
        });
      },
    } as unknown as AcpClient;
    const agent = new ClaudeAcpAgent(mockClient, { log: () => {}, error: () => {} });
    const session = injectSession(agent, "session-1");
    // The tool_call was already surfaced by the streamed tool_use chunk, so the
    // permission request goes straight to requestPermission without first
    // emitting one.
    session.emittedToolCalls.add("tool-1");

    const controller = new AbortController();
    const pending = agent.canUseTool("session-1")("Bash", { command: "ls" }, {
      signal: controller.signal,
      suggestions: [],
      toolUseID: "tool-1",
    } as any);
    // Let canUseTool reach the awaited requestPermission before cancelling.
    await Promise.resolve();

    // The tool-call signal is threaded through as the cancellation signal.
    expect(receivedSignal).toBe(controller.signal);

    controller.abort();

    await expect(pending).rejects.toThrow("Tool use aborted");
  });

  it("treats a cancelled permission outcome as an aborted tool use", async () => {
    const mockClient = {
      sessionUpdate: async () => {},
      requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
    } as unknown as AcpClient;
    const agent = new ClaudeAcpAgent(mockClient, { log: () => {}, error: () => {} });
    injectSession(agent, "session-1");

    await expect(
      agent.canUseTool("session-1")("Bash", { command: "ls" }, {
        signal: new AbortController().signal,
        suggestions: [],
        toolUseID: "tool-1",
      } as any),
    ).rejects.toThrow("Tool use aborted");
  });
});

describe("tool_call emitted before permission request", () => {
  // The SDK can invoke canUseTool before the assistant message's tool_use block
  // streams to us. ACP clients expect the tool_call a permission request
  // references to already exist, so the permission flow emits it eagerly and the
  // streamed chunk later refines it with a tool_call_update (deduped via
  // session.emittedToolCalls) rather than emitting a duplicate.
  function setup(overrides: Record<string, any> = {}) {
    const events: string[] = [];
    const updates: SessionNotification[] = [];
    const mockClient = {
      sessionUpdate: async (n: SessionNotification) => {
        events.push(`update:${n.update.sessionUpdate}`);
        updates.push(n);
      },
      requestPermission: async () => {
        events.push("permission");
        return { outcome: { outcome: "selected", optionId: "allow" } };
      },
    } as unknown as AcpClient;
    const agent = new ClaudeAcpAgent(mockClient, { log: () => {}, error: () => {} });
    agent.sessions["session-1"] = mockSessionState(overrides);
    return { agent, events, updates, session: agent.sessions["session-1"]! };
  }

  it("emits the tool_call (then asks permission) when the stream hasn't yet", async () => {
    const { agent, events, updates, session } = setup();

    const result = await agent.canUseTool("session-1")("Bash", { command: "ls" }, {
      signal: new AbortController().signal,
      suggestions: [],
      toolUseID: "tool-1",
    } as any);

    // tool_call is sent before the permission request is raised.
    expect(events).toEqual(["update:tool_call", "permission"]);
    expect(updates[0].update).toMatchObject({
      sessionUpdate: "tool_call",
      toolCallId: "tool-1",
      status: "pending",
    });
    expect(session.emittedToolCalls.has("tool-1")).toBe(true);
    expect(result).toMatchObject({ behavior: "allow" });
  });

  it("does not re-emit the tool_call when the stream already surfaced it", async () => {
    const { agent, events } = setup();
    agent.sessions["session-1"]!.emittedToolCalls.add("tool-1");

    await agent.canUseTool("session-1")("Bash", { command: "ls" }, {
      signal: new AbortController().signal,
      suggestions: [],
      toolUseID: "tool-1",
    } as any);

    expect(events).toEqual(["permission"]);
  });

  it("refines the eagerly-emitted tool_call with a tool_call_update when the chunk streams", () => {
    const { session } = setup();
    // Permission flow already emitted the tool_call for this id.
    session.emittedToolCalls.add("tool-1");

    const notifications = toAcpNotifications(
      [{ type: "tool_use", id: "tool-1", name: "Bash", input: { command: "ls" } }],
      "assistant",
      "session-1",
      session.toolUseCache,
      {} as AcpClient,
      console,
      { emittedToolCalls: session.emittedToolCalls },
    );

    expect(notifications).toHaveLength(1);
    expect(notifications[0].update.sessionUpdate).toBe("tool_call_update");
  });

  it("emits a tool_call for plan-rendered tools (TodoWrite) so the permission request references a known id (issue #851)", async () => {
    // Strict clients reject (or worse, drop without responding to) a
    // permission request whose toolCallId they have never seen as a
    // tool_call, so even tools the stream renders as a plan must surface one
    // before the request goes out.
    const { agent, events, session } = setup();

    await agent.canUseTool("session-1")(
      "TodoWrite",
      { todos: [{ content: "x", status: "pending" }] },
      { signal: new AbortController().signal, suggestions: [], toolUseID: "todo-1" } as any,
    );

    expect(events).toEqual(["update:tool_call", "permission"]);
    expect(session.emittedToolCalls.has("todo-1")).toBe(true);
  });

  it("resolves a permission-surfaced TodoWrite tool_call at tool_result time", () => {
    // The streamed path renders TodoWrite as `plan` updates and never sends a
    // tool_call_update for it, so the permission-surfaced tool_call must be
    // completed when its tool_result arrives or it would stay pending forever.
    const { session } = setup();
    session.emittedToolCalls.add("todo-1");
    session.toolUseCache["todo-1"] = {
      type: "tool_use",
      id: "todo-1",
      name: "TodoWrite",
      input: { todos: [] },
    };

    const notifications = toAcpNotifications(
      [{ type: "tool_result", tool_use_id: "todo-1", content: [{ type: "text", text: "ok" }] }],
      "user",
      "session-1",
      session.toolUseCache,
      {} as AcpClient,
      console,
      { emittedToolCalls: session.emittedToolCalls },
    );

    expect(notifications).toHaveLength(1);
    expect(notifications[0].update).toMatchObject({
      sessionUpdate: "tool_call_update",
      toolCallId: "todo-1",
      status: "completed",
    });
    expect(session.emittedToolCalls.has("todo-1")).toBe(false);
  });

  it("marks a permission-surfaced TodoWrite tool_call failed on an is_error tool_result", () => {
    // E.g. the user rejected the permission request: the SDK synthesizes an
    // is_error tool_result, which must resolve the surfaced call as failed.
    const { session } = setup();
    session.emittedToolCalls.add("todo-1");
    session.toolUseCache["todo-1"] = {
      type: "tool_use",
      id: "todo-1",
      name: "TodoWrite",
      input: { todos: [] },
    };

    const notifications = toAcpNotifications(
      [
        {
          type: "tool_result",
          tool_use_id: "todo-1",
          is_error: true,
          content: [{ type: "text", text: "User refused permission to run tool" }],
        },
      ],
      "user",
      "session-1",
      session.toolUseCache,
      {} as AcpClient,
      console,
      { emittedToolCalls: session.emittedToolCalls },
    );

    expect(notifications).toHaveLength(1);
    expect(notifications[0].update).toMatchObject({
      sessionUpdate: "tool_call_update",
      toolCallId: "todo-1",
      status: "failed",
    });
  });

  it("resolves permission-surfaced Task* tool_calls too", () => {
    // Task* tool_use/tool_result pairs are normally suppressed entirely (their
    // state surfaces as plan snapshots), so a permission-surfaced tool_call for
    // them also needs an explicit resolution.
    const { session } = setup();
    session.emittedToolCalls.add("task-1");
    session.toolUseCache["task-1"] = {
      type: "tool_use",
      id: "task-1",
      name: "TaskList",
      input: {},
    };

    const notifications = toAcpNotifications(
      [{ type: "tool_result", tool_use_id: "task-1", content: [{ type: "text", text: "[]" }] }],
      "user",
      "session-1",
      session.toolUseCache,
      {} as AcpClient,
      console,
      { emittedToolCalls: session.emittedToolCalls },
    );

    expect(notifications).toHaveLength(1);
    expect(notifications[0].update).toMatchObject({
      sessionUpdate: "tool_call_update",
      toolCallId: "task-1",
      status: "completed",
    });
  });

  it("stays silent on a TodoWrite tool_result when no tool_call was surfaced", () => {
    // The common case: TodoWrite was never permission-gated, so nothing was
    // emitted for it and its tool_result must remain suppressed as before.
    const { session } = setup();
    session.toolUseCache["todo-1"] = {
      type: "tool_use",
      id: "todo-1",
      name: "TodoWrite",
      input: { todos: [] },
    };

    const notifications = toAcpNotifications(
      [{ type: "tool_result", tool_use_id: "todo-1", content: [{ type: "text", text: "ok" }] }],
      "user",
      "session-1",
      session.toolUseCache,
      {} as AcpClient,
      console,
      { emittedToolCalls: session.emittedToolCalls },
    );

    expect(notifications).toHaveLength(0);
  });

  it("includes Bash terminal_info _meta in the eager tool_call so terminal output can attach", async () => {
    const { agent, updates } = setup();
    // Terminal-capable client (e.g. Zed). The eager tool_call must carry
    // terminal_info.terminal_id, otherwise the later terminal_output/terminal_exit
    // updates (keyed by terminal_id) have nothing to attach to.
    (agent as any).clientCapabilities = { _meta: { terminal_output: true } };

    await agent.canUseTool("session-1")("Bash", { command: "ls" }, {
      signal: new AbortController().signal,
      suggestions: [],
      toolUseID: "tool-1",
    } as any);

    expect(updates[0].update).toMatchObject({
      sessionUpdate: "tool_call",
      toolCallId: "tool-1",
      _meta: { terminal_info: { terminal_id: "tool-1" } },
    });
  });

  it("prunes the emission marker and resolves the call on a tool_result even when the tool_use was never cached", () => {
    const { session } = setup();
    // Eager-emitted via the permission flow, but the tool_use chunk never
    // streamed (e.g. the assistant message was dropped by the cancelled-turn
    // guard), so toolUseCache has no entry for it. The surfaced tool_call must
    // still resolve — the eager emission was its only surface — even though the
    // tool name (and thus claudeCode meta) is unknowable here.
    session.emittedToolCalls.add("tool-1");

    const notifications = toAcpNotifications(
      [{ type: "tool_result", tool_use_id: "tool-1", content: [{ type: "text", text: "x" }] }],
      "user",
      "session-1",
      session.toolUseCache,
      {} as AcpClient,
      // Silence the expected "tool result for tool use that wasn't tracked" log.
      { log: () => {}, error: () => {} },
      { emittedToolCalls: session.emittedToolCalls },
    );

    expect(session.emittedToolCalls.has("tool-1")).toBe(false);
    expect(notifications).toHaveLength(1);
    expect(notifications[0].update).toMatchObject({
      sessionUpdate: "tool_call_update",
      toolCallId: "tool-1",
      status: "completed",
    });
  });

  it("does not resolve an uncached tool_result that was never surfaced", () => {
    // Without an eager emission there is no pending tool_call to settle, so
    // the untracked-result path must stay silent as before.
    const { session } = setup();

    const notifications = toAcpNotifications(
      [{ type: "tool_result", tool_use_id: "tool-1", content: [{ type: "text", text: "x" }] }],
      "user",
      "session-1",
      session.toolUseCache,
      {} as AcpClient,
      { log: () => {}, error: () => {} },
      { emittedToolCalls: session.emittedToolCalls },
    );

    expect(notifications).toHaveLength(0);
  });
});

describe("subagent permission attribution (issue #851)", () => {
  // A background subagent's permission requests reach canUseTool with only an
  // `agentID`; the streamed subagent messages carry `parent_tool_use_id`
  // instead. `task_started` bridges the two (for subagent tasks its `task_id`
  // IS the agent id and its `tool_use_id` is the spawning Agent/Task call), so
  // the eagerly-emitted tool_call and the permission request can be attributed
  // to the parent tool call the same way the streamed path attributes updates.
  function setup() {
    const updates: SessionNotification[] = [];
    const requests: RequestPermissionRequest[] = [];
    const log = vi.fn();
    const mockClient = {
      sessionUpdate: async (n: SessionNotification) => {
        updates.push(n);
      },
      requestPermission: async (params: RequestPermissionRequest) => {
        requests.push(params);
        return { outcome: { outcome: "selected", optionId: "allow" } };
      },
    } as unknown as AcpClient;
    const agent = new ClaudeAcpAgent(mockClient, { log, error: () => {} });
    agent.sessions["session-1"] = mockSessionState();
    return { agent, updates, requests, log, session: agent.sessions["session-1"]! };
  }

  it("attributes a subagent tool's eager tool_call and permission request to the spawning tool call", async () => {
    const { agent, updates, requests, session } = setup();
    session.liveBackgroundTasks.set("agent-42", {
      parentToolUseId: "toolu_parent",
      isSubagent: true,
    });

    await agent.canUseTool("session-1")("Bash", { command: "ls" }, {
      signal: new AbortController().signal,
      suggestions: [],
      toolUseID: "toolu_sub",
      agentID: "agent-42",
    } as any);

    expect(updates[0].update).toMatchObject({
      sessionUpdate: "tool_call",
      toolCallId: "toolu_sub",
      _meta: { claudeCode: { parentToolUseId: "toolu_parent" } },
    });
    // The request's claudeCode meta keeps the shape every other claudeCode
    // meta has (toolName is required by ToolUpdateMeta).
    expect(requests[0].toolCall._meta).toMatchObject({
      claudeCode: { toolName: "Bash", parentToolUseId: "toolu_parent" },
    });
  });

  it("omits the attribution (and logs the miss) when the agent id has no recorded parent", async () => {
    const { agent, updates, requests, log } = setup();

    await agent.canUseTool("session-1")("Bash", { command: "ls" }, {
      signal: new AbortController().signal,
      suggestions: [],
      toolUseID: "toolu_sub",
      agentID: "agent-unknown",
    } as any);

    const meta = updates[0].update._meta as { claudeCode?: { parentToolUseId?: string } };
    expect(meta.claudeCode?.parentToolUseId).toBeUndefined();
    expect(requests[0].toolCall._meta).toBeUndefined();
    // The task_id === agentID invariant is undocumented SDK behavior; a miss
    // must be observable so an SDK bump that breaks it doesn't regress silently.
    expect(log).toHaveBeenCalledWith(expect.stringContaining("agent-unknown"));
  });

  it("restores the attribution via the streamed refinement when the eager emission raced task_started", () => {
    // If canUseTool wins the race against the consumer processing
    // task_started, the eager tool_call goes out unattributed. The streamed
    // tool_use chunk — whose message carries parent_tool_use_id — then refines
    // it with a tool_call_update that restores the parent meta for merging
    // clients. This recovery is what makes the best-effort lookup acceptable.
    const { session } = setup();
    session.emittedToolCalls.add("toolu_sub");

    const notifications = toAcpNotifications(
      [{ type: "tool_use", id: "toolu_sub", name: "Bash", input: { command: "ls" } }],
      "assistant",
      "session-1",
      session.toolUseCache,
      {} as AcpClient,
      console,
      { emittedToolCalls: session.emittedToolCalls, parentToolUseId: "toolu_parent" },
    );

    expect(notifications).toHaveLength(1);
    expect(notifications[0].update).toMatchObject({
      sessionUpdate: "tool_call_update",
      toolCallId: "toolu_sub",
      _meta: { claudeCode: { parentToolUseId: "toolu_parent" } },
    });
  });

  function taskStarted(taskId: string, toolUseId: string) {
    return {
      type: "system",
      subtype: "task_started",
      task_id: taskId,
      tool_use_id: toolUseId,
      description: "Investigate",
      uuid: randomUUID(),
      session_id: "test-session",
    };
  }

  function successResult() {
    return {
      type: "result" as const,
      subtype: "success" as const,
      stop_reason: null,
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

  /** Replays the prompt's user echo (so the turn activates), then the given
   *  messages, then settles the turn. */
  function makeGenerator(messages: unknown[]) {
    return async function* (input: Pushable<any>) {
      const iter = input[Symbol.asyncIterator]();
      const { value: userMessage, done } = await iter.next();
      if (!done && userMessage) {
        yield userEcho(userMessage);
      }
      yield* messages as any;
      yield { type: "system", subtype: "session_state_changed", state: "idle" };
    };
  }

  it("records task_started's task_id → tool_use_id mapping while consuming the stream", async () => {
    const agent = new ClaudeAcpAgent(
      { sessionUpdate: vi.fn(async () => {}) } as unknown as AcpClient,
      {
        log: () => {},
        error: () => {},
      },
    );
    injectGeneratorSession(
      agent,
      makeGenerator([taskStarted("agent-42", "toolu_parent"), successResult()]),
    );

    await agent.prompt({ sessionId: "test-session", prompt: [{ type: "text", text: "go" }] });

    expect(
      agent.sessions["test-session"]!.liveBackgroundTasks.get("agent-42")?.parentToolUseId,
    ).toBe("toolu_parent");
  });

  it("prunes the mapping when the task settles (task_notification)", async () => {
    const agent = new ClaudeAcpAgent(
      { sessionUpdate: vi.fn(async () => {}) } as unknown as AcpClient,
      {
        log: () => {},
        error: () => {},
      },
    );
    injectGeneratorSession(
      agent,
      makeGenerator([
        taskStarted("agent-42", "toolu_parent"),
        {
          type: "system",
          subtype: "task_notification",
          task_id: "agent-42",
          tool_use_id: "toolu_parent",
          status: "completed",
          output_file: "",
          summary: "done",
          uuid: randomUUID(),
          session_id: "test-session",
        },
        successResult(),
      ]),
    );

    await agent.prompt({ sessionId: "test-session", prompt: [{ type: "text", text: "go" }] });

    expect(agent.sessions["test-session"]!.liveBackgroundTasks.size).toBe(0);
  });

  it("prunes the mapping on a terminal task_updated patch (belt and braces)", async () => {
    const agent = new ClaudeAcpAgent(
      { sessionUpdate: vi.fn(async () => {}) } as unknown as AcpClient,
      {
        log: () => {},
        error: () => {},
      },
    );
    injectGeneratorSession(
      agent,
      makeGenerator([
        taskStarted("agent-42", "toolu_parent"),
        taskStarted("agent-43", "toolu_parent_2"),
        {
          type: "system",
          subtype: "task_updated",
          task_id: "agent-42",
          patch: { status: "completed" },
          uuid: randomUUID(),
          session_id: "test-session",
        },
        // A non-terminal patch must NOT prune: the task keeps running and its
        // permission requests still need the attribution.
        {
          type: "system",
          subtype: "task_updated",
          task_id: "agent-43",
          patch: { status: "running", is_backgrounded: true },
          uuid: randomUUID(),
          session_id: "test-session",
        },
        successResult(),
      ]),
    );

    await agent.prompt({ sessionId: "test-session", prompt: [{ type: "text", text: "go" }] });

    const map = agent.sessions["test-session"]!.liveBackgroundTasks;
    expect(map.has("agent-42")).toBe(false);
    expect(map.get("agent-43")?.parentToolUseId).toBe("toolu_parent_2");
  });
});

describe("runPromptWithCancellation", () => {
  function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((r) => {
      resolve = r;
    });
    return { promise, resolve };
  }

  it("cancels the in-flight prompt when the request signal aborts ($/cancel_request)", async () => {
    const promptResult = deferred<PromptResponse>();
    const cancel = vi.fn(async () => {});
    const agent = {
      prompt: vi.fn(() => promptResult.promise),
      cancel,
      logger: { log: () => {}, error: () => {} },
    } as any;

    const controller = new AbortController();
    const params = { sessionId: "session-1", prompt: [] } as any;
    const pending = runPromptWithCancellation(agent, params, controller.signal);

    // No cancel yet — the turn is running.
    expect(cancel).not.toHaveBeenCalled();

    // Client sends $/cancel_request -> the SDK aborts this request's signal.
    controller.abort();
    expect(cancel).toHaveBeenCalledWith({ sessionId: "session-1" });

    // The prompt settles "cancelled" through the normal cancel path.
    promptResult.resolve({ stopReason: "cancelled" });
    await expect(pending).resolves.toEqual({ stopReason: "cancelled" });
  });

  it("does not cancel after the prompt settles normally", async () => {
    const promptResult = deferred<PromptResponse>();
    const cancel = vi.fn(async () => {});
    const agent = {
      prompt: vi.fn(() => promptResult.promise),
      cancel,
      logger: { log: () => {}, error: () => {} },
    } as any;

    const controller = new AbortController();
    const params = { sessionId: "session-1", prompt: [] } as any;
    const pending = runPromptWithCancellation(agent, params, controller.signal);

    promptResult.resolve({ stopReason: "end_turn" });
    await expect(pending).resolves.toEqual({ stopReason: "end_turn" });

    // A late abort (e.g. per-request signal cleanup) must not cancel a later turn.
    controller.abort();
    expect(cancel).not.toHaveBeenCalled();
  });
});

describe("stop reason propagation", () => {
  // The title-update tests set `getSessionInfo` to resolve a title; reset it so
  // that value can't leak into other turn-end (idle) assertions in this block.
  beforeEach(() => {
    vi.mocked(getSessionInfo).mockReset();
  });

  function createMockAgent() {
    const mockClient = {
      sessionUpdate: async () => {},
    } as unknown as AcpClient;
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

  it("only reconciles Fast mode from user-driven results, not task-notification followups", async () => {
    const updates: any[] = [];
    const mockClient = {
      sessionUpdate: async (n: any) => {
        updates.push(n);
      },
    } as unknown as AcpClient;
    const agent = new ClaudeAcpAgent(mockClient, { log: () => {}, error: () => {} });
    (agent as any).clientCapabilities = { session: { configOptions: { boolean: {} } } };

    const input = new Pushable<any>();

    // A background followup reports fast_mode_state="on". It must NOT flip the
    // user's toggle or emit a config_option_update (every other side effect in
    // the result handler is likewise gated behind !isTaskNotification).
    const backgroundTaskResult = {
      ...createResultMessage({ subtype: "success", stop_reason: null, is_error: false }),
      origin: { kind: "task-notification" },
      fast_mode_state: "on",
    };

    // The user prompt's own result reports the same state — this one IS a user
    // turn, so it reconciles and notifies.
    const promptResult = {
      ...createResultMessage({ subtype: "success", stop_reason: null, is_error: false }),
      fast_mode_state: "on",
    };

    async function* messageGenerator() {
      yield { type: "system", subtype: "init", session_id: "test-session" };
      yield backgroundTaskResult;

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

      yield promptResult;
      yield { type: "system", subtype: "session_state_changed", state: "idle" };
    }

    agent.sessions["test-session"] = mockSessionState({
      query: wrapQuery(messageGenerator()),
      input,
      fastModeEnabled: false,
      configOptions: [createFastModeConfigOption(false, true)],
    });

    await agent.prompt({
      sessionId: "test-session",
      prompt: [{ type: "text", text: "test" }],
    });

    // The user-turn result flipped the toggle and emitted exactly one
    // config_option_update; the background result contributed none.
    expect((agent.sessions["test-session"] as any).fastModeEnabled).toBe(true);
    const configUpdates = updates.filter(
      (n: any) => n.update?.sessionUpdate === "config_option_update",
    );
    expect(configUpdates).toHaveLength(1);
    expect(configUpdates[0].update.configOptions).toContainEqual(
      createFastModeConfigOption(true, true),
    );
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

  it("ignores command_lifecycle frames without logging an unexpected-case error", async () => {
    // CLIs 2.1.206+ report the fate of every uuid-stamped queued command as
    // `command_lifecycle` frames (queued/started/completed/...) on the SDK
    // stream, 2-3 per prompt. They are absent from the SDKMessage union, so
    // without the pre-switch guard they fall through to `unreachable`'s
    // error log on every prompt.
    const errors: string[] = [];
    const mockClient = { sessionUpdate: async () => {} } as unknown as AcpClient;
    const agent = new ClaudeAcpAgent(mockClient, {
      log: () => {},
      error: (msg: unknown) => errors.push(String(msg)),
    });

    injectGeneratorSession(agent, (input) => {
      async function* messageGenerator() {
        const iter = input[Symbol.asyncIterator]();
        const { value: userMessage } = await iter.next();
        yield lifecycleFrame(userMessage.uuid, "queued");
        yield lifecycleFrame(userMessage.uuid, "started");
        yield userEcho(userMessage);
        yield createResultMessage({ subtype: "success", stop_reason: "end_turn", is_error: false });
        yield lifecycleFrame(userMessage.uuid, "completed");
        yield { type: "system", subtype: "session_state_changed", state: "idle" };
      }
      return messageGenerator();
    });

    const response = await agent.prompt({
      sessionId: "test-session",
      prompt: [{ type: "text", text: "test" }],
    });

    expect(response.stopReason).toBe("end_turn");
    expect(errors.filter((e) => e.includes("Unexpected case"))).toEqual([]);
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
    } as unknown as AcpClient;
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

  it("pushes a session_info_update when the SDK generates a title at turn-end", async () => {
    const sessionUpdates: any[] = [];
    const mockClient = {
      sessionUpdate: async (u: any) => {
        sessionUpdates.push(u);
      },
    } as unknown as AcpClient;
    const agent = new ClaudeAcpAgent(mockClient, { log: () => {}, error: () => {} });

    vi.mocked(getSessionInfo).mockResolvedValue({
      sessionId: "test-session",
      summary: "Fix the flaky title test",
      lastModified: 1_700_000_000_000,
    } as any);

    const input = new Pushable<any>();
    async function* messageGenerator() {
      const iter = input[Symbol.asyncIterator]();
      const { value: userMessage } = await iter.next();
      yield userEcho(userMessage);
      yield createResultMessage({ subtype: "success", stop_reason: "end_turn", is_error: false });
      yield { type: "system", subtype: "session_state_changed", state: "idle" };
    }

    agent.sessions["test-session"] = mockSessionState({
      query: wrapQuery(messageGenerator()),
      input,
    });

    await agent.prompt({
      sessionId: "test-session",
      prompt: [{ type: "text", text: "test" }],
    });
    await agent.sessions["test-session"]?.consumer;

    const titleUpdate = sessionUpdates.find(
      (u) => u.update?.sessionUpdate === "session_info_update",
    );
    expect(titleUpdate?.update).toEqual({
      sessionUpdate: "session_info_update",
      title: "Fix the flaky title test",
      updatedAt: new Date(1_700_000_000_000).toISOString(),
    });
    expect(getSessionInfo).toHaveBeenCalledWith("test-session", { dir: "/test" });
  });

  it("does not re-push session_info_update when the title is unchanged", async () => {
    const sessionUpdates: any[] = [];
    const mockClient = {
      sessionUpdate: async (u: any) => {
        sessionUpdates.push(u);
      },
    } as unknown as AcpClient;
    const agent = new ClaudeAcpAgent(mockClient, { log: () => {}, error: () => {} });

    vi.mocked(getSessionInfo).mockResolvedValue({
      sessionId: "test-session",
      summary: "Stable title",
      lastModified: 1_700_000_000_000,
    } as any);

    const input = new Pushable<any>();
    async function* messageGenerator() {
      const iter = input[Symbol.asyncIterator]();
      // Two turns, each ending in idle, but the title never changes.
      for (let i = 0; i < 2; i++) {
        const { value: userMessage } = await iter.next();
        yield userEcho(userMessage);
        yield createResultMessage({
          subtype: "success",
          stop_reason: "end_turn",
          is_error: false,
        });
        yield { type: "system", subtype: "session_state_changed", state: "idle" };
      }
    }

    agent.sessions["test-session"] = mockSessionState({
      query: wrapQuery(messageGenerator()),
      input,
    });

    await agent.prompt({ sessionId: "test-session", prompt: [{ type: "text", text: "one" }] });
    await agent.prompt({ sessionId: "test-session", prompt: [{ type: "text", text: "two" }] });
    await agent.sessions["test-session"]?.consumer;

    const titleUpdates = sessionUpdates.filter(
      (u) => u.update?.sessionUpdate === "session_info_update",
    );
    expect(titleUpdates).toHaveLength(1);
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

describe("model refusal fallback handling", () => {
  /** Session overrides with a populated model picker: Fable selected,
   *  Opus available as the refusal-fallback target. `modes` mirrors a real
   *  session (never empty), so the mode-clamp logic in applyConfigOptionValue
   *  sees realistic state. */
  const modelStateOverrides = {
    models: {
      currentModelId: "claude-fable-5",
      availableModels: [
        { modelId: "claude-fable-5", name: "Claude Fable 5" },
        { modelId: "claude-opus-4-8", name: "Claude Opus 4.8" },
      ],
    },
    modelInfos: [
      { value: "claude-fable-5", displayName: "Claude Fable 5", description: "" },
      { value: "claude-opus-4-8", displayName: "Claude Opus 4.8", description: "" },
    ],
    modes: {
      currentModeId: "default",
      availableModes: [
        { id: "auto", name: "Auto", description: "" },
        { id: "default", name: "Default", description: "" },
      ],
    },
  };

  function refusalFallbackMessage(overrides: Record<string, unknown> = {}) {
    return {
      type: "system",
      subtype: "model_refusal_fallback",
      trigger: "refusal",
      direction: "retry",
      original_model: "claude-fable-5",
      fallback_model: "claude-opus-4-8",
      request_id: "req_1",
      api_refusal_category: "cyber",
      content: "banner",
      uuid: randomUUID(),
      session_id: "test-session",
      ...overrides,
    };
  }

  function successResult() {
    return {
      type: "result" as const,
      subtype: "success" as const,
      stop_reason: null,
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

  /** Replays the prompt's user echo (so the turn activates), then the given
   *  messages, then settles the turn. */
  function makeGenerator(messages: unknown[]) {
    return async function* (input: Pushable<any>) {
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
      yield* messages as any;
      yield { type: "system", subtype: "session_state_changed", state: "idle" };
    };
  }

  function createCapturingAgent() {
    const sessionUpdate = vi.fn(async () => {});
    const agent = new ClaudeAcpAgent({ sessionUpdate } as unknown as AcpClient, {
      log: () => {},
      error: () => {},
    });
    return { agent, sessionUpdate };
  }

  it("notifies the user and reconciles model state on model_refusal_fallback", async () => {
    const { agent, sessionUpdate } = createCapturingAgent();
    injectGeneratorSession(
      agent,
      makeGenerator([refusalFallbackMessage(), successResult()]),
      modelStateOverrides,
    );

    const response = await agent.prompt({
      sessionId: "test-session",
      prompt: [{ type: "text", text: "test" }],
    });
    expect(response.stopReason).toBe("end_turn");

    const session = agent.sessions["test-session"];
    // The swap is persistent — our bookkeeping must follow it.
    expect(session.models.currentModelId).toBe("claude-opus-4-8");
    // The SDK made the switch itself; a setModel round-trip would be wrong.
    expect(session.query.setModel).not.toHaveBeenCalled();

    const updates = sessionUpdate.mock.calls.map((c: any[]) => (c[0] as { update: any }).update);
    const notice = updates.find(
      (u) => u.sessionUpdate === "agent_message_chunk" && u.content.text.includes("Model fallback"),
    );
    expect(notice).toBeDefined();
    expect(notice.content.text).toContain("claude-fable-5");
    expect(notice.content.text).toContain("claude-opus-4-8");
    expect(notice.content.text).toContain("(cyber)");

    const configUpdate = updates.find((u) => u.sessionUpdate === "config_option_update");
    expect(configUpdate).toBeDefined();
    const modelOption = configUpdate.configOptions.find((o: { id: string }) => o.id === "model");
    expect(modelOption.currentValue).toBe("claude-opus-4-8");
  });

  it("includes the refusal explanation in the fallback notice when present", async () => {
    const { agent, sessionUpdate } = createCapturingAgent();
    injectGeneratorSession(
      agent,
      makeGenerator([
        refusalFallbackMessage({
          api_refusal_explanation: "This request tripped a safety classifier.",
        }),
        successResult(),
      ]),
      modelStateOverrides,
    );

    await agent.prompt({ sessionId: "test-session", prompt: [{ type: "text", text: "test" }] });

    const updates = sessionUpdate.mock.calls.map((c: any[]) => (c[0] as { update: any }).update);
    const notice = updates.find(
      (u) => u.sessionUpdate === "agent_message_chunk" && u.content.text.includes("Model fallback"),
    );
    expect(notice.content.text).toContain("This request tripped a safety classifier.");
  });

  it("tracks the raw model id when the fallback model is not among the options", async () => {
    const { agent, sessionUpdate } = createCapturingAgent();
    injectGeneratorSession(
      agent,
      makeGenerator([
        refusalFallbackMessage({ fallback_model: "claude-mystery-9" }),
        successResult(),
      ]),
      modelStateOverrides,
    );

    await agent.prompt({ sessionId: "test-session", prompt: [{ type: "text", text: "test" }] });

    const session = agent.sessions["test-session"];
    // Not resolvable to an option — keep the truthful raw id anyway so
    // model-dependent bookkeeping doesn't keep advertising the refused model.
    expect(session.models.currentModelId).toBe("claude-mystery-9");
    const updates = sessionUpdate.mock.calls.map((c: any[]) => (c[0] as { update: any }).update);
    expect(updates.some((u) => u.sessionUpdate === "config_option_update")).toBe(true);
  });

  it("skips the config update when the fallback equals the tracked model", async () => {
    const { agent, sessionUpdate } = createCapturingAgent();
    injectGeneratorSession(
      agent,
      makeGenerator([
        refusalFallbackMessage({ fallback_model: "claude-fable-5" }),
        successResult(),
      ]),
      modelStateOverrides,
    );

    await agent.prompt({ sessionId: "test-session", prompt: [{ type: "text", text: "test" }] });

    const updates = sessionUpdate.mock.calls.map((c: any[]) => (c[0] as { update: any }).update);
    // Notice still shown, but no state churn.
    expect(updates.some((u) => u.sessionUpdate === "agent_message_chunk")).toBe(true);
    expect(updates.some((u) => u.sessionUpdate === "config_option_update")).toBe(false);
  });

  it("surfaces the structured explanation when a refusal has no fallback", async () => {
    const { agent, sessionUpdate } = createCapturingAgent();
    injectGeneratorSession(
      agent,
      makeGenerator([
        {
          type: "system",
          subtype: "model_refusal_no_fallback",
          original_model: "claude-fable-5",
          request_id: "req_1",
          api_refusal_category: "cyber",
          api_refusal_explanation: "Declined by safety classifiers.",
          content: "banner",
          uuid: randomUUID(),
          session_id: "test-session",
        },
        { ...successResult(), stop_reason: "refusal" },
      ]),
      modelStateOverrides,
    );

    const response = await agent.prompt({
      sessionId: "test-session",
      prompt: [{ type: "text", text: "test" }],
    });
    expect(response.stopReason).toBe("refusal");

    const updates = sessionUpdate.mock.calls.map((c: any[]) => (c[0] as { update: any }).update);
    const chunk = updates.find((u) => u.sessionUpdate === "agent_message_chunk");
    expect(chunk.content.text).toBe("Declined by safety classifiers.");
    // No model reconciliation on the no-fallback path.
    expect(updates.some((u) => u.sessionUpdate === "config_option_update")).toBe(false);
  });

  it("does not persist the swap for a turn-only fallback (direction revert)", async () => {
    const { agent, sessionUpdate } = createCapturingAgent();
    injectGeneratorSession(
      agent,
      makeGenerator([refusalFallbackMessage({ direction: "revert" }), successResult()]),
      modelStateOverrides,
    );

    await agent.prompt({ sessionId: "test-session", prompt: [{ type: "text", text: "test" }] });

    const session = agent.sessions["test-session"];
    // Older-CLI "revert" means the session stays on the original model.
    expect(session.models.currentModelId).toBe("claude-fable-5");
    const updates = sessionUpdate.mock.calls.map((c: any[]) => (c[0] as { update: any }).update);
    const notice = updates.find(
      (u) => u.sessionUpdate === "agent_message_chunk" && u.content.text.includes("Model fallback"),
    );
    expect(notice.content.text).toContain("stays on claude-fable-5");
    expect(updates.some((u) => u.sessionUpdate === "config_option_update")).toBe(false);
  });

  it("keeps the current permission modes when the fallback model is unknown", async () => {
    const { agent, sessionUpdate } = createCapturingAgent();
    injectGeneratorSession(
      agent,
      makeGenerator([
        refusalFallbackMessage({ fallback_model: "claude-mystery-9" }),
        successResult(),
      ]),
      {
        ...modelStateOverrides,
        // Session is running in auto mode; the unknown fallback model's
        // capabilities are unknowable, so the mode must NOT be clamped.
        modes: {
          currentModeId: "auto",
          availableModes: [
            { id: "auto", name: "Auto", description: "" },
            { id: "default", name: "Default", description: "" },
          ],
        },
      },
    );

    await agent.prompt({ sessionId: "test-session", prompt: [{ type: "text", text: "test" }] });

    const session = agent.sessions["test-session"];
    expect(session.models.currentModelId).toBe("claude-mystery-9");
    expect(session.modes.currentModeId).toBe("auto");
    const updates = sessionUpdate.mock.calls.map((c: any[]) => (c[0] as { update: any }).update);
    expect(updates.some((u) => u.sessionUpdate === "current_mode_update")).toBe(false);
  });

  it("keeps the banner explanation when the refusal frame arrives after it without stop_details", async () => {
    const { agent, sessionUpdate } = createCapturingAgent();
    injectGeneratorSession(
      agent,
      makeGenerator([
        {
          type: "system",
          subtype: "model_refusal_no_fallback",
          original_model: "claude-fable-5",
          request_id: "req_1",
          api_refusal_explanation: "Declined by safety classifiers.",
          content: "banner",
          uuid: randomUUID(),
          session_id: "test-session",
        },
        // The consolidated refusal frame from a gateway that dropped
        // stop_details — it must not clobber the banner's explanation.
        {
          type: "assistant",
          parent_tool_use_id: null,
          uuid: randomUUID(),
          session_id: "test-session",
          message: {
            role: "assistant",
            model: "claude-fable-5",
            stop_reason: "refusal",
            content: [],
            usage: {
              input_tokens: 10,
              output_tokens: 0,
              cache_read_input_tokens: 0,
              cache_creation_input_tokens: 0,
            },
          },
        },
        { ...successResult(), stop_reason: "refusal" },
      ]),
      modelStateOverrides,
    );

    const response = await agent.prompt({
      sessionId: "test-session",
      prompt: [{ type: "text", text: "test" }],
    });
    expect(response.stopReason).toBe("refusal");

    const updates = sessionUpdate.mock.calls.map((c: any[]) => (c[0] as { update: any }).update);
    const chunk = updates.find(
      (u) =>
        u.sessionUpdate === "agent_message_chunk" &&
        u.content.text === "Declined by safety classifiers.",
    );
    expect(chunk).toBeDefined();
  });

  it("ignores a non-human-authored refusal banner (refused_user_message_uuid null)", async () => {
    const { agent, sessionUpdate } = createCapturingAgent();
    injectGeneratorSession(
      agent,
      makeGenerator([
        {
          type: "system",
          subtype: "model_refusal_no_fallback",
          original_model: "claude-fable-5",
          request_id: "req_1",
          api_refusal_explanation: "Background task declined.",
          refused_user_message_uuid: null,
          content: "banner",
          uuid: randomUUID(),
          session_id: "test-session",
        },
        { ...successResult(), stop_reason: "refusal" },
      ]),
      modelStateOverrides,
    );

    await agent.prompt({ sessionId: "test-session", prompt: [{ type: "text", text: "test" }] });

    const updates = sessionUpdate.mock.calls.map((c: any[]) => (c[0] as { update: any }).update);
    // The background followup's explanation must not be attributed to the
    // user's turn.
    expect(
      updates.some(
        (u) =>
          u.sessionUpdate === "agent_message_chunk" &&
          u.content.text.includes("Background task declined."),
      ),
    ).toBe(false);
  });
});

describe("logout", () => {
  function createMockAgent() {
    const mockClient = {
      sessionUpdate: async () => {},
    } as unknown as AcpClient;
    return new ClaudeAcpAgent(mockClient, { log: () => {}, error: () => {} });
  }

  it("advertises the logout capability during initialize", async () => {
    const agent = createMockAgent();
    const response = await agent.initialize({
      protocolVersion: 1,
      clientCapabilities: {},
    });
    expect(response.agentCapabilities?.auth?.logout).toEqual({});
  });
});

describe("session/close", () => {
  function createMockAgent() {
    const mockClient = {
      sessionUpdate: async () => {},
    } as unknown as AcpClient;
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
      agents: [],
      currentAgent: "default",
      fastModeEnabled: false,
      abortController: new AbortController(),
      emitRawSDKMessages: false,
      contextWindowSize: 200000,
      taskState: new Map(),
      toolUseCache: {},
      emittedToolCalls: new Set(),
      liveBackgroundTasks: new Map(),
      emittedAssistantText: false,
      owedTrailingIdles: 0,
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
    } as unknown as AcpClient;
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
      agents: [],
      currentAgent: "default",
      fastModeEnabled: false,
      abortController: new AbortController(),
      emitRawSDKMessages: false,
      contextWindowSize: 200000,
      taskState: new Map(),
      toolUseCache: {},
      emittedToolCalls: new Set(),
      liveBackgroundTasks: new Map(),
      emittedAssistantText: false,
      owedTrailingIdles: 0,
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
    } as unknown as AcpClient;
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
      agents: [],
      currentAgent: "default",
      fastModeEnabled: false,
      abortController: new AbortController(),
      emitRawSDKMessages: false,
      contextWindowSize: 200000,
      taskState: new Map(),
      toolUseCache: {},
      emittedToolCalls: new Set(),
      liveBackgroundTasks: new Map(),
      emittedAssistantText: false,
      owedTrailingIdles: 0,
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
    } as unknown as AcpClient;
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

  it("infers the 1M window from a model's description when the ID lacks a 1m token (issue #596)", async () => {
    // Semantic aliases like `default` resolve to a 1M-context model but carry
    // no "1m" token in the modelId — the SDK signals 1M only via the
    // human-facing displayName/description (e.g. "Opus 4.7 with 1M context").
    // Inference must read those so the session reports the correct window from
    // the first mid-stream update instead of the 200k placeholder.
    const { agent } = createMockAgentWithCapture();
    injectSession(agent, [{ type: "system", subtype: "session_state_changed", state: "idle" }]);
    const session = agent.sessions["test-session"];
    session.models = { currentModelId: "claude-sonnet-4-6", availableModels: [] };
    session.modelInfos = [
      { value: "default", displayName: "Default", description: "Opus 4.7 with 1M context" },
    ] as any;
    expect(session.contextWindowSize).toBe(200000);

    await (agent as any).applyConfigOptionValue("test-session", session, "model", "default");

    expect(session.contextWindowSize).toBe(1000000);
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
    // No trailing idle: an idle with no preceding result now fails the turn as
    // abandoned (issue #825), and a real compaction turn always produces a
    // result. Here the stream simply ends, settling the prompt end_turn.
    injectSession(agent, [
      { type: "system", subtype: "compact_boundary", session_id: "test-session" },
    ]);
    const session = agent.sessions["test-session"];
    // A 1M window learned earlier (e.g. from modelUsage) must survive
    // compaction — compaction frees occupancy, it doesn't change the window,
    // so the handler must not overwrite it from this response.
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
    // No trailing idle — see the sibling test above (issue #825).
    injectSession(agent, [
      { type: "system", subtype: "compact_boundary", session_id: "test-session" },
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
    } as unknown as AcpClient;
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

  function thinkingDelta(thinking: string) {
    return {
      type: "stream_event" as const,
      parent_tool_use_id: null,
      uuid: randomUUID(),
      session_id: "test-session",
      event: {
        type: "content_block_delta" as const,
        index: 0,
        delta: { type: "thinking_delta" as const, thinking },
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

  it("dedupes streamed text when the user echo activates the turn mid-message, between a thinking and a text block", async () => {
    const { agent, updates } = createMockAgentWithCapture();
    // Production ordering captured with: inside a single message id, the
    // thinking block streams, THEN the SDK replays the user message that
    // activates the turn, THEN the text block streams. Turn activation runs
    // `resetTurnScratch()`; if that nulls `currentStreamMessageId`, every text
    // delta after the echo streams untracked, so the consolidated `assistant`
    // text fails dedupe and is re-emitted as a duplicate. #785 fixed the
    // stream-before-echo case but left this residual mid-message path.
    injectSessionEchoAt(agent, [
      messageStart("msg-mixed"),
      thinkingDelta("private reasoning"),
      "ECHO",
      textDelta("Starting now."),
      assistantMessage("msg-mixed", [
        { type: "thinking", thinking: "private reasoning" },
        { type: "text", text: "Starting now." },
      ]),
      result(),
      idle,
    ]);

    await agent.prompt({ sessionId: "test-session", prompt: [{ type: "text", text: "hi" }] });

    // The text streamed once; the consolidated copy must be deduped, not doubled.
    expect(messageChunkTexts(updates)).toEqual(["Starting now."]);
    // The thinking streamed before the echo (still tracked) so it is deduped —
    // mirrors the production signature where only the text block doubled.
    expect(thoughtChunkTexts(updates)).toEqual(["private reasoning"]);
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

  it("forwards only the un-streamed remainder when the stream is cut short mid-block", async () => {
    const { agent, updates } = createMockAgentWithCapture();
    // The stream stops partway ("hello ") but the consolidated message carries
    // the whole block ("hello world"). The streamed prefix must not be re-sent,
    // and the un-streamed tail must still reach the client — dropping the whole
    // assembled block would truncate the answer to "hello ".
    injectSession(agent, [
      messageStart("msg-partial"),
      textDelta("hello "),
      assistantMessage("msg-partial", [{ type: "text", text: "hello world" }]),
      result(),
      idle,
    ]);

    await agent.prompt({ sessionId: "test-session", prompt: [{ type: "text", text: "hi" }] });

    // The streamed prefix, then just the tail from the consolidated message.
    expect(messageChunkTexts(updates)).toEqual(["hello ", "world"]);
  });

  it("dedupes streamed text even when the consolidated message carries a different id", async () => {
    const { agent, updates } = createMockAgentWithCapture();
    // Some gateways assign one id during the stream and a different one (or only
    // a uuid) on the assembled message. Dedupe must key on content, not the id,
    // or the consolidated block re-emits already-streamed text as a duplicate.
    injectSession(agent, [
      messageStart("msg-stream-id"),
      textDelta("hello "),
      textDelta("world"),
      assistantMessage("msg-DIFFERENT-id", [{ type: "text", text: "hello world" }]),
      result(),
      idle,
    ]);

    await agent.prompt({ sessionId: "test-session", prompt: [{ type: "text", text: "hi" }] });

    // Only the streamed deltas — the assembled copy is deduped despite the id
    // mismatch.
    expect(messageChunkTexts(updates)).toEqual(["hello ", "world"]);
  });

  it("dedupes a streamed text block even when an empty thinking delta precedes it", async () => {
    // An empty thinking delta (some gateways emit them — #793) must not create
    // a zero-length streamedBlocks entry: that entry can never satisfy the
    // consolidated handler's `text.length > 0` guard, so it would stall the
    // diff cursor and re-emit the real, already-streamed text as a duplicate.
    const { agent, updates } = createMockAgentWithCapture();
    injectSession(agent, [
      messageStart("msg-empty-thinking"),
      thinkingDelta(""),
      textDelta("real answer"),
      assistantMessage("msg-empty-thinking", [{ type: "text", text: "real answer" }]),
      result(),
      idle,
    ]);

    await agent.prompt({ sessionId: "test-session", prompt: [{ type: "text", text: "hi" }] });

    // The streamed text appears once; the consolidated copy is deduped.
    expect(messageChunkTexts(updates)).toEqual(["real answer"]);
  });

  it("dedupes a streamed text block even when a thinking delta omits text", async () => {
    const { agent, updates } = createMockAgentWithCapture();
    injectSession(agent, [
      messageStart("msg-missing-thinking"),
      thinkingDelta(undefined as any),
      textDelta("real answer"),
      assistantMessage("msg-missing-thinking", [{ type: "text", text: "real answer" }]),
      result(),
      idle,
    ]);

    await agent.prompt({ sessionId: "test-session", prompt: [{ type: "text", text: "hi" }] });

    expect(messageChunkTexts(updates)).toEqual(["real answer"]);
  });

  it("does not re-emit the next turn's text after a turn is cancelled mid-stream", async () => {
    // Regression: streamedBlocks is reset inside the consolidated-assistant
    // branch, but a cancelled turn `break`s out before reaching it (the
    // `if (session.cancelled) break;` guard), and streamedBlocks is
    // session-scoped — so a cancelled turn's streamed text used to leak into
    // the next turn. Block indices restart at 0 per message, so the leftover
    // "Hello there" would fuse with turn 2's first block and make its
    // consolidated copy fail the prefix dedupe, re-emitting "Second answer" as
    // a duplicate. The fix resets streamedBlocks on each top-level
    // `message_start`, bounding the record to one in-flight message.
    const { agent, updates } = createMockAgentWithCapture();

    let releaseCancel!: () => void;
    const cancelled = new Promise<void>((resolve) => {
      releaseCancel = resolve;
    });

    injectGeneratorSession(agent, (input) => {
      async function* messageGenerator() {
        const iter = input[Symbol.asyncIterator]();
        const u1 = await iter.next();
        yield userEcho(u1.value); // activate turn 1
        yield messageStart("msg-1");
        yield textDelta("Hello ");
        yield textDelta("there"); // streamedBlocks = [{ index: 0, text: "Hello there" }]
        await cancelled; // hold until the test has cancelled turn 1
        // Turn 1's consolidated message arrives while cancelled → hits the
        // `if (session.cancelled) break;` guard, skipping the streamedBlocks
        // reset. The leftover entry must not survive into turn 2.
        yield assistantMessage("msg-1", [{ type: "text", text: "Hello there" }]);
        yield idle; // settles turn 1 as cancelled
        const u2 = await iter.next();
        yield userEcho(u2.value); // activate turn 2
        yield messageStart("msg-2"); // resets streamedBlocks (the fix)
        yield textDelta("Second answer");
        yield assistantMessage("msg-2", [{ type: "text", text: "Second answer" }]);
        yield result();
        yield idle;
      }
      return messageGenerator();
    });

    const first = agent.prompt({
      sessionId: "test-session",
      prompt: [{ type: "text", text: "first" }],
    });
    // Wait until turn 1's deltas have streamed before cancelling.
    const deadline = Date.now() + 1000;
    while (!messageChunkTexts(updates).includes("there")) {
      if (Date.now() > deadline) throw new Error("turn 1 stream never arrived");
      await new Promise((r) => setTimeout(r, 1));
    }

    await agent.cancel({ sessionId: "test-session" });
    releaseCancel();
    await expect(first).resolves.toEqual({
      stopReason: "cancelled",
      usage: cancelledTurnUsage,
    });

    await agent.prompt({ sessionId: "test-session", prompt: [{ type: "text", text: "second" }] });

    // Turn 2's text appears exactly once (the live delta); the consolidated copy
    // is deduped despite the cancelled turn's leftover streamed text.
    expect(messageChunkTexts(updates).filter((t) => t === "Second answer")).toEqual([
      "Second answer",
    ]);
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

  // A cache-replayed turn reports output_tokens: 0 and, on some CLIs, carries
  // the answer only on the result — no deltas, no consolidated message.
  function replayedResult(text: string) {
    return { ...result(), result: text };
  }

  it("forwards the result text when nothing else carried it", async () => {
    const { agent, updates } = createMockAgentWithCapture();
    injectSession(agent, [replayedResult("**3**"), idle]);

    await agent.prompt({ sessionId: "test-session", prompt: [{ type: "text", text: "1+2" }] });

    expect(messageChunkTexts(updates)).toEqual(["**3**"]);
  });

  it("does not re-emit the result text after the consolidated message delivered it", async () => {
    const { agent, updates } = createMockAgentWithCapture();
    injectSession(agent, [
      assistantMessage("msg-1", [{ type: "text", text: "**3**" }]),
      replayedResult("**3**"),
      idle,
    ]);

    await agent.prompt({ sessionId: "test-session", prompt: [{ type: "text", text: "1+2" }] });

    expect(messageChunkTexts(updates)).toEqual(["**3**"]);
  });

  it("does not re-emit the result text when the echo lands mid-message", async () => {
    const { agent, updates } = createMockAgentWithCapture();
    // The echo activates the turn after the text has already streamed, and the
    // consolidated message then dedupes to nothing. The delivery flag survives
    // that activation, so the result must not re-emit the answer.
    injectSessionEchoAt(agent, [
      messageStart("msg-streamed"),
      textDelta("**3**"),
      "ECHO",
      assistantMessage("msg-streamed", [{ type: "text", text: "**3**" }]),
      replayedResult("**3**"),
      idle,
    ]);

    await agent.prompt({ sessionId: "test-session", prompt: [{ type: "text", text: "1+2" }] });

    expect(messageChunkTexts(updates)).toEqual(["**3**"]);
  });

  it("leaves the result text alone when the turn generated output tokens", async () => {
    const { agent, updates } = createMockAgentWithCapture();
    // output_tokens > 0 means the model produced this turn's text through the
    // stream/assistant paths; the result is their trailing copy, not the only one.
    injectSession(agent, [
      { ...replayedResult("**3**"), usage: { ...ZERO_USAGE, output_tokens: 5 } },
      idle,
    ]);

    await agent.prompt({ sessionId: "test-session", prompt: [{ type: "text", text: "1+2" }] });

    expect(messageChunkTexts(updates)).toEqual([]);
  });

  it("does not forward the result text of a task-notification followup", async () => {
    const { agent, updates } = createMockAgentWithCapture();
    injectSession(agent, [
      { ...replayedResult("background output"), origin: { kind: "task-notification" } },
      result(),
      idle,
    ]);

    await agent.prompt({ sessionId: "test-session", prompt: [{ type: "text", text: "1+2" }] });

    expect(messageChunkTexts(updates)).toEqual([]);
  });

  it("does not forward the result text of a turn that only emitted status text", async () => {
    const { agent, updates } = createMockAgentWithCapture();
    // `/compact` carries no echo, so it is promoted at its own result, and its
    // status text is emitted directly rather than through the forwarding loops.
    // That text still counts as delivered, so the result must not follow it.
    injectSession(agent, [
      { type: "system", subtype: "status", status: "compacting", session_id: "test-session" },
      replayedResult("conversation summarized"),
      idle,
    ]);

    await agent.prompt({ sessionId: "test-session", prompt: [{ type: "text", text: "/compact" }] });

    expect(messageChunkTexts(updates)).toEqual(["Compacting..."]);
  });

  // Like injectSession, but serves two prompts: each turn's echo is yielded
  // when its prompt arrives, followed by that turn's scripted messages.
  function injectSessionTwoTurns(agent: ClaudeAcpAgent, first: any[], second: any[]) {
    const input = new Pushable<any>();
    async function* messageGenerator() {
      const iter = input[Symbol.asyncIterator]();
      for (const messages of [first, second]) {
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
    }
    agent.sessions["test-session"] = mockSessionState({
      query: wrapQuery(messageGenerator()),
      input,
    });
  }

  it("does not re-emit the result text after an informational notice delivered it", async () => {
    const { agent, updates } = createMockAgentWithCapture();
    // A hook-blocked prompt: the SDK surfaces the block reason as an
    // informational notice and then repeats it on the result with zero output
    // tokens. The notice is the turn's delivered text — the fallback must not
    // emit the reason a second time.
    injectSession(agent, [
      {
        type: "system",
        subtype: "informational",
        content: "hook says no",
        level: "warning",
        session_id: "test-session",
      },
      replayedResult("hook says no"),
      idle,
    ]);

    await agent.prompt({ sessionId: "test-session", prompt: [{ type: "text", text: "1+2" }] });

    expect(messageChunkTexts(updates)).toEqual(["**Warning:** hook says no"]);
  });

  it("still forwards the result text after a turn failed without a result", async () => {
    const { agent, updates } = createMockAgentWithCapture();
    // Turn A streams partial text, then the SDK goes idle without ever
    // emitting its result (issue #825) — the turn fails, and the delivery
    // record it leaves behind must not suppress the retry's fallback.
    injectSessionTwoTurns(
      agent,
      [messageStart("msg-a"), textDelta("partial answ"), idle],
      [replayedResult("**3**"), idle],
    );

    await expect(
      agent.prompt({ sessionId: "test-session", prompt: [{ type: "text", text: "1+2" }] }),
    ).rejects.toThrow();

    await agent.prompt({ sessionId: "test-session", prompt: [{ type: "text", text: "1+2" }] });

    expect(messageChunkTexts(updates)).toEqual(["partial answ", "**3**"]);
  });

  it("does not let a refusal explanation suppress the next turn's fallback", async () => {
    const { agent, updates } = createMockAgentWithCapture();
    // The refusal explanation is emitted while the refused turn's result is
    // being handled; the stretch must still end at that result, or the next
    // replayed turn would read the explanation as ITS delivered answer and
    // end silently.
    injectSessionTwoTurns(
      agent,
      [
        {
          type: "system",
          subtype: "model_refusal_no_fallback",
          content: "cannot help with that",
          session_id: "test-session",
        },
        { ...result(), stop_reason: "refusal" },
        idle,
      ],
      [replayedResult("**3**"), idle],
    );

    const first = await agent.prompt({
      sessionId: "test-session",
      prompt: [{ type: "text", text: "nope" }],
    });
    expect(first.stopReason).toBe("refusal");

    await agent.prompt({ sessionId: "test-session", prompt: [{ type: "text", text: "1+2" }] });

    expect(messageChunkTexts(updates)).toEqual(["cannot help with that", "**3**"]);
  });

  it("forwards the result text when the backend omits output_tokens", async () => {
    const { agent, updates } = createMockAgentWithCapture();
    // Third-party backends have been observed emitting usage token fields as
    // null (see snapshotFromUsage), and the replay lane of issue #453 was
    // reported from exactly such a backend — a missing count must not
    // disable the fallback.
    injectSession(agent, [
      { ...replayedResult("**3**"), usage: { ...ZERO_USAGE, output_tokens: null } },
      idle,
    ]);

    await agent.prompt({ sessionId: "test-session", prompt: [{ type: "text", text: "1+2" }] });

    expect(messageChunkTexts(updates)).toEqual(["**3**"]);
  });

  it("forwards the result text when only subagent content preceded it", async () => {
    const { agent, updates } = createMockAgentWithCapture();
    // A subagent's image block passes the text/thinking filter but carries
    // the parentToolUseId meta — it is tool-internal, not the turn's answer,
    // so the replayed result must still be forwarded.
    injectSession(agent, [
      assistantMessage(
        "msg-sub",
        [{ type: "image", source: { type: "base64", data: "aGk=", media_type: "image/png" } }],
        "tool-1",
      ),
      replayedResult("**3**"),
      idle,
    ]);

    await agent.prompt({ sessionId: "test-session", prompt: [{ type: "text", text: "1+2" }] });

    expect(messageChunkTexts(updates)).toContain("**3**");
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
    } as unknown as AcpClient;
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
    } as unknown as AcpClient;
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
    } as unknown as AcpClient;
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
    } as unknown as AcpClient;
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
      agents: [],
      currentAgent: "default",
      fastModeEnabled: false,
      abortController: new AbortController(),
      emitRawSDKMessages: false,
      contextWindowSize: 200000,
      taskState: new Map(),
      toolUseCache: {},
      emittedToolCalls: new Set(),
      liveBackgroundTasks: new Map(),
      emittedAssistantText: false,
      owedTrailingIdles: 0,
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

    await expect(first).resolves.toEqual({
      stopReason: "cancelled",
      usage: cancelledTurnUsage,
    });
    await expect(second).resolves.toEqual(expect.objectContaining({ stopReason: "end_turn" }));
  });

  it("exposes the accumulated usage on a cancelled turn's PromptResponse (issue #844)", async () => {
    // The interrupted turn's result is dropped at the `session.cancelled`
    // guard, but its usage was already accumulated — the cancelled settle must
    // report it so clients metering token spend don't lose the round-trips
    // that completed before the cancel.
    const agent = createMockAgent();
    let releaseAfterCancel!: () => void;
    const afterCancel = new Promise<void>((resolve) => (releaseAfterCancel = resolve));
    injectGeneratorSession(agent, (input) => {
      async function* messageGenerator() {
        const iter = input[Symbol.asyncIterator]();
        const u1 = await iter.next();
        yield userEcho(u1.value); // turn 1 active
        await afterCancel; // wait until the test has cancelled turn 1
        // The interrupt still yields the turn's result (usage 10/5) before the
        // trailing idle that settles it cancelled.
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

    await expect(first).resolves.toEqual({
      stopReason: "cancelled",
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        cachedReadTokens: 0,
        cachedWriteTokens: 0,
        totalTokens: 15,
      },
    });
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

    await expect(first).resolves.toEqual({
      stopReason: "cancelled",
      usage: cancelledTurnUsage,
    });
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
    await expect(first).resolves.toEqual({
      stopReason: "cancelled",
      usage: cancelledTurnUsage,
    });

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

    // Turn 1 ran (and was cancelled mid-flight) so it reports its usage;
    // turn 2 never ran, so its cancelled settle carries none.
    await expect(first).resolves.toEqual({
      stopReason: "cancelled",
      usage: cancelledTurnUsage,
    });
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

    await expect(first).resolves.toEqual({
      stopReason: "cancelled",
      usage: cancelledTurnUsage,
    });
    await expect(second).resolves.toEqual({ stopReason: "cancelled" });
    const compactResult = await compact;
    expect(compactResult.stopReason).toBe("end_turn");
    // /compact settled with its OWN result (10 tokens), proving the orphan was
    // skipped — not promoted onto the /compact turn (which would leak its 999).
    expect(compactResult.usage?.inputTokens).toBe(10);
    await agent.sessions["test-session"]?.consumer;
  });

  it("uncounts an orphan the interrupt receipt reports dropped, so a no-echo result isn't swallowed", async () => {
    // interrupt_receipt_v1 CLIs: interrupt() resolves with `still_queued` —
    // the queued messages that will still run. Here the interrupt DROPS turn
    // 2's queued message (still_queued: []), so its orphan result never
    // arrives. Without the receipt reconciliation the stale count (1) would
    // swallow the next echo-less result — the /compact below — and hang its
    // prompt; activation's reset can't help because /compact never echoes.
    const agent = createMockAgent();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));

    injectGeneratorSession(agent, (input) => {
      async function* messageGenerator() {
        const iter = input[Symbol.asyncIterator]();
        const u1 = await iter.next();
        yield userEcho(u1.value); // turn 1 active
        await iter.next(); // turn 2's pushed message (cancelled; interrupt drops it)
        await gate; // wait until the test cancels and sends /compact
        yield { type: "system", subtype: "session_state_changed", state: "idle" }; // turn 1 settles cancelled
        // NO orphan result for turn 2 — the interrupt dropped its queued message.
        await iter.next(); // /compact's pushed message — never echoes its uuid
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
    // New-CLI interrupt: nothing queued survives the interrupt.
    agent.sessions["test-session"]!.query.interrupt = vi.fn(async () => ({ still_queued: [] }));

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

    await agent.cancel({ sessionId: "test-session" }); // counts turn 2, then the receipt uncounts it
    expect(agent.sessions["test-session"]?.pendingOrphanResults).toBe(0);
    const compact = agent.prompt({
      sessionId: "test-session",
      prompt: [{ type: "text", text: "/compact" }],
    });
    release();

    await expect(first).resolves.toEqual({
      stopReason: "cancelled",
      usage: cancelledTurnUsage,
    });
    await expect(second).resolves.toEqual({ stopReason: "cancelled" });
    const compactResult = await compact;
    expect(compactResult.stopReason).toBe("end_turn");
    expect(compactResult.usage?.inputTokens).toBe(10);
    await agent.sessions["test-session"]?.consumer;
  });

  it("keeps counting an orphan the interrupt receipt reports still queued", async () => {
    // The receipt lists turn 2's uuid in still_queued — its message survives
    // the interrupt, runs, and emits an orphan result that must still be
    // skipped (not promoted onto the later /compact).
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
        await iter.next(); // turn 2's pushed message (cancelled, but survives the interrupt)
        await gate;
        yield { type: "system", subtype: "session_state_changed", state: "idle" }; // turn 1 settles cancelled
        yield orphanResult; // turn 2's orphan — the kept count skips it
        await iter.next(); // /compact's pushed message — never echoes its uuid
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
    const second = agent.prompt({
      sessionId: "test-session",
      prompt: [{ type: "text", text: "second" }],
    });
    await waitFor(() => (agent.sessions["test-session"]?.turnQueue?.length ?? 0) >= 2);

    // Report turn 2's queued message as surviving the interrupt. Captured
    // before cancel() filters the queue (interrupt runs after the filter).
    const session = agent.sessions["test-session"]!;
    const survivingUuid = session.turnQueue![1].promptUuid;
    session.query.interrupt = vi.fn(async () => ({ still_queued: [survivingUuid] }));

    await agent.cancel({ sessionId: "test-session" });
    expect(agent.sessions["test-session"]?.pendingOrphanResults).toBe(1);
    const compact = agent.prompt({
      sessionId: "test-session",
      prompt: [{ type: "text", text: "/compact" }],
    });
    release();

    await expect(first).resolves.toEqual({
      stopReason: "cancelled",
      usage: cancelledTurnUsage,
    });
    await expect(second).resolves.toEqual({ stopReason: "cancelled" });
    const compactResult = await compact;
    expect(compactResult.stopReason).toBe("end_turn");
    // /compact settled with its OWN result, proving the surviving orphan was
    // skipped rather than promoted onto it (which would leak the 999).
    expect(compactResult.usage?.inputTokens).toBe(10);
    await agent.sessions["test-session"]?.consumer;
  });

  // msg_lifecycle_v1 CLIs (2.1.206+): cancel() tracks orphans per-uuid in
  // `orphanCommands`, drained by each command's own terminal lifecycle frame
  // instead of by counting results. (lifecycleInit / lifecycleFrame are the
  // module-scope helpers next to userEcho.)

  it("drains BOTH coalesced orphans on their one shared result (one result for two commands)", async () => {
    // Two cancelled queued turns can be FOLDED into one SDK turn that emits a
    // single result (observed live against CLI 2.1.206). A count would go
    // stale at 1 and swallow the /compact result below, hanging its prompt —
    // the shared result instead covers every "started" map entry at once
    // (they were all dispatched into the emitting turn), and the trailing
    // `completed` frames no-op on the already-drained entries.
    const agent = createMockAgent();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));

    const coalescedResult = createResultMessage({
      subtype: "success",
      stop_reason: "end_turn",
      is_error: false,
    });
    coalescedResult.usage.input_tokens = 999;

    injectGeneratorSession(agent, (input) => {
      async function* messageGenerator() {
        const iter = input[Symbol.asyncIterator]();
        const u1 = await iter.next();
        yield lifecycleInit; // latch msgLifecycleV1
        yield userEcho(u1.value); // turn 1 active
        const u2 = await iter.next(); // turn 2 queued (cancelled below)
        const u3 = await iter.next(); // turn 3 queued (cancelled below)
        await gate; // test cancels (orphans u2+u3) and sends /compact
        yield { type: "system", subtype: "session_state_changed", state: "idle" }; // turn 1 settles cancelled
        yield lifecycleFrame(u2.value.uuid, "started"); // both survivors dispatched
        yield lifecycleFrame(u3.value.uuid, "started"); // into ONE coalesced turn
        yield coalescedResult; // the shared orphan result — skipped, drains BOTH entries
        yield lifecycleFrame(u2.value.uuid, "completed"); // terminal frames no-op
        yield lifecycleFrame(u3.value.uuid, "completed"); // on the drained entries
        await iter.next(); // /compact's pushed message — never echoes its uuid
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
    const second = agent.prompt({
      sessionId: "test-session",
      prompt: [{ type: "text", text: "second" }],
    });
    const third = agent.prompt({
      sessionId: "test-session",
      prompt: [{ type: "text", text: "third" }],
    });
    await waitFor(() => (agent.sessions["test-session"]?.turnQueue?.length ?? 0) >= 3);

    await agent.cancel({ sessionId: "test-session" });
    expect(agent.sessions["test-session"]?.orphanCommands?.size).toBe(2);
    // The count lane must be untouched — the map is the only skip source here.
    expect(agent.sessions["test-session"]?.pendingOrphanResults ?? 0).toBe(0);
    const compact = agent.prompt({
      sessionId: "test-session",
      prompt: [{ type: "text", text: "/compact" }],
    });
    release();

    await expect(first).resolves.toEqual({
      stopReason: "cancelled",
      usage: cancelledTurnUsage,
    });
    await expect(second).resolves.toEqual({ stopReason: "cancelled" });
    await expect(third).resolves.toEqual({ stopReason: "cancelled" });
    const compactResult = await compact;
    expect(compactResult.stopReason).toBe("end_turn");
    // /compact settled with its own result — the coalesced orphan's 999 was
    // skipped, draining both map entries it covered.
    expect(compactResult.usage?.inputTokens).toBe(10);
    expect(agent.sessions["test-session"]?.orphanCommands?.size).toBe(0);
    await agent.sessions["test-session"]?.consumer;
  });

  it("forgets an orphan whose `cancelled` frame precedes any `started` (dropped, no result coming)", async () => {
    const agent = createMockAgent();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));

    injectGeneratorSession(agent, (input) => {
      async function* messageGenerator() {
        const iter = input[Symbol.asyncIterator]();
        const u1 = await iter.next();
        yield lifecycleInit;
        yield userEcho(u1.value); // turn 1 active
        const u2 = await iter.next(); // turn 2 queued (cancelled below)
        await gate;
        yield { type: "system", subtype: "session_state_changed", state: "idle" }; // turn 1 settles cancelled
        yield lifecycleFrame(u2.value.uuid, "cancelled"); // dropped before dispatch
        // NO orphan result — the command never ran.
        await iter.next(); // /compact's pushed message
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
    const second = agent.prompt({
      sessionId: "test-session",
      prompt: [{ type: "text", text: "second" }],
    });
    await waitFor(() => (agent.sessions["test-session"]?.turnQueue?.length ?? 0) >= 2);

    await agent.cancel({ sessionId: "test-session" });
    expect(agent.sessions["test-session"]?.orphanCommands?.size).toBe(1);
    const compact = agent.prompt({
      sessionId: "test-session",
      prompt: [{ type: "text", text: "/compact" }],
    });
    release();

    await expect(first).resolves.toEqual({
      stopReason: "cancelled",
      usage: cancelledTurnUsage,
    });
    await expect(second).resolves.toEqual({ stopReason: "cancelled" });
    const compactResult = await compact;
    expect(compactResult.stopReason).toBe("end_turn");
    expect(compactResult.usage?.inputTokens).toBe(10);
    await agent.sessions["test-session"]?.consumer;
  });

  it("skips a zombie orphan's late result exactly once (`cancelled` after `started`)", async () => {
    // The orphan was dispatched, then its turn was aborted: `cancelled` after
    // `started` means no more lifecycle frames come, but the dead turn's
    // result may still arrive. It must be skipped (not promoted onto
    // /compact) AND consume the zombie entry so it can't skip forever.
    const agent = createMockAgent();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));

    const zombieResult = createResultMessage({
      subtype: "error_during_execution",
      stop_reason: null,
      is_error: true,
    });
    zombieResult.usage.input_tokens = 999;

    injectGeneratorSession(agent, (input) => {
      async function* messageGenerator() {
        const iter = input[Symbol.asyncIterator]();
        const u1 = await iter.next();
        yield lifecycleInit;
        yield userEcho(u1.value); // turn 1 active
        const u2 = await iter.next(); // turn 2 queued (cancelled below)
        await gate;
        yield { type: "system", subtype: "session_state_changed", state: "idle" }; // turn 1 settles cancelled
        yield lifecycleFrame(u2.value.uuid, "started"); // dispatched...
        yield lifecycleFrame(u2.value.uuid, "cancelled"); // ...then its turn aborted -> zombie
        yield zombieResult; // the dead turn's late result — skipped, consumes the zombie
        await iter.next(); // /compact's pushed message
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
    const second = agent.prompt({
      sessionId: "test-session",
      prompt: [{ type: "text", text: "second" }],
    });
    await waitFor(() => (agent.sessions["test-session"]?.turnQueue?.length ?? 0) >= 2);

    await agent.cancel({ sessionId: "test-session" });
    const compact = agent.prompt({
      sessionId: "test-session",
      prompt: [{ type: "text", text: "/compact" }],
    });
    release();

    await expect(first).resolves.toEqual({
      stopReason: "cancelled",
      usage: cancelledTurnUsage,
    });
    await expect(second).resolves.toEqual({ stopReason: "cancelled" });
    const compactResult = await compact;
    expect(compactResult.stopReason).toBe("end_turn");
    expect(compactResult.usage?.inputTokens).toBe(10);
    expect(agent.sessions["test-session"]?.orphanCommands?.size).toBe(0);
    await agent.sessions["test-session"]?.consumer;
  });

  it("forgets a pending orphan the interrupt receipt reports dropped (lifecycle lane)", async () => {
    // Belt-and-suspenders: even if the CLI never emits a `cancelled` frame
    // for an interrupt-dropped command, the receipt's still_queued removes
    // the pending entry so /compact's echo-less result isn't swallowed.
    const agent = createMockAgent();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));

    injectGeneratorSession(agent, (input) => {
      async function* messageGenerator() {
        const iter = input[Symbol.asyncIterator]();
        const u1 = await iter.next();
        yield lifecycleInit;
        yield userEcho(u1.value); // turn 1 active
        await iter.next(); // turn 2's pushed message (dropped by the interrupt)
        await gate;
        yield { type: "system", subtype: "session_state_changed", state: "idle" }; // turn 1 settles cancelled
        // NO lifecycle frames and NO result for turn 2 — dropped silently.
        await iter.next(); // /compact's pushed message
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
    agent.sessions["test-session"]!.query.interrupt = vi.fn(async () => ({ still_queued: [] }));

    const first = agent.prompt({
      sessionId: "test-session",
      prompt: [{ type: "text", text: "first" }],
    });
    await waitFor(() => !!agent.sessions["test-session"]?.activeTurn);
    // Latch the capability before cancel() picks a lane: the init frame above
    // is only processed once the consumer drains it, which the first
    // activation already guarantees here.
    await waitFor(() => !!agent.sessions["test-session"]?.msgLifecycleV1);
    const second = agent.prompt({
      sessionId: "test-session",
      prompt: [{ type: "text", text: "second" }],
    });
    await waitFor(() => (agent.sessions["test-session"]?.turnQueue?.length ?? 0) >= 2);

    await agent.cancel({ sessionId: "test-session" });
    expect(agent.sessions["test-session"]?.orphanCommands?.size).toBe(0);
    const compact = agent.prompt({
      sessionId: "test-session",
      prompt: [{ type: "text", text: "/compact" }],
    });
    release();

    await expect(first).resolves.toEqual({
      stopReason: "cancelled",
      usage: cancelledTurnUsage,
    });
    await expect(second).resolves.toEqual({ stopReason: "cancelled" });
    const compactResult = await compact;
    expect(compactResult.stopReason).toBe("end_turn");
    expect(compactResult.usage?.inputTokens).toBe(10);
    await agent.sessions["test-session"]?.consumer;
  });

  it("deletes (not zombifies) an orphan whose `cancelled` frame arrives AFTER its error result", async () => {
    // The live-observed abort ordering is started → error result → cancelled.
    // The result deletes the "started" entry when it is skipped; the late
    // `cancelled` must then no-op — a zombie here would be a phantom (its
    // result already came) that swallows the next echo-less result and hangs
    // /compact.
    const agent = createMockAgent();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));

    const abortedResult = createResultMessage({
      subtype: "error_during_execution",
      stop_reason: null,
      is_error: true,
    });
    abortedResult.usage.input_tokens = 999;

    injectGeneratorSession(agent, (input) => {
      async function* messageGenerator() {
        const iter = input[Symbol.asyncIterator]();
        const u1 = await iter.next();
        yield lifecycleInit;
        yield userEcho(u1.value); // turn 1 active
        const u2 = await iter.next(); // turn 2 queued (cancelled below)
        await gate;
        yield { type: "system", subtype: "session_state_changed", state: "idle" }; // turn 1 settles cancelled
        yield lifecycleFrame(u2.value.uuid, "started"); // dispatched...
        yield abortedResult; // ...its turn dies: error result FIRST (observed ordering)
        yield lifecycleFrame(u2.value.uuid, "cancelled"); // ...terminal frame after — must no-op, not zombify
        await iter.next(); // /compact's pushed message
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
    const second = agent.prompt({
      sessionId: "test-session",
      prompt: [{ type: "text", text: "second" }],
    });
    await waitFor(() => (agent.sessions["test-session"]?.turnQueue?.length ?? 0) >= 2);

    await agent.cancel({ sessionId: "test-session" });
    const compact = agent.prompt({
      sessionId: "test-session",
      prompt: [{ type: "text", text: "/compact" }],
    });
    release();

    await expect(first).resolves.toEqual({
      stopReason: "cancelled",
      usage: cancelledTurnUsage,
    });
    await expect(second).resolves.toEqual({ stopReason: "cancelled" });
    const compactResult = await compact;
    expect(compactResult.stopReason).toBe("end_turn");
    expect(compactResult.usage?.inputTokens).toBe(10);
    expect(agent.sessions["test-session"]?.orphanCommands?.size).toBe(0);
    await agent.sessions["test-session"]?.consumer;
  });

  it("drains ALL coalesced orphans of an aborted turn on its single error result", async () => {
    // Two cancelled queued commands folded into ONE turn that the interrupt
    // then aborts: one shared error result, then a `cancelled` frame per
    // command. The result must cover BOTH entries (deleting them so the
    // cancelled frames no-op) — leaving one as a zombie would swallow
    // /compact's result and hang it.
    const agent = createMockAgent();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));

    const abortedResult = createResultMessage({
      subtype: "error_during_execution",
      stop_reason: null,
      is_error: true,
    });
    abortedResult.usage.input_tokens = 999;

    injectGeneratorSession(agent, (input) => {
      async function* messageGenerator() {
        const iter = input[Symbol.asyncIterator]();
        const u1 = await iter.next();
        yield lifecycleInit;
        yield userEcho(u1.value); // turn 1 active
        const u2 = await iter.next(); // turn 2 queued (cancelled below)
        const u3 = await iter.next(); // turn 3 queued (cancelled below)
        await gate;
        yield { type: "system", subtype: "session_state_changed", state: "idle" }; // turn 1 settles cancelled
        yield lifecycleFrame(u2.value.uuid, "started"); // both dispatched into
        yield lifecycleFrame(u3.value.uuid, "started"); // ONE coalesced turn...
        yield abortedResult; // ...which aborts: ONE shared error result
        yield lifecycleFrame(u2.value.uuid, "cancelled"); // per-command terminals
        yield lifecycleFrame(u3.value.uuid, "cancelled");
        await iter.next(); // /compact's pushed message
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
    const second = agent.prompt({
      sessionId: "test-session",
      prompt: [{ type: "text", text: "second" }],
    });
    const third = agent.prompt({
      sessionId: "test-session",
      prompt: [{ type: "text", text: "third" }],
    });
    await waitFor(() => (agent.sessions["test-session"]?.turnQueue?.length ?? 0) >= 3);

    await agent.cancel({ sessionId: "test-session" });
    expect(agent.sessions["test-session"]?.orphanCommands?.size).toBe(2);
    const compact = agent.prompt({
      sessionId: "test-session",
      prompt: [{ type: "text", text: "/compact" }],
    });
    release();

    await expect(first).resolves.toEqual({
      stopReason: "cancelled",
      usage: cancelledTurnUsage,
    });
    await expect(second).resolves.toEqual({ stopReason: "cancelled" });
    await expect(third).resolves.toEqual({ stopReason: "cancelled" });
    const compactResult = await compact;
    expect(compactResult.stopReason).toBe("end_turn");
    expect(compactResult.usage?.inputTokens).toBe(10);
    expect(agent.sessions["test-session"]?.orphanCommands?.size).toBe(0);
    await agent.sessions["test-session"]?.consumer;
  });

  it("does not seed an orphan for a queued command whose terminal frame already passed", async () => {
    // A queued command can fold into the ACTIVE turn and finish (started +
    // completed frames consumed) while its Turn still sits queued. A later
    // cancel() must not seed an entry for it: its one-and-only terminal frame
    // is spent, so nothing would ever drain the entry and it would swallow
    // /compact's echo-less result.
    const agent = createMockAgent();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));

    injectGeneratorSession(agent, (input) => {
      async function* messageGenerator() {
        const iter = input[Symbol.asyncIterator]();
        const u1 = await iter.next();
        yield lifecycleInit;
        yield userEcho(u1.value); // turn 1 active
        const u2 = await iter.next(); // turn 2 queued...
        yield lifecycleFrame(u2.value.uuid, "started"); // ...folded into turn 1
        yield lifecycleFrame(u2.value.uuid, "completed"); // ...and finished pre-cancel
        await gate;
        yield { type: "system", subtype: "session_state_changed", state: "idle" }; // turn 1 settles cancelled
        // NO further frames and NO orphan result for u2 — it is spent.
        await iter.next(); // /compact's pushed message
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
    const second = agent.prompt({
      sessionId: "test-session",
      prompt: [{ type: "text", text: "second" }],
    });
    // Wait for the consumer to record u2's terminal frame on the queued Turn
    // before cancelling, so cancel() sees commandFinished.
    await waitFor(
      () =>
        agent.sessions["test-session"]?.turnQueue?.some(
          (t: any) => t.commandFinished === "completed",
        ) === true,
    );

    await agent.cancel({ sessionId: "test-session" });
    expect(agent.sessions["test-session"]?.orphanCommands?.size ?? 0).toBe(0);
    const compact = agent.prompt({
      sessionId: "test-session",
      prompt: [{ type: "text", text: "/compact" }],
    });
    release();

    await expect(first).resolves.toEqual({
      stopReason: "cancelled",
      usage: cancelledTurnUsage,
    });
    await expect(second).resolves.toEqual({ stopReason: "cancelled" });
    const compactResult = await compact;
    expect(compactResult.stopReason).toBe("end_turn");
    expect(compactResult.usage?.inputTokens).toBe(10);
    await agent.sessions["test-session"]?.consumer;
  });

  it("stops blocking on a started orphan whose terminal frame never arrives", async () => {
    // Crash caveat: a turn that dies by throwing can leak an entry with no
    // terminal frame. The orphan's own result deletes the "started" entry, so
    // later echo-less results must FALL THROUGH to head promotion (the
    // entry's turn already produced its result) instead of being swallowed
    // one after another — /compact here must settle normally with nothing
    // left in the map.
    const agent = createMockAgent();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));

    const orphanResult = createResultMessage({
      subtype: "error_during_execution",
      stop_reason: null,
      is_error: true,
    });
    orphanResult.usage.input_tokens = 999;

    injectGeneratorSession(agent, (input) => {
      async function* messageGenerator() {
        const iter = input[Symbol.asyncIterator]();
        const u1 = await iter.next();
        yield lifecycleInit;
        yield userEcho(u1.value); // turn 1 active
        const u2 = await iter.next(); // turn 2 queued (cancelled below)
        await gate;
        yield { type: "system", subtype: "session_state_changed", state: "idle" }; // turn 1 settles cancelled
        yield lifecycleFrame(u2.value.uuid, "started"); // dispatched...
        yield orphanResult; // ...its result arrives (entry deleted)...
        // ...and its terminal frame is LOST (turn died by throwing).
        await iter.next(); // /compact's pushed message
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
    const second = agent.prompt({
      sessionId: "test-session",
      prompt: [{ type: "text", text: "second" }],
    });
    await waitFor(() => (agent.sessions["test-session"]?.turnQueue?.length ?? 0) >= 2);

    await agent.cancel({ sessionId: "test-session" });
    const compact = agent.prompt({
      sessionId: "test-session",
      prompt: [{ type: "text", text: "/compact" }],
    });
    release();

    await expect(first).resolves.toEqual({
      stopReason: "cancelled",
      usage: cancelledTurnUsage,
    });
    await expect(second).resolves.toEqual({ stopReason: "cancelled" });
    const compactResult = await compact;
    expect(compactResult.stopReason).toBe("end_turn");
    expect(compactResult.usage?.inputTokens).toBe(10);
    // The orphan's own result already deleted the entry.
    expect(agent.sessions["test-session"]?.orphanCommands?.size).toBe(0);
    await agent.sessions["test-session"]?.consumer;
  });

  it("consumes an orphan's result that arrives while the turn queue is empty", async () => {
    // The common post-cancel timeline: the active turn settles at the
    // interrupt's idle, the user hasn't typed yet, and only THEN does the
    // orphaned command's dead turn flush its frames and error result. The
    // bookkeeping must run even with nothing to promote — skipping it would
    // leave a "started" entry that the later `cancelled` frame turns into a
    // phantom zombie, swallowing the next /compact result.
    const agent = createMockAgent();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));

    const orphanResult = createResultMessage({
      subtype: "error_during_execution",
      stop_reason: null,
      is_error: true,
    });
    orphanResult.usage.input_tokens = 999;

    injectGeneratorSession(agent, (input) => {
      async function* messageGenerator() {
        const iter = input[Symbol.asyncIterator]();
        const u1 = await iter.next();
        yield lifecycleInit;
        yield userEcho(u1.value); // turn 1 active
        const u2 = await iter.next(); // turn 2 queued (cancelled below)
        await gate;
        yield { type: "system", subtype: "session_state_changed", state: "idle" }; // turn 1 settles cancelled — queue now EMPTY
        yield lifecycleFrame(u2.value.uuid, "started"); // dispatched...
        yield orphanResult; // ...result arrives with an empty queue — must drain the entry
        yield lifecycleFrame(u2.value.uuid, "cancelled"); // must no-op, not zombify
        await iter.next(); // /compact's pushed message — only sent once the map drained
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
    const second = agent.prompt({
      sessionId: "test-session",
      prompt: [{ type: "text", text: "second" }],
    });
    await waitFor(() => (agent.sessions["test-session"]?.turnQueue?.length ?? 0) >= 2);

    await agent.cancel({ sessionId: "test-session" });
    expect(agent.sessions["test-session"]?.orphanCommands?.size).toBe(1);
    release();

    await expect(first).resolves.toEqual({
      stopReason: "cancelled",
      usage: cancelledTurnUsage,
    });
    await expect(second).resolves.toEqual({ stopReason: "cancelled" });
    // The orphan's headless result must have drained its own entry — this
    // waitFor hangs (and fails the test) if the empty-queue result skipped
    // the bookkeeping.
    await waitFor(() => agent.sessions["test-session"]?.orphanCommands?.size === 0);
    // Only prompt /compact once the queue was provably empty at the orphan
    // result, so this test pins the headless path specifically.
    const compact = agent.prompt({
      sessionId: "test-session",
      prompt: [{ type: "text", text: "/compact" }],
    });
    const compactResult = await compact;
    expect(compactResult.stopReason).toBe("end_turn");
    expect(compactResult.usage?.inputTokens).toBe(10);
    await agent.sessions["test-session"]?.consumer;
  });

  it("does not zombify a command folded into the active turn whose shared result was the active turn's", async () => {
    // A queued command can FOLD into the still-active turn. After a cancel
    // orphans it ("started" entry), the fold's shared result arrives while
    // the absorbing turn is still active — attributed there, never reaching
    // the echo-less skip. That result must still cover the orphan's entry;
    // otherwise the trailing `cancelled` frame zombifies it into a phantom
    // that swallows /compact's result.
    const agent = createMockAgent();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));

    const sharedResult = createResultMessage({
      subtype: "success",
      stop_reason: "end_turn",
      is_error: false,
    });
    sharedResult.usage.input_tokens = 999;

    injectGeneratorSession(agent, (input) => {
      async function* messageGenerator() {
        const iter = input[Symbol.asyncIterator]();
        const u1 = await iter.next();
        yield lifecycleInit;
        yield userEcho(u1.value); // turn 1 active
        const u2 = await iter.next(); // turn 2 queued...
        yield lifecycleFrame(u2.value.uuid, "started"); // ...folded into ACTIVE turn 1
        await gate; // test cancels (orphans u2 as "started")
        yield sharedResult; // the fold's shared result — turn 1 is still active; must cover u2's entry
        yield { type: "system", subtype: "session_state_changed", state: "idle" }; // turn 1 settles cancelled
        yield lifecycleFrame(u2.value.uuid, "cancelled"); // must no-op, not zombify
        await iter.next(); // /compact's pushed message
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
    const second = agent.prompt({
      sessionId: "test-session",
      prompt: [{ type: "text", text: "second" }],
    });
    // Wait for the fold's "started" frame to latch, so cancel() seeds the
    // entry as "started" (dispatched, result still coming).
    await waitFor(
      () => agent.sessions["test-session"]?.turnQueue?.some((t: any) => t.commandStarted) === true,
    );

    await agent.cancel({ sessionId: "test-session" });
    expect(agent.sessions["test-session"]?.orphanCommands?.size).toBe(1);
    const compact = agent.prompt({
      sessionId: "test-session",
      prompt: [{ type: "text", text: "/compact" }],
    });
    release();

    const firstResult = await first;
    expect(firstResult.stopReason).toBe("cancelled");
    // The shared result arrived pre-idle, so its usage is the cancelled
    // turn's spend.
    expect(firstResult.usage?.inputTokens).toBe(999);
    await expect(second).resolves.toEqual({ stopReason: "cancelled" });
    const compactResult = await compact;
    expect(compactResult.stopReason).toBe("end_turn");
    expect(compactResult.usage?.inputTokens).toBe(10);
    expect(agent.sessions["test-session"]?.orphanCommands?.size).toBe(0);
    await agent.sessions["test-session"]?.consumer;
  });

  it("does not seed a zombie for a fold-aborted command whose shared result passed BEFORE the cancel", async () => {
    // The pre-cancel variant of the fold: turn 1 absorbs the queued command,
    // then dies — its error result is consumed as turn 1's (rejecting it) and
    // the command's `cancelled` frame latches commandFinished on the still-
    // queued turn 2, all before any cancel. cancel() must then seed NOTHING
    // for turn 2: its result already passed, so a zombie would be a phantom
    // that swallows /compact's result.
    const agent = createMockAgent();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));

    const abortedResult = createResultMessage({
      subtype: "error_during_execution",
      stop_reason: null,
      is_error: true,
    });
    abortedResult.usage.input_tokens = 999;

    injectGeneratorSession(agent, (input) => {
      async function* messageGenerator() {
        const iter = input[Symbol.asyncIterator]();
        const u1 = await iter.next();
        yield lifecycleInit;
        yield userEcho(u1.value); // turn 1 active
        const u2 = await iter.next(); // turn 2 queued...
        yield lifecycleFrame(u2.value.uuid, "started"); // ...folded into ACTIVE turn 1
        yield abortedResult; // turn 1 dies: the shared error result rejects it (u2's result has now passed)
        yield { type: "system", subtype: "session_state_changed", state: "idle" }; // the error's trailing idle
        yield lifecycleFrame(u2.value.uuid, "cancelled"); // u2's terminal frame, consumed pre-cancel
        await gate; // test cancels here — must seed nothing for u2
        await iter.next(); // /compact's pushed message
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
    const second = agent.prompt({
      sessionId: "test-session",
      prompt: [{ type: "text", text: "second" }],
    });
    // turn 1's rejection confirms the shared result was consumed.
    await expect(first).rejects.toThrow();
    // Wait for u2's terminal frame to latch on the queued turn before
    // cancelling, so cancel() sees commandFinished === "cancelled" AND
    // commandResultSeen.
    await waitFor(
      () =>
        agent.sessions["test-session"]?.turnQueue?.some(
          (t: any) => t.commandFinished === "cancelled" && t.commandResultSeen === true,
        ) === true,
    );

    await agent.cancel({ sessionId: "test-session" });
    expect(agent.sessions["test-session"]?.orphanCommands?.size ?? 0).toBe(0);
    const compact = agent.prompt({
      sessionId: "test-session",
      prompt: [{ type: "text", text: "/compact" }],
    });
    release();

    await expect(second).resolves.toEqual({ stopReason: "cancelled" });
    const compactResult = await compact;
    expect(compactResult.stopReason).toBe("end_turn");
    expect(compactResult.usage?.inputTokens).toBe(10);
    await agent.sessions["test-session"]?.consumer;
  });

  it("does not seed an orphan on force-cancel when the wedged turn's result and terminal frame already passed", async () => {
    // Wedge variant of the spent-frame rule: the interrupt aborts the active
    // turn and the consumer drains its error result (dropped at the
    // cancelled guard) and its `cancelled` frame — then the stream wedges
    // before the trailing idle and the force-cancel backstop settles the
    // turn. The backstop must seed NOTHING: both the result and the one-and-
    // only terminal frame are spent, so an entry could never drain and would
    // swallow /compact's result when the SDK recovers.
    const agent = createMockAgent();
    agent.forceCancelGraceMs = 50;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let releaseWedge!: () => void;
    const wedge = new Promise<void>((resolve) => (releaseWedge = resolve));

    const abortedResult = createResultMessage({
      subtype: "error_during_execution",
      stop_reason: null,
      is_error: true,
    });
    abortedResult.usage.input_tokens = 999;

    injectGeneratorSession(agent, (input) => {
      async function* messageGenerator() {
        const iter = input[Symbol.asyncIterator]();
        const u1 = await iter.next();
        yield lifecycleInit;
        yield userEcho(u1.value); // turn 1 active
        yield lifecycleFrame(u1.value.uuid, "started"); // its own dispatch frame
        await gate; // test cancels here
        yield abortedResult; // dropped at the cancelled guard; marks the command's result seen
        yield lifecycleFrame(u1.value.uuid, "cancelled"); // terminal frame consumed...
        await wedge; // ...then the stream wedges: no trailing idle; the backstop fires
        await iter.next(); // SDK "recovers": /compact's pushed message
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
    await waitFor(
      () => agent.sessions["test-session"]?.turnQueue?.some((t: any) => t.commandStarted) === true,
    );

    await agent.cancel({ sessionId: "test-session" });
    release();

    // The backstop settles the pending prompt after the grace elapses.
    const firstResult = await first;
    expect(firstResult.stopReason).toBe("cancelled");
    // Nothing seeded on either lane: result and terminal frame were spent.
    expect(agent.sessions["test-session"]?.orphanCommands?.size ?? 0).toBe(0);
    expect(agent.sessions["test-session"]?.pendingOrphanResults ?? 0).toBe(0);

    releaseWedge();
    const compact = agent.prompt({
      sessionId: "test-session",
      prompt: [{ type: "text", text: "/compact" }],
    });
    const compactResult = await compact;
    expect(compactResult.stopReason).toBe("end_turn");
    expect(compactResult.usage?.inputTokens).toBe(10);
    await agent.sessions["test-session"]?.consumer;
  });
});

describe("deferred settlement for live background subagents (issues #864/#866)", () => {
  // A turn whose terminal result arrives while background subagents IT
  // spawned are still live must NOT settle at that result: ACP allows
  // out-of-turn session/update, but many clients stop consuming at the
  // prompt response, so the subagents' remaining output would be dropped
  // and their permission requests would block on an RPC nobody answers. The turn is held open
  // across the CLI's idle cycles (observed cadence: user result → idle →
  // subagent works → task_notification → followup turn → idle) and settles
  // once its subagents are done — at the followup's terminal result, or at
  // an idle with none of them left.

  function createMockAgent() {
    const mockClient = {
      sessionUpdate: async () => {},
    } as unknown as AcpClient;
    return new ClaudeAcpAgent(mockClient, { log: () => {}, error: () => {} });
  }

  const waitFor = async (cond: () => boolean) => {
    for (let i = 0; i < 200; i++) {
      if (cond()) return;
      await new Promise((r) => setTimeout(r, 0));
    }
    throw new Error("waitFor timed out");
  };

  function resultMessage(overrides: Record<string, any> = {}) {
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
      ...overrides,
    };
  }

  const stateChanged = (state: "running" | "idle" | "requires_action") => ({
    type: "system",
    subtype: "session_state_changed",
    state,
    uuid: randomUUID(),
    session_id: "test-session",
  });
  const running = () => stateChanged("running");
  const idle = () => stateChanged("idle");
  const requiresAction = () => stateChanged("requires_action");

  /** Agent whose client records top-level agent_message_chunk texts as
   *  `chunk:<text>` in the returned events array. */
  const chunkCapturingAgent = () => {
    const events: string[] = [];
    const mockClient = {
      sessionUpdate: async (u: any) => {
        if (u.update?.sessionUpdate === "agent_message_chunk") {
          events.push(`chunk:${u.update.content?.text}`);
        }
      },
    } as unknown as AcpClient;
    const agent = new ClaudeAcpAgent(mockClient, { log: () => {}, error: () => {} });
    return { agent, events };
  };

  /** The issue-#453 cache-replay shape: zero output tokens, no streaming,
   *  the answer only on the result text. */
  const replayedResult = (text: string) =>
    resultMessage({
      result: text,
      usage: {
        input_tokens: 10,
        output_tokens: 0,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    });

  const backgroundTasksChanged = (taskIds: string[]) => ({
    type: "system",
    subtype: "background_tasks_changed",
    tasks: taskIds.map((task_id) => ({
      task_id,
      task_type: "local_agent",
      description: "explore",
    })),
    uuid: randomUUID(),
    session_id: "test-session",
  });

  /** A background Task/Agent-tool subagent starting (subagent_type set). */
  const subagentStarted = (taskId: string) => ({
    type: "system",
    subtype: "task_started",
    task_id: taskId,
    tool_use_id: `toolu_${taskId}`,
    description: "Explore the project",
    subagent_type: "Explore",
    uuid: randomUUID(),
    session_id: "test-session",
  });

  const taskNotification = (taskId: string) => ({
    type: "system",
    subtype: "task_notification",
    task_id: taskId,
    tool_use_id: `toolu_${taskId}`,
    status: "completed",
    output_file: "",
    summary: "done",
    uuid: randomUUID(),
    session_id: "test-session",
  });

  const assistantText = (text: string) => ({
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
      content: [{ type: "text", text }],
    },
  });

  it("holds the prompt open while a subagent is live and resolves at the followup's result", async () => {
    const { agent, events } = chunkCapturingAgent();

    injectGeneratorSession(agent, (input) => {
      async function* messageGenerator() {
        const iter = input[Symbol.asyncIterator]();
        const { value: userMessage } = await iter.next();
        yield userEcho(userMessage);
        yield running();
        yield subagentStarted("agent-1");
        // The user turn's terminal result: the subagent is still live, so the
        // prompt must NOT resolve here.
        yield resultMessage();
        // The CLI does not hold its trailing idle for background agents —
        // it arrives immediately, while the subagent still runs. The hold
        // must survive it.
        yield idle();
        // The subagent finishes; the model wakes and streams the promised
        // followup summary, which must land inside the still-open turn.
        yield taskNotification("agent-1");
        yield assistantText("promised summary");
        yield resultMessage({ origin: { kind: "task-notification" } });
        yield idle();
      }
      return messageGenerator();
    });

    const response = await agent
      .prompt({ sessionId: "test-session", prompt: [{ type: "text", text: "explore" }] })
      .then((r) => {
        events.push("resolved");
        return r;
      });

    expect(response.stopReason).toBe("end_turn");
    // The user turn's own usage — the task-notification followup's tokens are
    // reported separately, not folded into the prompt response.
    expect(response.usage?.totalTokens).toBe(15);
    // The followup summary streamed BEFORE the prompt resolved, i.e. inside
    // the turn, where every client is still listening.
    const summaryIndex = events.indexOf("chunk:promised summary");
    expect(summaryIndex).toBeGreaterThanOrEqual(0);
    expect(summaryIndex).toBeLessThan(events.indexOf("resolved"));
    await agent.sessions["test-session"]?.consumer;
  });

  it("falls back to settling at an idle when no followup comes", async () => {
    const agent = createMockAgent();

    injectGeneratorSession(agent, (input) => {
      async function* messageGenerator() {
        const iter = input[Symbol.asyncIterator]();
        const { value: userMessage } = await iter.next();
        yield userEcho(userMessage);
        yield running();
        yield subagentStarted("agent-1");
        yield resultMessage();
        yield idle(); // the turn's own trailer — still waiting, must hold
        yield taskNotification("agent-1"); // subagent done, but no followup
        yield idle(); // nothing left to wait for — settles here
      }
      return messageGenerator();
    });

    const response = await agent.prompt({
      sessionId: "test-session",
      prompt: [{ type: "text", text: "explore" }],
    });
    expect(response.stopReason).toBe("end_turn");
    await agent.sessions["test-session"]?.consumer;
  });

  it("resolves at the result when the subagent already settled during the turn", async () => {
    const agent = createMockAgent();
    let releaseIdle!: () => void;
    const idleGate = new Promise<void>((resolve) => (releaseIdle = resolve));
    let idleYielded = false;

    injectGeneratorSession(agent, (input) => {
      async function* messageGenerator() {
        const iter = input[Symbol.asyncIterator]();
        const { value: userMessage } = await iter.next();
        yield userEcho(userMessage);
        yield running();
        yield subagentStarted("agent-1");
        yield taskNotification("agent-1"); // settled before the result
        yield resultMessage();
        await idleGate;
        idleYielded = true;
        yield idle();
      }
      return messageGenerator();
    });

    const response = await agent.prompt({
      sessionId: "test-session",
      prompt: [{ type: "text", text: "quick" }],
    });
    expect(response.stopReason).toBe("end_turn");
    expect(idleYielded).toBe(false);
    releaseIdle();
    await agent.sessions["test-session"]?.consumer;
  });

  it("resolves at the result for non-subagent background tasks (run_in_background Bash)", async () => {
    // A dev server can outlive every turn; deferring on it would only add
    // settlement latency to each one. Only subagent tasks defer.
    const agent = createMockAgent();
    let releaseIdle!: () => void;
    const idleGate = new Promise<void>((resolve) => (releaseIdle = resolve));
    let idleYielded = false;

    injectGeneratorSession(agent, (input) => {
      async function* messageGenerator() {
        const iter = input[Symbol.asyncIterator]();
        const { value: userMessage } = await iter.next();
        yield userEcho(userMessage);
        yield running();
        yield {
          type: "system",
          subtype: "task_started",
          task_id: "bash-1",
          tool_use_id: "toolu_bash",
          description: "npm run dev",
          // no subagent_type: a background shell
          uuid: randomUUID(),
          session_id: "test-session",
        };
        yield resultMessage();
        await idleGate;
        idleYielded = true;
        yield idle();
      }
      return messageGenerator();
    });

    const response = await agent.prompt({
      sessionId: "test-session",
      prompt: [{ type: "text", text: "start the dev server" }],
    });
    expect(response.stopReason).toBe("end_turn");
    expect(idleYielded).toBe(false);
    releaseIdle();
    await agent.sessions["test-session"]?.consumer;
  });

  it("settles a deferred turn 'cancelled' immediately at cancel()", async () => {
    // During the hold the session is typically already idle (its trailer
    // fired at the result), so the interrupt may never produce a fresh idle
    // — cancel() must not wait for one (or for the force-cancel backstop).
    const agent = createMockAgent();
    let releaseAfterCancel!: () => void;
    const afterCancel = new Promise<void>((resolve) => (releaseAfterCancel = resolve));

    injectGeneratorSession(agent, (input) => {
      async function* messageGenerator() {
        const iter = input[Symbol.asyncIterator]();
        const { value: userMessage } = await iter.next();
        yield userEcho(userMessage);
        yield running();
        yield subagentStarted("agent-1");
        yield resultMessage(); // deferral point
        yield idle(); // the turn's own trailer — the hold survives it
        await afterCancel; // nothing more comes until after the cancel
        yield idle();
      }
      return messageGenerator();
    });

    const first = agent.prompt({
      sessionId: "test-session",
      prompt: [{ type: "text", text: "explore" }],
    });
    await waitFor(() => !!agent.sessions["test-session"]?.activeTurn?.deferredSettle);
    await agent.cancel({ sessionId: "test-session" });

    // Resolved by cancel() itself — no further stream message needed. The
    // turn's own result already accumulated its usage; the cancelled settle
    // must still report it (issue #844).
    await expect(first).resolves.toEqual({
      stopReason: "cancelled",
      usage: expect.objectContaining({ totalTokens: 15 }),
    });
    releaseAfterCancel();
    await agent.sessions["test-session"]?.consumer;
  });

  it("does not fail a held turn when a followup errors while another subagent is live", async () => {
    // A followup's is_error must never touch the user-turn lifecycle: the
    // held turn's own result recorded a success.
    const agent = createMockAgent();

    injectGeneratorSession(agent, (input) => {
      async function* messageGenerator() {
        const iter = input[Symbol.asyncIterator]();
        const { value: userMessage } = await iter.next();
        yield userEcho(userMessage);
        yield running();
        yield subagentStarted("agent-1");
        yield subagentStarted("agent-2");
        yield resultMessage(); // defers on both
        yield idle();
        yield taskNotification("agent-1");
        // agent-1's followup errors while agent-2 is still live.
        yield resultMessage({
          origin: { kind: "task-notification" },
          is_error: true,
          result: "followup blew up",
        });
        yield idle();
        yield taskNotification("agent-2");
        yield resultMessage({ origin: { kind: "task-notification" } }); // settles
        yield idle();
      }
      return messageGenerator();
    });

    const response = await agent.prompt({
      sessionId: "test-session",
      prompt: [{ type: "text", text: "explore" }],
    });
    expect(response.stopReason).toBe("end_turn");
    await agent.sessions["test-session"]?.consumer;
  });

  it("does not read a followup's lagged trailing idle as the next prompt being abandoned", async () => {
    // Settling at the followup's result unblocks the client right before the
    // followup's own trailing idle; if that idle lags past the next prompt's
    // echo it must be absorbed, not read as the fresh turn ending without a
    // result (issue #825's false-fail path).
    const agent = createMockAgent();

    injectGeneratorSession(agent, (input) => {
      async function* messageGenerator() {
        const iter = input[Symbol.asyncIterator]();
        const u1 = await iter.next();
        yield userEcho(u1.value);
        yield running();
        yield subagentStarted("agent-1");
        yield resultMessage(); // turn 1 defers
        yield idle(); // turn 1's trailer
        yield taskNotification("agent-1");
        yield resultMessage({ origin: { kind: "task-notification" } }); // settles turn 1
        const u2 = await iter.next();
        yield userEcho(u2.value); // turn 2 activates...
        yield idle(); // ...before the followup's lagged trailer arrives
        yield resultMessage(); // turn 2's own result
        yield idle();
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
    await agent.sessions["test-session"]?.consumer;
  });

  it("hands off a deferred turn with its recorded stop reason when the next prompt's echo arrives", async () => {
    // The user moving on must not block behind a long-running subagent — the
    // next echo settles the deferred turn — but the hand-off must report the
    // outcome its result recorded, not rewrite it to end_turn.
    const agent = createMockAgent();

    injectGeneratorSession(agent, (input) => {
      async function* messageGenerator() {
        const iter = input[Symbol.asyncIterator]();
        const u1 = await iter.next();
        yield userEcho(u1.value);
        yield running();
        yield subagentStarted("agent-1");
        yield resultMessage({ stop_reason: "max_tokens" }); // turn 1 defers
        const u2 = await iter.next();
        yield userEcho(u2.value); // turn 2's echo hands off turn 1
        // Turn 2 did not spawn agent-1, so it settles at its own result even
        // though the subagent is still live — an earlier turn's long-running
        // agent must not stall later prompts.
        yield resultMessage();
        yield idle();
      }
      return messageGenerator();
    });

    const first = agent.prompt({
      sessionId: "test-session",
      prompt: [{ type: "text", text: "first" }],
    });
    await waitFor(() => !!agent.sessions["test-session"]?.activeTurn?.deferredSettle);
    const second = agent.prompt({
      sessionId: "test-session",
      prompt: [{ type: "text", text: "second" }],
    });

    await expect(first).resolves.toEqual(expect.objectContaining({ stopReason: "max_tokens" }));
    await expect(second).resolves.toEqual(expect.objectContaining({ stopReason: "end_turn" }));
    await agent.sessions["test-session"]?.consumer;
  });

  it("hands off a held turn when an echo-less command's result arrives (/context during a hold)", async () => {
    // An echo-less queued command has no user echo to trigger the hand-off,
    // so its result must do it: settle the held turn with ITS recorded
    // outcome and promote the queued turn — not overwrite the held turn's
    // outcome and leave the queued prompt hanging.
    const agent = createMockAgent();

    injectGeneratorSession(agent, (input) => {
      async function* messageGenerator() {
        const iter = input[Symbol.asyncIterator]();
        const u1 = await iter.next();
        yield userEcho(u1.value);
        yield running();
        yield subagentStarted("agent-1");
        yield resultMessage({ stop_reason: "max_tokens" }); // turn 1 held
        yield idle();
        await iter.next(); // second prompt pushed — echo-less, only a result
        yield resultMessage();
        yield idle();
      }
      return messageGenerator();
    });

    const first = agent.prompt({
      sessionId: "test-session",
      prompt: [{ type: "text", text: "explore" }],
    });
    await waitFor(() => !!agent.sessions["test-session"]?.activeTurn?.deferredSettle);
    const second = agent.prompt({
      sessionId: "test-session",
      prompt: [{ type: "text", text: "/context" }],
    });

    await expect(first).resolves.toEqual(expect.objectContaining({ stopReason: "max_tokens" }));
    await expect(second).resolves.toEqual(expect.objectContaining({ stopReason: "end_turn" }));
    await agent.sessions["test-session"]?.consumer;
  });

  it("defers a refusal result while the turn's subagent is live", async () => {
    // A refusal is a normal turn outcome — it must route through the same
    // deferral gate, or the subagent's remaining work is stranded
    // out-of-turn through the refusal lane.
    const agent = createMockAgent();
    let releaseDrain!: () => void;
    const drainGate = new Promise<void>((resolve) => (releaseDrain = resolve));

    injectGeneratorSession(agent, (input) => {
      async function* messageGenerator() {
        const iter = input[Symbol.asyncIterator]();
        const { value: userMessage } = await iter.next();
        yield userEcho(userMessage);
        yield running();
        yield subagentStarted("agent-1");
        yield resultMessage({ stop_reason: "refusal" }); // held, not settled
        yield idle();
        await drainGate;
        yield taskNotification("agent-1");
        yield resultMessage({ origin: { kind: "task-notification" } }); // settles
        yield idle();
      }
      return messageGenerator();
    });

    const response = agent.prompt({
      sessionId: "test-session",
      prompt: [{ type: "text", text: "explore" }],
    });
    // The refusal result must HOLD the turn (deferredSettle recorded), not
    // settle it out from under the live subagent.
    await waitFor(
      () => agent.sessions["test-session"]?.activeTurn?.deferredSettle?.stopReason === "refusal",
    );
    releaseDrain();
    await expect(response).resolves.toEqual(expect.objectContaining({ stopReason: "refusal" }));
    await agent.sessions["test-session"]?.consumer;
  });

  it("resolves a held turn with its recorded outcome when the stream dies", async () => {
    // The held turn's answer already streamed; a stream death during the
    // post-answer hold is a background failure, not the turn's.
    const agent = createMockAgent();

    injectGeneratorSession(agent, (input) => {
      async function* messageGenerator() {
        const iter = input[Symbol.asyncIterator]();
        const { value: userMessage } = await iter.next();
        yield userEcho(userMessage);
        yield running();
        yield subagentStarted("agent-1");
        yield resultMessage(); // held
        yield idle();
        throw new Error("subprocess died");
      }
      return messageGenerator();
    });

    const response = await agent.prompt({
      sessionId: "test-session",
      prompt: [{ type: "text", text: "explore" }],
    });
    expect(response.stopReason).toBe("end_turn");
    await agent.sessions["test-session"]?.consumer;
  });

  it("absorbs the interrupt's lagged trailer after cancelling a held turn mid-followup", async () => {
    // Cancelling while a followup cycle is live pre-empts its result, so
    // the interrupt produces a trailer idle with no counted result; lagging
    // past the next prompt's echo it must be absorbed, not read as that
    // fresh turn ending without a result (issue #825's false-fail). (An
    // already-idle cancel produces no trailer, and pre-counting one there
    // would mask a future #825 detection — hence the not-idle gate, which
    // its own test pins below.)
    const agent = createMockAgent();
    let releaseAfterCancel!: () => void;
    const afterCancel = new Promise<void>((resolve) => (releaseAfterCancel = resolve));

    injectGeneratorSession(agent, (input) => {
      async function* messageGenerator() {
        const iter = input[Symbol.asyncIterator]();
        const u1 = await iter.next();
        yield userEcho(u1.value);
        yield running();
        yield subagentStarted("agent-1");
        yield resultMessage(); // turn 1 held
        yield idle(); // its trailer, absorbed mid-hold
        yield taskNotification("agent-1");
        yield running(); // the followup cycle starts...
        await afterCancel; // ...and the cancel's interrupt pre-empts it
        const u2 = await iter.next();
        yield userEcho(u2.value); // turn 2 activates...
        yield idle(); // ...before the interrupt's lagged trailer arrives
        yield resultMessage(); // turn 2's own result
        yield idle();
      }
      return messageGenerator();
    });

    const first = agent.prompt({
      sessionId: "test-session",
      prompt: [{ type: "text", text: "explore" }],
    });
    await waitFor(() => !!agent.sessions["test-session"]?.activeTurn?.deferredSettle);
    await agent.cancel({ sessionId: "test-session" });
    await expect(first).resolves.toEqual(expect.objectContaining({ stopReason: "cancelled" }));
    releaseAfterCancel();

    const second = await agent.prompt({
      sessionId: "test-session",
      prompt: [{ type: "text", text: "next" }],
    });
    expect(second.stopReason).toBe("end_turn");
    await agent.sessions["test-session"]?.consumer;
  });

  it("reconciles a leaked subagent entry via background_tasks_changed", async () => {
    // If a task's settle bookend is lost, the level signal's REPLACE
    // semantics drop the stale entry so later turns don't defer forever.
    const agent = createMockAgent();
    let releaseIdle!: () => void;
    const idleGate = new Promise<void>((resolve) => (releaseIdle = resolve));
    let idleYielded = false;

    injectGeneratorSession(agent, (input) => {
      async function* messageGenerator() {
        const iter = input[Symbol.asyncIterator]();
        const { value: userMessage } = await iter.next();
        yield userEcho(userMessage);
        yield running();
        yield subagentStarted("agent-1");
        // The settle bookend was lost; the level signal says nothing is live.
        yield backgroundTasksChanged([]);
        yield resultMessage();
        await idleGate;
        idleYielded = true;
        yield idle();
      }
      return messageGenerator();
    });

    const response = await agent.prompt({
      sessionId: "test-session",
      prompt: [{ type: "text", text: "explore" }],
    });
    expect(response.stopReason).toBe("end_turn");
    expect(idleYielded).toBe(false);
    // The entry survives for permission attribution (a live sync subagent is
    // legitimately absent from the level's background-only universe) — only
    // the hold stops waiting on it.
    const record = agent.sessions["test-session"]!.liveBackgroundTasks.get("agent-1");
    expect(record?.parentToolUseId).toBe("toolu_agent-1");
    expect(record?.endedPerLevel).toBe("ended");
    releaseIdle();
    await agent.sessions["test-session"]?.consumer;
  });

  it("keeps holding through a peer-origin autonomous result", async () => {
    // A peer/coordinator cycle's result is not the user's; it must neither
    // settle the held turn as a hand-off nor touch the user-turn lifecycle.
    const { agent, events } = chunkCapturingAgent();

    injectGeneratorSession(agent, (input) => {
      async function* messageGenerator() {
        const iter = input[Symbol.asyncIterator]();
        const { value: userMessage } = await iter.next();
        yield userEcho(userMessage);
        yield running();
        yield subagentStarted("agent-1");
        yield resultMessage(); // held
        yield idle();
        // A peer message wakes the model; its cycle's result must not end
        // the hold (the subagent is still live).
        yield resultMessage({ origin: { kind: "peer", from: "other-session" } });
        yield idle();
        yield assistantText("peer-cycle marker");
        yield taskNotification("agent-1");
        yield resultMessage({ origin: { kind: "task-notification" } }); // settles
        yield idle();
      }
      return messageGenerator();
    });

    const response = await agent
      .prompt({ sessionId: "test-session", prompt: [{ type: "text", text: "explore" }] })
      .then((r) => {
        events.push("resolved");
        return r;
      });

    expect(response.stopReason).toBe("end_turn");
    // Resolution came after the peer cycle's output — the peer result did
    // not settle the hold.
    const markerIndex = events.indexOf("chunk:peer-cycle marker");
    expect(markerIndex).toBeGreaterThanOrEqual(0);
    expect(markerIndex).toBeLessThan(events.indexOf("resolved"));
    await agent.sessions["test-session"]?.consumer;
  });

  it("closes the delivery stretch when a held turn is handed off by the next echo", async () => {
    // The held turn's followup summary latched the delivery flag; the echo
    // hand-off settles the held turn, so the flag must reset or the next
    // (replayed) turn's issue-#453 result-text fallback is suppressed.
    // Asserted on the observable: the replayed turn's result text IS
    // forwarded (a flag check after turn 2's finally would pass vacuously).
    const { agent, events } = chunkCapturingAgent();

    injectGeneratorSession(agent, (input) => {
      async function* messageGenerator() {
        const iter = input[Symbol.asyncIterator]();
        const u1 = await iter.next();
        yield userEcho(u1.value);
        yield running();
        yield subagentStarted("agent-1");
        yield subagentStarted("agent-2");
        yield resultMessage(); // held on both
        yield idle();
        yield taskNotification("agent-1");
        yield assistantText("first summary"); // latches the delivery flag
        yield resultMessage({ origin: { kind: "task-notification" } }); // still holding (agent-2)
        yield idle();
        const u2 = await iter.next();
        yield userEcho(u2.value); // hand-off settles the held turn
        // Turn 2 is a cache-replayed turn: nothing streams, zero output
        // tokens, the answer only on the result text (issue #453's shape).
        yield replayedResult("replayed answer");
        yield idle();
      }
      return messageGenerator();
    });

    const first = agent.prompt({
      sessionId: "test-session",
      prompt: [{ type: "text", text: "explore" }],
    });
    await waitFor(() => !!agent.sessions["test-session"]?.activeTurn?.deferredSettle);
    const second = agent.prompt({
      sessionId: "test-session",
      prompt: [{ type: "text", text: "next" }],
    });

    await expect(first).resolves.toEqual(expect.objectContaining({ stopReason: "end_turn" }));
    await expect(second).resolves.toEqual(expect.objectContaining({ stopReason: "end_turn" }));
    // The hand-off closed the held turn's stretch, so the replayed turn's
    // fallback fired instead of being suppressed by the followup's text.
    expect(events).toContain("chunk:replayed answer");
    await agent.sessions["test-session"]?.consumer;
  });

  it("re-arms the hold when a later level includes a previously absent task, and sweeps ended entries at activation", async () => {
    const agent = createMockAgent();
    let releaseDrain!: () => void;
    const drainGate = new Promise<void>((resolve) => (releaseDrain = resolve));

    injectGeneratorSession(agent, (input) => {
      async function* messageGenerator() {
        const iter = input[Symbol.asyncIterator]();
        const u1 = await iter.next();
        yield userEcho(u1.value);
        yield running();
        yield subagentStarted("agent-1");
        // A racing level omits the live agent (payload built before its
        // registration) — marks it endedPerLevel...
        yield backgroundTasksChanged([]);
        // ...and a later level that INCLUDES it proves it live: un-ended,
        // so the turn's result defers on it again.
        yield backgroundTasksChanged(["agent-1"]);
        yield resultMessage(); // must HOLD (the un-mark re-armed the wait)
        yield idle();
        await drainGate; // let the test observe the held state
        // A second racing level ends it again while held; nothing settles
        // here (the level precedes the notification in the normal ordering).
        yield backgroundTasksChanged([]);
        yield idle(); // the drain fallback settles the now-unwaited hold
        const u2 = await iter.next();
        yield userEcho(u2.value); // turn 2 activation ARMS the sweep
        yield resultMessage();
        yield idle();
        const u3 = await iter.next();
        yield userEcho(u3.value); // turn 3 activation deletes the armed entry
        yield resultMessage();
        yield idle();
      }
      return messageGenerator();
    });

    const first = agent.prompt({
      sessionId: "test-session",
      prompt: [{ type: "text", text: "explore" }],
    });
    // Deferral engaged despite the earlier absent-mark — the inclusion
    // un-ended the entry.
    await waitFor(() => !!agent.sessions["test-session"]?.activeTurn?.deferredSettle);
    releaseDrain();
    await expect(first).resolves.toEqual(expect.objectContaining({ stopReason: "end_turn" }));

    const second = await agent.prompt({
      sessionId: "test-session",
      prompt: [{ type: "text", text: "next" }],
    });
    expect(second.stopReason).toBe("end_turn");
    // The first activation only ARMS the sweep — the entry survives one full
    // turn so a corrective inclusive level can still rescue a live agent's
    // attribution (deletion is irreversible).
    expect(agent.sessions["test-session"]!.liveBackgroundTasks.get("agent-1")?.endedPerLevel).toBe(
      "sweep-armed",
    );

    const third = await agent.prompt({
      sessionId: "test-session",
      prompt: [{ type: "text", text: "again" }],
    });
    expect(third.stopReason).toBe("end_turn");
    // The second activation deletes it (growth bound for lost bookends).
    expect(agent.sessions["test-session"]!.liveBackgroundTasks.has("agent-1")).toBe(false);
    await agent.sessions["test-session"]?.consumer;
  });

  it("rescues a sweep-armed entry when an inclusive level arrives mid-grace", async () => {
    // The grace's whole point: an entry armed at one activation must be
    // rescued — attribution intact, sweep disarmed in the same assignment —
    // by an inclusive level before the next activation deletes it.
    const agent = createMockAgent();

    injectGeneratorSession(agent, (input) => {
      async function* messageGenerator() {
        const iter = input[Symbol.asyncIterator]();
        const u1 = await iter.next();
        yield userEcho(u1.value);
        yield running();
        yield subagentStarted("agent-1");
        yield backgroundTasksChanged([]); // racing payload marks it ended
        yield resultMessage(); // no hold (ended) — settles at the result
        yield idle();
        const u2 = await iter.next();
        yield userEcho(u2.value); // activation arms the sweep
        yield resultMessage();
        yield backgroundTasksChanged(["agent-1"]); // mid-grace rescue
        yield idle();
        const u3 = await iter.next();
        yield userEcho(u3.value); // must NOT delete the rescued entry
        yield resultMessage();
        yield idle();
      }
      return messageGenerator();
    });

    for (const text of ["one", "two", "three"]) {
      const response = await agent.prompt({
        sessionId: "test-session",
        prompt: [{ type: "text", text }],
      });
      expect(response.stopReason).toBe("end_turn");
    }
    const record = agent.sessions["test-session"]!.liveBackgroundTasks.get("agent-1");
    expect(record?.parentToolUseId).toBe("toolu_agent-1");
    expect(record?.endedPerLevel).toBeUndefined();
    await agent.sessions["test-session"]?.consumer;
  });

  it("absorbs the trailer when cancelling a hold blocked on a permission request", async () => {
    // requires_action is a live cycle too (a followup waiting on a
    // permission decision — the very scenario users cancel out of);
    // interrupting it produces a result-less trailer just like running.
    const agent = createMockAgent();
    let releaseAfterCancel!: () => void;
    const afterCancel = new Promise<void>((resolve) => (releaseAfterCancel = resolve));

    injectGeneratorSession(agent, (input) => {
      async function* messageGenerator() {
        const iter = input[Symbol.asyncIterator]();
        const u1 = await iter.next();
        yield userEcho(u1.value);
        yield running();
        yield subagentStarted("agent-1");
        yield resultMessage(); // turn 1 held
        yield idle(); // trailer absorbed
        yield taskNotification("agent-1");
        yield running();
        yield requiresAction(); // the followup blocks on a permission request
        await afterCancel; // the cancel's interrupt pre-empts it
        const u2 = await iter.next();
        yield userEcho(u2.value); // turn 2 activates...
        yield idle(); // ...before the interrupt's lagged trailer arrives
        yield resultMessage(); // turn 2's own result
        yield idle();
      }
      return messageGenerator();
    });

    const first = agent.prompt({
      sessionId: "test-session",
      prompt: [{ type: "text", text: "explore" }],
    });
    await waitFor(() => !!agent.sessions["test-session"]?.activeTurn?.deferredSettle);
    await agent.cancel({ sessionId: "test-session" });
    await expect(first).resolves.toEqual(expect.objectContaining({ stopReason: "cancelled" }));
    releaseAfterCancel();

    const second = await agent.prompt({
      sessionId: "test-session",
      prompt: [{ type: "text", text: "next" }],
    });
    expect(second.stopReason).toBe("end_turn");
    await agent.sessions["test-session"]?.consumer;
  });

  it("closes the stretch after autonomous prose so a replayed prompt still delivers", async () => {
    // Autonomous prose (a wake's summary) latches the delivery flag; with no
    // turn in flight or queued, the autonomous result must close the stretch
    // or the next cache-replayed prompt's issue-#453 fallback is suppressed.
    const { agent, events } = chunkCapturingAgent();

    injectGeneratorSession(agent, (input) => {
      async function* messageGenerator() {
        const iter = input[Symbol.asyncIterator]();
        const u1 = await iter.next();
        yield userEcho(u1.value);
        yield running();
        yield resultMessage(); // turn 1 settles normally
        yield idle();
        // Autonomous cycle with no turn pending: prose + result.
        yield assistantText("background note");
        yield resultMessage({ origin: { kind: "task-notification" } });
        yield idle();
        const u2 = await iter.next();
        yield userEcho(u2.value);
        // Cache-replayed turn: no streaming, zero output tokens, the answer
        // only on the result text.
        yield replayedResult("replayed answer");
        yield idle();
      }
      return messageGenerator();
    });

    const first = await agent.prompt({
      sessionId: "test-session",
      prompt: [{ type: "text", text: "one" }],
    });
    expect(first.stopReason).toBe("end_turn");
    // The user types AFTER the background note arrived (the real sequence);
    // prompting before the autonomous result is consumed would race the
    // queued-turn guard, which deliberately errs toward suppression. Wait
    // for the prose to land and the autonomous result's clear to follow.
    await waitFor(
      () =>
        events.includes("chunk:background note") &&
        agent.sessions["test-session"]!.emittedAssistantText === false,
    );
    const second = await agent.prompt({
      sessionId: "test-session",
      prompt: [{ type: "text", text: "two" }],
    });
    expect(second.stopReason).toBe("end_turn");
    expect(events).toContain("chunk:replayed answer");
    await agent.sessions["test-session"]?.consumer;
  });

  it("preserves a queued turn's streamed answer across an interleaved autonomous result", async () => {
    // Mid-message echo lag: a queued turn's deltas can stream before its echo
    // activates it (activeTurn still null). An autonomous result landing in
    // that window must NOT close the stretch — the flag guards the queued
    // turn's already-delivered answer, and clearing would re-emit it via the
    // issue-#453 fallback (the duplicate direction the flag's doc forbids).
    const { agent, events } = chunkCapturingAgent();

    injectGeneratorSession(agent, (input) => {
      async function* messageGenerator() {
        const iter = input[Symbol.asyncIterator]();
        const u1 = await iter.next();
        yield userEcho(u1.value);
        yield running();
        yield resultMessage(); // turn 1 settles
        yield idle();
        const u2 = await iter.next(); // turn 2 pushed (queued, not yet echoed)
        // Turn 2's answer streams BEFORE its echo (mid-message echo lag).
        yield assistantText("streamed answer");
        // An autonomous result interleaves while activeTurn is null but
        // turn 2 sits unsettled in the queue.
        yield resultMessage({ origin: { kind: "task-notification" } });
        yield userEcho(u2.value); // now the echo activates turn 2
        // Zero-output result whose text duplicates the streamed answer.
        yield replayedResult("streamed answer");
        yield idle();
        yield idle();
      }
      return messageGenerator();
    });

    const first = await agent.prompt({
      sessionId: "test-session",
      prompt: [{ type: "text", text: "one" }],
    });
    expect(first.stopReason).toBe("end_turn");
    const second = await agent.prompt({
      sessionId: "test-session",
      prompt: [{ type: "text", text: "two" }],
    });
    expect(second.stopReason).toBe("end_turn");
    // The streamed answer must appear exactly once — the queued-turn guard
    // kept the flag latched, so the fallback did not re-emit it.
    expect(events.filter((e) => e === "chunk:streamed answer")).toHaveLength(1);
    await agent.sessions["test-session"]?.consumer;
  });

  it("does not pre-count an interrupt trailer when cancelling an already-idle hold", async () => {
    // An already-idle hold's interrupt emits no trailer; a pre-counted debt
    // would never drain and would absorb the one un-owed idle that is the
    // issue-#825 detector's signal for a later genuinely-wedged turn.
    const agent = createMockAgent();
    let releaseAfterCancel!: () => void;
    const afterCancel = new Promise<void>((resolve) => (releaseAfterCancel = resolve));

    injectGeneratorSession(agent, (input) => {
      async function* messageGenerator() {
        const iter = input[Symbol.asyncIterator]();
        const u1 = await iter.next();
        yield userEcho(u1.value);
        yield running();
        yield subagentStarted("agent-1");
        yield resultMessage(); // turn 1 held
        yield idle(); // trailer absorbed; session sits idle
        await afterCancel; // cancel happens here — no cycle running
        const u2 = await iter.next();
        yield userEcho(u2.value); // turn 2 activates
        yield idle(); // un-owed idle with turn 2 unsettled — the #825 signal
        yield resultMessage(); // never reached for turn 2's settle
        yield idle();
      }
      return messageGenerator();
    });

    const first = agent.prompt({
      sessionId: "test-session",
      prompt: [{ type: "text", text: "explore" }],
    });
    await waitFor(() => !!agent.sessions["test-session"]?.activeTurn?.deferredSettle);
    await agent.cancel({ sessionId: "test-session" });
    await expect(first).resolves.toEqual(expect.objectContaining({ stopReason: "cancelled" }));
    releaseAfterCancel();

    // The #825 detection must still fire for turn 2 — a stale pre-counted
    // debt from the idle cancel would have absorbed the un-owed idle.
    await expect(
      agent.prompt({ sessionId: "test-session", prompt: [{ type: "text", text: "next" }] }),
    ).rejects.toMatchObject({ code: -32603 });
    await agent.sessions["test-session"]?.consumer;
  });
});

describe("session/cancel wedge recovery (issue #680)", () => {
  function createMockAgent() {
    const mockClient = {
      sessionUpdate: async () => {},
    } as unknown as AcpClient;
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
      agents: [],
      currentAgent: "default",
      fastModeEnabled: false,
      abortController: new AbortController(),
      emitRawSDKMessages: false,
      contextWindowSize: 200000,
      taskState: new Map(),
      toolUseCache: {},
      emittedToolCalls: new Set(),
      liveBackgroundTasks: new Map(),
      emittedAssistantText: false,
      owedTrailingIdles: 0,
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
    await expect(promptPromise).resolves.toEqual({
      stopReason: "cancelled",
      usage: cancelledTurnUsage,
    });
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

    await expect(promptPromise).resolves.toEqual({
      stopReason: "cancelled",
      usage: cancelledTurnUsage,
    });
    expect(agent.sessions["test-session"]).toBeUndefined();
  });
});

describe("turn abandoned by the SDK (issue #825)", () => {
  function createMockAgent() {
    const mockClient = {
      sessionUpdate: async () => {},
    } as unknown as AcpClient;
    return new ClaudeAcpAgent(mockClient, { log: () => {}, error: () => {} });
  }

  function createResultMessage() {
    return {
      type: "result" as const,
      subtype: "success",
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

  // Deterministic wait for the consumer to reach a state (e.g. a turn became
  // active), instead of a timing-based sleep that can pass vacuously on a
  // slow machine while exercising the wrong code path.
  const waitFor = async (cond: () => boolean) => {
    for (let i = 0; i < 200; i++) {
      if (cond()) return;
      await new Promise((r) => setTimeout(r, 0));
    }
    throw new Error("waitFor timed out");
  };

  it("fails the in-flight prompt when the SDK goes idle without emitting a result", async () => {
    // The issue #825 signature: the model stream drops mid-turn, the SDK's
    // turn loop exits (trailing `session_state_changed: idle` — its
    // authoritative turn-over signal) but the turn's `result` never arrives.
    // The prompt must fail at that idle instead of hanging until the next
    // prompt drains the stale state.
    const agent = createMockAgent();
    injectGeneratorSession(agent, (input) => {
      async function* messageGenerator() {
        const iter = input[Symbol.asyncIterator]();
        const u1 = await iter.next();
        yield userEcho(u1.value); // turn 1 active
        yield { type: "system", subtype: "session_state_changed", state: "idle" };
        // Parked awaiting the next prompt's input, like the real wedged SDK.
        const u2 = await iter.next();
        yield userEcho(u2.value);
        yield createResultMessage();
        yield { type: "system", subtype: "session_state_changed", state: "idle" };
      }
      return messageGenerator();
    });

    await expect(
      agent.prompt({ sessionId: "test-session", prompt: [{ type: "text", text: "first" }] }),
    ).rejects.toThrow(/without a result/);

    // The session recovers: the next prompt runs normally on the same stream.
    const second = await agent.prompt({
      sessionId: "test-session",
      prompt: [{ type: "text", text: "second" }],
    });
    expect(second.stopReason).toBe("end_turn");
    expect(second.usage?.inputTokens).toBe(10);
  });

  it("absorbs a cancelled turn's lagged trailing idle without failing the next turn", async () => {
    // Cancel turn 1; turn 2's echo arrives BEFORE turn 1's trailing idle, so
    // the hand-off settles turn 1 "cancelled" (recording the owed idle). The
    // lagged idle then lands while healthy turn 2 is active — it must be
    // absorbed as turn 1's trailer, not read as turn 2 ending without a
    // result (which would reject turn 2 here).
    const agent = createMockAgent();
    agent.forceCancelGraceMs = 60_000; // hand-off must settle turn 1, not the backstop
    injectGeneratorSession(agent, (input) => {
      async function* messageGenerator() {
        const iter = input[Symbol.asyncIterator]();
        const u1 = await iter.next();
        yield userEcho(u1.value); // turn 1 active
        // Parks until the test (after cancelling turn 1) sends turn 2.
        const u2 = await iter.next();
        yield userEcho(u2.value); // hand-off: turn 1 settles cancelled
        yield { type: "system", subtype: "session_state_changed", state: "idle" }; // turn 1's lagged trailer
        yield createResultMessage();
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
    const second = agent.prompt({
      sessionId: "test-session",
      prompt: [{ type: "text", text: "second" }],
    });

    await expect(first).resolves.toEqual({
      stopReason: "cancelled",
      usage: cancelledTurnUsage,
    });
    const secondResult = await second;
    expect(secondResult.stopReason).toBe("end_turn");
    expect(secondResult.usage?.inputTokens).toBe(10);
  });

  it("counts an orphaned queued turn's trailer so it cannot false-fail a later prompt", async () => {
    // Turn 1 active, turn 2 queued. cancel() settles+removes turn 2, but its
    // message was already pushed, so the SDK still runs it and emits a result
    // (the orphan) plus a trailing idle. The orphan result arrives while
    // session.cancelled is still true and must record the owed trailer —
    // otherwise the orphan's idle, lagging past turn 3's echo, would be read
    // as turn 3 ending without a result and reject the healthy prompt.
    const agent = createMockAgent();
    let releaseAfterCancel!: () => void;
    const afterCancel = new Promise<void>((resolve) => (releaseAfterCancel = resolve));
    injectGeneratorSession(agent, (input) => {
      async function* messageGenerator() {
        const iter = input[Symbol.asyncIterator]();
        const u1 = await iter.next();
        yield userEcho(u1.value); // turn 1 active
        await iter.next(); // turn 2's pushed message (cancelled + removed)
        await afterCancel; // test cancels (orphaning turn 2)
        yield { type: "system", subtype: "session_state_changed", state: "idle" }; // settles turn 1 cancelled
        yield createResultMessage(); // turn 2's orphan result — skipped; trailer now owed
        const u3 = await iter.next();
        yield userEcho(u3.value); // turn 3 activates (clears cancelled)
        yield { type: "system", subtype: "session_state_changed", state: "idle" }; // orphan's lagged trailer — absorbed
        yield createResultMessage();
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
    await agent.cancel({ sessionId: "test-session" });
    releaseAfterCancel();

    await expect(first).resolves.toEqual({
      stopReason: "cancelled",
      usage: cancelledTurnUsage,
    });
    await expect(second).resolves.toEqual({ stopReason: "cancelled" });
    const third = await agent.prompt({
      sessionId: "test-session",
      prompt: [{ type: "text", text: "third" }],
    });
    expect(third.stopReason).toBe("end_turn");
    expect(third.usage?.inputTokens).toBe(10);
  });

  it("skips a force-cancelled turn's late result and absorbs its trailer after recovery", async () => {
    // A wedged turn is settled "cancelled" by the force-cancel backstop; the
    // SDK later recovers from the wedge and still emits that turn's result
    // and trailing idle. The late result must be skipped as an orphan — not
    // promoted onto the next queued prompt (which would settle it with the
    // stale turn's stop reason and usage) — and its trailer absorbed, not
    // read as the next turn being abandoned.
    const agent = createMockAgent();
    agent.forceCancelGraceMs = 10;
    let releaseRecovery!: () => void;
    const recovery = new Promise<void>((resolve) => (releaseRecovery = resolve));
    const staleResult = createResultMessage();
    staleResult.usage.input_tokens = 999;
    injectGeneratorSession(agent, (input) => {
      async function* messageGenerator() {
        const iter = input[Symbol.asyncIterator]();
        const u1 = await iter.next();
        yield userEcho(u1.value); // turn 1 active
        await recovery; // wedged: interrupt is a no-op; the backstop settles turn 1
        yield staleResult; // turn 1's late result — orphan-skipped; trailer now owed
        const u2 = await iter.next();
        yield userEcho(u2.value); // turn 2 activates (clears cancelled)
        yield { type: "system", subtype: "session_state_changed", state: "idle" }; // turn 1's lagged trailer — absorbed
        yield createResultMessage();
        yield { type: "system", subtype: "session_state_changed", state: "idle" };
      }
      return messageGenerator();
    });

    const first = agent.prompt({
      sessionId: "test-session",
      prompt: [{ type: "text", text: "first" }],
    });
    await waitFor(() => !!agent.sessions["test-session"]?.activeTurn);
    await agent.cancel({ sessionId: "test-session" }); // backstop (10ms) settles turn 1
    await expect(first).resolves.toEqual({
      stopReason: "cancelled",
      usage: cancelledTurnUsage,
    });

    // Queue turn 2 BEFORE the SDK recovers, so the stale result races it.
    const second = agent.prompt({
      sessionId: "test-session",
      prompt: [{ type: "text", text: "second" }],
    });
    releaseRecovery();

    const secondResult = await second;
    expect(secondResult.stopReason).toBe("end_turn");
    // Turn 2 settles with its OWN result's usage — not the stale 999.
    expect(secondResult.usage?.inputTokens).toBe(10);
  });

  it("does not leak the owed idle when a cancel lands between a result and its trailer", async () => {
    // Turn 1's result settles it (debt recorded); the user cancels before the
    // lagged trailing idle arrives. That idle must still be absorbed via the
    // debt — otherwise it leaks and a future genuine abandoned-turn idle
    // would be absorbed instead of detected. Turn 2 then wedges (idle, no
    // result) and must still be failed.
    const agent = createMockAgent();
    let releaseAfterCancel!: () => void;
    const afterCancel = new Promise<void>((resolve) => (releaseAfterCancel = resolve));
    injectGeneratorSession(agent, (input) => {
      async function* messageGenerator() {
        const iter = input[Symbol.asyncIterator]();
        const u1 = await iter.next();
        yield userEcho(u1.value);
        yield createResultMessage(); // turn 1 settles here; trailer now owed
        await afterCancel; // test cancels with no active turn
        yield { type: "system", subtype: "session_state_changed", state: "idle" }; // absorbed via debt
        const u2 = await iter.next();
        yield userEcho(u2.value); // turn 2 active
        yield { type: "system", subtype: "session_state_changed", state: "idle" }; // un-owed → turn 2 abandoned
      }
      return messageGenerator();
    });

    const first = await agent.prompt({
      sessionId: "test-session",
      prompt: [{ type: "text", text: "first" }],
    });
    expect(first.stopReason).toBe("end_turn");

    await agent.cancel({ sessionId: "test-session" });
    releaseAfterCancel();

    await expect(
      agent.prompt({ sessionId: "test-session", prompt: [{ type: "text", text: "second" }] }),
    ).rejects.toThrow(/without a result/);
  });
});

describe("streamEventToAcpNotifications", () => {
  it("refines a tool call as soon as a streamed input field is complete", () => {
    const toolUseCache = {};
    const emittedToolCalls = new Set<string>();
    const streamedToolInputs: StreamedToolInputCache = new Map();
    const options = {
      cwd: "/Users/test/project",
      emittedToolCalls,
      streamedToolInputs,
    };
    const baseMessage = {
      type: "stream_event",
      parent_tool_use_id: null,
      uuid: randomUUID(),
      session_id: "test-session",
    };

    const start = streamEventToAcpNotifications(
      {
        ...baseMessage,
        event: {
          type: "content_block_start",
          index: 0,
          content_block: {
            type: "tool_use",
            id: "toolu_read",
            name: "Read",
            input: {},
          },
        },
      } as Parameters<typeof streamEventToAcpNotifications>[0],
      "test-session",
      toolUseCache,
      {} as AcpClient,
      console,
      options,
    );

    expect(start).toHaveLength(1);
    expect(start[0].update).toMatchObject({
      sessionUpdate: "tool_call",
      toolCallId: "toolu_read",
      title: "Read File",
      locations: [],
    });

    const partial = streamEventToAcpNotifications(
      {
        ...baseMessage,
        event: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "input_json_delta", partial_json: '{"file_' },
        },
      } as Parameters<typeof streamEventToAcpNotifications>[0],
      "test-session",
      toolUseCache,
      {} as AcpClient,
      console,
      options,
    );

    expect(partial).toEqual([]);

    const pathAvailable = streamEventToAcpNotifications(
      {
        ...baseMessage,
        event: {
          type: "content_block_delta",
          index: 0,
          delta: {
            type: "input_json_delta",
            partial_json: 'path":"/Users/test/project/src/ZodiacList.tsx","offset":',
          },
        },
      } as Parameters<typeof streamEventToAcpNotifications>[0],
      "test-session",
      toolUseCache,
      {} as AcpClient,
      console,
      options,
    );

    // The overall JSON is still invalid, but file_path is complete and already
    // makes this pending read distinguishable from other tool calls.
    expect(pathAvailable).toHaveLength(1);
    expect(pathAvailable[0].update).toMatchObject({
      sessionUpdate: "tool_call_update",
      toolCallId: "toolu_read",
      title: "Read src/ZodiacList.tsx",
      rawInput: { file_path: "/Users/test/project/src/ZodiacList.tsx" },
      locations: [{ path: "/Users/test/project/src/ZodiacList.tsx", line: 1 }],
    });
    expect(streamedToolInputs.size).toBe(1);

    const completed = streamEventToAcpNotifications(
      {
        ...baseMessage,
        event: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "input_json_delta", partial_json: "10}" },
        },
      } as Parameters<typeof streamEventToAcpNotifications>[0],
      "test-session",
      toolUseCache,
      {} as AcpClient,
      console,
      options,
    );

    // Completion emits nothing: the consolidated assistant message replays the
    // block with its full input and refines the call there — emitting here too
    // would send a duplicate identical update. The entry is just cleaned up.
    expect(completed).toEqual([]);
    expect(streamedToolInputs.size).toBe(0);
  });

  describe("partial tool input coverage", () => {
    function refineFromPartialInput({
      name,
      partialJson,
      type = "tool_use",
    }: {
      name: string;
      partialJson: string;
      type?: "tool_use" | "server_tool_use" | "mcp_tool_use";
    }) {
      const toolUseCache = {};
      const emittedToolCalls = new Set<string>();
      const streamedToolInputs: StreamedToolInputCache = new Map();
      const options = {
        cwd: "/Users/test/project",
        emittedToolCalls,
        streamedToolInputs,
      };
      const baseMessage = {
        type: "stream_event",
        parent_tool_use_id: null,
        uuid: randomUUID(),
        session_id: "test-session",
      };

      const started = streamEventToAcpNotifications(
        {
          ...baseMessage,
          event: {
            type: "content_block_start",
            index: 0,
            content_block: { type, id: "toolu_partial", name, input: {} },
          },
        } as Parameters<typeof streamEventToAcpNotifications>[0],
        "test-session",
        toolUseCache,
        {} as AcpClient,
        console,
        options,
      );
      const refined = streamEventToAcpNotifications(
        {
          ...baseMessage,
          event: {
            type: "content_block_delta",
            index: 0,
            delta: { type: "input_json_delta", partial_json: partialJson },
          },
        } as Parameters<typeof streamEventToAcpNotifications>[0],
        "test-session",
        toolUseCache,
        {} as AcpClient,
        console,
        options,
      );

      return { started, refined, streamedToolInputs };
    }

    it.each([
      {
        case: "Agent description",
        name: "Agent",
        partialJson: '{"description":"Investigate issue","prompt":',
        title: "Investigate issue",
        rawInput: { description: "Investigate issue" },
      },
      {
        case: "legacy Task description",
        name: "Task",
        partialJson: '{"description":"Research dependencies","prompt":',
        title: "Research dependencies",
        rawInput: { description: "Research dependencies" },
      },
      {
        case: "Bash command with comma and escaped quotes",
        name: "Bash",
        partialJson: `{"command":${JSON.stringify('sleep 900, then echo "done"')},"timeout":`,
        title: 'sleep 900, then echo "done"',
        rawInput: { command: 'sleep 900, then echo "done"' },
      },
      {
        case: "Read file path",
        name: "Read",
        partialJson: '{"file_path":"/Users/test/project/src/read.ts","offset":',
        title: "Read src/read.ts",
        rawInput: { file_path: "/Users/test/project/src/read.ts" },
      },
      {
        case: "Write file path",
        name: "Write",
        partialJson: '{"file_path":"/Users/test/project/src/write.ts","content":',
        title: "Write src/write.ts",
        rawInput: { file_path: "/Users/test/project/src/write.ts" },
      },
      {
        case: "Edit file path",
        name: "Edit",
        partialJson: '{"file_path":"/Users/test/project/src/edit.ts","old_string":',
        title: "Edit src/edit.ts",
        rawInput: { file_path: "/Users/test/project/src/edit.ts" },
      },
      {
        case: "Glob pattern",
        name: "Glob",
        partialJson: '{"pattern":"**/*.ts","path":',
        title: "Find `**/*.ts`",
        rawInput: { pattern: "**/*.ts" },
      },
      {
        case: "Grep strings, booleans, and numbers",
        name: "Grep",
        partialJson:
          '{"pattern":"TODO, FIXME","-i":true,"-n":true,"-A":2,"-B":1,"-C":3,"output_mode":"files_with_matches","head_limit":10,"glob":"*.ts","type":"ts","multiline":true,"path":',
        title:
          'grep -i -n -A 2 -B 1 -C 3 -l | head -10 --include="*.ts" --type=ts -P "TODO, FIXME"',
        rawInput: {
          pattern: "TODO, FIXME",
          "-i": true,
          "-n": true,
          "-A": 2,
          "-B": 1,
          "-C": 3,
          output_mode: "files_with_matches",
          head_limit: 10,
          glob: "*.ts",
          type: "ts",
          multiline: true,
        },
      },
      {
        case: "WebFetch URL",
        name: "WebFetch",
        partialJson: '{"url":"https://example.com/docs","prompt":',
        title: "Fetch https://example.com/docs",
        rawInput: { url: "https://example.com/docs" },
      },
      {
        case: "WebSearch query and domain array",
        name: "WebSearch",
        type: "server_tool_use" as const,
        partialJson:
          '{"query":"ACP tools","allowed_domains":["agentclientprotocol.com","github.com"],"blocked_domains":',
        title: '"ACP tools" (allowed: agentclientprotocol.com, github.com)',
        rawInput: {
          query: "ACP tools",
          allowed_domains: ["agentclientprotocol.com", "github.com"],
        },
      },
      {
        case: "ReportFindings nested array and object",
        name: "ReportFindings",
        partialJson:
          '{"findings":[{"file":"src/a.ts","line":7,"summary":"Broken","failure_scenario":"Fails"}],"level":',
        title: "Report 1 finding",
        rawInput: {
          findings: [
            {
              file: "src/a.ts",
              line: 7,
              summary: "Broken",
              failure_scenario: "Fails",
            },
          ],
        },
      },
      {
        case: "generic Other tool",
        name: "Other",
        partialJson: '{"query":"custom query","options":',
        title: "Other",
        rawInput: { query: "custom query" },
      },
      {
        case: "custom MCP tool",
        name: "mcp__demo__search",
        type: "mcp_tool_use" as const,
        partialJson: '{"query":"custom MCP query","options":',
        title: "mcp__demo__search",
        rawInput: { query: "custom MCP query" },
      },
    ])("refines $case before the full JSON object completes", (testCase) => {
      const { refined, streamedToolInputs } = refineFromPartialInput(testCase);

      expect(refined).toHaveLength(1);
      expect(refined[0].update).toMatchObject({
        sessionUpdate: "tool_call_update",
        toolCallId: "toolu_partial",
        title: testCase.title,
        rawInput: testCase.rawInput,
      });
      // Refinements never carry `content`: content built from partial input is
      // misleading (an Edit missing new_string renders as a deletion) or
      // invalid (a Write diff without content lacks the required newText).
      expect(refined[0].update).not.toHaveProperty("content");
      expect(streamedToolInputs.size).toBe(1);
    });

    it.each([
      {
        case: "ExitPlanMode plan",
        name: "ExitPlanMode",
        partialJson: '{"plan":"Implement streamed input"',
      },
      {
        case: "AskUserQuestion questions",
        name: "AskUserQuestion",
        partialJson:
          '{"questions":[{"question":"Which mode?","header":"Mode","options":[{"label":"Fast","description":"Fast mode"},{"label":"Safe","description":"Safe mode"}],"multiSelect":false}]',
      },
    ])(
      "waits for the consolidated message when $case is the only field",
      ({ name, partialJson }) => {
        // A single-field input has no top-level comma, so its one field only
        // completes when the whole object does — at which point the
        // consolidated assistant message refines the call. No early update.
        const { refined, streamedToolInputs } = refineFromPartialInput({ name, partialJson });
        expect(refined).toEqual([]);
        expect(streamedToolInputs.size).toBe(1);
      },
    );

    it("keeps streamed TodoWrite input out of the tool feed", () => {
      // TodoWrite surfaces as `plan` snapshots, not tool_calls; the snapshot is
      // emitted from the consolidated assistant message once the todos array is
      // complete, so the streamed lane stays silent.
      const { started, refined } = refineFromPartialInput({
        name: "TodoWrite",
        partialJson:
          '{"todos":[{"content":"Run tests","status":"in_progress","activeForm":"Running tests"}]',
      });

      expect(started).toEqual([]);
      expect(refined).toEqual([]);
    });

    it.each([
      {
        name: "TaskCreate",
        partialJson: '{"subject":"Create tests","description":',
      },
      {
        name: "TaskUpdate",
        partialJson: '{"taskId":"1","subject":"Update tests","status":',
      },
      { name: "TaskList", partialJson: "{}" },
      { name: "TaskGet", partialJson: '{"taskId":"1"}' },
    ])("keeps deliberately suppressed $name calls out of the tool feed", (testCase) => {
      const { started, refined } = refineFromPartialInput(testCase);
      expect(started).toEqual([]);
      expect(refined).toEqual([]);
    });

    it("does not publish an unfinished string", () => {
      const { refined } = refineFromPartialInput({
        name: "Bash",
        partialJson: '{"command":"sleep 900',
      });
      expect(refined).toEqual([]);
    });

    it("does not publish an ambiguous number until its delimiter arrives", () => {
      const first = refineFromPartialInput({ name: "Bash", partialJson: '{"timeout":10' });
      expect(first.refined).toEqual([]);

      const delimited = refineFromPartialInput({
        name: "Bash",
        partialJson: '{"timeout":100,"command":',
      });
      expect(delimited.refined).toHaveLength(1);
      expect(delimited.refined[0].update).toMatchObject({ rawInput: { timeout: 100 } });
    });

    it.each([
      {
        label: "boolean",
        partialJson: '{"run_in_background":true,"command":',
        rawInput: { run_in_background: true },
      },
      { label: "null", partialJson: '{"optional":null,"command":', rawInput: { optional: null } },
      {
        label: "array",
        partialJson: '{"items":[1,"two",false],"command":',
        rawInput: { items: [1, "two", false] },
      },
      {
        label: "nested object",
        partialJson: '{"options":{"limit":5,"enabled":true},"command":',
        rawInput: { options: { limit: 5, enabled: true } },
      },
    ])("recovers a completed $label value at a field boundary", ({ partialJson, rawInput }) => {
      const { refined } = refineFromPartialInput({ name: "CustomTool", partialJson });
      expect(refined).toHaveLength(1);
      expect(refined[0].update).toMatchObject({ sessionUpdate: "tool_call_update", rawInput });
    });

    it("survives a ping keep-alive arriving mid-stream", () => {
      const toolUseCache = {};
      const streamedToolInputs: StreamedToolInputCache = new Map();
      const options = { emittedToolCalls: new Set<string>(), streamedToolInputs };
      const baseMessage = {
        type: "stream_event",
        parent_tool_use_id: null,
        uuid: randomUUID(),
        session_id: "test-session",
      };
      const send = (event: unknown) =>
        streamEventToAcpNotifications(
          { ...baseMessage, event } as Parameters<typeof streamEventToAcpNotifications>[0],
          "test-session",
          toolUseCache,
          {} as AcpClient,
          console,
          options,
        );

      send({
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "toolu_ping", name: "Bash", input: {} },
      });
      send({
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: '{"command":"sleep 900"' },
      });
      // The API interleaves ping keep-alives during long generation pauses —
      // exactly when a large input is streaming. It must not disturb the
      // in-flight buffer.
      expect(send({ type: "ping" })).toEqual([]);
      expect(streamedToolInputs.size).toBe(1);

      const refined = send({
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: ',"timeout":' },
      });
      expect(refined).toHaveLength(1);
      expect(refined[0].update).toMatchObject({
        sessionUpdate: "tool_call_update",
        toolCallId: "toolu_ping",
        rawInput: { command: "sleep 900" },
      });
    });

    it("drops the buffered input at content_block_stop and message boundaries", () => {
      const toolUseCache = {};
      const streamedToolInputs: StreamedToolInputCache = new Map();
      const options = { emittedToolCalls: new Set<string>(), streamedToolInputs };
      const baseMessage = {
        type: "stream_event",
        parent_tool_use_id: null,
        uuid: randomUUID(),
        session_id: "test-session",
      };
      const send = (event: unknown) =>
        streamEventToAcpNotifications(
          { ...baseMessage, event } as Parameters<typeof streamEventToAcpNotifications>[0],
          "test-session",
          toolUseCache,
          {} as AcpClient,
          console,
          options,
        );

      send({
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "toolu_stop", name: "Bash", input: {} },
      });
      send({
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: '{"command":"tr' },
      });
      expect(streamedToolInputs.size).toBe(1);
      send({ type: "content_block_stop", index: 0 });
      expect(streamedToolInputs.size).toBe(0);

      send({
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "toolu_stale", name: "Bash", input: {} },
      });
      expect(streamedToolInputs.size).toBe(1);
      // A new message on the lane clears anything a cut-short stream left.
      send({ type: "message_start", message: {} });
      expect(streamedToolInputs.size).toBe(0);
    });
  });

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

    const result = streamEventToAcpNotifications(message, "test", {}, {} as AcpClient, console, {
      messageId,
    });

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
      {} as AcpClient,
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
      {} as AcpClient,
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
      {} as AcpClient,
      console,
      { messageId },
    );
    expect(thoughtResult[0].update).toMatchObject({
      sessionUpdate: "agent_thought_chunk",
      messageId,
    });
  });

  it("omits messageId when none is supplied", () => {
    const result = toAcpNotifications("hello", "assistant", "test", {}, {} as AcpClient, console);
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
      {} as AcpClient,
      console,
      { messageId, registerHooks: false },
    );
    expect(result[0].update.sessionUpdate).toBe("tool_call");
    expect(result[0].update).not.toHaveProperty("messageId");
  });
});

describe("toAcpNotifications thinking chunks", () => {
  it("emits an agent_thought_chunk for non-empty thinking text", () => {
    const result = toAcpNotifications(
      [{ type: "thinking", thinking: "let me reason", signature: "" }],
      "assistant",
      "test",
      {},
      {} as AcpClient,
      console,
    );

    expect(result).toEqual([
      {
        sessionId: "test",
        update: {
          sessionUpdate: "agent_thought_chunk",
          content: { type: "text", text: "let me reason" },
        },
      },
    ]);
  });

  it("skips empty thinking blocks (display: 'omitted' signature-only blocks)", () => {
    const result = toAcpNotifications(
      [{ type: "thinking", thinking: "", signature: "abc" }],
      "assistant",
      "test",
      {},
      {} as AcpClient,
      console,
    );

    expect(result).toEqual([]);
  });

  it("skips empty thinking deltas", () => {
    const result = toAcpNotifications(
      [{ type: "thinking_delta", thinking: "", estimated_tokens: 0 }],
      "assistant",
      "test",
      {},
      {} as AcpClient,
      console,
    );

    expect(result).toEqual([]);
  });

  it("skips thinking chunks without string content", () => {
    const result = toAcpNotifications(
      [
        { type: "thinking", signature: "abc" },
        { type: "thinking_delta", estimated_tokens: 0 },
        { type: "thinking_delta", thinking: null, estimated_tokens: 0 },
      ] as any,
      "assistant",
      "test",
      {},
      {} as AcpClient,
      console,
    );

    expect(result).toEqual([]);
  });

  it("skips text deltas without string content", () => {
    const result = toAcpNotifications(
      [{ type: "text_delta" }, { type: "text_delta", text: null }] as any,
      "assistant",
      "test",
      {},
      {} as AcpClient,
      console,
    );

    expect(result).toEqual([]);
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

describe("agent selection config option", () => {
  const baseModes = { currentModeId: "default", availableModes: [] };
  const baseModels = { currentModelId: "default", availableModels: [] };

  describe("discoverCustomAgents", () => {
    it("filters out Claude Code's built-in subagents", async () => {
      const q = {
        supportedAgents: async () => [
          { name: "claude", description: "catch-all" },
          { name: "Explore", description: "search" },
          { name: "general-purpose", description: "gp" },
          { name: "Plan", description: "architect" },
          { name: "statusline-setup", description: "status" },
          { name: "my-reviewer", description: "Reviews code" },
          { name: "my-writer", description: "Writes docs" },
        ],
      } as any;
      const agents = await discoverCustomAgents(q);
      expect(agents.map((a) => a.name)).toEqual(["my-reviewer", "my-writer"]);
    });

    it("excludes a custom agent named 'default' (reserved sentinel)", async () => {
      const q = {
        supportedAgents: async () => [
          { name: "default", description: "collides with the synthetic Default entry" },
          { name: "my-reviewer", description: "Reviews code" },
        ],
      } as any;
      const agents = await discoverCustomAgents(q);
      expect(agents.map((a) => a.name)).toEqual(["my-reviewer"]);
    });

    it("returns an empty list when discovery throws", async () => {
      const q = {
        supportedAgents: async () => {
          throw new Error("control request failed");
        },
      } as any;
      expect(await discoverCustomAgents(q)).toEqual([]);
    });
  });

  describe("buildConfigOptions agent option", () => {
    it("omits the agent option when no custom agents are configured", () => {
      const options = buildConfigOptions(baseModes, baseModels, [], undefined, [], "default");
      expect(options.find((o) => o.id === "agent")).toBeUndefined();
    });

    it("adds an agent option with a synthetic Default entry when custom agents exist", () => {
      const agents = [
        { name: "my-reviewer", description: "Reviews code" },
        // empty description should normalize to undefined, not ""
        { name: "my-writer", description: "" },
      ];
      const options = buildConfigOptions(
        baseModes,
        baseModels,
        [],
        undefined,
        agents,
        "my-reviewer",
      );
      const agentOption = options.find((o) => o.id === "agent");
      expect(agentOption).toBeDefined();
      expect(agentOption!.currentValue).toBe("my-reviewer");
      expect(agentOption!.type).toBe("select");
      const entries = (agentOption as any).options;
      expect(entries.map((o: any) => o.value)).toEqual(["default", "my-reviewer", "my-writer"]);
      expect(entries[2].description).toBeUndefined();
    });
  });

  describe("switching the agent", () => {
    function createMockAgent() {
      const mockClient = { sessionUpdate: async () => {} } as unknown as AcpClient;
      return new ClaudeAcpAgent(mockClient, { log: () => {}, error: () => {} });
    }

    const agents = [{ name: "my-reviewer", description: "Reviews code" }];

    function injectSession(agent: ClaudeAcpAgent, sessionId: string) {
      function* empty() {}
      const applyFlagSettings = vi.fn(async () => {});
      const gen = Object.assign(empty(), {
        interrupt: vi.fn(),
        close: vi.fn(),
        applyFlagSettings,
      });
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
        configOptions: buildConfigOptions(baseModes, baseModels, [], undefined, agents, "default"),
        agents,
        currentAgent: "default",
        fastModeEnabled: false,
        abortController: new AbortController(),
        emitRawSDKMessages: false,
        contextWindowSize: 200000,
        taskState: new Map(),
        toolUseCache: {},
        emittedToolCalls: new Set(),
        liveBackgroundTasks: new Map(),
        emittedAssistantText: false,
        owedTrailingIdles: 0,
        messageIdToUuid: new Map(),
      };
      return { session: agent.sessions[sessionId]!, applyFlagSettings };
    }

    it("applies the agent flag live without restarting the subprocess", async () => {
      const agent = createMockAgent();
      const { session, applyFlagSettings } = injectSession(agent, "s1");

      const result = await agent.setSessionConfigOption({
        sessionId: "s1",
        configId: "agent",
        value: "my-reviewer",
      });

      expect(applyFlagSettings).toHaveBeenCalledWith({ agent: "my-reviewer" });
      expect(session.currentAgent).toBe("my-reviewer");
      // The whole point of the SDK >= 0.3.161 approach: no process teardown.
      expect(session.query.interrupt).not.toHaveBeenCalled();
      expect(session.abortController.signal.aborted).toBe(false);
      expect(agent.sessions["s1"]).toBe(session);
      const agentOption = result.configOptions.find((o) => o.id === "agent");
      expect(agentOption?.currentValue).toBe("my-reviewer");
    });

    it("clears the flag (agent: null) when switching back to default", async () => {
      const agent = createMockAgent();
      const { session, applyFlagSettings } = injectSession(agent, "s2");
      session.currentAgent = "my-reviewer";

      await agent.setSessionConfigOption({
        sessionId: "s2",
        configId: "agent",
        value: "default",
      });

      expect(applyFlagSettings).toHaveBeenCalledWith({ agent: null });
      expect(session.currentAgent).toBe("default");
    });

    it("leaves tracked state untouched when the live switch is rejected", async () => {
      const agent = createMockAgent();
      const { session, applyFlagSettings } = injectSession(agent, "s3");
      applyFlagSettings.mockRejectedValueOnce(new Error("control channel closed"));

      await expect(
        agent.setSessionConfigOption({
          sessionId: "s3",
          configId: "agent",
          value: "my-reviewer",
        }),
      ).rejects.toThrow("control channel closed");

      // The flag never applied, so neither currentAgent nor the config option
      // moves — no desync with the agent the SDK is actually running.
      expect(session.currentAgent).toBe("default");
      const agentOption = session.configOptions.find((o) => o.id === "agent");
      expect(agentOption?.currentValue).toBe("default");
    });
  });
});
