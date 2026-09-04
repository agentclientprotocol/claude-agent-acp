function markerContents(text: string, tag: string): string[] {
  const open = `<${tag}>`;
  const close = `</${tag}>`;
  const contents: string[] = [];
  let offset = 0;
  while (offset < text.length) {
    const start = text.indexOf(open, offset);
    if (start === -1) break;
    const valueStart = start + open.length;
    const end = text.indexOf(close, valueStart);
    if (end === -1) break;
    contents.push(text.slice(valueStart, end));
    offset = end + close.length;
  }
  return contents;
}

function usageBar(percent: number): string {
  const cells = 20;
  const clamped = Math.max(0, Math.min(100, percent));
  const filled = clamped === 0 ? 0 : Math.max(1, Math.round((clamped / 100) * cells));
  return `${"█".repeat(filled)}${"░".repeat(cells - filled)}`;
}

function usageLabel(raw: string): string {
  if (/^current session$/i.test(raw)) return "5-hour limit";
  const weekly = raw.match(/^current week\s*\((.+)\)$/i);
  return weekly ? `Weekly · ${weekly[1]}` : raw;
}

function markdownCode(value: string): string {
  return `\`${value.replaceAll("`", "\\`")}\``;
}

/** Render Claude Code's plain `/usage` terminal report as compact Markdown.
 * The report is intentionally parsed by labels instead of line boundaries:
 * some CLI versions put several fields on one physical line. Unknown report
 * shapes are returned unchanged so a future Claude release stays readable. */
export function formatUsageCommandOutput(output: string): string {
  const limitPattern =
    /(Current session|Current week\s*\([^)]+\)):\s*(\d+(?:\.\d+)?)% used(?:\s*·\s*resets\s+(.+?))?(?=\s+Current (?:session|week)\b|\n|$)/gi;
  const limits = [...output.matchAll(limitPattern)].map((match) => ({
    label: usageLabel(match[1].trim()),
    percent: Number(match[2]),
    reset: match[3]?.trim(),
  }));

  const periodPattern =
    /Last\s+(24h|7d)\s*·\s*(\d+) requests\s*·\s*(\d+) sessions\s*Top MCP servers:\s*(.*?)(?=\s*Last\s+(?:24h|7d)\b|$)/gis;
  const periods = [...output.matchAll(periodPattern)].map((match) => {
    const servers = [...match[4].matchAll(/([^,\n]+?)\s+(\d+(?:\.\d+)?)%(?:\s*,|$)/g)].map(
      (server) => ({ name: server[1].trim(), percent: Number(server[2]) }),
    );
    return { range: match[1], requests: match[2], sessions: match[3], servers };
  });

  if (limits.length === 0 && periods.length === 0) return output;

  const lines = ["## Usage"];
  const intro = output
    .match(/You are currently using.*?(?=\s*Current session:|\n|$)/i)?.[0]
    ?.trim();
  if (intro) lines.push("", `> ${intro}`);

  if (limits.length > 0) {
    lines.push("", "### Limits", "");
    for (const limit of limits) {
      const reset = limit.reset ? ` · Resets ${limit.reset}` : "";
      lines.push(
        `**${limit.label}** — **${limit.percent}%**${reset}`,
        "",
        markdownCode(usageBar(limit.percent)),
        "",
      );
    }
    if (lines.at(-1) === "") lines.pop();
  }

  if (periods.length > 0) {
    lines.push(
      "",
      "---",
      "",
      "### What’s using your limits?",
      "",
      "> Approximate, overlapping measures · this machine only · excludes claude.ai",
    );
    for (const period of periods) {
      lines.push(
        "",
        `**Last ${period.range}** · ${period.requests} requests · ${period.sessions} sessions`,
      );
      if (period.servers.length === 0) continue;
      lines.push("", "| MCP server | Usage |", "|:--|--:|");
      for (const server of period.servers) {
        lines.push(
          `| ${markdownCode(server.name)} | ${markdownCode(usageBar(server.percent))} ${server.percent}% |`,
        );
      }
    }
  }

  return lines.join("\n");
}

/** Format a wrapped `/usage` command, returning `undefined` when the message
 * belongs to another local command and should follow its normal handling. */
export function formatUsageLocalCommandMessage(content: string): string | null | undefined {
  const command = markerContents(content, "command-name").at(-1)?.trim();
  const stdout = markerContents(content, "local-command-stdout").join("\n").trim();
  const isUsage =
    command === "/usage" ||
    (/\bCurrent session:\s*\d+(?:\.\d+)?% used\b/i.test(stdout) &&
      /\bCurrent week\s*\(/i.test(stdout));
  if (!isUsage) return undefined;
  if (!stdout) return null;
  return formatUsageCommandOutput(stdout);
}
