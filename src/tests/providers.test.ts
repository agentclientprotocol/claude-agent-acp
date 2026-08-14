import { describe, expect, it, Mock, vi, afterEach, beforeEach } from "vitest";
import { AcpClient, ClaudeAcpAgent } from "../acp-agent.js";

const mockQuery = vi.hoisted(() =>
  vi.fn(() => ({
    initializationResult: vi.fn().mockResolvedValue({
      models: [
        { value: "id", displayName: "name", description: "description", supportsAutoMode: true },
      ],
    }),
    setModel: vi.fn(),
    setPermissionMode: vi.fn(),
    supportedCommands: vi.fn().mockResolvedValue([]),
    close: vi.fn(),
    interrupt: vi.fn().mockResolvedValue(undefined),
    getContextUsage: vi.fn().mockResolvedValue({ totalTokens: 0, rawMaxTokens: 200000 }),
    [Symbol.asyncIterator]: async function* () {},
  })),
);

vi.mock("@anthropic-ai/claude-agent-sdk", async () => ({
  ...(await vi.importActual<typeof import("@anthropic-ai/claude-agent-sdk")>(
    "@anthropic-ai/claude-agent-sdk",
  )),
  query: mockQuery,
}));

// `logout` shells out to `claude auth logout`; make execFile succeed so the
// real logout body runs (and clears provider config) without a live CLI.
vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    execFile: vi.fn((_file: string, _args: string[], cb: (...a: unknown[]) => void) =>
      cb(null, { stdout: "", stderr: "" }),
    ),
  };
});

describe("providers", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.runAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.resetAllMocks();
  });

  async function createAgentMock(): Promise<[ClaudeAcpAgent, Mock]> {
    const connectionMock = {
      sessionUpdate: async (_: any) => {},
    } as AcpClient;
    const agent = new ClaudeAcpAgent(connectionMock);
    return [agent, mockQuery];
  }

  it("advertises the providers capability in initialize", async () => {
    const [agent] = await createAgentMock();
    const response = await agent.initialize({ protocolVersion: 1, clientCapabilities: {} });
    expect(response.agentCapabilities?.providers).toEqual({});
  });

  it("lists one mutually exclusive provider slot with native routing", async () => {
    const [agent] = await createAgentMock();
    const response = await agent.unstable_listProviders({});
    expect(response.providers).toEqual([
      {
        providerId: "main",
        supported: ["anthropic", "bedrock", "vertex"],
        required: false,
        current: { apiType: "anthropic", baseUrl: "https://api.anthropic.com" },
      },
    ]);
  });

  it("reflects apiType/baseUrl after set, and never echoes headers", async () => {
    const [agent] = await createAgentMock();
    await agent.unstable_setProvider({
      providerId: "main",
      apiType: "anthropic",
      baseUrl: "https://gateway.example/v1",
      headers: { authorization: "Bearer secret" },
    });

    const response = await agent.unstable_listProviders({});
    expect(response.providers[0].current).toEqual({
      apiType: "anthropic",
      baseUrl: "https://gateway.example/v1",
    });
    // headers must not leak through list
    expect(JSON.stringify(response.providers)).not.toContain("secret");
  });

  it("rejects set for an unknown providerId", async () => {
    const [agent] = await createAgentMock();
    await expect(
      agent.unstable_setProvider({
        providerId: "openai",
        apiType: "anthropic",
        baseUrl: "https://gateway.example",
      }),
    ).rejects.toMatchObject({ code: -32602 });
  });

  it("rejects set for an unsupported apiType", async () => {
    const [agent] = await createAgentMock();
    await expect(
      agent.unstable_setProvider({
        providerId: "main",
        apiType: "openai",
        baseUrl: "https://gateway.example",
      }),
    ).rejects.toMatchObject({ code: -32602 });
  });

  it("rejects set for an empty or non-http baseUrl", async () => {
    const [agent] = await createAgentMock();
    await expect(
      agent.unstable_setProvider({ providerId: "main", apiType: "anthropic", baseUrl: "" }),
    ).rejects.toMatchObject({ code: -32602 });
    await expect(
      agent.unstable_setProvider({
        providerId: "main",
        apiType: "anthropic",
        baseUrl: "ftp://nope.example",
      }),
    ).rejects.toMatchObject({ code: -32602 });
  });

  it("restores native routing after the last override is disabled", async () => {
    const [agent] = await createAgentMock();
    await agent.unstable_setProvider({
      providerId: "main",
      apiType: "anthropic",
      baseUrl: "https://gateway.example/v1",
    });
    expect((await agent.unstable_listProviders({})).providers[0].current).not.toBeNull();

    await expect(agent.unstable_disableProvider({ providerId: "main" })).resolves.toEqual({});

    expect((await agent.unstable_listProviders({})).providers[0].current).toEqual({
      apiType: "anthropic",
      baseUrl: "https://api.anthropic.com",
    });
  });

  it("replaces the active api type when the single slot is set again", async () => {
    const [agent] = await createAgentMock();
    await agent.unstable_setProvider({
      providerId: "main",
      apiType: "anthropic",
      baseUrl: "https://anthropic.example",
    });
    await agent.unstable_setProvider({
      providerId: "main",
      apiType: "bedrock",
      baseUrl: "https://bedrock.example",
    });

    const overridden = await agent.unstable_listProviders({});
    expect(overridden.providers[0].current).toEqual({
      apiType: "bedrock",
      baseUrl: "https://bedrock.example",
    });

    await agent.unstable_disableProvider({ providerId: "main" });
    expect((await agent.unstable_listProviders({})).providers[0].current).toEqual({
      apiType: "anthropic",
      baseUrl: "https://api.anthropic.com",
    });
  });

  it("treats disabling an unknown provider as an idempotent no-op", async () => {
    const [agent] = await createAgentMock();
    await expect(agent.unstable_disableProvider({ providerId: "openai" })).resolves.toEqual({});
  });

  it("routes anthropic provider config into session env", async () => {
    const [agent, mockQuery] = await createAgentMock();
    await agent.initialize({ protocolVersion: 1, clientCapabilities: {} });
    await agent.unstable_setProvider({
      providerId: "main",
      apiType: "anthropic",
      baseUrl: "https://gateway.example",
      headers: { "x-api-key": "test" },
    });

    await agent.newSession({ cwd: process.cwd(), mcpServers: [] });

    expect(mockQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({
          env: expect.objectContaining({
            ANTHROPIC_AUTH_TOKEN: "acp-proxy",
            ANTHROPIC_BASE_URL: "https://gateway.example",
            ANTHROPIC_CUSTOM_HEADERS: "x-api-key: test",
          }),
        }),
      }),
    );
  });

  it("keeps native session creation unchanged when the providers API is unused", async () => {
    const [agent, mockQuery] = await createAgentMock();
    await agent.initialize({ protocolVersion: 1, clientCapabilities: {} });

    await agent.newSession({ cwd: process.cwd(), mcpServers: [] });

    expect(mockQuery).toHaveBeenCalledOnce();
    expect(mockQuery.mock.calls[0][0].options.resume).toBeUndefined();
    expect(mockQuery.mock.results[0].value.close).not.toHaveBeenCalled();
  });

  it("recreates loaded sessions with the new provider between turns", async () => {
    const [agent, mockQuery] = await createAgentMock();
    await agent.initialize({ protocolVersion: 1, clientCapabilities: {} });
    const first = await agent.newSession({ cwd: process.cwd(), mcpServers: [] });
    const originalQuery = mockQuery.mock.results[0].value;

    await agent.unstable_setProvider({
      providerId: "main",
      apiType: "anthropic",
      baseUrl: "https://gateway.example",
    });

    expect(originalQuery.close).toHaveBeenCalledOnce();
    expect(mockQuery).toHaveBeenCalledTimes(2);
    expect(mockQuery.mock.calls[1][0]).toEqual(
      expect.objectContaining({
        options: expect.objectContaining({
          resume: first.sessionId,
          env: expect.objectContaining({ ANTHROPIC_BASE_URL: "https://gateway.example" }),
          settings: expect.objectContaining({
            apiKeyHelper: "",
            env: expect.objectContaining({
              ANTHROPIC_BASE_URL: "https://gateway.example",
              ANTHROPIC_AUTH_TOKEN: "acp-proxy",
              CLAUDE_CODE_OAUTH_TOKEN: "",
            }),
          }),
        }),
      }),
    );

    await agent.unstable_disableProvider({ providerId: "main" });

    expect(mockQuery).toHaveBeenCalledTimes(3);
    expect(mockQuery.mock.calls[2][0]).toEqual(
      expect.objectContaining({
        options: expect.objectContaining({ resume: first.sessionId }),
      }),
    );
    expect(mockQuery.mock.calls[2][0].options.env.ANTHROPIC_BASE_URL).toBe(
      process.env.ANTHROPIC_BASE_URL,
    );
  });

  it("switches every loaded session through proxy replacements and back to native routing", async () => {
    const [agent, mockQuery] = await createAgentMock();
    await agent.initialize({ protocolVersion: 1, clientCapabilities: {} });
    const first = await agent.newSession({ cwd: process.cwd(), mcpServers: [] });
    const second = await agent.newSession({ cwd: process.cwd(), mcpServers: [] });

    await agent.unstable_setProvider({
      providerId: "main",
      apiType: "anthropic",
      baseUrl: "https://first-gateway.example",
    });
    await agent.unstable_setProvider({
      providerId: "main",
      apiType: "anthropic",
      baseUrl: "https://second-gateway.example",
    });
    await agent.unstable_disableProvider({ providerId: "main" });

    expect(mockQuery).toHaveBeenCalledTimes(8);
    const resumedCalls = mockQuery.mock.calls.slice(2);
    for (let update = 0; update < 3; update += 1) {
      expect(
        resumedCalls.slice(update * 2, update * 2 + 2).map(([request]) => request.options.resume),
      ).toEqual([first.sessionId, second.sessionId]);
    }
    expect(
      resumedCalls.slice(0, 2).map(([request]) => request.options.env.ANTHROPIC_BASE_URL),
    ).toEqual(["https://first-gateway.example", "https://first-gateway.example"]);
    expect(
      resumedCalls.slice(2, 4).map(([request]) => request.options.env.ANTHROPIC_BASE_URL),
    ).toEqual(["https://second-gateway.example", "https://second-gateway.example"]);
    expect(
      resumedCalls.slice(4).map(([request]) => request.options.env.ANTHROPIC_BASE_URL),
    ).toEqual([process.env.ANTHROPIC_BASE_URL, process.env.ANTHROPIC_BASE_URL]);
    for (const result of mockQuery.mock.results.slice(0, 6)) {
      expect(result.value.close).toHaveBeenCalledOnce();
    }
    for (const result of mockQuery.mock.results.slice(6)) {
      expect(result.value.close).not.toHaveBeenCalled();
    }
  });

  it("overrides user routing settings while preserving unrelated settings", async () => {
    const [agent, mockQuery] = await createAgentMock();
    await agent.initialize({ protocolVersion: 1, clientCapabilities: {} });
    await agent.unstable_setProvider({
      providerId: "main",
      apiType: "anthropic",
      baseUrl: "https://gateway.example",
    });

    await agent.newSession({
      cwd: process.cwd(),
      mcpServers: [],
      _meta: {
        claudeCode: {
          options: {
            settings: {
              apiKeyHelper: "unsafe-helper",
              env: {
                ANTHROPIC_BASE_URL: "https://user-gateway.example",
                ANTHROPIC_API_KEY: "user-secret",
                UNRELATED_SETTING: "preserved",
              },
              model: "claude-sonnet-4-6",
            },
          },
        },
      },
    });

    expect(mockQuery.mock.calls[0][0].options.settings).toEqual(
      expect.objectContaining({
        apiKeyHelper: "",
        model: "claude-sonnet-4-6",
        env: expect.objectContaining({
          ANTHROPIC_BASE_URL: "https://gateway.example",
          ANTHROPIC_API_KEY: "",
          ANTHROPIC_AUTH_TOKEN: "acp-proxy",
          UNRELATED_SETTING: "preserved",
        }),
      }),
    );
  });

  it("waits for an active turn before recreating its session", async () => {
    const [agent, mockQuery] = await createAgentMock();
    await agent.initialize({ protocolVersion: 1, clientCapabilities: {} });
    const created = await agent.newSession({ cwd: process.cwd(), mcpServers: [] });
    const originalQuery = mockQuery.mock.results[0].value;
    let finishTurn!: () => void;
    const completion = new Promise<void>((resolve) => {
      finishTurn = resolve;
    });
    (agent.sessions[created.sessionId] as any).turnQueue = [{ completion }];

    const update = agent.unstable_setProvider({
      providerId: "main",
      apiType: "anthropic",
      baseUrl: "https://gateway.example",
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(originalQuery.close).not.toHaveBeenCalled();
    finishTurn();
    await update;
    expect(originalQuery.close).toHaveBeenCalledOnce();
  });

  it("routes bedrock provider config into session env", async () => {
    const [agent, mockQuery] = await createAgentMock();
    await agent.initialize({ protocolVersion: 1, clientCapabilities: {} });
    await agent.unstable_setProvider({
      providerId: "main",
      apiType: "bedrock",
      baseUrl: "https://gateway.example",
      headers: { "custom-header": "test" },
    });

    await agent.newSession({ cwd: process.cwd(), mcpServers: [] });

    expect(mockQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({
          env: expect.objectContaining({
            CLAUDE_CODE_USE_BEDROCK: "1",
            AWS_BEARER_TOKEN_BEDROCK: "acp-proxy",
            ANTHROPIC_BEDROCK_BASE_URL: "https://gateway.example",
            ANTHROPIC_CUSTOM_HEADERS: "custom-header: test",
          }),
        }),
      }),
    );
  });

  it("accepts vertex config via _meta and routes it into session env", async () => {
    const [agent, mockQuery] = await createAgentMock();
    await agent.initialize({ protocolVersion: 1, clientCapabilities: {} });
    await agent.unstable_setProvider({
      providerId: "main",
      apiType: "vertex",
      baseUrl: "https://vertex.example",
      headers: { "custom-header": "test" },
      _meta: { claudeCode: { vertex: { projectId: "my-project", region: "us-east5" } } },
    });

    // list surfaces apiType/baseUrl but not the _meta extras
    const listed = await agent.unstable_listProviders({});
    expect(listed.providers[0].current).toEqual({
      apiType: "vertex",
      baseUrl: "https://vertex.example",
    });

    await agent.newSession({ cwd: process.cwd(), mcpServers: [] });

    expect(mockQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({
          env: expect.objectContaining({
            CLAUDE_CODE_USE_VERTEX: "1",
            ANTHROPIC_VERTEX_BASE_URL: "https://vertex.example",
            ANTHROPIC_VERTEX_PROJECT_ID: "my-project",
            CLOUD_ML_REGION: "us-east5",
            ANTHROPIC_CUSTOM_HEADERS: "custom-header: test",
          }),
        }),
      }),
    );
  });

  it("rejects vertex set without _meta project/region", async () => {
    const [agent] = await createAgentMock();
    await expect(
      agent.unstable_setProvider({
        providerId: "main",
        apiType: "vertex",
        baseUrl: "https://vertex.example",
      }),
    ).rejects.toMatchObject({ code: -32602 });

    // partial _meta (missing region) is also rejected
    await expect(
      agent.unstable_setProvider({
        providerId: "main",
        apiType: "vertex",
        baseUrl: "https://vertex.example",
        _meta: { claudeCode: { vertex: { projectId: "my-project" } } } as any,
      }),
    ).rejects.toMatchObject({ code: -32602 });
  });

  it("providers/set takes precedence over gateway auth", async () => {
    const [agent, mockQuery] = await createAgentMock();
    await agent.initialize({
      protocolVersion: 1,
      clientCapabilities: { auth: { terminal: true, _meta: { gateway: true } } } as any,
    });

    // Gateway auth first...
    await agent.authenticate({
      methodId: "gateway",
      _meta: { gateway: { baseUrl: "https://gateway.example", headers: {} } },
    });
    // ...then providers/set wins.
    await agent.unstable_setProvider({
      providerId: "main",
      apiType: "anthropic",
      baseUrl: "https://provider.example",
    });

    await agent.newSession({ cwd: process.cwd(), mcpServers: [] });

    expect(mockQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({
          env: expect.objectContaining({
            ANTHROPIC_BASE_URL: "https://provider.example",
          }),
        }),
      }),
    );
  });

  it("clears provider config on logout", async () => {
    const [agent] = await createAgentMock();
    // Avoids resolving the native CLI binary in claudeCliPath().
    vi.stubEnv("CLAUDE_CODE_EXECUTABLE", "/bin/true");

    await agent.unstable_setProvider({
      providerId: "main",
      apiType: "anthropic",
      baseUrl: "https://provider.example",
    });
    expect((await agent.unstable_listProviders({})).providers[0].current).not.toBeNull();

    await agent.logout({});

    expect((await agent.unstable_listProviders({})).providers[0].current).toEqual({
      apiType: "anthropic",
      baseUrl: "https://api.anthropic.com",
    });
  });
});
