/**
 * The `sessionIndex` AIR extension against a real projects directory in a
 * temporary `CLAUDE_CONFIG_DIR`. The SDK session functions are the real ones,
 * wrapped in spies.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  deleteSession,
  forkSession as sdkForkSession,
  getSessionInfo,
  listSessions,
} from "@anthropic-ai/claude-agent-sdk";
import { spawn, type ChildProcess } from "node:child_process";
import { ClaudeAcpAgent, type AcpClient } from "../acp-agent.js";
import { encodeProjectPath } from "../session-index/project-dirs.js";
import {
  archiveInsteadOfDelete,
  SessionIndexService,
  writeCustomTitleSidecar,
} from "../session-index/service.js";
import { scanTranscriptFile } from "../session-index/transcript-scan.js";
import { LiveSessionRegistry } from "../session-index/live-registry.js";
import { repositoryWorktrees } from "../session-index/worktrees.js";
import { ListChangedWatcher } from "../session-index/list-changed.js";
import { SessionTitles } from "../session-titles.js";
import { initializeClient } from "./helpers.js";
import { mockSessionState } from "./session-doubles.js";

vi.mock("@anthropic-ai/claude-agent-sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@anthropic-ai/claude-agent-sdk")>();
  return {
    ...actual,
    deleteSession: vi.fn(actual.deleteSession),
    getSessionInfo: vi.fn(actual.getSessionInfo),
    listSessions: vi.fn(actual.listSessions),
  };
});

const air = (...capabilities: string[]) => ({
  _meta: { jetbrains: { air: { version: 1, capabilities } } },
});
const listMeta = (list: object) => ({ jetbrains: { air: { version: 1, list } } });

let configDir: string;
let workspace: string;
let previousConfigDir: string | undefined;

beforeEach(async () => {
  previousConfigDir = process.env.CLAUDE_CONFIG_DIR;
  configDir = fsSync.realpathSync(await fs.mkdtemp(path.join(os.tmpdir(), "session-index-cfg-")));
  workspace = fsSync.realpathSync(await fs.mkdtemp(path.join(os.tmpdir(), "session-index-ws-")));
  process.env.CLAUDE_CONFIG_DIR = configDir;
  vi.clearAllMocks();
});

afterEach(async () => {
  if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = previousConfigDir;
  await fs.rm(configDir, { recursive: true, force: true });
  await fs.rm(workspace, { recursive: true, force: true });
});

type TranscriptOptions = {
  sessionId?: string;
  cwd?: string;
  /** The `cwd` written in the records; defaults to `cwd`. Null writes none. */
  recordCwd?: string | null;
  prompt?: string;
  lastMessageAt?: number;
  mtimeMs?: number;
  stopReason?: string;
  costUsd?: number;
  sidechain?: boolean;
  /** A first prompt of this many characters, to push the head past 64 KB. */
  hugePrompt?: number;
  trailer?: object[];
  /** The project directory name; defaults to the encoding of `cwd`. */
  dirName?: string;
  /** The model of the assistant message. */
  model?: string;
  /** The `forkedFrom.sessionId` that a fork writes on every record. */
  forkedFrom?: string;
};

async function writeTranscript(options: TranscriptOptions): Promise<{ id: string; file: string }> {
  const id = options.sessionId ?? randomUUID();
  const cwd = options.cwd ?? workspace;
  const recordCwd = options.recordCwd === undefined ? cwd : options.recordCwd;
  const at = options.lastMessageAt ?? Date.parse("2026-01-01T00:00:00Z");
  const dir = path.join(configDir, "projects", options.dirName ?? encodeProjectPath(cwd));
  await fs.mkdir(dir, { recursive: true });
  const common = {
    sessionId: id,
    isSidechain: options.sidechain ?? false,
    ...(recordCwd !== null && { cwd: recordCwd }),
    ...(options.forkedFrom && {
      forkedFrom: { sessionId: options.forkedFrom, messageUuid: randomUUID() },
    }),
  };
  const prompt = options.hugePrompt ? "p".repeat(options.hugePrompt) : (options.prompt ?? "Fix it");
  const entries = [
    {
      ...common,
      type: "user",
      uuid: randomUUID(),
      timestamp: new Date(at - 1000).toISOString(),
      message: { role: "user", content: prompt },
    },
    {
      ...common,
      type: "assistant",
      uuid: randomUUID(),
      timestamp: new Date(at).toISOString(),
      message: {
        role: "assistant",
        ...(options.model && { model: options.model }),
        content: [{ type: "text", text: "Done" }],
        stop_reason: options.stopReason ?? "end_turn",
      },
    },
    ...(options.costUsd !== undefined
      ? [{ type: "cost-state", sessionId: id, totalCostUSD: options.costUsd }]
      : []),
    ...(options.trailer ?? []),
  ];
  const file = path.join(dir, `${id}.jsonl`);
  await fs.writeFile(file, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  const mtime = (options.mtimeMs ?? at + 500) / 1000;
  await fs.utimes(file, mtime, mtime);
  return { id, file };
}

function createAgent(options: { v2?: boolean } = {}) {
  const notifications: { method: string; params: Record<string, unknown> }[] = [];
  const updates: unknown[] = [];
  const client = {
    sessionUpdate: async (update: unknown) => {
      updates.push(update);
    },
    extNotification: async (method: string, params: Record<string, unknown>) => {
      notifications.push({ method, params });
    },
  } as unknown as AcpClient;
  const agent = new ClaudeAcpAgent(client, { log: () => {}, error: () => {} }, options);
  return { agent, notifications, updates };
}

async function indexAgent() {
  const created = createAgent();
  await initializeClient(created.agent, air("sessionIndex"));
  return created;
}

/** The `custom-title` and `agent-name` records that title a session. */
const titleRecords = (sessionId: string, title: string) => [
  { type: "custom-title", customTitle: title, sessionId },
  { type: "agent-name", agentName: title, sessionId },
];

/** The last `count` records of a transcript. */
async function lastRecords(file: string, count = 2): Promise<unknown[]> {
  const lines = (await fs.readFile(file, "utf8")).trim().split("\n");
  return lines.slice(-count).map((line) => JSON.parse(line));
}

const markerOf = (sessionId: string) => path.join(configDir, "acp", "archived", sessionId);

/** An archive marker file, which the adapter reads but never writes. */
async function writeMarker(sessionId: string): Promise<string> {
  const marker = markerOf(sessionId);
  await fs.mkdir(path.dirname(marker), { recursive: true });
  await fs.writeFile(marker, "");
  return marker;
}

const airCapabilities = (response: { _meta?: Record<string, unknown> | null }) =>
  (response._meta as any)?.jetbrains?.air?.capabilities as string[] | undefined;

describe("sessionIndex negotiation", () => {
  const indexCapabilities = ["sessionIndex", "sessionArchive", "sessionRename"];
  const baseline = [
    "sessionFailure",
    "agentFileChangeReport",
    "nativeSubagentSessions",
    "asyncTasks",
    "recommendedValue",
    "diffPatch",
    "planFile",
  ];

  it("is advertised with sessionArchive and sessionRename only to an AIR client that declares it", async () => {
    const declared = await createAgent().agent.initialize({
      protocolVersion: 1,
      clientCapabilities: air("sessionIndex"),
    });
    expect(airCapabilities(declared)).toEqual([...baseline, ...indexCapabilities]);

    const undeclared = await createAgent().agent.initialize({
      protocolVersion: 1,
      clientCapabilities: air("diffPatch"),
    });
    expect(airCapabilities(undeclared)).toEqual(baseline);

    // Declaring archive or rename alone enables nothing.
    const withoutIndex = await createAgent().agent.initialize({
      protocolVersion: 1,
      clientCapabilities: air("sessionArchive", "sessionRename"),
    });
    expect(airCapabilities(withoutIndex)).toEqual(baseline);

    const nonAir = await createAgent().agent.initialize({
      protocolVersion: 1,
      clientCapabilities: {},
    });
    expect(nonAir._meta).toEqual({ steering: { supported: true } });
  });

  it("is not advertised under ACP v2", async () => {
    const response = await createAgent({ v2: true }).agent.initialize({
      protocolVersion: 1,
      clientCapabilities: air("sessionIndex"),
    });
    for (const capability of indexCapabilities) {
      expect(airCapabilities(response)).not.toContain(capability);
    }
  });

  it("answers method-not-found to the new methods without the capability", async () => {
    // Declaring sessionArchive or sessionRename without sessionIndex enables
    // nothing either.
    for (const capabilities of [[], ["sessionArchive", "sessionRename"]]) {
      const { agent } = createAgent();
      await initializeClient(agent, air(...capabilities));
      const sessionId = randomUUID();
      await expect(agent.renameSessionTitle({ sessionId, title: "x" })).rejects.toMatchObject({
        code: -32601,
      });
      await expect(agent.archiveSession({ sessionId })).rejects.toMatchObject({ code: -32601 });
      await expect(agent.unarchiveSession({ sessionId })).rejects.toMatchObject({ code: -32601 });
    }
  });
});

describe("session/list of a sessionIndex client", () => {
  const base = Date.parse("2026-03-01T00:00:00Z");

  it("orders by the last message time, honours the limit, and pages with a cursor", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      ids.push((await writeTranscript({ lastMessageAt: base - i * 60_000 })).id);
    }
    // Touched last (a rename, a metadata record) but its last message is old.
    const touched = await writeTranscript({
      lastMessageAt: base - 10 * 60_000,
      mtimeMs: base + 60_000,
    });
    const { agent } = await indexAgent();

    const first = await agent.listSessions({ cwd: workspace, _meta: listMeta({ limit: 3 }) });
    expect(first.sessions.map((s) => s.sessionId)).toEqual(ids.slice(0, 3));
    expect(first.sessions[0]!.updatedAt).toBe(new Date(base).toISOString());
    expect(first.nextCursor).toBeDefined();

    const second = await agent.listSessions({
      cwd: workspace,
      cursor: first.nextCursor,
      _meta: listMeta({ limit: 3 }),
    });
    expect(second.sessions.map((s) => s.sessionId)).toEqual([...ids.slice(3), touched.id]);
    expect(second.nextCursor).toBeUndefined();

    await expect(
      agent.listSessions({
        cwd: workspace,
        cursor: first.nextCursor,
        _meta: listMeta({ archived: "all" }),
      }),
    ).rejects.toMatchObject({ code: -32602 });
  });

  it("never returns a cursor to an empty page", async () => {
    await writeTranscript({ lastMessageAt: base });
    await writeTranscript({ lastMessageAt: base - 1000 });
    // Sorted after both, but not listable.
    await writeTranscript({ lastMessageAt: base - 2000, sidechain: true });
    const { agent } = await indexAgent();
    const page = await agent.listSessions({ cwd: workspace, _meta: listMeta({ limit: 2 }) });
    expect(page.sessions).toHaveLength(2);
    expect(page.nextCursor).toBeUndefined();
  });

  it("stops reading once the page is full and older transcripts cannot rank higher", async () => {
    for (let i = 0; i < 60; i++) await writeTranscript({ lastMessageAt: base - i * 60_000 });
    const { agent } = await indexAgent();
    const page = await agent.listSessions({ cwd: workspace, _meta: listMeta({ limit: 5 }) });
    expect(page.sessions).toHaveLength(5);
    expect(vi.mocked(getSessionInfo).mock.calls.length).toBeLessThanOrEqual(16);
    // A second list reads nothing again.
    vi.mocked(getSessionInfo).mockClear();
    await agent.listSessions({ cwd: workspace, _meta: listMeta({ limit: 5 }) });
    expect(getSessionInfo).not.toHaveBeenCalled();
  });

  it("lists unarchived sessions by default, archived ones only, or all in one order", async () => {
    const newest = await writeTranscript({ lastMessageAt: base });
    const archived = await writeTranscript({ lastMessageAt: base - 1000 });
    const oldest = await writeTranscript({ lastMessageAt: base - 2000 });
    const { agent } = await indexAgent();
    await agent.archiveSession({ sessionId: archived.id });
    const rows = (page: { sessions: { sessionId: string; _meta?: unknown }[] }) =>
      page.sessions.map((s) => [s.sessionId, (s._meta as any).jetbrains.air.archived]);

    for (const archivedParam of [undefined, null, "unarchived"]) {
      const page = await agent.listSessions({
        cwd: workspace,
        ...(archivedParam !== undefined && { _meta: listMeta({ archived: archivedParam }) }),
      });
      expect(rows(page)).toEqual([
        [newest.id, false],
        [oldest.id, false],
      ]);
    }
    const all = await agent.listSessions({ cwd: workspace, _meta: listMeta({ archived: "all" }) });
    expect(rows(all)).toEqual([
      [newest.id, false],
      [archived.id, true],
      [oldest.id, false],
    ]);
    // Archiving did not move the session: its updatedAt is its last message.
    expect(all.sessions[1]!.updatedAt).toBe(new Date(base - 1000).toISOString());
    const onlyArchived = await agent.listSessions({
      cwd: workspace,
      _meta: listMeta({ archived: "archived" }),
    });
    expect(rows(onlyArchived)).toEqual([[archived.id, true]]);

    // The filter applies before pagination; a cursor keeps its value.
    const first = await agent.listSessions({
      cwd: workspace,
      _meta: listMeta({ archived: "all", limit: 2 }),
    });
    expect(first.sessions.map((s) => s.sessionId)).toEqual([newest.id, archived.id]);
    const second = await agent.listSessions({
      cwd: workspace,
      cursor: first.nextCursor,
      _meta: listMeta({ archived: "all", limit: 2 }),
    });
    expect(second.sessions.map((s) => s.sessionId)).toEqual([oldest.id]);
    for (const other of [undefined, "unarchived", "archived"]) {
      await expect(
        agent.listSessions({
          cwd: workspace,
          cursor: first.nextCursor,
          _meta: listMeta({ limit: 2, ...(other && { archived: other }) }),
        }),
      ).rejects.toMatchObject({ code: -32602 });
    }
    for (const invalid of [true, false, "only", 1]) {
      await expect(
        agent.listSessions({ cwd: workspace, _meta: listMeta({ archived: invalid }) }),
      ).rejects.toMatchObject({ code: -32602 });
    }
  });

  it("pages the archived sessions alone, and binds the cursor to that filter", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 5; i++)
      ids.push((await writeTranscript({ lastMessageAt: base - i * 1000 })).id);
    const { agent } = await indexAgent();
    for (const id of [ids[0]!, ids[2]!, ids[4]!]) await agent.archiveSession({ sessionId: id });
    const first = await agent.listSessions({
      cwd: workspace,
      _meta: listMeta({ archived: "archived", limit: 2 }),
    });
    expect(first.sessions.map((s) => s.sessionId)).toEqual([ids[0], ids[2]]);
    expect(first.sessions.every((s) => (s._meta as any).jetbrains.air.archived === true)).toBe(
      true,
    );
    const second = await agent.listSessions({
      cwd: workspace,
      cursor: first.nextCursor,
      _meta: listMeta({ archived: "archived", limit: 2 }),
    });
    expect(second.sessions.map((s) => s.sessionId)).toEqual([ids[4]]);
    expect(second.nextCursor).toBeUndefined();
    await expect(
      agent.listSessions({
        cwd: workspace,
        cursor: first.nextCursor,
        _meta: listMeta({ archived: "all", limit: 2 }),
      }),
    ).rejects.toMatchObject({ code: -32602 });
  });

  it("dedupes a session copied to two project directories, keeping the larger file", async () => {
    const other = path.join(workspace, "sub");
    await fs.mkdir(other);
    const small = await writeTranscript({ cwd: workspace, lastMessageAt: base });
    await writeTranscript({
      sessionId: small.id,
      cwd: workspace,
      lastMessageAt: base,
      trailer: [{ type: "last-prompt", lastPrompt: "x".repeat(100), sessionId: small.id }],
    });
    const { agent } = await indexAgent();
    const page = await agent.listSessions({ _meta: listMeta({ limit: 10 }) });
    expect(page.sessions.filter((s) => s.sessionId === small.id)).toHaveLength(1);
  });

  it("includes the sessions of existing linked worktrees on request, with their own cwd", async () => {
    const repo = path.join(workspace, "repo");
    const linked = path.join(workspace, "linked");
    const gone = path.join(workspace, "gone");
    await fs.mkdir(path.join(repo, ".git", "worktrees", "linked"), { recursive: true });
    await fs.mkdir(path.join(repo, ".git", "worktrees", "gone"), { recursive: true });
    await fs.mkdir(linked);
    await fs.writeFile(
      path.join(repo, ".git", "worktrees", "linked", "gitdir"),
      `${path.join(linked, ".git")}\n`,
    );
    await fs.writeFile(
      path.join(repo, ".git", "worktrees", "gone", "gitdir"),
      `${path.join(gone, ".git")}\n`,
    );
    await fs.writeFile(
      path.join(linked, ".git"),
      `gitdir: ${path.join(repo, ".git", "worktrees", "linked")}\n`,
    );
    await fs.writeFile(path.join(repo, ".git", "worktrees", "linked", "commondir"), "../..\n");
    const main = await writeTranscript({ cwd: repo, lastMessageAt: base });
    const inLinked = await writeTranscript({ cwd: linked, lastMessageAt: base - 1000 });
    await writeTranscript({ cwd: gone, lastMessageAt: base - 2000 });
    const { agent } = await indexAgent();

    // Worktrees are opt-in: without it, a cwd lists its own sessions.
    expect((await agent.listSessions({ cwd: repo })).sessions.map((s) => s.sessionId)).toEqual([
      main.id,
    ]);
    expect((await agent.listSessions({ cwd: linked })).sessions.map((s) => s.sessionId)).toEqual([
      inLinked.id,
    ]);
    for (const cwd of [repo, linked]) {
      const page = await agent.listSessions({
        cwd,
        _meta: listMeta({ includeWorktrees: true }),
      });
      expect(page.sessions.map((s) => [s.sessionId, s.cwd])).toEqual([
        [main.id, repo],
        [inLinked.id, linked],
      ]);
    }
    // A cursor is bound to the worktree scope.
    const first = await agent.listSessions({
      cwd: repo,
      _meta: listMeta({ includeWorktrees: true, limit: 1 }),
    });
    expect(first.nextCursor).toBeDefined();
    await expect(
      agent.listSessions({ cwd: repo, cursor: first.nextCursor, _meta: listMeta({ limit: 1 }) }),
    ).rejects.toMatchObject({ code: -32602 });
  });

  it("recovers the cwd of a session whose head has none", async () => {
    // A first prompt beyond 64 KB pushes the first cwd out of the head; the
    // tail cwd is a subdirectory of the project.
    const sub = path.join(workspace, "pkg");
    const bigPrompt = await writeTranscript({
      recordCwd: null,
      hugePrompt: 70_000,
      lastMessageAt: base,
      trailer: [
        { type: "attachment", cwd: sub, sessionId: "x" },
        { type: "last-prompt", lastPrompt: "Big paste", sessionId: "x" },
      ],
    });
    const noCwd = await writeTranscript({ recordCwd: null, lastMessageAt: base - 1000 });
    const { agent } = await indexAgent();

    const page = await agent.listSessions({ cwd: workspace });
    expect(page.sessions.map((s) => [s.sessionId, s.cwd])).toEqual([
      [bigPrompt.id, workspace],
      [noCwd.id, workspace],
    ]);
    // Without a requested cwd, a sibling of the same directory supplies it.
    const all = await agent.listSessions({});
    expect(all.sessions.map((s) => s.cwd)).toEqual([workspace, workspace]);
  });

  it("recovers a cwd from a sibling that the archive filter leaves out", async () => {
    const other = path.join(workspace, "other");
    const withCwd = await writeTranscript({ cwd: other, lastMessageAt: base });
    const noCwd = await writeTranscript({
      cwd: other,
      recordCwd: null,
      lastMessageAt: base - 1000,
    });
    const rows = (page: { sessions: { sessionId: string; cwd: string }[] }) =>
      page.sessions.map((s) => [s.sessionId, s.cwd]);

    // The cwd-less session is archived, its sibling is not.
    const archiving = await indexAgent();
    await archiving.agent.archiveSession({ sessionId: noCwd.id });
    const archivedOnly = await (
      await indexAgent()
    ).agent.listSessions({ _meta: listMeta({ archived: "archived" }) });
    expect(rows(archivedOnly)).toEqual([[noCwd.id, other]]);

    // And the reverse: the sibling with the cwd is archived.
    await archiving.agent.unarchiveSession({ sessionId: noCwd.id });
    await archiving.agent.archiveSession({ sessionId: withCwd.id });
    const unarchivedOnly = await (await indexAgent()).agent.listSessions({});
    expect(rows(unarchivedOnly)).toEqual([[noCwd.id, other]]);
  });

  it("reports the row fields of the RFDs, flat", async () => {
    const parent = randomUUID();
    const session = await writeTranscript({
      lastMessageAt: base,
      costUsd: 1.25,
      model: "claude-opus-5-5",
      forkedFrom: parent,
    });
    await writeTranscript({ lastMessageAt: base - 1000, costUsd: 0 });
    const { agent } = await indexAgent();
    const page = await agent.listSessions({ cwd: workspace });
    expect(page.sessions[0]).toEqual({
      sessionId: session.id,
      cwd: workspace,
      title: "Fix it",
      updatedAt: new Date(base).toISOString(),
      _meta: {
        jetbrains: {
          air: {
            version: 1,
            archived: false,
            // The prompt is the first record, a second before the answer.
            lastPromptAt: new Date(base - 1000).toISOString(),
            model: "claude-opus-5-5",
            forkedFrom: parent,
            state: "idle",
            lastTurnEndedAt: new Date(base).toISOString(),
            cost: { amount: 1.25, currency: "USD" },
          },
        },
      },
    });
    const other = (page.sessions[1]!._meta as any).jetbrains.air;
    for (const omitted of ["cost", "model", "forkedFrom", "activity", "usage"]) {
      expect(other).not.toHaveProperty(omitted);
    }
  });

  it("reports the live state and cost of a session this connection runs", async () => {
    const session = await writeTranscript({ lastMessageAt: base, costUsd: 1 });
    const { agent } = await indexAgent();
    agent.sessions[session.id] = mockSessionState(
      { lastSessionState: "running", lastTotalCostUsd: 3 },
      agent,
      session.id,
    ) as any;
    const page = await agent.listSessions({ cwd: workspace });
    const meta = (page.sessions[0]!._meta as any).jetbrains.air;
    expect(meta.state).toBe("running");
    expect(meta.cost).toEqual({ amount: 3, currency: "USD" });
  });
});

describe("old session/list path", () => {
  it("calls the SDK exactly as before for a client without sessionIndex", async () => {
    const session = await writeTranscript({});
    await fs.mkdir(path.join(configDir, "acp", "archived"), { recursive: true });
    await fs.writeFile(path.join(configDir, "acp", "archived", session.id), "");

    // Not AIR: the archive marker does not hide the session.
    const plain = createAgent().agent;
    await initializeClient(plain, {});
    const page = await plain.listSessions({ cwd: workspace });
    expect(page.sessions.map((s) => s.sessionId)).toEqual([session.id]);
    expect(page.sessions[0]).not.toHaveProperty("_meta");
    expect(vi.mocked(listSessions).mock.calls).toEqual([
      [{ dir: workspace, limit: 1001, offset: 0 }],
    ]);

    // AIR without sessionIndex: same SDK call, archived sessions hidden.
    vi.mocked(listSessions).mockClear();
    const airAgent = createAgent().agent;
    await initializeClient(airAgent, air());
    expect((await airAgent.listSessions({ cwd: workspace })).sessions).toEqual([]);
    expect(vi.mocked(listSessions).mock.calls).toEqual([
      [{ dir: workspace, limit: 1001, offset: 0 }],
    ]);
  });

  it("hides a session with an archived title from AIR without sessionIndex only", async () => {
    const archived = await writeTranscript({
      lastMessageAt: Date.parse("2026-01-02T00:00:00Z"),
      trailer: [{ type: "custom-title", customTitle: "[archived] Done", sessionId: "" }],
    });
    const open = await writeTranscript({});
    const airAgent = createAgent().agent;
    await initializeClient(airAgent, air());
    expect(
      (await airAgent.listSessions({ cwd: workspace })).sessions.map((s) => s.sessionId),
    ).toEqual([open.id]);
    const plain = createAgent().agent;
    await initializeClient(plain, {});
    expect(
      (await plain.listSessions({ cwd: workspace })).sessions.map((s) => [s.sessionId, s.title]),
    ).toEqual([
      [archived.id, "[archived] Done"],
      [open.id, "Fix it"],
    ]);
  });
});

describe("_session/rename", () => {
  it("renames a session that is not loaded: title records and the sidecar", async () => {
    const session = await writeTranscript({});
    const { agent } = await indexAgent();
    await agent.renameSessionTitle({ sessionId: session.id, title: "New name" });

    expect(await lastRecords(session.file)).toEqual(titleRecords(session.id, "New name"));
    const sidecar = path.join(path.dirname(session.file), session.id, "custom-title.json");
    expect(JSON.parse(await fs.readFile(sidecar, "utf8"))).toEqual({ customTitle: "New name" });
    expect((await fs.stat(sidecar)).mode & 0o777).toBe(0o600);
    expect((await fs.stat(path.dirname(sidecar))).mode & 0o777).toBe(0o700);
    const page = await agent.listSessions({ cwd: workspace });
    expect(page.sessions[0]!.title).toBe("New name");
  });

  it("refuses an unknown session and one held by another process", async () => {
    const { agent } = await indexAgent();
    await expect(
      agent.renameSessionTitle({ sessionId: randomUUID(), title: "x" }),
    ).rejects.toMatchObject({ code: -32002 });

    const session = await writeTranscript({});
    await fs.mkdir(path.join(configDir, "sessions"), { recursive: true });
    await fs.writeFile(
      path.join(configDir, "sessions", `${process.pid}.json`),
      JSON.stringify({ pid: process.pid, sessionId: session.id, updatedAt: Date.now() }),
    );
    const before = await fs.readFile(session.file, "utf8");
    await expect(
      agent.renameSessionTitle({ sessionId: session.id, title: "x" }),
    ).rejects.toMatchObject({ code: -32600, data: { reason: "thread_active_writer" } });
    expect(await fs.readFile(session.file, "utf8")).toBe(before);
  });

  it("renames a session loaded here through its CLI and publishes the title", async () => {
    const session = await writeTranscript({});
    const { agent, updates } = await indexAgent();
    const rename = vi.fn(async () => {});
    agent.sessions[session.id] = mockSessionState(
      { cwd: workspace, query: { renameSession: rename } },
      agent,
      session.id,
    ) as any;
    const before = await fs.readFile(session.file, "utf8");
    await agent.renameSessionTitle({ sessionId: session.id, title: "Live title" });
    expect(rename).toHaveBeenCalledWith("Live title", session.id);
    expect(await fs.readFile(session.file, "utf8")).toBe(before);
    expect(updates).toContainEqual({
      sessionId: session.id,
      update: { sessionUpdate: "session_info_update", title: "Live title" },
    });
  });

  it("waits for a title generation in flight, and the generated title never wins", async () => {
    const order: string[] = [];
    let finishGeneration!: (title: string) => void;
    const updates: any[] = [];
    const agent: any = {
      client: { sessionUpdate: async (update: unknown) => updates.push(update) },
      logger: { error: () => {} },
      sessions: {},
    };
    const titles = new SessionTitles(agent, "s1");
    const session: any = {
      queryClosed: false,
      cancelled: false,
      cwd: "/nowhere",
      query: {
        generateSessionTitle: () =>
          new Promise<string>((resolve) => {
            finishGeneration = (title) => {
              order.push("generated");
              resolve(title);
            };
          }),
      },
    };
    agent.sessions.s1 = session;
    titles.onPrompt([{ type: "text", text: "Please refactor the parser" }]);
    vi.mocked(getSessionInfo).mockResolvedValueOnce(undefined);
    await titles.onTurnEnd(session);

    const renamed = titles.setExplicitTitle("Mine", async () => {
      order.push("renamed");
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(order).toEqual([]);
    finishGeneration("Generated");
    await renamed;
    expect(order).toEqual(["generated", "renamed"]);
    const titlesSent = updates.map((update) => update.update.title);
    expect(titlesSent).toEqual(["Mine"]);
  });
});

describe("_session/archive and _session/unarchive", () => {
  it("append AIR's archive title records, are idempotent and keep updatedAt", async () => {
    const session = await writeTranscript({ prompt: "Fix  the\nparser" });
    const { agent } = await indexAgent();
    const [before] = (await agent.listSessions({ cwd: workspace })).sessions;
    const read = () => fs.readFile(session.file, "utf8");

    await agent.archiveSession({ sessionId: session.id });
    expect(await lastRecords(session.file)).toEqual(
      titleRecords(session.id, "[archived] Fix the parser"),
    );
    const archived = await read();
    await agent.archiveSession({ sessionId: session.id });
    expect(await read()).toBe(archived);
    const [row] = (
      await agent.listSessions({ cwd: workspace, _meta: listMeta({ archived: "archived" }) })
    ).sessions;
    expect(row).toMatchObject({ title: "Fix the parser", updatedAt: before!.updatedAt });
    expect((row!._meta as any).jetbrains.air.archived).toBe(true);
    // AIR writes no sidecar for an archive.
    expect(fsSync.existsSync(path.join(path.dirname(session.file), session.id))).toBe(false);

    await agent.unarchiveSession({ sessionId: session.id });
    expect(await lastRecords(session.file)).toEqual(titleRecords(session.id, "Fix the parser"));
    const unarchived = await read();
    await agent.unarchiveSession({ sessionId: session.id });
    expect(await read()).toBe(unarchived);
    expect((await agent.listSessions({ cwd: workspace })).sessions).toEqual([
      { ...before, title: "Fix the parser" },
    ]);
  });

  it("read a session archived by AIR, and rename it with the prefix kept", async () => {
    const session = await writeTranscript({
      trailer: [
        // An older explicit name, which the later agent name outranks.
        { type: "custom-title", customTitle: "Old", sessionId: randomUUID() },
        ...titleRecords("ignored", "[archived] Done work").map((record) => ({
          ...record,
          sessionId: undefined,
        })),
      ],
    });
    const { agent } = await indexAgent();
    const page = (archived: string) =>
      agent.listSessions({ cwd: workspace, _meta: listMeta({ archived }) });
    expect((await page("unarchived")).sessions).toEqual([]);
    expect((await page("archived")).sessions.map((s) => s.title)).toEqual(["Done work"]);

    await agent.renameSessionTitle({ sessionId: session.id, title: "Renamed" });
    expect(await lastRecords(session.file)).toEqual(titleRecords(session.id, "[archived] Renamed"));
    expect(
      JSON.parse(
        await fs.readFile(
          path.join(path.dirname(session.file), session.id, "custom-title.json"),
          "utf8",
        ),
      ),
    ).toEqual({ customTitle: "[archived] Renamed" });
    expect((await page("archived")).sessions.map((s) => s.title)).toEqual(["Renamed"]);
  });

  it("rank the agent name above the custom title for the archive state", async () => {
    const session = await writeTranscript({
      trailer: [
        { type: "agent-name", agentName: "Named", sessionId: "" },
        { type: "custom-title", customTitle: "[archived] Named", sessionId: "" },
      ],
    });
    const { agent } = await indexAgent();
    expect((await agent.listSessions({ cwd: workspace })).sessions.map((s) => s.title)).toEqual([
      "Named",
    ]);
    await agent.archiveSession({ sessionId: session.id });
    expect(await lastRecords(session.file)).toEqual(titleRecords(session.id, "[archived] Named"));
  });

  it("cut the archived title to the CLI's 200 characters", async () => {
    const long = "t".repeat(195);
    const session = await writeTranscript({
      trailer: [{ type: "custom-title", customTitle: long, sessionId: "" }],
    });
    const { agent } = await indexAgent();
    await agent.archiveSession({ sessionId: session.id });
    const [record] = (await lastRecords(session.file)) as { customTitle: string }[];
    expect(record!.customTitle).toBe(`[archived] ${long}`.slice(0, 200));
  });

  it("turn an archive marker into the title format", async () => {
    const archivedByMarker = await writeTranscript({});
    const unarchivedByMarker = await writeTranscript({});
    await writeMarker(archivedByMarker.id);
    await writeMarker(unarchivedByMarker.id);
    const { agent } = await indexAgent();
    const archivedRows = async () =>
      (
        await agent.listSessions({ cwd: workspace, _meta: listMeta({ archived: "archived" }) })
      ).sessions.map((s) => s.sessionId);
    expect((await archivedRows()).sort()).toEqual(
      [archivedByMarker.id, unarchivedByMarker.id].sort(),
    );

    await agent.archiveSession({ sessionId: archivedByMarker.id });
    expect(fsSync.existsSync(markerOf(archivedByMarker.id))).toBe(false);
    expect(await lastRecords(archivedByMarker.file)).toEqual(
      titleRecords(archivedByMarker.id, "[archived] Fix it"),
    );
    const before = await fs.readFile(unarchivedByMarker.file, "utf8");
    await agent.unarchiveSession({ sessionId: unarchivedByMarker.id });
    expect(fsSync.existsSync(markerOf(unarchivedByMarker.id))).toBe(false);
    expect(await fs.readFile(unarchivedByMarker.file, "utf8")).toBe(before);
    expect(await archivedRows()).toEqual([archivedByMarker.id]);
  });

  it("refuses an unknown session", async () => {
    const { agent } = await indexAgent();
    await expect(agent.archiveSession({ sessionId: randomUUID() })).rejects.toMatchObject({
      code: -32002,
    });
    await expect(agent.unarchiveSession({ sessionId: "not-a-uuid" })).rejects.toMatchObject({
      code: -32002,
    });
  });
});

describe("session/delete per client", () => {
  it("deletes the transcript and the marker for a sessionIndex client", async () => {
    const session = await writeTranscript({});
    const { agent } = await indexAgent();
    await agent.archiveSession({ sessionId: session.id });
    await agent.deleteSession({ sessionId: session.id });
    expect(fsSync.existsSync(session.file)).toBe(false);
    expect(fsSync.existsSync(path.join(configDir, "acp", "archived", session.id))).toBe(false);
    await expect(agent.deleteSession({ sessionId: session.id })).rejects.toMatchObject({
      code: -32002,
    });
  });

  it("refuses a session held by another process", async () => {
    const session = await writeTranscript({});
    await fs.mkdir(path.join(configDir, "sessions"), { recursive: true });
    await fs.writeFile(
      path.join(configDir, "sessions", `${process.pid}.json`),
      JSON.stringify({ pid: process.pid, sessionId: session.id, updatedAt: Date.now() }),
    );
    const { agent } = await indexAgent();
    await expect(agent.deleteSession({ sessionId: session.id })).rejects.toMatchObject({
      data: { reason: "thread_active_writer" },
    });
    expect(fsSync.existsSync(session.file)).toBe(true);
  });

  it("archives instead of deleting for an AIR client without sessionIndex", async () => {
    const session = await writeTranscript({});
    const { agent } = createAgent();
    await initializeClient(agent, air());
    await agent.deleteSession({ sessionId: session.id });
    expect(deleteSession).not.toHaveBeenCalled();
    expect(fsSync.existsSync(session.file)).toBe(true);
    expect(await lastRecords(session.file)).toEqual(titleRecords(session.id, "[archived] Fix it"));
    expect(fsSync.existsSync(markerOf(session.id))).toBe(false);
    expect((await agent.listSessions({ cwd: workspace })).sessions).toEqual([]);
  });

  it("refuses the archive of an AIR client without sessionIndex for a session held elsewhere", async () => {
    const session = await writeTranscript({});
    await registerHolder(process.pid, session.id);
    const { agent } = createAgent();
    await initializeClient(agent, air());
    const before = await fs.readFile(session.file, "utf8");
    await expect(agent.deleteSession({ sessionId: session.id })).rejects.toMatchObject({
      data: { reason: "thread_active_writer" },
    });
    expect(await fs.readFile(session.file, "utf8")).toBe(before);
  });

  it("deletes with the SDK for a client that is not AIR", async () => {
    const session = await writeTranscript({});
    const { agent } = createAgent();
    await initializeClient(agent, {});
    await agent.deleteSession({ sessionId: session.id });
    expect(deleteSession).toHaveBeenCalledWith(session.id);
    expect(fsSync.existsSync(session.file)).toBe(false);
    expect(fsSync.existsSync(path.join(configDir, "acp"))).toBe(false);
  });
});

describe("_session/list_changed", () => {
  const waitFor = async (predicate: () => boolean, timeoutMs = 3000) => {
    const start = Date.now();
    while (!predicate()) {
      if (Date.now() - start > timeoutMs) return false;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return true;
  };

  it("notifies a sessionIndex client once per burst of changes in a listed cwd", async () => {
    const session = await writeTranscript({});
    const { agent, notifications } = await indexAgent();
    await agent.listSessions({ cwd: workspace });
    // Let the watcher take its baseline.
    await new Promise((resolve) => setTimeout(resolve, 100));
    for (let i = 0; i < 5; i++) await fs.appendFile(session.file, "{}\n");
    expect(await waitFor(() => notifications.length > 0)).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(notifications).toEqual([
      { method: "_session/list_changed", params: { cwd: workspace } },
    ]);
    await agent.dispose();
  });

  it("never watches or notifies for a client without sessionIndex", async () => {
    const session = await writeTranscript({});
    const { agent, notifications } = createAgent();
    await initializeClient(agent, air());
    await agent.listSessions({ cwd: workspace });
    await fs.appendFile(session.file, "{}\n");
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(notifications.filter((n) => n.method === "_session/list_changed")).toEqual([]);
  });

  it("debounces with a maximum wait and skips unchanged state", async () => {
    const session = await writeTranscript({});
    const notified: string[] = [];
    const watcher = new ListChangedWatcher({
      projectDirs: async () => ({ dirNames: [encodeProjectPath(workspace)], paths: [workspace] }),
      notify: async (cwd) => {
        notified.push(cwd);
      },
      debounceMs: 100,
      maxWaitMs: 250,
      rescanMs: 60_000,
    });
    await watcher.onListed(workspace);
    // Keep writing faster than the debounce: the max wait still flushes.
    const writer = setInterval(() => fsSync.appendFileSync(session.file, "{}\n"), 30);
    expect(await waitFor(() => notified.length > 0, 2000)).toBe(true);
    clearInterval(writer);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const settled = notified.length;
    // An event without a change (a touch of another file) sends nothing.
    await fs.writeFile(path.join(path.dirname(session.file), "notes.txt"), "x");
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(notified.length).toBe(settled);
    watcher.dispose();
  });
});

/** Registers `pid` as a live CLI holding `sessionId`. */
async function registerHolder(pid: number, sessionId: string, extra: object = {}) {
  await fs.mkdir(path.join(configDir, "sessions"), { recursive: true });
  await fs.writeFile(
    path.join(configDir, "sessions", `${pid}.json`),
    JSON.stringify({ pid, sessionId, updatedAt: Date.now(), ...extra }),
  );
}

describe("ownership of a session for delete and rename", () => {
  it("checks the registry for a session whose query closed here", async () => {
    const session = await writeTranscript({});
    const { agent } = await indexAgent();
    // The stream ended, the husk stays mapped; another process resumed it.
    agent.sessions[session.id] = mockSessionState({ queryClosed: true }, agent, session.id) as any;
    await registerHolder(process.pid, session.id);

    await expect(agent.deleteSession({ sessionId: session.id })).rejects.toMatchObject({
      data: { reason: "thread_active_writer" },
    });
    expect(fsSync.existsSync(session.file)).toBe(true);
    const before = await fs.readFile(session.file, "utf8");
    await expect(
      agent.renameSessionTitle({ sessionId: session.id, title: "x" }),
    ).rejects.toMatchObject({ data: { reason: "thread_active_writer" } });
    await expect(agent.archiveSession({ sessionId: session.id })).rejects.toMatchObject({
      data: { reason: "thread_active_writer" },
    });
    expect(await fs.readFile(session.file, "utf8")).toBe(before);
  });

  describe.skipIf(process.platform === "win32")("a CLI child of this process", () => {
    let child: ChildProcess | undefined;
    afterEach(() => {
      child?.kill("SIGKILL");
      child = undefined;
    });

    const exitingChild = () => {
      const spawned = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], {
        stdio: "ignore",
      });
      child = spawned;
      const state = { killedAt: Infinity };
      return {
        pid: spawned.pid!,
        state,
        exit: () => {
          state.killedAt = Date.now();
          spawned.kill("SIGKILL");
        },
      };
    };

    it("is waited for, not refused, before a delete or a rename", async () => {
      const deleted = await writeTranscript({});
      const renamed = await writeTranscript({});
      const { agent } = await indexAgent();

      // The CLI that this adapter just closed is still registered, and exits.
      const first = exitingChild();
      await registerHolder(first.pid, deleted.id, { entrypoint: "sdk-ts" });
      setTimeout(first.exit, 300);
      await agent.deleteSession({ sessionId: deleted.id });
      expect(Date.now()).toBeGreaterThanOrEqual(first.state.killedAt);
      expect(fsSync.existsSync(deleted.file)).toBe(false);

      const second = exitingChild();
      await registerHolder(second.pid, renamed.id, { entrypoint: "sdk-ts" });
      setTimeout(second.exit, 300);
      await agent.renameSessionTitle({ sessionId: renamed.id, title: "Renamed" });
      expect(Date.now()).toBeGreaterThanOrEqual(second.state.killedAt);
      expect((await agent.listSessions({ cwd: workspace })).sessions[0]!.title).toBe("Renamed");
    });

    it("is waited for after a delete tears down a running session", async () => {
      const session = await writeTranscript({});
      const { agent } = await indexAgent();
      agent.sessions[session.id] = mockSessionState(
        { input: { end: () => {} }, query: { close: () => {}, interrupt: async () => {} } },
        agent,
        session.id,
      ) as any;
      const running = exitingChild();
      await registerHolder(running.pid, session.id, { entrypoint: "sdk-ts" });
      setTimeout(running.exit, 300);
      await agent.deleteSession({ sessionId: session.id });
      expect(Date.now()).toBeGreaterThanOrEqual(running.state.killedAt);
      expect(fsSync.existsSync(session.file)).toBe(false);
    });
  });
});

describe("session/delete of an AIR client without sessionIndex", () => {
  it("fails for an unknown session as the SDK delete did, and writes no marker", async () => {
    const { agent } = createAgent();
    await initializeClient(agent, air());
    for (const sessionId of [randomUUID(), "not-a-uuid"]) {
      const sdkError = await vi.mocked(deleteSession).getMockImplementation()!(sessionId).then(
        () => undefined,
        (error: Error) => error,
      );
      expect(sdkError).toBeInstanceOf(Error);
      vi.mocked(deleteSession).mockClear();
      await expect(agent.deleteSession({ sessionId })).rejects.toThrow(sdkError!.message);
      expect(deleteSession).not.toHaveBeenCalled();
    }
    expect(fsSync.existsSync(path.join(configDir, "acp", "archived"))).toBe(false);
  });
});

describe("session index service lifecycle", () => {
  it("starts no watcher after dispose, also for a list in flight", async () => {
    await writeTranscript({});
    const service = new SessionIndexService({
      notifyListChanged: async () => {},
      logError: () => {},
    });
    const inFlight = service.list({ cwd: workspace }, () => undefined);
    service.dispose();
    await inFlight;
    await service.list({ cwd: workspace }, () => undefined);
    expect((service as any).watcher).toBeUndefined();
  });
});

describe("rename of a session with several transcripts", () => {
  it("titles every copy, and the list shows the new title at once", async () => {
    const other = path.join(workspace, "other");
    const small = await writeTranscript({ cwd: other });
    const large = await writeTranscript({
      sessionId: small.id,
      cwd: workspace,
      trailer: [{ type: "last-prompt", lastPrompt: "x".repeat(500), sessionId: small.id }],
    });
    const { agent } = await indexAgent();
    // Caches the metadata of the listed (larger) copy.
    expect((await agent.listSessions({})).sessions[0]!.title).not.toBe("Both copies");

    await agent.renameSessionTitle({ sessionId: small.id, title: "Both copies" });
    for (const file of [small.file, large.file]) {
      const records = (await fs.readFile(file, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(records.filter((record) => record.type === "custom-title")).toEqual([
        { type: "custom-title", customTitle: "Both copies", sessionId: small.id },
      ]);
    }
    const page = await agent.listSessions({});
    expect(page.sessions.map((s) => [s.sessionId, s.title])).toEqual([[small.id, "Both copies"]]);
  });
});

describe("delete of a session with several transcripts", () => {
  it("reports a copy it could not delete and keeps the session archived", async () => {
    const first = await writeTranscript({ cwd: path.join(workspace, "a") });
    const second = await writeTranscript({
      sessionId: first.id,
      cwd: path.join(workspace, "b"),
    });
    const { agent } = await indexAgent();
    await agent.archiveSession({ sessionId: first.id });
    for (const file of [first.file, second.file]) {
      expect(await lastRecords(file)).toEqual(titleRecords(first.id, "[archived] Fix it"));
    }
    const marker = await writeMarker(first.id);
    const actual = vi.mocked(deleteSession).getMockImplementation()!;
    vi.mocked(deleteSession)
      .mockImplementationOnce(actual)
      .mockImplementationOnce(async () => {
        throw new Error("EACCES: permission denied");
      });

    await expect(agent.deleteSession({ sessionId: first.id })).rejects.toThrow("EACCES");
    expect([first.file, second.file].filter((file) => fsSync.existsSync(file))).toHaveLength(1);
    expect(fsSync.existsSync(marker)).toBe(true);
    expect(
      (await agent.listSessions({ _meta: listMeta({ archived: "archived" }) })).sessions.map(
        (s) => s.sessionId,
      ),
    ).toEqual([first.id]);

    await agent.deleteSession({ sessionId: first.id });
    expect([first.file, second.file].filter((file) => fsSync.existsSync(file))).toEqual([]);
    expect(fsSync.existsSync(marker)).toBe(false);
  });
});

describe("cwd recovery from a sibling transcript", () => {
  it("does not depend on the batch the sibling is read in", async () => {
    const base = Date.parse("2026-04-01T00:00:00Z");
    const other = path.join(workspace, "other");
    // Newest, without a cwd of its own; its only sibling with a cwd is the
    // oldest transcript, past the point where the page is full.
    const noCwd = await writeTranscript({ cwd: other, recordCwd: null, lastMessageAt: base });
    const fillers: string[] = [];
    for (let i = 1; i <= 16; i++) {
      fillers.push((await writeTranscript({ lastMessageAt: base - i * 1000 })).id);
    }
    await writeTranscript({ cwd: other, lastMessageAt: base - 3600_000 });
    const { agent } = await indexAgent();
    for (let attempt = 0; attempt < 2; attempt++) {
      const page = await agent.listSessions({ _meta: listMeta({ limit: 2 }) });
      expect(page.sessions.map((s) => [s.sessionId, s.cwd])).toEqual([
        [noCwd.id, other],
        [fillers[0], workspace],
      ]);
    }
  });
});

describe("a last message longer than the tail window", () => {
  it("keeps the session at its last message time after a metadata record", async () => {
    const lastMessageAt = Date.parse("2026-05-01T00:00:00Z");
    const id = randomUUID();
    const session = await writeTranscript({
      sessionId: id,
      lastMessageAt: lastMessageAt - 60_000,
      mtimeMs: lastMessageAt + 3600_000,
      trailer: [
        {
          type: "assistant",
          sessionId: id,
          cwd: workspace,
          uuid: randomUUID(),
          timestamp: new Date(lastMessageAt).toISOString(),
          message: {
            role: "assistant",
            content: [{ type: "text", text: "y".repeat(300_000) }],
            stop_reason: "end_turn",
          },
        },
        { type: "custom-title", customTitle: "Renamed later", sessionId: id },
      ],
    });
    const { agent } = await indexAgent();
    const page = await agent.listSessions({ cwd: workspace });
    expect(page.sessions.map((s) => [s.sessionId, s.updatedAt])).toEqual([
      [session.id, new Date(lastMessageAt).toISOString()],
    ]);
  });
});

describe("custom title sidecar", () => {
  it("survives concurrent writes and leaves other temporary files alone", async () => {
    const session = await writeTranscript({});
    const dir = path.join(path.dirname(session.file), session.id);
    await fs.mkdir(dir, { recursive: true });
    const foreign = path.join(dir, "custom-title.json.tmp.foreign");
    await fs.writeFile(foreign, "{}");
    const titles = Array.from({ length: 20 }, (_, i) => `Title ${i}`);
    await Promise.all(titles.map((title) => writeCustomTitleSidecar(session.file, title)));
    const written = JSON.parse(await fs.readFile(path.join(dir, "custom-title.json"), "utf8"));
    expect(titles).toContain(written.customTitle);
    expect((await fs.readdir(dir)).sort()).toEqual([
      "custom-title.json",
      "custom-title.json.tmp.foreign",
    ]);
  });
});

describe("long project paths that share a prefix", () => {
  const longBase = () => path.join(workspace, "x".repeat(210));

  it("lists only the directories whose transcripts belong to the path", async () => {
    const mine = path.join(longBase(), "mine");
    const theirs = path.join(longBase(), "theirs");
    const own = await writeTranscript({ cwd: mine });
    // The CLI hashes a long name differently from the SDK.
    const prefix = encodeProjectPath(mine).slice(0, 200);
    const cliCopy = await writeTranscript({ cwd: mine, dirName: `${prefix}-cli0hash` });
    await writeTranscript({ cwd: theirs });
    expect(encodeProjectPath(theirs).startsWith(prefix)).toBe(true);
    const { agent } = await indexAgent();

    const page = await agent.listSessions({ cwd: mine });
    expect(page.sessions.map((s) => s.sessionId).sort()).toEqual([own.id, cliCopy.id].sort());
  });

  it("does not notify a cwd of a live record of another long path", async () => {
    const mine = path.join(longBase(), "mine");
    const theirs = path.join(longBase(), "theirs");
    await writeTranscript({ cwd: mine });
    await writeTranscript({ cwd: theirs });
    await fs.mkdir(path.join(configDir, "sessions"), { recursive: true });
    const notified: string[] = [];
    const service = new SessionIndexService({
      notifyListChanged: async ({ cwd }) => {
        notified.push(cwd);
      },
      logError: () => {},
    });
    await service.list({ cwd: mine }, () => undefined);
    await new Promise((resolve) => setTimeout(resolve, 100));
    await registerHolder(process.pid, randomUUID(), { cwd: theirs });
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(notified).toEqual([]);
    await registerHolder(process.pid, randomUUID(), { cwd: mine });
    const start = Date.now();
    while (notified.length === 0 && Date.now() - start < 3000) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(notified).toEqual([mine]);
    service.dispose();
  });
});

describe("session title after an explicit rename", () => {
  it("never publishes the title a turn end read before the rename", async () => {
    const updates: any[] = [];
    const agent: any = {
      client: { sessionUpdate: async (update: unknown) => updates.push(update) },
      logger: { error: () => {} },
      sessions: {},
    };
    const titles = new SessionTitles(agent, "s1");
    const session: any = { queryClosed: false, cancelled: false, cwd: "/nowhere", query: {} };
    agent.sessions.s1 = session;
    let resolveInfo!: (info: any) => void;
    vi.mocked(getSessionInfo).mockImplementationOnce(
      () => new Promise((resolve) => (resolveInfo = resolve)),
    );
    const turnEnd = titles.onTurnEnd(session);
    await titles.setExplicitTitle("Mine", async () => {});
    resolveInfo({ customTitle: "Old", summary: "Old", lastModified: Date.now() });
    await turnEnd;
    await titles.onTurnEnd(session);
    expect(updates.map((update) => update.update.title)).toEqual(["Mine"]);
  });
});

describe("worktrees after git worktree move", () => {
  it("follows a moved linked worktree", async () => {
    const repo = path.join(workspace, "repo");
    const before = path.join(workspace, "before");
    const after = path.join(workspace, "after");
    const meta = path.join(repo, ".git", "worktrees", "wt");
    await fs.mkdir(meta, { recursive: true });
    await fs.mkdir(before);
    await fs.writeFile(path.join(meta, "gitdir"), `${path.join(before, ".git")}\n`);
    // The move rewrites the gitdir file only: the directory keeps its mtime.
    const worktreesDir = path.dirname(meta);
    await fs.utimes(worktreesDir, 1_700_000_000, 1_700_000_000);
    expect(await repositoryWorktrees(repo)).toEqual([repo, before]);

    await fs.rename(before, after);
    await fs.writeFile(path.join(meta, "gitdir"), `${path.join(after, ".git")}\n`);
    await fs.utimes(worktreesDir, 1_700_000_000, 1_700_000_000);
    expect(await repositoryWorktrees(repo)).toEqual([repo, after]);
  });
});

/** The real SDK `deleteSession`, behind the spy. */
const sdkDelete = () => vi.mocked(deleteSession).getMockImplementation()!;

describe("empty transcripts on delete", () => {
  it("deletes a session that has only an empty transcript, and its session directory", async () => {
    const id = randomUUID();
    const dir = path.join(configDir, "projects", encodeProjectPath(workspace));
    await fs.mkdir(path.join(dir, id), { recursive: true });
    await fs.writeFile(path.join(dir, `${id}.jsonl`), "");
    const { agent } = await indexAgent();
    await agent.deleteSession({ sessionId: id });
    expect(await fs.readdir(dir)).toEqual([]);
  });

  it("deletes a real and an empty copy of a session", async () => {
    const real = await writeTranscript({ cwd: path.join(workspace, "a") });
    const emptyDir = path.join(configDir, "projects", encodeProjectPath(path.join(workspace, "b")));
    await fs.mkdir(emptyDir, { recursive: true });
    await fs.writeFile(path.join(emptyDir, `${real.id}.jsonl`), "");
    const { agent } = await indexAgent();
    await agent.deleteSession({ sessionId: real.id });
    expect(fsSync.existsSync(real.file)).toBe(false);
    expect(await fs.readdir(emptyDir)).toEqual([]);
  });

  it("archives for an AIR client without sessionIndex only what the SDK delete would find", async () => {
    const id = randomUUID();
    const dir = path.join(configDir, "projects", encodeProjectPath(workspace));
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, `${id}.jsonl`), "");
    const sdkError = await sdkDelete()(id).then(
      () => undefined,
      (error: Error) => error,
    );
    const service = new SessionIndexService({
      notifyListChanged: async () => {},
      logError: () => {},
    });
    await expect(archiveInsteadOfDelete(id, service)).rejects.toThrow(sdkError!.message);
    expect(await fs.readFile(path.join(dir, `${id}.jsonl`), "utf8")).toBe("");
  });
});

describe("a failing SDK delete", () => {
  it("fails the request when the session directory could not be removed, and a retry finishes", async () => {
    const session = await writeTranscript({});
    const sessionDir = path.join(path.dirname(session.file), session.id);
    await fs.mkdir(path.join(sessionDir, "subagents"), { recursive: true });
    await fs.writeFile(path.join(sessionDir, "subagents", "agent-1.jsonl"), "{}\n");
    const { agent } = await indexAgent();
    const marker = await writeMarker(session.id);
    // The SDK removed the transcript, then failed to remove `<id>/`.
    vi.mocked(deleteSession).mockImplementationOnce(async () => {
      await fs.rm(session.file);
      throw Object.assign(new Error("EACCES: permission denied, rmdir"), { code: "EACCES" });
    });
    await expect(agent.deleteSession({ sessionId: session.id })).rejects.toThrow("EACCES");
    expect(fsSync.existsSync(marker)).toBe(true);
    expect(fsSync.existsSync(sessionDir)).toBe(true);

    // The retry finds the session directory without a transcript.
    await agent.deleteSession({ sessionId: session.id });
    expect(fsSync.existsSync(sessionDir)).toBe(false);
    expect(fsSync.existsSync(marker)).toBe(false);
  });

  it("removes a session directory that the SDK left behind", async () => {
    const session = await writeTranscript({});
    const sessionDir = path.join(path.dirname(session.file), session.id);
    await fs.mkdir(sessionDir);
    const { agent } = await indexAgent();
    vi.mocked(deleteSession).mockImplementationOnce(async () => {
      await fs.rm(session.file);
    });
    await agent.deleteSession({ sessionId: session.id });
    expect(fsSync.existsSync(sessionDir)).toBe(false);
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "fails the request when a session directory cannot be removed",
    async () => {
      const session = await writeTranscript({});
      const projectDir = path.dirname(session.file);
      const sessionDir = path.join(projectDir, session.id);
      await fs.mkdir(sessionDir);
      const { agent } = await indexAgent();
      await writeMarker(session.id);
      vi.mocked(deleteSession).mockImplementationOnce(async () => {
        await fs.rm(session.file);
        await fs.chmod(projectDir, 0o500);
      });
      try {
        await expect(agent.deleteSession({ sessionId: session.id })).rejects.toThrow();
      } finally {
        await fs.chmod(projectDir, 0o700);
      }
      expect(fsSync.existsSync(sessionDir)).toBe(true);
      expect(fsSync.existsSync(path.join(configDir, "acp", "archived", session.id))).toBe(true);
    },
  );
});

describe("a long project directory whose transcript gets its cwd later", () => {
  it("is listed once a transcript in it names the path", async () => {
    const mine = path.join(workspace, "x".repeat(210), "mine");
    const prefix = encodeProjectPath(mine).slice(0, 200);
    const session = await writeTranscript({
      cwd: mine,
      recordCwd: null,
      dirName: `${prefix}-cli0hash`,
    });
    const { agent } = await indexAgent();
    expect((await agent.listSessions({ cwd: mine })).sessions).toEqual([]);
    // Appending does not change the directory mtime.
    await fs.appendFile(
      session.file,
      JSON.stringify({ type: "user", cwd: mine, sessionId: session.id, message: {} }) + "\n",
    );
    expect((await agent.listSessions({ cwd: mine })).sessions.map((s) => s.sessionId)).toEqual([
      session.id,
    ]);
  });
});

describe("rename of a running session with several transcripts", () => {
  it("titles the other copies here and leaves the CLI's own copy to the CLI", async () => {
    const own = await writeTranscript({ cwd: workspace });
    const other = await writeTranscript({
      sessionId: own.id,
      cwd: path.join(workspace, "moved"),
      trailer: [{ type: "last-prompt", lastPrompt: "x".repeat(500), sessionId: own.id }],
    });
    const { agent } = await indexAgent();
    await agent.listSessions({});
    const cliRecord = titleRecords(own.id, "Live title")
      .map((record) => JSON.stringify(record) + "\n")
      .join("");
    // The CLI titles its own transcript.
    const rename = vi.fn(async () => {
      await fs.appendFile(own.file, cliRecord);
    });
    const ownBefore = await fs.readFile(own.file, "utf8");
    agent.sessions[own.id] = mockSessionState(
      { cwd: workspace, query: { renameSession: rename } },
      agent,
      own.id,
    ) as any;
    await agent.renameSessionTitle({ sessionId: own.id, title: "Live title" });

    expect(rename).toHaveBeenCalledWith("Live title", own.id);
    expect(await fs.readFile(own.file, "utf8")).toBe(ownBefore + cliRecord);
    expect(fsSync.existsSync(path.join(path.dirname(own.file), own.id))).toBe(false);
    expect(await lastRecords(other.file)).toEqual(titleRecords(own.id, "Live title"));
    const sidecar = path.join(path.dirname(other.file), own.id, "custom-title.json");
    expect(JSON.parse(await fs.readFile(sidecar, "utf8"))).toEqual({ customTitle: "Live title" });
    expect((await agent.listSessions({})).sessions[0]!.title).toBe("Live title");
  });
});

describe("the stored title of an archived session at turn end", () => {
  it("is published without the prefix to a sessionIndex client only", async () => {
    for (const [capabilities, expected] of [
      [["sessionIndex"], "Done"],
      [[], "[archived] Done"],
    ] as const) {
      const { agent, updates } = createAgent();
      await initializeClient(agent, air(...capabilities));
      const titles = new SessionTitles(agent, "s1");
      vi.mocked(getSessionInfo).mockResolvedValueOnce({
        sessionId: "s1",
        summary: "[archived] Done",
        customTitle: "[archived] Done",
        lastModified: 0,
      });
      await titles.onTurnEnd({ queryClosed: false, cwd: workspace } as any);
      expect(updates.map((update: any) => update.update.title)).toEqual([expected]);
    }
  });
});

describe("a failed rename", () => {
  it("leaves the title open to generation", async () => {
    const updates: any[] = [];
    const agent: any = {
      client: { sessionUpdate: async (update: unknown) => updates.push(update) },
      logger: { error: () => {} },
      sessions: {},
    };
    const titles = new SessionTitles(agent, "s1");
    const session: any = {
      queryClosed: false,
      cancelled: false,
      cwd: "/nowhere",
      query: { generateSessionTitle: async () => "Generated" },
    };
    agent.sessions.s1 = session;
    titles.onPrompt([{ type: "text", text: "Please refactor the parser module" }]);
    await expect(
      titles.setExplicitTitle("Mine", async () => {
        throw new Error("disk full");
      }),
    ).rejects.toThrow("disk full");
    vi.mocked(getSessionInfo).mockResolvedValueOnce(undefined);
    await titles.onTurnEnd(session);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(updates.map((update) => update.update.title)).toEqual(["Generated"]);
  });
});

describe("a title record after a torn last line", () => {
  it("is not written for a running session whose CLI cannot take a title", async () => {
    const session = await writeTranscript({});
    await fs.appendFile(session.file, '{"type":"assistant","mess');
    const before = await fs.readFile(session.file, "utf8");
    const { agent } = await indexAgent();
    // A running session whose SDK has no rename control request: its CLI
    // holds the title and would write it back.
    agent.sessions[session.id] = mockSessionState({ cwd: workspace }, agent, session.id) as any;
    await expect(
      agent.renameSessionTitle({ sessionId: session.id, title: "Later" }),
    ).rejects.toMatchObject({ code: -32600 });
    await expect(agent.archiveSession({ sessionId: session.id })).rejects.toMatchObject({
      code: -32600,
    });
    expect(await fs.readFile(session.file, "utf8")).toBe(before);
  });

  it("follows a complete line when no process writes the transcript", async () => {
    const session = await writeTranscript({});
    await fs.appendFile(session.file, '{"type":"assistant","mess');
    const { agent } = await indexAgent();
    await agent.renameSessionTitle({ sessionId: session.id, title: "Later" });
    const lines = (await fs.readFile(session.file, "utf8")).split("\n");
    expect(lines.slice(-4)).toEqual([
      '{"type":"assistant","mess',
      ...titleRecords(session.id, "Later").map((record) => JSON.stringify(record)),
      "",
    ]);
  });
});

describe("cwd recovery in a directory without any cwd", () => {
  it("reads a bounded number of transcripts, and not again until it changes", async () => {
    const base = Date.parse("2026-06-01T00:00:00Z");
    const other = path.join(workspace, "other");
    await writeTranscript({ cwd: other, recordCwd: null, lastMessageAt: base });
    for (let i = 1; i <= 20; i++) await writeTranscript({ lastMessageAt: base - i * 1000 });
    for (let i = 0; i < 100; i++) {
      await writeTranscript({ cwd: other, recordCwd: null, lastMessageAt: base - 3600_000 - i });
    }
    const { agent } = await indexAgent();
    vi.mocked(getSessionInfo).mockClear();
    await agent.listSessions({ _meta: listMeta({ limit: 2 }) });
    expect(vi.mocked(getSessionInfo).mock.calls.length).toBeLessThanOrEqual(16 + 64);
    vi.mocked(getSessionInfo).mockClear();
    await agent.listSessions({ _meta: listMeta({ limit: 2 }) });
    expect(getSessionInfo).not.toHaveBeenCalled();
  });
});

describe("tail growth", () => {
  const big = (id: string, at: number, size: number) =>
    JSON.stringify({
      type: "assistant",
      sessionId: id,
      timestamp: new Date(at).toISOString(),
      message: { role: "assistant", content: [{ type: "text", text: "z".repeat(size) }] },
    });

  it("finds a last message beyond the first grown windows", async () => {
    const id = randomUUID();
    const file = path.join(workspace, `${id}.jsonl`);
    const at = Date.parse("2026-07-01T00:00:00Z");
    await fs.writeFile(file, `${big(id, at - 1000, 10)}\n${big(id, at, 2_000_000)}\n`);
    const { size } = await fs.stat(file);
    expect((await scanTranscriptFile(file, size, id)).lastMessageAt).toBe(at);
  });

  it("does not search a transcript of the same size again", async () => {
    const id = randomUUID();
    const file = path.join(workspace, `${id}.jsonl`);
    const at = Date.parse("2026-07-01T00:00:00Z");
    const filler = JSON.stringify({ type: "progress", data: "q".repeat(5_000_000) });
    const first = `${big(id, at, 10)}\n${filler}\n`;
    const size = Buffer.byteLength(first);
    await fs.writeFile(file, first);
    expect((await scanTranscriptFile(file, size, id)).lastMessageAt).toBeUndefined();
    // Same path and size, a message 100 KB before the end now: the cached
    // miss stands, the tail is not searched again.
    const message = big(id, at, 10);
    const pad = JSON.stringify({ type: "progress", data: "p".repeat(100_000) });
    const moved = JSON.stringify({
      type: "progress",
      data: "q".repeat(5_000_000 - message.length - pad.length - 2),
    });
    const second = `${message}\n${moved}\n${message}\n${pad}\n`;
    expect(Buffer.byteLength(second)).toBe(size);
    await fs.writeFile(file, second);
    expect((await scanTranscriptFile(file, size, id)).lastMessageAt).toBeUndefined();
  });
});

describe("a CLI child of this process that does not exit", () => {
  let child: ChildProcess | undefined;
  afterEach(() => {
    child?.kill("SIGKILL");
    child = undefined;
  });

  it.skipIf(process.platform === "win32")("is a holder once the wait is over", async () => {
    const session = await writeTranscript({});
    child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" });
    await registerHolder(child.pid!, session.id, { entrypoint: "sdk-ts" });
    const service = new SessionIndexService({
      registry: new LiveSessionRegistry({ ownChildExitTimeoutMs: 200 }),
      notifyListChanged: async () => {},
      logError: () => {},
    });
    await expect(service.assertNotHeldElsewhere(session.id)).rejects.toMatchObject({
      data: { reason: "thread_active_writer" },
    });
    expect(fsSync.existsSync(session.file)).toBe(true);
  });
});

describe("other copies on a running session's rename", () => {
  async function runningWithCopy(otherTrailer = "") {
    const own = await writeTranscript({ cwd: workspace });
    const other = await writeTranscript({ sessionId: own.id, cwd: path.join(workspace, "moved") });
    if (otherTrailer) await fs.appendFile(other.file, otherTrailer);
    const { agent, updates } = await indexAgent();
    agent.sessions[own.id] = mockSessionState(
      { cwd: workspace, query: { renameSession: async () => {} } },
      agent,
      own.id,
    ) as any;
    return { agent, updates, own, other };
  }

  it("leaves a copy alone whose last line another process may be writing", async () => {
    const { agent, other, own } = await runningWithCopy('{"type":"assistant","mess');
    const before = await fs.readFile(other.file, "utf8");
    await agent.renameSessionTitle({ sessionId: own.id, title: "Live" });
    expect(await fs.readFile(other.file, "utf8")).toBe(before);
    expect(fsSync.existsSync(path.join(path.dirname(other.file), own.id))).toBe(false);
  });

  it("succeeds once the CLI has the title, even when another copy fails", async () => {
    const { agent, updates, other, own } = await runningWithCopy();
    // A file where the sidecar directory would go.
    await fs.writeFile(path.join(path.dirname(other.file), own.id), "");
    await agent.renameSessionTitle({ sessionId: own.id, title: "Live" });
    expect(updates).toContainEqual({
      sessionId: own.id,
      update: { sessionUpdate: "session_info_update", title: "Live" },
    });
  });
});

describe("list metadata of the listed copy", () => {
  it("takes the title from the listed transcript, not another copy", async () => {
    const id = randomUUID();
    // Sorted first, so the SDK finds this copy first without a dir.
    await writeTranscript({
      sessionId: id,
      cwd: path.join(workspace, "a"),
      trailer: [{ type: "custom-title", customTitle: "Old copy", sessionId: id }],
    });
    await writeTranscript({
      sessionId: id,
      cwd: path.join(workspace, "b"),
      trailer: [
        { type: "custom-title", customTitle: "Listed copy", sessionId: id },
        { type: "last-prompt", lastPrompt: "x".repeat(300), sessionId: id },
      ],
    });
    const { agent } = await indexAgent();
    const page = await agent.listSessions({});
    expect(page.sessions.map((s) => s.title)).toEqual(["Listed copy"]);
  });

  it("keeps a row whose copy the SDK does not find", async () => {
    const session = await writeTranscript({});
    vi.mocked(getSessionInfo).mockResolvedValueOnce(undefined);
    const { agent } = await indexAgent();
    const page = await agent.listSessions({ cwd: workspace });
    expect(page.sessions.map((s) => [s.sessionId, s.title])).toEqual([[session.id, "Fix it"]]);
  });
});

describe("a continued session", () => {
  it("is hidden once its successor has history, as in the SDK list", async () => {
    const successorId = randomUUID();
    const predecessor = await writeTranscript({
      lastMessageAt: Date.parse("2026-08-01T00:00:00Z"),
      trailer: [{ type: "continued-in", continuedInSessionId: successorId }],
    });
    const stub = await writeTranscript({
      sessionId: successorId,
      lastMessageAt: Date.parse("2026-08-01T01:00:00Z"),
    });
    const { agent } = await indexAgent();
    const ids = async () =>
      (await agent.listSessions({ cwd: workspace })).sessions.map((s) => s.sessionId);
    const sdkIds = async () => (await listSessions({ dir: workspace })).map((s) => s.sessionId);

    // The successor has no history yet: both are listed.
    expect((await ids()).sort()).toEqual([predecessor.id, stub.id].sort());
    expect((await sdkIds()).sort()).toEqual([predecessor.id, stub.id].sort());

    await fs.appendFile(
      stub.file,
      JSON.stringify({ type: "user", parentUuid: null, sessionId: successorId, cwd: workspace }) +
        "\n",
    );
    expect(await ids()).toEqual([successorId]);
    expect(await sdkIds()).toEqual([successorId]);
  });
});

describe.skipIf(process.platform !== "darwin")("a project directory renamed in case", () => {
  it("is the project directory of the cwd on a case-insensitive volume", async () => {
    const lower = path.join(workspace, "repo");
    const upper = path.join(workspace, "Repo");
    const session = await writeTranscript({ cwd: lower });
    if (!fsSync.existsSync(path.join(configDir, "projects", encodeProjectPath(upper)))) return;
    const { agent } = await indexAgent();
    const page = await agent.listSessions({ cwd: upper });
    expect(page.sessions.map((s) => s.sessionId)).toEqual([session.id]);
    // The SDK finds it too.
    expect((await listSessions({ dir: upper })).map((s) => s.sessionId)).toEqual([session.id]);
  });
});

describe("delete of a session that runs here", () => {
  it("is refused after the teardown when another process holds it", async () => {
    const session = await writeTranscript({});
    const { agent } = await indexAgent();
    agent.sessions[session.id] = mockSessionState(
      { input: { end: () => {} }, query: { close: () => {}, interrupt: async () => {} } },
      agent,
      session.id,
    ) as any;
    // Another CLI resumed the session meanwhile.
    await registerHolder(process.pid, session.id);
    await expect(agent.deleteSession({ sessionId: session.id })).rejects.toMatchObject({
      data: { reason: "thread_active_writer" },
    });
    expect(agent.sessions[session.id]).toBeUndefined();
    expect(fsSync.existsSync(session.file)).toBe(true);
  });
});

describe.skipIf(process.platform !== "darwin")(
  "a cwd that differs in case from its directory",
  () => {
    it("is recovered from the transcript", async () => {
      const lower = path.join(workspace, "repo");
      const upper = path.join(workspace, "Repo");
      // The repository was renamed in case; the CLI keeps writing to the old directory.
      const session = await writeTranscript({ cwd: lower, recordCwd: upper });
      if (!fsSync.existsSync(path.join(configDir, "projects", encodeProjectPath(upper)))) return;
      const { agent } = await indexAgent();
      for (const params of [{}, { cwd: upper }]) {
        const page = await agent.listSessions(params);
        expect(page.sessions.map((s) => [s.sessionId, s.cwd])).toEqual([[session.id, upper]]);
      }
    });
  },
);

describe("title of a listed copy that starts with a slash command", () => {
  it("is the first real prompt, as the SDK titles it", async () => {
    const id = randomUUID();
    const dir = path.join(configDir, "projects", encodeProjectPath(workspace));
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, `${id}.jsonl`);
    const record = (content: unknown, at: string) => ({
      type: "user",
      sessionId: id,
      cwd: workspace,
      uuid: randomUUID(),
      parentUuid: null,
      timestamp: at,
      message: { role: "user", content },
    });
    await fs.writeFile(
      file,
      [
        record("<command-name>/init</command-name>", "2026-09-01T00:00:00Z"),
        record("Add a parser", "2026-09-01T00:00:01Z"),
      ]
        .map((entry) => JSON.stringify(entry))
        .join("\n") + "\n",
    );
    // The SDK does not find this copy: the title comes from the file.
    vi.mocked(getSessionInfo).mockResolvedValueOnce(undefined);
    const { agent } = await indexAgent();
    const page = await agent.listSessions({ cwd: workspace });
    expect(page.sessions.map((s) => s.title)).toEqual([
      (await vi
        .importActual<typeof import("@anthropic-ai/claude-agent-sdk")>(
          "@anthropic-ai/claude-agent-sdk",
        )
        .then((sdk) => sdk.getSessionInfo(id, { dir: workspace })))!.summary,
    ]);
    expect(page.sessions[0]!.title).toBe("Add a parser");
  });
});

describe("session ids in another case", () => {
  const running = (agent: ClaudeAcpAgent, sessionId: string, extra: object = {}) =>
    mockSessionState(
      {
        cwd: workspace,
        input: { end: () => {} },
        query: { close: () => {}, interrupt: async () => {} },
        ...extra,
      },
      agent,
      sessionId,
    ) as any;

  it("finds the holder, the running session and the transcript of a lower-case id", async () => {
    const session = await writeTranscript({});
    const upper = session.id.toUpperCase();
    const { agent } = await indexAgent();
    agent.sessions[session.id] = running(agent, session.id);
    await registerHolder(process.pid, session.id);

    await expect(agent.deleteSession({ sessionId: upper })).rejects.toMatchObject({
      data: { reason: "thread_active_writer" },
    });
    // The running session was torn down, the transcript kept.
    expect(agent.sessions[session.id]).toBeUndefined();
    expect(fsSync.existsSync(session.file)).toBe(true);
    await expect(agent.renameSessionTitle({ sessionId: upper, title: "x" })).rejects.toMatchObject({
      data: { reason: "thread_active_writer" },
    });

    await fs.rm(path.join(configDir, "sessions"), { recursive: true });
    await agent.archiveSession({ sessionId: upper });
    expect(await lastRecords(session.file)).toEqual(titleRecords(session.id, "[archived] Fix it"));
    await agent.deleteSession({ sessionId: upper });
    expect(fsSync.existsSync(session.file)).toBe(false);
  });

  it("renames a running session through its CLI under its own id", async () => {
    const session = await writeTranscript({});
    const { agent } = await indexAgent();
    const rename = vi.fn(async () => {});
    agent.sessions[session.id] = running(agent, session.id, {
      query: { renameSession: rename },
    });
    await agent.renameSessionTitle({ sessionId: session.id.toUpperCase(), title: "Upper" });
    expect(rename).toHaveBeenCalledWith("Upper", session.id);
  });
});

describe("rename of a session that runs here and in another process", () => {
  it("is refused before the CLI renames it", async () => {
    const session = await writeTranscript({});
    const { agent } = await indexAgent();
    const rename = vi.fn(async () => {});
    agent.sessions[session.id] = mockSessionState(
      { cwd: workspace, query: { renameSession: rename } },
      agent,
      session.id,
    ) as any;
    await registerHolder(process.pid, session.id);
    await expect(
      agent.renameSessionTitle({ sessionId: session.id, title: "Mine" }),
    ).rejects.toMatchObject({ data: { reason: "thread_active_writer" } });
    expect(rename).not.toHaveBeenCalled();
  });
});

describe("a transcript named by an upper-case id", () => {
  it("is renamed, archived and deleted under the listed id and its own spelling", async () => {
    const upper = randomUUID().toUpperCase();
    const session = await writeTranscript({ sessionId: upper });
    const dir = path.dirname(session.file);
    const { agent } = await indexAgent();
    const [row] = (await agent.listSessions({ cwd: workspace })).sessions;
    expect(row!.sessionId).toBe(upper);

    await agent.renameSessionTitle({ sessionId: row!.sessionId, title: "Upper" });
    expect(await lastRecords(session.file)).toEqual(titleRecords(upper, "Upper"));
    // No transcript of another spelling appeared.
    expect((await fs.readdir(dir)).filter((name) => name.endsWith(".jsonl"))).toEqual([
      `${upper}.jsonl`,
    ]);
    expect((await agent.listSessions({ cwd: workspace })).sessions[0]!.title).toBe("Upper");

    await agent.archiveSession({ sessionId: row!.sessionId });
    expect(
      (
        await agent.listSessions({ cwd: workspace, _meta: listMeta({ archived: "all" }) })
      ).sessions.map((s) => (s._meta as any).jetbrains.air.archived),
    ).toEqual([true]);

    await agent.deleteSession({ sessionId: row!.sessionId });
    expect(vi.mocked(deleteSession).mock.calls).toEqual([[upper]]);
    expect(await fs.readdir(dir)).toEqual([]);
  });

  it("deletes copies of both spellings, each by its own name", async () => {
    const lower = randomUUID();
    const upper = lower.toUpperCase();
    const a = await writeTranscript({ sessionId: upper, cwd: path.join(workspace, "a") });
    const b = await writeTranscript({ sessionId: lower, cwd: path.join(workspace, "b") });
    const { agent } = await indexAgent();
    await agent.deleteSession({ sessionId: upper });
    expect(
      vi
        .mocked(deleteSession)
        .mock.calls.map(([id]) => id)
        .sort(),
    ).toEqual([upper, lower].sort());
    expect(fsSync.existsSync(a.file)).toBe(false);
    expect(fsSync.existsSync(b.file)).toBe(false);
  });
});

describe("a closed session whose lone holder cannot be identified", () => {
  it("is waited for as this connection's exiting CLI", async () => {
    const session = await writeTranscript({});
    const { agent } = await indexAgent();
    // Parents cannot be told (as on Windows).
    const registry = (agent as any).sessionIndex.service.registry as LiveSessionRegistry;
    (registry as any).parentPids = async () => new Map();
    (registry as any).ownChildExitTimeoutMs = 200;
    (agent as any).sessionIndex.closedCliSessions.set(session.id, Date.now());
    await registerHolder(process.pid, session.id);
    const started = Date.now();
    await expect(agent.deleteSession({ sessionId: session.id })).rejects.toMatchObject({
      data: { reason: "thread_active_writer" },
    });
    // Waited for, then refused as it stayed.
    expect(Date.now() - started).toBeGreaterThanOrEqual(190);

    // A session this connection never ran: refused at once.
    const other = await writeTranscript({});
    await registerHolder(process.pid, other.id);
    (registry as any).ownChildExitTimeoutMs = 60_000;
    await expect(
      agent.renameSessionTitle({ sessionId: other.id, title: "x" }),
    ).rejects.toMatchObject({ data: { reason: "thread_active_writer" } });
  });
});

describe("rename of a running session with a copy under another long path", () => {
  it("titles the copy of the other path that shares the cut prefix", async () => {
    const base = path.join(workspace, "x".repeat(210));
    const mine = path.join(base, "mine");
    const theirs = path.join(base, "theirs");
    const prefix = encodeProjectPath(mine).slice(0, 200);
    // The CLI's own copy, in a directory hashed the CLI's way.
    const own = await writeTranscript({ cwd: mine, dirName: `${prefix}-cli0hash` });
    const other = await writeTranscript({ sessionId: own.id, cwd: theirs });
    expect(path.basename(path.dirname(other.file)).startsWith(prefix)).toBe(true);
    const ownBefore = await fs.readFile(own.file, "utf8");
    const { agent } = await indexAgent();
    agent.sessions[own.id] = mockSessionState(
      { cwd: mine, query: { renameSession: async () => {} } },
      agent,
      own.id,
    ) as any;
    await agent.renameSessionTitle({ sessionId: own.id, title: "Long" });

    expect(await fs.readFile(own.file, "utf8")).toBe(ownBefore);
    expect(await lastRecords(other.file)).toEqual(titleRecords(own.id, "Long"));
    expect(
      fsSync.existsSync(path.join(path.dirname(other.file), own.id, "custom-title.json")),
    ).toBe(true);
  });
});

describe("archive state (ACP RFD #2161)", () => {
  it("is reported to a session loaded here, which keeps running", async () => {
    const session = await writeTranscript({});
    const { agent, updates } = await indexAgent();
    const close = vi.fn();
    const interrupt = vi.fn(async () => {});
    const rename = vi.fn(async () => {});
    const loaded = mockSessionState(
      { cwd: workspace, query: { close, interrupt, renameSession: rename } },
      agent,
      session.id,
    ) as any;
    agent.sessions[session.id] = loaded;
    const before = await fs.readFile(session.file, "utf8");

    await agent.archiveSession({ sessionId: session.id });
    await agent.unarchiveSession({ sessionId: session.id });

    const archivedMeta = (archived: boolean) => ({
      sessionId: session.id,
      update: {
        sessionUpdate: "session_info_update",
        _meta: { jetbrains: { air: { version: 1, archived } } },
      },
    });
    expect(updates).toEqual([archivedMeta(true), archivedMeta(false)]);
    expect(agent.sessions[session.id]).toBe(loaded);
    expect(loaded.queryClosed).toBeFalsy();
    expect(close).not.toHaveBeenCalled();
    expect(interrupt).not.toHaveBeenCalled();
    // The CLI titles its own transcript; the adapter does not write it.
    // The unarchive reads the title the CLI holds, not the transcript the
    // CLI may not have written yet.
    expect(rename.mock.calls).toEqual([
      ["[archived] Fix it", session.id],
      ["Fix it", session.id],
    ]);
    expect(await fs.readFile(session.file, "utf8")).toBe(before);
  });

  it("is not reported for a session not loaded on this connection", async () => {
    const session = await writeTranscript({});
    const { agent, updates } = await indexAgent();
    await agent.archiveSession({ sessionId: session.id });
    expect(updates).toEqual([]);
  });

  it("never brings back a deleted session", async () => {
    const session = await writeTranscript({});
    const { agent } = await indexAgent();
    await agent.archiveSession({ sessionId: session.id });
    await agent.deleteSession({ sessionId: session.id });
    for (const archived of ["all", "archived"]) {
      expect(
        (await agent.listSessions({ cwd: workspace, _meta: listMeta({ archived }) })).sessions,
      ).toEqual([]);
    }
    await expect(agent.unarchiveSession({ sessionId: session.id })).rejects.toMatchObject({
      code: -32002,
    });
    await expect(agent.archiveSession({ sessionId: session.id })).rejects.toMatchObject({
      code: -32002,
    });
  });

  it("is unknown for a session whose transcript is gone but whose marker stayed", async () => {
    const session = await writeTranscript({});
    const { agent } = await indexAgent();
    await agent.archiveSession({ sessionId: session.id });
    // The CLI cleanup removed the transcript.
    await fs.rm(session.file);
    const marker = path.join(configDir, "acp", "archived", session.id);
    await expect(agent.archiveSession({ sessionId: session.id })).rejects.toMatchObject({
      code: -32002,
    });
    await expect(agent.unarchiveSession({ sessionId: session.id })).rejects.toMatchObject({
      code: -32002,
    });
    expect(fsSync.existsSync(marker)).toBe(false);
  });

  it("shows a session that an AIR client without sessionIndex marked done as archived", async () => {
    const session = await writeTranscript({});
    const legacy = createAgent().agent;
    await initializeClient(legacy, air());
    await legacy.deleteSession({ sessionId: session.id });

    const { agent } = await indexAgent();
    expect((await agent.listSessions({ cwd: workspace })).sessions).toEqual([]);
    const all = await agent.listSessions({ cwd: workspace, _meta: listMeta({ archived: "all" }) });
    expect(all.sessions.map((s) => [s.sessionId, (s._meta as any).jetbrains.air.archived])).toEqual(
      [[session.id, true]],
    );
  });
});

describe("session list extensions RFD", () => {
  it("reports forkedFrom for a session the SDK forked", async () => {
    const parent = await writeTranscript({});
    const { sessionId: child } = await sdkForkSession(parent.id, { dir: workspace });
    const { agent } = await indexAgent();
    const rows = (await agent.listSessions({ cwd: workspace })).sessions;
    const forked = rows.find((row) => row.sessionId === child);
    expect((forked!._meta as any).jetbrains.air.forkedFrom).toBe(parent.id);
    const original = rows.find((row) => row.sessionId === parent.id);
    expect((original!._meta as any).jetbrains.air).not.toHaveProperty("forkedFrom");
  });

  it("does not watch a list without a cwd", async () => {
    await writeTranscript({});
    const service = new SessionIndexService({
      notifyListChanged: async () => {},
      logError: () => {},
    });
    await service.list({}, () => undefined);
    expect((service as any).watcher).toBeUndefined();
    await service.list({ cwd: workspace }, () => undefined);
    expect((service as any).watcher).toBeDefined();
    service.dispose();
  });
});

describe("load and resume of a session that another process holds", () => {
  const stubOpen = (agent: ClaudeAcpAgent) => {
    const opened = vi.fn(async () => ({ sessionId: "x" }) as any);
    (agent as any).getOrCreateSession = opened;
    (agent as any).createSessionWhileReplaying = opened;
    return opened;
  };

  it("is thread_active_writer for a sessionIndex client", async () => {
    const session = await writeTranscript({});
    await registerHolder(process.pid, session.id);
    const { agent } = await indexAgent();
    const opened = stubOpen(agent);
    for (const open of [
      () => agent.loadSession({ sessionId: session.id, cwd: workspace, mcpServers: [] }),
      () => agent.resumeSession({ sessionId: session.id, cwd: workspace, mcpServers: [] }),
    ]) {
      await expect(open()).rejects.toMatchObject({ data: { reason: "thread_active_writer" } });
    }
    expect(opened).not.toHaveBeenCalled();
  });

  it("opens as before for a client without sessionIndex", async () => {
    const session = await writeTranscript({});
    await registerHolder(process.pid, session.id);
    const { agent } = createAgent();
    await initializeClient(agent, air());
    const opened = stubOpen(agent);
    await agent.resumeSession({ sessionId: session.id, cwd: workspace, mcpServers: [] });
    await agent.loadSession({ sessionId: session.id, cwd: workspace, mcpServers: [] });
    expect(opened).toHaveBeenCalledTimes(2);
  });
});

describe("paths that share a project directory", () => {
  it("are listed and watched apart", async () => {
    const dotted = path.join(workspace, "app.v2");
    const dashed = path.join(workspace, "app-v2");
    expect(encodeProjectPath(dotted)).toBe(encodeProjectPath(dashed));
    const mine = await writeTranscript({
      cwd: dotted,
      lastMessageAt: Date.parse("2026-01-02T00:00:00Z"),
    });
    const theirs = await writeTranscript({ cwd: dashed });
    const { agent, notifications } = await indexAgent();
    for (const [cwd, id] of [
      [dotted, mine.id],
      [dashed, theirs.id],
    ] as const) {
      const page = await agent.listSessions({ cwd });
      expect(page.sessions.map((s) => [s.sessionId, s.cwd])).toEqual([[id, cwd]]);
    }

    // Watched by the last list: the dashed path. A change of the dotted
    // path's session is no change of that list.
    await new Promise((resolve) => setTimeout(resolve, 100));
    await fs.appendFile(mine.file, "{}\n");
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(notifications.filter((n) => n.params.cwd === dashed)).toEqual([]);
    await fs.appendFile(theirs.file, "{}\n");
    const start = Date.now();
    while (!notifications.some((n) => n.params.cwd === dashed) && Date.now() - start < 3000) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(notifications.some((n) => n.params.cwd === dashed)).toBe(true);
    await agent.dispose();
  });

  it("hint a watched path when a session of the other path moves into it", async () => {
    const dotted = path.join(workspace, "app.v2");
    const dashed = path.join(workspace, "app-v2");
    const mine = await writeTranscript({ cwd: dotted });
    await writeTranscript({ cwd: dashed });
    const { agent, notifications } = await indexAgent();
    await agent.listSessions({ cwd: dotted });
    await agent.listSessions({ cwd: dashed });

    await new Promise((resolve) => setTimeout(resolve, 100));
    await fs.appendFile(
      mine.file,
      JSON.stringify({ type: "relocated", sessionId: mine.id, relocatedCwd: dashed }) + "\n",
    );
    const start = Date.now();
    while (!notifications.some((n) => n.params.cwd === dashed) && Date.now() - start < 3000) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(notifications.some((n) => n.params.cwd === dashed)).toBe(true);
    await agent.dispose();
  });
});

describe("a relocation out of the project directory", () => {
  it("keeps the session in the change hint, as the list keeps showing it", async () => {
    const session = await writeTranscript({});
    const service = new SessionIndexService({
      notifyListChanged: async () => {},
      logError: () => {},
    });
    const rows = await service.index.list({
      cwd: workspace,
      limit: 10,
      archived: "unarchived",
      archivedIds: new Set(),
    });
    expect(rows.rows).toHaveLength(1);
    await fs.appendFile(
      session.file,
      JSON.stringify({ type: "relocated", sessionId: session.id, relocatedCwd: "/elsewhere" }) +
        "\n",
    );
    expect(await service.index.scopeFingerprint(workspace, false)).toHaveLength(1);
    service.dispose();
  });
});

describe("worktrees of a subdirectory cwd", () => {
  it("are the same subdirectory in each existing worktree", async () => {
    const repo = path.join(workspace, "repo");
    const linked = path.join(workspace, "linked");
    const meta = path.join(repo, ".git", "worktrees", "linked");
    await fs.mkdir(meta, { recursive: true });
    await fs.mkdir(path.join(repo, "packages", "a"), { recursive: true });
    await fs.mkdir(path.join(linked, "packages", "a"), { recursive: true });
    await fs.writeFile(path.join(meta, "gitdir"), `${path.join(linked, ".git")}\n`);
    await fs.writeFile(path.join(linked, ".git"), `gitdir: ${meta}\n`);
    await fs.writeFile(path.join(meta, "commondir"), "../..\n");
    const sub = path.join(repo, "packages", "a");
    const linkedSub = path.join(linked, "packages", "a");
    const base = Date.parse("2026-02-01T00:00:00Z");
    const inSub = await writeTranscript({ cwd: sub, lastMessageAt: base });
    const inLinkedSub = await writeTranscript({ cwd: linkedSub, lastMessageAt: base - 1000 });
    await writeTranscript({ cwd: linked, lastMessageAt: base - 2000 });
    await writeTranscript({ cwd: repo, lastMessageAt: base - 3000 });
    const { agent } = await indexAgent();
    const page = await agent.listSessions({
      cwd: sub,
      _meta: listMeta({ includeWorktrees: true }),
    });
    expect(page.sessions.map((s) => [s.sessionId, s.cwd])).toEqual([
      [inSub.id, sub],
      [inLinkedSub.id, linkedSub],
    ]);
  });
});

describe("list cursor scope", () => {
  it("does not bind the limit", async () => {
    const base = Date.parse("2026-03-01T00:00:00Z");
    const ids: string[] = [];
    for (let i = 0; i < 4; i++)
      ids.push((await writeTranscript({ lastMessageAt: base - i * 1000 })).id);
    const { agent } = await indexAgent();
    const first = await agent.listSessions({ cwd: workspace, _meta: listMeta({ limit: 1 }) });
    const rest = await agent.listSessions({
      cwd: workspace,
      cursor: first.nextCursor,
      _meta: listMeta({ limit: 10, archived: null, includeWorktrees: null }),
    });
    expect([...first.sessions, ...rest.sessions].map((s) => s.sessionId)).toEqual(ids);
  });
});

describe("open a session that runs here and that another process resumed", () => {
  it("is thread_active_writer for a sessionIndex client", async () => {
    const session = await writeTranscript({});
    const { agent } = await indexAgent();
    agent.sessions[session.id] = mockSessionState({}, agent, session.id) as any;
    await registerHolder(process.pid, session.id);
    (agent as any).getOrCreateSession = vi.fn();
    await expect(
      agent.resumeSession({ sessionId: session.id, cwd: workspace, mcpServers: [] }),
    ).rejects.toMatchObject({ data: { reason: "thread_active_writer" } });
    await expect(
      agent.loadSession({ sessionId: session.id, cwd: workspace, mcpServers: [] }),
    ).rejects.toMatchObject({ data: { reason: "thread_active_writer" } });
    expect((agent as any).getOrCreateSession).not.toHaveBeenCalled();
  });
});

describe("archive of a loaded session without its transcript", () => {
  it("is unknown once the session had history, and allowed for a new unwritten one", async () => {
    const { agent, updates } = await indexAgent();
    const query = { renameSession: async () => {} };
    const stale = randomUUID();
    agent.sessions[stale] = mockSessionState({ queryClosed: true }, agent, stale) as any;
    const finished = randomUUID();
    agent.sessions[finished] = mockSessionState(
      { lastTurnEndedAt: Date.now(), query },
      agent,
      finished,
    ) as any;
    const resumed = randomUUID();
    agent.sessions[resumed] = mockSessionState(
      { resumedFromHistory: true, query },
      agent,
      resumed,
    ) as any;
    for (const sessionId of [stale, finished, resumed]) {
      await expect(agent.archiveSession({ sessionId })).rejects.toMatchObject({ code: -32002 });
      await expect(agent.unarchiveSession({ sessionId })).rejects.toMatchObject({ code: -32002 });
    }
    expect(updates).toEqual([]);

    // The CLI holds the title until it writes the transcript.
    const fresh = randomUUID();
    const rename = vi.fn(async () => {});
    agent.sessions[fresh] = mockSessionState(
      { query: { renameSession: rename } },
      agent,
      fresh,
    ) as any;
    await agent.archiveSession({ sessionId: fresh });
    await agent.archiveSession({ sessionId: fresh });
    await agent.unarchiveSession({ sessionId: fresh });
    const name = `Session ${fresh.slice(0, 8)}`;
    expect(rename.mock.calls).toEqual([
      [`[archived] ${name}`, fresh],
      [name, fresh],
    ]);
    expect(updates).toHaveLength(3);
  });
});

describe("delete of an unknown session with a leftover marker", () => {
  it("drops the marker and is -32002", async () => {
    const sessionId = randomUUID();
    const marker = path.join(configDir, "acp", "archived", sessionId);
    await fs.mkdir(path.dirname(marker), { recursive: true });
    await fs.writeFile(marker, "");
    const { agent } = await indexAgent();
    await expect(agent.deleteSession({ sessionId })).rejects.toMatchObject({ code: -32002 });
    expect(fsSync.existsSync(marker)).toBe(false);
  });
});

describe("a session relocated to a path with the same project directory", () => {
  it("is listed under the cwd it was moved to", async () => {
    const from = path.join(workspace, "app.v2");
    const to = path.join(workspace, "app-v2");
    const id = randomUUID();
    const session = await writeTranscript({
      sessionId: id,
      cwd: from,
      trailer: [{ type: "relocated", sessionId: id, relocatedCwd: to }],
    });
    const { agent } = await indexAgent();
    expect(
      (await agent.listSessions({ cwd: to })).sessions.map((s) => [s.sessionId, s.cwd]),
    ).toEqual([[session.id, to]]);
    expect((await agent.listSessions({ cwd: from })).sessions).toEqual([]);
  });
});

describe("order by the last user activity", () => {
  it("ranks by the last prompt, else updatedAt, and pages and merges archived on that key", async () => {
    const now = Date.parse("2026-04-01T12:00:00Z");
    const minute = 60_000;
    // Prompted 10 minutes ago; the agent kept working until now.
    const workedOn = await writeTranscript({
      lastMessageAt: now - 10 * minute + 1000,
      mtimeMs: now + 500,
    });
    await fs.appendFile(
      workedOn.file,
      JSON.stringify({
        type: "assistant",
        sessionId: workedOn.id,
        cwd: workspace,
        uuid: randomUUID(),
        timestamp: new Date(now).toISOString(),
        message: {
          role: "assistant",
          content: [{ type: "text", text: "more" }],
          stop_reason: "end_turn",
        },
      }) + "\n",
    );
    await fs.utimes(workedOn.file, (now + 500) / 1000, (now + 500) / 1000);
    // Prompted 5 minutes ago, done a minute later.
    const recent = await writeTranscript({ lastMessageAt: now - 4 * minute });
    // No real prompt (a slash command only): ordered by updatedAt (7 minutes ago).
    const noPrompt = await writeTranscript({
      prompt: "<command-name>/compact</command-name>",
      lastMessageAt: now - 7 * minute,
    });
    const { agent } = await indexAgent();

    const page = await agent.listSessions({ cwd: workspace });
    expect(page.sessions.map((s) => s.sessionId)).toEqual([recent.id, noPrompt.id, workedOn.id]);
    const workedOnRow = page.sessions[2]!;
    expect(workedOnRow.updatedAt).toBe(new Date(now).toISOString());
    expect((workedOnRow._meta as any).jetbrains.air.lastPromptAt).toBe(
      new Date(now - 10 * minute).toISOString(),
    );
    expect((page.sessions[1]!._meta as any).jetbrains.air).not.toHaveProperty("lastPromptAt");

    // A cursor anchors on the same key.
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const next = await agent.listSessions({
        cwd: workspace,
        cursor,
        _meta: listMeta({ limit: 1 }),
      });
      seen.push(...next.sessions.map((s) => s.sessionId));
      cursor = next.nextCursor ?? undefined;
    } while (cursor);
    expect(seen).toEqual([recent.id, noPrompt.id, workedOn.id]);

    // Archived sessions merge on the same key.
    await agent.archiveSession({ sessionId: noPrompt.id });
    expect((await agent.listSessions({ cwd: workspace })).sessions.map((s) => s.sessionId)).toEqual(
      [recent.id, workedOn.id],
    );
    const all = await agent.listSessions({ cwd: workspace, _meta: listMeta({ archived: "all" }) });
    expect(all.sessions.map((s) => s.sessionId)).toEqual([recent.id, noPrompt.id, workedOn.id]);
  });
});

describe("a last prompt followed by more than the tail window", () => {
  it("is found by growing the tail, and kept while the transcript grows", async () => {
    const now = Date.parse("2026-05-01T12:00:00Z");
    const minute = 60_000;
    const working = await writeTranscript({ lastMessageAt: now - 10 * minute + 1000 });
    const output = (at: number, size: number) =>
      JSON.stringify({
        type: "user",
        sessionId: working.id,
        cwd: workspace,
        uuid: randomUUID(),
        timestamp: new Date(at).toISOString(),
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "t", content: "o".repeat(size) }],
        },
      }) + "\n";
    // 300 KB of tool output after the prompt.
    await fs.appendFile(working.file, output(now - minute, 300_000));
    await fs.utimes(working.file, now / 1000, now / 1000);
    const prompted = await writeTranscript({ lastMessageAt: now - 4 * minute });
    const { agent } = await indexAgent();

    const ids = async () =>
      (await agent.listSessions({ cwd: workspace })).sessions.map((s) => s.sessionId);
    expect(await ids()).toEqual([prompted.id, working.id]);
    const row = (await agent.listSessions({ cwd: workspace })).sessions[1]!;
    expect((row._meta as any).jetbrains.air.lastPromptAt).toBe(
      new Date(now - 10 * minute).toISOString(),
    );

    // The agent writes on: the session stays where its last prompt puts it.
    await fs.appendFile(working.file, output(now, 1000));
    await fs.utimes(working.file, (now + 1000) / 1000, (now + 1000) / 1000);
    expect(await ids()).toEqual([prompted.id, working.id]);
  });
});

describe("a session whose last prompt is an image or a document", () => {
  it("is ordered by that prompt", async () => {
    const now = Date.parse("2026-06-01T12:00:00Z");
    const minute = 60_000;
    const middle = await writeTranscript({ lastMessageAt: now - 5 * minute });
    const withMedia: string[] = [];
    for (const [type, at] of [
      ["image", now - 2 * minute],
      ["document", now - minute],
    ] as const) {
      // A text prompt 10 minutes ago, then a media-only prompt.
      const session = await writeTranscript({ lastMessageAt: now - 10 * minute + 1000 });
      await fs.appendFile(
        session.file,
        JSON.stringify({
          type: "user",
          sessionId: session.id,
          cwd: workspace,
          uuid: randomUUID(),
          timestamp: new Date(at).toISOString(),
          message: { role: "user", content: [{ type, source: { type: "base64", data: "x" } }] },
        }) + "\n",
      );
      await fs.utimes(session.file, (at + 500) / 1000, (at + 500) / 1000);
      withMedia.push(session.id);
    }
    const { agent } = await indexAgent();
    const page = await agent.listSessions({ cwd: workspace });
    expect(page.sessions.map((s) => s.sessionId)).toEqual([withMedia[1], withMedia[0], middle.id]);
    expect((page.sessions[0]!._meta as any).jetbrains.air.lastPromptAt).toBe(
      new Date(now - minute).toISOString(),
    );
  });
});

describe("session index cost", () => {
  it("pages through a project reading each transcript once", async () => {
    const base = Date.parse("2026-08-01T00:00:00Z");
    for (let i = 0; i < 120; i++) await writeTranscript({ lastMessageAt: base - i * 60_000 });
    const { agent } = await indexAgent();
    vi.mocked(getSessionInfo).mockClear();
    let cursor: string | undefined;
    let rows = 0;
    do {
      const page = await agent.listSessions({
        cwd: workspace,
        cursor,
        _meta: listMeta({ limit: 10 }),
      });
      rows += page.sessions.length;
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(rows).toBe(120);
    // Pages after a cursor skip the transcripts cached before it.
    expect(vi.mocked(getSessionInfo).mock.calls.length).toBeLessThanOrEqual(120);
  });

  it("computes the change fingerprint without reading transcripts", async () => {
    for (let i = 0; i < 30; i++) await writeTranscript({});
    const service = new SessionIndexService({
      notifyListChanged: async () => {},
      logError: () => {},
    });
    vi.mocked(getSessionInfo).mockClear();
    const parts = await service.index.scopeFingerprint(workspace, false);
    expect(parts).toHaveLength(30);
    expect(getSessionInfo).not.toHaveBeenCalled();
    service.dispose();
  });
});

describe("a transcript without a prompt in its last 4 MB", () => {
  it("keeps what an earlier wide scan found when a small append has none of it", async () => {
    const id = randomUUID();
    const file = path.join(workspace, `${id}.jsonl`);
    const at = Date.parse("2026-07-01T00:00:00Z");
    const result = (size: number) =>
      JSON.stringify({
        type: "user",
        sessionId: id,
        timestamp: new Date(at + 5000).toISOString(),
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "t", content: "o".repeat(size) }],
        },
      }) + "\n";
    const size = Buffer.byteLength(result(10));
    await fs.writeFile(file, result(10) + result(100));
    const grown = await scanTranscriptFile(
      file,
      size + Buffer.byteLength(result(100)),
      id,
      undefined,
      {
        size,
        promptSearched: true,
        model: "claude-model-x",
        lastTurnEndedAt: at,
        costUsd: 1.5,
      },
    );
    expect(grown.model).toBe("claude-model-x");
    expect(grown.lastTurnEndedAt).toBe(at);
    expect(grown.costUsd).toBe(1.5);
  });

  it("keeps an inherited turn end and cost when a small append needs a wider tail", async () => {
    const id = randomUUID();
    const file = path.join(workspace, `${id}.jsonl`);
    const at = Date.parse("2026-07-01T00:00:00Z");
    const line = (entry: object) => JSON.stringify({ sessionId: id, ...entry }) + "\n";
    const working = Array.from({ length: 400 }, (_, i) =>
      line({
        type: "assistant",
        timestamp: new Date(at + 10_000 + i).toISOString(),
        message: {
          role: "assistant",
          stop_reason: "tool_use",
          content: [{ type: "text", text: "w".repeat(2_000) }],
        },
      }),
    ).join("");
    const meta = line({ type: "last-prompt", lastPrompt: "m".repeat(1_000) }).repeat(80);
    const before =
      line({
        type: "user",
        timestamp: new Date(at).toISOString(),
        message: { role: "user", content: "Go" },
      }) +
      line({
        type: "assistant",
        timestamp: new Date(at + 1000).toISOString(),
        message: {
          role: "assistant",
          stop_reason: "end_turn",
          content: [{ type: "text", text: "ok" }],
        },
      }) +
      working +
      meta;
    const appended = line({ type: "last-prompt", lastPrompt: "x" });
    await fs.writeFile(file, before + appended);
    const grown = await scanTranscriptFile(
      file,
      Buffer.byteLength(before + appended),
      id,
      undefined,
      {
        size: Buffer.byteLength(before),
        lastPromptAt: at,
        promptSearched: true,
        lastTurnEndedAt: at + 1000,
        costUsd: 2,
      },
    );
    expect(grown.lastMessageAt).toBeDefined();
    expect(grown.lastTurnEndedAt).toBe(at + 1000);
    expect(grown.costUsd).toBe(2);
  });

  it("is searched again when replaced by another file of the same size", async () => {
    const id = randomUUID();
    const file = path.join(workspace, `${id}.jsonl`);
    const at = Date.parse("2026-07-01T00:00:00Z");
    const record = (type: "user" | "assistant", time: number, text: string) =>
      JSON.stringify({
        type,
        sessionId: id,
        timestamp: new Date(time).toISOString(),
        message: { role: type, content: type === "user" ? text : [{ type: "text", text }] },
      }) + "\n";
    const output = record("assistant", at, "a".repeat(1_000_000));
    const original = record("user", at, "Start") + output.repeat(5);
    await fs.writeFile(file, original);
    const size = Buffer.byteLength(original);
    expect((await scanTranscriptFile(file, size, id, undefined, undefined, 1)).lastPromptAt).toBe(
      undefined,
    );
    const head =
      record("user", at, "Start") + output.repeat(3) + record("user", at + 1000, "Hidden");
    const last = record("assistant", at + 2000, "");
    const pad = size - Buffer.byteLength(head + output + last);
    const replacement = head + output + record("assistant", at + 2000, "z".repeat(pad));
    expect(Buffer.byteLength(replacement)).toBe(size);
    await fs.writeFile(file, replacement);
    expect((await scanTranscriptFile(file, size, id, undefined, undefined, 2)).lastPromptAt).toBe(
      at + 1000,
    );
  });

  it("is searched again when another file replaces it", async () => {
    const id = randomUUID();
    const dir = path.join(configDir, "projects", encodeProjectPath(workspace));
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, `${id}.jsonl`);
    const at = Date.parse("2026-07-01T00:00:00Z");
    const record = (type: "user" | "assistant", time: number, text: string) =>
      JSON.stringify({
        type,
        sessionId: id,
        cwd: workspace,
        uuid: randomUUID(),
        timestamp: new Date(time).toISOString(),
        message: { role: type, content: type === "user" ? text : [{ type: "text", text }] },
      }) + "\n";
    const output = record("assistant", at, "a".repeat(1_000_000));
    await fs.writeFile(
      file,
      record("user", at - 60_000, "Start") +
        output.repeat(5) +
        record("assistant", at, "y".repeat(40_000)),
    );
    const { agent } = await indexAgent();
    const lastPromptAt = async () =>
      ((await agent.listSessions({ cwd: workspace })).sessions[0]!._meta as any).jetbrains.air
        .lastPromptAt;
    expect(await lastPromptAt()).toBeUndefined();

    // A slightly larger file takes its place, grown by less than its tail
    // covers: a prompt 1 MB before its end.
    const replacement = `${file}.new`;
    await fs.writeFile(
      replacement,
      record("user", at - 60_000, "Start") +
        output.repeat(4) +
        record("user", at + 1000, "Hidden") +
        output +
        record("assistant", at + 2000, "z".repeat(40_000)),
    );
    await fs.rename(replacement, file);
    expect(await lastPromptAt()).toBe(new Date(at + 1000).toISOString());
  });

  it("is not searched again while it only grows by what its tail covers", async () => {
    const id = randomUUID();
    const file = path.join(workspace, `${id}.jsonl`);
    const record = (type: "user" | "assistant", at: number, text: string) =>
      JSON.stringify({
        type,
        sessionId: id,
        timestamp: new Date(at).toISOString(),
        message: { role: type, content: type === "user" ? text : [{ type: "text", text }] },
      }) + "\n";
    const at = Date.parse("2026-07-01T00:00:00Z");
    const output = record("assistant", at, "a".repeat(1_000_000));
    const original = record("user", at, "Start") + output.repeat(5);
    await fs.writeFile(file, original);
    let size = Buffer.byteLength(original);
    const first = await scanTranscriptFile(file, size, id);
    expect(first.lastPromptAt).toBeUndefined();
    expect(first.promptSearched).toBe(true);

    // A prompt 1 MB back and a small append: the earlier full search stands,
    // so the 1 MB is not read (the prompt stays unseen).
    const replaced = record("user", at, "Hidden") + output + record("assistant", at, "z");
    await fs.writeFile(file, replaced);
    size = Buffer.byteLength(replaced);
    // The appended bytes (the last record) are inside the tail window.
    const grown = await scanTranscriptFile(file, size, id, undefined, {
      size: size - 50,
      lastPromptAt: undefined,
      promptSearched: true,
    });
    expect(grown.lastPromptAt).toBeUndefined();
    expect(grown.promptSearched).toBe(true);
  });
});

describe("archive in AIR's title format, edge cases", () => {
  it("renames a running archived session through its CLI with the prefix kept", async () => {
    const session = await writeTranscript({});
    const { agent, updates } = await indexAgent();
    const rename = vi.fn(async () => {});
    agent.sessions[session.id] = mockSessionState(
      { cwd: workspace, query: { renameSession: rename } },
      agent,
      session.id,
    ) as any;
    await agent.archiveSession({ sessionId: session.id });
    await agent.renameSessionTitle({ sessionId: session.id, title: "[archived] New" });
    expect(rename.mock.calls).toEqual([
      ["[archived] Fix it", session.id],
      ["[archived] New", session.id],
    ]);
    expect(updates).toContainEqual({
      sessionId: session.id,
      update: { sessionUpdate: "session_info_update", title: "New" },
    });
  });

  it("stores a rename as the CLI keeps it, and never archives by a client title", async () => {
    const session = await writeTranscript({});
    const { agent } = await indexAgent();
    await agent.renameSessionTitle({ sessionId: session.id, title: "[archived] Mine" });
    expect(await lastRecords(session.file)).toEqual(titleRecords(session.id, "Mine"));
    const long = `${"a".repeat(199)} tail`;
    await agent.renameSessionTitle({ sessionId: session.id, title: long });
    expect(await lastRecords(session.file)).toEqual(titleRecords(session.id, "a".repeat(199)));
    await agent.archiveSession({ sessionId: session.id });
    await agent.renameSessionTitle({ sessionId: session.id, title: long });
    expect(await lastRecords(session.file)).toEqual(
      titleRecords(session.id, `[archived] ${"a".repeat(189)}`),
    );
  });

  it("finds an agent name that later traffic pushed out of the tail window", async () => {
    const filler = Array.from({ length: 40 }, () => ({
      type: "system",
      subtype: "informational",
      content: "x".repeat(4000),
    }));
    const session = await writeTranscript({
      trailer: [
        ...titleRecords("", "[archived] Done"),
        ...filler,
        // A custom title alone, as the SDK renameSession writes it.
        { type: "custom-title", customTitle: "Plain", sessionId: "" },
      ],
    });
    expect((await fs.stat(session.file)).size).toBeGreaterThan(128 * 1024);
    const { agent } = await indexAgent();
    const [row] = (
      await agent.listSessions({ cwd: workspace, _meta: listMeta({ archived: "all" }) })
    ).sessions;
    expect(row!.title).toBe("Done");
    expect((row!._meta as any).jetbrains.air.archived).toBe(true);
    await agent.unarchiveSession({ sessionId: session.id });
    expect(await lastRecords(session.file)).toEqual(titleRecords(session.id, "Done"));
  });

  it("keeps the marker while a copy of a running session could not be titled", async () => {
    const own = await writeTranscript({ cwd: workspace });
    const other = await writeTranscript({ sessionId: own.id, cwd: path.join(workspace, "b") });
    await fs.appendFile(other.file, '{"type":"assistant","mess');
    const marker = await writeMarker(own.id);
    const { agent } = await indexAgent();
    agent.sessions[own.id] = mockSessionState(
      { cwd: workspace, query: { renameSession: async () => {} } },
      agent,
      own.id,
    ) as any;
    await agent.archiveSession({ sessionId: own.id });
    expect((await fs.readFile(other.file, "utf8")).endsWith('"mess')).toBe(true);
    expect(fsSync.existsSync(marker)).toBe(true);
  });

  it("brings an existing sidecar in line with a transcript already archived", async () => {
    const session = await writeTranscript({
      trailer: titleRecords("", "[archived] Done"),
    });
    await writeCustomTitleSidecar(session.file, "Done");
    const { agent } = await indexAgent();
    const before = await fs.readFile(session.file, "utf8");
    await agent.archiveSession({ sessionId: session.id });
    expect(await fs.readFile(session.file, "utf8")).toBe(before);
    const sidecar = path.join(path.dirname(session.file), session.id, "custom-title.json");
    expect(JSON.parse(await fs.readFile(sidecar, "utf8"))).toEqual({
      customTitle: "[archived] Done",
    });
  });

  it("leaves a loaded session in place when AIR without sessionIndex may not archive it", async () => {
    const session = await writeTranscript({});
    const { agent } = createAgent();
    await initializeClient(agent, air());
    const loaded = mockSessionState({ queryClosed: true }, agent, session.id) as any;
    agent.sessions[session.id] = loaded;
    await registerHolder(process.pid, session.id);
    await expect(agent.deleteSession({ sessionId: session.id })).rejects.toMatchObject({
      data: { reason: "thread_active_writer" },
    });
    expect(agent.sessions[session.id]).toBe(loaded);
  });

  it("filters archived rows after reading them, across batches and pages", async () => {
    const base = Date.parse("2026-05-01T00:00:00Z");
    const sessions = [];
    for (let i = 0; i < 40; i++) {
      const archived = i % 3 === 0;
      sessions.push({
        archived,
        ...(await writeTranscript({
          lastMessageAt: base - i * 1000,
          ...(archived && { trailer: titleRecords("", "[archived] Old") }),
        })),
      });
    }
    const { agent } = await indexAgent();
    for (const archived of ["unarchived", "archived"] as const) {
      const expected = sessions
        .filter((session) => session.archived === (archived === "archived"))
        .map((session) => session.id);
      const seen: string[] = [];
      let cursor: string | undefined;
      do {
        const page = await agent.listSessions({
          cwd: workspace,
          cursor,
          _meta: listMeta({ archived, limit: 4 }),
        });
        seen.push(...page.sessions.map((s) => s.sessionId));
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      expect(seen).toEqual(expected);
    }
  });
});

describe("an archive that stores nothing", () => {
  it("leaves the title open to generation", async () => {
    const updates: any[] = [];
    const agent: any = {
      client: { sessionUpdate: async (update: unknown) => updates.push(update) },
      logger: { error: () => {} },
      sessions: {},
    };
    const titles = new SessionTitles(agent, "s1");
    const session: any = {
      queryClosed: false,
      cancelled: false,
      cwd: "/nowhere",
      query: { generateSessionTitle: async () => "Generated" },
    };
    agent.sessions.s1 = session;
    titles.onPrompt([{ type: "text", text: "Please refactor the parser module" }]);
    await titles.setExplicitTitle(undefined, async () => undefined);
    vi.mocked(getSessionInfo).mockResolvedValueOnce(undefined);
    await titles.onTurnEnd(session);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(updates.map((update) => update.update.title)).toEqual(["Generated"]);
  });
});
