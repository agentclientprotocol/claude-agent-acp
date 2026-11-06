import {
  ForkSessionRequest,
  ForkSessionResponse,
  RequestError,
} from "@agentclientprotocol/sdk/unstable";
import {
  forkSession as forkClaudeSession,
  getSessionMessages,
} from "@anthropic-ai/claude-agent-sdk";
import {
  assistantGroups,
  historyPoint,
  historyPointMessageIdCandidates,
  loadFullSessionHistory,
  resolveHistoryPointUuid,
  type MessageIdForGrouping,
  type SessionHistoryPoint,
} from "./session-history-point.js";
import { rewoundSession } from "./resumed-session.js";
import { SessionTiming } from "./session-timing.js";

type ForkSessionMeta = {
  [key: string]: unknown;
  jetbrains?: { air?: { fork?: { version?: number } & Record<string, unknown> } };
};

type ForkSessionDependencies = {
  liveMessageIdToUuid?: ReadonlyMap<string, string>;
  logger?: { log: (...args: unknown[]) => void; error: (...args: unknown[]) => void };
  messageIdForGrouping: MessageIdForGrouping;
};

function forkPoint(meta: unknown): SessionHistoryPoint | undefined {
  const fork = (meta as ForkSessionMeta | null | undefined)?.jetbrains?.air?.fork;
  if (fork?.version !== 1) return undefined;
  return historyPoint(fork);
}

/**
 * Whether `error` is the Claude SDK's report that `sessionId` has no
 * transcript: `forkSession` and `importSessionToStore` throw
 * `Error("Session <id> not found")`, and both throw
 * `"Invalid sessionId: <id>"` for an id that is not a UUID.
 */
function isUnknownSessionError(error: unknown, sessionId: string): boolean {
  if (!(error instanceof Error)) return false;
  return (
    error.message === `Session ${sessionId} not found` ||
    error.message === `Invalid sessionId: ${sessionId}`
  );
}

export async function forkSession(
  params: ForkSessionRequest,
  dependencies: ForkSessionDependencies,
): Promise<ForkSessionResponse> {
  try {
    return await forkTranscript(params, dependencies);
  } catch (error) {
    if (isUnknownSessionError(error, params.sessionId)) {
      throw RequestError.sessionNotFound(params.sessionId);
    }
    throw error;
  }
}

async function forkTranscript(
  params: ForkSessionRequest,
  dependencies: ForkSessionDependencies,
): Promise<ForkSessionResponse> {
  const timing = new SessionTiming(dependencies.logger, "fork", params.sessionId);
  const point = forkPoint(params._meta);
  // SDK `dir` scopes source lookup, not the fork's working directory. Search
  // all projects: params.cwd can name a different workspace for the new session.
  if (!point) {
    // The SDK forks the newest branch, which until the next prompt is the
    // one a pending rewind dropped.
    const pending = (await rewoundSession(params.sessionId, dependencies.logger))?.pending;
    const forked = pending
      ? await forkClaudeSession(params.sessionId, { upToMessageId: pending.resumeSessionAt })
      : await forkClaudeSession(params.sessionId);
    timing.phase("sdk-fork", ` resolution=${pending ? "rewind" : "latest"}`);
    return { sessionId: forked.sessionId };
  }

  const candidateIds = historyPointMessageIdCandidates(point.messageId);
  const liveUuid = candidateIds
    .map((candidateId) => dependencies.liveMessageIdToUuid?.get(candidateId))
    .find(Boolean);
  const history = liveUuid ? undefined : await getSessionMessages(params.sessionId);
  timing.phase("active-history", ` resolution=${liveUuid ? "live" : "pending"}`);
  const messageUuid =
    liveUuid ??
    candidateIds
      .map(
        (candidateId) =>
          history
            ?.slice()
            .reverse()
            .find((message) => dependencies.messageIdForGrouping(message) === candidateId)?.uuid,
      )
      .find(Boolean);
  const fullHistoryUuid = messageUuid
    ? undefined
    : await resolveFromFullHistory(params.sessionId, point, dependencies);
  timing.phase(
    "full-history",
    ` resolution=${liveUuid ? "live" : messageUuid ? "active" : fullHistoryUuid ? "full" : "missing"}`,
  );

  if (!messageUuid && !fullHistoryUuid) {
    throw RequestError.invalidParams(
      { messageId: point.messageId },
      `Fork point message ${point.messageId} was not found in session ${params.sessionId}`,
    );
  }

  const forked = await forkClaudeSession(params.sessionId, {
    upToMessageId: messageUuid ?? fullHistoryUuid,
  });
  timing.phase("sdk-fork");
  return { sessionId: forked.sessionId };
}

async function resolveFromFullHistory(
  sessionId: string,
  point: SessionHistoryPoint,
  dependencies: ForkSessionDependencies,
): Promise<string | undefined> {
  const entries = await loadFullSessionHistory(sessionId);
  return resolveHistoryPointUuid(
    entries,
    assistantGroups(entries, dependencies.messageIdForGrouping),
    point,
    dependencies.messageIdForGrouping,
  );
}
