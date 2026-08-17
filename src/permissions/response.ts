import type { RequestPermissionResponse } from "@agentclientprotocol/sdk";
import type { PermissionOption } from "@agentclientprotocol/sdk";
import type { PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import type { DurablePermissionChangeSet } from "./normalization.js";
import { applyClaudePermissionSelection, parseClaudePermissionSelection } from "./effects.js";

export function mapClaudePermissionResponse(
  response: RequestPermissionResponse,
  toolName: string,
  input: Record<string, unknown>,
  toolUseID: string,
  offeredOptions: readonly PermissionOption[],
  durableChangeSet?: DurablePermissionChangeSet,
): PermissionResult {
  const selection = parseClaudePermissionSelection(response);
  const offeredOption = offeredOptions.find((option) => option.optionId === selection.optionId);
  if (!offeredOption) {
    throw new Error(`Permission option was not offered: ${selection.optionId}`);
  }
  return applyClaudePermissionSelection(selection, {
    toolName,
    input,
    toolUseID,
    durableChangeSet,
  });
}
