/**
 * The PreToolUse hook that shows an Edit's or Write's exact patch before the
 * tool runs, as the bridge does (`ClaudeAcpAgent.fileChangePreviewHook`).
 *
 * A v2 diff cannot hold the input's snippet, so without it an auto-approved
 * Edit would show its change only once it is done. Claude Code runs the tool
 * only after the hook returns, so the file is still as it was, and the patch
 * is the one a permission request for the tool would show. The hook makes no
 * permission decision, and a failure only leaves the preview out.
 */
import type { HookCallbackMatcher } from "@anthropic-ai/claude-agent-sdk";
import type { Logger } from "../acp-agent.js";
import { previewPatchContent } from "../diff.js";
import type { RequestTarget } from "./tasks.js";

/** The session of a tool use: the root's, or a subagent's (`agentId`). */
export type PreviewTargets = (agentId: string | undefined) => Promise<RequestTarget>;

export function fileChangePreviewHook(
  targets: PreviewTargets,
  logger: Logger,
): HookCallbackMatcher {
  return {
    matcher: "Edit|Write",
    hooks: [
      async (input, toolUseID) => {
        if (input.hook_event_name !== "PreToolUse" || !toolUseID) return { continue: true };
        try {
          const target = await targets(input.agent_id);
          // The work a cancel stopped shows nothing, as in `canUseTool`.
          if (target.cancelling()) return { continue: true };
          const toolInput = (input.tool_input ?? {}) as Record<string, unknown>;
          const content = await previewPatchContent(input.tool_name, toolInput, target.cwd, "v2");
          if (content) target.output.preview(input.tool_name, toolUseID, toolInput, content);
        } catch (error) {
          logger.error(`Failed to preview ${toolUseID}:`, error);
        }
        return { continue: true };
      },
    ],
  };
}
