import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "claude-cli-"));
    vi.stubEnv("CLAUDE_CODE_EXECUTABLE", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
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
    writeFileSync(join(dir, cliFileName), "");
    useBundledClaudeCli(dir);

    expect(await claudeCliPath()).toBe(join(dir, cliFileName));
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

describe("cliDelivery", () => {
  afterEach(() => vi.unstubAllEnvs());

  it.each<{
    name: string;
    cli: string;
    extraArgs?: Record<string, string>;
    mcpServers: string;
    settings: string;
  }>([
    {
      name: "is stdin for the CLI that it ships",
      cli: "",
      mcpServers: "initialize",
      settings: "initialize",
    },
    {
      name: "is a flag for a CLAUDE_CODE_EXECUTABLE",
      cli: "/opt/claude",
      mcpServers: "argv",
      settings: "argv",
    },
    {
      name: "keeps settings a flag beside a client's",
      cli: "",
      extraArgs: { settings: "{}" },
      mcpServers: "initialize",
      settings: "argv",
    },
    {
      name: "keeps settings a flag with sdk-url",
      cli: "",
      extraArgs: { "sdk-url": "wss://example.com/session" },
      mcpServers: "initialize",
      settings: "argv",
    },
  ])("$name", async ({ cli, extraArgs, mcpServers, settings }) => {
    vi.stubEnv("CLAUDE_CODE_EXECUTABLE", cli);
    const { cliDelivery } = await load();

    expect(cliDelivery(extraArgs)).toEqual({
      mcpServersDelivery: mcpServers,
      settingsDelivery: settings,
    });
  });
});
