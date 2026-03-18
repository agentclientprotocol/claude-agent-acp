import { mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AgentSideConnection, SessionNotification } from "@agentclientprotocol/sdk";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import type { ClaudeAcpAgent as ClaudeAcpAgentType } from "../acp-agent.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let capturedOptions: Options | undefined;
vi.mock("@anthropic-ai/claude-agent-sdk", async () => ({
  ...(await vi.importActual<typeof import("@anthropic-ai/claude-agent-sdk")>(
    "@anthropic-ai/claude-agent-sdk",
  )),
  query: ({ options }: { options: Options }) => {
    capturedOptions = options;
    return {
      initializationResult: async () => ({
        models: [{ value: "claude-sonnet-4-5", displayName: "Claude Sonnet", description: "Fast" }],
      }),
      setModel: async () => {},
      supportedCommands: async () => [],
      [Symbol.asyncIterator]: async function* () {},
    };
  },
}));
vi.mock("../tools.js", async () => ({
  ...(await vi.importActual<typeof import("../tools.js")>("../tools.js")),
  registerHookCallback: vi.fn(),
}));

describe("additionalRoots", () => {
  let agent: ClaudeAcpAgentType;
  const tempDirs: string[] = [];
  const newSession = (meta: Record<string, unknown>, cwd = "/test") =>
    agent.newSession({ cwd, mcpServers: [], _meta: meta });

  beforeEach(async () => {
    capturedOptions = undefined;
    tempDirs.length = 0;
    vi.resetModules();
    const { ClaudeAcpAgent } = await import("../acp-agent.js");
    agent = new ClaudeAcpAgent({
      sessionUpdate: async (_notification: SessionNotification) => {},
      requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
      readTextFile: async () => ({ content: "" }),
      writeTextFile: async () => ({}),
    } as unknown as AgentSideConnection);
  });

  afterEach(
    async () =>
      void (await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })))),
  );

  it("passes through relative roots as provided", async () => {
    const projectRoot = await mkdtemp(path.join(os.tmpdir(), "claude-project-"));
    tempDirs.push(projectRoot);
    await newSession({ additionalRoots: ["."] }, projectRoot);
    expect(capturedOptions!.additionalDirectories).toEqual(["."]);
  });

  it("merges additionalRoots with user additionalDirectories without normalization", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "claude-root-"));
    tempDirs.push(root);
    await newSession({
      additionalRoots: ["", root],
      claudeCode: { options: { additionalDirectories: ["/workspace/shared"] } },
    });
    expect(capturedOptions!.additionalDirectories).toEqual(["/workspace/shared", "", root]);
  });
});
