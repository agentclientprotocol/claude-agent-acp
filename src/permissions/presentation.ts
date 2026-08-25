import type { RequestPermissionRequest, ToolCallLocation } from "@agentclientprotocol/sdk";
import { toolInfoFromToolUse } from "../tools.js";

export interface ClaudePermissionPresentationInput {
  toolName: string;
  input: Record<string, unknown>;
  toolUseID: string;
  cwd?: string;
  supportsTerminalOutput?: boolean;
  blockedPath?: string;
  title?: string;
  displayName?: string;
  description?: string;
  decisionReason?: string;
}

function humanText(value: unknown, maxLength: number, singleLine = false): string | undefined {
  if (typeof value !== "string") return undefined;
  const withoutControls = Array.from(value)
    .filter((character) => {
      const code = character.charCodeAt(0);
      return !(
        code <= 0x08 ||
        code === 0x0b ||
        code === 0x0c ||
        (code >= 0x0e && code <= 0x1f) ||
        code === 0x7f
      );
    })
    .join("");
  const normalized = singleLine
    ? withoutControls.replace(/\s+/gu, " ").trim()
    : withoutControls.trim();
  return normalized && normalized.length <= maxLength ? normalized : undefined;
}

function compactText(value: unknown): string | undefined {
  return humanText(value, 160, true);
}

function withBlockedPath(
  locations: ToolCallLocation[] | undefined,
  blockedPath: unknown,
): ToolCallLocation[] | undefined {
  const path = humanText(blockedPath, 4_096, true);
  if (!path) return locations;
  const result = [...(locations ?? [])];
  if (!result.some((location) => location.path === path)) result.push({ path });
  return result;
}

export function buildClaudePermissionPresentation(
  value: ClaudePermissionPresentationInput,
): Pick<RequestPermissionRequest, "toolCall" | "_meta"> {
  const info = toolInfoFromToolUse(
    { id: value.toolUseID, name: value.toolName, input: value.input },
    value.supportsTerminalOutput ?? false,
    value.cwd,
  );
  const host =
    value.toolName === "SandboxNetworkAccess" ? compactText(value.input.host) : undefined;
  const isComputerUse = value.toolName.startsWith("mcp__computer-use__");
  const subjectTitle = host ?? (isComputerUse ? compactText(value.displayName) : undefined);
  const subjectContent =
    (host || isComputerUse) && info.content.length === 0
      ? [
          {
            type: "content" as const,
            content: {
              type: "text" as const,
              text: `\`\`\`json\n${JSON.stringify(value.input, null, 2)}\n\`\`\``,
            },
          },
        ]
      : info.content;
  // Reuse the exact standard tool-call heading as the permission heading so
  // the approval never maintains a second, divergent name for the operation.
  // decisionReason is temporarily exposed as the permission description so
  // its actual SDK values can be inspected; it remains diagnostic policy text.
  const shellTitle =
    value.toolName === "Bash" || value.toolName === "PowerShell"
      ? (compactText(value.input.description) ?? value.toolName)
      : undefined;
  const toolCallTitle = shellTitle ?? subjectTitle ?? info.title;
  const permissionTitle = value.toolName === "ExitPlanMode" ? "Ready to code?" : toolCallTitle;
  const title = humanText(permissionTitle, 4_000, true) ?? "Use tool?";
  const decisionReason = humanText(value.decisionReason, 4_000);
  const description = decisionReason ? `Reason: ${decisionReason}` : undefined;
  return {
    toolCall: {
      toolCallId: value.toolUseID,
      name: value.toolName,
      status: "pending",
      rawInput: value.input,
      ...info,
      title: toolCallTitle,
      content: subjectContent,
      locations: withBlockedPath(info.locations, value.blockedPath),
    },
    ...(title
      ? {
          _meta: {
            permission: {
              version: 1,
              title,
              ...(description ? { description } : {}),
            },
          },
        }
      : {}),
  };
}
