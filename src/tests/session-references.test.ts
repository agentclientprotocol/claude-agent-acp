import { getSessionMessages } from "@anthropic-ai/claude-agent-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveSessionResourceLinks } from "../session-references.js";

vi.mock("@anthropic-ai/claude-agent-sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@anthropic-ai/claude-agent-sdk")>();
  return {
    ...actual,
    getSessionMessages: vi.fn(actual.getSessionMessages),
  };
});

describe("session references", () => {
  beforeEach(() => {
    vi.mocked(getSessionMessages).mockReset();
  });

  it("resolves an ACP session link through Claude session history", async () => {
    vi.mocked(getSessionMessages).mockResolvedValueOnce([
      {
        type: "assistant",
        uuid: "answer",
        session_id: "source-session",
        message: { role: "assistant", content: [{ type: "text", text: "Resolved answer" }] },
        parent_tool_use_id: null,
        parent_agent_id: null,
      },
    ]);

    const resolved = await resolveSessionResourceLinks(
      {
        sessionId: "current-session",
        prompt: [
          {
            type: "resource_link",
            name: "Source chat",
            uri: "acp-session://reference?sessionId=source-session",
          },
        ],
      },
      "/workspace",
    );

    expect(getSessionMessages).toHaveBeenCalledWith("source-session", {
      dir: "/workspace",
      includeSystemMessages: true,
    });
    expect(resolved.prompt).toEqual([
      expect.objectContaining({
        type: "resource",
        resource: expect.objectContaining({ text: expect.stringContaining("Resolved answer") }),
      }),
    ]);
  });

  it("rejects a link to the active Claude session", async () => {
    await expect(
      resolveSessionResourceLinks(
        {
          sessionId: "current-session",
          prompt: [
            {
              type: "resource_link",
              name: "Current chat",
              uri: "acp-session://reference?sessionId=current-session",
            },
          ],
        },
        "/workspace",
      ),
    ).rejects.toThrow("A session cannot reference itself");

    expect(getSessionMessages).not.toHaveBeenCalled();
  });
});
