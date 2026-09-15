import type { McpServerStatus, Query } from "@anthropic-ai/claude-agent-sdk";
import { FILE_CHANGE_AUDIT_SERVER_NAME } from "./file-change-audit.js";

/**
 * `/mcp reconnect|enable|disable [<server>|all]`.
 *
 * The CLI handles these inline in its interactive UI, but a headless session
 * (which is what the SDK runs) refuses them. The command still goes to the CLI
 * as a normal turn; when its output is that refusal, the adapter runs the action
 * through the SDK's control requests and replies in its place. The branches and
 * the replies mirror the CLI's inline handler so a user sees the same wording
 * either way; `/mcp` and `/mcp list` stay with the CLI.
 */

/** The CLI's exact reply to these actions in a session without its /mcp UI. */
const HEADLESS_REFUSAL = "Reconnect, enable, and disable aren't available in this session.";

export function isMcpServerCommandRefusal(output: string): boolean {
  return output.trim() === HEADLESS_REFUSAL;
}

export type McpServerAction = "reconnect" | "enable" | "disable";

export type McpServerCommand = {
  action: McpServerAction;
  /** A configured server's name, or "all", which is also what no name means. */
  serverName: string;
};

type McpControls = Pick<Query, "reconnectMcpServer" | "toggleMcpServer" | "mcpServerStatus">;
type Status = McpServerStatus["status"];

/** The CLI's own labels for a server's state, as it prints them in parentheses. */
const STATUS_LABEL: Record<Status, string> = {
  connected: "connected",
  pending: "connecting",
  disabled: "disabled",
  failed: "not connected",
  "needs-auth": "needs authentication",
};

const SEE_STATUS = "Run `/mcp` in the terminal to see status.";
const CHECK = "Run `/mcp` in the terminal to check.";

export function parseMcpServerCommand(text: string): McpServerCommand | null {
  const match = /^\/mcp\s+(\S+)(?:\s+(.*))?$/.exec(text.trim());
  if (!match) return null;
  const action = match[1].toLowerCase();
  if (action !== "reconnect" && action !== "enable" && action !== "disable") return null;
  return { action, serverName: match[2] || "all" };
}

/** Runs the command and returns the reply. Failures become the reply too,
 *  never a rejected prompt. */
export async function runMcpServerCommand(
  query: McpControls,
  { action, serverName }: McpServerCommand,
): Promise<string> {
  const all = serverName === "all";
  let servers: McpServerStatus[];
  try {
    servers = await listServers(query);
  } catch (error) {
    return couldNot(action, all ? "MCP servers" : quote(serverName), error);
  }

  const targets = all ? servers : servers.filter((s) => s.name === serverName);
  if (targets.length === 0) {
    return all
      ? "No MCP servers are configured. Add one with `claude mcp add`."
      : `There's no MCP server named ${quote(serverName)}. Run \`/mcp\` in the terminal to see configured servers.`;
  }

  if (action === "reconnect") {
    return all ? reconnectAll(query, targets) : reconnectOne(query, targets[0]);
  }
  return all
    ? toggleAll(query, targets, action === "enable")
    : toggleOne(query, targets[0], action === "enable");
}

async function reconnectOne(query: McpControls, server: McpServerStatus): Promise<string> {
  const name = quote(server.name);
  if (server.status === "disabled") {
    return withCommand(
      `${name} is disabled.`,
      ` Run \`/mcp enable ${server.name}\` to bring it back.`,
      server.name,
    );
  }
  if (server.status === "pending") {
    return `${name} is already reconnecting — retries can take a few minutes when a server keeps failing.`;
  }
  try {
    await query.reconnectMcpServer(server.name);
  } catch (error) {
    return couldNot("reconnect", name, error);
  }
  const status = await statusOf(query, server.name);
  return status === "connected"
    ? `Reconnected ${name}.`
    : `Couldn't reconnect ${name} (${STATUS_LABEL[status]}). ${nextStep(status)}`;
}

async function reconnectAll(query: McpControls, servers: McpServerStatus[]): Promise<string> {
  const retry = servers.filter(notConnected);
  if (retry.length === 0) {
    const disabled = servers.filter((s) => s.status === "disabled").length;
    return disabled > 0
      ? `${disabled} MCP server(s) are disabled. Run \`/mcp enable all\` to bring them back.`
      : "All enabled MCP servers are already connected or connecting.";
  }
  const results = await Promise.allSettled(retry.map((s) => query.reconnectMcpServer(s.name)));
  const after = await listServers(query).catch(() => []);
  const reconnected = retry.filter(
    (s, i) =>
      results[i].status === "fulfilled" &&
      after.find((a) => a.name === s.name)?.status === "connected",
  ).length;
  return `Reconnected ${reconnected} of ${retry.length} MCP server(s). ${SEE_STATUS}`;
}

async function toggleOne(
  query: McpControls,
  server: McpServerStatus,
  enable: boolean,
): Promise<string> {
  const name = quote(server.name);
  const verb = enable ? "enable" : "disable";
  if ((server.status === "disabled") !== enable) {
    return enable && notConnected(server)
      ? withCommand(
          `${name} is already enabled but not connected.`,
          ` Run \`/mcp reconnect ${server.name}\` to retry.`,
          server.name,
        )
      : `${name} is already ${verb}d.`;
  }
  try {
    await query.toggleMcpServer(server.name, enable);
  } catch (error) {
    return enable
      ? couldNot("enable", name, error)
      : `Couldn't disable ${name} — it may have been removed, or its configuration couldn't be read. ${CHECK}`;
  }
  if (!enable) return `Disabled ${name}.`;
  const status = await statusOf(query, server.name);
  if (status === "connected") return `Enabled ${name}.`;
  const label = status === "failed" ? "" : ` (${STATUS_LABEL[status]})`;
  return `Enabled ${name}, but it isn't connected yet${label}. ${nextStep(status)}`;
}

async function toggleAll(
  query: McpControls,
  servers: McpServerStatus[],
  enable: boolean,
): Promise<string> {
  const change = servers.filter((s) => (s.status === "disabled") === enable);
  if (change.length === 0) {
    const stuck = enable ? servers.filter(notConnected).length : 0;
    if (stuck > 0) {
      return `All MCP servers are already enabled, but ${stuck} ${stuck === 1 ? "isn't" : "aren't"} connected — reply \`/mcp reconnect all\` here to retry.`;
    }
    return `All MCP servers are already ${enable ? "enabled" : "disabled"}.`;
  }
  const results = await Promise.allSettled(
    change.map((s) => query.toggleMcpServer(s.name, enable)),
  );
  const changed = results.filter((r) => r.status === "fulfilled").length;
  const failed = change.length - changed;
  let pending = "";
  if (enable) {
    const after = await listServers(query).catch(() => []);
    const connected = change.filter(
      (s, i) =>
        results[i].status === "fulfilled" &&
        after.find((a) => a.name === s.name)?.status === "connected",
    ).length;
    if (connected < changed) pending = ` (${changed - connected} enabled but not yet connected)`;
  }
  return (
    `${enable ? "Enabled" : "Disabled"} ${changed} MCP server(s)${pending}` +
    (failed > 0 ? ` (${failed} couldn't be changed)` : "") +
    `. ${SEE_STATUS}`
  );
}

/** The CLI leaves its own IDE bridge out of `/mcp`; the adapter's file-change
 *  audit server is left out too, since disabling it would break the audit. */
async function listServers(query: McpControls): Promise<McpServerStatus[]> {
  return (await query.mcpServerStatus()).filter(
    (s) => s.name !== "ide" && s.name !== FILE_CHANGE_AUDIT_SERVER_NAME,
  );
}

/** A control request resolving means the CLI ran it, not that the server came
 *  up; the state after is what the reply reports. */
async function statusOf(query: McpControls, name: string): Promise<Status> {
  const servers = await listServers(query).catch(() => []);
  return servers.find((s) => s.name === name)?.status ?? "failed";
}

/** The CLI counts failed and needs-auth servers as "not connected". */
function notConnected(server: McpServerStatus): boolean {
  return server.status === "failed" || server.status === "needs-auth";
}

function nextStep(status: Status): string {
  return status === "needs-auth"
    ? "Authenticate with `/mcp` in the terminal."
    : "Check its config with `/mcp` in the terminal.";
}

function couldNot(action: McpServerAction, what: string, error: unknown): string {
  const reason = error instanceof Error ? error.message : String(error);
  return `Couldn't ${action} ${what} — ${reason}. ${CHECK}`;
}

/** Appends a command to retype only when the name can be typed back as one
 *  argument and the reply stays short, as the CLI does. */
function withCommand(sentence: string, command: string, name: string): string {
  const text = sentence + command;
  return /^\w[\w.@-]*$/.test(name) && [...text].length <= 1024 ? text : sentence;
}

function quote(name: string): string {
  return `"${name}"`;
}
