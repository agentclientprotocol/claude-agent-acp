import { type PromptRequest, RequestError } from "@agentclientprotocol/sdk";

/**
 * Rewrites `acp-session://reference?sessionId=…` resource links into a short,
 * self-describing session mention.
 *
 * There is no standard to follow here. ACP defines `resource_link` but no
 * convention for pointing at another agent session; Codex's `codex://threads/<id>`
 * is a desktop deep link the app resolves, not something a model is expected to
 * act on; and the `prompt:` URI scheme (draft-boone-prompt-uri-scheme) is an
 * individual Internet-Draft with no adoption. So this is our own convention, and
 * it is aimed at the model rather than at a URL handler: say "session", give the
 * id, keep it to one line.
 *
 * The referenced transcript is deliberately *not* inlined -- a chat is usually far
 * larger than the part that matters, and the session-management tools read it on
 * demand. The mention does not explain those tools either; their own descriptions
 * do. And `acp-session:` is the client's wire format, which means nothing to the
 * model, so it stops at this boundary.
 */
export function resolveSessionResourceLinks(prompt: PromptRequest): PromptRequest {
  const resolved: PromptRequest["prompt"] = [];
  for (const block of prompt.prompt) {
    if (block.type !== "resource_link") {
      resolved.push(block);
      continue;
    }
    const sessionId = acpSessionId(block.uri);
    if (sessionId === null) {
      resolved.push(block);
      continue;
    }
    if (sessionId === prompt.sessionId) {
      throw RequestError.invalidParams(undefined, "A session cannot reference itself");
    }
    resolved.push({
      type: "text",
      text: sessionMention(sessionId, block.name),
    });
  }
  return { ...prompt, prompt: resolved };
}

/** One line, in the position the link occupied. */
function sessionMention(sessionId: string, title: string): string {
  const label = title ? `Claude session "${title}"` : "Claude session";
  return `[${label}](claude://sessions/${encodeURIComponent(sessionId)})`;
}

function acpSessionId(uri: string): string | null {
  try {
    const parsed = new URL(uri);
    if (parsed.protocol !== "acp-session:" || parsed.hostname !== "reference") return null;
    return parsed.searchParams.get("sessionId")?.trim() || null;
  } catch {
    return null;
  }
}
