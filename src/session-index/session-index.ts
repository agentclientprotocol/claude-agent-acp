/**
 * The session list of a `sessionIndex` client.
 *
 * Each list enumerates the transcripts of the requested cwd and of every
 * worktree of its repository: one `readdir` per project directory and one
 * `stat` per transcript, no long-lived cache. The metadata of a transcript is
 * cached by `(path, mtime, size)` in an LRU and read on a miss with the SDK
 * `getSessionInfo` (titles, sidecar) plus one head and tail read for
 * what the SDK does not report (see {@link scanTranscript}). Misses are read in
 * parallel batches.
 *
 * Order is the last user activity descending, then session id: the time of
 * the last real user prompt (`lastPromptAt`), else `updatedAt`. `updatedAt`
 * is the time of the last message, capped at the transcript mtime, so a
 * rename or another metadata record does not move a session up, and the
 * order key is never later than it. Candidates are read in mtime order: a
 * candidate's order key is at most its mtime, so the scan stops as soon as
 * the page is full and the next mtime is older than the key of the last row.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { SDKSessionInfo } from "@anthropic-ai/claude-agent-sdk";
import { sanitizeTitle } from "../session-titles.js";
import { isArchivedTitle, visibleTitle } from "./archive-title.js";
import {
  canonicalPath,
  encodeProjectPath,
  isExactProjectDir,
  isSessionId,
  normalizePath,
  pathAndAncestors,
  projectDirMatches,
  projectDirsOf,
  projectsRoot,
  sameProjectPath,
} from "./project-dirs.js";
import {
  continuedInSessionId,
  hasHistory,
  isSidechainTranscript,
  lastTimestamp,
  readHeadTail,
  relocatedCwd,
  scanTranscriptFile,
  sdkTitles,
  tailCustomTitle,
  transcriptProjectCwd,
  type HeadTail,
  type PreviousScan,
  type SdkTitles,
  type TranscriptFacts,
} from "./transcript-scan.js";
import { DirListings, statFiles } from "./dir-listing.js";
import { worktreeCounterparts } from "./worktrees.js";

export const DEFAULT_LIST_LIMIT = 50;
export const MAX_LIST_LIMIT = 200;
/** Entries of the metadata cache: a few hundred bytes each, so the
 *  transcripts of a large history (tens of thousands) stay cached and deep
 *  pages do not read them again. */
const METADATA_CACHE_SIZE = 50_000;
const READ_BATCH_SIZE = 16;
/** Transcripts read at most per directory to recover a sibling's cwd. */
const MAX_CWD_PROBES_PER_DIR = 64;
/** How long a directory that gave no cwd is not probed again. */
const NO_CWD_RETRY_MS = 60_000;

/** Which sessions a list holds by archive state: `unarchived` the
 *  unarchived ones only, `archived` the archived ones only, `all` both in one
 *  order. */
export type ArchivedFilter = "unarchived" | "archived" | "all";

export const ARCHIVED_FILTERS: readonly ArchivedFilter[] = ["unarchived", "archived", "all"];

/** Whether `filter` keeps a session of that archive state. */
export function archivedFilterKeeps(filter: ArchivedFilter, archived: boolean): boolean {
  return filter === "all" || (filter === "archived") === archived;
}

/** One transcript file found by the enumeration. */
export type TranscriptCandidate = {
  sessionId: string;
  filePath: string;
  dirName: string;
  /** The requested path (cwd or worktree) whose project directory this is. */
  projectPath?: string;
  mtimeMs: number;
  size: number;
  /** Tells a replaced file from one that grew. */
  ino: number;
};

/** The cached metadata of one transcript. */
type TranscriptMetadata = {
  /** The visible title: without the archive prefix. */
  title: string;
  /** The custom title the SDK reports carries the archive prefix. */
  archived: boolean;
  /** The cwd read from the transcript, when it encodes to the directory name. */
  fileCwd?: string;
  /** The cwd the SDK list checks the transcript by: the last relocation,
   *  else the first cwd of the head. */
  projectCwd?: string;
  /** The session this transcript was continued in, from its tail. */
  continuedIn?: string;
  updatedAtMs: number;
  facts: TranscriptFacts;
};

export type IndexRow = {
  sessionId: string;
  cwd: string;
  title: string;
  updatedAtMs: number;
  /** The order key: the last user activity, `lastPromptAt`, else
   *  `updatedAt`. Never later than `updatedAt`, so never later than the
   *  transcript mtime. */
  orderAtMs: number;
  facts: TranscriptFacts;
  mtimeMs: number;
  archived: boolean;
};

/** A keyset position: the order key and the session id of the last row. */
export type ListCursor = { orderAtMs: number; sessionId: string };

export type ListQuery = {
  cwd?: string | null;
  /** Also list the sessions of the existing linked worktrees of `cwd`. */
  includeWorktrees?: boolean;
  limit: number;
  archived: ArchivedFilter;
  after?: ListCursor;
};

export type GetSessionInfo = (
  sessionId: string,
  options: { dir?: string },
) => Promise<SDKSessionInfo | undefined>;

type CacheEntry = {
  mtimeMs: number;
  size: number;
  ino: number;
  metadata: TranscriptMetadata | null;
};

/** A small LRU: a `Map` keeps insertion order, and a hit is re-inserted. */
class Lru<K, V> {
  private readonly entries = new Map<K, V>();
  constructor(private readonly capacity: number) {}
  get(key: K): V | undefined {
    const value = this.entries.get(key);
    if (value !== undefined) {
      this.entries.delete(key);
      this.entries.set(key, value);
    }
    return value;
  }
  set(key: K, value: V): void {
    this.entries.delete(key);
    this.entries.set(key, value);
    if (this.entries.size > this.capacity) {
      this.entries.delete(this.entries.keys().next().value as K);
    }
  }
  delete(key: K): void {
    this.entries.delete(key);
  }
  /** The value of `key`, without making it recent. */
  peek(key: K): V | undefined {
    return this.entries.get(key);
  }
}

function compareRows(a: { orderAtMs: number; sessionId: string }, b: typeof a): number {
  if (a.orderAtMs !== b.orderAtMs) return b.orderAtMs - a.orderAtMs;
  return a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0;
}

type Resolved = { candidate: TranscriptCandidate; metadata: TranscriptMetadata };

function toRow({ candidate, metadata }: Resolved, cwd: string): IndexRow {
  return {
    archived: metadata.archived,
    sessionId: candidate.sessionId,
    cwd,
    title: metadata.title,
    updatedAtMs: metadata.updatedAtMs,
    orderAtMs: Math.min(metadata.facts.lastPromptAt ?? metadata.updatedAtMs, metadata.updatedAtMs),
    facts: metadata.facts,
    mtimeMs: candidate.mtimeMs,
  };
}

function isAfter(row: { orderAtMs: number; sessionId: string }, cursor: ListCursor): boolean {
  return compareRows(row, cursor) > 0;
}

function byMtimeDescending(a: TranscriptCandidate, b: TranscriptCandidate): number {
  if (a.mtimeMs !== b.mtimeMs) return b.mtimeMs - a.mtimeMs;
  return a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0;
}

/** The title of the CLI's `custom-title.json` sidecar of a transcript. */
export async function readSidecarTitle(
  filePath: string,
  sessionId: string,
): Promise<string | undefined> {
  try {
    const text = await fs.readFile(
      path.join(path.dirname(filePath), sessionId, "custom-title.json"),
      "utf8",
    );
    const title = (JSON.parse(text) as { customTitle?: unknown }).customTitle;
    return typeof title === "string" && title.trim() ? title : undefined;
  } catch {
    return undefined;
  }
}

/**
 * On macOS the SDK opens `<projects>/<encoded cwd>` through the file system,
 * which ignores case on the usual volumes: a directory whose name differs in
 * case only (a repository renamed in case) is the project directory then.
 * Returns that entry of `rootEntries` when the file system resolves the
 * exact name to it.
 */
async function caseInsensitiveProjectDir(
  projectPath: string,
  rootEntries: readonly string[],
): Promise<string | undefined> {
  if (process.platform !== "darwin") return undefined;
  const exact = encodeProjectPath(projectPath);
  if (rootEntries.includes(exact)) return undefined;
  const lower = exact.toLowerCase();
  const variant = rootEntries.find((name) => name.toLowerCase() === lower);
  if (!variant) return undefined;
  try {
    return (await fs.stat(path.join(projectsRoot(), exact))).isDirectory() ? variant : undefined;
  } catch {
    return undefined;
  }
}

/** Whether the encoding of `cwd` names the directory `dirName` on disk. */
async function sameDirOnDisk(dirName: string, cwd: string): Promise<boolean> {
  const root = projectsRoot();
  try {
    const [listed, resolved] = await Promise.all([
      fs.stat(path.join(root, dirName)),
      fs.stat(path.join(root, encodeProjectPath(cwd))),
    ]);
    return listed.isDirectory() && listed.ino === resolved.ino && listed.dev === resolved.dev;
  } catch {
    return false;
  }
}

/** Whether paths are compared ignoring case, as the SDK does on macOS and
 *  Windows. */
const CASE_INSENSITIVE_PATHS = process.platform === "darwin" || process.platform === "win32";

/** A path as the SDK compares it: forward slashes, in any case where the
 *  file system ignores it. */
function comparable(value: string): string {
  const slashed = normalizePath(value).replaceAll("\\", "/");
  return CASE_INSENSITIVE_PATHS ? slashed.toLowerCase() : slashed;
}

/** Whether `a` and `b` are different paths that encode to the same project
 *  directory name (`/ws/app.v2` and `/ws/app-v2`). */
function collides(a: string, b: string): boolean {
  return sameProjectPath(a, b) && comparable(a) !== comparable(b);
}

/** A path the SDK does not resolve: a `..` segment, or a UNC or device path. */
function unresolvable(value: string): boolean {
  return /(^|[\\/])\.\.([\\/]|$)/.test(value) || /^[\\/]{2}/.test(value);
}

/**
 * Which transcripts of the project directories of `paths` (every one
 * without `paths`) the SDK `listSessions` of those paths lists. It leaves out
 * only a transcript whose cwd (see {@link TranscriptMetadata.projectCwd}) is
 * another path that encodes to the same directory and still resolves on disk
 * to such another path; one whose cwd is gone, or lies in one of `paths`, is
 * listed.
 */
function scopeOf(
  paths: readonly string[] | undefined,
): (candidate: TranscriptCandidate, metadata: TranscriptMetadata) => Promise<boolean> {
  if (!paths) return async () => true;
  const own = paths.map(comparable);
  const resolved = new Map<string, Promise<boolean>>();
  const hidden = async (cwd: string, projectPath: string): Promise<boolean> => {
    if (!collides(cwd, projectPath) || unresolvable(cwd) || unresolvable(projectPath)) return false;
    let real: string;
    try {
      real = normalizePath(await fs.realpath(cwd));
    } catch {
      return false;
    }
    return collides(real, await canonicalPath(projectPath));
  };
  return async ({ projectPath }, { projectCwd }) => {
    if (projectPath === undefined || projectCwd === undefined) return true;
    const cwd = comparable(projectCwd);
    if (
      own.some(
        (ownPath) =>
          cwd === ownPath || cwd.startsWith(ownPath.endsWith("/") ? ownPath : `${ownPath}/`),
      )
    ) {
      return true;
    }
    const key = `${projectCwd}\0${projectPath}`;
    let result = resolved.get(key);
    if (!result) {
      result = hidden(projectCwd, projectPath).then((isHidden) => !isHidden);
      resolved.set(key, result);
    }
    return result;
  };
}

export class SessionIndex {
  private readonly listings = new DirListings();
  private readonly metadata = new Lru<string, CacheEntry>(METADATA_CACHE_SIZE);
  /** The metadata reads in flight, by path: a list and a subscription that
   *  want the same transcript at the same stat read it once. */
  private readonly reading = new Map<
    string,
    { key: string; promise: Promise<TranscriptMetadata | null> }
  >();
  /** A cwd that encodes to each project directory name, learned from its
   *  transcripts; it recovers the cwd of a sibling that has none. */
  private readonly dirCwds = new Map<string, string>();
  /** The project cwd of the transcripts of prefix-matched long directories. */
  private readonly transcriptCwds = new Lru<
    string,
    { mtimeMs: number; size: number; cwd: string | undefined }
  >(METADATA_CACHE_SIZE);
  /** Directories whose transcripts gave no cwd, by the directory mtime and
   *  when that was learned. */
  private readonly dirsWithoutCwd = new Map<string, { mtimeMs: number; at: number }>();

  constructor(private readonly getSessionInfo: GetSessionInfo) {}

  /** The paths whose sessions a list of `cwd` shows: `cwd`, and with
   *  `includeWorktrees` the same subdirectory of every other existing
   *  worktree of its repository (the worktree roots for a cwd at the root). */
  async listedPaths(cwd: string, includeWorktrees: boolean): Promise<string[]> {
    const canonical = await canonicalPath(cwd);
    if (!includeWorktrees) return [canonical];
    return [...new Set([canonical, ...(await worktreeCounterparts(canonical))])];
  }

  /** The project directories (names under the projects root) of `paths`.
   *  A long path is matched by its cut prefix, which other long paths may
   *  share: such a directory counts only when one of its transcripts belongs
   *  to the path, as the SDK checks. */
  async projectDirs(paths: readonly string[]): Promise<{ dirName: string; projectPath: string }[]> {
    const rootEntries = await this.listings.names(projectsRoot());
    const seen = new Set<string>();
    const result: { dirName: string; projectPath: string }[] = [];
    for (const projectPath of paths) {
      const names = projectDirsOf(projectPath, rootEntries);
      const caseVariant = await caseInsensitiveProjectDir(projectPath, rootEntries);
      if (caseVariant && !names.includes(caseVariant)) names.unshift(caseVariant);
      for (const dirName of names) {
        if (seen.has(dirName)) continue;
        if (
          dirName !== caseVariant &&
          dirName !== encodeProjectPath(projectPath) &&
          !(await this.longDirBelongsTo(dirName, projectPath))
        ) {
          continue;
        }
        seen.add(dirName);
        result.push({ dirName, projectPath });
      }
    }
    return result;
  }

  /** Whether a transcript of the prefix-matched `dirName` belongs to
   *  `projectPath`. The cwd of each transcript is cached by its
   *  `(path, mtime, size)`, so a transcript that changes is read again. */
  private async longDirBelongsTo(dirName: string, projectPath: string): Promise<boolean> {
    const dir = path.join(projectsRoot(), dirName);
    for (const name of await this.listings.names(dir)) {
      if (!name.endsWith(".jsonl")) continue;
      const filePath = path.join(dir, name);
      try {
        const stats = await fs.stat(filePath);
        if (!stats.isFile()) continue;
        let cached = this.transcriptCwds.get(filePath);
        if (!cached || cached.mtimeMs !== stats.mtimeMs || cached.size !== stats.size) {
          cached = {
            mtimeMs: stats.mtimeMs,
            size: stats.size,
            cwd: transcriptProjectCwd(await readHeadTail(filePath, stats.size)),
          };
          this.transcriptCwds.set(filePath, cached);
        }
        if (cached.cwd && sameProjectPath(cached.cwd, projectPath)) return true;
      } catch {
        // Gone or unreadable: look at the next one.
      }
    }
    return false;
  }

  /** Every non-empty transcript file of `paths` (without, of all projects),
   *  every copy of a session: a list shows the newest one that has a row
   *  (see {@link collectRows}), as the SDK does. */
  async enumerateFiles(paths?: readonly string[]): Promise<TranscriptCandidate[]> {
    const root = projectsRoot();
    const dirs: { dirName: string; projectPath?: string }[] = paths
      ? await this.projectDirs(paths)
      : (await this.listings.names(root)).map((dirName) => ({ dirName }));
    // All directories' names first, then one bounded run of stats.
    const listed = await this.listings.namesOfAll(
      dirs.map(({ dirName }) => path.join(root, dirName)),
    );
    const files = dirs.flatMap(({ dirName, projectPath }, i) =>
      listed[i]!.filter((name) => name.endsWith(".jsonl") && isSessionId(name.slice(0, -6))).map(
        (name) => ({ name, filePath: path.join(root, dirName, name), dirName, projectPath }),
      ),
    );
    const stats = await statFiles(files.map(({ filePath }) => filePath));
    const all: TranscriptCandidate[] = [];
    files.forEach(({ name, filePath, dirName, projectPath }, i) => {
      const fileStats = stats[i];
      if (!fileStats?.isFile() || fileStats.size === 0) return;
      all.push({
        sessionId: name.slice(0, -6),
        filePath,
        dirName,
        projectPath,
        mtimeMs: fileStats.mtimeMs,
        size: fileStats.size,
        ino: fileStats.ino,
      });
    });
    return all;
  }

  /**
   * Every transcript (with its size) and every `<sessionId>/` directory
   * (sidecar, subagent transcripts) of the session, in any project
   * directory, by the exact id. One pass over the (cached) project directory
   * listings.
   */
  async scanSession(
    sessionId: string,
  ): Promise<{ transcripts: { filePath: string; size: number }[]; sessionDirs: string[] }> {
    if (!isSessionId(sessionId)) return { transcripts: [], sessionDirs: [] };
    const root = projectsRoot();
    const dirs = (await this.listings.names(root)).map((dirName) => path.join(root, dirName));
    const listed = await this.listings.namesOfAll(dirs);
    const transcriptName = `${sessionId}.jsonl`;
    const transcriptPaths = dirs.flatMap((dir, i) =>
      listed[i]!.includes(transcriptName) ? [path.join(dir, transcriptName)] : [],
    );
    const dirPaths = dirs.flatMap((dir, i) =>
      listed[i]!.includes(sessionId) ? [path.join(dir, sessionId)] : [],
    );
    const [transcriptStats, dirStats] = await Promise.all([
      statFiles(transcriptPaths),
      Promise.all(dirPaths.map((dir) => fs.lstat(dir).catch(() => undefined))),
    ]);
    return {
      transcripts: transcriptPaths.flatMap((filePath, i) => {
        const stats = transcriptStats[i];
        return stats?.isFile() ? [{ filePath, size: stats.size }] : [];
      }),
      sessionDirs: dirPaths.filter((_, i) => dirStats[i]?.isDirectory()),
    };
  }

  /** Every transcript file of `sessionId` (see {@link scanSession}). Empty
   *  files only with `includeEmpty`. */
  async findTranscripts(
    sessionId: string,
    options: { includeEmpty?: boolean } = {},
  ): Promise<string[]> {
    const { transcripts } = await this.scanSession(sessionId);
    return transcripts
      .filter(({ size }) => size > 0 || options.includeEmpty)
      .map(({ filePath }) => filePath);
  }

  /** Every `<sessionId>/` directory of the session (see {@link scanSession}). */
  async findSessionDirs(sessionId: string): Promise<string[]> {
    return (await this.scanSession(sessionId)).sessionDirs;
  }

  /** Whether `candidate` was read at its stat: its metadata is cached, also
   *  when it holds no row. False after a failed read. */
  isRead(candidate: TranscriptCandidate): boolean {
    const cached = this.metadata.peek(candidate.filePath);
    return (
      cached !== undefined &&
      cached.mtimeMs === candidate.mtimeMs &&
      cached.size === candidate.size &&
      cached.ino === candidate.ino
    );
  }

  /** The session that the cached metadata of `filePath` says it was
   *  continued in. */
  continuedIn(filePath: string): string | undefined {
    return this.metadata.peek(filePath)?.metadata?.continuedIn;
  }

  /** Drops the cached metadata of `filePaths`. */
  invalidate(filePaths: readonly string[]): void {
    for (const filePath of filePaths) this.metadata.delete(filePath);
  }

  /** One page of rows, plus whether more rows follow the page. */
  async list(query: ListQuery): Promise<{ rows: IndexRow[]; hasMore: boolean }> {
    const paths = query.cwd
      ? await this.listedPaths(query.cwd, query.includeWorktrees ?? false)
      : undefined;
    const after = query.after;
    const enumerated = (await this.enumerateFiles(paths)).sort(byMtimeDescending);
    // A page after a cursor skips, without reading them, the sessions whose
    // newest transcript has a cached order key before the cursor. The
    // archive state comes from the title, so the archive filter applies once
    // a transcript is read.
    const skipped = new Set<string>();
    const seen = new Set<string>();
    for (const candidate of enumerated) {
      if (seen.has(candidate.sessionId)) continue;
      seen.add(candidate.sessionId);
      if (after && this.cachedBefore(candidate, after)) skipped.add(candidate.sessionId);
    }
    const candidates = enumerated.filter((candidate) => !skipped.has(candidate.sessionId));
    // One row more than the page tells whether a next page exists, so a
    // cursor never leads to an empty page.
    const rows = await this.collectRows(candidates, {
      inScope: scopeOf(paths),
      archived: query.archived,
      after,
      wanted: query.limit + 1,
      unread: (read) => enumerated.filter((candidate) => !read.has(candidate)),
    });
    return { rows: rows.slice(0, query.limit), hasMore: rows.length > query.limit };
  }

  /**
   * The rows of `candidates`, one per session (its newest transcript that has
   * a row), any archive state, as a list of `paths` shows them: a candidate
   * without a row (no title, a sidechain, continued elsewhere, another path
   * that shares the project directory) is left out. `siblings` are the other
   * transcripts of the candidates' directories, read only when a candidate
   * has no cwd of its own. The metadata cache makes an unchanged transcript
   * free.
   */
  async rowsOf(
    paths: readonly string[],
    candidates: readonly TranscriptCandidate[],
    siblings: () => readonly TranscriptCandidate[],
  ): Promise<IndexRow[]> {
    return this.collectRows(candidates, {
      inScope: scopeOf(paths),
      archived: "all",
      wanted: Infinity,
      unread: (read) => siblings().filter((candidate) => !read.has(candidate)),
    });
  }

  /**
   * The rows of `candidates` (as {@link rowsOf}) that the metadata cache
   * alone gives, read from it at once, and the ids of the sessions it gives
   * no answer for: a transcript of it has nothing cached at its stat, no cwd
   * known, or is continued in another session (whether the successor hides
   * it depends on the successor now). Reads no transcript.
   */
  async cachedRowsOf(
    paths: readonly string[],
    candidates: readonly TranscriptCandidate[],
  ): Promise<{ rows: IndexRow[]; unknown: Set<string> }> {
    const unknown = new Set<string>();
    const resolved: { item: Resolved; cwd: string }[] = [];
    for (const candidate of candidates) {
      const id = candidate.sessionId;
      const cached = this.metadata.peek(candidate.filePath);
      if (
        !cached ||
        cached.mtimeMs !== candidate.mtimeMs ||
        cached.size !== candidate.size ||
        cached.ino !== candidate.ino ||
        cached.metadata?.continuedIn
      ) {
        unknown.add(id);
        continue;
      }
      if (!cached.metadata) continue;
      const cwd = cached.metadata.fileCwd ?? this.fallbackCwd(candidate);
      if (cwd) resolved.push({ item: { candidate, metadata: cached.metadata }, cwd });
      else unknown.add(id);
    }
    const inScope = scopeOf(paths);
    const newest = new Map<string, { row: IndexRow; mtimeMs: number }>();
    for (const { item, cwd } of resolved) {
      const id = item.candidate.sessionId;
      if (unknown.has(id) || !(await inScope(item.candidate, item.metadata))) continue;
      const previous = newest.get(id);
      if (previous && previous.mtimeMs >= item.candidate.mtimeMs) continue;
      newest.set(id, { row: toRow(item, cwd), mtimeMs: item.candidate.mtimeMs });
    }
    return { rows: [...newest.values()].map(({ row }) => row), unknown };
  }

  /**
   * Reads `candidates` in order into rows, one per session, sorted. A
   * session copied to several transcripts shows its newest one that has a
   * row, as the SDK list does. With a finite `wanted`, stops once `wanted`
   * rows are certain to come first (a candidate's order key is at most its
   * mtime, so `candidates` must be in mtime order then).
   */
  private async collectRows(
    candidates: readonly TranscriptCandidate[],
    options: {
      inScope: (candidate: TranscriptCandidate, metadata: TranscriptMetadata) => Promise<boolean>;
      /** The rows kept by archive state. */
      archived: ArchivedFilter;
      after?: ListCursor;
      wanted: number;
      /** The transcripts not read, which may supply a sibling's cwd. */
      unread: (read: ReadonlySet<TranscriptCandidate>) => readonly TranscriptCandidate[];
    },
  ): Promise<IndexRow[]> {
    const { inScope, archived, after, wanted } = options;
    /** The row of each session (null: left out by the archive filter or
     *  the cursor), and the mtime of the transcript it is from. */
    const bySession = new Map<string, { row: IndexRow | null; mtimeMs: number }>();
    const rows = () =>
      [...bySession.values()].flatMap(({ row }) => (row ? [row] : [])).sort(compareRows);
    // Read transcripts without a cwd of their own: a sibling of the same
    // directory may supply it, whichever batch it is read in.
    let pending: Resolved[] = [];
    const accept = async (resolved: Resolved, cwd: string) => {
      // The SDK leaves out another path that encodes to the same project
      // directory (see scopeOf).
      if (!(await inScope(resolved.candidate, resolved.metadata))) return;
      const { sessionId, mtimeMs } = resolved.candidate;
      const previous = bySession.get(sessionId);
      if (previous && previous.mtimeMs >= mtimeMs) return;
      const row = toRow(resolved, cwd);
      // A newer copy that the filter or the cursor leaves out still hides
      // an older one.
      const kept = archivedFilterKeeps(archived, row.archived) && (!after || isAfter(row, after));
      bySession.set(sessionId, { row: kept ? row : null, mtimeMs });
    };
    const settlePending = async () => {
      const left: Resolved[] = [];
      for (const resolved of pending) {
        const cwd = this.fallbackCwd(resolved.candidate);
        if (cwd) await accept(resolved, cwd);
        else left.push(resolved);
      }
      pending = left;
    };
    const read = new Set<TranscriptCandidate>();
    let index = 0;
    while (index < candidates.length) {
      if (bySession.size >= wanted) {
        const sorted = rows();
        // A candidate's order key is at most its mtime.
        if (sorted.length >= wanted && candidates[index]!.mtimeMs < sorted[wanted - 1]!.orderAtMs) {
          break;
        }
      }
      const batch = candidates.slice(index, index + READ_BATCH_SIZE);
      index += batch.length;
      const resolved = await Promise.all(
        batch.map(async (candidate) => {
          read.add(candidate);
          const metadata = await this.metadataOf(candidate);
          if (!metadata || (await this.continuedElsewhere(candidate, metadata))) return undefined;
          return { candidate, metadata };
        }),
      );
      for (const item of resolved) {
        if (!item) continue;
        const cwd = item.metadata.fileCwd ?? this.fallbackCwd(item.candidate);
        if (cwd) await accept(item, cwd);
        else pending.push(item);
      }
      await settlePending();
    }
    if (pending.length > 0) {
      // A row recovered after the scan stopped still sorts into the page: it
      // was read before the stop, and more rows only raise the bound. A
      // sibling that the archive filter or the cursor leaves out may still
      // supply the cwd.
      await this.learnDirCwds(
        new Set(pending.map(({ candidate }) => candidate.dirName)),
        options.unread(read),
      );
      await settlePending();
    }
    return rows();
  }

  /** Whether the cached metadata of `candidate`, still current, places it
   *  at or before `cursor`. */
  private cachedBefore(candidate: TranscriptCandidate, cursor: ListCursor): boolean {
    const cached = this.metadata.peek(candidate.filePath);
    if (
      !cached?.metadata ||
      cached.mtimeMs !== candidate.mtimeMs ||
      cached.size !== candidate.size ||
      cached.ino !== candidate.ino
    ) {
      return false;
    }
    const { metadata } = cached;
    const orderAtMs = Math.min(
      metadata.facts.lastPromptAt ?? metadata.updatedAtMs,
      metadata.updatedAtMs,
    );
    return !isAfter({ orderAtMs, sessionId: candidate.sessionId }, cursor);
  }

  /** Reads the unread transcripts of `dirNames` until each directory has a
   *  known cwd, at most {@link MAX_CWD_PROBES_PER_DIR} per directory. A
   *  directory that gives none is not read again for a while, unless it
   *  changes. */
  private async learnDirCwds(
    dirNames: ReadonlySet<string>,
    unread: readonly TranscriptCandidate[],
  ): Promise<void> {
    const root = projectsRoot();
    const now = Date.now();
    const mtimes = new Map<string, number>();
    for (const dirName of dirNames) {
      const mtimeMs = await fs.stat(path.join(root, dirName)).then(
        (stats) => stats.mtimeMs,
        () => undefined,
      );
      if (mtimeMs === undefined) continue;
      const known = this.dirsWithoutCwd.get(dirName);
      if (known && known.mtimeMs === mtimeMs && now - known.at < NO_CWD_RETRY_MS) continue;
      mtimes.set(dirName, mtimeMs);
    }
    const probes = new Map<string, number>();
    let remaining = unread.filter((candidate) => {
      if (!mtimes.has(candidate.dirName)) return false;
      const count = probes.get(candidate.dirName) ?? 0;
      if (count >= MAX_CWD_PROBES_PER_DIR) return false;
      probes.set(candidate.dirName, count + 1);
      return true;
    });
    while (remaining.length > 0) {
      remaining = remaining.filter((candidate) => !this.dirCwds.has(candidate.dirName));
      const batch = remaining.slice(0, READ_BATCH_SIZE);
      remaining = remaining.slice(batch.length);
      await Promise.all(batch.map((candidate) => this.metadataOf(candidate)));
    }
    for (const [dirName, mtimeMs] of mtimes) {
      if (!this.dirCwds.has(dirName)) this.dirsWithoutCwd.set(dirName, { mtimeMs, at: now });
    }
  }

  /** The requested path of the directory, else a sibling's cwd. */
  private fallbackCwd(candidate: TranscriptCandidate): string | undefined {
    // A directory found for the requested path belongs to it, also one that
    // differs in case only (see caseInsensitiveProjectDir).
    if (
      candidate.projectPath &&
      (projectDirMatches(candidate.dirName, candidate.projectPath) ||
        isExactProjectDir(candidate.dirName, candidate.projectPath))
    ) {
      return candidate.projectPath;
    }
    return this.dirCwds.get(candidate.dirName);
  }

  private async metadataOf(candidate: TranscriptCandidate): Promise<TranscriptMetadata | null> {
    const cached = this.metadata.get(candidate.filePath);
    if (
      cached &&
      cached.mtimeMs === candidate.mtimeMs &&
      cached.size === candidate.size &&
      cached.ino === candidate.ino
    ) {
      if (cached.metadata?.fileCwd) this.dirCwds.set(candidate.dirName, cached.metadata.fileCwd);
      return cached.metadata;
    }
    const key = `${candidate.mtimeMs}:${candidate.size}:${candidate.ino}`;
    const inFlight = this.reading.get(candidate.filePath);
    if (inFlight?.key === key) return inFlight.promise;
    const promise = this.readAndCache(candidate, cached);
    this.reading.set(candidate.filePath, { key, promise });
    void promise.finally(() => {
      if (this.reading.get(candidate.filePath)?.promise === promise) {
        this.reading.delete(candidate.filePath);
      }
    });
    return promise;
  }

  private async readAndCache(
    candidate: TranscriptCandidate,
    cached: CacheEntry | undefined,
  ): Promise<TranscriptMetadata | null> {
    let metadata: TranscriptMetadata | null;
    try {
      // The transcript grew since: an earlier scan may still know its last
      // prompt.
      metadata = await this.readMetadata(
        candidate,
        cached && cached.ino === candidate.ino
          ? { ...cached.metadata?.facts, size: cached.size }
          : undefined,
      );
    } catch {
      // Unreadable now (deleted, permissions): skip it and retry next time.
      return null;
    }
    this.metadata.set(candidate.filePath, {
      mtimeMs: candidate.mtimeMs,
      size: candidate.size,
      ino: candidate.ino,
      metadata,
    });
    return metadata;
  }

  private async readMetadata(
    candidate: TranscriptCandidate,
    previous?: PreviousScan,
  ): Promise<TranscriptMetadata | null> {
    const headTail = await readHeadTail(candidate.filePath, candidate.size);
    if (isSidechainTranscript(headTail.head)) return null;
    const facts = await scanTranscriptFile(
      candidate.filePath,
      candidate.size,
      headTail,
      previous,
      candidate.ino,
    );
    if (!facts.hasMessages) return null;
    // The last relocation names the session's cwd, as the SDK reads it; the
    // messages before it keep the old one.
    const fileCwd = await this.recoverCwd(candidate.dirName, [
      relocatedCwd(headTail.tail),
      facts.headCwd,
      ...(facts.tailCwd ? pathAndAncestors(facts.tailCwd) : []),
    ]);
    if (fileCwd) this.dirCwds.set(candidate.dirName, fileCwd);
    const { customTitle, summary } = await this.titlesOf(candidate, headTail, fileCwd);
    // No title at all: the SDK does not list it either.
    if (!summary) return null;
    // Archived by its name alone.
    const archived = isArchivedTitle(customTitle);
    // A last message longer than the tail search still ends with its
    // timestamp; the mtime moves with every metadata record.
    const lastMessageAt =
      facts.lastMessageAt ??
      (await lastTimestamp(candidate.filePath, candidate.size)) ??
      candidate.mtimeMs;
    const continuedIn = continuedInSessionId(headTail.tail);
    const projectCwd = transcriptProjectCwd(headTail);
    return {
      title: sanitizeTitle(archived ? visibleTitle(summary) : summary),
      archived,
      ...(fileCwd && { fileCwd }),
      ...(projectCwd && { projectCwd }),
      ...(continuedIn && { continuedIn }),
      updatedAtMs: Math.min(lastMessageAt, candidate.mtimeMs),
      facts,
    };
  }

  /**
   * The titles the SDK reports for the listed transcript (`customTitle` and
   * `summary` of `getSessionInfo`). The SDK reads the first copy of the
   * session that its search finds; its answer is used only when that copy is
   * the listed file (same size and mtime), else the same titles are taken
   * from the listed file itself (see {@link sdkTitles}).
   */
  private async titlesOf(
    candidate: TranscriptCandidate,
    headTail: HeadTail,
    fileCwd: string | undefined,
  ): Promise<SdkTitles> {
    const dir = [fileCwd, candidate.projectPath].find(
      (cwd) => cwd !== undefined && isExactProjectDir(candidate.dirName, cwd),
    );
    const info = await this.getSessionInfo(candidate.sessionId, dir ? { dir } : {}).catch(
      () => undefined,
    );
    if (
      info &&
      info.fileSize === candidate.size &&
      info.lastModified === Math.trunc(candidate.mtimeMs)
    ) {
      return { customTitle: info.customTitle, summary: info.summary };
    }
    const sidecar =
      tailCustomTitle(headTail.tail) === undefined
        ? await readSidecarTitle(candidate.filePath, candidate.sessionId)
        : undefined;
    return sdkTitles(headTail, sidecar);
  }

  /** Whether a successor of a continued transcript holds history: the SDK
   *  list then hides the predecessor. */
  private async continuedElsewhere(candidate: TranscriptCandidate, metadata: TranscriptMetadata) {
    if (!metadata.continuedIn) return false;
    return hasHistory(path.join(path.dirname(candidate.filePath), `${metadata.continuedIn}.jsonl`));
  }

  /** The first candidate that encodes to `dirName`, or, on macOS, that
   *  encodes to a name the file system resolves to `dirName` (it differs in
   *  case only). A directory name is never decoded. */
  private async recoverCwd(
    dirName: string,
    candidates: (string | undefined)[],
  ): Promise<string | undefined> {
    for (const candidate of candidates) {
      if (!candidate || !path.isAbsolute(candidate)) continue;
      if (projectDirMatches(dirName, candidate)) return candidate;
      if (isExactProjectDir(dirName, candidate) && (await sameDirOnDisk(dirName, candidate))) {
        return candidate;
      }
    }
    return undefined;
  }
}
