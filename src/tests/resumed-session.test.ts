import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getSessionMessages, type SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  readHistoryAcrossCompactions,
  readResumedTail,
  resumedModelFromTranscript,
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

describe("readHistoryAcrossCompactions", () => {
  const sessionId = "33333333-3333-4333-8333-333333333333";
  let configDir: string;
  let originalConfigDir: string | undefined;

  beforeEach(async () => {
    configDir = await mkdtemp(path.join(os.tmpdir(), "claude-acp-compacted-"));
    originalConfigDir = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = configDir;
  });

  afterEach(async () => {
    if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = originalConfigDir;
    await rm(configDir, { recursive: true, force: true });
  });

  /** Writes the records as Claude Code does: each one links to the record
   *  before it, except a record that sets its own `parentUuid`. */
  async function transcript(records: Record<string, unknown>[]): Promise<void> {
    const directory = path.join(configDir, "projects", "-workspace");
    await mkdir(directory, { recursive: true });
    let parentUuid: unknown = null;
    const lines = records.map((record) => {
      const line = {
        parentUuid,
        sessionId,
        isSidechain: false,
        timestamp: "2026-10-11T00:00:00.000Z",
        ...record,
      };
      parentUuid = record.uuid;
      return JSON.stringify(line);
    });
    await writeFile(path.join(directory, `${sessionId}.jsonl`), lines.join("\n") + "\n");
  }

  const user = (uuid: string, text: string, extra: object = {}) => ({
    type: "user",
    uuid,
    message: { role: "user", content: text },
    ...extra,
  });
  const assistant = (uuid: string, text: string) => ({
    type: "assistant",
    uuid,
    message: {
      id: `msg_${uuid}`,
      role: "assistant",
      model: "claude-opus-5",
      content: [{ type: "text", text }],
    },
  });
  /** A boundary as Claude Code writes it: no parent, and the last message
   *  before it in `logicalParentUuid`. */
  const boundary = (uuid: string, logicalParentUuid: string, compactMetadata: object = {}) => ({
    type: "system",
    subtype: "compact_boundary",
    uuid,
    parentUuid: null,
    logicalParentUuid,
    compactMetadata: { trigger: "manual", preTokens: 1000, ...compactMetadata },
  });
  const summary = (uuid: string) => user(uuid, `Summary ${uuid}`, { isCompactSummary: true });

  const texts = (messages: SessionMessage[]) =>
    messages.map((message) => {
      const content = (message.message as { content: unknown }).content;
      return typeof content === "string" ? content : (content as { text: string }[])[0]!.text;
    });

  it("reads the messages before each compaction", async () => {
    await transcript([
      user("u1", "hi"),
      assistant("a1", "Hello"),
      boundary("b1", "a1"),
      summary("s1"),
      user("u2", "next"),
      assistant("a2", "Next"),
      boundary("b2", "a2"),
      summary("s2"),
      user("u3", "identify yourself"),
      assistant("a3", "Claude"),
    ]);

    // getSessionMessages stops at the last boundary.
    const chain = await getSessionMessages(sessionId);
    expect(texts(chain)).toEqual(["Summary s2", "identify yourself", "Claude"]);
    expect(texts(await readHistoryAcrossCompactions(sessionId, chain))).toEqual([
      "hi",
      "Hello",
      "Summary s1",
      "next",
      "Next",
      "Summary s2",
      "identify yourself",
      "Claude",
    ]);
  });

  it("keeps the messages that a compaction preserved where they were said", async () => {
    // Claude Code 2.1.293 keeps u2 and a2 in the context after the summary,
    // and records them in both forms of preserved-message metadata.
    await transcript([
      user("u1", "hi"),
      assistant("a1", "Hello"),
      user("u2", "keep this"),
      assistant("a2", "Kept"),
      boundary("b1", "a2", {
        preservedSegment: { headUuid: "u2", anchorUuid: "s1", tailUuid: "a2" },
        preservedMessages: { anchorUuid: "s1", uuids: ["u2", "a2"] },
      }),
      summary("s1"),
      user("u3", "after"),
      assistant("a3", "After"),
    ]);

    // getSessionMessages moves the preserved messages after the summary.
    const chain = await getSessionMessages(sessionId);
    expect(texts(chain)).toEqual(["Summary s1", "keep this", "Kept", "after", "After"]);
    expect(texts(await readHistoryAcrossCompactions(sessionId, chain))).toEqual([
      "hi",
      "Hello",
      "keep this",
      "Kept",
      "Summary s1",
      "after",
      "After",
    ]);
  });

  it("returns the chain of a session without a compaction as it is", async () => {
    await transcript([user("u1", "hi"), assistant("a1", "Hello")]);

    const chain = await getSessionMessages(sessionId);
    expect(await readHistoryAcrossCompactions(sessionId, chain)).toBe(chain);
  });
});
