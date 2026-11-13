import { randomUUID } from "node:crypto";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";
import { RetractedToolCalls } from "../tool-calls/retracted.js";

/** An assistant message that calls the tools `toolUseIds`, as the SDK sends it. */
function assistant(toolUseIds: string[], supersedes?: string[]) {
  return {
    type: "assistant",
    message: {
      id: "msg_1",
      type: "message",
      role: "assistant",
      model: "claude-fable-5",
      content: toolUseIds.map((id) => ({ type: "tool_use", id, name: "Read", input: {} })),
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    },
    parent_tool_use_id: null,
    uuid: randomUUID(),
    session_id: "session",
    ...(supersedes && { supersedes }),
  } as unknown as SDKMessage & { uuid: string };
}

/** The notice of a refusal fallback that took back the messages `retracted`. */
const notice = (retracted: string[]) =>
  ({
    type: "system",
    subtype: "model_refusal_fallback",
    retracted_message_uuids: retracted,
  }) as unknown as SDKMessage;

describe("RetractedToolCalls", () => {
  it("gives the tool calls of a message once, though the notice and the retry both name it", () => {
    const calls = new RetractedToolCalls();
    const refused = assistant(["toolu_a", "toolu_b"]);
    calls.sent(refused);

    expect(calls.retractedBy(notice([refused.uuid]))).toEqual(["toolu_a", "toolu_b"]);
    expect(calls.retractedBy(assistant([], [refused.uuid]))).toEqual([]);
  });

  it("leaves out a tool call that the replacing message makes itself", () => {
    const calls = new RetractedToolCalls();
    const refused = assistant(["toolu_gone", "toolu_again"]);
    calls.sent(refused);

    expect(calls.retractedBy(assistant(["toolu_again"], [refused.uuid]))).toEqual(["toolu_gone"]);
  });

  it("forgets the oldest of more than 1000 messages", () => {
    const calls = new RetractedToolCalls();
    const oldest = assistant(["toolu_oldest"]);
    calls.sent(oldest);
    const others = Array.from({ length: 1000 }, (_, i) => assistant([`toolu_${i}`]));
    for (const message of others) calls.sent(message);

    expect(calls.retractedBy(notice([oldest.uuid]))).toEqual([]);
    expect(calls.retractedBy(notice([others[0]!.uuid]))).toEqual(["toolu_0"]);
  });
});
