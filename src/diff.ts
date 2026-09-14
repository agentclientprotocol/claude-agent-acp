import { ToolCallContent, ToolCallLocation } from "@agentclientprotocol/sdk";
import { AIR_DIFF_STATS_KEY, withAirMeta } from "./air-extension.js";

interface DiffToolResponseHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
}

interface DiffToolResponse {
  filePath?: string;
  structuredPatch?: DiffToolResponseHunk[];
  /** FileWriteOutput only (FileEditOutput carries no `type`): whether the
   *  write created the file or overwrote an existing one. */
  type?: "create" | "update";
  /** FileWriteOutput only: the content that was written. */
  content?: string;
  /** FileWriteOutput only: the pre-write content — null on create, or on an
   *  update whose previous content was too large to include. */
  originalFile?: string | null;
}

/**
 * Builds diff ToolUpdate content from the structured toolResponse provided by
 * the PostToolUse hook for diff-producing tools (Edit, Write). Unlike parsing
 * the plain unified diff string, this uses the pre-parsed structuredPatch
 * which supports multiple replacement sites (replaceAll) and always includes
 * context lines for better readability.
 */
export function toolUpdateFromDiffToolResponse(toolResponse: unknown): {
  content?: ToolCallContent[];
  locations?: ToolCallLocation[];
} {
  if (!toolResponse || typeof toolResponse !== "object") return {};
  const response = toolResponse as DiffToolResponse;
  if (!response.filePath || !Array.isArray(response.structuredPatch)) return {};

  const content: ToolCallContent[] = [];
  const locations: ToolCallLocation[] = [];
  let previousOldEnd = 0;
  let previousNewEnd = 0;
  let coordinatesRemainOrdered = true;

  for (const { lines, oldStart, newStart, oldLines, newLines } of response.structuredPatch) {
    const oldText: string[] = [];
    const newText: string[] = [];
    let added = 0;
    let removed = 0;
    let validPrefixes = true;
    let validEofMarkers = true;
    const validCoordinates: boolean =
      coordinatesRemainOrdered &&
      Number.isSafeInteger(oldStart) &&
      Number.isSafeInteger(newStart) &&
      Number.isSafeInteger(oldLines) &&
      Number.isSafeInteger(newLines) &&
      oldStart >= (oldLines === 0 ? 0 : 1) &&
      newStart >= (newLines === 0 ? 0 : 1) &&
      oldLines >= 0 &&
      newLines >= 0 &&
      Number.isSafeInteger(oldStart + oldLines) &&
      Number.isSafeInteger(newStart + newLines) &&
      oldStart >= previousOldEnd &&
      newStart >= previousNewEnd;
    coordinatesRemainOrdered = validCoordinates;
    if (validCoordinates) {
      previousOldEnd = oldStart + oldLines;
      previousNewEnd = newStart + newLines;
    }
    for (const [index, line] of lines.entries()) {
      if (line.startsWith("-")) {
        oldText.push(line.slice(1));
        removed++;
      } else if (line.startsWith("+")) {
        newText.push(line.slice(1));
        added++;
      } else if (line === "\\ No newline at end of file") {
        const previousLine = lines[index - 1];
        if (
          typeof previousLine !== "string" ||
          (!previousLine.startsWith("-") &&
            !previousLine.startsWith("+") &&
            !previousLine.startsWith(" "))
        ) {
          validEofMarkers = false;
        }
        continue;
      } else {
        if (!line.startsWith(" ")) validPrefixes = false;
        oldText.push(line.slice(1));
        newText.push(line.slice(1));
      }
    }
    if (oldText.length > 0 || newText.length > 0) {
      locations.push({ path: response.filePath, line: newStart });
      content.push({
        type: "diff",
        path: response.filePath,
        oldText: oldText.join("\n") || null,
        newText: newText.join("\n"),
        ...(validCoordinates &&
        validPrefixes &&
        validEofMarkers &&
        oldText.length === oldLines &&
        newText.length === newLines
          ? { _meta: withAirMeta(undefined, AIR_DIFF_STATS_KEY, { version: 1, added, removed }) }
          : {}),
      });
    }
  }

  // A Write `update` can arrive with an empty structuredPatch — nothing
  // changed, the diff timed out, or the previous content was too large to
  // diff (originalFile null; SDK 0.3.252 documents the lane). Returning `{}`
  // would leave Write's optimistic tool_use-time content standing, and that
  // was built with `oldText: null` — "creation" semantics — so an overwrite
  // of a large existing file would render as creating it. Emit a truthful
  // replacement instead. Gated on `type` so Edit (whose output carries no
  // `type` and whose optimistic old/new diff is already truthful) keeps the
  // empty-return behavior.
  if (content.length === 0 && response.type === "update" && typeof response.content === "string") {
    locations.push({ path: response.filePath });
    content.push(
      typeof response.originalFile === "string"
        ? {
            type: "diff",
            path: response.filePath,
            oldText: response.originalFile,
            newText: response.content,
          }
        : {
            type: "content",
            content: {
              type: "text",
              text: `Updated \`${response.filePath}\` (previous content too large to diff)`,
            },
          },
    );
  }

  const result: { content?: ToolCallContent[]; locations?: ToolCallLocation[] } = {};
  if (content.length > 0) result.content = content;
  if (locations.length > 0) result.locations = locations;
  return result;
}
