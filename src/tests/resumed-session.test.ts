import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readResumedModel, resumedModelFromTranscript } from "../resumed-session.js";

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

describe("readResumedModel", () => {
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

    expect(await readResumedModel("long")).toBe("claude-opus-5");
  });

  it("reads a record that is longer than one backward read", async () => {
    await transcript("wide", [
      record("claude-opus-5", { padding: "y".repeat(200 * 1024) }),
      userLine("after"),
    ]);

    expect(await readResumedModel("wide")).toBe("claude-opus-5");
  });

  it("reads the first line of the file", async () => {
    await transcript("single", [record("claude-opus-5")]);

    expect(await readResumedModel("single")).toBe("claude-opus-5");
  });

  it("returns undefined when no real model is recorded", async () => {
    await transcript("none", [userLine("hello"), record("<synthetic>")]);

    expect(await readResumedModel("none")).toBeUndefined();
  });
});
