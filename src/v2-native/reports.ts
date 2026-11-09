/**
 * The reports of a native v2 session that are not Claude's output: the
 * context window and cost (`usage_update`), Claude Code's warnings and MCP startup failures (`notice`), compactions
 * (`compaction_update`), the title (`session_info_update`), and the
 * adapter's own idle compaction.
 *
 * They are built as the v1 core builds them, from the shared modules
 * (`session-usage.ts`, `session-notices.ts`, `context-compaction.ts`,
 * `session-titles.ts`, `idle-compaction.ts`), and go out through the
 * session's v1-to-v2 translation. The session tells it where its turns start
 * and end.
 */
import type { ContentBlock, PromptRequest } from "@agentclientprotocol/sdk/unstable";
import type {
  ModelUsage,
  Options,
  SDKAssistantMessage,
  SDKMessage,
  SDKPartialAssistantMessage,
  SDKResultMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { Logger } from "../acp-agent.js";
import type { AcpSessionNotification } from "../acp-subagents.js";
import {
  ContextCompactionLifecycle,
  contextCompactionMetadataFromBoundary,
} from "../context-compaction.js";
import { IdleCompaction } from "../idle-compaction.js";
import {
  informationalNotice,
  mcpServerStartupNotice,
  normalizeNoticeText,
  noticeUpdate,
} from "../session-notices.js";
import {
  DEFAULT_CONTEXT_WINDOW,
  getMatchingModelUsage,
  inferContextWindowFromModel,
  snapshotFromUsage,
  totalTokens,
  ZERO_USAGE,
  type UsageSnapshot,
} from "../session-usage.js";
import { SessionTitles, type TitledSession } from "../session-titles.js";
import type { SettingsManager } from "../settings.js";
import { createTaskHook } from "../tools.js";
import type { SessionOutput } from "./stream.js";

type UsageUpdate = Extract<AcpSessionNotification["update"], { sessionUpdate: "usage_update" }>;

/** What the reports need of their session. */
export interface ReportsHost {
  readonly sessionId: string;
  readonly logger: Logger;
  /** Sends v1-shaped updates of the session, in the order of the calls. */
  emit(notifications: AcpSessionNotification[]): void;
  /** For the idle compaction: whether the session is busy, and its `/compact`. */
  isBusy(): boolean;
  compact(): Promise<void>;
  /** The session as titles read it, the same object each time; undefined until it starts and once it ends. */
  titledSession(): TitledSession | undefined;
}

/** What the session's query was started with (see {@link SessionReports.configure}). */
export interface ReportsSetup {
  /** The session's live Claude Code settings, disposed with the reports. */
  settings: Pick<SettingsManager, "getSettings" | "dispose">;
  /** The query's environment. */
  env: Record<string, string | undefined>;
  /** The names of the client's MCP servers. */
  mcpServers: readonly string[];
}

export class SessionReports {
  private readonly titles: SessionTitles;
  private readonly compaction: ContextCompactionLifecycle;
  private idleCompaction: IdleCompaction | undefined;
  private settings: ReportsSetup["settings"] | undefined;
  private clientMcpServers = new Set<string>();
  private readonly reportedMcpServers = new Set<string>();
  /** The tool uses whose `informational` progress went out as a notice. */
  private readonly noticedToolUses = new Set<string>();

  // The open turn's figures, reset when a turn starts.
  private lastUsage: UsageSnapshot | null = null;
  private lastTotal: number | null = null;
  private lastModel: string | null = null;
  /** A `rate_limit_event` that came before the turn had usage to report it with. */
  private pendingRateLimit: unknown = null;
  /** The normalized texts of the turn's notices (see {@link repeats}). */
  private noticeTexts: string[] = [];

  /** The context window of the session's model. */
  private contextWindow = DEFAULT_CONTEXT_WINDOW;
  /** Whether {@link contextWindow} came from a result's `modelUsage`. */
  private contextWindowAuthoritative = false;
  /** The context used after the last main-thread request. */
  private contextUsed: number | undefined;

  constructor(private readonly host: ReportsHost) {
    this.titles = new SessionTitles(
      {
        client: { sessionUpdate: async (notification) => host.emit([notification]) },
        logger: host.logger,
        get sessions() {
          const session = host.titledSession();
          return session ? { [host.sessionId]: session } : {};
        },
      },
      host.sessionId,
    );
    // Every v2 client takes compaction updates.
    this.compaction = new ContextCompactionLifecycle(
      async (notification) => host.emit([notification]),
      {
        sessionId: host.sessionId,
        presentation: "compaction_update",
        logError: (message, error) => host.logger.error(message, error),
      },
    );
  }

  /** Called once, before the query's first message. */
  configure(setup: ReportsSetup): void {
    this.clientMcpServers = new Set(setup.mcpServers);
    this.settings = setup.settings;
    this.idleCompaction = new IdleCompaction(
      {
        isBusy: () => this.host.isBusy(),
        contextTokens: () => this.contextUsed,
        settings: () => setup.settings.getSettings(),
        compact: () => this.host.compact(),
        // The logger has no debug level.
        log: (message) => this.host.logger.log(message),
      },
      { env: setup.env },
    );
  }

  /**
   * The session's query restarted with the same MCP servers (see
   * `restarts.ts`): a server already reported is not reported again.
   */
  restartedFrom(previous: SessionReports): void {
    for (const server of previous.reportedMcpServers) this.reportedMcpServers.add(server);
  }

  /** The session's MCP servers changed, as a resume of the active session asks. */
  mcpServersChanged(names: readonly string[]): void {
    this.clientMcpServers = new Set(names);
  }

  // --- Turns ---------------------------------------------------------------

  turnStarted(): void {
    this.lastUsage = null;
    this.lastTotal = null;
    this.lastModel = null;
    this.noticeTexts = [];
  }

  /**
   * The turn ends: a compaction that Claude Code left open ends `cancelled`.
   * Called before the turn's idle.
   */
  turnEnded(): void {
    void this.compaction.reset();
  }

  /**
   * Whether the text of a result that streamed no model text was shown
   * already: as a compaction, or as one of the turn's notices (a hook-blocked
   * turn's result repeats the block reason).
   */
  repeats(resultText: string): boolean {
    return (
      this.compaction.hasDeliveredOutput ||
      this.noticeTexts.includes(normalizeNoticeText(resultText))
    );
  }

  /**
   * Claude Code's session state went `idle`: the idle compaction may arm, and
   * the title may have landed (see {@link SessionTitles.onTurnEnd}).
   */
  idle(): void {
    this.idleCompaction?.onIdle();
    const session = this.host.titledSession();
    if (session) {
      this.titles.onTurnEnd(session).catch((error) => {
        this.host.logger.error(`Session ${this.host.sessionId}: failed to update the title`, error);
      });
    }
  }

  // --- Titles ----------------------------------------------------------------

  /**
   * A client prompt came: it drops the armed idle compaction, and its text is
   * for the title. The adapter's `/compact` is no client prompt.
   */
  promptSent(prompt: PromptRequest["prompt"]): void {
    this.idleCompaction?.disarm("prompt");
    this.titles.onPrompt(prompt);
  }

  /** The client prompt went to Claude Code, which may title the session from it. */
  promptQueued(prompt: PromptRequest["prompt"]): void {
    const session = this.host.titledSession();
    if (session) this.titles.onPromptQueued(session, prompt);
  }

  /** A live agent text chunk of the root session, for the title. */
  agentText(content: ContentBlock): void {
    this.titles.onAssistantText(content);
  }

  /** Sends the session's current title and `updatedAt`, as `session/resume` asks. */
  async publishTitle(): Promise<void> {
    const session = this.host.titledSession();
    if (!session) return;
    try {
      await this.titles.publishCurrent(session);
    } catch (error) {
      this.host.logger.error(
        `Session ${this.host.sessionId}: failed to send the session info`,
        error,
      );
    }
  }

  /** Drops the armed idle compaction: a prompt, a cancel or a model change came. */
  disarmIdleCompaction(reason: string): void {
    this.idleCompaction?.disarm(reason);
  }

  dispose(): void {
    this.idleCompaction?.dispose();
    this.settings?.dispose();
  }

  /** The PostCompact hook's summary of the root conversation's compaction. */
  compactSummary(summary: unknown): void {
    this.compaction.recordSummary(summary);
  }

  // --- The query's messages ----------------------------------------------

  /** A root stream event: its usage, and the streamed summary of a compaction. */
  streamEvent(message: SDKPartialAssistantMessage): void {
    const { event } = message;
    const compactionBlock =
      event.type === "content_block_start" && event.content_block.type === "compaction"
        ? event.content_block
        : event.type === "content_block_delta" && event.delta.type === "compaction_delta"
          ? event.delta
          : undefined;
    // `content` is null on the opening block and on a failed compaction.
    if (compactionBlock) {
      void this.compaction.heartbeat(message.uuid, compactionBlock.content ?? undefined);
    }
    if (event.type === "message_start") {
      this.lastUsage = snapshotFromUsage(event.message.usage);
      const model = event.message.model;
      if (model && model !== "<synthetic>") {
        this.lastModel = model;
        this.idleCompaction?.noteRequest(event.message.usage, event.message.id || undefined);
        if (!this.contextWindowAuthoritative && this.contextWindow === DEFAULT_CONTEXT_WINDOW) {
          this.contextWindow = inferContextWindowFromModel(model) ?? this.contextWindow;
        }
      }
    } else if (event.type === "message_delta") {
      const usage = event.usage;
      const prev: Readonly<UsageSnapshot> = this.lastUsage ?? ZERO_USAGE;
      // The delta's counters are cumulative; the nullable ones keep the
      // previous value when the delta leaves them out.
      this.lastUsage = {
        input_tokens: usage.input_tokens ?? prev.input_tokens,
        output_tokens: usage.output_tokens,
        cache_read_input_tokens: usage.cache_read_input_tokens ?? prev.cache_read_input_tokens,
        cache_creation_input_tokens:
          usage.cache_creation_input_tokens ?? prev.cache_creation_input_tokens,
      };
    } else {
      return;
    }
    const used = totalTokens(this.lastUsage);
    if (used === this.lastTotal) return;
    this.lastTotal = used;
    this.contextUsed = used;
    this.sendUsage({ sessionUpdate: "usage_update", used, size: this.contextWindow });
  }

  /**
   * A root assistant message: the turn's latest usage and model. A synthetic
   * message (a CLI banner with an all-zero usage) is not a model response.
   */
  assistant(message: SDKAssistantMessage): void {
    if (message.message.model === "<synthetic>") return;
    this.lastUsage = snapshotFromUsage(message.message.usage);
    this.lastTotal = totalTokens(this.lastUsage);
    this.contextUsed = this.lastTotal;
    this.idleCompaction?.noteRequest(message.message.usage, message.message.id || undefined);
    if (message.message.model) this.lastModel = message.message.model;
  }

  /** A result: its cost, and the model's context window. The idle's quota is `outcome.ts`'s. */
  result(message: SDKResultMessage): void {
    const matching = this.lastModel
      ? getMatchingModelUsage(message.modelUsage, this.lastModel)
      : undefined;
    const window = (matching?.usage as ModelUsage | undefined)?.contextWindow;
    if (typeof window === "number" && window > 0) {
      this.contextWindow = window;
      this.contextWindowAuthoritative = true;
    }
    if (this.lastTotal === null) return;
    this.sendUsage({
      sessionUpdate: "usage_update",
      used: this.lastTotal,
      size: this.contextWindow,
      cost: { amount: message.total_cost_usd, currency: "USD" },
      ...(message.origin ? { _meta: { "_claude/origin": message.origin } } : {}),
    });
  }

  /**
   * The messages that only report: Claude Code's notices, compaction states
   * and rate limits. Returns whether `message` was one.
   */
  handle(message: SDKMessage): boolean {
    switch (message.type) {
      case "rate_limit_event":
        this.idleCompaction?.noteRateLimit(message.rate_limit_info);
        // Sent before the turn's first usage: it goes out with that usage.
        if (this.lastTotal === null) {
          this.pendingRateLimit = message.rate_limit_info;
        } else {
          this.sendUsage({
            sessionUpdate: "usage_update",
            used: this.lastTotal,
            size: this.contextWindow,
            _meta: { "_claude/rateLimit": message.rate_limit_info },
          });
        }
        return true;
      case "system":
        break;
      default:
        return false;
    }
    switch (message.subtype) {
      case "init":
        this.mcpStartupFailures(message.mcp_servers);
        // The turn goes on: the session opens it.
        return false;
      case "status":
        if (message.status === "compacting") {
          void this.compaction.start(message.uuid);
        } else if (message.compact_result === "success") {
          void this.compaction.finish(message.uuid, "completed");
        } else if (message.compact_result === "failed") {
          this.idleCompaction?.noteCompactionFailed(message.compact_error);
          void this.compaction.finish(message.uuid, "failed", {
            ...(message.compact_error ? { error: message.compact_error } : {}),
          });
        }
        return true;
      case "compact_boundary": {
        const metadata = message.compact_metadata;
        void this.compaction.finish(
          message.uuid,
          "completed",
          metadata
            ? contextCompactionMetadataFromBoundary(metadata, {
                idleCompaction: this.idleCompaction?.isCompacting,
              })
            : {},
          true,
        );
        // The boundary carries the context that the compaction kept. The
        // window stays: compaction frees context, it does not change the model.
        const used = metadata?.post_tokens ?? 0;
        this.lastUsage = null;
        this.lastTotal = used;
        this.contextUsed = used;
        this.sendUsage({ sessionUpdate: "usage_update", used, size: this.contextWindow });
        return true;
      }
      case "informational": {
        // 'info' shows only in Claude Code's transcript mode: not worth a notice.
        if (message.level === "info") return true;
        if (message.tool_use_id) {
          if (this.noticedToolUses.has(message.tool_use_id)) return true;
          this.noticedToolUses.add(message.tool_use_id);
        }
        this.host.emit([
          { sessionId: this.host.sessionId, update: noticeUpdate(informationalNotice(message)) },
        ]);
        this.noticeTexts.push(normalizeNoticeText(message.content));
        return true;
      }
      default:
        return false;
    }
  }

  /** A notice for each client MCP server that did not start, once per server. */
  private mcpStartupFailures(servers: Array<{ name: string; status: string }> | undefined): void {
    for (const server of servers ?? []) {
      if (!this.clientMcpServers.has(server.name) || this.reportedMcpServers.has(server.name)) {
        continue;
      }
      // This core runs no MCP OAuth flow.
      const notice = mcpServerStartupNotice(server, false);
      if (!notice) continue;
      this.reportedMcpServers.add(server.name);
      this.host.emit([{ sessionId: this.host.sessionId, update: noticeUpdate(notice) }]);
    }
  }

  /**
   * Sends a `usage_update` with the model the usage belongs to and any
   * pending rate limit in `_meta`, as ACP's usage_update has no field for them.
   */
  private sendUsage(update: UsageUpdate): void {
    let meta: Record<string, unknown> = { ...(update._meta ?? {}) };
    if (this.pendingRateLimit !== null) {
      meta = { "_claude/rateLimit": this.pendingRateLimit, ...meta };
      this.pendingRateLimit = null;
    }
    if (this.lastModel) meta["_claude/model"] = this.lastModel;
    this.host.emit([
      {
        sessionId: this.host.sessionId,
        update: { ...update, ...(Object.keys(meta).length > 0 ? { _meta: meta } : {}) },
      },
    ]);
  }
}

/**
 * The hooks that feed the reports: the PostCompact summary of the root
 * conversation's compaction (a subagent's own is not the session's), and
 * the TaskCreated and TaskCompleted changes of the session's Task* plan.
 */
export function reportHooks(session: {
  readonly reports: SessionReports;
  readonly output: SessionOutput;
}): NonNullable<Options["hooks"]> {
  const taskHook = createTaskHook({
    taskState: session.output.taskState,
    onChange: async () => session.output.taskPlanChanged(),
  });
  return {
    PostCompact: [
      {
        hooks: [
          async (input) => {
            if (input.hook_event_name === "PostCompact" && !input.agent_id) {
              session.reports.compactSummary(input.compact_summary);
            }
            return { continue: true };
          },
        ],
      },
    ],
    TaskCreated: [{ hooks: [taskHook] }],
    TaskCompleted: [{ hooks: [taskHook] }],
  };
}
