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

  it("lists a single optional 'main' provider, unconfigured by default", async () => {
    const [agent] = await createAgentMock();
    const response = await agent.unstable_listProviders({});
    expect(response.providers).toEqual([
      {
        providerId: "main",
        supported: ["anthropic", "bedrock", "vertex"],
        required: false,
        current: null,
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

  it("disables the 'main' provider by clearing config and reporting current: null", async () => {
    const [agent] = await createAgentMock();
    await agent.unstable_setProvider({
      providerId: "main",
      apiType: "anthropic",
      baseUrl: "https://gateway.example/v1",
    });
    expect((await agent.unstable_listProviders({})).providers[0].current).not.toBeNull();

    await expect(agent.unstable_disableProvider({ providerId: "main" })).resolves.toEqual({});

    expect((await agent.unstable_listProviders({})).providers[0].current).toBeNull();
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
            ANTHROPIC_AUTH_TOKEN: " ",
            ANTHROPIC_BASE_URL: "https://gateway.example",
            ANTHROPIC_CUSTOM_HEADERS: "x-api-key: test",
          }),
        }),
      }),
    );
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
            AWS_BEARER_TOKEN_BEDROCK: " ",
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

    expect((await agent.unstable_listProviders({})).providers[0].current).toBeNull();
  });
});
