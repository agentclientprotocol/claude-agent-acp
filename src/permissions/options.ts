import type { PermissionOption } from "@agentclientprotocol/sdk";
import {
  buildEditPermissionOptions,
  buildGlobPermissionOptions,
  buildGrepPermissionOptions,
  buildNotebookEditPermissionOptions,
  buildReadPermissionOptions,
  buildWritePermissionOptions,
} from "./options/filesystem.js";
import { buildBashPermissionOptions, buildPowerShellPermissionOptions } from "./options/shell.js";
import type { PermissionOptionContext } from "./options/shared.js";
import {
  buildComputerUseMcpPermissionOptions,
  buildEnterPlanModePermissionOptions,
  buildExitPlanModePermissionOptions,
  buildFallbackPermissionOptions,
  buildSandboxNetworkPermissionOptions,
  buildSkillPermissionOptions,
  buildWebFetchPermissionOptions,
  isComputerUseMcpTool,
} from "./options/tools.js";

export { PERMISSION_OPTION_ID } from "./options/shared.js";

export function buildClaudePermissionOptions(context: PermissionOptionContext): PermissionOption[] {
  // ACP has no "pre-selected option" field, so option order is the only lever
  // for the CLI's `defaultToNo` hint ("open on the decline option"): lead with
  // the reject options instead of the approvals.
  const order = context.defaultToNo === true ? declineFirstOptionOrder : permissionOptionOrder;
  return buildUnsortedClaudePermissionOptions(context).sort(
    (left, right) => order(left) - order(right),
  );
}

function buildUnsortedClaudePermissionOptions(
  context: PermissionOptionContext,
): PermissionOption[] {
  if (isComputerUseMcpTool(context.toolName)) {
    return buildComputerUseMcpPermissionOptions(context);
  }
  switch (context.toolName) {
    case "AskUserQuestion":
      throw new Error("AskUserQuestion must be handled by ACP elicitation, not permission options");
    case "Bash":
      return buildBashPermissionOptions(context);
    case "PowerShell":
      return buildPowerShellPermissionOptions(context);
    case "Read":
      return buildReadPermissionOptions(context);
    case "Glob":
      return buildGlobPermissionOptions(context);
    case "Grep":
      return buildGrepPermissionOptions(context);
    case "Edit":
      return buildEditPermissionOptions(context);
    case "Write":
      return buildWritePermissionOptions(context);
    case "NotebookEdit":
      return buildNotebookEditPermissionOptions(context);
    case "WebFetch":
      return buildWebFetchPermissionOptions(context);
    case "Skill":
      return buildSkillPermissionOptions(context);
    case "EnterPlanMode":
      return buildEnterPlanModePermissionOptions();
    case "ExitPlanMode":
      return buildExitPlanModePermissionOptions(context);
    case "SandboxNetworkAccess":
      return buildSandboxNetworkPermissionOptions(context);
    case "WebSearch":
    case "Agent":
    case "Task":
    default:
      return buildFallbackPermissionOptions(context);
  }
}

function declineFirstOptionOrder(option: PermissionOption): number {
  switch (option.kind) {
    case "reject_once":
    case "reject_always":
      return 0;
    default:
      return 1 + permissionOptionOrder(option);
  }
}

function permissionOptionOrder(option: PermissionOption): number {
  switch (option.kind) {
    case "allow_once":
      return 0;
    case "allow_always":
      return 1;
    case "reject_once":
    case "reject_always":
      return 3;
    default:
      return 2;
  }
}
