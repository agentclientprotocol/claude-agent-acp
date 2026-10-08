import { createHash } from "node:crypto";
import type { Query, SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import { RequestError } from "@agentclientprotocol/sdk";
import { readSessionHistory } from "./session-history.js";
import {
  nativeRewind,
  NativeRewindUnsupported,
  NativeRewindUncertain,
} from "./native-rewind-control.js";

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
  interruptIfRunning?: boolean;
};
export type SessionRewindResponse = { rewound: boolean; reason?: string; sessionId?: string };
export type RewindSessionState = {
  query: Query;
  queryClosed?: boolean;
  activeTurn?: { completion?: Promise<void> } | null;
  turnQueue?: readonly { completion?: Promise<void>; promptUuid?: string }[];
  lastSessionState?: string;
  liveBackgroundTasks?: ReadonlyMap<string, { endedPerLevel?: string }>;
  nativeRewindUnsupported?: boolean;
  lastObservedUserMessageUuid?: string;
};
export type SessionRewindDependencies = {
  getSession(id: string): RewindSessionState | undefined;
  cancel(id: string): Promise<void>;
  invalidate(session: RewindSessionState): void;
  committed(id: string): void;
  messageIdForGrouping(message: SessionMessage): string | undefined;
};
export function parseSessionRewindRequest(params: unknown): SessionRewindRequest {
  if (!params || typeof params !== "object")
    throw RequestError.invalidParams(undefined, "rewind params must be an object");
  const p = params as Record<string, unknown>;
  if (typeof p.sessionId !== "string" || !p.sessionId.trim())
    throw RequestError.invalidParams(undefined, "sessionId must be a non-empty string");
  if (p.interruptIfRunning !== undefined && typeof p.interruptIfRunning !== "boolean")
    throw RequestError.invalidParams(undefined, "interruptIfRunning must be a boolean");
  return {
    sessionId: p.sessionId,
    beforeMessage: parseHistoryPoint(p.beforeMessage, "beforeMessage"),
    ...(p.resumeAtMessage === undefined
      ? {}
      : { resumeAtMessage: parseHistoryPoint(p.resumeAtMessage, "resumeAtMessage") }),
    ...(p.interruptIfRunning === undefined
      ? {}
      : { interruptIfRunning: p.interruptIfRunning as boolean }),
  };
}
export function sessionMutationBusy(session: RewindSessionState): string | undefined {
  if (session.queryClosed) return "session_closed";
  if ([...(session.liveBackgroundTasks?.values() ?? [])].some((t) => !t.endedPerLevel))
    return "background_tasks";
  if (
    session.activeTurn ||
    session.turnQueue?.length ||
    session.lastSessionState === "running" ||
    session.lastSessionState === "requires_action"
  )
    return "busy";
  return undefined;
}
export async function rewindClaudeSession(
  p: SessionRewindRequest,
  deps: SessionRewindDependencies,
): Promise<SessionRewindResponse> {
  const session = deps.getSession(p.sessionId);
  if (!session) return { rewound: false, reason: "session_not_found" };
  if (session.nativeRewindUnsupported) return { rewound: false, reason: "unsupported" };
  const query = session.query;
  const busy = sessionMutationBusy(session);
  if (busy && (busy !== "busy" || !p.interruptIfRunning)) return { rewound: false, reason: busy };
  // Resolve before cancelling: a malformed target must not interrupt unrelated work.
  let messages = await readSessionHistory(p.sessionId, true);
  resolveTarget(messages, p, deps.messageIdForGrouping);
  if (busy) {
    const completions = (session.turnQueue ?? []).map((t) => t.completion).filter(Boolean);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        (async () => {
          await deps.cancel(p.sessionId);
          await Promise.all(completions);
          // ACP turn settlement may precede the CLI's trailing idle event.
          const deadline = Date.now() + 2_000;
          while (
            session.lastSessionState === "running" &&
            Date.now() < deadline &&
            !session.queryClosed
          ) {
            await new Promise((resolve) => setTimeout(resolve, 20));
          }
        })(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("cancel_timeout")), 15_000);
        }),
      ]);
    } catch {
      deps.invalidate(session);
      return { rewound: false, reason: "cancel_failed_reload_required" };
    } finally {
      clearTimeout(timer);
    }
    messages = await readSessionHistory(p.sessionId, true);
  }
  if (deps.getSession(p.sessionId) !== session || session.query !== query)
    return { rewound: false, reason: "state_changed" };
  const nowBusy = sessionMutationBusy(session);
  if (nowBusy) return { rewound: false, reason: nowBusy };
  const target = resolveTarget(messages, p, deps.messageIdForGrouping);
  const last =
    session.lastObservedUserMessageUuid ?? messages.findLast(isAuthoredUserMessage)?.uuid;
  if (!last) return { rewound: false, reason: "target_not_found" };
  try {
    const result = await nativeRewind(query, target.uuid, last);
    if (!result.rewound) return { rewound: false, reason: result.reason ?? "native_refused" };
    if (result.targetMessageUuid !== target.uuid)
      throw new NativeRewindUncertain("CLI rewound a different message; reload required");
    if (deps.getSession(p.sessionId) !== session || session.query !== query || session.queryClosed)
      throw new NativeRewindUncertain("Session changed while rewinding; reload required");
    deps.committed(p.sessionId);
    return { rewound: true, sessionId: p.sessionId };
  } catch (error) {
    if (error instanceof NativeRewindUnsupported) {
      session.nativeRewindUnsupported = true;
      return { rewound: false, reason: "unsupported" };
    }
    // A missing acknowledgement is not proof of no mutation. Close the stale
    // query and require reload; never retry the operation or report success.
    deps.invalidate(session);
    throw error;
  }
}
function resolveTarget(
  messages: SessionMessage[],
  p: SessionRewindRequest,
  grouping: SessionRewindDependencies["messageIdForGrouping"],
): SessionMessage {
  const target = resolveHistoryPointFromMessages(
    messages,
    p.sessionId,
    p.beforeMessage,
    "user",
    grouping,
  );
  const index = messages.indexOf(target);
  if (p.resumeAtMessage) {
    const assistant = resolveHistoryPointFromMessages(
      messages,
      p.sessionId,
      p.resumeAtMessage,
      "assistant",
      grouping,
    );
    if (!isAssistantInPrecedingAuthoredTurn(messages, index, assistant))
      throw RequestError.invalidParams(
        undefined,
        "resumeAtMessage is not the assistant message immediately preceding beforeMessage",
      );
  } else if (messages.slice(0, index).some(isAuthoredUserMessage)) {
    throw RequestError.invalidParams(
      undefined,
      "resumeAtMessage is required for a non-initial user message",
    );
  }
  return target;
}
export async function resolveHistoryPoint(
  sessionId: string,
  point: SessionHistoryPoint,
  role: "user" | "assistant",
  grouping: SessionRewindDependencies["messageIdForGrouping"],
): Promise<SessionMessage> {
  return resolveHistoryPointFromMessages(
    await readSessionHistory(sessionId, true),
    sessionId,
    point,
    role,
    grouping,
  );
}

export function resolveHistoryPointFromMessages(
  messages: SessionMessage[],
  sessionId: string,
  point: SessionHistoryPoint,
  role: "user" | "assistant",
  messageIdForGrouping: (message: SessionMessage) => string | undefined,
): SessionMessage {
  const roleMessages = messages.filter((message) =>
    role === "user" ? isAuthoredUserMessage(message) : message.type === role,
  );
  const candidates = messageIdCandidates(point.messageId);
  const exact = roleMessages
    .slice()
    .reverse()
    .find((message) => candidates.includes(messageIdForGrouping(message) ?? "") && message.uuid);
  if (exact) {
    if (fingerprint(messageText(exact)) !== point.messageFingerprint) {
      throw RequestError.invalidParams(
        undefined,
        "Message fingerprint does not match the selected message",
      );
    }
    return exact;
  }

  // A text hash cannot identify an image or distinguish repeated identical
  // prompts after ids have changed. Require a unique, non-empty text-only match.
  const matching = roleMessages.filter(
    (message) => message.uuid && fingerprint(messageText(message)) === point.messageFingerprint,
  );
  const fallback = matching.length === 1 ? matching[0] : undefined;
  const content = (fallback?.message as { content?: unknown } | undefined)?.content;
  const textOnly =
    typeof content === "string" ||
    (Array.isArray(content) &&
      content.every(
        (block) =>
          block && typeof block === "object" && (block as { type?: string }).type === "text",
      ));
  if (fallback && textOnly && messageText(fallback).trim()) return fallback;
  throw RequestError.invalidParams(
    { messageId: point.messageId },
    `Rewind message ${point.messageId} was not found in session ${sessionId}`,
  );
}

function isAssistantInPrecedingAuthoredTurn(
  messages: SessionMessage[],
  beforeIndex: number,
  assistant: SessionMessage,
): boolean {
  const assistantIndex = messages.indexOf(assistant);
  const precedingAuthoredUserIndex = messages
    .slice(0, beforeIndex)
    .findLastIndex(isAuthoredUserMessage);
  return assistantIndex > precedingAuthoredUserIndex && assistantIndex < beforeIndex;
}

export function isAuthoredUserMessage(message: SessionMessage): boolean {
  if (
    message.type !== "user" ||
    message.parent_tool_use_id != null ||
    message.parent_agent_id != null ||
    (message as { isMeta?: boolean }).isMeta ||
    (message as { is_meta?: boolean }).is_meta ||
    (message as { isCompactSummary?: boolean }).isCompactSummary ||
    (message as { isSynthetic?: boolean }).isSynthetic
  )
    return false;
  const content = (message as { message?: { content?: unknown } }).message?.content;
  if (typeof content === "string") return true;
  if (!Array.isArray(content)) return false;
  return content.some(
    (block) =>
      !block || typeof block !== "object" || (block as { type?: unknown }).type !== "tool_result",
  );
}

export function parseHistoryPoint(value: unknown, name: string): SessionHistoryPoint {
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
