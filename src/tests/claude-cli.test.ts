import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Fresh module state per test: the bundled CLI directory is process-wide.
async function load() {
  vi.resetModules();
  return import("../claude-cli.js");
}

describe("claudeCliPath", () => {
  let dir: string;
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "claude-cli-tmp-"));
    dir = mkdtempSync(join(tmpdir(), "claude-cli-"));
    vi.stubEnv("CLAUDE_CODE_EXECUTABLE", "");
    // Keep the pins out of the real temp directory.
    vi.stubEnv("TMPDIR", tmp);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
    rmSync(tmp, { recursive: true, force: true });
  });

  const cliFileName = process.platform === "win32" ? "claude.exe" : "claude";

  it("prefers CLAUDE_CODE_EXECUTABLE over the bundled CLI", async () => {
    const { claudeCliPath, useBundledClaudeCli } = await load();
    writeFileSync(join(dir, cliFileName), "");
    useBundledClaudeCli(dir);
    vi.stubEnv("CLAUDE_CODE_EXECUTABLE", "/opt/claude");

    expect(await claudeCliPath()).toBe("/opt/claude");
  });

  it("returns the CLI next to the executable", async () => {
    const { claudeCliPath, useBundledClaudeCli } = await load();
    writeFileSync(join(dir, cliFileName), "cli-v1");
    useBundledClaudeCli(dir);

    const path = await claudeCliPath();
    expect(path).toBe(join(tmp, `claude-agent-acp-cli-${process.pid}`, cliFileName));
    expect(readFileSync(path, "utf8")).toBe("cli-v1");
  });

  it("keeps the CLI usable after the release directory is deleted (#1596)", async () => {
    const { claudeCliPath, useBundledClaudeCli } = await load();
    writeFileSync(join(dir, cliFileName), "cli-v1");
    useBundledClaudeCli(dir);
    rmSync(dir, { recursive: true, force: true });

    const path = await claudeCliPath();
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, "utf8")).toBe("cli-v1");
  });

  it("throws a clear error when the release directory is gone and nothing was pinned", async () => {
    const { claudeCliPath, useBundledClaudeCli } = await load();
    const gone = join(dir, "never-created");
    useBundledClaudeCli(gone);

    await expect(claudeCliPath()).rejects.toThrow(
      `claude-agent-acp was updated or removed while it was running: ${gone} no longer exists.`,
    );
  });

  it("removes the pins of dead processes and keeps those of live ones", async () => {
    const { useBundledClaudeCli } = await load();
    writeFileSync(join(dir, cliFileName), "cli-v1");
    const stale = join(tmp, `claude-agent-acp-cli-${2 ** 22 + 1}`);
    const live = join(tmp, `claude-agent-acp-cli-${process.ppid}`);
    mkdirSync(stale);
    mkdirSync(live);
    useBundledClaudeCli(dir);

    expect(existsSync(stale)).toBe(false);
    expect(existsSync(live)).toBe(true);
    expect(existsSync(join(tmp, `claude-agent-acp-cli-${process.pid}`, cliFileName))).toBe(true);
  });

  it("throws when the CLI is missing next to the executable", async () => {
    const { claudeCliPath, useBundledClaudeCli } = await load();
    useBundledClaudeCli(dir);

    await expect(claudeCliPath()).rejects.toThrow(
      `The Claude CLI is missing: expected ${join(dir, cliFileName)}. Keep ${cliFileName} from the release archive`,
    );
  });

  it.skipIf(!process.env.RUN_INTEGRATION_TESTS)("finds the installed CLI", async () => {
    const { claudeCliPath } = await load();
    expect(await claudeCliPath()).toMatch(/@anthropic-ai\/claude-agent-sdk-[^/]+\/claude(\.exe)?$/);
  });
});
