import { HIDE_CLAUDE_AUTH_FLAG } from "./hide-claude-auth.js";

/**
 * The command that starts this agent again with the flags it was started with,
 * for a client to run in a terminal (e.g. `terminal-auth` login).
 *
 * Under Node, `process.argv` is `[node, script, ...flags]`, so the command is
 * `node script ...flags`. In a `bun build --compile` executable it is
 * `["bun", "/$bunfs/root/<name>", ...flags]` (`B:\~BUN\root\<name>` on
 * Windows): `process.execPath` is the executable itself and `argv[1]` names a
 * file inside it, which must not be passed back as an argument.
 */
export function agentCommand(argv: readonly string[] = process.argv): {
  command: string;
  args: string[];
} {
  const [, script, ...flags] = argv;
  if (script === undefined) return { command: process.execPath, args: [] };
  const compiled = script.includes("$bunfs") || script.includes("~BUN");
  return { command: process.execPath, args: compiled ? flags : [script, ...flags] };
}

/**
 * The arguments for the Claude CLI under `--cli`: the flags this process was
 * started with, minus the ones the adapter owns. The terminal-auth command
 * reruns the agent with its own flags (`--hide-claude-auth --cli auth login`),
 * and the CLI rejects the unknown option `--hide-claude-auth`. `argv.slice(2)`
 * is the flags under both Node and a compiled executable (see
 * {@link agentCommand}).
 */
export function cliArgs(argv: readonly string[] = process.argv): string[] {
  return argv.slice(2).filter((arg) => arg !== "--cli" && arg !== HIDE_CLAUDE_AUTH_FLAG);
}
