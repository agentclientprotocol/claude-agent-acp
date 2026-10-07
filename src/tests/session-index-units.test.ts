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
} from "../session-index/service.js";
import {
  continuedInSessionId,
  scanTranscript,
  titleFields,
  type TranscriptFacts,
} from "../session-index/transcript-scan.js";
import { firstPrompt } from "../session-index/first-prompt.js";
import { ListChangedWatcher } from "../session-index/list-changed.js";

const SESSION = "11111111-1111-4111-8111-111111111111";
const lines = (...entries: object[]) => entries.map((entry) => JSON.stringify(entry)).join("\n");
const scan = (text: string) => scanTranscript({ head: text, tail: text }, SESSION);

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

  it("takes the last valid cost-state of this session only", () => {
    const facts = scan(
      lines(
        { type: "cost-state", sessionId: SESSION, totalCostUSD: 1.5 },
        { type: "cost-state", sessionId: SESSION, totalCostUSD: "bad" },
        { type: "cost-state", sessionId: "other", totalCostUSD: 9 },
      ),
    );
    expect(facts.costUsd).toBe(1.5);
  });

  it("reports the head cwd and the last tail cwd, and a stub without messages", () => {
    const facts = scanTranscript(
      {
        head: lines({ type: "queue-operation" }, { type: "attachment", cwd: "/repo" }),
        tail: lines({ type: "attachment", cwd: "/repo/sub" }, { type: "last-prompt" }),
      },
      SESSION,
    );
    expect(facts.headCwd).toBe("/repo");
    expect(facts.tailCwd).toBe("/repo/sub");
    expect(facts.hasMessages).toBe(false);
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
  it("prefers the live result, else the transcript, and only a positive amount", () => {
    expect(selectCost({ costUsd: 2 }, { hasMessages: true, costUsd: 1 })).toBe(2);
    expect(selectCost({ costUsd: 0 }, { hasMessages: true, costUsd: 1 })).toBe(1);
    expect(selectCost(undefined, { hasMessages: true, costUsd: 0 })).toBeUndefined();
    expect(selectCost(undefined, { hasMessages: true })).toBeUndefined();
  });
});

describe("list request parsing", () => {
  const meta = (list: object) => ({ jetbrains: { air: { version: 1, list } } });

  it("defaults and clamps the limit", () => {
    expect(parseListOptions(undefined)).toEqual({
      limit: 50,
      archived: false,
      includeWorktrees: false,
    });
    expect(parseListOptions(meta({ limit: 1000 })).limit).toBe(200);
    expect(parseListOptions(meta({ limit: 0 })).limit).toBe(1);
  });

  it("takes archived and includeWorktrees as booleans, null as false, and rejects anything else", () => {
    expect(parseListOptions(meta({ includeWorktrees: true })).includeWorktrees).toBe(true);
    expect(parseListOptions(meta({ includeWorktrees: null })).includeWorktrees).toBe(false);
    expect(() => parseListOptions(meta({ includeWorktrees: "yes" }))).toThrow(
      expect.objectContaining({ code: -32602 }),
    );
    expect(parseListOptions(meta({ archived: true })).archived).toBe(true);
    expect(parseListOptions(meta({ archived: false })).archived).toBe(false);
    expect(parseListOptions(meta({ archived: null })).archived).toBe(false);
    for (const archived of ["only", "exclude", 1, "true", {}]) {
      expect(() => parseListOptions(meta({ archived }))).toThrow(
        expect.objectContaining({ code: -32602 }),
      );
    }
  });

  it("round-trips a cursor and rejects one of another scope", () => {
    const scope = { cwd: "/repo", archived: false, includeWorktrees: false };
    const cursor = encodeListCursor({ updatedAtMs: 5, sessionId: SESSION }, scope);
    expect(decodeListCursor(cursor, scope)).toEqual({ updatedAtMs: 5, sessionId: SESSION });
    expect(() => decodeListCursor(cursor, { ...scope, archived: true })).toThrow(
      expect.objectContaining({ code: -32602 }),
    );
    expect(() => decodeListCursor(cursor, { ...scope, includeWorktrees: true })).toThrow(
      expect.objectContaining({ code: -32602 }),
    );
    expect(() => decodeListCursor(cursor, { ...scope, cwd: "/other" })).toThrow(
      expect.objectContaining({ code: -32602 }),
    );
    expect(() => decodeListCursor("offset:1000", scope)).toThrow(
      expect.objectContaining({ code: -32602 }),
    );
    // A cursor of the string filter this adapter issued before.
    const legacy = Buffer.from(
      JSON.stringify({ v: 1, u: 5, id: SESSION, cwd: "/repo", archived: "exclude" }),
    ).toString("base64url");
    expect(() => decodeListCursor(legacy, scope)).toThrow(
      expect.objectContaining({ code: -32602 }),
    );
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
      parentPids: async (pids) => new Map(pids.map((pid) => [pid, 1])),
    });
    const snapshot = await registry.snapshot();
    expect([...snapshot.keys()].sort()).toEqual(["live", "old-but-proven"]);
    expect((await registry.holder("live"))?.pid).toBe(10);
    expect(await registry.holder("dead")).toBeUndefined();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("reports another process before it waits for a CLI child of this one", async () => {
    const dir = await registryWith({
      "21.json": { pid: 21, sessionId: "both", updatedAt: now },
      "22.json": { pid: 22, sessionId: "both", updatedAt: now },
    });
    const registry = new LiveSessionRegistry({
      dir: () => dir,
      now: () => now,
      isAlive: () => true,
      pidDomain: async () => "darwin",
      ownPid: 1000,
      parentPids: async (pids) => new Map(pids.map((pid) => [pid, pid === 22 ? 1 : 1000])),
      ownChildExitTimeoutMs: 60_000,
    });
    // Our exiting child and another process: the other one holds it, at once.
    expect((await registry.holder("both"))?.pid).toBe(22);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("waits for a CLI child of this process to exit, and reports one that does not", async () => {
    const dir = await registryWith({
      "30.json": { pid: 30, sessionId: "exiting", updatedAt: now },
      "31.json": { pid: 31, sessionId: "stuck", updatedAt: now },
    });
    let exited = false;
    const registry = new LiveSessionRegistry({
      dir: () => dir,
      now: () => now,
      isAlive: (pid) => pid !== 30 || !exited,
      pidDomain: async () => "darwin",
      ownPid: 1000,
      parentPids: async (pids) => new Map(pids.map((pid) => [pid, 1000])),
      ownChildExitTimeoutMs: 250,
    });
    setTimeout(() => (exited = true), 100);
    expect(await registry.holder("exiting")).toBeUndefined();

    const started = Date.now();
    expect((await registry.holder("stuck"))?.pid).toBe(31);
    expect(Date.now() - started).toBeGreaterThanOrEqual(240);
    await fs.rm(dir, { recursive: true, force: true });
  });

  describe("a holder whose parent is unknown", () => {
    const unknownParents = async (records: Record<string, object>, timeoutMs = 150) => {
      const dir = await registryWith(records);
      return {
        dir,
        registry: new LiveSessionRegistry({
          dir: () => dir,
          now: () => now,
          isAlive: () => true,
          pidDomain: async () => "win32:host",
          parentPids: async () => new Map(),
          ownChildExitTimeoutMs: timeoutMs,
        }),
      };
    };

    it("is another process when this one ran no CLI for the session", async () => {
      const { dir, registry } = await unknownParents(
        { "40.json": { pid: 40, sessionId: "s", updatedAt: now } },
        60_000,
      );
      expect((await registry.holder("s"))?.pid).toBe(40);
      await fs.rm(dir, { recursive: true, force: true });
    });

    it("is taken for the CLI of this process when it is the only one", async () => {
      const { dir, registry } = await unknownParents({
        "41.json": { pid: 41, sessionId: "s", updatedAt: now },
      });
      expect(await registry.holder("s", { ownCli: "running" })).toBeUndefined();
      // An exiting one is waited for, and reported if it stays.
      const started = Date.now();
      expect((await registry.holder("s", { ownCli: "exiting" }))?.pid).toBe(41);
      expect(Date.now() - started).toBeGreaterThanOrEqual(140);
      await fs.rm(dir, { recursive: true, force: true });
    });

    it("is another process when two hold the session", async () => {
      const { dir, registry } = await unknownParents(
        {
          "42.json": { pid: 42, sessionId: "s", updatedAt: now },
          "43.json": { pid: 43, sessionId: "s", updatedAt: now },
        },
        60_000,
      );
      expect(await registry.holder("s", { ownCli: "running" })).toBeDefined();
      expect(await registry.holder("s", { ownCli: "exiting" })).toBeDefined();
      await fs.rm(dir, { recursive: true, force: true });
    });
  });

  it("matches a session id in any case", async () => {
    const id = "abcdef01-2345-4678-89ab-cdef01234567";
    const dir = await registryWith({ "50.json": { pid: 50, sessionId: id, updatedAt: now } });
    const registry = new LiveSessionRegistry({
      dir: () => dir,
      now: () => now,
      isAlive: () => true,
      pidDomain: async () => "darwin",
      ownPid: 1000,
      parentPids: async (pids) => new Map(pids.map((pid) => [pid, 1])),
    });
    expect((await registry.holder(id.toUpperCase()))?.pid).toBe(50);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("does not count or wait for the CLI child that runs the session", async () => {
    const dir = await registryWith({
      "60.json": { pid: 60, sessionId: "running", updatedAt: now },
      "61.json": { pid: 61, sessionId: "resumed", updatedAt: now },
      "62.json": { pid: 62, sessionId: "resumed", updatedAt: now },
    });
    const registry = new LiveSessionRegistry({
      dir: () => dir,
      now: () => now,
      isAlive: () => true,
      pidDomain: async () => "darwin",
      ownPid: 1000,
      parentPids: async (pids) => new Map(pids.map((pid) => [pid, pid === 62 ? 1 : 1000])),
      ownChildExitTimeoutMs: 60_000,
    });
    expect(await registry.holder("running", { ownCli: "running" })).toBeUndefined();
    expect((await registry.holder("resumed", { ownCli: "running" }))?.pid).toBe(62);
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
    expect(titleFields({ head: init, tail: init }).summary).toBe("/init");
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
    expect(titleFields({ head, tail: head }).summary).toBe("Image");
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
    expect(facts.createdAt).toBe(Date.parse("2026-01-01T00:00:00Z"));
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

describe("list change watches", () => {
  it("are keyed by cwd and worktree scope, and a list renews its watch", async () => {
    const scopes: boolean[] = [];
    const watcher = new ListChangedWatcher({
      projectDirs: async (_cwd, includeWorktrees) => {
        scopes.push(includeWorktrees);
        return { dirNames: [], paths: [] };
      },
      notify: async () => {},
      rescanMs: 60_000,
    });
    await watcher.onListed("/repo");
    await watcher.onListed("/repo", true);
    await watcher.onListed("/repo");
    expect(watcher.watchedCwds()).toEqual(["/repo", "/repo"]);
    expect(scopes).toEqual([false, true]);
    watcher.dispose();
  });
});
