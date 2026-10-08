/**
 * The `sessionIndex` AIR extension: the session list, rename, archive and
 * delete of a client that declared the capability.
 *
 * Wire contract: docs/air-extensions.md, "Session index". Everything here is
 * reached only for a `sessionIndex` client, except the archive that an AIR
 * client without the capability gets in place of a delete (see
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
} from "@anthropic-ai/claude-agent-sdk";
import { airExtensionMeta, withAirMeta } from "../air-extension.js";
import { sanitizeTitle } from "../session-titles.js";
import { deriveActivity, selectCost, type OwnSessionState } from "./activity.js";
import { readArchivedSessionIds, removeArchiveMarker } from "./archive-markers.js";
import { isArchivedTitle, storedTitle, titleRecords } from "./archive-title.js";
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
import {
  effectiveTranscriptTitle,
  hasTailCustomTitle,
  readHeadTail,
  transcriptProjectCwd,
} from "./transcript-scan.js";
import {
  DEFAULT_LIST_LIMIT,
  MAX_LIST_LIMIT,
  ARCHIVED_FILTERS,
  readSidecarTitle,
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
/** The cursor format. A cursor of another version is rejected. */
const CURSOR_VERSION = 5;

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
export type ListScope = {
  cwd: string | null;
  archived: ArchivedFilter;
  includeWorktrees: boolean;
};

function archivedFilter(list: Record<string, unknown>): ArchivedFilter {
  // Omitted or null is `unarchived`.
  const value = list.archived ?? "unarchived";
  if (!ARCHIVED_FILTERS.includes(value as ArchivedFilter)) {
    throw RequestError.invalidParams(
      { archived: value },
      '`_meta.jetbrains.air.list.archived` must be "unarchived", "archived" or "all"',
    );
  }
  return value as ArchivedFilter;
}

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
  // Omitted or null is the default; an integer of at least 1 is clamped;
  // anything else is invalid.
  const raw = list.limit ?? DEFAULT_LIST_LIMIT;
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1) {
    throw RequestError.invalidParams(
      { limit: raw },
      "`_meta.jetbrains.air.list.limit` must be an integer of at least 1",
    );
  }
  return {
    limit: Math.min(MAX_LIST_LIMIT, raw),
    archived: archivedFilter(list),
    includeWorktrees: optionalBoolean(list, "includeWorktrees"),
  };
}

type CursorPayload = {
  v: number;
  u: number;
  id: string;
  cwd: string | null;
  archived: ArchivedFilter;
  worktrees: boolean;
};

export function encodeListCursor(cursor: ListCursor, scope: ListScope): string {
  const payload: CursorPayload = {
    v: CURSOR_VERSION,
    u: cursor.orderAtMs,
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
  return { orderAtMs: payload.u, sessionId: payload.id };
}

/** `<projectDir>/<sessionId>/custom-title.json` of a transcript. */
function sidecarPath(transcriptPath: string): string {
  const sessionId = path.basename(transcriptPath, ".jsonl");
  return path.join(path.dirname(transcriptPath), sessionId, "custom-title.json");
}

/** Writes `<projectDir>/<sessionId>/custom-title.json` the way the CLI's
 *  `/rename` does: file 0600 in a 0700 directory, replaced atomically. The
 *  temporary file has a random name of the CLI's `custom-title.json.tmp.*`
 *  pattern, and only a temporary file this call created is removed. */
export async function writeCustomTitleSidecar(transcriptPath: string, title: string) {
  const target = sidecarPath(transcriptPath);
  await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
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

/** The last two non-empty lines of a file, from its last 64 KB, and
 *  whether the file ends with a newline. */
async function lastLines(
  filePath: string,
): Promise<{ lines: string[]; last: string; endsWithNewline: boolean }> {
  const handle = await fs.open(filePath, "r");
  try {
    const { size } = await handle.stat();
    const length = Math.min(size, 64 * 1024);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    const text = buffer.toString("utf8");
    const lines = text.split("\n").filter((line) => line.trim());
    return {
      lines: lines.slice(-2),
      last: lines.at(-1) ?? "",
      endsWithNewline: text.endsWith("\n"),
    };
  } finally {
    await handle.close();
  }
}

/** Appends the title records of `title` (see archive-title.ts) to a
 *  transcript whose last two records are not those already. A transcript
 *  that does not end with a complete line is left alone while a live writer
 *  may be finishing that line; otherwise its torn last line is closed first.
 *  Returns whether the records are there. */
async function ensureTitleRecords(
  filePath: string,
  sessionId: string,
  title: string,
  options: { liveWriter: boolean },
): Promise<boolean> {
  const records = titleRecords(sessionId, title);
  const { lines, last, endsWithNewline } = await lastLines(filePath);
  if (lines.join("\n") + "\n" === records) return true;
  const complete = endsWithNewline || last === "";
  if (!complete && options.liveWriter) return false;
  await fs.appendFile(filePath, `${complete ? "" : "\n"}${records}`);
  return true;
}

/** The effective title of one transcript copy (see
 *  {@link effectiveTranscriptTitle}). */
async function copyTitle(filePath: string): Promise<string | undefined> {
  const { size } = await fs.stat(filePath);
  const headTail = await readHeadTail(filePath, size);
  const sidecar = hasTailCustomTitle(headTail.tail)
    ? undefined
    : await readSidecarTitle(filePath, transcriptSessionId(filePath));
  return effectiveTranscriptTitle(headTail, sidecar);
}

/** The title a change stores for a copy whose effective title is `current`
 *  (undefined: none yet), or undefined to leave the copy as it is. */
export type TitleChange = (current: string | undefined, sessionId: string) => string | undefined;

/** `_session/rename`: the new title, with the archive prefix on a copy
 *  that is archived, so a rename keeps the archive state. */
export function renameTo(title: string): TitleChange {
  return (current, sessionId) =>
    isArchivedTitle(current) ? storedTitle(title, true, sessionId) : title;
}

/** `_session/archive` and `_session/unarchive`: the current title with or
 *  without the archive prefix; a copy already in that state is left alone. */
export function archiveTo(archived: boolean): TitleChange {
  return (current, sessionId) =>
    isArchivedTitle(current) === archived
      ? undefined
      : storedTitle(current ?? "", archived, sessionId);
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
 * session without a transcript fails as the SDK delete did. `ownCli`: this
 * process ran a CLI for the session, which is waited for.
 */
export async function archiveInsteadOfDelete(
  sessionId: string,
  service: SessionIndexService,
  options: { ownCli?: "running" | "exiting" } = {},
): Promise<void> {
  if (!isSessionId(sessionId)) throw sdkDeleteError(sessionId);
  // The SDK delete skips empty transcripts, so they do not count.
  const found = await service.index.findTranscripts(sessionId, { exactSpelling: true });
  if (found.length === 0) throw sdkDeleteError(sessionId);
  await service.retitle(sessionId, archiveTo(true), {
    ownCli: options.ownCli,
    sidecar: "existing",
    dropMarker: true,
  });
}

/** How {@link SessionIndexService.retitle} reaches the session. */
export type RetitleOptions = {
  /** This process runs (or just closed) a CLI for the session. */
  ownCli?: "running" | "exiting";
  /** The CLI of the session runs here: it stores the title of its own
   *  transcript (`rename_session`), and `title` is the title it holds while
   *  it has no transcript yet. */
  live?: { cwd: string; rename: (title: string) => Promise<void>; title?: string };
  /** A session without a transcript is not unknown: a new session this
   *  connection runs, or a live one being renamed. */
  mayBeUnwritten?: boolean;
  /** `always` writes the CLI title sidecar next to every titled copy;
   *  `existing` rewrites only one that is there already. */
  sidecar: "always" | "existing";
  /** Also drop the session's archive marker. */
  dropMarker?: boolean;
};

export type SessionIndexDeps = {
  getSessionInfo?: GetSessionInfo;
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
  private readonly deleteSession: (sessionId: string) => Promise<void>;

  constructor(private readonly deps: SessionIndexDeps) {
    this.index = new SessionIndex(deps.getSessionInfo ?? sdkGetSessionInfo);
    this.registry = deps.registry ?? new LiveSessionRegistry();
    this.now = deps.now ?? Date.now;
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
        lastPromptAt: iso(facts.lastPromptAt),
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

  /**
   * Retitles every transcript of a session with `change`: rename, archive
   * and unarchive. Returns the title stored for the session's own copy (the
   * CLI's, else the first), or undefined when it was left as it was.
   *
   * - The CLI runs here (`live`): it titles its own transcript and sidecar
   *   (`rename_session`), the only writer that cannot be overtaken by the
   *   title the CLI holds. The other copies get the records and the sidecar
   *   here, as a best effort once the CLI has the title: a copy that another
   *   process may be writing (its last line incomplete) is left alone, and a
   *   failure is logged, not returned. Another process that resumed the
   *   session too is `thread_active_writer`: only the CLI child of this
   *   process that runs it does not count.
   * - Otherwise every transcript gets the records (and the sidecar, see
   *   {@link RetitleOptions.sidecar}). A session that another live process
   *   holds is `thread_active_writer`; a CLI this process closed is waited
   *   for.
   *
   * A session without a transcript is unknown (`-32002`), unless
   * {@link RetitleOptions.mayBeUnwritten}.
   */
  async retitle(
    sessionId: string,
    change: TitleChange,
    options: RetitleOptions,
  ): Promise<string | undefined> {
    const { live } = options;
    if (!isSessionId(sessionId)) {
      if (!live || !options.mayBeUnwritten) throw sessionNotFound(sessionId);
      return this.exclusive(sessionId, async () => {
        await this.assertNotHeldElsewhere(sessionId, "running");
        const title = change(live.title, sessionId);
        if (title !== undefined) await live.rename(title);
        return title;
      });
    }
    return this.exclusive(sessionId, async () => {
      const transcripts = await this.index.findTranscripts(sessionId);
      if (transcripts.length === 0 && !options.mayBeUnwritten) {
        if (options.dropMarker) await removeArchiveMarker(sessionId);
        throw sessionNotFound(sessionId);
      }
      let stored: string | undefined;
      try {
        if (live) {
          await this.assertNotHeldElsewhere(sessionId, "running");
          const paths = [...new Set([live.cwd, await canonicalPath(live.cwd)])];
          const own: string[] = [];
          const others: string[] = [];
          for (const transcript of transcripts) {
            ((await isTranscriptOf(transcript, paths)) ? own : others).push(transcript);
          }
          const primary = own[0] ?? others[0];
          const current = primary ? await copyTitle(primary) : live.title;
          stored = change(current, sessionId);
          if (stored !== undefined) await live.rename(stored);
          try {
            await this.titleCopies(others, change, true, options.sidecar);
          } catch (error) {
            this.deps.logError(`titling the other transcripts of ${sessionId} failed`, error);
          }
        } else {
          await this.assertNotHeldElsewhere(sessionId, options.ownCli);
          stored = await this.titleCopies(
            transcripts,
            change,
            options.ownCli === "running",
            options.sidecar,
          );
        }
      } finally {
        this.index.invalidate(transcripts);
      }
      if (options.dropMarker) await removeArchiveMarker(sessionId);
      return stored;
    });
  }

  /** Appends the title records `change` gives each copy, then its sidecar.
   *  Returns the title of the first copy that got one. */
  private async titleCopies(
    transcripts: readonly string[],
    change: TitleChange,
    liveWriter: boolean,
    sidecar: RetitleOptions["sidecar"],
  ): Promise<string | undefined> {
    let first: string | undefined;
    for (const transcript of transcripts) {
      const id = transcriptSessionId(transcript);
      const title = change(await copyTitle(transcript), id);
      if (title === undefined) continue;
      if (!(await ensureTitleRecords(transcript, id, title, { liveWriter }))) continue;
      first ??= title;
      if (sidecar === "always" || (await exists(sidecarPath(transcript)))) {
        await writeCustomTitleSidecar(transcript, title);
      }
    }
    return first;
  }

  /** Deletes every transcript of the session, then its archive marker (see
   *  archive-markers.ts). A failure leaves the marker. `known`: the session was loaded here (and is torn down
   *  already), so a missing transcript is no error.
   *
   *  The SDK deletes the first non-empty transcript it finds and its
   *  `<sessionId>/` directory, one copy per call; empty transcripts, which it
   *  skips, are removed here. */
  async delete(sessionId: string, known: boolean): Promise<void> {
    if (!isSessionId(sessionId)) throw sessionNotFound(sessionId);
    await this.exclusive(sessionId, async () => {
      // A session directory can outlive its transcript: a delete that removed
      // the transcript and then failed on the directory.
      const found = await this.index.scanSession(sessionId);
      const all = found.transcripts.map(({ filePath }) => filePath);
      if (all.length === 0 && found.sessionDirs.length === 0) {
        // A leftover marker of a session without history is dropped; the
        // session is still unknown unless it was loaded here.
        await removeArchiveMarker(sessionId);
        if (known) return;
        throw sessionNotFound(sessionId);
      }
      try {
        // The SDK finds a non-empty transcript by its exact file name: one
        // call per copy, with that copy's spelling of the id.
        for (const { filePath } of found.transcripts.filter(({ size }) => size > 0)) {
          const spelling = transcriptSessionId(filePath);
          try {
            await this.deleteSession(spelling);
          } catch (error) {
            // Only "not found" with that copy gone is a copy removed meanwhile.
            if (isSdkNotFound(error) && !(await exists(filePath))) continue;
            throw error;
          }
        }
        // Empty transcripts, which the SDK skips, and session directories
        // without a transcript.
        for (const { filePath, size } of found.transcripts) {
          if (size === 0) await fs.rm(filePath, { force: true });
        }
        for (const sessionDir of found.sessionDirs) {
          if (await exists(`${sessionDir}.jsonl`)) continue;
          await fs.rm(sessionDir, { recursive: true, force: true });
        }
        const left = await this.index.scanSession(sessionId);
        const remaining = [
          ...left.transcripts.map(({ filePath }) => filePath),
          ...left.sessionDirs,
        ];
        if (remaining.length > 0) {
          throw new Error(`Session ${sessionId} was not deleted: ${remaining.join(", ")} remain`);
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
      transcripts: (watchedCwd, worktrees) => this.index.scopeFingerprint(watchedCwd, worktrees),
      notify: (changedCwd) => this.deps.notifyListChanged({ cwd: changedCwd }),
      logError: this.deps.logError,
    });
    void this.watcher
      .onListed(cwd, includeWorktrees)
      .catch((error) => this.deps.logError("session list watch failed", error));
  }
}
