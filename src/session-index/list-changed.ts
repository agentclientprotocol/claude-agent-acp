/**
 * `_session/list_changed`: tells a `sessionIndex` client that the list of a
 * cwd it reads may have changed.
 *
 * Only the cwds that this connection listed in the last 10 minutes are
 * watched, at most 32, each with the worktree scope it was listed with (a
 * list renews its watch; a list without a cwd is not watched). Each watch has a non-recursive `fs.watch` on the
 * project directories of its paths; the CLI registry directory and the
 * archive marker directory are shared by all of them. An event marks cwds
 * dirty; after a 150 ms quiet period (at most 1 s after the first event) each
 * dirty cwd is checked against a cheap fingerprint (transcript names, mtimes
 * and sizes, archive markers, live records) and notified only when that
 * changed. A rescan every 10 s covers events that `fs.watch` misses.
 *
 * Notifications are hints: the client also polls, so a lost one is harmless.
 */

import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { archiveMarkerDir } from "./archive-markers.js";
import { liveRegistryDir } from "./live-registry.js";
import { encodeProjectPath, projectsRoot, sameProjectPath } from "./project-dirs.js";

export const LIST_CHANGED_METHOD = "_session/list_changed";

const MAX_WATCHED_CWDS = 32;
const WATCH_TTL_MS = 10 * 60 * 1000;
const DEBOUNCE_MS = 150;
const MAX_WAIT_MS = 1_000;
const RESCAN_MS = 10_000;

export type ListChangedDeps = {
  /** The paths that a list of a cwd shows (the cwd, and with
   *  `includeWorktrees` its worktrees), and the names of their project
   *  directories. */
  projectDirs: (
    cwd: string,
    includeWorktrees: boolean,
  ) => Promise<{ dirNames: string[]; paths: string[] }>;
  /** Sends `_session/list_changed { cwd }`. */
  notify: (cwd: string) => Promise<void>;
  now?: () => number;
  logError?: (message: string, error: unknown) => void;
  debounceMs?: number;
  maxWaitMs?: number;
  rescanMs?: number;
};

type WatchedCwd = {
  /** The watch: the cwd and the worktree scope of the list. */
  key: string;
  cwd: string;
  includeWorktrees: boolean;
  lastListedAt: number;
  dirNames: string[];
  /** The paths that `dirNames` belong to. */
  paths: string[];
  watchers: fs.FSWatcher[];
  fingerprint?: string;
  debounce?: ReturnType<typeof setTimeout>;
  maxWait?: ReturnType<typeof setTimeout>;
};

function watchDir(dir: string, onEvent: (filename: string | null) => void): fs.FSWatcher | null {
  try {
    const watcher = fs.watch(dir, { persistent: false }, (_event, filename) =>
      onEvent(filename === null ? null : String(filename)),
    );
    watcher.on("error", () => watcher.close());
    return watcher;
  } catch {
    // A directory that does not exist yet is covered by the rescan.
    return null;
  }
}

async function dirFingerprint(dir: string, filter: (name: string) => boolean): Promise<string> {
  let names: string[];
  try {
    names = (await fsp.readdir(dir)).filter(filter).sort();
  } catch {
    return "";
  }
  const parts = await Promise.all(
    names.map(async (name) => {
      try {
        const stats = await fsp.stat(path.join(dir, name));
        return `${name}:${stats.mtimeMs}:${stats.size}`;
      } catch {
        return `${name}:gone`;
      }
    }),
  );
  return parts.join("|");
}

const isTranscript = (name: string) => name.endsWith(".jsonl");
const isRegistryRecord = (name: string) => /^\d+\.json$/.test(name);

/** The live records whose cwd is one of `paths`, or encodes exactly to one
 *  of `dirNames`. A long path's directory is matched by prefix only, which
 *  other long paths may share: their records do not belong here. */
async function liveRecordsFingerprint(
  dirNames: readonly string[],
  paths: readonly string[],
): Promise<string> {
  const dir = liveRegistryDir();
  let names: string[];
  try {
    names = (await fsp.readdir(dir)).filter(isRegistryRecord).sort();
  } catch {
    return "";
  }
  const parts = await Promise.all(
    names.map(async (name) => {
      try {
        const record = JSON.parse(await fsp.readFile(path.join(dir, name), "utf8")) as Record<
          string,
          unknown
        >;
        const cwd = typeof record.cwd === "string" ? record.cwd : undefined;
        const belongs =
          cwd !== undefined &&
          (dirNames.includes(encodeProjectPath(cwd)) ||
            paths.some((projectPath) => sameProjectPath(cwd, projectPath)));
        if (!belongs) return undefined;
        return `${name}:${String(record.sessionId)}:${String(record.status)}:${String(record.statusUpdatedAt)}`;
      } catch {
        return undefined;
      }
    }),
  );
  return parts.filter(Boolean).join("|");
}

export class ListChangedWatcher {
  private readonly watched = new Map<string, WatchedCwd>();
  private readonly sharedWatchers = new Map<string, fs.FSWatcher>();
  private rescanTimer?: ReturnType<typeof setTimeout>;
  private disposed = false;
  private readonly now: () => number;
  private readonly debounceMs: number;
  private readonly maxWaitMs: number;
  private readonly rescanMs: number;

  constructor(private readonly deps: ListChangedDeps) {
    this.now = deps.now ?? Date.now;
    this.debounceMs = deps.debounceMs ?? DEBOUNCE_MS;
    this.maxWaitMs = deps.maxWaitMs ?? MAX_WAIT_MS;
    this.rescanMs = deps.rescanMs ?? RESCAN_MS;
  }

  /** The cwds being watched, for tests and diagnostics. */
  watchedCwds(): string[] {
    return [...this.watched.values()].map(({ cwd }) => cwd);
  }

  /** Records that the client listed `cwd`, and watches it. */
  async onListed(cwd: string, includeWorktrees = false): Promise<void> {
    if (this.disposed) return;
    const key = `${includeWorktrees ? "w" : "-"}\0${cwd}`;
    const existing = this.watched.get(key);
    if (existing) {
      existing.lastListedAt = this.now();
      return;
    }
    const entry: WatchedCwd = {
      key,
      cwd,
      includeWorktrees,
      lastListedAt: this.now(),
      dirNames: [],
      paths: [],
      watchers: [],
    };
    this.watched.set(key, entry);
    this.evictOverflow();
    this.ensureShared();
    await this.refreshDirs(entry);
    entry.fingerprint = await this.fingerprint(entry);
  }

  dispose(): void {
    this.disposed = true;
    for (const entry of this.watched.values()) this.unwatch(entry);
    this.watched.clear();
    this.stopShared();
  }

  private stopShared(): void {
    for (const watcher of this.sharedWatchers.values()) watcher.close();
    this.sharedWatchers.clear();
    if (this.rescanTimer) clearInterval(this.rescanTimer);
    this.rescanTimer = undefined;
  }

  private evictOverflow(): void {
    while (this.watched.size > MAX_WATCHED_CWDS) {
      let oldest: WatchedCwd | undefined;
      for (const entry of this.watched.values()) {
        if (!oldest || entry.lastListedAt < oldest.lastListedAt) oldest = entry;
      }
      if (!oldest) return;
      this.unwatch(oldest);
      this.watched.delete(oldest.key);
    }
  }

  private unwatch(entry: WatchedCwd): void {
    for (const watcher of entry.watchers) watcher.close();
    entry.watchers = [];
    if (entry.debounce) clearTimeout(entry.debounce);
    if (entry.maxWait) clearTimeout(entry.maxWait);
    entry.debounce = entry.maxWait = undefined;
  }

  /** Watches the registry and the archive marker directories, the ones that
   *  exist by now, and starts the rescan. */
  private ensureShared(): void {
    for (const [dir, filter] of [
      [liveRegistryDir(), isRegistryRecord],
      [archiveMarkerDir(), () => true],
    ] as const) {
      if (this.sharedWatchers.has(dir)) continue;
      const watcher = watchDir(dir, (filename) => {
        if (filename === null || filter(filename)) this.markAllDirty();
      });
      if (watcher) this.sharedWatchers.set(dir, watcher);
    }
    if (!this.rescanTimer) {
      this.rescanTimer = setInterval(() => void this.rescan(), this.rescanMs);
      this.rescanTimer.unref?.();
    }
  }

  /** Watches the current project directories of `entry`. */
  private async refreshDirs(entry: WatchedCwd): Promise<void> {
    let dirNames: string[];
    let paths: string[];
    try {
      ({ dirNames, paths } = await this.deps.projectDirs(entry.cwd, entry.includeWorktrees));
    } catch (error) {
      this.deps.logError?.(`session list watch of ${entry.cwd} failed`, error);
      return;
    }
    if (this.disposed || this.watched.get(entry.key) !== entry) return;
    entry.paths = paths;
    if (dirNames.join("\0") === entry.dirNames.join("\0") && entry.watchers.length > 0) return;
    for (const watcher of entry.watchers) watcher.close();
    entry.dirNames = dirNames;
    entry.watchers = dirNames
      .map((dirName) =>
        watchDir(path.join(projectsRoot(), dirName), (filename) => {
          if (filename === null || isTranscript(filename)) this.markDirty(entry);
        }),
      )
      .filter((watcher): watcher is fs.FSWatcher => watcher !== null);
  }

  /** The state of `entry` that its list shows: its transcripts, the
   *  archive markers of those sessions, and the live records in its
   *  directories. */
  private async fingerprint(entry: WatchedCwd): Promise<string> {
    const root = projectsRoot();
    const transcripts = await Promise.all(
      entry.dirNames.map((dirName) => dirFingerprint(path.join(root, dirName), isTranscript)),
    );
    const sessionIds = new Set(
      transcripts
        .flatMap((part) => part.split("|"))
        .map((item) => item.slice(0, item.indexOf(".jsonl")).toLowerCase())
        .filter(Boolean),
    );
    const [markers, live] = await Promise.all([
      dirFingerprint(archiveMarkerDir(), (name) => sessionIds.has(name.toLowerCase())),
      liveRecordsFingerprint(entry.dirNames, entry.paths),
    ]);
    return [entry.dirNames.join("\0"), ...transcripts, markers, live].join("\n");
  }

  private markAllDirty(): void {
    for (const entry of this.watched.values()) this.markDirty(entry);
  }

  private markDirty(entry: WatchedCwd): void {
    if (this.disposed) return;
    if (entry.debounce) clearTimeout(entry.debounce);
    entry.debounce = setTimeout(() => void this.flush(entry), this.debounceMs);
    entry.debounce.unref?.();
    if (!entry.maxWait) {
      entry.maxWait = setTimeout(() => void this.flush(entry), this.maxWaitMs);
      entry.maxWait.unref?.();
    }
  }

  private async flush(entry: WatchedCwd): Promise<void> {
    if (entry.debounce) clearTimeout(entry.debounce);
    if (entry.maxWait) clearTimeout(entry.maxWait);
    entry.debounce = entry.maxWait = undefined;
    await this.check(entry);
  }

  /** Notifies the client when the fingerprint of `entry` changed. */
  private async check(entry: WatchedCwd): Promise<void> {
    if (this.disposed || this.watched.get(entry.key) !== entry) return;
    try {
      const fingerprint = await this.fingerprint(entry);
      if (fingerprint === entry.fingerprint) return;
      entry.fingerprint = fingerprint;
      if (this.disposed || this.watched.get(entry.key) !== entry) return;
      await this.deps.notify(entry.cwd);
    } catch (error) {
      this.deps.logError?.(`session list change check of ${entry.cwd} failed`, error);
    }
  }

  /** Drops expired cwds, re-reads the worktrees, and checks every cwd. */
  private async rescan(): Promise<void> {
    const now = this.now();
    for (const entry of [...this.watched.values()]) {
      if (now - entry.lastListedAt > WATCH_TTL_MS) {
        this.unwatch(entry);
        this.watched.delete(entry.key);
        continue;
      }
      await this.refreshDirs(entry);
      await this.check(entry);
    }
    if (this.watched.size === 0) this.stopShared();
    else this.ensureShared();
  }
}
