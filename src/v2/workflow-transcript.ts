import { setTimeout as delay } from "node:timers/promises";
import type { SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import { isSyntheticLoginMessage, stripLocalCommandMetadata } from "../message-filters.js";

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Only displayable content travels in a worker message or tool result.
 * SDK reasoning, signatures and harness metadata stay in the transcript. */
function visibleBlock(block: unknown, user: boolean): Record<string, unknown> | undefined {
  if (!record(block)) return;
  if (block.type === "text" && typeof block.text === "string") {
    const text = user ? stripLocalCommandMetadata(block.text) : block.text;
    return text ? { type: "text", text } : undefined;
  }
  if (block.type === "image" && record(block.source)) {
    const { type, media_type, data, url } = block.source;
    if (type === "base64" && typeof media_type === "string" && typeof data === "string")
      return { type: "image", source: { type, media_type, data } };
    if (type === "url" && typeof url === "string") return { type: "image", source: { type, url } };
  }
}

function visibleResult(content: unknown): unknown {
  if (typeof content === "string") return stripLocalCommandMetadata(content) ?? "";
  if (!Array.isArray(content)) return "";
  return content.flatMap((block) => visibleBlock(block, true) ?? []);
}

/**
 * A Workflow worker's public transcript record. The SDK can split one model
 * response across transcript records (including text after a tool call); the
 * record UUID identifies the same piece of content both live and on replay.
 */
export function workflowWorkerMessage(message: SessionMessage): SessionMessage | undefined {
  if (
    (message.type !== "assistant" && message.type !== "user") ||
    !message.uuid ||
    (message as { is_meta?: boolean }).is_meta ||
    !record(message.message) ||
    isSyntheticLoginMessage(message.message)
  )
    return undefined;
  const source = message.message.content;
  let content: unknown;
  if (typeof source === "string") {
    content =
      message.type === "user"
        ? stripLocalCommandMetadata(source)
        : [{ type: "text", text: source }];
  } else if (Array.isArray(source)) {
    const blocks: Record<string, unknown>[] = [];
    for (const block of source) {
      if (!record(block)) continue;
      const { type, id, name, input, tool_use_id } = block;
      const shown = visibleBlock(block, message.type === "user");
      if (shown) {
        blocks.push(shown);
      } else if (
        message.type === "assistant" &&
        (type === "tool_use" || type === "server_tool_use" || type === "mcp_tool_use") &&
        typeof id === "string" &&
        typeof name === "string"
      ) {
        blocks.push({ type, id, name, input });
      } else if (
        message.type === "user" &&
        type === "tool_result" &&
        typeof tool_use_id === "string"
      ) {
        blocks.push({
          type,
          tool_use_id,
          content: visibleResult(block.content),
          ...(block.is_error === true ? { is_error: true } : {}),
        });
      }
    }
    content = blocks.length ? blocks : undefined;
  }
  if (!content) return undefined;
  return {
    type: message.type,
    uuid: message.uuid,
    session_id: message.session_id,
    parent_tool_use_id: null,
    parent_agent_id: message.parent_agent_id,
    message: { id: message.uuid, content },
  };
}

/** Up to four SDK transcript reads at a time, shared by live polls and final snapshots. */
const MAX_READS = 4;
const POLL_MS = 2000;

type Worker = {
  seen: Set<string>;
  ready: SessionMessage[];
  send?: (message: SessionMessage) => void;
  following: boolean;
  next: number;
  generation: number;
  delay: number;
  reading?: Promise<void>;
};

/**
 * The Workflow's SDK event stream has progress but no worker messages.
 * Sample each active worker's SDK transcript, retrying missing/unfinished
 * files. The final sample is requested before applying the terminal state.
 */
export class WorkflowTranscripts {
  private workers = new Map<string, Worker>();
  private timer?: ReturnType<typeof setInterval>;
  private reads = 0;
  private waiters: Array<() => void> = [];

  constructor(
    private readonly read: (id: string) => Promise<SessionMessage[]>,
    private readonly failed: (id: string, error: unknown) => void,
  ) {}

  hasMessages(id: string): boolean {
    return !!this.workers.get(id)?.ready.length;
  }

  follow(id: string, send: (message: SessionMessage) => void, running: boolean): void {
    const worker = this.worker(id);
    worker.send = send;
    this.flush(worker);
    if (!running || worker.following) return;
    worker.following = true;
    this.poll();
    this.timer ??= setInterval(() => this.poll(), POLL_MS).unref();
  }

  stop(id: string): void {
    const worker = this.workers.get(id);
    if (!worker) return;
    worker.following = false;
    if (![...this.workers.values()].some((w) => w.following)) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  forget(id: string): void {
    this.stop(id);
    this.workers.delete(id);
  }

  clear(): void {
    clearInterval(this.timer);
    this.timer = undefined;
    this.workers.clear();
  }

  /** A fresh read after any older poll; a file append may have raced that poll. */
  async final(ids: Set<string>): Promise<void> {
    const pending = Array.from(ids, (id) => [id, this.worker(id)] as const);
    let expired = false;
    const timer = new AbortController();
    const drain = async (id: string, worker: Worker) => {
      this.stop(id);
      await worker.reading;
      if (expired || this.workers.get(id) !== worker) return;
      await this.sample(id, worker);
      if (worker.seen.size || expired) return;
      // A terminal notification can beat creation of the worker transcript.
      await delay(120);
      if (!expired && this.workers.get(id) === worker) await this.sample(id, worker);
    };
    try {
      await Promise.race([
        Promise.all(pending.map(([id, worker]) => drain(id, worker))),
        // A stalled filesystem must not hold the root SDK stream indefinitely.
        delay(2000, undefined, { signal: timer.signal, ref: false }).then(() => {
          expired = true;
          for (const [, worker] of pending) worker.generation++;
        }),
      ]);
    } finally {
      timer.abort();
    }
  }

  private worker(id: string): Worker {
    let worker = this.workers.get(id);
    if (!worker) {
      worker = {
        seen: new Set(),
        ready: [],
        following: false,
        next: 0,
        generation: 0,
        delay: POLL_MS,
      };
      this.workers.set(id, worker);
    }
    return worker;
  }

  private flush(worker: Worker): void {
    if (!worker.send) return;
    for (const message of worker.ready) worker.send(message);
    worker.ready = [];
  }

  private poll(): void {
    for (const [id, worker] of [...this.workers].sort(([, a], [, b]) => a.next - b.next)) {
      if (this.reads === MAX_READS) break;
      if (worker.following && worker.next <= Date.now() && !worker.reading) {
        void this.sample(id, worker);
      }
    }
  }

  private sample(id: string, worker: Worker): Promise<void> {
    const generation = worker.generation;
    const current = () => this.workers.get(id) === worker && generation === worker.generation;
    const sample = async () => {
      if (this.reads === MAX_READS)
        await new Promise<void>((resolve) => this.waiters.push(resolve));
      else this.reads++;
      try {
        if (!current()) return;
        const messages = await this.read(id);
        if (!current()) return;
        const seen = worker.seen.size;
        for (const message of messages) {
          if (worker.seen.has(message.uuid)) continue;
          worker.seen.add(message.uuid);
          const shown = workflowWorkerMessage(message);
          if (shown) worker.ready.push(shown);
        }
        this.flush(worker);
        worker.delay = worker.seen.size === seen ? Math.min(worker.delay * 2, 10000) : POLL_MS;
      } catch (error) {
        this.failed(id, error);
      } finally {
        worker.next = Date.now() + worker.delay;
        worker.reading = undefined;
        const next = this.waiters.shift();
        if (next) next();
        else this.reads--;
      }
    };
    return (worker.reading = sample());
  }
}
