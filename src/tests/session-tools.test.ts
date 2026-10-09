import { describe, it, expect, vi } from "vitest";
import {
  createSessionToolsServer,
  RENAME_SESSION_WIRE_TOOL_NAME,
  SESSION_TOOLS_SERVER_NAME,
  sessionTools,
} from "../session-tools.js";
import { toolInfoFromToolUse } from "../tools.js";

describe("session tools", () => {
  it("serves the rename tool from the adapter's own in-process server", () => {
    const server = createSessionToolsServer({ rename: async (title) => title });

    expect(server).toMatchObject({ type: "sdk", name: SESSION_TOOLS_SERVER_NAME });
    expect(RENAME_SESSION_WIRE_TOOL_NAME).toBe("mcp__acp_session__rename");
  });

  it("renames through the host and answers with the title as stored", async () => {
    const rename = vi.fn(async (_title: string) => "Fix the login bug");
    const [renameTool] = sessionTools({ rename });

    const result = await renameTool.handler({ title: "Fix the\nlogin bug" }, {});

    expect(rename).toHaveBeenCalledWith("Fix the\nlogin bug");
    expect(result).toEqual({
      content: [{ type: "text", text: "Session renamed to: Fix the login bug" }],
    });
  });

  it("answers a refused rename with a tool error", async () => {
    const [renameTool] = sessionTools({
      rename: async () => {
        throw new Error("The title is empty");
      },
    });

    const result = await renameTool.handler({ title: " " }, {});

    expect(result).toEqual({
      content: [{ type: "text", text: "The session was not renamed: Error: The title is empty" }],
      isError: true,
    });
  });

  it("titles the tool call with the new title", () => {
    const info = toolInfoFromToolUse(
      { name: RENAME_SESSION_WIRE_TOOL_NAME, id: "toolu_1", input: { title: "Fix the login bug" } },
      false,
    );
    expect(info.title).toBe("Rename session: Fix the login bug");
    expect(info.kind).toBe("other");
  });

  it("falls back to a plain title while the input is still empty", () => {
    const info = toolInfoFromToolUse(
      { name: RENAME_SESSION_WIRE_TOOL_NAME, id: "toolu_2", input: {} },
      false,
    );
    expect(info.title).toBe("Rename session");
  });
});
