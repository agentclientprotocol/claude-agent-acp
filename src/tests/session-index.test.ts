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
import { ClaudeAcpAgent, type AcpClient } from "../acp-agent.js";
import { encodeProjectPath } from "../session-index/project-dirs.js";
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
};

async function writeTranscript(options: TranscriptOptions): Promise<{ id: string; file: string }> {
  const id = options.sessionId ?? randomUUID();
  const cwd = options.cwd ?? workspace;
  const recordCwd = options.recordCwd === undefined ? cwd : options.recordCwd;
  const at = options.lastMessageAt ?? Date.parse("2026-01-01T00:00:00Z");
  const dir = path.join(configDir, "projects", encodeProjectPath(cwd));
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
      projectDirs: async () => [encodeProjectPath(workspace)],
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
