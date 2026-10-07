/**
 * The `sessionIndex` AIR extension: the session list, rename, archive and
 * delete of a client that declared the capability.
 *
 * Wire contract: docs/air-extensions.md, "Session index". Everything here is
 * reached only for a `sessionIndex` client, except the archive markers that an
 * AIR client without the capability gets in place of a delete (see
 * `ClaudeAcpAgent.deleteSession`).
 */

import { randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  RequestError,
  type ListSessionsRequest,
  type ListSessionsResponse,
  type SessionInfo,
} from "@agentclientprotocol/sdk";
import {
  deleteSession as sdkDeleteSession,
  getSessionInfo as sdkGetSessionInfo,
  renameSession as sdkRenameSession,
} from "@anthropic-ai/claude-agent-sdk";
import { airExtensionMeta, withAirMeta } from "../air-extension.js";
import { sanitizeTitle } from "../session-titles.js";
import { deriveActivity, selectCost, type OwnSessionState } from "./activity.js";
import {
  readArchivedSessionIds,
  removeArchiveMarker,
  writeArchiveMarker,
} from "./archive-markers.js";
import { LIST_CHANGED_METHOD, ListChangedWatcher } from "./list-changed.js";
import { LiveSessionRegistry } from "./live-registry.js";
import {
  canonicalPath,
  errorCode,
  isExactProjectDir,
  isSessionId,
  projectDirMatches,
  sameProjectPath,
} from "./project-dirs.js";
import { readHeadTail, transcriptProjectCwd } from "./transcript-scan.js";
import {
  DEFAULT_LIST_LIMIT,
  MAX_LIST_LIMIT,
  SessionIndex,
  type ArchivedFilter,
  type GetSessionInfo,
  type ListCursor,
} from "./session-index.js";

export { LIST_CHANGED_METHOD };
export const SESSION_RENAME_METHOD = "_session/rename";
export const SESSION_ARCHIVE_METHOD = "_session/archive";
export const SESSION_UNARCHIVE_METHOD = "_session/unarchive";

/** The JSON-RPC code of an unknown session (ACP `ResourceNotFound`). */
const RESOURCE_NOT_FOUND = -32002;
/** 3: boolean `archived` (ACP RFD #2161) and `includeWorktrees`. */
const CURSOR_VERSION = 3;

export type SessionIdRequest = { sessionId: string };
export type RenameSessionRequest = { sessionId: string; title: string };

function iso(ms: number | undefined): string | undefined {
  return ms === undefined || !Number.isFinite(ms) ? undefined : new Date(ms).toISOString();
}

export function sessionNotFound(sessionId: string): RequestError {
  return new RequestError(RESOURCE_NOT_FOUND, `Session not found: ${sessionId}`, { sessionId });
}

/** The error for a session that another live Claude Code process holds. The
 *  `reason` is the one AIR already recognizes from codex-acp. */
export function activeWriterError(sessionId: string): RequestError {
  return RequestError.invalidRequest(
    { reason: "thread_active_writer", sessionId },
    "This Claude session is open in another Claude Code process. Close it there, then try again.",
  );
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function parseSessionIdRequest(value: unknown): SessionIdRequest {
  const sessionId = asRecord(value).sessionId;
  if (typeof sessionId !== "string" || !sessionId.trim()) {
    throw RequestError.invalidParams(undefined, "params require a non-empty sessionId");
  }
  return { sessionId: sessionId.trim() };
}

export function parseRenameSessionRequest(value: unknown): RenameSessionRequest {
  const { sessionId } = parseSessionIdRequest(value);
  const raw = asRecord(value).title;
  const title = typeof raw === "string" ? sanitizeTitle(raw) : "";
  if (!title) throw RequestError.invalidParams(undefined, "title must be a non-empty string");
  return { sessionId, title };
}

type ListOptions = { limit: number; archived: ArchivedFilter; includeWorktrees: boolean };

/** What a cursor is bound to: the request values that select the rows. */
export type ListScope = { cwd: string | null; archived: boolean; includeWorktrees: boolean };

function optionalBoolean(list: Record<string, unknown>, key: string): boolean {
  // Omitted or null is false.
  const value = list[key] ?? false;
  if (typeof value !== "boolean") {
    throw RequestError.invalidParams(
      { [key]: value },
      `\`_meta.jetbrains.air.list.${key}\` must be a boolean`,
    );
  }
  return value;
}

/** `_meta.jetbrains.air.list` of a list request. */
export function parseListOptions(meta: unknown): ListOptions {
  const list = asRecord(airExtensionMeta(meta)?.list);
  const limit =
    typeof list.limit === "number" && Number.isFinite(list.limit)
      ? Math.min(MAX_LIST_LIMIT, Math.max(1, Math.floor(list.limit)))
      : DEFAULT_LIST_LIMIT;
  return {
    limit,
    archived: optionalBoolean(list, "archived"),
    includeWorktrees: optionalBoolean(list, "includeWorktrees"),
  };
}

type CursorPayload = {
  v: number;
  u: number;
  id: string;
  cwd: string | null;
  archived: boolean;
  worktrees: boolean;
};

export function encodeListCursor(cursor: ListCursor, scope: ListScope): string {
  const payload: CursorPayload = {
    v: CURSOR_VERSION,
    u: cursor.updatedAtMs,
    id: cursor.sessionId,
    cwd: scope.cwd,
    archived: scope.archived,
    worktrees: scope.includeWorktrees,
  };
  return Buffer.from(JSON.stringify(payload)).toString("base64url");
}

/** The position a cursor names. A cursor of another cwd or filter, or one
 *  this adapter did not issue, is rejected. */
export function decodeListCursor(cursor: string, scope: ListScope): ListCursor {
  let payload: Partial<CursorPayload> | undefined;
  try {
    payload = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as CursorPayload;
  } catch {
    payload = undefined;
  }
  if (
    !payload ||
    payload.v !== CURSOR_VERSION ||
    typeof payload.u !== "number" ||
    typeof payload.id !== "string"
  ) {
    throw RequestError.invalidParams(undefined, `Unknown session/list cursor: ${cursor}`);
  }
  if (
    payload.cwd !== scope.cwd ||
    payload.archived !== scope.archived ||
    payload.worktrees !== scope.includeWorktrees
  ) {
    throw RequestError.invalidParams(
      undefined,
      "The session/list cursor belongs to another cwd or filter",
    );
  }
  return { updatedAtMs: payload.u, sessionId: payload.id };
}

/** Writes `<projectDir>/<sessionId>/custom-title.json` the way the CLI's
 *  `/rename` does: file 0600 in a 0700 directory, replaced atomically. The
 *  temporary file has a random name of the CLI's `custom-title.json.tmp.*`
 *  pattern, and only a temporary file this call created is removed. */
export async function writeCustomTitleSidecar(transcriptPath: string, title: string) {
  const sessionId = path.basename(transcriptPath, ".jsonl");
  const dir = path.join(path.dirname(transcriptPath), sessionId);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const target = path.join(dir, "custom-title.json");
  const temporary = `${target}.tmp.${randomBytes(8).toString("hex")}`;
  const handle = await fs.open(temporary, "wx", 0o600);
  try {
    try {
      await handle.writeFile(JSON.stringify({ customTitle: title }));
    } finally {
      await handle.close();
    }
    await fs.rename(temporary, target);
  } catch (error) {
    await fs.rm(temporary, { force: true });
    throw error;
  }
}

/** The title record that the SDK `renameSession` appends. */
function customTitleRecord(sessionId: string, title: string): string {
  return JSON.stringify({ type: "custom-title", customTitle: title, sessionId });
}

/** The last non-empty line of a file, from its last 64 KB, and whether the
 *  file ends with a newline. */
async function lastLine(filePath: string): Promise<{ line: string; endsWithNewline: boolean }> {
  const handle = await fs.open(filePath, "r");
  try {
    const { size } = await handle.stat();
    const length = Math.min(size, 64 * 1024);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    const text = buffer.toString("utf8");
    const lines = text.split("\n").filter((line) => line.trim());
    return { line: lines[lines.length - 1] ?? "", endsWithNewline: text.endsWith("\n") };
  } finally {
    await handle.close();
  }
}

/** Appends the title record to a transcript whose last record is not that
 *  title already. A transcript that does not end with a complete line is
 *  left alone while a live writer may be finishing that line; otherwise its
 *  torn last line is closed first. Returns whether the record is there. */
async function ensureTitleRecord(
  filePath: string,
  sessionId: string,
  title: string,
  options: { liveWriter: boolean },
): Promise<boolean> {
  const { line, endsWithNewline } = await lastLine(filePath);
  try {
    const last = JSON.parse(line) as { type?: unknown; customTitle?: unknown };
    if (last.type === "custom-title" && last.customTitle === title) return true;
  } catch {
    // Not a record: append.
  }
  const complete = endsWithNewline || line === "";
  if (!complete && options.liveWriter) return false;
  await fs.appendFile(filePath, `${complete ? "" : "\n"}${customTitleRecord(sessionId, title)}\n`);
  return true;
}

/**
 * Whether `transcript` lies in the project directory of one of `paths`, the
 * one the CLI of that cwd writes: the exact encoding, or, for a long path
 * whose name the CLI hashes differently, a directory with the cut prefix
 * whose transcript belongs to the path. Another long path that shares the
 * prefix does not count.
 */
async function isTranscriptOf(transcript: string, paths: readonly string[]): Promise<boolean> {
  const dirName = path.basename(path.dirname(transcript));
  if (paths.some((cwd) => isExactProjectDir(dirName, cwd))) return true;
  if (!paths.some((cwd) => projectDirMatches(dirName, cwd))) return false;
  try {
    const { size } = await fs.stat(transcript);
    const cwd = transcriptProjectCwd(await readHeadTail(transcript, size));
    return cwd !== undefined && paths.some((projectPath) => sameProjectPath(cwd, projectPath));
  } catch {
    // Unreadable: not known to be the CLI's own copy.
    return false;
  }
}

/** The session id as the file name of a transcript spells it. */
function transcriptSessionId(transcript: string): string {
  return path.basename(transcript, ".jsonl");
}

function isSdkNotFound(error: unknown): boolean {
  return error instanceof Error && /^Session \S+ not found in /.test(error.message);
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.lstat(target);
    return true;
  } catch (error) {
    if (errorCode(error) === "ENOENT" || errorCode(error) === "ENOTDIR") return false;
    throw error;
  }
}

/** The error the SDK `deleteSession` gives for a session id it rejects or
 *  does not find, which a client without `sessionIndex` got before. */
function sdkDeleteError(sessionId: string): Error {
  return new Error(
    isSessionId(sessionId)
      ? `Session ${sessionId} not found in any project directory`
      : `Invalid sessionId: ${sessionId}`,
  );
}

/**
 * `session/delete` of an AIR client without `sessionIndex`, which uses delete
 * to mark a session done: archives it instead, so the transcript survives. A
 * session without a transcript fails as the SDK delete did.
 */
export async function archiveInsteadOfDelete(
  sessionId: string,
  index: Pick<SessionIndex, "findTranscripts"> = new SessionIndex(sdkGetSessionInfo),
): Promise<void> {
  if (!isSessionId(sessionId)) throw sdkDeleteError(sessionId);
  // The SDK delete skips empty transcripts, so they do not count.
  if ((await index.findTranscripts(sessionId, { exactSpelling: true })).length === 0) {
    throw sdkDeleteError(sessionId);
  }
  await writeArchiveMarker(sessionId);
}

export type SessionIndexDeps = {
  getSessionInfo?: GetSessionInfo;
  renameSession?: (sessionId: string, title: string) => Promise<void>;
  deleteSession?: (sessionId: string) => Promise<void>;
  registry?: LiveSessionRegistry;
  now?: () => number;
  /** Sends `_session/list_changed`. */
  notifyListChanged: (params: { cwd: string }) => Promise<void>;
  logError: (message: string, error: unknown) => void;
};

export class SessionIndexService {
  readonly index: SessionIndex;
  readonly registry: LiveSessionRegistry;
  private watcher?: ListChangedWatcher;
  /** Set for good by {@link dispose}: no watcher is started after it. */
  private disposed = false;
  /** The mutation in flight per session, which the next one waits for. */
  private readonly mutations = new Map<string, Promise<unknown>>();
  private readonly now: () => number;
  private readonly renameSession: (sessionId: string, title: string) => Promise<void>;
  private readonly deleteSession: (sessionId: string) => Promise<void>;

  constructor(private readonly deps: SessionIndexDeps) {
    this.index = new SessionIndex(deps.getSessionInfo ?? sdkGetSessionInfo);
    this.registry = deps.registry ?? new LiveSessionRegistry();
    this.now = deps.now ?? Date.now;
    this.renameSession = deps.renameSession ?? ((id, title) => sdkRenameSession(id, title));
    this.deleteSession = deps.deleteSession ?? ((id) => sdkDeleteSession(id));
  }

  /** `session/list` of a `sessionIndex` client. `own` reports the sessions
   *  that this connection runs. */
  async list(
    params: ListSessionsRequest,
    own: (sessionId: string) => OwnSessionState | undefined,
  ): Promise<ListSessionsResponse> {
    const { limit, archived, includeWorktrees } = parseListOptions(params._meta);
    const cwd = params.cwd ?? null;
    const scope: ListScope = { cwd, archived, includeWorktrees };
    const after =
      params.cursor === null || params.cursor === undefined
        ? undefined
        : decodeListCursor(params.cursor, scope);
    // The live registry is read while the transcripts are.
    const livePromise = this.registry.snapshot();
    const archivedIds = await readArchivedSessionIds();
    const { rows, hasMore } = await this.index.list({
      cwd,
      includeWorktrees,
      limit,
      archived,
      after,
      archivedIds,
    });
    const live = await livePromise;
    // A list without a cwd is not watched.
    if (cwd) this.watch(cwd, includeWorktrees);
    const now = this.now();
    const sessions: SessionInfo[] = rows.map((row) => {
      const ownState = own(row.sessionId);
      const activity = deriveActivity({
        own: ownState,
        live: live.get(row.sessionId),
        facts: row.facts,
        transcriptMtimeMs: row.mtimeMs,
        now,
      });
      const cost = selectCost(ownState, row.facts);
      const { facts } = row;
      // The row fields of the session list extensions RFD and RFD #2161, flat;
      // each is omitted when unknown, except `archived`.
      const fields: Record<string, unknown> = {
        archived: row.archived,
        createdAt: iso(facts.createdAt),
        lastPromptAt: iso(facts.lastPromptAt),
        gitBranch: row.gitBranch,
        model: facts.model,
        forkedFrom: facts.forkedFrom,
        state: activity?.state,
        lastTurnEndedAt: activity?.lastTurnEndedAt,
        cost: cost === undefined ? undefined : { amount: cost, currency: "USD" },
      };
      let meta: Record<string, unknown> | undefined;
      for (const [key, value] of Object.entries(fields)) {
        if (value !== undefined) meta = withAirMeta(meta, key, value);
      }
      return {
        sessionId: row.sessionId,
        cwd: row.cwd,
        title: row.title,
        updatedAt: new Date(row.updatedAtMs).toISOString(),
        _meta: meta,
      };
    });
    const last = rows[rows.length - 1];
    return hasMore && last ? { sessions, nextCursor: encodeListCursor(last, scope) } : { sessions };
  }

  /** Throws `thread_active_writer` when another live process holds the
   *  session. A CLI that this process started (one being closed) is waited
   *  for instead, and refused only when it outlives the wait. `ownCli`: this
   *  process ran a CLI for the session (see {@link LiveSessionRegistry.holder}). */
  async assertNotHeldElsewhere(sessionId: string, ownCli?: "running" | "exiting"): Promise<void> {
    if (await this.registry.holder(sessionId, { ownCli })) throw activeWriterError(sessionId);
  }

  /** Runs `mutation` after the previous mutation of the session ended. */
  private exclusive<T>(sessionId: string, mutation: () => Promise<T>): Promise<T> {
    const key = sessionId.toLowerCase();
    const previous = this.mutations.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(mutation);
    const settled = next.catch(() => undefined);
    this.mutations.set(key, settled);
    void settled.then(() => {
      if (this.mutations.get(key) === settled) this.mutations.delete(key);
    });
    return next;
  }

  /** Renames a session whose CLI does not run here: appends the title record
   *  to every transcript of the session (the SDK writes the first one only)
   *  and writes the title sidecar next to each. `ownCli`: this process runs
   *  (or just closed) a CLI for the session. */
  async renameOffline(
    sessionId: string,
    title: string,
    options: { ownCli?: "running" | "exiting" } = {},
  ): Promise<void> {
    if (!isSessionId(sessionId)) throw sessionNotFound(sessionId);
    await this.exclusive(sessionId, async () => {
      const transcripts = await this.index.findTranscripts(sessionId);
      if (transcripts.length === 0) throw sessionNotFound(sessionId);
      await this.assertNotHeldElsewhere(sessionId, options.ownCli);
      try {
        // The SDK finds the transcript by its exact file name.
        await this.renameSession(transcriptSessionId(transcripts[0]!), title);
        await this.titleCopies(transcripts, sessionId, title, options.ownCli === "running");
      } finally {
        this.index.invalidate(transcripts);
      }
    });
  }

  /** Renames a session whose CLI runs here: `rename` asks the CLI, which
   *  titles its own transcript and sidecar. The other copies of the session
   *  get the record and the sidecar here, as a best effort once the CLI has
   *  the title: a copy that another process may be writing (its last line
   *  incomplete) is left alone, and a failure is logged, not returned.
   *  Another process that resumed the session too is `thread_active_writer`:
   *  only the CLI child of this process that runs it does not count. */
  async renameLive(
    sessionId: string,
    title: string,
    cwd: string,
    rename: () => Promise<void>,
  ): Promise<void> {
    await this.exclusive(sessionId, async () => {
      await this.assertNotHeldElsewhere(sessionId, "running");
      await rename();
      if (!isSessionId(sessionId)) return;
      let transcripts: string[] = [];
      try {
        transcripts = await this.index.findTranscripts(sessionId);
        const paths = [...new Set([cwd, await canonicalPath(cwd)])];
        const others: string[] = [];
        for (const transcript of transcripts) {
          if (!(await isTranscriptOf(transcript, paths))) others.push(transcript);
        }
        await this.titleCopies(others, sessionId, title, true);
      } catch (error) {
        this.deps.logError(`titling the other transcripts of ${sessionId} failed`, error);
      } finally {
        this.index.invalidate(transcripts);
      }
    });
  }

  private async titleCopies(
    transcripts: readonly string[],
    sessionId: string,
    title: string,
    liveWriter: boolean,
  ): Promise<void> {
    for (const transcript of transcripts) {
      const id = transcriptSessionId(transcript);
      if (await ensureTitleRecord(transcript, id, title, { liveWriter })) {
        await writeCustomTitleSidecar(transcript, title);
      }
    }
  }

  /** Writes the archive marker. Neither touches the transcript (so
   *  `updatedAt` stays) nor the session's execution. A session without a
   *  transcript is unknown (`-32002`), also one that still has a marker;
   *  `known` is a session this connection runs, which may have no transcript
   *  yet. */
  async archive(sessionId: string, known: boolean): Promise<void> {
    if (!isSessionId(sessionId)) throw sessionNotFound(sessionId);
    await this.exclusive(sessionId, async () => {
      if (!known && !(await this.exists(sessionId))) throw sessionNotFound(sessionId);
      await writeArchiveMarker(sessionId);
    });
  }

  /** Removes the archive marker. A deleted session is not brought back: a
   *  session without a transcript is unknown (`-32002`), and its stale
   *  marker is dropped. */
  async unarchive(sessionId: string, known: boolean): Promise<void> {
    if (!isSessionId(sessionId)) throw sessionNotFound(sessionId);
    await this.exclusive(sessionId, async () => {
      if (!known && !(await this.exists(sessionId))) {
        await removeArchiveMarker(sessionId);
        throw sessionNotFound(sessionId);
      }
      await removeArchiveMarker(sessionId);
    });
  }

  /** Whether the session has a transcript the list can show. */
  private async exists(sessionId: string): Promise<boolean> {
    return (await this.index.findTranscripts(sessionId)).length > 0;
  }

  /** Deletes every transcript of the session, then its archive marker. A
   *  failure leaves the marker, so a session it fails to delete stays
   *  archived. `known`: the session was loaded here (and is torn down
   *  already), so a missing transcript is no error.
   *
   *  The SDK deletes the first non-empty transcript it finds and its
   *  `<sessionId>/` directory, one copy per call; empty transcripts, which it
   *  skips, are removed here. */
  async delete(sessionId: string, known: boolean): Promise<void> {
    if (!isSessionId(sessionId)) throw sessionNotFound(sessionId);
    await this.exclusive(sessionId, async () => {
      const all = await this.index.findTranscripts(sessionId, { includeEmpty: true });
      // A session directory can outlive its transcript: a delete that removed
      // the transcript and then failed on the directory.
      const sessionDirs = await this.index.findSessionDirs(sessionId);
      if (all.length === 0 && sessionDirs.length === 0) {
        if (await removeArchiveMarker(sessionId)) return;
        if (known) return;
        throw sessionNotFound(sessionId);
      }
      try {
        // The SDK finds a transcript by its exact file name: one call per
        // copy, with that copy's spelling of the id.
        for (const transcript of await this.index.findTranscripts(sessionId)) {
          const spelling = transcriptSessionId(transcript);
          try {
            await this.deleteSession(spelling);
          } catch (error) {
            // Only "not found" with no copy of that spelling left is a copy
            // removed meanwhile.
            const left = await this.index.findTranscripts(sessionId);
            if (
              isSdkNotFound(error) &&
              !left.some((file) => transcriptSessionId(file) === spelling)
            ) {
              continue;
            }
            throw error;
          }
        }
        // Empty transcripts, which the SDK skips, and session directories
        // without a transcript.
        for (const transcript of await this.index.findTranscripts(sessionId, {
          includeEmpty: true,
        })) {
          const stats = await fs.stat(transcript).catch(() => undefined);
          if (stats && stats.size > 0) continue;
          await fs.rm(transcript, { force: true });
        }
        for (const sessionDir of await this.index.findSessionDirs(sessionId)) {
          if (await exists(`${sessionDir}.jsonl`)) continue;
          await fs.rm(sessionDir, { recursive: true, force: true });
        }
        const left = [
          ...(await this.index.findTranscripts(sessionId, { includeEmpty: true })),
          ...(await this.index.findSessionDirs(sessionId)),
        ];
        if (left.length > 0) {
          throw new Error(`Session ${sessionId} was not deleted: ${left.join(", ")} remain`);
        }
      } finally {
        this.index.invalidate(all);
      }
      await removeArchiveMarker(sessionId);
    });
  }

  dispose(): void {
    this.disposed = true;
    this.watcher?.dispose();
    this.watcher = undefined;
  }

  private watch(cwd: string, includeWorktrees: boolean): void {
    // A list that was in flight when the connection closed starts nothing.
    if (this.disposed) return;
    this.watcher ??= new ListChangedWatcher({
      projectDirs: async (watchedCwd, worktrees) => {
        const paths = await this.index.listedPaths(watchedCwd, worktrees);
        const dirs = await this.index.projectDirs(paths);
        return { dirNames: dirs.map(({ dirName }) => dirName), paths };
      },
      notify: (changedCwd) => this.deps.notifyListChanged({ cwd: changedCwd }),
      logError: this.deps.logError,
    });
    void this.watcher
      .onListed(cwd, includeWorktrees)
      .catch((error) => this.deps.logError("session list watch failed", error));
  }
}
