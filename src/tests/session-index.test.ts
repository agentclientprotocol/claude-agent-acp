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
  getSessionInfo,
  listSessions,
  renameSession,
} from "@anthropic-ai/claude-agent-sdk";
import { spawn, type ChildProcess } from "node:child_process";
import { ClaudeAcpAgent, type AcpClient } from "../acp-agent.js";
import { encodeProjectPath } from "../session-index/project-dirs.js";
import { SessionIndexService, writeCustomTitleSidecar } from "../session-index/service.js";
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
    renameSession: vi.fn(actual.renameSession),
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
  gitBranch?: string;
  /** A first prompt of this many characters, to push the head past 64 KB. */
  hugePrompt?: number;
  trailer?: object[];
  /** The project directory name; defaults to the encoding of `cwd`. */
  dirName?: string;
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
    ...(options.gitBranch && { gitBranch: options.gitBranch }),
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

const airCapabilities = (response: { _meta?: Record<string, unknown> | null }) =>
  (response._meta as any)?.jetbrains?.air?.capabilities as string[] | undefined;

describe("sessionIndex negotiation", () => {
  const baseline = [
    "sessionFailure",
    "agentFileChangeReport",
    "nativeSubagentSessions",
    "asyncTasks",
    "recommendedValue",
    "diffPatch",
    "planFile",
  ];

  it("is advertised only to an AIR client that declares it", async () => {
    const declared = await createAgent().agent.initialize({
      protocolVersion: 1,
      clientCapabilities: air("sessionIndex"),
    });
    expect(airCapabilities(declared)).toEqual([...baseline, "sessionIndex"]);

    const undeclared = await createAgent().agent.initialize({
      protocolVersion: 1,
      clientCapabilities: air("diffPatch"),
    });
    expect(airCapabilities(undeclared)).toEqual(baseline);

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
    expect(airCapabilities(response)).not.toContain("sessionIndex");
  });

  it("answers method-not-found to the new methods without the capability", async () => {
    const { agent } = createAgent();
    await initializeClient(agent, air());
    const sessionId = randomUUID();
    await expect(agent.renameSessionTitle({ sessionId, title: "x" })).rejects.toMatchObject({
      code: -32601,
    });
    await expect(agent.archiveSession({ sessionId })).rejects.toMatchObject({ code: -32601 });
    await expect(agent.unarchiveSession({ sessionId })).rejects.toMatchObject({ code: -32601 });
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
        _meta: listMeta({ archived: "only" }),
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

  it("filters archived sessions and lists only them on request", async () => {
    const kept = await writeTranscript({ lastMessageAt: base });
    const archived = await writeTranscript({ lastMessageAt: base - 1000 });
    const { agent } = await indexAgent();
    await agent.archiveSession({ sessionId: archived.id });

    const active = await agent.listSessions({ cwd: workspace });
    expect(active.sessions.map((s) => s.sessionId)).toEqual([kept.id]);
    const only = await agent.listSessions({
      cwd: workspace,
      _meta: listMeta({ archived: "only" }),
    });
    expect(only.sessions.map((s) => s.sessionId)).toEqual([archived.id]);
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

  it("includes the sessions of existing linked worktrees, with their own cwd", async () => {
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

    for (const cwd of [repo, linked]) {
      const page = await agent.listSessions({ cwd });
      expect(page.sessions.map((s) => [s.sessionId, s.cwd])).toEqual([
        [main.id, repo],
        [inLinked.id, linked],
      ]);
    }
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

  it("reports branch, activity and cost in the row metadata", async () => {
    const session = await writeTranscript({
      lastMessageAt: base,
      gitBranch: "feature/x",
      costUsd: 1.25,
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
            gitBranch: "feature/x",
            activity: { state: "idle", lastTurnEndedAt: new Date(base).toISOString() },
            usage: { cost: { amount: 1.25, currency: "USD" } },
          },
        },
      },
    });
    expect((page.sessions[1]!._meta as any).jetbrains.air.usage).toBeUndefined();
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
    expect(meta.activity.state).toBe("running");
    expect(meta.usage.cost.amount).toBe(3);
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
});

describe("_session/rename", () => {
  it("renames a session that is not loaded: SDK title record and the sidecar", async () => {
    const session = await writeTranscript({});
    const { agent } = await indexAgent();
    await agent.renameSessionTitle({ sessionId: session.id, title: "New name" });

    expect(renameSession).toHaveBeenCalledWith(session.id, "New name");
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
    await expect(
      agent.renameSessionTitle({ sessionId: session.id, title: "x" }),
    ).rejects.toMatchObject({ code: -32600, data: { reason: "thread_active_writer" } });
    expect(renameSession).not.toHaveBeenCalled();
  });

  it("renames a session loaded here through its CLI and publishes the title", async () => {
    const session = await writeTranscript({});
    const { agent, updates } = await indexAgent();
    const rename = vi.fn(async () => {});
    agent.sessions[session.id] = mockSessionState(
      { query: { renameSession: rename } },
      agent,
      session.id,
    ) as any;
    await agent.renameSessionTitle({ sessionId: session.id, title: "Live title" });
    expect(rename).toHaveBeenCalledWith("Live title", session.id);
    expect(renameSession).not.toHaveBeenCalled();
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
  it("are idempotent and keep the transcript untouched", async () => {
    const session = await writeTranscript({});
    const before = await fs.stat(session.file);
    const { agent } = await indexAgent();
    const marker = path.join(configDir, "acp", "archived", session.id);

    await agent.archiveSession({ sessionId: session.id });
    await agent.archiveSession({ sessionId: session.id });
    expect(fsSync.existsSync(marker)).toBe(true);
    await agent.unarchiveSession({ sessionId: session.id });
    await agent.unarchiveSession({ sessionId: session.id });
    expect(fsSync.existsSync(marker)).toBe(false);
    expect((await fs.stat(session.file)).mtimeMs).toBe(before.mtimeMs);
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
    expect(fsSync.existsSync(path.join(configDir, "acp", "archived", session.id))).toBe(true);
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
    await expect(
      agent.renameSessionTitle({ sessionId: session.id, title: "x" }),
    ).rejects.toMatchObject({ data: { reason: "thread_active_writer" } });
    expect(renameSession).not.toHaveBeenCalled();
  });

  describe.skipIf(process.platform === "win32")("a CLI child of this process", () => {
    let child: ChildProcess | undefined;
    afterEach(() => {
      child?.kill("SIGKILL");
      child = undefined;
    });

    it("is no other writer while it exits after a close", async () => {
      const deleted = await writeTranscript({});
      const renamed = await writeTranscript({});
      child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" });
      const pid = child.pid!;
      // The CLI that this adapter just closed is still registered.
      await registerHolder(pid, deleted.id, { entrypoint: "sdk-ts" });
      const { agent } = await indexAgent();
      await agent.deleteSession({ sessionId: deleted.id });
      expect(fsSync.existsSync(deleted.file)).toBe(false);

      await registerHolder(pid, renamed.id, { entrypoint: "sdk-ts" });
      await agent.renameSessionTitle({ sessionId: renamed.id, title: "Renamed" });
      expect((await agent.listSessions({ cwd: workspace })).sessions[0]!.title).toBe("Renamed");
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
    const marker = path.join(configDir, "acp", "archived", first.id);
    const actual = vi.mocked(deleteSession).getMockImplementation()!;
    vi.mocked(deleteSession)
      .mockImplementationOnce(actual)
      .mockImplementationOnce(async () => {
        throw new Error("EACCES: permission denied");
      });

    await expect(agent.deleteSession({ sessionId: first.id })).rejects.toThrow("EACCES");
    expect([first.file, second.file].filter((file) => fsSync.existsSync(file))).toHaveLength(1);
    expect(fsSync.existsSync(marker)).toBe(true);

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
