import { SessionNotification } from "@agentclientprotocol/sdk";
import {
  ContextCompactionMetadata,
  createContextCompactionMeta,
} from "./context-compaction-meta.js";

type CompactionStatus = "completed" | "failed";

type CompactionState = {
  toolCallId: string;
  terminalStatus?: CompactionStatus;
  heartbeatSent: boolean;
};

type SendUpdate = (notification: SessionNotification) => Promise<void>;

/**
 * Translates Claude's compaction signals into one idempotent ACP tool lifecycle.
 *
 * The SDK can duplicate terminal compact_result messages and can omit the
 * opening status on replay. State therefore lives until the owning turn's
 * result (or abort), while a new compacting status after a terminal outcome
 * starts a fresh lifecycle.
 */
export class ContextCompactionLifecycle {
  private activeCompaction: CompactionState | undefined;
  private outputDelivered = false;

  constructor(private readonly sendUpdate: SendUpdate) {}

  get hasDeliveredOutput(): boolean {
    return this.outputDelivered;
  }

  reset(): void {
    this.activeCompaction = undefined;
    this.outputDelivered = false;
  }

  async start(sessionId: string, toolCallId: string): Promise<CompactionState> {
    if (this.activeCompaction && !this.activeCompaction.terminalStatus) {
      return this.activeCompaction;
    }

    this.activeCompaction = { toolCallId, heartbeatSent: false };
    this.outputDelivered = true;
    await this.sendUpdate({
      sessionId,
      update: {
        sessionUpdate: "tool_call",
        toolCallId,
        title: "Compact conversation",
        kind: "think",
        status: "in_progress",
        _meta: compactionToolMeta(),
      },
    });
    return this.activeCompaction;
  }

  async heartbeat(sessionId: string, fallbackId: string): Promise<void> {
    const state = this.activeCompaction ?? (await this.start(sessionId, fallbackId));
    if (state.terminalStatus || state.heartbeatSent) return;

    state.heartbeatSent = true;
    await this.sendUpdate({
      sessionId,
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: state.toolCallId,
        status: "in_progress",
        _meta: compactionToolMeta(),
      },
    });
  }

  async finish(
    sessionId: string,
    fallbackId: string,
    status: CompactionStatus,
    metadata: Omit<ContextCompactionMetadata, "version"> = {},
    enrichTerminal = false,
  ): Promise<void> {
    const rawOutput = Object.keys(metadata).length > 0 ? metadata : undefined;
    if (!this.activeCompaction) {
      this.activeCompaction = {
        toolCallId: fallbackId,
        heartbeatSent: false,
        terminalStatus: status,
      };
      this.outputDelivered = true;
      await this.sendUpdate({
        sessionId,
        update: {
          sessionUpdate: "tool_call",
          toolCallId: fallbackId,
          title: "Compact conversation",
          kind: "think",
          status,
          ...(status === "failed" && metadata.error
            ? { content: [compactionErrorContent(metadata.error)] }
            : {}),
          ...(rawOutput ? { rawOutput } : {}),
          _meta: compactionToolMeta(metadata),
        },
      });
      return;
    }

    const state = this.activeCompaction;
    if (state.terminalStatus && !enrichTerminal) return;

    const firstTerminal = state.terminalStatus === undefined;
    if (firstTerminal) state.terminalStatus = status;
    await this.sendUpdate({
      sessionId,
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: state.toolCallId,
        ...(firstTerminal ? { status } : {}),
        ...(status === "failed" && metadata.error
          ? { content: [compactionErrorContent(metadata.error)] }
          : {}),
        ...(rawOutput ? { rawOutput } : {}),
        _meta: compactionToolMeta(metadata),
      },
    });
  }
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

function compactionToolMeta(
  metadata: Omit<ContextCompactionMetadata, "version"> = {},
): Record<string, unknown> {
  return {
    ...createContextCompactionMeta(metadata),
    claudeCode: { toolName: "compact" },
  };
}

function compactionErrorContent(error: string) {
  return {
    type: "content" as const,
    content: {
      type: "text" as const,
      text: `Compaction failed: ${error}`,
    },
  };
}
