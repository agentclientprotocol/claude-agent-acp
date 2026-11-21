import { describe, it, expect } from "vitest";
import type { ClientCapabilities } from "@agentclientprotocol/sdk/unstable";
import { ClaudeAcpAgent } from "../../v1/acp-agent.js";
import type { AcpClient } from "../../acp-client.js";
import {
  promptSuggestionsMeta,
  promptSuggestionsUpdate,
  promptSuggestionText,
} from "../../prompt-suggestions.js";
import { Pushable } from "../../utils.js";
import {
  mockSessionState,
  successfulResultMessage,
  userEcho,
  wrapQuery,
} from "./session-doubles.js";

/** An AIR client, which reads the follow-up prompt from `_meta`. */
const AIR_CLIENT: ClientCapabilities = {
  _meta: { jetbrains: { air: { version: 1, capabilities: [] } } },
};

/** A client that advertised ACP's `prompt_suggestions_update`. */
const SUGGESTIONS_CLIENT: ClientCapabilities = { session: { promptSuggestions: {} } };

/** The session info update that carries `text` to AIR. */
const metaUpdate = (text: string | null) => ({
  sessionUpdate: "session_info_update",
  _meta: promptSuggestionsMeta(text),
});

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

  it("is one suggestion of one text block in ACP's update, and an empty list withdraws it", () => {
    expect(promptSuggestionsUpdate("Run the tests")).toEqual({
      sessionUpdate: "prompt_suggestions_update",
      suggestions: [{ prompt: [{ type: "text", text: "Run the tests" }] }],
    });
    expect(promptSuggestionsUpdate(null)).toEqual({
      sessionUpdate: "prompt_suggestions_update",
      suggestions: [],
    });
  });
});

/** Collects every update that carries a predicted prompt, in either form. */
function recorder() {
  const published: unknown[] = [];
  const client = {
    sessionUpdate: async (notification: any) => {
      const update = notification.update;
      const carries =
        update?.sessionUpdate === "prompt_suggestions_update" ||
        (update?.sessionUpdate === "session_info_update" &&
          update._meta?.promptSuggestions !== undefined);
      if (carries) published.push(update);
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

async function agentFor(client: AcpClient, clientCapabilities: ClientCapabilities) {
  const agent = new ClaudeAcpAgent(client, { log: () => {}, error: () => {} });
  await agent.initialize({ protocolVersion: 1, clientCapabilities });
  return agent;
}

/**
 * Runs one turn per entry of `suggestions`. `drain` lets the consumer read a
 * turn's prediction before the next prompt. `queued` sends every prompt
 * before the first turn's result.
 */
async function run(
  agent: ClaudeAcpAgent,
  suggestions: (string | null)[],
  { drain = true, queued = false }: { drain?: boolean; queued?: boolean } = {},
) {
  const input = new Pushable<any>();
  agent.sessions["test-session"] = mockSessionState(
    { query: wrapQuery(turns(input, suggestions)), input },
    agent,
  );
  const prompts: Promise<unknown>[] = [];
  for (let i = 0; i < suggestions.length; i++) {
    const prompt = agent.prompt({
      sessionId: "test-session",
      prompt: [{ type: "text", text: `prompt ${i}` }],
    });
    prompts.push(prompt);
    if (queued) continue;
    await prompt;
    // The prediction lands after the turn's result, so let the consumer read
    // it off the stream before the next prompt: a user types slower than this.
    if (drain) await new Promise((resolve) => setTimeout(resolve, 0));
  }
  await Promise.all(prompts);
  await agent.sessions["test-session"]?.consumer;
}

describe.each([
  { form: "AIR's _meta", capabilities: AIR_CLIENT, sent: metaUpdate },
  {
    form: "prompt_suggestions_update",
    capabilities: SUGGESTIONS_CLIENT,
    sent: promptSuggestionsUpdate,
  },
])("the follow-up prompt at turn-end, as $form", ({ capabilities, sent }) => {
  it("publishes the predicted prompt after the turn's result", async () => {
    const { client, published } = recorder();
    const agent = await agentFor(client, capabilities);

    await run(agent, ["Run the tests"]);

    expect(published).toEqual([sent("Run the tests")]);
  });

  it("clears the previous prediction when the next prompt arrives", async () => {
    const { client, published } = recorder();
    const agent = await agentFor(client, capabilities);

    // The second turn predicts nothing, so without the clear at the prompt the
    // first turn's prediction would still sit in the composer after it.
    await run(agent, ["Run the tests", null]);

    expect(published).toEqual([sent("Run the tests"), sent(null)]);
  });

  it("does not publish a prediction that is only whitespace", async () => {
    const { client, published } = recorder();
    const agent = await agentFor(client, capabilities);

    await run(agent, ["   "]);

    expect(published).toEqual([]);
  });

  it("drops a prediction the next prompt outran", async () => {
    const { client, published } = recorder();
    const agent = await agentFor(client, capabilities);

    // Both prompts are sent before the consumer reads the first turn's
    // prediction: it answers a turn the user has already moved past, so it must
    // not surface in the composer during or after the second turn.
    await run(agent, ["Run the tests", null], { drain: false });

    expect(published).toEqual([]);
  });
});

describe("the follow-up prompt of a client by what it declares", () => {
  it("sends nothing to a client that is not AIR and advertises no prompt suggestions", async () => {
    const { client, published } = recorder();
    const agent = await agentFor(client, {} as ClientCapabilities);

    await run(agent, ["Run the tests"]);

    expect(published).toEqual([]);
  });

  it("sends both forms to an AIR client that advertises prompt suggestions", async () => {
    const { client, published } = recorder();
    const agent = await agentFor(client, { ...AIR_CLIENT, ...SUGGESTIONS_CLIENT });

    await run(agent, ["Run the tests"]);

    expect(published).toEqual([
      promptSuggestionsUpdate("Run the tests"),
      metaUpdate("Run the tests"),
    ]);
  });

  /**
   * Scenario:
   * 1. Two prompts arrive before the first turn's result.
   * 2. Each turn ends with a prediction.
   * Expected:
   * - The first prediction comes while the second prompt waits, so it does not
   *   account for that prompt. ACP's update drops it. AIR's `_meta` keeps its
   *   rules and carries it.
   * - The second prediction goes out in both forms.
   */
  it.each([
    {
      form: "prompt_suggestions_update",
      capabilities: SUGGESTIONS_CLIENT,
      expected: [promptSuggestionsUpdate("Commit")],
    },
    {
      form: "AIR's _meta",
      capabilities: AIR_CLIENT,
      expected: [metaUpdate("Run the tests"), metaUpdate("Commit")],
    },
  ])(
    "handles a prediction that arrives while another prompt waits by the rules of $form",
    async ({ capabilities, expected }) => {
      const { client, published } = recorder();
      const agent = await agentFor(client, capabilities);

      await run(agent, ["Run the tests", "Commit"], { queued: true });

      expect(published).toEqual(expected);
    },
  );
});
