import type { AvailableCommand } from "@agentclientprotocol/sdk";
import type { McpServerStatus } from "@anthropic-ai/claude-agent-sdk";
import { escapeMarkdown } from "./usage-markdown.js";

/** A `/mcp` prompt that the adapter answers itself. Claude Code's own `/mcp`
 *  points the user to a terminal, which an ACP client does not have. */
export type McpCommand = { action: "status" } | { action: "reconnect"; server?: string };

/** The `/mcp` entry of `available_commands_update`. The adapter answers
 *  `/mcp` itself, so this entry replaces the Claude Code entry. */
export const MCP_AVAILABLE_COMMAND: AvailableCommand = {
  name: "mcp",
  description: "Show the MCP servers and their status, or reconnect a server",
  input: { hint: "reconnect [server]" },
};

/** Parse a prompt that is exactly `/mcp`, `/mcp reconnect`, or
 *  `/mcp reconnect <server>`. `/mcp reconnect all` means every server, as in
 *  Claude Code. Any other `/mcp` argument stays with Claude Code. */
export function parseMcpCommand(text: string): McpCommand | null {
  const words = text.trim().split(/\s+/);
  if (words[0] !== "/mcp") return null;
  if (words.length === 1) return { action: "status" };
  if (words[1]?.toLowerCase() !== "reconnect") return null;
  const server = words.slice(2).join(" ");
  if (server === "" || server === "all") return { action: "reconnect" };
  return { action: "reconnect", server };
}

/** The result of one reconnect attempt, shown above the server list. */
export type McpReconnectResult =
  | { server: string; outcome: "reconnected" }
  | { server: string; outcome: "authenticated" }
  | { server: string; outcome: "not-authenticated" }
  | { server: string; outcome: "failed"; error: string };

/** Why a `/mcp reconnect` did not try a server, shown above the server list. */
export type McpReconnectNote =
  { kind: "disabled"; server: string } | { kind: "nothing-to-reconnect" };

/** The known statuses in the order of the groups and of the summary counts.
 *  A disabled server is not a group. It is on one line at the end. */
const GROUP_ORDER: McpServerStatus["status"][] = ["failed", "needs-auth", "pending", "connected"];

const GROUP_TITLES: Partial<Record<McpServerStatus["status"], string>> = {
  failed: "Failed",
  "needs-auth": "Needs authentication",
  pending: "Connecting",
  connected: "Connected",
};

const SUMMARY_LABELS: Record<McpServerStatus["status"], string> = {
  connected: "connected",
  failed: "failed",
  "needs-auth": "need authentication",
  pending: "connecting",
  disabled: "disabled",
};

const KNOWN_STATUSES: string[] = [...GROUP_ORDER, "disabled"];

const MAX_ERROR_LENGTH = 160;

/** The longest segment that can be a wrapper. A longer segment is content. */
const MAX_WRAPPER_LENGTH = 60;

/** True for a server that a `/mcp reconnect` without a name must retry. */
export function needsReconnect(status: McpServerStatus): boolean {
  return (
    status.status === "failed" || status.status === "pending" || status.status === "needs-auth"
  );
}

/** The text as a Markdown code span. The fence is longer than the longest
 *  backtick run in the text, so the span shows the text unchanged. The user
 *  can copy a server name from it into `/mcp reconnect`. */
function codeSpan(text: string): string {
  const longestRun = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(longestRun + 1);
  // CommonMark strips one space from each end of a span, so a pad keeps the text unchanged.
  const pad = text.startsWith("`") || text.endsWith("`") || /^ .*[^ ].* $/.test(text) ? " " : "";
  return `${fence}${pad}${text}${pad}${fence}`;
}

function isErrorCode(segment: string): boolean {
  return /^-?\d+$/.test(segment);
}

/** True for a segment that only wraps the real error, such as
 *  `MCP startup failed`, `McpError`, or `MCP error -32001`, or for an error code. */
function isWrapperSegment(segment: string): boolean {
  if (isErrorCode(segment)) return true;
  return (
    segment.length <= MAX_WRAPPER_LENGTH &&
    !/[.!?]/.test(segment) &&
    /(failed|error|exception)(\s+-?\d+)?$/i.test(segment)
  );
}

/** True for a Rust or TypeScript type path, which means nothing to the user. */
function isTypeNoise(segment: string): boolean {
  return segment.includes("::") || /<[^<>]{20,}>/.test(segment);
}

/** The last name of a type path without its generics, for example
 *  `ServerInitializeError` for `rmcp::service::ServerInitializeError`. */
function typeName(segment: string): string {
  return segment.replace(/<.*$/, "").split("::").pop()?.trim() ?? "";
}

/** The error text when every segment is a wrapper, a code, or a type path.
 *  A type name comes first. Then the last wrapper and the codes after it, so
 *  an error code is never alone. */
function fallbackError(segments: string[], text: string): string {
  const typePath = [...segments].reverse().find((segment) => segment.includes("::"));
  const name = typePath ? typeName(typePath) : "";
  if (name !== "") return name;
  const wrappers = segments.filter((segment) => !isTypeNoise(segment));
  let last = wrappers.length - 1;
  while (last >= 0 && isErrorCode(wrappers[last]!)) last--;
  return last >= 0 ? wrappers.slice(last).join(": ") : text;
}

/** Cut the text to `MAX_ERROR_LENGTH` code points, so a surrogate pair stays whole. */
function truncate(text: string): string {
  const chars = Array.from(text);
  if (chars.length <= MAX_ERROR_LENGTH) return text;
  const cut = chars.slice(0, MAX_ERROR_LENGTH - 1).join("");
  const space = cut.lastIndexOf(" ");
  return `${(space > cut.length / 2 ? cut.slice(0, space) : cut).replace(/[\s.,;:]+$/, "")}…`;
}

function dedupe(items: string[]): string[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = item.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Make an MCP error short and readable for one list item. The result has
 *  no wrapper segments, no repeated segments, and no type paths. It has at
 *  most two sentences and `MAX_ERROR_LENGTH` code points. When only wrappers
 *  and type paths remain, the result is the type name, or the last wrapper
 *  with its codes. The result is empty for an error with only whitespace. */
export function cleanMcpError(error: string): string {
  const text = error.replace(/\s+/g, " ").trim();
  if (text === "") return "";
  const segments = text
    .split(/:\s+/)
    .map((segment) => segment.trim())
    .filter((segment) => segment !== "");
  const content = dedupe(
    segments.filter((segment) => !isTypeNoise(segment) && !isWrapperSegment(segment)),
  );
  if (content.length === 0) return truncate(fallbackError(segments, text));
  const sentences = dedupe(content.join(": ").split(/(?<=[.!?])\s+/));
  return truncate(sentences.slice(0, 2).join(" "));
}

function toolCount(status: McpServerStatus): string | undefined {
  if (!status.tools) return undefined;
  return status.tools.length === 1 ? "1 tool" : `${status.tools.length} tools`;
}

/** The server name as inline code. Claude Code keys the servers by name, so
 *  two servers have the same name only from different scopes. Then the
 *  scope tells them apart. */
function serverName(status: McpServerStatus, duplicates: Set<string>): string {
  const origin = status.scope ?? status.source;
  return duplicates.has(status.name) && origin
    ? `${codeSpan(status.name)} (${escapeMarkdown(origin)})`
    : codeSpan(status.name);
}

function serverItem(status: McpServerStatus, duplicates: Set<string>): string {
  const error = status.error ? cleanMcpError(status.error) : "";
  const details = [error === "" ? undefined : escapeMarkdown(error), toolCount(status)]
    .filter((detail) => detail !== undefined)
    .join("; ");
  const name = serverName(status, duplicates);
  return details === "" ? `- ${name}` : `- ${name}: ${details}`;
}

function summaryLine(statuses: McpServerStatus[]): string {
  // The counts follow the group order. An unknown status also counts, so the counts add up to the total.
  const counts = [...GROUP_ORDER, ...unknownStatuses(statuses), "disabled"]
    .map((state) => ({
      state,
      count: statuses.filter((status) => status.status === state).length,
    }))
    .filter(({ count }) => count > 0);
  const parts = counts.map(({ state, count }) =>
    count === 1 && state === "needs-auth"
      ? "1 needs authentication"
      : `${count} ${SUMMARY_LABELS[state as McpServerStatus["status"]] ?? escapeMarkdown(state)}`,
  );
  return `**MCP servers:** ${statuses.length} (${parts.join(", ")})`;
}

/** The statuses that this adapter does not know, in the SDK order. The SDK
 *  can report a new status before the adapter knows it. */
function unknownStatuses(statuses: McpServerStatus[]): string[] {
  return [
    ...new Set(
      statuses
        .map((status) => status.status as string)
        .filter((state) => !KNOWN_STATUSES.includes(state)),
    ),
  ];
}

function resultLine(result: McpReconnectResult): string {
  const name = codeSpan(result.server);
  switch (result.outcome) {
    case "failed": {
      const error = cleanMcpError(result.error);
      return error === ""
        ? `- ${name}: the reconnect failed.`
        : `- ${name}: the reconnect failed. ${escapeMarkdown(error)}`;
    }
    case "authenticated":
      return `- ${name}: authenticated.`;
    case "not-authenticated":
      return `- ${name}: not authenticated. The authentication flow did not finish.`;
    default:
      return `- ${name}: reconnected.`;
  }
}

function noteLine(note: McpReconnectNote): string {
  return note.kind === "disabled"
    ? `${codeSpan(note.server)} is disabled. A reconnect does not apply to a disabled server.`
    : "Every MCP server is connected or disabled. There is nothing to reconnect.";
}

/** The group title of a status that the adapter does not know. It starts with a capital letter, as a known title does. */
function unknownTitle(state: string): string {
  return escapeMarkdown(state.charAt(0).toUpperCase() + state.slice(1));
}

/** Markdown for `/mcp`: the reconnect note and results (if any), a summary
 *  line, one group of servers for each status, and the disabled servers on
 *  one line. A list reads better than a table in a narrow chat. */
export function formatMcpStatus(
  statuses: McpServerStatus[],
  options: { results?: McpReconnectResult[]; note?: McpReconnectNote } = {},
): string {
  const blocks: string[] = [];
  const results = options.results ?? [];
  if (results.length > 0 || options.note) {
    blocks.push(
      [
        ...(options.note ? [noteLine(options.note)] : []),
        ...(results.length > 0 ? ["**Reconnect:**", ...results.map(resultLine)] : []),
      ].join("\n"),
    );
  }
  if (statuses.length === 0) {
    blocks.push("No MCP servers are configured.");
    return blocks.join("\n\n");
  }
  const names = statuses.map((status) => status.name);
  const duplicates = new Set(names.filter((name, index) => names.indexOf(name) !== index));
  blocks.push(summaryLine(statuses));
  const groups: [string, string][] = [
    ...GROUP_ORDER.map((state): [string, string] => [state, GROUP_TITLES[state]!]),
    ...unknownStatuses(statuses).map((state): [string, string] => [state, unknownTitle(state)]),
  ];
  for (const [state, title] of groups) {
    const members = statuses.filter((status) => status.status === state);
    if (members.length === 0) continue;
    blocks.push(
      [`**${title}**`, ...members.map((status) => serverItem(status, duplicates))].join("\n"),
    );
  }
  const disabled = statuses.filter((status) => status.status === "disabled");
  if (disabled.length > 0) {
    blocks.push(
      `**Disabled:** ${disabled.map((status) => serverName(status, duplicates)).join(", ")}`,
    );
  }
  if (statuses.some(needsReconnect)) {
    blocks.push(
      "Run `/mcp reconnect <server>` to reconnect one server, or `/mcp reconnect` to reconnect every server that is not connected and not disabled.",
    );
  }
  return blocks.join("\n\n");
}

/** Markdown for `/mcp reconnect <server>` when no server has that name. */
export function formatUnknownMcpServer(server: string, statuses: McpServerStatus[]): string {
  const lines = [`There is no MCP server named ${codeSpan(server)}.`];
  if (statuses.length === 0) {
    lines.push("No MCP servers are configured.");
  } else {
    lines.push(`Known servers: ${statuses.map((status) => codeSpan(status.name)).join(", ")}.`);
  }
  return lines.join("\n");
}

/** Markdown for `/mcp` when the MCP server status cannot be read. */
export function formatMcpStatusUnavailable(error: string): string {
  return `The MCP server status is not available. ${escapeMarkdown(error)}`;
}
