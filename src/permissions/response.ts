import type { RequestPermissionResponse } from "@agentclientprotocol/sdk";
import type { PermissionOption } from "@agentclientprotocol/sdk";
import type { PermissionMode, PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import type { DurablePermissionChangeSet } from "./normalization.js";
import { applyClaudePermissionSelection, parseClaudePermissionSelection } from "./effects.js";

export interface ClaudePermissionDecision {
  permissionResult: PermissionResult;
  contextResetMode?: PermissionMode;
}

/** Decode, validate, and interpret an ACP response exactly once. */
export function decodeClaudePermissionResponse(
  response: RequestPermissionResponse,
  toolName: string,
  input: Record<string, unknown>,
  toolUseID: string,
  offeredOptions: readonly PermissionOption[],
  durableChangeSet?: DurablePermissionChangeSet,
): ClaudePermissionDecision {
  const selection = parseClaudePermissionSelection(response, toolName);
  const offeredOption = offeredOptions.find((option) => option.optionId === selection.optionId);
  if (!offeredOption) {
    throw new Error(`Permission option was not offered: ${selection.optionId}`);
  }
  const permissionResult = applyClaudePermissionSelection(selection, {
    toolName,
    input,
    toolUseID,
    durableChangeSet,
  });
  return {
    permissionResult,
    ...(selection.contextResetMode ? { contextResetMode: selection.contextResetMode } : {}),
  };
}
