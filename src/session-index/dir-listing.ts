/**
 * File system reads of the session index that stay cheap with thousands of
 * transcripts: bounded batches of stats, and directory listings that are
 * read again only when the directory changed.
 */

import * as fs from "node:fs";

/** Stats in flight at once, across all callers of {@link statFiles}. */
const STAT_CONCURRENCY = 512;
let statsInFlight = 0;
/** Queued stats, a FIFO read from `waitingHead` (no `shift()`: the queue
 *  can hold tens of thousands). */
let waitingStats: (() => void)[] = [];
let waitingHead = 0;

function nextWaitingStat(): (() => void) | undefined {
  if (waitingHead >= waitingStats.length) return undefined;
  const next = waitingStats[waitingHead++];
  if (waitingHead > 1024 && waitingHead * 2 > waitingStats.length) {
    waitingStats = waitingStats.slice(waitingHead);
    waitingHead = 0;
  }
  return next;
}

/** Runs `stat` once fewer than {@link STAT_CONCURRENCY} are in flight. */
function statBounded(filePath: string, done: (stats: fs.Stats | undefined) => void): void {
  const run = () => {
    statsInFlight++;
    fs.stat(filePath, (error, stats) => {
      statsInFlight--;
      nextWaitingStat()?.();
      done(error ? undefined : stats);
    });
  };
  if (statsInFlight < STAT_CONCURRENCY) run();
  else waitingStats.push(run);
}

/**
 * The stats of `filePaths` (undefined for one that is gone). A project
 * directory holds thousands of transcripts: the callback API costs about
 * half of one promise per file, and a bounded number in flight, shared by
 * all callers, keeps each turn of the event loop short (dispatching
 * thousands at once holds it for 100 ms and more). Unlike synchronous
 * stats, a file system stall never holds the event loop.
 */
export function statFiles(filePaths: readonly string[]): Promise<(fs.Stats | undefined)[]> {
  const result: (fs.Stats | undefined)[] = new Array(filePaths.length);
  if (filePaths.length === 0) return Promise.resolve(result);
  return new Promise((resolve) => {
    let left = filePaths.length;
    filePaths.forEach((filePath, i) => {
      statBounded(filePath, (stats) => {
        result[i] = stats;
        if (--left === 0) resolve(result);
      });
    });
  });
}

type Listing = {
  mtimeMs: number;
  /** When the listing was read. */
  readAt: number;
  names: string[];
  byLowerName?: Map<string, string[]>;
};

/** A listing read this soon after the directory changed is not trusted:
 *  some file systems keep the mtime in whole seconds, so another change in
 *  the same second would leave it unchanged. */
const MTIME_RESOLUTION_MS = 2000;

/**
 * Directory listings, read again only when the directory's mtime changed
 * (an entry was added, removed or renamed; an append to a file does not
 * change it). A project directory with thousands of transcripts is then one
 * stat instead of one `readdir` per list or mutation.
 */
export class DirListings {
  private readonly listings = new Map<string, Listing>();

  /** The entry names of `dir`, empty when it cannot be read. */
  async names(dir: string): Promise<string[]> {
    return (await this.listing(dir, await statOrUndefined(dir))).names;
  }

  /** The entry names of each of `dirs`, one bounded batch of stats. */
  async namesOfAll(dirs: readonly string[]): Promise<string[][]> {
    const stats = await statFiles(dirs);
    return Promise.all(dirs.map(async (dir, i) => (await this.listing(dir, stats[i])).names));
  }

  /** The entry names of each of `dirs` that equal `name` in any case. */
  async matchingInAll(dirs: readonly string[], name: string): Promise<string[][]> {
    return (await this.matchingAnyInAll(dirs, [name])).map((byName) => byName[0]!);
  }

  /** For each of `dirs`, and each of `names`, the entries that equal the
   *  name in any case: one validation of the listings for all names. */
  async matchingAnyInAll(dirs: readonly string[], names: readonly string[]): Promise<string[][][]> {
    const stats = await statFiles(dirs);
    return Promise.all(
      dirs.map(async (dir, i) => {
        const listing = await this.listing(dir, stats[i]);
        listing.byLowerName ??= byLowerName(listing.names);
        const index = listing.byLowerName;
        return names.map((name) => index.get(name.toLowerCase()) ?? []);
      }),
    );
  }

  private async listing(dir: string, stats: fs.Stats | undefined): Promise<Listing> {
    if (!stats?.isDirectory()) {
      this.listings.delete(dir);
      return { mtimeMs: 0, readAt: 0, names: [] };
    }
    const cached = this.listings.get(dir);
    if (
      cached &&
      cached.mtimeMs === stats.mtimeMs &&
      cached.readAt - cached.mtimeMs > MTIME_RESOLUTION_MS
    ) {
      return cached;
    }
    const readAt = Date.now();
    let names: string[];
    try {
      names = await fs.promises.readdir(dir);
    } catch {
      return { mtimeMs: 0, readAt, names: [] };
    }
    const listing: Listing = { mtimeMs: stats.mtimeMs, readAt, names };
    this.listings.set(dir, listing);
    return listing;
  }
}

function byLowerName(names: readonly string[]): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (const name of names) {
    const key = name.toLowerCase();
    const list = result.get(key);
    if (list) list.push(name);
    else result.set(key, [name]);
  }
  return result;
}

function statOrUndefined(target: string): Promise<fs.Stats | undefined> {
  return fs.promises.stat(target).then(
    (stats) => stats,
    () => undefined,
  );
}
