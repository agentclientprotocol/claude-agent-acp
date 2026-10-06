/**
 * What the session list needs from a transcript beyond the SDK metadata.
 *
 * One open reads the first and the last {@link CHUNK_SIZE} bytes, the same
 * window that the SDK reads. The tail gives the time of the last message, the
 * end of the last turn, and the last `cost-state` record. The head and the
 * tail give the `cwd` candidates.
 */

import * as fs from "node:fs/promises";

const CHUNK_SIZE = 64 * 1024;

export type TurnState = "finished" | "unfinished";

export type TranscriptFacts = {
  /** Time of the last user or assistant message in the tail, epoch ms. */
  lastMessageAt?: number;
  /** Whether the last turn in the tail ended. Undefined when the tail shows
   *  no turn at all. */
  turnState?: TurnState;
  /** Time the last ended turn ended, epoch ms. */
  lastTurnEndedAt?: number;
  /** `totalCostUSD` of the last valid `cost-state` record of this session. */
  costUsd?: number;
  /** The first `cwd` of the head. */
  headCwd?: string;
  /** The last `cwd` of the tail. */
  tailCwd?: string;
  /** Whether the head or the tail holds a user or an assistant message. A
   *  transcript without one is a metadata-only stub. */
  hasMessages: boolean;
};

export type HeadTail = { head: string; tail: string };

/** The first and the last 64 KB of `filePath`. The tail is the head for a
 *  file that fits in one chunk. */
export async function readHeadTail(filePath: string, size: number): Promise<HeadTail> {
  const handle = await fs.open(filePath, "r");
  try {
    const buffer = Buffer.allocUnsafe(CHUNK_SIZE);
    const first = await handle.read(buffer, 0, CHUNK_SIZE, 0);
    const head = buffer.toString("utf8", 0, first.bytesRead);
    if (size <= CHUNK_SIZE) return { head, tail: head };
    const last = await handle.read(buffer, 0, CHUNK_SIZE, size - CHUNK_SIZE);
    // The first line of the tail window is cut; drop it.
    const raw = buffer.toString("utf8", 0, last.bytesRead);
    const newline = raw.indexOf("\n");
    return { head, tail: newline >= 0 ? raw.slice(newline + 1) : "" };
  } finally {
    await handle.close();
  }
}

const MESSAGE_MARKERS = [
  '"type":"user"',
  '"type":"assistant"',
  '"type": "user"',
  '"type": "assistant"',
];

/** System records that the CLI writes when a turn ends. */
const TURN_END_SYSTEM_SUBTYPES = new Set(["stop_hook_summary", "turn_duration"]);

const INTERRUPT_PREFIX = "[Request interrupted by user";

type Entry = Record<string, unknown>;

function parseLine(line: string): Entry | undefined {
  try {
    const value: unknown = JSON.parse(line);
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Entry)
      : undefined;
  } catch {
    return undefined;
  }
}

function timestampOf(entry: Entry): number | undefined {
  if (typeof entry.timestamp !== "string") return undefined;
  const value = Date.parse(entry.timestamp);
  return Number.isNaN(value) ? undefined : value;
}

function firstText(entry: Entry): string | undefined {
  const message = entry.message as { content?: unknown } | undefined;
  const content = message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block && typeof block === "object" && (block as { type?: unknown }).type === "text") {
        const text = (block as { text?: unknown }).text;
        if (typeof text === "string") return text;
      }
    }
  }
  return undefined;
}

/**
 * How a main-chain record bears on the end of the turn: `finished` for a
 * record that ends a turn (an assistant `end_turn`, an API error, a user
 * interrupt, the CLI's turn-end system records), `unfinished` for a record of
 * a turn in progress, and undefined for a record that says nothing.
 */
export function turnEffect(entry: Entry): TurnState | undefined {
  if (entry.isSidechain === true) return undefined;
  switch (entry.type) {
    case "assistant": {
      if (entry.isApiErrorMessage === true) return "finished";
      const stopReason = (entry.message as { stop_reason?: unknown } | undefined)?.stop_reason;
      return stopReason === "end_turn" ? "finished" : "unfinished";
    }
    case "user": {
      if (entry.isMeta === true) return undefined;
      return firstText(entry)?.startsWith(INTERRUPT_PREFIX) ? "finished" : "unfinished";
    }
    case "system":
      return TURN_END_SYSTEM_SUBTYPES.has(entry.subtype as string) ? "finished" : undefined;
    default:
      return undefined;
  }
}

const CWD_PATTERN = /"cwd":\s?"((?:[^"\\]|\\.)*)"/;

function decodeJsonString(raw: string): string | undefined {
  try {
    const value: unknown = JSON.parse(`"${raw}"`);
    return typeof value === "string" ? value : undefined;
  } catch {
    return undefined;
  }
}

/** The facts of a transcript, from its head and its tail. */
export function scanTranscript({ head, tail }: HeadTail, sessionId: string): TranscriptFacts {
  const facts: TranscriptFacts = {
    hasMessages: MESSAGE_MARKERS.some((marker) => head.includes(marker) || tail.includes(marker)),
  };
  const headCwd = CWD_PATTERN.exec(head)?.[1];
  if (headCwd !== undefined) facts.headCwd = decodeJsonString(headCwd);

  const lines = tail.split("\n");
  let costFound = false;
  let turnEndFound = false;
  let messageFound = false;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (!line) continue;
    const isCost = line.includes('"cost-state"');
    const isTurnRecord =
      line.includes('"user"') || line.includes('"assistant"') || line.includes('"system"');
    const hasCwd = facts.tailCwd === undefined && line.includes('"cwd"');
    if (!isCost && !isTurnRecord && !hasCwd) continue;
    // Everything has been found: stop parsing.
    if (costFound && turnEndFound && messageFound && !hasCwd) break;
    const entry = parseLine(line);
    if (!entry) continue;
    if (hasCwd && typeof entry.cwd === "string" && entry.cwd) facts.tailCwd = entry.cwd;
    if (entry.type === "cost-state") {
      if (
        !costFound &&
        entry.sessionId === sessionId &&
        typeof entry.totalCostUSD === "number" &&
        Number.isFinite(entry.totalCostUSD)
      ) {
        facts.costUsd = entry.totalCostUSD;
        costFound = true;
      }
      continue;
    }
    if (entry.isSidechain === true) continue;
    if (!messageFound && (entry.type === "user" || entry.type === "assistant")) {
      messageFound = true;
      facts.lastMessageAt = timestampOf(entry);
    }
    const effect = turnEffect(entry);
    if (effect === undefined) continue;
    if (facts.turnState === undefined) facts.turnState = effect;
    if (effect === "finished" && !turnEndFound) {
      turnEndFound = true;
      facts.lastTurnEndedAt = timestampOf(entry);
    }
  }
  return facts;
}
