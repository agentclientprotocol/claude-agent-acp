import type { AuthMethod } from "@agentclientprotocol/sdk/unstable";
import { agentCommand } from "./agent-command.js";
import { shouldHideClaudeAuth } from "./hide-claude-auth.js";

/**
 * The terminal login methods the agent advertises, in v1 form.
 *
 * - `terminal`: the client runs `args` against the agent's own command
 *   (`auth.terminal` in v1, an `auth.terminal` object in v2).
 * - `metaTerminal`: the client reads `_meta["terminal-auth"]`, which names
 *   the command too.
 *
 * Without either, the client cannot run a login, and the list is empty. On a
 * remote machine (SSH, `NO_BROWSER`, `CLAUDE_CODE_REMOTE`, as the SDK's own
 * isRemote check) the OAuth redirect to localhost cannot reach a browser, and
 * `claude auth login` falls back to a manual flow that does not work over ACP,
 * so the one method runs the TUI's `claude /login` instead. The Claude
 * subscription method is left out when `shouldHideClaudeAuth()` says so.
 */
export function terminalAuthMethods({
  terminal,
  metaTerminal,
}: {
  terminal: boolean;
  metaTerminal: boolean;
}): AuthMethod[] {
  if (!terminal && !metaTerminal) return [];
  const withMeta = (method: AuthMethod & { args: string[] }, label: string): AuthMethod => {
    if (!metaTerminal) return method;
    const agent = agentCommand();
    return {
      ...method,
      _meta: {
        "terminal-auth": { command: agent.command, args: [...agent.args, ...method.args], label },
      },
    };
  };
  const isRemote = !!(
    process.env.NO_BROWSER ||
    process.env.SSH_CONNECTION ||
    process.env.SSH_CLIENT ||
    process.env.SSH_TTY ||
    process.env.CLAUDE_CODE_REMOTE
  );
  if (isRemote) {
    if (shouldHideClaudeAuth()) return [];
    return [
      withMeta(
        {
          description: "Run `claude /login` in the terminal",
          name: "Log in with Claude",
          id: "claude-login",
          type: "terminal",
          args: ["--cli"],
        },
        "Claude Login",
      ),
    ];
  }
  const methods: AuthMethod[] = [];
  if (!shouldHideClaudeAuth()) {
    methods.push(
      withMeta(
        {
          description: "Use Claude subscription ",
          name: "Claude Subscription",
          id: "claude-ai-login",
          type: "terminal",
          args: ["--cli", "auth", "login", "--claudeai"],
        },
        "Claude Login",
      ),
    );
  }
  methods.push(
    withMeta(
      {
        description: "Use Anthropic Console (API usage billing)",
        name: "Anthropic Console",
        id: "console-login",
        type: "terminal",
        args: ["--cli", "auth", "login", "--console"],
      },
      "Anthropic Console Login",
    ),
  );
  return methods;
}
