import { describe, it, expect } from "vitest";
import { randomUUID } from "crypto";
import { ClaudeAcpAgent, type AcpClient } from "../acp-agent.js";
import { mockSessionState, wrapQuery } from "./session-doubles.js";
import { Pushable } from "../utils.js";

/**
 * The backend-acceptance marker (`executablemd.session-materialization/v1`).
 *
 * A client that defers creating durable session state until a conversation
 * really exists needs one fact: the SDK took this queued prompt into a turn.
 * Nothing a turn produces says that — output, an idle, a result and a settled
 * response each say the turn is under way or over — so the adapter says it
 * itself, once, at the point the SDK reports the dispatch.
 *
 * Two facts report that dispatch: the `command_lifecycle` "started" frame on
 * CLIs that emit one, and the replayed echo of the prompt's own uuid
 * everywhere else. Either may arrive first, or both; the marker is published
 * once for the prompt regardless.
 */

const SESSION_MATERIALIZATION_META = "executablemd.session-materialization/v1";

/** Every `session_info_update` an agent pushes that states acceptance. */
function acceptanceRecorder() {
  const markers: unknown[] = [];
  const client = {
    sessionUpdate: async (notification: any) => {
      const update = notification.update;
      if (
        update?.sessionUpdate === "session_info_update" &&
        update._meta?.[SESSION_MATERIALIZATION_META] !== undefined
      ) {
        markers.push(notification);
      }
    },
  } as unknown as AcpClient;
  return { client, markers };
}

function resultMessage(overrides: Record<string, unknown> = {}) {
  return {
    type: "result" as const,
    subtype: "success",
    stop_reason: null,
    is_error: false,
    result: "",
    errors: [],
    duration_ms: 0,
    duration_api_ms: 0,
    num_turns: 1,
    total_cost_usd: 0,
    usage: {
      input_tokens: 10,
      output_tokens: 5,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
    modelUsage: {},
    permission_denials: [],
    uuid: randomUUID(),
    session_id: "test-session",
    ...overrides,
  };
}

const IDLE = { type: "system", subtype: "session_state_changed", state: "idle" };

/** A `command_lifecycle` frame (CLIs 2.1.206+) for one queued command. */
function lifecycleFrame(commandUuid: string, state: string) {
  return {
    type: "command_lifecycle",
    command_uuid: commandUuid,
    state,
    uuid: randomUUID(),
    session_id: "test-session",
  };
}

/**
 * Install a session whose stream reports the prompt's dispatch the way
 * `dispatch` asks, and then settles the turn.
 *
 * `echo` replays the prompt's own uuid back; `lifecycle` emits the "started"
 * frame for it. A run may do either, both, or neither.
 */
function injectSession(
  agent: ClaudeAcpAgent,
  sessionId: string,
  dispatch: { echo?: boolean; lifecycle?: boolean },
) {
  const input = new Pushable<any>();
  async function* messageGenerator() {
    const iter = input[Symbol.asyncIterator]();
    const { value: userMessage, done } = await iter.next();
    if (done || !userMessage) {
      return;
    }
    if (dispatch.lifecycle) {
      yield lifecycleFrame(userMessage.uuid, "started") as any;
    }
    if (dispatch.echo) {
      yield {
        type: "user",
        message: userMessage.message,
        parent_tool_use_id: null,
        uuid: userMessage.uuid,
        session_id: sessionId,
        isReplay: true,
      } as any;
    }
    yield resultMessage() as any;
    yield IDLE as any;
  }
  agent.sessions[sessionId] = mockSessionState({
    query: wrapQuery(messageGenerator()),
    input,
  });
}

async function runPrompt(dispatch: { echo?: boolean; lifecycle?: boolean }) {
  const { client, markers } = acceptanceRecorder();
  const agent = new ClaudeAcpAgent(client, { log: () => {}, error: () => {} });
  injectSession(agent, "test-session", dispatch);
  await agent.prompt({ sessionId: "test-session", prompt: [{ type: "text", text: "test" }] });
  await agent.sessions["test-session"]?.consumer;
  return markers;
}

describe("session materialization marker", () => {
  it("reports acceptance from the replayed echo of the prompt's own uuid", async () => {
    const markers = await runPrompt({ echo: true });

    expect(markers).toEqual([
      {
        sessionId: "test-session",
        update: {
          sessionUpdate: "session_info_update",
          _meta: { [SESSION_MATERIALIZATION_META]: { state: "accepted" } },
        },
      },
    ]);
  });

  it("reports acceptance from a command_lifecycle started frame", async () => {
    const markers = await runPrompt({ lifecycle: true });

    expect(markers).toHaveLength(1);
  });

  it("reports one acceptance when both dispatch facts arrive", async () => {
    const markers = await runPrompt({ lifecycle: true, echo: true });

    expect(markers).toHaveLength(1);
  });

  it("reports nothing when the SDK never says it took the prompt", async () => {
    // A result and an idle settle the turn, and neither is a dispatch: the
    // turn ends without the adapter ever claiming the SDK accepted it.
    const markers = await runPrompt({});

    expect(markers).toEqual([]);
  });
});
