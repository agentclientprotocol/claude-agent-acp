/** The ACP v2 lifecycle around the shared AIR session index. */
import { SessionBatchGetConnection } from "../session-index/batch-get.js";
import type { BatchGetSessionsRequest } from "../session-index/service.js";
import { RequestError } from "@agentclientprotocol/sdk/unstable";
import type * as v2 from "@agentclientprotocol/sdk/experimental/v2/unstable";
import type { Logger } from "../logger.js";
import { withAirMeta } from "../air-extension.js";
import type { RetitledSession } from "../session-index/rename.js";
import { archiveSession } from "../session-index/archive.js";
import { retitleSession } from "../session-index/rename.js";
import { SessionIndexConnection } from "../session-index/connection.js";
import { visibleTitle } from "../session-index/archive-title.js";
import type { ListChanges } from "../session-index/list-subscriptions.js";
import {
  archiveTo,
  SESSION_ARCHIVE_METHOD,
  SESSION_UNARCHIVE_METHOD,
  SESSION_RENAME_METHOD,
  type RenameSessionRequest,
  type SessionIdRequest,
} from "../session-index/service.js";
import type { OwnSessionState } from "../session-index/activity.js";

type IndexHost = {
  ownSessionState(sessionId: string): OwnSessionState | undefined;
  loaded(sessionId: string): RetitledSession | undefined;
  settled(sessionId: string): Promise<void>;
  assertIdle(sessionId: string): void;
  close(sessionId: string): Promise<unknown>;
  setTitle(params: RenameSessionRequest): Promise<unknown>;
  send(notification: v2.UpdateSessionNotification): void;
  notify(changes: ListChanges): Promise<void>;
  logger: Logger;
  mutationEnded(sessionId: string): void;
  assertRoot(sessionId: string): void;
  interrupt(sessionId: string): Promise<void>;
  isUnwritten(sessionId: string): boolean;
};

export class V2SessionIndex extends SessionIndexConnection {
  private readonly batches = new SessionBatchGetConnection(
    () => this.service,
    (id) => this.ownSessionState(id),
  );

  initialize(capabilities: unknown): void {
    super.initialize(capabilities);
    this.batches.negotiate(capabilities);
  }

  capabilities(): string[] {
    return super.capabilities(...this.batches.capabilities());
  }

  batchGet(params: BatchGetSessionsRequest, signal?: AbortSignal) {
    return this.batches.batchGet(params, signal);
  }

  private readonly mutations = new Map<string, "waiting" | "writing">();

  constructor(private readonly host: IndexHost) {
    super({
      ownSessionState: (sessionId) => host.ownSessionState(sessionId),
      notifyListChanges: (changes) => host.notify(changes),
      logError: (message, error) => host.logger.error(`[session-index] ${message}:`, error),
    });
  }

  assertAvailable(sessionId: string): void {
    if (this.mutations.has(sessionId)) {
      throw RequestError.invalidRequest(
        { sessionId },
        "Another session change is in progress. Try again when that request ends.",
      );
    }
  }

  mutate<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    if (!this.service) return operation();
    this.host.assertRoot(sessionId);
    this.assertAvailable(sessionId);
    this.mutations.set(sessionId, "waiting");
    return this.runMutation(sessionId, operation);
  }

  private async runMutation<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    try {
      // Earlier resume/restart work may need a turn boundary to finish.
      // Reserve new requests now, and hold that boundary only after it settles.
      await this.host.settled(sessionId);
      this.mutations.set(sessionId, "writing");
      return await operation();
    } finally {
      this.mutations.delete(sessionId);
      this.host.mutationEnded(sessionId);
    }
  }

  isMutating(sessionId: string): boolean {
    return this.mutations.get(sessionId) === "writing";
  }

  clientTitle(title: string): string {
    return this.service ? visibleTitle(title) : title;
  }

  async rename(params: RenameSessionRequest): Promise<Record<string, never>> {
    this.requireService(SESSION_RENAME_METHOD);
    await this.host.setTitle(params);
    return {};
  }

  archive({ sessionId }: SessionIdRequest): Promise<Record<string, never>> {
    const service = this.requireService(SESSION_ARCHIVE_METHOD);
    return this.mutate(sessionId, async () => {
      const loaded = await archiveSession(service, sessionId, {
        loaded: () => this.host.loaded(sessionId),
        isUnwritten: () => this.host.isUnwritten(sessionId),
        interrupt: () => this.host.interrupt(sessionId),
        close: () => this.host.close(sessionId),
        logError: (message, error) => this.host.logger.error(`[session-index] ${message}:`, error),
      });
      this.reportArchived(sessionId, true, loaded);
      return {};
    });
  }

  unarchive({ sessionId }: SessionIdRequest): Promise<Record<string, never>> {
    const service = this.requireService(SESSION_UNARCHIVE_METHOD);
    return this.mutate(sessionId, async () => {
      this.host.assertIdle(sessionId);
      const loaded = this.host.loaded(sessionId);
      await retitleSession(service, sessionId, archiveTo(false), undefined, loaded, {
        mayBeUnwritten: true,
        sidecar: "existing",
      });
      this.reportArchived(sessionId, false, loaded !== undefined);
      return {};
    });
  }

  private reportArchived(sessionId: string, archived: boolean, loaded: boolean): void {
    if (!loaded) return;
    this.host.send({
      sessionId,
      update: {
        sessionUpdate: "session_info_update",
        _meta: withAirMeta(undefined, "archived", archived),
      },
    });
  }
}
