/**
 * What the session list needs from a transcript beyond the SDK metadata.
 *
 * One open reads the first and the last {@link CHUNK_SIZE} bytes, the same
 * window that the SDK reads. The tail gives the time of the last message, the
 * end of the last turn, and the last `cost-state` record. The head and the
 * tail give the `cwd` candidates.
 *
 * A last message longer than the tail window leaves no message in it: then
 * the tail window grows, up to {@link MAX_TAIL_SIZE}, until it holds one.
 */

import * as fs from "node:fs/promises";

const CHUNK_SIZE = 64 * 1024;
/** The largest tail window read to find the last message. */
const MAX_TAIL_SIZE = 4 * 1024 * 1024;
const TAIL_GROWTH = 4;
const NO_MESSAGE_CACHE_SIZE = 512;

/** `path\0size` of the transcripts whose last {@link MAX_TAIL_SIZE} bytes hold
 *  no message: a file of the same size is not searched again. */
const noMessageInTail = new Set<string>();

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

/** The last `window` bytes of a file of `size` bytes, without the first,
 *  cut line. The whole file when it fits. */
async function readTail(handle: fs.FileHandle, size: number, window: number): Promise<string> {
  const length = Math.min(window, size);
  const buffer = Buffer.allocUnsafe(length);
  const { bytesRead } = await handle.read(buffer, 0, length, size - length);
  const raw = buffer.toString("utf8", 0, bytesRead);
  if (length === size) return raw;
  const newline = raw.indexOf("\n");
  return newline >= 0 ? raw.slice(newline + 1) : "";
}

/** The first and the last 64 KB of `filePath`. The tail is the head for a
 *  file that fits in one chunk. */
export async function readHeadTail(filePath: string, size: number): Promise<HeadTail> {
  const handle = await fs.open(filePath, "r");
  try {
    const buffer = Buffer.allocUnsafe(CHUNK_SIZE);
    const first = await handle.read(buffer, 0, CHUNK_SIZE, 0);
    const head = buffer.toString("utf8", 0, first.bytesRead);
    if (size <= CHUNK_SIZE) return { head, tail: head };
    return { head, tail: await readTail(handle, size, CHUNK_SIZE) };
  } finally {
    await handle.close();
  }
}

/**
 * The facts of `filePath`, from its head and tail. When the transcript has
 * messages but the tail window holds none (the last one is longer than the
 * window), the window grows until it holds one or reaches
 * {@link MAX_TAIL_SIZE}.
 */
export async function scanTranscriptFile(
  filePath: string,
  size: number,
  sessionId: string,
  headTail?: HeadTail,
): Promise<TranscriptFacts> {
  const read = headTail ?? (await readHeadTail(filePath, size));
  const facts = scanTranscript(read, sessionId);
  if (!facts.hasMessages || facts.lastMessageAt !== undefined || size <= CHUNK_SIZE) {
    return facts;
  }
  const key = `${filePath}\0${size}`;
  if (noMessageInTail.has(key)) return facts;
  const handle = await fs.open(filePath, "r");
  try {
    // The bytes from `start` to the end, grown by reading the new range only.
    let start = Math.max(0, size - CHUNK_SIZE);
    let bytes = Buffer.alloc(0);
    {
      const first = Buffer.allocUnsafe(size - start);
      const { bytesRead } = await handle.read(first, 0, first.length, start);
      bytes = first.subarray(0, bytesRead);
    }
    for (let window = CHUNK_SIZE * TAIL_GROWTH; start > 0; window *= TAIL_GROWTH) {
      const nextStart = Math.max(0, size - Math.min(window, MAX_TAIL_SIZE));
      if (nextStart >= start) break;
      const range = Buffer.allocUnsafe(start - nextStart);
      const { bytesRead } = await handle.read(range, 0, range.length, nextStart);
      bytes = Buffer.concat([range.subarray(0, bytesRead), bytes]);
      start = nextStart;
      let tail = bytes.toString("utf8");
      if (start > 0) {
        // The first line of the window is cut; drop it.
        const newline = tail.indexOf("\n");
        tail = newline >= 0 ? tail.slice(newline + 1) : "";
      }
      const wider = scanTranscript({ head: read.head, tail }, sessionId);
      if (wider.lastMessageAt !== undefined) {
        // A wider tail ends with the same records: what the narrow one found
        // stays, and the wider one adds what lay before it.
        return { ...wider, hasMessages: facts.hasMessages };
      }
    }
  } finally {
    await handle.close();
  }
  noMessageInTail.add(key);
  if (noMessageInTail.size > NO_MESSAGE_CACHE_SIZE) {
    noMessageInTail.delete(noMessageInTail.values().next().value as string);
  }
  return facts;
}

const RELOCATED_MARKER = '"relocated"';

/** The cwd a transcript belongs to, as the SDK reads it: the last
 *  `relocated` record of the tail, else the first cwd of the head. */
export function transcriptProjectCwd({ head, tail }: HeadTail): string | undefined {
  const lines = tail.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (!line.includes(RELOCATED_MARKER)) continue;
    const entry = parseLine(line);
    if (entry?.type === "relocated" && typeof entry.relocatedCwd === "string") {
      return entry.relocatedCwd;
    }
  }
  const headCwd = CWD_PATTERN.exec(head)?.[1];
  return headCwd === undefined ? undefined : decodeJsonString(headCwd);
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
