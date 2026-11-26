import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Query } from "@anthropic-ai/claude-agent-sdk";
import { claudeCliPath } from "../claude-cli.js";
import { parsePluginCommand, runPluginCommand } from "../plugin-command.js";

const execFileAsync = promisify(execFile);

/**
 * The `/plugin` command of the adapter (see `plugin-command.ts`) with the
 * bundled Claude Code CLI, in an empty home directory and a marketplace that
 * is a local directory. The cases need no account, no network and no API usage.
 */
describe.skipIf(!process.env.RUN_INTEGRATION_TESTS)("/plugin with Claude Code", () => {
  let home: string;
  let env: Record<string, string>;

  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), "acp-plugin-integration-"));
    env = {
      PATH: process.env.PATH ?? "",
      HOME: home,
      CLAUDE_CONFIG_DIR: path.join(home, "config"),
      ANTHROPIC_API_KEY: "dummy",
      NO_COLOR: "1",
    };
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it("still refuses /plugin in a headless run, which is why the adapter serves it", async () => {
    const { stdout } = await execFileAsync(
      await claudeCliPath(),
      ["-p", "--output-format", "stream-json", "--verbose", "/plugin"],
      { cwd: home, env },
    );
    const result = stdout
      .split("\n")
      .filter((line) => line.startsWith("{"))
      .map((line) => JSON.parse(line) as { type?: string; result?: string })
      .find((message) => message.type === "result");
    expect(result?.result).toContain("/plugin isn't available in this environment");
  }, 60_000);

  it("installs, lists, refuses and uninstalls a plugin of a local marketplace", async () => {
    const marketplace = path.join(home, "marketplace");
    const plugin = path.join(marketplace, "plugins", "p");
    await mkdir(path.join(marketplace, ".claude-plugin"), { recursive: true });
    await mkdir(path.join(plugin, ".claude-plugin"), { recursive: true });
    await mkdir(path.join(plugin, "commands"));
    await writeFile(
      path.join(marketplace, ".claude-plugin", "marketplace.json"),
      JSON.stringify({
        name: "m",
        owner: { name: "x" },
        plugins: [{ name: "p", source: "./plugins/p" }],
      }),
    );
    await writeFile(
      path.join(plugin, ".claude-plugin", "plugin.json"),
      JSON.stringify({ name: "p", version: "1.0.0", description: "test plugin" }),
    );
    await writeFile(path.join(plugin, "commands", "hello.md"), "Say hello.\n");

    const reloadPlugins = vi.fn(async () => ({ plugins: [{ name: "p" }] }));
    const run = (prompt: string) => {
      const command = parsePluginCommand([{ type: "text", text: prompt }]);
      if (!command) throw new Error(`not a /plugin command: ${prompt}`);
      return runPluginCommand(command, {
        cliPath: claudeCliPath,
        cwd: home,
        env,
        signal: new AbortController().signal,
        query: () => ({ reloadPlugins }) as unknown as Query,
        logError: (message) => {
          throw new Error(message);
        },
      });
    };

    const added = await run(`/plugin marketplace add ${marketplace}`);
    expect(added.ok, added.message).toBe(true);

    const installed = await run("/plugin install p@m");
    expect(installed.ok, installed.message).toBe(true);
    expect(installed.reload?.status).toBe("applied");
    expect(reloadPlugins).toHaveBeenCalledTimes(1);

    const listed = await run("/plugin list");
    expect(listed.ok, listed.message).toBe(true);
    expect(JSON.stringify(listed.data)).toContain("p@m");

    const enabled = await run("/plugin enable unknown");
    expect(enabled).toMatchObject({ ok: false, failureCode: "not_installed" });

    const uninstalled = await run("/plugin uninstall p");
    expect(uninstalled.ok, uninstalled.message).toBe(true);
    expect(reloadPlugins).toHaveBeenCalledTimes(2);
    expect(JSON.stringify((await run("/plugin list")).data)).not.toContain("p@m");
  }, 120_000);
});
