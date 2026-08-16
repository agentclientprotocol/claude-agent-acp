import { describe, it, expect, beforeEach, vi } from "vitest";
import { SessionNotification } from "@agentclientprotocol/sdk";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import type { AcpClient, ClaudeAcpAgent as ClaudeAcpAgentType } from "../acp-agent.js";

let capturedOptions: Options | undefined;
let sessionMessages: unknown[] = [];
vi.mock("@anthropic-ai/claude-agent-sdk", async () => {
  const actual = await vi.importActual<typeof import("@anthropic-ai/claude-agent-sdk")>(
    "@anthropic-ai/claude-agent-sdk",
  );
  return {
    ...actual,
    getSessionMessages: async () => sessionMessages,
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
        getContextUsage: () => Promise.reject(new Error("no context usage mocked")),
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

describe("session/fork rewindTo", () => {
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
    sessionMessages = [];

    vi.resetModules();
    const acpAgent = await import("../acp-agent.js");
    ClaudeAcpAgent = acpAgent.ClaudeAcpAgent;

    agent = new ClaudeAcpAgent(createMockClient());
  });

  it("translates _meta.claudeCode.rewindTo into the SDK resumeSessionAt option", async () => {
    const { sessionId } = await agent.newSession({ cwd: process.cwd(), mcpServers: [] });

    sessionMessages = [
      { type: "assistant", uuid: "uuid-turn-1", message: { id: "msg_turn_1" } },
      { type: "assistant", uuid: "uuid-turn-2", message: { id: "msg_turn_2" } },
    ];

    await agent.unstable_forkSession({
      sessionId,
      cwd: process.cwd(),
      mcpServers: [],
      _meta: { claudeCode: { rewindTo: "msg_turn_1" } },
    });

    expect(capturedOptions!.resumeSessionAt).toBe("uuid-turn-1");
    expect(capturedOptions!.forkSession).toBe(true);
    expect(capturedOptions!.resume).toBe(sessionId);
  });

  it("prefers the in-memory messageId→uuid map over a history read", async () => {
    const { sessionId } = await agent.newSession({ cwd: process.cwd(), mcpServers: [] });
    agent.sessions[sessionId].messageIdToUuid.set("msg_live", "uuid-live");

    await agent.unstable_forkSession({
      sessionId,
      cwd: process.cwd(),
      mcpServers: [],
      _meta: { claudeCode: { rewindTo: "msg_live" } },
    });

    expect(capturedOptions!.resumeSessionAt).toBe("uuid-live");
  });

  it("keeps the turn-boundary uuid when one message id spans several messages", async () => {
    const { sessionId } = await agent.newSession({ cwd: process.cwd(), mcpServers: [] });

    sessionMessages = [
      { type: "assistant", uuid: "uuid-block-1", message: { id: "msg_split" } },
      { type: "assistant", uuid: "uuid-block-2", message: { id: "msg_split" } },
    ];

    await agent.unstable_forkSession({
      sessionId,
      cwd: process.cwd(),
      mcpServers: [],
      _meta: { claudeCode: { rewindTo: "msg_split" } },
    });

    expect(capturedOptions!.resumeSessionAt).toBe("uuid-block-2");
  });

  it("rejects an unknown rewindTo id with invalid params", async () => {
    const { sessionId } = await agent.newSession({ cwd: process.cwd(), mcpServers: [] });

    await expect(
      agent.unstable_forkSession({
        sessionId,
        cwd: process.cwd(),
        mcpServers: [],
        _meta: { claudeCode: { rewindTo: "msg_missing" } },
      }),
    ).rejects.toThrow(/No message with id `msg_missing`/);
  });

  it("forks without resumeSessionAt when no rewindTo is given", async () => {
    const { sessionId } = await agent.newSession({ cwd: process.cwd(), mcpServers: [] });

    await agent.unstable_forkSession({ sessionId, cwd: process.cwd(), mcpServers: [] });

    expect(capturedOptions!.resumeSessionAt).toBeUndefined();
    expect(capturedOptions!.forkSession).toBe(true);
  });
});
