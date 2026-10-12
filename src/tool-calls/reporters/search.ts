import type { GlobInput, GrepInput } from "@anthropic-ai/claude-agent-sdk/sdk-tools.js";
import type { ToolReporter, ToolUseFacts } from "../facts.js";

/** Glob: the file list is the result to show. */
export class GlobReporter implements ToolReporter {
  toolUse(input: unknown): ToolUseFacts {
    const glob = input as GlobInput | undefined;
    let label = "Find";
    if (glob?.path) label += ` \`${glob.path}\``;
    if (glob?.pattern) label += ` \`${glob.pattern}\``;
    return {
      title: label,
      kind: "search",
      locations: glob?.path ? [{ path: glob.path }] : [],
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
    if (grep?.output_mode === "files_with_matches") label += " -l";
    else if (grep?.output_mode === "count") label += " -c";
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
