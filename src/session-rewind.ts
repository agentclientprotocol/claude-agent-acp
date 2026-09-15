import { createHash } from "node:crypto";
import { getSessionMessages, type SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import { RequestError, type NewSessionRequest } from "@agentclientprotocol/sdk";

export const SESSION_REWIND_METHOD = "_session/rewind";
export const SESSION_REWIND_CAPABILITY = "sessionRewind";

export type SessionHistoryPoint = {
  messageId: string;
  messageFingerprint: string;
  messageOccurrence: number;
};

export type SessionRewindRequest = {
  sessionId: string;
  beforeMessage: SessionHistoryPoint;
  resumeAtMessage?: SessionHistoryPoint;
};

export type SessionRewindResponse = { rewound: boolean };

type RewindSessionState = {
  activeTurn?: unknown;
  turnQueue?: readonly unknown[];
  cwd: string;
  creationParams?: NewSessionRequest;
};

type RewindSessionCreationOptions =
  | { reuseSessionId: string }
  | { resume: string }
  | {
      resume: string;
      resumeSessionAt: string;
      resumeDropsTurn: string;
    };

export type SessionRewindDependencies = {
  waitForProviderUpdate(): Promise<void>;
  getSession(sessionId: string): RewindSessionState | undefined;
  teardownSession(sessionId: string): Promise<void>;
  createSession(params: NewSessionRequest, options: RewindSessionCreationOptions): Promise<unknown>;
  messageIdForGrouping(message: SessionMessage): string | undefined;
};

export function parseSessionRewindRequest(params: unknown): SessionRewindRequest {
  if (!params || typeof params !== "object") {
    throw RequestError.invalidParams(undefined, "rewind params must be an object");
  }
  const record = params as Record<string, unknown>;
  if (typeof record.sessionId !== "string" || record.sessionId.trim().length === 0) {
    throw RequestError.invalidParams(undefined, "rewind sessionId must be a non-empty string");
  }
  return {
    sessionId: record.sessionId,
    beforeMessage: parseHistoryPoint(record.beforeMessage, "beforeMessage"),
    ...(record.resumeAtMessage === undefined
      ? {}
      : { resumeAtMessage: parseHistoryPoint(record.resumeAtMessage, "resumeAtMessage") }),
  };
}

export async function rewindClaudeSession(
  params: SessionRewindRequest,
  dependencies: SessionRewindDependencies,
): Promise<SessionRewindResponse> {
  await dependencies.waitForProviderUpdate();
  const session = dependencies.getSession(params.sessionId);
  if (!session || session.activeTurn || session.turnQueue?.length) return { rewound: false };

  const messages = await getSessionMessages(params.sessionId);
  const beforeMessage = resolveHistoryPointFromMessages(
    messages,
    params.sessionId,
    params.beforeMessage,
    "user",
    dependencies.messageIdForGrouping,
  );
  const beforeUuid = beforeMessage.uuid;
  if (!beforeUuid) return { rewound: false };

  // The selected prompt's parent is the final chain entry of the retained turn. It can be a tool result or
  // structured output after the visible assistant message, which is the exact boundary resumeSessionAt needs.
  const resumeAtUuid = params.resumeAtMessage
    ? (beforeMessage as SessionMessage & { parentUuid?: string }).parentUuid
    : undefined;
  if (params.resumeAtMessage && !resumeAtUuid) return { rewound: false };
  if (params.resumeAtMessage) {
    const visibleAssistant = resolveHistoryPointFromMessages(
      messages,
      params.sessionId,
      params.resumeAtMessage,
      "assistant",
      dependencies.messageIdForGrouping,
    );
    if (!isAssistantAtRetainedBoundary(messages, resumeAtUuid!, visibleAssistant.uuid)) {
      throw RequestError.invalidParams(
        { messageId: params.resumeAtMessage.messageId },
        "resumeAtMessage is not the assistant message immediately preceding beforeMessage",
      );
    }
  }

  await dependencies.teardownSession(params.sessionId);
  const creationParams = session.creationParams ?? { cwd: session.cwd, mcpServers: [] };
  try {
    await dependencies.createSession(
      creationParams,
      resumeAtUuid
        ? {
            resume: params.sessionId,
            resumeSessionAt: resumeAtUuid,
            resumeDropsTurn: beforeUuid,
          }
        : { reuseSessionId: params.sessionId },
    );
  } catch (rewindError) {
    try {
      await dependencies.createSession(creationParams, { resume: params.sessionId });
    } catch (rollbackError) {
      throw new AggregateError(
        [rewindError, rollbackError],
        `Session ${params.sessionId} rewind failed and the original session could not be restored`,
        { cause: rollbackError },
      );
    }
    if (
      rewindError instanceof Error &&
      rewindError.message.startsWith("Resume rejected by --resume-drops-turn:")
    ) {
      return { rewound: false };
    }
    throw rewindError;
  }
  return { rewound: true };
}

export async function resolveHistoryPoint(
  sessionId: string,
  point: SessionHistoryPoint,
  role: "user" | "assistant",
  messageIdForGrouping: (message: SessionMessage) => string | undefined,
): Promise<SessionMessage> {
  const messages = await getSessionMessages(sessionId);
  return resolveHistoryPointFromMessages(messages, sessionId, point, role, messageIdForGrouping);
}

function resolveHistoryPointFromMessages(
  messages: SessionMessage[],
  sessionId: string,
  point: SessionHistoryPoint,
  role: "user" | "assistant",
  messageIdForGrouping: (message: SessionMessage) => string | undefined,
): SessionMessage {
  const roleMessages = messages.filter((message) => message.type === role);
  const candidates = messageIdCandidates(point.messageId);
  const exact = roleMessages
    .slice()
    .reverse()
    .find((message) => candidates.includes(messageIdForGrouping(message) ?? "") && message.uuid);
  if (exact) return exact;

  const matching = roleMessages.filter(
    (message) => message.uuid && fingerprint(messageText(message)) === point.messageFingerprint,
  );
  const fallback = matching[point.messageOccurrence - 1];
  if (fallback) return fallback;
  throw RequestError.invalidParams(
    { messageId: point.messageId },
    `Rewind message ${point.messageId} was not found in session ${sessionId}`,
  );
}

function isAssistantAtRetainedBoundary(
  messages: SessionMessage[],
  boundaryUuid: string,
  assistantUuid: string | undefined,
): boolean {
  if (!assistantUuid) return false;
  const byUuid = new Map(
    messages.flatMap((message) => (message.uuid ? [[message.uuid, message]] : [])),
  );
  const visited = new Set<string>();
  let uuid: string | undefined = boundaryUuid;
  while (uuid && !visited.has(uuid)) {
    visited.add(uuid);
    const message = byUuid.get(uuid);
    if (!message) return false;
    if (message.type === "assistant") return message.uuid === assistantUuid;
    uuid = (message as SessionMessage & { parentUuid?: string }).parentUuid;
  }
  return false;
}

function parseHistoryPoint(value: unknown, name: string): SessionHistoryPoint {
  if (!value || typeof value !== "object") {
    throw RequestError.invalidParams(undefined, `${name} must be an object`);
  }
  const point = value as Record<string, unknown>;
  if (typeof point.messageId !== "string" || point.messageId.trim().length === 0) {
    throw RequestError.invalidParams(undefined, `${name}.messageId must be a non-empty string`);
  }
  if (
    typeof point.messageFingerprint !== "string" ||
    !/^sha256:[0-9a-f]{64}$/.test(point.messageFingerprint)
  ) {
    throw RequestError.invalidParams(
      undefined,
      `${name}.messageFingerprint must be a SHA-256 fingerprint`,
    );
  }
  if (!Number.isSafeInteger(point.messageOccurrence) || (point.messageOccurrence as number) < 1) {
    throw RequestError.invalidParams(undefined, `${name}.messageOccurrence must be positive`);
  }
  return point as SessionHistoryPoint;
}

function messageIdCandidates(messageId: string): string[] {
  const protocolMessageId = messageId.replace(/:segment:\d+$/, "");
  return protocolMessageId === messageId ? [messageId] : [messageId, protocolMessageId];
}

function fingerprint(text: string): string {
  return `sha256:${createHash("sha256").update(text).digest("hex")}`;
}

function messageText(message: SessionMessage): string {
  const content = (message as { message?: { content?: unknown } }).message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) =>
      block && typeof block === "object" && typeof (block as { text?: unknown }).text === "string"
        ? (block as { text: string }).text
        : "",
    )
    .join("");
}
