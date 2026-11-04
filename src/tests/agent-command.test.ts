import { describe, expect, it } from "vitest";
import { agentCommand } from "../agent-command.js";

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
