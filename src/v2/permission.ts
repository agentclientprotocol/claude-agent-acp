/**
 * The v2 form of the permission requests that `ClaudeAcpAgent` sends, and the
 * v1 form of their answers.
 */
import type { RequestPermissionResponse } from "@agentclientprotocol/sdk";
import type * as v2 from "@agentclientprotocol/sdk/experimental/v2";
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
 * approval. They become `cancelled`, which the agent reads as an aborted tool
 * use, as it does a cancelled prompt.
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
