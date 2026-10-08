/**
 * `_session/list/subscribe`: pushes the changed rows of a cwd's session list
 * to a `sessionIndex` client.
 *
 * A subscription covers the sessions of its cwd and of the same subdirectory
 * in every linked worktree (the `includeWorktrees` scope of the list), in any
 * archive state. All subscriptions of one cwd share one {@link ScopeWatch}:
 * a non-recursive `fs.watch` on each project directory of the scope, the
 * stats of its transcripts, and the row of each session read since. The
 * registry, the archive markers and the projects root are watched once per
 * connection.
 *
 * Subscribe reads no row: it opens the watchers, stats the transcripts and
 * reads the registry and the archive markers. A row is read on the first
 * event of its session and sent unconditionally; later rows are compared
 * with it.
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
 * once a second per subscription. A rescan every 10 s stats the scope again
 * and reads the transcripts whose stat changed (or whose marker came or
 * went, or whose last read failed), which covers events `fs.watch` missed;
 * the state of a live session ages from the metadata the index holds.
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
    | "listedPaths"
    | "projectDirs"
    | "enumerateFiles"
    | "rowsOf"
    | "cachedRowsOf"
    | "continuedIn"
    | "isRead"
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
  /** When it subscribed, on the {@link ListSubscriptions.seq} clock. */
  since: number;
  /** What was last sent per session (lower-case id): the row's signature,
   *  or null for a removal, and the id as the transcript spells it. A
   *  session without an entry was never sent: its next change is sent
   *  whatever it is. */
  sent: Map<string, { signature: string | null; sessionId: string }>;
  sentAt: Map<string, number>;
  /** Sessions to compare with `sent` at the next delivery, with the id as
   *  the transcript spells it. */
  pending: Map<string, string>;
  /** Fires when a session held back by the interval may be sent. */
  timer?: ReturnType<typeof setTimeout>;
};

/** The watching of one cwd, shared by its subscriptions. */
type ScopeWatch = {
  key: string;
  cwd: string;
  paths: string[];
  /** Project directory name → the scope path it belongs to, its watcher,
   *  and the directory the watcher watches. */
  dirs: Map<string, WatchedDir>;
  /** Every non-empty transcript file of the scope, as last stat'ed. */
  files: Map<string, TranscriptCandidate>;
  /** The file paths of each session (lower-case id). */
  filesById: Map<string, Set<string>>;
  /** The sessions (lower-case ids) whose first transcript appeared after
   *  the watch was ready, on the {@link ListSubscriptions.seq} clock: a
   *  subscription older than that never had them listed. */
  born: Map<string, number>;
  /** The current row of each session (lower-case id) in the scope that was
   *  read since the watch started. */
  rows: Map<string, Row>;
  subscriptions: Set<Subscription>;
  started: Promise<void>;
  /** The transcripts are stat'ed and the registry and markers read. */
  ready: boolean;
  /** When it became ready: about when its client listed the sessions. */
  readyAt: number;
  closed: boolean;
  dirtyFiles: Set<string>;
  /** Sessions whose row is resolved again (from the cache when unchanged). */
  dirtyRows: Set<string>;
  /** Sessions whose row is presented again: their state may have changed. */
  dirtyStates: Set<string>;
  rescan: boolean;
  /** The session each session read here is continued in (lower-case ids),
   *  by its metadata: a change of the successor may show or hide it. */
  successorOf: Map<string, string>;
  /** Live continued sessions that a seed found hidden by their successor,
   *  with the stats of both then: not checked again until one changes. */
  hiddenSeeds: Map<string, string>;
  /** The scope paths the rows were last resolved against. */
  resolvedPaths: string;
  /** The archive markers the rows were last read with (at first, those of
   *  the start). */
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
  /** Orders subscriptions and session births (see {@link ScopeWatch.born}). */
  private seq = 0;
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
   *  return on. Reads no row (see {@link createWatch}). */
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
      since: ++this.seq,
      sent: new Map(),
      sentAt: new Map(),
      pending: new Map(),
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
      if (watch.ready && watch.rows.has(id)) {
        watch.dirtyStates.add(id);
        this.schedule(watch, "states");
      } else if (!watch.ready || watch.filesById.has(id)) {
        // Its first event here: the row is read.
        watch.dirtyRows.add(id);
        this.schedule(watch, "now");
      }
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
      born: new Map(),
      rows: new Map(),
      subscriptions: new Set(),
      started: Promise.resolve(),
      ready: false,
      readyAt: 0,
      closed: false,
      dirtyFiles: new Set(),
      dirtyRows: new Set(),
      dirtyStates: new Set(),
      rescan: false,
      successorOf: new Map(),
      hiddenSeeds: new Map(),
      markers: new Set(),
      unreadable: new Set(),
      resolvedPaths: "",
      again: false,
      againFiles: false,
    };
    // When subscribe returns, the watchers are open; no row is read. What it
    // keeps, all without reading a transcript:
    // - the stats of the transcripts, opened after the watchers: a deletion
    //   or a move out of the scope is a stat that went, the rescan reads only
    //   a transcript whose stat changed, and a session's other copies are
    //   known when its row is read;
    // - the archive markers: the rescan reads only a session whose marker
    //   came or went;
    // - the registry: a later change of it is an event of the sessions whose
    //   record changed.
    watch.started = this.refreshDirs(watch).then(async () => {
      const [files, markers] = await Promise.all([
        this.deps.index.enumerateFiles(watch.paths),
        this.deps.archivedIds(),
      ]);
      await this.registryLoaded;
      if (watch.closed) return;
      this.setFiles(watch, files);
      this.learnSuccessors(watch);
      watch.markers = markers;
      watch.resolvedPaths = scopeKey(watch.paths);
      // The rows of the live sessions a list read: their state ages from now.
      const seeded = await this.liveSeeds(watch, new Set(), markers);
      if (watch.closed) return;
      watch.ready = true;
      watch.readyAt = this.now();
      for (const row of seeded) {
        watch.rows.set(row.sessionId.toLowerCase(), this.present(row, watch.readyAt));
      }
      // Events of the start, held until now.
      if (
        watch.dirtyFiles.size > 0 ||
        watch.dirtyRows.size > 0 ||
        watch.dirtyStates.size > 0 ||
        watch.rescan
      ) {
        this.schedule(watch, "debounced");
      }
    });
    void watch.started.catch(() => this.closeWatch(watch));
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
    watch.born.clear();
    watch.successorOf.clear();
    watch.hiddenSeeds.clear();
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
      if (!watch.ready) continue;
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
      // Before the watch is ready, held until it is.
      watch.dirtyFiles.add(path.join(projectsRoot(), dirName, filename));
    }
    this.schedule(watch, "debounced");
  }

  private onArchiveEvent(filename: string | null): void {
    for (const watch of this.watches.values()) {
      if (filename === null) {
        watch.rescan = true;
      } else if (isSessionId(filename)) {
        watch.dirtyRows.add(filename.toLowerCase());
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
      let states = false;
      let rows = false;
      for (const id of affected) {
        if (watch.ready && watch.rows.has(id)) {
          watch.dirtyStates.add(id);
          states = true;
        } else if (!watch.ready || watch.filesById.has(id)) {
          // Its first event here: the row is read.
          watch.dirtyRows.add(id);
          rows = true;
        }
      }
      if (states) this.schedule(watch, "states");
      if (rows) this.schedule(watch, "debounced");
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

  private setFiles(watch: ScopeWatch, files: readonly TranscriptCandidate[]): void {
    const before = watch.filesById;
    watch.files = new Map();
    watch.filesById = new Map();
    for (const file of files) this.putFile(watch, file, before);
  }

  /** `known`: the sessions with a transcript before; another one is born. */
  private putFile(
    watch: ScopeWatch,
    file: TranscriptCandidate,
    known: ReadonlyMap<string, unknown> = watch.filesById,
  ): void {
    watch.files.set(file.filePath, file);
    const id = file.sessionId.toLowerCase();
    if (watch.ready && !known.has(id)) watch.born.set(id, ++this.seq);
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
    // Before the transcripts are stat'ed, the events wait: the start runs a
    // pass for them.
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
    /** Sessions whose state may have aged: sent only when it changed. */
    const agedIds = new Set<string>();
    /** The scope paths and the transcripts of each session read again, as
     *  they were before this pass. */
    const priorPaths = watch.paths;
    const priorFiles = new Map<string, TranscriptCandidate[]>();
    const remember = (id: string) => {
      if (!priorFiles.has(id)) priorFiles.set(id, this.filesOf(watch, id));
    };
    if (files) {
      watch.rescan = false;
      watch.dirtyFiles.clear();
      watch.dirtyRows.clear();
    }
    watch.dirtyStates.clear();

    let resolved = new Map<string, IndexRow>();
    /** Rows of live sessions not read here, from the metadata the index
     *  holds: their state ages from now on. */
    let seeded: IndexRow[] = [];
    /** Sessions that may have had a row before this pass. */
    let shownBefore = new Set<string>();
    try {
      if (rescan) {
        await this.refreshDirs(watch);
        const files = await this.deps.index.enumerateFiles(watch.paths);
        if (watch.closed) return;
        // The sessions of a transcript that is new, changed or gone are
        // read again; one whose stat did not change is not read.
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
        for (const id of rowIds) remember(id);
        this.setFiles(watch, files);
        this.learnSuccessors(watch);
        if (scopeKey(watch.paths) !== watch.resolvedPaths) {
          // A worktree came or went: a transcript that did not change may now
          // be in the scope or out of it (another path of the same project
          // directory). Resolved again: the sessions read here, and those whose
          // metadata the index holds (a list read them); both without reading
          // a transcript.
          for (const id of watch.rows.keys()) rowIds.add(id);
          for (const file of files) {
            if (this.deps.index.isRead(file)) rowIds.add(file.sessionId.toLowerCase());
          }
        }
        // A marker that came or went (the title records of an archive are a
        // transcript change), and a transcript that could not be read before.
        markers = await this.deps.archivedIds();
        if (watch.closed) return;
        for (const id of markers) if (!watch.markers.has(id)) rowIds.add(id);
        for (const id of watch.markers) if (!markers.has(id)) rowIds.add(id);
        for (const id of watch.unreadable) rowIds.add(id);
        watch.unreadable.clear();
        // Only the state of a session that a live process holds depends on
        // the time (an unfinished turn ages). One without a row read here
        // gets it from the metadata the index holds (a list read it), not
        // from its transcript; if it has none, the client did not list it.
        for (const sessionId of this.live.keys()) {
          const id = sessionId.toLowerCase();
          if (watch.rows.has(id)) agedIds.add(id);
        }
        seeded = await this.liveSeeds(watch, rowIds, markers);
        if (watch.closed) return;
        for (const id of this.ownShown) if (watch.rows.has(id)) agedIds.add(id);
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
          remember(id);
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

      if (rowIds.size > 0) {
        // A session continued in a changed one may be shown or hidden now.
        // Which sessions those are is known from the reads here and from
        // the metadata the index holds: a session that no list or event read
        // was not shown.
        const successors = new Set(rowIds);
        for (const [id, successor] of watch.successorOf) {
          if (successors.has(successor)) rowIds.add(id);
        }
        for (const file of watch.files.values()) {
          const successor = this.deps.index.continuedIn(file.filePath)?.toLowerCase();
          if (successor && successors.has(successor)) rowIds.add(file.sessionId.toLowerCase());
        }
        for (const id of rowIds) remember(id);
        // Before the read below replaces the metadata the index holds.
        shownBefore = await this.shownBefore(watch, priorPaths, rowIds, priorFiles);
        if (watch.closed) return;
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
        resolved = new Map(rows.map((row) => [row.sessionId.toLowerCase(), row]));
        for (const file of read) {
          const id = file.sessionId.toLowerCase();
          const successor = this.deps.index.continuedIn(file.filePath)?.toLowerCase();
          if (successor) watch.successorOf.set(id, successor);
          else if (this.deps.index.isRead(file)) watch.successorOf.delete(id);
        }
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
    /** The changed sessions, with the id as the transcript spells it. */
    const changed = new Map<string, string>();
    /** Sessions without a row now. */
    const absent = new Set<string>();
    for (const id of rowIds) {
      const row = resolved.get(id);
      if (row) {
        watch.rows.set(id, this.present(row, now));
        changed.set(id, row.sessionId);
        continue;
      }
      const previous = watch.rows.get(id);
      watch.rows.delete(id);
      if (!previous && !shownBefore.has(id)) continue;
      changed.set(id, previous?.row.sessionId ?? priorFiles.get(id)![0]!.sessionId);
      absent.add(id);
    }
    for (const row of seeded) {
      const id = row.sessionId.toLowerCase();
      if (rowIds.has(id) || watch.rows.has(id)) continue;
      // As the client listed it, about when the watch became ready: a state
      // that aged since is sent below.
      watch.rows.set(id, this.present(row, watch.readyAt));
      agedIds.add(id);
    }
    for (const id of new Set([...stateIds, ...agedIds])) {
      if (rowIds.has(id)) continue;
      const current = watch.rows.get(id);
      if (!current) continue;
      const next = this.present(current.row, now);
      watch.rows.set(id, next);
      // An event of the session, or a state that aged.
      if (stateIds.has(id) || next.signature !== current.signature) {
        changed.set(id, next.row.sessionId);
      }
    }
    for (const subscription of watch.subscriptions) {
      for (const [id, sessionId] of changed) {
        const born = watch.born.get(id);
        if (
          absent.has(id) &&
          !subscription.sent.has(id) &&
          born !== undefined &&
          born > subscription.since
        ) {
          // Born after the subscription and never sent: nothing to remove.
          subscription.pending.delete(id);
          continue;
        }
        subscription.pending.set(id, sessionId);
      }
      this.deliver(subscription);
    }
    // A session without a transcript now, shown or not: a removal already
    // sent for it is forgotten too.
    for (const id of rowIds) {
      if (watch.filesById.has(id)) continue;
      watch.born.delete(id);
      watch.successorOf.delete(id);
      watch.hiddenSeeds.delete(id);
      for (const subscription of watch.subscriptions) {
        if (subscription.sent.get(id)?.signature === null && !subscription.pending.has(id)) {
          subscription.sent.delete(id);
        }
      }
    }
  }

  /** Records which session each transcript is continued in, by the metadata
   *  the index holds now (a list read it): kept when the index evicts it.
   *  Reads nothing. */
  private learnSuccessors(watch: ScopeWatch): void {
    for (const file of watch.files.values()) {
      const successor = this.deps.index.continuedIn(file.filePath);
      if (successor) watch.successorOf.set(file.sessionId.toLowerCase(), successor.toLowerCase());
    }
  }

  /**
   * The rows of the live sessions of the scope without a row here (and not
   * in `except`), from the metadata the index holds (a list read them), not
   * from their transcripts; one it holds nothing for the client did not
   * list. Reads no transcript: a continued one only checks its successor.
   */
  private async liveSeeds(
    watch: ScopeWatch,
    except: ReadonlySet<string>,
    markers: ReadonlySet<string>,
  ): Promise<IndexRow[]> {
    const seeds: TranscriptCandidate[] = [];
    for (const sessionId of this.live.keys()) {
      const id = sessionId.toLowerCase();
      if (!watch.rows.has(id) && !except.has(id)) seeds.push(...this.filesOf(watch, id));
    }
    if (seeds.length === 0) return [];
    const read = onePerSession(seeds);
    const cached = await this.deps.index.cachedRowsOf(watch.paths, read, markers);
    // A continued one is shown while its successor has no history: its
    // cached metadata and that check, made again only when the stat of
    // either changed.
    const statOf = (file: TranscriptCandidate | undefined) =>
      file ? `${file.mtimeMs}:${file.size}:${file.ino}` : "-";
    const continued: { file: TranscriptCandidate; key: string }[] = [];
    for (const file of read) {
      const id = file.sessionId.toLowerCase();
      const successor = this.deps.index.continuedIn(file.filePath);
      if (!cached.unknown.has(id) || !this.deps.index.isRead(file) || !successor) continue;
      const successorFile = watch.files.get(
        path.join(path.dirname(file.filePath), `${successor}.jsonl`),
      );
      const key = `${statOf(file)}|${statOf(successorFile)}`;
      if (watch.hiddenSeeds.get(id) !== key) continued.push({ file, key });
    }
    if (continued.length === 0) return cached.rows;
    const rows = await this.deps.index.rowsOf(
      watch.paths,
      continued.map(({ file }) => file),
      markers,
      () => [],
    );
    const shown = new Set(rows.map((row) => row.sessionId.toLowerCase()));
    for (const { file, key } of continued) {
      const id = file.sessionId.toLowerCase();
      if (shown.has(id)) watch.hiddenSeeds.delete(id);
      else watch.hiddenSeeds.set(id, key);
    }
    return [...cached.rows, ...rows];
  }

  /** The transcripts of a session (lower-case id) the watch knows. */
  private filesOf(watch: ScopeWatch, id: string): TranscriptCandidate[] {
    const files: TranscriptCandidate[] = [];
    for (const filePath of watch.filesById.get(id) ?? []) {
      const file = watch.files.get(filePath);
      if (file) files.push(file);
    }
    return files;
  }

  /**
   * Which of `ids`, without a row read here, may have had a row in the scope
   * before: those that the metadata the index holds for their earlier
   * transcripts (a list read them) gives a row, and those it gives no answer
   * for (unknown: a removal is sent once). Not a session without a
   * transcript before, nor one known to have had no row (another path of
   * the project directory, a hidden session). Reads no transcript.
   */
  private async shownBefore(
    watch: ScopeWatch,
    paths: readonly string[],
    ids: ReadonlySet<string>,
    priorFiles: ReadonlyMap<string, readonly TranscriptCandidate[]>,
  ): Promise<Set<string>> {
    const candidates: TranscriptCandidate[] = [];
    for (const id of ids) {
      if (!watch.rows.has(id)) candidates.push(...(priorFiles.get(id) ?? []));
    }
    if (candidates.length === 0) return new Set();
    const { rows, unknown } = await this.deps.index.cachedRowsOf(
      paths,
      onePerSession(candidates),
      watch.markers,
    );
    for (const row of rows) unknown.add(row.sessionId.toLowerCase());
    return unknown;
  }

  /** Sends the pending sessions of `subscription` that differ from what it
   *  last sent (a session never sent differs), each at most once per
   *  interval, in one notification. */
  private deliver(subscription: Subscription): void {
    const { watch } = subscription;
    if (watch.closed) return;
    if (subscription.timer) clearTimeout(subscription.timer);
    subscription.timer = undefined;
    const now = this.now();
    const sessions: SessionInfo[] = [];
    const removed: string[] = [];
    let nextAt = Infinity;
    for (const [id, sessionId] of subscription.pending) {
      const current = watch.rows.get(id);
      const sent = subscription.sent.get(id);
      const unchanged = current
        ? sent?.signature === current.signature
        : sent !== undefined && sent.signature === null;
      if (unchanged) {
        subscription.pending.delete(id);
        continue;
      }
      const dueAt = (subscription.sentAt.get(id) ?? -Infinity) + this.minIntervalMs;
      if (dueAt > now) {
        nextAt = Math.min(nextAt, dueAt);
        continue;
      }
      subscription.pending.delete(id);
      subscription.sentAt.set(id, now);
      if (!current) {
        removed.push(sent?.sessionId ?? sessionId);
        // A session with a transcript but no row (hidden, or of another
        // path) is remembered as removed; one without a transcript is
        // forgotten.
        if (watch.filesById.has(id)) {
          subscription.sent.set(id, { signature: null, sessionId: sent?.sessionId ?? sessionId });
        } else {
          subscription.sent.delete(id);
        }
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
