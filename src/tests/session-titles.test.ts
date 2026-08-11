import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { ClaudeAcpAgent, type AcpClient } from "../acp-agent.js";
import { appendTitleContext } from "../session-titles.js";
import { Pushable } from "../utils.js";
import { getSessionInfo } from "@anthropic-ai/claude-agent-sdk";
import {
  mockSessionState,
  successfulResultMessage,
  userEcho,
  wrapQuery,
} from "./session-doubles.js";

vi.mock("@anthropic-ai/claude-agent-sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@anthropic-ai/claude-agent-sdk")>();
  return { ...actual, getSessionInfo: vi.fn() };
});

describe("SDK title generation contract", () => {
  // Smoke test for the one undeclared SDK method this feature rests on:
  // `generateSessionTitle` is on the runtime `Query` class but absent from
  // `sdk.d.ts`, so nothing else would catch its removal. Method names survive
  // bundling (only module-scope identifiers get mangled), so an SDK upgrade that
  // renames or drops it fails here instead of silently degrading titles back to
  // raw prompts. Runs unconditionally — it reads the shipped bundle and never
  // spawns the CLI.
  it("SDK still ships generateSessionTitle and its control subtype", async () => {
    const sdkEntry = createRequire(import.meta.url).resolve("@anthropic-ai/claude-agent-sdk");
    const bundle = await readFile(sdkEntry, "utf8");
    expect({
      method: bundle.includes("async generateSessionTitle("),
      subtype: bundle.includes('subtype:"generate_session_title"'),
    }).toEqual({ method: true, subtype: true });
  });

  it("keeps only the trailing title context", () => {
    expect(appendTitleContext("abc", "def")).toBe("abcdef");
    expect(appendTitleContext(undefined, "abc")).toBe("abc");
    const overflowed = appendTitleContext("x".repeat(1000), "tail");
    expect(overflowed).toHaveLength(1000);
    expect(overflowed.endsWith("tail")).toBe(true);
  });
});

describe("session titles at turn-end", () => {
  beforeEach(() => {
    vi.mocked(getSessionInfo).mockReset();
  });

  /** Collect every `session_info_update` an agent pushes. */
  function titleRecorder() {
    const updates: any[] = [];
    const client = {
      sessionUpdate: async (u: any) => {
        if (u.update?.sessionUpdate === "session_info_update") updates.push(u.update);
      },
    } as unknown as AcpClient;
    return { client, titles: () => updates.map((u) => u.title) };
  }

  /** `wrapQuery` plus the undeclared `generateSessionTitle` the real `Query`
   *  exposes, so turn-end takes the generate branch. */
  function wrapTitleQuery(generator: AsyncGenerator<any>, title: string | null) {
    const generateSessionTitle = vi.fn(async (_d: string, _o?: { persist?: boolean }) => title);
    return {
      query: Object.assign(wrapQuery(generator), { generateSessionTitle }),
      generateSessionTitle,
    };
  }

  /** One turn: echo the pushed prompt, succeed, go idle. */
  async function* oneTurn(input: Pushable<any>, turns = 1) {
    const iter = input[Symbol.asyncIterator]();
    for (let i = 0; i < turns; i++) {
      const { value: userMessage } = await iter.next();
      yield userEcho(userMessage);
      yield successfulResultMessage();
      yield { type: "system", subtype: "session_state_changed", state: "idle" };
    }
  }

  function newAgent(client: AcpClient) {
    return new ClaudeAcpAgent(client, { log: () => {}, error: () => {} });
  }

  const LONG_PROMPT = "Explain what the add function in hello.py does, in one sentence";

  it("pushes a session_info_update when the SDK generates a title at turn-end", async () => {
    const sessionUpdates: any[] = [];
    const agent = newAgent({
      sessionUpdate: async (u: any) => {
        sessionUpdates.push(u);
      },
    } as unknown as AcpClient);

    vi.mocked(getSessionInfo).mockResolvedValue({
      sessionId: "test-session",
      summary: "Fix the flaky title test",
      lastModified: 1_700_000_000_000,
    } as any);

    const input = new Pushable<any>();
    agent.sessions["test-session"] = mockSessionState(
      {
        query: wrapQuery(oneTurn(input)),
        input,
      },
      agent,
    );

    await agent.prompt({ sessionId: "test-session", prompt: [{ type: "text", text: "test" }] });
    await agent.sessions["test-session"]?.consumer;

    const titleUpdate = sessionUpdates.find(
      (u) => u.update?.sessionUpdate === "session_info_update",
    );
    expect(titleUpdate?.update).toEqual({
      sessionUpdate: "session_info_update",
      title: "Fix the flaky title test",
      updatedAt: new Date(1_700_000_000_000).toISOString(),
    });
    expect(getSessionInfo).toHaveBeenCalledWith("test-session", { dir: "/test" });
  });

  it("does not re-push session_info_update when the title is unchanged", async () => {
    const { client, titles } = titleRecorder();
    const agent = newAgent(client);

    vi.mocked(getSessionInfo).mockResolvedValue({
      sessionId: "test-session",
      summary: "Stable title",
      lastModified: 1_700_000_000_000,
    } as any);

    const input = new Pushable<any>();
    agent.sessions["test-session"] = mockSessionState(
      {
        query: wrapQuery(oneTurn(input, 2)),
        input,
      },
      agent,
    );

    await agent.prompt({ sessionId: "test-session", prompt: [{ type: "text", text: "one" }] });
    await agent.prompt({ sessionId: "test-session", prompt: [{ type: "text", text: "two" }] });
    await agent.sessions["test-session"]?.consumer;

    expect(titles()).toEqual(["Stable title"]);
  });

  it("generates a title at turn-end instead of publishing the raw prompt", async () => {
    const { client, titles } = titleRecorder();
    const agent = newAgent(client);

    // What an SDK-driven session really looks like: nothing has written a title,
    // so `summary` is just the opening prompt.
    vi.mocked(getSessionInfo).mockResolvedValue({
      sessionId: "test-session",
      summary: LONG_PROMPT,
      lastModified: 1_700_000_000_000,
    } as any);

    const input = new Pushable<any>();
    const { query, generateSessionTitle } = wrapTitleQuery(
      oneTurn(input),
      "Explain add() in hello.py",
    );
    agent.sessions["test-session"] = mockSessionState({ query, input }, agent);

    await agent.prompt({
      sessionId: "test-session",
      prompt: [{ type: "text", text: LONG_PROMPT }],
    });
    await agent.sessions["test-session"]?.consumer;
    // Generation is fired off the turn-end path, so it lands after `idle`.
    await vi.waitFor(() => {
      expect(generateSessionTitle).toHaveBeenCalledTimes(1);
    });

    expect(generateSessionTitle).toHaveBeenCalledWith(LONG_PROMPT, { persist: true });
    // The raw prompt was never published — only the generated title.
    expect(titles()).toEqual(["Explain add() in hello.py"]);
  });

  it("adopts a stored title and never generates over it", async () => {
    const { client, titles } = titleRecorder();
    const agent = newAgent(client);

    // The SDK folds a `/rename` and an earlier generated title into the same
    // field, so a non-empty `customTitle` means hands off.
    vi.mocked(getSessionInfo).mockResolvedValue({
      sessionId: "test-session",
      summary: "Renamed by the user",
      customTitle: "Renamed by the user",
      lastModified: 1_700_000_000_000,
    } as any);

    const input = new Pushable<any>();
    const { query, generateSessionTitle } = wrapTitleQuery(oneTurn(input), "Generated instead");
    agent.sessions["test-session"] = mockSessionState({ query, input }, agent);

    await agent.prompt({
      sessionId: "test-session",
      prompt: [{ type: "text", text: LONG_PROMPT }],
    });
    await agent.sessions["test-session"]?.consumer;

    expect(generateSessionTitle).not.toHaveBeenCalled();
    expect(titles()).toEqual(["Renamed by the user"]);
  });

  it("generates once per session, and a later turn can't fall back to the prompt", async () => {
    const { client, titles } = titleRecorder();
    const agent = newAgent(client);

    // `getSessionInfo` never reports the persisted title here, so the
    // once-per-session latch is the only thing holding the second turn back.
    vi.mocked(getSessionInfo).mockResolvedValue({
      sessionId: "test-session",
      summary: LONG_PROMPT,
      lastModified: 1_700_000_000_000,
    } as any);

    const input = new Pushable<any>();
    const { query, generateSessionTitle } = wrapTitleQuery(
      oneTurn(input, 2),
      "Explain add() in hello.py",
    );
    agent.sessions["test-session"] = mockSessionState({ query, input }, agent);

    await agent.prompt({
      sessionId: "test-session",
      prompt: [{ type: "text", text: LONG_PROMPT }],
    });
    await vi.waitFor(() => {
      expect(generateSessionTitle).toHaveBeenCalledTimes(1);
    });
    await agent.prompt({
      sessionId: "test-session",
      prompt: [{ type: "text", text: "And what is the capital of France?" }],
    });
    await agent.sessions["test-session"]?.consumer;

    expect(generateSessionTitle).toHaveBeenCalledTimes(1);
    expect(titles()).toEqual(["Explain add() in hello.py"]);
  });

  it("releases the latch when generation yields no title", async () => {
    const { client, titles } = titleRecorder();
    const agent = newAgent(client);

    vi.mocked(getSessionInfo).mockResolvedValue({
      sessionId: "test-session",
      summary: LONG_PROMPT,
      lastModified: 1_700_000_000_000,
    } as any);

    const input = new Pushable<any>();
    const { query, generateSessionTitle } = wrapTitleQuery(oneTurn(input, 2), null);
    agent.sessions["test-session"] = mockSessionState({ query, input }, agent);

    await agent.prompt({
      sessionId: "test-session",
      prompt: [{ type: "text", text: LONG_PROMPT }],
    });
    await vi.waitFor(() => {
      expect(generateSessionTitle).toHaveBeenCalledTimes(1);
    });
    await agent.prompt({
      sessionId: "test-session",
      prompt: [{ type: "text", text: "And what is the capital of France?" }],
    });
    await agent.sessions["test-session"]?.consumer;
    await vi.waitFor(() => {
      expect(generateSessionTitle).toHaveBeenCalledTimes(2);
    });

    // Nothing generated, so the client still gets the summary fallback.
    expect(titles()).toEqual([LONG_PROMPT]);
  });

  it("skips slash-command and bash openers when building the title context", async () => {
    const { client } = titleRecorder();
    const agent = newAgent(client);

    vi.mocked(getSessionInfo).mockResolvedValue({
      sessionId: "test-session",
      summary: "/compact",
      lastModified: 1_700_000_000_000,
    } as any);

    const input = new Pushable<any>();
    const { query, generateSessionTitle } = wrapTitleQuery(oneTurn(input), "Compact the session");
    agent.sessions["test-session"] = mockSessionState({ query, input }, agent);

    await agent.prompt({
      sessionId: "test-session",
      prompt: [{ type: "text", text: "/compact keep the design discussion" }],
    });
    await agent.sessions["test-session"]?.consumer;

    expect(generateSessionTitle).not.toHaveBeenCalled();
  });
});
