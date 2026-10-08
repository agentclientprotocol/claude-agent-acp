/**
 * `_session/list/subscribe`: pushes the changed rows of a cwd's session list
 * to a `sessionIndex` client.
 *
 * A subscription covers the sessions of its cwd and of the same subdirectory
 * in every linked worktree (the `includeWorktrees` scope of the list), in any
 * archive state. All subscriptions of one cwd share one {@link ScopeWatch}:
 * a non-recursive `fs.watch` on each project directory of the scope, and the
 * current row of every session in it. The registry, the archive markers and
 * the projects root are watched once per connection.
 *
 * - A transcript event names the file: only that file is stat'ed and, when
 *   it changed, its metadata read again (the index's metadata cache and tail
 *   scan).
 * - A registry event names the record: only that record is read, and only
 *   the sessions whose record changed get their `state` recomputed.
 * - A session this connection runs reports its SDK state at once.
 *
 * Events are coalesced: 150 ms after the last one, at most 1 s after the
 * first. Each subscription compares a recomputed row with the last row it
 * sent; a change of `updatedAt` alone is no change. A session is sent at most
 * once a second per subscription. A rescan every 10 s re-reads the whole
 * scope (the metadata cache makes an unchanged transcript free) and sends
 * whatever differs, which covers events `fs.watch` missed.
 *
 * Delivery is best effort: there is no resync and no sequence number; the
 * client also reads the list now and then.
 */

import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { RequestError, type SessionInfo } from "@agentclientprotocol/sdk";
import type { OwnSessionState } from "./activity.js";
import { archiveMarkerDir } from "./archive-markers.js";
import {
  bySession,
  liveRegistryDir,
  type LiveRecord,
  type LiveSessionRegistry,
  type LiveSnapshot,
} from "./live-registry.js";
import { isExactProjectDir, isSessionId, projectDirMatches, projectsRoot } from "./project-dirs.js";
import {
  onePerSession,
  type IndexRow,
  type SessionIndex,
  type TranscriptCandidate,
} from "./session-index.js";
import { changeSignature, sessionInfoOf } from "./session-info.js";

export const LIST_SUBSCRIBE_METHOD = "_session/list/subscribe";
export const LIST_UNSUBSCRIBE_METHOD = "_session/list/unsubscribe";
export const LIST_CHANGES_METHOD = "_session/list/changes";

/** Subscriptions per connection. */
export const MAX_SUBSCRIPTIONS = 128;
const DEBOUNCE_MS = 150;
const MAX_WAIT_MS = 1_000;
const RESCAN_MS = 10_000;
/** When a rescan follows the opening of a directory watcher. */
const SETTLE_MS = 1_000;
/** The least time between two changes of one session to one subscription. */
const MIN_SESSION_INTERVAL_MS = 1_000;

export type ListSubscribeRequest = { cwd: string };
export type ListSubscribeResponse = { subscriptionId: string };
export type ListUnsubscribeRequest = { subscriptionId: string };
export type ListChanges = { subscriptionId: string; sessions: SessionInfo[]; removed: string[] };

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** `{ cwd }`: an absolute path. Other parameters are ignored. */
export function parseListSubscribeRequest(value: unknown): ListSubscribeRequest {
  const cwd = asRecord(value).cwd;
  if (typeof cwd !== "string" || !path.isAbsolute(cwd)) {
    throw RequestError.invalidParams({ cwd }, "params require an absolute cwd");
  }
  return { cwd };
}

/** `{ subscriptionId }`. */
export function parseListUnsubscribeRequest(value: unknown): ListUnsubscribeRequest {
  const subscriptionId = asRecord(value).subscriptionId;
  if (typeof subscriptionId !== "string") {
    throw RequestError.invalidParams(undefined, "params require a subscriptionId");
  }
  return { subscriptionId };
}

export type ListSubscriptionDeps = {
  index: Pick<
    SessionIndex,
    "listedPaths" | "projectDirs" | "enumerateFiles" | "rowsOf" | "continuedIn" | "isRead"
  >;
  registry: Pick<LiveSessionRegistry, "readFiles">;
  /** What this connection knows of a session it runs. */
  own: (sessionId: string) => OwnSessionState | undefined;
  /** The ids of the archived sessions, lower case. */
  archivedIds: () => Promise<ReadonlySet<string>>;
  notify: (changes: ListChanges) => Promise<void>;
  logError: (message: string, error: unknown) => void;
  now?: () => number;
  debounceMs?: number;
  maxWaitMs?: number;
  rescanMs?: number;
  minSessionIntervalMs?: number;
};

type Row = { row: IndexRow; info: SessionInfo; signature: string };

type WatchedDir = { projectPath: string; watcher: fs.FSWatcher | null; identity?: string };

type Subscription = {
  id: string;
  watch: ScopeWatch;
  /** The row last sent per session (lower-case id): its signature and the
   *  id as the transcript spells it. Before the first change, the row at
   *  subscribe time. */
  sent: Map<string, { signature: string; sessionId: string }>;
  sentAt: Map<string, number>;
  /** Sessions to compare with `sent` at the next delivery. */
  pending: Set<string>;
  /** Sessions sent at their next delivery even when their row equals the
   *  one in `sent` (a row the first read may have taken after a change). */
  force: Set<string>;
  /** Fires when a session held back by the interval may be sent. */
  timer?: ReturnType<typeof setTimeout>;
  /** Set once `sent` holds the rows at subscribe time. */
  initialized: boolean;
};

/** The watching of one cwd, shared by its subscriptions. */
type ScopeWatch = {
  key: string;
  cwd: string;
  paths: string[];
  /** Project directory name → the scope path it belongs to, its watcher,
   *  and the directory the watcher watches. */
  dirs: Map<string, WatchedDir>;
  /** Every non-empty transcript file of the scope. */
  files: Map<string, TranscriptCandidate>;
  /** The file paths of each session (lower-case id). */
  filesById: Map<string, Set<string>>;
  /** The current row of each session (lower-case id) in the scope. */
  rows: Map<string, Row>;
  subscriptions: Set<Subscription>;
  started: Promise<void>;
  ready: boolean;
  /** The first rows are being read. */
  baselining: boolean;
  closed: boolean;
  dirtyFiles: Set<string>;
  /** Sessions whose row is resolved again (from the cache when unchanged). */
  dirtyRows: Set<string>;
  /** Sessions whose row is presented again: their state may have changed. */
  dirtyStates: Set<string>;
  rescan: boolean;
  /** Sessions that changed while the first rows were read: sent once. */
  touched: Set<string>;
  /** Sessions whose transcript was there at subscribe time and gone when
   *  the first rows were read: sent as removed. By lower-case id. */
  vanished: Map<string, string>;
  /** The sessions continued in each session (lower-case ids), from the
   *  metadata read: a change of the successor may show or hide them. */
  predecessors: Map<string, Set<string>>;
  /** The scope paths the rows were last resolved against. */
  resolvedPaths: string;
  /** The archive markers the rows were last read with. */
  markers: ReadonlySet<string>;
  /** Sessions whose transcript could not be read: kept as they were, and
   *  read again by the next rescan. */
  unreadable: Set<string>;
  debounce?: ReturnType<typeof setTimeout>;
  maxWait?: ReturnType<typeof setTimeout>;
  /** A rescan soon after a directory watcher opened: a new watcher may miss
   *  the events of its first moments. */
  settle?: ReturnType<typeof setTimeout>;
  /** The work in flight; the next one runs after it. */
  working?: Promise<void>;
  /** Work was asked for while some ran. */
  again: boolean;
  /** ...and it included the transcripts. */
  againFiles: boolean;
};

/** A non-recursive watch of `dir`, or null when it cannot be watched (it
 *  does not exist yet). `onError` runs when the watch fails later (the
 *  directory was removed): the watcher is closed then. */
function watchDir(
  dir: string,
  onEvent: (filename: string | null) => void,
  onError: () => void,
): fs.FSWatcher | null {
  try {
    const watcher = fs.watch(dir, { persistent: false }, (_event, filename) =>
      onEvent(filename === null || filename === undefined ? null : String(filename)),
    );
    watcher.on("error", () => {
      watcher.close();
      onError();
    });
    return watcher;
  } catch {
    // A directory that does not exist yet is covered by the rescan.
    return null;
  }
}

const RECORD_FILE = /^\d+\.json$/;

/** Which directory a path is now (device and inode), or undefined. A
 *  directory replaced by another one keeps no watcher of the old one. */
function dirIdentity(dir: string): string | undefined {
  try {
    const stats = fs.statSync(dir);
    return stats.isDirectory() ? `${stats.dev}:${stats.ino}` : undefined;
  } catch {
    return undefined;
  }
}

/** The scope paths as one comparable value. */
function scopeKey(paths: readonly string[]): string {
  return [...paths].sort().join("\0");
}

/** The lower-case session id of a transcript file name, else undefined. */
function transcriptId(filename: string): string | undefined {
  if (!filename.endsWith(".jsonl")) return undefined;
  const id = filename.slice(0, -6);
  return isSessionId(id) ? id.toLowerCase() : undefined;
}

export class ListSubscriptions {
  private readonly subscriptions = new Map<string, Subscription>();
  /** Sessions whose row shows this connection's SDK state: the rescan
   *  presents them again, in case a change of it was not reported. */
  private readonly ownShown = new Set<string>();
  private readonly watches = new Map<string, ScopeWatch>();
  private readonly shared = new Map<string, fs.FSWatcher>();
  /** The directory each shared watcher watches (see {@link dirIdentity}). */
  private readonly sharedIdentity = new Map<string, string | undefined>();
  /** The nearest existing ancestor of each shared directory that does not
   *  exist yet, watched for its creation. */
  private readonly ancestors = new Map<string, fs.FSWatcher>();
  private rescanTimer?: ReturnType<typeof setInterval>;
  /** The live records by registry file name. */
  private liveFiles = new Map<string, LiveRecord>();
  private live: LiveSnapshot = new Map();
  private registryLoaded?: Promise<void>;
  private registryNames = new Set<string>();
  private registryFull = false;
  private registryDebounce?: ReturnType<typeof setTimeout>;
  private registryMaxWait?: ReturnType<typeof setTimeout>;
  private registryWorking?: Promise<void>;
  private disposed = false;
  private readonly now: () => number;
  private readonly debounceMs: number;
  private readonly maxWaitMs: number;
  private readonly rescanMs: number;
  private readonly minIntervalMs: number;

  constructor(private readonly deps: ListSubscriptionDeps) {
    this.now = deps.now ?? Date.now;
    this.debounceMs = deps.debounceMs ?? DEBOUNCE_MS;
    this.maxWaitMs = deps.maxWaitMs ?? MAX_WAIT_MS;
    this.rescanMs = deps.rescanMs ?? RESCAN_MS;
    this.minIntervalMs = deps.minSessionIntervalMs ?? MIN_SESSION_INTERVAL_MS;
  }

  /** Subscribes to the sessions of `cwd`. Changes are tracked from the
   *  return on. */
  async subscribe(cwd: string): Promise<ListSubscribeResponse> {
    if (this.disposed) throw RequestError.internalError(undefined, "The connection is closed");
    if (this.subscriptions.size >= MAX_SUBSCRIPTIONS) {
      throw RequestError.invalidParams(
        { reason: "too_many_subscriptions", max: MAX_SUBSCRIPTIONS },
        `At most ${MAX_SUBSCRIPTIONS} session list subscriptions per connection`,
      );
    }
    const key = path.resolve(cwd);
    let watch = this.watches.get(key);
    if (!watch) {
      watch = this.createWatch(key);
      this.watches.set(key, watch);
      this.ensureShared();
    }
    const subscription: Subscription = {
      id: randomUUID(),
      watch,
      sent: new Map(),
      sentAt: new Map(),
      pending: new Set(),
      force: new Set(),
      initialized: false,
    };
    // Counted at once, so concurrent subscribes cannot pass the limit.
    this.subscriptions.set(subscription.id, subscription);
    watch.subscriptions.add(subscription);
    try {
      await watch.started;
    } catch (error) {
      this.unsubscribe(subscription.id);
      throw error;
    }
    // The connection closed meanwhile.
    if (!this.subscriptions.has(subscription.id)) {
      throw RequestError.internalError(undefined, "The connection is closed");
    }
    if (watch.ready) this.initialize(subscription);
    return { subscriptionId: subscription.id };
  }

  /** Idempotent: an unknown id is no error. */
  unsubscribe(subscriptionId: string): void {
    const subscription = this.subscriptions.get(subscriptionId);
    if (!subscription) return;
    this.subscriptions.delete(subscriptionId);
    if (subscription.timer) clearTimeout(subscription.timer);
    subscription.timer = undefined;
    const { watch } = subscription;
    watch.subscriptions.delete(subscription);
    if (watch.subscriptions.size === 0) this.closeWatch(watch);
  }

  /** A session this connection runs changed its state, turn end or cost. */
  ownSessionChanged(sessionId: string): void {
    const id = sessionId.toLowerCase();
    for (const watch of this.watches.values()) {
      if (!watch.ready) {
        watch.touched.add(id);
        continue;
      }
      if (!watch.rows.has(id)) continue;
      watch.dirtyStates.add(id);
      this.schedule(watch, "states");
    }
  }

  dispose(): void {
    this.disposed = true;
    for (const id of [...this.subscriptions.keys()]) this.unsubscribe(id);
    this.stopShared();
  }

  /** The open watchers and armed timers, for tests and diagnostics. */
  openHandles(): { watches: number; watchers: number; timers: number } {
    let watchers = this.shared.size + this.ancestors.size;
    let timers = [this.rescanTimer, this.registryDebounce, this.registryMaxWait].filter(
      Boolean,
    ).length;
    for (const watch of this.watches.values()) {
      for (const { watcher } of watch.dirs.values()) if (watcher) watchers++;
      if (watch.debounce) timers++;
      if (watch.maxWait) timers++;
      if (watch.settle) timers++;
      for (const subscription of watch.subscriptions) if (subscription.timer) timers++;
    }
    return { watches: this.watches.size, watchers, timers };
  }

  private createWatch(key: string): ScopeWatch {
    const watch: ScopeWatch = {
      key,
      cwd: key,
      paths: [],
      dirs: new Map(),
      files: new Map(),
      filesById: new Map(),
      rows: new Map(),
      subscriptions: new Set(),
      started: Promise.resolve(),
      ready: false,
      baselining: false,
      closed: false,
      dirtyFiles: new Set(),
      dirtyRows: new Set(),
      dirtyStates: new Set(),
      rescan: false,
      touched: new Set(),
      vanished: new Map(),
      predecessors: new Map(),
      markers: new Set(),
      unreadable: new Set(),
      resolvedPaths: "",
      again: false,
      againFiles: false,
    };
    // When subscribe returns, the watchers are open and the transcripts
    // stat'ed: the first rows are read after it, from those stats, and a
    // rescan then finds what changed in the meantime.
    watch.started = this.refreshDirs(watch).then(async () => {
      const files = await this.deps.index.enumerateFiles(watch.paths);
      if (!watch.closed) this.setFiles(watch, files);
      // The registry as it is now: a later change of it is an event.
      await this.registryLoaded;
    });
    void watch.started.then(
      () => this.baseline(watch),
      () => this.closeWatch(watch),
    );
    return watch;
  }

  private closeWatch(watch: ScopeWatch): void {
    if (watch.closed) return;
    watch.closed = true;
    for (const subscription of watch.subscriptions) {
      this.subscriptions.delete(subscription.id);
      if (subscription.timer) clearTimeout(subscription.timer);
    }
    watch.subscriptions.clear();
    for (const { watcher } of watch.dirs.values()) watcher?.close();
    watch.dirs.clear();
    if (watch.debounce) clearTimeout(watch.debounce);
    if (watch.maxWait) clearTimeout(watch.maxWait);
    if (watch.settle) clearTimeout(watch.settle);
    watch.debounce = watch.maxWait = watch.settle = undefined;
    watch.rows.clear();
    watch.files.clear();
    watch.filesById.clear();
    if (this.watches.get(watch.key) === watch) this.watches.delete(watch.key);
    if (this.watches.size === 0) this.stopShared();
  }

  /** The registry, the archive markers and the projects root, watched once
   *  for all cwds, and the rescan. */
  private ensureShared(): void {
    if (this.disposed || this.watches.size === 0) return;
    const watchers: [string, (filename: string | null) => void][] = [
      [liveRegistryDir(), (filename) => this.onRegistryEvent(filename)],
      [archiveMarkerDir(), (filename) => this.onArchiveEvent(filename)],
      [projectsRoot(), (filename) => this.onProjectsRootEvent(filename)],
    ];
    const missing: string[] = [];
    let created = false;
    for (const [dir, onEvent] of watchers) {
      const identity = dirIdentity(dir);
      const existing = this.shared.get(dir);
      if (existing && this.sharedIdentity.get(dir) === identity) continue;
      if (existing) {
        // Replaced or gone: watch what is there now.
        existing.close();
        this.shared.delete(dir);
      }
      this.sharedIdentity.set(dir, identity);
      const watcher = watchDir(dir, onEvent, () => {
        // Watched again, or its ancestor, by the next rescan.
        if (this.shared.get(dir) === watcher) this.shared.delete(dir);
      });
      if (watcher) {
        this.shared.set(dir, watcher);
        created = true;
      } else {
        missing.push(dir);
      }
    }
    this.watchAncestors(missing);
    if (created && this.registryLoaded) {
      // What the new directory got before its watcher opened.
      this.registryFull = true;
      this.scheduleRegistry(true);
      for (const watch of this.watches.values()) {
        if (!watch.ready) continue;
        watch.rescan = true;
        this.schedule(watch, "now");
      }
    }
    this.registryLoaded ??= this.readRegistry(true).then(
      () => undefined,
      (error: unknown) => this.deps.logError("session list registry read failed", error),
    );
    if (!this.rescanTimer) {
      this.rescanTimer = setInterval(() => this.rescanAll(), this.rescanMs);
      this.rescanTimer.unref?.();
    }
  }

  /** Watches the nearest existing ancestor of each of `missing` (a config
   *  directory without `projects` or `sessions` yet): any event there checks
   *  again. */
  private watchAncestors(missing: readonly string[]): void {
    const wanted = new Set<string>();
    for (const dir of missing) {
      let ancestor = path.dirname(dir);
      while (!fs.existsSync(ancestor) && path.dirname(ancestor) !== ancestor) {
        ancestor = path.dirname(ancestor);
      }
      wanted.add(ancestor);
    }
    for (const [ancestor, watcher] of this.ancestors) {
      if (wanted.has(ancestor)) continue;
      watcher.close();
      this.ancestors.delete(ancestor);
    }
    for (const ancestor of wanted) {
      if (this.ancestors.has(ancestor)) continue;
      const watcher = watchDir(
        ancestor,
        () => this.ensureShared(),
        () => {
          if (this.ancestors.get(ancestor) === watcher) this.ancestors.delete(ancestor);
        },
      );
      if (watcher) this.ancestors.set(ancestor, watcher);
    }
  }

  private stopShared(): void {
    for (const watcher of this.shared.values()) watcher.close();
    this.shared.clear();
    this.sharedIdentity.clear();
    this.ownShown.clear();
    for (const watcher of this.ancestors.values()) watcher.close();
    this.ancestors.clear();
    if (this.rescanTimer) clearInterval(this.rescanTimer);
    if (this.registryDebounce) clearTimeout(this.registryDebounce);
    if (this.registryMaxWait) clearTimeout(this.registryMaxWait);
    this.rescanTimer = this.registryDebounce = this.registryMaxWait = undefined;
    this.registryLoaded = undefined;
    this.registryNames.clear();
    this.registryFull = false;
    this.liveFiles = new Map();
    this.live = new Map();
  }

  private rescanAll(): void {
    // Directories that did not exist before may now.
    this.ensureShared();
    this.registryFull = true;
    this.scheduleRegistry(true);
    for (const watch of this.watches.values()) {
      if (!watch.ready) {
        // A first read that failed is tried again.
        if (!watch.baselining) void this.baseline(watch);
        continue;
      }
      watch.rescan = true;
      this.schedule(watch, "now");
    }
  }

  // --- Events -------------------------------------------------------------

  private onTranscriptEvent(watch: ScopeWatch, dirName: string, filename: string | null): void {
    if (watch.closed) return;
    if (filename === null) {
      watch.rescan = true;
    } else {
      const id = transcriptId(filename);
      if (id === undefined) return;
      // Before the watch is ready, the rescan after the first rows finds it.
      watch.dirtyFiles.add(path.join(projectsRoot(), dirName, filename));
    }
    this.schedule(watch, "debounced");
  }

  private onArchiveEvent(filename: string | null): void {
    for (const watch of this.watches.values()) {
      if (filename === null) {
        watch.rescan = true;
      } else if (isSessionId(filename)) {
        const id = filename.toLowerCase();
        if (!watch.ready) watch.touched.add(id);
        watch.dirtyRows.add(id);
      } else {
        continue;
      }
      this.schedule(watch, "debounced");
    }
  }

  /** A project directory that a scope lacked may have been created. */
  private onProjectsRootEvent(filename: string | null): void {
    if (filename === null) return;
    // A project directory of a scope was made, removed or replaced: the
    // rescan watches what is there now.
    for (const watch of this.watches.values()) {
      if (
        watch.paths.some(
          (cwd) => isExactProjectDir(filename, cwd) || projectDirMatches(filename, cwd),
        )
      ) {
        watch.rescan = true;
        this.schedule(watch, "debounced");
      }
    }
  }

  private onRegistryEvent(filename: string | null): void {
    if (filename === null) this.registryFull = true;
    else if (RECORD_FILE.test(filename)) this.registryNames.add(filename);
    else return;
    this.scheduleRegistry(false);
  }

  // --- Scheduling ---------------------------------------------------------

  /**
   * Runs the work of `watch`: `debounced` after the quiet period, `now` at
   * once, and `states` at once for the recomputed states only, leaving the
   * transcript events to their quiet period (a registry that changes every
   * 200 ms then does not read the transcripts that often).
   */
  private schedule(watch: ScopeWatch, mode: "debounced" | "now" | "states"): void {
    if (watch.closed) return;
    if (mode === "states") {
      void this.work(watch, false);
      return;
    }
    if (mode === "now") {
      this.clearWatchTimers(watch);
      void this.work(watch, true);
      return;
    }
    if (watch.debounce) clearTimeout(watch.debounce);
    watch.debounce = setTimeout(() => this.schedule(watch, "now"), this.debounceMs);
    watch.debounce.unref?.();
    if (!watch.maxWait) {
      watch.maxWait = setTimeout(() => this.schedule(watch, "now"), this.maxWaitMs);
      watch.maxWait.unref?.();
    }
  }

  private clearWatchTimers(watch: ScopeWatch): void {
    if (watch.debounce) clearTimeout(watch.debounce);
    if (watch.maxWait) clearTimeout(watch.maxWait);
    watch.debounce = watch.maxWait = undefined;
  }

  private scheduleRegistry(now: boolean): void {
    if (this.disposed || this.watches.size === 0) return;
    const run = () => {
      if (this.registryDebounce) clearTimeout(this.registryDebounce);
      if (this.registryMaxWait) clearTimeout(this.registryMaxWait);
      this.registryDebounce = this.registryMaxWait = undefined;
      void this.registryWork();
    };
    if (now) return run();
    if (this.registryDebounce) clearTimeout(this.registryDebounce);
    this.registryDebounce = setTimeout(run, this.debounceMs);
    this.registryDebounce.unref?.();
    if (!this.registryMaxWait) {
      this.registryMaxWait = setTimeout(run, this.maxWaitMs);
      this.registryMaxWait.unref?.();
    }
  }

  // --- Registry -----------------------------------------------------------

  private async registryWork(): Promise<void> {
    if (this.registryWorking) {
      // The running read picks the new names up when it ends.
      return;
    }
    this.registryWorking = (async () => {
      try {
        await this.registryLoaded;
        while (this.registryFull || this.registryNames.size > 0) {
          const full = this.registryFull;
          this.registryFull = false;
          const affected = await this.readRegistry(full);
          this.onLiveChanged(affected);
        }
      } catch (error) {
        this.deps.logError("session list registry read failed", error);
      } finally {
        this.registryWorking = undefined;
      }
    })();
    await this.registryWorking;
  }

  /** Reads the changed registry records (all with `full`) and returns the
   *  lower-case ids of the sessions whose record changed. */
  private async readRegistry(full: boolean): Promise<Set<string>> {
    let names: string[];
    if (full) {
      this.registryNames.clear();
      try {
        names = await fsp.readdir(liveRegistryDir());
      } catch {
        names = [];
      }
    } else {
      names = [...this.registryNames];
      this.registryNames.clear();
    }
    const read = await this.deps.registry.readFiles(names, { recentStarts: true });
    const affected = new Set<string>();
    const key = (record: LiveRecord | undefined) =>
      record
        ? `${record.sessionId}\0${record.status}\0${record.statusUpdatedAt}\0${record.kind}\0${record.entrypoint}`
        : "";
    const next = full ? new Map<string, LiveRecord>() : new Map(this.liveFiles);
    const before = this.liveFiles;
    const changedNames = full ? new Set([...before.keys(), ...read.keys()]) : read.keys();
    for (const name of changedNames) {
      const previous = before.get(name);
      const record = read.get(name);
      if (record) next.set(name, record);
      else next.delete(name);
      if (key(previous) !== key(record)) {
        if (previous) affected.add(previous.sessionId.toLowerCase());
        if (record) affected.add(record.sessionId.toLowerCase());
      }
    }
    this.liveFiles = next;
    this.live = bySession(next.values());
    return affected;
  }

  private onLiveChanged(affected: ReadonlySet<string>): void {
    if (affected.size === 0) return;
    for (const watch of this.watches.values()) {
      if (!watch.ready) {
        for (const id of affected) watch.touched.add(id);
        continue;
      }
      let any = false;
      for (const id of affected) {
        if (!watch.rows.has(id)) continue;
        watch.dirtyStates.add(id);
        any = true;
      }
      if (any) this.schedule(watch, "states");
    }
  }

  // --- Scope work ---------------------------------------------------------

  /** Reads the scope paths and watches their project directories. */
  private async refreshDirs(watch: ScopeWatch): Promise<void> {
    const paths = await this.deps.index.listedPaths(watch.cwd, true);
    const dirs = await this.deps.index.projectDirs(paths);
    if (watch.closed) return;
    watch.paths = paths;
    const wanted = new Map(dirs.map(({ dirName, projectPath }) => [dirName, projectPath]));
    let opened = false;
    for (const [dirName, entry] of watch.dirs) {
      if (wanted.has(dirName)) continue;
      entry.watcher?.close();
      watch.dirs.delete(dirName);
    }
    for (const [dirName, projectPath] of wanted) {
      const dir = path.join(projectsRoot(), dirName);
      const identity = dirIdentity(dir);
      let entry = watch.dirs.get(dirName);
      if (entry?.watcher && entry.identity === identity) {
        entry.projectPath = projectPath;
        continue;
      }
      if (entry?.watcher) {
        // Replaced (renamed away and made again): watch the new one.
        entry.watcher.close();
        watch.dirs.delete(dirName);
        entry = undefined;
      }
      const created: WatchedDir = { projectPath, watcher: null, identity };
      created.watcher = watchDir(
        dir,
        (filename) => this.onTranscriptEvent(watch, dirName, filename),
        () => {
          // Opened again by the next rescan, when the directory is back.
          created.watcher = null;
        },
      );
      watch.dirs.set(dirName, created);
      // Not for a watcher opened again after an error, which could repeat.
      if (created.watcher && !entry) opened = true;
    }
    if (opened && !watch.settle) {
      watch.settle = setTimeout(() => {
        watch.settle = undefined;
        watch.rescan = true;
        this.schedule(watch, "now");
      }, SETTLE_MS);
      watch.settle.unref?.();
    }
  }

  /** Reads the first rows of the scope, then makes the watch ready. */
  private async baseline(watch: ScopeWatch): Promise<void> {
    if (watch.closed) return;
    watch.baselining = true;
    try {
      // The newest first: those the client's first page reads too.
      const files = onePerSession([...watch.files.values()]).sort((a, b) => b.mtimeMs - a.mtimeMs);
      const archived = await this.deps.archivedIds();
      const rows = await this.deps.index.rowsOf(watch.paths, files, archived, () => [
        ...watch.files.values(),
      ]);
      const withRow = new Set(rows.map((row) => row.sessionId.toLowerCase()));
      const stats = await Promise.all(
        files.map((file) =>
          withRow.has(file.sessionId.toLowerCase())
            ? undefined
            : fsp.stat(file.filePath).catch(() => undefined),
        ),
      );
      // A session continued in a successor that changed since the stats may
      // have been shown or hidden then.
      const successors = files.map((file) => {
        const successor = this.deps.index.continuedIn(file.filePath);
        return successor ? path.join(path.dirname(file.filePath), `${successor}.jsonl`) : undefined;
      });
      const successorStats = await Promise.all(
        successors.map((successor) =>
          successor ? fsp.stat(successor).catch(() => undefined) : undefined,
        ),
      );
      // A transcript that changed since the stats may have been read with
      // a newer sidecar title, or other state of after the stats: its row is
      // sent once, whatever the rescan that follows finds.
      const current = new Map(
        (await this.deps.index.enumerateFiles(watch.paths)).map((file) => [file.filePath, file]),
      );
      for (const file of watch.files.values()) {
        const now = current.get(file.filePath);
        if (
          !now ||
          now.size !== file.size ||
          now.mtimeMs !== file.mtimeMs ||
          now.ino !== file.ino
        ) {
          watch.touched.add(file.sessionId.toLowerCase());
        }
      }
      await this.registryLoaded;
      if (watch.closed) return;
      files.forEach((file, i) => {
        const id = file.sessionId.toLowerCase();
        const shown = withRow.has(id);
        if (!shown && !stats[i]) {
          watch.vanished.set(id, file.sessionId);
          return;
        }
        if (!shown && !this.deps.index.isRead(file)) {
          // Read again by the rescan that follows.
          watch.unreadable.add(id);
          return;
        }
        const successor = successors[i];
        if (successor === undefined) return;
        const then = watch.files.get(successor);
        const current = successorStats[i];
        if (then && current && then.size === current.size && then.mtimeMs === current.mtimeMs) {
          return;
        }
        if (shown) watch.touched.add(id);
        else watch.vanished.set(id, file.sessionId);
      });
      watch.markers = archived;
      watch.resolvedPaths = scopeKey(watch.paths);
      const now = this.now();
      for (const row of rows) {
        watch.rows.set(row.sessionId.toLowerCase(), this.present(row, now));
      }
      this.learnPredecessors(watch, files);
      watch.ready = true;
      for (const subscription of watch.subscriptions) this.initialize(subscription);
      watch.touched.clear();
      watch.vanished.clear();
      // What changed since the transcripts were stat'ed.
      watch.rescan = true;
      this.schedule(watch, "now");
    } catch (error) {
      // The rescan tries again.
      this.deps.logError(`session list subscription of ${watch.cwd} failed`, error);
    } finally {
      watch.baselining = false;
    }
  }

  /** Takes the current rows as sent. The sessions that changed while the
   *  first rows were read are sent once. */
  private initialize(subscription: Subscription): void {
    if (subscription.initialized) return;
    subscription.initialized = true;
    const { watch } = subscription;
    for (const [id, { signature, row }] of watch.rows) {
      subscription.sent.set(id, { signature, sessionId: row.sessionId });
    }
    for (const id of watch.touched) {
      subscription.force.add(id);
      subscription.pending.add(id);
    }
    // The client may have listed them before they went.
    for (const [id, sessionId] of watch.vanished) {
      subscription.sent.set(id, { signature: "", sessionId });
      subscription.pending.add(id);
    }
  }

  /** Records which sessions `files` continue in (see {@link predecessors}). */
  private learnPredecessors(watch: ScopeWatch, files: readonly TranscriptCandidate[]): void {
    for (const file of files) {
      const id = file.sessionId.toLowerCase();
      for (const set of watch.predecessors.values()) set.delete(id);
      const successor = this.deps.index.continuedIn(file.filePath)?.toLowerCase();
      if (!successor) continue;
      let set = watch.predecessors.get(successor);
      if (!set) watch.predecessors.set(successor, (set = new Set()));
      set.add(id);
    }
    for (const [successor, set] of watch.predecessors) {
      if (set.size === 0) watch.predecessors.delete(successor);
    }
  }

  private setFiles(watch: ScopeWatch, files: readonly TranscriptCandidate[]): void {
    watch.files.clear();
    watch.filesById.clear();
    for (const file of files) this.putFile(watch, file);
  }

  private putFile(watch: ScopeWatch, file: TranscriptCandidate): void {
    watch.files.set(file.filePath, file);
    const id = file.sessionId.toLowerCase();
    let paths = watch.filesById.get(id);
    if (!paths) watch.filesById.set(id, (paths = new Set()));
    paths.add(file.filePath);
  }

  private dropFile(watch: ScopeWatch, filePath: string, id: string): void {
    watch.files.delete(filePath);
    const paths = watch.filesById.get(id);
    paths?.delete(filePath);
    if (paths?.size === 0) watch.filesById.delete(id);
  }

  private present(row: IndexRow, now: number): Row {
    const own = this.deps.own(row.sessionId);
    const id = row.sessionId.toLowerCase();
    if (own) this.ownShown.add(id);
    else this.ownShown.delete(id);
    const info = sessionInfoOf(row, own, this.live.get(row.sessionId), now);
    return { row, info, signature: changeSignature(info) };
  }

  /** Runs one pass of the pending work of `watch`, one at a time. `files`:
   *  the transcript events and the rescan too, not only the states. */
  private async work(watch: ScopeWatch, files: boolean): Promise<void> {
    // Before the first rows, the events wait: the baseline runs a pass.
    if (!watch.ready || watch.closed) return;
    if (watch.working) {
      watch.again = true;
      watch.againFiles ||= files;
      return;
    }
    const working = (async () => {
      let withFiles = files;
      do {
        withFiles ||= watch.againFiles;
        watch.again = watch.againFiles = false;
        try {
          await this.pass(watch, withFiles);
        } catch (error) {
          this.deps.logError(`session list change check of ${watch.cwd} failed`, error);
        }
        withFiles = false;
      } while (watch.again && !watch.closed);
    })();
    watch.working = working;
    try {
      await working;
    } finally {
      if (watch.working === working) watch.working = undefined;
    }
  }

  private async pass(watch: ScopeWatch, files: boolean): Promise<void> {
    const rescan = files && watch.rescan;
    /** The archive markers a rescan read. */
    let markers: ReadonlySet<string> | undefined;
    const dirtyFiles = files ? [...watch.dirtyFiles] : [];
    const rowIds = new Set(files ? watch.dirtyRows : []);
    const stateIds = new Set(watch.dirtyStates);
    if (files) {
      watch.rescan = false;
      watch.dirtyFiles.clear();
      watch.dirtyRows.clear();
    }
    watch.dirtyStates.clear();

    let resolved = new Map<string, IndexRow>();
    try {
      if (rescan) {
        await this.refreshDirs(watch);
        const files = await this.deps.index.enumerateFiles(watch.paths);
        if (watch.closed) return;
        if (scopeKey(watch.paths) !== watch.resolvedPaths) {
          // A worktree came or went: a transcript that did not change may now
          // be in the scope or out of it (another path of the same project
          // directory). The metadata cache makes this cheap.
          for (const id of watch.filesById.keys()) rowIds.add(id);
          for (const file of files) rowIds.add(file.sessionId.toLowerCase());
        }
        // The sessions of a transcript that is new, changed or gone are
        // resolved again; every state is recomputed (an unfinished turn ages).
        const before = new Map(watch.files);
        for (const file of files) {
          const old = before.get(file.filePath);
          before.delete(file.filePath);
          if (
            !old ||
            old.mtimeMs !== file.mtimeMs ||
            old.size !== file.size ||
            old.ino !== file.ino
          ) {
            rowIds.add(file.sessionId.toLowerCase());
          }
        }
        for (const gone of before.values()) rowIds.add(gone.sessionId.toLowerCase());
        this.setFiles(watch, files);
        // A marker that came or went (the title records of an archive are a
        // transcript change), and a transcript that could not be read before.
        markers = await this.deps.archivedIds();
        if (watch.closed) return;
        for (const id of markers) if (!watch.markers.has(id)) rowIds.add(id);
        for (const id of watch.markers) if (!markers.has(id)) rowIds.add(id);
        for (const id of watch.unreadable) rowIds.add(id);
        watch.unreadable.clear();
        // Only the state of a session that a live process holds depends on
        // the time (an unfinished turn ages).
        for (const sessionId of this.live.keys()) {
          const id = sessionId.toLowerCase();
          if (watch.rows.has(id)) stateIds.add(id);
        }
        for (const id of this.ownShown) if (watch.rows.has(id)) stateIds.add(id);
      } else if (dirtyFiles.length > 0) {
        const stats = await Promise.all(
          dirtyFiles.map((filePath) => fsp.stat(filePath).catch(() => undefined)),
        );
        if (watch.closed) return;
        dirtyFiles.forEach((filePath, i) => {
          const filename = path.basename(filePath);
          const dirName = path.basename(path.dirname(filePath));
          const id = transcriptId(filename)!;
          rowIds.add(id);
          const dir = watch.dirs.get(dirName);
          const fileStats = stats[i];
          if (!dir || !fileStats?.isFile() || fileStats.size === 0) {
            this.dropFile(watch, filePath, id);
            return;
          }
          this.putFile(watch, {
            sessionId: filename.slice(0, -6),
            filePath,
            dirName,
            projectPath: dir.projectPath,
            mtimeMs: fileStats.mtimeMs,
            size: fileStats.size,
            ino: fileStats.ino,
          });
        });
      }

      // A session continued in a changed one may be shown or hidden now.
      for (const id of [...rowIds]) {
        for (const predecessor of watch.predecessors.get(id) ?? []) rowIds.add(predecessor);
      }
      if (rowIds.size > 0) {
        const candidates: TranscriptCandidate[] = [];
        for (const id of rowIds) {
          for (const filePath of watch.filesById.get(id) ?? []) {
            const file = watch.files.get(filePath);
            if (file) candidates.push(file);
          }
        }
        const read = onePerSession(candidates);
        const archived = markers ?? (await this.deps.archivedIds());
        const rows = await this.deps.index.rowsOf(watch.paths, read, archived, () => [
          ...watch.files.values(),
        ]);
        if (watch.closed) return;
        if (!markers) {
          // Only the markers of the sessions read here count as seen: another
          // marker change is left to its event or the rescan.
          const seen = new Set(watch.markers);
          for (const id of rowIds) {
            if (archived.has(id)) seen.add(id);
            else seen.delete(id);
          }
          watch.markers = seen;
        }
        this.learnPredecessors(watch, read);
        resolved = new Map(rows.map((row) => [row.sessionId.toLowerCase(), row]));
        // A transcript there whose read failed is no removal: it keeps its row
        // until a rescan reads it.
        for (const file of read) {
          const id = file.sessionId.toLowerCase();
          if (!resolved.has(id) && !this.deps.index.isRead(file)) {
            watch.unreadable.add(id);
            rowIds.delete(id);
          }
        }
      }
    } catch (error) {
      // What this pass took is left for the next one: the file stats may
      // have moved on, so the sessions are resolved again by id.
      for (const filePath of dirtyFiles) watch.dirtyFiles.add(filePath);
      for (const id of rowIds) watch.dirtyRows.add(id);
      for (const id of stateIds) watch.dirtyStates.add(id);
      if (rescan) watch.rescan = true;
      throw error;
    }
    if (markers) watch.markers = markers;
    if (rescan) watch.resolvedPaths = scopeKey(watch.paths);

    // From here on synchronous: the rows change and are delivered at once.
    const now = this.now();
    const changed = new Set<string>();
    for (const id of rowIds) {
      const row = resolved.get(id);
      if (row) {
        watch.rows.set(id, this.present(row, now));
        changed.add(id);
      } else if (watch.rows.delete(id)) {
        changed.add(id);
      }
    }
    for (const id of stateIds) {
      if (rowIds.has(id)) continue;
      const current = watch.rows.get(id);
      if (!current) continue;
      watch.rows.set(id, this.present(current.row, now));
      changed.add(id);
    }
    for (const subscription of watch.subscriptions) {
      for (const id of changed) subscription.pending.add(id);
      this.deliver(subscription);
    }
  }

  /** Sends the pending sessions of `subscription` that differ from what it
   *  last sent, each at most once per interval, in one notification. */
  private deliver(subscription: Subscription): void {
    const { watch } = subscription;
    if (watch.closed || !subscription.initialized) return;
    if (subscription.timer) clearTimeout(subscription.timer);
    subscription.timer = undefined;
    const now = this.now();
    const sessions: SessionInfo[] = [];
    const removed: string[] = [];
    let nextAt = Infinity;
    for (const id of subscription.pending) {
      const current = watch.rows.get(id);
      const sent = subscription.sent.get(id);
      const unchanged = !current
        ? !sent
        : sent?.signature === current.signature && !subscription.force.has(id);
      if (unchanged) {
        subscription.pending.delete(id);
        subscription.force.delete(id);
        continue;
      }
      const dueAt = (subscription.sentAt.get(id) ?? -Infinity) + this.minIntervalMs;
      if (dueAt > now) {
        nextAt = Math.min(nextAt, dueAt);
        continue;
      }
      subscription.pending.delete(id);
      subscription.force.delete(id);
      subscription.sentAt.set(id, now);
      if (!current) {
        removed.push(sent!.sessionId);
        subscription.sent.delete(id);
        continue;
      }
      sessions.push(current.info);
      subscription.sent.set(id, {
        signature: current.signature,
        sessionId: current.row.sessionId,
      });
    }
    this.forgetOldSends(subscription, now);
    if (nextAt !== Infinity) {
      subscription.timer = setTimeout(() => this.deliver(subscription), nextAt - now);
      subscription.timer.unref?.();
    }
    if (sessions.length === 0 && removed.length === 0) return;
    void this.deps
      .notify({ subscriptionId: subscription.id, sessions, removed })
      .catch((error) => this.deps.logError("session list change notification failed", error));
  }

  /** Drops send times older than the interval: they hold nothing back. */
  private forgetOldSends(subscription: Subscription, now: number): void {
    if (subscription.sentAt.size < 1024) return;
    for (const [id, at] of subscription.sentAt) {
      if (now - at >= this.minIntervalMs) subscription.sentAt.delete(id);
    }
  }
}
