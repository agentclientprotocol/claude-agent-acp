import { existsSync, linkSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI_FILE_NAME = process.platform === "win32" ? "claude.exe" : "claude";

const PIN_DIRECTORY_PREFIX = "claude-agent-acp-cli-";

let bundledCliDirectory: string | undefined;
let pinnedCliPath: string | undefined;

/**
 * Called by the executable's entry (`src/binary-entry.ts`) before the agent
 * starts. A `bun build --compile` executable has no `node_modules` to resolve
 * the SDK's platform package from, so the release archive ships the Claude CLI
 * next to it. The CLI isn't embedded: a child process can't run a file inside
 * Bun's `$bunfs`, so an embedded copy would have to be extracted to disk first.
 */
export function useBundledClaudeCli(directory: string): void {
  bundledCliDirectory = directory;
  pinBundledCli(directory);
}

/**
 * Hard-links the bundled CLI into a directory this process owns. Zed's agent
 * registry installs each release in its own `v_<version>_…` directory and
 * deletes the old one when another session pulls an update, while this process
 * keeps running. A hard link shares the inode, so it costs no disk space and
 * stays readable after the release directory is gone. Without it, the first
 * CLI spawn after the update (e.g. approving a plan with a fresh context) fails
 * with "The Claude CLI is missing".
 *
 * Never throws: when linking fails (EXDEV if the temp directory is on another
 * volume, EPERM, …), `claudeCliPath` uses the release directory as before.
 */
function pinBundledCli(directory: string): void {
  pinnedCliPath = undefined;
  const source = join(directory, CLI_FILE_NAME);
  if (!existsSync(source)) return;
  try {
    sweepStalePins();
    const pinDirectory = join(tmpdir(), `${PIN_DIRECTORY_PREFIX}${process.pid}`);
    rmSync(pinDirectory, { recursive: true, force: true });
    mkdirSync(pinDirectory, { recursive: true });
    const pin = join(pinDirectory, CLI_FILE_NAME);
    linkSync(source, pin);
    process.on("exit", () => rmSync(pinDirectory, { recursive: true, force: true }));
    pinnedCliPath = pin;
  } catch (error) {
    console.warn(`Could not pin the bundled Claude CLI; using ${source} directly:`, error);
  }
}

/** Removes the pins of processes that died without running their exit handler
 *  (a crash or SIGKILL), which would otherwise keep a full CLI's inode alive. */
function sweepStalePins(): void {
  for (const entry of readdirSync(tmpdir())) {
    if (!entry.startsWith(PIN_DIRECTORY_PREFIX)) continue;
    const pid = Number(entry.slice(PIN_DIRECTORY_PREFIX.length));
    if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) continue;
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as { code?: string }).code !== "ESRCH") continue;
      rmSync(join(tmpdir(), entry), { recursive: true, force: true });
    }
  }
}

/**
 * The Claude CLI binary to spawn: `CLAUDE_CODE_EXECUTABLE` if set, then the
 * pinned link to the CLI shipped next to the executable, then that CLI itself, then the SDK's platform-specific package.
 */
export async function claudeCliPath(): Promise<string> {
  if (process.env.CLAUDE_CODE_EXECUTABLE) {
    return process.env.CLAUDE_CODE_EXECUTABLE;
  }
  if (pinnedCliPath !== undefined && existsSync(pinnedCliPath)) {
    return pinnedCliPath;
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
    if (!existsSync(directory)) {
      throw new Error(
        `claude-agent-acp was updated or removed while it was running: ${directory} no longer exists. ` +
          "Restart the agent to use the installed version.",
      );
    }
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
