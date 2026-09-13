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

  const beforeMessage = await resolveHistoryPoint(
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

  await dependencies.teardownSession(params.sessionId);
  await dependencies.createSession(
    session.creationParams ?? { cwd: session.cwd, mcpServers: [] },
    resumeAtUuid
      ? {
          resume: params.sessionId,
          resumeSessionAt: resumeAtUuid,
          resumeDropsTurn: beforeUuid,
        }
      : { reuseSessionId: params.sessionId },
  );
  return { rewound: true };
}

export async function resolveHistoryPoint(
  sessionId: string,
  point: SessionHistoryPoint,
  role: "user" | "assistant",
  messageIdForGrouping: (message: SessionMessage) => string | undefined,
): Promise<SessionMessage> {
  const messages = await getSessionMessages(sessionId);
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
