import { PromptRequest, RequestError } from "@agentclientprotocol/sdk/unstable";

/** Custom (extension) request method a client uses to steer the turn that is
 *  currently running: the message is injected into the in-flight turn rather
 *  than queued as a separate `session/prompt`. Named `_session/steering` per the
 *  agreed ACP steering wire protocol; advertised to clients via the top-level
 *  `InitializeResponse._meta.steering.supported`. */
export const STEER_METHOD = "_session/steering";

/** How urgently the SDK delivers a steered message relative to the running
 *  turn — an internal Claude implementation detail, not part of the wire
 *  contract. `now` pre-empts the current generation, while `later` waits for a
 *  pending permission/elicitation callback to settle instead of cancelling its
 *  ACP request and hiding the client's user-input card (IJAI-1191). */
export const STEER_PRIORITY_NOW = "now" as const;
export const STEER_PRIORITY_LATER = "later" as const;

/** Request-level steering options. `promptRequired` is opt-in so existing Hosts
 *  keep the established idle fallback behavior. */
type SteerMeta = {
  [key: string]: unknown;
  steering?: {
    idleBehavior?: "promptRequired";
  };
};

/** Params of a {@link STEER_METHOD} request. Shaped like the relevant subset of
 *  a `PromptRequest` so the same `promptToClaude` conversion applies. Delivery
 *  priority is deliberately NOT exposed here — it's an internal detail the agent
 *  chooses (see {@link STEER_PRIORITY}). */
export type SteerRequest = {
  sessionId: string;
  prompt: PromptRequest["prompt"];
  _meta?: SteerMeta | null;
};

/** Result of a {@link STEER_METHOD} request. The legacy `startedNewTurn` result
 *  remains the default idle behavior; `promptRequired` is returned only when the
 *  Host explicitly opts into the host-owned fallback in request `_meta`. */
export type SteerResponse =
  | { outcome: "injected" }
  | { outcome: "startedNewTurn" }
  | { outcome: "promptRequired"; reason: "noRunningTurn" };

/** Validate raw JSON-RPC params into a {@link SteerRequest}. Kept minimal — the
 *  content blocks are handed to `promptToClaude`, which tolerates unknown block
 *  types — but `sessionId` and a non-empty `prompt` array are required. */
export function parseSteerRequest(params: unknown): SteerRequest {
  if (!params || typeof params !== "object") {
    throw RequestError.invalidParams(undefined, "steer params must be an object");
  }
  const { sessionId, prompt, _meta } = params as Record<string, unknown>;
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    throw RequestError.invalidParams(undefined, "steer params require a non-empty sessionId");
  }
  if (!Array.isArray(prompt) || prompt.length === 0) {
    throw RequestError.invalidParams(undefined, "steer params require a non-empty prompt array");
  }
  const steering =
    _meta && typeof _meta === "object" ? (_meta as Record<string, unknown>).steering : undefined;
  const idleBehavior =
    steering && typeof steering === "object"
      ? (steering as Record<string, unknown>).idleBehavior
      : undefined;
  if (idleBehavior !== undefined && idleBehavior !== "promptRequired") {
    throw RequestError.invalidParams(undefined, "unsupported steering idleBehavior");
  }
  return {
    sessionId,
    prompt: prompt as PromptRequest["prompt"],
    _meta: _meta as SteerMeta | null | undefined,
  };
}
