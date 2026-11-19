import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Options } from "@anthropic-ai/claude-agent-sdk";

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

/** How an option reaches the Claude CLI: in a flag, or over stdin in the SDK's initialize request. */
type Delivery = NonNullable<Options["mcpServersDelivery"]>;

/**
 * The SDK options that say how a session's MCP servers and its `settings`
 * reach the CLI of {@link claudeCliPath}. A client's own options replace them.
 *
 * - `'initialize'` for the CLI that the adapter ships: over stdin, in the
 *   SDK's initialize request.
 * - `'argv'` for a CLI that `CLAUDE_CODE_EXECUTABLE` names: in the
 *   `--mcp-config` and `--settings` flags, as before SDK 0.3.326. Its version
 *   is not known, and a CLI that cannot take them over stdin fails the session
 *   at startup (2.1.323: "too old to read MCP servers from the initialize
 *   request", "unknown option '--initialize-fields=settings'").
 * - `settings` stay `'argv'` when the client's `extraArgs` hold `settings`:
 *   Claude Code refuses to start with both ("--initialize-fields=settings
 *   cannot be used with --settings"), and in the flag the `settings` option
 *   replaces that argument. They also stay `'argv'` with `sdk-url` in the
 *   `extraArgs`: such a session cannot read the request at launch, and the SDK
 *   sends its MCP servers in the flag for the same reason.
 *
 * The SDK reads `settingsDelivery` (0.3.328) but does not declare it in
 * `sdk.d.ts`, so nothing fails to compile if a later SDK drops it. The v2
 * integration tests check the delivery against the real CLI.
 *
 * `mcpServersDelivery` is always set. The adapter names the CLI to start
 * (`pathToClaudeCodeExecutable`), and for such an app the SDK prints a
 * `DeprecationWarning` when a session has MCP servers and the option is unset.
 */
export function cliDelivery(clientExtraArgs: Options["extraArgs"]): {
  mcpServersDelivery: Delivery;
  settingsDelivery: Delivery;
} {
  const delivery = process.env.CLAUDE_CODE_EXECUTABLE ? "argv" : "initialize";
  const settingsInFlag = Object.keys(clientExtraArgs ?? {}).some(
    (name) => name === "settings" || name === "sdk-url" || name.startsWith("sdk-url="),
  );
  return { mcpServersDelivery: delivery, settingsDelivery: settingsInFlag ? "argv" : delivery };
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
