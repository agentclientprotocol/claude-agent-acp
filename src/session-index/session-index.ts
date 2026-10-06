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
  isSessionId,
  pathAndAncestors,
  projectDirMatches,
  projectDirsOf,
  projectsRoot,
  sameProjectPath,
} from "./project-dirs.js";
import {
  readHeadTail,
  scanTranscriptFile,
  transcriptProjectCwd,
  type TranscriptFacts,
} from "./transcript-scan.js";
import { repositoryWorktrees } from "./worktrees.js";

export const DEFAULT_LIST_LIMIT = 50;
export const MAX_LIST_LIMIT = 200;
const METADATA_CACHE_SIZE = 2000;
const READ_BATCH_SIZE = 16;

export type ArchivedFilter = "exclude" | "only";

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
};

export type ListCursor = { updatedAtMs: number; sessionId: string };

export type ListQuery = {
  cwd?: string | null;
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

function toRow({ candidate, metadata }: Resolved, cwd: string): IndexRow {
  return {
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
  /** Whether a prefix-matched long project directory belongs to a path. */
  private readonly longDirOwners = new Map<string, { mtimeMs: number; belongs: boolean }>();

  constructor(private readonly getSessionInfo: GetSessionInfo) {}

  /** The paths whose sessions a list of `cwd` shows: `cwd` and every existing
   *  worktree of its repository. */
  async listedPaths(cwd: string): Promise<string[]> {
    const canonical = await canonicalPath(cwd);
    return [...new Set([canonical, ...(await repositoryWorktrees(canonical))])];
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
      for (const dirName of projectDirsOf(projectPath, rootEntries)) {
        if (seen.has(dirName)) continue;
        if (
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
   *  `projectPath`. A match is cached for good; a miss until the directory
   *  changes. */
  private async longDirBelongsTo(dirName: string, projectPath: string): Promise<boolean> {
    const dir = path.join(projectsRoot(), dirName);
    const key = `${dirName}\0${projectPath}`;
    let mtimeMs: number;
    try {
      mtimeMs = (await fs.stat(dir)).mtimeMs;
    } catch {
      return false;
    }
    const cached = this.longDirOwners.get(key);
    if (cached && (cached.belongs || cached.mtimeMs === mtimeMs)) return cached.belongs;
    let belongs = false;
    for (const name of await readDirNames(dir)) {
      if (!name.endsWith(".jsonl")) continue;
      const filePath = path.join(dir, name);
      try {
        const stats = await fs.stat(filePath);
        if (!stats.isFile()) continue;
        const cwd = transcriptProjectCwd(await readHeadTail(filePath, stats.size));
        if (cwd && sameProjectPath(cwd, projectPath)) {
          belongs = true;
          break;
        }
      } catch {
        // Gone or unreadable: look at the next one.
      }
    }
    this.longDirOwners.set(key, { mtimeMs, belongs });
    return belongs;
  }

  /** Every non-empty transcript of `cwd` and its worktrees (or of all
   *  projects without a cwd), one per session id: the larger file wins. */
  async enumerate(cwd?: string | null): Promise<TranscriptCandidate[]> {
    const root = projectsRoot();
    const dirs: { dirName: string; projectPath?: string }[] = cwd
      ? await this.projectDirs(await this.listedPaths(cwd))
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

  /** Every transcript file of `sessionId`, in any project directory. Empty
   *  files only with `includeEmpty`. */
  async findTranscripts(
    sessionId: string,
    options: { includeEmpty?: boolean } = {},
  ): Promise<string[]> {
    if (!isSessionId(sessionId)) return [];
    const root = projectsRoot();
    const found = await Promise.all(
      (await readDirNames(root)).map(async (dirName) => {
        const filePath = path.join(root, dirName, `${sessionId}.jsonl`);
        try {
          const stats = await fs.stat(filePath);
          return stats.isFile() && (stats.size > 0 || options.includeEmpty) ? filePath : undefined;
        } catch {
          return undefined;
        }
      }),
    );
    return found.filter((value): value is string => value !== undefined);
  }

  /** Drops the cached metadata of `filePaths`. */
  invalidate(filePaths: readonly string[]): void {
    for (const filePath of filePaths) this.metadata.delete(filePath);
  }

  /** One page of rows, plus whether more rows follow the page. */
  async list(query: ListQuery): Promise<{ rows: IndexRow[]; hasMore: boolean }> {
    const candidates = (await this.enumerate(query.cwd))
      .filter((candidate) => {
        const archived = query.archivedIds.has(candidate.sessionId.toLowerCase());
        return query.archived === "only" ? archived : !archived;
      })
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
    const accept = (resolved: Resolved, cwd: string) => {
      const row = toRow(resolved, cwd);
      if (!query.after || isAfter(row, query.after)) rows.push(row);
    };
    const settlePending = () => {
      pending = pending.filter((resolved) => {
        const cwd = this.fallbackCwd(resolved.candidate);
        if (cwd) accept(resolved, cwd);
        return !cwd;
      });
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
          return metadata ? { candidate, metadata } : undefined;
        }),
      );
      for (const item of resolved) {
        if (!item) continue;
        const cwd = item.metadata.fileCwd ?? this.fallbackCwd(item.candidate);
        if (cwd) accept(item, cwd);
        else pending.push(item);
      }
      settlePending();
    }
    if (pending.length > 0) {
      // A row recovered after the scan stopped still sorts into the page: it
      // was read before the stop, and more rows only raise the bound.
      await this.learnDirCwds(
        new Set(pending.map(({ candidate }) => candidate.dirName)),
        candidates.filter((candidate) => !read.has(candidate)),
      );
      settlePending();
    }
    rows.sort(compareRows);
    return { rows: rows.slice(0, query.limit), hasMore: rows.length > query.limit };
  }

  /** Reads the unread transcripts of `dirNames` until each directory has a
   *  known cwd, or none of its transcripts gives one. */
  private async learnDirCwds(
    dirNames: ReadonlySet<string>,
    unread: readonly TranscriptCandidate[],
  ): Promise<void> {
    let remaining = unread.filter((candidate) => dirNames.has(candidate.dirName));
    while (remaining.length > 0) {
      remaining = remaining.filter((candidate) => !this.dirCwds.has(candidate.dirName));
      const batch = remaining.slice(0, READ_BATCH_SIZE);
      remaining = remaining.slice(batch.length);
      await Promise.all(batch.map((candidate) => this.metadataOf(candidate)));
    }
  }

  /** The requested path of the directory, else a sibling's cwd. */
  private fallbackCwd(candidate: TranscriptCandidate): string | undefined {
    if (candidate.projectPath && projectDirMatches(candidate.dirName, candidate.projectPath)) {
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
    // With the exact project path the SDK looks in this directory only;
    // without it, it searches every project directory.
    const dir =
      candidate.projectPath && encodeProjectPath(candidate.projectPath) === candidate.dirName
        ? candidate.projectPath
        : undefined;
    const [info, headTail] = await Promise.all([
      this.getSessionInfo(candidate.sessionId, dir ? { dir } : {}),
      readHeadTail(candidate.filePath, candidate.size),
    ]);
    // No info: a sidechain, or no title at all.
    if (!info) return null;
    const facts = await scanTranscriptFile(
      candidate.filePath,
      candidate.size,
      candidate.sessionId,
      headTail,
    );
    if (!facts.hasMessages) return null;
    const fileCwd = this.recoverCwd(candidate.dirName, [
      facts.headCwd,
      ...(facts.tailCwd ? pathAndAncestors(facts.tailCwd) : []),
      info.cwd,
    ]);
    if (fileCwd) this.dirCwds.set(candidate.dirName, fileCwd);
    const lastMessageAt = facts.lastMessageAt ?? candidate.mtimeMs;
    return {
      title: sanitizeTitle(info.summary),
      ...(info.gitBranch && { gitBranch: info.gitBranch }),
      ...(fileCwd && { fileCwd }),
      updatedAtMs: Math.min(lastMessageAt, candidate.mtimeMs),
      facts,
    };
  }

  /** The first candidate that encodes to `dirName`. A directory name is
   *  never decoded. */
  private recoverCwd(dirName: string, candidates: (string | undefined)[]): string | undefined {
    for (const candidate of candidates) {
      if (candidate && path.isAbsolute(candidate) && projectDirMatches(dirName, candidate)) {
        return candidate;
      }
    }
    return undefined;
  }
}
