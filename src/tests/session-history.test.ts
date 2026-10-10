import type { SessionMessage, SessionStoreEntry } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";
import { applyRewindAnchor } from "../session-history.js";
const rows: SessionStoreEntry[] = [
  { type: "user", uuid: "u1", parentUuid: null },
  { type: "assistant", uuid: "a1", parentUuid: "u1" },
  { type: "attachment", uuid: "hidden", parentUuid: "a1" },
  { type: "user", uuid: "u2", parentUuid: "hidden" },
  { type: "assistant", uuid: "a2", parentUuid: "u2" },
];
const messages = rows.filter((r) => r.type !== "attachment") as unknown as SessionMessage[];
const anchor = (leafUuid: string | null) => ({
  type: "last-prompt",
  explicit: true,
  rewound: true,
  leafUuid,
});
describe("native rewind anchor replay", () => {
  it("returns empty for first-message anchor even when SDK returns stale messages", () => {
    expect(applyRewindAnchor(messages, [...rows, anchor(null)])).toEqual([]);
  });
  it("walks parents through hidden chain entries instead of a visible index", () => {
    expect(applyRewindAnchor(messages, [...rows, anchor("hidden")]).map((m) => m.uuid)).toEqual([
      "u1",
      "a1",
    ]);
  });
  it("preserves explicit anchors across non-explicit metadata and sidechains", () => {
    expect(
      applyRewindAnchor(messages, [
        ...rows,
        anchor("a1"),
        { type: "last-prompt", leafUuid: "a1" },
        { type: "user", uuid: "child", parentUuid: "a2", isSidechain: true },
      ]).map((m) => m.uuid),
    ).toEqual(["u1", "a1"]);
  });
  it("uses the SDK active chain after a new prompt follows the anchor", () => {
    const current = [
      messages[0],
      messages[1],
      { type: "user", uuid: "edited", parentUuid: "a1" },
    ] as SessionMessage[];
    expect(
      applyRewindAnchor(current, [
        ...rows,
        anchor("a1"),
        { type: "user", uuid: "edited", parentUuid: "a1" },
      ]),
    ).toEqual(current);
  });
  it("does not reactivate stale log entries or duplicate pre-rewind rows", () => {
    expect(
      applyRewindAnchor(messages, [
        ...rows,
        anchor("a1"),
        rows[4],
        { type: "progress", uuid: "late", parentUuid: "a2" },
        { type: "system", uuid: "late-log", parentUuid: "a2" },
      ]).map((m) => m.uuid),
    ).toEqual(["u1", "a1"]);
    expect(() =>
      applyRewindAnchor(messages, [
        ...rows,
        anchor("a1"),
        { type: "assistant", uuid: "late-answer", parentUuid: "a2" },
      ]),
    ).toThrow("outside");
  });
  it("rejects missing and cyclic chains instead of replaying the deleted suffix", () => {
    expect(() => applyRewindAnchor(messages, [...rows, anchor("absent")])).toThrow("unavailable");
    expect(() =>
      applyRewindAnchor(messages, [
        { type: "user", uuid: "loop", parentUuid: "loop" },
        anchor("loop"),
      ]),
    ).toThrow("Cycle");
  });
});
