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

function rawSessionId(message: JsonObject): string | undefined {
  return typeof message.session_id === "string" ? message.session_id : undefined;
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
  it("forwards a background subagent permission request in default mode", async () => {
    const harness = await createHarness();
    try {
      const response = await harness.agent.prompt({
        sessionId: harness.sessionId,
        prompt: [
          {
            type: "text",
            text:
              "Use the Agent tool exactly once with run_in_background=true. Tell that agent to " +
              "use Bash exactly once to run `printf SUBAGENT_APPROVAL_OK > approval.txt`, then stop. " +
              "After launching it, reply exactly LAUNCHED and do not use any other tool.",
          },
        ],
      });

      const subagentRequest = harness.permissionRequests.find((request) => {
        const meta = object(request.toolCall._meta)?.claudeCode;
        return object(meta)?.parentToolUseId !== undefined;
      });
      const toolCallId = subagentRequest?.toolCall.toolCallId;
      const matchingToolCall = harness.updates
        .map(updateBody)
        .find((update) => update.sessionUpdate === "tool_call" && update.toolCallId === toolCallId);
      const announcementIndex = harness.events.findIndex(
        (event) => event.kind === "update" && event.toolCallId === toolCallId,
      );
      const permissionIndex = harness.events.findIndex(
        (event) => event.kind === "permission" && event.toolCallId === toolCallId,
      );

      printResult("subagent-permission", {
        stopReason: response.stopReason,
        permissionCount: harness.permissionRequests.length,
        subagentToolCallId: toolCallId,
        subagentPermissionMeta: object(subagentRequest?.toolCall._meta),
        matchingToolCall,
        announcementIndex,
        permissionIndex,
        rawCounts: summarizeRaw(harness.rawMessages),
      });

      expect(
        subagentRequest,
        "the background subagent must reach the ACP permission callback",
      ).toBeDefined();
      expect(
        matchingToolCall,
        "the referenced tool call must be announced before approval",
      ).toBeDefined();
      expect(announcementIndex).toBeGreaterThanOrEqual(0);
      expect(permissionIndex).toBeGreaterThan(announcementIndex);
    } finally {
      await harness.dispose();
    }
  }, 120_000);

  it("keeps ACP routing stable across a real /clear and follow-up", async () => {
    const harness = await createHarness();
    try {
      console.info("LIVE_CAPABILITY_AUDIT reset stage=before-first-prompt");
      await harness.agent.prompt({
        sessionId: harness.sessionId,
        prompt: [{ type: "text", text: "Reply with exactly BEFORE." }],
      });
      console.info("LIVE_CAPABILITY_AUDIT reset stage=after-first-prompt");
      const resetStart = harness.rawMessages.length;
      await harness.agent.prompt({
        sessionId: harness.sessionId,
        prompt: [{ type: "text", text: "/clear" }],
      });
      console.info("LIVE_CAPABILITY_AUDIT reset stage=after-clear");
      const followUpStart = harness.updates.length;
      await harness.agent.prompt({
        sessionId: harness.sessionId,
        prompt: [{ type: "text", text: "Reply with exactly AFTER." }],
      });
      console.info("LIVE_CAPABILITY_AUDIT reset stage=after-follow-up");

      const resetMessages = harness.rawMessages.slice(resetStart);
      const resetIndex = resetMessages.findIndex(
        (message) => message.type === "conversation_reset",
      );
      const reset = resetIndex >= 0 ? resetMessages[resetIndex] : undefined;
      const providerIdsAfterReset = [
        ...new Set(
          resetMessages
            .slice(resetIndex + 1)
            .map(rawSessionId)
            .filter(Boolean),
        ),
      ];
      const routedIds = [...new Set(harness.updates.map((update) => update.sessionId))];

      printResult("reset", {
        newConversationId: reset?.new_conversation_id,
        providerIdsAfterReset,
        routedIds,
        rawCounts: summarizeRaw(resetMessages),
      });

      expect(reset, "the real SDK must emit conversation_reset for /clear").toBeDefined();
      expect(routedIds).toEqual([harness.sessionId]);
      expect(transcriptText(harness.updates, followUpStart)).toContain("AFTER");
    } finally {
      await harness.dispose();
    }
  }, 120_000);

  it("captures the real background Bash launch and terminal task lifecycle", async () => {
    const harness = await createHarness();
    try {
      await harness.agent.prompt({
        sessionId: harness.sessionId,
        prompt: [
          {
            type: "text",
            text:
              "Use the Bash tool exactly once with command `sleep 2; printf LIVE_BACKGROUND_OK` " +
              "and run_in_background=true. Do not use any other tool. After launch reply exactly LAUNCHED.",
          },
        ],
      });

      await waitFor(
        "a terminal task_updated or task_notification",
        () =>
          harness.rawMessages.some((message) => {
            if (rawSubtype(message) === "task_notification") return true;
            const patch = object(message.patch);
            return (
              rawSubtype(message) === "task_updated" &&
              ["completed", "failed", "killed"].includes(String(patch?.status))
            );
          }),
        15_000,
      );

      const toolCall = harness.updates
        .map(updateBody)
        .find(
          (update) =>
            update.sessionUpdate === "tool_call" && object(update._meta)?.claudeCode !== undefined,
        );
      const toolCallId = String(toolCall?.toolCallId ?? "");
      const rawTaskEvents = harness.rawMessages.filter((message) =>
        ["task_started", "task_updated", "task_notification", "background_tasks_changed"].includes(
          rawSubtype(message) ?? "",
        ),
      );

      printResult("background-bash", {
        toolCallId,
        acpStatuses: toolCallId ? toolStatusSequence(harness.updates, toolCallId) : [],
        taskEvents: rawTaskEvents.map((message) => ({
          subtype: rawSubtype(message),
          taskId: message.task_id,
          patch: message.patch,
        })),
        rawCounts: summarizeRaw(harness.rawMessages),
      });

      expect(toolCallId).not.toBe("");
      expect(rawTaskEvents.some((message) => rawSubtype(message) === "task_started")).toBe(true);
      expect(
        rawTaskEvents.some((message) =>
          ["task_updated", "task_notification"].includes(rawSubtype(message) ?? ""),
        ),
      ).toBe(true);
    } finally {
      await harness.dispose();
    }
  }, 45_000);

  it("settles every announced tool call when a real Bash turn is cancelled", async () => {
    const harness = await createHarness();
    try {
      const prompt = harness.agent.prompt({
        sessionId: harness.sessionId,
        prompt: [
          {
            type: "text",
            text:
              "Use the Bash tool exactly once to run `sleep 20`. Do not run it in the background " +
              "and do not use any other tool.",
          },
        ],
      });

      await waitFor(
        "the Bash tool_call",
        () => harness.updates.some((update) => updateBody(update).sessionUpdate === "tool_call"),
        20_000,
      );
      await harness.agent.cancel({ sessionId: harness.sessionId });
      const response = await prompt;
      await delay(500);

      const toolCallIds = [
        ...new Set(
          harness.updates
            .map(updateBody)
            .filter((update) => update.sessionUpdate === "tool_call")
            .map((update) => String(update.toolCallId)),
        ),
      ];
      const statuses = Object.fromEntries(
        toolCallIds.map((id) => [id, toolStatusSequence(harness.updates, id)]),
      );

      printResult("cancel", {
        stopReason: response.stopReason,
        statuses,
        rawCounts: summarizeRaw(harness.rawMessages),
      });

      expect(response.stopReason).toBe("cancelled");
      expect(toolCallIds.length).toBeGreaterThan(0);
      for (const id of toolCallIds) {
        expect(
          statuses[id].some((status) => ["completed", "failed"].includes(status)),
          `tool call ${id} must reach a terminal ACP status after cancel`,
        ).toBe(true);
      }
    } finally {
      await harness.dispose();
    }
  }, 45_000);
});
