import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  AGENT_FILE_CHANGE_REPORT_MAX_BYTES,
  agentFileChangeReportRequestId,
  createNativeFileChangeReporter,
  type AgentFileChangeReportResult,
  type NativeFileChangeReporter,
} from "../file-change-audit.js";

function createSupport(options: {
  cwd?: string;
  additionalDirectories?: string[];
  publish?: (result: AgentFileChangeReportResult) => Promise<void>;
  logError?: (message: string) => void;
  timeoutMs?: number;
}) {
  return createNativeFileChangeReporter({
    cwd: options.cwd ?? process.cwd(),
    additionalDirectories: options.additionalDirectories ?? [],
    publish: options.publish ?? (async () => {}),
    logError: options.logError ?? (() => {}),
    timeoutMs: options.timeoutMs,
  });
}

function requestedTurn(reporter: NativeFileChangeReporter, requestId: string) {
  const fileChangeReport = reporter.request({
    jetbrains: {
      air: {
        agentFileChangeReportRequest: { version: 1, requestId },
      },
    },
  });
  expect(fileChangeReport).toBeDefined();
  return { promptUuid: "prompt-uuid", fileChangeReport };
}

describe("native agent file-change report", () => {
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

  it("owns request-id deduplication for the session", () => {
    const reporter = createSupport({});
    const turn = requestedTurn(reporter, "request-deduplicated");

    expect(turn.fileChangeReport?.requestId).toBe("request-deduplicated");
    expect(
      reporter.request({
        jetbrains: {
          air: {
            agentFileChangeReportRequest: {
              version: 1,
              requestId: "request-deduplicated",
            },
          },
        },
      }),
    ).toBeUndefined();
  });

  it("uses Claude checkpoint dry-run and normalizes its paths", async () => {
    const cwd = path.join(os.tmpdir(), "native-file-report-project");
    const additionalRoot = path.join(os.tmpdir(), "native-file-report-shared");
    const canonicalTempRoot = fs.realpathSync.native(os.tmpdir());
    const published: AgentFileChangeReportResult[] = [];
    const support = createSupport({
      cwd,
      additionalDirectories: [additionalRoot],
      publish: async (result) => void published.push(result),
    });
    const turn = requestedTurn(support, "request-1");
    const rewindFiles = vi.fn(async () => ({
      canRewind: true,
      filesChanged: ["src/a.ts", "src/a.ts", path.join(additionalRoot, "generated.ts")],
      insertions: 12,
      deletions: 3,
    }));

    await support.report(turn, { rewindFiles });

    expect(rewindFiles).toHaveBeenCalledWith("prompt-uuid", { dryRun: true });
    expect(published).toEqual([
      {
        version: 1,
        requestId: "request-1",
        status: "reported",
        paths: [
          path.join(canonicalTempRoot, "native-file-report-project", "src/a.ts"),
          path.join(canonicalTempRoot, "native-file-report-shared", "generated.ts"),
        ],
        declaredComplete: false,
        truncated: false,
      },
    ]);
    expect(turn.fileChangeReport?.phase).toBe("finished");
  });

  it("publishes unavailable when Claude cannot preview the checkpoint", async () => {
    const published: AgentFileChangeReportResult[] = [];
    const support = createSupport({ publish: async (result) => void published.push(result) });
    const turn = requestedTurn(support, "request-invalid");

    await support.report(turn, {
      rewindFiles: vi.fn(async () => ({ canRewind: false, error: "checkpoint missing" })),
    });

    expect(published).toEqual([
      {
        version: 1,
        requestId: "request-invalid",
        status: "unavailable",
        reason: "invalidOutput",
      },
    ]);
  });

  it("times out fail-open and publishes only one terminal", async () => {
    const published: AgentFileChangeReportResult[] = [];
    const support = createSupport({
      publish: async (result) => void published.push(result),
      timeoutMs: 1,
    });
    const turn = requestedTurn(support, "request-timeout");
    const never = new Promise<never>(() => {});

    await support.report(turn, { rewindFiles: vi.fn(() => never) });
    support.finish(turn.fileChangeReport, "cancelled");

    expect(published).toEqual([
      {
        version: 1,
        requestId: "request-timeout",
        status: "unavailable",
        reason: "timeout",
      },
    ]);
  });

  it("lets cancellation win a race with a late checkpoint response", async () => {
    const published: AgentFileChangeReportResult[] = [];
    const support = createSupport({ publish: async (result) => void published.push(result) });
    const turn = requestedTurn(support, "request-race");
    let resolvePreview!: (value: { canRewind: true; filesChanged: string[] }) => void;
    const preview = new Promise<{ canRewind: true; filesChanged: string[] }>((resolve) => {
      resolvePreview = resolve;
    });
    const reporting = support.report(turn, { rewindFiles: vi.fn(() => preview) });

    support.finish(turn.fileChangeReport, "cancelled");
    resolvePreview({ canRewind: true, filesChanged: ["src/late.ts"] });
    await reporting;

    expect(published).toEqual([
      {
        version: 1,
        requestId: "request-race",
        status: "unavailable",
        reason: "cancelled",
      },
    ]);
  });

  it("caps path count and serialized report bytes", async () => {
    const cwd = path.join(os.tmpdir(), "native-file-report-caps");
    const reports: AgentFileChangeReportResult[] = [];
    const support = createSupport({
      cwd,
      publish: async (result) => void reports.push(result),
    });
    const turn = requestedTurn(support, "request-caps");

    await support.report(turn, {
      rewindFiles: vi.fn(async () => ({
        canRewind: true,
        filesChanged: Array.from(
          { length: 1030 },
          (_, index) => `generated/${index}-${"x".repeat(280)}.txt`,
        ),
      })),
    });

    expect(reports[0]).toMatchObject({
      status: "reported",
      declaredComplete: false,
      truncated: true,
    });
    expect(Buffer.byteLength(JSON.stringify(reports[0]), "utf8")).toBeLessThanOrEqual(
      AGENT_FILE_CHANGE_REPORT_MAX_BYTES,
    );
  });

  it("fails open when report publication fails", async () => {
    const logError = vi.fn();
    const support = createSupport({
      publish: async () => {
        throw new Error("transport closed");
      },
      logError,
    });
    const turn = requestedTurn(support, "request-publish-failure");

    await expect(
      support.report(turn, {
        rewindFiles: vi.fn(async () => ({ canRewind: true, filesChanged: [] })),
      }),
    ).resolves.toBeUndefined();

    expect(turn.fileChangeReport?.phase).toBe("finished");
    expect(logError).toHaveBeenCalledWith(expect.stringContaining("transport closed"));
  });
});
