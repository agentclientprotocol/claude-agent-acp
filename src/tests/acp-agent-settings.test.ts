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
              value: "claude-sonnet-4-6",
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

  it("falls back to 'default' when permissions.defaultMode is invalid", async () => {
    await fs.promises.writeFile(
      path.join(tempDir, "settings.json"),
      JSON.stringify({
        permissions: {
          defaultMode: "not-a-real-mode",
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

    // Bad mode is ignored at the usage site; session creation must not throw.
    expect(getCapturedOptions().permissionMode).toBe("default");
    expect(response.modes.currentModeId).toBe("default");
  });

  it("ignores model from settings when it is not a string", async () => {
    await fs.promises.writeFile(
      path.join(tempDir, "settings.json"),
      JSON.stringify({
        model: 123,
      }),
    );

    const projectDir = path.join(tempDir, "project");
    await fs.promises.mkdir(projectDir, { recursive: true });

    const { setModelSpy } = mockQuery();

    const { ClaudeAcpAgent } = await import("../acp-agent.js");
    const agent: ClaudeAcpAgentType = new ClaudeAcpAgent(createMockClient());

    const response = await (agent as any).createSession({
      cwd: projectDir,
      mcpServers: [],
      _meta: { disableBuiltInTools: true },
    });

    // Bad model is ignored at the usage site; falls back to the first SDK model.
    expect(setModelSpy).toHaveBeenCalledWith("claude-sonnet-4-6");
    expect(response.models.currentModelId).toBe("claude-sonnet-4-6");
  });

  describe("auto mode availability per model", () => {
    function mockQueryWithModels(models: any[]): {
      getCapturedOptions: () => any;
      setModelSpy: ReturnType<typeof vi.fn>;
      setPermissionModeSpy: ReturnType<typeof vi.fn>;
    } {
      let capturedOptions: any;
      const setModelSpy = vi.fn();
      const setPermissionModeSpy = vi.fn();
      querySpy.mockImplementation(({ options }: any) => {
        capturedOptions = options;
        return {
          initializationResult: async () => ({ models }),
          setModel: setModelSpy,
          setPermissionMode: setPermissionModeSpy,
          supportedCommands: async () => [],
        } as any;
      });
      return {
        getCapturedOptions: () => capturedOptions,
        setModelSpy,
        setPermissionModeSpy,
      };
    }

    it("omits `auto` from availableModes when the resolved model lacks supportsAutoMode", async () => {
      const projectDir = path.join(tempDir, "project");
      await fs.promises.mkdir(projectDir, { recursive: true });

      mockQueryWithModels([
        {
          value: "claude-haiku-4-5",
          displayName: "Claude Haiku",
          description: "Fast",
          // supportsAutoMode intentionally omitted
        },
      ]);

      const { ClaudeAcpAgent } = await import("../acp-agent.js");
      const agent: ClaudeAcpAgentType = new ClaudeAcpAgent(createMockClient());

      const response = await (agent as any).createSession({
        cwd: projectDir,
        mcpServers: [],
        _meta: { disableBuiltInTools: true },
      });

      const modeIds: string[] = response.modes.availableModes.map((m: any) => m.id);
      expect(modeIds).not.toContain("auto");
      expect(modeIds).toEqual(
        expect.arrayContaining(["default", "acceptEdits", "plan", "dontAsk"]),
      );
    });

    it("includes `auto` when the resolved model has supportsAutoMode: true", async () => {
      const projectDir = path.join(tempDir, "project");
      await fs.promises.mkdir(projectDir, { recursive: true });

      mockQueryWithModels([
        {
          value: "claude-opus-4-5",
          displayName: "Claude Opus",
          description: "Most capable",
          supportsAutoMode: true,
        },
      ]);

      const { ClaudeAcpAgent } = await import("../acp-agent.js");
      const agent: ClaudeAcpAgentType = new ClaudeAcpAgent(createMockClient());

      const response = await (agent as any).createSession({
        cwd: projectDir,
        mcpServers: [],
        _meta: { disableBuiltInTools: true },
      });

      const modeIds: string[] = response.modes.availableModes.map((m: any) => m.id);
      expect(modeIds).toContain("auto");
    });

    it("clamps permissions.defaultMode='auto' to 'default' on a model that lacks supportsAutoMode", async () => {
      await fs.promises.writeFile(
        path.join(tempDir, "settings.json"),
        JSON.stringify({ permissions: { defaultMode: "auto" } }),
      );

      const projectDir = path.join(tempDir, "project");
      await fs.promises.mkdir(projectDir, { recursive: true });

      const { getCapturedOptions, setPermissionModeSpy } = mockQueryWithModels([
        {
          value: "claude-haiku-4-5",
          displayName: "Claude Haiku",
          description: "Fast",
          // supportsAutoMode intentionally omitted
        },
      ]);

      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      try {
        const { ClaudeAcpAgent } = await import("../acp-agent.js");
        const agent: ClaudeAcpAgentType = new ClaudeAcpAgent(createMockClient());

        const response = await (agent as any).createSession({
          cwd: projectDir,
          mcpServers: [],
          _meta: { disableBuiltInTools: true },
        });

        // Options.permissionMode is built before init resolves, so it still
        // carries the user-typed value; the SDK was synced via
        // setPermissionMode after we discovered the model can't honor it.
        expect(getCapturedOptions().permissionMode).toBe("auto");
        expect(setPermissionModeSpy).toHaveBeenCalledWith("default");
        expect(response.modes.currentModeId).toBe("default");
        expect(response.modes.availableModes.map((m: any) => m.id)).not.toContain("auto");

        // A descriptive warning was logged so operators see the clamp.
        const messages = errorSpy.mock.calls.map((c) => c.join(" "));
        expect(messages.some((m) => m.includes("auto") && m.includes("claude-haiku-4-5"))).toBe(
          true,
        );
      } finally {
        errorSpy.mockRestore();
      }
    });

    it("does not clamp permissions.defaultMode='auto' on a model that supports auto", async () => {
      await fs.promises.writeFile(
        path.join(tempDir, "settings.json"),
        JSON.stringify({ permissions: { defaultMode: "auto" } }),
      );

      const projectDir = path.join(tempDir, "project");
      await fs.promises.mkdir(projectDir, { recursive: true });

      const { getCapturedOptions, setPermissionModeSpy } = mockQueryWithModels([
        {
          value: "claude-opus-4-5",
          displayName: "Claude Opus",
          description: "Most capable",
          supportsAutoMode: true,
        },
      ]);

      const { ClaudeAcpAgent } = await import("../acp-agent.js");
      const agent: ClaudeAcpAgentType = new ClaudeAcpAgent(createMockClient());

      const response = await (agent as any).createSession({
        cwd: projectDir,
        mcpServers: [],
        _meta: { disableBuiltInTools: true },
      });

      expect(getCapturedOptions().permissionMode).toBe("auto");
      expect(setPermissionModeSpy).not.toHaveBeenCalled();
      expect(response.modes.currentModeId).toBe("auto");
    });
  });

  describe("availableModels allowlist from settings", () => {
    function mockQueryWithModels(models: any[]): {
      setModelSpy: ReturnType<typeof vi.fn>;
    } {
      const setModelSpy = vi.fn();
      querySpy.mockImplementation(() => {
        return {
          initializationResult: async () => ({ models }),
          setModel: setModelSpy,
          supportedCommands: async () => [],
        } as any;
      });
      return { setModelSpy };
    }

    it("restricts configOptions to the user's allowlist using their exact IDs", async () => {
      // Reproduces the scenario from
      // https://github.com/agentclientprotocol/claude-agent-acp/issues/620:
      // user lists `claude-haiku-4-5` (no date pin) in availableModels, but
      // the SDK still surfaces its `haiku` alias which resolves to a
      // date-pinned variant the user doesn't have access to.
      await fs.promises.writeFile(
        path.join(tempDir, "settings.json"),
        JSON.stringify({
          availableModels: [
            "claude-sonnet-4-6[1m]",
            "claude-opus-4-6[1m]",
            "claude-haiku-4-5",
            "claude-opus-4-7[1m]",
          ],
        }),
      );

      const projectDir = path.join(tempDir, "project");
      await fs.promises.mkdir(projectDir, { recursive: true });

      mockQueryWithModels([
        { value: "default", displayName: "Default", description: "Default model" },
        {
          value: "sonnet[1m]",
          displayName: "Sonnet (1M context)",
          description: "Sonnet 4.6 long context",
        },
        {
          value: "opus[1m]",
          displayName: "Opus (1M context)",
          description: "Opus 1M context",
        },
        { value: "haiku", displayName: "Haiku", description: "Fast" },
      ]);

      const { ClaudeAcpAgent } = await import("../acp-agent.js");
      const agent: ClaudeAcpAgentType = new ClaudeAcpAgent(createMockClient());

      const response = await (agent as any).createSession({
        cwd: projectDir,
        mcpServers: [],
        _meta: { disableBuiltInTools: true },
      });

      const modelOption = response.configOptions.find((o: any) => o.id === "model");
      expect(modelOption.options.map((o: any) => o.value)).toEqual([
        "default",
        "claude-sonnet-4-6[1m]",
        "claude-opus-4-6[1m]",
        "claude-haiku-4-5",
        "claude-opus-4-7[1m]",
      ]);
    });

    it("unions availableModels across user and project settings", async () => {
      // https://code.claude.com/docs/en/model-config#merge-behavior
      await fs.promises.writeFile(
        path.join(tempDir, "settings.json"),
        JSON.stringify({ availableModels: ["claude-haiku-4-5"] }),
      );

      const projectDir = path.join(tempDir, "project");
      await fs.promises.mkdir(path.join(projectDir, ".claude"), { recursive: true });
      await fs.promises.writeFile(
        path.join(projectDir, ".claude", "settings.json"),
        JSON.stringify({
          availableModels: ["claude-haiku-4-5", "claude-opus-4-7[1m]"],
        }),
      );

      mockQueryWithModels([
        { value: "default", displayName: "Default", description: "Default model" },
        { value: "haiku", displayName: "Haiku", description: "Fast" },
      ]);

      const { ClaudeAcpAgent } = await import("../acp-agent.js");
      const agent: ClaudeAcpAgentType = new ClaudeAcpAgent(createMockClient());

      const response = await (agent as any).createSession({
        cwd: projectDir,
        mcpServers: [],
        _meta: { disableBuiltInTools: true },
      });

      const modelOption = response.configOptions.find((o: any) => o.id === "model");
      // User and project entries are unioned and deduplicated.
      expect(modelOption.options.map((o: any) => o.value)).toEqual([
        "default",
        "claude-haiku-4-5",
        "claude-opus-4-7[1m]",
      ]);
    });

    it("returns only the default entry when availableModels is an empty array", async () => {
      await fs.promises.writeFile(
        path.join(tempDir, "settings.json"),
        JSON.stringify({ availableModels: [] }),
      );

      const projectDir = path.join(tempDir, "project");
      await fs.promises.mkdir(projectDir, { recursive: true });

      mockQueryWithModels([
        { value: "default", displayName: "Default", description: "Default model" },
        { value: "haiku", displayName: "Haiku", description: "Fast" },
      ]);

      const { ClaudeAcpAgent } = await import("../acp-agent.js");
      const agent: ClaudeAcpAgentType = new ClaudeAcpAgent(createMockClient());

      const response = await (agent as any).createSession({
        cwd: projectDir,
        mcpServers: [],
        _meta: { disableBuiltInTools: true },
      });

      const modelOption = response.configOptions.find((o: any) => o.id === "model");
      expect(modelOption.options.map((o: any) => o.value)).toEqual(["default"]);
    });

    it("does not filter when availableModels is absent from settings", async () => {
      const projectDir = path.join(tempDir, "project");
      await fs.promises.mkdir(projectDir, { recursive: true });

      mockQueryWithModels([
        { value: "default", displayName: "Default", description: "Default model" },
        { value: "haiku", displayName: "Haiku", description: "Fast" },
      ]);

      const { ClaudeAcpAgent } = await import("../acp-agent.js");
      const agent: ClaudeAcpAgentType = new ClaudeAcpAgent(createMockClient());

      const response = await (agent as any).createSession({
        cwd: projectDir,
        mcpServers: [],
        _meta: { disableBuiltInTools: true },
      });

      const modelOption = response.configOptions.find((o: any) => o.id === "model");
      expect(modelOption.options.map((o: any) => o.value)).toEqual(["default", "haiku"]);
    });

    it("passes the user's exact ID to setModel when it matches an SDK alias", async () => {
      // Without the allowlist, the SDK would resolve `haiku` to a
      // date-pinned variant. Forcing setModel to receive `claude-haiku-4-5`
      // is exactly what the issue's workaround
      // (`ANTHROPIC_DEFAULT_HAIKU_MODEL`) achieves manually.
      await fs.promises.writeFile(
        path.join(tempDir, "settings.json"),
        JSON.stringify({
          availableModels: ["claude-haiku-4-5"],
          model: "claude-haiku-4-5",
        }),
      );

      const projectDir = path.join(tempDir, "project");
      await fs.promises.mkdir(projectDir, { recursive: true });

      const { setModelSpy } = mockQueryWithModels([
        { value: "default", displayName: "Default", description: "Default model" },
        { value: "haiku", displayName: "Haiku", description: "Fast" },
      ]);

      const { ClaudeAcpAgent } = await import("../acp-agent.js");
      const agent: ClaudeAcpAgentType = new ClaudeAcpAgent(createMockClient());

      const response = await (agent as any).createSession({
        cwd: projectDir,
        mcpServers: [],
        _meta: { disableBuiltInTools: true },
      });

      expect(setModelSpy).toHaveBeenCalledWith("claude-haiku-4-5");
      expect(response.models.currentModelId).toBe("claude-haiku-4-5");
    });
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
});
