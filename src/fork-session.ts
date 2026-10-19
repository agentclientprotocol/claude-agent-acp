import { ForkSessionRequest, ForkSessionResponse, RequestError } from "@agentclientprotocol/sdk";
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
import { SessionTiming } from "./session-timing.js";

type ForkSessionMeta = {
  [key: string]: unknown;
  jetbrains?: { air?: { fork?: { version?: number } & Record<string, unknown> } };
};

type ForkSessionDependencies = {
  liveMessageIdToUuid?: ReadonlyMap<string, string>;
  logger?: { log: (...args: unknown[]) => void };
  messageIdForGrouping: MessageIdForGrouping;
};

function forkPoint(meta: unknown): SessionHistoryPoint | undefined {
  const fork = (meta as ForkSessionMeta | null | undefined)?.jetbrains?.air?.fork;
  if (fork?.version !== 1) return undefined;
  return historyPoint(fork);
}

export async function forkSession(
  params: ForkSessionRequest,
  dependencies: ForkSessionDependencies,
): Promise<ForkSessionResponse> {
  const timing = new SessionTiming(dependencies.logger, "fork", params.sessionId);
  const point = forkPoint(params._meta);
  if (!point) {
    const forked = await forkClaudeSession(params.sessionId, { dir: params.cwd });
    timing.phase("sdk-fork", " resolution=latest");
    return { sessionId: forked.sessionId };
  }

  const candidateIds = historyPointMessageIdCandidates(point.messageId);
  const liveUuid = candidateIds
    .map((candidateId) => dependencies.liveMessageIdToUuid?.get(candidateId))
    .find(Boolean);
  const history = liveUuid
    ? undefined
    : await getSessionMessages(params.sessionId, { dir: params.cwd });
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
    : await resolveFromFullHistory(params.sessionId, params.cwd, point, dependencies);
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
    dir: params.cwd,
    upToMessageId: messageUuid ?? fullHistoryUuid,
  });
  timing.phase("sdk-fork");
  return { sessionId: forked.sessionId };
}

async function resolveFromFullHistory(
  sessionId: string,
  cwd: string,
  point: SessionHistoryPoint,
  dependencies: ForkSessionDependencies,
): Promise<string | undefined> {
  const entries = await loadFullSessionHistory(sessionId, cwd);
  return resolveHistoryPointUuid(
    entries,
    assistantGroups(entries, dependencies.messageIdForGrouping),
    point,
    dependencies.messageIdForGrouping,
  );
}
