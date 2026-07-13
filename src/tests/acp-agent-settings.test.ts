import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { AcpClient, ClaudeAcpAgent as ClaudeAcpAgentType } from "../acp-agent.js";
import { makeMockQuery } from "./helpers.js";

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

  function createMockClient(): AcpClient {
    return {
      sessionUpdate: async () => {},
      requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
      readTextFile: async () => ({ content: "" }),
      writeTextFile: async () => ({}),
    } as unknown as AcpClient;
  }

  function mockQuery() {
    let capturedOptions: any;
    const setModelSpy = vi.fn();
    querySpy.mockImplementation(({ options }: any) => {
      capturedOptions = options;
      return makeMockQuery({
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
      }) as any;
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

  it("drops escalating defaultMode when it comes from project-tier settings", async () => {
    // bypassPermissions in .claude/settings.json (a repo-committed tier) is
    // filtered by the SDK's trust policy and clamps to 'default'.
    const projectDir = path.join(tempDir, "project");
    await fs.promises.mkdir(path.join(projectDir, ".claude"), { recursive: true });
    await fs.promises.writeFile(
      path.join(projectDir, ".claude", "settings.json"),
      JSON.stringify({ permissions: { defaultMode: "bypassPermissions" } }),
    );

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
    // No setModel call is needed because no override was applied — the SDK is
    // already on its own default.
    expect(setModelSpy).not.toHaveBeenCalled();
    expect(response.configOptions?.find((o: any) => o.id === "model")?.currentValue).toBe(
      "claude-sonnet-4-6",
    );
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
        return makeMockQuery({
          initializationResult: async () => ({ models }),
          setModel: setModelSpy,
          setPermissionMode: setPermissionModeSpy,
        }) as any;
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
        return makeMockQuery({
          initializationResult: async () => ({ models }),
          setModel: setModelSpy,
        }) as any;
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
      expect(response.configOptions?.find((o: any) => o.id === "model")?.currentValue).toBe(
        "claude-haiku-4-5",
      );
    });

    it("does not inherit display info across mismatched model versions", async () => {
      // https://github.com/agentclientprotocol/claude-agent-acp/issues/639:
      // when the SDK's `opus` alias resolves to Opus 4.7, an allowlist entry
      // of `claude-opus-4-6` (or `claude-opus-4-6[1m]`) used to substring-match
      // `opus` and inherit the "Opus 4.7" display info. With version-aware
      // matching, these entries fall back to showing their literal ID rather
      // than a misleading newer name.
      await fs.promises.writeFile(
        path.join(tempDir, "settings.json"),
        JSON.stringify({
          availableModels: [
            "claude-opus-4-6",
            "claude-opus-4-6[1m]",
            "claude-opus-4-7",
            "claude-opus-4-7[1m]",
          ],
        }),
      );

      const projectDir = path.join(tempDir, "project");
      await fs.promises.mkdir(projectDir, { recursive: true });

      mockQueryWithModels([
        { value: "default", displayName: "Default", description: "Default model" },
        {
          value: "opus",
          displayName: "Opus 4.7",
          description: "Claude Opus 4.7 — complex tasks, higher cost",
        },
        {
          value: "opus[1m]",
          displayName: "Opus 4.7 (1M context)",
          description: "Opus 4.7 with 1M context",
        },
      ]);

      const { ClaudeAcpAgent } = await import("../acp-agent.js");
      const agent: ClaudeAcpAgentType = new ClaudeAcpAgent(createMockClient());

      const response = await (agent as any).createSession({
        cwd: projectDir,
        mcpServers: [],
        _meta: { disableBuiltInTools: true },
      });

      const modelOption = response.configOptions.find((o: any) => o.id === "model");
      const byValue: Record<string, { name: string; description?: string }> = {};
      for (const opt of modelOption.options) {
        byValue[opt.value] = { name: opt.name, description: opt.description };
      }

      // 4-6 entries must NOT inherit the 4.7 SDK alias display info.
      expect(byValue["claude-opus-4-6"].name).toBe("claude-opus-4-6");
      expect(byValue["claude-opus-4-6"].description).toBe("");
      expect(byValue["claude-opus-4-6[1m]"].name).toBe("claude-opus-4-6[1m]");
      expect(byValue["claude-opus-4-6[1m]"].description).toBe("");

      // 4-7 entries continue to inherit display info from a 4.7 SDK alias.
      expect(byValue["claude-opus-4-7"].name).toBe("Opus 4.7");
      expect(byValue["claude-opus-4-7[1m]"].name).toMatch(/Opus 4\.7/);
    });

    it("does not inherit display info across mismatched model families", async () => {
      // https://github.com/agentclientprotocol/claude-agent-acp/issues/639:
      // when the SDK's `opus` alias resolves to Opus 4.8, `claude-opus-4-6[1m]`
      // fails the version check against `opus` but the tokenized matcher
      // falls through to `sonnet[1m]` because the `1m` context hint alone
      // is enough to score a match.
      await fs.promises.writeFile(
        path.join(tempDir, "settings.json"),
        JSON.stringify({
          availableModels: ["claude-opus-4-6", "claude-opus-4-6[1m]"],
        }),
      );

      const projectDir = path.join(tempDir, "project");
      await fs.promises.mkdir(projectDir, { recursive: true });

      mockQueryWithModels([
        { value: "default", displayName: "Default", description: "Default model" },
        {
          value: "sonnet",
          displayName: "Sonnet",
          description: "Sonnet 4.6 · Best for everyday tasks",
        },
        {
          value: "sonnet[1m]",
          displayName: "Sonnet (1M context)",
          description: "Sonnet 4.6 for long sessions",
        },
        {
          value: "opus",
          displayName: "Opus 4.8",
          description: "Claude Opus 4.8",
        },
      ]);

      const { ClaudeAcpAgent } = await import("../acp-agent.js");
      const agent: ClaudeAcpAgentType = new ClaudeAcpAgent(createMockClient());

      const response = await (agent as any).createSession({
        cwd: projectDir,
        mcpServers: [],
        _meta: { disableBuiltInTools: true },
      });

      const modelOption = response.configOptions.find((o: any) => o.id === "model");
      const byValue: Record<string, { name: string; description?: string }> = {};
      for (const opt of modelOption.options) {
        byValue[opt.value] = { name: opt.name, description: opt.description };
      }

      expect(byValue["claude-opus-4-6[1m]"].name).toBe("claude-opus-4-6[1m]");
      expect(byValue["claude-opus-4-6"].name).toBe("claude-opus-4-6");
    });

    it("preserves ANTHROPIC_CUSTOM_MODEL_OPTION even when absent from the allowlist", async () => {
      // Per the model-config docs, ANTHROPIC_CUSTOM_MODEL_OPTION adds an entry
      // "without replacing the built-in aliases" and "appears at the bottom of
      // the /model picker", so it is exempt from the availableModels allowlist
      // (the same way the Default option is "not affected by availableModels").
      // ACP must match: a slim alias allowlist must not hide the custom model
      // row, and it appears last, after the allowlisted entries.
      // https://code.claude.com/docs/en/model-config#add-a-custom-model-option
      const originalEnv = process.env.ANTHROPIC_CUSTOM_MODEL_OPTION;
      process.env.ANTHROPIC_CUSTOM_MODEL_OPTION = "claude-opus-4-8[1m]";
      try {
        await fs.promises.writeFile(
          path.join(tempDir, "settings.json"),
          JSON.stringify({
            availableModels: ["sonnet", "opus", "haiku"],
          }),
        );

        const projectDir = path.join(tempDir, "project");
        await fs.promises.mkdir(projectDir, { recursive: true });

        mockQueryWithModels([
          { value: "default", displayName: "Default", description: "Default model" },
          { value: "sonnet", displayName: "Sonnet", description: "Claude Sonnet 4.6" },
          { value: "opus", displayName: "Opus", description: "Claude Opus 4.6" },
          { value: "haiku", displayName: "Haiku", description: "Claude Haiku 4.5" },
          {
            value: "claude-opus-4-8[1m]",
            displayName: "Opus 4.8",
            description: "Claude Opus 4.8",
          },
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
          "sonnet",
          "opus",
          "haiku",
          "claude-opus-4-8[1m]",
        ]);
        const custom = modelOption.options.find((o: any) => o.value === "claude-opus-4-8[1m]");
        expect(custom.name).toBe("Opus 4.8");
        expect(custom.description).toBe("Claude Opus 4.8");
      } finally {
        if (originalEnv === undefined) {
          delete process.env.ANTHROPIC_CUSTOM_MODEL_OPTION;
        } else {
          process.env.ANTHROPIC_CUSTOM_MODEL_OPTION = originalEnv;
        }
      }
    });

    it("does not duplicate the custom model option when also in the allowlist", async () => {
      // If the user lists the custom model's exact ID in availableModels AND it
      // is set as ANTHROPIC_CUSTOM_MODEL_OPTION, it must appear exactly once.
      const originalEnv = process.env.ANTHROPIC_CUSTOM_MODEL_OPTION;
      process.env.ANTHROPIC_CUSTOM_MODEL_OPTION = "claude-opus-4-8[1m]";
      try {
        await fs.promises.writeFile(
          path.join(tempDir, "settings.json"),
          JSON.stringify({
            availableModels: ["sonnet", "claude-opus-4-8[1m]"],
          }),
        );

        const projectDir = path.join(tempDir, "project");
        await fs.promises.mkdir(projectDir, { recursive: true });

        mockQueryWithModels([
          { value: "default", displayName: "Default", description: "Default model" },
          { value: "sonnet", displayName: "Sonnet", description: "Claude Sonnet 4.6" },
          {
            value: "claude-opus-4-8[1m]",
            displayName: "Opus 4.8",
            description: "Claude Opus 4.8",
          },
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
          "sonnet",
          "claude-opus-4-8[1m]",
        ]);
      } finally {
        if (originalEnv === undefined) {
          delete process.env.ANTHROPIC_CUSTOM_MODEL_OPTION;
        } else {
          process.env.ANTHROPIC_CUSTOM_MODEL_OPTION = originalEnv;
        }
      }
    });

    it("maps allowlist aliases through modelOverrides to provider IDs", async () => {
      // Bedrock/Vertex deployments enforce short aliases in availableModels
      // but require provider-specific IDs at the API. Without applying
      // modelOverrides during allowlist resolution, the alias is surfaced as
      // the model value and passed verbatim to setModel, which the provider
      // API rejects with a 400 "invalid model identifier".
      await fs.promises.writeFile(
        path.join(tempDir, "settings.json"),
        JSON.stringify({
          availableModels: ["claude-opus-4-6", "claude-sonnet-4-6"],
          model: "claude-opus-4-6",
          modelOverrides: {
            "claude-opus-4-6": "global.anthropic.claude-opus-4-6-v1[1m]",
            "claude-sonnet-4-6": "global.anthropic.claude-sonnet-4-6[1m]",
          },
        }),
      );

      const projectDir = path.join(tempDir, "project");
      await fs.promises.mkdir(projectDir, { recursive: true });

      const { setModelSpy } = mockQueryWithModels([
        { value: "default", displayName: "Default", description: "Default model" },
        { value: "opus", displayName: "Opus", description: "Claude Opus 4.6" },
        { value: "sonnet", displayName: "Sonnet", description: "Claude Sonnet 4.6" },
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
        "global.anthropic.claude-opus-4-6-v1[1m]",
        "global.anthropic.claude-sonnet-4-6[1m]",
      ]);
      // The allowlist synthesized the overridden ID (the SDK only surfaced the
      // `opus` alias), so the adapter syncs the provider ID via setModel — never
      // the raw alias that Bedrock would reject.
      expect(setModelSpy).toHaveBeenCalledWith("global.anthropic.claude-opus-4-6-v1[1m]");
      expect(modelOption.currentValue).toBe("global.anthropic.claude-opus-4-6-v1[1m]");
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
      return makeMockQuery({
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
      }) as any;
    });

    const { ClaudeAcpAgent } = await import("../acp-agent.js");
    const agent: ClaudeAcpAgentType = new ClaudeAcpAgent(createMockClient());

    const response = await (agent as any).createSession({
      cwd: projectDir,
      mcpServers: [],
      _meta: { disableBuiltInTools: true },
    });

    expect(setModelSpy).toHaveBeenCalledWith("claude-opus-4-6-1m");
    expect(response.configOptions?.find((o: any) => o.id === "model")?.currentValue).toBe(
      "claude-opus-4-6-1m",
    );
  });

  it("skips the initial setModel when the resolved value matches the SDK's model list verbatim", async () => {
    // Covers the launcher case from PR #646: the launcher bakes the model into
    // ANTHROPIC_MODEL, the SDK already starts on that model, and a second
    // setModel call would be a redundant round-trip (and on some launcher
    // setups, more fragile than launch-time selection).
    const originalEnv = process.env.ANTHROPIC_MODEL;
    process.env.ANTHROPIC_MODEL = "claude-opus-4-6";

    const projectDir = path.join(tempDir, "project");
    await fs.promises.mkdir(projectDir, { recursive: true });

    const setModelSpy = vi.fn();
    querySpy.mockImplementation(() => {
      return makeMockQuery({
        initializationResult: async () => ({
          models: [
            { value: "default", displayName: "Default", description: "" },
            { value: "claude-sonnet-4-6", displayName: "Claude Sonnet 4.6", description: "" },
            { value: "claude-opus-4-6", displayName: "Claude Opus 4.6", description: "" },
          ],
        }),
        setModel: setModelSpy,
      }) as any;
    });

    try {
      const { ClaudeAcpAgent } = await import("../acp-agent.js");
      const agent: ClaudeAcpAgentType = new ClaudeAcpAgent(createMockClient());

      const response = await (agent as any).createSession({
        cwd: projectDir,
        mcpServers: [],
        _meta: { disableBuiltInTools: true },
      });

      expect(setModelSpy).not.toHaveBeenCalled();
      expect(response.configOptions?.find((o: any) => o.id === "model")?.currentValue).toBe(
        "claude-opus-4-6",
      );
    } finally {
      if (originalEnv === undefined) {
        delete process.env.ANTHROPIC_MODEL;
      } else {
        process.env.ANTHROPIC_MODEL = originalEnv;
      }
    }
  });

  it("still calls setModel when the allowlist synthesizes a value the SDK has not surfaced", async () => {
    // The allowlist may rewrite a model's `value` to the user's literal ID
    // (e.g., `claude-haiku-4-5`) even when the SDK only exposed an alias
    // (`haiku`). In that case the SDK has not independently arrived at the
    // user's preferred ID, so we must sync via setModel.
    await fs.promises.writeFile(
      path.join(tempDir, "settings.json"),
      JSON.stringify({
        availableModels: ["claude-haiku-4-5"],
        model: "claude-haiku-4-5",
      }),
    );

    const projectDir = path.join(tempDir, "project");
    await fs.promises.mkdir(projectDir, { recursive: true });

    const setModelSpy = vi.fn();
    querySpy.mockImplementation(() => {
      return makeMockQuery({
        initializationResult: async () => ({
          models: [
            { value: "default", displayName: "Default", description: "" },
            { value: "haiku", displayName: "Haiku", description: "Fast" },
          ],
        }),
        setModel: setModelSpy,
      }) as any;
    });

    const { ClaudeAcpAgent } = await import("../acp-agent.js");
    const agent: ClaudeAcpAgentType = new ClaudeAcpAgent(createMockClient());

    const response = await (agent as any).createSession({
      cwd: projectDir,
      mcpServers: [],
      _meta: { disableBuiltInTools: true },
    });

    expect(setModelSpy).toHaveBeenCalledWith("claude-haiku-4-5");
    expect(response.configOptions?.find((o: any) => o.id === "model")?.currentValue).toBe(
      "claude-haiku-4-5",
    );
  });
});
