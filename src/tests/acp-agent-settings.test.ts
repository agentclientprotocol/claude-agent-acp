import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { AgentSideConnection } from "@agentclientprotocol/sdk";
import type { ClaudeAcpAgent as ClaudeAcpAgentType } from "../acp-agent.js";

const { querySpy } = vi.hoisted(() => ({
  querySpy: vi.fn(),
}));

vi.mock("@anthropic-ai/claude-agent-sdk", async () => {
  const actual = await vi.importActual<any>("@anthropic-ai/claude-agent-sdk");
  return {
    ...actual,
    query: querySpy,
  };
});

describe("ClaudeAcpAgent settings", () => {
  let tempDir: string;
  let originalClaudeConfigDir: string | undefined;

  function createMockClient(): AgentSideConnection {
    return {
      sessionUpdate: async () => {},
      requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
      readTextFile: async () => ({ content: "" }),
      writeTextFile: async () => ({}),
    } as unknown as AgentSideConnection;
  }

  function mockQuery() {
    let capturedOptions: any;
    const setModelSpy = vi.fn();
    querySpy.mockImplementation(({ options }: any) => {
      capturedOptions = options;
      return {
        initializationResult: async () => ({
          models: [
            {
              value: "claude-sonnet-4-5",
              displayName: "Claude Sonnet 4.5",
              description: "Default",
            },
          ],
        }),
        setModel: setModelSpy,
        supportedCommands: async () => [],
      } as any;
    });
    return { getCapturedOptions: () => capturedOptions, setModelSpy };
  }

  beforeEach(async () => {
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "acp-agent-settings-"));
    originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = tempDir;
    querySpy.mockReset();
    vi.resetModules();
  });

  afterEach(async () => {
    if (originalClaudeConfigDir) {
      process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDir;
    } else {
      delete process.env.CLAUDE_CONFIG_DIR;
    }
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  });

  it("uses permissions.defaultMode for new sessions", async () => {
    await fs.promises.writeFile(
      path.join(tempDir, "settings.json"),
      JSON.stringify({
        permissions: {
          defaultMode: "dontAsk",
        },
      }),
    );

    const projectDir = path.join(tempDir, "project");
    await fs.promises.mkdir(projectDir, { recursive: true });

    const { getCapturedOptions } = mockQuery();

    const { ClaudeAcpAgent } = await import("../acp-agent.js");
    const agent: ClaudeAcpAgentType = new ClaudeAcpAgent(createMockClient());

    const response = await (agent as any).createSession({
      cwd: projectDir,
      mcpServers: [],
      _meta: { disableBuiltInTools: true },
    });

    expect(getCapturedOptions().permissionMode).toBe("dontAsk");
    expect(getCapturedOptions().settingSources).toEqual(["user", "project", "local"]);
    expect(response.modes.currentModeId).toBe("dontAsk");
  });

  it("supports acceptEdits mode defaults", async () => {
    await fs.promises.writeFile(
      path.join(tempDir, "settings.json"),
      JSON.stringify({
        permissions: {
          defaultMode: "acceptEdits",
        },
      }),
    );

    const projectDir = path.join(tempDir, "project");
    await fs.promises.mkdir(projectDir, { recursive: true });

    const { getCapturedOptions } = mockQuery();

    const { ClaudeAcpAgent } = await import("../acp-agent.js");
    const agent: ClaudeAcpAgentType = new ClaudeAcpAgent(createMockClient());

    const response = await (agent as any).createSession({
      cwd: projectDir,
      mcpServers: [],
      _meta: { disableBuiltInTools: true },
    });

    expect(getCapturedOptions().permissionMode).toBe("acceptEdits");
    expect(response.modes.currentModeId).toBe("acceptEdits");
  });

  it("defaults to 'default' when no permissions.defaultMode is set", async () => {
    const projectDir = path.join(tempDir, "project");
    await fs.promises.mkdir(projectDir, { recursive: true });

    const { getCapturedOptions } = mockQuery();

    const { ClaudeAcpAgent } = await import("../acp-agent.js");
    const agent: ClaudeAcpAgentType = new ClaudeAcpAgent(createMockClient());

    const response = await (agent as any).createSession({
      cwd: projectDir,
      mcpServers: [],
      _meta: { disableBuiltInTools: true },
    });

    expect(getCapturedOptions().permissionMode).toBe("default");
    expect(response.modes.currentModeId).toBe("default");
  });

  it("throws when permissions.defaultMode is not a string", async () => {
    await fs.promises.writeFile(
      path.join(tempDir, "settings.json"),
      JSON.stringify({
        permissions: {
          defaultMode: 123,
        },
      }),
    );

    const projectDir = path.join(tempDir, "project");
    await fs.promises.mkdir(projectDir, { recursive: true });

    mockQuery();

    const { ClaudeAcpAgent } = await import("../acp-agent.js");
    const agent: ClaudeAcpAgentType = new ClaudeAcpAgent(createMockClient());

    await expect(
      (agent as any).createSession({
        cwd: projectDir,
        mcpServers: [],
        _meta: { disableBuiltInTools: true },
      }),
    ).rejects.toThrow("Invalid permissions.defaultMode");
  });

  it("resolves model aliases like opus[1m] to the correct model", async () => {
    await fs.promises.writeFile(
      path.join(tempDir, "settings.json"),
      JSON.stringify({
        model: "opus[1m]",
      }),
    );

    const projectDir = path.join(tempDir, "project");
    await fs.promises.mkdir(projectDir, { recursive: true });

    const setModelSpy = vi.fn();
    querySpy.mockImplementation(({ options: _options }: any) => {
      return {
        initializationResult: async () => ({
          models: [
            {
              value: "claude-opus-4-6",
              displayName: "Claude Opus 4.6",
              description: "Base",
            },
            {
              value: "claude-opus-4-6-1m",
              displayName: "Claude Opus 4.6 (1M)",
              description: "Long context",
            },
          ],
        }),
        setModel: setModelSpy,
        supportedCommands: async () => [],
      } as any;
    });

    const { ClaudeAcpAgent } = await import("../acp-agent.js");
    const agent: ClaudeAcpAgentType = new ClaudeAcpAgent(createMockClient());

    const response = await (agent as any).createSession({
      cwd: projectDir,
      mcpServers: [],
      _meta: { disableBuiltInTools: true },
    });

    expect(setModelSpy).toHaveBeenCalledWith("claude-opus-4-6-1m");
    expect(response.models.currentModelId).toBe("claude-opus-4-6-1m");
  });

  it("filters visible models using availableModels", async () => {
    await fs.promises.writeFile(
      path.join(tempDir, "settings.json"),
      JSON.stringify({
        availableModels: ["claude-opus-4-6-1m"],
      }),
    );

    const projectDir = path.join(tempDir, "project");
    await fs.promises.mkdir(projectDir, { recursive: true });

    const setModelSpy = vi.fn();
    querySpy.mockImplementation(() => {
      return {
        initializationResult: async () => ({
          models: [
            {
              value: "claude-opus-4-6",
              displayName: "Claude Opus 4.6",
              description: "Base",
            },
            {
              value: "claude-opus-4-6-1m",
              displayName: "Claude Opus 4.6 (1M)",
              description: "Long context",
            },
          ],
        }),
        setModel: setModelSpy,
        supportedCommands: async () => [],
      } as any;
    });

    const { ClaudeAcpAgent } = await import("../acp-agent.js");
    const agent: ClaudeAcpAgentType = new ClaudeAcpAgent(createMockClient());

    const response = await (agent as any).createSession({
      cwd: projectDir,
      mcpServers: [],
      _meta: { disableBuiltInTools: true },
    });

    expect(setModelSpy).toHaveBeenCalledWith("claude-opus-4-6-1m");
    expect(response.models.availableModels).toEqual([
      {
        modelId: "claude-opus-4-6-1m",
        name: "Claude Opus 4.6 (1M)",
        description: "Long context",
      },
    ]);
    expect(response.models.currentModelId).toBe("claude-opus-4-6-1m");
  });

  it("falls back to the SDK model list when availableModels has no matches", async () => {
    await fs.promises.writeFile(
      path.join(tempDir, "settings.json"),
      JSON.stringify({
        availableModels: ["gpt-5.4"],
      }),
    );

    const projectDir = path.join(tempDir, "project");
    await fs.promises.mkdir(projectDir, { recursive: true });

    const setModelSpy = vi.fn();
    querySpy.mockImplementation(() => {
      return {
        initializationResult: async () => ({
          models: [
            {
              value: "claude-sonnet-4-5",
              displayName: "Claude Sonnet 4.5",
              description: "Default",
            },
            {
              value: "claude-opus-4-6",
              displayName: "Claude Opus 4.6",
              description: "Most capable",
            },
          ],
        }),
        setModel: setModelSpy,
        supportedCommands: async () => [],
      } as any;
    });

    const { ClaudeAcpAgent } = await import("../acp-agent.js");
    const agent: ClaudeAcpAgentType = new ClaudeAcpAgent(createMockClient());

    const response = await (agent as any).createSession({
      cwd: projectDir,
      mcpServers: [],
      _meta: { disableBuiltInTools: true },
    });

    expect(setModelSpy).toHaveBeenCalledWith("claude-sonnet-4-5");
    expect(response.models.availableModels).toEqual([
      {
        modelId: "claude-sonnet-4-5",
        name: "Claude Sonnet 4.5",
        description: "Default",
      },
      {
        modelId: "claude-opus-4-6",
        name: "Claude Opus 4.6",
        description: "Most capable",
      },
    ]);
    expect(response.models.currentModelId).toBe("claude-sonnet-4-5");
  });
});
