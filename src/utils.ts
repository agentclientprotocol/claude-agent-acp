// A pushable async iterable: allows you to push items and consume them with for-await.

import { Readable, Writable } from "node:stream";
import { WritableStream, ReadableStream } from "node:stream/web";
import { Logger } from "./acp-agent.js";

// Useful for bridging push-based and async-iterator-based code.
export class Pushable<T> implements AsyncIterable<T> {
  private queue: T[] = [];
  private resolvers: ((value: IteratorResult<T>) => void)[] = [];
  private done = false;

  push(item: T) {
    if (this.resolvers.length > 0) {
      const resolve = this.resolvers.shift()!;
      resolve({ value: item, done: false });
    } else {
      this.queue.push(item);
    }
  }

  end() {
    this.done = true;
    while (this.resolvers.length > 0) {
      const resolve = this.resolvers.shift()!;
      resolve({ value: undefined as any, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        if (this.queue.length > 0) {
          const value = this.queue.shift()!;
          return Promise.resolve({ value, done: false });
        }
        if (this.done) {
          return Promise.resolve({ value: undefined as any, done: true });
        }
        return new Promise<IteratorResult<T>>((resolve) => {
          this.resolvers.push(resolve);
        });
      },
    };
  }
}

// Helper to convert Node.js streams to Web Streams
export function nodeToWebWritable(nodeStream: Writable): WritableStream<Uint8Array> {
  return new WritableStream<Uint8Array>({
    write(chunk) {
      return new Promise<void>((resolve, reject) => {
        // A Uint8Array is written as it is: Node wraps it in a Buffer view
        // without a copy. The encoder hands each message a fresh array, so
        // nothing changes the bytes while the write is pending.
        nodeStream.write(chunk, (err) => {
          if (err) {
            reject(err);
          } else {
            resolve();
          }
        });
      });
    },
  });
}

export function nodeToWebReadable(nodeStream: Readable): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      nodeStream.on("data", (chunk: Buffer) => {
        controller.enqueue(new Uint8Array(chunk));
      });
      nodeStream.on("end", () => controller.close());
      nodeStream.on("error", (err) => controller.error(err));
    },
  });
}

export function unreachable(value: never, logger: Logger = console) {
  let valueAsString;
  try {
    valueAsString = JSON.stringify(value);
  } catch {
    valueAsString = value;
  }
  logger.error(`Unexpected case: ${valueAsString}`);
}

/**
 * Yields to the event loop when the current macrotask has run for too long.
 *
 * An await of an already-resolved promise continues in a microtask, so a loop
 * that drains a backlog of buffered messages never lets timers or I/O run:
 * incoming requests, `session/cancel` among them, wait until the backlog is
 * gone. A loop calls {@link maybeYield} once per item. Within the budget it
 * returns undefined and the loop goes on at once. Past the budget it returns a
 * promise that resolves in the check phase of the event loop, after pending
 * I/O has run.
 *
 * The budget is measured from the first call since the event loop last
 * reached its check phase, so a loop that already waits on real I/O never
 * yields, and all loops that share one instance share the budget of the
 * macrotask that runs them.
 */
export class EventLoopYielder {
  /** Whether a check-phase marker is pending. While it is, the event loop has
   *  not reached its check phase since {@link sliceStart}. */
  private markerPending = false;
  private sliceStart = 0;

  constructor(
    private readonly budgetMs: number,
    private readonly now: () => number = () => performance.now(),
  ) {}

  maybeYield(): Promise<void> | undefined {
    const time = this.now();
    if (!this.markerPending) {
      this.markerPending = true;
      this.sliceStart = time;
      setImmediate(() => {
        this.markerPending = false;
      });
      return undefined;
    }
    if (time - this.sliceStart < this.budgetMs) return undefined;
    return new Promise<void>((resolve) => setImmediate(resolve));
  }
}

/** The longest stretch, in milliseconds, that a message loop keeps the event
 *  loop before it yields. */
const MESSAGE_LOOP_BUDGET_MS = 8;

/** The yielder shared by the loops that forward messages to the client. */
export const messageLoopYielder = new EventLoopYielder(MESSAGE_LOOP_BUDGET_MS);

export function sleep(time: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, time));
}

/** The outcome of {@link raceTimeoutAndAbort}. */
export type RaceOutcome<T> = { type: "done"; value: T } | { type: "timeout" } | { type: "aborted" };

/** Wait for `promise` until `timeoutMs` passes or `signal` aborts. A rejection
 *  of `promise` rejects the result. The timer does not keep the process alive. */
export async function raceTimeoutAndAbort<T>(
  promise: Promise<T>,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<RaceOutcome<T>> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      promise.then((value): RaceOutcome<T> => ({ type: "done", value })),
      new Promise<RaceOutcome<T>>((resolve) => {
        timeout = setTimeout(() => resolve({ type: "timeout" }), timeoutMs);
        timeout.unref?.();
      }),
      new Promise<RaceOutcome<T>>((resolve) => {
        onAbort = () => resolve({ type: "aborted" });
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}
