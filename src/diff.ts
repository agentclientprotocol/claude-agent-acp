import { ToolCallContent, ToolCallLocation } from "@agentclientprotocol/sdk";
import type * as v2 from "@agentclientprotocol/sdk/experimental/v2";
import { structuredPatch } from "diff";
import { constants } from "node:fs";
import { type FileHandle, open } from "node:fs/promises";
import path from "node:path";
import { AIR_DIFF_PATCH_CAPABILITY, withAirMeta } from "./air-extension.js";
import { normalizeWriteInput } from "./tool-calls/reporters/file-edit.js";

/**
 * The largest file, in bytes, that the adapter turns into a git patch.
 *
 * A larger file, a larger new text, or an Edit whose result can be larger
 * gets no patch. The tool call then keeps its standard ACP content. The limit
 * bounds the file read, the replacement, and the line diff that run while
 * Claude waits for an approval.
 */
export const MAX_PATCH_FILE_BYTES = 1024 * 1024;

/**
 * The wall-clock budget, in milliseconds, of one line diff for a patch.
 *
 * The diff runs synchronously, so the budget is also the longest block of the
 * event loop.
 */
const PATCH_DIFF_TIMEOUT_MS = 100;

/** The number of context lines around a change in a hunk. */
const PATCH_CONTEXT_LINES = 3;

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

/** The kind of file change that a git patch describes. */
type FileChange = "create" | "update";

/** A file change and the hunks of its git patch. */
interface FilePatch {
  change: FileChange;
  hunks: PatchHunk[];
}

/**
 * The diff that carries an exact patch: AIR's `diffPatch` extension of a v1
 * diff, or an ACP v2 diff.
 */
export type PatchForm = "air" | "v2";

/**
 * How a git patch names its file. `git` is git's own form: the leading slash
 * dropped and the `a/` and `b/` prefixes added. `absolute` is the form of an
 * ACP v2 `git_patch`, whose paths must be absolute: the path itself.
 */
type GitPatchPaths = "git" | "absolute";

/** An ACP v2 diff, as tool call content. */
type V2DiffContent = v2.Diff & { type: "diff" };

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
 * A Write always gets content that shows the change: the patch, the standard
 * diff (in v2, the change alone) of a text that cannot have an exact patch, or
 * a notice that the Write overwrites a file that the adapter cannot show.
 *
 * The preview uses the tool input as it is. Claude can still remove the
 * trailing whitespace of a line before it writes. The PostToolUse hook then
 * sends the patch of the written file.
 */
export async function previewPatchContent(
  toolName: string,
  input: Record<string, unknown>,
  cwd?: string,
  form: PatchForm = "air",
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
      return exactPatch(filePath, oldText, newString, form);
    }
    if (oldText === null) return undefined;
    const occurrences = oldText.split(oldString).length - 1;
    if (occurrences === 0 || (edit.replace_all !== true && occurrences !== 1)) return undefined;
    if (replacedTextBytesBound(oldText, oldString, newString, occurrences) > MAX_PATCH_FILE_BYTES) {
      return undefined;
    }
    const newText = replacedText(oldText, oldString, newString, edit.replace_all === true);
    return exactPatch(filePath, oldText, newText, form);
  }

  if (toolName === "Write") {
    const write = normalizeWriteInput(input);
    if (typeof write?.file_path !== "string" || typeof write.content !== "string") {
      return undefined;
    }
    // The Write tool call shows no diff, so the approval is the only place that
    // shows what the Write changes.
    const content = write.content;
    const filePath = resolveToolPath(write.file_path, cwd);
    const oldText = await readPatchSource(filePath);
    if (oldText === undefined) {
      return [
        {
          type: "content",
          content: {
            type: "text",
            text: `Overwrites the existing file \`${write.file_path}\`. The adapter cannot show its current content.`,
          },
        },
      ];
    }
    if (oldText === content) return undefined;
    const standard: ToolCallContent[] = [
      form === "v2"
        ? v2DiffContent(filePath, oldText === null ? "create" : "update")
        : { type: "diff", path: write.file_path, oldText, newText: content },
    ];
    if (!isPatchableText(content)) return standard;
    // A dense change can exceed the diff budget. The approval then shows the standard diff.
    return exactPatch(filePath, oldText, content, form) ?? standard;
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
  form: PatchForm = "air",
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
  // The same size limit as the new side: a larger text gets the standard diff.
  if (oldText !== null && Buffer.byteLength(oldText, "utf8") > MAX_PATCH_FILE_BYTES)
    return undefined;
  const newText = await readPatchSource(response.filePath);
  if (typeof newText !== "string" || newText.startsWith("\uFEFF")) return undefined;
  if (response.type === "create" && newText !== response.content) return undefined;
  const patch = filePatch(oldText, newText);
  if (!patch) return undefined;
  return {
    content: [patchContent(response.filePath, patch, form)],
    // A created file keeps the location of its Write tool call.
    locations:
      oldText === null
        ? [{ path: response.filePath }]
        : patch.hunks.map(({ newStart }) => ({ path: response.filePath!, line: newStart })),
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
  // empty-return behavior. A `create` needs nothing here: the
  // tool_use-time diff shows the created file, and a client with diffPatch
  // gets it from the Write reporter.
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
 * The ACP v2 diff of a finished Edit or Write: the exact patch of
 * {@link patchUpdateFromDiffToolResponse} when it can be built, else the
 * change with a patch from what the toolResponse holds.
 *
 * The fallback patch of an update comes from the `structuredPatch`, which is
 * display data (see {@link patchUpdateFromDiffToolResponse}). That is enough
 * for a v2 patch, which is renderable text, not a patch to apply. An update
 * without hunks, such as one whose previous content was too large to diff,
 * gets the change alone. An Edit with an empty `old_string` reports the same
 * response for a created file and a filled empty one, so it gets no diff.
 */
export async function v2UpdateFromDiffToolResponse(toolResponse: unknown): Promise<{
  content?: ToolCallContent[];
  locations?: ToolCallLocation[];
}> {
  const exact = await patchUpdateFromDiffToolResponse(toolResponse, "v2");
  if (exact) return exact;
  if (!toolResponse || typeof toolResponse !== "object") return {};
  const response = toolResponse as DiffToolResponse;
  const filePath = response.filePath;
  if (typeof filePath !== "string") return {};
  if (response.type === "create") {
    const hunk =
      typeof response.content === "string" && isPatchableText(response.content)
        ? wholeFileHunk(response.content)
        : undefined;
    return {
      content: [v2DiffContent(filePath, "create", hunk && [hunk])],
      locations: [{ path: filePath }],
    };
  }
  if (response.type === undefined && response.oldString === "" && response.originalFile === "") {
    return {};
  }
  // A Write whose content is the previous text changed nothing.
  if (response.type === "update" && response.content === response.originalFile) return {};
  const hunks =
    Array.isArray(response.structuredPatch) && response.structuredPatch.length > 0
      ? response.structuredPatch
      : undefined;
  return {
    content: [v2DiffContent(filePath, "update", hunks)],
    locations: hunks
      ? hunks.map(({ newStart }) => ({ path: filePath, line: newStart }))
      : [{ path: filePath }],
  };
}

/**
 * The text of one git patch for `filePath`.
 *
 * The headers follow `git diff`: the path is quoted when git would quote it,
 * and a created file gets its mode line and a `/dev/null` side. With `git`
 * paths, the path loses its leading slash and gets the `a/` and `b/` prefixes.
 */
export function gitPatchText(
  filePath: string,
  change: FileChange,
  hunks: PatchHunk[],
  paths: GitPatchPaths = "git",
): string {
  return [
    ...gitPatchHeader(filePath, change, paths),
    ...hunks.flatMap((hunk) => [hunkHeader(hunk), ...hunk.lines]),
    "",
  ].join("\n");
}

function gitPatchHeader(filePath: string, change: FileChange, paths: GitPatchPaths): string[] {
  // A Windows path gets forward slashes so the header names the same file on
  // every platform.
  const slashed = filePath.replaceAll("\\", "/");
  // git drops one leading slash of an absolute path.
  const name = paths === "git" ? slashed.replace(/^\/+/u, "") : slashed;
  const oldName = quoteGitPath(paths === "git" ? "a/" : "", name);
  const newName = quoteGitPath(paths === "git" ? "b/" : "", name);
  // git ends a ---/+++ name that contains a space with a tab, for GNU patch.
  const tab = name.includes(" ") ? "\t" : "";
  return [
    `diff --git ${oldName} ${newName}`,
    ...(change === "create" ? ["new file mode 100644"] : []),
    `--- ${change === "create" ? "/dev/null" : `${oldName}${tab}`}`,
    `+++ ${newName}${tab}`,
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
 * The line-diff hunks between two texts. Returns undefined when the diff runs
 * out of its time budget.
 */
function diffHunks(oldText: string | null, newText: string): PatchHunk[] | undefined {
  if (oldText === null) {
    const hunk = wholeFileHunk(newText);
    return hunk ? [hunk] : [];
  }
  const oldLines = textLines(oldText);
  const newLines = textLines(newText);
  // The diff gets only the changed middle and its context lines. An edit
  // usually changes a small part of a large file.
  const common = Math.min(oldLines.length, newLines.length);
  let prefix = 0;
  while (prefix < common && oldLines[prefix] === newLines[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < common - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix++;
  }
  const skipped = Math.max(0, prefix - PATCH_CONTEXT_LINES);
  const skippedEnd = Math.max(0, suffix - PATCH_CONTEXT_LINES);
  const patch = structuredPatch(
    "",
    "",
    oldLines.slice(skipped, oldLines.length - skippedEnd).join(""),
    newLines.slice(skipped, newLines.length - skippedEnd).join(""),
    "",
    "",
    { context: PATCH_CONTEXT_LINES, timeout: PATCH_DIFF_TIMEOUT_MS },
  );
  return patch?.hunks.map((hunk) => ({
    ...hunk,
    oldStart: hunk.oldStart + skipped,
    newStart: hunk.newStart + skipped,
  }));
}

/** The lines of a text, each with its line break. The last line can have none. */
function textLines(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

/**
 * The patch of a change from `oldText`, null for a missing file, to
 * `newText`. Returns undefined when nothing changed or the diff runs out of
 * its time budget.
 */
function filePatch(oldText: string | null, newText: string): FilePatch | undefined {
  const hunks = memoizedDiffHunks(oldText, newText);
  if (!hunks || hunks.length === 0) return undefined;
  return { change: oldText === null ? "create" : "update", hunks };
}

/** The number of recent line diffs that {@link memoizedDiffHunks} keeps. */
const DIFF_MEMO_SIZE = 4;

/** Recent line diffs not read again yet, the most recent last. A text of at
 *  most {@link MAX_PATCH_FILE_BYTES} is held until it is read again or later
 *  diffs push it out. */
const diffMemo: { oldText: string | null; newText: string; hunks: PatchHunk[] }[] = [];

/**
 * {@link diffHunks} of a recent pair of texts again, without a second diff.
 *
 * The approval of an Edit or Write diffs the file against the predicted text,
 * and the PostToolUse hook diffs the same texts once Claude wrote them. On a
 * large file each diff can block the event loop for its whole time budget.
 * Only a diff that completed is remembered: one that ran out of its budget
 * says nothing about the texts, so a later call diffs them again. The hunks
 * are shared, and no caller changes them.
 */
function memoizedDiffHunks(oldText: string | null, newText: string): PatchHunk[] | undefined {
  const index = diffMemo.findIndex(
    (entry) => entry.oldText === oldText && entry.newText === newText,
  );
  if (index >= 0) {
    // The hook is normally the last reader of a pair, so the entry goes: the
    // memo does not hold two large texts longer than needed.
    const [entry] = diffMemo.splice(index, 1);
    return entry.hunks;
  }
  const hunks = diffHunks(oldText, newText);
  if (hunks) {
    diffMemo.push({ oldText, newText, hunks });
    if (diffMemo.length > DIFF_MEMO_SIZE) diffMemo.shift();
  }
  return hunks;
}

/** Forget the remembered line diffs. For tests. */
export function clearDiffMemo(): void {
  diffMemo.length = 0;
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
  let handle: FileHandle;
  try {
    // O_NONBLOCK keeps the open of a FIFO from waiting for a writer. It does not change a regular file.
    handle = await open(filePath, constants.O_RDONLY | constants.O_NONBLOCK);
  } catch (error) {
    return isMissingFileError(error) ? null : undefined;
  }
  try {
    // The checks and the read use one open file, so a swap of the path between them has no effect.
    const stats = await handle.stat();
    if (!stats.isFile() || stats.size > MAX_PATCH_FILE_BYTES) return undefined;
    // One byte more than the checked size shows a file that grew after the check.
    const buffer = Buffer.alloc(stats.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > stats.size) return undefined;
    const text = decodeFileText(buffer.subarray(0, length));
    return text?.includes("\r") ? undefined : text;
  } catch {
    return undefined;
  } finally {
    await handle.close();
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

/** The exact patch content of a change, or undefined when it has no patch. */
function exactPatch(
  filePath: string,
  oldText: string | null,
  newText: string,
  form: PatchForm,
): ToolCallContent[] | undefined {
  const patch = filePatch(oldText, newText);
  return patch && [patchContent(filePath, patch, form)];
}

/** The content that carries a patch, in the given form. */
function patchContent(filePath: string, patch: FilePatch, form: PatchForm): ToolCallContent {
  return form === "v2"
    ? v2DiffContent(filePath, patch.change, patch.hunks)
    : airPatchContent(filePath, patch);
}

/**
 * A diff block in the AIR patch form.
 *
 * `oldText: null` and `newText: ""` only satisfy the ACP schema. The adapter
 * sends this form only to a client that advertised `diffPatch`.
 */
function airPatchContent(filePath: string, { change, hunks }: FilePatch): ToolCallContent {
  return {
    type: "diff",
    path: filePath,
    oldText: null,
    newText: "",
    _meta: withAirMeta(undefined, AIR_DIFF_PATCH_CAPABILITY, {
      version: 1,
      format: "git_patch",
      text: gitPatchText(filePath, change, hunks),
    }),
  };
}

/**
 * The ACP v2 diff of a change to the text file `filePath`: the change and,
 * given hunks, its git patch.
 *
 * The agent builds tool call content in v1 types, and v1 cannot express a v2
 * diff, so the diff travels as v1 content. Nothing in the agent reads inside a
 * diff, and only a v2 client gets one: the v2 surface sends it as it is
 * (`src/v2/tool-call.ts`).
 */
export function v2DiffContent(
  filePath: string,
  change: FileChange,
  hunks?: PatchHunk[],
): ToolCallContent {
  const fileChange: v2.DiffChange =
    change === "create"
      ? { operation: "add", path: filePath, fileType: "text" }
      : { operation: "modify", path: filePath, fileType: "text" };
  const diff: V2DiffContent = {
    type: "diff",
    changes: [fileChange],
    ...(hunks?.length
      ? { patch: { format: "git_patch", text: gitPatchText(filePath, change, hunks, "absolute") } }
      : {}),
  };
  return diff as unknown as ToolCallContent;
}

function resolveToolPath(filePath: string, cwd?: string): string {
  return path.isAbsolute(filePath) ? filePath : path.resolve(cwd ?? process.cwd(), filePath);
}

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
