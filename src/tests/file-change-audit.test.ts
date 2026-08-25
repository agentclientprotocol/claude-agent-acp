import type { HookCallback } from "@anthropic-ai/claude-agent-sdk";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  AGENT_FILE_CHANGE_REPORT_MAX_BYTES,
  agentFileChangeReportRequestId,
  createFileChangeAuditSupport,
  createFileChangeAuditTurnState,
  FILE_CHANGE_AUDIT_TOOL_NAME,
  FILE_CHANGE_AUDIT_WIRE_TOOL_NAME,
  type AgentFileChangeReport,
  type AgentFileChangeReportResult,
  type FileChangeAuditTurnState,
} from "../file-change-audit.js";

type RegisteredAuditTool = {
  _meta?: Record<string, unknown>;
  handler: (report: AgentFileChangeReport) => Promise<{
    isError?: boolean;
    structuredContent?: AgentFileChangeReportResult;
  }>;
};

function auditToolHandler(
  support: ReturnType<typeof createFileChangeAuditSupport>,
): RegisteredAuditTool {
  const server = support.mcpServer as unknown as {
    instance: { _registeredTools: Record<string, RegisteredAuditTool> };
  };
  return server.instance._registeredTools[FILE_CHANGE_AUDIT_TOOL_NAME];
}

function stopInput(stopHookActive = false): Parameters<HookCallback>[0] {
  return {
    hook_event_name: "Stop",
    stop_hook_active: stopHookActive,
  } as Parameters<HookCallback>[0];
}

function createSupport(options: {
  state: FileChangeAuditTurnState;
  cwd?: string;
  additionalDirectories?: string[];
  publish?: (result: AgentFileChangeReportResult) => Promise<void>;
  logError?: (message: string) => void;
}) {
  return createFileChangeAuditSupport({
    cwd: options.cwd ?? process.cwd(),
    additionalDirectories: options.additionalDirectories ?? [],
    getActiveState: () => options.state,
    publish: options.publish ?? (async () => {}),
    logError: options.logError ?? (() => {}),
  });
}

describe("agent file-change audit", () => {
  it("accepts only the versioned prompt request shape", () => {
    expect(
      agentFileChangeReportRequestId({
        jetbrains: {
          air: {
            agentFileChangeReportRequest: { version: 1, requestId: "turn:42_a-b.c" },
          },
        },
      }),
    ).toBe("turn:42_a-b.c");

    for (const request of [
      { version: 2, requestId: "turn-42" },
      { version: 1, requestId: "contains spaces" },
      { version: 1, requestId: "x".repeat(129) },
      { version: 1 },
      { version: 1, requestId: "turn-42", extra: true },
      null,
    ]) {
      expect(
        agentFileChangeReportRequestId({
          jetbrains: { air: { agentFileChangeReportRequest: request } },
        }),
      ).toBeUndefined();
    }
  });

  it("continues Stop at most once and reports a missing tool call once", async () => {
    const state = createFileChangeAuditTurnState("request-1");
    const publish = vi.fn(async (_result: AgentFileChangeReportResult) => {});
    const support = createSupport({ state, publish });
    const hookOptions = { signal: new AbortController().signal };
    const preToolInput = (toolName: string) =>
      ({
        hook_event_name: "PreToolUse",
        tool_name: toolName,
        tool_input: {},
        tool_use_id: "tool-1",
      }) as Parameters<HookCallback>[0];

    await expect(
      support.preToolUseHook(preToolInput(FILE_CHANGE_AUDIT_WIRE_TOOL_NAME), "tool-1", hookOptions),
    ).resolves.toMatchObject({
      hookSpecificOutput: { permissionDecision: "deny" },
    });

    const pausedStop = {
      ...stopInput(),
      background_tasks: [{ id: "generator", type: "shell", status: "running", description: "" }],
    } as Parameters<HookCallback>[0];
    expect(await support.stopHook(pausedStop, undefined, hookOptions)).toEqual({});
    expect(state.phase).toBe("requested");

    const first = await support.stopHook(stopInput(), undefined, hookOptions);
    expect(state.phase).toBe("collecting");
    expect(first).toMatchObject({
      hookSpecificOutput: {
        hookEventName: "Stop",
        additionalContext: expect.stringContaining(FILE_CHANGE_AUDIT_WIRE_TOOL_NAME),
      },
    });

    await expect(
      support.preToolUseHook(preToolInput("Bash"), "tool-1", hookOptions),
    ).resolves.toMatchObject({
      hookSpecificOutput: { permissionDecision: "deny" },
    });
    await expect(
      support.preToolUseHook(preToolInput(FILE_CHANGE_AUDIT_WIRE_TOOL_NAME), "tool-1", hookOptions),
    ).resolves.toMatchObject({
      hookSpecificOutput: { permissionDecision: "allow" },
    });

    expect(await support.stopHook(stopInput(true), undefined, hookOptions)).toEqual({});
    expect(state.phase).toBe("finished");
    expect(publish).toHaveBeenCalledWith({
      version: 1,
      requestId: "request-1",
      status: "unavailable",
      reason: "notReported",
    });

    await support.stopHook(stopInput(true), undefined, hookOptions);
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it("publishes only the first unavailable terminal and rejects a late report", async () => {
    const state = createFileChangeAuditTurnState("request-terminal-race");
    state.phase = "collecting";
    const publish = vi.fn(async (_result: AgentFileChangeReportResult) => {});
    const support = createSupport({ state, publish });

    await Promise.all([
      support.finishUnavailable(state, "cancelled"),
      support.finishUnavailable(state, "providerError"),
    ]);

    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledWith({
      version: 1,
      requestId: "request-terminal-race",
      status: "unavailable",
      reason: "cancelled",
    });
    await expect(
      auditToolHandler(support).handler({ paths: ["src/late.ts"], complete: true }),
    ).resolves.toMatchObject({ isError: true });
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it("normalizes roots, drops invalid paths, and deduplicates without truncation", async () => {
    const cwd = path.join(os.tmpdir(), "file-audit-project");
    const additionalRoot = path.join(os.tmpdir(), "file-audit-shared");
    const canonicalTempRoot = fs.realpathSync.native(os.tmpdir());
    const canonicalCwd = path.join(canonicalTempRoot, "file-audit-project");
    const canonicalAdditionalRoot = path.join(canonicalTempRoot, "file-audit-shared");
    const outside = path.join(os.tmpdir(), "file-audit-outside", "outside.txt");
    const state = createFileChangeAuditTurnState("request-2");
    state.phase = "collecting";
    const published: AgentFileChangeReportResult[] = [];
    const support = createSupport({
      state,
      cwd,
      additionalDirectories: [additionalRoot],
      publish: async (result) => void published.push(result),
    });
    const tool = auditToolHandler(support);

    expect(tool._meta).toMatchObject({
      "anthropic/alwaysLoad": true,
      "claude/endTurn": true,
    });
    const result = await tool.handler({
      paths: [
        "src/a.ts",
        "src/a.ts",
        cwd,
        additionalRoot,
        path.join(additionalRoot, "generated.ts"),
        outside,
        "bad\u0000path",
        "bad\u0085path",
        "x".repeat(4090),
      ],
      complete: true,
      uncertainty: "Generated files may be missing",
    });

    expect(result.isError).not.toBe(true);
    expect(published).toEqual([
      {
        version: 1,
        requestId: "request-2",
        status: "reported",
        paths: [
          path.join(canonicalCwd, "src/a.ts"),
          path.join(canonicalAdditionalRoot, "generated.ts"),
        ],
        declaredComplete: false,
        truncated: true,
        uncertainty: "Generated files may be missing",
      },
    ]);

    expect(await tool.handler({ paths: ["src/late.ts"], complete: true })).toMatchObject({
      isError: true,
    });
    expect(published).toHaveLength(1);

    const duplicateOnlyState = createFileChangeAuditTurnState("request-3");
    duplicateOnlyState.phase = "collecting";
    const duplicateOnlyReports: AgentFileChangeReportResult[] = [];
    const duplicateOnlyTool = auditToolHandler(
      createSupport({
        state: duplicateOnlyState,
        cwd,
        publish: async (report) => void duplicateOnlyReports.push(report),
      }),
    );
    await duplicateOnlyTool.handler({ paths: ["src/a.ts", "src/a.ts"], complete: true });
    expect(duplicateOnlyReports[0]).toMatchObject({
      declaredComplete: true,
      truncated: false,
      paths: [path.join(canonicalCwd, "src/a.ts")],
    });
  });

  it("accepts canonical paths under a symlinked workspace root", async () => {
    if (process.platform === "win32") return;

    const realRoot = fs.mkdtempSync(path.join(os.tmpdir(), "file-audit-real-"));
    const linkedRoot = `${realRoot}-link`;
    fs.symlinkSync(realRoot, linkedRoot, "dir");
    try {
      const state = createFileChangeAuditTurnState("request-symlink-root");
      state.phase = "collecting";
      const reports: AgentFileChangeReportResult[] = [];
      const tool = auditToolHandler(
        createSupport({
          state,
          cwd: linkedRoot,
          publish: async (report) => void reports.push(report),
        }),
      );
      const canonicalPath = path.join(fs.realpathSync.native(realRoot), "generated.ts");

      await tool.handler({
        paths: [canonicalPath, path.join(linkedRoot, "generated.ts")],
        complete: true,
      });

      expect(reports[0]).toMatchObject({
        paths: [canonicalPath],
        declaredComplete: true,
        truncated: false,
      });
    } finally {
      fs.unlinkSync(linkedRoot);
      fs.rmSync(realRoot, { recursive: true, force: true });
    }
  });

  it("caps path count and total UTF-8 bytes", async () => {
    const cwd = path.join(os.tmpdir(), "file-audit-caps");

    const countState = createFileChangeAuditTurnState("request-count");
    countState.phase = "collecting";
    const countReports: AgentFileChangeReportResult[] = [];
    await auditToolHandler(
      createSupport({
        state: countState,
        cwd,
        publish: async (report) => void countReports.push(report),
      }),
    ).handler({
      paths: Array.from({ length: 1030 }, (_, index) => `src/file-${index}.ts`),
      complete: true,
    });
    expect(countReports[0]).toMatchObject({
      declaredComplete: false,
      truncated: true,
    });
    expect(countReports[0].status).toBe("reported");
    if (countReports[0].status !== "reported") throw new Error("Expected a reported result");
    expect(countReports[0].paths).toHaveLength(1024);

    const byteState = createFileChangeAuditTurnState("request-bytes");
    byteState.phase = "collecting";
    const byteReports: AgentFileChangeReportResult[] = [];
    await auditToolHandler(
      createSupport({
        state: byteState,
        cwd,
        publish: async (report) => void byteReports.push(report),
      }),
    ).handler({
      paths: Array.from(
        { length: 1000 },
        (_, index) => `generated/${index}-${"x".repeat(280)}.txt`,
      ),
      complete: true,
    });
    expect(byteReports[0]).toMatchObject({
      declaredComplete: false,
      truncated: true,
    });
    expect(byteReports[0].status).toBe("reported");
    if (byteReports[0].status !== "reported") throw new Error("Expected a reported result");
    expect(byteReports[0].paths.length).toBeLessThan(1000);
    expect(Buffer.byteLength(JSON.stringify(byteReports[0]), "utf8")).toBeLessThanOrEqual(
      AGENT_FILE_CHANGE_REPORT_MAX_BYTES,
    );
  });

  it("fails open when report publication fails", async () => {
    const state = createFileChangeAuditTurnState("request-4");
    state.phase = "collecting";
    const logError = vi.fn();
    const tool = auditToolHandler(
      createSupport({
        state,
        publish: async () => {
          throw new Error("transport closed");
        },
        logError,
      }),
    );

    await expect(tool.handler({ paths: ["src/a.ts"], complete: true })).resolves.toMatchObject({
      structuredContent: { requestId: "request-4", status: "reported" },
    });
    expect(state.phase).toBe("finished");
    expect(logError).toHaveBeenCalledWith(expect.stringContaining("transport closed"));

    const unavailableState = createFileChangeAuditTurnState("request-unavailable-failure");
    const unavailableSupport = createSupport({
      state: unavailableState,
      publish: async () => {
        throw new Error("transport closed");
      },
      logError,
    });
    await expect(
      unavailableSupport.finishUnavailable(unavailableState, "providerError"),
    ).resolves.toBeUndefined();
    expect(unavailableState.phase).toBe("finished");
    expect(logError).toHaveBeenCalledWith(expect.stringContaining("request-unavailable-failure"));
  });
});
