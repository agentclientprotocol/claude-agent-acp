import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { describe, expect, it } from "vitest";

type Json = Record<string, any>;

// Opt in explicitly: this test launches the built adapter and bills real model calls.
const enabled = process.env.RUN_LIVE_RESUMED_SUBAGENT === "true";
const forms = (process.env.LIVE_SUBAGENT_FORMS ?? "rfd").split(",");
const receiptMode = process.env.LIVE_SUBAGENT_RECEIPT ?? "inline";
const outputRoot = path.resolve(
  process.env.LIVE_SUBAGENT_OUTPUT ?? "tmp/resumed-subagent-fix-20261024/live",
);

class StdioClient {
  readonly received: Array<{ turn: number; message: Json }> = [];
  readonly approvals: Json[] = [];
  turn = 0;
  private nextId = 0;
  private pending = new Map<
    number,
    { resolve: (value: Json) => void; reject: (error: Error) => void }
  >();

  constructor(
    readonly child: ChildProcessWithoutNullStreams,
    readonly directory: string,
    private readonly secrets: string[],
  ) {
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      let message: Json;
      try {
        message = JSON.parse(line);
      } catch {
        this.fail(new Error("Adapter wrote non-JSON data to stdout"));
        return;
      }
      this.log("in", message);
      this.received.push({ turn: this.turn, message });
      if (message.method === "session/request_permission") {
        const option = message.params.options.find((entry: Json) => entry.kind === "allow_once");
        this.approvals.push({ turn: this.turn, request: message.params, option });
        this.send({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            outcome: option
              ? { outcome: "selected", optionId: option.optionId }
              : { outcome: "cancelled" },
          },
        });
      } else if (message.method && message.id !== undefined) {
        this.send({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32601, message: "Unsupported client request" },
        });
      } else if (message.id !== undefined) {
        const request = this.pending.get(message.id);
        if (!request) return;
        this.pending.delete(message.id);
        if (message.error) request.reject(new Error(JSON.stringify(message.error)));
        else request.resolve(message.result);
      }
    });
    child.stderr.on("data", (data: Buffer) => {
      appendFileSync(path.join(directory, "stderr.log"), this.redact(data.toString()));
    });
    child.on("error", (error) => this.fail(error));
    child.on("exit", (code, signal) => this.fail(new Error(`Adapter exited: ${code}/${signal}`)));
  }

  private redact(value: string): string {
    for (const secret of this.secrets) if (secret) value = value.split(secret).join("[REDACTED]");
    return value;
  }

  private log(direction: string, message: Json): void {
    appendFileSync(
      path.join(this.directory, "wire.jsonl"),
      this.redact(
        JSON.stringify({ at: new Date().toISOString(), direction, turn: this.turn, message }),
      ) + "\n",
    );
  }

  private send(message: Json): void {
    this.log("out", message);
    this.child.stdin.write(JSON.stringify(message) + "\n");
  }

  private fail(error: Error): void {
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
  }

  async request(method: string, params: Json, timeoutMs = 240_000): Promise<Json> {
    const id = ++this.nextId;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await new Promise<Json>((resolve, reject) => {
        this.pending.set(id, { resolve, reject });
        timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new Error(`${method} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        this.send({ jsonrpc: "2.0", id, method, params });
      });
    } finally {
      clearTimeout(timer);
    }
  }

  async close(): Promise<void> {
    this.child.stdin.end();
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    const exited = once(this.child, "exit");
    const timeout = setTimeout(() => this.child.kill(), 10_000);
    try {
      await exited;
    } finally {
      clearTimeout(timeout);
    }
  }
}

function updates(client: StdioClient, turn: number): Json[] {
  return client.received
    .filter((entry) => entry.turn === turn && entry.message.method === "session/update")
    .map((entry) => entry.message.params);
}

function raw(client: StdioClient, turn: number): Json[] {
  return client.received
    .filter((entry) => entry.turn === turn && entry.message.method === "_claude/sdkMessage")
    .map((entry) => entry.message.params.message);
}

function bashCalls(traffic: Json[]): Json[] {
  return traffic.filter(
    (entry) =>
      entry.update.sessionUpdate === "tool_call" &&
      entry.update._meta?.claudeCode?.toolName === "Bash",
  );
}

describe.skipIf(!enabled)("real ACP resumed subagent tool lifecycle", () => {
  for (const form of forms) {
    it(`delivers first and resumed successful/failed tools with approvals (${form}, ${receiptMode})`, async () => {
      expect(["rfd", "plain", "air"]).toContain(form);
      expect(["inline", "legacy"]).toContain(receiptMode);
      const directory = path.join(outputRoot, `${form}-${receiptMode}-${Date.now()}`);
      const cwd = path.join(directory, "workspace");
      const isolatedHome = path.join(directory, "home");
      mkdirSync(cwd, { recursive: true });
      mkdirSync(path.join(isolatedHome, ".claude"), { recursive: true });
      writeFileSync(path.join(isolatedHome, ".claude", "settings.json"), "{}");
      const settings = JSON.parse(
        readFileSync(path.join(homedir(), ".claude", "settings.json"), "utf8"),
      );
      const provider = settings.env ?? {};
      const model = process.env.LIVE_SUBAGENT_MODEL ?? provider.ANTHROPIC_MODEL ?? settings.model;
      const env = {
        ...process.env,
        ...provider,
        HOME: isolatedHome,
        USERPROFILE: isolatedHome,
        CLAUDE_CONFIG_DIR: path.join(isolatedHome, ".claude"),
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
        // The SDK blocks foreground-only resumes and returns inlineHandback/pin.id.
        // This changes only the test session's scheduling, never permission mode.
        ...(receiptMode === "inline" ? { CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1" } : {}),
      };
      delete env.CLAUDECODE;
      if (env.CLAUDE_CODE_EXECUTABLE === "/usr/bin/false") delete env.CLAUDE_CODE_EXECUTABLE;
      const secrets = Object.entries(env)
        .filter(([key]) => /token|api.?key|password|secret/i.test(key))
        .map(([, value]) => String(value ?? ""));
      const child = spawn(process.execPath, [path.resolve("dist/index.js")], {
        cwd,
        env,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
      const client = new StdioClient(child, directory, secrets);
      console.log(`Live ACP evidence: ${directory}`);
      try {
        const capabilities =
          form === "air"
            ? {
                _meta: {
                  jetbrains: { air: { version: 1, capabilities: ["nativeSubagentSessions"] } },
                },
              }
            : form === "rfd"
              ? { subagents: {} }
              : {};
        await client.request(
          "initialize",
          { protocolVersion: 1, clientCapabilities: capabilities },
          30_000,
        );
        const session = await client.request("session/new", {
          cwd,
          mcpServers: [],
          _meta: {
            claudeCode: {
              emitRawSDKMessages: true,
              options: {
                model,
                effort: "low",
                maxTurns: 12,
                settingSources: [],
                tools: ["Agent", "SendMessage", "Bash"],
                agents: {
                  "event-probe": {
                    description:
                      "Run exactly the requested local test commands and return their output.",
                    prompt:
                      "You are a test worker. Use Bash for each exact command given. Do not delegate. A deliberately nonzero command is expected: report it without retrying or fixing it.",
                    tools: ["Bash"],
                    model: "inherit",
                  },
                },
              },
            },
          },
        });
        const firstCommand = `node -e "require('fs').writeFileSync('first.txt','FIRST'); console.log('FIRST')"`;
        client.turn = 1;
        const first = await client.request("session/prompt", {
          sessionId: session.sessionId,
          prompt: [
            {
              type: "text",
              text: `Use the Agent tool exactly once with subagent_type event-probe, name receipt-worker, run_in_background false. Ask it to run this exact Bash command and report the result: ${firstCommand}. Do not run Bash yourself. Wait for its result and include its agent ID in your short response.`,
            },
          ],
        });
        const firstRaw = raw(client, 1);
        const launched = firstRaw.find(
          (entry) =>
            entry.type === "system" && entry.subtype === "task_started" && entry.subagent_type,
        );
        const agentResult = firstRaw.find(
          (entry) => entry.type === "user" && typeof entry.tool_use_result?.agentId === "string",
        );
        const agentId = launched?.task_id ?? agentResult?.tool_use_result.agentId;
        expect(typeof agentId, "SDK must identify the one launched child").toBe("string");
        const successCommand = `node -e "require('fs').writeFileSync('resumed.txt','RESUMED'); console.log('RESUMED')"`;
        const failureCommand = `node -e "console.error('EXPECTED_FAILURE'); process.exit(7)"`;
        client.turn = 2;
        const second = await client.request("session/prompt", {
          sessionId: session.sessionId,
          prompt: [
            {
              type: "text",
              text: `Continue the SAME finished agent ${agentId} using SendMessage to ${agentId}. Do not use Agent again and do not run Bash yourself. Tell it to run these two exact commands as separate Bash calls in order: 1) ${successCommand} 2) ${failureCommand}. The second is deliberately expected to fail: report the failure once, do not retry. Wait for its reply.`,
            },
          ],
        });
        const firstUpdates = updates(client, 1);
        const resumedUpdates = updates(client, 2);
        const resumedRaw = raw(client, 2);
        const receipts = resumedRaw
          .filter((entry) => entry.type === "user" && entry.tool_use_result?.success !== undefined)
          .map((entry) => entry.tool_use_result);
        const summary: Json = {
          form,
          receiptMode,
          model,
          rootSessionId: session.sessionId,
          agentId,
          first,
          second,
          receipts,
          rawTypes: resumedRaw.map((entry) => `${entry.type}/${entry.subtype ?? ""}`),
          firstTools: bashCalls(firstUpdates),
          resumedTools: bashCalls(resumedUpdates),
          resumedToolEvents: resumedUpdates.filter((entry) =>
            ["tool_call", "tool_call_update"].includes(entry.update.sessionUpdate),
          ),
          approvals: client.approvals,
        };
        writeFileSync(path.join(directory, "summary.json"), JSON.stringify(summary, null, 2));
        console.log(
          JSON.stringify({
            form,
            agentId,
            firstTools: summary.firstTools.length,
            resumedTools: summary.resumedTools.length,
            receiptKeys: receipts.map((entry) => Object.keys(entry)),
            approvals: client.approvals.length,
          }),
        );
        expect(first.stopReason).toBe("end_turn");
        expect(second.stopReason).toBe("end_turn");
        if (receiptMode === "inline") {
          expect(
            receipts.some(
              (receipt) =>
                receipt.success === true &&
                receipt.resumedAgentId === undefined &&
                receipt.inlineHandback !== null &&
                typeof receipt.inlineHandback === "object" &&
                receipt.pin?.id === agentId &&
                typeof receipt.message === "string" &&
                receipt.message.startsWith("Resumed agent."),
            ),
            "real SDK must exercise the new inline-handback format",
          ).toBe(true);
        } else {
          expect(
            receipts.some(
              (receipt) => receipt.success === true && receipt.resumedAgentId === agentId,
            ),
          ).toBe(true);
        }
        expect(readFileSync(path.join(cwd, "first.txt"), "utf8")).toBe("FIRST");
        expect(readFileSync(path.join(cwd, "resumed.txt"), "utf8")).toBe("RESUMED");
        expect(bashCalls(firstUpdates).length).toBeGreaterThanOrEqual(1);
        expect(bashCalls(resumedUpdates)).toHaveLength(2);
        for (const firstCall of bashCalls(firstUpdates)) {
          const firstEvents = firstUpdates.filter(
            (entry) => entry.update.toolCallId === firstCall.update.toolCallId,
          );
          expect(firstCall.sessionId).toBe(form === "plain" ? session.sessionId : agentId);
          expect(firstEvents[0].update.sessionUpdate).toBe("tool_call");
          expect(firstEvents.at(-1)?.update.status).toBe("completed");
          expect(firstEvents.every((entry) => entry.sessionId === firstCall.sessionId)).toBe(true);
        }
        const starts = bashCalls(resumedUpdates);
        const expectedSession =
          form === "plain"
            ? session.sessionId
            : form === "rfd"
              ? agentId
              : `${agentId}:generation:2`;
        for (const [index, call] of starts.entries()) {
          expect(call.sessionId).toBe(expectedSession);
          const events = resumedUpdates.filter(
            (entry) => entry.update.toolCallId === call.update.toolCallId,
          );
          expect(events[0].update.sessionUpdate).toBe("tool_call");
          expect(events.at(-1)?.update.status).toBe(index === 0 ? "completed" : "failed");
          expect(events.every((entry) => entry.sessionId === expectedSession)).toBe(true);
        }
        expect(
          client.approvals.some((entry) => entry.turn === 2 && entry.option?.kind === "allow_once"),
        ).toBe(true);
        const launches = resumedRaw
          .flatMap((entry) =>
            entry.type === "assistant" && entry.parent_tool_use_id === null
              ? (entry.message?.content ?? [])
              : [],
          )
          .filter((entry: Json) => entry.type === "tool_use" && entry.name === "Agent");
        expect(launches, "turn 2 must continue the same child, not replace it").toHaveLength(0);
      } finally {
        await client.close();
      }
    }, 600_000);
  }
});
