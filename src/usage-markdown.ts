import type { SDKControlGetUsageResponse } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

const usageWindowSchema = z
  .object({ utilization: z.number().nullable(), resets_at: z.string().nullable() })
  .nullable()
  .optional();
const contributionSchema = z.object({ name: z.string(), pct: z.number() });
const behaviorPeriodSchema = z.object({
  request_count: z.number(),
  session_count: z.number(),
  behaviors: z.array(
    z.object({
      key: z.enum(["cache_miss", "long_context", "subagent_heavy", "high_parallel", "cron"]),
      pct: z.number(),
      count: z.number(),
    }),
  ),
  agents: z.array(contributionSchema),
  skills: z.array(contributionSchema),
  plugins: z.array(contributionSchema),
  mcp_servers: z.array(contributionSchema),
});
const modelUsageSchema = z.object({
  inputTokens: z.number(),
  outputTokens: z.number(),
  thinkingTokens: z.number().optional(),
  cacheReadInputTokens: z.number(),
  cacheCreationInputTokens: z.number(),
  webSearchRequests: z.number(),
  costUSD: z.number(),
  contextWindow: z.number(),
  maxOutputTokens: z.number(),
  canonicalModel: z.string().optional(),
  provider: z.string().optional(),
  costBasis: z.enum(["list", "managed", "unknown"]).optional(),
});

const usageResponseSchema = z.object({
  session: z.object({
    total_cost_usd: z.number(),
    total_api_duration_ms: z.number(),
    total_duration_ms: z.number(),
    total_lines_added: z.number(),
    total_lines_removed: z.number(),
    model_usage: z.record(z.string(), modelUsageSchema),
  }),
  subscription_type: z.string().nullable(),
  rate_limits_available: z.boolean(),
  rate_limits: z
    .object({
      five_hour: usageWindowSchema,
      seven_day: usageWindowSchema,
      seven_day_oauth_apps: usageWindowSchema,
      seven_day_opus: usageWindowSchema,
      seven_day_sonnet: usageWindowSchema,
      model_scoped: z
        .array(
          z.object({
            display_name: z.string(),
            utilization: z.number().nullable(),
            resets_at: z.string().nullable(),
          }),
        )
        .optional(),
      extra_usage: z
        .object({
          is_enabled: z.boolean(),
          monthly_limit: z.number().nullable(),
          used_credits: z.number().nullable(),
          utilization: z.number().nullable(),
          currency: z.string().nullable().optional(),
        })
        .nullable()
        .optional(),
    })
    .nullable(),
  behaviors: z.object({ day: behaviorPeriodSchema, week: behaviorPeriodSchema }).nullable(),
});

/** Validate the experimental SDK response at the runtime boundary. */
export function parseUsageResponse(value: unknown): SDKControlGetUsageResponse | null {
  const parsed = usageResponseSchema.safeParse(value);
  return parsed.success ? (parsed.data as SDKControlGetUsageResponse) : null;
}

export function isUsageCommandText(text: string): boolean {
  return ["/usage", "/cost", "/stats"].includes(text.trim());
}

function usageBar(percent: number): string {
  const cells = 20;
  const clamped = Math.max(0, Math.min(100, percent));
  const filled = clamped === 0 ? 0 : Math.max(1, Math.round((clamped / 100) * cells));
  return `${"█".repeat(filled)}${"░".repeat(cells - filled)}`;
}

function escapeMarkdown(value: string): string {
  return value.replace(/([\\`*_[\]<>|])/g, "\\$1").replace(/[\r\n]+/g, " ");
}

function formatDuration(milliseconds: number): string {
  const seconds = Math.max(0, Math.round(milliseconds / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return remainder === 0 ? `${minutes}m` : `${minutes}m ${remainder}s`;
}

function formatCount(value: number): string {
  return new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(
    value,
  );
}

function formatReset(value: string | null): string {
  if (!value) return "";
  const reset = new Date(value);
  if (Number.isNaN(reset.getTime())) return ` · Resets ${escapeMarkdown(value)}`;
  return ` · Resets ${new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(reset)}`;
}

function appendLimit(
  lines: string[],
  label: string,
  window: { utilization: number | null; resets_at: string | null } | null | undefined,
): void {
  if (!window || window.utilization === null) return;
  lines.push(
    `**${escapeMarkdown(label)}** — **${window.utilization}%**${formatReset(window.resets_at)}`,
    "",
    `\`${usageBar(window.utilization)}\``,
    "",
  );
}

function appendContributions(
  lines: string[],
  label: string,
  period: {
    request_count: number;
    session_count: number;
    mcp_servers: { name: string; pct: number }[];
  },
): void {
  lines.push(
    "",
    `**${label}** · ${period.request_count} requests · ${period.session_count} sessions`,
  );
  if (period.mcp_servers.length === 0) return;
  lines.push("", "| MCP server | Usage |", "|:--|--:|");
  for (const server of period.mcp_servers) {
    lines.push(`| ${escapeMarkdown(server.name)} | \`${usageBar(server.pct)}\` ${server.pct}% |`);
  }
}

/** Render the SDK's structured `/usage` response as Markdown. */
export function formatUsageResponse(usage: SDKControlGetUsageResponse): string {
  const lines = ["## Usage"];
  if (usage.subscription_type) {
    lines.push("", `> Claude ${escapeMarkdown(usage.subscription_type)} subscription usage`);
  }

  if (usage.rate_limits_available && usage.rate_limits) {
    lines.push("", "### Limits", "");
    appendLimit(lines, "5-hour limit", usage.rate_limits.five_hour);
    appendLimit(lines, "Weekly · all models", usage.rate_limits.seven_day);
    const modelWindows = usage.rate_limits.model_scoped ?? [];
    for (const model of modelWindows) appendLimit(lines, `Weekly · ${model.display_name}`, model);
    if (modelWindows.length === 0) {
      appendLimit(lines, "Weekly · Opus", usage.rate_limits.seven_day_opus);
      appendLimit(lines, "Weekly · Sonnet", usage.rate_limits.seven_day_sonnet);
    }
    if (lines.at(-1) === "") lines.pop();
  }

  const models = Object.values(usage.session.model_usage);
  const totals = models.reduce(
    (sum, model) => ({
      input: sum.input + model.inputTokens,
      output: sum.output + model.outputTokens,
      cacheRead: sum.cacheRead + model.cacheReadInputTokens,
      cacheWrite: sum.cacheWrite + model.cacheCreationInputTokens,
    }),
    { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  );
  lines.push(
    "",
    "---",
    "",
    "### This session",
    "",
    "| Cost | API time | Active |",
    "|:--|:--|:--|",
    `| $${usage.session.total_cost_usd.toFixed(2)} | ${formatDuration(usage.session.total_api_duration_ms)} | ${formatDuration(usage.session.total_duration_ms)} |`,
    "",
    "| Breakdown | Tokens |",
    "|:--|--:|",
    `| Input | ${formatCount(totals.input)} |`,
    `| Output | ${formatCount(totals.output)} |`,
    `| Cache read | ${formatCount(totals.cacheRead)} |`,
    `| Cache write | ${formatCount(totals.cacheWrite)} |`,
  );

  if (usage.behaviors) {
    lines.push(
      "",
      "---",
      "",
      "### What’s using your limits?",
      "",
      "> Approximate, overlapping measures · this machine only · excludes claude.ai",
    );
    appendContributions(lines, "Last 24h", usage.behaviors.day);
    appendContributions(lines, "Last 7d", usage.behaviors.week);
  }
  return lines.join("\n");
}
