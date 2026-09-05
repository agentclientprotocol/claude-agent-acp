import { describe, expect, it } from "vitest";
import type { SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import { resumedModelFromTranscript } from "../resumed-session.js";

function assistant(model: unknown): SessionMessage {
  return {
    type: "assistant",
    uuid: crypto.randomUUID(),
    session_id: "session-id",
    parent_tool_use_id: null,
    parent_agent_id: null,
    message: { model },
  };
}

describe("resumedModelFromTranscript", () => {
  it("returns the last real assistant model", () => {
    expect(
      resumedModelFromTranscript([assistant("claude-sonnet-5"), assistant("claude-opus-5")]),
    ).toBe("claude-opus-5");
  });

  it("skips synthetic assistant records after the real response", () => {
    expect(resumedModelFromTranscript([assistant("claude-opus-5"), assistant("<synthetic>")])).toBe(
      "claude-opus-5",
    );
  });

  it("returns undefined when the transcript has no real assistant model", () => {
    expect(resumedModelFromTranscript([assistant("<synthetic>")])).toBeUndefined();
  });
});
