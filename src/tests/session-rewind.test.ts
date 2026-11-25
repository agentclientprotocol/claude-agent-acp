import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appendFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { getSessionMessages, type SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  activeSessionMessages,
  cutAtRewindPoint,
  isRewindRefusal,
  loadRewindableHistory,
  parseSessionRewindRequest,
  pendingRewindEnd,
  prepareRewoundResume,
  readRewindPoint,
  rewindSession,
  withoutRewoundBranch,
  writeRewindPoint,
  type RewindableHistory,
  type SessionRewindHost,
} from "../session-rewind.js";
import { loadFullSessionHistory } from "../resumed-session.js";
import {
  transcriptAssistant,
  transcriptCompactBoundary,
  transcriptCompactSummary,
  transcriptUser,
  writeTranscript,
} from "./helpers.js";

vi.mock("../resumed-session.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../resumed-session.js")>();
  return { ...original, loadFullSessionHistory: vi.fn(original.loadFullSessionHistory) };
});

vi.mock("@anthropic-ai/claude-agent-sdk", async (importOriginal) => {
  const original = await importOriginal<typeof import("@anthropic-ai/claude-agent-sdk")>();
  return { ...original, getSessionMessages: vi.fn(original.getSessionMessages) };
});

const SESSION_ID = "11111111-2222-3333-4444-555555555555";

function user(uuid: string, content: unknown, extra: Record<string, unknown> = {}) {
  return {
    type: "user",
    uuid,
    session_id: SESSION_ID,
    parent_tool_use_id: null,
    parent_agent_id: null,
    message: { role: "user", content },
    ...extra,
  } as unknown as SessionMessage;
}

function assistant(uuid: string, extra: Record<string, unknown> = {}) {
  return {
    type: "assistant",
    uuid,
    session_id: SESSION_ID,
    parent_tool_use_id: null,
    parent_agent_id: null,
    message: { role: "assistant", content: [{ type: "text", text: uuid }] },
    ...extra,
  } as unknown as SessionMessage;
}

/** Three turns. A cursor exists before `u2` and `u3`, and `s1` is a subagent's prompt. */
const visible: SessionMessage[] = [
  user("u1", "first"),
  assistant("a1"),
  user("u2", "second"),
  assistant("a2"),
  user("r1", [{ type: "tool_result", tool_use_id: "t1", content: "ok" }]),
  assistant("a3"),
  user("s1", "subagent task", { parent_tool_use_id: "t2" }),
  user("u3", "third"),
  assistant("a4"),
];

function fakeHost(
  overrides: Partial<SessionRewindHost> = {},
  history: RewindableHistory = { visible, current: visible },
) {
  const replaceQuery = vi.fn<SessionRewindHost["replaceQuery"]>(async () => {});
  const rewound = vi.fn<SessionRewindHost["rewound"]>();
  const abandon = vi.fn<SessionRewindHost["abandon"]>(async (error) => error);
  const host: SessionRewindHost = {
    logger: { log: vi.fn(), error: vi.fn() },
    clearedContext: false,
    claudeIsWorking: () => false,
    hasBackgroundWork: () => false,
    loadHistory: async () => history,
    replaceQuery,
    rewound,
    abandon,
    ...overrides,
  };
  return Object.assign(host, {
    replaceQuery: overrides.replaceQuery ?? replaceQuery,
    rewound: overrides.rewound ?? rewound,
    abandon: overrides.abandon ?? abandon,
  }) as SessionRewindHost & {
    replaceQuery: typeof replaceQuery;
    rewound: typeof rewound;
    abandon: typeof abandon;
  };
}

let configDir: string;

beforeEach(async () => {
  configDir = await mkdtemp(path.join(os.tmpdir(), "session-rewind-"));
  vi.stubEnv("CLAUDE_CONFIG_DIR", configDir);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(configDir, { recursive: true, force: true });
});

const projectDir = () => path.join(configDir, "projects", "project");
const rewindFile = () => path.join(projectDir(), SESSION_ID, "rewind.json");
const exists = (file: string) =>
  stat(file).then(
    () => true,
    () => false,
  );

describe("parseSessionRewindRequest", () => {
  it("takes a session id and a cursor id", () => {
    expect(parseSessionRewindRequest({ sessionId: "s", cursorId: "before:u2" })).toEqual({
      sessionId: "s",
      cursorId: "before:u2",
    });
  });

  it.each([null, "s", {}, { sessionId: "s" }, { cursorId: "c" }, { sessionId: "", cursorId: "c" }])(
    "rejects %j with -32602",
    (params) => {
      expect(() => parseSessionRewindRequest(params)).toThrow(
        expect.objectContaining({ code: -32602 }),
      );
    },
  );
});

describe("rewindSession", () => {
  beforeEach(async () => {
    await writeTranscript(projectDir(), SESSION_ID, [
      transcriptUser("u1", "first"),
      transcriptAssistant("a1", "one"),
      transcriptUser("u2", "second"),
      transcriptAssistant("a2", "two"),
    ]);
  });

  const rewind = (host: SessionRewindHost, cursorId: string) =>
    rewindSession({ sessionId: SESSION_ID, cursorId }, host);

  describe("the position", () => {
    it.each([
      ["a cursor of no session", "before:nope"],
      ["an id that is no cursor", "u2"],
      ["the first message, which has no cursor", "before:u1"],
      ["a tool result", "before:r1"],
      ["a subagent's message", "before:s1"],
      ["an agent message", "before:a2"],
    ])("fails with -32602 for %s and changes nothing", async (_, cursorId) => {
      const host = fakeHost();
      await expect(rewind(host, cursorId)).rejects.toMatchObject({ code: -32602 });
      expect(host.replaceQuery).not.toHaveBeenCalled();
      expect(await readRewindPoint(SESSION_ID)).toBeUndefined();
    });

    it("fails with -32602 for a message before the newest compaction when the history before it cannot be read", async () => {
      await writeTranscript(projectDir(), SESSION_ID, [
        transcriptUser("u1", "first"),
        transcriptAssistant("a1", "one"),
        transcriptUser("u2", "second"),
        transcriptAssistant("a2", "two"),
        transcriptCompactBoundary("b1", "a2"),
        transcriptCompactSummary("s1"),
        transcriptUser("u3", "third"),
        transcriptAssistant("a3", "three"),
      ]);
      const read = vi.mocked(getSessionMessages);
      const original = read.getMockImplementation()!;
      // The read across compactions is the one that gets a session store.
      read.mockImplementation(async (sessionId, options) => {
        if (options?.sessionStore) throw new Error("unreadable");
        return original(sessionId, options);
      });
      try {
        const host = fakeHost({ loadHistory: () => loadRewindableHistory(SESSION_ID) });
        await expect(rewind(host, "before:u2")).rejects.toMatchObject({ code: -32602 });
        expect(host.replaceQuery).not.toHaveBeenCalled();
        expect(await readRewindPoint(SESSION_ID)).toBeUndefined();
      } finally {
        read.mockImplementation(original);
      }
    });

    it("resumes at the entry before the message, and drops that message", async () => {
      const host = fakeHost();
      expect(await rewind(host, "before:u3")).toEqual({ rewound: true });
      // The entry before `u3` is the subagent's prompt `s1`: the stored order.
      expect(host.replaceQuery).toHaveBeenCalledWith({
        resumeSessionAt: "s1",
        resumeDropsTurn: "u3",
      });
    });
  });

  it("reports the cursor that it rewound to", async () => {
    const host = fakeHost();
    await rewind(host, "before:u2");
    expect(host.rewound).toHaveBeenCalledWith("before:u2");
  });

  describe("resumeDropsTurn", () => {
    it("guards the last turn", async () => {
      const host = fakeHost();
      await rewind(host, "before:u3");
      expect(host.replaceQuery).toHaveBeenCalledWith(
        expect.objectContaining({ resumeDropsTurn: "u3" }),
      );
    });

    it("is not passed for an earlier turn: the turns after it are in the dropped range", async () => {
      const host = fakeHost();
      await rewind(host, "before:u2");
      expect(host.replaceQuery).toHaveBeenCalledWith({ resumeSessionAt: "a1" });
    });
  });

  describe("refusals", () => {
    it.each([
      ["busy", { claudeIsWorking: () => true }],
      ["backgroundWork", { hasBackgroundWork: () => true }],
      ["clearedContext", { clearedContext: true }],
    ] as const)("answers %s without touching anything", async (reason, overrides) => {
      const host = fakeHost(overrides);
      expect(await rewind(host, "before:u2")).toEqual({ rewound: false, reason });
      expect(host.replaceQuery).not.toHaveBeenCalled();
      expect(await readRewindPoint(SESSION_ID)).toBeUndefined();
    });

    it("answers beforeCompaction for a message whose predecessor the compaction dropped", async () => {
      const host = fakeHost(
        {},
        { visible, current: visible.filter((message) => message.uuid !== "a1") },
      );
      expect(await rewind(host, "before:u2")).toEqual({
        rewound: false,
        reason: "beforeCompaction",
      });
      expect(host.replaceQuery).not.toHaveBeenCalled();
    });

    it("answers busy when Claude starts a cycle while the history is read", async () => {
      let working = false;
      const host = fakeHost({
        claudeIsWorking: () => working,
        loadHistory: async () => {
          working = true;
          return { visible, current: visible };
        },
      });
      expect(await rewind(host, "before:u2")).toEqual({ rewound: false, reason: "busy" });
      expect(host.replaceQuery).not.toHaveBeenCalled();
    });

    it("answers busy when Claude starts a cycle while the transcript is prepared", async () => {
      let working = false;
      const host = fakeHost({
        claudeIsWorking: () => working,
        loadHistory: async () => {
          // After the history is read and before the transcript preparation ends.
          setImmediate(() => (working = true));
          return { visible, current: visible };
        },
      });
      expect(await rewind(host, "before:u2")).toEqual({ rewound: false, reason: "busy" });
      expect(host.replaceQuery).not.toHaveBeenCalled();
      expect(host.rewound).not.toHaveBeenCalled();
      expect(await readRewindPoint(SESSION_ID)).toBeUndefined();
    });
  });

  describe("the rewind point", () => {
    it("is written before the query is replaced", async () => {
      const host = fakeHost();
      let writtenDuringCut: unknown;
      host.replaceQuery.mockImplementation(async () => {
        writtenDuringCut = await readRewindPoint(SESSION_ID);
      });
      await rewind(host, "before:u2");
      expect(writtenDuringCut).toEqual({ resumeSessionAt: "a1", droppedPromptUuid: "u2" });
      expect(await readRewindPoint(SESSION_ID)).toEqual(writtenDuringCut);
      expect(host.rewound).toHaveBeenCalledTimes(1);
    });

    it("answers persistFailed and leaves the query alone when it cannot be written", async () => {
      vi.stubEnv("CLAUDE_CONFIG_DIR", path.join(configDir, "elsewhere"));
      const host = fakeHost();
      expect(await rewind(host, "before:u2")).toEqual({
        rewound: false,
        reason: "persistFailed",
      });
      expect(host.replaceQuery).not.toHaveBeenCalled();
      expect(host.rewound).not.toHaveBeenCalled();
      expect(host.logger.error).toHaveBeenCalled();
    });

    describe("when the cut does not happen", () => {
      const earlier = { resumeSessionAt: "a1", droppedPromptUuid: "u2" };
      const refusal = new Error("Resume rejected by --resume-drops-turn: queued message");

      it.each([
        ["no point", undefined],
        ["an earlier pending point", earlier],
      ])("restores %s after a failed cut", async (_, previous) => {
        if (previous) await writeRewindPoint(SESSION_ID, previous);
        const before = previous && (await readFile(rewindFile(), "utf8"));
        const host = fakeHost();
        host.replaceQuery.mockRejectedValueOnce(refusal);
        expect(await rewind(host, "before:u3")).toEqual({
          rewound: false,
          reason: "providerRefused",
        });
        expect(await readRewindPoint(SESSION_ID)).toEqual(previous);
        if (before !== undefined) expect(await readFile(rewindFile(), "utf8")).toBe(before);
        expect(host.rewound).not.toHaveBeenCalled();
      });

      it("restores the point before the recovery resumes, which reads it", async () => {
        const host = fakeHost();
        host.replaceQuery.mockRejectedValueOnce(refusal);
        let seenByRecovery: unknown = "unset";
        host.replaceQuery.mockImplementationOnce(async () => {
          seenByRecovery = await readRewindPoint(SESSION_ID);
        });
        await rewind(host, "before:u3");
        expect(seenByRecovery).toBeUndefined();
      });

      it("restores the point when the rewind is abandoned", async () => {
        const host = fakeHost();
        host.replaceQuery.mockRejectedValue(refusal);
        await expect(rewind(host, "before:u3")).rejects.toBe(refusal);
        expect(await exists(rewindFile())).toBe(false);
      });

      it.each([
        ["no point", undefined],
        ["an earlier pending point", earlier],
      ])("restores %s when Claude starts a cycle before the cut", async (_, previous) => {
        if (previous) await writeRewindPoint(SESSION_ID, previous);
        let working = false;
        const host = fakeHost({
          claudeIsWorking: () => working,
          loadHistory: async () => {
            // After the history is read and before the point is written.
            setImmediate(() => setImmediate(() => (working = true)));
            return { visible, current: visible };
          },
        });
        const before = previous && (await readFile(rewindFile(), "utf8"));
        expect(await rewind(host, "before:u3")).toEqual({ rewound: false, reason: "busy" });
        expect(host.replaceQuery).not.toHaveBeenCalled();
        expect(await readRewindPoint(SESSION_ID)).toEqual(previous);
        if (before !== undefined) expect(await readFile(rewindFile(), "utf8")).toBe(before);
      });
    });

    describe("when the point cannot be put back", () => {
      const refusal = new Error("Resume rejected by --resume-drops-turn: queued message");
      /** Replaces `rewind.json` with a directory, which `rm` without `recursive` cannot remove. */
      const blockRemoval = async () => {
        await rm(rewindFile(), { force: true });
        await mkdir(rewindFile());
      };

      it("fails instead of answering busy, when Claude starts a cycle before the cut", async () => {
        let calls = 0;
        const host = fakeHost({
          claudeIsWorking: () => {
            // The second check is the one after the point is written.
            if (++calls < 2) return false;
            rmSync(rewindFile(), { force: true });
            mkdirSync(rewindFile());
            return true;
          },
        });
        await expect(rewind(host, "before:u3")).rejects.toMatchObject({ code: -32603 });
        expect(host.replaceQuery).not.toHaveBeenCalled();
      });

      it("fails after the recovery resume, when the cut fails", async () => {
        const host = fakeHost();
        host.replaceQuery.mockImplementationOnce(async () => {
          await blockRemoval();
          throw refusal;
        });
        await expect(rewind(host, "before:u3")).rejects.toMatchObject({ code: -32603 });
        expect(host.replaceQuery).toHaveBeenCalledTimes(2);
        expect(host.replaceQuery.mock.calls.at(-1)).toEqual([undefined]);
        expect(host.abandon).not.toHaveBeenCalled();
        expect(host.rewound).not.toHaveBeenCalled();
      });
    });

    it("no longer accepts a cursor at or after the cut, and a second rewind works", async () => {
      expect(await rewind(fakeHost(), "before:u2")).toEqual({ rewound: true });

      // The transcript still holds the dropped branch, and the SDK reads it to its end.
      const afterRewind = await loadRewindableHistory(SESSION_ID);
      expect(afterRewind.visible.map((message) => message.uuid)).toEqual(["u1", "a1"]);
      await expect(
        rewindSession({ sessionId: SESSION_ID, cursorId: "before:u2" }, fakeHost({}, afterRewind)),
      ).rejects.toMatchObject({ code: -32602 });

      // The next prompts continue from the cut, as Claude Code writes them.
      const line = (record: Record<string, unknown>) =>
        appendFile(
          path.join(projectDir(), `${SESSION_ID}.jsonl`),
          JSON.stringify({ sessionId: SESSION_ID, isSidechain: false, ...record }) + "\n",
        );
      await line({ ...transcriptUser("n1", "edited"), parentUuid: "a1" });
      await line({ ...transcriptAssistant("n2", "answer"), parentUuid: "n1" });
      await line({ ...transcriptUser("n3", "more"), parentUuid: "n2" });
      await line({ ...transcriptAssistant("n4", "more answer"), parentUuid: "n3" });

      const second = fakeHost();
      const secondHistory = await loadRewindableHistory(SESSION_ID);
      expect(secondHistory.visible.map((message) => message.uuid)).toEqual([
        "u1",
        "a1",
        "n1",
        "n2",
        "n3",
        "n4",
      ]);
      expect(
        await rewind({ ...second, loadHistory: async () => secondHistory }, "before:n3"),
      ).toEqual({ rewound: true });
      expect(second.replaceQuery).toHaveBeenCalledWith({
        resumeSessionAt: "n2",
        resumeDropsTurn: "n3",
      });
    });
  });

  describe("recovery", () => {
    const refusal = new Error(
      "Resume rejected by --resume-drops-turn: the range holds a queued message",
    );

    it.each([
      ["a refusal of the cut", refusal],
      ["a failed restart", new Error("spawn failed")],
    ])("recovers once into the untruncated conversation after %s", async (_, error) => {
      const host = fakeHost();
      host.replaceQuery.mockRejectedValueOnce(error);
      expect(await rewind(host, "before:u3")).toEqual({
        rewound: false,
        reason: "providerRefused",
      });
      expect(host.replaceQuery.mock.calls).toEqual([
        [{ resumeSessionAt: "s1", resumeDropsTurn: "u3" }],
        [undefined],
      ]);
      expect(host.abandon).not.toHaveBeenCalled();
      expect(await exists(rewindFile())).toBe(false);
    });

    it("recovers into the cut that an earlier rewind made", async () => {
      await writeRewindPoint(SESSION_ID, { resumeSessionAt: "a1", droppedPromptUuid: "u2" });
      const host = fakeHost();
      host.replaceQuery.mockRejectedValueOnce(refusal);
      await rewind(host, "before:u3");
      expect(host.replaceQuery.mock.calls.at(-1)).toEqual([{ resumeSessionAt: "a1" }]);
    });

    it("fails with what abandon returns when the recovery fails too", async () => {
      const failure = new Error("could not resume");
      const host = fakeHost({ abandon: vi.fn(async () => failure) });
      host.replaceQuery.mockRejectedValue(refusal);
      await expect(rewind(host, "before:u3")).rejects.toBe(failure);
      expect(host.replaceQuery).toHaveBeenCalledTimes(2);
      expect(host.abandon).toHaveBeenCalledWith(refusal);
    });
  });
});

describe("isRewindRefusal", () => {
  it("matches the message prefix of the CLI's refusal only", () => {
    expect(isRewindRefusal(new Error("Resume rejected by --resume-drops-turn: x"))).toBe(true);
    expect(isRewindRefusal(new Error("No message found with message.uuid of x"))).toBe(false);
  });
});

describe("activeSessionMessages", () => {
  const history = visible.slice(0, 4);

  it("cuts a history that still ends in the dropped branch", () => {
    expect(
      activeSessionMessages(history, { resumeSessionAt: "a1", droppedPromptUuid: "u2" }).map(
        (message) => message.uuid,
      ),
    ).toEqual(["u1", "a1"]);
  });

  it.each([
    ["no rewind point", undefined],
    [
      "a point whose dropped prompt a later branch left out",
      { resumeSessionAt: "a1", droppedPromptUuid: "gone" },
    ],
  ])("returns the history as it is for %s", (_, point) => {
    expect(activeSessionMessages(history, point)).toEqual(history);
  });
});

describe("prepareRewoundResume", () => {
  const lastPrompts = async () =>
    (await readFile(path.join(projectDir(), `${SESSION_ID}.jsonl`), "utf8"))
      .split("\n")
      .filter((line) => line.includes('"last-prompt"'))
      .map((line) => JSON.parse(line));

  beforeEach(async () => {
    await writeTranscript(projectDir(), SESSION_ID, [
      transcriptUser("u1", "first"),
      transcriptAssistant("a1", "one"),
      transcriptUser("u2", "second"),
      transcriptAssistant("a2", "two"),
    ]);
  });

  it("does nothing for a session that was never rewound", async () => {
    expect(await prepareRewoundResume(SESSION_ID)).toBeUndefined();
    expect(await lastPrompts()).toEqual([]);
  });

  it("names the rewind point explicitly while the dropped branch is the newest", async () => {
    await writeRewindPoint(SESSION_ID, { resumeSessionAt: "a1", droppedPromptUuid: "u2" });
    expect(await prepareRewoundResume(SESSION_ID)).toBe("a1");
    expect(await lastPrompts()).toEqual([
      {
        type: "last-prompt",
        lastPrompt: "first",
        leafUuid: "a1",
        explicit: true,
        sessionId: SESSION_ID,
      },
    ]);
    expect(await readRewindPoint(SESSION_ID)).toBeDefined();
  });

  it("names the newest entry and removes the point once a branch descends from it", async () => {
    await writeRewindPoint(SESSION_ID, { resumeSessionAt: "a1", droppedPromptUuid: "u2" });
    await appendFile(
      path.join(projectDir(), `${SESSION_ID}.jsonl`),
      JSON.stringify({
        ...transcriptUser("n1", "edited"),
        parentUuid: "a1",
        sessionId: SESSION_ID,
      }) + "\n",
    );
    expect(await prepareRewoundResume(SESSION_ID)).toBeUndefined();
    expect(await lastPrompts()).toEqual([
      { type: "last-prompt", lastPrompt: "edited", leafUuid: "n1", sessionId: SESSION_ID },
    ]);
    expect(await readRewindPoint(SESSION_ID)).toBeUndefined();
  });
});

describe("prepareRewoundResume with trailing metadata and failures", () => {
  const transcript = () => path.join(projectDir(), `${SESSION_ID}.jsonl`);

  beforeEach(async () => {
    await writeTranscript(projectDir(), SESSION_ID, [
      transcriptUser("u1", "first"),
      transcriptAssistant("a1", "one"),
      transcriptUser("u2", "second"),
      transcriptAssistant("a2", "two"),
    ]);
    await writeRewindPoint(SESSION_ID, { resumeSessionAt: "a1", droppedPromptUuid: "u2" });
    await appendFile(
      transcript(),
      [
        { ...transcriptUser("n1", "edited"), parentUuid: "a1", sessionId: SESSION_ID },
        { ...transcriptAssistant("n2", "answer"), parentUuid: "n1", sessionId: SESSION_ID },
        { type: "ai-title", uuid: "t1", aiTitle: "A title", sessionId: SESSION_ID },
        { type: "tag", uuid: "t2", tag: "x", sessionId: SESSION_ID },
      ]
        .map((record) => JSON.stringify(record))
        .join("\n") + "\n",
    );
  });

  it("keeps the edited conversation when uuid-bearing metadata follows it", async () => {
    expect(await prepareRewoundResume(SESSION_ID)).toBeUndefined();
    expect(await readRewindPoint(SESSION_ID)).toBeUndefined();
    const lastPrompt = (await readFile(transcript(), "utf8"))
      .split("\n")
      .filter((line) => line.includes('"last-prompt"'))
      .map((line) => JSON.parse(line))
      .at(-1);
    expect(lastPrompt).toMatchObject({ leafUuid: "n2" });
    expect(lastPrompt.explicit).toBeUndefined();
  });

  it("fails the resume instead of resuming plainly when the history cannot be read", async () => {
    vi.mocked(loadFullSessionHistory).mockRejectedValueOnce(new Error("EIO"));
    await expect(prepareRewoundResume(SESSION_ID)).rejects.toMatchObject({
      message: expect.stringContaining("could not be prepared"),
    });
    expect(await readRewindPoint(SESSION_ID)).toBeDefined();
  });

  describe.each([
    [
      "cannot be read",
      async () => {
        await rm(rewindFile(), { force: true });
        await mkdir(rewindFile());
      },
    ],
    ["is not JSON", () => writeFile(rewindFile(), "{ not json")],
    ["lacks the cut", () => writeFile(rewindFile(), JSON.stringify({ resumeSessionAt: "a1" }))],
  ])("a rewind point that %s", (_, corrupt) => {
    beforeEach(corrupt);

    it("fails the resume, and leaves the transcript and the point alone", async () => {
      const before = await readFile(transcript(), "utf8");
      await expect(prepareRewoundResume(SESSION_ID)).rejects.toMatchObject({
        message: expect.stringContaining("rewind point cannot be read"),
      });
      expect(await readFile(transcript(), "utf8")).toBe(before);
      expect(await exists(rewindFile())).toBe(true);
    });

    it("fails the replay, the fork reads and the rewind instead of showing the dropped turns", async () => {
      const stored = await getSessionMessages(SESSION_ID);
      await expect(cutAtRewindPoint(SESSION_ID, stored)).rejects.toThrow("cannot be read");
      await expect(pendingRewindEnd(SESSION_ID)).rejects.toThrow("cannot be read");
      await expect(withoutRewoundBranch(SESSION_ID, [])).rejects.toThrow("cannot be read");
      await expect(readRewindPoint(SESSION_ID)).rejects.toThrow("cannot be read");
    });
  });

  it("is unaffected by a failing history read when there is no rewind point", async () => {
    await rm(rewindFile(), { force: true });
    vi.mocked(loadFullSessionHistory).mockRejectedValueOnce(new Error("EIO"));
    expect(await prepareRewoundResume(SESSION_ID)).toBeUndefined();
    vi.mocked(loadFullSessionHistory).mockReset();
  });
});

describe("a pending rewind point", () => {
  const point = { resumeSessionAt: "a2", droppedPromptUuid: "u3" };

  beforeEach(async () => {
    await writeTranscript(projectDir(), SESSION_ID, [
      transcriptUser("u1", "first"),
      transcriptAssistant("a1", "one"),
      transcriptUser("u2", "second"),
      transcriptAssistant("a2", "two"),
      transcriptUser("u3", "third"),
      transcriptAssistant("a3", "three"),
    ]);
  });

  it("is cut from the stored history, and from nothing else once it is not pending", async () => {
    const stored = await getSessionMessages(SESSION_ID);
    expect(stored.map((message) => message.uuid)).toEqual(["u1", "a1", "u2", "a2", "u3", "a3"]);
    expect(await cutAtRewindPoint(SESSION_ID, stored)).toHaveLength(6);

    await writeRewindPoint(SESSION_ID, point);
    expect((await cutAtRewindPoint(SESSION_ID, stored)).map((message) => message.uuid)).toEqual([
      "u1",
      "a1",
      "u2",
      "a2",
    ]);
  });

  it("is cut before the history of a compaction is read", async () => {
    await writeTranscript(projectDir(), SESSION_ID, [
      transcriptUser("u1", "first"),
      transcriptAssistant("a1", "one"),
      transcriptCompactBoundary("b1", "a1"),
      transcriptCompactSummary("s1"),
      transcriptUser("u2", "second"),
      transcriptAssistant("a2", "two"),
      transcriptUser("u3", "third"),
      transcriptAssistant("a3", "three"),
    ]);
    const uuids = async () =>
      (await loadRewindableHistory(SESSION_ID)).visible.map((message) => message.uuid);
    expect(await uuids()).toEqual(["u1", "a1", "s1", "u2", "a2", "u3", "a3"]);

    await writeRewindPoint(SESSION_ID, point);
    const history = await loadRewindableHistory(SESSION_ID);
    expect(history.visible.map((message) => message.uuid)).toEqual(["u1", "a1", "s1", "u2", "a2"]);
    expect(history.current.map((message) => message.uuid)).toEqual(["s1", "u2", "a2"]);
  });

  it("ends a fork of the whole session at its resume entry, until a branch descends from it", async () => {
    expect(await pendingRewindEnd(SESSION_ID)).toBeUndefined();
    await writeRewindPoint(SESSION_ID, point);
    expect(await pendingRewindEnd(SESSION_ID)).toBe("a2");

    await appendFile(
      path.join(projectDir(), `${SESSION_ID}.jsonl`),
      JSON.stringify({
        ...transcriptUser("n1", "edited"),
        parentUuid: "a2",
        sessionId: SESSION_ID,
      }) + "\n",
    );
    expect(await pendingRewindEnd(SESSION_ID)).toBeUndefined();
  });

  it("leaves out the dropped branch of the full history, and keeps the other inactive ones", async () => {
    await appendFile(
      path.join(projectDir(), `${SESSION_ID}.jsonl`),
      JSON.stringify({
        ...transcriptAssistant("alt", "older branch"),
        parentUuid: "u2",
        sessionId: SESSION_ID,
      }) + "\n",
    );
    const full = await loadFullSessionHistory(SESSION_ID);
    const uuids = async () =>
      (await withoutRewoundBranch(SESSION_ID, full)).flatMap((entry) =>
        typeof entry.uuid === "string" ? [entry.uuid] : [],
      );
    expect(await uuids()).toEqual(["u1", "a1", "u2", "a2", "u3", "a3", "alt"]);

    await writeRewindPoint(SESSION_ID, point);
    expect(await uuids()).toEqual(["u1", "a1", "u2", "a2", "alt"]);
  });
});
