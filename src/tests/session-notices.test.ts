import { describe, expect, it } from "vitest";
import {
  clientSupportsNotices,
  MAX_NOTICE_TITLE_LENGTH,
  normalizeNoticeText,
  noticeOrTranscriptUpdate,
  noticePlainText,
  noticeTranscriptText,
  sentenceCase,
  splitNoticeText,
} from "../session-notices.js";

describe("session notices", () => {
  it("requires an object under clientCapabilities.session.notices", () => {
    expect(clientSupportsNotices(undefined)).toBe(false);
    expect(clientSupportsNotices({})).toBe(false);
    expect(clientSupportsNotices({ session: {} })).toBe(false);
    expect(clientSupportsNotices({ session: { notices: null } })).toBe(false);
    expect(clientSupportsNotices({ session: { notices: [] as never } })).toBe(false);
    expect(clientSupportsNotices({ session: { notices: {} } })).toBe(true);
  });

  it("renders the bold-label transcript line for clients without the capability", () => {
    const notice = {
      severity: "warning" as const,
      title: "Fast mode turned off",
      description: "Why.",
    };
    expect(noticeTranscriptText(notice)).toBe("**Fast mode turned off:** Why.");
    expect(noticeTranscriptText({ severity: "info", title: "Done" })).toBe("**Done**");
    expect(noticeOrTranscriptUpdate(notice, false)).toEqual({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "**Fast mode turned off:** Why." },
    });
    expect(noticeOrTranscriptUpdate(notice, false, "custom line")).toEqual({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "custom line" },
    });
    const meta = { claudeCode: { kind: "informational", level: "warning" } };
    expect(noticeOrTranscriptUpdate(notice, false, "custom line", meta)).toEqual({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "custom line" },
      _meta: meta,
    });
    expect(noticeOrTranscriptUpdate(notice, true, "custom line", meta)).not.toHaveProperty("_meta");
  });

  it("sends a notice update when the client can present one", () => {
    expect(
      noticeOrTranscriptUpdate({ severity: "info", title: "Task stopped by user" }, true),
    ).toEqual({ sessionUpdate: "notice", severity: "info", title: "Task stopped by user" });
    expect(
      noticeOrTranscriptUpdate({ severity: "error", title: "T", description: "D" }, true),
    ).toEqual({ sessionUpdate: "notice", severity: "error", title: "T", description: "D" });
  });

  it("strips inline markdown that a plain-text notice would show literally", () => {
    expect(noticePlainText("**Blocked:** run `npm test` first")).toBe(
      "Blocked: run npm test first",
    );
    expect(noticePlainText("## Heading\n__strong__ and a * lone star")).toBe(
      "Heading\nstrong and a * lone star",
    );
    expect(splitNoticeText("**Blocked:** run `npm test` first", "Fallback")).toEqual({
      title: "Blocked: run npm test first",
    });
  });

  it("normalizes whitespace for repeat detection and capitalizes fragments", () => {
    expect(normalizeNoticeText("  a\r\nb  c\n")).toBe("a b c");
    expect(sentenceCase("not available on the free plan")).toBe("Not available on the free plan");
    expect(sentenceCase("")).toBe("");
  });

  it("shapes free-form text into a standalone title", () => {
    expect(splitNoticeText("hook says no", "Fallback")).toEqual({ title: "hook says no" });
    expect(splitNoticeText("  hook says no \n", "Fallback")).toEqual({ title: "hook says no" });
    expect(splitNoticeText("First line\r\n\nRest of it\n", "Fallback")).toEqual({
      title: "First line",
      description: "Rest of it",
    });
    expect(splitNoticeText("", "Fallback")).toEqual({ title: "Fallback" });
    const long = "x".repeat(MAX_NOTICE_TITLE_LENGTH + 1);
    expect(splitNoticeText(long, "Fallback")).toEqual({ title: "Fallback", description: long });
    expect(splitNoticeText(`${long}\nmore`, "Fallback")).toEqual({
      title: "Fallback",
      description: `${long}\nmore`,
    });
  });
});
