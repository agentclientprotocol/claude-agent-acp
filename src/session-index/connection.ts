/** The session index, subscriptions and live-row state of one ACP connection. */
import {
  RequestError,
  type ListSessionsRequest,
  type ListSessionsResponse,
} from "@agentclientprotocol/sdk/unstable";
import {
  AIR_SESSION_INDEX_CAPABILITY,
  AIR_SESSION_ARCHIVE_CAPABILITY,
  AIR_SESSION_RENAME_CAPABILITY,
  AIR_SESSION_LIST_SUBSCRIBE_CAPABILITY,
  AIR_SESSION_WORKTREES_CAPABILITY,
  clientSupportsAirCapability,
  isAirClient,
} from "../air-extension.js";
import type { OwnSessionState } from "./activity.js";
import { SessionIndexService, type SessionIndexDeps } from "./service.js";
import {
  LIST_SUBSCRIBE_METHOD,
  LIST_UNSUBSCRIBE_METHOD,
  type ListSubscribeRequest,
  type ListSubscribeResponse,
  type ListUnsubscribeRequest,
} from "./list-subscriptions.js";

type IndexConnectionDeps = Pick<SessionIndexDeps, "logError" | "notifyListChanges"> & {
  ownSessionState(sessionId: string): OwnSessionState | undefined;
};
type EmptyResponse = Record<string, never>;

export class SessionIndexConnection {
  service?: SessionIndexService;
  private readonly failedQueries = new Map<string, number>();

  constructor(private readonly deps: IndexConnectionDeps) {}

  initialize(capabilities: unknown): void {
    this.service?.dispose();
    this.service = undefined;
    if (
      isAirClient(capabilities) &&
      clientSupportsAirCapability(capabilities, AIR_SESSION_INDEX_CAPABILITY)
    ) {
      this.service = new SessionIndexService({
        ...this.deps,
        ownSessionState: (sessionId) => this.ownSessionState(sessionId),
      });
    }
  }

  capabilities(...extensions: string[]): string[] {
    return this.service
      ? [
          AIR_SESSION_INDEX_CAPABILITY,
          ...extensions,
          AIR_SESSION_ARCHIVE_CAPABILITY,
          AIR_SESSION_RENAME_CAPABILITY,
          AIR_SESSION_LIST_SUBSCRIBE_CAPABILITY,
          AIR_SESSION_WORKTREES_CAPABILITY,
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

  /**
   * Runs `fork`, the handler of a `session/fork` request of `sourceId`. The
   * session list holds back the forks of the source until the response is
   * out. The client then knows a fork from the response before a list shows
   * it.
   */
  async forking<T>(sourceId: string, fork: () => Promise<T>): Promise<T> {
    // The forks of this connection: the request handler reads the service
    // once, so a later `initialize` does not split the start and the answer.
    const service = this.service;
    service?.forkStarted(sourceId);
    try {
      return await fork();
    } finally {
      // The SDK writes the response in the microtasks after the handler
      // resolves, so a `setTimeout(0)` callback runs after it.
      setTimeout(() => service?.forkAnswered(sourceId), 0);
    }
  }

  /** The `session/fork` of `sourceId` copied the transcript into `forkId`. */
  onForkCreated(sourceId: string, forkId: string): void {
    this.service?.forkCreated(sourceId, forkId);
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

  protected requireService(method: string): SessionIndexService {
    if (!this.service) throw RequestError.methodNotFound(method);
    return this.service;
  }

  protected ownSessionState(sessionId: string): OwnSessionState | undefined {
    const own = this.deps.ownSessionState(sessionId);
    if (own)
      return { ...own, lastTurnFailed: own.lastTurnFailed || this.failedQueries.has(sessionId) };
    const failedAt = this.failedQueries.get(sessionId);
    return failedAt === undefined ? undefined : { queryFailedAt: failedAt };
  }
}
