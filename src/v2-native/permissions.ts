/**
 * Claude Code's permission checks (`canUseTool`), asked as ACP v2 permission
 * requests.
 *
 * The request is built and its answer read by the same helpers as on v1
 * (`permissions/*`), so a v2 client gets the same options and the same
 * effects of each.
 */
import type { CanUseTool, PermissionMode } from "@anthropic-ai/claude-agent-sdk";
import { previewPatchContent } from "../diff.js";
import { normalizeDurablePermissionChangeSet } from "../permissions/normalization.js";
import { buildClaudePermissionOptions } from "../permissions/options.js";
import { buildClaudePermissionPresentation } from "../permissions/presentation.js";
import { decodeClaudePermissionResponse } from "../permissions/response.js";
import { ClientCapabilities } from "../tool-calls/client-capabilities.js";
import { v1PermissionResponse, v2PermissionRequest } from "../v2/permission.js";
import type { RequestTarget } from "./tasks.js";

const V2_CAPABILITIES = ClientCapabilities.from(undefined, { v2: true });

/** What a permission check needs of its root session. */
export interface PermissionHost {
  /** The ids of the modes that the session offers. */
  availableModes(): string[];
  /**
   * The session that the request goes to: the root, or the child session of
   * the subagent `agentId`. It counts the request as open while it is
   * (`requires_action`).
   */
  target(agentId: string | undefined): Promise<RequestTarget>;
  /** The user picked a mode in the answer, such as ExitPlanMode's "auto-accept edits". */
  modeChanged(mode: PermissionMode): void;
}

export function canUseTool(host: PermissionHost): CanUseTool {
  return async (
    toolName,
    toolInput,
    {
      signal,
      suggestions,
      toolUseID,
      matchedAskRule,
      blockedPath,
      decisionReason,
      title,
      displayName,
      description,
      defaultToNo,
      suppressAlwaysAllowRule,
      agentID,
    },
  ) => {
    const target = await host.target(agentID);
    // No persistent "always allow" when the user's own ask rule forced the
    // prompt, or when Claude Code says the rule it would write grants more
    // than this ask.
    const noPersistentRule = matchedAskRule !== undefined || suppressAlwaysAllowRule === true;
    const durableChangeSet = normalizeDurablePermissionChangeSet(suggestions, noPersistentRule);
    // A v2 diff cannot hold an Edit's snippet: the request shows the exact patch.
    const previewContent = await previewPatchContent(toolName, toolInput, target.cwd, "v2");
    const presentation = buildClaudePermissionPresentation({
      toolName,
      input: toolInput,
      toolUseID,
      cwd: target.cwd,
      capabilities: V2_CAPABILITIES,
      previewContent,
      blockedPath,
      title,
      displayName,
      description,
      decisionReason,
      defaultToNo,
    });
    const options = buildClaudePermissionOptions({
      toolName,
      displayName,
      input: toolInput,
      cwd: target.cwd,
      durableChangeSet,
      allowPersistentOptions: !noPersistentRule,
      defaultToNo,
      availableModes: host.availableModes(),
      // Clearing the context after a plan needs a turn to continue in, which
      // this core does not start on its own.
      allowContextReset: false,
    });
    const response = v1PermissionResponse(
      await target.requestPermission(
        v2PermissionRequest({ ...presentation, options, sessionId: target.sessionId }),
        signal,
      ),
    );
    if (signal.aborted) throw new Error("Tool use aborted");
    // In v2, `cancelled` is also the user dismissing the prompt. Without a
    // `session/cancel`, that is a refusal, and the turn goes on.
    if (response.outcome.outcome === "cancelled") {
      if (target.cancelling()) throw new Error("Tool use aborted");
      return {
        behavior: "deny",
        message: "User refused permission to run tool",
        toolUseID,
        decisionClassification: "user_reject",
      };
    }
    const { permissionResult } = decodeClaudePermissionResponse(
      response,
      toolName,
      toolInput,
      toolUseID,
      options,
      durableChangeSet,
    );
    if (permissionResult.behavior === "allow") {
      const modeUpdate = permissionResult.updatedPermissions?.find(
        (update) => update.type === "setMode" && update.destination === "session",
      );
      if (modeUpdate?.type === "setMode") host.modeChanged(modeUpdate.mode);
    }
    return permissionResult;
  };
}
