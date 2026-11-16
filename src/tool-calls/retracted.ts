import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

/** The most assistant messages whose tool uses are kept. The oldest are dropped. */
const MAX_MESSAGES = 1000;

/**
 * The tool uses of the assistant messages that Claude Code sent, by message
 * `uuid`, to find the tool calls of a message that Claude Code takes back.
 *
 * Claude Code takes back the response of a model that refuses, and retries on
 * the fallback model. It stops the tool calls of that response that have no
 * result yet, and sends no result for them. It names the messages it took
 * back, by the `uuid` they were sent with:
 * - in `retracted_message_uuids` of the `model_refusal_fallback` notice;
 * - in `supersedes` of the first assistant message of the retry.
 *
 * Both name the same messages, so a tool call is given once. Since Claude
 * Code 2.1.323 `supersedes` also names a response whose tool call could not
 * be parsed, which Claude Code retries too. Such a response holds no tool
 * use: its stop reason is `tool_use` and it has no `tool_use` block.
 */
export class RetractedToolCalls {
  private readonly toolUses = new Map<string, string[]>();

  /** Records the tool uses of a complete assistant message. */
  sent(message: SDKMessage): void {
    if (message.type !== "assistant" || typeof message.uuid !== "string") return;
    const ids = toolUseIds(message);
    if (ids.length === 0) return;
    this.toolUses.delete(message.uuid);
    this.toolUses.set(message.uuid, ids);
    if (this.toolUses.size > MAX_MESSAGES) {
      this.toolUses.delete(this.toolUses.keys().next().value!);
    }
  }

  /**
   * The tool calls of the messages that `message` takes back, each given
   * once. A tool call that `message` makes itself is not among them: the
   * message that replaces another can hold the same tool use.
   */
  retractedBy(message: SDKMessage): string[] {
    const own = new Set(toolUseIds(message));
    const retracted: string[] = [];
    for (const uuid of retractedMessageUuids(message)) {
      for (const id of this.toolUses.get(uuid) ?? []) {
        if (!own.has(id)) retracted.push(id);
      }
      this.toolUses.delete(uuid);
    }
    return retracted;
  }
}

/** The `uuid`s of the messages that `message` says Claude Code took back. */
function retractedMessageUuids(message: SDKMessage): readonly string[] {
  if (message.type === "assistant") return message.supersedes ?? [];
  if (message.type === "system" && message.subtype === "model_refusal_fallback") {
    return message.retracted_message_uuids ?? [];
  }
  return [];
}

/** The ids of the tool uses of an assistant message. */
function toolUseIds(message: SDKMessage): string[] {
  if (message.type !== "assistant" || !Array.isArray(message.message.content)) return [];
  return message.message.content.flatMap((block) => (block.type === "tool_use" ? [block.id] : []));
}
