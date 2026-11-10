import { describe, expect, it } from "vitest";
import { agentCommand, cliArgs } from "../agent-command.js";

describe("agentCommand", () => {
  it.each([
    {
      runtime: "Node",
      argv: ["/usr/bin/node", "/opt/acp/dist/index.js", "--hide-claude-auth"],
      args: ["/opt/acp/dist/index.js", "--hide-claude-auth"],
    },
    {
      runtime: "a compiled executable",
      argv: ["bun", "/$bunfs/root/claude-agent-acp", "--hide-claude-auth"],
      args: ["--hide-claude-auth"],
    },
    {
      runtime: "a compiled Windows executable",
      argv: ["bun", "B:\\~BUN\\root\\claude-agent-acp.exe", "--hide-claude-auth"],
      args: ["--hide-claude-auth"],
    },
  ])("reruns $runtime with its own flags", ({ argv, args }) => {
    expect(agentCommand(argv)).toEqual({ command: process.execPath, args });
  });
});

describe("cliArgs", () => {
  /**
   * The `--cli` passthrough hands the Claude CLI the adapter's flags without `--cli` and
   * `--hide-claude-auth`, under Node and in a compiled executable, and still forwards `--version`.
   */
  it.each([
    {
      scenario: "Node, terminal-auth login rerun",
      argv: [
        "/usr/bin/node",
        "/opt/acp/dist/index.js",
        "--hide-claude-auth",
        "--cli",
        "auth",
        "login",
        "--console",
      ],
      args: ["auth", "login", "--console"],
    },
    {
      scenario: "a compiled executable",
      argv: [
        "bun",
        "/$bunfs/root/claude-agent-acp",
        "--hide-claude-auth",
        "--cli",
        "auth",
        "status",
      ],
      args: ["auth", "status"],
    },
    {
      scenario: "--version after --cli",
      argv: ["/usr/bin/node", "/opt/acp/dist/index.js", "--cli", "--version"],
      args: ["--version"],
    },
  ])("drops the adapter's own flags for $scenario", ({ argv, args }) => {
    expect(cliArgs(argv)).toEqual(args);
  });
});
