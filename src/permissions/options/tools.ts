import type { PermissionOption } from "@agentclientprotocol/sdk";
import {
  allowOnce,
  exactLocalAllowRule,
  isMcpAllowChangeSet,
  PERMISSION_OPTION_ID,
  plainString,
  type PermissionOptionContext,
  reject,
  withGeneratedUpdate,
  withOptionalUpdate,
} from "./shared.js";

export function buildWebFetchPermissionOptions(
  context: PermissionOptionContext,
): PermissionOption[] {
  const url = plainString(context.input.url);
  if (url && context.allowPersistentOptions !== false) {
    try {
      const hostname = new URL(url).hostname;
      if (hostname) {
        return withGeneratedUpdate(`Yes, and don't ask again for ${hostname}`);
      }
    } catch {
      // Invalid input cannot produce Claude Code's domain-specific option.
    }
  }
  return [allowOnce(), reject("No")];
}

export function buildSkillPermissionOptions(context: PermissionOptionContext): PermissionOption[] {
  const skill = plainString(context.input.skill);
  const options = [allowOnce()];
  if (skill && context.allowPersistentOptions !== false) {
    options.push({
      optionId: PERMISSION_OPTION_ID.allowSkillExact,
      name: `Yes, and don't ask again for ${skill}`,
      kind: "allow_always",
    });
    const spaceIndex = skill.indexOf(" ");
    if (spaceIndex > 0) {
      const prefix = `${skill.slice(0, spaceIndex)}:*`;
      options.push({
        optionId: PERMISSION_OPTION_ID.allowSkillPrefix,
        name: `Yes, and don't ask again for ${prefix} commands`,
        kind: "allow_always",
      });
    }
  }
  options.push(reject("No"));
  return options;
}

export function buildEnterPlanModePermissionOptions(): PermissionOption[] {
  return [allowOnce("Yes, enter plan mode"), reject("No, start implementing now")];
}

export function buildExitPlanModePermissionOptions(
  context: PermissionOptionContext,
): PermissionOption[] {
  const modes = new Set(context.availableModes);
  const options: PermissionOption[] = [];
  // Claude Code offers bypass only when the user launched with it, so it can
  // prefer bypass outright. The adapter advertises bypass by default, so Auto
  // leads unless the session was in bypass before entering plan mode. Both stay
  // selectable: they have different permission semantics.
  const elevatedModes = (
    context.prePlanMode === "bypassPermissions"
      ? (["bypassPermissions", "auto"] as const)
      : (["auto", "bypassPermissions"] as const)
  ).filter((mode) => modes.has(mode));
  const preferredMode = elevatedModes[0] ?? "acceptEdits";
  if (plainString(context.input.plan)) {
    const usage =
      context.contextUsedPercent === undefined ? "" : ` (${context.contextUsedPercent}% used)`;
    options.push(
      preferredMode === "auto"
        ? {
            optionId: PERMISSION_OPTION_ID.exitPlanClearAuto,
            name: `Yes, clear context${usage} and use auto mode`,
            kind: "allow_always",
          }
        : preferredMode === "bypassPermissions"
          ? {
              optionId: PERMISSION_OPTION_ID.exitPlanClearBypass,
              name: `Yes, clear context${usage} and bypass permissions`,
              kind: "allow_always",
            }
          : {
              optionId: PERMISSION_OPTION_ID.exitPlanClearAcceptEdits,
              name: `Yes, clear context${usage} and auto-accept edits`,
              kind: "allow_always",
            },
    );
  }
  for (const mode of elevatedModes) {
    options.push(
      mode === "auto"
        ? {
            optionId: PERMISSION_OPTION_ID.exitPlanAuto,
            name: "Yes, and use auto mode",
            kind: "allow_always",
          }
        : {
            optionId: PERMISSION_OPTION_ID.exitPlanBypass,
            name: "Yes, and bypass permissions",
            kind: "allow_always",
          },
    );
  }
  if (elevatedModes.length === 0) {
    options.push({
      optionId: PERMISSION_OPTION_ID.exitPlanAcceptEdits,
      name: "Yes, auto-accept edits",
      kind: "allow_always",
    });
  }
  options.push({
    optionId: PERMISSION_OPTION_ID.exitPlanDefault,
    name: "Yes, manually approve edits",
    kind: "allow_once",
  });
  options.push(reject("No, keep planning"));
  return options;
}

export function buildSandboxNetworkPermissionOptions(
  context: PermissionOptionContext,
): PermissionOption[] {
  const host = plainString(context.input.host);
  const name =
    host && exactLocalAllowRule(context.durableChangeSet, context.toolName, host)
      ? `Yes, and don't ask again for ${host}`
      : undefined;
  return withOptionalUpdate(context.durableChangeSet, name, "Yes", "No");
}

export function buildFallbackPermissionOptions(
  context: PermissionOptionContext,
): PermissionOption[] {
  const toolLabel = plainString(context.displayName) ?? context.toolName;
  if (context.toolName.startsWith("mcp__")) {
    const changeSet =
      context.allowPersistentOptions !== false &&
      isMcpAllowChangeSet(context.durableChangeSet, context.toolName)
        ? context.durableChangeSet
        : undefined;
    return withOptionalUpdate(
      changeSet,
      changeSet ? `Yes, and don't ask again for ${toolLabel} commands` : undefined,
    );
  }
  if (context.allowPersistentOptions !== false) {
    return withGeneratedUpdate(`Yes, and don't ask again for ${toolLabel} commands`);
  }
  return [allowOnce(), reject("No")];
}

const COMPUTER_USE_MCP_TOOL_PREFIX = "mcp__computer-use__";

export function isComputerUseMcpTool(toolName: string): boolean {
  return toolName.startsWith(COMPUTER_USE_MCP_TOOL_PREFIX);
}

export function buildComputerUseMcpPermissionOptions(
  context: PermissionOptionContext,
): PermissionOption[] {
  const toolLabel = plainString(context.displayName) ?? context.toolName;
  const changeSet =
    context.allowPersistentOptions !== false &&
    isMcpAllowChangeSet(context.durableChangeSet, context.toolName)
      ? context.durableChangeSet
      : undefined;
  return withOptionalUpdate(
    changeSet,
    changeSet ? `Yes, and don't ask again for ${toolLabel}` : undefined,
  );
}
