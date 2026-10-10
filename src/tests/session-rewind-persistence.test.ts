import type { SessionMessage, SessionStoreEntry } from "@anthropic-ai/claude-agent-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readLocalSessionRows } from "../session-history.js";
import {
  prepareRewindPersistence,
  confirmRewindPersistence,
} from "../session-rewind-persistence.js";

vi.mock("../session-history.js", async (original) => ({
  ...(await original<typeof import("../session-history.js")>()),
  readLocalSessionRows: vi.fn(),
}));
const rows: SessionStoreEntry[] = [
  { type: "user", uuid: "u1", parentUuid: null },
  { type: "assistant", uuid: "a1", parentUuid: "u1" },
  { type: "attachment", uuid: "hidden", parentUuid: "a1" },
  { type: "user", uuid: "u2", parentUuid: "hidden" },
  { type: "assistant", uuid: "a2", parentUuid: "u2" },
];
const messages = rows.filter((row) => row.type !== "attachment") as unknown as SessionMessage[];
const anchor = (leafUuid: string | null) => ({
  type: "last-prompt",
  explicit: true,
  rewound: true,
  leafUuid,
});
async function prepare(target = "u1") {
  const before = await prepareRewindPersistence("sid", messages, target);
  expect(before).toBeDefined();
  return before!;
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(readLocalSessionRows).mockReset().mockResolvedValue(rows);
});
afterEach(() => vi.useRealTimers());

describe("native rewind persistence confirmation", () => {
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
    [anchor(null), { type: "user", uuid: "other", parentUuid: null }],
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
    expect(await prepareRewindPersistence("sid", messages, "u1")).toBeUndefined();
    vi.mocked(readLocalSessionRows).mockResolvedValue([]);
    expect(await prepareRewindPersistence("sid", messages, "u1")).toBeUndefined();
  });
});
