import { describe, it, expect, vi } from "vitest";
import { ClaudeAcpAgent, type AcpClient } from "../acp-agent.js";
import { Pushable } from "../utils.js";
import { mockSessionState, successfulResultMessage, wrapQuery } from "./session-doubles.js";

const HUMAN = { kind: "human" };

function userReplay(uuid: string, text: string, extra: Record<string, unknown> = {}) {
  return userReplayContent(uuid, [{ type: "text", text }], extra);
}

function userReplayContent(uuid: string, content: unknown[], extra: Record<string, unknown> = {}) {
  return {
    type: "user",
    message: { role: "user", content },
    parent_tool_use_id: null,
    uuid,
    session_id: "test-session",
    isReplay: true,
    ...extra,
  };
}

/** The echo of a message the adapter pushed. The adapter stamps every prompt
 *  and steer with a human origin (`promptToClaude`), and Claude Code echoes it
 *  back unchanged. */
const echoOfAdapterMessage = (uuid: string, text: string) =>
  userReplay(uuid, text, { origin: HUMAN });

const idle = { type: "system", subtype: "session_state_changed", state: "idle" };

function createAgent() {
  const updates: any[] = [];
  const client = {
    sessionUpdate: vi.fn(async (notification: any) => {
      updates.push(notification.update);
    }),
  } as unknown as AcpClient;
  const agent = new ClaudeAcpAgent(client, { log: () => {}, error: () => {} });
  const userChunks = () =>
    updates.filter((update) => update.sessionUpdate === "user_message_chunk");
  const userTexts = () => userChunks().map((update) => update.content.text);
  return { agent, userTexts, userChunks };
}

async function promptWith(messages: (promptUuid: string) => unknown[]) {
  return (await promptWithChunks(messages)).map((chunk) => chunk.content.text);
}

async function promptWithChunks(messages: (promptUuid: string) => unknown[]) {
  const { agent, userChunks } = createAgent();
  const input = new Pushable<any>();
  async function* generator() {
    const { value: sent } = await input[Symbol.asyncIterator]().next();
    yield echoOfAdapterMessage(sent.uuid, "typed in Zed");
    yield* messages(sent.uuid);
    yield successfulResultMessage();
    yield idle;
  }
  agent.sessions["test-session"] = mockSessionState({ query: wrapQuery(generator()), input });
  await agent.prompt({
    sessionId: "test-session",
    prompt: [{ type: "text", text: "typed in Zed" }],
  });
  return userChunks();
}

describe("user messages typed in another client of the session", () => {
  it("does not repeat the echo of the prompt the adapter sent", async () => {
    expect(await promptWith(() => [])).toEqual([]);
  });

  it.each([
    ["has no origin", {}],
    ["is synthetic", { origin: HUMAN, isSynthetic: true }],
    ["comes from a peer session", { origin: { kind: "peer", from: "other" } }],
    ["comes from a subagent", { origin: HUMAN, parent_tool_use_id: "toolu_1" }],
  ])("ignores a replayed message that %s", async (_description, extra) => {
    expect(await promptWith(() => [userReplay("other-1", "not a person", extra)])).toEqual([]);
  });

  it("does not repeat a steer the adapter sent while a turn was running", async () => {
    const { agent, userTexts } = createAgent();
    const input = new Pushable<any>();
    async function* generator() {
      const iterator = input[Symbol.asyncIterator]();
      const { value: prompt } = await iterator.next();
      yield echoOfAdapterMessage(prompt.uuid, "start the work");
      const { value: steer } = await iterator.next();
      yield echoOfAdapterMessage(steer.uuid, "also update the tests");
      yield successfulResultMessage();
      yield idle;
    }
    agent.sessions["test-session"] = mockSessionState({ query: wrapQuery(generator()), input });

    const turn = agent.prompt({
      sessionId: "test-session",
      prompt: [{ type: "text", text: "start the work" }],
    });
    await vi.waitFor(() => expect(agent.sessions["test-session"].turnQueue).toHaveLength(1));
    await agent.steer({
      sessionId: "test-session",
      prompt: [{ type: "text", text: "also update the tests" }],
    });
    await turn;

    expect(userTexts()).toEqual([]);
  });

  it("does not repeat the echo of a turn that settled before its echo came", async () => {
    const { agent, userTexts } = createAgent();
    const input = new Pushable<any>();
    async function* generator() {
      const { value: prompt } = await input[Symbol.asyncIterator]().next();
      yield successfulResultMessage();
      yield idle;
      yield echoOfAdapterMessage(prompt.uuid, "typed in Zed");
    }
    agent.sessions["test-session"] = mockSessionState({ query: wrapQuery(generator()), input });

    await agent.prompt({
      sessionId: "test-session",
      prompt: [{ type: "text", text: "typed in Zed" }],
    });
    await agent.sessions["test-session"].consumer;

    expect(userTexts()).toEqual([]);
    expect(agent.sessions["test-session"].sentUserUuids?.size ?? 0).toBe(0);
  });

  it("forgets a sent uuid once its echo has come", async () => {
    const { agent } = createAgent();
    const input = new Pushable<any>();
    async function* generator() {
      const { value: prompt } = await input[Symbol.asyncIterator]().next();
      yield echoOfAdapterMessage(prompt.uuid, "typed in Zed");
      yield successfulResultMessage();
      yield idle;
    }
    agent.sessions["test-session"] = mockSessionState({ query: wrapQuery(generator()), input });

    await agent.prompt({
      sessionId: "test-session",
      prompt: [{ type: "text", text: "typed in Zed" }],
    });

    expect(agent.sessions["test-session"].sentUserUuids?.size ?? 0).toBe(0);
  });

  const text = (value: string) => ({ type: "text", text: value });
  const png = {
    type: "image",
    source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" },
  };
  // The shape Claude Code delivered for a photo uploaded in the mobile app: one
  // message, one base64 JPEG block, no text.
  const photo = {
    type: "image",
    source: { type: "base64", media_type: "image/jpeg", data: "/9j/4AAQ" },
  };
  const urlImage = { type: "image", source: { type: "url", url: "https://example.com/a.png" } };
  const pdf = {
    type: "document",
    source: { type: "base64", media_type: "application/pdf", data: "JVBERi0=" },
  };

  it.each([
    ["text", [text("typed on the phone")], [text("typed on the phone")]],
    [
      "text and an image",
      [text("what is in this picture?"), png],
      [
        text("what is in this picture?"),
        { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
      ],
    ],
    ["a photo on its own", [photo], [{ type: "image", data: "/9j/4AAQ", mimeType: "image/jpeg" }]],
    [
      "only a url image",
      [urlImage],
      [expect.objectContaining({ type: "image", uri: "https://example.com/a.png" })],
    ],
    [
      "text with a document, keeping the text",
      [text("summarize the attached file"), pdf],
      [text("summarize the attached file")],
    ],
    [
      "text with command markup removed",
      [text("<command-name>/review</command-name>please look at this")],
      [text("please look at this")],
    ],
    [
      "only command markup, skipping it",
      [text("<local-command-stdout>output</local-command-stdout>")],
      [],
    ],
  ])("shows %s sent from another client", async (_description, content, expected) => {
    const chunks = await promptWithChunks(() => [
      userReplayContent("phone-1", content, { origin: HUMAN }),
    ]);

    expect(chunks.map((chunk) => chunk.content)).toEqual(expected);
  });
});
