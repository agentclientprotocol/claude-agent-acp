import { describe, expect, it } from "vitest";
import { promptToClaude } from "../acp-agent.js";
import { sessionMentionForLink } from "../session-references.js";

describe("session references", () => {
  it("mentions a referenced session by title and id", () => {
    expect(
      sessionMentionForLink("acp-session://reference?sessionId=source", "Source chat", "current"),
    ).toBe('[Claude session "Source chat"](claude://sessions/source)');
  });

  it("passes over links with other URI schemes", () => {
    expect(sessionMentionForLink("file:///workspace/main.ts", "main.ts", "current")).toBeNull();
    expect(
      sessionMentionForLink("acp-session://other?sessionId=source", "x", "current"),
    ).toBeNull();
  });

  it("rejects a reference to the active Claude session", () => {
    expect(() =>
      sessionMentionForLink("acp-session://reference?sessionId=current", "Current chat", "current"),
    ).toThrow("A session cannot reference itself");
  });

  it("renders session links and file links side by side in one prompt", () => {
    const message = promptToClaude({
      sessionId: "current",
      prompt: [
        { type: "text", text: "compare with" },
        {
          type: "resource_link",
          name: "Source chat",
          uri: "acp-session://reference?sessionId=source",
        },
        { type: "resource_link", name: "main.ts", uri: "file:///workspace/main.ts" },
      ],
    });

    expect(message.message.content).toEqual([
      { type: "text", text: "compare with" },
      { type: "text", text: '[Claude session "Source chat"](claude://sessions/source)' },
      { type: "text", text: "[@main.ts](file:///workspace/main.ts)" },
    ]);
  });
});
