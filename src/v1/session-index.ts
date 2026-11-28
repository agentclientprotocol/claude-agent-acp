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
  type SetSessionTitleRequest,
  type SetSessionTitleResponse,
} from "@agentclientprotocol/sdk/unstable";
import type { Session } from "./acp-agent.js";
import type { AcpClient } from "../acp-client.js";
import type { Logger } from "../logger.js";
import {
  AIR_SESSION_BATCH_GET_CAPABILITY,
  AIR_SESSION_TRANSCRIPT_TEXT_CAPABILITY,
  clientSupportsAirCapability,
  withAirMeta,
} from "../air-extension.js";
import { SessionIndexConnection as SharedSessionIndexConnection } from "../session-index/connection.js";
import { archiveSession } from "../session-index/archive.js";
import { isArchivedTitle, visibleTitle } from "../session-index/archive-title.js";
import { renameSession, retitleSession, type RetitledSession } from "../session-index/rename.js";
import {
  LIST_CHANGES_METHOD,
  LIST_SUBSCRIBE_METHOD,
  LIST_UNSUBSCRIBE_METHOD,
  parseListSubscribeRequest,
  parseListUnsubscribeRequest,
  type ListSubscribeRequest,
  type ListSubscribeResponse,
  type ListUnsubscribeRequest,
} from "../session-index/list-subscriptions.js";
import {
  archiveInsteadOfDelete,
  deleteSessionIfStored,
  archiveTo,
  parseRenameSessionRequest,
  parseSessionIdRequest,
  parseBatchGetSessionsRequest,
  SESSION_BATCH_GET_METHOD,
  SESSION_ARCHIVE_METHOD,
  SESSION_RENAME_METHOD,
  SESSION_UNARCHIVE_METHOD,
  SessionIndexService,
  transcriptWriter,
  type RenameSessionRequest,
  type SessionIdRequest,
  type BatchGetSessionsRequest,
  type BatchGetSessionsResponse,
} from "../session-index/service.js";

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

export class SessionIndexConnection extends SharedSessionIndexConnection {
  private clientAdvertisedSessionTranscriptText = false;
  private transcripts?: SessionIndexService;

  constructor(private readonly host: SessionIndexHost) {
    super({
      ownSessionState: (sessionId) => {
        const session = host.agent.sessions[sessionId];
        return session && !session.queryClosed
          ? {
              state: session.lastSessionState,
              lastTurnEndedAt: session.lastTurnEndedAt,
              lastTurnFailed: session.lastTurnFailed,
              costUsd: session.lastTotalCostUsd,
            }
          : undefined;
      },
      notifyListChanges: (changes) =>
        host.agent.client.extNotification(LIST_CHANGES_METHOD, changes),
      logError: (message, error) => host.agent.logger.error(`[session-index] ${message}:`, error),
    });
  }

  negotiate(request: InitializeRequest): void {
    this.clientAdvertisedSessionTranscriptText = clientSupportsAirCapability(
      request.clientCapabilities,
      AIR_SESSION_TRANSCRIPT_TEXT_CAPABILITY,
    );
    this.initialize(request.clientCapabilities);
  }

  /** A stored title as the client shows it: an AIR client gets the title
   *  of an archived session without the archive prefix, as in its list;
   *  every other client the title as stored. */
  clientTitle(title: string): string {
    return this.host.isAirClient() && isArchivedTitle(title) ? visibleTitle(title) : title;
  }

  /** The AIR capabilities the agent advertises for the index: the index
   *  itself, batch get, archive, rename, the list subscription and the `agentWorktree`
   *  row field, all only to a client that declared `sessionIndex`. */
  capabilities(): string[] {
    return super.capabilities(
      AIR_SESSION_BATCH_GET_CAPABILITY,
      ...(this.clientAdvertisedSessionTranscriptText
        ? [AIR_SESSION_TRANSCRIPT_TEXT_CAPABILITY]
        : []),
    );
  }

  batchGet(
    params: BatchGetSessionsRequest,
    signal?: AbortSignal,
  ): Promise<BatchGetSessionsResponse> {
    const service = this.requireService(SESSION_BATCH_GET_METHOD);
    if (params.transcriptText && !this.clientAdvertisedSessionTranscriptText) {
      throw RequestError.invalidParams(
        undefined,
        "Declare sessionTranscriptText in initialize first",
      );
    }
    return service.batchGet(params, (sessionId) => this.ownSessionState(sessionId), signal);
  }

  /** An AIR client archives with session/delete (see {@link deleteSession}):
   *  its archived sessions (an archived custom title) stay hidden from the
   *  old list, as when the delete removed them. */
  hideArchived<T extends { customTitle?: string }>(sessions: T[]): T[] {
    if (!this.host.isAirClient()) return sessions;
    return sessions.filter((session) => !isArchivedTitle(session.customTitle));
  }

  /** `_session/rename` of a `sessionIndex` client (see {@link renameSession}). */
  async rename(request: RenameSessionRequest): Promise<EmptyResponse> {
    await this.renameWith(this.requireService(SESSION_RENAME_METHOD), request);
    return {};
  }

  /** `session/set_title`, for every client: the rename of `_session/rename`,
   *  without the session index of a client that did not ask for it. */
  async setTitle(request: SetSessionTitleRequest): Promise<SetSessionTitleResponse> {
    const title = await this.renameWith(
      this.service ?? this.writer(),
      parseRenameSessionRequest(request),
    );
    return { title };
  }

  private renameWith(index: SessionIndexService, request: RenameSessionRequest): Promise<string> {
    return renameSession(index, request, this.loaded(request.sessionId), (stored) =>
      this.clientTitle(stored),
    );
  }

  /** The session loaded here, as a rename reaches it. */
  private loaded(sessionId: string): RetitledSession | undefined {
    const session = this.host.agent.sessions[sessionId];
    return session && { session, titles: session.titles };
  }

  /** `_session/archive`: hides a session from the default list and stops
   *  it. Idempotent; the session need not be loaded. A session loaded here
   *  is interrupted, retitled through its CLI while that still runs, then
   *  closed as `session/close` closes it. */
  async archive(params: SessionIdRequest): Promise<EmptyResponse> {
    const index = this.requireService(SESSION_ARCHIVE_METHOD);
    const { sessionId } = params;
    const loaded = await archiveSession(index, sessionId, {
      loaded: () => this.loaded(sessionId),
      isUnwritten: () => this.isUnwrittenSession(sessionId),
      interrupt: () => this.host.interruptSession(sessionId),
      close: () => this.host.teardownSession(sessionId),
      logError: (message, error) =>
        this.host.agent.logger.error(`[session-index] ${message}:`, error),
    });
    await this.reportArchived(sessionId, true, loaded);
    return {};
  }

  /** `_session/unarchive`. Idempotent; it does not load the session. */
  async unarchive(params: SessionIdRequest): Promise<EmptyResponse> {
    const index = this.requireService(SESSION_UNARCHIVE_METHOD);
    const { sessionId } = params;
    await retitleSession(index, sessionId, archiveTo(false), undefined, this.loaded(sessionId), {
      mayBeUnwritten: this.isUnwrittenSession(sessionId),
      sidecar: "existing",
    });
    await this.reportArchived(sessionId, false, this.host.agent.sessions[sessionId] !== undefined);
    return {};
  }

  /**
   * `session/delete`:
   * - A `sessionIndex` client deletes for real: every transcript, whoever
   *   else has the session open, as the CLI does.
   * - Another AIR client uses delete to mark a session done, and may reopen
   *   it later: the adapter archives it instead (as `_session/archive` does,
   *   after the CLI closed), so the transcript survives.
   * - Every other client: the SDK delete. A session without a transcript
   *   succeeds (see {@link deleteSessionIfStored}).
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
      await archiveInsteadOfDelete(params.sessionId, this.writer());
    } else {
      // After a `session/set_title` of the session in flight.
      await this.writer().exclusive(params.sessionId, () =>
        deleteSessionIfStored(params.sessionId),
      );
    }
    return {};
  }

  private writer(): SessionIndexService {
    this.transcripts ??= transcriptWriter(this.host.agent.logger);
    return this.transcripts;
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
  batchGetSessions(
    params: BatchGetSessionsRequest,
    signal: AbortSignal,
  ): Promise<BatchGetSessionsResponse>;
  subscribeSessionList(params: ListSubscribeRequest): Promise<ListSubscribeResponse>;
  unsubscribeSessionList(params: ListUnsubscribeRequest): Promise<EmptyResponse>;
  renameSessionTitle(params: RenameSessionRequest): Promise<EmptyResponse>;
  archiveSession(params: SessionIdRequest): Promise<EmptyResponse>;
  unarchiveSession(params: SessionIdRequest): Promise<EmptyResponse>;
};

/** Routes `_session/batch_get`, `_session/list/subscribe`, `_session/list/unsubscribe`,
 *  `_session/rename`, `_session/archive` and `_session/unarchive`. */
export function onSessionIndexRequests(app: AgentApp, agent: () => SessionIndexMethods): AgentApp {
  return app
    .onRequest<BatchGetSessionsRequest, BatchGetSessionsResponse>(
      SESSION_BATCH_GET_METHOD,
      { parse: parseBatchGetSessionsRequest },
      (ctx) => agent().batchGetSessions(ctx.params, ctx.signal),
    )
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
