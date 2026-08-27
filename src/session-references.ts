import { type PromptRequest, RequestError } from "@agentclientprotocol/sdk";
import { getSessionMessages } from "@anthropic-ai/claude-agent-sdk";

export async function resolveSessionResourceLinks(
  prompt: PromptRequest,
  cwd: string,
): Promise<PromptRequest> {
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
    const messages = await getSessionMessages(sessionId, {
      dir: cwd,
      includeSystemMessages: true,
    });
    resolved.push({
      type: "resource",
      resource: {
        uri: block.uri,
        mimeType: "application/json",
        text: JSON.stringify({
          type: "session_reference",
          sessionId,
          title: block.name,
          messages,
        }),
      },
    });
  }
  return { ...prompt, prompt: resolved };
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
