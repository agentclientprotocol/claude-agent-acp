import {
  createSdkMcpServer,
  type HookCallback,
  type McpSdkServerConfigWithInstance,
  type SdkMcpToolDefinition,
} from "@anthropic-ai/claude-agent-sdk";
import * as path from "node:path";
import { z } from "zod";

export const AGENT_FILE_CHANGE_REPORT_CAPABILITY = "agentFileChangeReport";
export const FILE_CHANGE_AUDIT_SERVER_NAME = "claude_agent_acp";
export const FILE_CHANGE_AUDIT_TOOL_NAME = "report_changed_files";
export const FILE_CHANGE_AUDIT_WIRE_TOOL_NAME = `mcp__${FILE_CHANGE_AUDIT_SERVER_NAME}__${FILE_CHANGE_AUDIT_TOOL_NAME}`;

const FILE_CHANGE_AUDIT_MARKER = "claude-agent-acp-file-change-audit";
const MAX_REPORTED_PATHS = 1024;
const MAX_REPORTED_PATH_LENGTH = 4096;
export const AGENT_FILE_CHANGE_REPORT_MAX_BYTES = 256 * 1024;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

export type FileChangeAuditTurnState = {
  requestId: string;
  phase: "requested" | "collecting" | "finished";
};

export type FileChangeAuditWorkspace = {
  cwd: string;
  additionalDirectories: string[];
};

export type AgentFileChangeReport = {
  paths: string[];
  complete: boolean;
  uncertainty?: string;
};

export type AgentFileChangeReportResult = {
  version: 1;
  requestId: string;
} & (
  | {
      status: "reported";
      paths: string[];
      declaredComplete: boolean;
      truncated: boolean;
      uncertainty?: string;
    }
  | {
      status: "unavailable";
      reason: FileChangeReportUnavailableReason;
    }
);

export type FileChangeReportUnavailableReason =
  "cancelled" | "timeout" | "invalidOutput" | "notReported" | "providerError";

const JETBRAINS_META_KEY = "jetbrains";
const AIR_META_KEY = "air";
const AIR_EXTENSION_VERSION = 1;
const AIR_EXTENSION_CAPABILITIES_KEY = "capabilities";
const AIR_AGENT_FILE_CHANGE_REPORT_KEY = "agentFileChangeReport";

type FileChangeAuditSupportOptions = {
  cwd: string;
  additionalDirectories: string[];
  getActiveState: () => FileChangeAuditTurnState | undefined;
  publish: (result: AgentFileChangeReportResult) => Promise<void>;
  logError: (message: string) => void;
};

export type FileChangeAuditSupport = {
  mcpServer: McpSdkServerConfigWithInstance;
  preToolUseHook: HookCallback;
  stopHook: HookCallback;
  finishUnavailable: (
    state: FileChangeAuditTurnState,
    reason: FileChangeReportUnavailableReason,
  ) => Promise<void>;
};

const reportInputSchema = {
  paths: z
    .array(z.string())
    .describe(
      "Workspace file paths changed during this turn. Use absolute paths or paths relative to cwd.",
    ),
  complete: z
    .boolean()
    .describe("True only when paths contains every workspace file changed during this turn."),
  uncertainty: z
    .string()
    .trim()
    .min(1)
    .max(2000)
    .optional()
    .describe("Why the report may be incomplete or uncertain."),
};

export function agentFileChangeReportRequestId(meta: unknown): string | undefined {
  const air = airExtension(meta);
  const request = air?.agentFileChangeReportRequest;
  if (!request || typeof request !== "object" || Array.isArray(request)) return undefined;
  const requestRecord = request as Record<string, unknown>;
  const requestKeys = Object.keys(requestRecord);
  if (
    requestKeys.length !== 2 ||
    !requestKeys.includes("version") ||
    !requestKeys.includes("requestId") ||
    requestRecord.version !== 1
  )
    return undefined;
  const requestId = requestRecord.requestId;
  return typeof requestId === "string" && REQUEST_ID_PATTERN.test(requestId)
    ? requestId
    : undefined;
}

export function supportsAgentFileChangeReport(capabilities: unknown): boolean {
  if (!capabilities || typeof capabilities !== "object" || Array.isArray(capabilities)) {
    return false;
  }
  const air = airExtension((capabilities as Record<string, unknown>)._meta);
  const advertised = air?.[AIR_EXTENSION_CAPABILITIES_KEY];
  return (
    air?.version === AIR_EXTENSION_VERSION &&
    Array.isArray(advertised) &&
    advertised.includes(AGENT_FILE_CHANGE_REPORT_CAPABILITY)
  );
}

export function agentFileChangeReportMeta(
  result: AgentFileChangeReportResult,
): Record<string, unknown> {
  return {
    [JETBRAINS_META_KEY]: {
      [AIR_META_KEY]: {
        version: AIR_EXTENSION_VERSION,
        [AIR_AGENT_FILE_CHANGE_REPORT_KEY]: result,
      },
    },
  };
}

function airExtension(meta: unknown): Record<string, unknown> | undefined {
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return undefined;
  const jetbrains = (meta as Record<string, unknown>)[JETBRAINS_META_KEY];
  if (!jetbrains || typeof jetbrains !== "object" || Array.isArray(jetbrains)) return undefined;
  const air = (jetbrains as Record<string, unknown>)[AIR_META_KEY];
  return air && typeof air === "object" && !Array.isArray(air)
    ? (air as Record<string, unknown>)
    : undefined;
}

export function createFileChangeAuditTurnState(requestId: string): FileChangeAuditTurnState {
  return {
    requestId,
    phase: "requested",
  };
}

export function isFileChangeAuditReportPhase(state: FileChangeAuditTurnState | undefined): boolean {
  return state?.phase === "collecting" || state?.phase === "finished";
}

export function isFileChangeAuditTool(toolName: string): boolean {
  return toolName === FILE_CHANGE_AUDIT_WIRE_TOOL_NAME;
}

export function containsFileChangeAuditMarker(text: string): boolean {
  return text.includes(`<${FILE_CHANGE_AUDIT_MARKER}>`);
}

export function createFileChangeAuditSupport(
  options: FileChangeAuditSupportOptions,
): FileChangeAuditSupport {
  const workspace = normalizeWorkspace(options.cwd, options.additionalDirectories);

  const finishUnavailable = async (
    state: FileChangeAuditTurnState,
    reason: FileChangeReportUnavailableReason,
  ) => {
    // Claim the terminal outcome before the first await. The report tool, a
    // Stop hook, cancellation, and stream teardown can race, but only the
    // winner may publish for this request id. Publication remains fail-open:
    // an audit transport failure must never hold the user prompt open.
    if (state.phase === "finished") return;
    state.phase = "finished";
    try {
      await options.publish({
        version: 1,
        requestId: state.requestId,
        status: "unavailable",
        reason,
      });
    } catch (error) {
      options.logError(`Failed to publish unavailable report ${state.requestId}: ${error}`);
    }
  };

  const tool: SdkMcpToolDefinition<typeof reportInputSchema> = {
    name: FILE_CHANGE_AUDIT_TOOL_NAME,
    description:
      "Internal audit tool. Call it only when a stop-hook message explicitly requests the file-change audit.",
    inputSchema: reportInputSchema,
    _meta: {
      "anthropic/alwaysLoad": true,
      "claude/endTurn": true,
    },
    handler: async (report) => {
      const state = options.getActiveState();
      if (!state || state.phase !== "collecting") {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `<${FILE_CHANGE_AUDIT_MARKER}>No file-change audit is active.</${FILE_CHANGE_AUDIT_MARKER}>`,
            },
          ],
        };
      }

      // Flip before publishing: a client transport failure must not make the
      // model retry the report and produce duplicates. Delivery is audit-only
      // and fail-open; the normal turn must still finish.
      state.phase = "finished";
      const normalized = normalizeReportedPaths(report.paths, workspace);
      const result = fitReportedAgentFileChangeReport({
        version: 1,
        requestId: state.requestId,
        status: "reported",
        paths: normalized.paths,
        declaredComplete: report.complete && !normalized.truncated,
        truncated: normalized.truncated,
        ...(report.uncertainty ? { uncertainty: report.uncertainty } : {}),
      });
      try {
        await options.publish(result);
      } catch (error) {
        options.logError(`Failed to publish file-change report ${state.requestId}: ${error}`);
      }

      return {
        content: [
          {
            type: "text",
            text: `<${FILE_CHANGE_AUDIT_MARKER}>File-change audit recorded.</${FILE_CHANGE_AUDIT_MARKER}>`,
          },
        ],
        structuredContent: result,
      };
    },
  };

  // canUseTool is not guaranteed to run for tools that the current permission
  // mode auto-allows (notably bypassPermissions). A PreToolUse hook is the
  // enforcement boundary that keeps the hidden continuation read-only in every
  // mode: it can submit the report, but cannot inspect or mutate more files.
  const preToolUseHook: HookCallback = async (input) => {
    if (input.hook_event_name !== "PreToolUse") return {};
    const state = options.getActiveState();
    const isReportTool = isFileChangeAuditTool(input.tool_name);
    if (!isReportTool && !isFileChangeAuditReportPhase(state)) return {};

    const allowReport = state?.phase === "collecting" && isReportTool;
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: allowReport ? "allow" : "deny",
        ...(!allowReport
          ? {
              permissionDecisionReason:
                "Only the internal file-change report is allowed during the audit.",
            }
          : {}),
      },
    };
  };

  const stopHook: HookCallback = async (input) => {
    if (input.hook_event_name !== "Stop") return {};
    const state = options.getActiveState();
    if (!state || state.phase === "finished") return {};
    // A Stop can be only a pause while a background generator is still
    // running. Keep the request pending so a later final Stop can include its
    // writes instead of declaring a prematurely complete path set.
    if (state.phase === "requested" && (input.background_tasks?.length ?? 0) > 0) return {};
    if (state.phase === "collecting" || input.stop_hook_active) {
      await finishUnavailable(state, "notReported");
      return {};
    }

    // Set the phase before returning the continuation so every following SDK
    // message is hidden even if the next stream starts immediately.
    state.phase = "collecting";
    return {
      hookSpecificOutput: {
        hookEventName: "Stop",
        additionalContext:
          `<${FILE_CHANGE_AUDIT_MARKER}>` +
          `Before stopping, call ${FILE_CHANGE_AUDIT_WIRE_TOOL_NAME} exactly once. ` +
          "Report every workspace file changed during this user turn, including files changed " +
          "by commands, generators, version-control operations, and child processes. " +
          "Do not call any other tool and do not emit user-facing prose. " +
          "Set complete to false and explain uncertainty when you are not sure the list is complete." +
          `</${FILE_CHANGE_AUDIT_MARKER}>`,
      },
    };
  };

  return {
    mcpServer: createSdkMcpServer({
      name: FILE_CHANGE_AUDIT_SERVER_NAME,
      version: "1.0.0",
      tools: [tool],
      alwaysLoad: true,
    }),
    preToolUseHook,
    stopHook,
    finishUnavailable,
  };
}

function normalizeWorkspace(
  cwd: string,
  additionalDirectories: string[],
): FileChangeAuditWorkspace {
  const normalizedCwd = path.resolve(cwd);
  const seen = new Set([pathKey(normalizedCwd)]);
  const normalizedAdditionalDirectories: string[] = [];
  for (const directory of additionalDirectories) {
    const normalized = path.resolve(normalizedCwd, directory);
    const key = pathKey(normalized);
    if (seen.has(key)) continue;
    seen.add(key);
    normalizedAdditionalDirectories.push(normalized);
  }
  return {
    cwd: normalizedCwd,
    additionalDirectories: normalizedAdditionalDirectories,
  };
}

function normalizeReportedPaths(
  reportedPaths: string[],
  workspace: FileChangeAuditWorkspace,
): { paths: string[]; truncated: boolean } {
  const roots = [workspace.cwd, ...workspace.additionalDirectories];
  const seen = new Set<string>();
  const result: string[] = [];
  let totalBytes = 0;
  let truncated = false;
  for (const reportedPath of reportedPaths) {
    if (
      reportedPath.trim().length === 0 ||
      reportedPath.length > MAX_REPORTED_PATH_LENGTH ||
      hasControlCharacter(reportedPath)
    ) {
      truncated = true;
      continue;
    }
    let normalized: string;
    try {
      normalized = path.resolve(workspace.cwd, reportedPath);
    } catch {
      truncated = true;
      continue;
    }
    if (normalized.length > MAX_REPORTED_PATH_LENGTH || hasControlCharacter(normalized)) {
      truncated = true;
      continue;
    }
    if (!roots.some((root) => isWithinRoot(normalized, root))) {
      truncated = true;
      continue;
    }
    const key = pathKey(normalized);
    if (roots.some((root) => pathKey(root) === key)) {
      truncated = true;
      continue;
    }
    if (seen.has(key)) {
      continue;
    }
    const pathBytes = Buffer.byteLength(normalized, "utf8");
    if (
      result.length >= MAX_REPORTED_PATHS ||
      totalBytes + pathBytes > AGENT_FILE_CHANGE_REPORT_MAX_BYTES
    ) {
      truncated = true;
      continue;
    }
    seen.add(key);
    result.push(normalized);
    totalBytes += pathBytes;
  }
  return { paths: result, truncated };
}

/** Keep the complete serialized report within AIR's wire limit. */
function fitReportedAgentFileChangeReport(
  report: Extract<AgentFileChangeReportResult, { status: "reported" }>,
): Extract<AgentFileChangeReportResult, { status: "reported" }> {
  const paths = [...report.paths];
  let fitted = report;
  while (Buffer.byteLength(JSON.stringify(fitted), "utf8") > AGENT_FILE_CHANGE_REPORT_MAX_BYTES) {
    if (paths.length === 0) {
      // The fixed fields and bounded uncertainty are far below the cap. Keep
      // this loud if the wire contract changes without updating this helper.
      throw new Error("Agent file-change report exceeds the wire limit without paths");
    }
    paths.pop();
    fitted = {
      ...report,
      paths: [...paths],
      declaredComplete: false,
      truncated: true,
    };
  }
  return fitted;
}

function isWithinRoot(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return !path.isAbsolute(relative) && !relative.startsWith(`..${path.sep}`) && relative !== "..";
}

function pathKey(value: string): string {
  return process.platform === "win32" ? value.toLowerCase() : value;
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}
