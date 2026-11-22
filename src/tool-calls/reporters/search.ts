import type { GlobInput, GrepInput } from "@anthropic-ai/claude-agent-sdk/sdk-tools.js";
import { inputString } from "../content.js";
import type { ToolReporter, ToolUseContext, ToolUseFacts } from "../facts.js";

/**
 * Glob: the file list is the result to show. A v1 client gets the path and
 * the pattern as Markdown code spans, like upstream. A v2 tool call title is
 * plain text, so a v2 client gets them as they are.
 */
export class GlobReporter implements ToolReporter {
  toolUse(input: unknown, { capabilities }: ToolUseContext): ToolUseFacts {
    const glob = input as GlobInput | undefined;
    const searchPath = inputString(input, "path");
    const code = (text: string) => (capabilities.v2 ? text : `\`${text}\``);
    let label = "Find";
    if (searchPath) label += ` ${code(searchPath)}`;
    if (glob?.pattern) label += ` ${code(glob.pattern)}`;
    return {
      title: label,
      kind: "search",
      locations: searchPath ? [{ path: searchPath }] : [],
    };
  }
}

/** Grep: the title is the equivalent grep command line. */
export class GrepReporter implements ToolReporter {
  toolUse(input: unknown): ToolUseFacts {
    const grep = input as GrepInput | undefined;
    let label = "grep";
    if (grep?.["-i"]) label += " -i";
    if (grep?.["-n"]) label += " -n";
    if (grep?.["-A"] !== undefined) label += ` -A ${grep["-A"]}`;
    if (grep?.["-B"] !== undefined) label += ` -B ${grep["-B"]}`;
    if (grep?.["-C"] !== undefined) label += ` -C ${grep["-C"]}`;
    const outputMode = grepOutputMode(input);
    if (outputMode === "files_with_matches") label += " -l";
    else if (outputMode === "count") label += " -c";
    if (grep?.head_limit !== undefined) label += ` | head -${grep.head_limit}`;
    if (grep?.glob) label += ` --include="${grep.glob}"`;
    if (grep?.type) label += ` --type=${grep.type}`;
    if (grep?.multiline) label += " -P";
    if (grep?.pattern) label += ` "${grep.pattern}"`;
    const path = grepPath(input);
    if (path) label += ` ${path}`;
    return { title: label, kind: "search" };
  }
}

/**
 * Reads a Grep input's output mode the way the CLI validates it. Since CLI
 * 2.1.295 the CLI reads a `-l` or `-c` flag (`true` or `"true"`) as
 * `output_mode: "files_with_matches"` or `"count"` when `output_mode` is unset.
 */
function grepOutputMode(input: unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const raw = input as Record<string, unknown>;
  if (typeof raw.output_mode === "string") return raw.output_mode;
  if (raw["-l"] === true || raw["-l"] === "true") return "files_with_matches";
  if (raw["-c"] === true || raw["-c"] === "true") return "count";
  return undefined;
}

/**
 * Reads a Grep input's path the way the CLI validates it. Since CLI 2.1.292
 * the CLI accepts `file_path` for `path`. The streamed tool use keeps the
 * original key. The canonical key wins when both spellings are present.
 */
export function grepPath(input: unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const raw = input as Record<string, unknown>;
  if (typeof raw.path === "string") return raw.path;
  return typeof raw.file_path === "string" ? raw.file_path : undefined;
}
