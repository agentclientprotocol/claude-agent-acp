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
  buildMonitorPermissionOptions,
  buildReviewArtifactPermissionOptions,
  buildSandboxNetworkPermissionOptions,
  buildSkillPermissionOptions,
  buildWebFetchPermissionOptions,
  buildWorkflowPermissionOptions,
  isComputerUseMcpTool,
} from "./options/tools.js";

export { PERMISSION_OPTION_ID } from "./options/shared.js";

export function buildClaudePermissionOptions(context: PermissionOptionContext): PermissionOption[] {
  return buildUnsortedClaudePermissionOptions(context).sort(
    (left, right) => permissionOptionOrder(left) - permissionOptionOrder(right),
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
    case "ReviewArtifact":
      return buildReviewArtifactPermissionOptions(context);
    case "Workflow":
      return buildWorkflowPermissionOptions(context);
    case "Monitor":
      return buildMonitorPermissionOptions(context);
    case "WebSearch":
    case "Agent":
    case "Task":
    default:
      return buildFallbackPermissionOptions(context);
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
