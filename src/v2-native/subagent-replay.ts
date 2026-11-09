/**
 * The replay of a session's subagents, for `session/resume` with
 * `replayFrom`, as the bridge replays them (`RfdSubagentReplay`).
 *
 * Claude Code keeps each subagent's history in its own transcript, and its
 * metadata file names the Agent or Task call that launched it (see
 * `subagentHistory`). The replay announces each child right after that call,
 * under its live session id (the agent id), with no capabilities: it cannot
 * run again in this process. Then it sends the child's `model` (of its first
 * response) and its history to the child session. As live, the parent is not
 * shown the launch call: its prompt is the parent's outgoing message, and a
 * foreground child's answer its reply.
 *
 * Every child's end goes out on its parent at the end of the replay, and once
 * on the child's own stream: v2 forbids replaying a child's past `running` as
 * current activity. These states are history to the client, so each child's
 * current state goes out again after the response ({@link afterResponse}).
 * A child that the live session still tracks, on a resume of the active
 * session, gets its current state from the resume snapshot instead
 * (`SessionTasks.currentState`).
 *
 * Not replayed: SendMessage deliveries and hand-backs, which stay tool calls
 * and user text, and a model change after a child's first response. A launch
 * without metadata stays an ordinary tool call of its parent.
 */
import * as fs from "node:fs";
import type * as v2 from "@agentclientprotocol/sdk/experimental/v2/unstable";
import type { SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import type { Logger } from "../acp-agent.js";
import type { AcpSessionNotification } from "../acp-subagents.js";
import {
  childModelOption,
  launchReply,
  linkedSessionMessages,
  nativeSubagentState,
  responseModelEntry,
  rfdEndState,
  rfdLabels,
  type SubagentModels,
  type WorkState,
} from "../native-subagents.js";
import {
  readSubagentMessages,
  subagentHistory,
  subagentLaunchIds,
  type SubagentHistory,
  type SubagentRecord,
} from "../subagent-history.js";
import { firstResponseModel, replaySubagentTerminalState } from "../subagent-replay.js";
import type { V2UpdateTranslator } from "../v2/update-translator.js";
import { SessionOutput, type ReplayHooks } from "./stream.js";
import { sameDirectory } from "./tasks.js";

/** What the replay needs of its root session. */
export interface ReplayHost {
  readonly sessionId: string;
  readonly cwd: string;
  readonly logger: Logger;
  readonly translator: V2UpdateTranslator;
  /** Sends an update of the root session or one of its children. */
  send(notification: v2.UpdateSessionNotification): void;
  models(): SubagentModels;
}

type ReplayChild = {
  launchId: string;
  sessionId: string;
  record: SubagentRecord;
  parentSessionId: string;
  input: Record<string, unknown>;
  /** How the launch's tool result ended a foreground child's run. */
  launchEnd?: "completed" | "failed" | "cancelled";
  announced: boolean;
  promptSent: boolean;
  /** The `cwd` it was announced with, when not its parent's. */
  cwd?: string;
  output?: SessionOutput;
};

export class SubagentReplay {
  /** The children, by the id of the call that launched each. */
  private readonly children = new Map<string, ReplayChild>();
  private rootOutput: SessionOutput | undefined;

  private constructor(
    private readonly host: ReplayHost,
    private readonly history: SubagentHistory,
    /** The transcript of each child, by agent id. */
    private readonly transcripts: Map<string, SessionMessage[]>,
    /** Whether the live session tracks the child session `sessionId`. */
    private readonly live: (sessionId: string) => boolean,
  ) {}

  /**
   * Reads the subagent history that `messages`, the session's transcript,
   * launched, with every child's transcript. Undefined when it launched none.
   */
  static async load(
    host: ReplayHost,
    messages: SessionMessage[],
    live: (sessionId: string) => boolean = () => false,
  ): Promise<SubagentReplay | undefined> {
    if (!messages.some((message) => launchIdsOf(message).length > 0)) return undefined;
    const history = await subagentHistory(host.sessionId);
    const transcripts = new Map<string, SessionMessage[]>();
    const queue = messages.flatMap(launchIdsOf);
    while (queue.length > 0) {
      const record = history.agents.get(queue.shift()!);
      if (!record || transcripts.has(record.agentId)) continue;
      const transcript = (
        await readSubagentMessages(host.sessionId, record.agentId, history, host.logger)
      ).map((message) => ({ ...message, parent_tool_use_id: null }));
      transcripts.set(record.agentId, transcript);
      queue.push(...transcript.flatMap(launchIdsOf));
    }
    return new SubagentReplay(host, history, transcripts, live);
  }

  /** The hooks of the replay of the root session's history (`messages`). */
  hooks(output: SessionOutput, messages: SessionMessage[]): ReplayHooks {
    this.rootOutput = output;
    this.scan(messages, output.sessionId);
    return this.ownerHooks(output, undefined);
  }

  /** Ends the replay: every child's end, on its parent, then once on its own stream. */
  finish(): void {
    const announced = [...this.children.values()].filter((child) => child.announced);
    for (const child of [...announced].reverse()) {
      this.host.send({
        sessionId: child.parentSessionId,
        update: {
          sessionUpdate: "subagent_update",
          sessionId: child.sessionId,
          state: endState(child) as v2.StateUpdate,
        },
      });
    }
    for (const child of announced) {
      this.host.send({
        sessionId: child.sessionId,
        update: { sessionUpdate: "state_update", ...endState(child) } as v2.SessionUpdate,
      });
    }
  }

  /**
   * The current state of each replayed child that the live session does not
   * track, after the response: its process is gone, so its replayed end. A
   * `cwd` that is gone, such as a worktree that Claude Code removed, is
   * cleared.
   */
  afterResponse(): void {
    for (const child of this.children.values()) {
      if (!child.announced || this.live(child.sessionId)) continue;
      const state = endState(child);
      this.host.send({
        sessionId: child.parentSessionId,
        update: {
          sessionUpdate: "subagent_update",
          sessionId: child.sessionId,
          ...(child.cwd && !isDirectory(child.cwd) ? { cwd: null } : {}),
          state: state as v2.StateUpdate,
        },
      });
      this.host.send({
        sessionId: child.sessionId,
        update: { sessionUpdate: "state_update", ...state } as v2.SessionUpdate,
      });
    }
  }

  private ownerHooks(output: SessionOutput, owner: ReplayChild | undefined): ReplayHooks {
    return {
      route: (notification) => this.route(notification),
      replayed: (message) => this.replayed(message, output),
      ...(owner ? { userContent: (_message, content) => this.childContent(owner, content) } : {}),
    };
  }

  /** Registers the launches in `messages`, of the session `ownerSessionId`, and their results. */
  private scan(messages: readonly SessionMessage[], ownerSessionId: string): void {
    for (const message of messages) {
      for (const block of contentBlocks(message)) {
        if (block.type === "tool_use" && typeof block.id === "string") {
          const record = this.history.agents.get(block.id);
          if (!record || this.children.has(block.id)) continue;
          this.children.set(block.id, {
            launchId: block.id,
            sessionId: record.agentId,
            record,
            parentSessionId: ownerSessionId,
            input: (typeof block.input === "object" && block.input !== null
              ? block.input
              : {}) as Record<string, unknown>,
            announced: false,
            promptSent: false,
          });
        } else if (block.type === "tool_result" && typeof block.tool_use_id === "string") {
          const child = this.children.get(block.tool_use_id);
          // A background launch answers at once; its result is not the end.
          if (child && !child.record.background)
            child.launchEnd = replaySubagentTerminalState(block);
        }
      }
    }
  }

  /** The launch call of a replayed child is not shown; a foreground one's answer is its reply. */
  private route(notification: AcpSessionNotification): AcpSessionNotification[] {
    const { update } = notification;
    if (update.sessionUpdate !== "tool_call" && update.sessionUpdate !== "tool_call_update") {
      return [notification];
    }
    const child = this.children.get(update.toolCallId);
    if (!child) return [notification];
    if (update.status === "completed" && child.announced && !child.record.background) {
      const reply = launchReply(child.launchId, child.sessionId, child.parentSessionId, update);
      if (reply) return [reply];
    }
    return [];
  }

  /** After a message that launched children: each is announced, and its history replays. */
  private replayed(message: SessionMessage, parent: SessionOutput): void {
    if (message.type !== "assistant") return;
    for (const launchId of launchIdsOf(message)) {
      const child = this.children.get(launchId);
      if (!child || child.announced) continue;
      const messages = this.transcripts.get(child.sessionId) ?? [];
      this.announce(child, firstResponseModel(messages));
      this.scan(messages, child.sessionId);
      child.output!.replay(messages, this.ownerHooks(child.output!, child));
      if (!child.promptSent && typeof child.input.prompt === "string") {
        this.sendPrompt(child, parent, child.input.prompt);
      }
    }
  }

  private announce(child: ReplayChild, model: string | undefined): void {
    const labels = rfdLabels(
      child.record.name ?? child.input.name,
      child.record.agentType ?? child.input.subagent_type,
      child.record.description ?? child.input.description,
    );
    const parentCwd = this.cwdOf(child.parentSessionId);
    child.cwd =
      child.record.cwd && !sameDirectory(child.record.cwd, parentCwd)
        ? child.record.cwd
        : undefined;
    child.announced = true;
    this.host.send({
      sessionId: child.parentSessionId,
      update: {
        sessionUpdate: "subagent_update",
        sessionId: child.sessionId,
        ...(labels.title ? { title: labels.title } : {}),
        ...(labels.description ? { description: labels.description } : {}),
        ...(child.cwd ? { cwd: child.cwd } : {}),
        state: { state: "running" },
      },
    });
    child.output = new SessionOutput(
      child.sessionId,
      child.cwd ?? parentCwd,
      this.host.translator,
      (update) => this.host.send({ sessionId: child.sessionId, update }),
      this.host.logger,
      true,
    );
    const entry = responseModelEntry(model, this.host.models());
    if (entry) {
      child.output.emitV1([
        {
          sessionId: child.sessionId,
          update: {
            sessionUpdate: "config_option_update",
            configOptions: [childModelOption(entry)],
          },
        },
      ]);
    }
  }

  /**
   * The rest of a child's user message, after its first text went out as
   * the launch's prompt. Its other text is Claude Code's, such as "[Request
   * interrupted by user]", which the live child session does not show.
   */
  private childContent(child: ReplayChild, content: unknown): unknown {
    const text = textOf(content);
    if (text.trim() && !child.promptSent) {
      const parent = this.outputOf(child.parentSessionId);
      if (parent) this.sendPrompt(child, parent, text);
    }
    if (!Array.isArray(content)) return null;
    const rest = content.filter(
      (block) => !(typeof block === "object" && block !== null && block.type === "text"),
    );
    return rest.length > 0 ? rest : null;
  }

  private sendPrompt(child: ReplayChild, parent: SessionOutput, text: string): void {
    child.promptSent = true;
    const [outgoing, incoming] = linkedSessionMessages(
      child.launchId,
      child.parentSessionId,
      child.sessionId,
      text,
    );
    parent.emitV1([outgoing!]);
    child.output!.emitV1([incoming!]);
  }

  private outputOf(sessionId: string): SessionOutput | undefined {
    if (sessionId === this.host.sessionId) return this.rootOutput;
    return [...this.children.values()].find((child) => child.sessionId === sessionId)?.output;
  }

  private cwdOf(sessionId: string): string {
    const child = [...this.children.values()].find((c) => c.sessionId === sessionId);
    if (!child) return this.host.cwd;
    return child.cwd ?? this.cwdOf(child.parentSessionId);
  }
}

/** How a replayed child's work ended: a stop by the user, else its foreground launch's result. */
function endState(child: ReplayChild): WorkState {
  const end = child.record.stoppedByUser ? "cancelled" : child.launchEnd;
  const state = end ? nativeSubagentState(end) : undefined;
  return state ? rfdEndState(state, undefined) : { state: "idle" };
}

function launchIdsOf(message: SessionMessage): string[] {
  if (message.type !== "assistant") return [];
  return subagentLaunchIds((message.message as { content?: unknown } | undefined)?.content);
}

function contentBlocks(message: SessionMessage): Record<string, unknown>[] {
  const content = (message as { message?: { content?: unknown } }).message?.content;
  return Array.isArray(content)
    ? content.filter(
        (block): block is Record<string, unknown> => typeof block === "object" && block !== null,
      )
    : [];
}

/** The text of user message content: a string, or its text blocks. */
function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((block) =>
      typeof block === "object" && block !== null && block.type === "text" ? [block.text] : [],
    )
    .filter((text): text is string => typeof text === "string")
    .join("\n");
}

function isDirectory(dir: string): boolean {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}
