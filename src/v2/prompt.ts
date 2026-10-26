/**
 * ACP v2 `session/prompt`, served through the turn events of `ClaudeAcpAgent`.
 *
 * v2 answers the prompt once Claude Code takes it in, with the id of the user
 * message it became, and reports the rest of the turn as `state_update`s.
 */
import {
  RequestError,
  type Annotations,
  type ContentBlock,
  type PromptRequest,
  type Role,
} from "@agentclientprotocol/sdk/unstable";
import * as v2 from "@agentclientprotocol/sdk/experimental/v2/unstable";
import type { ClaudeAcpAgent } from "../acp-agent.js";
import type { ForegroundEvents, StopReason, TurnEvents, TurnOutcome } from "../turn-events.js";

/**
 * Starts a turn for `params`, and answers when Claude Code takes the prompt
 * in, with the id of the user message it became. `send` delivers a session
 * update of the prompt's session; it must not throw, and must deliver updates
 * in the order it is called, also relative to the agent's own updates.
 *
 * - Taken in: the prompt's `user_message`, then the answer. From then on, the
 *   turn is the session's foreground work, which reports its states (see
 *   {@link v2Foreground}).
 * - Ended or failed before it was taken in: the answer is a JSON-RPC error,
 *   `-32800` for a prompt that a cancel ended in the queue.
 */
export function v2Prompt(
  agent: ClaudeAcpAgent,
  params: v2.PromptRequest,
  send: (update: v2.SessionUpdate) => void,
): Promise<v2.PromptResponse> {
  return new Promise((resolve, reject) => {
    let inserted = false;
    const events: TurnEvents = {
      inserted(messageId) {
        inserted = true;
        send({ sessionUpdate: "user_message", messageId, content: params.prompt });
        resolve({ messageId });
      },
      ended(outcome) {
        if (inserted) return;
        reject(
          outcome.stopReason === "cancelled"
            ? RequestError.requestCancelled()
            : RequestError.internalError(
                { stopReason: outcome.stopReason },
                "The turn ended before Claude Code took the prompt in",
              ),
        );
      },
      failed(error) {
        if (!inserted) reject(error);
      },
    };
    let request: PromptRequest;
    try {
      request = v1PromptRequest(params);
    } catch (error) {
      reject(error);
      return;
    }
    agent.startTurn(request, events).catch(reject);
  });
}

/**
 * Reports the foreground work of a session (see {@link ForegroundEvents}) as
 * its `state_update`s. `send` delivers a session update of that session, as
 * for {@link v2Prompt}.
 *
 * - Started: `running`. For a prompt's turn, right after its `user_message`.
 * - Waiting on a permission request or a question: `requires_action`, and
 *   `running` once none is open, unless a cancel withdrew the last one: the
 *   work is being stopped then, and its `idle` follows.
 * - Ended: `idle` with the stop reason, usage, and `_meta` of the work.
 * - Failed: `idle` with the `error` stop reason and the JSON-RPC error that v1
 *   answers the prompt with, so a client can show its message and handle its
 *   code as for an error response (for example, `-32000` starts the client's
 *   sign-in).
 *
 * The work is a prompt's turn or a model cycle that Claude Code started on its
 * own, such as its follow-up after a background subagent finished. A turn's
 * work ends at its result, also when v1 holds the turn's answer for the
 * background subagents it spawned (`Turn.deferredSettle`): v2 allows
 * background updates while idle, so the subagents' output and requests arrive
 * after `idle`, and their follow-up is a cycle of its own.
 */
export function v2Foreground(send: (update: v2.SessionUpdate) => void): ForegroundEvents {
  return {
    running() {
      send({ sessionUpdate: "state_update", state: "running" });
    },
    awaitingUser() {
      send({ sessionUpdate: "state_update", state: "requires_action" });
    },
    ended(outcome) {
      send(idle(outcome));
    },
    failed(error) {
      send({
        sessionUpdate: "state_update",
        state: "idle",
        stopReason: "error",
        error: jsonRpcError(error),
      });
    },
  };
}

/** The JSON-RPC error that v1 answers a failed prompt with. */
function jsonRpcError(error: unknown): { code: number; message: string; data?: unknown } {
  if (error instanceof RequestError) {
    return {
      code: error.code,
      message: error.message,
      ...(error.data !== undefined ? { data: error.data } : {}),
    };
  }
  return {
    code: RequestError.internalError().code,
    message: error instanceof Error ? error.message : String(error),
  };
}

/**
 * The `idle` of a turn that ended. Every stop reason the agent reports is one
 * of v2's own, so the state is typed as those members of `IdleStateUpdate`:
 * the type checker matches each stop reason to its member, which it cannot do
 * against the whole union with its custom and unknown members.
 */
function idle({ stopReason, usage, _meta }: TurnOutcome): v2.SessionUpdate {
  const state: Extract<v2.IdleStateUpdate, { stopReason: StopReason }> = {
    stopReason,
    ...(usage ? { usage } : {}),
    ...(_meta ? { _meta } : {}),
  };
  return { sessionUpdate: "state_update", state: "idle", ...state };
}

/**
 * A v2 prompt may hold content blocks that v1 cannot express: a custom one,
 * or one from a newer ACP version. Clients send only the kinds the agent
 * advertised, so such a block is rejected rather than silently dropped.
 */
export function v1PromptRequest({ prompt, ...request }: v2.PromptRequest): PromptRequest {
  return { ...request, prompt: prompt.map(v1ContentBlock) };
}

export function v1ContentBlock(block: v2.ContentBlock): ContentBlock {
  if (
    v2.ContentBlock.isText(block) ||
    v2.ContentBlock.isImage(block) ||
    v2.ContentBlock.isAudio(block) ||
    v2.ContentBlock.isResourceLink(block) ||
    v2.ContentBlock.isResource(block)
  ) {
    const { annotations, ...rest } = block;
    return annotations != null ? { ...rest, annotations: v1Annotations(annotations) } : rest;
  }
  throw RequestError.invalidParams(
    { type: block.type },
    `Content blocks of type ${block.type} are not supported`,
  );
}

/**
 * v2 also accepts audiences of a newer ACP version; v1 knows two. An audience
 * of only unknown roles is dropped rather than narrowed to nobody.
 */
function v1Annotations({ audience, ...annotations }: v2.Annotations): Annotations {
  if (audience == null) return annotations;
  const known = audience.filter(isV1Role);
  return known.length > 0 || audience.length === 0
    ? { ...annotations, audience: known }
    : annotations;
}

function isV1Role(role: string): role is Role {
  return role === "assistant" || role === "user";
}
