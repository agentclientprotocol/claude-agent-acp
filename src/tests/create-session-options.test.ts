import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { AgentSideConnection, SessionNotification } from "@agentclientprotocol/sdk";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import type { ClaudeAcpAgent as ClaudeAcpAgentType } from "../acp-agent.js";

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
            { value: "claude-sonnet-4-5", displayName: "Claude Sonnet", description: "Fast" },
          ],
        }),
        setModel: async () => {},
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
      cwd: "/test",
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
      cwd: "/test",
      mcpServers: [],
    });

    expect(capturedOptions!.disallowedTools).toContain("AskUserQuestion");
  });

  it("works when user provides empty disallowedTools", async () => {
    await agent.newSession({
      cwd: "/test",
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
      cwd: "/test",
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
      cwd: "/test",
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
      cwd: "/test",
      mcpServers: [],
    });

    expect(capturedOptions?.env?.HOME).toBe(process.env.HOME);
    expect(capturedOptions?.env?.PATH).toBe(process.env.PATH);
  });

  it("merges user-provided env vars on top of process.env", async () => {
    await agent.newSession({
      cwd: "/test",
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
      cwd: "/test",
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
      cwd: "/test",
      mcpServers: [],
    });

    expect(capturedOptions!.tools).toEqual({ type: "preset", preset: "claude_code" });
  });

  it("passes through user-provided tools string array", async () => {
    await agent.newSession({
      cwd: "/test",
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
      cwd: "/test",
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
      cwd: "/test",
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
      await agent.newSession({ cwd: "/test", mcpServers: [] });

      expect(capturedOptions!.systemPrompt).toEqual({
        type: "preset",
        preset: "claude_code",
      });
    });

    it("replaces the preset when a string is provided", async () => {
      await agent.newSession({
        cwd: "/test",
        mcpServers: [],
        _meta: { systemPrompt: "custom prompt" },
      });

      expect(capturedOptions!.systemPrompt).toBe("custom prompt");
    });

    it("forwards append", async () => {
      await agent.newSession({
        cwd: "/test",
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
        cwd: "/test",
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
        cwd: "/test",
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
        cwd: "/test",
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

      await agent.newSession({ cwd: "/test", mcpServers: [] });

      expect(capturedOptions!.settings).toEqual({
        modelOverrides: { "claude-opus-4-6": "us.anthropic.claude-opus-4-6-v1" },
      });
    });

    it("passes availableModels as settings", async () => {
      process.env.CLAUDE_MODEL_CONFIG = JSON.stringify({
        availableModels: ["opus", "sonnet"],
      });

      await agent.newSession({ cwd: "/test", mcpServers: [] });

      expect(capturedOptions!.settings).toEqual({
        availableModels: ["opus", "sonnet"],
      });
    });

    it("passes both modelOverrides and availableModels", async () => {
      process.env.CLAUDE_MODEL_CONFIG = JSON.stringify({
        modelOverrides: { "claude-opus-4-6": "us.anthropic.claude-opus-4-6-v1" },
        availableModels: ["opus"],
      });

      await agent.newSession({ cwd: "/test", mcpServers: [] });

      expect(capturedOptions!.settings).toEqual({
        modelOverrides: { "claude-opus-4-6": "us.anthropic.claude-opus-4-6-v1" },
        availableModels: ["opus"],
      });
    });

    it("does not add settings when env var is not set", async () => {
      await agent.newSession({ cwd: "/test", mcpServers: [] });

      expect(capturedOptions!.settings).toBeUndefined();
    });

    it("ignores env var when _meta provides settings", async () => {
      process.env.CLAUDE_MODEL_CONFIG = JSON.stringify({
        modelOverrides: { "claude-opus-4-6": "us.anthropic.claude-opus-4-6-v1" },
      });

      await agent.newSession({
        cwd: "/test",
        mcpServers: [],
        _meta: {
          claudeCode: {
            options: {
              settings: {
                model: "claude-sonnet-4-5",
                modelOverrides: { "claude-opus-4-6": "meta-value" },
              },
            },
          },
        },
      });

      // _meta settings take precedence; env var is ignored entirely
      expect(capturedOptions!.settings).toEqual({
        model: "claude-sonnet-4-5",
        modelOverrides: { "claude-opus-4-6": "meta-value" },
      });
    });

    it("throws on invalid JSON", async () => {
      process.env.CLAUDE_MODEL_CONFIG = "not-json";

      await expect(agent.newSession({ cwd: "/test", mcpServers: [] })).rejects.toThrow();
    });
  });

  it("merges user-provided mcpServers with ACP mcpServers", async () => {
    await agent.newSession({
      cwd: "/test",
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
});
