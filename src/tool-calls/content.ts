import type { ContentBlock, ToolCallContent } from "@agentclientprotocol/sdk";
import {
  DocumentBlockParam,
  ImageBlockParam,
  TextBlockParam,
  ToolResultBlockParam,
  WebSearchResultBlock,
  WebSearchToolResultBlockParam,
  WebSearchToolResultError,
} from "@anthropic-ai/sdk/resources";
import {
  BetaBashCodeExecutionResultBlock,
  BetaBashCodeExecutionToolResultBlockParam,
  BetaBashCodeExecutionToolResultError,
  BetaCodeExecutionResultBlock,
  BetaCodeExecutionToolResultBlockParam,
  BetaCodeExecutionToolResultError,
  BetaImageBlockParam,
  BetaRequestMCPToolResultBlockParam,
  BetaTextEditorCodeExecutionCreateResultBlock,
  BetaTextEditorCodeExecutionStrReplaceResultBlock,
  BetaTextEditorCodeExecutionToolResultBlockParam,
  BetaTextEditorCodeExecutionToolResultError,
  BetaTextEditorCodeExecutionViewResultBlock,
  BetaToolReferenceBlock,
  BetaToolResultBlockParam,
  BetaToolSearchToolResultBlockParam,
  BetaToolSearchToolResultError,
  BetaToolSearchToolSearchResultBlock,
  BetaWebFetchBlock,
  BetaWebFetchToolResultBlockParam,
  BetaWebFetchToolResultErrorBlock,
  BetaWebSearchToolResultBlockParam,
} from "@anthropic-ai/sdk/resources/beta.mjs";
import path from "node:path";

/**
 * Union of all possible content types that can appear in tool results from the Anthropic SDK.
 * These are transformed to valid ACP ContentBlock types by toValidAcpContent().
 */
export type ToolResultContent =
  | TextBlockParam
  | DocumentBlockParam
  | ImageBlockParam
  | BetaImageBlockParam
  | BetaToolReferenceBlock
  | BetaToolSearchToolSearchResultBlock
  | BetaToolSearchToolResultError
  | WebSearchResultBlock
  | WebSearchToolResultError
  | BetaWebFetchBlock
  | BetaWebFetchToolResultErrorBlock
  | BetaCodeExecutionResultBlock
  | BetaCodeExecutionToolResultError
  | BetaBashCodeExecutionResultBlock
  | BetaBashCodeExecutionToolResultError
  | BetaTextEditorCodeExecutionViewResultBlock
  | BetaTextEditorCodeExecutionCreateResultBlock
  | BetaTextEditorCodeExecutionStrReplaceResultBlock
  | BetaTextEditorCodeExecutionToolResultError;

/**
 * Convert an absolute file path to a project-relative path for display.
 * Returns the original path if it's outside the project directory or if no cwd is provided.
 */
export function toDisplayPath(filePath: string, cwd?: string): string {
  if (!cwd) return filePath;
  const resolvedCwd = path.resolve(cwd);
  const resolvedFile = path.resolve(filePath);
  if (resolvedFile.startsWith(resolvedCwd + path.sep) || resolvedFile === resolvedCwd) {
    return path.relative(resolvedCwd, resolvedFile);
  }
  return filePath;
}

/**
 * Narrow the untyped message-level `tool_use_result` toward a per-tool Output
 * shape: rejects everything but a plain non-null object (arrays pass a bare
 * `typeof === "object"` check, so they're excluded here). The returned value
 * is only *nominally* typed — it arrives over the wire from arbitrary CLI
 * versions, so each caller must still guard the specific fields it reads
 * before trusting them.
 */
export function structuredResult<T extends object>(toolUseResult: unknown): T | undefined {
  return toolUseResult !== null &&
    typeof toolUseResult === "object" &&
    !Array.isArray(toolUseResult)
    ? (toolUseResult as T)
    : undefined;
}

/** One display format for a web-search hit, shared by the structured
 *  WebSearchOutput render and the server-side `web_search_result` block so
 *  the two paths can't drift. */
export function formatWebSearchHit(hit: { title: string; url: string }): string {
  return `${hit.title} (${hit.url})`;
}

/** Human-readable size for the document placeholder ("312 B", "2.4 KB",
 *  "1.3 MB"). */
function formatByteSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function toAcpContentUpdate(
  content: any,
  isError: boolean = false,
): { content?: ToolCallContent[] } {
  if (Array.isArray(content) && content.length > 0) {
    return {
      content: content.map((c: any) => ({
        type: "content" as const,
        content: toAcpContentBlock(c, isError),
      })),
    };
  } else if (typeof content === "object" && content !== null && "type" in content) {
    return {
      content: [
        {
          type: "content" as const,
          content: toAcpContentBlock(content, isError),
        },
      ],
    };
  } else if (typeof content === "string" && content.length > 0) {
    return {
      content: [
        {
          type: "content",
          content: {
            type: "text",
            text: isError ? `\`\`\`\n${content}\n\`\`\`` : content,
          },
        },
      ],
    };
  }
  return {};
}

export function toAcpContentBlock(content: ToolResultContent, isError: boolean): ContentBlock {
  const wrapText = (text: string): ContentBlock => ({
    type: "text" as const,
    text: isError ? `\`\`\`\n${text}\n\`\`\`` : text,
  });

  switch (content.type) {
    case "text":
      return {
        type: "text" as const,
        text: isError ? `\`\`\`\n${content.text}\n\`\`\`` : content.text,
      };
    case "image":
      if (content.source.type === "base64") {
        return {
          type: "image" as const,
          data: content.source.data,
          mimeType: content.source.media_type,
        };
      }
      // URL and file-based images can't be converted to ACP format (requires data)
      return wrapText(
        content.source.type === "url"
          ? `[image: ${content.source.url}]`
          : "[image: file reference]",
      );

    case "document": {
      // A PDF Read delivers its raw `document` block inside the tool_result
      // content (SDK 0.3.243 moved it here from a separate follow-up user
      // message; the MultiRead documents lane always lived here). ACP has no
      // document block and the base64 payload can be megabytes — render a
      // compact placeholder, never the data, matching the CLI's own compact
      // "Read PDF (size)" rendering.
      const title =
        typeof content.title === "string" && content.title.length > 0 ? ` "${content.title}"` : "";
      const source = content.source;
      switch (source.type) {
        case "url":
          return wrapText(`[document${title}: ${source.url}]`);
        case "base64":
        case "text":
          // base64 inflates the byte count by 4/3; plain text is 1:1.
          return wrapText(
            `[document${title}: ${source.media_type}, ${formatByteSize(
              source.type === "base64"
                ? Math.floor((source.data.length * 3) / 4)
                : source.data.length,
            )}]`,
          );
        default:
          return wrapText(`[document${title}]`);
      }
    }
    case "tool_reference":
      return wrapText(`Tool: ${content.tool_name}`);
    case "tool_search_tool_search_result":
      return wrapText(
        `Tools found: ${content.tool_references.map((r) => r.tool_name).join(", ") || "none"}`,
      );
    case "tool_search_tool_result_error":
      return wrapText(
        `Error: ${content.error_code}${content.error_message ? ` - ${content.error_message}` : ""}`,
      );
    case "web_search_result":
      return wrapText(formatWebSearchHit(content));
    case "web_search_tool_result_error":
      return wrapText(`Error: ${content.error_code}`);
    case "web_fetch_result":
      return wrapText(`Fetched: ${content.url}`);
    case "web_fetch_tool_result_error":
      return wrapText(`Error: ${content.error_code}`);
    case "code_execution_result":
      return wrapText(`Output: ${content.stdout || content.stderr || ""}`);
    case "bash_code_execution_result":
      return wrapText(`Output: ${content.stdout || content.stderr || ""}`);
    case "code_execution_tool_result_error":
    case "bash_code_execution_tool_result_error":
      return wrapText(`Error: ${content.error_code}`);
    case "text_editor_code_execution_view_result":
      return wrapText(content.content);
    case "text_editor_code_execution_create_result":
      return wrapText(content.is_file_update ? "File updated" : "File created");
    case "text_editor_code_execution_str_replace_result":
      return wrapText(content.lines?.join("\n") || "");
    case "text_editor_code_execution_tool_result_error":
      return wrapText(
        `Error: ${content.error_code}${content.error_message ? ` - ${content.error_message}` : ""}`,
      );

    default:
      return wrapText(JSON.stringify(content));
  }
}

export function markdownEscape(text: string): string {
  let escape = "```";
  for (const [m] of text.matchAll(/^```+/gm)) {
    while (m.length >= escape.length) {
      escape += "`";
    }
  }
  return escape + "\n" + text + (text.endsWith("\n") ? "" : "\n") + escape;
}

/** Every SDK block that reports the result of a tool use. */
export type ToolResultBlock =
  | ToolResultBlockParam
  | BetaToolResultBlockParam
  | BetaWebSearchToolResultBlockParam
  | BetaWebFetchToolResultBlockParam
  | WebSearchToolResultBlockParam
  | BetaCodeExecutionToolResultBlockParam
  | BetaBashCodeExecutionToolResultBlockParam
  | BetaTextEditorCodeExecutionToolResultBlockParam
  | BetaRequestMCPToolResultBlockParam
  | BetaToolSearchToolResultBlockParam;

/** One text content block. */
export function textContent(text: string): ToolCallContent {
  return { type: "content", content: { type: "text", text } };
}

/** The result text that the model saw, as the result to show. */
export function resultText(result: { content?: unknown; is_error?: boolean | null }): {
  content?: ToolCallContent[];
} {
  return toAcpContentUpdate(result.content, result.is_error === true);
}

/**
 * The marker fields of a PostToolUse `tool_response` that clients read.
 *
 * The full `tool_response` repeats the tool output. A Read holds the whole
 * file, a Bash holds stdout and stderr, and a Write holds the content. The
 * tool-call content already carries that output. JetBrains AIR reads
 * `status` and `isAsync` to detect an async subagent launch, so only those
 * fields stay. Returns undefined when neither field is present.
 */
export function toolResponseMarkers(
  toolResponse: unknown,
): { status?: string; isAsync?: boolean } | undefined {
  if (!toolResponse || typeof toolResponse !== "object" || Array.isArray(toolResponse)) {
    return undefined;
  }
  const { status, isAsync } = toolResponse as { status?: unknown; isAsync?: unknown };
  const markers = {
    ...(typeof status === "string" ? { status } : {}),
    ...(typeof isAsync === "boolean" ? { isAsync } : {}),
  };
  return Object.keys(markers).length > 0 ? markers : undefined;
}
