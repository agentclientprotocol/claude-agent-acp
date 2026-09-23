import type { FileReadInput, FileReadOutput } from "@anthropic-ai/claude-agent-sdk/sdk-tools.js";
import {
  markdownEscape,
  structuredResult,
  textContent,
  toAcpContentBlock,
  toDisplayPath,
} from "../content.js";
import type {
  ToolReporter,
  ToolResultContext,
  ToolResultFacts,
  ToolUseContext,
  ToolUseFacts,
} from "../facts.js";

/** Read: the file text is the result to show. */
export class ReadReporter implements ToolReporter {
  toolUse(input: unknown, { cwd }: ToolUseContext): ToolUseFacts {
    const read = input as FileReadInput | undefined;
    let limit = "";
    if (read?.limit && read.limit > 0) {
      limit = " (" + (read.offset ?? 1) + " - " + ((read.offset ?? 1) + read.limit - 1) + ")";
    } else if (read?.offset) {
      limit = " (from line " + read.offset + ")";
    }
    const displayPath = read?.file_path ? toDisplayPath(read.file_path, cwd) : "File";
    return {
      title: "Read " + displayPath + limit,
      kind: "read",
      locations: read?.file_path ? [{ path: read.file_path, line: read.offset ?? 1 }] : [],
    };
  }

  toolResult({ toolUse, result, structured }: ToolResultContext): ToolResultFacts {
    // The raw tool_result text is the model-facing view: line-numbered content
    // plus appended <system-reminder> blocks that clients must not see. The
    // structured FileReadOutput carries the clean content, so rebuild the
    // line-numbered view from it. Image, notebook, and PDF variants use the
    // raw content blocks, which already render.
    const structuredRead = structuredResult<FileReadOutput>(structured);
    if (
      structuredRead?.type === "text" &&
      typeof structuredRead.file?.content === "string" &&
      // An empty file has nothing to number: keep the raw "file is empty" note.
      structuredRead.file.content.length > 0
    ) {
      const startLine =
        structuredRead.file.startLine ?? (toolUse.input as FileReadInput | undefined)?.offset ?? 1;
      // A trailing newline ends the last line. It is not an extra line.
      let numbered = structuredRead.file.content
        .replace(/\n$/, "")
        .split("\n")
        .map((line, i) => `${startLine + i}\t${line}`)
        .join("\n");
      // The model-facing truncation banner does not survive the rebuild.
      if (structuredRead.file.truncatedByTokenCap) {
        const { numLines, totalLines } = structuredRead.file;
        const detail =
          typeof numLines === "number" && typeof totalLines === "number"
            ? `: showing ${numLines} of ${totalLines} lines`
            : "";
        numbered += `\n[File truncated${detail}]`;
      }
      return { content: [textContent(markdownEscape(numbered))] };
    }
    const content = result.content;
    if (Array.isArray(content) && content.length > 0) {
      return {
        content: content.map((block: any) => ({
          type: "content" as const,
          content:
            block.type === "text"
              ? { type: "text" as const, text: markdownEscape(block.text) }
              : toAcpContentBlock(block, false),
        })),
      };
    }
    if (typeof content === "string" && content.length > 0) {
      return { content: [textContent(markdownEscape(content))] };
    }
    return {};
  }
}
