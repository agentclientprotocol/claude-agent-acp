import type { SessionConfigOption, SessionConfigSelectOption } from "@agentclientprotocol/sdk";
import type { SDKRateLimitInfo } from "@anthropic-ai/claude-agent-sdk";

export type UsageView = "context" | "five_hour" | "week" | "hidden";
export type UsageRateLimitKey = "five_hour" | "seven_day_opus" | "seven_day_sonnet" | "seven_day";

type LabelTooltip = { label: string; tooltip: string };

export function buildUsageConfigOption(
  view: UsageView,
  context: { used: number; size: number } | null,
  rateLimits: Partial<Record<UsageRateLimitKey, SDKRateLimitInfo>>,
): SessionConfigOption {
  const ctx = formatContextUsage(context);
  const five = formatFiveHour(rateLimits.five_hour);
  const week = formatWeek(
    rateLimits.seven_day_opus,
    rateLimits.seven_day_sonnet,
    rateLimits.seven_day,
  );

  const options: SessionConfigSelectOption[] = [
    { value: "context", name: ctx.label, description: ctx.tooltip },
  ];
  if (five) options.push({ value: "five_hour", name: five.label, description: five.tooltip });
  if (week) options.push({ value: "week", name: week.label, description: week.tooltip });
  options.push({
    value: "hidden",
    name: "",
    description:
      "Collapses this dropdown to just the selector chevron. Pick this if you don't want context or cooldown info on screen.",
  });

  // If the preferred view isn't currently in the list (e.g. rate-limit data
  // hasn't arrived yet), fall back to "context" for what's shown on the
  // closed button. The caller keeps the stored preference so selection
  // restores when data becomes available again.
  const available = new Set(options.map((o) => o.value));
  const currentValue = available.has(view) ? view : "context";

  return {
    id: "usage",
    name: "Usage",
    description: "Context and rate-limit usage",
    type: "select",
    currentValue,
    options,
  };
}

export function formatContextUsage(context: { used: number; size: number } | null): LabelTooltip {
  if (!context || context.size <= 0) {
    return { label: "Ctx: —", tooltip: "Context usage not yet available." };
  }
  const pct = Math.round((context.used / context.size) * 100);
  return {
    label: `Ctx: ${pct}%`,
    tooltip: `Context: ${formatTokens(context.used)} / ${formatTokens(context.size)} tokens (${pct}%)`,
  };
}

/** Build the 5-hour label+tooltip, or return null to hide the option entirely
 *  (no resetsAt and no utilization available — nothing useful to display). */
export function formatFiveHour(info: SDKRateLimitInfo | undefined): LabelTooltip | null {
  if (!info) return null;
  const pct = info.utilization !== undefined ? Math.round(info.utilization * 100) : null;
  const resetIn = formatResetIn(info.resetsAt);
  const resetAt = formatResetAt(info.resetsAt);
  if (pct === null && resetIn === null) return null;

  const labelParts = ["5h"];
  if (pct !== null) labelParts.push(`${pct}%`);
  if (resetIn) labelParts.push(resetIn);
  const label = labelParts.join(" ");

  const tooltipParts: string[] = [];
  tooltipParts.push(
    pct !== null ? `5-hour limit: ${pct}% used` : "5-hour limit: usage unknown until threshold",
  );
  if (resetAt) tooltipParts.push(`resets at ${resetAt}`);
  if (info.status === "allowed_warning") tooltipParts.push("status: approaching limit");
  if (info.status === "rejected") tooltipParts.push("status: limit reached");
  return { label, tooltip: tooltipParts.join(" · ") };
}

/** Build the weekly label+tooltip, or return null to hide the option when no
 *  weekly utilization is present. Weekly data only arrives once a warning
 *  threshold has been crossed, so the option is omitted during normal use. */
export function formatWeek(
  opus: SDKRateLimitInfo | undefined,
  sonnet: SDKRateLimitInfo | undefined,
  generic: SDKRateLimitInfo | undefined,
): LabelTooltip | null {
  const primary = opus ?? generic ?? sonnet;
  if (!primary || primary.utilization === undefined) return null;

  const pct = Math.round(primary.utilization * 100);
  const label = `Week: ${pct}%`;

  const lines: string[] = [];
  if (opus) lines.push(weeklyLine("Weekly Opus", opus));
  else if (generic) lines.push(weeklyLine("Weekly", generic));
  if (sonnet) lines.push(weeklyLine("Weekly Sonnet", sonnet));
  return { label, tooltip: lines.join("\n") };
}

function weeklyLine(prefix: string, info: SDKRateLimitInfo): string {
  const pct = info.utilization !== undefined ? Math.round(info.utilization * 100) : null;
  const resetAt = formatResetAt(info.resetsAt);
  const pctStr = pct !== null ? `${pct}% used` : "usage unknown";
  return `${prefix}: ${pctStr}${resetAt ? `, resets ${resetAt}` : ""}`;
}

export function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(2)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(0)}k`;
  return String(tokens);
}

export function formatResetIn(resetsAt: number | undefined): string | null {
  if (resetsAt === undefined) return null;
  const msLeft = resetsAt * 1000 - Date.now();
  if (msLeft <= 0) return null;
  const totalMinutes = Math.floor(msLeft / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours}:${minutes.toString().padStart(2, "0")}`;
}

/** Format an absolute reset timestamp in the user's local timezone, including
 *  a short tz name so the value is unambiguous in the tooltip. */
export function formatResetAt(resetsAt: number | undefined): string | null {
  if (resetsAt === undefined) return null;
  const date = new Date(resetsAt * 1000);
  const sameDay = new Date().toDateString() === date.toDateString();
  const time = date.toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });
  if (sameDay) return time;
  const day = date.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
  return `${day} ${time}`;
}
