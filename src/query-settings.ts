import type { Query, Settings } from "@anthropic-ai/claude-agent-sdk";

/** The fields used from Claude Code's `get_settings` control response. */
export type QuerySettings = {
  effective?: Settings;
  sources?: Array<{ source?: unknown; settings?: Settings }>;
  applied?: {
    model?: unknown;
    ultracodeAvailable?: unknown;
    ultracodeRequested?: unknown;
  };
};

// Query.getSettings exists at runtime but is missing from the SDK's types
// as of 0.3.331. Older SDKs/CLIs may not serve it.
type SettingsQuery = Query & { getSettings?: () => Promise<QuerySettings> };

export async function readQuerySettings(query: Query): Promise<QuerySettings | undefined> {
  const getSettings = (query as SettingsQuery).getSettings;
  if (typeof getSettings !== "function") return undefined;
  try {
    return await getSettings.call(query);
  } catch {
    return undefined;
  }
}

/**
 * The policy tier the running CLI applies: its managed settings, remote ones
 * included. Undefined when the CLI reports none.
 */
export function cliPolicySettings(report: QuerySettings | undefined): Settings | undefined {
  const sources = Array.isArray(report?.sources) ? report.sources : [];
  const policy = sources.find((entry) => entry?.source === "policySettings")?.settings;
  if (!policy || typeof policy !== "object" || Object.keys(policy).length === 0) return undefined;
  return policy;
}
