/**
 * Where Claude Code keeps the transcripts of a working directory.
 *
 * The CLI stores the transcripts of `cwd` in `<config>/projects/<encoded cwd>/`.
 * The encoding replaces every character that is not ASCII alphanumeric with `-`.
 * A name longer than {@link MAX_SANITIZED_LENGTH} is cut and gets a hash
 * suffix; the CLI (Bun) and the SDK (Node) compute different hashes, so a long
 * name is matched by its prefix, as the SDK does.
 *
 * The encoding is lossy (`/a/b-c` and `/a/b/c` share a directory), so a
 * directory name is never decoded: a path belongs to a directory only when
 * the path encodes to the name.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { claudeConfigDir } from "../paths.js";

/** The SDK cuts an encoded path at this length and appends a hash. */
const MAX_SANITIZED_LENGTH = 200;

const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Whether `value` is a Claude session id (a UUID). Only such ids name a
 *  transcript, and only such ids are safe to use as a file name. */
export function isSessionId(value: unknown): value is string {
  return typeof value === "string" && SESSION_ID_PATTERN.test(value);
}

/** `<config>/projects`, normalized like the SDK does. */
export function projectsRoot(): string {
  return path.join(claudeConfigDir(), "projects").normalize("NFC");
}

function sanitize(value: string): string {
  return value.replace(/[^a-zA-Z0-9]/g, "-");
}

/** The SDK's 32-bit string hash for long project names. */
function hashCode(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i++) {
    hash = ((hash << 5) - hash + value.charCodeAt(i)) | 0;
  }
  return hash;
}

/** The project directory name of `cwd`, exactly as the SDK computes it. */
export function encodeProjectPath(cwd: string): string {
  const sanitized = sanitize(normalizePath(cwd));
  if (sanitized.length <= MAX_SANITIZED_LENGTH) return sanitized;
  return `${sanitized.slice(0, MAX_SANITIZED_LENGTH)}-${Math.abs(hashCode(normalizePath(cwd))).toString(36)}`;
}

/** NFC on darwin, as the SDK normalizes paths there. */
export function normalizePath(value: string): string {
  return process.platform === "darwin" ? value.normalize("NFC") : value;
}

function sameName(a: string, b: string): boolean {
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/**
 * Whether `dirName` is the project directory of `cwd`: the exact encoding, or,
 * for a long path, a directory with the same cut prefix and any hash suffix.
 */
export function projectDirMatches(dirName: string, cwd: string): boolean {
  if (sameName(dirName, encodeProjectPath(cwd))) return true;
  const sanitized = sanitize(normalizePath(cwd));
  if (sanitized.length <= MAX_SANITIZED_LENGTH) return false;
  const prefix = `${sanitized.slice(0, MAX_SANITIZED_LENGTH)}-`;
  const name = process.platform === "win32" ? dirName.toLowerCase() : dirName;
  return name.startsWith(process.platform === "win32" ? prefix.toLowerCase() : prefix);
}

/** Whether a transcript's `cwd` belongs to `projectPath`, compared the way
 *  the SDK does: the full sanitized forms, ignoring case where the file
 *  system does. */
export function sameProjectPath(cwd: string, projectPath: string): boolean {
  const a = sanitize(normalizePath(cwd));
  const b = sanitize(normalizePath(projectPath));
  return process.platform === "win32" || process.platform === "darwin"
    ? a.toLowerCase() === b.toLowerCase()
    : a === b;
}

/** The real path of `cwd`, like the SDK resolves it before encoding. Falls
 *  back to `cwd` when it does not exist. */
export async function canonicalPath(cwd: string): Promise<string> {
  try {
    return normalizePath(await fs.realpath(cwd));
  } catch {
    return normalizePath(cwd);
  }
}

/** The names of the project directories of `cwd` among `rootEntries`. */
export function projectDirsOf(cwd: string, rootEntries: readonly string[]): string[] {
  const exact = encodeProjectPath(cwd);
  const sanitizedLength = sanitize(normalizePath(cwd)).length;
  if (sanitizedLength <= MAX_SANITIZED_LENGTH) {
    return rootEntries.filter((name) => sameName(name, exact));
  }
  return rootEntries.filter((name) => projectDirMatches(name, cwd));
}

/** `value` and each of its ancestors, nearest first. */
export function pathAndAncestors(value: string): string[] {
  const result: string[] = [];
  let current = value;
  for (;;) {
    result.push(current);
    const parent = path.dirname(current);
    if (parent === current) return result;
    current = parent;
  }
}

/** The `code` of a Node.js system error, if it has one. */
export function errorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : undefined;
}
