/**
 * Test shorthands for the shared tool call renderer: one tool use or tool
 * result, rendered for a client with the given capabilities. Production code
 * renders through {@link AcpToolCallRenderer} directly.
 */
import type {
  ToolCallContent,
  ToolCallLocation,
  ToolKind,
} from "@agentclientprotocol/sdk/unstable";
import { stripLocalCommandMetadata } from "../message-filters.js";
import { ClientCapabilities } from "../tool-calls/client-capabilities.js";
import type { ToolResultBlock } from "../tool-calls/content.js";
import { AcpToolCallRenderer, type RenderedResult } from "../tool-calls/renderer.js";

/**
 * The title, kind, content, and locations of a tool use, for a client with the
 * given terminal and patch capabilities. The {@link AcpToolCallRenderer} builds
 * them from the facts of the tool reporter.
 */
export function toolInfoFromToolUse(
  toolUse: any,
  supportsTerminalOutput: boolean = false,
  cwd?: string,
  supportsDiffPatch: boolean = false,
): {
  title: string;
  kind: ToolKind;
  content: ToolCallContent[];
  locations?: ToolCallLocation[];
} {
  const renderer = new AcpToolCallRenderer(
    new ClientCapabilities(supportsTerminalOutput, false, supportsDiffPatch),
  );
  return renderer.toolInfo({ id: toolUse?.id, name: toolUse?.name, input: toolUse?.input }, cwd);
}

/**
 * The result fields of a tool result, for a client with the given terminal
 * capabilities. The {@link AcpToolCallRenderer} builds them from the facts of
 * the tool reporter.
 */
export function toolUpdateFromToolResult(
  toolResult: ToolResultBlock,
  toolUse: any | undefined,
  supportsTerminalOutput: boolean = false,
  toolUseResult?: unknown,
  preferTerminalOutputDelta: boolean = false,
): RenderedResult {
  const renderer = new AcpToolCallRenderer(
    new ClientCapabilities(supportsTerminalOutput, preferTerminalOutputDelta),
  );
  return renderer.resultFields(
    { id: toolUse?.id, name: toolUse?.name ?? "", input: toolUse?.input },
    toolResult as Parameters<AcpToolCallRenderer["resultFields"]>[1],
    toolUseResult,
  );
}

/** Whether `content` is only Claude Code's local-command metadata, which the agent drops. */
export function isLocalCommandMetadata(content: unknown): boolean {
  return stripLocalCommandMetadata(content) === null;
}
