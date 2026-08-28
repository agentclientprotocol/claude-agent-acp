import { describe, expect, it } from "vitest";
import { resolveSessionResourceLinks } from "../session-references.js";

describe("session references", () => {
  it("rewrites an ACP session link into a session mention in place", () => {
    const resolved = resolveSessionResourceLinks({
      sessionId: "current-session",
      prompt: [
        { type: "text", text: "compare with" },
        {
          type: "resource_link",
          name: "Source chat",
          uri: "acp-session://reference?sessionId=source-session",
        },
      ],
    });

    expect(resolved.prompt[0]).toEqual({ type: "text", text: "compare with" });
    expect(resolved.prompt[1]).toEqual({
      type: "text",
      text: '[Claude session "Source chat"](claude://sessions/source-session)',
    });
  });

  it("leaves other resource links untouched", () => {
    const link = {
      type: "resource_link" as const,
      name: "file",
      uri: "file:///workspace/main.ts",
    };
    const resolved = resolveSessionResourceLinks({ sessionId: "current-session", prompt: [link] });
    expect(resolved.prompt).toEqual([link]);
  });

  it("rejects a link to the active Claude session", () => {
    expect(() =>
      resolveSessionResourceLinks({
        sessionId: "current-session",
        prompt: [
          {
            type: "resource_link",
            name: "Current chat",
            uri: "acp-session://reference?sessionId=current-session",
          },
        ],
      }),
    ).toThrow("A session cannot reference itself");
  });
});
