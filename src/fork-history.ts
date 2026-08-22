import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

/** The durable relationship between a fork and the transcript it inherited. */
export type ForkLineage = {
  version: 1;
  sessionId: string;
  parentSessionId: string;
  /** The final inherited transcript entry, if the fork has a branch point. */
  branchPoint?: string;
};

/**
 * The Claude session to resume when creating a fork. A newborn fork has no
 * Claude transcript of its own yet, so its id cannot be resumed directly.
 */
export type ForkResumeTarget = {
  sessionId: string;
  branchPoint?: string;
};

/**
 * The persisted Claude session and SDK message uuid to use for a point fork.
 * `branchPoint` itself remains the client-visible message id so the display
 * transcript can still be reconstructed independently of Claude's SDK ids.
 */
export type ForkPointResumeTarget = {
  sessionId: string;
  messageUuid: string;
};

/**
 * Stores one file per fork. Separate files make concurrent ACP processes safe:
 * a new fork never needs to rewrite another process's lineage record.
 */
export class ForkHistoryStore {
  constructor(private readonly directory: string) {}

  async record(lineage: Omit<ForkLineage, "version">): Promise<void> {
    await fs.mkdir(this.directory, { recursive: true });
    const destination = this.fileFor(lineage.sessionId);
    const temporary = path.join(
      this.directory,
      `.${path.basename(destination)}.${randomUUID()}.tmp`,
    );
    const contents = JSON.stringify({ version: 1, ...lineage } satisfies ForkLineage) + "\n";

    try {
      await fs.writeFile(temporary, contents, { encoding: "utf8", mode: 0o600 });
      await fs.rename(temporary, destination);
    } finally {
      await fs.rm(temporary, { force: true }).catch(() => {});
    }
  }

  async read(sessionId: string): Promise<ForkLineage | undefined> {
    let contents: string;
    try {
      contents = await fs.readFile(this.fileFor(sessionId), "utf8");
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw error;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(contents);
    } catch {
      return undefined;
    }
    if (!isForkLineage(parsed) || parsed.sessionId !== sessionId) return undefined;
    return parsed;
  }

  async remove(sessionId: string): Promise<void> {
    await fs.rm(this.fileFor(sessionId), { force: true });
  }

  private fileFor(sessionId: string): string {
    const digest = createHash("sha256").update(sessionId).digest("hex");
    return path.join(this.directory, `${digest}.json`);
  }
}

/**
 * Reconstructs the display transcript of a fork. Claude keeps only the new
 * branch's entries under the new session id, so a reload must prepend the
 * inherited prefix itself. The result is also correct for nested forks.
 */
export async function forkedSessionHistory<Message>(
  sessionId: string,
  store: ForkHistoryStore,
  readMessages: (sessionId: string) => Promise<Message[]>,
  messageId: (message: Message) => string | undefined,
): Promise<Message[]> {
  return historyFor(sessionId, store, readMessages, messageId, new Set());
}

/**
 * Resolves an empty fork back to the closest session Claude can actually
 * resume. The returned boundary keeps the model context identical to the
 * inherited display transcript, including through several empty forks.
 */
export async function forkResumeTarget<Message>(
  sessionId: string,
  store: ForkHistoryStore,
  readMessages: (sessionId: string) => Promise<Message[]>,
): Promise<ForkResumeTarget> {
  return resumeTargetFor(sessionId, store, readMessages, new Set());
}

/**
 * Resolves a client-visible fork boundary to the session which owns it and to
 * the SDK uuid Claude expects in `resumeSessionAt`. A visible fork transcript
 * can contain inherited messages, so looking only in the immediate session is
 * insufficient: Claude cannot resume that session at a parent message id.
 */
export async function forkPointResumeTarget<Message>(
  sessionId: string,
  branchPoint: string,
  store: ForkHistoryStore,
  readMessages: (sessionId: string) => Promise<Message[]>,
  messageId: (message: Message) => string | undefined,
  messageUuid: (message: Message) => string | undefined,
): Promise<ForkPointResumeTarget> {
  return pointResumeTargetFor(
    sessionId,
    branchPoint,
    store,
    readMessages,
    messageId,
    messageUuid,
    new Set(),
  );
}

async function historyFor<Message>(
  sessionId: string,
  store: ForkHistoryStore,
  readMessages: (sessionId: string) => Promise<Message[]>,
  messageId: (message: Message) => string | undefined,
  visiting: Set<string>,
): Promise<Message[]> {
  if (visiting.has(sessionId)) {
    throw new Error(`Fork lineage contains a cycle at session ${sessionId}`);
  }
  visiting.add(sessionId);
  try {
    const [lineage, ownMessages] = await Promise.all([
      store.read(sessionId),
      readMessages(sessionId),
    ]);
    if (!lineage) return ownMessages;

    const inherited = await historyFor(
      lineage.parentSessionId,
      store,
      readMessages,
      messageId,
      visiting,
    );
    const prefix = lineage.branchPoint
      ? inheritedThrough(inherited, lineage.branchPoint, messageId, sessionId)
      : inherited;
    return [...prefix, ...ownMessages];
  } finally {
    visiting.delete(sessionId);
  }
}

async function resumeTargetFor<Message>(
  sessionId: string,
  store: ForkHistoryStore,
  readMessages: (sessionId: string) => Promise<Message[]>,
  visiting: Set<string>,
): Promise<ForkResumeTarget> {
  if (visiting.has(sessionId)) {
    throw new Error(`Fork lineage contains a cycle at session ${sessionId}`);
  }
  visiting.add(sessionId);
  try {
    const [lineage, ownMessages] = await Promise.all([
      store.read(sessionId),
      readMessages(sessionId),
    ]);

    if (!lineage || ownMessages.length > 0) return { sessionId };

    const inherited = await resumeTargetFor(lineage.parentSessionId, store, readMessages, visiting);
    return lineage.branchPoint ? { ...inherited, branchPoint: lineage.branchPoint } : inherited;
  } finally {
    visiting.delete(sessionId);
  }
}

async function pointResumeTargetFor<Message>(
  sessionId: string,
  branchPoint: string,
  store: ForkHistoryStore,
  readMessages: (sessionId: string) => Promise<Message[]>,
  messageId: (message: Message) => string | undefined,
  messageUuid: (message: Message) => string | undefined,
  visiting: Set<string>,
): Promise<ForkPointResumeTarget> {
  if (visiting.has(sessionId)) {
    throw new Error(`Fork lineage contains a cycle at session ${sessionId}`);
  }
  visiting.add(sessionId);
  try {
    const [lineage, ownMessages] = await Promise.all([
      store.read(sessionId),
      readMessages(sessionId),
    ]);

    // A single Claude turn can yield several persisted records with the same
    // ACP grouping id. Last-write-wins matches the adapter's live/replay map
    // and selects the final, resumable record for that turn.
    let matchingMessage: Message | undefined;
    for (const message of ownMessages) {
      if (messageId(message) === branchPoint) matchingMessage = message;
    }
    if (matchingMessage) {
      const uuid = messageUuid(matchingMessage);
      if (!uuid) {
        throw new Error(
          `Fork boundary ${branchPoint} in session ${sessionId} has no SDK message uuid`,
        );
      }
      return { sessionId, messageUuid: uuid };
    }

    if (!lineage) {
      throw new Error(
        `Fork boundary ${branchPoint} is absent from session ${sessionId} and its ancestors`,
      );
    }
    return pointResumeTargetFor(
      lineage.parentSessionId,
      branchPoint,
      store,
      readMessages,
      messageId,
      messageUuid,
      visiting,
    );
  } finally {
    visiting.delete(sessionId);
  }
}

function inheritedThrough<Message>(
  messages: Message[],
  branchPoint: string,
  messageId: (message: Message) => string | undefined,
  sessionId: string,
): Message[] {
  // One completed assistant turn can be persisted as several records sharing
  // its ACP grouping id (thinking, tool calls, then its final text). The fork
  // boundary is after that turn, so retain every matching record rather than
  // stopping at the first one.
  let boundary = -1;
  for (let index = 0; index < messages.length; index += 1) {
    if (messageId(messages[index]) === branchPoint) boundary = index;
  }
  if (boundary < 0) {
    throw new Error(
      `Fork ${sessionId} refers to message ${branchPoint}, which is absent from its parent history`,
    );
  }
  return messages.slice(0, boundary + 1);
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function isForkLineage(value: unknown): value is ForkLineage {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    record.version === 1 &&
    typeof record.sessionId === "string" &&
    typeof record.parentSessionId === "string" &&
    (record.branchPoint === undefined || typeof record.branchPoint === "string")
  );
}
