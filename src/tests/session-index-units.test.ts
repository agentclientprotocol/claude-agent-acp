import { describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { deriveActivity, selectCost } from "../session-index/activity.js";
import { LiveSessionRegistry } from "../session-index/live-registry.js";
import {
  encodeProjectPath,
  isSessionId,
  pathAndAncestors,
  projectDirMatches,
} from "../session-index/project-dirs.js";
import {
  decodeListCursor,
  encodeListCursor,
  parseListOptions,
  parseRenameSessionRequest,
  type ListScope,
} from "../session-index/service.js";
import {
  effectiveTitle,
  isArchivedTitle,
  storedTitle,
  titleRecords,
  visibleTitle,
} from "../session-index/archive-title.js";
import {
  continuedInSessionId,
  readHeadTail,
  scanTranscript,
  scanTranscriptFile,
  sdkTitles,
  transcriptAgentName,
  type TranscriptFacts,
} from "../session-index/transcript-scan.js";
import { firstPrompt } from "../session-index/first-prompt.js";
import { DirListings, statFiles } from "../session-index/dir-listing.js";
import { SessionIndex } from "../session-index/session-index.js";

const SESSION = "11111111-1111-4111-8111-111111111111";
const lines = (...entries: object[]) => entries.map((entry) => JSON.stringify(entry)).join("\n");
const scan = (text: string) => scanTranscript({ head: text, tail: text });

const user = (text: string, timestamp: string, extra: object = {}) => ({
  type: "user",
  sessionId: SESSION,
  timestamp,
  message: { role: "user", content: text },
  ...extra,
});
const assistant = (stopReason: string | null, timestamp: string, extra: object = {}) => ({
  type: "assistant",
  sessionId: SESSION,
  timestamp,
  message: { role: "assistant", content: [{ type: "text", text: "ok" }], stop_reason: stopReason },
  ...extra,
});

describe("project directory encoding", () => {
  it("matches the SDK encoding and never decodes", () => {
    expect(encodeProjectPath("/Users/me/repo.x")).toBe("-Users-me-repo-x");
    expect(projectDirMatches("-Users-me-repo-x", "/Users/me/repo.x")).toBe(true);
    expect(projectDirMatches("-Users-me-repo-x", "/Users/me/repo")).toBe(false);
  });

  it("matches a long path by its cut prefix, whatever the hash", () => {
    const long = `/${"a".repeat(250)}`;
    const encoded = encodeProjectPath(long);
    expect(encoded.length).toBeGreaterThan(200);
    expect(projectDirMatches(`${encoded.slice(0, 200)}-otherhash`, long)).toBe(true);
  });

  it("lists a path and its ancestors", () => {
    expect(pathAndAncestors("/a/b")).toEqual(["/a/b", "/a", "/"]);
  });

  it("accepts only UUID session ids", () => {
    expect(isSessionId(SESSION)).toBe(true);
    expect(isSessionId("../etc/passwd")).toBe(false);
    expect(isSessionId("agent-123")).toBe(false);
  });
});

describe("transcript scan", () => {
  it("reads a small transcript only up to the size it was stat'ed at", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "head-tail-"));
    const file = path.join(dir, "t.jsonl");
    const size = Buffer.byteLength("first\n");
    await fs.writeFile(file, "first\nappended later\n");
    expect(await readHeadTail(file, size)).toEqual({ head: "first\n", tail: "first\n" });
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("sees a finished turn at an assistant end_turn", () => {
    const facts = scan(
      lines(user("hi", "2026-01-01T00:00:00Z"), assistant("end_turn", "2026-01-01T00:00:05Z")),
    );
    expect(facts.turnState).toBe("finished");
    expect(facts.lastTurnEndedAt).toBe(Date.parse("2026-01-01T00:00:05Z"));
    expect(facts.lastMessageAt).toBe(Date.parse("2026-01-01T00:00:05Z"));
    expect(facts.hasMessages).toBe(true);
  });

  it("sees a turn end at an interrupt, an API error, and the turn-end system records", () => {
    expect(
      scan(lines(user("[Request interrupted by user]", "2026-01-01T00:00:00Z"))).turnState,
    ).toBe("finished");
    expect(
      scan(lines(assistant(null, "2026-01-01T00:00:00Z", { isApiErrorMessage: true }))).turnState,
    ).toBe("finished");
    const hook = scan(
      lines(assistant("tool_use", "2026-01-01T00:00:00Z"), {
        type: "system",
        subtype: "stop_hook_summary",
        timestamp: "2026-01-01T00:00:09Z",
      }),
    );
    expect(hook.turnState).toBe("finished");
    expect(hook.lastTurnEndedAt).toBe(Date.parse("2026-01-01T00:00:09Z"));
  });

  it("sees an unfinished turn and keeps the previous turn end", () => {
    const facts = scan(
      lines(
        assistant("end_turn", "2026-01-01T00:00:01Z"),
        user("next", "2026-01-01T00:00:02Z"),
        assistant("tool_use", "2026-01-01T00:00:03Z"),
        { type: "custom-title", customTitle: "x", sessionId: SESSION },
      ),
    );
    expect(facts.turnState).toBe("unfinished");
    expect(facts.lastTurnEndedAt).toBe(Date.parse("2026-01-01T00:00:01Z"));
    expect(facts.lastMessageAt).toBe(Date.parse("2026-01-01T00:00:03Z"));
  });

  it("ignores sidechain and meta records", () => {
    const facts = scan(
      lines(
        assistant("end_turn", "2026-01-01T00:00:01Z"),
        user("meta", "2026-01-01T00:00:02Z", { isMeta: true }),
        assistant("tool_use", "2026-01-01T00:00:03Z", { isSidechain: true }),
      ),
    );
    expect(facts.turnState).toBe("finished");
  });

  it("reads no cost from a transcript", () => {
    const facts = scan(
      lines(user("hello", "2026-01-01T00:00:01.000Z"), {
        type: "cost-state",
        sessionId: SESSION,
        totalCostUSD: 1.5,
      }),
    );
    expect(facts).not.toHaveProperty("costUsd");
  });

  it("reports the head cwd and the last tail cwd, and a stub without messages", () => {
    const facts = scanTranscript({
      head: lines({ type: "queue-operation" }, { type: "attachment", cwd: "/repo" }),
      tail: lines({ type: "attachment", cwd: "/repo/sub" }, { type: "last-prompt" }),
    });
    expect(facts.headCwd).toBe("/repo");
    expect(facts.tailCwd).toBe("/repo/sub");
    expect(facts.hasMessages).toBe(false);
  });

  it('takes a prompt whose text is "tool_result" for a prompt', () => {
    const facts = scan(
      lines(
        user("tool_result", "2026-01-01T00:00:01.000Z"),
        assistant("end_turn", "2026-01-01T00:00:02.000Z"),
      ),
    );
    expect(facts.lastPromptAt).toBe(Date.parse("2026-01-01T00:00:01.000Z"));
  });

  it("finds the model and cwd before a tail that is one large tool result", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "si-scan-"));
    try {
      const file = path.join(dir, `${SESSION}.jsonl`);
      const text =
        lines(
          user("hello", "2026-01-01T00:00:01.000Z", { cwd: "/repo" }),
          assistant("tool_use", "2026-01-01T00:00:02.000Z", {
            cwd: "/repo",
            message: {
              role: "assistant",
              model: "claude-model-x",
              stop_reason: "tool_use",
              content: [],
            },
          }),
          {
            type: "user",
            sessionId: SESSION,
            timestamp: "2026-01-01T00:00:03.000Z",
            message: {
              role: "user",
              content: [{ type: "tool_result", tool_use_id: "t1", content: "x".repeat(200_000) }],
            },
          },
        ) + "\n";
      await fs.writeFile(file, text);
      const facts = await scanTranscriptFile(file, Buffer.byteLength(text));
      expect(facts.model).toBe("claude-model-x");
      expect(facts.tailCwd).toBe("/repo");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe("activity", () => {
  const now = Date.parse("2026-01-01T01:00:00Z");
  const facts = (overrides: Partial<TranscriptFacts> = {}): TranscriptFacts => ({
    hasMessages: true,
    ...overrides,
  });

  it("reports the SDK state of a session this connection runs", () => {
    expect(
      deriveActivity({
        own: { state: "requires_action", lastTurnEndedAt: now - 1000 },
        facts: facts({ lastTurnEndedAt: 1 }),
        transcriptMtimeMs: now,
        now,
      }),
    ).toEqual({ state: "requires_action", lastTurnEndedAt: new Date(now - 1000).toISOString() });
    expect(deriveActivity({ own: {}, facts: facts(), transcriptMtimeMs: now, now })).toEqual({
      state: "idle",
    });
  });

  it("is error after a turn that ended with an API error, until a new turn", () => {
    const errorFacts = scan(
      lines(
        user("hi", "2026-01-01T00:00:00Z"),
        assistant(null, "2026-01-01T00:00:05Z", { isApiErrorMessage: true }),
      ),
    );
    expect(errorFacts.lastTurnError).toBe(true);
    const at = { transcriptMtimeMs: now, now };
    expect(deriveActivity({ facts: errorFacts, ...at })?.state).toBe("error");
    // A user interrupt is no error.
    const interrupted = scan(
      lines(
        user("hi", "2026-01-01T00:00:00Z"),
        user("[Request interrupted by user]", "2026-01-01T00:00:05Z"),
      ),
    );
    expect(interrupted.lastTurnError).toBeUndefined();
    expect(deriveActivity({ facts: interrupted, ...at })?.state).toBe("idle");
    // A prompt after the error starts a new turn.
    const again = scan(
      lines(
        user("hi", "2026-01-01T00:00:00Z"),
        assistant(null, "2026-01-01T00:00:05Z", { isApiErrorMessage: true }),
        user("again", "2026-01-01T00:00:09Z"),
      ),
    );
    expect(again.lastTurnError).toBeUndefined();
    expect(deriveActivity({ facts: again, ...at })?.state).toBe("idle");
    // A busy or waiting CLI wins; an idle one shows the error.
    const live = (status: string) => ({
      pid: 1,
      sessionId: "s",
      kind: "interactive",
      entrypoint: "cli",
      status,
      statusUpdatedAt: now,
    });
    const held = { facts: errorFacts, transcriptMtimeMs: now - 1, now };
    expect(deriveActivity({ live: live("busy"), ...held })?.state).toBe("running");
    expect(deriveActivity({ live: live("waiting"), ...held })?.state).toBe("requires_action");
    expect(deriveActivity({ live: live("idle"), ...held })?.state).toBe("error");
    // A session that runs here: its own failed turn, while idle.
    expect(
      deriveActivity({ own: { state: "idle", lastTurnFailed: true }, facts: facts(), ...at })
        ?.state,
    ).toBe("error");
    expect(
      deriveActivity({ own: { state: "running", lastTurnFailed: true }, facts: facts(), ...at })
        ?.state,
    ).toBe("running");
    expect(deriveActivity({ own: { state: "idle" }, facts: errorFacts, ...at })?.state).toBe(
      "idle",
    );
    // The API error behind the CLI's turn-end records.
    const behindTurnEnd = scan(
      lines(
        user("hi", "2026-01-01T00:00:00Z"),
        assistant(null, "2026-01-01T00:00:05Z", { isApiErrorMessage: true }),
        { type: "system", subtype: "turn_duration", timestamp: "2026-01-01T00:00:06Z" },
        { type: "system", subtype: "stop_hook_summary", timestamp: "2026-01-01T00:00:06Z" },
      ),
    );
    expect(behindTurnEnd.lastTurnError).toBe(true);
    // A query that failed here: error until the transcript changes, and a
    // busy CLI still wins.
    const unfinished = facts({ turnState: "unfinished" });
    const failedHere = { own: { queryFailedAt: now }, facts: unfinished, now };
    expect(deriveActivity({ ...failedHere, transcriptMtimeMs: now - 1 })?.state).toBe("error");
    expect(deriveActivity({ ...failedHere, transcriptMtimeMs: now + 60_000 })?.state).toBe("error");
    // A turn that ended after the failure (another process resumed it).
    const resumed = facts({ turnState: "finished", lastTurnEndedAt: now + 2000 });
    expect(
      deriveActivity({
        own: { queryFailedAt: now },
        facts: resumed,
        transcriptMtimeMs: now + 2000,
        now,
      })?.state,
    ).toBe("idle");
    expect(
      deriveActivity({ ...failedHere, live: live("busy"), transcriptMtimeMs: now - 1 })?.state,
    ).toBe("running");
  });

  it("is idle when no live process holds the session", () => {
    expect(
      deriveActivity({ facts: facts({ turnState: "unfinished" }), transcriptMtimeMs: now, now }),
    ).toEqual({ state: "idle" });
  });

  it("uses the registry status of an interactive CLI newer than the transcript", () => {
    const live = {
      pid: 1,
      sessionId: "s",
      kind: "interactive",
      entrypoint: "cli",
      status: "waiting",
      statusUpdatedAt: now,
    };
    expect(deriveActivity({ live, facts: facts(), transcriptMtimeMs: now - 1, now })?.state).toBe(
      "requires_action",
    );
    expect(
      deriveActivity({
        live: { ...live, status: "busy" },
        facts: facts(),
        transcriptMtimeMs: now - 1,
        now,
      })?.state,
    ).toBe("running");
    // Older than the transcript: the tail decides.
    expect(
      deriveActivity({
        live,
        facts: facts({ turnState: "finished" }),
        transcriptMtimeMs: now + 1,
        now,
      })?.state,
    ).toBe("idle");
  });

  it("reads the tail for an SDK-driven CLI, whose registry stays busy", () => {
    const live = {
      pid: 1,
      sessionId: "s",
      kind: "interactive",
      entrypoint: "sdk-ts",
      status: "busy",
      statusUpdatedAt: now,
    };
    const base = { live, transcriptMtimeMs: now - 60_000, now };
    expect(deriveActivity({ ...base, facts: facts({ turnState: "finished" }) })?.state).toBe(
      "idle",
    );
    expect(deriveActivity({ ...base, facts: facts({ turnState: "unfinished" }) })?.state).toBe(
      "running",
    );
    // An unfinished turn that has not written for 10 minutes has no known state.
    expect(
      deriveActivity({
        ...base,
        transcriptMtimeMs: now - 11 * 60_000,
        facts: facts({ turnState: "unfinished" }),
      }),
    ).toBeUndefined();
  });
});

describe("cost", () => {
  it("is the SDK's amount of a session that runs here, and only a positive one", () => {
    expect(selectCost({ costUsd: 2 })).toBe(2);
    expect(selectCost({ costUsd: 0 })).toBeUndefined();
    expect(selectCost({ costUsd: Number.NaN })).toBeUndefined();
    // No SDK result yet, or a session that does not run here: no cost.
    expect(selectCost({ state: "idle" })).toBeUndefined();
    expect(selectCost(undefined)).toBeUndefined();
  });
});

describe("list request parsing", () => {
  const meta = (list: object) => ({ jetbrains: { air: { version: 1, list } } });

  it("defaults and clamps the limit", () => {
    expect(parseListOptions(undefined)).toEqual({
      limit: 50,
      archived: "unarchived",
      includeWorktrees: false,
    });
    expect(parseListOptions(meta({ limit: null })).limit).toBe(50);
    expect(parseListOptions(meta({ limit: 1 })).limit).toBe(1);
    expect(parseListOptions(meta({ limit: 1000 })).limit).toBe(200);
    for (const limit of ["1", 1.5, 0, -3, Number.NaN, Number.POSITIVE_INFINITY, true, {}]) {
      expect(() => parseListOptions(meta({ limit }))).toThrow(
        expect.objectContaining({ code: -32602 }),
      );
    }
  });

  it("takes includeWorktrees as a boolean and archived as a filter value, null as the default", () => {
    expect(parseListOptions(meta({ includeWorktrees: true })).includeWorktrees).toBe(true);
    expect(parseListOptions(meta({ includeWorktrees: null })).includeWorktrees).toBe(false);
    expect(() => parseListOptions(meta({ includeWorktrees: "yes" }))).toThrow(
      expect.objectContaining({ code: -32602 }),
    );
    for (const archived of ["unarchived", "archived", "all"]) {
      expect(parseListOptions(meta({ archived })).archived).toBe(archived);
    }
    expect(parseListOptions(meta({ archived: null })).archived).toBe("unarchived");
    expect(parseListOptions(meta({})).archived).toBe("unarchived");
    for (const archived of [true, false, "only", "ALL", "Archived", "", 1, "true", {}, []]) {
      expect(() => parseListOptions(meta({ archived }))).toThrow(
        expect.objectContaining({ code: -32602 }),
      );
    }
  });

  it("round-trips a cursor and rejects one of another scope", () => {
    const scope: ListScope = { cwd: "/repo", archived: "unarchived", includeWorktrees: false };
    const cursor = encodeListCursor({ orderAtMs: 5, sessionId: SESSION }, scope);
    expect(decodeListCursor(cursor, scope)).toEqual({ orderAtMs: 5, sessionId: SESSION });
    for (const archived of ["archived", "all"] as const) {
      expect(() => decodeListCursor(cursor, { ...scope, archived })).toThrow(
        expect.objectContaining({ code: -32602 }),
      );
      const other = encodeListCursor({ orderAtMs: 5, sessionId: SESSION }, { ...scope, archived });
      expect(decodeListCursor(other, { ...scope, archived })).toEqual({
        orderAtMs: 5,
        sessionId: SESSION,
      });
      expect(() => decodeListCursor(other, scope)).toThrow(
        expect.objectContaining({ code: -32602 }),
      );
    }
    expect(() => decodeListCursor(cursor, { ...scope, includeWorktrees: true })).toThrow(
      expect.objectContaining({ code: -32602 }),
    );
    expect(() => decodeListCursor(cursor, { ...scope, cwd: "/other" })).toThrow(
      expect.objectContaining({ code: -32602 }),
    );
    expect(() => decodeListCursor("offset:1000", scope)).toThrow(
      expect.objectContaining({ code: -32602 }),
    );
    // Cursors of earlier format versions.
    for (const v of [3, 4]) {
      const legacy = Buffer.from(
        JSON.stringify({ v, u: 5, id: SESSION, cwd: "/repo", archived: false, worktrees: false }),
      ).toString("base64url");
      expect(() => decodeListCursor(legacy, scope)).toThrow(
        expect.objectContaining({ code: -32602 }),
      );
    }
  });

  it("validates and truncates a rename title", () => {
    expect(() => parseRenameSessionRequest({ sessionId: SESSION, title: "  " })).toThrow(
      expect.objectContaining({ code: -32602 }),
    );
    expect(() => parseRenameSessionRequest({ sessionId: SESSION })).toThrow(
      expect.objectContaining({ code: -32602 }),
    );
    const { title } = parseRenameSessionRequest({ sessionId: SESSION, title: "x".repeat(300) });
    expect(title).toHaveLength(256);
  });
});

describe("live registry", () => {
  const now = Date.parse("2026-01-02T00:00:00Z");

  async function registryWith(records: Record<string, object | string>) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "live-registry-"));
    for (const [name, record] of Object.entries(records)) {
      await fs.writeFile(
        path.join(dir, name),
        typeof record === "string" ? record : JSON.stringify(record),
      );
    }
    return dir;
  }

  it("keeps live, matching records and applies the liveness rules", async () => {
    const dir = await registryWith({
      "10.json": {
        pid: 10,
        sessionId: "live",
        procStart: "Mon Jan  1 00:00:00 2026",
        updatedAt: now,
      },
      "11.json": { pid: 11, sessionId: "dead", updatedAt: now },
      "12.json": {
        pid: 12,
        sessionId: "reused",
        procStart: "Sun Jan 1 00:00:00 2025",
        updatedAt: now,
      },
      "13.json": { pid: 13, sessionId: "stale", updatedAt: now - 25 * 3600_000 },
      "14.json": {
        pid: 14,
        sessionId: "old-but-proven",
        procStart: "Tue Jan 2 00:00:00 2024",
        updatedAt: 0,
      },
      "15.json": { pid: 15, sessionId: "foreign", pidDomain: "elsewhere", updatedAt: now },
      "16.json": "{ not json",
      "17.json": { pid: 99, sessionId: "wrong-name", updatedAt: now },
      "18.abcdef.key": "secret",
    });
    const registry = new LiveSessionRegistry({
      dir: () => dir,
      now: () => now,
      isAlive: (pid) => pid !== 11,
      processStarts: async () =>
        new Map([
          [10, "Mon Jan 1 00:00:00 2026"],
          [12, "Mon Jan 1 00:00:00 2026"],
          [14, "Tue Jan 2 00:00:00 2024"],
        ]),
      pidDomain: async () => "darwin",
    });
    const snapshot = await registry.snapshot();
    expect([...snapshot.keys()].sort()).toEqual(["live", "old-but-proven"]);
    expect(snapshot.get("live")?.pid).toBe(10);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("reads single records, never a .key file, and reuses a recent start time on request", async () => {
    const dir = await registryWith({
      "10.json": {
        pid: 10,
        sessionId: "live",
        procStart: "Mon Jan 1 00:00:00 2026",
        updatedAt: now,
      },
      "10.json.tmp": "{}",
      "18.abcdef.key": "secret",
    });
    const asked: number[][] = [];
    const registry = new LiveSessionRegistry({
      dir: () => dir,
      now: () => now,
      isAlive: () => true,
      processStarts: async (pids) => {
        asked.push(pids);
        return new Map([[10, "Mon Jan 1 00:00:00 2026"]]);
      },
      pidDomain: async () => "darwin",
    });
    const read = await registry.readFiles(["10.json", "10.json.tmp", "18.abcdef.key", "11.json"]);
    expect([...read.keys()].sort()).toEqual(["10.json", "11.json"]);
    expect(read.get("10.json")?.sessionId).toBe("live");
    expect(read.get("11.json")).toBeUndefined();
    await registry.readFiles(["10.json"], { recentStarts: true });
    expect(asked).toEqual([[10]]);
    // Without recentStarts, `ps` is asked again.
    await registry.readFiles(["10.json"]);
    expect(asked).toEqual([[10], [10]]);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("is empty when the registry does not exist", async () => {
    const registry = new LiveSessionRegistry({ dir: () => "/nonexistent/registry" });
    expect((await registry.snapshot()).size).toBe(0);
  });
});

describe("first prompt, as the SDK extracts it", () => {
  const userLine = (content: unknown, extra: object = {}) =>
    JSON.stringify({
      type: "user",
      sessionId: SESSION,
      message: { role: "user", content },
      ...extra,
    });

  it("keeps a slash command only as a fallback for a real prompt", () => {
    const init = userLine(
      "<command-message>init</command-message>\n<command-name>/init</command-name>",
    );
    expect(firstPrompt([init, userLine("Explain the parser")].join("\n"))).toBe(
      "Explain the parser",
    );
    expect(firstPrompt(init)).toBe("/init");
    expect(sdkTitles({ head: init, tail: init }).summary).toBe("/init");
  });

  it("skips tags, interrupts, meta, compact summaries and tool results", () => {
    const head = [
      userLine("<local-command-stdout>ok</local-command-stdout>"),
      userLine("[Request interrupted by user]"),
      userLine("Hidden", { isMeta: true }),
      userLine("Summary", { isCompactSummary: true }),
      userLine([{ type: "tool_result", tool_use_id: "t", content: "x" }]),
      userLine([
        { type: "text", text: "<system-reminder>r</system-reminder>" },
        { type: "text", text: "Second  block\nprompt" },
      ]),
    ].join("\n");
    expect(firstPrompt(head)).toBe("Second  block prompt");
  });

  it("renders bash input, expands pasted content, and cuts at 200 characters", () => {
    expect(firstPrompt(userLine("<bash-input> ls -la </bash-input>"))).toBe("! ls -la");
    const pasted =
      'Fix this\n<pasted_content id="0a1f">\nstack trace\n</pasted_content id="0a1f">\n';
    expect(firstPrompt(userLine(pasted))).toBe("Fix thisstack trace");
    expect(firstPrompt(userLine("y".repeat(300)))).toBe(`${"y".repeat(200)}…`);
  });

  it("titles an image-only first prompt", () => {
    const head = userLine([{ type: "image", source: { type: "base64", data: "x" } }]);
    expect(sdkTitles({ head, tail: head }).summary).toBe("Image");
  });
});

describe("continued-in", () => {
  const successor = "22222222-2222-4222-8222-222222222222";
  const continued = { type: "continued-in", continuedInSessionId: successor };

  it("counts only a real prompt or a finished answer after it as a resume", () => {
    expect(continuedInSessionId(lines(user("x", "2026-01-01T00:00:00Z"), continued))).toBe(
      successor,
    );
    // A meta record or a slash command after it is no resume.
    expect(
      continuedInSessionId(
        lines(
          continued,
          user("<command-name>/status</command-name>", "2026-01-01T00:00:01Z"),
          user("note", "2026-01-01T00:00:02Z", { isMeta: true }),
        ),
      ),
    ).toBe(successor);
    expect(
      continuedInSessionId(lines(continued, user("Go on", "2026-01-01T00:00:03Z"))),
    ).toBeUndefined();
    expect(
      continuedInSessionId(lines(continued, assistant("end_turn", "2026-01-01T00:00:04Z"))),
    ).toBeUndefined();
  });
});

describe("row facts of the tail and head", () => {
  it("takes lastPromptAt from the last real prompt only", () => {
    const facts = scan(
      lines(
        user("Fix it", "2026-01-01T00:00:00Z"),
        assistant("tool_use", "2026-01-01T00:00:01Z"),
        {
          type: "user",
          sessionId: SESSION,
          timestamp: "2026-01-01T00:00:02Z",
          message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t" }] },
        },
        user("<command-name>/status</command-name>", "2026-01-01T00:00:03Z"),
        user("note", "2026-01-01T00:00:04Z", { isMeta: true }),
        user("[Request interrupted by user]", "2026-01-01T00:00:05Z"),
        assistant("end_turn", "2026-01-01T00:00:06Z"),
      ),
    );
    expect(facts.lastPromptAt).toBe(Date.parse("2026-01-01T00:00:00Z"));
  });

  it("takes the model of the last real assistant message", () => {
    const facts = scan(
      lines(
        assistant("end_turn", "2026-01-01T00:00:01Z", {
          message: { role: "assistant", model: "claude-a", content: [], stop_reason: "end_turn" },
        }),
        assistant("end_turn", "2026-01-01T00:00:02Z", {
          isApiErrorMessage: true,
          message: {
            role: "assistant",
            model: "<synthetic>",
            content: [],
            stop_reason: "end_turn",
          },
        }),
      ),
    );
    expect(facts.model).toBe("claude-a");
    expect(scan(lines(user("x", "2026-01-01T00:00:00Z"))).model).toBeUndefined();
  });

  it("knows forkedFrom only from a fork's records", () => {
    const parent = "33333333-3333-4333-8333-333333333333";
    expect(
      scan(
        lines(
          user("x", "2026-01-01T00:00:00Z", {
            forkedFrom: { sessionId: parent, messageUuid: "m" },
          }),
        ),
      ).forkedFrom,
    ).toBe(parent);
    expect(scan(lines(user("x", "2026-01-01T00:00:00Z"))).forkedFrom).toBeUndefined();
  });
});

describe("lastPromptAt of a media prompt", () => {
  const media = (type: "image" | "document", timestamp: string, extra: object = {}) => ({
    type: "user",
    sessionId: SESSION,
    timestamp,
    message: {
      role: "user",
      content: [{ type, source: { type: "base64", media_type: "x", data: "x" } }],
    },
    ...extra,
  });

  it("counts an image or a document as a prompt", () => {
    for (const type of ["image", "document"] as const) {
      const facts = scan(
        lines(
          user("Fix it", "2026-01-01T00:00:00Z"),
          assistant("end_turn", "2026-01-01T00:00:01Z"),
          media(type, "2026-01-01T00:00:02Z"),
          assistant("end_turn", "2026-01-01T00:00:03Z"),
        ),
      );
      expect(facts.lastPromptAt).toBe(Date.parse("2026-01-01T00:00:02Z"));
    }
  });

  it("does not count media in a tool result or a meta record", () => {
    const facts = scan(
      lines(
        user("Fix it", "2026-01-01T00:00:00Z"),
        {
          type: "user",
          sessionId: SESSION,
          timestamp: "2026-01-01T00:00:02Z",
          message: {
            role: "user",
            content: [
              { type: "tool_result", tool_use_id: "t", content: [{ type: "image", source: {} }] },
            ],
          },
        },
        media("image", "2026-01-01T00:00:03Z", { isMeta: true }),
      ),
    );
    expect(facts.lastPromptAt).toBe(Date.parse("2026-01-01T00:00:00Z"));
  });
});

describe("directory listings and stats", () => {
  it("re-reads a listing when an entry is added or removed, not otherwise", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "listing-"));
    const listings = new DirListings();
    await fs.writeFile(path.join(dir, "a.jsonl"), "x");
    // A directory changed in the last seconds is read again each time: its
    // mtime may not show a second change in the same second.
    const old = new Date(Date.now() - 60_000);
    await fs.utimes(dir, old, old);
    expect(await listings.names(dir)).toEqual(["a.jsonl"]);
    await fs.writeFile(path.join(dir, "hidden.jsonl"), "x");
    await fs.utimes(dir, old, old);
    // Same mtime: the cached listing stands (an append changes none either).
    expect(await listings.names(dir)).toEqual(["a.jsonl"]);
    await fs.rm(path.join(dir, "hidden.jsonl"));
    await fs.writeFile(path.join(dir, "B.jsonl"), "x");
    const later = new Date(Date.now() - 30_000);
    await fs.utimes(dir, later, later);
    expect((await listings.names(dir)).sort()).toEqual(["B.jsonl", "a.jsonl"]);
    // A change just now is seen at once.
    await fs.rm(path.join(dir, "a.jsonl"));
    expect(await listings.names(dir)).toEqual(["B.jsonl"]);
    await fs.writeFile(path.join(dir, "c.jsonl"), "x");
    expect((await listings.names(dir)).sort()).toEqual(["B.jsonl", "c.jsonl"]);
    await fs.rm(dir, { recursive: true, force: true });
    expect(await listings.names(dir)).toEqual([]);
  });

  it("re-reads a directory replaced by another with the same mtime", async () => {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), "listing-swap-"));
    const dir = path.join(parent, "project");
    const other = path.join(parent, "restored");
    await fs.mkdir(dir);
    await fs.mkdir(other);
    await fs.writeFile(path.join(dir, "a.jsonl"), "x");
    await fs.writeFile(path.join(other, "b.jsonl"), "x");
    const old = new Date(Date.now() - 60_000);
    await fs.utimes(dir, old, old);
    await fs.utimes(other, old, old);
    const listings = new DirListings();
    expect(await listings.names(dir)).toEqual(["a.jsonl"]);
    await fs.rm(dir, { recursive: true });
    await fs.rename(other, dir);
    await fs.utimes(dir, old, old);
    expect(await listings.names(dir)).toEqual(["b.jsonl"]);
    await fs.rm(parent, { recursive: true, force: true });
  });

  it("stats many files in order, bounded, and reports missing ones", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "stats-"));
    const files = await Promise.all(
      Array.from({ length: 1500 }, async (_, i) => {
        const file = path.join(dir, `${i}.txt`);
        await fs.writeFile(file, "x".repeat(i % 7));
        return file;
      }),
    );
    const [all, again] = await Promise.all([
      statFiles([...files, path.join(dir, "missing")]),
      statFiles(files.slice(0, 10)),
    ]);
    expect(all.slice(0, 1500).map((stats) => stats?.size)).toEqual(files.map((_, i) => i % 7));
    expect(all[1500]).toBeUndefined();
    expect(again.map((stats) => stats?.size)).toEqual(files.slice(0, 10).map((_, i) => i % 7));
    await fs.rm(dir, { recursive: true, force: true });
  });
});

describe("session id lookup", () => {
  it("matches a session id exactly, in no other case", async () => {
    const config = await fs.mkdtemp(path.join(os.tmpdir(), "si-exact-id-"));
    const previous = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = config;
    try {
      const dir = path.join(config, "projects", "-repo");
      const id = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
      await fs.mkdir(path.join(dir, id), { recursive: true });
      const file = path.join(dir, `${id}.jsonl`);
      await fs.writeFile(file, lines(user("hi", "2026-01-01T00:00:00.000Z")) + "\n");
      const index = new SessionIndex();
      expect(await index.findTranscripts(id)).toEqual([file]);
      expect(await index.scanSession(id)).toEqual({
        transcripts: [{ filePath: file, size: expect.any(Number) }],
        sessionDirs: [path.join(dir, id)],
      });
      const upper = id.toUpperCase();
      expect(await index.findTranscripts(upper)).toEqual([]);
      expect(await index.scanSession(upper)).toEqual({ transcripts: [], sessionDirs: [] });
    } finally {
      if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = previous;
      await fs.rm(config, { recursive: true, force: true });
    }
  });
});

describe("archive titles (AIR's Claude format)", () => {
  const id = "0b0e6c2e-1d55-4c1f-9b4e-2b1d7f6f1a11";

  it("tells an archived title by its prefix once normalized", () => {
    for (const title of ["[archived] Done", "  [archived]\n  Done", "[archived]\tx"]) {
      expect(isArchivedTitle(title)).toBe(true);
    }
    for (const title of [undefined, "Done", "[archived]", "[archived]   ", "x [archived] y"]) {
      expect(isArchivedTitle(title)).toBe(false);
    }
    expect(visibleTitle("[archived]  Done")).toBe("Done");
  });

  it("stores the visible title normalized, with the prefix when archived, cut to 200", () => {
    expect(storedTitle(" Fix\n the  parser ", true, id)).toBe("[archived] Fix the parser");
    expect(storedTitle("[archived] Fix it", false, id)).toBe("Fix it");
    expect(storedTitle("[archived] Fix it", true, id)).toBe("[archived] Fix it");
    expect(storedTitle("", true, id)).toBe("[archived] Session 0b0e6c2e");
    expect(storedTitle(`A${" ".repeat(5000)}B`, true, id)).toBe("[archived] A B");
    expect(storedTitle("[archived] [archived] X", false, id)).toBe("X");
    expect(storedTitle("[archived] ".repeat(10_000) + "X", true, id)).toBe("[archived] X");
    expect(storedTitle(`${"a".repeat(188)} ${"b".repeat(20)}`, true, id)).toBe(
      `[archived] ${"a".repeat(188)}`,
    );
  });

  it("writes the custom-title and agent-name records with AIR's fields", () => {
    expect(titleRecords(id, "[archived] T")).toBe(
      `{"type":"custom-title","customTitle":"[archived] T","sessionId":"${id}"}\n` +
        `{"type":"agent-name","agentName":"[archived] T","sessionId":"${id}"}\n`,
    );
  });

  it("takes the custom title the SDK reports, never an agent name", () => {
    const lines = (...records: object[]) => records.map((r) => JSON.stringify(r)).join("\n");
    const text = lines(
      { type: "custom-title", customTitle: "Custom" },
      { type: "agent-name", agentName: "[archived] Agent" },
    );
    expect(sdkTitles({ head: text, tail: text })).toEqual({
      customTitle: "Custom",
      summary: "Custom",
    });
    // The tail wins over the sidecar, the sidecar over the head.
    const head = lines({ type: "custom-title", customTitle: "Head" });
    const tail = lines({ type: "custom-title", customTitle: "Tail" });
    expect(sdkTitles({ head, tail }, "Sidecar").customTitle).toBe("Tail");
    expect(sdkTitles({ head, tail: "" }, "Sidecar").customTitle).toBe("Sidecar");
    expect(sdkTitles({ head, tail: "" }).customTitle).toBe("Head");
    // A generated title is no custom title.
    const prompt = lines(user("[archived] Looks archived", "2026-01-01T00:00:00Z"));
    expect(sdkTitles({ head: prompt, tail: prompt })).toEqual({
      customTitle: undefined,
      summary: "[archived] Looks archived",
    });
  });

  it("reads the last top-level agent name of the tail, else of the head", () => {
    const lines = (...records: object[]) => records.map((r) => JSON.stringify(r)).join("\n");
    const head = lines({ type: "agent-name", agentName: "Head" });
    const tail = lines(
      { type: "agent-name", agentName: "First" },
      { type: "agent-name", agentName: "Last" },
      { type: "agent-name", agentName: "  " },
      { type: "user", toolUseResult: { agentName: "Nested" } },
      { type: "custom-title", customTitle: "Custom" },
    );
    expect(transcriptAgentName({ head, tail })).toBe("Last");
    expect(
      transcriptAgentName({ head, tail: lines({ type: "custom-title", customTitle: "C" }) }),
    ).toBe("Head");
    expect(transcriptAgentName({ head: "", tail: "" })).toBeUndefined();
  });

  it("decides the archive state by the agent name first, else the custom title", () => {
    // The agent name with the prefix, the custom title without: archived.
    expect(
      effectiveTitle("[archived] Agent", { customTitle: "Custom", summary: "Custom" }),
    ).toEqual({ title: "[archived] Agent", archived: true });
    // The agent name without the prefix, the custom title with it: not archived.
    expect(
      effectiveTitle("Agent", { customTitle: "[archived] Custom", summary: "[archived] Custom" }),
    ).toEqual({ title: "Agent", archived: false });
    // No agent name: the custom title decides.
    expect(
      effectiveTitle(undefined, { customTitle: "[archived] Custom", summary: "[archived] Custom" }),
    ).toEqual({ title: "[archived] Custom", archived: true });
    expect(effectiveTitle(undefined, { customTitle: "Custom", summary: "Custom" })).toEqual({
      title: "Custom",
      archived: false,
    });
    // A generated title is no name.
    expect(effectiveTitle(undefined, { summary: "[archived] Prompt" })).toEqual({
      title: "[archived] Prompt",
      archived: false,
    });
  });
});
