/**
 * The live Claude Code processes on this machine, from the CLI's registry.
 *
 * Each running CLI writes `<config>/sessions/<pid>.json` with its session id,
 * kind, entrypoint and status. The format is not documented; the reader keeps
 * to the fields it needs and applies the liveness rules of Claude Desktop:
 *
 * - only `<pid>.json` files are read; `.key` files and other names are never
 *   opened, and no file is ever written or deleted;
 * - a record whose JSON does not parse is read once more, then skipped;
 * - a record of another pid domain (another machine or pid namespace) is
 *   skipped;
 * - the process must be alive: `kill(pid, 0)` succeeds or fails with `EPERM`;
 * - a recorded `procStart` must match the start time of the live process,
 *   so a reused pid does not count;
 * - a record older than 24 hours counts only when its `procStart` matches.
 *
 * A snapshot is cached for {@link SNAPSHOT_TTL_MS}. A holder check before a
 * destructive operation asks for a fresh one.
 */

import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { claudeConfigDir } from "../paths.js";
import { errorCode } from "./project-dirs.js";

const SNAPSHOT_TTL_MS = 5_000;
const STALE_RECORD_MS = 24 * 60 * 60 * 1000;
const PS_TIMEOUT_MS = 1_000;
const RECORD_FILE_PATTERN = /^(\d+)\.json$/;

export type LiveRecord = {
  pid: number;
  sessionId: string;
  cwd?: string;
  kind?: string;
  entrypoint?: string;
  status?: string;
  statusUpdatedAt?: number;
};

export type LiveSnapshot = ReadonlyMap<string, LiveRecord>;

export type LiveRegistryDeps = {
  /** The registry directory. Defaults to `<config>/sessions`. */
  dir?: () => string;
  now?: () => number;
  /** Whether the process is alive. Defaults to `kill(pid, 0)`. */
  isAlive?: (pid: number) => boolean;
  /** The `ps -o lstart=` start time of each live pid. */
  processStarts?: (pids: number[]) => Promise<Map<number, string>>;
  /** This machine's pid domain, as the CLI computes it. */
  pidDomain?: () => Promise<string>;
};

/** `<config>/sessions`, where each CLI process registers itself. */
export function liveRegistryDir(): string {
  return path.join(claudeConfigDir(), "sessions");
}

function defaultIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) === "EPERM";
  }
}

/** The start times of `pids`, from one `ps` call, in the format the CLI
 *  records (`LC_ALL=C TZ=UTC ps -o lstart=`). */
function defaultProcessStarts(pids: number[]): Promise<Map<number, string>> {
  const result = new Map<number, string>();
  if (pids.length === 0 || process.platform === "win32") return Promise.resolve(result);
  return new Promise((resolve) => {
    execFile(
      "ps",
      ["-o", "pid=,lstart=", "-p", pids.join(",")],
      { timeout: PS_TIMEOUT_MS, env: { ...process.env, LC_ALL: "C", TZ: "UTC" } },
      (_error, stdout) => {
        // `ps` exits 1 when one of the pids is gone; its output still holds
        // the live ones.
        for (const line of String(stdout ?? "").split("\n")) {
          const match = /^\s*(\d+)\s+(.+?)\s*$/.exec(line);
          if (match) result.set(Number(match[1]), normalizeStart(match[2]!));
        }
        resolve(result);
      },
    );
  });
}

function normalizeStart(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

let cachedPidDomain: Promise<string> | undefined;

/** The pid domain the CLI records: the platform on macOS, the machine id and
 *  pid namespace on Linux, the host name on Windows. */
function defaultPidDomain(): Promise<string> {
  cachedPidDomain ??= (async () => {
    if (process.platform === "win32") return `win32:${os.hostname().toLowerCase()}`;
    if (process.platform !== "linux") return process.platform;
    const [machineId, pidNamespace] = await Promise.all([
      fs.readFile("/etc/machine-id", "utf8").then(
        (value) => value.trim(),
        () => "",
      ),
      fs.readlink("/proc/self/ns/pid").catch(() => ""),
    ]);
    return `linux:${machineId}:${pidNamespace}`;
  })();
  return cachedPidDomain;
}

type RawRecord = Record<string, unknown>;

async function readRecord(file: string): Promise<RawRecord | undefined> {
  for (let attempt = 0; attempt < 2; attempt++) {
    let text: string;
    try {
      text = await fs.readFile(file, "utf8");
    } catch {
      return undefined;
    }
    try {
      const value: unknown = JSON.parse(text);
      return value && typeof value === "object" && !Array.isArray(value)
        ? (value as RawRecord)
        : undefined;
    } catch {
      // The CLI may be rewriting the file; read it once more.
    }
  }
  return undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export class LiveSessionRegistry {
  private cached?: { at: number; snapshot: Promise<LiveSnapshot> };
  private readonly dir: () => string;
  private readonly now: () => number;
  private readonly isAlive: (pid: number) => boolean;
  private readonly processStarts: (pids: number[]) => Promise<Map<number, string>>;
  private readonly pidDomain: () => Promise<string>;

  constructor(deps: LiveRegistryDeps = {}) {
    this.dir = deps.dir ?? liveRegistryDir;
    this.now = deps.now ?? Date.now;
    this.isAlive = deps.isAlive ?? defaultIsAlive;
    this.processStarts = deps.processStarts ?? defaultProcessStarts;
    this.pidDomain = deps.pidDomain ?? defaultPidDomain;
  }

  /** The live records by session id. Cached for 5 s unless `fresh`. */
  snapshot(options: { fresh?: boolean } = {}): Promise<LiveSnapshot> {
    const now = this.now();
    if (!options.fresh && this.cached && now - this.cached.at < SNAPSHOT_TTL_MS) {
      return this.cached.snapshot;
    }
    const snapshot = this.read().catch(() => new Map<string, LiveRecord>());
    this.cached = { at: now, snapshot };
    return snapshot;
  }

  /** The live record of `sessionId` from a fresh read, if a process holds it. */
  async holder(sessionId: string): Promise<LiveRecord | undefined> {
    return (await this.snapshot({ fresh: true })).get(sessionId);
  }

  private async read(): Promise<LiveSnapshot> {
    const dir = this.dir();
    let names: string[];
    try {
      names = await fs.readdir(dir);
    } catch {
      return new Map();
    }
    const domain = await this.pidDomain();
    const candidates: { pid: number; raw: RawRecord }[] = [];
    await Promise.all(
      names.map(async (name) => {
        const match = RECORD_FILE_PATTERN.exec(name);
        if (!match) return;
        const pid = Number(match[1]);
        const raw = await readRecord(path.join(dir, name));
        if (!raw || raw.pid !== pid || typeof raw.sessionId !== "string") return;
        if (typeof raw.pidDomain === "string" && raw.pidDomain !== domain) return;
        if (!this.isAlive(pid)) return;
        candidates.push({ pid, raw });
      }),
    );
    const needStarts = candidates
      .filter(({ raw }) => typeof raw.procStart === "string")
      .map(({ pid }) => pid);
    const starts = needStarts.length > 0 ? await this.processStarts(needStarts) : new Map();
    const now = this.now();
    const result = new Map<string, LiveRecord>();
    for (const { pid, raw } of candidates) {
      const recorded =
        typeof raw.procStart === "string" ? normalizeStart(raw.procStart) : undefined;
      const actual = starts.get(pid);
      if (recorded !== undefined && actual !== undefined && recorded !== actual) continue;
      const procStartMatches = recorded !== undefined && actual === recorded;
      const lastSeen = Math.max(
        finiteNumber(raw.updatedAt) ?? 0,
        finiteNumber(raw.statusUpdatedAt) ?? 0,
        finiteNumber(raw.startedAt) ?? 0,
      );
      if (now - lastSeen > STALE_RECORD_MS && !procStartMatches) continue;
      const record: LiveRecord = {
        pid,
        sessionId: raw.sessionId as string,
        cwd: optionalString(raw.cwd),
        kind: optionalString(raw.kind),
        entrypoint: optionalString(raw.entrypoint),
        status: optionalString(raw.status),
        statusUpdatedAt: finiteNumber(raw.statusUpdatedAt),
      };
      const previous = result.get(record.sessionId);
      if (!previous || (record.statusUpdatedAt ?? 0) > (previous.statusUpdatedAt ?? 0)) {
        result.set(record.sessionId, record);
      }
    }
    return result;
  }
}
