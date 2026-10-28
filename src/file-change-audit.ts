import type { Query, RewindFilesResult } from "@anthropic-ai/claude-agent-sdk";
import * as fs from "node:fs";
import * as path from "node:path";
import { airExtensionMeta, clientSupportsAirCapability, withAirMeta } from "./air-extension.js";

export const AGENT_FILE_CHANGE_REPORT_CAPABILITY = "agentFileChangeReport";

const MAX_REPORTED_PATHS = 1024;
const MAX_REPORTED_PATH_LENGTH = 4096;
export const AGENT_FILE_CHANGE_REPORT_MAX_BYTES = 256 * 1024;
export const AGENT_FILE_CHANGE_REPORT_TIMEOUT_MS = 2_000;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

export type FileChangeReportTurnState = {
  requestId: string;
  phase: "requested" | "collecting" | "finished";
};

export type NativeFileChangeReportTurn = {
  promptUuid: string;
  fileChangeReport?: FileChangeReportTurnState;
  /** Raw `file_path`/`notebook_path` values of the file-tool edits that
   *  subagents of this turn completed. Checkpoints do not track files that
   *  only a subagent edited. */
  editedPaths?: Set<string>;
};

export type FileChangeReportWorkspace = {
  cwd: string;
  additionalDirectories: string[];
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
    }
  | {
      status: "unavailable";
      reason: FileChangeReportUnavailableReason;
    }
);

export type FileChangeReportUnavailableReason =
  "cancelled" | "timeout" | "invalidOutput" | "notReported" | "providerError";

type NativeFileChangeReporterOptions = {
  cwd: string;
  additionalDirectories: string[];
  publish: (result: AgentFileChangeReportResult) => Promise<void>;
  logError: (message: string) => void;
  timeoutMs?: number;
};

export type NativeFileChangeReporter = {
  request(meta: unknown): FileChangeReportTurnState | undefined;
  report(
    turn: NativeFileChangeReportTurn | null | undefined,
    query: Pick<Query, "rewindFiles">,
  ): Promise<void>;
  finish(
    state: FileChangeReportTurnState | undefined,
    reason: FileChangeReportUnavailableReason,
  ): void;
};

export function agentFileChangeReportRequestId(meta: unknown): string | undefined {
  const air = airExtensionMeta(meta);
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
  return clientSupportsAirCapability(capabilities, AGENT_FILE_CHANGE_REPORT_CAPABILITY);
}

export function agentFileChangeReportMeta(
  result: AgentFileChangeReportResult,
): Record<string, unknown> {
  return withAirMeta(undefined, AGENT_FILE_CHANGE_REPORT_CAPABILITY, result);
}

const FILE_EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

/**
 * Adds to `turn.editedPaths` the `file_path` (`notebook_path` for NotebookEdit)
 * of each successful file-tool edit among the tool results of a subagent
 * message. Root-agent messages (`parentToolUseId === null`) are skipped: the
 * checkpoint already tracks their files. Must run before `toAcpNotifications`
 * drops the tool use cache entries.
 */
export function recordSubagentFileEdits(
  turn: (NativeFileChangeReportTurn & { settled: boolean }) | null | undefined,
  parentToolUseId: string | null,
  content: unknown,
  toolUses: Record<string, { name: string; input: unknown } | undefined>,
): void {
  if (parentToolUseId === null || !turn || turn.settled || !turn.fileChangeReport) return;
  if (!Array.isArray(content)) return;
  for (const block of content) {
    if (
      block?.type !== "tool_result" ||
      block.is_error === true ||
      typeof block.tool_use_id !== "string"
    ) {
      continue;
    }
    const toolUse = toolUses[block.tool_use_id];
    if (!toolUse || !FILE_EDIT_TOOLS.has(toolUse.name)) continue;
    const input = toolUse.input as Record<string, unknown> | undefined;
    const editedPath = toolUse.name === "NotebookEdit" ? input?.notebook_path : input?.file_path;
    if (typeof editedPath === "string" && editedPath.length > 0) {
      (turn.editedPaths ??= new Set()).add(editedPath);
    }
  }
}

export function createNativeFileChangeReporter(
  options: NativeFileChangeReporterOptions,
): NativeFileChangeReporter {
  const workspace = normalizeWorkspace(options.cwd, options.additionalDirectories);
  const timeoutMs = options.timeoutMs ?? AGENT_FILE_CHANGE_REPORT_TIMEOUT_MS;
  const requestIds = new Set<string>();

  async function publish(state: FileChangeReportTurnState, result: AgentFileChangeReportResult) {
    if (state.phase === "finished") return;
    state.phase = "finished";
    try {
      await options.publish(result);
    } catch (error) {
      options.logError(`Failed to publish file-change report ${state.requestId}: ${error}`);
    }
  }

  async function finishUnavailable(
    state: FileChangeReportTurnState,
    reason: FileChangeReportUnavailableReason,
  ) {
    await publish(state, {
      version: 1,
      requestId: state.requestId,
      status: "unavailable",
      reason,
    });
  }

  async function publishReported(state: FileChangeReportTurnState, reportedPaths: string[]) {
    const normalized = normalizeReportedPaths(reportedPaths, workspace);
    await publish(
      state,
      fitReportedAgentFileChangeReport({
        version: 1,
        requestId: state.requestId,
        status: "reported",
        paths: normalized.paths,
        // Checkpoints miss Bash mutations. Subagent file-tool edits are added
        // from the message stream, but the list is still not exhaustive.
        declaredComplete: false,
        truncated: normalized.truncated,
      }),
    );
  }

  // Used when the checkpoint preview fails: the subagent edits seen in the
  // stream are still worth reporting.
  async function finishWithoutPreview(
    state: FileChangeReportTurnState,
    editedPaths: Set<string> | undefined,
    reason: FileChangeReportUnavailableReason,
  ) {
    if (editedPaths && editedPaths.size > 0) {
      await publishReported(state, [...editedPaths]);
    } else {
      await finishUnavailable(state, reason);
    }
  }

  async function report(
    turn: NativeFileChangeReportTurn | null | undefined,
    query: Pick<Query, "rewindFiles">,
  ) {
    const state = turn?.fileChangeReport;
    if (!state || state.phase !== "requested") return;
    state.phase = "collecting";

    let timer: ReturnType<typeof setTimeout> | undefined;
    const previewPromise = query.rewindFiles(turn.promptUuid, { dryRun: true });
    // A timed-out control request may still settle later. Observe it so a late
    // rejection cannot become unhandled, but never let it publish a second terminal.
    void previewPromise.catch(() => {});
    try {
      const preview = await Promise.race<RewindFilesResult | null>([
        previewPromise,
        new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), timeoutMs);
          timer.unref?.();
        }),
      ]);
      if (preview === null) {
        await finishWithoutPreview(state, turn.editedPaths, "timeout");
        return;
      }
      if (!preview.canRewind || !Array.isArray(preview.filesChanged)) {
        await finishWithoutPreview(state, turn.editedPaths, "invalidOutput");
        return;
      }

      await publishReported(state, [...preview.filesChanged, ...(turn.editedPaths ?? [])]);
    } catch (error) {
      options.logError(`Failed to inspect Claude file checkpoint ${turn.promptUuid}: ${error}`);
      await finishWithoutPreview(state, turn.editedPaths, "providerError");
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  return {
    request(meta) {
      const requestId = agentFileChangeReportRequestId(meta);
      if (!requestId || requestIds.has(requestId)) return undefined;
      requestIds.add(requestId);
      return { requestId, phase: "requested" };
    },
    report,
    finish(state, reason) {
      if (!state) return;
      void finishUnavailable(state, reason);
    },
  };
}

function normalizeWorkspace(
  cwd: string,
  additionalDirectories: string[],
): FileChangeReportWorkspace {
  const normalizedCwd = canonicalizeWorkspaceRoot(path.resolve(cwd));
  const seen = new Set([pathKey(normalizedCwd)]);
  const normalizedAdditionalDirectories: string[] = [];
  for (const directory of additionalDirectories) {
    const normalized = canonicalizeWorkspaceRoot(path.resolve(normalizedCwd, directory));
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
  workspace: FileChangeReportWorkspace,
): { paths: string[]; truncated: boolean } {
  const roots = [workspace.cwd, ...workspace.additionalDirectories];
  const seen = new Set<string>();
  const result: string[] = [];
  let totalBytes = 0;
  let truncated = false;
  for (const reportedPath of reportedPaths) {
    if (
      typeof reportedPath !== "string" ||
      reportedPath.trim().length === 0 ||
      reportedPath.length > MAX_REPORTED_PATH_LENGTH ||
      hasControlCharacter(reportedPath)
    ) {
      truncated = true;
      continue;
    }
    let normalized: string;
    try {
      normalized = canonicalizeReportedPath(path.resolve(workspace.cwd, reportedPath));
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
    if (seen.has(key)) continue;
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

function fitReportedAgentFileChangeReport(
  report: Extract<AgentFileChangeReportResult, { status: "reported" }>,
): Extract<AgentFileChangeReportResult, { status: "reported" }> {
  const paths = [...report.paths];
  let fitted = report;
  while (Buffer.byteLength(JSON.stringify(fitted), "utf8") > AGENT_FILE_CHANGE_REPORT_MAX_BYTES) {
    if (paths.length === 0) {
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

function canonicalizeWorkspaceRoot(value: string): string {
  return canonicalizeFromExistingAncestor(value);
}

function canonicalizeReportedPath(value: string): string {
  const parent = canonicalizeFromExistingAncestor(path.dirname(value));
  return path.resolve(parent, path.basename(value));
}

function canonicalizeFromExistingAncestor(value: string): string {
  const original = path.resolve(value);
  let current = original;
  const missingSegments: string[] = [];
  while (true) {
    try {
      const canonical = fs.realpathSync.native(current);
      return path.resolve(canonical, ...missingSegments.reverse());
    } catch (error) {
      if (!isMissingPathError(error)) return original;
    }
    const parent = path.dirname(current);
    if (parent === current) return original;
    missingSegments.push(path.basename(current));
    current = parent;
  }
}

function isMissingPathError(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) return false;
  return error.code === "ENOENT" || error.code === "ENOTDIR";
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
