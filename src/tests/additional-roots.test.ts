import { mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { SessionNotification } from "@agentclientprotocol/sdk";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import type { AcpClient, ClaudeAcpAgent as ClaudeAcpAgentType } from "../acp-agent.js";
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
}));
vi.mock("../tools.js", async () => ({
  ...(await vi.importActual<typeof import("../tools.js")>("../tools.js")),
  registerHookCallback: vi.fn(),
}));

describe("additionalRoots", () => {
  let agent: ClaudeAcpAgentType;
  const tempDirs: string[] = [];
  const newSession = (meta: Record<string, unknown>, cwd = process.cwd()) =>
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
    } as unknown as AcpClient);
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

  it("prefers the official ACP additionalDirectories field over _meta.additionalRoots", async () => {
    await agent.newSession({
      cwd: process.cwd(),
      mcpServers: [],
      additionalDirectories: ["/from/official"],
      _meta: { additionalRoots: ["/from/meta"] },
    });
    expect(capturedOptions!.additionalDirectories).toEqual(["/from/official"]);
  });

  it("merges official ACP additionalDirectories with claudeCode SDK additionalDirectories", async () => {
    await agent.newSession({
      cwd: process.cwd(),
      mcpServers: [],
      additionalDirectories: ["/from/official"],
      _meta: { claudeCode: { options: { additionalDirectories: ["/from/sdk"] } } },
    });
    expect(capturedOptions!.additionalDirectories).toEqual(["/from/sdk", "/from/official"]);
  });

  it("falls back to _meta.additionalRoots when the official field is omitted", async () => {
    await agent.newSession({
      cwd: process.cwd(),
      mcpServers: [],
      _meta: { additionalRoots: ["/from/meta"] },
    });
    expect(capturedOptions!.additionalDirectories).toEqual(["/from/meta"]);
  });
});
