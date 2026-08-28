import { RequestError } from "@agentclientprotocol/sdk";

/**
 * Rewrites an `acp-session://reference?sessionId=…` resource link into a short,
 * self-describing session mention. Returns `null` for any other link, so the
 * caller falls through to its normal resource-link handling.
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
export function sessionMentionForLink(
  uri: string,
  name: string,
  activeSessionId: string,
): string | null {
  // A string compare first, so ordinary `file://` links never reach the parser.
  if (!uri.startsWith("acp-session:")) return null;
  const sessionId = acpSessionId(uri);
  if (sessionId === null) return null;
  if (sessionId === activeSessionId) {
    throw RequestError.invalidParams(undefined, "A session cannot reference itself");
  }
  const label = name ? `Claude session "${name}"` : "Claude session";
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
