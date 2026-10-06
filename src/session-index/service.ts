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
  hasArchiveMarker,
  writeArchiveMarker,
} from "./archive-markers.js";
import { LIST_CHANGED_METHOD, ListChangedWatcher } from "./list-changed.js";
import { LiveSessionRegistry } from "./live-registry.js";
import { isSessionId } from "./project-dirs.js";
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
const CURSOR_VERSION = 1;

export type SessionIdRequest = { sessionId: string };
export type RenameSessionRequest = { sessionId: string; title: string };

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

type ListOptions = { limit: number; archived: ArchivedFilter };

/** `_meta.jetbrains.air.list` of a list request. */
export function parseListOptions(meta: unknown): ListOptions {
  const list = asRecord(airExtensionMeta(meta)?.list);
  const limit =
    typeof list.limit === "number" && Number.isFinite(list.limit)
      ? Math.min(MAX_LIST_LIMIT, Math.max(1, Math.floor(list.limit)))
      : DEFAULT_LIST_LIMIT;
  const archived = list.archived ?? "exclude";
  if (archived !== "exclude" && archived !== "only") {
    throw RequestError.invalidParams(
      { archived },
      '`_meta.jetbrains.air.list.archived` must be "exclude" or "only"',
    );
  }
  return { limit, archived };
}

type CursorPayload = { v: number; u: number; id: string; cwd: string | null; archived: string };

export function encodeListCursor(
  cursor: ListCursor,
  scope: { cwd: string | null; archived: ArchivedFilter },
): string {
  const payload: CursorPayload = {
    v: CURSOR_VERSION,
    u: cursor.updatedAtMs,
    id: cursor.sessionId,
    cwd: scope.cwd,
    archived: scope.archived,
  };
  return Buffer.from(JSON.stringify(payload)).toString("base64url");
}

/** The position a cursor names. A cursor of another cwd or filter, or one
 *  this adapter did not issue, is rejected. */
export function decodeListCursor(
  cursor: string,
  scope: { cwd: string | null; archived: ArchivedFilter },
): ListCursor {
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
  if (payload.cwd !== scope.cwd || payload.archived !== scope.archived) {
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
 *  title already. */
async function ensureTitleRecord(filePath: string, sessionId: string, title: string) {
  const { line, endsWithNewline } = await lastLine(filePath);
  try {
    const last = JSON.parse(line) as { type?: unknown; customTitle?: unknown };
    if (last.type === "custom-title" && last.customTitle === title) return;
  } catch {
    // Not a record: append.
  }
  const prefix = endsWithNewline || line === "" ? "" : "\n";
  await fs.appendFile(filePath, `${prefix}${customTitleRecord(sessionId, title)}\n`);
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
  if ((await index.findTranscripts(sessionId, { includeEmpty: true })).length === 0) {
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
    const { limit, archived } = parseListOptions(params._meta);
    const cwd = params.cwd ?? null;
    const scope = { cwd, archived };
    const after =
      params.cursor === null || params.cursor === undefined
        ? undefined
        : decodeListCursor(params.cursor, scope);
    // The live registry is read while the transcripts are.
    const livePromise = this.registry.snapshot();
    const archivedIds = await readArchivedSessionIds();
    const { rows, hasMore } = await this.index.list({ cwd, limit, archived, after, archivedIds });
    const live = await livePromise;
    if (cwd) this.watch(cwd);
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
      let meta: Record<string, unknown> | undefined;
      if (row.gitBranch) meta = withAirMeta(meta, "gitBranch", row.gitBranch);
      if (activity) meta = withAirMeta(meta, "activity", activity);
      if (cost !== undefined) {
        meta = withAirMeta(meta, "usage", { cost: { amount: cost, currency: "USD" } });
      }
      return {
        sessionId: row.sessionId,
        cwd: row.cwd,
        title: row.title,
        updatedAt: new Date(row.updatedAtMs).toISOString(),
        ...(meta && { _meta: meta }),
      };
    });
    const last = rows[rows.length - 1];
    return hasMore && last ? { sessions, nextCursor: encodeListCursor(last, scope) } : { sessions };
  }

  /** Throws `thread_active_writer` when another live process holds the
   *  session. A CLI that this process started (one being closed) does not
   *  count. */
  async assertNotHeldElsewhere(sessionId: string): Promise<void> {
    if (await this.registry.holder(sessionId)) throw activeWriterError(sessionId);
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
   *  and writes the title sidecar next to each. `ownedHere`: the session's
   *  query runs in this process, so no other writer is looked for. */
  async renameOffline(
    sessionId: string,
    title: string,
    options: { ownedHere?: boolean } = {},
  ): Promise<void> {
    if (!isSessionId(sessionId)) throw sessionNotFound(sessionId);
    await this.exclusive(sessionId, async () => {
      const transcripts = await this.index.findTranscripts(sessionId);
      if (transcripts.length === 0) throw sessionNotFound(sessionId);
      if (!options.ownedHere) await this.assertNotHeldElsewhere(sessionId);
      try {
        await this.renameSession(sessionId, title);
        for (const transcript of transcripts) {
          await ensureTitleRecord(transcript, sessionId, title);
          await writeCustomTitleSidecar(transcript, title);
        }
      } finally {
        this.index.invalidate(transcripts);
      }
    });
  }

  /** Writes the archive marker. `known` skips the existence check for a
   *  session this connection runs (it may have no transcript yet). */
  async archive(sessionId: string, known: boolean): Promise<void> {
    if (!isSessionId(sessionId)) throw sessionNotFound(sessionId);
    await this.exclusive(sessionId, async () => {
      if (!known && !(await hasArchiveMarker(sessionId))) {
        if ((await this.index.findTranscripts(sessionId)).length === 0) {
          throw sessionNotFound(sessionId);
        }
      }
      await writeArchiveMarker(sessionId);
    });
  }

  async unarchive(sessionId: string, known: boolean): Promise<void> {
    if (!isSessionId(sessionId)) throw sessionNotFound(sessionId);
    await this.exclusive(sessionId, async () => {
      if (await removeArchiveMarker(sessionId)) return;
      if (!known && (await this.index.findTranscripts(sessionId)).length === 0) {
        throw sessionNotFound(sessionId);
      }
    });
  }

  /** Deletes every transcript of the session, then its archive marker. A
   *  failure leaves the marker, so a session it fails to delete stays
   *  archived. `known`: the session was loaded here (and is torn down
   *  already), so a missing transcript is no error. */
  async delete(sessionId: string, known: boolean): Promise<void> {
    if (!isSessionId(sessionId)) throw sessionNotFound(sessionId);
    await this.exclusive(sessionId, async () => {
      const find = () => this.index.findTranscripts(sessionId, { includeEmpty: true });
      const transcripts = await find();
      if (transcripts.length === 0) {
        if (await removeArchiveMarker(sessionId)) return;
        if (known) return;
        throw sessionNotFound(sessionId);
      }
      try {
        // The SDK deletes the first transcript it finds: one call per copy.
        for (let i = 0; i < transcripts.length; i++) {
          try {
            await this.deleteSession(sessionId);
          } catch (error) {
            // A copy removed meanwhile is no failure.
            if ((await find()).length === 0) break;
            throw error;
          }
        }
        const remaining = await find();
        if (remaining.length > 0) {
          throw new Error(
            `Session ${sessionId} was not deleted from ${remaining.map((file) => path.dirname(file)).join(", ")}`,
          );
        }
      } finally {
        this.index.invalidate(transcripts);
      }
      await removeArchiveMarker(sessionId);
    });
  }

  dispose(): void {
    this.disposed = true;
    this.watcher?.dispose();
    this.watcher = undefined;
  }

  private watch(cwd: string): void {
    // A list that was in flight when the connection closed starts nothing.
    if (this.disposed) return;
    this.watcher ??= new ListChangedWatcher({
      projectDirs: async (watchedCwd) => {
        const paths = await this.index.listedPaths(watchedCwd);
        const dirs = await this.index.projectDirs(paths);
        return { dirNames: dirs.map(({ dirName }) => dirName), paths };
      },
      notify: (changedCwd) => this.deps.notifyListChanged({ cwd: changedCwd }),
      logError: this.deps.logError,
    });
    void this.watcher
      .onListed(cwd)
      .catch((error) => this.deps.logError("session list watch failed", error));
  }
}
