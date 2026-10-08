/**
 * The session index of one ACP connection: what `ClaudeAcpAgent` does for a
 * client that declared `sessionIndex`, and the archive of an AIR client
 * without it. The agent keeps thin call sites; everything else
 * lives here.
 *
 * Wire contract: docs/air-extensions.md, "Session index".
 */

import {
  RequestError,
  type AgentApp,
  type DeleteSessionRequest,
  type DeleteSessionResponse,
  type InitializeRequest,
  type ListSessionsRequest,
  type ListSessionsResponse,
} from "@agentclientprotocol/sdk";
import { deleteSession as sdkDeleteSession } from "@anthropic-ai/claude-agent-sdk";
import type { Query } from "@anthropic-ai/claude-agent-sdk";
import type { AcpClient, Logger, Session } from "../acp-agent.js";
import {
  AIR_SESSION_ARCHIVE_CAPABILITY,
  AIR_SESSION_INDEX_CAPABILITY,
  AIR_SESSION_RENAME_CAPABILITY,
  clientSupportsAirCapability,
  withAirMeta,
} from "../air-extension.js";
import type { OwnSessionState } from "./activity.js";
import { readArchivedSessionIds } from "./archive-markers.js";
import { isArchivedTitle, storedTitle, visibleTitle } from "./archive-title.js";
import { isSessionId } from "./project-dirs.js";
import {
  archiveInsteadOfDelete,
  archiveTo,
  renameTo,
  LIST_CHANGED_METHOD,
  parseRenameSessionRequest,
  parseSessionIdRequest,
  SESSION_ARCHIVE_METHOD,
  SESSION_RENAME_METHOD,
  SESSION_UNARCHIVE_METHOD,
  SessionIndexService,
  type RenameSessionRequest,
  type RetitleOptions,
  type SessionIdRequest,
  type TitleChange,
} from "./service.js";

/** How long a closed CLI may still be exiting (the SDK kills it after 7 s). */
const CLOSED_CLI_MEMORY_MS = 30_000;

/** What the session index keeps on each `Session`. */
export type SessionIndexFields = {
  /** When the last turn ended (the last `session_state_changed: idle`), epoch
   *  ms. Reported as `lastTurnEndedAt` in the session index. */
  lastTurnEndedAt?: number;
  /** `total_cost_usd` of the last result, reported as the cost of the session
   *  in the session index. */
  lastTotalCostUsd?: number;
  /** The query resumed a stored conversation (load, resume, fork): the
   *  session has a transcript, unlike a new one before its first turn. */
  resumedFromHistory?: boolean;
};

/** Records the end of a turn at `session_state_changed`. */
export function noteSessionState(
  session: Session,
  previous: Session["lastSessionState"],
  state: Session["lastSessionState"],
): void {
  if (state === "idle" && previous !== "idle") session.lastTurnEndedAt = Date.now();
}

/** What the connection needs from the agent. */
export type SessionIndexHost = {
  /** Read when used: the agent may still be under construction. */
  agent: {
    readonly sessions: { [key: string]: Session };
    readonly client: AcpClient;
    readonly logger: Logger;
  };
  /** Whether the client is an AIR client. */
  isAirClient(): boolean;
  teardownSession(sessionId: string): Promise<void>;
};

type EmptyResponse = Record<string, never>;

export class SessionIndexConnection {
  /**
   * The session index of a client that declared `sessionIndex`. Undefined for
   * every other client, which keeps the session list, delete and the watchers
   * exactly as before.
   */
  service?: SessionIndexService;
  /** The archive behind `session/delete` of an AIR client without
   *  `sessionIndex`: the same writes, without a list or a watcher. */
  private archiver?: SessionIndexService;
  /** When this connection last closed the CLI of a session, by lower-case
   *  id: the session index takes a lone registry holder whose parent it
   *  cannot tell for that CLI while it exits. */
  readonly closedCliSessions = new Map<string, number>();

  constructor(private readonly host: SessionIndexHost) {}

  /** Sets the index up for the client of `initialize`. ACP v2 does not route
   *  the session index methods yet. */
  negotiate(request: InitializeRequest, options: { v2: boolean }): void {
    this.service?.dispose();
    this.service = undefined;
    if (
      !options.v2 &&
      this.host.isAirClient() &&
      clientSupportsAirCapability(request.clientCapabilities, AIR_SESSION_INDEX_CAPABILITY)
    ) {
      this.service = new SessionIndexService({
        notifyListChanged: (params) =>
          this.host.agent.client.extNotification(LIST_CHANGED_METHOD, params),
        logError: (message, error) =>
          this.host.agent.logger.error(`[session-index] ${message}:`, error),
      });
    }
  }

  /** A stored title as the client shows it: a `sessionIndex` client gets
   *  the title of an archived session without the archive prefix, as in
   *  its list; every other client the title as stored. */
  clientTitle(title: string): string {
    return this.service && isArchivedTitle(title) ? visibleTitle(title) : title;
  }

  /** The AIR capabilities the agent advertises for the index: the index
   *  itself, archive and rename, all only to a client that declared
   *  `sessionIndex`. */
  capabilities(): string[] {
    return this.service
      ? [
          AIR_SESSION_INDEX_CAPABILITY,
          AIR_SESSION_ARCHIVE_CAPABILITY,
          AIR_SESSION_RENAME_CAPABILITY,
        ]
      : [];
  }

  dispose(): void {
    this.service?.dispose();
  }

  onTeardown(sessionId: string): void {
    this.closedCliSessions.set(sessionId.toLowerCase(), Date.now());
  }

  /** `session/list` of a `sessionIndex` client; undefined for another one. */
  list(params: ListSessionsRequest): Promise<ListSessionsResponse> | undefined {
    return this.service?.list(params, (sessionId) => this.ownSessionState(sessionId));
  }

  /** An AIR client archives with session/delete (see {@link deleteSession}):
   *  its archived sessions (an archived custom title, or an archive marker)
   *  stay hidden from the old list, as when the delete removed them. */
  async hideArchived<T extends { sessionId: string; customTitle?: string }>(
    sessions: T[],
  ): Promise<T[]> {
    if (!this.host.isAirClient()) return sessions;
    const marked = await readArchivedSessionIds();
    return sessions.filter(
      (session) =>
        !isArchivedTitle(session.customTitle) && !marked.has(session.sessionId.toLowerCase()),
    );
  }

  /** A `sessionIndex` client may not open a second writer: loading or
   *  resuming a session that another live process holds is
   *  `thread_active_writer`. The CLI that runs the session here does not
   *  count; another process that resumed it too does. */
  async assertNoOtherWriter(sessionId: string): Promise<void> {
    if (!this.service) return;
    await this.service.assertNotHeldElsewhere(sessionId, this.ownCliState(sessionId));
  }

  /** `_session/rename`: names a session; no generated title replaces it.
   *  An archived session stays archived. */
  async rename(request: RenameSessionRequest): Promise<EmptyResponse> {
    const index = this.requireService(SESSION_RENAME_METHOD);
    const sessionId = this.indexSessionId(request.sessionId);
    // As the CLI keeps it, and never with the archive prefix: a rename does
    // not change the archive state.
    const title = storedTitle(request.title, false, sessionId);
    await this.retitle(index, sessionId, renameTo(title), title, {
      mayBeUnwritten: true,
      sidecar: "always",
    });
    return {};
  }

  /** `_session/archive`: hides a session from the default list. Idempotent;
   *  the session need not be loaded. */
  async archive(params: SessionIdRequest): Promise<EmptyResponse> {
    return this.setArchived(this.requireService(SESSION_ARCHIVE_METHOD), params, true);
  }

  /** `_session/unarchive`. Idempotent. */
  async unarchive(params: SessionIdRequest): Promise<EmptyResponse> {
    return this.setArchived(this.requireService(SESSION_UNARCHIVE_METHOD), params, false);
  }

  private async setArchived(
    index: SessionIndexService,
    params: SessionIdRequest,
    archived: boolean,
  ): Promise<EmptyResponse> {
    const sessionId = this.indexSessionId(params.sessionId);
    await this.retitle(index, sessionId, archiveTo(archived), undefined, {
      mayBeUnwritten: this.isUnwrittenSession(sessionId),
      sidecar: "existing",
      dropMarker: true,
    });
    await this.reportArchived(sessionId, archived);
    return {};
  }

  /**
   * Retitles a session (see {@link SessionIndexService.retitle}). A session
   * this connection runs is titled through its CLI (`rename_session`). A
   * loaded session's title state takes the change as a client title, so no
   * generated title replaces it; `publish` is the title it then publishes.
   */
  private async retitle(
    index: SessionIndexService,
    sessionId: string,
    change: TitleChange,
    publish: string | undefined,
    options: Pick<RetitleOptions, "mayBeUnwritten" | "sidecar" | "dropMarker">,
  ): Promise<void> {
    const session = this.host.agent.sessions[sessionId];
    // Decided once a title generation in flight has ended: the query may
    // have closed meanwhile.
    const persist = () => {
      const query = session?.query as
        | (Query & { renameSession?: (title: string, sessionId?: string) => Promise<void> })
        | undefined;
      // A closed session's CLI is gone here, and another process may have
      // resumed the session since: only a running query is ours.
      const running = session !== undefined && !session.queryClosed;
      if (running && typeof query?.renameSession !== "function") {
        // Its CLI holds the title and would write it back over ours.
        throw RequestError.invalidRequest(
          { sessionId },
          "The Claude Code CLI of this session cannot change its title while it runs.",
        );
      }
      const live = running
        ? {
            cwd: session.cwd,
            rename: (title: string) => query!.renameSession!(title, sessionId),
            stored: session.titles.storedTitle,
            shown: session.titles.shownTitle,
          }
        : undefined;
      return index.retitle(sessionId, change, {
        ...options,
        // Without its CLI, a session needs its transcript.
        mayBeUnwritten: live !== undefined && options.mayBeUnwritten,
        live,
        ownCli: this.ownCliState(sessionId),
      });
    };
    if (session) {
      await session.titles.setExplicitTitle(publish, persist);
    } else {
      await persist();
    }
  }

  /**
   * `session/delete`:
   * - A `sessionIndex` client deletes for real: every transcript and the
   *   archive marker. A session that another live process holds is refused.
   * - Another AIR client uses delete to mark a session done, and may reopen
   *   it later: the adapter archives it instead (as `_session/archive` does,
   *   after the CLI closed), so the transcript survives.
   * - Every other client: the SDK delete, as before.
   */
  async deleteSession(request: DeleteSessionRequest): Promise<DeleteSessionResponse> {
    // A sessionIndex client's id matches in any case; every other client's
    // exactly, as before.
    const params = this.service
      ? { ...request, sessionId: this.indexSessionId(request.sessionId) }
      : request;
    const session = this.host.agent.sessions[params.sessionId];
    const loaded = session !== undefined;
    const running = session !== undefined && !session.queryClosed;
    // The holder check waits for the CLIs this process started to exit (they
    // stay registered, and may write, while they do) and refuses a session
    // that another process holds. A session that runs here is checked once
    // its CLI is closed: another process may have resumed it meanwhile.
    // An AIR client without sessionIndex archives instead (see below): the
    // same holder rules, before the session is torn down.
    const index = this.service ?? (this.host.isAirClient() ? this.airArchiver() : undefined);
    if (index && !running) {
      await index.assertNotHeldElsewhere(params.sessionId, this.ownCliState(params.sessionId));
    }
    // Tear down any active in-memory state first so the on-disk file isn't
    // recreated by an outstanding query writing to it.
    if (loaded) {
      await this.host.teardownSession(params.sessionId);
    }
    if (this.service) {
      if (running) await this.service.assertNotHeldElsewhere(params.sessionId, "exiting");
      await this.service.delete(params.sessionId, loaded);
    } else if (index) {
      await archiveInsteadOfDelete(params.sessionId, index, {
        ownCli: this.ownCliState(params.sessionId),
      });
    } else {
      await sdkDeleteSession(params.sessionId);
    }
    return {};
  }

  private airArchiver(): SessionIndexService {
    this.archiver ??= new SessionIndexService({
      notifyListChanged: async () => {},
      logError: (message, error) =>
        this.host.agent.logger.error(`[session-index] ${message}:`, error),
    });
    return this.archiver;
  }

  private requireService(method: string): SessionIndexService {
    if (!this.service) throw RequestError.methodNotFound(method);
    return this.service;
  }

  /** What the session index reports for a session this connection runs. */
  private ownSessionState(sessionId: string): OwnSessionState | undefined {
    const session = this.host.agent.sessions[sessionId];
    if (!session || session.queryClosed) return undefined;
    return {
      state: session.lastSessionState,
      lastTurnEndedAt: session.lastTurnEndedAt,
      costUsd: session.lastTotalCostUsd,
    };
  }

  /**
   * The id under which the session index handles a session: a UUID is
   * matched in any case, so the id this connection runs the session under
   * (normally lower case, like the CLI's transcripts), else the lower-case
   * UUID. Used by the `sessionIndex` paths only.
   */
  private indexSessionId(sessionId: string): string {
    const sessions = this.host.agent.sessions;
    if (!isSessionId(sessionId) || sessions[sessionId]) return sessionId;
    const lower = sessionId.toLowerCase();
    return Object.keys(sessions).find((key) => key.toLowerCase() === lower) ?? lower;
  }

  /** Whether this connection runs a CLI for the session (`running`), or
   *  closed one that may still be exiting (`exiting`). */
  private ownCliState(sessionId: string): "running" | "exiting" | undefined {
    const session = this.host.agent.sessions[sessionId];
    if (session && !session.queryClosed) return "running";
    if (session) return "exiting";
    const closedAt = this.closedCliSessions.get(sessionId.toLowerCase());
    if (closedAt !== undefined && Date.now() - closedAt < CLOSED_CLI_MEMORY_MS) return "exiting";
    this.closedCliSessions.delete(sessionId.toLowerCase());
    return undefined;
  }

  /** A new session this connection runs that may have no transcript yet: it
   *  resumed no stored conversation and no turn of it has ended. A session
   *  whose query ended, or that has history, needs its transcript. */
  private isUnwrittenSession(sessionId: string): boolean {
    const session = this.host.agent.sessions[sessionId];
    return (
      session !== undefined &&
      !session.queryClosed &&
      !session.resumedFromHistory &&
      session.lastTurnEndedAt === undefined
    );
  }

  /** Tells the client the archive state of a session loaded on this
   *  connection (`session_info_update` with `_meta.jetbrains.air.archived`,
   *  RFD #2161's `archived` field). The session itself is not touched. */
  private async reportArchived(sessionId: string, archived: boolean): Promise<void> {
    if (!this.host.agent.sessions[sessionId]) return;
    await this.host.agent.client.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: "session_info_update",
        _meta: withAirMeta(undefined, "archived", archived),
      },
    });
  }
}

/** The agent methods behind the session index extension methods. */
type SessionIndexMethods = {
  renameSessionTitle(params: RenameSessionRequest): Promise<EmptyResponse>;
  archiveSession(params: SessionIdRequest): Promise<EmptyResponse>;
  unarchiveSession(params: SessionIdRequest): Promise<EmptyResponse>;
};

/** Routes `_session/rename`, `_session/archive` and `_session/unarchive`. */
export function onSessionIndexRequests(app: AgentApp, agent: () => SessionIndexMethods): AgentApp {
  return app
    .onRequest<RenameSessionRequest, EmptyResponse>(
      SESSION_RENAME_METHOD,
      { parse: parseRenameSessionRequest },
      (ctx) => agent().renameSessionTitle(ctx.params),
    )
    .onRequest<SessionIdRequest, EmptyResponse>(
      SESSION_ARCHIVE_METHOD,
      { parse: parseSessionIdRequest },
      (ctx) => agent().archiveSession(ctx.params),
    )
    .onRequest<SessionIdRequest, EmptyResponse>(
      SESSION_UNARCHIVE_METHOD,
      { parse: parseSessionIdRequest },
      (ctx) => agent().unarchiveSession(ctx.params),
    );
}
