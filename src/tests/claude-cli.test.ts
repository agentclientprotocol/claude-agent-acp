import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Fresh module state per test: the embedded CLI is process-wide.
async function load() {
  vi.resetModules();
  return import("../claude-cli.js");
}

describe("claudeCliPath", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "claude-cli-"));
    vi.stubEnv("CLAUDE_CODE_EXECUTABLE", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  });

  it("prefers CLAUDE_CODE_EXECUTABLE over the embedded CLI", async () => {
    const { claudeCliPath, useEmbeddedClaudeCli } = await load();
    const extract = vi.fn(() => join(dir, "claude"));
    useEmbeddedClaudeCli(extract);
    vi.stubEnv("CLAUDE_CODE_EXECUTABLE", "/opt/claude");

    expect(await claudeCliPath()).toBe("/opt/claude");
    expect(extract).not.toHaveBeenCalled();
  });

  it("extracts the embedded CLI once while the extracted file exists", async () => {
    const { claudeCliPath, useEmbeddedClaudeCli } = await load();
    const extracted = join(dir, "claude");
    const extract = vi.fn(() => {
      writeFileSync(extracted, "");
      return extracted;
    });
    useEmbeddedClaudeCli(extract);

    expect(await claudeCliPath()).toBe(extracted);
    expect(await claudeCliPath()).toBe(extracted);
    expect(extract).toHaveBeenCalledTimes(1);

    rmSync(extracted);
    expect(await claudeCliPath()).toBe(extracted);
    expect(extract).toHaveBeenCalledTimes(2);
  });

  it.each(["/$bunfs/root/claude", "B:\\~BUN\\root\\claude.exe"])(
    "throws when extraction falls back to the embedded path %s",
    async (embedded) => {
      const { claudeCliPath, useEmbeddedClaudeCli } = await load();
      useEmbeddedClaudeCli(() => embedded);

      await expect(claudeCliPath()).rejects.toThrow(
        "Could not extract the bundled Claude CLI to the temp directory. Set CLAUDE_CODE_TMPDIR",
      );
    },
  );

  it.skipIf(!process.env.RUN_INTEGRATION_TESTS)("finds the installed CLI", async () => {
    const { claudeCliPath } = await load();
    expect(await claudeCliPath()).toMatch(/@anthropic-ai\/claude-agent-sdk-[^/]+\/claude(\.exe)?$/);
  });
});
