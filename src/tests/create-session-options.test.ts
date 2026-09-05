import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  CreateElicitationRequest,
  RequestError,
  SessionNotification,
} from "@agentclientprotocol/sdk";
import type { ClientCapabilities } from "@agentclientprotocol/sdk";
import { getSessionMessages, type Options } from "@anthropic-ai/claude-agent-sdk";
import type { AcpClient, ClaudeAcpAgent as ClaudeAcpAgentType } from "../acp-agent.js";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

let capturedOptions: Options | undefined;
let contextUsageResult: (() => Promise<{ rawMaxTokens: number; model?: string }>) | undefined;
let sessionMessages: Record<string, unknown>[];
let sessionMessagesResult: () => Promise<Record<string, unknown>[]>;
let initModels: Record<string, unknown>[] | undefined;
let setModelImpl: ((model: string) => Promise<void>) | undefined;
let mcpServerStatusResult: () => Promise<Array<{ name: string; status: string }>>;
let mcpAuthenticateImpl: (serverName: string) => Promise<{
  authUrl?: string;
  requiresUserAction: boolean;
  callbackExpected: boolean;
}>;
vi.mock("@anthropic-ai/claude-agent-sdk", async () => {
  const actual = await vi.importActual<typeof import("@anthropic-ai/claude-agent-sdk")>(
    "@anthropic-ai/claude-agent-sdk",
  );
  const { makeMockQuery, DEFAULT_CONTEXT_USAGE } = await import("./helpers.js");
  return {
    ...actual,
    query: (args: { prompt: unknown; options: Options }) => {
      capturedOptions = args.options;
      return makeMockQuery({
        initializationResult: async () => ({
          models: initModels ?? [
            {
              value: "claude-sonnet-4-6",
              displayName: "Claude Sonnet",
              description: "Fast",
              supportsAutoMode: true,
            },
          ],
        }),
        setModel: (model: string) => (setModelImpl ? setModelImpl(model) : Promise.resolve()),
        getContextUsage: () =>
          contextUsageResult ? contextUsageResult() : Promise.resolve(DEFAULT_CONTEXT_USAGE),
        mcpServerStatus: () => mcpServerStatusResult(),
        mcpAuthenticate: (serverName: string) => mcpAuthenticateImpl(serverName),
      });
    },
    getSessionMessages: vi.fn(() => sessionMessagesResult()),
  };
});

vi.mock("../tools.js", async () => {
  const actual = await vi.importActual<typeof import("../tools.js")>("../tools.js");
  return {
    ...actual,
    registerHookCallback: vi.fn(),
  };
});

describe("createSession options merging", () => {
  let agent: ClaudeAcpAgentType;
  let ClaudeAcpAgent: typeof ClaudeAcpAgentType;

  function createMockClient(): AcpClient {
    return {
      sessionUpdate: async (_notification: SessionNotification) => {},
      requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
      readTextFile: async () => ({ content: "" }),
      writeTextFile: async () => ({}),
    } as unknown as AcpClient;
  }

  beforeEach(async () => {
    capturedOptions = undefined;
    contextUsageResult = undefined;
    sessionMessages = [];
    sessionMessagesResult = async () => sessionMessages;
    vi.mocked(getSessionMessages).mockClear();
    initModels = undefined;
    setModelImpl = undefined;
    mcpServerStatusResult = async () => [];
    mcpAuthenticateImpl = async () => ({
      requiresUserAction: false,
      callbackExpected: false,
    });

    vi.resetModules();
    const acpAgent = await import("../acp-agent.js");
    ClaudeAcpAgent = acpAgent.ClaudeAcpAgent;

    agent = new ClaudeAcpAgent(createMockClient());
  });

  it("merges user-provided disallowedTools with ACP internal list", async () => {
    await agent.newSession({
      cwd: process.cwd(),
      mcpServers: [],
      _meta: {
        claudeCode: {
          options: {
            disallowedTools: ["WebSearch", "WebFetch"],
          },
        },
      },
    });

    // User-provided tools should be present
    expect(capturedOptions!.disallowedTools).toContain("WebSearch");
    expect(capturedOptions!.disallowedTools).toContain("WebFetch");
    // ACP's internal disallowed tool should also be present
    expect(capturedOptions!.disallowedTools).toContain("AskUserQuestion");
  });

  it("works when user provides no disallowedTools", async () => {
    await agent.newSession({
      cwd: process.cwd(),
      mcpServers: [],
    });

    expect(capturedOptions!.disallowedTools).toContain("AskUserQuestion");
  });

  it("works when user provides empty disallowedTools", async () => {
    await agent.newSession({
      cwd: process.cwd(),
      mcpServers: [],
      _meta: {
        claudeCode: {
          options: {
            disallowedTools: [],
          },
        },
      },
    });

    expect(capturedOptions!.disallowedTools).toContain("AskUserQuestion");
  });

  it("sets tools to empty array when disableBuiltInTools is true", async () => {
    await agent.newSession({
      cwd: process.cwd(),
      mcpServers: [],
      _meta: {
        disableBuiltInTools: true,
        claudeCode: {
          options: {
            disallowedTools: ["CustomTool"],
          },
        },
      },
    });

    // disableBuiltInTools removes all built-in tools from context
    expect(capturedOptions!.tools).toEqual([]);
    // User-provided and ACP disallowedTools still apply
    expect(capturedOptions!.disallowedTools).toContain("CustomTool");
    expect(capturedOptions!.disallowedTools).toContain("AskUserQuestion");
  });

  it("merges user-provided hooks with ACP hooks", async () => {
    const userPreToolUseHook = { hooks: [{ command: "echo pre" }] };

    await agent.newSession({
      cwd: process.cwd(),
      mcpServers: [],
      _meta: {
        claudeCode: {
          options: {
            hooks: {
              PreToolUse: [userPreToolUseHook],
              PostToolUse: [{ hooks: [{ command: "echo user-post" }] }],
            },
          },
        },
      },
    });

    // User's PreToolUse hooks should be preserved
    expect(capturedOptions!.hooks?.PreToolUse).toEqual([userPreToolUseHook]);
    // PostToolUse should contain both user and ACP hooks
    expect(capturedOptions!.hooks?.PostToolUse).toHaveLength(2);
  });

  it("inherits HOME and PATH from process.env when no env is provided", async () => {
    await agent.newSession({
      cwd: process.cwd(),
      mcpServers: [],
    });

    expect(capturedOptions?.env?.HOME).toBe(process.env.HOME);
    expect(capturedOptions?.env?.PATH).toBe(process.env.PATH);
  });

  it("merges user-provided env vars on top of process.env", async () => {
    await agent.newSession({
      cwd: process.cwd(),
      mcpServers: [],
      _meta: {
        claudeCode: {
          options: {
            env: {
              CUSTOM_VAR: "custom-value",
            },
          },
        },
      },
    });

    expect(capturedOptions?.env?.HOME).toBe(process.env.HOME);
    expect(capturedOptions?.env?.PATH).toBe(process.env.PATH);
    expect(capturedOptions?.env?.CUSTOM_VAR).toBe("custom-value");
  });

  it("allows user-provided env vars to override process.env entries", async () => {
    await agent.newSession({
      cwd: process.cwd(),
      mcpServers: [],
      _meta: {
        claudeCode: {
          options: {
            env: {
              HOME: "/custom/home",
            },
          },
        },
      },
    });

    expect(capturedOptions?.env?.HOME).toBe("/custom/home");
  });

  it("defaults tools to claude_code preset when not provided", async () => {
    await agent.newSession({
      cwd: process.cwd(),
      mcpServers: [],
    });

    expect(capturedOptions!.tools).toEqual({ type: "preset", preset: "claude_code" });
  });

  it("passes through user-provided tools string array", async () => {
    await agent.newSession({
      cwd: process.cwd(),
      mcpServers: [],
      _meta: {
        claudeCode: {
          options: {
            tools: ["Read", "Glob"],
          },
        },
      },
    });

    expect(capturedOptions!.tools).toEqual(["Read", "Glob"]);
  });

  it("explicit tools array takes precedence over disableBuiltInTools", async () => {
    await agent.newSession({
      cwd: process.cwd(),
      mcpServers: [],
      _meta: {
        disableBuiltInTools: true,
        claudeCode: {
          options: {
            tools: ["Read", "Glob"],
          },
        },
      },
    });

    expect(capturedOptions!.tools).toEqual(["Read", "Glob"]);
  });

  it("passes through empty tools array to disable all built-in tools", async () => {
    await agent.newSession({
      cwd: process.cwd(),
      mcpServers: [],
      _meta: {
        claudeCode: {
          options: {
            tools: [],
          },
        },
      },
    });

    expect(capturedOptions!.tools).toEqual([]);
  });

  describe("subagent transcript forwarding", () => {
    it("keeps the legacy default when neither the client nor caller opts in", async () => {
      await agent.newSession({ cwd: process.cwd(), mcpServers: [] });

      expect(capturedOptions!.forwardSubagentText).toBe(false);
    });

    it("preserves caller-provided legacy transcript forwarding", async () => {
      await agent.newSession({
        cwd: process.cwd(),
        mcpServers: [],
        _meta: { claudeCode: { options: { forwardSubagentText: true } } },
      });

      expect(capturedOptions!.forwardSubagentText).toBe(true);
    });

    it("accepts the legacy transcript extension", async () => {
      await agent.initialize({
        protocolVersion: 1,
        clientCapabilities: { _meta: { "subagent-transcript": true } },
      });
      await agent.newSession({
        cwd: process.cwd(),
        mcpServers: [],
        _meta: { claudeCode: { options: { forwardSubagentText: false } } },
      });

      expect(capturedOptions!.forwardSubagentText).toBe(true);
    });

    it("enables SDK forwarding after native ACP negotiation", async () => {
      await agent.initialize({
        protocolVersion: 1,
        clientCapabilities: { subagents: {} } as ClientCapabilities,
      });
      await agent.newSession({
        cwd: process.cwd(),
        mcpServers: [],
        _meta: { claudeCode: { options: { forwardSubagentText: false } } },
      });

      expect(capturedOptions!.forwardSubagentText).toBe(true);
    });
  });

  describe("systemPrompt via _meta", () => {
    it("defaults to the claude_code preset when not provided", async () => {
      await agent.newSession({ cwd: process.cwd(), mcpServers: [] });

      expect(capturedOptions!.systemPrompt).toEqual({
        type: "preset",
        preset: "claude_code",
      });
    });

    it("replaces the preset when a string is provided", async () => {
      await agent.newSession({
        cwd: process.cwd(),
        mcpServers: [],
        _meta: { systemPrompt: "custom prompt" },
      });

      expect(capturedOptions!.systemPrompt).toBe("custom prompt");
    });

    it("forwards append", async () => {
      await agent.newSession({
        cwd: process.cwd(),
        mcpServers: [],
        _meta: { systemPrompt: { append: "extra instructions" } },
      });

      expect(capturedOptions!.systemPrompt).toEqual({
        type: "preset",
        preset: "claude_code",
        append: "extra instructions",
      });
    });

    it("forwards excludeDynamicSections", async () => {
      await agent.newSession({
        cwd: process.cwd(),
        mcpServers: [],
        _meta: { systemPrompt: { excludeDynamicSections: true } },
      });

      expect(capturedOptions!.systemPrompt).toEqual({
        type: "preset",
        preset: "claude_code",
        excludeDynamicSections: true,
      });
    });

    it("forwards append and excludeDynamicSections together", async () => {
      await agent.newSession({
        cwd: process.cwd(),
        mcpServers: [],
        _meta: {
          systemPrompt: {
            append: "extra instructions",
            excludeDynamicSections: true,
          },
        },
      });

      expect(capturedOptions!.systemPrompt).toEqual({
        type: "preset",
        preset: "claude_code",
        append: "extra instructions",
        excludeDynamicSections: true,
      });
    });

    it("ignores caller-provided type/preset overrides", async () => {
      await agent.newSession({
        cwd: process.cwd(),
        mcpServers: [],
        _meta: {
          systemPrompt: {
            type: "something-else",
            preset: "other-preset",
            append: "extra",
          },
        },
      });

      expect(capturedOptions!.systemPrompt).toEqual({
        type: "preset",
        preset: "claude_code",
        append: "extra",
      });
    });
  });

  describe("CLAUDE_MODEL_CONFIG", () => {
    let originalModelConfig: string | undefined;

    beforeEach(() => {
      originalModelConfig = process.env.CLAUDE_MODEL_CONFIG;
      delete process.env.CLAUDE_MODEL_CONFIG;
    });

    afterEach(() => {
      if (originalModelConfig !== undefined) {
        process.env.CLAUDE_MODEL_CONFIG = originalModelConfig;
      } else {
        delete process.env.CLAUDE_MODEL_CONFIG;
      }
    });

    it("passes modelOverrides as settings", async () => {
      process.env.CLAUDE_MODEL_CONFIG = JSON.stringify({
        modelOverrides: { "claude-opus-4-6": "us.anthropic.claude-opus-4-6-v1" },
      });

      await agent.newSession({ cwd: process.cwd(), mcpServers: [] });

      expect(capturedOptions!.settings).toEqual({
        modelOverrides: { "claude-opus-4-6": "us.anthropic.claude-opus-4-6-v1" },
      });
    });

    it("passes availableModels as settings", async () => {
      process.env.CLAUDE_MODEL_CONFIG = JSON.stringify({
        availableModels: ["opus", "sonnet"],
      });

      await agent.newSession({ cwd: process.cwd(), mcpServers: [] });

      expect(capturedOptions!.settings).toEqual({
        availableModels: ["opus", "sonnet"],
      });
    });

    it("passes both modelOverrides and availableModels", async () => {
      process.env.CLAUDE_MODEL_CONFIG = JSON.stringify({
        modelOverrides: { "claude-opus-4-6": "us.anthropic.claude-opus-4-6-v1" },
        availableModels: ["opus"],
      });

      await agent.newSession({ cwd: process.cwd(), mcpServers: [] });

      expect(capturedOptions!.settings).toEqual({
        modelOverrides: { "claude-opus-4-6": "us.anthropic.claude-opus-4-6-v1" },
        availableModels: ["opus"],
      });
    });

    it("does not add settings when env var is not set", async () => {
      await agent.newSession({ cwd: process.cwd(), mcpServers: [] });

      expect(capturedOptions!.settings).toBeUndefined();
    });

    it("ignores env var when _meta provides settings", async () => {
      process.env.CLAUDE_MODEL_CONFIG = JSON.stringify({
        modelOverrides: { "claude-opus-4-6": "us.anthropic.claude-opus-4-6-v1" },
      });

      await agent.newSession({
        cwd: process.cwd(),
        mcpServers: [],
        _meta: {
          claudeCode: {
            options: {
              settings: {
                model: "claude-sonnet-4-6",
                modelOverrides: { "claude-opus-4-6": "meta-value" },
              },
            },
          },
        },
      });

      // _meta settings take precedence; env var is ignored entirely
      expect(capturedOptions!.settings).toEqual({
        model: "claude-sonnet-4-6",
        modelOverrides: { "claude-opus-4-6": "meta-value" },
      });
    });

    it("throws on invalid JSON", async () => {
      process.env.CLAUDE_MODEL_CONFIG = "not-json";

      await expect(agent.newSession({ cwd: process.cwd(), mcpServers: [] })).rejects.toThrow();
    });
  });

  it("merges user-provided mcpServers with ACP mcpServers", async () => {
    await agent.newSession({
      cwd: process.cwd(),
      mcpServers: [
        {
          name: "acp-server",
          command: "node",
          args: ["acp-server.js"],
          env: [],
        },
      ],
      _meta: {
        claudeCode: {
          options: {
            mcpServers: {
              "user-server": {
                type: "stdio",
                command: "node",
                args: ["server.js"],
              },
            },
          },
        },
      },
    });

    // User-provided MCP server should be present
    expect(capturedOptions!.mcpServers).toHaveProperty("user-server");
    // ACP-provided MCP server should also be present
    expect(capturedOptions!.mcpServers).toHaveProperty("acp-server");
  });

  describe("thinking config from MAX_THINKING_TOKENS", () => {
    let originalMaxThinking: string | undefined;

    beforeEach(() => {
      originalMaxThinking = process.env.MAX_THINKING_TOKENS;
      delete process.env.MAX_THINKING_TOKENS;
    });

    afterEach(() => {
      if (originalMaxThinking !== undefined) {
        process.env.MAX_THINKING_TOKENS = originalMaxThinking;
      } else {
        delete process.env.MAX_THINKING_TOKENS;
      }
    });

    it("leaves thinking unset (SDK default) when env var is absent", async () => {
      await agent.newSession({ cwd: process.cwd(), mcpServers: [] });
      expect(capturedOptions!.thinking).toBeUndefined();
      // The deprecated option must not be set either.
      expect(capturedOptions!.maxThinkingTokens).toBeUndefined();
    });

    it("maps 0 to disabled thinking", async () => {
      process.env.MAX_THINKING_TOKENS = "0";
      await agent.newSession({ cwd: process.cwd(), mcpServers: [] });
      expect(capturedOptions!.thinking).toEqual({ type: "disabled" });
    });

    it("maps a positive value to a fixed thinking budget", async () => {
      process.env.MAX_THINKING_TOKENS = "12000";
      await agent.newSession({ cwd: process.cwd(), mcpServers: [] });
      expect(capturedOptions!.thinking).toEqual({ type: "enabled", budgetTokens: 12000 });
    });

    it("ignores a non-numeric value", async () => {
      process.env.MAX_THINKING_TOKENS = "lots";
      // The bad value is deliberate — capture the agent's warning instead of
      // letting it hit the console.
      const errorSpy = vi.fn();
      (agent as any).logger = { log: () => {}, error: errorSpy };
      await agent.newSession({ cwd: process.cwd(), mcpServers: [] });
      expect(capturedOptions!.thinking).toBeUndefined();
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("MAX_THINKING_TOKENS"));
    });

    it("lets a user-provided thinking option override the env default", async () => {
      process.env.MAX_THINKING_TOKENS = "12000";
      await agent.newSession({
        cwd: process.cwd(),
        mcpServers: [],
        _meta: {
          claudeCode: {
            options: {
              thinking: { type: "adaptive" },
            },
          },
        },
      });
      expect(capturedOptions!.thinking).toEqual({ type: "adaptive" });
    });
  });

  describe("cwd validation", () => {
    it("rejects a relative cwd with invalidParams", async () => {
      await expect(
        agent.newSession({ cwd: "relative/path", mcpServers: [] }),
      ).rejects.toMatchObject({ code: RequestError.invalidParams().code });
    });

    it("rejects a non-existent cwd with invalidParams", async () => {
      const missing = path.join(os.tmpdir(), "claude-acp-does-not-exist-xyz");
      await expect(agent.newSession({ cwd: missing, mcpServers: [] })).rejects.toMatchObject({
        code: RequestError.invalidParams().code,
      });
    });

    it("rejects a cwd that points at a file with invalidParams", async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-acp-cwd-is-a-file-"));
      const file = path.join(dir, "not-a-directory.txt");
      fs.writeFileSync(file, "not a directory");
      try {
        await expect(agent.newSession({ cwd: file, mcpServers: [] })).rejects.toMatchObject({
          code: RequestError.invalidParams().code,
        });
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it("accepts an existing absolute directory", async () => {
      await expect(agent.newSession({ cwd: process.cwd(), mcpServers: [] })).resolves.toBeDefined();
    });
  });

  describe("elicitation", () => {
    it("keeps AskUserQuestion disabled and omits callbacks without elicitation capability", async () => {
      await agent.initialize({ protocolVersion: 1, clientCapabilities: {} });
      await agent.newSession({ cwd: process.cwd(), mcpServers: [] });

      expect(capturedOptions!.disallowedTools).toContain("AskUserQuestion");
      expect(capturedOptions!.onElicitation).toBeUndefined();
    });

    it("enables AskUserQuestion and wires the elicitation callback when form is supported", async () => {
      await agent.initialize({
        protocolVersion: 1,
        clientCapabilities: { elicitation: { form: {} } },
      });
      await agent.newSession({ cwd: process.cwd(), mcpServers: [] });

      expect(capturedOptions!.disallowedTools).not.toContain("AskUserQuestion");
      expect(typeof capturedOptions!.onElicitation).toBe("function");
    });

    it("wires callbacks for url-only elicitation but keeps AskUserQuestion disabled", async () => {
      await agent.initialize({
        protocolVersion: 1,
        clientCapabilities: { elicitation: { url: {} } },
      });
      await agent.newSession({ cwd: process.cwd(), mcpServers: [] });

      expect(capturedOptions!.disallowedTools).toContain("AskUserQuestion");
      expect(typeof capturedOptions!.onElicitation).toBe("function");
    });

    it("starts MCP OAuth as an ACP URL elicitation and completes it after reconnect", async () => {
      let statusCall = 0;
      mcpServerStatusResult = async () =>
        statusCall++ === 0
          ? [{ name: "linear", status: "needs-auth" }]
          : [{ name: "linear", status: "connected" }];
      const authenticate = vi.fn(async () => ({
        authUrl: "https://example.com/oauth/authorize",
        requiresUserAction: true,
        callbackExpected: true,
      }));
      mcpAuthenticateImpl = authenticate;
      const createElicitation = vi.fn(async (_request: CreateElicitationRequest) => ({
        action: "accept" as const,
      }));
      const completeElicitation = vi.fn(async () => {});
      Object.assign((agent as unknown as { client: object }).client, {
        createElicitation,
        completeElicitation,
      });

      await agent.initialize({
        protocolVersion: 1,
        clientCapabilities: { elicitation: { url: {} } },
      });
      const { sessionId } = await agent.newSession({
        cwd: process.cwd(),
        mcpServers: [
          { name: "linear", type: "http", url: "https://mcp.linear.app/mcp", headers: [] },
        ],
      });

      await vi.waitFor(() => expect(completeElicitation).toHaveBeenCalledOnce());

      expect(authenticate).toHaveBeenCalledWith("linear");
      expect(createElicitation).toHaveBeenCalledOnce();
      const request = createElicitation.mock.calls[0]![0];
      expect(request.mode).toBe("url");
      if (request.mode !== "url") throw new Error("Expected a URL elicitation");
      expect(request).toMatchObject({
        mode: "url",
        sessionId,
        message: "Authenticate with MCP server linear",
        url: "https://example.com/oauth/authorize",
        elicitationId: expect.stringMatching(/^mcp-oauth-/),
      });
      expect(completeElicitation).toHaveBeenCalledWith({
        elicitationId: request.elicitationId,
      });
    });

    it("still merges user-provided disallowedTools when AskUserQuestion is enabled", async () => {
      await agent.initialize({
        protocolVersion: 1,
        clientCapabilities: { elicitation: { form: {} } },
      });
      await agent.newSession({
        cwd: process.cwd(),
        mcpServers: [],
        _meta: { claudeCode: { options: { disallowedTools: ["WebSearch"] } } },
      });

      expect(capturedOptions!.disallowedTools).toContain("WebSearch");
      expect(capturedOptions!.disallowedTools).not.toContain("AskUserQuestion");
    });
  });

  describe("context window seeding", () => {
    function sessionFor(sessionId: string) {
      return (agent as unknown as { sessions: Record<string, any> }).sessions[sessionId];
    }

    it("does not call getContextUsage during session creation", async () => {
      // getContextUsage stalls until the session's first prompt turn has run
      // (it is not serviced pre-turn), so session/new must never call it —
      // awaiting it inline is what regressed session/new latency in 0.59.0.
      const ctxSpy = vi.fn(async () => ({ rawMaxTokens: 967000 }));
      contextUsageResult = ctxSpy;

      await agent.newSession({ cwd: process.cwd(), mcpServers: [] });

      expect(ctxSpy).not.toHaveBeenCalled();
    });

    it("seeds contextWindowSize from text inference, falling back to the default when it misses", async () => {
      // The mock model ("claude-sonnet-4-6" / "Claude Sonnet" / "Fast") carries
      // no "1m" token anywhere, so inference misses and the window falls back to
      // the default; the authoritative value arrives later via result.modelUsage.
      contextUsageResult = async () => ({ rawMaxTokens: 967000 });

      const response = await agent.newSession({ cwd: process.cwd(), mcpServers: [] });

      expect(sessionFor(response.sessionId).contextWindowSize).toBe(200000);
      expect(sessionFor(response.sessionId).contextWindowAuthoritative).toBe(false);
    });

    it("session/load restores the transcript model without waiting for getContextUsage", async () => {
      // getContextUsage is a live CLI control request. On a real, large resumed
      // session it can take tens of seconds before returning, so it must stay
      // off the load critical path. Claude restores from this same last
      // assistant model field, which is available through a local transcript
      // read in milliseconds.
      const ctxSpy = vi.fn(() => new Promise<never>(() => {}));
      contextUsageResult = ctxSpy;
      initModels = [
        {
          value: "default",
          displayName: "Default",
          description: "Default model",
          resolvedModel: "claude-sonnet-4-6",
        },
        {
          value: "haiku",
          displayName: "Haiku",
          description: "Fast",
          resolvedModel: "claude-haiku-4-5",
        },
      ];
      sessionMessages = [
        {
          type: "assistant",
          uuid: "assistant-uuid",
          session_id: "resumed-model-probe",
          parent_tool_use_id: null,
          parent_agent_id: null,
          message: { model: "claude-haiku-4-5", role: "assistant", content: [] },
        },
      ];

      const response = await agent.loadSession({
        sessionId: "resumed-model-probe",
        cwd: process.cwd(),
        mcpServers: [],
      });

      expect(response.configOptions?.find((option) => option.id === "model")?.currentValue).toBe(
        "haiku",
      );
      expect(ctxSpy).not.toHaveBeenCalled();
      expect(sessionFor("resumed-model-probe").contextWindowAuthoritative).toBe(false);
      expect(getSessionMessages).toHaveBeenCalledTimes(1);
      expect(getSessionMessages).toHaveBeenCalledWith("resumed-model-probe");
    });

    it("resume remains best-effort when the transcript hint cannot be read", async () => {
      sessionMessagesResult = async () => {
        throw new Error("unreadable transcript");
      };

      await expect(
        agent.resumeSession({
          sessionId: "unreadable-resume-probe",
          cwd: process.cwd(),
          mcpServers: [],
        }),
      ).resolves.toMatchObject({ sessionId: "unreadable-resume-probe" });
    });

    it("scopes providerCacheKey by per-session env routing", async () => {
      // The context-window cache key must distinguish backends exactly as the
      // CLI will see them: a session routed to a proxy via _meta env shares a
      // model id spelling with default-routed sessions but not a context lane,
      // so it must land in its own cache bucket (and two default-routed
      // sessions must share one).
      const r1 = await agent.newSession({ cwd: process.cwd(), mcpServers: [] });
      const r2 = await agent.newSession({
        cwd: process.cwd(),
        mcpServers: [],
        _meta: {
          claudeCode: {
            options: { env: { ANTHROPIC_BASE_URL: "https://window-probe-proxy.example" } },
          },
        },
      });
      const r3 = await agent.newSession({ cwd: process.cwd(), mcpServers: [] });

      expect(sessionFor(r2.sessionId).providerCacheKey).not.toBe(
        sessionFor(r1.sessionId).providerCacheKey,
      );
      expect(sessionFor(r3.sessionId).providerCacheKey).toBe(
        sessionFor(r1.sessionId).providerCacheKey,
      );
    });

    it("scopes providerCacheKey by provider headers: same endpoint, different headers → different buckets", async () => {
      // Two providers/set configs sharing apiType+baseUrl but differing in
      // headers (e.g. an `anthropic-beta: context-1m-…` routing header) can
      // serve different context lanes for the same model id, so they must not
      // share a window-cache bucket.
      await agent.unstable_setProvider({
        providerId: "main",
        apiType: "anthropic",
        baseUrl: "https://gw.example",
        headers: {},
      });
      const plain = await agent.newSession({ cwd: process.cwd(), mcpServers: [] });
      const plainProviderCacheKey = sessionFor(plain.sessionId).providerCacheKey;

      await agent.unstable_setProvider({
        providerId: "main",
        apiType: "anthropic",
        baseUrl: "https://gw.example",
        headers: { "anthropic-beta": "context-1m-2025-08-07" },
      });
      const beta = await agent.newSession({ cwd: process.cwd(), mcpServers: [] });

      expect(sessionFor(beta.sessionId).providerCacheKey).not.toBe(plainProviderCacheKey);
    });
  });

  describe("refusal fallback dialog", () => {
    it("declares the dialog kind and callback when the client supports form elicitation", async () => {
      await agent.initialize({
        protocolVersion: 1,
        clientCapabilities: { elicitation: { form: {} } },
      });
      await agent.newSession({ cwd: process.cwd(), mcpServers: [] });

      expect(capturedOptions!.supportedDialogKinds).toEqual(["refusal_fallback_prompt"]);
      expect(typeof capturedOptions!.onUserDialog).toBe("function");
    });

    it("omits the dialog wiring without form elicitation support (url-only included)", async () => {
      await agent.initialize({
        protocolVersion: 1,
        clientCapabilities: { elicitation: { url: {} } },
      });
      await agent.newSession({ cwd: process.cwd(), mcpServers: [] });

      // The CLI fails closed on the undeclared kind, so the flow degrades to
      // the classic refusal error instead of parking a dialog we can't render.
      expect(capturedOptions!.supportedDialogKinds).toBeUndefined();
      expect(capturedOptions!.onUserDialog).toBeUndefined();
    });

    /** Wire the session up with form support and return the captured dialog
     *  callback plus a mock the test can point the elicitation response at. */
    async function setupDialog() {
      await agent.initialize({
        protocolVersion: 1,
        clientCapabilities: { elicitation: { form: {} } },
      });
      await agent.newSession({ cwd: process.cwd(), mcpServers: [] });
      const createElicitation = vi.fn();
      (agent as unknown as { client: { createElicitation: unknown } }).client.createElicitation =
        createElicitation;
      return { onUserDialog: capturedOptions!.onUserDialog!, createElicitation };
    }

    const signal = () => ({ signal: new AbortController().signal, requestId: "1" });

    it("renders the prompt as a form elicitation and maps the retry choice", async () => {
      const { onUserDialog, createElicitation } = await setupDialog();
      createElicitation.mockResolvedValue({
        action: "accept",
        content: { choice: "retry_fallback" },
      });

      const result = await onUserDialog(
        {
          dialogKind: "refusal_fallback_prompt",
          payload: {
            originalModel: "claude-fable-5",
            fallbackModel: "claude-opus-4-8",
            apiRefusalCategory: "cyber",
          },
        },
        signal(),
      );

      expect(result).toEqual({ behavior: "completed", result: "retry_fallback" });
      const request = createElicitation.mock.calls[0][0];
      expect(request.mode).toBe("form");
      expect(request.message).toContain("claude-fable-5");
      expect(request.message).toContain("claude-opus-4-8");
    });

    it("completes with cancelled when the user keeps the refusal", async () => {
      const { onUserDialog, createElicitation } = await setupDialog();
      createElicitation.mockResolvedValue({ action: "cancel" });

      const result = await onUserDialog(
        {
          dialogKind: "refusal_fallback_prompt",
          payload: { originalModel: "a", fallbackModel: "b" },
        },
        signal(),
      );

      expect(result).toEqual({ behavior: "completed", result: "cancelled" });
    });

    it("cancels unrecognized dialog kinds without presenting anything", async () => {
      const { onUserDialog, createElicitation } = await setupDialog();

      const result = await onUserDialog(
        { dialogKind: "some_future_dialog", payload: {} },
        signal(),
      );

      expect(result).toEqual({ behavior: "cancelled" });
      expect(createElicitation).not.toHaveBeenCalled();
    });

    it("cancels on a malformed payload without presenting anything", async () => {
      const { onUserDialog, createElicitation } = await setupDialog();
      // The malformed payload is deliberate — capture the agent's warning
      // instead of letting it hit the console.
      const errorSpy = vi.fn();
      (agent as any).logger = { log: () => {}, error: errorSpy };

      const result = await onUserDialog(
        { dialogKind: "refusal_fallback_prompt", payload: { fallbackModel: 42 } },
        signal(),
      );

      expect(result).toEqual({ behavior: "cancelled" });
      expect(createElicitation).not.toHaveBeenCalled();
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("unexpected shape"));
    });

    it("cancels when the elicitation request fails", async () => {
      const { onUserDialog, createElicitation } = await setupDialog();
      createElicitation.mockRejectedValue(new Error("client exploded"));
      // The client failure is deliberate — capture the agent's warning
      // instead of letting it hit the console.
      const errorSpy = vi.fn();
      (agent as any).logger = { log: () => {}, error: errorSpy };

      const result = await onUserDialog(
        {
          dialogKind: "refusal_fallback_prompt",
          payload: { originalModel: "a", fallbackModel: "b" },
        },
        signal(),
      );

      expect(result).toEqual({ behavior: "cancelled" });
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("client exploded"));
    });
  });

  describe("model switches and PreModelSwitch hooks", () => {
    const TWO_MODELS = [
      {
        value: "claude-sonnet-4-6",
        displayName: "Claude Sonnet",
        description: "Fast",
        supportsAutoMode: true,
      },
      {
        value: "claude-opus-4-8",
        displayName: "Claude Opus",
        description: "Capable",
        supportsAutoMode: true,
      },
    ];

    let originalAnthropicModel: string | undefined;
    beforeEach(() => {
      originalAnthropicModel = process.env.ANTHROPIC_MODEL;
      delete process.env.ANTHROPIC_MODEL;
    });
    afterEach(() => {
      if (originalAnthropicModel !== undefined) {
        process.env.ANTHROPIC_MODEL = originalAnthropicModel;
      } else {
        delete process.env.ANTHROPIC_MODEL;
      }
    });

    it("tolerates a PreModelSwitch hook vetoing the fresh-session model pin", async () => {
      // CLI 2.1.251+: a user-configured PreModelSwitch hook can deny (or
      // 'ask', which headless sessions refuse) the pin's setModel. Terminal
      // Claude Code never lets a hook veto its startup model, so the same
      // config must not fail session/new over ACP — the session stays on the
      // SDK's default, and we report that.
      initModels = TWO_MODELS;
      process.env.ANTHROPIC_MODEL = "opus";
      setModelImpl = () =>
        Promise.reject(new Error("Model switch blocked by a PreModelSwitch hook: pinned by IT"));

      const errorSpy = vi.fn();
      (agent as any).logger = { log: () => {}, error: errorSpy };
      const response = await agent.newSession({ cwd: process.cwd(), mcpServers: [] });

      expect((agent as any).sessions[response.sessionId].models.currentModelId).toBe(
        "claude-sonnet-4-6",
      );
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining("vetoed by a PreModelSwitch hook"),
        expect.anything(),
      );
    });

    it("still fails session/new loudly on a non-hook setModel failure", async () => {
      initModels = TWO_MODELS;
      process.env.ANTHROPIC_MODEL = "opus";
      setModelImpl = () => Promise.reject(new Error("transport exploded"));

      await expect(agent.newSession({ cwd: process.cwd(), mcpServers: [] })).rejects.toThrow(
        "transport exploded",
      );
    });

    it("syncs adapter model state when a PostModelSwitch hook reports an external switch", async () => {
      // A `/model <name>` command typed as a prompt switches the session's
      // model with no refusal-fallback frame; the registered PostModelSwitch
      // hook is what keeps the ACP picker truthful.
      initModels = TWO_MODELS;
      const response = await agent.newSession({ cwd: process.cwd(), mcpServers: [] });
      const sessionId = response.sessionId;

      const matchers = capturedOptions!.hooks?.PostModelSwitch;
      expect(matchers).toBeDefined();
      const callback = (matchers!.at(-1) as any).hooks[0];

      const hookInput = {
        hook_event_name: "PostModelSwitch",
        session_id: sessionId,
        transcript_path: "",
        cwd: process.cwd(),
        from_model: "claude-sonnet-4-6",
        to_model: "claude-opus-4-8",
        requested_model: "opus",
        source: "command",
        context_tokens: 0,
        prompt_cache_warm: false,
        cache_ttl: "5m",
        estimated_cache_write_usd: 0,
        pricing: "catalog",
      };
      const out = await callback(hookInput, undefined, {
        signal: new AbortController().signal,
      });
      expect(out).toEqual({ continue: true });

      // The sync is detached from the hook response (control requests are
      // serialized); wait for it to land.
      await vi.waitFor(() => {
        expect((agent as any).sessions[sessionId].models.currentModelId).toBe("claude-opus-4-8");
      });
    });

    it("ignores PostModelSwitch reports for the adapter's own setModel calls", async () => {
      initModels = TWO_MODELS;
      const response = await agent.newSession({ cwd: process.cwd(), mcpServers: [] });
      const sessionId = response.sessionId;
      const callback = (capturedOptions!.hooks!.PostModelSwitch!.at(-1) as any).hooks[0];

      await callback(
        {
          hook_event_name: "PostModelSwitch",
          session_id: sessionId,
          transcript_path: "",
          cwd: process.cwd(),
          from_model: "claude-sonnet-4-6",
          to_model: "claude-opus-4-8",
          requested_model: "opus",
          source: "sdk",
          context_tokens: 0,
          prompt_cache_warm: false,
          cache_ttl: "5m",
          estimated_cache_write_usd: 0,
          pricing: "catalog",
        },
        undefined,
        { signal: new AbortController().signal },
      );

      // Detached-sync window: give a stray sync the chance to land, then
      // assert nothing moved.
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
      expect((agent as any).sessions[sessionId].models.currentModelId).toBe("claude-sonnet-4-6");
    });
  });
});
