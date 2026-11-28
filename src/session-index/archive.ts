/** Archive a session through its live CLI before closing it, on either ACP version. */
import { retitleSession, type RetitledSession } from "./rename.js";
import { archiveTo, type SessionIndexService } from "./service.js";

type ArchiveHost = {
  loaded(): RetitledSession | undefined;
  isUnwritten(): boolean;
  interrupt(): Promise<void>;
  close(): Promise<unknown>;
  logError(message: string, error: unknown): void;
};

export async function archiveSession(
  index: SessionIndexService,
  sessionId: string,
  host: ArchiveHost,
): Promise<boolean> {
  const loaded = host.loaded() !== undefined;
  if (loaded) await host.interrupt();
  await retitleSession(index, sessionId, archiveTo(true), undefined, host.loaded(), {
    mayBeUnwritten: host.isUnwritten(),
    sidecar: "existing",
  });
  if (loaded) {
    await host.close();
    // The closing CLI may flush its older agent name. Align the stored copies
    // again after close, as a best effort once its live title was archived.
    try {
      await index.retitle(sessionId, archiveTo(true), {
        mayBeUnwritten: true,
        sidecar: "existing",
      });
    } catch (error) {
      host.logError(`archiving ${sessionId} after its close failed`, error);
    }
  }
  return loaded;
}
