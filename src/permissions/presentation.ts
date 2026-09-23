import type { RequestPermissionRequest, ToolCallContent } from "@agentclientprotocol/sdk";
import { AIR_PERMISSION_KEY, withAirMeta } from "../air-extension.js";
import { ClientCapabilities } from "../tool-calls/client-capabilities.js";
import { AcpToolCallRenderer } from "../tool-calls/renderer.js";

export interface ClaudePermissionPresentationInput {
  toolName: string;
  input: Record<string, unknown>;
  toolUseID: string;
  cwd?: string;
  capabilities?: ClientCapabilities;
  /** The exact patch of the change to approve, for a negotiated `diffPatch` client. */
  previewContent?: ToolCallContent[];
  blockedPath?: string;
  title?: string;
  displayName?: string;
  description?: string;
  decisionReason?: string;
  defaultToNo?: boolean;
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

/**
 * The permission request presentation.
 *
 * The request `toolCall` carries `toolCallId`, `title`, and `rawInput`. The
 * adapter emits the `tool_call` before the request, so the client already
 * holds the rest. The request adds only what it shows new: the exact preview
 * patch, and the blocked path when the tool call has no such location.
 */
export function buildClaudePermissionPresentation(
  value: ClaudePermissionPresentationInput,
): Pick<RequestPermissionRequest, "toolCall" | "_meta"> {
  const capabilities = value.capabilities ?? new ClientCapabilities();
  const renderer = new AcpToolCallRenderer(capabilities);
  const toolUse = { id: value.toolUseID, name: value.toolName, input: value.input };
  const facts = renderer.facts(toolUse, value.cwd);
  const host =
    value.toolName === "SandboxNetworkAccess" ? compactText(value.input.host) : undefined;
  const isComputerUse = value.toolName.startsWith("mcp__computer-use__");
  const subjectTitle = host ?? (isComputerUse ? compactText(value.displayName) : undefined);
  // Reuse the exact standard tool-call heading as the permission heading so
  // the approval never maintains a second, divergent name for the operation.
  // decisionReason is temporarily exposed as the permission description so
  // its actual SDK values can be inspected; it remains diagnostic policy text.
  const toolCallTitle = subjectTitle ?? facts.title;
  const permissionTitle = value.toolName === "ExitPlanMode" ? "Ready to code?" : toolCallTitle;
  // Shell titles are executable input: compacting whitespace changes quoted
  // arguments and comment boundaries, and length limits can hide the command.
  const title =
    value.toolName === "Bash" || value.toolName === "PowerShell"
      ? permissionTitle
      : (humanText(permissionTitle, 4_000, true) ?? "Use tool?");
  const decisionReason = humanText(value.decisionReason, 4_000);
  const description = decisionReason ? `Reason: ${decisionReason}` : undefined;
  const blockedPath = humanText(value.blockedPath, 4_096, true);
  const extraLocations =
    blockedPath && !(facts.locations ?? []).some((location) => location.path === blockedPath)
      ? [{ path: blockedPath }]
      : undefined;
  return {
    toolCall: renderer.permissionToolCall(toolUse, {
      cwd: value.cwd,
      title: toolCallTitle,
      previewContent: value.previewContent,
      extraLocations,
      // The upstream request shows the input of a network or computer-use
      // request that has no content of its own.
      fallbackContent:
        host || isComputerUse
          ? [
              {
                type: "content" as const,
                content: {
                  type: "text" as const,
                  text: `\`\`\`json\n${JSON.stringify(value.input, null, 2)}\n\`\`\``,
                },
              },
            ]
          : undefined,
    }),
    // Only AIR gets the permission presentation.
    ...(title && capabilities.air.client
      ? {
          _meta: withAirMeta(undefined, AIR_PERMISSION_KEY, {
            version: 1,
            title,
            ...(description ? { description } : {}),
            // The CLI's own hint, forwarded so a client that can pre-select
            // an option keeps the decline focused; the option order already
            // leads with the reject options when this is set.
            ...(value.defaultToNo === true ? { defaultToNo: true } : {}),
          }),
        }
      : {}),
  };
}
