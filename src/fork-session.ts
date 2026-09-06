import { ForkSessionRequest, ForkSessionResponse, RequestError } from "@agentclientprotocol/sdk";
import {
  forkSession as forkClaudeSession,
  getSessionMessages,
  importSessionToStore,
  type SessionStore,
  type SessionStoreEntry,
} from "@anthropic-ai/claude-agent-sdk";
import { createHash } from "node:crypto";
import { assistantMessageText } from "./session-failure-extension.js";
import { SessionTiming } from "./session-timing.js";

type ForkSessionMeta = {
  [key: string]: unknown;
  jetbrains?: {
    air?: {
      fork?: {
        version?: number;
        messageId?: string;
        messageFingerprint?: string;
        messageOccurrence?: number;
      };
    };
  };
};

type ForkSessionDependencies = {
  liveMessageIdToUuid?: ReadonlyMap<string, string>;
  logger?: { log: (...args: unknown[]) => void };
  messageIdForGrouping: (message: {
    type?: string;
    uuid?: string | null;
    message?: unknown;
  }) => string | undefined;
};

type ForkPoint = {
  messageId: string;
  messageFingerprint?: string;
  messageOccurrence?: number;
};

function forkPoint(meta: unknown): ForkPoint | undefined {
  const fork = (meta as ForkSessionMeta | null | undefined)?.jetbrains?.air?.fork;
  if (fork?.version !== 1) return undefined;
  const messageId = fork.messageId?.trim();
  if (!messageId) return undefined;
  const messageFingerprint = fork.messageFingerprint?.trim();
  const messageOccurrence = fork.messageOccurrence;
  return {
    messageId,
    ...(messageFingerprint ? { messageFingerprint } : {}),
    // AIR computes this with count(...) over the visible prefix, so it is 1-based.
    ...(typeof messageOccurrence === "number" &&
    Number.isSafeInteger(messageOccurrence) &&
    messageOccurrence > 0
      ? { messageOccurrence }
      : {}),
  };
}

function forkPointMessageIdCandidates(messageId: string): string[] {
  // Older AIR builds sent their visible segment id. Prefer the exact id before its ACP source id.
  const protocolMessageId = messageId.replace(/:segment:\d+$/, "");
  return protocolMessageId === messageId ? [messageId] : [messageId, protocolMessageId];
}

async function loadFullSessionHistory(
  sessionId: string,
  cwd: string,
): Promise<SessionStoreEntry[]> {
  // getSessionMessages returns only the active parentUuid chain. The import keeps inactive branches that AIR can still reference.
  const entries: SessionStoreEntry[] = [];
  const store: SessionStore = {
    append: async (_key, batch) => {
      entries.push(...batch);
    },
    load: async () => null,
  };
  await importSessionToStore(sessionId, store, { dir: cwd, includeSubagents: false });
  return entries;
}

function assistantGroups(
  entries: SessionStoreEntry[],
  messageIdForGrouping: ForkSessionDependencies["messageIdForGrouping"],
) {
  const groups = new Map<string, { uuid?: string; text: string }>();
  for (const entry of entries) {
    if (
      entry.type !== "assistant" ||
      entry.isSidechain === true ||
      entry.parent_tool_use_id != null ||
      entry.parent_agent_id != null
    ) {
      continue;
    }
    const messageId = messageIdForGrouping(entry);
    if (!messageId) continue;
    const group = groups.get(messageId) ?? { text: "" };
    if (typeof entry.uuid === "string" && entry.uuid.length > 0) group.uuid = entry.uuid;
    group.text += assistantMessageText(entry.message) ?? "";
    groups.set(messageId, group);
  }
  return groups;
}

function fingerprint(text: string): string {
  return `sha256:${createHash("sha256").update(text).digest("hex")}`;
}

function fingerprintOccurrenceOnBranch(
  targetUuid: string,
  expectedFingerprint: string,
  entries: SessionStoreEntry[],
  groups: ReturnType<typeof assistantGroups>,
  messageIdForGrouping: ForkSessionDependencies["messageIdForGrouping"],
): number {
  const entriesByUuid = new Map(
    entries.flatMap((entry) => (typeof entry.uuid === "string" ? [[entry.uuid, entry]] : [])),
  );
  const seenGroups = new Set<string>();
  let occurrence = 0;
  let cursor: string | undefined = targetUuid;
  while (cursor) {
    const entry = entriesByUuid.get(cursor);
    if (!entry) break;
    if (
      entry.type === "assistant" &&
      entry.isSidechain !== true &&
      entry.parent_tool_use_id == null &&
      entry.parent_agent_id == null
    ) {
      const messageId = messageIdForGrouping(entry);
      if (messageId && !seenGroups.has(messageId)) {
        seenGroups.add(messageId);
        const group = groups.get(messageId);
        if (group && fingerprint(group.text) === expectedFingerprint) occurrence++;
      }
    }
    cursor = typeof entry.parentUuid === "string" ? entry.parentUuid : undefined;
  }
  return occurrence;
}

function resolveFromFullHistory(
  entries: SessionStoreEntry[],
  candidates: string[],
  point: ForkPoint,
  messageIdForGrouping: ForkSessionDependencies["messageIdForGrouping"],
): string | undefined {
  const groups = assistantGroups(entries, messageIdForGrouping);
  const exact = candidates.map((candidate) => groups.get(candidate)?.uuid).find(Boolean);
  if (exact) return exact;
  if (!point.messageFingerprint || !point.messageOccurrence) return undefined;

  const fingerprintMatches = [...groups.values()].filter(
    (group) => group.uuid && fingerprint(group.text) === point.messageFingerprint,
  );
  // If only one persisted message has this content, the fingerprint already
  // identifies it even when an older client supplied an incompatible index.
  if (fingerprintMatches.length === 1) return fingerprintMatches[0]?.uuid;

  const occurrenceMatches = fingerprintMatches.filter(
    (group) =>
      group.uuid &&
      fingerprintOccurrenceOnBranch(
        group.uuid,
        point.messageFingerprint!,
        entries,
        groups,
        messageIdForGrouping,
      ) === point.messageOccurrence,
  );
  return occurrenceMatches.length === 1 ? occurrenceMatches[0]?.uuid : undefined;
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

  const candidateIds = forkPointMessageIdCandidates(point.messageId);
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
    : resolveFromFullHistory(
        await loadFullSessionHistory(params.sessionId, params.cwd),
        candidateIds,
        point,
        dependencies.messageIdForGrouping,
      );
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
