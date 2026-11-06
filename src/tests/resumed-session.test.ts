import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  activeSessionMessages,
  prepareRewoundResume,
  readResumedTail,
  resumedModelFromTranscript,
  rewoundSession,
  writeRewindPoint,
} from "../resumed-session.js";

function assistant(
  model: unknown,
  nesting: Pick<SessionMessage, "parent_tool_use_id" | "parent_agent_id"> = {
    parent_tool_use_id: null,
    parent_agent_id: null,
  },
): SessionMessage {
  return {
    type: "assistant",
    uuid: crypto.randomUUID(),
    session_id: "session-id",
    ...nesting,
    message: { model },
  };
}

describe("resumedModelFromTranscript", () => {
  it("returns the last real assistant model", () => {
    expect(
      resumedModelFromTranscript([assistant("claude-sonnet-5"), assistant("claude-opus-5")]),
    ).toBe("claude-opus-5");
  });

  it("skips synthetic assistant records after the real response", () => {
    expect(resumedModelFromTranscript([assistant("claude-opus-5"), assistant("<synthetic>")])).toBe(
      "claude-opus-5",
    );
  });

  it("skips nested assistant records that can use a different model", () => {
    expect(
      resumedModelFromTranscript([
        assistant("claude-opus-5"),
        assistant("claude-haiku-4-5", {
          parent_tool_use_id: "task-tool-use",
          parent_agent_id: null,
        }),
      ]),
    ).toBe("claude-opus-5");
  });

  it("returns undefined when the transcript has no real assistant model", () => {
    expect(resumedModelFromTranscript([assistant("<synthetic>")])).toBeUndefined();
  });
});

describe("rewind point", () => {
  let configDir: string;
  let originalConfigDir: string | undefined;
  const sessionId = crypto.randomUUID();
  const directory = () => path.join(configDir, "projects", "-workspace");

  beforeEach(async () => {
    configDir = await mkdtemp(path.join(os.tmpdir(), "claude-acp-rewind-point-"));
    originalConfigDir = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = configDir;
    await mkdir(directory(), { recursive: true });
  });

  afterEach(async () => {
    if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = originalConfigDir;
    await rm(configDir, { recursive: true, force: true });
  });

  const ids = Array.from({ length: 6 }, () => crypto.randomUUID());
  const entry = (index: number, parent: number | undefined, type: "user" | "assistant") => ({
    type,
    uuid: ids[index],
    parentUuid: parent === undefined ? null : ids[parent],
    isSidechain: false,
    sessionId,
    timestamp: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
    message:
      type === "user"
        ? { role: "user", content: `prompt ${index}` }
        : { role: "assistant", content: [{ type: "text", text: `answer ${index}` }] },
  });
  async function transcript(entries: unknown[]): Promise<void> {
    await writeFile(
      path.join(directory(), `${sessionId}.jsonl`),
      entries.map((record) => JSON.stringify(record)).join("\n") + "\n",
    );
  }
  const twoTurns = [
    entry(0, undefined, "user"),
    entry(1, 0, "assistant"),
    entry(2, 1, "user"),
    entry(3, 2, "assistant"),
  ];
  const point = { resumeSessionAt: ids[1]!, droppedPromptUuid: ids[2]! };

  it("leaves a session that was never rewound to Claude Code", async () => {
    await transcript(twoTurns);

    expect(await rewoundSession(sessionId)).toBeUndefined();
  });

  it("cuts the conversation at a rewind the next prompt has not written past", async () => {
    await transcript(twoTurns);
    await writeRewindPoint(sessionId, point);

    expect(await rewoundSession(sessionId)).toEqual({
      leaf: ids[1],
      lastPrompt: "prompt 0",
      pending: point,
    });
    expect((await activeSessionMessages(sessionId)).map((message) => message.uuid)).toEqual([
      ids[0],
      ids[1],
    ]);
  });

  it("ends the conversation at the newest entry once the next prompt starts the new branch", async () => {
    await transcript([...twoTurns, entry(4, 1, "user"), entry(5, 4, "assistant")]);
    await writeRewindPoint(sessionId, point);

    expect(await rewoundSession(sessionId)).toEqual({ leaf: ids[5], lastPrompt: "prompt 4" });
    expect((await activeSessionMessages(sessionId)).map((message) => message.uuid)).toEqual([
      ids[0],
      ids[1],
      ids[4],
      ids[5],
    ]);
  });
  const lastLines = async (count: number) =>
    (await readFile(path.join(directory(), `${sessionId}.jsonl`), "utf8"))
      .trim()
      .split("\n")
      .slice(-count)
      .map((line) => JSON.parse(line));
  const rewindFile = () => path.join(directory(), sessionId, "rewind.json");

  it("names a pending rewind point explicitly for Claude Code's next resume", async () => {
    // The process that resumed before the rewind named the dropped branch.
    const stale = { type: "last-prompt", leafUuid: ids[3], sessionId };
    await transcript([...twoTurns, stale]);
    await writeRewindPoint(sessionId, point);

    expect(await prepareRewoundResume(sessionId)).toBe(ids[1]);
    expect(await prepareRewoundResume(sessionId)).toBe(ids[1]);

    // Once, and explicit: a plain line stands for the newest entry descending
    // from its leaf, which is in the dropped branch.
    expect(await lastLines(2)).toEqual([
      stale,
      { type: "last-prompt", lastPrompt: "prompt 0", leafUuid: ids[1], explicit: true, sessionId },
    ]);
    await expect(readFile(rewindFile(), "utf8")).resolves.toBeDefined();
  });

  it("names the newest entry once the new branch is written, and forgets the point", async () => {
    // The rewound process wrote the new branch, but its `last-prompt` line
    // still names the leaf it loaded, explicitly.
    const stale = { type: "last-prompt", leafUuid: ids[1], explicit: true, sessionId };
    await transcript([...twoTurns, entry(4, 1, "user"), entry(5, 4, "assistant"), stale]);
    await writeRewindPoint(sessionId, point);

    expect(await prepareRewoundResume(sessionId)).toBeUndefined();

    expect(await lastLines(2)).toEqual([
      stale,
      { type: "last-prompt", lastPrompt: "prompt 4", leafUuid: ids[5], sessionId },
    ]);
    await expect(readFile(rewindFile(), "utf8")).rejects.toThrow();
    expect(await rewoundSession(sessionId)).toBeUndefined();
  });
});

describe("readResumedTail", () => {
  let configDir: string;
  let originalConfigDir: string | undefined;

  beforeEach(async () => {
    configDir = await mkdtemp(path.join(os.tmpdir(), "claude-acp-resume-"));
    originalConfigDir = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = configDir;
  });

  afterEach(async () => {
    if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = originalConfigDir;
    await rm(configDir, { recursive: true, force: true });
  });

  async function transcript(sessionId: string, records: unknown[]): Promise<void> {
    const directory = path.join(configDir, "projects", "-workspace");
    await mkdir(directory, { recursive: true });
    await writeFile(
      path.join(directory, `${sessionId}.jsonl`),
      records.map((record) => JSON.stringify(record)).join("\n") + "\n",
    );
  }

  const record = (model: string, extra: object = {}) => ({
    type: "assistant",
    uuid: crypto.randomUUID(),
    message: { role: "assistant", model, content: [{ type: "text", text: "ok" }] },
    ...extra,
  });
  const userLine = (text: string) => ({ type: "user", message: { role: "user", content: text } });

  it("reads the last real main-thread model across many backward reads", async () => {
    // The model record is followed by about 3 MB of later records.
    await transcript("long", [
      record("claude-sonnet-5"),
      record("claude-opus-5"),
      ...Array.from({ length: 3000 }, () => userLine("x".repeat(1000))),
      record("<synthetic>"),
      record("claude-haiku-4-5", { isSidechain: true }),
    ]);

    expect((await readResumedTail("long")).model).toBe("claude-opus-5");
  });

  it("reads a record that is longer than one backward read", async () => {
    await transcript("wide", [
      record("claude-opus-5", { padding: "y".repeat(200 * 1024) }),
      userLine("after"),
    ]);

    expect((await readResumedTail("wide")).model).toBe("claude-opus-5");
  });

  it("reads the first line of the file", async () => {
    await transcript("single", [record("claude-opus-5")]);

    expect((await readResumedTail("single")).model).toBe("claude-opus-5");
  });

  it("returns undefined when no real model is recorded", async () => {
    await transcript("none", [userLine("hello"), record("<synthetic>")]);

    expect((await readResumedTail("none")).model).toBeUndefined();
  });

  const prompt = (text: string, extra: object = {}) => ({ ...userLine(text), ...extra });

  it("reads the permission mode of the last main-thread user record", async () => {
    await transcript("mode", [
      prompt("first", { permissionMode: "plan" }),
      record("claude-opus-5"),
      prompt("second", { permissionMode: "bypassPermissions" }),
      record("claude-opus-5"),
      prompt("nested", { permissionMode: "default", isSidechain: true }),
      { type: "mode", mode: "normal" },
      userLine("tool result without a mode"),
    ]);

    expect(await readResumedTail("mode")).toEqual({
      model: "claude-opus-5",
      permissionMode: "bypassPermissions",
    });
  });

  it("reads a permission mode that is before the last model", async () => {
    await transcript("early-mode", [
      prompt("first", { permissionMode: "acceptEdits" }),
      ...Array.from({ length: 200 }, () => userLine("x".repeat(1000))),
      record("claude-opus-5"),
    ]);

    expect((await readResumedTail("early-mode")).permissionMode).toBe("acceptEdits");
  });

  it("ignores the permission-mode records of the CLI metadata block", async () => {
    await transcript("metadata-mode", [
      prompt("first", { permissionMode: "bypassPermissions", origin: { kind: "human" } }),
      record("claude-opus-5"),
      { type: "permission-mode", permissionMode: "auto", sessionId: "metadata-mode" },
    ]);

    expect((await readResumedTail("metadata-mode")).permissionMode).toBe("bypassPermissions");
  });

  it("gives no plan mode when a plan exit follows it", async () => {
    const planExit = { type: "attachment", attachment: { type: "plan_mode_exit" } };
    await transcript("plan-exit", [
      prompt("plan it", { permissionMode: "plan", origin: { kind: "human" } }),
      record("claude-opus-5"),
      planExit,
      record("claude-opus-5"),
    ]);
    await transcript("plan-exit-then-mode", [
      prompt("plan it", { permissionMode: "plan", origin: { kind: "human" } }),
      planExit,
      prompt("go", { permissionMode: "acceptEdits", origin: { kind: "human" } }),
      record("claude-opus-5"),
    ]);

    expect(await readResumedTail("plan-exit")).toEqual({ model: "claude-opus-5" });
    expect((await readResumedTail("plan-exit-then-mode")).permissionMode).toBe("acceptEdits");
  });

  it("stops the mode search at the last human prompt without a mode", async () => {
    await transcript("bounded", [
      prompt("old", { permissionMode: "bypassPermissions", origin: { kind: "human" } }),
      prompt("new", { origin: { kind: "human" } }),
      record("claude-opus-5"),
    ]);

    expect(await readResumedTail("bounded")).toEqual({ model: "claude-opus-5" });
  });

  it("reads the mode of the prompt before a compaction", async () => {
    await transcript("compacted", [
      prompt("old", { permissionMode: "plan", origin: { kind: "human" } }),
      { type: "system", subtype: "compact_boundary" },
      prompt("summary", { isCompactSummary: true }),
      record("claude-opus-5"),
    ]);

    expect((await readResumedTail("compacted")).permissionMode).toBe("plan");
  });

  it("returns no permission mode when the transcript records none", async () => {
    await transcript("no-mode", [userLine("hello"), record("claude-opus-5")]);

    expect(await readResumedTail("no-mode")).toEqual({ model: "claude-opus-5" });
  });
});
