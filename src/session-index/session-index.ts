/**
 * The session list of a `sessionIndex` client.
 *
 * Each list enumerates the transcripts of the requested cwd and of every
 * worktree of its repository: one `readdir` per project directory and one
 * `stat` per transcript, no long-lived cache. The metadata of a transcript is
 * cached by `(path, mtime, size)` in an LRU and read on a miss with the SDK
 * `getSessionInfo` (titles, sidecar, branch) plus one head and tail read for
 * what the SDK does not report (see {@link scanTranscript}). Misses are read in
 * parallel batches.
 *
 * Order is `updatedAt` descending, then session id. `updatedAt` is the time
 * of the last message, capped at the transcript mtime, so a rename or another
 * metadata record does not move a session up. Candidates are read in mtime
 * order: a candidate's `updatedAt` is at most its mtime, so the scan stops as
 * soon as the page is full and the next mtime is older than the last row.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { SDKSessionInfo } from "@anthropic-ai/claude-agent-sdk";
import { sanitizeTitle } from "../session-titles.js";
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
  hasTailCustomTitle,
  isSidechainTranscript,
  readHeadTail,
  scanTranscriptFile,
  titleFields,
  transcriptProjectCwd,
  type HeadTail,
  type TitleFields,
  type TranscriptFacts,
} from "./transcript-scan.js";
import { worktreeCounterparts } from "./worktrees.js";

export const DEFAULT_LIST_LIMIT = 50;
export const MAX_LIST_LIMIT = 200;
const METADATA_CACHE_SIZE = 2000;
const READ_BATCH_SIZE = 16;
/** Transcripts read at most per directory to recover a sibling's cwd. */
const MAX_CWD_PROBES_PER_DIR = 64;
/** How long a directory that gave no cwd is not probed again. */
const NO_CWD_RETRY_MS = 60_000;

/** Whether a list includes archived sessions: `false` lists the unarchived
 *  ones only, `true` all of them in one order (ACP RFD #2161). */
export type ArchivedFilter = boolean;

/** One transcript file found by the enumeration. */
export type TranscriptCandidate = {
  sessionId: string;
  filePath: string;
  dirName: string;
  /** The requested path (cwd or worktree) whose project directory this is. */
  projectPath?: string;
  mtimeMs: number;
  size: number;
};

/** The cached metadata of one transcript. */
type TranscriptMetadata = {
  title: string;
  gitBranch?: string;
  /** The cwd read from the transcript, when it encodes to the directory name. */
  fileCwd?: string;
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
  gitBranch?: string;
  facts: TranscriptFacts;
  mtimeMs: number;
  archived: boolean;
};

export type ListCursor = { updatedAtMs: number; sessionId: string };

export type ListQuery = {
  cwd?: string | null;
  /** Also list the sessions of the existing linked worktrees of `cwd`. */
  includeWorktrees?: boolean;
  limit: number;
  archived: ArchivedFilter;
  after?: ListCursor;
  archivedIds: ReadonlySet<string>;
};

export type GetSessionInfo = (
  sessionId: string,
  options: { dir?: string },
) => Promise<SDKSessionInfo | undefined>;

type CacheEntry = { mtimeMs: number; size: number; metadata: TranscriptMetadata | null };

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
}

function compareRows(a: { updatedAtMs: number; sessionId: string }, b: typeof a): number {
  if (a.updatedAtMs !== b.updatedAtMs) return b.updatedAtMs - a.updatedAtMs;
  return a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0;
}

type Resolved = { candidate: TranscriptCandidate; metadata: TranscriptMetadata };

function toRow({ candidate, metadata }: Resolved, cwd: string, archived: boolean): IndexRow {
  return {
    archived,
    sessionId: candidate.sessionId,
    cwd,
    title: metadata.title,
    updatedAtMs: metadata.updatedAtMs,
    gitBranch: metadata.gitBranch,
    facts: metadata.facts,
    mtimeMs: candidate.mtimeMs,
  };
}

function isAfter(row: { updatedAtMs: number; sessionId: string }, cursor: ListCursor): boolean {
  return compareRows(row, cursor) > 0;
}

/** The title of the CLI's `custom-title.json` sidecar of a transcript. */
async function readSidecarTitle(filePath: string, sessionId: string): Promise<string | undefined> {
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

/** A path as the file system compares it: case-insensitive on macOS and
 *  Windows, as the SDK assumes there. */
function comparable(value: string): string {
  const normalized = normalizePath(value);
  return process.platform === "darwin" || process.platform === "win32"
    ? normalized.toLowerCase()
    : normalized;
}

/** Whether a row cwd is one of `paths` (every cwd is without `paths`): the
 *  same path, or one that resolves to it through symlinks. */
function scopeOf(paths: readonly string[] | undefined): (cwd: string) => Promise<boolean> {
  if (!paths) return async () => true;
  const wanted = new Set(paths.map(comparable));
  const resolved = new Map<string, Promise<boolean>>();
  return (cwd) => {
    if (wanted.has(comparable(cwd))) return Promise.resolve(true);
    let result = resolved.get(cwd);
    if (!result) {
      result = canonicalPath(cwd).then((real) => wanted.has(comparable(real)));
      resolved.set(cwd, result);
    }
    return result;
  };
}

async function readDirNames(dir: string): Promise<string[]> {
  try {
    return await fs.readdir(dir);
  } catch {
    return [];
  }
}

export class SessionIndex {
  private readonly metadata = new Lru<string, CacheEntry>(METADATA_CACHE_SIZE);
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
    const rootEntries = await readDirNames(projectsRoot());
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
    for (const name of await readDirNames(dir)) {
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

  /** Every non-empty transcript of `cwd` (with `includeWorktrees` also of
   *  its worktrees; without a cwd, of all projects), one per session id: the
   *  larger file wins. */
  async enumerate(paths?: readonly string[]): Promise<TranscriptCandidate[]> {
    const root = projectsRoot();
    const dirs: { dirName: string; projectPath?: string }[] = paths
      ? await this.projectDirs(paths)
      : (await readDirNames(root)).map((dirName) => ({ dirName }));
    const perDir = await Promise.all(
      dirs.map(async ({ dirName, projectPath }) => {
        const dir = path.join(root, dirName);
        const names = (await readDirNames(dir)).filter(
          (name) => name.endsWith(".jsonl") && isSessionId(name.slice(0, -6)),
        );
        const stats = await Promise.all(
          names.map(async (name): Promise<TranscriptCandidate | undefined> => {
            const filePath = path.join(dir, name);
            try {
              const stats = await fs.stat(filePath);
              if (!stats.isFile() || stats.size === 0) return undefined;
              return {
                sessionId: name.slice(0, -6),
                filePath,
                dirName,
                projectPath,
                mtimeMs: stats.mtimeMs,
                size: stats.size,
              };
            } catch {
              return undefined;
            }
          }),
        );
        return stats.filter((value): value is TranscriptCandidate => value !== undefined);
      }),
    );
    const bySession = new Map<string, TranscriptCandidate>();
    for (const candidate of perDir.flat()) {
      const key = candidate.sessionId.toLowerCase();
      const previous = bySession.get(key);
      if (!previous || candidate.size > previous.size) bySession.set(key, candidate);
    }
    return [...bySession.values()];
  }

  /** Every transcript file of `sessionId`, in any project directory and in
   *  any spelling of the id (each project directory is read): the CLI names
   *  files by the id as it was given. Empty files only with `includeEmpty`.
   *  `exactSpelling` looks for the id as given only, like the SDK. */
  async findTranscripts(
    sessionId: string,
    options: { includeEmpty?: boolean; exactSpelling?: boolean } = {},
  ): Promise<string[]> {
    if (!isSessionId(sessionId)) return [];
    const root = projectsRoot();
    const wanted = `${sessionId}.jsonl`;
    const lower = wanted.toLowerCase();
    const found = await Promise.all(
      (await readDirNames(root)).map(async (dirName) => {
        const dir = path.join(root, dirName);
        const names = options.exactSpelling
          ? [wanted]
          : (await readDirNames(dir)).filter((name) => name.toLowerCase() === lower);
        return Promise.all(
          names.map(async (name) => {
            const filePath = path.join(dir, name);
            try {
              const stats = await fs.stat(filePath);
              return stats.isFile() && (stats.size > 0 || options.includeEmpty)
                ? filePath
                : undefined;
            } catch {
              return undefined;
            }
          }),
        );
      }),
    );
    return found.flat().filter((value): value is string => value !== undefined);
  }

  /** Every `<sessionId>/` directory (sidecar, subagent transcripts) of the
   *  session, in any project directory and any spelling of the id, with or
   *  without a transcript. */
  async findSessionDirs(sessionId: string): Promise<string[]> {
    if (!isSessionId(sessionId)) return [];
    const root = projectsRoot();
    const lower = sessionId.toLowerCase();
    const found = await Promise.all(
      (await readDirNames(root)).map(async (dirName) => {
        const dir = path.join(root, dirName);
        const names = (await readDirNames(dir)).filter((name) => name.toLowerCase() === lower);
        return Promise.all(
          names.map(async (name) => {
            try {
              return (await fs.lstat(path.join(dir, name))).isDirectory()
                ? path.join(dir, name)
                : undefined;
            } catch {
              return undefined;
            }
          }),
        );
      }),
    );
    return found.flat().filter((value): value is string => value !== undefined);
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
    const inScope = scopeOf(paths);
    const candidates = (await this.enumerate(paths))
      .filter(
        (candidate) => query.archived || !query.archivedIds.has(candidate.sessionId.toLowerCase()),
      )
      .sort((a, b) =>
        a.mtimeMs !== b.mtimeMs
          ? b.mtimeMs - a.mtimeMs
          : a.sessionId < b.sessionId
            ? -1
            : a.sessionId > b.sessionId
              ? 1
              : 0,
      );
    // One row more than the page tells whether a next page exists, so a
    // cursor never leads to an empty page.
    const wanted = query.limit + 1;
    const rows: IndexRow[] = [];
    // Read transcripts without a cwd of their own: a sibling of the same
    // directory may supply it, whichever batch it is read in.
    let pending: Resolved[] = [];
    const accept = async (resolved: Resolved, cwd: string) => {
      // Another path that encodes to the same project directory is not this
      // cwd (`/a/b` and `/a-b`).
      if (!(await inScope(cwd))) return;
      const row = toRow(
        resolved,
        cwd,
        query.archivedIds.has(resolved.candidate.sessionId.toLowerCase()),
      );
      if (!query.after || isAfter(row, query.after)) rows.push(row);
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
      if (rows.length >= wanted) {
        rows.sort(compareRows);
        if (candidates[index]!.mtimeMs < rows[wanted - 1]!.updatedAtMs) break;
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
      // was read before the stop, and more rows only raise the bound.
      await this.learnDirCwds(
        new Set(pending.map(({ candidate }) => candidate.dirName)),
        candidates.filter((candidate) => !read.has(candidate)),
      );
      await settlePending();
    }
    rows.sort(compareRows);
    return { rows: rows.slice(0, query.limit), hasMore: rows.length > query.limit };
  }

  /** The `sessionId:mtime:size` of every transcript that a list of `cwd`
   *  shows, archived or not, for the change hint: a transcript of another
   *  path that shares a project directory does not count. A transcript
   *  whose cwd is unknown counts. */
  async scopeFingerprint(cwd: string, includeWorktrees: boolean): Promise<string[]> {
    const paths = await this.listedPaths(cwd, includeWorktrees);
    const inScope = scopeOf(paths);
    const parts = await Promise.all(
      (await this.enumerate(paths)).map(async (candidate) => {
        const metadata = await this.metadataOf(candidate);
        const rowCwd = metadata?.fileCwd ?? this.fallbackCwd(candidate);
        if (rowCwd && !(await inScope(rowCwd))) return undefined;
        return `${candidate.sessionId}:${candidate.mtimeMs}:${candidate.size}`;
      }),
    );
    return parts.filter((part): part is string => part !== undefined).sort();
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
    if (cached && cached.mtimeMs === candidate.mtimeMs && cached.size === candidate.size) {
      if (cached.metadata?.fileCwd) this.dirCwds.set(candidate.dirName, cached.metadata.fileCwd);
      return cached.metadata;
    }
    let metadata: TranscriptMetadata | null;
    try {
      metadata = await this.readMetadata(candidate);
    } catch {
      // Unreadable now (deleted, permissions): skip it and retry next time.
      return null;
    }
    this.metadata.set(candidate.filePath, {
      mtimeMs: candidate.mtimeMs,
      size: candidate.size,
      metadata,
    });
    return metadata;
  }

  private async readMetadata(candidate: TranscriptCandidate): Promise<TranscriptMetadata | null> {
    const headTail = await readHeadTail(candidate.filePath, candidate.size);
    if (isSidechainTranscript(headTail.head)) return null;
    const facts = await scanTranscriptFile(
      candidate.filePath,
      candidate.size,
      candidate.sessionId,
      headTail,
    );
    if (!facts.hasMessages) return null;
    const fileCwd = await this.recoverCwd(candidate.dirName, [
      facts.headCwd,
      ...(facts.tailCwd ? pathAndAncestors(facts.tailCwd) : []),
    ]);
    if (fileCwd) this.dirCwds.set(candidate.dirName, fileCwd);
    const { summary, gitBranch } = await this.titleOf(candidate, headTail, fileCwd);
    // No title at all: the SDK does not list it either.
    if (!summary) return null;
    const lastMessageAt = facts.lastMessageAt ?? candidate.mtimeMs;
    const continuedIn = continuedInSessionId(headTail.tail);
    return {
      title: sanitizeTitle(summary),
      ...(gitBranch && { gitBranch }),
      ...(fileCwd && { fileCwd }),
      ...(continuedIn && { continuedIn }),
      updatedAtMs: Math.min(lastMessageAt, candidate.mtimeMs),
      facts,
    };
  }

  /**
   * The title and branch of the listed transcript. The SDK `getSessionInfo`
   * reads the first copy of the session that its search finds; its answer is
   * used only when that copy is the listed file (same size and mtime), else
   * the fields come from the listed file itself.
   */
  private async titleOf(
    candidate: TranscriptCandidate,
    headTail: HeadTail,
    fileCwd: string | undefined,
  ): Promise<TitleFields> {
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
      return {
        summary: info.summary,
        ...(info.gitBranch && { gitBranch: info.gitBranch }),
      };
    }
    const sidecar = hasTailCustomTitle(headTail.tail)
      ? undefined
      : await readSidecarTitle(candidate.filePath, candidate.sessionId);
    return titleFields(headTail, sidecar);
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
