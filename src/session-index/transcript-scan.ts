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
import { firstPrompt, isUserPrompt, mediaPrompt, promptOf } from "./first-prompt.js";

const CHUNK_SIZE = 64 * 1024;
/** The largest tail window read to find the last message. */
const MAX_TAIL_SIZE = 4 * 1024 * 1024;
const TAIL_GROWTH = 4;
const FULL_SEARCH_CACHE_SIZE = 512;

/** By `path\0size`, the facts of the transcripts whose last
 *  {@link MAX_TAIL_SIZE} bytes lack the last message or prompt: a file of
 *  the same size is not searched again. */
const fullySearched = new Map<string, TranscriptFacts>();

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
  /** Time of the last real user prompt in the tail (not a tool result, a
   *  meta record or a slash command), epoch ms. */
  lastPromptAt?: number;
  /** The model of the last assistant message in the tail. */
  model?: string;
  /** The first timestamp of the head, as the SDK's `createdAt`. */
  createdAt?: number;
  /** The session this one was forked from: the `forkedFrom.sessionId` that
   *  the SDK and CLI fork write on every copied record. */
  forkedFrom?: string;
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
 * messages but the tail window lacks the last message or the last user
 * prompt (a long answer or tool output follows it), the window grows,
 * reading only the new range each step, until it holds both or reaches
 * {@link MAX_TAIL_SIZE}. The result of a full search is kept per
 * `(path, size)`.
 *
 * `previous` is what an earlier scan of the same file found: when the file
 * only grew by less than the tail window, and the tail holds no prompt, the
 * appended bytes hold none either, so the earlier `lastPromptAt` stands.
 */
export async function scanTranscriptFile(
  filePath: string,
  size: number,
  sessionId: string,
  headTail?: HeadTail,
  previous?: { size: number; lastPromptAt?: number },
): Promise<TranscriptFacts> {
  const read = headTail ?? (await readHeadTail(filePath, size));
  const facts = scanTranscript(read, sessionId);
  if (
    facts.lastPromptAt === undefined &&
    previous?.lastPromptAt !== undefined &&
    size >= previous.size &&
    // The tail covers every appended byte.
    size - Buffer.byteLength(read.tail) <= previous.size
  ) {
    facts.lastPromptAt = previous.lastPromptAt;
  }
  const complete = (found: TranscriptFacts) =>
    found.lastMessageAt !== undefined && found.lastPromptAt !== undefined;
  if (!facts.hasMessages || complete(facts) || size <= CHUNK_SIZE) return facts;
  const key = `${filePath}\0${size}`;
  const searched = fullySearched.get(key);
  if (searched) return searched;
  let result = facts;
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
      // A wider tail ends with the same records: what the narrow one found
      // stays, and the wider one adds what lay before it.
      const wider = scanTranscript({ head: read.head, tail }, sessionId);
      result = {
        ...wider,
        hasMessages: facts.hasMessages,
        lastPromptAt: wider.lastPromptAt ?? facts.lastPromptAt,
      };
      if (complete(result)) return result;
    }
  } finally {
    await handle.close();
  }
  fullySearched.set(key, result);
  if (fullySearched.size > FULL_SEARCH_CACHE_SIZE) {
    fullySearched.delete(fullySearched.keys().next().value as string);
  }
  return result;
}

const RELOCATED_MARKER = '"relocated"';

/** The cwd of the last `relocated` record of the tail: where the session
 *  was moved, whatever cwd its earlier messages carry. */
export function relocatedCwd(tail: string): string | undefined {
  const lines = tail.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (!line.includes(RELOCATED_MARKER)) continue;
    const entry = parseLine(line);
    if (entry?.type === "relocated" && typeof entry.relocatedCwd === "string") {
      return entry.relocatedCwd;
    }
  }
  return undefined;
}

/** The cwd a transcript belongs to, as the SDK reads it: the last
 *  `relocated` record of the tail, else the first cwd of the head. */
export function transcriptProjectCwd({ head, tail }: HeadTail): string | undefined {
  const relocated = relocatedCwd(tail);
  if (relocated !== undefined) return relocated;
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

const FORKED_FROM_PATTERN =
  /"forkedFrom":\s?\{"sessionId":\s?"([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})"/;

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
  const createdAt = firstField(head, "timestamp");
  if (createdAt !== undefined && !Number.isNaN(Date.parse(createdAt))) {
    facts.createdAt = Date.parse(createdAt);
  }
  const forkedFrom = FORKED_FROM_PATTERN.exec(head)?.[1];
  if (forkedFrom !== undefined) facts.forkedFrom = forkedFrom;

  const lines = tail.split("\n");
  let costFound = false;
  let turnEndFound = false;
  let messageFound = false;
  let promptFound = false;
  let modelFound = false;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (!line) continue;
    const isCost = line.includes('"cost-state"');
    const isTurnRecord =
      line.includes('"user"') || line.includes('"assistant"') || line.includes('"system"');
    const hasCwd = facts.tailCwd === undefined && line.includes('"cwd"');
    if (!isCost && !isTurnRecord && !hasCwd) continue;
    // Everything has been found: stop parsing.
    if (costFound && turnEndFound && messageFound && promptFound && modelFound && !hasCwd) break;
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
    if (!promptFound && entry.type === "user" && isUserPrompt(entry)) {
      promptFound = true;
      facts.lastPromptAt = timestampOf(entry);
    }
    if (!modelFound && entry.type === "assistant") {
      const model = (entry.message as { model?: unknown } | undefined)?.model;
      // The CLI marks the messages it makes up (API errors) `<synthetic>`.
      if (typeof model === "string" && model && model !== "<synthetic>") {
        modelFound = true;
        facts.model = model;
      }
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

/** Every `"key":"value"` string of `text`, in order, decoded. */
function stringFields(text: string, key: string): string[] {
  const pattern = new RegExp(`"${key}":\\s?"((?:[^"\\\\]|\\\\.)*)"`, "g");
  const values: string[] = [];
  for (const match of text.matchAll(pattern)) {
    const value = decodeJsonString(match[1]!);
    if (value !== undefined) values.push(value);
  }
  return values;
}

const lastField = (text: string, key: string) => stringFields(text, key).at(-1) || undefined;
const firstField = (text: string, key: string) => stringFields(text, key)[0] || undefined;

/** Whether the first record of the transcript is a sidechain one, which the
 *  SDK never lists. */
export function isSidechainTranscript(head: string): boolean {
  const newline = head.indexOf("\n");
  const first = newline >= 0 ? head.slice(0, newline) : head;
  return first.includes('"isSidechain":true') || first.includes('"isSidechain": true');
}

export type TitleFields = { summary?: string; gitBranch?: string };

/**
 * The title and branch of a transcript from its own head and tail, in the
 * SDK's order: custom title (tail, the sidecar, head), AI title, last prompt,
 * summary, first prompt. For a transcript the SDK `getSessionInfo` does not
 * read (another copy of the session comes first in its search).
 */
export function titleFields({ head, tail }: HeadTail, sidecarTitle?: string): TitleFields {
  const summary =
    lastField(tail, "customTitle") ??
    sidecarTitle ??
    lastField(head, "customTitle") ??
    lastField(tail, "aiTitle") ??
    lastField(head, "aiTitle") ??
    lastField(tail, "lastPrompt") ??
    lastField(tail, "summary") ??
    (firstPrompt(head) || mediaPrompt(head) || undefined);
  const gitBranch = lastField(tail, "gitBranch") ?? firstField(head, "gitBranch");
  return {
    ...(summary !== undefined && { summary }),
    ...(gitBranch !== undefined && { gitBranch }),
  };
}

/** Whether the tail carries a custom title of its own. */
export function hasTailCustomTitle(tail: string): boolean {
  return lastField(tail, "customTitle") !== undefined;
}

const CONTINUED_IN_MARKER = '"type":"continued-in"';

/**
 * The session this transcript was continued in, as the SDK list reads it: the
 * last `continued-in` record of the tail, unless a completed turn follows it
 * (the session was resumed here again).
 */
export function continuedInSessionId(tail: string): string | undefined {
  if (!tail.includes(CONTINUED_IN_MARKER)) return undefined;
  const lines = tail.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    const isContinuation = line.includes(CONTINUED_IN_MARKER);
    const isMessage = line.includes('"type":"user"') || line.includes('"type":"assistant"');
    if (!isContinuation && !isMessage) continue;
    const entry = parseLine(line);
    if (!entry) continue;
    if (isContinuation && entry.type === "continued-in") {
      const id = entry.continuedInSessionId;
      return typeof id === "string" && SESSION_ID.test(id) ? id : undefined;
    }
    if (entry.type === "assistant") {
      const stopReason = (entry.message as { stop_reason?: unknown } | undefined)?.stop_reason;
      if (entry.isApiErrorMessage !== true && typeof stopReason === "string") return undefined;
    } else if (promptOf(entry, { commandFallback: "" }) !== undefined) {
      return undefined;
    }
  }
  return undefined;
}

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HISTORY_MARKER = '"parentUuid":';
const HISTORY_SCAN_LIMIT = 16 * 1024 * 1024;
const HISTORY_SCAN_CHUNK = 1024 * 1024;

/** Whether the transcript at `filePath` holds conversation history (a record
 *  with a `parentUuid`), as the SDK checks a continuation's successor. */
export async function hasHistory(filePath: string): Promise<boolean> {
  let handle: fs.FileHandle;
  try {
    handle = await fs.open(filePath, "r");
  } catch {
    return false;
  }
  try {
    const { size } = await handle.stat();
    const buffer = Buffer.allocUnsafe(HISTORY_SCAN_CHUNK + HISTORY_MARKER.length);
    let carry = 0;
    for (let offset = 0; offset < Math.min(size, HISTORY_SCAN_LIMIT);) {
      const { bytesRead } = await handle.read(buffer, carry, HISTORY_SCAN_CHUNK, offset);
      if (bytesRead === 0) return false;
      const end = carry + bytesRead;
      if (buffer.subarray(0, end).includes(HISTORY_MARKER)) return true;
      carry = Math.min(HISTORY_MARKER.length, end);
      buffer.copyWithin(0, end - carry, end);
      offset += bytesRead;
    }
    // Past the scan limit the SDK assumes history.
    return size > HISTORY_SCAN_LIMIT;
  } catch {
    return false;
  } finally {
    await handle.close();
  }
}
