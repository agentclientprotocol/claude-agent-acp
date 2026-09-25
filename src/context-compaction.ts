import { ClientCapabilities, SessionNotification } from "@agentclientprotocol/sdk";
import {
  ContextCompactionMetadata,
  createContextCompactionMeta,
} from "./context-compaction-meta.js";
import { compactionToolCall } from "./tool-calls/reporters/compaction.js";

type CompactionStatus = "completed" | "failed";
type TerminalStatus = CompactionStatus | "cancelled";

/**
 * How compaction reaches the client.
 *
 * - `compaction_update`: the ACP session-compaction contract (ID-addressed
 *   `compaction_update` / `compaction_summary_chunk`), used when the v1 client
 *   advertises `clientCapabilities.session.compaction`.
 * - `tool_call`: the legacy synthetic "Compact conversation" tool call, kept
 *   for clients that do not advertise the capability.
 */
export type CompactionPresentation = "tool_call" | "compaction_update";

type CompactionState = {
  /** Doubles as the toolCallId under the legacy presentation. */
  compactionId: string;
  terminalStatus?: TerminalStatus;
  heartbeatSent: boolean;
  /** The summary text that went out as chunks. */
  streamedSummary?: string;
  /** User-displayable summary reported by the PostCompact hook. While the
   *  compaction is in progress it awaits the terminal update; on a `completed`
   *  state it has been sent. */
  summary?: string;
};

type SendUpdate = (notification: SessionNotification) => Promise<void>;

export type ContextCompactionLifecycleOptions = {
  sessionId: string;
  presentation?: CompactionPresentation;
  /** Receives failures of the send that must not propagate: the turn-boundary
   *  `cancelled` terminal. */
  logError?: (message: string, error: unknown) => void;
  /** The client is AIR. Only AIR gets the compaction facts, under `_meta.jetbrains.air`. */
  airClient?: boolean;
};

export function clientSupportsCompactionUpdates(capabilities?: ClientCapabilities | null): boolean {
  const compaction = capabilities?.session?.compaction;
  return typeof compaction === "object" && compaction !== null && !Array.isArray(compaction);
}

/** Tags on their own line, as the model emits them; a summary that merely
 *  quotes `<summary>` mid-sentence must not be truncated at the mention. */
const SUMMARY_OPEN_LINE = /^[ \t]*<summary>[ \t]*\r?\n/gim;
const SUMMARY_CLOSE_LINE = /^[ \t]*<\/summary>[ \t]*$/gim;
/** The model's private reasoning block that precedes the summary; stripped
 *  first so a `<summary>` it merely mentions cannot anchor the summary span,
 *  and even when the summary tags themselves are missing. Own-line tags
 *  anywhere; inline tags only as a leading block, since a summary body may
 *  quote both tag names. */
const ANALYSIS_BLOCKS = [
  /^[ \t]*<analysis>[ \t]*\r?\n[\s\S]*?\n[ \t]*<\/analysis>[ \t]*$/gim,
  /^\s*<analysis>[\s\S]*?<\/analysis>/i,
];
/** The framing Claude Code wraps around the retained summary when it persists
 *  it as the post-compaction user message. */
const CONTINUATION_PREAMBLE = /^\s*This session is being continued from a previous conversation/i;
const PERSISTED_PREAMBLE =
  /^\s*This session is being continued from a previous conversation[^\n]*\n+Summary:[ \t]*\r?\n/;
const PERSISTED_TRAILERS = [
  /\n+If you need specific details from before compaction[\s\S]*$/,
  /\n+(?:Please )?[Cc]ontinue the conversation from where it left (?:it )?off[\s\S]*$/,
];

/**
 * Reduce Claude's compaction output to the user-displayable summary.
 *
 * The PostCompact hook reports the model's raw output, which wraps the
 * summary in `<summary>` tags (often preceded by an `<analysis>` block). The
 * persisted transcript instead frames the same summary with continuation
 * instructions for the model. Neither framing belongs in the ACP `summary`,
 * and a continuation prompt whose framing is not recognized yields no summary
 * at all rather than model-facing instructions.
 */
export function compactionSummaryText(raw: string): string | undefined {
  let text = raw;
  for (const block of ANALYSIS_BLOCKS) {
    text = text.replace(block, "");
  }
  const tagged = taggedSummary(text);
  if (tagged !== undefined) {
    text = tagged;
  } else if (CONTINUATION_PREAMBLE.test(text)) {
    const body = text.replace(PERSISTED_PREAMBLE, "");
    if (body === text) return undefined;
    text = body;
    for (const trailer of PERSISTED_TRAILERS) {
      text = text.replace(trailer, "");
    }
  }
  text = text.trim();
  return text.length > 0 ? text : undefined;
}

function taggedSummary(raw: string): string | undefined {
  const close = [...raw.matchAll(SUMMARY_CLOSE_LINE)].at(-1);
  if (close?.index !== undefined) {
    const open = [...raw.slice(0, close.index).matchAll(SUMMARY_OPEN_LINE)].at(-1);
    if (open?.index !== undefined) {
      return raw.slice(open.index + open[0].length, close.index);
    }
  }
  // Inline tags: the widest span, so a quoted `</summary>` inside the body
  // does not end it early. Plain index scans keep an unterminated tag linear.
  const openInline = raw.search(/<summary>/i);
  const closeInline = raw.toLowerCase().lastIndexOf("</summary>");
  if (openInline >= 0 && closeInline > openInline) {
    return raw.slice(openInline + "<summary>".length, closeInline);
  }
  return undefined;
}

/** True for the post-compaction user message Claude Code persists (and
 *  `getSessionMessages` returns) with the summary of the dropped history. */
export function isCompactSummaryMessage(message: unknown): boolean {
  return (
    typeof message === "object" &&
    message !== null &&
    (message as { type?: unknown }).type === "user" &&
    (message as { isCompactSummary?: unknown }).isCompactSummary === true
  );
}

/**
 * Translates Claude's compaction signals into one idempotent ACP lifecycle.
 *
 * The SDK can duplicate terminal compact_result messages and can omit the
 * opening status on replay. State therefore lives until the owning turn's
 * result (or abort), while a new compacting status after a terminal outcome
 * starts a fresh lifecycle.
 */
export class ContextCompactionLifecycle {
  private activeCompaction: CompactionState | undefined;
  private outputDelivered = false;
  private duplicateErrorOutput: string | undefined;
  /** After interruption, uncorrelated terminal frames and hooks may still
   *  arrive from the abandoned work, including an opening we never consumed.
   *  Wait for a known new turn before accepting them again. */
  private interrupted = false;
  /** Summary reported by PostCompact before the opening status was consumed.
   *  Deliberately survives `reset()`: the CLI awaits the hook before emitting
   *  the compaction's terminal frames, so a pending summary always belongs to
   *  a compaction whose frames are still ahead of the consumer — possibly
   *  queued behind a previous turn's result. */
  private pendingSummary: string | undefined;
  private readonly sessionId: string;
  readonly presentation: CompactionPresentation;
  private readonly logError: (message: string, error: unknown) => void;
  private readonly airClient: boolean;

  constructor(
    private readonly sendUpdate: SendUpdate,
    options: ContextCompactionLifecycleOptions,
  ) {
    this.sessionId = options.sessionId;
    this.presentation = options.presentation ?? "tool_call";
    this.logError = options.logError ?? (() => {});
    this.airClient = options.airClient ?? false;
  }

  get hasDeliveredOutput(): boolean {
    return this.outputDelivered;
  }

  /**
   * Close the lifecycle at a turn boundary (result, cancel, idle-abandon).
   *
   * A `compaction_update` entity still `in_progress` here never received its
   * terminal signal from the runtime and gets its one terminal status,
   * `cancelled`. The legacy tool call is deliberately left as it was (an
   * `in_progress` call): ACP `ToolCallStatus` has no cancelled state and that
   * presentation's behavior predates this lifecycle. Never throws — a failed
   * send is logged, so callers can settle the turn unconditionally.
   */
  async reset(): Promise<void> {
    const state = this.activeCompaction;
    this.activeCompaction = undefined;
    this.outputDelivered = false;
    this.duplicateErrorOutput = undefined;
    if (!state || state.terminalStatus || this.presentation !== "compaction_update") return;
    state.terminalStatus = "cancelled";
    await this.sendQuietly(
      {
        sessionUpdate: "compaction_update",
        compactionId: state.compactionId,
        status: "cancelled",
      },
      "cancelled compaction",
    );
  }

  /** Abandon the current work before settling its prompt or tearing down the
   *  stream. Unlike a normal result boundary, its pending hooks are not safe
   *  to carry into the next compaction. A hook has no command ID, so even an
   *  early hook for the next compaction must be omitted until the stream gives
   *  us a new live turn boundary. Idempotent and best-effort. */
  async interrupt(): Promise<void> {
    if (this.presentation === "compaction_update") {
      this.interrupted = true;
      this.pendingSummary = undefined;
    }
    await this.reset();
  }

  /** A live command's dispatch/echo proves the interrupted command's tail
   *  has drained in the SDK's FIFO stream. Do not reset normal lifecycle
   *  state: compaction may already have started before the user echo. */
  resume(): void {
    this.interrupted = false;
  }

  /**
   * Claude also emits a failed manual compaction's error as local-command
   * stdout. Consume that one duplicate after the lifecycle carried it,
   * without hiding unrelated command output.
   */
  consumeDuplicateErrorOutput(content: string): boolean {
    if (
      this.duplicateErrorOutput === undefined ||
      content.trim() !== this.duplicateErrorOutput.trim()
    ) {
      return false;
    }
    this.duplicateErrorOutput = undefined;
    return true;
  }

  async start(compactionId: string): Promise<void> {
    if (this.interrupted) return;
    if (this.activeCompaction && !this.activeCompaction.terminalStatus) {
      return;
    }

    this.open(compactionId);
    if (this.presentation === "compaction_update") {
      await this.send({
        sessionUpdate: "compaction_update",
        compactionId,
        status: "in_progress",
        ...(this.airClient ? { _meta: createContextCompactionMeta() } : {}),
      });
      return;
    }
    await this.send(compactionToolCall.started(compactionId, this.airClient));
  }

  /**
   * Streaming progress from the API's compaction content block.
   *
   * Under `compaction_update` the block's text is the retained summary and
   * streams as `compaction_summary_chunk`s — but only into an entity the CLI
   * announced with its `compacting` status. The block alone carries no
   * terminal signal, so opening an entity from it would leave nothing but the
   * turn-boundary `cancelled` to close a compaction that succeeded. The legacy
   * tool call keeps its historical behavior: open on first sight, re-assert
   * `in_progress` once.
   */
  async heartbeat(fallbackId: string, summaryChunk?: string): Promise<void> {
    if (this.presentation === "compaction_update") {
      const state = this.activeCompaction;
      if (!state || state.terminalStatus || !summaryChunk) return;
      state.streamedSummary = (state.streamedSummary ?? "") + summaryChunk;
      await this.send({
        sessionUpdate: "compaction_summary_chunk",
        compactionId: state.compactionId,
        content: { type: "text", text: summaryChunk },
      });
      return;
    }

    if (!this.activeCompaction) await this.start(fallbackId);
    const state = this.activeCompaction;
    if (!state || state.terminalStatus || state.heartbeatSent) return;
    state.heartbeatSent = true;
    await this.send(compactionToolCall.inProgress(state.compactionId, this.airClient));
  }

  /**
   * The PostCompact hook's summary. The CLI awaits the hook before emitting
   * the compaction's terminal frames, so the summary lands while its
   * compaction is `in_progress` and rides on the terminal update. Anything
   * else — no entity yet, or the entity is a previous, already-terminal
   * compaction of the same turn whose status frame the consumer is still
   * catching up to — belongs to the compaction whose frames are ahead of the
   * consumer, and waits for it. Only the `compaction_update` presentation
   * carries the summary; the legacy tool call never exposed it. Never throws:
   * it runs detached from a hook callback. Returns whether a summary was
   * retained.
   */
  recordSummary(rawSummary: unknown): boolean {
    if (this.interrupted) return false;
    if (this.presentation !== "compaction_update" || typeof rawSummary !== "string") return false;
    const summary = compactionSummaryText(rawSummary);
    if (!summary) return false;

    const state = this.activeCompaction;
    if (state && !state.terminalStatus) {
      state.summary = summary;
    } else {
      this.pendingSummary = summary;
    }
    return true;
  }

  async finish(
    compactionId: string,
    status: CompactionStatus,
    metadata: Omit<ContextCompactionMetadata, "version"> = {},
    enrichTerminal = false,
  ): Promise<void> {
    if (this.interrupted) return;
    // The opening status can be missed (replay, or a terminal-only runtime):
    // the first update for the ID is then already terminal.
    const opened = this.activeCompaction === undefined;
    const firstTerminal = !this.activeCompaction?.terminalStatus;
    const state = this.activeCompaction ?? this.open(compactionId, status);
    if (firstTerminal) {
      state.terminalStatus = status;
    } else if (!enrichTerminal) {
      return;
    }
    if (status === "failed" && metadata.error) {
      this.duplicateErrorOutput = metadata.error;
    }
    const terminalStatus = state.terminalStatus ?? status;
    const hasMetadata = Object.keys(metadata).length > 0;

    if (this.presentation === "compaction_update") {
      // A summary that went out as chunks is not sent again in full. The
      // chunks are the raw API text and the summary is the cleaned hook text,
      // so the summary is left out only when both hold the same text.
      const summaryStreamed = state.streamedSummary === state.summary;
      const summary =
        firstTerminal && terminalStatus === "completed" && !summaryStreamed
          ? state.summary
          : undefined;
      await this.send({
        sessionUpdate: "compaction_update",
        compactionId: state.compactionId,
        status: terminalStatus,
        ...(summary !== undefined ? { summary: [{ type: "text", text: summary }] } : {}),
        ...(terminalStatus === "failed" && metadata.error ? { error: metadata.error } : {}),
        // `_meta` is a replace-patch: seed it with the first terminal, then
        // only re-send it when the boundary adds facts, so a status-only
        // duplicate can't wipe the token counts.
        // The standard `error` field carries the error, so `_meta` does not.
        // Only AIR gets the compaction facts.
        ...(this.airClient && (firstTerminal || hasMetadata)
          ? { _meta: createContextCompactionMeta(withoutError(metadata)) }
          : {}),
      });
      return;
    }

    await this.send(
      compactionToolCall.finished(
        state.compactionId,
        opened || firstTerminal ? status : undefined,
        metadata,
        opened,
        this.airClient,
      ),
    );
  }

  /** Make `compactionId` the active entity, moving a pending hook summary onto
   *  it, and mark compaction output as delivered for the owning turn. */
  private open(compactionId: string, terminalStatus?: TerminalStatus): CompactionState {
    const state: CompactionState = {
      compactionId,
      heartbeatSent: false,
      ...(terminalStatus ? { terminalStatus } : {}),
      ...(this.pendingSummary !== undefined ? { summary: this.pendingSummary } : {}),
    };
    this.pendingSummary = undefined;
    this.activeCompaction = state;
    this.outputDelivered = true;
    return state;
  }

  private send(update: SessionNotification["update"]): Promise<void> {
    return this.sendUpdate({ sessionId: this.sessionId, update });
  }

  private async sendQuietly(update: SessionNotification["update"], what: string): Promise<void> {
    try {
      await this.send(update);
    } catch (error) {
      this.logError(`Failed to send the ${what} update for session ${this.sessionId}`, error);
    }
  }
}

function withoutError({
  error: _error,
  ...facts
}: Omit<ContextCompactionMetadata, "version">): Omit<ContextCompactionMetadata, "version"> {
  return facts;
}

export function contextCompactionMetadataFromBoundary(compactMetadata: {
  trigger: "manual" | "auto";
  pre_tokens: number;
  post_tokens?: number;
  duration_ms?: number;
}): Omit<ContextCompactionMetadata, "version"> {
  return {
    trigger: compactMetadata.trigger === "auto" ? "automatic" : "manual",
    preTokens: compactMetadata.pre_tokens,
    ...(compactMetadata.post_tokens !== undefined
      ? { postTokens: compactMetadata.post_tokens }
      : {}),
    ...(compactMetadata.duration_ms !== undefined
      ? { durationMs: compactMetadata.duration_ms }
      : {}),
  };
}
