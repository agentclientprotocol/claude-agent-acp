import { describe, it, expect } from "vitest";
import type { ClientCapabilities } from "@agentclientprotocol/sdk/unstable";
import { ClaudeAcpAgent, type AcpClient } from "../acp-agent.js";
import { promptSuggestionsMeta, promptSuggestionText } from "../prompt-suggestions.js";
import { Pushable } from "../utils.js";
import {
  mockSessionState,
  successfulResultMessage,
  userEcho,
  wrapQuery,
} from "./session-doubles.js";

/** An AIR client: the only one that renders the follow-up prompt. */
const AIR_CLIENT: ClientCapabilities = {
  _meta: { jetbrains: { air: { version: 1, capabilities: [] } } },
};

describe("the follow-up prompt on the wire", () => {
  it("drops a prediction that says nothing", () => {
    expect(promptSuggestionText("Run the tests")).toBe("Run the tests");
    expect(promptSuggestionText("  Run the tests  ")).toBe("Run the tests");
    expect(promptSuggestionText("   ")).toBe(null);
    expect(promptSuggestionText("")).toBe(null);
    expect(promptSuggestionText(undefined)).toBe(null);
  });

  it("names no vendor and clears with an empty list", () => {
    expect(promptSuggestionsMeta("Run the tests")).toEqual({
      promptSuggestions: { suggestions: [{ text: "Run the tests" }] },
    });
    expect(promptSuggestionsMeta(null)).toEqual({ promptSuggestions: { suggestions: [] } });
  });
});

describe("the follow-up prompt at turn-end", () => {
  /** Collects the `_meta.promptSuggestions` of every session info update. */
  function recorder() {
    const published: unknown[] = [];
    const client = {
      sessionUpdate: async (notification: any) => {
        const update = notification.update;
        if (update?.sessionUpdate !== "session_info_update") return;
        if (update._meta?.promptSuggestions === undefined) return;
        published.push(update._meta.promptSuggestions);
      },
    } as unknown as AcpClient;
    return { client, published };
  }

  /** One turn per entry: echo the prompt, succeed, predict `suggestion` (when
   *  the entry has one), go idle. A turn with `null` predicts nothing, as the
   *  CLI does in plan mode or after an API error. */
  function turns(input: Pushable<any>, suggestions: (string | null)[]) {
    return (async function* () {
      const iter = input[Symbol.asyncIterator]();
      for (const suggestion of suggestions) {
        const { value: userMessage } = await iter.next();
        yield userEcho(userMessage);
        yield successfulResultMessage();
        if (suggestion !== null) {
          yield { type: "prompt_suggestion", suggestion, uuid: "uuid", session_id: "test-session" };
        }
        yield { type: "system", subtype: "session_state_changed", state: "idle" };
      }
    })();
  }

  async function airAgent(client: AcpClient) {
    const agent = new ClaudeAcpAgent(client, { log: () => {}, error: () => {} });
    await agent.initialize({ protocolVersion: 1, clientCapabilities: AIR_CLIENT });
    return agent;
  }

  async function run(
    agent: ClaudeAcpAgent,
    suggestions: (string | null)[],
    { drain = true }: { drain?: boolean } = {},
  ) {
    const input = new Pushable<any>();
    agent.sessions["test-session"] = mockSessionState(
      { query: wrapQuery(turns(input, suggestions)), input },
      agent,
    );
    for (let i = 0; i < suggestions.length; i++) {
      await agent.prompt({
        sessionId: "test-session",
        prompt: [{ type: "text", text: `prompt ${i}` }],
      });
      // The prediction lands after the turn's result, so let the consumer read
      // it off the stream before the next prompt: a user types slower than this.
      if (drain) await new Promise((resolve) => setTimeout(resolve, 0));
    }
    await agent.sessions["test-session"]?.consumer;
  }

  it("publishes the predicted prompt after the turn's result", async () => {
    const { client, published } = recorder();
    const agent = await airAgent(client);

    await run(agent, ["Run the tests"]);

    expect(published).toEqual([{ suggestions: [{ text: "Run the tests" }] }]);
  });

  it("clears the previous prediction when the next prompt arrives", async () => {
    const { client, published } = recorder();
    const agent = await airAgent(client);

    // The second turn predicts nothing, so without the clear at the prompt the
    // first turn's prediction would still sit in the composer after it.
    await run(agent, ["Run the tests", null]);

    expect(published).toEqual([{ suggestions: [{ text: "Run the tests" }] }, { suggestions: [] }]);
  });

  it("does not publish a prediction that is only whitespace", async () => {
    const { client, published } = recorder();
    const agent = await airAgent(client);

    await run(agent, ["   "]);

    expect(published).toEqual([]);
  });

  it("drops a prediction the next prompt outran", async () => {
    const { client, published } = recorder();
    const agent = await airAgent(client);

    // Both prompts are sent before the consumer reads the first turn's
    // prediction: it answers a turn the user has already moved past, so it must
    // not surface in the composer during or after the second turn.
    await run(agent, ["Run the tests", null], { drain: false });

    expect(published).toEqual([]);
  });

  it("sends nothing to a client that is not AIR", async () => {
    const { client, published } = recorder();
    const agent = new ClaudeAcpAgent(client, { log: () => {}, error: () => {} });
    await agent.initialize({ protocolVersion: 1, clientCapabilities: {} as ClientCapabilities });

    await run(agent, ["Run the tests"]);

    expect(published).toEqual([]);
  });
});
