import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ForkHistoryStore,
  forkedSessionHistory,
  forkPointResumeTarget,
  forkResumeTarget,
} from "../fork-history.js";

type Message = { id: string; text: string; uuid?: string };

const temporaryDirectories: string[] = [];

async function store(): Promise<ForkHistoryStore> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "claude-acp-fork-history-"));
  temporaryDirectories.push(directory);
  return new ForkHistoryStore(directory);
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

async function history(
  sessionId: string,
  lineages: ForkHistoryStore,
  transcripts: Record<string, Message[]>,
): Promise<Message[]> {
  return forkedSessionHistory(
    sessionId,
    lineages,
    async (id) => transcripts[id] ?? [],
    (message) => message.id,
  );
}

async function resumeTarget(
  sessionId: string,
  lineages: ForkHistoryStore,
  transcripts: Record<string, Message[]>,
) {
  return forkResumeTarget(sessionId, lineages, async (id) => transcripts[id] ?? []);
}

async function pointResumeTarget(
  sessionId: string,
  branchPoint: string,
  lineages: ForkHistoryStore,
  transcripts: Record<string, Message[]>,
) {
  return forkPointResumeTarget(
    sessionId,
    branchPoint,
    lineages,
    async (id) => transcripts[id] ?? [],
    (message) => message.id,
    (message) => message.uuid,
  );
}

describe("fork history", () => {
  it("prepends a full parent transcript and keeps the fork's later messages", async () => {
    const lineages = await store();
    await lineages.record({ sessionId: "fork", parentSessionId: "parent" });

    await expect(
      history("fork", lineages, {
        parent: [
          { id: "u1", text: "first" },
          { id: "a1", text: "first answer" },
        ],
        fork: [{ id: "u2", text: "new branch prompt" }],
      }),
    ).resolves.toEqual([
      { id: "u1", text: "first" },
      { id: "a1", text: "first answer" },
      { id: "u2", text: "new branch prompt" },
    ]);
  });

  it("stops a point fork at the selected inherited message", async () => {
    const lineages = await store();
    await lineages.record({ sessionId: "fork", parentSessionId: "parent", branchPoint: "u2" });

    await expect(
      history("fork", lineages, {
        parent: [
          { id: "u1", text: "first" },
          { id: "a1", text: "first answer" },
          { id: "u2", text: "try another approach" },
          { id: "a2", text: "old answer that is not inherited" },
        ],
        fork: [{ id: "a3", text: "new branch answer" }],
      }),
    ).resolves.toEqual([
      { id: "u1", text: "first" },
      { id: "a1", text: "first answer" },
      { id: "u2", text: "try another approach" },
      { id: "a3", text: "new branch answer" },
    ]);
  });

  it("resolves a point fork from a previously forked session", async () => {
    const lineages = await store();
    await lineages.record({ sessionId: "first-fork", parentSessionId: "root" });
    await lineages.record({
      sessionId: "second-fork",
      parentSessionId: "first-fork",
      branchPoint: "u2",
    });

    await expect(
      history("second-fork", lineages, {
        root: [{ id: "u1", text: "root prompt" }],
        "first-fork": [
          { id: "a1", text: "root answer" },
          { id: "u2", text: "fork prompt" },
          { id: "a2", text: "fork answer not inherited" },
        ],
        "second-fork": [{ id: "a3", text: "second fork answer" }],
      }),
    ).resolves.toEqual([
      { id: "u1", text: "root prompt" },
      { id: "a1", text: "root answer" },
      { id: "u2", text: "fork prompt" },
      { id: "a3", text: "second fork answer" },
    ]);
  });

  it("resumes an empty nested fork through its nearest persisted ancestor", async () => {
    const lineages = await store();
    await lineages.record({
      sessionId: "first-fork",
      parentSessionId: "root",
      branchPoint: "a1",
    });
    await lineages.record({ sessionId: "second-fork", parentSessionId: "first-fork" });

    await expect(
      resumeTarget("second-fork", lineages, {
        root: [
          { id: "u1", text: "root prompt" },
          { id: "a1", text: "root answer" },
        ],
        "first-fork": [],
        "second-fork": [],
      }),
    ).resolves.toEqual({ sessionId: "root", branchPoint: "a1" });
  });

  it("uses a new nested point instead of the inherited boundary", async () => {
    const lineages = await store();
    await lineages.record({
      sessionId: "first-fork",
      parentSessionId: "root",
      branchPoint: "a2",
    });
    await lineages.record({
      sessionId: "second-fork",
      parentSessionId: "first-fork",
      branchPoint: "a1",
    });

    await expect(
      resumeTarget("second-fork", lineages, {
        root: [
          { id: "u1", text: "root prompt" },
          { id: "a1", text: "first answer" },
          { id: "u2", text: "second prompt" },
          { id: "a2", text: "second answer" },
        ],
        "first-fork": [],
        "second-fork": [],
      }),
    ).resolves.toEqual({ sessionId: "root", branchPoint: "a1" });
  });

  it("resolves an ACP assistant id to the final SDK uuid in its owning session", async () => {
    const lineages = await store();

    await expect(
      pointResumeTarget("parent", "msg_answer", lineages, {
        parent: [
          { id: "msg_answer", uuid: "thinking-uuid", text: "thinking" },
          { id: "msg_answer", uuid: "answer-uuid", text: "answer" },
        ],
      }),
    ).resolves.toEqual({ sessionId: "parent", messageUuid: "answer-uuid" });
  });

  it("finds the owning parent when point-forking an inherited response", async () => {
    const lineages = await store();
    await lineages.record({ sessionId: "fork", parentSessionId: "parent" });

    await expect(
      pointResumeTarget("fork", "msg_parent_answer", lineages, {
        parent: [{ id: "msg_parent_answer", uuid: "parent-answer-uuid", text: "answer" }],
        fork: [{ id: "msg_fork_answer", uuid: "fork-answer-uuid", text: "new answer" }],
      }),
    ).resolves.toEqual({ sessionId: "parent", messageUuid: "parent-answer-uuid" });
  });

  it("finds an inherited boundary through empty nested forks", async () => {
    const lineages = await store();
    await lineages.record({
      sessionId: "first-fork",
      parentSessionId: "root",
      branchPoint: "msg_root_answer",
    });
    await lineages.record({ sessionId: "second-fork", parentSessionId: "first-fork" });

    await expect(
      pointResumeTarget("second-fork", "msg_root_answer", lineages, {
        root: [{ id: "msg_root_answer", uuid: "root-answer-uuid", text: "root answer" }],
        "first-fork": [],
        "second-fork": [],
      }),
    ).resolves.toEqual({ sessionId: "root", messageUuid: "root-answer-uuid" });
  });

  it("rejects a point absent from the complete fork lineage", async () => {
    const lineages = await store();
    await lineages.record({ sessionId: "fork", parentSessionId: "parent" });

    await expect(
      pointResumeTarget("fork", "msg_missing", lineages, {
        parent: [{ id: "msg_parent", uuid: "parent-uuid", text: "answer" }],
        fork: [],
      }),
    ).rejects.toThrow("Fork boundary msg_missing is absent from session parent and its ancestors");
  });

  it("persists the lineage across agent processes", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "claude-acp-fork-history-"));
    temporaryDirectories.push(directory);
    const forkId = randomUUID();
    await new ForkHistoryStore(directory).record({
      sessionId: forkId,
      parentSessionId: "parent",
      branchPoint: "u1",
    });

    await expect(new ForkHistoryStore(directory).read(forkId)).resolves.toEqual({
      version: 1,
      sessionId: forkId,
      parentSessionId: "parent",
      branchPoint: "u1",
    });
  });

  it("removes the lineage when its forked session is deleted", async () => {
    const lineages = await store();
    await lineages.record({ sessionId: "fork", parentSessionId: "parent" });
    await expect(lineages.read("fork")).resolves.toEqual({
      version: 1,
      sessionId: "fork",
      parentSessionId: "parent",
    });
    await lineages.remove("fork");
    await expect(lineages.read("fork")).resolves.toBeUndefined();
  });
});
