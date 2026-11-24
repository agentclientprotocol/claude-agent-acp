import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getSessionMessages } from "@anthropic-ai/claude-agent-sdk";
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { messageIdForGrouping } from "../../sdk-to-acp.js";
import { forkSession } from "../../fork-session.js";
import { writeRewindPoint } from "../../session-rewind.js";
import { encodeProjectPath } from "../../session-index/project-dirs.js";

// Use the real SDK against temporary transcripts, without starting Claude Code.
let root: string;
let sourceCwd: string;
let destinationCwd: string;
let sessionId: string;
let sourceFile: string;
let transcript: string;
let activeUuid: string;

beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "fork-session-")));
  sourceCwd = path.join(root, "source");
  destinationCwd = path.join(root, "destination");
  const configDir = path.join(root, "config");
  vi.stubEnv("CLAUDE_CONFIG_DIR", configDir);
  await fs.mkdir(sourceCwd);
  await fs.mkdir(destinationCwd);
  sessionId = randomUUID();
  const userUuid = randomUUID();
  const firstUuid = randomUUID();
  const followupUuid = randomUUID();
  activeUuid = randomUUID();
  const common = { sessionId, cwd: sourceCwd, isSidechain: false };
  const entries = [
    {
      ...common,
      type: "user",
      uuid: userUuid,
      parentUuid: null,
      message: { role: "user", content: "First prompt" },
    },
    {
      ...common,
      type: "assistant",
      uuid: firstUuid,
      parentUuid: userUuid,
      message: {
        id: "msg_first",
        role: "assistant",
        content: [{ type: "text", text: "First answer" }],
      },
    },
    {
      ...common,
      type: "user",
      uuid: followupUuid,
      parentUuid: firstUuid,
      message: { role: "user", content: "Follow-up prompt" },
    },
    {
      ...common,
      type: "assistant",
      uuid: randomUUID(),
      parentUuid: followupUuid,
      message: {
        id: "msg_inactive",
        role: "assistant",
        content: [{ type: "text", text: "Inactive answer" }],
      },
    },
    {
      ...common,
      type: "assistant",
      uuid: activeUuid,
      parentUuid: followupUuid,
      message: {
        id: "msg_active",
        role: "assistant",
        content: [{ type: "text", text: "Active answer" }],
      },
    },
  ];
  transcript =
    entries
      .map((entry, index) =>
        JSON.stringify({ ...entry, timestamp: new Date(1_700_000_000_000 + index).toISOString() }),
      )
      .join("\n") + "\n";
  const projectDir = path.join(configDir, "projects", encodeProjectPath(sourceCwd));
  await fs.mkdir(projectDir, { recursive: true });
  sourceFile = path.join(projectDir, `${sessionId}.jsonl`);
  await fs.writeFile(sourceFile, transcript);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await fs.rm(root, { recursive: true, force: true });
});

describe.each(["same directory", "different directory"])("fork into %s", (directory) => {
  it.each([
    { resolution: "latest", messageId: undefined, expectedAnswer: "Active answer", count: 4 },
    {
      resolution: "active history",
      messageId: "msg_first",
      expectedAnswer: "First answer",
      count: 2,
    },
    {
      resolution: "inactive branch",
      messageId: "msg_inactive",
      expectedAnswer: "Inactive answer",
      count: 4,
    },
    {
      resolution: "fingerprint",
      messageId: "stale-message-id",
      expectedAnswer: "Inactive answer",
      count: 4,
    },
    { resolution: "live map", messageId: "msg_active", expectedAnswer: "Active answer", count: 4 },
  ])("resolves the fork point through $resolution", async (scenario) => {
    const originalMessages = await getSessionMessages(sessionId);
    expect(originalMessages.map(messageIdForGrouping)).not.toContain("msg_inactive");
    const cwd = directory === "same directory" ? sourceCwd : destinationCwd;
    const result = await forkSession(
      {
        sessionId,
        cwd,
        mcpServers: [],
        ...(scenario.messageId && {
          _meta: {
            jetbrains: {
              air: {
                fork: {
                  version: 1,
                  messageId: scenario.messageId,
                  ...(scenario.resolution === "fingerprint" && {
                    messageFingerprint: `sha256:${createHash("sha256").update("Inactive answer").digest("hex")}`,
                    messageOccurrence: 1,
                  }),
                },
              },
            },
          },
        }),
      },
      {
        messageIdForGrouping,
        ...(scenario.resolution === "live map" && {
          liveMessageIdToUuid: new Map([["msg_active", activeUuid]]),
        }),
      },
    );

    expect(result.sessionId).not.toBe(sessionId);
    const messages = await getSessionMessages(result.sessionId);
    expect(messages).toHaveLength(scenario.count);
    expect(messages.at(-1)?.message).toMatchObject({
      content: [{ type: "text", text: scenario.expectedAnswer }],
    });
    const originalUuids = originalMessages.map((message) => message.uuid);
    for (const message of messages) {
      expect(originalUuids).not.toContain(message.uuid);
    }
    expect(await fs.readFile(sourceFile, "utf8")).toBe(transcript);
  });

  it("rejects a fork point that is not in the source session", async () => {
    await expect(
      forkSession(
        {
          sessionId,
          cwd: directory === "same directory" ? sourceCwd : destinationCwd,
          mcpServers: [],
          _meta: { jetbrains: { air: { fork: { version: 1, messageId: "missing" } } } },
        },
        { messageIdForGrouping },
      ),
    ).rejects.toMatchObject({
      code: -32602,
      message: expect.stringContaining(
        `Fork point message missing was not found in session ${sessionId}`,
      ),
    });
    expect(await fs.readFile(sourceFile, "utf8")).toBe(transcript);
  });
});

describe("fork at a session cursor", () => {
  /** The entries of the source transcript, as `getSessionMessages` returns its active chain. */
  const history = () => getSessionMessages(sessionId, { dir: sourceCwd });

  it("copies the history before the cursor's user message", async () => {
    const [, firstAnswer, followup] = await history();
    const response = await forkSession(
      { sessionId, cwd: destinationCwd, mcpServers: [], cursorId: `before:${followup!.uuid}` },
      { messageIdForGrouping },
    );

    const forked = await getSessionMessages(response.sessionId);
    expect(forked.map((message) => message.message)).toEqual([
      { role: "user", content: "First prompt" },
      expect.objectContaining({ id: "msg_first" }),
    ]);
    expect(firstAnswer!.message).toMatchObject({ id: "msg_first" });
    expect(await fs.readFile(sourceFile, "utf8")).toBe(transcript);
  });

  it.each([
    ["an id that the session did not announce", () => "cur_9f2c41"],
    // Nothing is before the first entry.
    ["the first entry of the history", async () => `before:${(await history())[0]!.uuid}`],
    ["an entry that is no user message", async () => `before:${(await history())[1]!.uuid}`],
  ])("rejects %s without forking anything", async (_, cursor) => {
    const cursorId = await cursor();
    await expect(
      forkSession(
        { sessionId, cwd: sourceCwd, mcpServers: [], cursorId },
        { messageIdForGrouping },
      ),
    ).rejects.toMatchObject({
      code: -32602,
      data: { cursorId },
      message: expect.stringContaining("that a fork can start at"),
    });
    expect(await fs.readdir(path.dirname(sourceFile))).toEqual([path.basename(sourceFile)]);
  });
});

describe("fork after a rewind", () => {
  const fork = (extra: Partial<Parameters<typeof forkSession>[0]>, deps = {}) =>
    forkSession(
      { sessionId, cwd: sourceCwd, mcpServers: [], ...extra },
      { messageIdForGrouping, ...deps },
    );
  const messagePoint = (messageId: string) => ({
    _meta: { jetbrains: { air: { fork: { version: 1, messageId } } } },
  });
  let droppedPrompt: string;

  beforeEach(async () => {
    // The user rewound the follow-up: it and its answers stay in the transcript.
    const [, firstAnswer, followup] = await getSessionMessages(sessionId, { dir: sourceCwd });
    droppedPrompt = followup!.uuid;
    await writeRewindPoint(sessionId, {
      resumeSessionAt: firstAnswer!.uuid,
      droppedPromptUuid: droppedPrompt,
    });
  });

  it.each([
    ["the whole session", {}],
    ["a message of the retained part", messagePoint("msg_first")],
  ])("copies the retained history for %s", async (_, extra) => {
    const forked = await getSessionMessages((await fork(extra)).sessionId);
    expect(forked.map((message) => message.message)).toEqual([
      { role: "user", content: "First prompt" },
      expect.objectContaining({ id: "msg_first" }),
    ]);
  });

  it.each([
    ["the dropped prompt's cursor", () => ({ cursorId: `before:${droppedPrompt}` }), "cursorId"],
    ["an active message of the dropped part", () => messagePoint("msg_active"), "messageId"],
    ["an inactive message of the dropped part", () => messagePoint("msg_inactive"), "messageId"],
  ])("rejects %s with -32602 and forks nothing", async (_, request, field) => {
    await expect(fork(request())).rejects.toMatchObject({
      code: -32602,
      data: expect.objectContaining({ [field]: expect.any(String) }),
    });
    expect(
      (await fs.readdir(path.dirname(sourceFile))).filter((name) => name.endsWith(".jsonl")),
    ).toEqual([path.basename(sourceFile)]);
  });
});
