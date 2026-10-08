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
  /** Whether `lastPromptAt` is final: the prompt was found, or the tail
   *  window searched up to {@link MAX_TAIL_SIZE} holds none. */
  promptSearched?: boolean;
  /** The model of the last assistant message in the tail. */
  model?: string;
  /** The session this one was forked from: the `forkedFrom.sessionId` that
   *  the SDK and CLI fork write on every copied record. */
  forkedFrom?: string;
  /** Whether the head or the tail holds a user or an assistant message. A
   *  transcript without one is a metadata-only stub. */
  hasMessages: boolean;
};

export type HeadTail = { head: string; tail: string };

/** Facts that an earlier scan may have found before the tail window. */
const INHERITED_FACTS = ["model", "tailCwd", "lastTurnEndedAt", "costUsd"] as const;

/** What an earlier scan of the same file found, at `size`. */
export type PreviousScan = { size: number } & Pick<
  TranscriptFacts,
  "lastPromptAt" | "promptSearched" | (typeof INHERITED_FACTS)[number]
>;

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

/** The first and the last 64 KB of the first `size` bytes of `filePath`:
 *  what was appended after the file was stat'ed is not read, so the result
 *  matches the size it is cached by. The tail is the head for a file that
 *  fits in one chunk. */
export async function readHeadTail(filePath: string, size: number): Promise<HeadTail> {
  const handle = await fs.open(filePath, "r");
  try {
    const buffer = Buffer.allocUnsafe(CHUNK_SIZE);
    const first = await handle.read(buffer, 0, Math.min(CHUNK_SIZE, size), 0);
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
  previous?: PreviousScan,
  /** Tells a file replaced by another of the same size apart (its inode). */
  identity?: number,
): Promise<TranscriptFacts> {
  const read = headTail ?? (await readHeadTail(filePath, size));
  const facts = scanTranscript(read, sessionId);
  // The file only grew by bytes that the tail covers, and the tail holds no
  // prompt: the appended bytes hold none either, so the earlier search
  // stands (its prompt, or that the last 4 MB held none).
  const grownWithinTail =
    previous !== undefined &&
    size >= previous.size &&
    size - Buffer.byteLength(read.tail) <= previous.size;
  if (grownWithinTail) {
    // What the earlier, possibly wider, scan found before the tail stands
    // when the tail has nothing newer.
    for (const key of INHERITED_FACTS) {
      if (facts[key] === undefined && previous[key] !== undefined) {
        (facts as Record<string, unknown>)[key] = previous[key];
      }
    }
  }
  if (facts.lastPromptAt !== undefined || size <= CHUNK_SIZE) {
    facts.promptSearched = true;
  } else if (grownWithinTail && (previous.lastPromptAt !== undefined || previous.promptSearched)) {
    facts.lastPromptAt = previous.lastPromptAt;
    facts.promptSearched = true;
  }
  const complete = (found: TranscriptFacts) =>
    found.lastMessageAt !== undefined && found.promptSearched === true;
  if (!facts.hasMessages || complete(facts) || size <= CHUNK_SIZE) return facts;
  const key = `${filePath}\0${size}\0${identity ?? ""}`;
  const searched = fullySearched.get(key);
  if (searched) return searched;
  let result = facts;
  const handle = await fs.open(filePath, "r");
  try {
    // The bytes from `start` to the end, grown by reading the new range only.
    let start = Math.max(0, size - CHUNK_SIZE);
    const first = Buffer.allocUnsafe(size - start);
    const { bytesRead: firstRead } = await handle.read(first, 0, first.length, start);
    let bytes = first.subarray(0, firstRead);
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
      const wider = scanTranscript({ head: read.head, tail }, sessionId, {
        wide: true,
        known: { model: facts.model, tailCwd: facts.tailCwd },
      });
      const lastPromptAt = wider.lastPromptAt ?? facts.lastPromptAt;
      result = {
        ...wider,
        ...(facts.model !== undefined && { model: facts.model }),
        ...(facts.tailCwd !== undefined && { tailCwd: facts.tailCwd }),
        // A turn end or cost the wider tail lacks may lie before it: the
        // narrow scan inherited it from an earlier scan of this file.
        lastTurnEndedAt: wider.lastTurnEndedAt ?? facts.lastTurnEndedAt,
        costUsd: wider.costUsd ?? facts.costUsd,
        hasMessages: facts.hasMessages,
        lastPromptAt,
        // Searched to the start of the file, or found.
        promptSearched: facts.promptSearched || lastPromptAt !== undefined || start === 0,
      };
      if (complete(result)) return result;
    }
  } finally {
    await handle.close();
  }
  // The whole window is searched: no prompt in it either.
  result = { ...result, promptSearched: true };
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
export function scanTranscript(
  { head, tail }: HeadTail,
  sessionId: string,
  options: { wide?: boolean; known?: { model?: string; tailCwd?: string } } = {},
): TranscriptFacts {
  const facts: TranscriptFacts = {
    hasMessages: MESSAGE_MARKERS.some((marker) => head.includes(marker) || tail.includes(marker)),
  };
  const headCwd = CWD_PATTERN.exec(head)?.[1];
  if (headCwd !== undefined) facts.headCwd = decodeJsonString(headCwd);
  const forkedFrom = FORKED_FROM_PATTERN.exec(head)?.[1];
  if (forkedFrom !== undefined) facts.forkedFrom = forkedFrom;

  const lines = tail.split("\n");
  let costFound = false;
  let turnEndFound = false;
  let messageFound = false;
  let promptFound = false;
  // A wide tail (see scanTranscriptFile) is searched for what the narrow
  // one lacked: the last message, prompt and turn end, and the model and
  // the cwd only when the narrow tail had none (its records can all be cut,
  // e.g. one large tool result), so a long answer is not parsed line by line.
  const wide = options.wide === true;
  let modelFound = wide && options.known?.model !== undefined;
  const searchCwd = !wide || options.known?.tailCwd === undefined;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (!line) continue;
    const isCost = line.includes('"cost-state"');
    const isTurnRecord =
      line.includes('"user"') || line.includes('"assistant"') || line.includes('"system"');
    const hasCwd = searchCwd && facts.tailCwd === undefined && line.includes('"cwd"');
    if (!isCost && !isTurnRecord && !hasCwd) continue;
    // Everything has been found: stop parsing.
    if (costFound && turnEndFound && messageFound && promptFound && modelFound && !hasCwd) break;
    // Once the last message and the turn state are known, only a line that
    // can still tell something is parsed: lines are often large (tool
    // results, long answers), and a long tail has thousands of them.
    if (
      messageFound &&
      facts.turnState !== undefined &&
      !hasCwd &&
      !(isCost && !costFound) &&
      !(!promptFound && mayBePrompt(line)) &&
      !(!modelFound && hasType(line, "assistant")) &&
      !(!turnEndFound && mayEndTurn(line))
    ) {
      continue;
    }
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

function hasType(line: string, type: string): boolean {
  return line.includes(`"type":"${type}"`) || line.includes(`"type": "${type}"`);
}

/** Whether a line may be a user prompt: a user record that is no tool
 *  result, or one that carries an image or a document. */
function mayBePrompt(line: string): boolean {
  if (!hasType(line, "user")) return false;
  return !hasType(line, "tool_result") || hasType(line, "image") || hasType(line, "document");
}

/** Whether a line may end a turn (see {@link turnEffect}). */
function mayEndTurn(line: string): boolean {
  return (
    line.includes('"end_turn"') ||
    line.includes('"isApiErrorMessage"') ||
    line.includes(INTERRUPT_PREFIX) ||
    [...TURN_END_SYSTEM_SUBTYPES].some((subtype) => line.includes(`"${subtype}"`))
  );
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

/** Whether the first record of the transcript is a sidechain one, which the
 *  SDK never lists. */
export function isSidechainTranscript(head: string): boolean {
  const newline = head.indexOf("\n");
  const first = newline >= 0 ? head.slice(0, newline) : head;
  return first.includes('"isSidechain":true') || first.includes('"isSidechain": true');
}

/**
 * The title of a transcript from its own head and tail, in the
 * SDK's order: custom title (tail, the sidecar, head), then
 * {@link generatedTitle}. For a transcript the SDK `getSessionInfo` does not
 * read (another copy of the session comes first in its search).
 */
export function transcriptTitle(
  { head, tail }: HeadTail,
  sidecarTitle?: string,
): string | undefined {
  return (
    lastField(tail, "customTitle") ??
    sidecarTitle ??
    lastField(head, "customTitle") ??
    generatedTitle({ head, tail })
  );
}

/** The title of a transcript without a custom title, in the SDK's order: AI
 *  title, last prompt, summary, first prompt. */
export function generatedTitle({ head, tail }: HeadTail): string | undefined {
  return (
    lastField(tail, "aiTitle") ??
    lastField(head, "aiTitle") ??
    lastField(tail, "lastPrompt") ??
    lastField(tail, "summary") ??
    (firstPrompt(head) || mediaPrompt(head) || undefined)
  );
}

/** The last non-blank top-level string `field` of the records of `text`,
 *  of records of `type` only when given. */
function lastRecordField(text: string, field: string, type?: string): string | undefined {
  const key = `"${field}"`;
  if (!text.includes(key)) return undefined;
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (!line.includes(key)) continue;
    const entry = parseLine(line);
    if (!entry || (type !== undefined && entry.type !== type)) continue;
    const value = entry[field];
    if (typeof value === "string" && value.trim()) return value;
  }
  return undefined;
}

/** The last agent name of `text`: the top-level `agentName` of any record,
 *  which `/rename`, a `rename_session` and AIR write with the custom title,
 *  and which AIR ranks above it. */
export function lastAgentName(text: string): string | undefined {
  return lastRecordField(text, "agentName");
}

/** The last `customTitle` of a `custom-title` record of `text`. */
export function lastCustomTitle(text: string): string | undefined {
  return lastRecordField(text, "customTitle", "custom-title");
}

/**
 * The last agent name of a transcript: in its tail, else, when the tail has
 * a custom title or the head an agent name (the session was named), in the
 * last {@link MAX_TAIL_SIZE} bytes before the tail, else in its head.
 */
export async function transcriptAgentName(
  filePath: string,
  size: number,
  headTail: HeadTail,
): Promise<string | undefined> {
  const inTail = lastAgentName(headTail.tail);
  if (inTail !== undefined) return inTail;
  const inHead = lastAgentName(headTail.head);
  const end = size - Buffer.byteLength(headTail.tail);
  if (end > CHUNK_SIZE && (inHead !== undefined || lastCustomTitle(headTail.tail) !== undefined)) {
    const start = Math.max(0, end - MAX_TAIL_SIZE);
    const handle = await fs.open(filePath, "r");
    try {
      const buffer = Buffer.allocUnsafe(end - start);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
      let text = buffer.toString("utf8", 0, bytesRead);
      if (start > 0) text = text.slice(text.indexOf("\n") + 1);
      const found = lastAgentName(text);
      if (found !== undefined) return found;
    } finally {
      await handle.close();
    }
  }
  return inHead;
}

/**
 * The effective title of a transcript, as AIR ranks the named ones: the
 * last agent name (`agentName`, see {@link transcriptAgentName}), else the
 * last custom title (tail, the sidecar, head), else the title the SDK gives
 * a session without a name ({@link generatedTitle}).
 */
export function effectiveTranscriptTitle(
  headTail: HeadTail,
  agentName: string | undefined,
  sidecarTitle?: string,
): string | undefined {
  return (
    agentName ??
    lastCustomTitle(headTail.tail) ??
    sidecarTitle ??
    lastCustomTitle(headTail.head) ??
    generatedTitle(headTail)
  );
}

/** The time of the last `"timestamp"` in the last 64 KB of a file, cut
 *  line included, epoch ms: a record longer than that still ends with it. */
export async function lastTimestamp(filePath: string, size: number): Promise<number | undefined> {
  const handle = await fs.open(filePath, "r");
  let text: string;
  try {
    const length = Math.min(size, CHUNK_SIZE);
    const buffer = Buffer.allocUnsafe(length);
    const { bytesRead } = await handle.read(buffer, 0, length, size - length);
    text = buffer.toString("utf8", 0, bytesRead);
  } finally {
    await handle.close();
  }
  for (const raw of stringFields(text, "timestamp").reverse()) {
    const value = Date.parse(raw);
    if (!Number.isNaN(value)) return value;
  }
  return undefined;
}

/** Whether the tail carries a custom title of its own. */
export function hasTailCustomTitle(tail: string): boolean {
  return lastCustomTitle(tail) !== undefined;
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
