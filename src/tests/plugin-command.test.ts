import { describe, expect, it, vi } from "vitest";
import type { Query } from "@anthropic-ai/claude-agent-sdk";
import {
  PLUGIN_AVAILABLE_COMMAND,
  parsePluginCommand,
  pluginCommandMarkdown,
  runPluginCommand,
  type ExecLike,
  type PluginCommand,
  type PluginCommandDeps,
  type PluginCommandResult,
} from "../plugin-command.js";

const text = (value: string) => [{ type: "text", text: value }];
const cli = (operation: string, argv: string[], target?: string): PluginCommand =>
  ({ kind: "cli", operation, argv, ...(target === undefined ? {} : { target }) }) as PluginCommand;

describe("PLUGIN_AVAILABLE_COMMAND", () => {
  it("is named plugin with an input hint", () => {
    expect(PLUGIN_AVAILABLE_COMMAND.name).toBe("plugin");
    expect(PLUGIN_AVAILABLE_COMMAND.input).toMatchObject({ hint: expect.any(String) });
  });
});

describe("parsePluginCommand", () => {
  it.each<[string, PluginCommand | null]>([
    ["/plugin", { kind: "overview" }],
    ["  /plugins  ", { kind: "overview" }],
    ["/marketplace", { kind: "overview" }],
    ["/plugin help", { kind: "overview" }],
    ["/pluginx", null],
    ["/pluginfoo list", null],
    ["/plugins-extra", null],
    ["plugin list", null],
    ["hello /plugin", null],
    ["/plugin list", cli("list", ["list"])],
    ["/plugin ls --available", cli("list", ["list", "--available"])],
    ["/plugins list", cli("list", ["list"])],
    ["/plugin install p@m", cli("install", ["install", "p@m"], "p@m")],
    ["/plugin i p", cli("install", ["install", "p"], "p")],
    [
      "/plugin install p --scope project --marketplace owner/repo --config a=1 --config b=2",
      cli(
        "install",
        [
          "install",
          "p",
          "--scope",
          "project",
          "--marketplace",
          "owner/repo",
          "--config",
          "a=1",
          "--config",
          "b=2",
        ],
        "p",
      ),
    ],
    ["/plugin install p -s local", cli("install", ["install", "p", "--scope", "local"], "p")],
    ["/plugin install p --scope=user", cli("install", ["install", "p", "--scope", "user"], "p")],
    ["/plugin uninstall p --keep-data", cli("uninstall", ["uninstall", "p", "--keep-data"], "p")],
    ["/plugin remove p", cli("uninstall", ["uninstall", "p"], "p")],
    ["/plugin rm p -s user", cli("uninstall", ["uninstall", "p", "--scope", "user"], "p")],
    ["/plugin enable p@m", cli("enable", ["enable", "p@m"], "p@m")],
    ["/plugin disable p", cli("disable", ["disable", "p"], "p")],
    ["/plugin disable -a", cli("disable", ["disable", "--all"])],
    ["/plugin disable --all --scope user", cli("disable", ["disable", "--scope", "user", "--all"])],
    ["/plugin update p@m", cli("update", ["update", "p@m"], "p@m")],
    [
      "/plugin marketplace add ./dir --scope local --sparse .claude-plugin plugins",
      cli(
        "marketplace-add",
        [
          "marketplace",
          "add",
          "./dir",
          "--scope",
          "local",
          "--sparse",
          ".claude-plugin",
          "plugins",
        ],
        "./dir",
      ),
    ],
    ["/plugin market list", cli("marketplace-list", ["marketplace", "list"])],
    ["/plugin marketplace rm m", cli("marketplace-remove", ["marketplace", "remove", "m"], "m")],
    ["/plugin marketplace update", cli("marketplace-update", ["marketplace", "update"])],
    [
      "/plugin marketplace update m",
      cli("marketplace-update", ["marketplace", "update", "m"], "m"),
    ],
  ])("%s", (prompt, expected) => {
    expect(parsePluginCommand(text(prompt))).toEqual(expected);
  });

  it.each([
    "/plugin install",
    "/plugin install p -y",
    "/plugin install p --yes",
    "/plugin install p --accept-command abc",
    "/plugin install p --accept-command=abc",
    "/plugin install p --config=--yes",
    "/plugin marketplace add x --sparse=-y",
    "/plugin install p --marketplace=--accept-command",
    "/plugin install p --json",
    "/plugin install p --scope managed",
    "/plugin install p --scope",
    "/plugin install p q",
    "/plugin install p --marketplace --scope user",
    "/plugin uninstall p --prune",
    "/plugin update p --all",
    "/plugin list --json",
    "/plugin list --data-size",
    "/plugin list extra",
    "/plugin enable",
    "/plugin disable",
    "/plugin disable p --all",
    "/plugin marketplace",
    "/plugin marketplace add",
    "/marketplace add owner/repo",
    "/plugin add owner/repo",
    "/plugin marketplace add x --claudeai",
    "/plugin marketplace remove",
    "/plugin marketplace update m extra",
    "/plugin marketplace frob",
    "/plugin install --help",
    "/plugin tag",
    "/plugin validate .",
    "/plugin configure p",
    "/plugin init",
    "/plugin eval",
    "/plugin test",
    "/plugin prune",
    "/plugin restore-set-aside",
    "/plugin details p",
  ])("%s is usage and no CLI call", (prompt) => {
    expect(parsePluginCommand(text(prompt))).toMatchObject({ kind: "usage" });
  });

  it.each([
    ["two blocks", [...text("/plugin list"), ...text("more")]],
    ["an image", [{ type: "image" }]],
    ["no blocks", []],
  ])("ignores a prompt with %s", (_name, prompt) => {
    expect(parsePluginCommand(prompt)).toBeNull();
  });
});

type Call = { file: string; args: string[]; cwd: string; env: Record<string, string | undefined> };
type Reply = { stdout?: string; stderr?: string; code?: number } | Error;

function setup(replies: Reply[], overrides: Partial<PluginCommandDeps> = {}) {
  const calls: Call[] = [];
  const exec: ExecLike = async (file, args, options) => {
    calls.push({ file, args, cwd: options.cwd, env: options.env });
    const reply = replies.shift() ?? { stdout: "", code: 0 };
    if (reply instanceof Error) throw reply;
    return { stdout: reply.stdout ?? "", stderr: reply.stderr ?? "", code: reply.code ?? 0 };
  };
  const reloadPlugins = vi.fn().mockResolvedValue({ plugins: [{ name: "p" }, { name: "q" }] });
  const logError = vi.fn();
  const deps: PluginCommandDeps = {
    cliPath: async () => "/bin/claude",
    cwd: "/work",
    env: { PATH: "/bin", CLAUDECODE: "1", CLAUDE_CODE_CHILD_SESSION: "1", KEEP: "yes" },
    signal: new AbortController().signal,
    query: () => ({ reloadPlugins }) as unknown as Query,
    logError,
    exec,
    ...overrides,
  };
  return { deps, calls, reloadPlugins, logError };
}

const ok = (fields: Record<string, unknown>) => JSON.stringify({ outcome: "ok", ...fields }) + "\n";

const INSTALL_OK = ok({
  command: "install",
  plugin: "p@m",
  pluginId: "p@m",
  scope: "user",
  message: "Successfully installed plugin: p@m (scope: user)",
});

const LIST_JSON = JSON.stringify(
  [
    {
      id: "p@m",
      version: "1.0.0",
      scope: "user",
      enabled: true,
      installPath: "/h/.claude/plugins/cache/m/p/1.0.0",
      projectEnabled: false,
    },
  ],
  null,
  2,
);

describe("runPluginCommand", () => {
  it("runs the CLI with --json, the session cwd, and an env without the session markers", async () => {
    const { deps, calls } = setup([{ stdout: INSTALL_OK }]);
    const result = await runPluginCommand(cli("install", ["install", "p@m"], "p@m"), deps);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      file: "/bin/claude",
      args: ["plugin", "install", "p@m", "--json"],
      cwd: "/work",
    });
    expect(calls[0]!.env).toEqual({ PATH: "/bin", KEEP: "yes" });
    expect(result).toMatchObject({
      ok: true,
      operation: "install",
      message: "Successfully installed plugin: p@m (scope: user)",
    });
  });

  it("reads the last stdout line when text comes before it", async () => {
    const { deps } = setup([{ stdout: `Cloning…\nValidating\n${INSTALL_OK}\n` }]);
    const result = await runPluginCommand(cli("install", ["install", "p@m"], "p@m"), deps);
    expect(result.ok).toBe(true);
    expect(result.message).toContain("Successfully installed");
  });

  it("fails with the CLI message on exit 1 with JSON", async () => {
    const failure = JSON.stringify({
      command: "marketplace-add",
      outcome: "failed",
      message: "Path does not exist: /nonexistent",
      failureCode: "invalid_source",
    });
    const { deps, reloadPlugins } = setup([
      { stdout: failure + "\n", stderr: "✘ Path does not exist: /nonexistent\n", code: 1 },
    ]);
    const result = await runPluginCommand(
      cli("marketplace-add", ["marketplace", "add", "/nonexistent"], "/nonexistent"),
      deps,
    );
    expect(result).toEqual({
      ok: false,
      operation: "marketplace-add",
      message: "Path does not exist: /nonexistent",
      failureCode: "invalid_source",
    });
    expect(reloadPlugins).not.toHaveBeenCalled();
  });

  it("falls back to text and the exit code when there is no JSON", async () => {
    const { deps } = setup([{ stderr: "Please specify a plugin name\n", code: 1 }]);
    const failed = await runPluginCommand(cli("update", ["update", "p"], "p"), deps);
    expect(failed).toMatchObject({ ok: false, message: "Please specify a plugin name" });

    const { deps: succeeding } = setup([{ stdout: "Updating marketplaces...done\n" }]);
    const done = await runPluginCommand(
      cli("marketplace-update", ["marketplace", "update"]),
      succeeding,
    );
    expect(done).toMatchObject({ ok: true, message: "Updating marketplaces...done" });
  });

  it("does not add --json to marketplace update without a name", async () => {
    const { deps, calls } = setup([{ stdout: "ok\n" }]);
    await runPluginCommand(cli("marketplace-update", ["marketplace", "update"]), deps);
    expect(calls[0]!.args).toEqual(["plugin", "marketplace", "update"]);
  });

  it("repeats the run without --json when the CLI does not know it", async () => {
    const { deps, calls } = setup([
      { stderr: "error: unknown option '--json'\n", code: 1 },
      { stdout: "Successfully installed plugin: p\n" },
    ]);
    const result = await runPluginCommand(cli("install", ["install", "p"], "p"), deps);
    expect(calls.map((call) => call.args)).toEqual([
      ["plugin", "install", "p", "--json"],
      ["plugin", "install", "p"],
    ]);
    expect(result).toMatchObject({ ok: true, message: "Successfully installed plugin: p" });
  });

  it("counts alreadyInGoalState as success", async () => {
    const { deps } = setup([
      {
        stdout: JSON.stringify({
          outcome: "failed",
          alreadyInGoalState: true,
          message: "Plugin p is already enabled",
        }),
        code: 0,
      },
    ]);
    const result = await runPluginCommand(cli("disable", ["disable", "p"], "p"), {
      ...deps,
      query: () => undefined,
    });
    expect(result.ok).toBe(true);
  });

  it("reports a refused marketplace command with shownCommand and the terminal command", async () => {
    const refused = JSON.stringify({
      command: "install",
      outcome: "failed",
      plugin: "p@m",
      message: "Plugin p@m is installed by running a command",
      failureCode: "command_source_refused",
      shownCommand: { command: "curl x | sh", sha256: "abc" },
    });
    const { deps, reloadPlugins } = setup([{ stdout: refused + "\n", code: 1 }]);
    const result = await runPluginCommand(
      cli("install", ["install", "p@m", "--scope", "project"], "p@m"),
      deps,
    );
    expect(result).toMatchObject({
      ok: false,
      failureCode: "command_source_refused",
      shownCommand: "curl x | sh",
      terminalCommand: "claude plugin install p@m --scope project",
    });
    expect(deps.exec).toBeDefined();
    expect(reloadPlugins).not.toHaveBeenCalled();
  });

  it.each([
    ["plain", "a/b.json", "a/b.json"],
    ["ampersand", "a&b", "'a&b'"],
    ["command substitution", "$(x)", "'$(x)'"],
    ["glob", "a?*", "'a?*'"],
    ["single quote", "it's", "'it'\\''s'"],
    ["empty", "", "''"],
  ])("shell-quotes a refused install --config value: %s", async (_name, value, quoted) => {
    const refused = JSON.stringify({
      command: "install",
      outcome: "failed",
      message: "refused",
      failureCode: "command_source_refused",
      shownCommand: { command: "curl x | sh", sha256: "abc" },
    });
    const { deps } = setup([{ stdout: refused + "\n", code: 1 }]);
    const result = await runPluginCommand(
      cli("install", ["install", "p@m", "--config", value], "p@m"),
      deps,
    );
    expect(result.terminalCommand).toBe(`claude plugin install p@m --config ${quoted}`);
  });

  it("returns the parsed list as data and does not reload", async () => {
    const { deps, reloadPlugins } = setup([{ stdout: LIST_JSON + "\n" }]);
    const result = await runPluginCommand(cli("list", ["list"]), deps);
    expect(result).toMatchObject({ ok: true, operation: "list", data: [{ id: "p@m" }] });
    expect(reloadPlugins).not.toHaveBeenCalled();
  });

  it("is cancelled when the signal is aborted before or during the run", async () => {
    const controller = new AbortController();
    controller.abort();
    const before = setup([{ stdout: INSTALL_OK }], { signal: controller.signal });
    expect(await runPluginCommand(cli("install", ["install", "p"], "p"), before.deps)).toEqual({
      ok: false,
      operation: "install",
      message: "Cancelled.",
    });
    expect(before.calls).toHaveLength(0);

    const during = new AbortController();
    const { deps, reloadPlugins } = setup([], {
      signal: during.signal,
      exec: async () => {
        during.abort();
        throw new Error("The operation was aborted");
      },
    });
    const result = await runPluginCommand(cli("install", ["install", "p"], "p"), deps);
    expect(result).toMatchObject({ ok: false, message: "Cancelled." });
    expect(reloadPlugins).not.toHaveBeenCalled();
  });

  it("turns a spawn error into a failed result and logs it", async () => {
    const { deps, logError } = setup([new Error("spawn /bin/claude ENOENT")]);
    const result = await runPluginCommand(cli("install", ["install", "p"], "p"), deps);
    expect(result).toMatchObject({ ok: false });
    expect(result.message).toContain("ENOENT");
    expect(logError).toHaveBeenCalled();
  });

  it("turns a failing cliPath into a failed result", async () => {
    const { deps } = setup([], {
      cliPath: async () => {
        throw new Error("The Claude CLI is missing");
      },
    });
    const result = await runPluginCommand(cli("list", ["list"]), deps);
    expect(result).toMatchObject({ ok: false });
    expect(result.message).toContain("The Claude CLI is missing");
  });

  describe("enable", () => {
    it("refuses a plugin that is not installed, without calling enable", async () => {
      const { deps, calls } = setup([{ stdout: LIST_JSON }]);
      const result = await runPluginCommand(
        cli("enable", ["enable", "nothere@m"], "nothere@m"),
        deps,
      );
      expect(result).toMatchObject({
        ok: false,
        operation: "enable",
        failureCode: "not_installed",
      });
      expect(calls.map((call) => call.args)).toEqual([["plugin", "list", "--json"]]);
    });

    it.each(["p@m", "p"])("enables the installed plugin %s", async (name) => {
      const enabled = ok({
        command: "enable",
        plugin: name,
        message: "Successfully enabled plugin: p",
      });
      const { deps, calls } = setup([{ stdout: LIST_JSON }, { stdout: enabled }]);
      const result = await runPluginCommand(cli("enable", ["enable", name], name), deps);
      expect(result.ok).toBe(true);
      expect(calls[1]!.args).toEqual(["plugin", "enable", name, "--json"]);
    });
  });

  describe("reload", () => {
    it.each([
      ["install", cli("install", ["install", "p@m"], "p@m")],
      ["uninstall", cli("uninstall", ["uninstall", "p@m"], "p@m")],
      ["disable", cli("disable", ["disable", "p@m"], "p@m")],
      ["update", cli("update", ["update", "p@m"], "p@m")],
      ["marketplace-remove", cli("marketplace-remove", ["marketplace", "remove", "m"], "m")],
    ])("runs after %s", async (_name, command) => {
      const { deps, reloadPlugins } = setup([{ stdout: INSTALL_OK }]);
      const result = await runPluginCommand(command, deps);
      expect(reloadPlugins).toHaveBeenCalledWith({ refuseIfBusy: true });
      expect(result.reload).toEqual({ status: "applied", plugins: ["p", "q"] });
    });

    it("runs after enable", async () => {
      const { deps, reloadPlugins } = setup([{ stdout: LIST_JSON }, { stdout: INSTALL_OK }]);
      await runPluginCommand(cli("enable", ["enable", "p@m"], "p@m"), deps);
      expect(reloadPlugins).toHaveBeenCalledTimes(1);
    });

    it.each([
      ["list", cli("list", ["list"])],
      ["marketplace-list", cli("marketplace-list", ["marketplace", "list"])],
      ["marketplace-add", cli("marketplace-add", ["marketplace", "add", "x"], "x")],
      ["marketplace-update", cli("marketplace-update", ["marketplace", "update", "m"], "m")],
    ])("does not run after %s", async (_name, command) => {
      const { deps, reloadPlugins } = setup([{ stdout: LIST_JSON }]);
      const result = await runPluginCommand(command, deps);
      expect(reloadPlugins).not.toHaveBeenCalled();
      expect(result.reload).toBeUndefined();
    });

    it.each([
      [
        "busy",
        Object.assign(new Error("busy"), { errorCode: "reload_plugins_busy" }),
        { status: "busy" },
      ],
      ["failed", new Error("boom"), { status: "failed", error: "boom" }],
    ])("reports %s", async (_name, error, expected) => {
      const { deps, reloadPlugins, logError } = setup([{ stdout: INSTALL_OK }]);
      reloadPlugins.mockRejectedValue(error);
      const result = await runPluginCommand(cli("install", ["install", "p@m"], "p@m"), deps);
      expect(result.ok).toBe(true);
      expect(result.reload).toEqual(expected);
      expect(logError).toHaveBeenCalledTimes(expected.status === "failed" ? 1 : 0);
    });

    it("reports unavailable without a query, and reads the query after the CLI ends", async () => {
      let current: Query | undefined = { reloadPlugins: vi.fn() } as unknown as Query;
      const replacement = vi.fn().mockResolvedValue({ plugins: [] });
      const { deps } = setup([], {
        query: () => current,
        exec: async () => {
          current ??= undefined;
          if (current) current = { reloadPlugins: replacement } as unknown as Query;
          return { stdout: INSTALL_OK, stderr: "", code: 0 };
        },
      });
      const replaced = await runPluginCommand(cli("install", ["install", "p"], "p"), deps);
      expect(replacement).toHaveBeenCalledTimes(1);
      expect(replaced.reload).toEqual({ status: "applied", plugins: [] });

      current = undefined;
      const none = await runPluginCommand(cli("install", ["install", "p"], "p"), deps);
      expect(none.reload).toEqual({ status: "unavailable" });
    });
  });

  it("returns usage and an overview without running a mutating command", async () => {
    const usage = setup([]);
    expect(await runPluginCommand({ kind: "usage", reason: "no" }, usage.deps)).toMatchObject({
      ok: false,
      operation: "usage",
      message: "no",
    });
    expect(usage.calls).toHaveLength(0);

    const overview = setup([
      { stdout: LIST_JSON },
      { stdout: JSON.stringify([{ name: "m", source: "directory", path: "/x" }]) },
    ]);
    const result = await runPluginCommand({ kind: "overview" }, overview.deps);
    expect(overview.calls.map((call) => call.args).sort()).toEqual([
      ["plugin", "list", "--json"],
      ["plugin", "marketplace", "list", "--json"],
    ]);
    expect(result.data).toMatchObject({ plugins: [{ id: "p@m" }], marketplaces: [{ name: "m" }] });
  });

  describe("overview failures", () => {
    const section = (markdown: string, title: string) =>
      markdown.split("\n\n**").find((block) => block.replace(/^\*\*/, "").startsWith(title)) ?? "";

    it("reports both lists failing instead of None", async () => {
      const { deps } = setup([new Error("spawn ENOENT"), { stderr: "boom", code: 2 }]);
      const result = await runPluginCommand({ kind: "overview" }, deps);
      expect(result.ok).toBe(false);
      const markdown = pluginCommandMarkdown(result);
      expect(markdown).not.toContain("None");
      expect(markdown).toContain("spawn ENOENT");
      expect(markdown).toContain("boom");
    });

    it("reports only the list that failed", async () => {
      const { deps } = setup([{ stdout: LIST_JSON }, { stderr: "no marketplaces", code: 1 }]);
      const result = await runPluginCommand({ kind: "overview" }, deps);
      expect(result.ok).toBe(false);
      const markdown = pluginCommandMarkdown(result);
      expect(section(markdown, "Installed plugins")).toContain("p@m");
      expect(section(markdown, "Marketplaces")).toContain("no marketplaces");
      expect(markdown).not.toContain("None");
    });

    it("renders None for lists that succeeded empty", async () => {
      const { deps } = setup([{ stdout: "[]" }, { stdout: "[]" }]);
      const result = await runPluginCommand({ kind: "overview" }, deps);
      expect(result.ok).toBe(true);
      expect(pluginCommandMarkdown(result).match(/None/g)).toHaveLength(2);
    });
  });
});

describe("pluginCommandMarkdown", () => {
  const base = { ok: true, operation: "install", message: "" } as const;

  it.each<[PluginCommandResult["reload"], string]>([
    [{ status: "applied", plugins: ["p", "q"] }, "Reloaded: the session now has `p`, `q`."],
    [{ status: "busy" }, "The session is busy"],
    [{ status: "failed", error: "boom" }, "failed: boom"],
    [{ status: "unavailable" }, "applies to new sessions"],
  ])("explains reload %j", (reload, expected) => {
    expect(pluginCommandMarkdown({ ...base, reload })).toContain(expected);
  });

  it("rewrites CLI hints to chat commands and escapes the rest", () => {
    const markdown = pluginCommandMarkdown({
      ...base,
      ok: false,
      message: "Plugin *evil_* <b> not found. Use `claude plugin marketplace list` to see them.",
    });
    expect(markdown).toBe(
      "Plugin \\*evil\\_\\* \\<b\\> not found. Use `/plugin marketplace list` to see them.",
    );
  });

  it("shows the marketplace command as code and tells the user to confirm in a terminal", () => {
    const markdown = pluginCommandMarkdown({
      ...base,
      ok: false,
      message: "Plugin p@m is installed by running a command",
      failureCode: "command_source_refused",
      shownCommand: "echo `id`",
      terminalCommand: "claude plugin install p@m",
    });
    expect(markdown).toContain("`` echo `id` ``");
    expect(markdown).toContain("run `claude plugin install p@m` in a terminal");
  });

  it("renders a terminal command containing a backtick intact in a code span", () => {
    const markdown = pluginCommandMarkdown({
      ...base,
      ok: false,
      message: "refused",
      failureCode: "command_source_refused",
      shownCommand: "curl x | sh",
      terminalCommand: "claude plugin install p@m --config 'a`b'",
    });
    expect(markdown).toContain("run ``claude plugin install p@m --config 'a`b'`` in a terminal");
  });

  it("lists installed plugins, marketplaces and available plugins as Markdown lists", () => {
    const installed = [{ id: "p@m", version: "1.0.0", scope: "user", enabled: false }];
    expect(
      pluginCommandMarkdown({ ok: true, operation: "list", message: "", data: installed }),
    ).toBe("**Installed plugins**\n\n- `p@m` — v1.0.0, user scope, disabled");

    const available = pluginCommandMarkdown({
      ok: true,
      operation: "list",
      message: "",
      data: {
        installed: [],
        available: [{ pluginId: "q@m", name: "q", description: "Does *things*" }],
      },
    });
    expect(available).toContain("None. Run `/plugin install <plugin>` to add one.");
    expect(available).toContain("- `q@m` — Does \\*things\\*");

    const marketplaces = pluginCommandMarkdown({
      ok: true,
      operation: "marketplace-list",
      message: "",
      data: [{ name: "m", source: "github", repo: "owner/repo" }],
    });
    expect(marketplaces).toBe("**Marketplaces**\n\n- `m` — owner/repo");
  });

  it("gives usage text, with the reason first, for usage and for the overview", () => {
    const usage = pluginCommandMarkdown({
      ok: false,
      operation: "usage",
      message: "`--yes` is not supported here.",
    });
    expect(usage.startsWith("`--yes` is not supported here.")).toBe(true);
    expect(usage).toContain("`/plugin install <plugin>[@marketplace]");

    const overview = pluginCommandMarkdown({
      ok: true,
      operation: "overview",
      message: "",
      data: { plugins: [], marketplaces: [] },
    });
    expect(overview).toContain("**Installed plugins**");
    expect(overview).toContain("**Marketplaces**");
    expect(overview).toContain("**Usage**");
  });
});
