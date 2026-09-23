import { ToolCallContent, ToolCallLocation } from "@agentclientprotocol/sdk";
import { structuredPatch } from "diff";
import { readFileSync, statSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { AIR_DIFF_PATCH_CAPABILITY, withAirMeta } from "./air-extension.js";

/**
 * The largest file, in bytes, that the adapter turns into a git patch.
 *
 * A larger file, a larger new text, or an Edit whose result can be larger
 * gets no patch. The tool call then keeps its standard ACP content. The limit
 * bounds the file read, the replacement, and the line diff that run while
 * Claude waits for an approval.
 */
export const MAX_PATCH_FILE_BYTES = 1024 * 1024;

/** The wall-clock budget, in milliseconds, of one line diff for a patch. */
const PATCH_DIFF_TIMEOUT_MS = 500;

/** Git reads this many leading bytes to decide that a file is binary. */
const BINARY_SNIFF_BYTES = 8000;

const NO_NEWLINE_MARKER = "\\ No newline at end of file";

/**
 * One unified-diff hunk in the `diff` package convention.
 *
 * A side with zero lines stores the number of the line after the change as its
 * start. {@link hunkHeader} converts that start to the git convention.
 */
interface PatchHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
}

interface DiffToolResponse {
  filePath?: string;
  structuredPatch?: PatchHunk[];
  /** FileWriteOutput only (FileEditOutput carries no `type`): whether the
   *  write created the file or overwrote an existing one. */
  type?: "create" | "update";
  /** FileWriteOutput only: the content that was written. */
  content?: string;
  /** The pre-change content. It is null on a Write create, or on a Write
   *  update whose previous content was too large to include. An Edit that
   *  creates a file reports an empty string, as for an existing empty file. */
  originalFile?: string | null;
  /** FileEditOutput only: the text that the Edit replaced. It is empty when
   *  the Edit created the file or filled an existing empty file. */
  oldString?: string;
}

interface EditPreviewInput {
  file_path?: unknown;
  old_string?: unknown;
  new_string?: unknown;
  replace_all?: unknown;
}

interface WritePreviewInput {
  file_path?: unknown;
  content?: unknown;
}

/** The kind of file change that a git patch describes. */
type FileChange = "create" | "update" | "delete";

/**
 * Builds the exact patch shown before Claude runs an Edit or Write tool.
 *
 * Returns undefined when the adapter cannot predict the file change exactly.
 * The caller then keeps the standard tool-call content. The adapter declines
 * a file that is missing for an Edit, too large, binary, or that has CR line
 * endings. Claude converts the line endings of an edited file, so an in-memory
 * replacement would not match the bytes that Claude writes. It also declines
 * an `old_string` that does not match exactly once, because Claude then
 * normalizes quotes or fails.
 *
 * The preview uses the tool input as it is. Claude can still remove the
 * trailing whitespace of a line before it writes. The PostToolUse hook then
 * sends the patch of the written file.
 */
export async function previewPatchContent(
  toolName: string,
  input: Record<string, unknown>,
  cwd?: string,
): Promise<ToolCallContent[] | undefined> {
  if (toolName === "Edit") {
    const edit = input as EditPreviewInput;
    if (
      typeof edit.file_path !== "string" ||
      typeof edit.old_string !== "string" ||
      typeof edit.new_string !== "string"
    ) {
      return undefined;
    }
    const oldString = edit.old_string;
    const filePath = resolveToolPath(edit.file_path, cwd);
    const oldText = await readPatchSource(filePath);
    if (oldText === undefined) return undefined;
    const newString = edit.new_string;
    if (oldString === newString || !isPatchableText(newString)) return undefined;
    if (oldString.length === 0) {
      // An empty old_string creates the file, or fills an existing file that
      // holds only whitespace. `trim` also removes a byte order mark, whose
      // handling the adapter does not predict, so such a file is declined.
      if (oldText !== null && (oldText.trim() !== "" || oldText.includes("\uFEFF"))) {
        return undefined;
      }
      return optionalContent(await filePatchContent(filePath, oldText, newString));
    }
    if (oldText === null) return undefined;
    const occurrences = oldText.split(oldString).length - 1;
    if (occurrences === 0 || (edit.replace_all !== true && occurrences !== 1)) return undefined;
    if (replacedTextBytesBound(oldText, oldString, newString, occurrences) > MAX_PATCH_FILE_BYTES) {
      return undefined;
    }
    const newText = replacedText(oldText, oldString, newString, edit.replace_all === true);
    return optionalContent(await filePatchContent(filePath, oldText, newText));
  }

  if (toolName === "Write") {
    const write = input as WritePreviewInput;
    if (typeof write.file_path !== "string" || typeof write.content !== "string") {
      return undefined;
    }
    const content = write.content;
    if (!isPatchableText(content)) return undefined;
    const filePath = resolveToolPath(write.file_path, cwd);
    const oldText = await readPatchSource(filePath);
    if (oldText === undefined || oldText === content) return undefined;
    return optionalContent(await filePatchContent(filePath, oldText, content));
  }

  return undefined;
}

/**
 * An upper bound of the UTF-8 size, in bytes, of {@link replacedText}.
 *
 * The caller checks the bound before it builds the text. A `replace_all` of
 * many short matches with a long `newString` can otherwise build a text of
 * gigabytes before the timed line diff starts.
 */
function replacedTextBytesBound(
  fileText: string,
  oldString: string,
  newString: string,
  occurrences: number,
): number {
  const growth = Buffer.byteLength(newString, "utf8") - Buffer.byteLength(oldString, "utf8");
  return Buffer.byteLength(fileText, "utf8") + occurrences * Math.max(0, growth);
}

/**
 * The file text after Claude replaces `oldString` with `newString`.
 *
 * An empty `newString` deletes a line: when `oldString` does not end with a
 * line break and the file holds `oldString` and a line break, Claude also
 * removes that line break. With `replaceAll`, it then replaces only the
 * occurrences that a line break follows.
 */
function replacedText(
  fileText: string,
  oldString: string,
  newString: string,
  replaceAll: boolean,
): string {
  const target =
    newString === "" && !oldString.endsWith("\n") && fileText.includes(`${oldString}\n`)
      ? `${oldString}\n`
      : oldString;
  return replaceAll
    ? fileText.split(target).join(newString)
    : fileText.replace(target, () => newString);
}

/**
 * Builds the git patch for a finished Edit or Write from the file on disk.
 *
 * The Claude SDK `structuredPatch` is display data: Claude converts leading
 * tabs to spaces and CRLF line endings to LF before it computes the hunks. A
 * patch built from those hunks does not match the file. This function diffs
 * `originalFile` against the written file instead. It returns undefined when
 * it cannot build an exact patch, and the caller then sends the standard diff.
 * A written file that contains a CR or a byte order mark is declined, because
 * Claude removed those bytes from `originalFile`.
 */
export async function patchUpdateFromDiffToolResponse(
  toolResponse: unknown,
): Promise<{ content: ToolCallContent[]; locations: ToolCallLocation[] } | undefined> {
  if (!toolResponse || typeof toolResponse !== "object") return undefined;
  const response = toolResponse as DiffToolResponse;
  if (typeof response.filePath !== "string") return undefined;
  // An Edit with an empty old_string reports "" as the original of a created
  // file and of an existing empty file. The response does not tell the two
  // apart, so the caller keeps the standard diff.
  if (response.type === undefined && response.oldString === "" && response.originalFile === "") {
    return undefined;
  }
  // A Write whose content is the previous text changed nothing. The file on
  // disk can hold a later change, and that change is not the change of this Write.
  if (
    response.type === "update" &&
    typeof response.content === "string" &&
    response.originalFile === response.content
  ) {
    return undefined;
  }
  const oldText =
    response.type === "create"
      ? null
      : typeof response.originalFile === "string"
        ? response.originalFile
        : undefined;
  if (oldText === undefined) return undefined;
  const newText = await readPatchSource(response.filePath);
  if (typeof newText !== "string" || newText.startsWith("\uFEFF")) return undefined;
  if (response.type === "create" && newText !== response.content) return undefined;
  const hunks = await diffHunks(oldText, newText);
  if (!hunks || hunks.length === 0) return undefined;
  return {
    content: [
      patchContent(
        response.filePath,
        gitPatchText(response.filePath, oldText === null ? "create" : "update", hunks),
      ),
    ],
    // A created file keeps the location of its Write tool call.
    locations:
      oldText === null
        ? [{ path: response.filePath }]
        : hunks.map(({ newStart }) => ({ path: response.filePath!, line: newStart })),
  };
}

/**
 * Builds standard ACP diff content from the structured toolResponse provided
 * by the PostToolUse hook for diff-producing tools (Edit, Write). Unlike
 * parsing the plain unified diff string, this uses the pre-parsed
 * structuredPatch which supports multiple replacement sites (replaceAll) and
 * always includes context lines for better readability.
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
  for (const { lines, newStart } of response.structuredPatch) {
    const oldText: string[] = [];
    const newText: string[] = [];
    for (const line of lines) {
      if (line.startsWith("-")) {
        oldText.push(line.slice(1));
      } else if (line.startsWith("+")) {
        newText.push(line.slice(1));
      } else if (line === NO_NEWLINE_MARKER) {
        continue;
      } else {
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
  // empty-return behavior. A `create` needs nothing: the tool_use-time
  // content already shows the created file.
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

/**
 * The patch content for a Write that creates `filePath` with `content`.
 *
 * Returns undefined when the content is empty, too large, binary, or contains a
 * CR. Claude converts the line endings of a written file, so such a patch
 * would not be exact.
 */
export function creationPatchContent(
  filePath: string,
  content: string,
): ToolCallContent | undefined {
  if (!isPatchableText(content)) return undefined;
  const hunk = wholeFileHunk(content);
  return hunk ? patchContent(filePath, gitPatchText(filePath, "create", [hunk])) : undefined;
}

/** The change of a Write tool call, and whether it holds the new file text. */
export interface WriteChange {
  change: ToolCallContent[];
  holdsFileText: boolean;
}

/**
 * The change of a Write tool call for a client that negotiated `diffPatch`.
 *
 * A missing file gets a creation patch. An existing file gets the standard
 * diff from its current text, and the approval preview or the PostToolUse
 * hook later sends the exact patch. An existing file whose text the adapter
 * cannot read gets a notice that the Write overwrites it, and no diff: a diff
 * without old text would claim a creation. Returns undefined when the
 * adapter does not know if the file exists, or cannot build a creation
 * patch. The caller then sends the standard diff.
 *
 * The check runs while the tool call renders, so it reads the file
 * synchronously. The read is bounded by {@link MAX_PATCH_FILE_BYTES}.
 */
export function writeToolUseChange(
  filePath: string,
  content: string,
  cwd?: string,
): WriteChange | undefined {
  const resolvedPath = resolveToolPath(filePath, cwd);
  let oldText: string | undefined;
  try {
    const stats = statSync(resolvedPath);
    if (stats.isFile() && stats.size <= MAX_PATCH_FILE_BYTES) {
      oldText = decodeFileText(readFileSync(resolvedPath));
    }
  } catch (error) {
    if (!isMissingFileError(error)) return undefined;
    const patch = creationPatchContent(filePath, content);
    return patch ? { change: [patch], holdsFileText: true } : undefined;
  }
  if (oldText === undefined) {
    return {
      change: [
        {
          type: "content",
          content: {
            type: "text",
            text: `Overwrites the existing file \`${filePath}\`. The adapter cannot show its current content.`,
          },
        },
      ],
      holdsFileText: false,
    };
  }
  return {
    change: [
      {
        type: "diff",
        path: filePath,
        oldText,
        newText: content,
      },
    ],
    holdsFileText: true,
  };
}

/**
 * The text of one git patch for `filePath`.
 *
 * The headers follow `git diff`: the path loses its leading slash, gets the
 * `a/` and `b/` prefixes, and is quoted when git would quote it. A created or
 * deleted file gets its mode line and a `/dev/null` side.
 */
export function gitPatchText(filePath: string, change: FileChange, hunks: PatchHunk[]): string {
  return [
    ...gitPatchHeader(filePath, change),
    ...hunks.flatMap((hunk) => [hunkHeader(hunk), ...hunk.lines]),
    "",
  ].join("\n");
}

function gitPatchHeader(filePath: string, change: FileChange): string[] {
  // git drops one leading slash of an absolute path; a Windows path gets
  // forward slashes so the header names the same file on every platform.
  const name = filePath.replaceAll("\\", "/").replace(/^\/+/u, "");
  const oldName = quoteGitPath("a/", name);
  const newName = quoteGitPath("b/", name);
  // git ends a ---/+++ name that contains a space with a tab, for GNU patch.
  const tab = name.includes(" ") ? "\t" : "";
  return [
    `diff --git ${oldName} ${newName}`,
    ...(change === "create" ? ["new file mode 100644"] : []),
    ...(change === "delete" ? ["deleted file mode 100644"] : []),
    `--- ${change === "create" ? "/dev/null" : `${oldName}${tab}`}`,
    `+++ ${change === "delete" ? "/dev/null" : `${newName}${tab}`}`,
  ];
}

const GIT_PATH_ESCAPES: Record<number, string> = {
  0x07: "a",
  0x08: "b",
  0x09: "t",
  0x0a: "n",
  0x0b: "v",
  0x0c: "f",
  0x0d: "r",
  0x22: '"',
  0x5c: "\\",
};

/**
 * Quotes `prefix + name` like git with the default `core.quotePath`.
 *
 * A double quote, a backslash, a control byte, or a non-ASCII byte makes git
 * put the whole name in double quotes. git then writes a C escape or a
 * three-digit octal escape for each such UTF-8 byte.
 */
function quoteGitPath(prefix: string, name: string): string {
  const full = `${prefix}${name}`;
  let quoted = "";
  let needsQuotes = false;
  for (const byte of Buffer.from(full, "utf8")) {
    const escape = GIT_PATH_ESCAPES[byte];
    if (escape !== undefined) {
      quoted += `\\${escape}`;
      needsQuotes = true;
    } else if (byte < 0x20 || byte >= 0x7f) {
      quoted += `\\${byte.toString(8).padStart(3, "0")}`;
      needsQuotes = true;
    } else {
      quoted += String.fromCharCode(byte);
    }
  }
  return needsQuotes ? `"${quoted}"` : full;
}

function hunkHeader({ oldStart, oldLines, newStart, newLines }: PatchHunk): string {
  return `@@ -${hunkRange(oldStart, oldLines)} +${hunkRange(newStart, newLines)} @@`;
}

/** A git hunk range. A side with zero lines names the line before the change. */
function hunkRange(start: number, count: number): string {
  if (count === 0) return `${Math.max(0, start - 1)},0`;
  return count === 1 ? String(start) : `${start},${count}`;
}

/** The hunk that adds every line of `text` to an empty file. */
function wholeFileHunk(text: string): PatchHunk | undefined {
  if (text.length === 0) return undefined;
  const terminated = text.endsWith("\n");
  const lines = (terminated ? text.slice(0, -1) : text).split("\n");
  return {
    oldStart: 1,
    oldLines: 0,
    newStart: 1,
    newLines: lines.length,
    lines: [...lines.map((line) => `+${line}`), ...(terminated ? [] : [NO_NEWLINE_MARKER])],
  };
}

/**
 * The line-diff hunks between two texts, computed without blocking the event
 * loop. Returns undefined when the diff runs out of its time budget.
 */
async function diffHunks(
  oldText: string | null,
  newText: string,
): Promise<PatchHunk[] | undefined> {
  if (oldText === null) {
    const hunk = wholeFileHunk(newText);
    return hunk ? [hunk] : [];
  }
  return new Promise((resolve) => {
    structuredPatch("", "", oldText, newText, "", "", {
      context: 3,
      timeout: PATCH_DIFF_TIMEOUT_MS,
      callback: (patch) => resolve(patch?.hunks),
    });
  });
}

async function filePatchContent(
  filePath: string,
  oldText: string | null,
  newText: string,
): Promise<ToolCallContent | undefined> {
  const hunks = await diffHunks(oldText, newText);
  if (!hunks || hunks.length === 0) return undefined;
  return patchContent(
    filePath,
    gitPatchText(filePath, oldText === null ? "create" : "update", hunks),
  );
}

/**
 * Reads a file as patch input.
 *
 * Returns null when the file does not exist. Returns undefined when the file
 * cannot be read, is not a regular file, is larger than
 * {@link MAX_PATCH_FILE_BYTES}, is binary, is not valid UTF-8, or contains a
 * CR.
 */
async function readPatchSource(filePath: string): Promise<string | null | undefined> {
  try {
    const stats = await stat(filePath);
    if (!stats.isFile() || stats.size > MAX_PATCH_FILE_BYTES) return undefined;
    const text = decodeFileText(await readFile(filePath));
    return text?.includes("\r") ? undefined : text;
  } catch (error) {
    return isMissingFileError(error) ? null : undefined;
  }
}

/** The text of a file of at most {@link MAX_PATCH_FILE_BYTES} that is not binary and is valid UTF-8. */
function decodeFileText(bytes: Uint8Array): string | undefined {
  if (bytes.length > MAX_PATCH_FILE_BYTES) return undefined;
  if (bytes.subarray(0, BINARY_SNIFF_BYTES).includes(0)) return undefined;
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

/** Whether a tool input text can be the new side of an exact patch. */
function isPatchableText(text: string): boolean {
  return (
    Buffer.byteLength(text, "utf8") <= MAX_PATCH_FILE_BYTES &&
    !text.includes("\0") &&
    !text.includes("\r")
  );
}

function optionalContent(content: ToolCallContent | undefined): ToolCallContent[] | undefined {
  return content ? [content] : undefined;
}

/**
 * A diff block in the AIR patch form.
 *
 * `oldText: null` and `newText: ""` only satisfy the ACP schema. The adapter
 * sends this form only to a client that advertised `diffPatch`.
 */
function patchContent(filePath: string, text: string): ToolCallContent {
  return {
    type: "diff",
    path: filePath,
    oldText: null,
    newText: "",
    _meta: withAirMeta(undefined, AIR_DIFF_PATCH_CAPABILITY, {
      version: 1,
      format: "git_patch",
      text,
    }),
  };
}

function resolveToolPath(filePath: string, cwd?: string): string {
  return path.isAbsolute(filePath) ? filePath : path.resolve(cwd ?? process.cwd(), filePath);
}

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
