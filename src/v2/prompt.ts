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
} from "@agentclientprotocol/sdk";
import * as v2 from "@agentclientprotocol/sdk/experimental/v2";
import type { ClaudeAcpAgent } from "../acp-agent.js";
import { splitNoticeText } from "../session-notices.js";
import type { StopReason, TurnEvents, TurnOutcome } from "../turn-events.js";

/**
 * Starts a turn for `params`, and answers when Claude Code takes the prompt
 * in. `send` delivers a session update of the prompt's session; it must not
 * throw, and must deliver updates in the order it is called, also relative to
 * the agent's own updates.
 *
 * - Taken in: the prompt's `user_message`, then `running`, then the answer.
 * - Waiting on a permission request or a question: `requires_action`, and
 *   `running` once none is open.
 * - Ended: `idle` with the stop reason, usage, and `_meta` of the turn.
 * - Failed after it was taken in: `idle` with {@link FAILED_STOP_REASON} and
 *   the JSON-RPC error that v1 answers with in `_meta.claudeCode.error`, and
 *   an error `notice` before it that shows the failure. v2 has no error on
 *   `idle`, and a notice must not be the only report of a failure.
 * - Ended or failed before it was taken in: the answer is a JSON-RPC error,
 *   `-32800` for a prompt that a cancel ended in the queue.
 *
 * Deferred decision: a turn whose background subagents still run ends only
 * when they finish (`Turn.deferredSettle`), so `idle` waits for them too. The
 * hold exists for v1, whose clients stop listening at the prompt response.
 * v2 allows background updates while idle, so it could report `idle` at the
 * turn's result instead, with a turn event for the hold. To be decided with
 * async tasks (step 6 in `docs/acp-v2.md`).
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
        send({ sessionUpdate: "state_update", state: "running" });
        resolve({ messageId });
      },
      awaitingUser() {
        send({ sessionUpdate: "state_update", state: "requires_action" });
      },
      resumed() {
        send({ sessionUpdate: "state_update", state: "running" });
      },
      ended(outcome) {
        if (inserted) {
          send(idle(outcome));
        } else if (outcome.stopReason === "cancelled") {
          reject(RequestError.requestCancelled());
        } else {
          reject(
            RequestError.internalError(
              { stopReason: outcome.stopReason },
              "The turn ended before Claude Code took the prompt in",
            ),
          );
        }
      },
      failed(error, title) {
        if (!inserted) {
          reject(error);
          return;
        }
        const failure = jsonRpcError(error);
        send({
          sessionUpdate: "notice",
          severity: "error",
          ...splitNoticeText(title ?? failure.message, "The turn failed"),
        });
        send({
          sessionUpdate: "state_update",
          state: "idle",
          stopReason: FAILED_STOP_REASON,
          _meta: { claudeCode: { error: failure } },
        });
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
 * The stop reason of a turn that failed after it was taken in. v2's stop
 * reasons all describe work that ended without an error, and a custom one
 * starts with `_`; clients show it as a generic stop.
 */
export const FAILED_STOP_REASON = "_error";

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

function v1ContentBlock(block: v2.ContentBlock): ContentBlock {
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
