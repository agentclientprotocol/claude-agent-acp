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
import { spawn } from "node:child_process";
import { ClaudeAcpAgent, type AcpClient } from "../acp-agent.js";
import type { SessionInfo } from "@agentclientprotocol/sdk";
import { encodeProjectPath } from "../session-index/project-dirs.js";
import {
  archiveInsteadOfDelete,
  archiveTo,
  renameTo,
  SessionIndexService,
  writeCustomTitleSidecar,
} from "../session-index/service.js";
import { scanTranscriptFile } from "../session-index/transcript-scan.js";
import { repositoryWorktrees } from "../session-index/worktrees.js";
import {
  ListSubscriptions,
  MAX_SUBSCRIPTIONS,
  parseListSubscribeRequest,
  parseListUnsubscribeRequest,
  type ListChanges,
} from "../session-index/list-subscriptions.js";
import { SessionTitles } from "../session-titles.js";
import { initializeClient } from "./helpers.js";
import {
  mockSessionState,
  successfulResultMessage,
  userEcho,
  wrapQuery,
} from "./session-doubles.js";
import { Pushable } from "../utils.js";

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

/** The transcripts the session index of `agent` has read so far. */
const transcriptsRead = (agent: ClaudeAcpAgent): number =>
  (agent as any).sessionIndex.service.index.transcriptsRead;

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

/** A `rename_session` of a CLI: it writes the custom title before it
 *  answers (the agent name follows later, and is left out). */
const cliRename = (file: string, sessionId: string) =>
  vi.fn(async (title: string) => {
    await fs.appendFile(
      file,
      JSON.stringify({ type: "custom-title", customTitle: title, sessionId }) + "\n",
    );
  });

/** A session loaded here whose CLI runs: `query` gets the interrupt and
 *  close that an archive, which stops the session, calls. */
function runningSession(
  overrides: Record<string, any>,
  agent: ClaudeAcpAgent,
  sessionId: string,
): any {
  return mockSessionState(
    {
      ...overrides,
      query: { interrupt: vi.fn(async () => {}), close: vi.fn(), ...overrides.query },
      input: { end: vi.fn() },
    },
    agent,
    sessionId,
  );
}

const airCapabilities = (response: { _meta?: Record<string, unknown> | null }) =>
  (response._meta as any)?.jetbrains?.air?.capabilities as string[] | undefined;

describe("sessionIndex negotiation", () => {
  const indexCapabilities = [
    "sessionIndex",
    "sessionArchive",
    "sessionRename",
    "sessionListSubscribe",
  ];
  const baseline = [
    "sessionFailure",
    "agentFileChangeReport",
    "nativeSubagentSessions",
    "asyncTasks",
    "customInstructions",
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
    expect(nonAir._meta).toMatchObject({
      steering: { supported: true },
      runtime: { version: 1 },
    });
    expect(airCapabilities(nonAir)).toBeUndefined();
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
    const read = transcriptsRead(agent);
    expect(read).toBeLessThanOrEqual(16);
    // A second list reads nothing again.
    await agent.listSessions({ cwd: workspace, _meta: listMeta({ limit: 5 }) });
    expect(transcriptsRead(agent)).toBe(read);
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

  it("lists a session copied to two project directories once, from its newest copy, as the SDK", async () => {
    const other = path.join(workspace, "sub");
    await fs.mkdir(other);
    const larger = await writeTranscript({
      cwd: workspace,
      lastMessageAt: base,
      prompt: "Larger copy",
      trailer: [{ type: "last-prompt", lastPrompt: "x".repeat(1000), sessionId: "" }],
    });
    await writeTranscript({
      sessionId: larger.id,
      cwd: other,
      lastMessageAt: base + 5000,
      prompt: "Newer copy",
    });
    const sdk = await listSessions();
    expect(sdk.map((s) => [s.sessionId, s.cwd])).toEqual([[larger.id, other]]);
    const { agent } = await indexAgent();
    const page = await agent.listSessions({ _meta: listMeta({ limit: 10 }) });
    expect(page.sessions.map((s) => [s.sessionId, s.cwd, s.title])).toEqual([
      [larger.id, other, sdk[0]!.summary],
    ]);
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
    // A cost record in a transcript is not read: a row has a cost only from
    // the SDK of a session that runs here.
    const session = await writeTranscript({
      lastMessageAt: base,
      costUsd: 1.25,
      model: "claude-opus-5-5",
      forkedFrom: parent,
    });
    await writeTranscript({ lastMessageAt: base - 1000 });
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

  it("has no cost unless the SDK gave one for a session that runs here", async () => {
    const running = await writeTranscript({ lastMessageAt: base, costUsd: 4 });
    const closed = await writeTranscript({ lastMessageAt: base - 1000, costUsd: 5 });
    const { agent } = await indexAgent();
    // Running, but no SDK result yet.
    agent.sessions[running.id] = mockSessionState(
      { lastSessionState: "running" },
      agent,
      running.id,
    ) as any;
    // An SDK result, but the query closed: the session no longer runs here.
    agent.sessions[closed.id] = mockSessionState(
      { lastSessionState: "idle", lastTotalCostUsd: 2, queryClosed: true },
      agent,
      closed.id,
    ) as any;
    const page = await agent.listSessions({ cwd: workspace });
    expect(page.sessions.map((s) => s.sessionId)).toEqual([running.id, closed.id]);
    for (const row of page.sessions) {
      expect((row._meta as any).jetbrains.air).not.toHaveProperty("cost");
    }
    // Its first SDK result gives the row a cost.
    agent.sessions[running.id]!.lastTotalCostUsd = 0.5;
    const after = await agent.listSessions({ cwd: workspace });
    expect((after.sessions[0]!._meta as any).jetbrains.air.cost).toEqual({
      amount: 0.5,
      currency: "USD",
    });
  });
});

describe("old session/list path", () => {
  it("calls the SDK exactly as before for a client without sessionIndex", async () => {
    const session = await writeTranscript({});

    const plain = createAgent().agent;
    await initializeClient(plain, {});
    const page = await plain.listSessions({ cwd: workspace });
    expect(page.sessions.map((s) => s.sessionId)).toEqual([session.id]);
    expect(page.sessions[0]).not.toHaveProperty("_meta");
    expect(vi.mocked(listSessions).mock.calls).toEqual([
      [{ dir: workspace, limit: 1001, offset: 0 }],
    ]);

    // AIR without sessionIndex: the same SDK call.
    vi.mocked(listSessions).mockClear();
    const airAgent = createAgent().agent;
    await initializeClient(airAgent, air());
    expect(
      (await airAgent.listSessions({ cwd: workspace })).sessions.map((s) => s.sessionId),
    ).toEqual([session.id]);
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

  it("refuses an unknown session", async () => {
    const { agent } = await indexAgent();
    await expect(
      agent.renameSessionTitle({ sessionId: randomUUID(), title: "x" }),
    ).rejects.toMatchObject({ code: -32002 });
  });

  it("renames a session that another process holds, as the CLI does", async () => {
    const session = await writeTranscript({});
    await registerHolder(process.pid, session.id);
    const { agent } = await indexAgent();
    await agent.renameSessionTitle({ sessionId: session.id, title: "Held" });
    expect(await lastRecords(session.file)).toEqual(titleRecords(session.id, "Held"));
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

  it("read the archive state from the agent name first, else the custom title, as AIR does", async () => {
    // The agent name has the prefix, the custom title not: archived.
    const byAgentName = await writeTranscript({
      lastMessageAt: Date.parse("2026-01-03T00:00:00Z"),
      trailer: [
        { type: "custom-title", customTitle: "Open", sessionId: "" },
        { type: "agent-name", agentName: "[archived] Open", sessionId: "" },
      ],
    });
    // The custom title has the prefix, the agent name not: not archived,
    // whichever record comes last.
    const byTitle = await writeTranscript({
      lastMessageAt: Date.parse("2026-01-02T00:00:00Z"),
      trailer: [
        { type: "agent-name", agentName: "Named", sessionId: "" },
        { type: "custom-title", customTitle: "[archived] Named", sessionId: "" },
      ],
    });
    // No agent name: the custom title decides.
    const byCustomTitle = await writeTranscript({
      lastMessageAt: Date.parse("2026-01-01T00:00:00Z"),
      trailer: [{ type: "custom-title", customTitle: "[archived] Done", sessionId: "" }],
    });
    // A prompt is no name: it never archives a session.
    const byPrompt = await writeTranscript({
      lastMessageAt: Date.parse("2025-12-31T00:00:00Z"),
      prompt: "[archived] Looks done",
    });
    const { agent } = await indexAgent();
    const rows = async (archived: string) =>
      (await agent.listSessions({ cwd: workspace, _meta: listMeta({ archived }) })).sessions.map(
        (s) => [s.sessionId, s.title, airRow(s).archived],
      );
    expect(await rows("archived")).toEqual([
      [byAgentName.id, "Open", true],
      [byCustomTitle.id, "Done", true],
    ]);
    expect(await rows("unarchived")).toEqual([
      [byTitle.id, "Named", false],
      [byPrompt.id, "[archived] Looks done", false],
    ]);
    // Archive and unarchive take the title and the state as listed, and
    // write both records.
    await agent.archiveSession({ sessionId: byTitle.id });
    expect(await lastRecords(byTitle.file)).toEqual(titleRecords(byTitle.id, "[archived] Named"));
    await agent.archiveSession({ sessionId: byPrompt.id });
    expect(await lastRecords(byPrompt.file)).toEqual(
      titleRecords(byPrompt.id, "[archived] Looks done"),
    );
    // A rename of a session archived by its agent name keeps the prefix.
    await agent.renameSessionTitle({ sessionId: byAgentName.id, title: "Renamed" });
    expect(await lastRecords(byAgentName.file)).toEqual(
      titleRecords(byAgentName.id, "[archived] Renamed"),
    );
    await agent.unarchiveSession({ sessionId: byAgentName.id });
    expect(await lastRecords(byAgentName.file)).toEqual(titleRecords(byAgentName.id, "Renamed"));
    await agent.unarchiveSession({ sessionId: byCustomTitle.id });
    expect(await lastRecords(byCustomTitle.file)).toEqual(titleRecords(byCustomTitle.id, "Done"));
    expect(await rows("archived")).toEqual([
      [byTitle.id, "Named", true],
      [byPrompt.id, "Looks done", true],
    ]);
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

  it("ignore a legacy archive marker file", async () => {
    const session = await writeTranscript({});
    const marker = path.join(configDir, "acp", "archived", session.id);
    await fs.mkdir(path.dirname(marker), { recursive: true });
    await fs.writeFile(marker, "");
    const { agent } = await indexAgent();
    const page = await agent.listSessions({ cwd: workspace });
    expect(page.sessions.map((s) => s.sessionId)).toEqual([session.id]);
    expect((page.sessions[0]!._meta as any).jetbrains.air.archived).toBe(false);
    await agent.archiveSession({ sessionId: session.id });
    expect(fsSync.existsSync(marker)).toBe(true);
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
  it("deletes the transcript for a sessionIndex client", async () => {
    const session = await writeTranscript({});
    const { agent } = await indexAgent();
    await agent.archiveSession({ sessionId: session.id });
    await agent.deleteSession({ sessionId: session.id });
    expect(fsSync.existsSync(session.file)).toBe(false);
    await expect(agent.deleteSession({ sessionId: session.id })).rejects.toMatchObject({
      code: -32002,
    });
  });

  it("deletes a session that another process holds, as the CLI does", async () => {
    const session = await writeTranscript({});
    await registerHolder(process.pid, session.id);
    const { agent } = await indexAgent();
    await agent.deleteSession({ sessionId: session.id });
    expect(fsSync.existsSync(session.file)).toBe(false);
  });

  it("archives instead of deleting for an AIR client without sessionIndex", async () => {
    const session = await writeTranscript({});
    const { agent } = createAgent();
    await initializeClient(agent, air());
    await agent.deleteSession({ sessionId: session.id });
    expect(deleteSession).not.toHaveBeenCalled();
    expect(fsSync.existsSync(session.file)).toBe(true);
    expect(await lastRecords(session.file)).toEqual(titleRecords(session.id, "[archived] Fix it"));
    expect((await agent.listSessions({ cwd: workspace })).sessions).toEqual([]);
  });

  it("archives for an AIR client without sessionIndex a session held elsewhere", async () => {
    const session = await writeTranscript({});
    await registerHolder(process.pid, session.id);
    const { agent } = createAgent();
    await initializeClient(agent, air());
    await agent.deleteSession({ sessionId: session.id });
    expect(await lastRecords(session.file)).toEqual(titleRecords(session.id, "[archived] Fix it"));
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

/** Registers `pid` as a live CLI holding `sessionId`. */
async function registerHolder(pid: number, sessionId: string, extra: object = {}) {
  await fs.mkdir(path.join(configDir, "sessions"), { recursive: true });
  await fs.writeFile(
    path.join(configDir, "sessions", `${pid}.json`),
    JSON.stringify({ pid, sessionId, updatedAt: Date.now(), ...extra }),
  );
}

/** Lets the watchers of a subscription settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 300));

async function waitFor(predicate: () => boolean, timeoutMs = 8000): Promise<boolean> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) return false;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return true;
}

/** An interactive CLI record whose status is newer than any transcript. */
const liveCli = (status: string) => ({
  kind: "interactive",
  entrypoint: "cli",
  status,
  statusUpdatedAt: Date.now() + 60_000,
});

function promptRecord(sessionId: string, text: string, at = Date.now()): string {
  return JSON.stringify({
    type: "user",
    sessionId,
    cwd: workspace,
    uuid: randomUUID(),
    timestamp: new Date(at).toISOString(),
    message: { role: "user", content: text },
  });
}

function assistantRecord(sessionId: string, stopReason: string | null, at = Date.now()): string {
  return JSON.stringify({
    type: "assistant",
    sessionId,
    cwd: workspace,
    uuid: randomUUID(),
    timestamp: new Date(at).toISOString(),
    message: { role: "assistant", content: [{ type: "text", text: "z" }], stop_reason: stopReason },
  });
}

const airRow = (info: { _meta?: Record<string, unknown> | null }) =>
  (info._meta as any)?.jetbrains?.air as Record<string, unknown>;

describe("_session/list/subscribe", () => {
  const changesOf = (notifications: { method: string; params: Record<string, unknown> }[]) =>
    notifications
      .filter((n) => n.method === "_session/list/changes")
      .map((n) => n.params as unknown as ListChanges);

  async function subscribedAgent(cwd = workspace) {
    const created = await indexAgent();
    const { subscriptionId } = await created.agent.subscribeSessionList({ cwd });
    await settle();
    const changes = () => changesOf(created.notifications);
    const rowsOf = (sessionId: string) =>
      changes().flatMap((change) => change.sessions.filter((s) => s.sessionId === sessionId));
    return { ...created, subscriptionId, changes, rowsOf };
  }

  const handlesOf = (agent: ClaudeAcpAgent) =>
    (agent as any).sessionIndex.service.subscriptions as ListSubscriptions | undefined;

  it("takes an absolute cwd and ignores other parameters", () => {
    for (const params of [{}, { cwd: 1 }, { cwd: "relative/dir" }, { cwd: "" }, null]) {
      expect(() => parseListSubscribeRequest(params)).toThrow(
        expect.objectContaining({ code: -32602 }),
      );
    }
    expect(parseListSubscribeRequest({ cwd: "/repo", archived: "all", limit: 3 })).toEqual({
      cwd: "/repo",
    });
    expect(() => parseListUnsubscribeRequest({})).toThrow(
      expect.objectContaining({ code: -32602 }),
    );
  });

  it("answers method-not-found without sessionIndex", async () => {
    const { agent } = createAgent();
    await initializeClient(agent, air());
    await expect(agent.subscribeSessionList({ cwd: workspace })).rejects.toMatchObject({
      code: -32601,
    });
    await expect(agent.unsubscribeSessionList({ subscriptionId: "x" })).rejects.toMatchObject({
      code: -32601,
    });
  });

  it("refuses the 129th subscription of a connection", async () => {
    const { agent } = await indexAgent();
    const ids: string[] = [];
    for (let i = 0; i < MAX_SUBSCRIPTIONS; i++) {
      ids.push((await agent.subscribeSessionList({ cwd: workspace })).subscriptionId);
    }
    expect(new Set(ids).size).toBe(MAX_SUBSCRIPTIONS);
    await expect(agent.subscribeSessionList({ cwd: workspace })).rejects.toMatchObject({
      code: -32602,
      data: { reason: "too_many_subscriptions" },
    });
    expect(await agent.unsubscribeSessionList({ subscriptionId: ids[0]! })).toEqual({});
    // Idempotent, and an unknown id is no error.
    expect(await agent.unsubscribeSessionList({ subscriptionId: ids[0]! })).toEqual({});
    expect(await agent.unsubscribeSessionList({ subscriptionId: "unknown" })).toEqual({});
    await agent.subscribeSessionList({ cwd: workspace });
    // One watch of the cwd for all of them.
    expect(handlesOf(agent)!.openHandles().watches).toBe(1);
    await agent.dispose();
  });

  it("sends the archive state by the agent name first, else the custom title", async () => {
    const { rowsOf, agent } = await subscribedAgent();
    const byAgentName = await writeTranscript({
      trailer: [
        { type: "custom-title", customTitle: "Open", sessionId: "" },
        { type: "agent-name", agentName: "[archived] Open", sessionId: "" },
      ],
    });
    const byTitle = await writeTranscript({
      trailer: [
        { type: "agent-name", agentName: "Named", sessionId: "" },
        { type: "custom-title", customTitle: "[archived] Named", sessionId: "" },
      ],
    });
    const byCustomTitle = await writeTranscript({
      trailer: [{ type: "custom-title", customTitle: "[archived] Done", sessionId: "" }],
    });
    const ids = [byAgentName.id, byTitle.id, byCustomTitle.id];
    expect(await waitFor(() => ids.every((id) => rowsOf(id).length > 0))).toBe(true);
    const last = (id: string) => rowsOf(id).at(-1)!;
    expect(ids.map((id) => [last(id).title, airRow(last(id)).archived])).toEqual([
      ["Open", true],
      ["Named", false],
      ["Done", true],
    ]);
    await agent.dispose();
  });

  it("sends a created session, a prompt and a turn end, but not updatedAt alone", async () => {
    const { rowsOf, changes, subscriptionId, agent } = await subscribedAgent();
    const session = await writeTranscript({ prompt: "First", lastMessageAt: Date.now() - 5000 });
    expect(await waitFor(() => rowsOf(session.id).length === 1)).toBe(true);
    expect(changes()[0]).toMatchObject({ subscriptionId, removed: [] });
    expect(rowsOf(session.id)[0]).toMatchObject({ title: "First", cwd: workspace });
    expect(airRow(rowsOf(session.id)[0]!)).toMatchObject({ archived: false, state: "idle" });

    const promptAt = Date.now() - 1000;
    await fs.appendFile(session.file, promptRecord(session.id, "Second", promptAt) + "\n");
    expect(await waitFor(() => rowsOf(session.id).length === 2)).toBe(true);
    expect(airRow(rowsOf(session.id)[1]!).lastPromptAt).toBe(new Date(promptAt).toISOString());

    const endedAt = Date.now() - 500;
    await fs.appendFile(session.file, assistantRecord(session.id, "end_turn", endedAt) + "\n");
    expect(await waitFor(() => rowsOf(session.id).length === 3)).toBe(true);
    expect(airRow(rowsOf(session.id)[2]!).lastTurnEndedAt).toBe(new Date(endedAt).toISOString());

    // A message that changes nothing but updatedAt.
    await fs.appendFile(session.file, assistantRecord(session.id, null) + "\n");
    await new Promise((resolve) => setTimeout(resolve, 2500));
    expect(rowsOf(session.id)).toHaveLength(3);
    await agent.dispose();
  }, 60_000);

  it("sends a state flip of the registry, a rename, archive, unarchive and a delete", async () => {
    const session = await writeTranscript({ prompt: "Old title" });
    const { rowsOf, changes, agent } = await subscribedAgent();
    // The last row sent satisfies `check` (the watch may also report the
    // transcript's creation, just before subscribe, as its first change).
    const lastIs = (check: (row: SessionInfo) => boolean) =>
      waitFor(() => {
        const row = rowsOf(session.id).at(-1);
        return row !== undefined && check(row);
      });

    await registerHolder(process.pid, session.id, liveCli("busy"));
    expect(await lastIs((row) => airRow(row).state === "running")).toBe(true);
    await registerHolder(process.pid, session.id, liveCli("waiting"));
    expect(await lastIs((row) => airRow(row).state === "requires_action")).toBe(true);
    await fs.rm(path.join(configDir, "sessions", `${process.pid}.json`));
    expect(await lastIs((row) => airRow(row).state === "idle")).toBe(true);

    await agent.renameSessionTitle({ sessionId: session.id, title: "New title" });
    expect(await lastIs((row) => row.title === "New title")).toBe(true);

    await agent.archiveSession({ sessionId: session.id });
    expect(await lastIs((row) => airRow(row).archived === true)).toBe(true);
    await agent.unarchiveSession({ sessionId: session.id });
    expect(await lastIs((row) => airRow(row).archived === false)).toBe(true);

    await agent.deleteSession({ sessionId: session.id });
    expect(await waitFor(() => changes().some((c) => c.removed.includes(session.id)))).toBe(true);
    await agent.dispose();
  }, 60_000);

  it("sends the error state of a turn that ended with an API error, and clears it", async () => {
    const session = await writeTranscript({});
    const { rowsOf, agent } = await subscribedAgent();
    await fs.appendFile(
      session.file,
      JSON.stringify({
        type: "assistant",
        sessionId: session.id,
        cwd: workspace,
        uuid: randomUUID(),
        timestamp: new Date().toISOString(),
        isApiErrorMessage: true,
        message: { role: "assistant", content: [{ type: "text", text: "API Error" }] },
      }) + "\n",
    );
    const state = (value: string) => () =>
      rowsOf(session.id).some((row) => airRow(row).state === value);
    expect(await waitFor(state("error"))).toBe(true);
    const listed = await agent.listSessions({ cwd: workspace });
    expect(airRow(listed.sessions[0]!).state).toBe("error");
    await fs.appendFile(session.file, promptRecord(session.id, "Try again") + "\n");
    expect(await waitFor(() => airRow(rowsOf(session.id).at(-1)!).state === "idle")).toBe(true);
    await agent.dispose();
  });

  it("keeps the error of a query that failed here after it closes", async () => {
    const session = await writeTranscript({});
    const { rowsOf, agent } = await subscribedAgent();
    const loaded = mockSessionState({}, agent, session.id) as any;
    loaded.lastSessionState = "running";
    loaded.input = { end: () => {} };
    loaded.query = { close: () => {} };
    agent.sessions[session.id] = loaded;
    (agent as any).sessionIndex.onQueryFailed(session.id);
    (agent as any).closeQueryStream(loaded);
    const last = () => rowsOf(session.id).at(-1);
    expect(await waitFor(() => last() !== undefined && airRow(last()!).state === "error")).toBe(
      true,
    );
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(airRow(last()!).state).toBe("error");
    const listed = await agent.listSessions({ cwd: workspace });
    expect(airRow(listed.sessions[0]!).state).toBe("error");
    // Loaded again: still the failure until a turn starts.
    const reloaded = mockSessionState({}, agent, session.id) as any;
    reloaded.lastSessionState = "idle";
    agent.sessions[session.id] = reloaded;
    const relisted = async () =>
      airRow((await agent.listSessions({ cwd: workspace })).sessions[0]!).state;
    expect(await relisted()).toBe("error");
    (agent as any).sessionIndex.onTurnStarted(session.id);
    expect(await relisted()).toBe("idle");
    delete agent.sessions[session.id];
    await agent.dispose();
  });

  it("clears the failed turn of a session that runs here when a new turn starts", async () => {
    const { noteSessionState } = await import("../session-index/connection.js");
    const session = { lastTurnFailed: true } as any;
    noteSessionState(session, "idle", "running");
    expect(session.lastTurnFailed).toBe(false);
  });

  it("sends the SDK state of a session this connection runs at once, and its close", async () => {
    const session = await writeTranscript({});
    const { rowsOf, agent } = await subscribedAgent();
    // Past the interval of a row sent for the creation of the transcript.
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const loaded = mockSessionState({}, agent, session.id) as any;
    loaded.lastSessionState = "running";
    agent.sessions[session.id] = loaded;
    const started = Date.now();
    (agent as any).sessionIndex.onOwnSessionChanged(session.id);
    const running = () => rowsOf(session.id).some((row) => airRow(row).state === "running");
    expect(await waitFor(running)).toBe(true);
    expect(Date.now() - started).toBeLessThan(150);
    // The query closes: the row shows the transcript's state again.
    await new Promise((resolve) => setTimeout(resolve, 1100));
    loaded.input = { end: () => {} };
    loaded.query = { close: () => {} };
    (agent as any).closeQueryStream(loaded);
    const idle = () => rowsOf(session.id).some((row) => airRow(row).state === "idle");
    expect(await waitFor(idle)).toBe(true);
    delete agent.sessions[session.id];
    await agent.dispose();
  });

  it("coalesces the changes of a session to one a second", async () => {
    const session = await writeTranscript({});
    const service = new SessionIndexService({ logError: () => {} });
    const sent: { at: number; changes: ListChanges }[] = [];
    const subscriptions = new ListSubscriptions({
      index: service.index,
      registry: service.registry,
      own: () => undefined,
      notify: async (changes) => {
        sent.push({ at: Date.now(), changes });
      },
      logError: () => {},
      debounceMs: 30,
      maxWaitMs: 100,
      minSessionIntervalMs: 500,
    });
    await subscriptions.subscribe(workspace);
    await settle();
    // A new prompt every 40 ms for 1.6 s: each one changes lastPromptAt.
    const start = Date.now();
    let lastAt = 0;
    while (Date.now() - start < 1600) {
      lastAt = Date.now() - 100_000;
      await fs.appendFile(session.file, promptRecord(session.id, "again", lastAt) + "\n");
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    await new Promise((resolve) => setTimeout(resolve, 800));
    const times = sent
      .filter(({ changes }) => changes.sessions.some((s) => s.sessionId === session.id))
      .map(({ at }) => at);
    expect(times.length).toBeGreaterThanOrEqual(3);
    expect(times.length).toBeLessThanOrEqual(5);
    for (let i = 1; i < times.length; i++) {
      expect(times[i]! - times[i - 1]!).toBeGreaterThanOrEqual(480);
    }
    // The last sent row is the last prompt.
    const lastRow = sent.at(-1)!.changes.sessions.at(-1)!;
    expect(airRow(lastRow).lastPromptAt).toBe(new Date(lastAt).toISOString());
    subscriptions.dispose();
  }, 10_000);

  it("shares one watcher between two subscriptions of a cwd, each notified", async () => {
    const { agent, notifications } = await indexAgent();
    const handles = () => handlesOf(agent)!.openHandles();
    const first = await agent.subscribeSessionList({ cwd: workspace });
    const session = await writeTranscript({});
    await settle();
    const one = handles();
    const second = await agent.subscribeSessionList({ cwd: workspace });
    expect(handles()).toMatchObject({ watches: 1, watchers: one.watchers });
    const notifiedIds = () =>
      changesOf(notifications)
        .filter((c) => c.sessions.length > 0)
        .map((c) => c.subscriptionId);

    await fs.appendFile(session.file, promptRecord(session.id, "Again") + "\n");
    expect(
      await waitFor(
        () =>
          notifiedIds().includes(first.subscriptionId) &&
          notifiedIds().includes(second.subscriptionId),
      ),
    ).toBe(true);

    await agent.unsubscribeSessionList(first);
    expect(handles()).toMatchObject({ watches: 1, watchers: one.watchers });
    const before = notifiedIds().length;
    await new Promise((resolve) => setTimeout(resolve, 1100));
    await fs.appendFile(session.file, promptRecord(session.id, "Once more") + "\n");
    expect(await waitFor(() => notifiedIds().length > before)).toBe(true);
    expect(notifiedIds().slice(before)).toEqual([second.subscriptionId]);

    await agent.unsubscribeSessionList(second);
    expect(handles()).toEqual({ watches: 0, watchers: 0, timers: 0 });
    await agent.dispose();
  }, 10_000);

  it("leaves no watcher or timer after the connection closes", async () => {
    const session = await writeTranscript({});
    const { agent } = await subscribedAgent();
    const subscriptions = handlesOf(agent)!;
    expect(subscriptions.openHandles().watchers).toBeGreaterThan(0);
    // A change in flight when the connection closes.
    await fs.appendFile(session.file, promptRecord(session.id, "Late") + "\n");
    await agent.dispose();
    expect(subscriptions.openHandles()).toEqual({ watches: 0, watchers: 0, timers: 0 });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(subscriptions.openHandles()).toEqual({ watches: 0, watchers: 0, timers: 0 });
  });

  it("covers the same subdirectory of every linked worktree", async () => {
    const repo = path.join(workspace, "repo");
    const linked = path.join(workspace, "linked");
    const meta = path.join(repo, ".git", "worktrees", "linked");
    await fs.mkdir(meta, { recursive: true });
    await fs.mkdir(linked, { recursive: true });
    await fs.writeFile(path.join(meta, "gitdir"), `${path.join(linked, ".git")}\n`);
    await fs.writeFile(path.join(linked, ".git"), `gitdir: ${meta}\n`);
    await fs.writeFile(path.join(meta, "commondir"), "../..\n");
    // The worktree's project directory exists before the subscription.
    await writeTranscript({ cwd: linked });
    const { rowsOf, changes, agent } = await subscribedAgent(repo);
    const inLinked = await writeTranscript({ cwd: linked });
    const inRepo = await writeTranscript({ cwd: repo });
    const elsewhere = await writeTranscript({ cwd: workspace });
    expect(
      await waitFor(() => rowsOf(inLinked.id).length === 1 && rowsOf(inRepo.id).length === 1),
    ).toBe(true);
    expect(rowsOf(inLinked.id)[0]!.cwd).toBe(linked);
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(changes().flatMap((c) => c.sessions.map((s) => s.sessionId))).not.toContain(
      elsewhere.id,
    );
    await agent.dispose();
  });

  /** A subscription manager over a real index whose first read of rows is slow. */
  function slowFirstRows(
    delayMs: number,
    options: {
      minSessionIntervalMs?: number;
      rescanMs?: number;
      failFirstRead?: boolean;
      now?: () => number;
    } = {},
  ) {
    const service = new SessionIndexService({ logError: () => {} });
    const sent: { at: number; changes: ListChanges }[] = [];
    const rowsRead: string[][] = [];
    let slow = true;
    let failing = false;
    const index = {
      listedPaths: service.index.listedPaths.bind(service.index),
      projectDirs: service.index.projectDirs.bind(service.index),
      enumerateFiles: service.index.enumerateFiles.bind(service.index),
      continuedIn: service.index.continuedIn.bind(service.index),
      cachedRowsOf: service.index.cachedRowsOf.bind(service.index),
      isRead: (candidate: Parameters<typeof service.index.isRead>[0]) =>
        failing ? false : service.index.isRead(candidate),
      rowsOf: async (...args: Parameters<typeof service.index.rowsOf>) => {
        rowsRead.push(args[1].map((candidate) => candidate.sessionId));
        if (slow) {
          slow = false;
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          // A first read that fails: no row, and nothing cached.
          if (options.failFirstRead) {
            failing = true;
            setTimeout(() => (failing = false), 100);
            return [];
          }
        }
        return service.index.rowsOf(...args);
      },
    };
    const subscriptions = new ListSubscriptions({
      index,
      registry: service.registry,
      own: () => undefined,
      notify: async (changes) => {
        sent.push({ at: Date.now(), changes });
      },
      logError: () => {},
      minSessionIntervalMs: options.minSessionIntervalMs,
      now: options.now,
      rescanMs: options.rescanMs,
    });
    /** What a client reads with session/list before it subscribes. */
    const list = (cwd = workspace) => service.index.list({ cwd, limit: 50, archived: "all" });
    return { subscriptions, sent, rowsRead, list, service };
  }

  it("hides a listed session continued in a successor that got history during a read", async () => {
    const successorId = randomUUID();
    const predecessor = await writeTranscript({
      trailer: [{ type: "continued-in", continuedInSessionId: successorId }],
    });
    const stub = await writeTranscript({ sessionId: successorId });
    const { subscriptions, sent, list } = slowFirstRows(400);
    await list();
    await subscriptions.subscribe(workspace);
    await fs.appendFile(
      stub.file,
      JSON.stringify({ type: "user", parentUuid: null, sessionId: successorId, cwd: workspace }) +
        "\n",
    );
    expect(
      await waitFor(() => sent.some(({ changes }) => changes.removed.includes(predecessor.id))),
    ).toBe(true);
    subscriptions.dispose();
  });

  it("shows a session continued in a successor deleted after it was listed", async () => {
    const successorId = randomUUID();
    const predecessor = await writeTranscript({
      trailer: [{ type: "continued-in", continuedInSessionId: successorId }],
    });
    const successor = await writeTranscript({ sessionId: successorId });
    await fs.appendFile(
      successor.file,
      JSON.stringify({ type: "user", parentUuid: null, sessionId: successorId, cwd: workspace }) +
        "\n",
    );
    // The successor has history: the list hides the predecessor.
    const { subscriptions, sent, list } = slowFirstRows(400);
    expect((await list()).rows.map((row) => row.sessionId)).toEqual([successorId]);
    await subscriptions.subscribe(workspace);
    await fs.rm(successor.file);
    const shown = () =>
      sent.some(({ changes }) => changes.sessions.some((s) => s.sessionId === predecessor.id));
    expect(await waitFor(shown)).toBe(true);
    subscriptions.dispose();
  });

  it("reads again a transcript whose first read failed", async () => {
    const session = await writeTranscript({});
    const { subscriptions, sent } = slowFirstRows(0, { rescanMs: 500, failFirstRead: true });
    await subscriptions.subscribe(workspace);
    await fs.appendFile(session.file, promptRecord(session.id, "Next") + "\n");
    const shown = () =>
      sent.some(({ changes }) => changes.sessions.some((s) => s.sessionId === session.id));
    expect(await waitFor(shown)).toBe(true);
    subscriptions.dispose();
  });

  it("sends a registry change that lands while the registry is read first", async () => {
    const session = await writeTranscript({});
    await registerHolder(process.pid, session.id, liveCli("idle"));
    const service = new SessionIndexService({ logError: () => {} });
    let first = true;
    const registry = {
      readFiles: async (...args: Parameters<typeof service.registry.readFiles>) => {
        if (first) {
          first = false;
          await new Promise((resolve) => setTimeout(resolve, 300));
        }
        return service.registry.readFiles(...args);
      },
    };
    const sent: ListChanges[] = [];
    const subscriptions = new ListSubscriptions({
      index: service.index,
      registry,
      own: () => undefined,
      notify: async (changes) => {
        sent.push(changes);
      },
      logError: () => {},
    });
    await subscriptions.subscribe(workspace);
    await registerHolder(process.pid, session.id, liveCli("busy"));
    const running = () =>
      sent.some((c) =>
        c.sessions.some((s) => s.sessionId === session.id && airRow(s).state === "running"),
      );
    expect(await waitFor(running)).toBe(true);
    subscriptions.dispose();
  });

  it("sends the sessions of a worktree linked after subscribe that shares the directory", async () => {
    const repo = path.join(workspace, "repo.a");
    const linked = path.join(workspace, "repo-a");
    expect(encodeProjectPath(repo)).toBe(encodeProjectPath(linked));
    await fs.mkdir(path.join(repo, ".git"), { recursive: true });
    await fs.mkdir(linked, { recursive: true });
    const inLinked = await writeTranscript({ cwd: linked });
    const { subscriptions, sent, list } = slowFirstRows(0, { rescanMs: 400 });
    // The client's list of the repository read the transcript of the other path.
    await list(repo);
    await subscriptions.subscribe(repo);
    await settle();
    expect(sent).toEqual([]);
    // `git worktree add` of the other path.
    const meta = path.join(repo, ".git", "worktrees", "linked");
    await fs.mkdir(meta, { recursive: true });
    await fs.writeFile(path.join(meta, "gitdir"), `${path.join(linked, ".git")}\n`);
    await fs.writeFile(path.join(meta, "commondir"), "../..\n");
    await fs.writeFile(path.join(linked, ".git"), `gitdir: ${meta}\n`);
    const shown = () =>
      sent.some(({ changes }) => changes.sessions.some((s) => s.sessionId === inLinked.id));
    expect(await waitFor(shown)).toBe(true);
    subscriptions.dispose();
  });

  it("watches a project directory that was replaced", async () => {
    const session = await writeTranscript({});
    const dir = path.dirname(session.file);
    const { subscriptions, sent } = slowFirstRows(0);
    await subscriptions.subscribe(workspace);
    await settle();
    await fs.rename(dir, `${dir}.old`);
    await fs.mkdir(dir);
    await fs.copyFile(path.join(`${dir}.old`, path.basename(session.file)), session.file);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const before = sent.length;
    await fs.appendFile(session.file, promptRecord(session.id, "In the new directory") + "\n");
    expect(await waitFor(() => sent.length > before, 3000)).toBe(true);
    subscriptions.dispose();
    await fs.rm(`${dir}.old`, { recursive: true, force: true });
  });

  it("removes a session deleted after the first read took its row", async () => {
    const session = await writeTranscript({});
    const { subscriptions, sent } = slowFirstRows(400);
    await subscriptions.subscribe(workspace);
    // Its row is read (the delay is inside the first read), then it goes.
    await new Promise((resolve) => setTimeout(resolve, 100));
    await fs.appendFile(session.file, promptRecord(session.id, "Changed") + "\n");
    await new Promise((resolve) => setTimeout(resolve, 450));
    await fs.rm(session.file);
    expect(
      await waitFor(() => sent.some(({ changes }) => changes.removed.includes(session.id))),
    ).toBe(true);
    subscriptions.dispose();
  });

  it("sends a rename made while the first read runs", async () => {
    const session = await writeTranscript({ prompt: "Before" });
    const { subscriptions, sent } = slowFirstRows(400);
    await subscriptions.subscribe(workspace);
    await fs.appendFile(
      session.file,
      JSON.stringify({ type: "custom-title", customTitle: "After", sessionId: session.id }) + "\n",
    );
    await writeCustomTitleSidecar(session.file, "After");
    const renamed = () =>
      sent.some(({ changes }) =>
        changes.sessions.some((s) => s.sessionId === session.id && s.title === "After"),
      );
    expect(await waitFor(renamed)).toBe(true);
    subscriptions.dispose();
  });

  it("reads no transcript to subscribe, nor on a rescan of unchanged ones", async () => {
    const sessions: { id: string; file: string }[] = [];
    for (let i = 0; i < 12; i++) sessions.push(await writeTranscript({}));
    // Past the events of these writes, which a new watch may still get.
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const { subscriptions, sent, rowsRead, service } = slowFirstRows(0, { rescanMs: 300 });
    await subscriptions.subscribe(workspace);
    // Past the rescan after the watchers opened, and a few periodic ones.
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(rowsRead).toEqual([]);
    expect(sent).toEqual([]);
    expect(service.index.transcriptsRead).toBe(0);
    const files = await service.index.enumerateFiles([workspace]);
    expect(files).toHaveLength(12);
    expect(files.filter((file) => service.index.isRead(file))).toEqual([]);

    await fs.appendFile(sessions[4]!.file, promptRecord(sessions[4]!.id, "Next") + "\n");
    expect(await waitFor(() => sent.length > 0)).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 1000));
    // Only the changed session was read, by its event and by none of the rescans.
    expect(new Set(rowsRead.flat())).toEqual(new Set([sessions[4]!.id]));
    expect(
      (await service.index.enumerateFiles([workspace]))
        .filter((file) => service.index.isRead(file))
        .map((file) => file.sessionId),
    ).toEqual([sessions[4]!.id]);
    subscriptions.dispose();
  });

  it("sends the first change of a session in full, then not updatedAt alone", async () => {
    const session = await writeTranscript({ prompt: "Before", lastMessageAt: Date.now() - 60_000 });
    const { subscriptions, sent } = slowFirstRows(0, { minSessionIntervalMs: 300 });
    await subscriptions.subscribe(workspace);
    await settle();
    // A message that changes nothing but updatedAt: the first change is sent.
    await fs.appendFile(session.file, assistantRecord(session.id, null) + "\n");
    expect(await waitFor(() => sent.length === 1)).toBe(true);
    expect(sent[0]!.changes.sessions.map((s) => [s.sessionId, s.title])).toEqual([
      [session.id, "Before"],
    ]);
    // Another one is no change.
    await new Promise((resolve) => setTimeout(resolve, 500));
    await fs.appendFile(session.file, assistantRecord(session.id, null) + "\n");
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(sent).toHaveLength(1);
    subscriptions.dispose();
  });

  it.each([
    { continued: false, beforeRescan: false, evicted: false },
    { continued: false, beforeRescan: true, evicted: false },
    { continued: false, beforeRescan: true, evicted: true },
    { continued: true, beforeRescan: false, evicted: false },
  ])(
    "sends the state of a listed live session that ages without an event (%o)",
    async ({ continued, beforeRescan, evicted }) => {
      const id = randomUUID();
      // An unfinished turn of an SDK session in another process; continued
      // in a session that has no transcript, so the list still shows it.
      const session = await writeTranscript({
        sessionId: id,
        mtimeMs: Date.now(),
        trailer: [
          JSON.parse(promptRecord(id, "Working", Date.now())),
          ...(continued ? [{ type: "continued-in", continuedInSessionId: randomUUID() }] : []),
        ],
      });
      await registerHolder(process.pid, session.id, { entrypoint: "sdk-ts" });
      await new Promise((resolve) => setTimeout(resolve, 1000));
      let offset = 0;
      const { subscriptions, sent, list, rowsRead, service } = slowFirstRows(0, {
        rescanMs: 300,
        now: () => Date.now() + offset,
      });
      const listed = (await list()).rows;
      expect(listed.map((row) => row.sessionId)).toEqual([session.id]);
      await subscriptions.subscribe(workspace);
      // The index drops its metadata before the first rescan.
      if (evicted) service.index.invalidate([session.file]);
      if (!beforeRescan) {
        await new Promise((resolve) => setTimeout(resolve, 800));
        expect(sent).toEqual([]);
      }
      // Past the time an unfinished turn counts as running.
      offset = 11 * 60 * 1000;
      expect(await waitFor(() => sent.length > 0)).toBe(true);
      const row = sent[0]!.changes.sessions[0]!;
      expect(row.sessionId).toBe(session.id);
      expect(airRow(row).state).toBeUndefined();
      // From the metadata the list read: no transcript read for the row.
      if (!continued) expect(rowsRead).toEqual([]);
      subscriptions.dispose();
    },
  );

  it("removes a sent continued session whose cached metadata went when its successor gets history", async () => {
    const successorId = randomUUID();
    const predecessor = await writeTranscript({
      trailer: [{ type: "continued-in", continuedInSessionId: successorId }],
    });
    const stub = await writeTranscript({ sessionId: successorId });
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const { subscriptions, sent, service } = slowFirstRows(0, { minSessionIntervalMs: 0 });
    await subscriptions.subscribe(workspace);
    await settle();
    // An event of it that leaves it continued.
    await fs.appendFile(
      predecessor.file,
      JSON.stringify({ type: "continued-in", continuedInSessionId: successorId }) + "\n",
    );
    const shown = () =>
      sent.some(({ changes }) => changes.sessions.some((s) => s.sessionId === predecessor.id));
    expect(await waitFor(shown)).toBe(true);
    // The index no longer holds its metadata (evicted).
    service.index.invalidate([predecessor.file]);
    await fs.appendFile(
      stub.file,
      JSON.stringify({ type: "user", parentUuid: null, sessionId: successorId, cwd: workspace }) +
        "\n",
    );
    expect(
      await waitFor(() => sent.some(({ changes }) => changes.removed.includes(predecessor.id))),
    ).toBe(true);
    subscriptions.dispose();
  }, 15_000);

  it("removes a listed continued session whose cached metadata went when its successor gets history", async () => {
    const successorId = randomUUID();
    const predecessor = await writeTranscript({
      trailer: [{ type: "continued-in", continuedInSessionId: successorId }],
    });
    const stub = await writeTranscript({ sessionId: successorId });
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const { subscriptions, sent, service, list } = slowFirstRows(0);
    expect((await list()).rows.map((row) => row.sessionId)).toContain(predecessor.id);
    await subscriptions.subscribe(workspace);
    await settle();
    // The index no longer holds its metadata (evicted), and no event read it.
    service.index.invalidate([predecessor.file]);
    await fs.appendFile(
      stub.file,
      JSON.stringify({ type: "user", parentUuid: null, sessionId: successorId, cwd: workspace }) +
        "\n",
    );
    expect(
      await waitFor(() => sent.some(({ changes }) => changes.removed.includes(predecessor.id))),
    ).toBe(true);
    subscriptions.dispose();
  }, 15_000);

  it("checks a live continued session hidden by its successor once, not on every rescan", async () => {
    const successorId = randomUUID();
    const predecessor = await writeTranscript({
      mtimeMs: Date.now(),
      trailer: [{ type: "continued-in", continuedInSessionId: successorId }],
    });
    await writeTranscript({
      sessionId: successorId,
      trailer: [{ type: "user", parentUuid: null, sessionId: successorId, cwd: workspace }],
    });
    await registerHolder(process.pid, predecessor.id, { entrypoint: "sdk-ts" });
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const { subscriptions, sent, list, rowsRead } = slowFirstRows(0, { rescanMs: 300 });
    expect((await list()).rows.map((row) => row.sessionId)).toEqual([successorId]);
    await subscriptions.subscribe(workspace);
    await new Promise((resolve) => setTimeout(resolve, 1800));
    expect(rowsRead.flat().filter((id) => id === predecessor.id)).toHaveLength(1);
    expect(sent).toEqual([]);
    subscriptions.dispose();
  });

  it("forgets a removal it sent once the transcript is deleted", async () => {
    const successorId = randomUUID();
    const predecessor = await writeTranscript({
      trailer: [{ type: "continued-in", continuedInSessionId: successorId }],
    });
    const stub = await writeTranscript({ sessionId: successorId });
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const { subscriptions, sent } = slowFirstRows(0, { minSessionIntervalMs: 0 });
    await subscriptions.subscribe(workspace);
    await settle();
    const subscription = () => [...(subscriptions as any).subscriptions.values()][0];
    await fs.appendFile(
      predecessor.file,
      JSON.stringify({ type: "continued-in", continuedInSessionId: successorId }) + "\n",
    );
    const shown = () =>
      sent.some(({ changes }) => changes.sessions.some((s) => s.sessionId === predecessor.id));
    expect(await waitFor(shown)).toBe(true);
    // Hidden by its successor: removed, and remembered as removed.
    await fs.appendFile(
      stub.file,
      JSON.stringify({ type: "user", parentUuid: null, sessionId: successorId, cwd: workspace }) +
        "\n",
    );
    expect(
      await waitFor(() => sent.some(({ changes }) => changes.removed.includes(predecessor.id))),
    ).toBe(true);
    expect(subscription().sent.get(predecessor.id)).toBeNull();
    await fs.rm(predecessor.file);
    expect(await waitFor(() => !subscription().sent.has(predecessor.id))).toBe(true);
    subscriptions.dispose();
  }, 15_000);

  it("forgets a hidden session created after subscribe once it is deleted", async () => {
    const { subscriptions, sent } = slowFirstRows(0);
    await subscriptions.subscribe(workspace);
    await settle();
    const watch = () => [...(subscriptions as any).watches.values()][0];
    const hidden = await writeTranscript({ sidechain: true });
    expect(await waitFor(() => watch().born.has(hidden.id))).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 400));
    await fs.rm(hidden.file);
    expect(await waitFor(() => !watch().born.has(hidden.id))).toBe(true);
    expect(sent).toEqual([]);
    subscriptions.dispose();
  });

  it("keeps a row whose transcript cannot be read for now, and reads it again", async () => {
    const session = await writeTranscript({});
    const { subscriptions, sent } = slowFirstRows(0, { rescanMs: 700 });
    await subscriptions.subscribe(workspace);
    await settle();
    await fs.appendFile(session.file, promptRecord(session.id, "Unreadable") + "\n");
    await fs.chmod(session.file, 0o000);
    try {
      await new Promise((resolve) => setTimeout(resolve, 1200));
      expect(sent.flatMap(({ changes }) => changes.removed)).toEqual([]);
    } finally {
      await fs.chmod(session.file, 0o644);
    }
    expect(await waitFor(() => sent.some(({ changes }) => changes.sessions.length > 0))).toBe(true);
    expect(sent.flatMap(({ changes }) => changes.removed)).toEqual([]);
    subscriptions.dispose();
  });

  it("does not read an archived session on a rescan", async () => {
    const session = await writeTranscript({});
    const { agent } = await indexAgent();
    await agent.archiveSession({ sessionId: session.id });
    // Past the events of the archive, which a new watch may still get.
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const { subscriptions, rowsRead } = slowFirstRows(0, { rescanMs: 300 });
    await subscriptions.subscribe(workspace);
    await new Promise((resolve) => setTimeout(resolve, 1800));
    // Several rescans since, and nothing changed.
    expect(rowsRead).toEqual([]);
    subscriptions.dispose();
  });

  it("keeps working after events that arrive while the first read runs", async () => {
    const session = await writeTranscript({});
    const { subscriptions, sent } = slowFirstRows(600);
    await subscriptions.subscribe(workspace);
    // Past the quiet period: the first read runs.
    await fs.appendFile(session.file, promptRecord(session.id, "During") + "\n");
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await waitFor(() => sent.length === 1)).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 1100));
    await fs.appendFile(session.file, promptRecord(session.id, "After") + "\n");
    expect(await waitFor(() => sent.length === 2)).toBe(true);
    subscriptions.dispose();
  });

  it("removes a session never sent when its transcript is deleted", async () => {
    const session = await writeTranscript({});
    const { subscriptions, sent } = slowFirstRows(400);
    await subscriptions.subscribe(workspace);
    await fs.rm(session.file);
    expect(await waitFor(() => sent.some(({ changes }) => changes.removed.length > 0))).toBe(true);
    expect(sent.flatMap(({ changes }) => changes.removed)).toEqual([session.id]);
    subscriptions.dispose();
  });

  it("holds a removal back for the interval of the session", async () => {
    const session = await writeTranscript({});
    const { subscriptions, sent } = slowFirstRows(0, { minSessionIntervalMs: 800 });
    await subscriptions.subscribe(workspace);
    await settle();
    await fs.appendFile(session.file, promptRecord(session.id, "Last") + "\n");
    expect(await waitFor(() => sent.length === 1)).toBe(true);
    await fs.rm(session.file);
    expect(await waitFor(() => sent.length === 2)).toBe(true);
    expect(sent[1]!.changes.removed).toEqual([session.id]);
    expect(sent[1]!.at - sent[0]!.at).toBeGreaterThanOrEqual(780);
    subscriptions.dispose();
  });

  it("hides a continued session once its successor has history", async () => {
    const successorId = randomUUID();
    const predecessor = await writeTranscript({
      trailer: [{ type: "continued-in", continuedInSessionId: successorId }],
    });
    const stub = await writeTranscript({ sessionId: successorId });
    const { changes, agent } = await subscribedAgent();
    // The client lists it.
    await agent.listSessions({ cwd: workspace });
    await fs.appendFile(
      stub.file,
      JSON.stringify({ type: "user", parentUuid: null, sessionId: successorId, cwd: workspace }) +
        "\n",
    );
    expect(await waitFor(() => changes().some((c) => c.removed.includes(predecessor.id)))).toBe(
      true,
    );
    // Nothing shows it after (its creation just before subscribe may have).
    const all = changes();
    const lastRemoved = all.findLastIndex((c) => c.removed.includes(predecessor.id));
    const lastShown = all.findLastIndex((c) =>
      c.sessions.some((row) => row.sessionId === predecessor.id),
    );
    expect(lastShown).toBeLessThan(lastRemoved);
    await agent.dispose();
  });

  it("is not started by session/list", async () => {
    await writeTranscript({});
    const { agent } = await indexAgent();
    await agent.listSessions({ cwd: workspace });
    expect(handlesOf(agent)).toBeUndefined();
  });

  it("sends a session that changed right after subscribe", async () => {
    const sessions: { id: string; file: string }[] = [];
    for (let i = 0; i < 20; i++) sessions.push(await writeTranscript({}));
    const { agent, notifications } = await indexAgent();
    await agent.subscribeSessionList({ cwd: workspace });
    // Right after subscribe returns.
    await fs.appendFile(sessions[7]!.file, promptRecord(sessions[7]!.id, "Meanwhile") + "\n");
    expect(
      await waitFor(() =>
        changesOf(notifications).some((c) =>
          c.sessions.some((s) => s.sessionId === sessions[7]!.id),
        ),
      ),
    ).toBe(true);
    await agent.dispose();
  });
});

describe("a session that another process holds", () => {
  it("is renamed, archived, unarchived and deleted, also when its query closed here", async () => {
    const session = await writeTranscript({});
    const { agent } = await indexAgent();
    // The stream ended, the husk stays mapped; another process resumed it.
    agent.sessions[session.id] = mockSessionState({ queryClosed: true }, agent, session.id) as any;
    await registerHolder(process.pid, session.id, { entrypoint: "cli", kind: "interactive" });

    await agent.renameSessionTitle({ sessionId: session.id, title: "Renamed" });
    expect(await lastRecords(session.file)).toEqual(titleRecords(session.id, "Renamed"));
    await agent.archiveSession({ sessionId: session.id });
    expect(await lastRecords(session.file)).toEqual(titleRecords(session.id, "[archived] Renamed"));
    await agent.unarchiveSession({ sessionId: session.id });
    expect(await lastRecords(session.file)).toEqual(titleRecords(session.id, "Renamed"));
    await agent.deleteSession({ sessionId: session.id });
    expect(fsSync.existsSync(session.file)).toBe(false);
  });

  it.skipIf(process.platform === "win32")(
    "is deleted without waiting for a CLI child of this process to exit",
    async () => {
      const session = await writeTranscript({});
      const { agent } = await indexAgent();
      const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], {
        stdio: "ignore",
      });
      try {
        await registerHolder(child.pid!, session.id, { entrypoint: "sdk-ts" });
        const started = Date.now();
        await agent.deleteSession({ sessionId: session.id });
        expect(Date.now() - started).toBeLessThan(2000);
        expect(fsSync.existsSync(session.file)).toBe(false);
      } finally {
        child.kill("SIGKILL");
      }
    },
  );
});

describe("session/delete of an AIR client without sessionIndex", () => {
  it("fails for an unknown session as the SDK delete did", async () => {
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
  });
});

describe("session index service lifecycle", () => {
  it("starts no watcher after dispose, also for a list in flight", async () => {
    await writeTranscript({});
    const service = new SessionIndexService({
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
  it("reports a copy it could not delete, and a retry deletes it", async () => {
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
    const actual = vi.mocked(deleteSession).getMockImplementation()!;
    vi.mocked(deleteSession)
      .mockImplementationOnce(actual)
      .mockImplementationOnce(async () => {
        throw new Error("EACCES: permission denied");
      });

    await expect(agent.deleteSession({ sessionId: first.id })).rejects.toThrow("EACCES");
    expect([first.file, second.file].filter((file) => fsSync.existsSync(file))).toHaveLength(1);
    expect(
      (await agent.listSessions({ _meta: listMeta({ archived: "archived" }) })).sessions.map(
        (s) => s.sessionId,
      ),
    ).toEqual([first.id]);

    await agent.deleteSession({ sessionId: first.id });
    expect([first.file, second.file].filter((file) => fsSync.existsSync(file))).toEqual([]);
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

  it("does not change a subscription on a live record of another long path", async () => {
    const mine = path.join(longBase(), "mine");
    const theirs = path.join(longBase(), "theirs");
    const own = await writeTranscript({ cwd: mine });
    const other = await writeTranscript({ cwd: theirs });
    await fs.mkdir(path.join(configDir, "sessions"), { recursive: true });
    const changes: ListChanges[] = [];
    const service = new SessionIndexService({
      notifyListChanges: async (change) => {
        changes.push(change);
      },
      logError: () => {},
    });
    await service.subscribeList(mine);
    await settle();
    await registerHolder(process.pid, other.id, liveCli("busy"));
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(changes).toEqual([]);
    await registerHolder(process.ppid, own.id, liveCli("busy"));
    expect(await waitFor(() => changes.length > 0)).toBe(true);
    expect(changes[0]!.sessions.map((s) => s.sessionId)).toEqual([own.id]);
    service.dispose();
  }, 15_000);
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

  it("never publishes a title read before a later client rename", async () => {
    const updates: any[] = [];
    const agent: any = {
      client: { sessionUpdate: async (update: unknown) => updates.push(update) },
      logger: { error: () => {} },
      sessions: {},
    };
    const titles = new SessionTitles(agent, "s1");
    const session: any = { queryClosed: false, cancelled: false, cwd: "/nowhere", query: {} };
    agent.sessions.s1 = session;
    await titles.setExplicitTitle("First", async () => "First");
    let resolveInfo!: (info: any) => void;
    vi.mocked(getSessionInfo).mockImplementationOnce(
      () => new Promise((resolve) => (resolveInfo = resolve)),
    );
    const turnEnd = titles.onTurnEnd(session);
    await titles.setExplicitTitle("Second", async () => "Second");
    resolveInfo({ customTitle: "First", summary: "First", lastModified: Date.now() });
    await turnEnd;
    expect(updates.map((update) => update.update.title)).toEqual(["First", "Second"]);
  });

  it("adopts a title stored later by someone else, and generates none", async () => {
    const updates: any[] = [];
    const agent: any = {
      client: { sessionUpdate: async (update: unknown) => updates.push(update) },
      logger: { error: () => {} },
      sessions: {},
    };
    const titles = new SessionTitles(agent, "s1");
    const generateSessionTitle = vi.fn(async () => "Generated");
    const session: any = {
      queryClosed: false,
      cancelled: false,
      cwd: "/nowhere",
      query: { generateSessionTitle },
    };
    agent.sessions.s1 = session;
    await titles.setExplicitTitle("Mine", async () => "Mine");
    vi.mocked(getSessionInfo).mockResolvedValueOnce({
      customTitle: "Mine",
      summary: "Mine",
      lastModified: Date.now(),
    } as any);
    await titles.onTurnEnd(session);
    vi.mocked(getSessionInfo).mockResolvedValueOnce({
      customTitle: "Renamed in the CLI",
      summary: "Renamed in the CLI",
      lastModified: Date.now(),
    } as any);
    await titles.onTurnEnd(session);
    // Renamed back to the title the client stored.
    vi.mocked(getSessionInfo).mockResolvedValueOnce({
      customTitle: "Mine",
      summary: "Mine",
      lastModified: Date.now(),
    } as any);
    await titles.onTurnEnd(session);
    vi.mocked(getSessionInfo).mockResolvedValueOnce({
      summary: "First prompt",
      lastModified: Date.now(),
    } as any);
    await titles.onTurnEnd(session);
    expect(updates.map((update) => update.update.title)).toEqual([
      "Mine",
      "Renamed in the CLI",
      "Mine",
    ]);
    expect(generateSessionTitle).not.toHaveBeenCalled();
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
    // The SDK removed the transcript, then failed to remove `<id>/`.
    vi.mocked(deleteSession).mockImplementationOnce(async () => {
      await fs.rm(session.file);
      throw Object.assign(new Error("EACCES: permission denied, rmdir"), { code: "EACCES" });
    });
    await expect(agent.deleteSession({ sessionId: session.id })).rejects.toThrow("EACCES");
    expect(fsSync.existsSync(sessionDir)).toBe(true);

    // The retry finds the session directory without a transcript.
    await agent.deleteSession({ sessionId: session.id });
    expect(fsSync.existsSync(sessionDir)).toBe(false);
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
  it("is published without the prefix to an AIR client only", async () => {
    for (const [request, expected] of [
      [air("sessionIndex"), "Done"],
      [air(), "Done"],
      [{}, "[archived] Done"],
    ] as const) {
      const { agent, updates } = createAgent();
      await initializeClient(agent, request);
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
    agent.sessions[session.id] = runningSession({ cwd: workspace }, agent, session.id);
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
    await agent.listSessions({ _meta: listMeta({ limit: 2 }) });
    const read = transcriptsRead(agent);
    expect(read).toBeLessThanOrEqual(16 + 64);
    await agent.listSessions({ _meta: listMeta({ limit: 2 }) });
    expect(transcriptsRead(agent)).toBe(read);
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
    expect((await scanTranscriptFile(file, size)).lastMessageAt).toBe(at);
  });

  it("does not search a transcript of the same size again", async () => {
    const id = randomUUID();
    const file = path.join(workspace, `${id}.jsonl`);
    const at = Date.parse("2026-07-01T00:00:00Z");
    const filler = JSON.stringify({ type: "progress", data: "q".repeat(5_000_000) });
    const first = `${big(id, at, 10)}\n${filler}\n`;
    const size = Buffer.byteLength(first);
    await fs.writeFile(file, first);
    expect((await scanTranscriptFile(file, size)).lastMessageAt).toBeUndefined();
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
    expect((await scanTranscriptFile(file, size)).lastMessageAt).toBeUndefined();
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

  it("titles a copy whose last line is torn after closing that line, as no process holds it", async () => {
    const { agent, other, own } = await runningWithCopy('{"type":"assistant","mess');
    const before = await fs.readFile(other.file, "utf8");
    await agent.renameSessionTitle({ sessionId: own.id, title: "Live" });
    expect(await fs.readFile(other.file, "utf8")).toBe(
      before +
        "\n" +
        titleRecords(own.id, "Live")
          .map((record) => JSON.stringify(record) + "\n")
          .join(""),
    );
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
    // Newer, so the list shows this copy, as the SDK list does.
    await writeTranscript({
      sessionId: id,
      cwd: path.join(workspace, "b"),
      mtimeMs: Date.parse("2026-01-02T00:00:00Z"),
      trailer: [{ type: "custom-title", customTitle: "Listed copy", sessionId: id }],
    });
    const { agent } = await indexAgent();
    const page = await agent.listSessions({});
    expect(page.sessions.map((s) => s.title)).toEqual(["Listed copy"]);
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
  it("tears it down and deletes it, also when another process holds it", async () => {
    const session = await writeTranscript({});
    const { agent } = await indexAgent();
    agent.sessions[session.id] = mockSessionState(
      { input: { end: () => {} }, query: { close: () => {}, interrupt: async () => {} } },
      agent,
      session.id,
    ) as any;
    // Another CLI resumed the session meanwhile.
    await registerHolder(process.pid, session.id);
    await agent.deleteSession({ sessionId: session.id });
    expect(agent.sessions[session.id]).toBeUndefined();
    expect(fsSync.existsSync(session.file)).toBe(false);
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
  it("do not match: a session id matches exactly", async () => {
    const session = await writeTranscript({});
    const upper = session.id.toUpperCase();
    const { agent } = await indexAgent();
    const rename = vi.fn(async () => {});
    agent.sessions[session.id] = mockSessionState(
      { cwd: workspace, query: { renameSession: rename } },
      agent,
      session.id,
    ) as any;
    const before = await fs.readFile(session.file, "utf8");
    for (const request of [
      () => agent.renameSessionTitle({ sessionId: upper, title: "x" }),
      () => agent.archiveSession({ sessionId: upper }),
      () => agent.unarchiveSession({ sessionId: upper }),
      () => agent.deleteSession({ sessionId: upper }),
    ]) {
      await expect(request()).rejects.toMatchObject({ code: -32002 });
    }
    expect(rename).not.toHaveBeenCalled();
    expect(agent.sessions[session.id]).toBeDefined();
    expect(await fs.readFile(session.file, "utf8")).toBe(before);
  });
});

describe("rename of a session that runs here and in another process", () => {
  it("is renamed through the CLI that runs it here", async () => {
    const session = await writeTranscript({});
    const { agent } = await indexAgent();
    const rename = vi.fn(async () => {});
    agent.sessions[session.id] = mockSessionState(
      { cwd: workspace, query: { renameSession: rename } },
      agent,
      session.id,
    ) as any;
    await registerHolder(process.pid, session.id);
    await agent.renameSessionTitle({ sessionId: session.id, title: "Mine" });
    expect(rename).toHaveBeenCalledWith("Mine", session.id);
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
  it("stops a session loaded here: interrupts it, retitles it through its CLI, then closes it", async () => {
    const session = await writeTranscript({});
    const { agent, updates } = await indexAgent();
    const close = vi.fn();
    const interrupt = vi.fn(async () => {});
    const rename = cliRename(session.file, session.id);
    const loaded = mockSessionState(
      {
        cwd: workspace,
        query: { close, interrupt, renameSession: rename },
        input: { end: vi.fn() },
      },
      agent,
      session.id,
    ) as any;
    agent.sessions[session.id] = loaded;
    const before = await fs.readFile(session.file, "utf8");

    await agent.archiveSession({ sessionId: session.id });

    const archivedMeta = (archived: boolean) => ({
      sessionId: session.id,
      update: {
        sessionUpdate: "session_info_update",
        _meta: { jetbrains: { air: { version: 1, archived } } },
      },
    });
    expect(updates).toEqual([archivedMeta(true)]);
    // Interrupted, retitled while its CLI ran, then closed as session/close
    // (whose cancel interrupts again).
    expect(interrupt).toHaveBeenCalled();
    expect(rename.mock.calls).toEqual([["[archived] Fix it", session.id]]);
    expect(close).toHaveBeenCalledTimes(1);
    expect(interrupt.mock.invocationCallOrder[0]).toBeLessThan(rename.mock.invocationCallOrder[0]!);
    expect(rename.mock.invocationCallOrder[0]).toBeLessThan(close.mock.invocationCallOrder[0]!);
    expect(loaded.queryClosed).toBe(true);
    expect(agent.sessions[session.id]).toBeUndefined();
    // A prompt fails as for a closed session.
    await expect(
      agent.prompt({ sessionId: session.id, prompt: [{ type: "text", text: "go on" }] }),
    ).rejects.toThrow("Session not found");

    // Unarchive does not reopen it, and reports nothing to the closed session.
    await agent.unarchiveSession({ sessionId: session.id });
    expect(agent.sessions[session.id]).toBeUndefined();
    expect(updates).toEqual([archivedMeta(true)]);
    expect(rename).toHaveBeenCalledTimes(1);
    // The CLI wrote the archive title; the adapter wrote the unarchive one.
    expect(await fs.readFile(session.file, "utf8")).toBe(
      before +
        [
          JSON.stringify({
            type: "custom-title",
            customTitle: "[archived] Fix it",
            sessionId: session.id,
          }),
          ...titleRecords(session.id, "Fix it").map((record) => JSON.stringify(record)),
        ].join("\n") +
        "\n",
    );
  });

  it("is reported to a loaded session on unarchive, which keeps running", async () => {
    const session = await writeTranscript({
      trailer: titleRecords("ignored", "[archived] Fix it").map((record) => ({
        ...record,
        sessionId: "",
      })),
    });
    const { agent, updates } = await indexAgent();
    const close = vi.fn();
    const interrupt = vi.fn(async () => {});
    const rename = cliRename(session.file, session.id);
    const loaded = mockSessionState(
      { cwd: workspace, query: { close, interrupt, renameSession: rename } },
      agent,
      session.id,
    ) as any;
    agent.sessions[session.id] = loaded;

    await agent.unarchiveSession({ sessionId: session.id });

    expect(updates).toEqual([
      {
        sessionId: session.id,
        update: {
          sessionUpdate: "session_info_update",
          _meta: { jetbrains: { air: { version: 1, archived: false } } },
        },
      },
    ]);
    expect(rename.mock.calls).toEqual([["Fix it", session.id]]);
    expect(agent.sessions[session.id]).toBe(loaded);
    expect(loaded.queryClosed).toBeFalsy();
    expect(close).not.toHaveBeenCalled();
    expect(interrupt).not.toHaveBeenCalled();
  });

  it("archives and unarchives a running session whose transcript has an agent name", async () => {
    const session = await writeTranscript({
      trailer: [
        ...titleRecords("ignored", "[archived] Fix it"),
        ...titleRecords("ignored", "Fix it"),
      ].map((record) => ({ ...record, sessionId: "" })),
    });
    const { agent } = await indexAgent();
    const listed = async () =>
      (
        await agent.listSessions({ cwd: workspace, _meta: listMeta({ archived: "all" }) })
      ).sessions.map((row) => [row.title, (row._meta as any).jetbrains.air.archived]);
    const load = () => {
      agent.sessions[session.id] = runningSession(
        { cwd: workspace, query: { renameSession: cliRename(session.file, session.id) } },
        agent,
        session.id,
      );
    };

    // Loading an archived session does not unarchive it: unarchive it live.
    await agent.archiveSession({ sessionId: session.id });
    expect(await listed()).toEqual([["Fix it", true]]);
    load();
    await agent.unarchiveSession({ sessionId: session.id });
    expect(await listed()).toEqual([["Fix it", false]]);

    // Archive it live: the CLI writes only the custom title.
    await agent.archiveSession({ sessionId: session.id });
    expect(agent.sessions[session.id]).toBeUndefined();
    expect(await listed()).toEqual([["Fix it", true]]);
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

  it("is unknown for an archived session whose transcript is gone", async () => {
    const session = await writeTranscript({});
    const { agent } = await indexAgent();
    await agent.archiveSession({ sessionId: session.id });
    // The CLI cleanup removed the transcript.
    await fs.rm(session.file);
    await expect(agent.archiveSession({ sessionId: session.id })).rejects.toMatchObject({
      code: -32002,
    });
    await expect(agent.unarchiveSession({ sessionId: session.id })).rejects.toMatchObject({
      code: -32002,
    });
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
});

describe("load and resume of a session that another process holds", () => {
  const stubOpen = (agent: ClaudeAcpAgent) => {
    const opened = vi.fn(async () => ({ sessionId: "x" }) as any);
    (agent as any).getOrCreateSession = opened;
    (agent as any).createSessionWhileReplaying = opened;
    return opened;
  };

  it("opens it for a sessionIndex client, as the CLI does", async () => {
    const session = await writeTranscript({});
    await registerHolder(process.pid, session.id);
    const { agent } = await indexAgent();
    const opened = stubOpen(agent);
    await agent.loadSession({ sessionId: session.id, cwd: workspace, mcpServers: [] });
    await agent.resumeSession({ sessionId: session.id, cwd: workspace, mcpServers: [] });
    expect(opened).toHaveBeenCalledTimes(2);
  });

  it("loads and prompts it for a sessionIndex client", async () => {
    const session = await writeTranscript({});
    await registerHolder(process.pid, session.id);
    const { agent } = await indexAgent();
    (agent as any).sendAvailableCommandsUpdate = vi.fn(async () => {});
    const input = new Pushable<any>();
    async function* turn() {
      const { value: user } = await input[Symbol.asyncIterator]().next();
      yield { ...userEcho(user), session_id: session.id };
      yield successfulResultMessage({ session_id: session.id });
      yield { type: "system", subtype: "session_state_changed", state: "idle" };
    }
    (agent as any).createSessionWhileReplaying = vi.fn(async () => {
      agent.sessions[session.id] = mockSessionState(
        { cwd: workspace, query: wrapQuery(turn()), input },
        agent,
        session.id,
      );
      return { sessionId: session.id };
    });

    await agent.loadSession({ sessionId: session.id, cwd: workspace, mcpServers: [] });
    const response = await agent.prompt({
      sessionId: session.id,
      prompt: [{ type: "text", text: "go on" }],
    });
    expect(response.stopReason).toBe("end_turn");
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
  const changesFor = (
    notifications: { method: string; params: Record<string, unknown> }[],
    subscriptionId: string,
  ) =>
    notifications
      .map((n) => n.params as unknown as ListChanges)
      .filter((change) => change.subscriptionId === subscriptionId);

  it("are listed and subscribed apart while both exist, as the SDK lists them", async () => {
    const dotted = path.join(workspace, "app.v2");
    const dashed = path.join(workspace, "app-v2");
    await fs.mkdir(dotted);
    await fs.mkdir(dashed);
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
      expect((await listSessions({ dir: cwd })).map((s) => s.sessionId)).toEqual([id]);
    }

    // A change of the dotted path's session is no change of the dashed list.
    const { subscriptionId } = await agent.subscribeSessionList({ cwd: dashed });
    await settle();
    const named = () =>
      changesFor(notifications, subscriptionId).flatMap((c) => [
        ...c.sessions.map((s) => s.sessionId),
        ...c.removed,
      ]);
    await fs.appendFile(mine.file, promptRecord(mine.id, "Mine") + "\n");
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(named()).not.toContain(mine.id);
    const promptAt = Date.now() - 1000;
    await fs.appendFile(theirs.file, promptRecord(theirs.id, "Theirs", promptAt) + "\n");
    const sent = () =>
      changesFor(notifications, subscriptionId).flatMap((c) =>
        c.sessions.filter((s) => airRow(s).lastPromptAt === new Date(promptAt).toISOString()),
      );
    expect(await waitFor(() => sent().length > 0)).toBe(true);
    expect(sent().map((s) => s.sessionId)).toEqual([theirs.id]);
    expect(named()).not.toContain(mine.id);
    await agent.dispose();
  }, 10_000);

  it("are listed together once the other path is gone, as the SDK lists them", async () => {
    const dotted = path.join(workspace, "app.v2");
    const dashed = path.join(workspace, "app-v2");
    await fs.mkdir(dashed);
    // `app.v2` does not exist (any more).
    const gone = await writeTranscript({
      cwd: dotted,
      lastMessageAt: Date.parse("2026-01-02T00:00:00Z"),
    });
    const here = await writeTranscript({ cwd: dashed });
    const { agent } = await indexAgent();
    const sdk = await listSessions({ dir: dashed });
    expect(sdk.map((s) => s.sessionId)).toEqual([gone.id, here.id]);
    const page = await agent.listSessions({ cwd: dashed });
    expect(page.sessions.map((s) => [s.sessionId, s.cwd])).toEqual([
      [gone.id, dotted],
      [here.id, dashed],
    ]);
    // Once it exists again, it is another path's session.
    await fs.mkdir(dotted);
    expect((await agent.listSessions({ cwd: dashed })).sessions.map((s) => s.sessionId)).toEqual([
      here.id,
    ]);
    expect((await listSessions({ dir: dashed })).map((s) => s.sessionId)).toEqual([here.id]);
  });

  it("move a session from one path's subscription to the other's", async () => {
    const dotted = path.join(workspace, "app.v2");
    const dashed = path.join(workspace, "app-v2");
    await fs.mkdir(dotted);
    await fs.mkdir(dashed);
    const mine = await writeTranscript({ cwd: dotted });
    await writeTranscript({ cwd: dashed });
    const { agent, notifications } = await indexAgent();
    const fromDotted = await agent.subscribeSessionList({ cwd: dotted });
    const fromDashed = await agent.subscribeSessionList({ cwd: dashed });
    await settle();

    await fs.appendFile(
      mine.file,
      JSON.stringify({ type: "relocated", sessionId: mine.id, relocatedCwd: dashed }) + "\n",
    );
    const added = () =>
      changesFor(notifications, fromDashed.subscriptionId)
        .flatMap((c) => c.sessions)
        .filter((s) => s.sessionId === mine.id);
    const removed = () =>
      changesFor(notifications, fromDotted.subscriptionId).flatMap((c) => c.removed);
    expect(await waitFor(() => added().length > 0 && removed().length > 0)).toBe(true);
    expect(added().map((s) => [s.sessionId, s.cwd])).toEqual([[mine.id, dashed]]);
    // It may also name the other path's session, never listed here.
    expect(removed()).toContain(mine.id);
    await agent.dispose();
  });
});

describe("a relocation out of the project directory", () => {
  it("keeps the session in a subscription, as the list keeps showing it", async () => {
    const session = await writeTranscript({});
    const changes: ListChanges[] = [];
    const service = new SessionIndexService({
      notifyListChanges: async (change) => {
        changes.push(change);
      },
      logError: () => {},
    });
    await service.subscribeList(workspace);
    await settle();
    await fs.appendFile(
      session.file,
      JSON.stringify({ type: "relocated", sessionId: session.id, relocatedCwd: "/elsewhere" }) +
        "\n",
    );
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(changes.flatMap((change) => change.removed)).toEqual([]);
    const rows = await service.index.list({
      cwd: workspace,
      limit: 10,
      archived: "unarchived",
    });
    expect(rows.rows).toHaveLength(1);
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
  it("opens it for a sessionIndex client", async () => {
    const session = await writeTranscript({});
    const { agent } = await indexAgent();
    agent.sessions[session.id] = mockSessionState({}, agent, session.id) as any;
    await registerHolder(process.pid, session.id);
    (agent as any).getOrCreateSession = vi.fn(async () => ({ sessionId: session.id }));
    (agent as any).replaySessionHistory = vi.fn(async () => {});
    (agent as any).sendAvailableCommandsUpdate = vi.fn(async () => {});
    await agent.resumeSession({ sessionId: session.id, cwd: workspace, mcpServers: [] });
    await agent.loadSession({ sessionId: session.id, cwd: workspace, mcpServers: [] });
    expect((agent as any).getOrCreateSession).toHaveBeenCalledTimes(2);
  });
});

describe("archive of a loaded session without its transcript", () => {
  it("is unknown once the session had history, and allowed for a new unwritten one", async () => {
    const { agent, updates } = await indexAgent();
    const query = { renameSession: async () => {} };
    const stale = randomUUID();
    agent.sessions[stale] = mockSessionState({ queryClosed: true }, agent, stale) as any;
    const finished = randomUUID();
    agent.sessions[finished] = runningSession(
      { lastTurnEndedAt: Date.now(), query },
      agent,
      finished,
    );
    const resumed = randomUUID();
    agent.sessions[resumed] = runningSession({ resumedFromHistory: true, query }, agent, resumed);
    for (const sessionId of [stale, finished, resumed]) {
      await expect(agent.archiveSession({ sessionId })).rejects.toMatchObject({ code: -32002 });
      await expect(agent.unarchiveSession({ sessionId })).rejects.toMatchObject({ code: -32002 });
    }
    expect(updates).toEqual([]);
    // A failed archive does not close the session.
    expect(agent.sessions[finished]).toBeDefined();

    // The CLI holds the title until it writes the transcript.
    const fresh = randomUUID();
    const rename = vi.fn(async () => {});
    agent.sessions[fresh] = runningSession({ query: { renameSession: rename } }, agent, fresh);
    await agent.archiveSession({ sessionId: fresh });
    const name = `Session ${fresh.slice(0, 8)}`;
    expect(rename.mock.calls).toEqual([[`[archived] ${name}`, fresh]]);
    expect(updates).toHaveLength(1);
    // The archive closed it: without its CLI, it needs a transcript.
    expect(agent.sessions[fresh]).toBeUndefined();
    await expect(agent.archiveSession({ sessionId: fresh })).rejects.toMatchObject({
      code: -32002,
    });
  });
});

describe("a session relocated to a path with the same project directory", () => {
  it("is listed under the cwd it was moved to", async () => {
    const from = path.join(workspace, "app.v2");
    const to = path.join(workspace, "app-v2");
    await fs.mkdir(from);
    await fs.mkdir(to);
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
    expect(transcriptsRead(agent)).toBeLessThanOrEqual(120);
  });

  it("reads only the changed transcript for a subscription", async () => {
    const sessions: { id: string; file: string }[] = [];
    for (let i = 0; i < 30; i++) sessions.push(await writeTranscript({}));
    const changes: ListChanges[] = [];
    const service = new SessionIndexService({
      notifyListChanges: async (change) => {
        changes.push(change);
      },
      logError: () => {},
    });
    await service.subscribeList(workspace);
    await settle();
    const read = service.index.transcriptsRead;
    await fs.appendFile(sessions[3]!.file, promptRecord(sessions[3]!.id, "Next") + "\n");
    expect(await waitFor(() => changes.length > 0)).toBe(true);
    // At most the changed one.
    expect(service.index.transcriptsRead - read).toBeLessThanOrEqual(1);
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
    const grown = await scanTranscriptFile(file, size + Buffer.byteLength(result(100)), undefined, {
      size,
      promptSearched: true,
      model: "claude-model-x",
      lastTurnEndedAt: at,
    });
    expect(grown.model).toBe("claude-model-x");
    expect(grown.lastTurnEndedAt).toBe(at);
  });

  it("keeps an inherited turn end when a small append needs a wider tail", async () => {
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
    const grown = await scanTranscriptFile(file, Buffer.byteLength(before + appended), undefined, {
      size: Buffer.byteLength(before),
      lastPromptAt: at,
      promptSearched: true,
      lastTurnEndedAt: at + 1000,
    });
    expect(grown.lastMessageAt).toBeDefined();
    expect(grown.lastTurnEndedAt).toBe(at + 1000);
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
    expect((await scanTranscriptFile(file, size, undefined, undefined, 1)).lastPromptAt).toBe(
      undefined,
    );
    const head =
      record("user", at, "Start") + output.repeat(3) + record("user", at + 1000, "Hidden");
    const last = record("assistant", at + 2000, "");
    const pad = size - Buffer.byteLength(head + output + last);
    const replacement = head + output + record("assistant", at + 2000, "z".repeat(pad));
    expect(Buffer.byteLength(replacement)).toBe(size);
    await fs.writeFile(file, replacement);
    expect((await scanTranscriptFile(file, size, undefined, undefined, 2)).lastPromptAt).toBe(
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
    const first = await scanTranscriptFile(file, size);
    expect(first.lastPromptAt).toBeUndefined();
    expect(first.promptSearched).toBe(true);

    // A prompt 1 MB back and a small append: the earlier full search stands,
    // so the 1 MB is not read (the prompt stays unseen).
    const replaced = record("user", at, "Hidden") + output + record("assistant", at, "z");
    await fs.writeFile(file, replaced);
    size = Buffer.byteLength(replaced);
    // The appended bytes (the last record) are inside the tail window.
    const grown = await scanTranscriptFile(file, size, undefined, {
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
    const session = await writeTranscript({
      trailer: titleRecords("", "[archived] Fix it"),
    });
    const { agent, updates } = await indexAgent();
    const rename = cliRename(session.file, session.id);
    agent.sessions[session.id] = runningSession(
      { cwd: workspace, query: { renameSession: rename } },
      agent,
      session.id,
    );
    await agent.renameSessionTitle({ sessionId: session.id, title: "[archived] New" });
    expect(rename.mock.calls).toEqual([["[archived] New", session.id]]);
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

  it("ranks an agent name in the head above a later custom title, as AIR does", async () => {
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
    // The agent name of the head decides, not the custom title of the tail.
    expect(row!.title).toBe("Done");
    expect((row!._meta as any).jetbrains.air.archived).toBe(true);
    // Unarchive writes both records, so the two names agree again.
    await agent.unarchiveSession({ sessionId: session.id });
    expect(await lastRecords(session.file)).toEqual(titleRecords(session.id, "Done"));
    const [after] = (
      await agent.listSessions({ cwd: workspace, _meta: listMeta({ archived: "all" }) })
    ).sessions;
    expect(after!.title).toBe("Done");
    expect((after!._meta as any).jetbrains.air.archived).toBe(false);
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

describe("archive in AIR's title format, round two", () => {
  it("never leaves a twice-prefixed title archived by a rename or an unarchive", async () => {
    const session = await writeTranscript({
      trailer: titleRecords("", "[archived] [archived] Twice"),
    });
    const { agent } = await indexAgent();
    await agent.unarchiveSession({ sessionId: session.id });
    expect(await lastRecords(session.file)).toEqual(titleRecords(session.id, "Twice"));
    await agent.renameSessionTitle({ sessionId: session.id, title: "[archived] [archived] X" });
    expect(await lastRecords(session.file)).toEqual(titleRecords(session.id, "X"));
  });

  it("publishes the title an archived rename stored", async () => {
    const session = await writeTranscript({
      trailer: titleRecords("", "[archived] Fix it"),
    });
    const { agent, updates } = await indexAgent();
    agent.sessions[session.id] = runningSession(
      { cwd: workspace, query: { renameSession: cliRename(session.file, session.id) } },
      agent,
      session.id,
    );
    await agent.renameSessionTitle({ sessionId: session.id, title: "x".repeat(200) });
    expect(updates.at(-1)).toEqual({
      sessionId: session.id,
      update: { sessionUpdate: "session_info_update", title: "x".repeat(189) },
    });
  });
  it("reads the title of a running session from its transcript once the CLI changed it", async () => {
    const session = await writeTranscript({});
    const { agent } = await indexAgent();
    const rename = vi.fn(async (title: string) => {
      // The CLI writes the custom title before it answers.
      await fs.appendFile(
        session.file,
        JSON.stringify({ type: "custom-title", customTitle: title, sessionId: session.id }) + "\n",
      );
    });
    agent.sessions[session.id] = runningSession(
      { cwd: workspace, query: { renameSession: rename } },
      agent,
      session.id,
    );
    await agent.renameSessionTitle({ sessionId: session.id, title: "First" });
    // A `/rename` in the session, which the adapter does not see.
    await fs.appendFile(
      session.file,
      titleRecords(session.id, "Renamed in the CLI")
        .map((record) => JSON.stringify(record) + "\n")
        .join(""),
    );
    await agent.archiveSession({ sessionId: session.id });
    expect(rename.mock.calls.map(([title]) => title)).toEqual([
      "First",
      "[archived] Renamed in the CLI",
    ]);
  });
  it("unarchives a resumed session that AIR archived through its CLI", async () => {
    const session = await writeTranscript({ trailer: titleRecords("", "[archived] Done") });
    const { agent } = await indexAgent();
    const rename = vi.fn(async () => {});
    agent.sessions[session.id] = mockSessionState(
      { cwd: workspace, resumedFromHistory: true, query: { renameSession: rename } },
      agent,
      session.id,
    ) as any;
    await agent.unarchiveSession({ sessionId: session.id });
    expect(rename.mock.calls).toEqual([["Done", session.id]]);
  });

  it("keeps the title open to generation across overlapping changes that store nothing", async () => {
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
    let release!: () => void;
    const first = titles.setExplicitTitle(
      undefined,
      () => new Promise<undefined>((resolve) => (release = () => resolve(undefined))),
    );
    const second = titles.setExplicitTitle(undefined, async () => undefined);
    await new Promise((resolve) => setTimeout(resolve, 5));
    release();
    await Promise.all([first, second]);
    vi.mocked(getSessionInfo).mockResolvedValueOnce(undefined);
    await titles.onTurnEnd(session);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(updates.map((update) => update.update.title)).toEqual(["Generated"]);
  });
});

describe("archive in AIR's title format, round three", () => {
  it("titles the copy of the unresolved cwd of a running session here", async () => {
    const real = path.join(workspace, "real");
    const link = path.join(workspace, "link");
    await fs.mkdir(real);
    await fs.symlink(real, link);
    const cliCopy = await writeTranscript({ cwd: real });
    const linkCopy = await writeTranscript({ sessionId: cliCopy.id, cwd: link });
    const { agent } = await indexAgent();
    const rename = cliRename(cliCopy.file, cliCopy.id);
    agent.sessions[cliCopy.id] = runningSession(
      { cwd: link, query: { renameSession: rename } },
      agent,
      cliCopy.id,
    );
    await agent.archiveSession({ sessionId: cliCopy.id });
    expect(rename.mock.calls).toEqual([["[archived] Fix it", cliCopy.id]]);
    expect(await lastRecords(linkCopy.file)).toEqual(titleRecords(cliCopy.id, "[archived] Fix it"));
  });

  it("keeps updatedAt of a session whose last message outgrows the tail search", async () => {
    const at = Date.parse("2026-03-01T00:00:00Z");
    const session = await writeTranscript({ lastMessageAt: at, mtimeMs: at + 60_000 });
    const huge = {
      type: "assistant",
      sessionId: session.id,
      message: {
        role: "assistant",
        content: [{ type: "text", text: "y".repeat(5 * 1024 * 1024) }],
      },
      timestamp: new Date(at + 1000).toISOString(),
    };
    await fs.appendFile(session.file, JSON.stringify(huge) + "\n");
    await fs.utimes(session.file, (at + 60_000) / 1000, (at + 60_000) / 1000);
    const { agent } = await indexAgent();
    const [before] = (await agent.listSessions({ cwd: workspace })).sessions;
    expect(before!.updatedAt).toBe(new Date(at + 1000).toISOString());
    await agent.archiveSession({ sessionId: session.id });
    const [after] = (
      await agent.listSessions({ cwd: workspace, _meta: listMeta({ archived: "archived" }) })
    ).sessions;
    expect(after!.updatedAt).toBe(before!.updatedAt);
  });
});

describe("archive of a long session", () => {
  it("keeps a last prompt that only an earlier scan could see", async () => {
    const at = Date.parse("2026-03-01T00:00:00Z");
    const session = await writeTranscript({ lastMessageAt: at });
    const record = (i: number, size: number) =>
      JSON.stringify({
        type: "assistant",
        sessionId: session.id,
        message: {
          role: "assistant",
          content: [{ type: "text", text: "z".repeat(size) }],
          stop_reason: "end_turn",
        },
        timestamp: new Date(at + 1000 + i).toISOString(),
      }) + "\n";
    // Grows past the 4 MB search in steps the tail window covers, listed in
    // between, so the prompt is known from the earlier scans only.
    await fs.appendFile(session.file, record(0, 4 * 1024 * 1024 - 100 * 1024));
    const { agent } = await indexAgent();
    const list = async (archived = "all") =>
      (await agent.listSessions({ cwd: workspace, _meta: listMeta({ archived }) })).sessions[0]!;
    const lastPromptAt = (row: any) => row._meta.jetbrains.air.lastPromptAt;
    expect(lastPromptAt(await list())).toBe(new Date(at - 1000).toISOString());
    for (let i = 1; i <= 6; i++) {
      await fs.appendFile(session.file, record(i, 30 * 1024));
      expect(lastPromptAt(await list())).toBe(new Date(at - 1000).toISOString());
    }
    await agent.archiveSession({ sessionId: session.id });
    expect(lastPromptAt(await list("archived"))).toBe(new Date(at - 1000).toISOString());
  });
});

describe("list subscriptions after this connection's own title changes", () => {
  it("push a rename, archive, unarchive and delete at once, without the watcher", async () => {
    const session = await writeTranscript({ prompt: "Old title" });
    const changes: ListChanges[] = [];
    const service = new SessionIndexService({
      notifyListChanges: async (change) => {
        changes.push(change);
      },
      // The watcher's events and rescans would come only after the test.
      listSubscriptionTiming: {
        debounceMs: 60_000,
        maxWaitMs: 60_000,
        rescanMs: 60_000,
        minSessionIntervalMs: 0,
      },
      logError: () => {},
    });
    await service.subscribeList(workspace);
    // Past the rescan that follows the opening of the watchers.
    await new Promise((resolve) => setTimeout(resolve, 1300));
    changes.length = 0;
    const last = () =>
      changes.flatMap((change) => change.sessions.filter((s) => s.sessionId === session.id)).at(-1);
    const soon = (check: () => boolean) => waitFor(check, 500);

    await service.retitle(session.id, renameTo("New title"), { sidecar: "always" });
    expect(await soon(() => last()?.title === "New title")).toBe(true);
    await service.retitle(session.id, archiveTo(true), { sidecar: "existing" });
    expect(await soon(() => airRow(last()!).archived === true)).toBe(true);
    await service.retitle(session.id, archiveTo(false), { sidecar: "existing" });
    expect(await soon(() => airRow(last()!).archived === false)).toBe(true);
    expect(last()!.title).toBe("New title");
    // A rename to the title it has changes nothing, and sends nothing.
    const sent = changes.length;
    await service.retitle(session.id, renameTo("New title"), { sidecar: "always" });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(changes).toHaveLength(sent);

    await service.delete(session.id, false);
    expect(await soon(() => changes.some((change) => change.removed.includes(session.id)))).toBe(
      true,
    );
    service.dispose();
  });

  it("push a rename made by another process through the watcher", async () => {
    const session = await writeTranscript({ prompt: "Old title" });
    const changes: ListChanges[] = [];
    const service = new SessionIndexService({
      notifyListChanges: async (change) => {
        changes.push(change);
      },
      logError: () => {},
    });
    await service.subscribeList(workspace);
    await settle();
    await fs.appendFile(
      session.file,
      titleRecords(session.id, "Renamed elsewhere")
        .map((record) => JSON.stringify(record))
        .join("\n") + "\n",
    );
    await writeCustomTitleSidecar(session.file, "Renamed elsewhere");
    expect(
      await waitFor(() =>
        changes.some((change) =>
          change.sessions.some(
            (s) => s.sessionId === session.id && s.title === "Renamed elsewhere",
          ),
        ),
      ),
    ).toBe(true);
    service.dispose();
  });
});

describe("the pages of one list", () => {
  const base = Date.parse("2026-07-01T00:00:00Z");
  const projectDir = () => path.join(configDir, "projects", encodeProjectPath(workspace));

  /** Transcripts one minute apart, newest first, in directories that
   *  changed long enough ago for their listings to be kept. */
  async function project(count: number) {
    const sessions: { id: string; file: string }[] = [];
    for (let i = 0; i < count; i++) {
      sessions.push(await writeTranscript({ lastMessageAt: base - i * 60_000 }));
    }
    const past = (Date.now() - 60_000) / 1000;
    await fs.utimes(projectDir(), past, past);
    await fs.utimes(path.dirname(projectDir()), past, past);
    return sessions;
  }

  async function drain(
    agent: ClaudeAcpAgent,
    limit: number,
    between?: (page: number) => Promise<void>,
  ) {
    const pages: string[][] = [];
    let cursor: string | undefined;
    do {
      const page = await agent.listSessions({ cwd: workspace, cursor, _meta: listMeta({ limit }) });
      pages.push(page.sessions.map((s) => s.sessionId));
      cursor = page.nextCursor ?? undefined;
      if (cursor) await between?.(pages.length);
    } while (cursor);
    return pages;
  }

  const enumerations = (agent: ClaudeAcpAgent) =>
    vi.spyOn((agent as any).sessionIndex.service.index, "enumerate");

  it("enumerates the transcripts once for all its pages", async () => {
    const sessions = await project(45);
    const { agent } = await indexAgent();
    const enumerate = enumerations(agent);
    const pages = await drain(agent, 10);
    expect(pages.flat()).toEqual(sessions.map(({ id }) => id));
    expect(enumerate).toHaveBeenCalledTimes(1);
    // A new list enumerates again, and pages as before.
    expect(await drain(agent, 10)).toEqual(pages);
    expect(enumerate).toHaveBeenCalledTimes(2);
  });

  it("is as fresh after a cursor as a new enumeration", async () => {
    const sessions = await project(30);
    const { agent } = await indexAgent();
    const enumerate = enumerations(agent);
    const deleted = sessions[25]!;
    const prompted = sessions[22]!;
    const answered = sessions[28]!;
    const pages = await drain(agent, 10, async (page) => {
      if (page !== 1) return;
      // Neither adds nor removes a transcript: the enumeration is reused.
      await fs.truncate(deleted.file, 0);
      await fs.appendFile(prompted.file, promptRecord(prompted.id, "Again") + "\n");
      await fs.appendFile(answered.file, assistantRecord(answered.id, "end_turn") + "\n");
    });
    expect(enumerate).toHaveBeenCalledTimes(1);
    const listed = pages.flat();
    // Emptied: gone. Prompted: moved before the cursor, out of later pages.
    expect(listed).not.toContain(deleted.id);
    expect(listed).not.toContain(prompted.id);
    // Answered without a prompt: in its place, with its new turn end.
    expect(listed.indexOf(answered.id)).toBe(listed.indexOf(sessions[27]!.id) + 1);
    const fresh = await agent.listSessions({ cwd: workspace, _meta: listMeta({ limit: 50 }) });
    expect(fresh.sessions[0]!.sessionId).toBe(prompted.id);
    expect(fresh.sessions.map((s) => s.sessionId).filter((id) => id !== prompted.id)).toEqual(
      listed,
    );
  });

  it("reads every copy of a session that a later page reaches", async () => {
    const sessions = await project(30);
    // A session with a copy among the second page and an older one in
    // another project, which gets a new prompt after the first page.
    const id = randomUUID();
    await writeTranscript({ sessionId: id, lastMessageAt: base - 14.5 * 60_000 });
    const older = await writeTranscript({
      sessionId: id,
      cwd: path.join(workspace, "other"),
      lastMessageAt: base - 90 * 60_000,
    });
    const past = (Date.now() - 60_000) / 1000;
    await fs.utimes(projectDir(), past, past);
    await fs.utimes(path.dirname(older.file), past, past);
    await fs.utimes(path.dirname(projectDir()), past, past);
    const { agent } = await indexAgent();
    const enumerate = enumerations(agent);
    const pages: string[][] = [];
    let cursor: string | undefined;
    do {
      const page = await agent.listSessions({ cursor, _meta: listMeta({ limit: 10 }) });
      pages.push(page.sessions.map((s) => s.sessionId));
      cursor = page.nextCursor ?? undefined;
      if (pages.length === 1) {
        await fs.appendFile(older.file, promptRecord(id, "Resumed") + "\n");
      }
    } while (cursor);
    expect(enumerate).toHaveBeenCalledTimes(1);
    // Its newest copy now comes before the first page's cursor.
    expect(pages.flat()).toEqual(sessions.map((session) => session.id));
    const fresh = await agent.listSessions({ _meta: listMeta({ limit: 1 }) });
    expect(fresh.sessions.map((s) => [s.sessionId, s.cwd])).toEqual([
      [id, path.join(workspace, "other")],
    ]);
  });

  it("enumerates again once a transcript is added or removed", async () => {
    const sessions = await project(30);
    const { agent } = await indexAgent();
    const enumerate = enumerations(agent);
    let added: { id: string } | undefined;
    const pages = await drain(agent, 10, async (page) => {
      if (page === 1) {
        // An older session copied in: listed in its place.
        added = await writeTranscript({ lastMessageAt: base - 25.5 * 60_000 });
      } else if (page === 2) {
        await fs.rm(sessions[29]!.file);
      }
    });
    expect(enumerate).toHaveBeenCalledTimes(3);
    const listed = pages.flat();
    expect(listed.indexOf(added!.id)).toBe(listed.indexOf(sessions[25]!.id) + 1);
    expect(listed).not.toContain(sessions[29]!.id);
    expect(listed).toHaveLength(30);
  });
});

describe("titles by the SDK's rule", () => {
  it("finds a custom title whose record starts before the tail window", async () => {
    const id = randomUUID();
    // Past the head window.
    let filler = assistantRecord(id, null);
    while (filler.length < 70_000) filler += "\n" + assistantRecord(id, null);
    // The cut line of the last 64 KB, which the SDK still searches.
    const title = JSON.stringify({
      type: "custom-title",
      padding: "p".repeat(10_000),
      customTitle: "Across the boundary",
      sessionId: id,
    });
    // About 60 KB after it: the window starts within its padding.
    let tail = assistantRecord(id, null);
    while (tail.length < 60_000) tail += "\n" + assistantRecord(id, null);
    const session = await writeTranscript({
      sessionId: id,
      prompt: "First prompt",
      trailer: [],
    });
    await fs.appendFile(session.file, `${filler}\n${title}\n${tail}\n`);
    const bytes = await fs.readFile(session.file);
    const window = bytes.length - 64 * 1024;
    const start = bytes.indexOf(title);
    expect(start).toBeLessThan(window);
    expect(start + title.indexOf('"customTitle"')).toBeGreaterThan(window);
    expect(start).toBeGreaterThan(64 * 1024);
    const sdk = await vi
      .importActual<typeof import("@anthropic-ai/claude-agent-sdk")>(
        "@anthropic-ai/claude-agent-sdk",
      )
      .then((module) => module.getSessionInfo(id, { dir: workspace }));
    expect(sdk!.summary).toBe("Across the boundary");
    const { agent } = await indexAgent();
    const page = await agent.listSessions({ cwd: workspace });
    expect(page.sessions.map((s) => s.title)).toEqual(["Across the boundary"]);
  });
});
