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

function inheritedThrough<Message>(
  messages: Message[],
  branchPoint: string,
  messageId: (message: Message) => string | undefined,
  sessionId: string,
): Message[] {
  const boundary = messages.findIndex((message) => messageId(message) === branchPoint);
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
