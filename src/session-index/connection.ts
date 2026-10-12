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
  AIR_SESSION_LIST_SUBSCRIBE_CAPABILITY,
  AIR_SESSION_RENAME_CAPABILITY,
  clientSupportsAirCapability,
  withAirMeta,
} from "../air-extension.js";
import type { OwnSessionState } from "./activity.js";
import { isArchivedTitle, storedTitle, visibleTitle } from "./archive-title.js";
import {
  LIST_CHANGES_METHOD,
  LIST_SUBSCRIBE_METHOD,
  LIST_UNSUBSCRIBE_METHOD,
  parseListSubscribeRequest,
  parseListUnsubscribeRequest,
  type ListSubscribeRequest,
  type ListSubscribeResponse,
  type ListUnsubscribeRequest,
} from "./list-subscriptions.js";
import {
  archiveInsteadOfDelete,
  archiveTo,
  renameTo,
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

/** What the session index keeps on each `Session`. */
export type SessionIndexFields = {
  /** When the last turn ended (the last `session_state_changed: idle`), epoch
   *  ms. Reported as `lastTurnEndedAt` in the session index. */
  lastTurnEndedAt?: number;
  /** The last turn failed with an error, not a cancel; a new turn clears
   *  it. Reported as the `error` state in the session index. */
  lastTurnFailed?: boolean;
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
  if (state === "running" && previous !== "running") session.lastTurnFailed = false;
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
  /** Cancels the running turns of a session loaded here and sends its CLI
   *  the interrupt, without awaiting the reply. */
  interruptSession(sessionId: string): Promise<void>;
  /** Closes a session loaded here, as `session/close` does. */
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
  /** When the query of a session failed here, by session id. */
  private readonly failedQueries = new Map<string, number>();

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
        ownSessionState: (sessionId) => this.ownSessionState(sessionId),
        notifyListChanges: (changes) =>
          this.host.agent.client.extNotification(LIST_CHANGES_METHOD, changes),
        logError: (message, error) =>
          this.host.agent.logger.error(`[session-index] ${message}:`, error),
      });
    }
  }

  /** A stored title as the client shows it: an AIR client gets the title
   *  of an archived session without the archive prefix, as in its list;
   *  every other client the title as stored. */
  clientTitle(title: string): string {
    return this.host.isAirClient() && isArchivedTitle(title) ? visibleTitle(title) : title;
  }

  /** The AIR capabilities the agent advertises for the index: the index
   *  itself, archive, rename and the list subscription, all only to a client
   *  that declared `sessionIndex`. */
  capabilities(): string[] {
    return this.service
      ? [
          AIR_SESSION_INDEX_CAPABILITY,
          AIR_SESSION_ARCHIVE_CAPABILITY,
          AIR_SESSION_RENAME_CAPABILITY,
          AIR_SESSION_LIST_SUBSCRIBE_CAPABILITY,
        ]
      : [];
  }

  dispose(): void {
    this.service?.dispose();
  }

  /** The query of a session that ran here failed (not a cancel): its row
   *  shows `error` until its transcript changes. */
  onQueryFailed(sessionId: string): void {
    this.failedQueries.set(sessionId, Date.now());
    if (this.failedQueries.size > 1024) {
      this.failedQueries.delete(this.failedQueries.keys().next().value as string);
    }
    this.service?.ownSessionChanged(sessionId);
  }

  /** A turn of a session started here: an earlier failed query of it no
   *  longer counts. */
  onTurnStarted(sessionId: string): void {
    this.failedQueries.delete(sessionId);
  }

  onTeardown(sessionId: string): void {
    // Its row now shows what the registry and the transcript tell.
    this.service?.ownSessionChanged(sessionId);
  }

  /** A session this connection runs changed its state, turn end or cost:
   *  the list subscriptions send it at once. */
  onOwnSessionChanged(sessionId: string): void {
    this.service?.ownSessionChanged(sessionId);
  }

  /** `_session/list/subscribe`. */
  subscribeList(params: ListSubscribeRequest): Promise<ListSubscribeResponse> {
    return this.requireService(LIST_SUBSCRIBE_METHOD).subscribeList(params.cwd);
  }

  /** `_session/list/unsubscribe`. Idempotent. */
  unsubscribeList(params: ListUnsubscribeRequest): EmptyResponse {
    this.requireService(LIST_UNSUBSCRIBE_METHOD).unsubscribeList(params.subscriptionId);
    return {};
  }

  /** `session/list` of a `sessionIndex` client; undefined for another one. */
  list(params: ListSessionsRequest): Promise<ListSessionsResponse> | undefined {
    return this.service?.list(params, (sessionId) => this.ownSessionState(sessionId));
  }

  /** An AIR client archives with session/delete (see {@link deleteSession}):
   *  its archived sessions (an archived custom title) stay hidden from the
   *  old list, as when the delete removed them. */
  hideArchived<T extends { customTitle?: string }>(sessions: T[]): T[] {
    if (!this.host.isAirClient()) return sessions;
    return sessions.filter((session) => !isArchivedTitle(session.customTitle));
  }

  /** `_session/rename`: names a session; no generated title replaces it.
   *  An archived session stays archived. */
  async rename(request: RenameSessionRequest): Promise<EmptyResponse> {
    const index = this.requireService(SESSION_RENAME_METHOD);
    const { sessionId } = request;
    // As the CLI keeps it, and never with the archive prefix: a rename does
    // not change the archive state.
    const title = storedTitle(request.title, false, sessionId);
    // The title as stored: an archived one is cut with its prefix.
    const shown = (stored: string | undefined) =>
      stored === undefined ? title : visibleTitle(stored);
    await this.retitle(index, sessionId, renameTo(title), shown, {
      mayBeUnwritten: true,
      sidecar: "always",
    });
    return {};
  }

  /** Check negotiation before the caller cancels any in-flight native work. */
  assertArchiveSupported(): void {
    this.requireService(SESSION_ARCHIVE_METHOD);
  }

  /** `_session/archive`: hides a session from the default list and stops
   *  it. Idempotent; the session need not be loaded. A session loaded here
   *  is interrupted, retitled through its CLI while that still runs, then
   *  closed as `session/close` closes it. */
  async archive(params: SessionIdRequest): Promise<EmptyResponse> {
    const index = this.requireService(SESSION_ARCHIVE_METHOD);
    const { sessionId } = params;
    const loaded = this.host.agent.sessions[sessionId] !== undefined;
    // No turn goes on after the archive: the interrupt goes to the CLI ahead
    // of the rename.
    if (loaded) await this.host.interruptSession(sessionId);
    await this.retitle(index, sessionId, archiveTo(true), undefined, {
      mayBeUnwritten: this.isUnwrittenSession(sessionId),
      sidecar: "existing",
    });
    if (loaded) {
      await this.host.teardownSession(sessionId);
      // The closed CLI may have lost or overwritten the agent name it was
      // still to write: the transcripts are archived without it once more,
      // as a best effort, since the CLI took the archived title.
      try {
        await index.retitle(sessionId, archiveTo(true), {
          mayBeUnwritten: true,
          sidecar: "existing",
        });
      } catch (error) {
        this.host.agent.logger.error(
          `[session-index] archiving ${sessionId} after its close failed:`,
          error,
        );
      }
    }
    await this.reportArchived(sessionId, true, loaded);
    return {};
  }

  /** `_session/unarchive`. Idempotent; it does not load the session. */
  async unarchive(params: SessionIdRequest): Promise<EmptyResponse> {
    const index = this.requireService(SESSION_UNARCHIVE_METHOD);
    const { sessionId } = params;
    await this.retitle(index, sessionId, archiveTo(false), undefined, {
      mayBeUnwritten: this.isUnwrittenSession(sessionId),
      sidecar: "existing",
    });
    await this.reportArchived(sessionId, false, this.host.agent.sessions[sessionId] !== undefined);
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
    publish: Parameters<Session["titles"]["setExplicitTitle"]>[0],
    options: Pick<RetitleOptions, "mayBeUnwritten" | "sidecar">,
  ): Promise<void> {
    const session = this.host.agent.sessions[sessionId];
    // Decided once a title generation in flight has ended: the query may
    // have closed meanwhile.
    const persist = () => {
      const query = session?.query as
        | (Query & { renameSession?: (title: string, sessionId?: string) => Promise<void> })
        | undefined;
      // A closed session's CLI is gone here: only a running query titles it.
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
            stored: () => session.titles.storedTitle,
            remember: (title: string) => session.titles.rememberStoredTitle(title),
            shown: session.titles.shownTitle,
          }
        : undefined;
      return index.retitle(sessionId, change, {
        ...options,
        // Without its CLI, a session needs its transcript.
        mayBeUnwritten: live !== undefined && options.mayBeUnwritten,
        live,
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
   * - A `sessionIndex` client deletes for real: every transcript, whoever
   *   else has the session open, as the CLI does.
   * - Another AIR client uses delete to mark a session done, and may reopen
   *   it later: the adapter archives it instead (as `_session/archive` does,
   *   after the CLI closed), so the transcript survives.
   * - Every other client: the SDK delete, as before.
   */
  async deleteSession(params: DeleteSessionRequest): Promise<DeleteSessionResponse> {
    const loaded = this.host.agent.sessions[params.sessionId] !== undefined;
    // Tear down any active in-memory state first so the on-disk file isn't
    // recreated by an outstanding query writing to it.
    if (loaded) {
      await this.host.teardownSession(params.sessionId);
    }
    if (this.service) {
      await this.service.delete(params.sessionId, loaded);
    } else if (this.host.isAirClient()) {
      await archiveInsteadOfDelete(params.sessionId, this.airArchiver());
    } else {
      await sdkDeleteSession(params.sessionId);
    }
    return {};
  }

  private airArchiver(): SessionIndexService {
    this.archiver ??= new SessionIndexService({
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
    if (!session || session.queryClosed) {
      const failedAt = this.failedQueries.get(sessionId);
      return failedAt === undefined ? undefined : { queryFailedAt: failedAt };
    }
    return {
      state: session.lastSessionState,
      lastTurnEndedAt: session.lastTurnEndedAt,
      // A session loaded again after its query failed here shows the failure
      // until a turn of it starts.
      lastTurnFailed: session.lastTurnFailed || this.failedQueries.has(sessionId),
      costUsd: session.lastTotalCostUsd,
    };
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

  /** Tells the client the archive state of a session that was loaded on
   *  this connection (`session_info_update` with
   *  `_meta.jetbrains.air.archived`, RFD #2161's `archived` field), also
   *  once the archive closed it. */
  private async reportArchived(
    sessionId: string,
    archived: boolean,
    loaded: boolean,
  ): Promise<void> {
    if (!loaded) return;
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
  subscribeSessionList(params: ListSubscribeRequest): Promise<ListSubscribeResponse>;
  unsubscribeSessionList(params: ListUnsubscribeRequest): Promise<EmptyResponse>;
  renameSessionTitle(params: RenameSessionRequest): Promise<EmptyResponse>;
  archiveSession(params: SessionIdRequest): Promise<EmptyResponse>;
  unarchiveSession(params: SessionIdRequest): Promise<EmptyResponse>;
};

/** Routes `_session/list/subscribe`, `_session/list/unsubscribe`,
 *  `_session/rename`, `_session/archive` and `_session/unarchive`. */
export function onSessionIndexRequests(app: AgentApp, agent: () => SessionIndexMethods): AgentApp {
  return app
    .onRequest<ListSubscribeRequest, ListSubscribeResponse>(
      LIST_SUBSCRIBE_METHOD,
      { parse: parseListSubscribeRequest },
      (ctx) => agent().subscribeSessionList(ctx.params),
    )
    .onRequest<ListUnsubscribeRequest, EmptyResponse>(
      LIST_UNSUBSCRIBE_METHOD,
      { parse: parseListUnsubscribeRequest },
      (ctx) => agent().unsubscribeSessionList(ctx.params),
    )
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
