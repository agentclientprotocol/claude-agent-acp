import {
  getSessionMessages,
  type SessionMessage,
  type SessionStoreEntry,
} from "@anthropic-ai/claude-agent-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import type { Query } from "@anthropic-ai/claude-agent-sdk";
import { readLocalSessionRows, readSessionHistory } from "../session-history.js";
import { rewindClaudeSession, type SessionRewindDependencies } from "../session-rewind.js";
import {
  prepareRewindPersistence,
  confirmRewindPersistence,
} from "../session-rewind-persistence.js";

vi.mock("../session-history.js", async (original) => ({
  ...(await original<typeof import("../session-history.js")>()),
  readLocalSessionRows: vi.fn(),
  readSessionHistory: vi.fn(),
}));
const sid = "11111111-1111-4111-8111-111111111111";
const rows: SessionStoreEntry[] = [
  { type: "user", uuid: "u1", parentUuid: null },
  { type: "assistant", uuid: "a1", parentUuid: "u1" },
  { type: "attachment", uuid: "hidden", parentUuid: "a1" },
  { type: "user", uuid: "u2", parentUuid: "hidden" },
  { type: "assistant", uuid: "a2", parentUuid: "u2" },
].map((row) => ({
  ...row,
  sessionId: sid,
  timestamp: "2026-10-10T00:00:00.000Z",
  message: { role: row.type, content: row.uuid },
}));
const messages = rows.filter((row) => row.type !== "attachment") as unknown as SessionMessage[];
const anchor = (leafUuid: string | null) => ({
  type: "last-prompt",
  explicit: true,
  rewound: true,
  leafUuid,
});
const metaRows: SessionStoreEntry[] = [
  rows[0],
  { ...rows[0], uuid: "meta", parentUuid: "u1", isMeta: true },
  { ...rows[1], parentUuid: "meta" },
  { ...rows[3], parentUuid: "a1" },
  rows[4],
];
const canonical = (entries: SessionStoreEntry[]) =>
  getSessionMessages(sid, {
    includeSystemMessages: true,
    sessionStore: {
      load: async () => entries,
      append: async () => {
        throw new Error("read-only test store");
      },
    },
  });
async function prepare(target = "u1") {
  const before = await prepareRewindPersistence(sid, messages, target);
  expect(before).toBeDefined();
  return before!;
}
beforeEach(() => {
  // The real SDK history reader yields via setImmediate; only fake our deadline/poll timers.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  vi.mocked(readLocalSessionRows).mockReset().mockResolvedValue(rows);
});
afterEach(() => vi.useRealTimers());

describe("native rewind persistence confirmation", () => {
  it("accepts hidden isMeta ancestry using actual SDK-visible history on both sides", async () => {
    const visible = await canonical(metaRows);
    expect(visible.map((message) => message.uuid)).toEqual(["u1", "a1", "u2", "a2"]);
    vi.mocked(readLocalSessionRows).mockResolvedValue(metaRows);
    const before = await prepareRewindPersistence(sid, visible, "u2");
    expect(before?.retained).toEqual(["u1", "a1"]);
    vi.mocked(readLocalSessionRows).mockResolvedValue([...metaRows, anchor("a1")]);
    await expect(confirmRewindPersistence(before!, () => {})).resolves.toBeUndefined();
  });
  it.each(["user", "assistant"])(
    "still rejects a new visible %s append through a hidden parent",
    async (type) => {
      const visible = await canonical(metaRows);
      vi.mocked(readLocalSessionRows).mockResolvedValue(metaRows);
      const before = await prepareRewindPersistence(sid, visible, "u2");
      vi.mocked(readLocalSessionRows).mockResolvedValue([
        ...metaRows,
        anchor("a1"),
        { ...rows[0], uuid: "new-meta", parentUuid: "a1", isMeta: true },
        {
          ...rows[0],
          type,
          uuid: "unexpected",
          parentUuid: "new-meta",
          message: { role: type, content: "visible new branch" },
        },
      ]);
      await expect(confirmRewindPersistence(before!, () => {})).rejects.toThrow("prefix diverged");
    },
  );
  it("commits a correct meta-containing rewind through the real production guard", async () => {
    vi.mocked(readSessionHistory).mockResolvedValue(await canonical(metaRows));
    vi.mocked(readLocalSessionRows).mockResolvedValue(metaRows);
    const request = vi.fn(async () => {
      vi.mocked(readLocalSessionRows).mockResolvedValue([...metaRows, anchor("a1")]);
      return { response: { rewound: true, targetMessageUuid: "u2" } };
    });
    const session = { query: { request } as unknown as Query, turnQueue: [] };
    const deps: SessionRewindDependencies = {
      getSession: () => session,
      cancel: vi.fn(),
      invalidate: vi.fn(),
      committed: vi.fn(),
      messageIdForGrouping: (message) => message.uuid,
    };
    const point = (id: string) => ({
      messageId: id,
      messageFingerprint: "sha256:" + createHash("sha256").update(id).digest("hex"),
      messageOccurrence: 1,
    });
    await expect(
      rewindClaudeSession(
        { sessionId: sid, beforeMessage: point("u2"), resumeAtMessage: point("a1") },
        deps,
      ),
    ).resolves.toEqual({ rewound: true, sessionId: sid });
    expect(request).toHaveBeenCalledOnce();
    expect(deps.committed).toHaveBeenCalledOnce();
    expect(deps.invalidate).not.toHaveBeenCalled();
  });
  it("waits for the delayed first-message anchor despite a successful native ACK", async () => {
    const before = await prepare();
    let done = false;
    const assertCurrent = vi.fn();
    const pending = confirmRewindPersistence(before, assertCurrent).then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(100);
    expect(done).toBe(false);
    vi.mocked(readLocalSessionRows).mockResolvedValue([...rows, anchor(null)]);
    await vi.advanceTimersByTimeAsync(20);
    await pending;
    expect(done).toBe(true);
    expect(assertCurrent).toHaveBeenCalled();
  });
  it("checks historical prefix through hidden parents and ignores duplicate flushes", async () => {
    const before = await prepare("u2");
    vi.mocked(readLocalSessionRows).mockResolvedValue([...rows, anchor("hidden"), rows[4]]);
    await expect(confirmRewindPersistence(before, () => {})).resolves.toBeUndefined();
  });
  it("does not accept an old matching anchor as evidence of a new mutation", async () => {
    vi.mocked(readLocalSessionRows).mockResolvedValue([...rows, anchor(null)]);
    const before = await prepare();
    const pending = expect(confirmRewindPersistence(before, () => {}, 50)).rejects.toThrow(
      "timed out",
    );
    await vi.advanceTimersByTimeAsync(50);
    await pending;
  });
  it.each(["missing", "hung read"])(
    "bounds %s persistence without accepting late completion",
    async (mode) => {
      const before = await prepare();
      const deferred = Promise.withResolvers<SessionStoreEntry[]>();
      if (mode === "hung read") vi.mocked(readLocalSessionRows).mockReturnValue(deferred.promise);
      const pending = expect(confirmRewindPersistence(before, () => {}, 50)).rejects.toThrow(
        "timed out",
      );
      await vi.advanceTimersByTimeAsync(50);
      await pending;
      const count = vi.mocked(readLocalSessionRows).mock.calls.length;
      deferred.resolve([...rows, anchor(null)]);
      await vi.advanceTimersByTimeAsync(100);
      expect(readLocalSessionRows).toHaveBeenCalledTimes(count);
    },
  );
  it.each([
    [anchor("a1")],
    [
      anchor(null),
      {
        ...rows[0],
        uuid: "other",
        parentUuid: null,
        message: { role: "user", content: "unexpected" },
      },
    ],
    [anchor("missing")],
    [{ ...anchor(null), rewound: false }],
    [{ type: "last-prompt", explicit: true, rewound: true }],
  ])("rejects divergent or malformed persisted state (%#)", async (...suffix) => {
    const before = await prepare();
    vi.mocked(readLocalSessionRows).mockResolvedValue([...rows, ...suffix]);
    await expect(confirmRewindPersistence(before, () => {})).rejects.toThrow();
  });
  it("rejects a replaced anchor watermark", async () => {
    vi.mocked(readLocalSessionRows).mockResolvedValue([...rows, anchor("a2")]);
    const before = await prepare();
    vi.mocked(readLocalSessionRows).mockResolvedValue([...rows, anchor(null)]);
    await expect(confirmRewindPersistence(before, () => {})).rejects.toThrow("outside");
  });
  it("propagates read failures and checks ownership again after a pending read", async () => {
    const before = await prepare();
    vi.mocked(readLocalSessionRows).mockRejectedValue(new Error("disk read failed"));
    await expect(confirmRewindPersistence(before, () => {})).rejects.toThrow("disk read failed");
    vi.mocked(readLocalSessionRows).mockResolvedValue([...rows, anchor(null)]);
    const ownership = vi
      .fn()
      .mockImplementationOnce(() => {})
      .mockImplementation(() => {
        throw new Error("closed");
      });
    await expect(confirmRewindPersistence(before, ownership)).rejects.toThrow("closed");
  });
  it("refuses fileless or unavailable target storage before mutation", async () => {
    vi.mocked(readLocalSessionRows).mockResolvedValue(undefined);
    expect(await prepareRewindPersistence(sid, messages, "u1")).toBeUndefined();
    vi.mocked(readLocalSessionRows).mockResolvedValue([]);
    expect(await prepareRewindPersistence(sid, messages, "u1")).toBeUndefined();
  });
});
