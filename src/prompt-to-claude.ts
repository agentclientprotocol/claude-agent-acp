/**
 * The conversion of an ACP prompt into the Claude Code user message.
 */
import type { PromptRequest } from "@agentclientprotocol/sdk/unstable";
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { blobResourceToClaude } from "./blob-resources.js";

function formatUriAsLink(uri: string): string {
  try {
    if (uri.startsWith("file://")) {
      const path = uri.slice(7); // Remove "file://"
      const name = path.split("/").pop() || path;
      return `[@${name}](${uri})`;
    } else if (uri.startsWith("zed://")) {
      const parts = uri.split("/");
      const name = parts[parts.length - 1] || uri;
      return `[@${name}](${uri})`;
    }
    return uri;
  } catch {
    return uri;
  }
}

/** The prompt content block types that `promptToClaude` converts. The agent
 *  advertises no `audio` prompt capability. */
export const SUPPORTED_PROMPT_CONTENT_TYPES: readonly string[] = [
  "text",
  "image",
  "resource_link",
  "resource",
];

export function promptToClaude(prompt: PromptRequest): SDKUserMessage {
  const content: any[] = [];
  const context: any[] = [];

  const firstText = prompt.prompt.find((chunk) => chunk.type === "text");
  for (const chunk of prompt.prompt) {
    switch (chunk.type) {
      case "text": {
        let text = chunk.text;
        // A slash command is the first text block. Change
        // `/mcp:server:command args` to `/server:command (MCP) args`; the
        // arguments can span lines.
        const mcpMatch =
          chunk === firstText ? text.match(/^\/mcp:([^:\s]+):(\S+)(?:\s+([\s\S]*))?$/) : null;
        if (mcpMatch) {
          const [, server, command, args] = mcpMatch;
          text = `/${server}:${command} (MCP)${args ? ` ${args}` : ""}`;
        }
        content.push({ type: "text", text });
        break;
      }
      case "resource_link": {
        const formattedUri = formatUriAsLink(chunk.uri);
        content.push({
          type: "text",
          text: formattedUri,
        });
        break;
      }
      case "resource": {
        const { uri } = chunk.resource;
        // A blob resource becomes an image or document block, or its decoded
        // text. A v1 prompt skips a blob of any other type, e.g.
        // `application/zip`; a v2 prompt rejects it (see `v1PromptRequest`).
        const blob = "blob" in chunk.resource ? blobResourceToClaude(chunk.resource) : undefined;
        const text =
          "text" in chunk.resource
            ? chunk.resource.text
            : blob?.kind === "text"
              ? blob.text
              : undefined;
        if (blob?.kind === "image" || blob?.kind === "document") {
          content.push({ type: "text", text: formatUriAsLink(uri) }, blob.block);
        } else if (text !== undefined) {
          content.push({ type: "text", text: formatUriAsLink(uri) });
          context.push({
            type: "text",
            text: `\n<context ref="${uri}">\n${text}\n</context>`,
          });
        }
        break;
      }
      case "image":
        if (chunk.data) {
          content.push({
            type: "image",
            source: {
              type: "base64",
              data: chunk.data,
              media_type: chunk.mimeType,
            },
          });
        } else if (chunk.uri && chunk.uri.startsWith("http")) {
          content.push({
            type: "image",
            source: {
              type: "url",
              url: chunk.uri,
            },
          });
        }
        break;
      // Ignore audio and other unsupported types
      default:
        break;
    }
  }

  content.push(...context);

  return {
    type: "user",
    message: {
      role: "user",
      content: content,
    },
    session_id: prompt.sessionId,
    parent_tool_use_id: null,
    // ACP prompts are the user's own input relayed by the client. Stamp the
    // provenance explicitly: per the SDK, a host wrapping keyboard input must
    // send `{kind: "human"}` — an absent `origin` is treated as unattributed
    // and fails closed at the CLI's strict isHuman() trust gates (e.g. the
    // ultracode keyword opt-in honors only human-originated turns).
    origin: { kind: "human" },
  };
}
