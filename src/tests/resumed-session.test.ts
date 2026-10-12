import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readResumedTail, resumedModelFromTranscript } from "../resumed-session.js";

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

  it("restores model and mode from the retained branch after repeated native rewind", async () => {
    await transcript("rewound", [
      { type: "user", uuid: "u1", parentUuid: null, permissionMode: "default" },
      record("kept-model", { uuid: "a1", parentUuid: "u1" }),
      { type: "user", uuid: "u2", parentUuid: "a1", permissionMode: "plan" },
      record("discarded-model", { uuid: "a2", parentUuid: "u2" }),
      { type: "last-prompt", explicit: true, leafUuid: "a2" },
      { type: "last-prompt", explicit: true, leafUuid: "a1" },
      { type: "system", uuid: "late-log", parentUuid: "a2" },
    ]);
    expect(await readResumedTail("rewound")).toEqual({
      model: "kept-model",
      permissionMode: "default",
    });
  });

  it("restores neither discarded model nor permission after first-message rewind", async () => {
    await transcript("empty-rewind", [
      { type: "user", uuid: "u1", parentUuid: null, permissionMode: "plan" },
      record("discarded-model", { uuid: "a1", parentUuid: "u1" }),
      { type: "last-prompt", explicit: true, leafUuid: null },
    ]);
    expect(await readResumedTail("empty-rewind")).toEqual({});
  });

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
