/**
 * Claude Code's permission checks (`canUseTool`), asked as ACP v2 permission
 * requests.
 *
 * The request is built and its answer read by the same helpers as on v1
 * (`permissions/*`), so a v2 client gets the same options and the same
 * effects of each.
 */
import type { RequestPermissionResponse, ToolCallUpdate } from "@agentclientprotocol/sdk/unstable";
import type * as v2 from "@agentclientprotocol/sdk/experimental/v2/unstable";
import type { CanUseTool, PermissionMode, PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import { previewPatchContent } from "../diff.js";
import { normalizeDurablePermissionChangeSet } from "../permissions/normalization.js";
import { buildClaudePermissionOptions } from "../permissions/options.js";
import {
  airPermissionMeta,
  buildClaudePermissionPresentation,
  permissionToolCallMeta,
  type AcpPermissionRequest,
} from "../permissions/presentation.js";
import { decodeClaudePermissionResponse } from "../permissions/response.js";
import { ClientCapabilities } from "../tool-calls/client-capabilities.js";
import type { ClearContextReset } from "../clear-context-coordinator.js";
import type { RequestTarget } from "./tasks.js";
import { v2ToolCallPatch } from "./tool-call.js";

const V2_CAPABILITIES = ClientCapabilities.from(undefined, { v2: true });

/** What a permission check needs of its root session. */
export interface PermissionHost {
  /**
   * The client is JetBrains AIR: a request carries the AIR permission
   * presentation, and its tool call the AIR `_meta.claudeCode` (see
   * `permissionToolCallMeta`).
   */
  readonly airClient: boolean;
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
  /** The mode the session left when it entered plan mode, while it is in plan. */
  prePlanMode(): string | undefined;
  /** An allowed answer, with a mode the model cannot serve set as its fallback (see `config.ts`). */
  permissionAllowed(result: PermissionResult): Promise<PermissionResult>;
  /**
   * Whether ExitPlanMode of the agent `agentId` offers to clear the context
   * (see `ClearContext`), and how much of the context is in use.
   */
  contextReset(agentId: string | undefined): { offered: boolean; usedPercent: number | undefined };
  /**
   * An ExitPlanMode answer that interrupts the cycle: "No, keep planning", or
   * a plan accepted with clearing the context (`reset`).
   */
  exitPlanInterrupting(toolUseId: string, reset: ClearContextReset | undefined): void;
  /**
   * A permission request of `target` is about to show the tool call
   * `toolCallId` of `toolName` (see `SessionTasks.requestShows`).
   */
  requestShows(target: RequestTarget, toolName: string, toolCallId: string): void;
  /** The subject's tool call, with the `_meta` that the client holds of it. */
  toolCallSubject<T extends ToolCallUpdate>(sessionId: string, toolCall: T): T;
  /**
   * Whether the tool use is of work that a cancel stopped before the client
   * saw it (see `StoppedWork`): it is denied without a request (see
   * {@link denyingStoppedWork}).
   */
  dropsToolUse(
    toolUseId: string,
    agentId: string | undefined,
    signal: AbortSignal,
  ): Promise<boolean>;
}

/**
 * Denies the tool uses of work that a cancel stopped before the client saw it
 * (see `StoppedWork`), without a request, before `inner` asks the client
 * anything: a permission request, or AskUserQuestion's questions. The client
 * was told that this work never ran.
 */
export function denyingStoppedWork(
  host: Pick<PermissionHost, "dropsToolUse">,
  inner: CanUseTool,
): CanUseTool {
  return async (toolName, toolInput, options) => {
    if (await host.dropsToolUse(options.toolUseID, options.agentID, options.signal)) {
      return { behavior: "deny", message: "The user cancelled this prompt." };
    }
    return inner(toolName, toolInput, options);
  };
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
      mcpServer,
    },
  ) => {
    // No persistent "always allow" when the user's own ask rule forced the
    // prompt, or when Claude Code says the rule it would write grants more
    // than this ask.
    const noPersistentRule = matchedAskRule !== undefined || suppressAlwaysAllowRule === true;
    const durableChangeSet = normalizeDurablePermissionChangeSet(suggestions, noPersistentRule);
    // A v2 diff cannot hold an Edit's snippet: the request shows the exact patch.
    const previewCwd = (await host.target(agentID)).cwd;
    const previewContent = await previewPatchContent(toolName, toolInput, previewCwd, "v2");
    // After the last await: a subagent announced meanwhile gets the request
    // on its own session.
    const target = await host.target(agentID);
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
    // The tool call keeps the v2 rendering that the stream gave it. An AIR
    // client also gets the heading and explanation in AIR's `_meta`.
    if (host.airClient && presentation.title) {
      presentation._meta = airPermissionMeta({
        title: presentation.title,
        description: presentation.description,
        defaultToNo,
      });
    }
    const toolCallMeta = permissionToolCallMeta({
      toolName,
      parentToolUseId: target.parentToolUseId,
      mcpServer,
      airClient: host.airClient,
    });
    if (toolCallMeta) presentation.toolCall._meta = toolCallMeta;
    const contextReset = host.contextReset(agentID);
    const options = buildClaudePermissionOptions({
      toolName,
      displayName,
      input: toolInput,
      cwd: target.cwd,
      durableChangeSet,
      allowPersistentOptions: !noPersistentRule,
      defaultToNo,
      availableModes: host.availableModes(),
      prePlanMode: host.prePlanMode(),
      allowContextReset: contextReset.offered,
      contextUsedPercent: contextReset.usedPercent,
    });
    // The stream never shows SandboxNetworkAccess's tool call: the client
    // gets it before the request, and its status after the answer.
    const networkAccess = toolName === "SandboxNetworkAccess";
    if (networkAccess) target.output.permissionToolCall(toolName, toolUseID, toolInput);
    host.requestShows(target, toolName, toolUseID);
    const toolCall = host.toolCallSubject(target.sessionId, presentation.toolCall);
    const response = v1PermissionResponse(
      await target.requestPermission(
        v2PermissionRequest({ ...presentation, toolCall, options, sessionId: target.sessionId }),
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
    const decision = decodeClaudePermissionResponse(
      response,
      toolName,
      toolInput,
      toolUseID,
      options,
      durableChangeSet,
    );
    const decoded = decision.permissionResult;
    if (toolName === "ExitPlanMode" && decoded.behavior === "deny" && decoded.interrupt === true) {
      const plan = typeof toolInput.plan === "string" ? toolInput.plan.trim() : "";
      host.exitPlanInterrupting(
        toolUseID,
        decision.contextResetMode && plan
          ? { toolUseId: toolUseID, plan, mode: decision.contextResetMode }
          : undefined,
      );
    }
    const permissionResult = await host.permissionAllowed(decoded);
    if (networkAccess) {
      target.output.toolCallStatus(
        toolUseID,
        permissionResult.behavior === "allow" ? "completed" : "failed",
      );
    }
    if (permissionResult.behavior === "allow") {
      const modeUpdate = permissionResult.updatedPermissions?.find(
        (update) => update.type === "setMode" && update.destination === "session",
      );
      if (modeUpdate?.type === "setMode") host.modeChanged(modeUpdate.mode);
    }
    return permissionResult;
  };
}

/**
 * The v2 form of a permission request.
 *
 * v1 asks about a tool call, whose title the prompt shows. v2 gives the prompt
 * its own `title` and `description`, which the presentation sets for a v2
 * client (`AcpPermissionRequest`), and asks about a `subject`: here always the tool
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
 * user dismissed the prompt or the client declined it by policy. So the v2
 * core reads a `cancelled` outcome as the user refusing the tool, unless a
 * `session/cancel` is stopping the session's work: then the tool use is
 * aborted, as on v1 (`canUseTool`).
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
