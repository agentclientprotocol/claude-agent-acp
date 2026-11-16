import { existsSync } from "node:fs";
import { join } from "node:path";

const CLI_FILE_NAME = process.platform === "win32" ? "claude.exe" : "claude";

let bundledCliDirectory: string | undefined;

/**
 * Called by the executable's entry (`src/binary-entry.ts`) before the agent
 * starts. A `bun build --compile` executable has no `node_modules` to resolve
 * the SDK's platform package from, so the release archive ships the Claude CLI
 * next to it. The CLI isn't embedded: a child process can't run a file inside
 * Bun's `$bunfs`, so an embedded copy would have to be extracted to disk first.
 */
export function useBundledClaudeCli(directory: string): void {
  bundledCliDirectory = directory;
}

/**
 * The Claude CLI binary to spawn: `CLAUDE_CODE_EXECUTABLE` if set, then the CLI
 * shipped next to the executable, then the SDK's platform-specific package.
 */
export async function claudeCliPath(): Promise<string> {
  if (process.env.CLAUDE_CODE_EXECUTABLE) {
    return process.env.CLAUDE_CODE_EXECUTABLE;
  }
  if (bundledCliDirectory !== undefined) {
    return bundledClaudeCliPath(bundledCliDirectory);
  }
  return installedClaudeCliPath();
}

function bundledClaudeCliPath(directory: string): string {
  const path = join(directory, CLI_FILE_NAME);
  // Without this check, spawning a missing CLI fails with a bare ENOENT.
  if (!existsSync(path)) {
    throw new Error(
      `The Claude CLI is missing: expected ${path}. Keep ${CLI_FILE_NAME} from the release archive ` +
        "in the same directory as claude-agent-acp, or set CLAUDE_CODE_EXECUTABLE to a Claude CLI binary.",
    );
  }
  return path;
}

async function installedClaudeCliPath(): Promise<string> {
  // The SDK's CLI is a native binary shipped as a platform-specific optional
  // dependency of @anthropic-ai/claude-agent-sdk. Resolve via a require bound
  // to the SDK so nested installs are found even when npm doesn't hoist.
  const { createRequire } = await import("node:module");
  const req = createRequire(import.meta.resolve("@anthropic-ai/claude-agent-sdk"));
  const ext = process.platform === "win32" ? ".exe" : "";
  // On linux, both glibc and musl variants may be installed side-by-side
  // (e.g. bunx hydrates every optional dep), so picking one by trial is
  // unreliable: the wrong binary segfaults at runtime instead of failing to
  // spawn. Detect the runtime libc and prefer the matching variant, falling
  // back to the other only if the preferred one isn't installed.
  const candidates =
    process.platform === "linux"
      ? isMuslLibc()
        ? [
            `@anthropic-ai/claude-agent-sdk-linux-${process.arch}-musl/claude${ext}`,
            `@anthropic-ai/claude-agent-sdk-linux-${process.arch}/claude${ext}`,
          ]
        : [
            `@anthropic-ai/claude-agent-sdk-linux-${process.arch}/claude${ext}`,
            `@anthropic-ai/claude-agent-sdk-linux-${process.arch}-musl/claude${ext}`,
          ]
      : [`@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/claude${ext}`];
  for (const candidate of candidates) {
    try {
      return req.resolve(candidate);
    } catch {
      // try next candidate
    }
  }
  throw new Error(
    `Claude native binary not found for ${process.platform}-${process.arch}. ` +
      `Reinstall @anthropic-ai/claude-agent-sdk without --omit=optional, or set CLAUDE_CODE_EXECUTABLE.`,
  );
}

function isMuslLibc(): boolean {
  // process.report.getReport().header.glibcVersionRuntime is populated when
  // Node is dynamically linked against glibc, and absent on musl.
  const report = process.report?.getReport() as
    { header?: { glibcVersionRuntime?: string } } | undefined;
  return !report?.header?.glibcVersionRuntime;
}
