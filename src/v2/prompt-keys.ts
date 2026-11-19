/**
 * The `idempotencyKey`s of one session's prompts (ACP v2 `session/prompt`).
 *
 * A client that lost a prompt's response sends the prompt again with the same
 * key. The session then inserts at most one user message for the key:
 *
 * - A prompt with the key that is not answered yet: the retry gets that
 *   prompt's outcome, and nothing more goes to Claude Code.
 * - A message inserted with the key: the retry gets its `messageId`.
 * - A prompt with the key that failed: the key is unused, and the retry is a
 *   new prompt.
 *
 * The key is stored as the message's id. A keyed prompt goes to Claude Code
 * with a uuid whose first 32 characters are a hash of the session id and the
 * key, and whose last 4 hex digits count the attempts. Claude Code keeps that
 * uuid in the transcript (`getSessionMessages` returns it, also for a prompt
 * that waited in its queue or that it folded into a running turn), so a key
 * is recognized for as long as its message is stored, across connections and
 * restarts, and no client sees the key: only its hash is in the `messageId`.
 * The session id is part of the hash, so the same key in another session, a
 * fork too, names another prompt.
 *
 * Each attempt has its own uuid because Claude Code ignores a prompt whose
 * uuid it has seen: it echoes it and starts no turn. A prompt that a
 * `session/cancel` answered with -32800 may have reached Claude Code, so the
 * next attempt must not reuse its uuid.
 *
 * A message that Claude Code does not store, such as a local command's, is
 * recognized while this record lives: the agent keeps one per session from
 * its start to `session/close` or the end of the connection, across restarts
 * of the session's query.
 */
import { createHash, type randomUUID } from "node:crypto";
import type * as v2 from "@agentclientprotocol/sdk/experimental/v2/unstable";
import type { Logger } from "../logger.js";

type UUID = ReturnType<typeof randomUUID>;

/** One attempt to insert the prompt of a key. */
export interface KeyedAttempt {
  /** The uuid that the prompt goes to Claude Code with, and its `messageId` once inserted. */
  uuid: UUID;
  /**
   * The `messageId` of the message that the session's stored history holds
   * for the key, or undefined for none. Absent when the history cannot hold
   * one: a session that this connection created has only the messages of
   * this record.
   */
  stored?: () => Promise<string | undefined>;
}

type KeyRecord = {
  /** The attempts so far. The next one's uuid ends in this number. */
  attempts: number;
  /** The attempt that is not answered yet. */
  pending?: Promise<v2.PromptResponse>;
  /** The message inserted with the key. */
  messageId?: string;
};

/** The characters of a keyed uuid that count its attempts: its last 4 hex digits. */
const ATTEMPT_DIGITS = 4;

export class PromptKeys {
  /** The keys seen on this connection, by the uuid prefix of their attempts. */
  private readonly keys = new Map<string, KeyRecord>();
  /** Whether the session's stored history can hold a message of an earlier connection. */
  private resumed = false;
  /** The stored history's keyed messages, by uuid prefix, once read. */
  private stored: Promise<ReadonlyMap<string, string>> | undefined;

  constructor(
    private readonly sessionId: string,
    /** The uuids of the user messages in the session's stored history, oldest first. */
    private readonly readStored: () => Promise<Iterable<string>>,
    private readonly logger: Logger,
  ) {}

  /**
   * A query of the session started. `resumed`: from a stored conversation,
   * which can hold messages that this record does not know, so the next
   * lookup reads the history again.
   */
  queryStarted(resumed: boolean): void {
    if (!resumed) return;
    this.resumed = true;
    this.stored = undefined;
  }

  /**
   * The response of a prompt with `key`: of the attempt that is not answered
   * yet, of the message inserted with the key, or of `submit`, which inserts
   * the prompt. `submit` runs at most once at a time for a key, and not at
   * all once a message is inserted with it. Its promise is returned as it
   * is.
   */
  once(
    key: string,
    submit: (attempt: KeyedAttempt) => Promise<v2.PromptResponse>,
  ): Promise<v2.PromptResponse> {
    const prefix = keyedPrefix(this.sessionId, key);
    let record = this.keys.get(prefix);
    if (!record) this.keys.set(prefix, (record = { attempts: 0 }));
    if (record.messageId !== undefined) return Promise.resolve({ messageId: record.messageId });
    if (record.pending) return record.pending;
    const known = record;
    const attempt = (known.attempts++ % 16 ** ATTEMPT_DIGITS)
      .toString(16)
      .padStart(ATTEMPT_DIGITS, "0");
    const response = submit({
      uuid: `${prefix}${attempt}` as UUID,
      ...(this.resumed ? { stored: () => this.storedMessage(prefix) } : {}),
    });
    known.pending = response;
    response.then(
      ({ messageId }) => {
        known.pending = undefined;
        known.messageId = messageId;
      },
      // An error leaves the key unused: the next prompt with it is a new attempt.
      () => {
        known.pending = undefined;
      },
    );
    return response;
  }

  /**
   * The `messageId` that the stored history holds for the uuid prefix of a
   * key. The history is read once per started query. When reading it fails,
   * the key counts as unused, so the session stays usable, and the next
   * lookup reads again.
   */
  private async storedMessage(prefix: string): Promise<string | undefined> {
    if (!this.stored) {
      const read: Promise<ReadonlyMap<string, string>> = this.readStored().then(
        (uuids) => {
          const messages = new Map<string, string>();
          // A later attempt's message replaces an earlier one's: only the last attempt was answered.
          for (const uuid of uuids) messages.set(uuid.slice(0, -ATTEMPT_DIGITS), uuid);
          return messages;
        },
        (error: unknown) => {
          this.logger.error(
            `Session ${this.sessionId}: failed to read its history for an idempotencyKey`,
            error,
          );
          if (this.stored === read) this.stored = undefined;
          return new Map<string, string>();
        },
      );
      this.stored = read;
    }
    return (await this.stored).get(prefix);
  }
}

/**
 * The first 32 characters of the uuids of the prompt `key` of the session
 * `sessionId`: a version 8 (custom) UUID of the SHA-256 hash of both, without
 * its last 4 hex digits.
 */
function keyedPrefix(sessionId: string, key: string): string {
  const hex = createHash("sha256").update(`${sessionId}\n${key}`).digest("hex");
  // The variant bits of RFC 9562: `10`.
  const variant = ((parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `8${hex.slice(13, 16)}`,
    `${variant}${hex.slice(17, 20)}`,
    hex.slice(20, 28),
  ].join("-");
}
