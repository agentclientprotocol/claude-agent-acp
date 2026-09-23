import { describe, expect, it, vi } from "vitest";
import type { SessionNotification } from "@agentclientprotocol/sdk";
import {
  ContextCompactionLifecycle,
  clientSupportsCompactionUpdates,
  compactionSummaryText,
  isCompactSummaryMessage,
} from "../context-compaction.js";

const PERSISTED_SUMMARY =
  "This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.\n\n" +
  "Summary:\n1. Primary Request and Intent:\n   Count upward.\n\n2. Optional Next Step:\n   None.\n\n" +
  "If you need specific details from before compaction (like exact code snippets, error messages, or content you generated), read the full transcript at: /tmp/session.jsonl\n" +
  "Continue the conversation from where it left off without asking the user any further questions. Resume directly — do not acknowledge the summary, do not recap what was happening.";

/** A lifecycle for an AIR client, which gets the compaction facts, unless `airClient` is false. */
function lifecycle(
  presentation: "tool_call" | "compaction_update",
  sendUpdate?: (notification: SessionNotification) => Promise<void>,
  airClient = true,
) {
  const sent: SessionNotification["update"][] = [];
  const logError = vi.fn();
  const compaction = new ContextCompactionLifecycle(
    sendUpdate ??
      (async (notification) => {
        sent.push(notification.update);
      }),
    { sessionId: "s", presentation, logError, airClient },
  );
  return { sent, compaction, logError };
}

describe("ContextCompactionLifecycle for a client that is not AIR", () => {
  it("sends the upstream tool call fields and no AIR key", async () => {
    const { sent, compaction } = lifecycle("tool_call", undefined, false);
    await compaction.start("c");
    await compaction.finish("c", "completed", { trigger: "manual", preTokens: 10 });
    expect(sent).toEqual([
      {
        sessionUpdate: "tool_call",
        toolCallId: "c",
        title: "Compact conversation",
        kind: "think",
        status: "in_progress",
        _meta: { claudeCode: { toolName: "compact" } },
      },
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "c",
        status: "completed",
        rawOutput: { trigger: "manual", preTokens: 10 },
        _meta: { claudeCode: { toolName: "compact" } },
      },
    ]);
  });

  it("sends compaction updates without _meta, and a summary that differs from the chunks", async () => {
    const { sent, compaction } = lifecycle("compaction_update", undefined, false);
    await compaction.start("c");
    await compaction.heartbeat("c", "Part");
    compaction.recordSummary("<summary>\nThe whole summary\n</summary>");
    await compaction.finish("c", "completed", { trigger: "manual" });
    expect(sent).toEqual([
      { sessionUpdate: "compaction_update", compactionId: "c", status: "in_progress" },
      {
        sessionUpdate: "compaction_summary_chunk",
        compactionId: "c",
        content: { type: "text", text: "Part" },
      },
      {
        sessionUpdate: "compaction_update",
        compactionId: "c",
        status: "completed",
        summary: [{ type: "text", text: "The whole summary" }],
      },
    ]);
  });
});

describe("clientSupportsCompactionUpdates", () => {
  it("requires the v1 session.compaction object", () => {
    expect(clientSupportsCompactionUpdates({ session: { compaction: {} } })).toBe(true);
    expect(clientSupportsCompactionUpdates({ session: { compaction: { extra: true } } })).toBe(
      true,
    );
    expect(clientSupportsCompactionUpdates({ session: { compaction: null } })).toBe(false);
    expect(clientSupportsCompactionUpdates({ session: null })).toBe(false);
    expect(clientSupportsCompactionUpdates({ session: {} })).toBe(false);
    expect(clientSupportsCompactionUpdates({})).toBe(false);
    expect(clientSupportsCompactionUpdates(undefined)).toBe(false);
    expect(clientSupportsCompactionUpdates(null)).toBe(false);
  });
});

describe("compactionSummaryText", () => {
  it("keeps only the <summary> body of the hook's raw model output", () => {
    expect(
      compactionSummaryText(
        "<analysis>\nThinking about it.\n</analysis>\n\n<summary>\n## Retained\n\nThe user counted.\n</summary>",
      ),
    ).toBe("## Retained\n\nThe user counted.");
  });

  it("is not fooled by tag names quoted inside the analysis or the summary", () => {
    expect(
      compactionSummaryText(
        "<analysis>\nThe user asked for an <analysis> block followed by a <summary> block.\n</analysis>\n\n" +
          "<summary>\n1. Intent:\n   Produce an `<analysis>` and a `<summary>` block, then </summary> nothing.\n</summary>\n",
      ),
    ).toBe(
      "1. Intent:\n   Produce an `<analysis>` and a `<summary>` block, then </summary> nothing.",
    );
  });

  it("takes the widest inline span and stays linear without a closing tag", () => {
    expect(compactionSummaryText("<summary>Inline </summary> quoted.</summary>")).toBe(
      "Inline </summary> quoted.",
    );
    const unterminated = "<summary> mention ".repeat(5000);
    const started = performance.now();
    expect(compactionSummaryText(unterminated)).toBe(unterminated.trim());
    expect(performance.now() - started).toBeLessThan(200);
  });

  it("strips the persisted continuation framing", () => {
    expect(compactionSummaryText(PERSISTED_SUMMARY)).toBe(
      "1. Primary Request and Intent:\n   Count upward.\n\n2. Optional Next Step:\n   None.",
    );
  });

  it("strips the older tagged transcript framing", () => {
    expect(
      compactionSummaryText(
        "This session is being continued from a previous conversation that ran out of context. The conversation is summarized below:\n<summary>\nOld style body.\n</summary>\nPlease continue the conversation from where it left it off without asking the user any further questions.",
      ),
    ).toBe("Old style body.");
  });

  it("fails closed on a continuation prompt whose framing it does not recognize", () => {
    expect(
      compactionSummaryText(
        "This session is being continued from a previous conversation that ran out of context. Here is what happened:\n\nThe user counted.\n\nResume directly.",
      ),
    ).toBeUndefined();
  });

  it("strips a leading analysis block even when the summary tags are missing", () => {
    expect(
      compactionSummaryText(
        "<analysis>\nPrivate reasoning about <summary> tags.\n</analysis>\n\n1. Primary Request:\n   Count.",
      ),
    ).toBe("1. Primary Request:\n   Count.");
    expect(compactionSummaryText("<analysis>inline</analysis> Body.")).toBe("Body.");
    // A body quoting both tag names inline is not an analysis block.
    expect(compactionSummaryText("Body mentions <analysis> and </analysis> inline.")).toBe(
      "Body mentions <analysis> and </analysis> inline.",
    );
  });

  it("does not let a <summary> mention inside an inline analysis anchor the span", () => {
    expect(
      compactionSummaryText(
        "<analysis>Wants a <summary> block.</analysis> <summary>Real body.</summary>",
      ),
    ).toBe("Real body.");
  });

  it("passes plain text through and drops empty summaries", () => {
    expect(compactionSummaryText("  Just a summary.  ")).toBe("Just a summary.");
    expect(compactionSummaryText("")).toBeUndefined();
    expect(compactionSummaryText("<summary>   </summary>")).toBeUndefined();
  });
});

describe("isCompactSummaryMessage", () => {
  it("matches only user messages flagged by Claude Code", () => {
    expect(isCompactSummaryMessage({ type: "user", isCompactSummary: true })).toBe(true);
    expect(isCompactSummaryMessage({ type: "user" })).toBe(false);
    expect(isCompactSummaryMessage({ type: "assistant", isCompactSummary: true })).toBe(false);
    expect(isCompactSummaryMessage(null)).toBe(false);
  });
});

describe("ContextCompactionLifecycle (compaction_update)", () => {
  it("opens in_progress, carries the hook summary on the terminal update, then enriches from the boundary", async () => {
    const { sent, compaction } = lifecycle("compaction_update");

    await compaction.start("cmp-1");
    compaction.recordSummary("<analysis>x</analysis><summary>\nRetained.\n</summary>");
    await compaction.finish("cmp-status", "completed");
    await compaction.finish(
      "cmp-boundary",
      "completed",
      { trigger: "manual", preTokens: 100, postTokens: 10, durationMs: 5 },
      true,
    );
    // A duplicated terminal status neither re-sends nor clears the metadata.
    await compaction.finish("cmp-status-dup", "completed");

    expect(sent).toEqual([
      {
        sessionUpdate: "compaction_update",
        compactionId: "cmp-1",
        status: "in_progress",
        _meta: { jetbrains: { air: { version: 1, contextCompaction: { version: 1 } } } },
      },
      {
        sessionUpdate: "compaction_update",
        compactionId: "cmp-1",
        status: "completed",
        summary: [{ type: "text", text: "Retained." }],
        _meta: { jetbrains: { air: { version: 1, contextCompaction: { version: 1 } } } },
      },
      {
        sessionUpdate: "compaction_update",
        compactionId: "cmp-1",
        status: "completed",
        _meta: {
          jetbrains: {
            air: {
              version: 1,
              contextCompaction: {
                version: 1,
                trigger: "manual",
                preTokens: 100,
                postTokens: 10,
                durationMs: 5,
              },
            },
          },
        },
      },
    ]);
    expect(compaction.hasDeliveredOutput).toBe(true);
  });

  it("holds a summary recorded before the opening status and attaches it once", async () => {
    const { sent, compaction } = lifecycle("compaction_update");

    compaction.recordSummary("<summary>Early.</summary>");
    expect(sent).toEqual([]);
    await compaction.start("cmp-1");
    await compaction.finish("cmp-1", "completed");
    await compaction.finish("cmp-b", "completed", { trigger: "automatic", preTokens: 1 }, true);

    expect(sent.map((u) => ("summary" in u ? u.summary : undefined))).toEqual([
      undefined,
      [{ type: "text", text: "Early." }],
      undefined,
    ]);
  });

  it("keeps a pending summary across a previous turn's reset", async () => {
    // The hook fires before the compaction's terminal frames, so a summary
    // that arrives while the consumer is still draining the previous turn
    // belongs to the compaction whose frames are still ahead of it.
    const { sent, compaction } = lifecycle("compaction_update");

    compaction.recordSummary("<summary>Next turn's.</summary>");
    await compaction.reset();
    await compaction.start("cmp-2");
    await compaction.finish("cmp-2", "completed");

    expect(sent.at(-1)).toMatchObject({
      compactionId: "cmp-2",
      status: "completed",
      summary: [{ type: "text", text: "Next turn's." }],
    });
  });

  it("holds a summary that arrives after a terminal entity for the next compaction", async () => {
    // The hook precedes its own compaction's terminal frames, so a summary
    // seen after compaction A's terminal is B's, whose `compacting` status the
    // consumer has not reached yet.
    const { sent, compaction } = lifecycle("compaction_update");

    await compaction.start("cmp-a");
    await compaction.finish("cmp-a", "completed");
    compaction.recordSummary("<summary>B's summary.</summary>");
    expect(sent).toHaveLength(2);

    await compaction.start("cmp-b");
    await compaction.finish("cmp-b", "completed");
    expect(sent.at(-1)).toMatchObject({
      compactionId: "cmp-b",
      status: "completed",
      summary: [{ type: "text", text: "B's summary." }],
    });
  });

  it("ignores a malformed or empty hook payload and reports whether a summary was kept", () => {
    const { compaction } = lifecycle("compaction_update");
    expect(compaction.recordSummary(undefined)).toBe(false);
    expect(compaction.recordSummary(null)).toBe(false);
    expect(compaction.recordSummary({ text: "x" })).toBe(false);
    expect(compaction.recordSummary("<summary>  </summary>")).toBe(false);
    expect(compaction.recordSummary("<summary>Kept.</summary>")).toBe(true);
  });

  it("materializes a terminal-only compaction as a single completed update", async () => {
    const { sent, compaction } = lifecycle("compaction_update");

    compaction.recordSummary("<summary>Only terminal.</summary>");
    await compaction.finish("cmp-boundary", "completed", {
      trigger: "automatic",
      preTokens: 50,
    });

    expect(sent).toEqual([
      {
        sessionUpdate: "compaction_update",
        compactionId: "cmp-boundary",
        status: "completed",
        summary: [{ type: "text", text: "Only terminal." }],
        _meta: {
          jetbrains: {
            air: {
              version: 1,
              contextCompaction: { version: 1, trigger: "automatic", preTokens: 50 },
            },
          },
        },
      },
    ]);
  });

  it("seeds _meta on a boundary-first terminal even without metadata", async () => {
    const { sent, compaction } = lifecycle("compaction_update");

    await compaction.finish("cmp-boundary", "completed", {}, true);

    expect(sent).toEqual([
      {
        sessionUpdate: "compaction_update",
        compactionId: "cmp-boundary",
        status: "completed",
        _meta: { jetbrains: { air: { version: 1, contextCompaction: { version: 1 } } } },
      },
    ]);
  });

  it("reports failures with the error and consumes the duplicated stdout once", async () => {
    const { sent, compaction } = lifecycle("compaction_update");

    await compaction.start("cmp-1");
    compaction.recordSummary("<summary>Never shown.</summary>");
    await compaction.finish("cmp-1", "failed", { error: "summary rejected" });

    expect(sent[1]).toEqual({
      sessionUpdate: "compaction_update",
      compactionId: "cmp-1",
      status: "failed",
      error: "summary rejected",
      // The standard error field carries the error once.
      _meta: { jetbrains: { air: { version: 1, contextCompaction: { version: 1 } } } },
    });
    expect(compaction.consumeDuplicateErrorOutput("summary rejected\n")).toBe(true);
    expect(compaction.consumeDuplicateErrorOutput("summary rejected")).toBe(false);
    // A summary never patches a failed entity.
    compaction.recordSummary("<summary>Still never.</summary>");
    expect(sent).toHaveLength(2);
  });

  it("streams API compaction text as summary chunks only into an announced entity", async () => {
    const { sent, compaction } = lifecycle("compaction_update");

    // The API block alone never opens an entity: nothing would close it.
    await compaction.heartbeat("cmp-stream", undefined);
    await compaction.heartbeat("cmp-stream", "orphan text");
    expect(sent).toEqual([]);
    expect(compaction.hasDeliveredOutput).toBe(false);

    await compaction.start("cmp-1");
    await compaction.heartbeat("cmp-stream", undefined);
    await compaction.heartbeat("cmp-stream", "## Retained\n");
    await compaction.heartbeat("cmp-stream", "The user counted.");
    await compaction.finish("cmp-1", "completed");
    await compaction.heartbeat("cmp-stream", "ignored after terminal");

    expect(sent).toEqual([
      {
        sessionUpdate: "compaction_update",
        compactionId: "cmp-1",
        status: "in_progress",
        _meta: { jetbrains: { air: { version: 1, contextCompaction: { version: 1 } } } },
      },
      {
        sessionUpdate: "compaction_summary_chunk",
        compactionId: "cmp-1",
        content: { type: "text", text: "## Retained\n" },
      },
      {
        sessionUpdate: "compaction_summary_chunk",
        compactionId: "cmp-1",
        content: { type: "text", text: "The user counted." },
      },
      {
        sessionUpdate: "compaction_update",
        compactionId: "cmp-1",
        status: "completed",
        _meta: { jetbrains: { air: { version: 1, contextCompaction: { version: 1 } } } },
      },
    ]);
  });

  it("closes an in-progress entity as cancelled on reset and starts fresh afterwards", async () => {
    const { sent, compaction } = lifecycle("compaction_update");

    await compaction.start("cmp-1");
    await compaction.reset();
    expect(sent.at(-1)).toEqual({
      sessionUpdate: "compaction_update",
      compactionId: "cmp-1",
      status: "cancelled",
    });
    expect(compaction.hasDeliveredOutput).toBe(false);

    // Terminal entities are left alone.
    await compaction.start("cmp-2");
    await compaction.finish("cmp-2", "completed");
    const before = sent.length;
    await compaction.reset();
    expect(sent).toHaveLength(before);
  });

  it("ignores interrupted work's late frames and hooks until a new turn begins", async () => {
    const { sent, compaction } = lifecycle("compaction_update");

    await compaction.start("cmp-1");
    compaction.recordSummary("<summary>Abandoned.</summary>");
    await compaction.interrupt();
    await compaction.interrupt();
    // An orphaned result still calls reset; it must not reopen the tail.
    await compaction.reset();
    await compaction.start("cmp-1");
    await compaction.start("unseen-late-opening");
    await compaction.heartbeat("late-stream", "late chunk");
    await compaction.finish("late-status", "completed");
    await compaction.finish("late-boundary", "completed", { preTokens: 100 }, true);
    expect(compaction.recordSummary("<summary>Late hook.</summary>")).toBe(false);
    expect(sent).toHaveLength(2);
    expect(sent[1]).toEqual({
      sessionUpdate: "compaction_update",
      compactionId: "cmp-1",
      status: "cancelled",
    });

    compaction.resume();
    await compaction.start("cmp-2");
    await compaction.finish("cmp-2", "completed");
    expect(sent.at(-1)).toEqual({
      sessionUpdate: "compaction_update",
      compactionId: "cmp-2",
      status: "completed",
      _meta: { jetbrains: { air: { version: 1, contextCompaction: { version: 1 } } } },
    });
  });

  it("discards pending summaries on interruption and accepts terminal-only output in a new turn", async () => {
    const { sent, compaction } = lifecycle("compaction_update");

    compaction.recordSummary("<summary>Pending abandoned summary.</summary>");
    await compaction.interrupt();
    expect(compaction.recordSummary("<summary>Late abandoned summary.</summary>")).toBe(false);
    await compaction.finish("abandoned-terminal", "completed");
    expect(sent).toEqual([]);

    compaction.resume();
    await compaction.finish("next-terminal", "completed");
    expect(sent).toEqual([
      {
        sessionUpdate: "compaction_update",
        compactionId: "next-terminal",
        status: "completed",
        _meta: { jetbrains: { air: { version: 1, contextCompaction: { version: 1 } } } },
      },
    ]);
  });

  it("leaves completed entities terminal when their surrounding work is interrupted", async () => {
    const { sent, compaction } = lifecycle("compaction_update");

    await compaction.start("cmp-1");
    await compaction.finish("cmp-1", "completed");
    compaction.recordSummary("<summary>Pending hook.</summary>");
    await compaction.interrupt();
    expect(sent).toHaveLength(2);

    compaction.resume();
    await compaction.start("cmp-2");
    expect(compaction.recordSummary("<summary>Fresh.</summary>")).toBe(true);
    await compaction.finish("cmp-2", "completed");
    expect(sent.at(-1)).toMatchObject({
      compactionId: "cmp-2",
      status: "completed",
      summary: [{ type: "text", text: "Fresh." }],
    });
  });

  it.each(["reset", "interrupt"] as const)("never throws from %s", async (method) => {
    const failing = vi.fn<(notification: SessionNotification) => Promise<void>>(async () => {
      throw new Error("client gone");
    });
    const { compaction, logError } = lifecycle("compaction_update", failing);

    // start() itself propagates like every other consumer send.
    await expect(compaction.start("cmp-1")).rejects.toThrow("client gone");
    await expect(compaction[method]()).resolves.toBeUndefined();
    expect(logError).toHaveBeenCalledTimes(1);
  });

  it("starts a new entity for a compaction that follows a terminal one", async () => {
    const { sent, compaction } = lifecycle("compaction_update");

    await compaction.start("cmp-1");
    await compaction.finish("cmp-1", "completed");
    await compaction.start("cmp-2");

    expect(sent.at(-1)).toMatchObject({ compactionId: "cmp-2", status: "in_progress" });
  });
});

describe("ContextCompactionLifecycle summary chunks", () => {
  it("does not repeat a streamed summary in the terminal update", async () => {
    const { sent, compaction } = lifecycle("compaction_update");
    await compaction.start("cmp-1");
    await compaction.heartbeat("cmp-1", "Retained ");
    await compaction.heartbeat("cmp-1", "context.");
    compaction.recordSummary("<summary>\nRetained context.\n</summary>");
    await compaction.finish("cmp-1", "completed");

    expect(sent.map((notification) => notification.sessionUpdate)).toEqual([
      "compaction_update",
      "compaction_summary_chunk",
      "compaction_summary_chunk",
      "compaction_update",
    ]);
    expect(sent[3]).not.toHaveProperty("summary");
  });
});

describe("ContextCompactionLifecycle summary for AIR", () => {
  it("sends the summary when it differs from the streamed chunks", async () => {
    const { sent, compaction } = lifecycle("compaction_update");
    await compaction.start("cmp-1");
    await compaction.heartbeat("cmp-1", "<analysis>raw</analysis><summary>Retained");
    compaction.recordSummary("<summary>\nRetained context.\n</summary>");
    await compaction.finish("cmp-1", "completed");

    expect(sent.at(-1)).toMatchObject({
      sessionUpdate: "compaction_update",
      status: "completed",
      summary: [{ type: "text", text: "Retained context." }],
    });
  });
});

describe("ContextCompactionLifecycle (tool_call)", () => {
  it("keeps the legacy synthetic tool call and never exposes the summary", async () => {
    const { sent, compaction } = lifecycle("tool_call");

    await compaction.start("compact-start");
    await compaction.heartbeat("compact-start", "streamed summary text");
    await compaction.heartbeat("compact-start", "more");
    compaction.recordSummary("<summary>Hidden.</summary>");
    await compaction.finish("compact-start", "completed");
    await compaction.reset();

    expect(sent).toEqual([
      {
        sessionUpdate: "tool_call",
        toolCallId: "compact-start",
        title: "Compact conversation",
        kind: "think",
        status: "in_progress",
        _meta: { jetbrains: { air: { version: 1, contextCompaction: { version: 1 } } } },
      },
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "compact-start",
        status: "in_progress",
        _meta: { jetbrains: { air: { version: 1, contextCompaction: { version: 1 } } } },
      },
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "compact-start",
        status: "completed",
        _meta: { jetbrains: { air: { version: 1, contextCompaction: { version: 1 } } } },
      },
    ]);
  });

  it("materializes a missed opening as a terminal tool_call with the failure content", async () => {
    const { sent, compaction } = lifecycle("tool_call");

    await compaction.finish("compact-failed", "failed", { error: "summary rejected" });
    // Legacy duplicates are ignored, boundary enrichment carries no status.
    await compaction.finish("compact-failed", "failed", { error: "summary rejected" });
    await compaction.finish(
      "compact-boundary",
      "completed",
      { trigger: "manual", preTokens: 3 },
      true,
    );

    expect(sent).toEqual([
      {
        sessionUpdate: "tool_call",
        toolCallId: "compact-failed",
        title: "Compact conversation",
        kind: "think",
        status: "failed",
        content: [
          {
            type: "content",
            content: { type: "text", text: "Compaction failed: summary rejected" },
          },
        ],
        _meta: {
          jetbrains: {
            air: { version: 1, contextCompaction: { version: 1, error: "summary rejected" } },
          },
        },
      },
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "compact-failed",
        _meta: {
          jetbrains: {
            air: { version: 1, contextCompaction: { version: 1, trigger: "manual", preTokens: 3 } },
          },
        },
      },
    ]);
  });
});
