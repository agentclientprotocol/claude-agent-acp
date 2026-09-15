import type { Options, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { SessionNotification } from "@agentclientprotocol/sdk";
import { randomUUID } from "node:crypto";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AcpClient, ClaudeAcpAgent as ClaudeAcpAgentType } from "../acp-agent.js";
import {
  AGENT_FILE_CHANGE_REPORT_CAPABILITY,
  type AgentFileChangeReportResult,
} from "../file-change-audit.js";
import type { Pushable } from "../utils.js";

type Scenario = "reported" | "providerError" | "localOnly" | "waitForCancel";
let scenario: Scenario = "reported";
let observedOptions: Options | undefined;
let replayMessages: unknown[] = [];
let turnActivated = Promise.resolve();
let resolveTurnActivated = () => {};
const rewindFiles = vi.fn();

vi.mock("@anthropic-ai/claude-agent-sdk", async () => {
  const actual = await vi.importActual<typeof import("@anthropic-ai/claude-agent-sdk")>(
    "@anthropic-ai/claude-agent-sdk",
  );
  return {
    ...actual,
    getSessionMessages: vi.fn(async () => replayMessages),
    query: ({ prompt, options }: { prompt: Pushable<SDKUserMessage>; options: Options }) => {
      observedOptions = options;
      let resolveInterrupt = () => {};
      const interrupted = new Promise<void>((resolve) => {
        resolveInterrupt = resolve;
      });
      rewindFiles.mockImplementation(async () => ({
        canRewind: true,
        filesChanged: ["src/changed.ts"],
        insertions: 4,
        deletions: 1,
      }));
      return Object.assign(runTurn(prompt, interrupted), {
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
        setModel: vi.fn(async () => {}),
        setPermissionMode: vi.fn(async () => {}),
        supportedAgents: vi.fn(async () => []),
        supportedCommands: vi.fn(async () => []),
        getContextUsage: vi.fn(async () => ({ totalTokens: 0, rawMaxTokens: 200000 })),
        rewindFiles,
        interrupt: vi.fn(async () => {
          resolveInterrupt();
          return undefined;
        }),
        close: vi.fn(),
      });
    },
  };
});

vi.mock("../tools.js", async () => ({
  ...(await vi.importActual<typeof import("../tools.js")>("../tools.js")),
  registerHookCallback: vi.fn(),
}));

function assistantMessage(text: string) {
  return {
    type: "assistant" as const,
    parent_tool_use_id: null,
    uuid: randomUUID(),
    session_id: "sdk-session",
    message: {
      role: "assistant" as const,
      model: "claude-sonnet-4-6",
      stop_reason: "end_turn",
      usage: {
        input_tokens: 1,
        output_tokens: 1,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
      content: [{ type: "text", text }],
    },
  };
}

function successResult() {
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
      input_tokens: 2,
      output_tokens: 2,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
    modelUsage: {},
    permission_denials: [],
    uuid: randomUUID(),
    session_id: "sdk-session",
  };
}

async function* runTurn(input: Pushable<SDKUserMessage>, interrupted: Promise<void>) {
  const iterator = input[Symbol.asyncIterator]();
  const { value: userMessage } = await iterator.next();
  if (!userMessage) return;

  if (scenario === "localOnly") {
    yield { ...successResult(), result: "Local command output" };
    return;
  }

  yield {
    type: "user" as const,
    message: userMessage.message,
    parent_tool_use_id: null,
    uuid: userMessage.uuid,
    session_id: "sdk-session",
    isReplay: true,
  };
  resolveTurnActivated();

  if (scenario === "waitForCancel") {
    await interrupted;
    yield {
      type: "system" as const,
      subtype: "session_state_changed" as const,
      state: "idle" as const,
      uuid: randomUUID(),
      session_id: "sdk-session",
    };
    return;
  }

  if (scenario === "providerError") {
    yield {
      ...successResult(),
      is_error: true,
      result: "Provider failed",
      errors: ["Provider failed"],
    };
    return;
  }

  yield assistantMessage("Visible answer");
  yield successResult();
}

describe("native file-change report integration", () => {
  beforeEach(() => {
    scenario = "reported";
    observedOptions = undefined;
    replayMessages = [];
    rewindFiles.mockReset();
    turnActivated = new Promise<void>((resolve) => {
      resolveTurnActivated = resolve;
    });
  });

  const negotiatedCapabilities = {
    _meta: {
      jetbrains: {
        air: {
          version: 1,
          capabilities: [AGENT_FILE_CHANGE_REPORT_CAPABILITY, "sessionFailure"],
        },
      },
    },
  };

  async function createAgent(updates: SessionNotification[]) {
    const client = {
      sessionUpdate: async (notification: SessionNotification) => void updates.push(notification),
      requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
      readTextFile: async () => ({ content: "" }),
      writeTextFile: async () => ({}),
    } as unknown as AcpClient;
    const { ClaudeAcpAgent } = await import("../acp-agent.js");
    const agent: ClaudeAcpAgentType = new ClaudeAcpAgent(client, {
      log: () => {},
      error: () => {},
    });
    await agent.initialize({
      protocolVersion: 1,
      clientCapabilities: negotiatedCapabilities,
    });
    const { sessionId } = await agent.newSession({ cwd: process.cwd(), mcpServers: [] });
    return { agent, sessionId };
  }

  function reports(updates: SessionNotification[]): AgentFileChangeReportResult[] {
    return updates.flatMap((notification) => {
      if (notification.update.sessionUpdate !== "session_info_update") return [];
      const meta = notification.update._meta as
        | {
            jetbrains?: {
              air?: { agentFileChangeReport?: AgentFileChangeReportResult };
            };
          }
        | undefined;
      const report = meta?.jetbrains?.air?.agentFileChangeReport;
      return report ? [report] : [];
    });
  }

  function prompt(sessionId: string, requestId: string, text: string) {
    return {
      sessionId,
      prompt: [{ type: "text" as const, text }],
      _meta: {
        jetbrains: {
          air: {
            agentFileChangeReportRequest: { version: 1, requestId },
          },
        },
      },
    };
  }

  it("enables native checkpointing and reports its dry-run paths", async () => {
    const updates: SessionNotification[] = [];
    const { agent, sessionId } = await createAgent(updates);

    await expect(
      agent.prompt(prompt(sessionId, "request-native", "Change a file")),
    ).resolves.toMatchObject({ stopReason: "end_turn" });

    expect(observedOptions?.enableFileCheckpointing).toBe(true);
    expect(observedOptions?.mcpServers).not.toHaveProperty("claude_agent_acp");
    expect(observedOptions?.hooks?.Stop).toBeUndefined();
    expect(rewindFiles).toHaveBeenCalledTimes(1);
    expect(rewindFiles).toHaveBeenCalledWith(expect.any(String), { dryRun: true });
    expect(reports(updates)).toEqual([
      {
        version: 1,
        requestId: "request-native",
        status: "reported",
        paths: [path.join(process.cwd(), "src/changed.ts")],
        declaredComplete: false,
        truncated: false,
      },
    ]);

    await agent.dispose();
  });

  it("does not inspect a checkpoint when the prompt did not request a report", async () => {
    const updates: SessionNotification[] = [];
    const { agent, sessionId } = await createAgent(updates);

    await agent.prompt({ sessionId, prompt: [{ type: "text", text: "No report" }] });

    expect(rewindFiles).not.toHaveBeenCalled();
    expect(reports(updates)).toEqual([]);
    await agent.dispose();
  });

  it("publishes providerError without attempting checkpoint inspection", async () => {
    scenario = "providerError";
    const updates: SessionNotification[] = [];
    const { agent, sessionId } = await createAgent(updates);

    await expect(agent.prompt(prompt(sessionId, "request-error", "Fail"))).resolves.toBeDefined();

    expect(rewindFiles).not.toHaveBeenCalled();
    expect(reports(updates)).toEqual([
      {
        version: 1,
        requestId: "request-error",
        status: "unavailable",
        reason: "providerError",
      },
    ]);
    await agent.dispose();
  });

  it("publishes cancelled without attempting checkpoint inspection", async () => {
    scenario = "waitForCancel";
    const updates: SessionNotification[] = [];
    const { agent, sessionId } = await createAgent(updates);
    const result = agent.prompt(prompt(sessionId, "request-cancel", "Wait"));
    await turnActivated;

    await agent.cancel({ sessionId });
    await expect(result).resolves.toMatchObject({ stopReason: "cancelled" });

    expect(rewindFiles).not.toHaveBeenCalled();
    expect(reports(updates)).toEqual([
      {
        version: 1,
        requestId: "request-cancel",
        status: "unavailable",
        reason: "cancelled",
      },
    ]);
    await agent.dispose();
  });
});
