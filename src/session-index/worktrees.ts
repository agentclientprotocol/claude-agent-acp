/**
 * The git worktrees of a working directory, read from the repository files.
 *
 * The SDK `listSessions({ dir })` includes the sessions of every worktree of
 * the repository and runs `git worktree list` for that on each call. This
 * module reads the same list without spawning git, the way the Codex TUI does:
 * the main worktree is the parent of the common `.git` directory, and each
 * linked worktree is named by `<common-dir>/worktrees/<name>/gitdir`.
 * A worktree whose directory no longer exists is dropped. Nothing is cached:
 * `git worktree move` rewrites a `gitdir` file without touching the
 * `worktrees` directory, so a cache keyed on it would miss the move.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { normalizePath } from "./project-dirs.js";

async function statOrUndefined(target: string) {
  try {
    return await fs.stat(target);
  } catch {
    return undefined;
  }
}

/** The git dir of the repository that contains `cwd`, or undefined. */
async function findGitDir(cwd: string): Promise<string | undefined> {
  let current = path.resolve(cwd);
  for (;;) {
    const candidate = path.join(current, ".git");
    const stats = await statOrUndefined(candidate);
    if (stats?.isDirectory()) return candidate;
    if (stats?.isFile()) {
      try {
        const text = await fs.readFile(candidate, "utf8");
        const match = /^gitdir:\s*(.+)$/m.exec(text);
        if (match) return path.resolve(current, match[1]!.trim());
      } catch {
        // An unreadable `.git` file is not a repository.
      }
      return undefined;
    }
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

async function commonDirOf(gitDir: string): Promise<string> {
  try {
    const text = await fs.readFile(path.join(gitDir, "commondir"), "utf8");
    const value = text.trim();
    if (value) return path.resolve(gitDir, value);
  } catch {
    // No `commondir`: the git dir is the common dir.
  }
  return gitDir;
}

async function linkedWorktrees(commonDir: string): Promise<string[]> {
  const worktreesDir = path.join(commonDir, "worktrees");
  const stats = await statOrUndefined(worktreesDir);
  if (!stats?.isDirectory()) return [];
  let names: string[];
  try {
    names = await fs.readdir(worktreesDir);
  } catch {
    return [];
  }
  return (
    await Promise.all(
      names.map(async (name) => {
        try {
          const text = await fs.readFile(path.join(worktreesDir, name, "gitdir"), "utf8");
          const gitFile = text.trim();
          return gitFile ? path.dirname(path.resolve(worktreesDir, name, gitFile)) : undefined;
        } catch {
          return undefined;
        }
      }),
    )
  ).filter((value): value is string => value !== undefined);
}

/**
 * Every existing worktree of the repository that contains `cwd`: the main
 * worktree and the linked ones. Empty outside a repository.
 */
export async function repositoryWorktrees(cwd: string): Promise<string[]> {
  const gitDir = await findGitDir(cwd);
  if (!gitDir) return [];
  const commonDir = await commonDirOf(gitDir);
  const candidates: string[] = [];
  if (path.basename(commonDir) === ".git") candidates.push(path.dirname(commonDir));
  candidates.push(...(await linkedWorktrees(commonDir)));
  const existing = await Promise.all(
    candidates.map(async (candidate) =>
      (await statOrUndefined(candidate))?.isDirectory() ? normalizePath(candidate) : undefined,
    ),
  );
  return [...new Set(existing.filter((value): value is string => value !== undefined))];
}
