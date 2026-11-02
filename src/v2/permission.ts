/**
 * The v2 form of the permission requests that `ClaudeAcpAgent` sends, and the
 * v1 form of their answers.
 */
import type { RequestPermissionResponse } from "@agentclientprotocol/sdk/unstable";
import type * as v2 from "@agentclientprotocol/sdk/experimental/v2/unstable";
import type { AcpPermissionRequest } from "../permissions/presentation.js";
import { v2ToolCallPatch } from "./tool-call.js";

/**
 * The v2 form of a permission request of the agent.
 *
 * v1 asks about a tool call, whose title the prompt shows. v2 gives the prompt
 * its own `title` and `description`, which the agent sets for a v2 client
 * (`AcpPermissionRequest`), and asks about a `subject`: here always the tool
 * call, as the same patch that a `tool_call_update` carries.
 */
export function v2PermissionRequest(request: AcpPermissionRequest): v2.RequestPermissionRequest {
  if (request.title === undefined) {
    throw new Error("An ACP v2 permission request needs a title");
  }
  return {
    sessionId: request.sessionId,
    title: request.title,
    ...(request.description ? { description: request.description } : {}),
    subject: { type: "tool_call", toolCall: v2ToolCallPatch(request.toolCall) },
    options: request.options,
    ...(request._meta != null ? { _meta: request._meta } : {}),
  };
}

/**
 * The v1 form of the answer to a permission request.
 *
 * v2 adds outcomes that v1 does not know, which the draft says are no
 * approval. They become `cancelled`. In v2, `cancelled` also means that the
 * user dismissed the prompt or the client declined it by policy. So the agent
 * reads a `cancelled` outcome on v2 as the user refusing the tool, unless a
 * `session/cancel` is stopping the session's work: then the tool use is
 * aborted, as on v1.
 */
export function v1PermissionResponse(
  response: v2.RequestPermissionResponse,
): RequestPermissionResponse {
  const outcome = response.outcome;
  return {
    outcome:
      outcome.outcome === "selected"
        ? (outcome as Extract<RequestPermissionResponse["outcome"], { outcome: "selected" }>)
        : { outcome: "cancelled" },
    ...(response._meta != null ? { _meta: response._meta } : {}),
  };
}
