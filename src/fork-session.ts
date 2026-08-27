import { ForkSessionRequest, ForkSessionResponse, RequestError } from "@agentclientprotocol/sdk";
import {
  forkSession as forkClaudeSession,
  getSessionMessages,
} from "@anthropic-ai/claude-agent-sdk";

type ForkSessionMeta = {
  [key: string]: unknown;
  jetbrains?: {
    air?: {
      fork?: {
        version?: number;
        messageId?: string;
      };
    };
  };
};

type ForkSessionDependencies = {
  liveMessageIdToUuid?: ReadonlyMap<string, string>;
  messageIdForGrouping: (message: {
    type?: string;
    uuid?: string | null;
    message?: unknown;
  }) => string | undefined;
};

function forkPointMessageId(meta: unknown): string | undefined {
  const fork = (meta as ForkSessionMeta | null | undefined)?.jetbrains?.air?.fork;
  if (fork?.version !== 1) return undefined;
  const messageId = fork.messageId?.trim();
  return messageId || undefined;
}

function forkPointMessageIdCandidates(messageId: string): string[] {
  // Older AIR builds sent their visible segment id. Prefer the exact id before its ACP source id.
  const protocolMessageId = messageId.replace(/:segment:\d+$/, "");
  return protocolMessageId === messageId ? [messageId] : [messageId, protocolMessageId];
}

export async function forkSession(
  params: ForkSessionRequest,
  dependencies: ForkSessionDependencies,
): Promise<ForkSessionResponse> {
  const messageId = forkPointMessageId(params._meta);
  if (!messageId) {
    const forked = await forkClaudeSession(params.sessionId, { dir: params.cwd });
    return { sessionId: forked.sessionId };
  }

  const candidateIds = forkPointMessageIdCandidates(messageId);
  const liveUuid = candidateIds
    .map((candidateId) => dependencies.liveMessageIdToUuid?.get(candidateId))
    .find(Boolean);
  const history = liveUuid
    ? undefined
    : await getSessionMessages(params.sessionId, { dir: params.cwd });
  const messageUuid =
    liveUuid ??
    candidateIds
      .map(
        (candidateId) =>
          history?.find((message) => dependencies.messageIdForGrouping(message) === candidateId)
            ?.uuid,
      )
      .find(Boolean);

  if (!messageUuid) {
    throw RequestError.invalidParams(
      { messageId },
      `Fork point message ${messageId} was not found in session ${params.sessionId}`,
    );
  }

  const forked = await forkClaudeSession(params.sessionId, {
    dir: params.cwd,
    upToMessageId: messageUuid,
  });
  return { sessionId: forked.sessionId };
}
