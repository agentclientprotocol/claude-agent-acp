import type { RewindFilesResult } from "@anthropic-ai/claude-agent-sdk";
import { RequestError } from "@agentclientprotocol/sdk";
import {
  parseHistoryPoint,
  resolveHistoryPoint,
  sessionMutationBusy,
  type SessionHistoryPoint,
  type SessionRewindDependencies,
} from "./session-rewind.js";

export const SESSION_REWIND_FILES_METHOD = "_session/rewind_files";
export type SessionRewindFilesRequest = {
  sessionId: string;
  beforeMessage: SessionHistoryPoint;
  dryRun: boolean;
};
export type SessionRewindFilesResponse = RewindFilesResult & {
  sessionId: string;
  dryRun: boolean;
  reason?: string;
};

export function parseSessionRewindFilesRequest(value: unknown): SessionRewindFilesRequest {
  if (!value || typeof value !== "object")
    throw RequestError.invalidParams(undefined, "Invalid file rewind request");
  const p = value as Record<string, unknown>;
  if (typeof p.sessionId !== "string" || !p.sessionId.trim() || typeof p.dryRun !== "boolean") {
    throw RequestError.invalidParams(undefined, "sessionId and explicit dryRun are required");
  }
  return {
    sessionId: p.sessionId,
    dryRun: p.dryRun,
    beforeMessage: parseHistoryPoint(p.beforeMessage, "beforeMessage"),
  };
}

export async function rewindSessionFiles(
  p: SessionRewindFilesRequest,
  deps: SessionRewindDependencies,
): Promise<SessionRewindFilesResponse> {
  const base = { sessionId: p.sessionId, dryRun: p.dryRun };
  const session = deps.getSession(p.sessionId);
  if (!session) return { ...base, canRewind: false, reason: "session_not_found" };
  const busy = sessionMutationBusy(session);
  if (busy) return { ...base, canRewind: false, reason: busy };
  const target = await resolveHistoryPoint(
    p.sessionId,
    p.beforeMessage,
    "user",
    deps.messageIdForGrouping,
  );
  if (deps.getSession(p.sessionId) !== session || sessionMutationBusy(session))
    return { ...base, canRewind: false, reason: "state_changed" };
  if (typeof session.query.rewindFiles !== "function")
    return { ...base, canRewind: false, reason: "unsupported" };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const operation = session.query.rewindFiles(target.uuid, { dryRun: p.dryRun });
    const result = !p.dryRun
      ? await operation
      : await Promise.race([
          operation,
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error("File rewind timed out; reload required")),
              15_000,
            );
          }),
        ]);
    return { ...base, ...result };
  } catch (error) {
    // A restore may have partially completed. Do not enable further writes on
    // this query after losing its acknowledgement.
    if (!p.dryRun) deps.invalidate(session);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
