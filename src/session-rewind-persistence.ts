import {
  getSessionMessages,
  type SessionMessage,
  type SessionStoreEntry,
} from "@anthropic-ai/claude-agent-sdk";
import { applyRewindAnchor, readLocalSessionRows } from "./session-history.js";
import { NativeRewindUncertain } from "./native-rewind-control.js";

type RewindPersistence = { sessionId: string; anchors: string[]; retained: string[] };

function main(row: SessionStoreEntry): boolean {
  return !row.isSidechain && row.parent_tool_use_id == null && row.parent_agent_id == null;
}
function anchors(rows: SessionStoreEntry[]): SessionStoreEntry[] {
  return rows.filter((row) => main(row) && row.type === "last-prompt" && row.explicit === true);
}
function conversation(row: { type: string }): boolean {
  return row.type === "user" || row.type === "assistant";
}

/** Establish a before-mutation watermark so an old matching anchor is not proof
 * of this mutation. Fileless sessions cannot offer this local durability contract. */
export async function prepareRewindPersistence(
  sessionId: string,
  messages: SessionMessage[],
  targetUuid: string,
): Promise<RewindPersistence | undefined> {
  const rows = await readLocalSessionRows(sessionId);
  const index = messages.findIndex((message) => message.uuid === targetUuid);
  if (!rows || index < 0 || !rows.some((row) => main(row) && row.uuid === targetUuid))
    return undefined;
  return {
    sessionId,
    anchors: anchors(rows).map((row) => JSON.stringify(row)),
    retained: messages
      .slice(0, index)
      .filter(conversation)
      .map((message) => message.uuid),
  };
}

/** The pinned CLI ACKs after enqueueing the local anchor, not after flushing it.
 * Keep the caller's mutation reservation until a NEW native anchor and the exact
 * retained conversation are readable on disk. Never retry the control or write
 * the transcript. This is cold-read visibility, not an fsync/power-loss guarantee. */
export async function confirmRewindPersistence(
  before: RewindPersistence,
  assertCurrent: () => void,
  timeoutMs = 5_000,
): Promise<void> {
  let expired = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const uncertain = (reason: string) =>
    new NativeRewindUncertain(`Rewind persistence ${reason}; reload required`);
  try {
    await Promise.race([
      (async () => {
        while (!expired) {
          assertCurrent();
          const rows = await readLocalSessionRows(before.sessionId);
          if (expired) return;
          assertCurrent();
          if (!rows) throw uncertain("unavailable");
          const current = anchors(rows);
          if (before.anchors.some((anchor, i) => JSON.stringify(current[i]) !== anchor))
            throw uncertain("changed outside the reserved mutation");
          if (current.length > before.anchors.length) {
            const latest = current.at(-1)!;
            if (
              latest.rewound !== true ||
              (latest.leafUuid !== null && typeof latest.leafUuid !== "string")
            )
              throw uncertain("has no rewind anchor");
            // Resolve the CURRENT raw retained chain first, keeping hidden rows
            // as parents. Do not intersect with old SDK-visible UUIDs: a new
            // appended branch must remain in the snapshot being verified.
            const unique = new Map<string, SessionStoreEntry>();
            for (const row of rows) if (main(row) && row.uuid) unique.set(row.uuid, row);
            const chain = new Set(
              applyRewindAnchor([...unique.values()] as unknown as SessionMessage[], rows).map(
                (message) => message.uuid,
              ),
            );
            // Normalize this one disk snapshot with the same pinned SDK reader
            // as the expected history. Raw isMeta/tool/system visibility is not
            // equivalent to testing type=user|assistant. Metadata without UUIDs
            // remains available to the SDK's delivery/visibility classification.
            const visible = await getSessionMessages(before.sessionId, {
              includeSystemMessages: true,
              sessionStore: {
                load: async () => rows.filter((row) => !row.uuid || chain.has(row.uuid)),
                append: async () => {
                  throw uncertain("reader attempted a write");
                },
              },
            });
            if (expired) return;
            assertCurrent();
            const retained = visible.filter(conversation).map((message) => message.uuid);
            if (
              retained.length !== before.retained.length ||
              retained.some((uuid, i) => uuid !== before.retained[i])
            )
              throw uncertain("retained prefix diverged");
            return;
          }
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      })(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          expired = true;
          reject(uncertain("confirmation timed out"));
        }, timeoutMs);
      }),
    ]);
  } finally {
    expired = true;
    clearTimeout(timer);
  }
}
