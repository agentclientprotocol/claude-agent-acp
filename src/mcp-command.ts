import type { AvailableCommand } from "@agentclientprotocol/sdk";
import type { McpServerStatus, Query } from "@anthropic-ai/claude-agent-sdk";
import { escapeMarkdown } from "./usage-markdown.js";
import { raceTimeoutAndAbort } from "./utils.js";

/** The `/mcp` entry of `available_commands_update`. The adapter shows the
 *  servers as a list, and runs a reconnect, an enable, or a disable through
 *  the SDK control API. */
export const MCP_AVAILABLE_COMMAND: AvailableCommand = {
  name: "mcp",
  description: "Show the MCP servers and their status, or reconnect, enable, or disable a server",
  input: { hint: "[reconnect|enable|disable [<server>|all]]" },
};

/** The time that the status read after a `/mcp` command can take. */
const MCP_STATUS_TIMEOUT_MS = 5_000;

/** The time that one reconnect, enable, or disable can take. */
const MCP_ACTION_TIMEOUT_MS = 30_000;

/** A `/mcp` prompt that gets a replacement for its Claude Code text. `all` is
 *  true for `all` and for a reconnect without a server name, as in Claude
 *  Code. `server` is undefined for an enable or a disable without a name. */
export type McpCommand =
  | { action: "status" }
  | { action: "reconnect" | "enable" | "disable"; all: boolean; server?: string };

/** Parse a prompt that is exactly `/mcp`, or `/mcp reconnect`, `/mcp enable`,
 *  or `/mcp disable` with an optional server name or `all`. Any other `/mcp`
 *  argument gives null, and the prompt gets no replacement. */
export function parseMcpCommand(text: string): McpCommand | null {
  const words = text.trim().split(/\s+/);
  if (words[0] !== "/mcp") return null;
  if (words.length === 1) return { action: "status" };
  const action = words[1]?.toLowerCase();
  if (action !== "reconnect" && action !== "enable" && action !== "disable") return null;
  const server = words.slice(2).join(" ");
  if (server === "all" || (server === "" && action === "reconnect")) {
    return { action, all: true };
  }
  return server === "" ? { action, all: false } : { action, all: false, server };
}

/** Read the MCP server status for the list after a `/mcp` command. Resolves
 *  to null when the read fails, takes too long, or `signal` aborts. Then the
 *  turn keeps the text of Claude Code. */
export async function readMcpServerStatus(
  query: Pick<Query, "mcpServerStatus">,
  signal: AbortSignal,
  logError: (message: string) => void,
): Promise<McpServerStatus[] | null> {
  if (signal.aborted) return null;
  try {
    const outcome = await raceTimeoutAndAbort(
      query.mcpServerStatus(),
      MCP_STATUS_TIMEOUT_MS,
      signal,
    );
    if (outcome.type === "timeout") {
      logError("The MCP server status read timed out; keeping the Claude Code text of /mcp");
    }
    return outcome.type === "done" ? outcome.value : null;
  } catch (error) {
    if (!signal.aborted) {
      logError(`The MCP server status read failed; keeping the Claude Code text of /mcp: ${error}`);
    }
    return null;
  }
}

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
function needsReconnect(status: McpServerStatus): boolean {
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
 *  `MCP startup failed`, `McpError`, `MCP error -32001`, an error code, or a
 *  Rust or TypeScript type path. */
function isWrapperSegment(segment: string): boolean {
  return (
    isErrorCode(segment) ||
    segment.includes("::") ||
    (segment.length <= MAX_WRAPPER_LENGTH &&
      !/[.!?]/.test(segment) &&
      /(failed|error|exception)(\s+-?\d+)?$/i.test(segment))
  );
}

/** Cut the text to `MAX_ERROR_LENGTH` code points, so a surrogate pair stays whole. */
function truncate(text: string): string {
  const chars = Array.from(text);
  if (chars.length <= MAX_ERROR_LENGTH) return text;
  const cut = chars.slice(0, MAX_ERROR_LENGTH - 1).join("");
  return `${cut.trimEnd()}…`;
}

/** Make an MCP error short and readable for one list item. The result has
 *  no leading wrapper segments, at most two sentences, and at most
 *  `MAX_ERROR_LENGTH` code points. A wrapper before an error code stays, so
 *  an error code is never alone. The result is empty for an error with only
 *  whitespace. */
export function cleanMcpError(error: string): string {
  const segments = error.replace(/\s+/g, " ").trim().split(": ");
  let start = 0;
  while (
    start < segments.length - 1 &&
    isWrapperSegment(segments[start]!) &&
    !segments.slice(start + 1).every(isErrorCode)
  ) {
    start++;
  }
  const content = segments.slice(start).join(": ");
  return truncate(
    content
      .split(/(?<=[.!?]) /)
      .slice(0, 2)
      .join(" "),
  );
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

/** The group title of a status that the adapter does not know. It starts with a capital letter, as a known title does. */
function unknownTitle(state: string): string {
  return escapeMarkdown(state.charAt(0).toUpperCase() + state.slice(1));
}

/** Markdown for `/mcp`: a summary line, one group of servers for each
 *  status, and the disabled servers on one line. A list reads better than a
 *  table in a narrow chat. */
export function formatMcpStatus(statuses: McpServerStatus[]): string {
  if (statuses.length === 0) return "No MCP servers are configured.";
  const blocks: string[] = [];
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

/** The SDK query methods that `/mcp` uses. */
export type McpControlQuery = Pick<
  Query,
  "mcpServerStatus" | "reconnectMcpServer" | "toggleMcpServer"
>;

/** The result of {@link runMcpCommand}. `markdown` is null when the turn
 *  keeps the text of Claude Code. `reconnected` holds the servers that the
 *  adapter tried to reconnect. */
export type McpCommandOutcome = { markdown: string | null; reconnected: string[] };

type CallResult = { type: "done" } | { type: "failed"; error: string } | { type: "aborted" };

/** Wait for one control call. The wait stops when `signal` aborts or the
 *  call takes more than {@link MCP_ACTION_TIMEOUT_MS}. */
async function awaitCall(call: () => Promise<void>, signal: AbortSignal): Promise<CallResult> {
  if (signal.aborted) return { type: "aborted" };
  try {
    const outcome = await raceTimeoutAndAbort(call(), MCP_ACTION_TIMEOUT_MS, signal);
    if (outcome.type === "timeout") return { type: "failed", error: "The request timed out." };
    return outcome.type === "done" ? { type: "done" } : outcome;
  } catch (error) {
    return signal.aborted
      ? { type: "aborted" }
      : { type: "failed", error: error instanceof Error ? error.message : String(error) };
  }
}

const ACTION_DONE = { reconnect: "Reconnected", enable: "Enabled", disable: "Disabled" };

/** The Claude Code sentence that refuses an action in SDK mode. */
const UNAVAILABLE_SENTENCE = /aren't available in this session/i;

/** A Claude Code sentence that points to a terminal, which an ACP client
 *  does not have. */
function isTerminalSentence(sentence: string): boolean {
  return /in the terminal/i.test(sentence) || sentence.includes("`/mcp reconnect all` here");
}

function sentences(text: string): string[] {
  return text
    .trim()
    .split(/(?<=[.!?])\s+/)
    .filter((sentence) => sentence !== "");
}

/** The servers that the action changes. A named server is always a target,
 *  so the control API reports its own error. */
function actionTargets(
  command: Extract<McpCommand, { all: boolean }>,
  statuses: McpServerStatus[],
): string[] {
  if (!command.all) return command.server === undefined ? [] : [command.server];
  const names = statuses
    .filter((status) => {
      if (command.action === "reconnect") return needsReconnect(status);
      if (command.action === "enable") return status.status === "disabled";
      return status.status !== "disabled";
    })
    .map((status) => status.name);
  return [...new Set(names)];
}

function nothingToDoLine(action: McpCommand["action"]): string {
  if (action === "enable") return "Every MCP server is already enabled.";
  if (action === "disable") return "Every MCP server is already disabled.";
  return "Every MCP server is connected or disabled. There is nothing to reconnect.";
}

/** Run a `/mcp` command after Claude Code sent `originalOutput`, its text for
 *  the command. Claude Code refuses a reconnect, an enable, and a disable in
 *  SDK mode, so the adapter runs them through the SDK control API. The result
 *  of each server goes above the server list. An error of one server does
 *  not stop the others. When the first status read fails or `signal`
 *  aborts, the turn keeps the text of Claude Code. */
export async function runMcpCommand(
  query: McpControlQuery,
  command: McpCommand,
  originalOutput: string,
  signal: AbortSignal,
  logError: (message: string) => void,
): Promise<McpCommandOutcome> {
  const reconnected: string[] = [];
  const keep: McpCommandOutcome = { markdown: null, reconnected };
  if (command.action === "status") {
    // The list replaces the Claude Code summary line.
    const statuses = await readMcpServerStatus(query, signal, logError);
    return { markdown: statuses ? formatMcpStatus(statuses) : null, reconnected };
  }
  const before = await readMcpServerStatus(query, signal, logError);
  if (!before) return keep;

  const cliSentences = sentences(originalOutput).filter(
    (sentence) => !isTerminalSentence(sentence),
  );
  const cliNamesUnknown = cliSentences.some((sentence) => /no MCP server named/i.test(sentence));
  const results: string[] = [];
  if (!command.all && command.server === undefined) {
    results.push(`Name a server or \`all\`, for example \`/mcp ${command.action} <server>\`.`);
  }
  const known = new Set(before.map((status) => status.name));
  const targets = actionTargets(command, before);
  if (command.all && targets.length === 0) results.push(nothingToDoLine(command.action));
  for (const server of targets) {
    if (!known.has(server)) {
      // Claude Code checks the name first. Its sentence then stays.
      if (!cliNamesUnknown) results.push(`There's no MCP server named ${codeSpan(server)}.`);
      continue;
    }
    if (command.action === "reconnect") reconnected.push(server);
    const call =
      command.action === "reconnect"
        ? () => query.reconnectMcpServer(server)
        : () => query.toggleMcpServer(server, command.action === "enable");
    const result = await awaitCall(call, signal);
    if (result.type === "aborted") return keep;
    if (result.type === "done") {
      results.push(`- ${ACTION_DONE[command.action]} ${codeSpan(server)}`);
    } else {
      const error = cleanMcpError(result.error);
      const failure = `- Couldn't ${command.action} ${codeSpan(server)}`;
      results.push(error === "" ? failure : `${failure}: ${escapeMarkdown(error)}`);
    }
  }

  const blocks: string[] = [];
  const kept = cliSentences.filter((sentence) => !UNAVAILABLE_SENTENCE.test(sentence));
  if (kept.length > 0) blocks.push(kept.join(" "));
  if (results.length > 0) blocks.push(results.join("\n"));
  const after = await readMcpServerStatus(query, signal, logError);
  if (signal.aborted) return keep;
  if (after) blocks.push(formatMcpStatus(after));
  return { markdown: blocks.join("\n\n"), reconnected };
}
