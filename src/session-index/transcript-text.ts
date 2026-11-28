import { RequestError } from "@agentclientprotocol/sdk/unstable";
import { getSessionMessages, type SessionStoreEntry } from "@anthropic-ai/claude-agent-sdk";
import { stat, open } from "node:fs/promises";
import { compactionSummaryText, isCompactSummaryMessage } from "../context-compaction.js";
import { stripLocalCommandMetadata } from "../message-filters.js";
import { readHistoryAcrossCompactions } from "../resumed-session.js";
import { messageIdForGrouping } from "../sdk-to-acp.js";
import { assistantMessageText } from "../session-failure-extension.js";
import { activeSessionMessages, readRewindPoint } from "../session-rewind.js";
import { errorCode } from "./project-dirs.js";
import type { IndexRow } from "./session-index.js";

export const TRANSCRIPT_TEXT_SNAPSHOT_KEY = "transcriptTextSnapshot";
export type TranscriptTextMode = "transcriptRevision" | "transcriptTextSnapshot";

type TranscriptMessage = { role: "user" | "assistant" | "compact_summary"; text: string };
type TranscriptText = {
  revision: string;
  messages?: TranscriptMessage[];
  truncated?: boolean;
};

const MAX_TRANSCRIPT_BYTES = 64 * 1024 * 1024;
const MAX_PROJECTION_JSON_BYTES = 4 * 1024 * 1024;

export async function readTranscriptText(
  row: IndexRow,
  mode: TranscriptTextMode,
  signal?: AbortSignal,
): Promise<TranscriptText | undefined> {
  try {
    signal?.throwIfAborted();
    const { initial, rewindPoint, revision } = await transcriptState(row);
    if (!initial.isFile()) return undefined;
    if (mode === "transcriptRevision") return { revision };
    if (initial.size > MAX_TRANSCRIPT_BYTES) return { revision, messages: [], truncated: true };

    const read = await readEntries(row.filePath, Number(initial.size), revisionOf(initial), signal);
    const entries = read.entries;
    let truncated = read.truncated;
    const chain = await getSessionMessages(row.sessionId, {
      sessionStore: { append: async () => {}, load: async () => entries },
    });
    const history = await readHistoryAcrossCompactions(
      row.sessionId,
      activeSessionMessages(chain, rewindPoint),
      {
        error: () => {
          truncated = true;
        },
        log: () => {},
      },
      undefined,
      async () => entries,
    );
    signal?.throwIfAborted();
    const result = project(history);
    if (revision !== (await transcriptState(row)).revision) {
      throw new Error("The transcript changed during the read");
    }
    return { revision, messages: result.messages, truncated: truncated || result.truncated };
  } catch (error) {
    signal?.throwIfAborted();
    if (errorCode(error) === "ENOENT") return undefined;
    throw RequestError.internalError(
      undefined,
      "Could not read the session transcript text. Retry the request.",
    );
  }
}

async function transcriptState(row: IndexRow) {
  const initial = await bigintStat(row.filePath);
  const rewindPoint = await readRewindPoint(row.sessionId, undefined, row.filePath);
  const revision = JSON.stringify([
    revisionOf(initial),
    rewindPoint?.resumeSessionAt,
    rewindPoint?.droppedPromptUuid,
  ]);
  return { initial, rewindPoint, revision };
}

function revisionOf({ dev, ino, size, mtimeNs, ctimeNs }: Awaited<ReturnType<typeof bigintStat>>) {
  return [dev, ino, size, mtimeNs, ctimeNs].join(":");
}

function bigintStat(filePath: string) {
  return stat(filePath, { bigint: true });
}

async function readEntries(
  filePath: string,
  bytes: number,
  revision: string,
  signal?: AbortSignal,
) {
  if (bytes === 0) return { entries: [], truncated: false };
  const file = await open(filePath);
  try {
    if (revision !== revisionOf(await file.stat({ bigint: true }))) {
      throw new Error("The transcript changed before the read");
    }
    const chunks: Buffer[] = [];
    for await (const chunk of file.createReadStream({ end: bytes - 1, autoClose: false, signal })) {
      chunks.push(chunk as Buffer);
    }
    let truncated = false;
    const entries = Buffer.concat(chunks)
      .toString("utf8")
      .split("\n")
      .flatMap((line): SessionStoreEntry[] => {
        if (!line.trim()) return [];
        let entry: unknown;
        try {
          entry = JSON.parse(line);
        } catch (error) {
          if (!(error instanceof SyntaxError)) throw error;
          truncated = true;
          return [];
        }
        return entry &&
          typeof entry === "object" &&
          "type" in entry &&
          typeof entry.type === "string"
          ? [entry as SessionStoreEntry]
          : [];
      });
    return { entries, truncated };
  } finally {
    await file.close();
  }
}

function project(history: Awaited<ReturnType<typeof getSessionMessages>>) {
  const groups = new Map<string, { role: TranscriptMessage["role"]; parts: string[] }>();
  let characters = 0;
  let truncated = false;
  for (const message of history) {
    if (message.parent_tool_use_id != null) continue;
    const payload = message.message as { model?: string; content?: unknown };
    const compact = isCompactSummaryMessage(message);
    const meta = (message as { is_meta?: boolean }).is_meta === true;
    if (!compact && (meta || payload.model === "<synthetic>")) continue;
    const role = compact ? "compact_summary" : message.type;
    if (role !== "user" && role !== "assistant" && role !== "compact_summary") continue;
    const text = compact
      ? compactionSummaryText(assistantMessageText(payload) ?? "")
      : assistantMessageText({
          content: role === "user" ? stripLocalCommandMetadata(payload.content) : payload.content,
        });
    if (!text) continue;

    const id = `${role}:${messageIdForGrouping(message) ?? message.uuid}`;
    const existing = groups.get(id);
    // Bound intermediate text before making the serialized response.
    characters += text.length + (existing ? 0 : 48);
    if (characters > MAX_PROJECTION_JSON_BYTES) {
      groups.delete(id);
      truncated = true;
      break;
    }
    const group = existing ?? { role, parts: [] };
    group.parts.push(text);
    groups.set(id, group);
  }
  const messages: TranscriptMessage[] = [];
  let serializedBytes = 2;
  for (const { role, parts } of groups.values()) {
    const message = { role, text: parts.join("") };
    serializedBytes += Buffer.byteLength(JSON.stringify(message)) + 1;
    if (serializedBytes > MAX_PROJECTION_JSON_BYTES) {
      truncated = true;
      break;
    }
    messages.push(message);
  }
  return { messages, truncated };
}
