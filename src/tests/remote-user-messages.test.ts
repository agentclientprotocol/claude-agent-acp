import { describe, it, expect, vi } from "vitest";
import type { AgentSideConnection as AcpClient } from "@agentclientprotocol/sdk";
import { ClaudeAcpAgent } from "../acp-agent.js";
import { Pushable } from "../utils.js";
import { mockSessionState, successfulResultMessage, wrapQuery } from "./session-doubles.js";

function userReplay(uuid: string, text: string, extra: Record<string, unknown> = {}) {
  return {
    type: "user",
    message: { role: "user", content: [{ type: "text", text }] },
    parent_tool_use_id: null,
    uuid,
    session_id: "test-session",
    isReplay: true,
    ...extra,
  };
}

async function promptWith(messages: (promptUuid: string) => unknown[]) {
  const updates: any[] = [];
  const client = {
    sessionUpdate: vi.fn(async (notification: any) => {
      updates.push(notification.update);
    }),
  } as unknown as AcpClient;
  const agent = new ClaudeAcpAgent(client, { log: () => {}, error: () => {} });
  const input = new Pushable<any>();
  async function* generator() {
    const { value: sent } = await input[Symbol.asyncIterator]().next();
    yield userReplay(sent.uuid, "typed in Zed");
    yield* messages(sent.uuid);
    yield successfulResultMessage();
    yield { type: "system", subtype: "session_state_changed", state: "idle" };
  }
  agent.sessions["test-session"] = mockSessionState({ query: wrapQuery(generator()), input });
  await agent.prompt({
    sessionId: "test-session",
    prompt: [{ type: "text", text: "typed in Zed" }],
  });
  return updates.filter((update) => update.sessionUpdate === "user_message_chunk");
}

describe("user messages typed in another client of the session", () => {
  it("forwards a human-origin message that this adapter did not send", async () => {
    const userChunks = await promptWith(() => [
      userReplay("phone-1", "typed on the phone", { origin: { kind: "human" } }),
    ]);

    expect(userChunks.map((chunk) => chunk.content.text)).toEqual(["typed on the phone"]);
  });

  it("does not repeat the echo of the prompt the adapter sent", async () => {
    const userChunks = await promptWith(() => []);

    expect(userChunks).toEqual([]);
  });

  it.each([
    ["has no origin", {}],
    ["is synthetic", { origin: { kind: "human" }, isSynthetic: true }],
    ["comes from a peer session", { origin: { kind: "peer", from: "other" } }],
    ["comes from a subagent", { origin: { kind: "human" }, parent_tool_use_id: "toolu_1" }],
  ])("ignores a replayed message that %s", async (_description, extra) => {
    const userChunks = await promptWith(() => [userReplay("other-1", "not a person", extra)]);

    expect(userChunks).toEqual([]);
  });
});
