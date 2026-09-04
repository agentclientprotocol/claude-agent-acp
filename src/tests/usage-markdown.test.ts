import { describe, expect, it } from "vitest";
import { formatUsageCommandOutput, formatUsageLocalCommandMessage } from "../usage-markdown.js";

const report = `You are currently using your subscription to power your Claude Code usage
Current session: 3% used · resets Sep 4 at 8:59pm (Asia/Yerevan)
Current week (all models): 0% used · resets Sep 4 at 9:59pm (Asia/Yerevan)
Current week (Fable): 0% used
What's contributing to your limits usage? Approximate, based on local sessions on this machine — does not include other devices or claude.ai. Behaviors are independent characteristics, not a breakdown.
Last 24h · 34 requests · 3 sessions Top MCP servers: ccd_session_mgmt 13%, ccd_session 5%, claude_agent_acp 3%
Last 7d · 43 requests · 5 sessions Top MCP servers: ccd_session_mgmt 11%, ccd_session 4%, claude_agent_acp 3%`;

describe("formatUsageCommandOutput", () => {
  it("renders subscription limits and MCP contributions as Markdown", () => {
    const formatted = formatUsageCommandOutput(report);

    expect(formatted).toContain("## Usage");
    expect(formatted).toContain("**5-hour limit** — **3%** · Resets Sep 4 at 8:59pm");
    expect(formatted).toContain("**Weekly · all models** — **0%**");
    expect(formatted).toContain("`█░░░░░░░░░░░░░░░░░░░`");
    expect(formatted).toContain("### What’s using your limits?");
    expect(formatted).toContain("**Last 24h** · 34 requests · 3 sessions");
    expect(formatted).toContain("| `ccd_session_mgmt` | `███░░░░░░░░░░░░░░░░░` 13% |");
    expect(formatted).toContain("**Last 7d** · 43 requests · 5 sessions");
    expect(formatted).not.toContain("Current session:");
  });

  it("leaves an unknown future report shape readable", () => {
    expect(formatUsageCommandOutput("Usage data is temporarily unavailable.")).toBe(
      "Usage data is temporarily unavailable.",
    );
  });
});

describe("formatUsageLocalCommandMessage", () => {
  it("extracts /usage stdout with and without a command-name marker", () => {
    const wrapped =
      `<command-name>/usage</command-name>` +
      `<local-command-stdout>${report}</local-command-stdout>`;
    expect(formatUsageLocalCommandMessage(wrapped)).toBe(formatUsageCommandOutput(report));
    expect(
      formatUsageLocalCommandMessage(`<local-command-stdout>${report}</local-command-stdout>`),
    ).toBe(formatUsageCommandOutput(report));
  });

  it("does not claim messages from other local commands", () => {
    expect(
      formatUsageLocalCommandMessage(
        "<command-name>/status</command-name><local-command-stdout>ok</local-command-stdout>",
      ),
    ).toBeUndefined();
  });
});
