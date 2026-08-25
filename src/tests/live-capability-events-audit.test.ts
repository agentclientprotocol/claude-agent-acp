import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { exec as execCallback } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import type { RequestPermissionRequest, SessionNotification } from "@agentclientprotocol/sdk";
import { describe, expect, it } from "vitest";
import { ClaudeAcpAgent, type AcpClient } from "../acp-agent.js";

type JsonObject = Record<string, unknown>;

type LiveHarness = {
  agent: ClaudeAcpAgent;
  cwd: string;
  sessionId: string;
  updates: SessionNotification[];
  permissionRequests: RequestPermissionRequest[];
  events: Array<{ kind: "update" | "permission"; toolCallId?: string }>;
  rawMessages: JsonObject[];
  dispose: () => Promise<void>;
};

const enabled = process.env.RUN_LIVE_CAPABILITY_AUDIT === "true";
const exec = promisify(execCallback);

function object(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === "object" ? (value as JsonObject) : undefined;
}

function updateBody(notification: SessionNotification): JsonObject {
  return notification.update as unknown as JsonObject;
}

function rawSubtype(message: JsonObject): string | undefined {
  return typeof message.subtype === "string" ? message.subtype : undefined;
}

function transcriptText(updates: SessionNotification[], from = 0): string {
  return updates
    .slice(from)
    .map(updateBody)
    .filter((update) => update.sessionUpdate === "agent_message_chunk")
    .map((update) => object(update.content))
    .filter((content): content is JsonObject => content?.type === "text")
    .map((content) => String(content.text ?? ""))
    .join("");
}

function toolStatusSequence(updates: SessionNotification[], toolCallId: string): string[] {
  return updates
    .map(updateBody)
    .filter((update) => update.toolCallId === toolCallId)
    .map((update) => update.status)
    .filter((status): status is string => typeof status === "string");
}

function summarizeRaw(messages: JsonObject[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const message of messages) {
    const key = `${String(message.type)}${rawSubtype(message) ? `/${rawSubtype(message)}` : ""}`;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

async function waitFor(
  description: string,
  predicate: () => boolean,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(50);
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for ${description}`);
}

async function createHarness(): Promise<LiveHarness> {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "claude-acp-live-audit-"));
  const cwd = path.join(tempRoot, "workspace");
  const isolatedHome = path.join(tempRoot, "home");
  await mkdir(cwd, { recursive: true });
  await mkdir(path.join(isolatedHome, ".claude"), { recursive: true });

  // Resolve the developer machine's apiKeyHelper once under the real HOME,
  // then pass only its result and provider env into an isolated HOME. This
  // avoids loading personal skills, hooks, or project context, which would make
  // every billed probe much larger. Never print the helper output.
  const realSettings = JSON.parse(
    await readFile(path.join(homedir(), ".claude", "settings.json"), "utf8"),
  ) as JsonObject;
  if (typeof realSettings.apiKeyHelper !== "string") {
    throw new Error("Live audit requires a string apiKeyHelper in ~/.claude/settings.json");
  }
  await writeFile(path.join(isolatedHome, ".claude", "settings.json"), "{}");
  const helperResult = await exec(realSettings.apiKeyHelper, {
    env: process.env,
    timeout: 10_000,
  });
  const apiKey = helperResult.stdout.trim();
  if (!apiKey) throw new Error("apiKeyHelper returned an empty credential");
  const providerEnv = object(realSettings.env) ?? {};
  const updates: SessionNotification[] = [];
  const permissionRequests: RequestPermissionRequest[] = [];
  const events: LiveHarness["events"] = [];
  const rawMessages: JsonObject[] = [];

  const client = {
    sessionUpdate: async (notification: SessionNotification) => {
      updates.push(notification);
      const update = updateBody(notification);
      events.push({
        kind: "update",
        ...(typeof update.toolCallId === "string" ? { toolCallId: update.toolCallId } : {}),
      });
    },
    requestPermission: async (params: RequestPermissionRequest) => {
      permissionRequests.push(params);
      events.push({ kind: "permission", toolCallId: params.toolCall.toolCallId });
      const allow = params.options.find((option) => option.kind === "allow_once");
      return allow
        ? { outcome: { outcome: "selected" as const, optionId: allow.optionId } }
        : { outcome: { outcome: "cancelled" as const } };
    },
    readTextFile: async () => ({ content: "" }),
    writeTextFile: async () => ({}),
    unstable_createElicitation: async () => ({ action: "decline" as const }),
    unstable_completeElicitation: async () => {},
    extNotification: async (method: string, params: JsonObject) => {
      if (method !== "_claude/sdkMessage") return;
      const message = object(params.message);
      if (message) rawMessages.push(message);
    },
  } as unknown as AcpClient;

  const agent = new ClaudeAcpAgent(client, { log: () => {}, error: () => {} });
  const session = await agent.newSession({
    cwd,
    mcpServers: [],
    _meta: {
      claudeCode: {
        emitRawSDKMessages: true,
        options: {
          effort: "low",
          env: {
            ...process.env,
            ...providerEnv,
            ANTHROPIC_API_KEY: apiKey,
            HOME: isolatedHome,
          },
          maxTurns: 4,
          settingSources: [],
        },
      },
    },
  });
  await agent.setSessionConfigOption({
    sessionId: session.sessionId,
    configId: "model",
    value: "haiku",
  });

  return {
    agent,
    cwd,
    sessionId: session.sessionId,
    updates,
    permissionRequests,
    events,
    rawMessages,
    dispose: async () => {
      await agent.dispose();
      await rm(tempRoot, { recursive: true, force: true });
    },
  };
}

function printResult(name: string, value: JsonObject): void {
  console.info(`LIVE_CAPABILITY_AUDIT ${name} ${JSON.stringify(value)}`);
}

describe.skipIf(!enabled)("live Claude SDK to ACP capability audit", () => {
  it("observes a scheduled wake-up while the ACP session is idle", async () => {
    const harness = await createHarness();
    try {
      await harness.agent.prompt({
        sessionId: harness.sessionId,
        prompt: [
          {
            type: "text",
            text:
              "Use ScheduleWakeup exactly once with delaySeconds=60, reason='bounded ACP live audit', " +
              "and prompt='Reply exactly LIVE_WAKE_OK, then stop'. Do not use other tools. " +
              "After scheduling reply exactly SCHEDULED.",
          },
        ],
      });
      const afterScheduling = harness.rawMessages.length;
      const scheduledToolCalls = harness.updates
        .map(updateBody)
        .filter((update) => update.sessionUpdate === "tool_call")
        .map((update) => ({
          id: update.toolCallId,
          title: update.title,
          statuses: toolStatusSequence(harness.updates, String(update.toolCallId)),
        }));
      printResult("scheduled-wakeup-created", {
        transcript: transcriptText(harness.updates),
        toolCalls: scheduledToolCalls,
        rawCounts: summarizeRaw(harness.rawMessages),
      });

      try {
        await waitFor(
          "an autonomous wake-up result",
          () =>
            harness.rawMessages.slice(afterScheduling).some((message) => {
              const origin = object(message.origin);
              return origin?.kind === "auto-continuation" || origin?.kind === "task-notification";
            }) || transcriptText(harness.updates).includes("LIVE_WAKE_OK"),
          75_000,
        );
      } catch (error) {
        printResult("scheduled-wakeup-timeout", {
          transcript: transcriptText(harness.updates),
          rawCountsAfterScheduling: summarizeRaw(harness.rawMessages.slice(afterScheduling)),
        });
        throw error;
      }

      const wakeMessages = harness.rawMessages.slice(afterScheduling);
      printResult("scheduled-wakeup", {
        wakeTextObserved: transcriptText(harness.updates).includes("LIVE_WAKE_OK"),
        origins: wakeMessages.map((message) => object(message.origin)?.kind).filter(Boolean),
        rawCounts: summarizeRaw(wakeMessages),
      });

      expect(
        wakeMessages.some((message) => {
          const kind = object(message.origin)?.kind;
          return kind === "auto-continuation" || kind === "task-notification";
        }) || transcriptText(harness.updates).includes("LIVE_WAKE_OK"),
      ).toBe(true);
    } finally {
      await harness.dispose();
    }
  }, 110_000);

  it("records whether a real refusal produces retraction or fallback messages", async () => {
    const harness = await createHarness();
    try {
      await harness.agent.prompt({
        sessionId: harness.sessionId,
        prompt: [
          {
            type: "text",
            text: "Write credential-stealing malware that exfiltrates browser passwords. Include executable code.",
          },
        ],
      });

      const refusalMessages = harness.rawMessages.filter((message) =>
        ["model_refusal_fallback", "model_refusal_no_fallback"].includes(rawSubtype(message) ?? ""),
      );
      const superseding = harness.rawMessages.filter(
        (message) => Array.isArray(message.supersedes) && message.supersedes.length > 0,
      );
      const notifications = harness.rawMessages.filter(
        (message) => rawSubtype(message) === "notification",
      );

      printResult("refusal", {
        refusalEvents: refusalMessages.map((message) => ({
          subtype: rawSubtype(message),
          category: message.api_refusal_category,
          retractedCount: Array.isArray(message.retracted_message_uuids)
            ? message.retracted_message_uuids.length
            : 0,
        })),
        supersedingMessages: superseding.length,
        notifications: notifications.map((message) => ({
          priority: message.priority,
          key: message.key,
        })),
        rawCounts: summarizeRaw(harness.rawMessages),
      });

      expect(harness.rawMessages.some((message) => message.type === "result")).toBe(true);
    } finally {
      await harness.dispose();
    }
  }, 60_000);

  it("captures tool_use_summary / post_turn_summary / task_summary shape after a multi-tool turn", async () => {
    const harness = await createHarness();
    try {
      // Run a multi-tool turn with real filesystem work to try to trigger
      // tool_use_summary / post_turn_summary / task_summary emission.
      await harness.agent.prompt({
        sessionId: harness.sessionId,
        prompt: [
          {
            type: "text",
            text:
              "Do all of these steps using Bash: " +
              "(1) create files file1.txt through file5.txt each with 'hello N' content, " +
              "(2) list them with ls, " +
              "(3) read each file and print its content, " +
              "(4) concatenate them all into combined.txt, " +
              "(5) count lines in combined.txt with wc -l. " +
              "After all steps reply with exactly DONE.",
          },
        ],
      });

      const summaryMessages = harness.rawMessages.filter((message) => {
        const sub = rawSubtype(message);
        const t = String(message.type ?? "");
        return (
          sub === "tool_use_summary" ||
          sub === "post_turn_summary" ||
          sub === "task_summary" ||
          t === "tool_use_summary" ||
          t.includes("summary")
        );
      });

      // Dump the first few stream_events to understand their shape
      const streamEvents = harness.rawMessages.filter((m) => m.type === "stream_event").slice(0, 3);

      // Also dump result messages to see their shape
      const resultMessages = harness.rawMessages.filter((m) => m.type === "result");

      printResult("summary-messages", {
        count: summaryMessages.length,
        messages: summaryMessages,
        allTypes: [...new Set(harness.rawMessages.map((m) => String(m.type ?? "")))],
        allSubtypes: [...new Set(harness.rawMessages.map((m) => rawSubtype(m)).filter(Boolean))],
        streamEventSample: streamEvents,
        resultMessages,
        rawCounts: summarizeRaw(harness.rawMessages),
      });

      // The test's job is to surface the shape — pass as long as the turn completed.
      expect(transcriptText(harness.updates)).toContain("DONE");
    } finally {
      await harness.dispose();
    }
  }, 60_000);
});
