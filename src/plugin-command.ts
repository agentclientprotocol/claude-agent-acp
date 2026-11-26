/**
 * `/plugin` (aliases `/plugins`, `/marketplace`), which the adapter serves
 * itself. Claude Code's own `/plugin` is an interactive terminal screen and
 * answers "/plugin isn't available in this environment." in a session without
 * a terminal, which is every ACP session. The adapter instead runs the CLI's
 * `claude plugin ...` commands, which have a `--json` form, and then reloads
 * the live session so the new plugin's commands, skills and MCP servers appear.
 *
 * Plugins bring hooks and MCP servers that run as the user, so the set of
 * commands and flags below is an allowlist, and it is the only guard. Anything
 * outside it, such as `-y`, `--accept-command` or `--json`, gets the usage
 * text and never reaches the CLI. Shared by the v1 core and the v2 core.
 */
import { execFile } from "node:child_process";
import type { AvailableCommand } from "@agentclientprotocol/sdk/unstable";
import type { Query } from "@anthropic-ai/claude-agent-sdk";
import { codeSpan, escapeMarkdown } from "./usage-markdown.js";

/** The content blocks of a prompt, in v1 or v2 form: the command is one text block. */
type PromptContent = ReadonlyArray<{ type: string; text?: unknown }>;

export const PLUGIN_COMMAND_NAME = "plugin";

/** The `/plugin` entry of `available_commands_update`. */
export const PLUGIN_AVAILABLE_COMMAND: AvailableCommand = {
  name: PLUGIN_COMMAND_NAME,
  description: "Manage Claude Code plugins and marketplaces",
  input: { hint: "[install|uninstall|enable|disable|update|list|marketplace …] …" },
};

/** The CLI operations that the adapter runs. */
export type PluginCliOperation =
  | "list"
  | "install"
  | "uninstall"
  | "enable"
  | "disable"
  | "update"
  | "marketplace-add"
  | "marketplace-list"
  | "marketplace-remove"
  | "marketplace-update";

export type PluginOperation = PluginCliOperation | "overview" | "usage";

export type PluginCommand =
  /** Bare `/plugin` and `/plugin help`: usage, installed plugins and marketplaces. */
  | { kind: "overview" }
  /** Anything outside the allowlist, or a missing argument. `reason` says which. */
  | { kind: "usage"; reason?: string }
  /** One CLI run. `argv` is what follows `claude plugin`, without `--json`.
   *  `target` is the plugin or marketplace name the command is about, if it has one. */
  | { kind: "cli"; operation: PluginCliOperation; argv: string[]; target?: string };

const SCOPES = ["user", "project", "local"];

type FlagKind = "bool" | "value" | "list" | "variadic";

interface FlagSpec {
  /** The flag's names, such as `["-s", "--scope"]`. The first is its key. */
  names: string[];
  kind: FlagKind;
  /** The allowed values; any value if absent. */
  values?: string[];
}

interface Scanned {
  positionals: string[];
  /** Per flag key: `true` for a bool, else the values in the order given. */
  flags: Map<string, true | string[]>;
}

const SCOPE_FLAG: FlagSpec = { names: ["-s", "--scope"], kind: "value", values: SCOPES };

/** Splits `tokens` into positionals and the flags of `specs`. Any other token
 *  that starts with `-` is an error, so no user text becomes a CLI option. */
function scan(tokens: string[], specs: FlagSpec[]): Scanned | { error: string | undefined } {
  const positionals: string[] = [];
  const flags = new Map<string, true | string[]>();
  for (let i = 0; i < tokens.length; i++) {
    let token = tokens[i]!;
    if (!token.startsWith("-")) {
      positionals.push(token);
      continue;
    }
    if (token === "-h" || token === "--help") return { error: undefined };
    let inline: string | undefined;
    const equals = token.startsWith("--") ? token.indexOf("=") : -1;
    if (equals > 0) {
      inline = token.slice(equals + 1);
      token = token.slice(0, equals);
      if (inline.startsWith("-")) return { error: `\`${token}\` needs a value.` };
    }
    const spec = specs.find((candidate) => candidate.names.includes(token));
    if (!spec) return { error: `\`${token}\` is not supported here.` };
    const key = spec.names[0]!;
    if (spec.kind === "bool") {
      if (inline !== undefined) return { error: `\`${token}\` takes no value.` };
      flags.set(key, true);
      continue;
    }
    const values: string[] = [];
    if (inline !== undefined) {
      values.push(inline);
    } else if (spec.kind === "variadic") {
      while (i + 1 < tokens.length && !tokens[i + 1]!.startsWith("-")) values.push(tokens[++i]!);
    } else if (i + 1 < tokens.length && !tokens[i + 1]!.startsWith("-")) {
      values.push(tokens[++i]!);
    }
    if (values.length === 0 || values.some((value) => value === "")) {
      return { error: `\`${token}\` needs a value.` };
    }
    if (spec.values && !values.every((value) => spec.values!.includes(value))) {
      return { error: `\`${token}\` takes one of ${spec.values.join(", ")}.` };
    }
    const previous = flags.get(key);
    if (previous !== undefined && spec.kind !== "list" && spec.kind !== "variadic") {
      return { error: `\`${token}\` is given twice.` };
    }
    flags.set(key, [...(Array.isArray(previous) ? previous : []), ...values]);
  }
  return { positionals, flags };
}

function flagArgs(scanned: Scanned, specs: FlagSpec[]): string[] {
  const args: string[] = [];
  for (const spec of specs) {
    const key = spec.names[0]!;
    const value = scanned.flags.get(key);
    if (value === undefined) continue;
    const flag = spec.names.find((name) => name.startsWith("--")) ?? key;
    if (value === true) args.push(flag);
    else if (spec.kind === "list") for (const item of value) args.push(flag, item);
    else args.push(flag, ...value);
  }
  return args;
}

const USAGE_PLUGIN_ARGUMENT = "Give a plugin name, as `name` or `name@marketplace`.";

/** Parses the arguments of a CLI subcommand into a `cli` command. */
function parseSubcommand(
  operation: PluginCliOperation,
  words: string[],
  specs: FlagSpec[],
  prefix: string[],
  options: { positional: "none" | "one" | "optional"; missing?: string },
): PluginCommand {
  const scanned = scan(words, specs);
  if ("error" in scanned) return { kind: "usage", reason: scanned.error };
  const max = options.positional === "none" ? 0 : 1;
  if (scanned.positionals.length > max) {
    return { kind: "usage", reason: `Unexpected argument \`${scanned.positionals[max]}\`.` };
  }
  if (options.positional === "one" && scanned.positionals.length === 0) {
    return { kind: "usage", reason: options.missing };
  }
  const target = scanned.positionals[0];
  return {
    kind: "cli",
    operation,
    argv: [...prefix, ...scanned.positionals, ...flagArgs(scanned, specs)],
    ...(target === undefined ? {} : { target }),
  };
}

const LIST_FLAGS: FlagSpec[] = [{ names: ["--available"], kind: "bool" }];
const INSTALL_FLAGS: FlagSpec[] = [
  SCOPE_FLAG,
  { names: ["--marketplace"], kind: "value" },
  { names: ["--config"], kind: "list" },
];
const UNINSTALL_FLAGS: FlagSpec[] = [SCOPE_FLAG, { names: ["--keep-data"], kind: "bool" }];
const ENABLE_FLAGS: FlagSpec[] = [SCOPE_FLAG];
const DISABLE_FLAGS: FlagSpec[] = [SCOPE_FLAG, { names: ["-a", "--all"], kind: "bool" }];
const MARKETPLACE_ADD_FLAGS: FlagSpec[] = [SCOPE_FLAG, { names: ["--sparse"], kind: "variadic" }];

function parseMarketplace(words: string[]): PluginCommand {
  const [sub, ...rest] = words;
  switch (sub) {
    case "add":
      return parseSubcommand(
        "marketplace-add",
        rest,
        MARKETPLACE_ADD_FLAGS,
        ["marketplace", "add"],
        {
          positional: "one",
          missing: "Give a marketplace source: a GitHub `owner/repo`, a git URL, or a path.",
        },
      );
    case "list":
    case "ls":
      return parseSubcommand("marketplace-list", rest, [], ["marketplace", "list"], {
        positional: "none",
      });
    case "remove":
    case "rm":
      return parseSubcommand("marketplace-remove", rest, [SCOPE_FLAG], ["marketplace", "remove"], {
        positional: "one",
        missing: "Give the name of the marketplace to remove.",
      });
    case "update":
      return parseSubcommand("marketplace-update", rest, [], ["marketplace", "update"], {
        positional: "optional",
      });
    default:
      return { kind: "usage" };
  }
}

/**
 * Parses `/plugin ...` (also `/plugins ...` and `/marketplace ...`, which are
 * aliases: `/marketplace marketplace add x` is `/plugin marketplace add x`,
 * and `/marketplace add x` is usage, like `/plugin add x`) from a single-text
 * prompt. `null` for any other prompt, which goes to Claude Code.
 */
export function parsePluginCommand(prompt: PromptContent): PluginCommand | null {
  const [first] = prompt;
  if (prompt.length !== 1 || first?.type !== "text" || typeof first.text !== "string") return null;
  // Check the first word before splitting, so a long prompt is not split into words.
  const text = first.text.trim();
  if (!/^\/(?:plugins?|marketplace)(?:\s|$)/.test(text)) return null;
  const [, ...words] = text.split(/\s+/);
  const [sub, ...rest] = words;
  switch (sub) {
    case undefined:
    case "help":
      return { kind: "overview" };
    case "list":
    case "ls":
      return parseSubcommand("list", rest, LIST_FLAGS, ["list"], { positional: "none" });
    case "install":
    case "i":
      return parseSubcommand("install", rest, INSTALL_FLAGS, ["install"], {
        positional: "one",
        missing: USAGE_PLUGIN_ARGUMENT,
      });
    case "uninstall":
    case "remove":
    case "rm":
      return parseSubcommand("uninstall", rest, UNINSTALL_FLAGS, ["uninstall"], {
        positional: "one",
        missing: USAGE_PLUGIN_ARGUMENT,
      });
    case "enable":
      return parseSubcommand("enable", rest, ENABLE_FLAGS, ["enable"], {
        positional: "one",
        missing: USAGE_PLUGIN_ARGUMENT,
      });
    case "disable": {
      const command = parseSubcommand("disable", rest, DISABLE_FLAGS, ["disable"], {
        positional: "optional",
      });
      if (command.kind !== "cli") return command;
      const all = command.argv.includes("--all");
      if (all === (command.target !== undefined)) {
        return {
          kind: "usage",
          reason: all
            ? "Give either a plugin name or `--all`, not both."
            : `${USAGE_PLUGIN_ARGUMENT} Or use \`--all\` to disable every plugin.`,
        };
      }
      return command;
    }
    case "update":
      return parseSubcommand("update", rest, [SCOPE_FLAG], ["update"], {
        positional: "one",
        missing: USAGE_PLUGIN_ARGUMENT,
      });
    case "marketplace":
    case "market":
      return parseMarketplace(rest);
    default:
      return { kind: "usage", reason: `Unknown subcommand \`${sub}\`.` };
  }
}

export type PluginReload = {
  status: "applied" | "busy" | "failed" | "unavailable";
  /** The names of the plugins the session has after a reload; with `applied`. */
  plugins?: string[];
  /** Why the reload failed; with `failed`. */
  error?: string;
};

export interface PluginCommandResult {
  ok: boolean;
  operation: PluginOperation;
  /** The CLI's own message, or the adapter's when the CLI did not run or did not answer. */
  message: string;
  /** The CLI's `failureCode`, such as `not_found` or `command_source_refused`. */
  failureCode?: string;
  /** With `command_source_refused`: the command that the marketplace declares as the install. */
  shownCommand?: string;
  /** With `shownCommand`: the terminal command that lets the user confirm it. */
  terminalCommand?: string;
  /** The parsed `--json` output of a list: an array, or `{installed, available}`; for an overview, `{plugins, marketplaces}` plus `pluginsError` or `marketplacesError` for a list that failed. */
  data?: unknown;
  reload?: PluginReload;
}

export interface ExecOptions {
  cwd: string;
  env: Record<string, string | undefined>;
  signal: AbortSignal;
  timeoutMs: number;
}

export interface ExecOutput {
  stdout: string;
  stderr: string;
  /** The exit code. A run that ends with a non-zero code is a result, not an error. */
  code: number;
}

/** Runs a program without a shell. Rejects when it cannot start, is aborted,
 *  times out, or prints too much. */
export type ExecLike = (file: string, args: string[], options: ExecOptions) => Promise<ExecOutput>;

export interface PluginCommandDeps {
  cliPath: () => Promise<string>;
  cwd: string;
  env: Record<string, string | undefined>;
  signal: AbortSignal;
  /** Read after the CLI ends: the session's query can be replaced while it runs. */
  query: () => Query | undefined;
  logError: (message: string) => void;
  exec?: ExecLike;
}

/** The time that one CLI run can take. A git clone of a marketplace is the slow case. */
const PLUGIN_CLI_TIMEOUT_MS = 5 * 60_000;

const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

const defaultExec: ExecLike = (file, args, options) =>
  new Promise((resolve, reject) => {
    const child = execFile(
      file,
      args,
      {
        cwd: options.cwd,
        env: options.env,
        signal: options.signal,
        timeout: options.timeoutMs,
        maxBuffer: MAX_OUTPUT_BYTES,
        encoding: "utf8",
      },
      (error, stdout, stderr) => {
        if (!error) return resolve({ stdout, stderr, code: 0 });
        if (typeof error.code === "number") return resolve({ stdout, stderr, code: error.code });
        if (error.killed && !options.signal.aborted) {
          return reject(new Error(`Timed out after ${options.timeoutMs / 60_000} minutes.`));
        }
        reject(error);
      },
    );
    // The CLI must not wait on a terminal that does not exist.
    child.stdin?.end();
  });

/** The operations after which the live session reloads its plugins. */
const RELOADING_OPERATIONS: ReadonlySet<PluginOperation> = new Set([
  "install",
  "uninstall",
  "enable",
  "disable",
  "update",
  "marketplace-remove",
]);

type CliRun =
  | { type: "cancelled" }
  | { type: "error"; message: string }
  | { type: "done"; code: number; stdout: string; stderr: string };

interface CliJson {
  outcome?: unknown;
  message?: unknown;
  failureCode?: unknown;
  alreadyInGoalState?: unknown;
  shownCommand?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The result line of a `--json` run: the last non-empty line of stdout. The
 *  CLI can print human-readable lines before it. */
function lastJsonLine(stdout: string): CliJson | undefined {
  const lines = stdout.split(/\r?\n/).filter((line) => line.trim() !== "");
  const last = lines[lines.length - 1];
  if (last === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(last);
    return isRecord(parsed) ? (parsed as CliJson) : undefined;
  } catch {
    return undefined;
  }
}

/** The whole of stdout as JSON: a list prints an indented array or object. */
function wholeJson(stdout: string): unknown {
  try {
    return JSON.parse(stdout.trim());
  } catch {
    return undefined;
  }
}

const MAX_TEXT_LENGTH = 1500;

function plainText(text: string): string {
  // eslint-disable-next-line no-control-regex
  const stripped = text.replace(/\u001b\[[0-9;]*[A-Za-z]/g, "").trim();
  return stripped.length > MAX_TEXT_LENGTH ? `${stripped.slice(0, MAX_TEXT_LENGTH)}…` : stripped;
}

function isJsonOptionUnknown(run: { stdout: string; stderr: string }): boolean {
  return /unknown option.*--json/i.test(`${run.stderr}\n${run.stdout}`);
}

/** Whether the CLI takes `--json` for the command: `marketplace update` without a name does not. */
function takesJson(command: Extract<PluginCommand, { kind: "cli" }>): boolean {
  return !(command.operation === "marketplace-update" && command.target === undefined);
}

async function runCli(
  deps: PluginCommandDeps,
  exec: ExecLike,
  env: Record<string, string | undefined>,
  argv: string[],
  json: boolean,
): Promise<CliRun> {
  if (deps.signal.aborted) return { type: "cancelled" };
  const run = async (args: string[]): Promise<CliRun> => {
    try {
      const file = await deps.cliPath();
      const output = await exec(file, args, {
        cwd: deps.cwd,
        env,
        signal: deps.signal,
        timeoutMs: PLUGIN_CLI_TIMEOUT_MS,
      });
      return { type: "done", ...output };
    } catch (error) {
      if (deps.signal.aborted) return { type: "cancelled" };
      const message = error instanceof Error ? error.message : String(error);
      deps.logError(`Failed to run \`claude plugin ${argv.join(" ")}\`: ${message}`);
      return { type: "error", message: `Could not run the Claude CLI: ${message}` };
    }
  };
  const first = await run(["plugin", ...argv, ...(json ? ["--json"] : [])]);
  // A CLI named by CLAUDE_CODE_EXECUTABLE can predate `--json`. It rejects the
  // flag before doing anything, so the run is repeated for its text and exit code.
  if (json && first.type === "done" && first.code !== 0 && isJsonOptionUnknown(first)) {
    return run(["plugin", ...argv]);
  }
  return first;
}

function cancelled(operation: PluginOperation): PluginCommandResult {
  return { ok: false, operation, message: "Cancelled." };
}

function failedToRun(operation: PluginOperation, run: CliRun): PluginCommandResult {
  return run.type === "cancelled"
    ? cancelled(operation)
    : { ok: false, operation, message: run.type === "error" ? run.message : "" };
}

function describeCliRun(
  command: Extract<PluginCommand, { kind: "cli" }>,
  run: Extract<CliRun, { type: "done" }>,
): PluginCommandResult {
  const { operation } = command;
  const isList = operation === "list" || operation === "marketplace-list";
  const json = lastJsonLine(run.stdout);
  if (isList) {
    const data = wholeJson(run.stdout);
    if (run.code === 0 && data !== undefined && typeof data === "object" && data !== null) {
      return { ok: true, operation, message: "", data };
    }
  }
  if (!json || typeof json.outcome !== "string") {
    const text = plainText(run.code === 0 ? run.stdout || run.stderr : run.stderr || run.stdout);
    return {
      ok: run.code === 0,
      operation,
      message: text || (run.code === 0 ? "Done." : `The Claude CLI exited with code ${run.code}.`),
    };
  }
  const message =
    typeof json.message === "string" && json.message.trim() !== ""
      ? plainText(json.message)
      : run.code === 0
        ? "Done."
        : `The Claude CLI exited with code ${run.code}.`;
  const ok = json.alreadyInGoalState === true || (json.outcome !== "failed" && run.code === 0);
  const result: PluginCommandResult = { ok, operation, message };
  if (!ok && typeof json.failureCode === "string") result.failureCode = json.failureCode;
  if (!ok && isRecord(json.shownCommand) && typeof json.shownCommand.command === "string") {
    result.shownCommand = json.shownCommand.command;
    if (operation === "install" || operation === "update") {
      result.terminalCommand = `claude plugin ${command.argv.map(shellQuote).join(" ")}`;
    }
  }
  return result;
}

// terminalCommand is pasted into a POSIX shell, and argv values are arbitrary
// text: `&` would background, `*` glob and `$(x)` expand unless quoted.
function shellQuote(arg: string): string {
  return /^[A-Za-z0-9@%+=:,./_-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", "'\\''")}'`;
}

async function reloadSession(deps: PluginCommandDeps): Promise<PluginReload> {
  const query = deps.query();
  if (!query) return { status: "unavailable" };
  try {
    const response = await query.reloadPlugins({ refuseIfBusy: true });
    return { status: "applied", plugins: response.plugins.map((plugin) => plugin.name) };
  } catch (error) {
    if ((error as { errorCode?: unknown } | null)?.errorCode === "reload_plugins_busy") {
      return { status: "busy" };
    }
    const message = error instanceof Error ? error.message : String(error);
    deps.logError(`Failed to reload plugins after /plugin: ${message}`);
    return { status: "failed", error: message };
  }
}

/** Whether `plugin` (`name` or `name@marketplace`) is among the installed plugin ids. */
function isInstalled(installed: unknown[], plugin: string): boolean {
  return installed.some((entry) => {
    const id = isRecord(entry) ? entry.id : undefined;
    if (typeof id !== "string") return false;
    return plugin.includes("@") ? id === plugin : id.split("@")[0] === plugin;
  });
}

/**
 * Runs a parsed `/plugin` command and, after a change, reloads the session's
 * plugins. A failure is in the result: this never throws.
 */
export async function runPluginCommand(
  command: PluginCommand,
  deps: PluginCommandDeps,
): Promise<PluginCommandResult> {
  if (command.kind === "usage") {
    return {
      ok: false,
      operation: "usage",
      message: command.reason ?? "",
    };
  }
  const exec = deps.exec ?? defaultExec;
  const env = { ...deps.env };
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_CHILD_SESSION;

  if (command.kind === "overview") {
    const [plugins, marketplaces] = await Promise.all([
      runCli(deps, exec, env, ["list"], true),
      runCli(deps, exec, env, ["marketplace", "list"], true),
    ]);
    if (plugins.type === "cancelled" || marketplaces.type === "cancelled") {
      return cancelled("overview");
    }
    const read = (run: CliRun): { value?: unknown; error?: string } => {
      if (run.type === "error") return { error: run.message };
      if (run.type === "done" && run.code === 0) {
        const value = wholeJson(run.stdout);
        return Array.isArray(value)
          ? { value }
          : { error: "The Claude CLI did not return a list." };
      }
      const text = run.type === "done" ? plainText(run.stderr || run.stdout) : "";
      return {
        error: text || `The Claude CLI exited with code ${run.type === "done" ? run.code : "?"}.`,
      };
    };
    const listed = { plugins: read(plugins), marketplaces: read(marketplaces) };
    const errors = [listed.plugins.error, listed.marketplaces.error].filter((e) => e !== undefined);
    return {
      ok: errors.length === 0,
      operation: "overview",
      message: errors.join("\n"),
      data: {
        plugins: listed.plugins.value,
        marketplaces: listed.marketplaces.value,
        pluginsError: listed.plugins.error,
        marketplacesError: listed.marketplaces.error,
      },
    };
  }

  const { operation } = command;
  if (operation === "enable" && command.target !== undefined) {
    const listing = await runCli(deps, exec, env, ["list"], true);
    if (listing.type === "cancelled") return cancelled(operation);
    // When the list cannot be read (an old CLI), the enable runs as typed.
    const installed =
      listing.type === "done" && listing.code === 0 ? wholeJson(listing.stdout) : undefined;
    if (Array.isArray(installed) && !isInstalled(installed, command.target)) {
      return {
        ok: false,
        operation,
        message: `Plugin ${command.target} is not installed, so it can't be enabled. Install it first.`,
        failureCode: "not_installed",
      };
    }
  }

  const run = await runCli(deps, exec, env, command.argv, takesJson(command));
  if (run.type !== "done") return failedToRun(operation, run);
  const result = describeCliRun(command, run);
  if (result.ok && RELOADING_OPERATIONS.has(operation)) {
    if (deps.signal.aborted) return cancelled(operation);
    result.reload = await reloadSession(deps);
  }
  return result;
}

const USAGE_LINES = [
  "- `/plugin list [--available]`",
  "- `/plugin install <plugin>[@marketplace] [--scope user|project|local] [--marketplace <source>] [--config key=value]`",
  "- `/plugin uninstall <plugin> [--scope …] [--keep-data]`",
  "- `/plugin enable <plugin> [--scope …]`",
  "- `/plugin disable <plugin>|--all [--scope …]`",
  "- `/plugin update <plugin> [--scope …]`",
  "- `/plugin marketplace add <source> [--scope …] [--sparse <path>…]`",
  "- `/plugin marketplace list`",
  "- `/plugin marketplace remove <name> [--scope …]`",
  "- `/plugin marketplace update [<name>]`",
];

function usageMarkdown(): string {
  return ["**Usage**", "", ...USAGE_LINES].join("\n");
}

/** Escapes CLI or plugin text. A `claude plugin X` hint in backticks becomes
 *  the `/plugin X` that works in this chat. */
function renderCliText(text: string): string {
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "")
    .map((line) =>
      line
        .split(/(`[^`\n]+`)/)
        .map((part, index) => {
          if (index % 2 === 0) return escapeMarkdown(part);
          const code = part.slice(1, -1).replace(/^claude plugins? /, "/plugin ");
          return codeSpan(code);
        })
        .join(""),
    )
    .join("\n\n");
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function installedLine(entry: unknown): string | undefined {
  if (!isRecord(entry)) return undefined;
  const id = str(entry.id);
  if (!id) return undefined;
  const details = [
    str(entry.version) && `v${str(entry.version)}`,
    str(entry.scope) && `${str(entry.scope)} scope`,
    entry.enabled === false ? "disabled" : "enabled",
  ].filter((part): part is string => typeof part === "string");
  return `- ${codeSpan(id)} — ${escapeMarkdown(details.join(", "))}`;
}

function availableLine(entry: unknown): string | undefined {
  if (!isRecord(entry)) return undefined;
  const id = str(entry.pluginId) ?? str(entry.name);
  if (!id) return undefined;
  const description = str(entry.description);
  return `- ${codeSpan(id)}${description ? ` — ${escapeMarkdown(description)}` : ""}`;
}

function marketplaceLine(entry: unknown): string | undefined {
  if (!isRecord(entry)) return undefined;
  const name = str(entry.name);
  if (!name) return undefined;
  const source = str(entry.repo) ?? str(entry.url) ?? str(entry.path) ?? str(entry.source);
  return `- ${codeSpan(name)}${source ? ` — ${escapeMarkdown(source)}` : ""}`;
}

/** The most available plugins that a reply lists. The official directory has hundreds. */
const MAX_AVAILABLE_LISTED = 40;

function section(title: string, lines: (string | undefined)[], empty: string): string {
  const shown = lines.filter((line): line is string => line !== undefined);
  return shown.length === 0 ? `**${title}**\n\n${empty}` : `**${title}**\n\n${shown.join("\n")}`;
}

function installedSection(data: unknown): string {
  return section(
    "Installed plugins",
    Array.isArray(data) ? data.map(installedLine) : [],
    "None. Run `/plugin install <plugin>` to add one.",
  );
}

function marketplacesSection(data: unknown): string {
  return section(
    "Marketplaces",
    Array.isArray(data) ? data.map(marketplaceLine) : [],
    "None. Run `/plugin marketplace add <source>` to add one.",
  );
}

function availableSection(entries: unknown[]): string {
  const lines = entries.map(availableLine).filter((line) => line !== undefined);
  const more = lines.length - MAX_AVAILABLE_LISTED;
  if (more > 0) lines.splice(MAX_AVAILABLE_LISTED, more, `- … and ${more} more`);
  return section("Available plugins", lines, "None.");
}

function reloadLine(reload: PluginReload): string {
  if (reload.status === "applied") {
    const plugins = reload.plugins ?? [];
    return plugins.length === 0
      ? "Reloaded: the session now has no plugins."
      : `Reloaded: the session now has ${plugins.map(codeSpan).join(", ")}.`;
  }
  if (reload.status === "busy") {
    return "The session is busy, so the change was not loaded into it. It applies to new sessions.";
  }
  if (reload.status === "failed") {
    return `Reloading the session's plugins failed${reload.error ? `: ${escapeMarkdown(reload.error)}` : ""}. The change applies to new sessions.`;
  }
  return "The change applies to new sessions.";
}

/** The chat reply for a result of {@link runPluginCommand}. */
export function pluginCommandMarkdown(result: PluginCommandResult): string {
  const blocks: string[] = [];
  const data = result.data;
  switch (result.operation) {
    case "usage":
      if (result.message) blocks.push(renderCliText(result.message));
      blocks.push(usageMarkdown());
      return blocks.join("\n\n");
    case "overview": {
      const parts = isRecord(data) ? data : {};
      const failure = (title: string, error: unknown): string =>
        `**${title}**\n\nCould not list: ${renderCliText(String(error))}`;
      return [
        typeof parts.pluginsError === "string"
          ? failure("Installed plugins", parts.pluginsError)
          : installedSection(parts.plugins),
        typeof parts.marketplacesError === "string"
          ? failure("Marketplaces", parts.marketplacesError)
          : marketplacesSection(parts.marketplaces),
        usageMarkdown(),
      ].join("\n\n");
    }
    case "list":
      if (result.ok && isRecord(data)) {
        blocks.push(installedSection(data.installed));
        blocks.push(availableSection(Array.isArray(data.available) ? data.available : []));
      } else if (result.ok && data !== undefined) {
        blocks.push(installedSection(data));
      }
      break;
    case "marketplace-list":
      if (result.ok && data !== undefined) blocks.push(marketplacesSection(data));
      break;
    default:
      break;
  }
  if (blocks.length === 0 && result.message) blocks.push(renderCliText(result.message));
  if (result.shownCommand !== undefined) {
    blocks.push(
      `The marketplace declares that this plugin is installed by running a command. The adapter does not run it:\n\n${codeSpan(result.shownCommand)}`,
    );
    if (result.terminalCommand) {
      blocks.push(
        `To confirm that command, run ${codeSpan(result.terminalCommand)} in a terminal.`,
      );
    }
  }
  if (result.reload) blocks.push(reloadLine(result.reload));
  return blocks.join("\n\n");
}
