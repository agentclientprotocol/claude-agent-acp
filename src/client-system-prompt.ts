/**
 * The client-provided system prompt of the unstable `systemPrompt` field on
 * `session/new`, `session/load`, `session/resume`, and `session/fork`.
 *
 * - `append` keeps the Claude Code preset and adds the text after it, the
 *   SDK's `{ type: "preset", preset: "claude_code", append }`.
 * - `override` replaces the Claude Code preset with the text, the SDK's custom
 *   string prompt. Tools, MCP servers, permissions, and settings (including the
 *   CLAUDE.md files that `settingSources` loads) are unchanged.
 *
 * The CLI records the system prompt of a conversation on its first request
 * and reuses it on resume, so a different `systemPrompt` on a later
 * `session/resume` takes effect at the next compaction. The RFD allows this
 * deferral.
 */
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import {
  RequestError,
  type SessionCapabilities,
  type SystemPrompt,
} from "@agentclientprotocol/sdk";

/** The `sessionCapabilities.systemPrompt` the agent advertises: both modes. */
export const SYSTEM_PROMPT_CAPABILITY = {
  mode: { override: {} },
} satisfies NonNullable<SessionCapabilities["systemPrompt"]>;

export type ClientSystemPrompt = { mode: "append" | "override"; text: string };

/**
 * The mode and text of a `systemPrompt`, or `undefined` when the request has
 * none. Throws `invalid_params` for a mode other than `append` and `override`
 * and for a content block other than text: the RFD requires an error, and no
 * session, for a prompt the agent cannot apply.
 */
export function clientSystemPrompt(
  systemPrompt: SystemPrompt | null | undefined,
): ClientSystemPrompt | undefined {
  if (systemPrompt == null) return undefined;
  const { mode, content } = systemPrompt;
  if (mode !== "append" && mode !== "override") {
    throw RequestError.invalidParams(
      { systemPrompt: { mode } },
      `Unsupported systemPrompt mode: ${mode}`,
    );
  }
  const text: string[] = [];
  for (const block of content) {
    if (block.type !== "text") {
      throw RequestError.invalidParams(
        { systemPrompt: { content: { type: block.type } } },
        `systemPrompt content must be text, but received a ${block.type} block`,
      );
    }
    text.push(block.text);
  }
  return { mode, text: text.join("\n\n") };
}

/**
 * The SDK `systemPrompt` option for a client system prompt. `customInstructions`
 * (AIR's `customInstructions` on `session/new` metadata) still follows the
 * client text in both modes.
 */
export function sdkSystemPrompt(
  prompt: ClientSystemPrompt,
  customInstructions: string | undefined,
): NonNullable<Options["systemPrompt"]> {
  const text = [prompt.text, customInstructions].filter((part) => part).join("\n\n");
  if (prompt.mode === "override") return text;
  return text
    ? { type: "preset", preset: "claude_code", append: text }
    : { type: "preset", preset: "claude_code" };
}
