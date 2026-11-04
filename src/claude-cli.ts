import { existsSync } from "node:fs";

/** Returns a spawnable path to the Claude CLI embedded in a single-file build. */
export type EmbeddedClaudeCli = () => string;

let embeddedCli: EmbeddedClaudeCli | undefined;
let extractedCliPath: string | undefined;

/**
 * Called by the single-file entry (`scripts/build-binary.mjs`) before the agent
 * starts. A `bun build --compile` binary has no `node_modules` to resolve the
 * SDK's platform package from, and a child process cannot run a file inside
 * Bun's `$bunfs`, so the entry embeds the CLI and passes a function that
 * extracts it to a real path.
 */
export function useEmbeddedClaudeCli(extract: EmbeddedClaudeCli): void {
  embeddedCli = extract;
  extractedCliPath = undefined;
}

/**
 * The Claude CLI binary to spawn: `CLAUDE_CODE_EXECUTABLE` if set, then the CLI
 * embedded in a single-file build, then the SDK's platform-specific package.
 */
export async function claudeCliPath(): Promise<string> {
  if (process.env.CLAUDE_CODE_EXECUTABLE) {
    return process.env.CLAUDE_CODE_EXECUTABLE;
  }
  if (embeddedCli) {
    return embeddedClaudeCliPath(embeddedCli);
  }
  return installedClaudeCliPath();
}

function embeddedClaudeCliPath(extract: EmbeddedClaudeCli): string {
  // Extraction reads and hashes the whole ~300 MB binary, so reuse the path
  // while it exists. A temp cleaner may delete it mid-run; extract again then.
  if (extractedCliPath && existsSync(extractedCliPath)) {
    return extractedCliPath;
  }
  const path = extract();
  // `extractFromBunfs` only warns and hands back the `$bunfs` path when the
  // write fails (e.g. a read-only temp dir), and spawning that path fails with
  // a bare ENOENT.
  if (path.includes("$bunfs") || path.includes("~BUN")) {
    throw new Error(
      "Could not extract the bundled Claude CLI to the temp directory. " +
        "Set CLAUDE_CODE_TMPDIR to a writable directory, or set CLAUDE_CODE_EXECUTABLE to a Claude CLI binary.",
    );
  }
  extractedCliPath = path;
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
