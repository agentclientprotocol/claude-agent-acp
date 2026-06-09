import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { AgentSideConnection, RequestError, SessionNotification } from "@agentclientprotocol/sdk";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import type { ClaudeAcpAgent as ClaudeAcpAgentType } from "../acp-agent.js";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

let capturedOptions: Options | undefined;
vi.mock("@anthropic-ai/claude-agent-sdk", async () => {
  const actual = await vi.importActual<typeof import("@anthropic-ai/claude-agent-sdk")>(
    "@anthropic-ai/claude-agent-sdk",
  );
  return {
    ...actual,
    query: (args: { prompt: unknown; options: Options }) => {
      capturedOptions = args.options;
      return {
        initializationResult: async () => ({
          models: [
            {
              value: "claude-sonnet-4-6",
              displayName: "Claude Sonnet",
              description: "Fast",
              supportsAutoMode: true,
            },
          ],
        }),
        setModel: async () => {},
        setPermissionMode: async () => {},
        supportedCommands: async () => [],
        [Symbol.asyncIterator]: async function* () {},
      };
    },
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

  function createMockClient(): AgentSideConnection {
    return {
      sessionUpdate: async (_notification: SessionNotification) => {},
      requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
      readTextFile: async () => ({ content: "" }),
      writeTextFile: async () => ({}),
    } as unknown as AgentSideConnection;
  }

  beforeEach(async () => {
    capturedOptions = undefined;

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
      await agent.newSession({ cwd: process.cwd(), mcpServers: [] });
      expect(capturedOptions!.thinking).toBeUndefined();
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
      const file = path.join(os.tmpdir(), "claude-acp-cwd-is-a-file.txt");
      fs.writeFileSync(file, "not a directory");
      try {
        await expect(agent.newSession({ cwd: file, mcpServers: [] })).rejects.toMatchObject({
          code: RequestError.invalidParams().code,
        });
      } finally {
        fs.rmSync(file, { force: true });
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
});
