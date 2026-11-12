/**
 * The output of a command that went to the background, read from the file
 * that Claude Code writes it to. Claude Code streams no output of such a
 * command, so its display terminal would show only the placeholder of the
 * Bash result ("Command running in background with ID …") until the command
 * exits. ACP v2 asks an Agent to keep a listed terminal's output current
 * whenever it can read it (the v2 prompt lifecycle, "Background work").
 *
 * The file is polled: watching a file is not reliable on every platform, and
 * a missing file only means that nothing was written yet.
 */
import { open } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";

/** How often a running command's output file is read. */
export const BACKGROUND_OUTPUT_POLL_MS = 500;

/** The most bytes one read takes, so a burst of output does not block the loop. */
export const BACKGROUND_OUTPUT_READ_BYTES = 256 * 1024;

/**
 * The most unread bytes that are still sent. A command that writes faster
 * than the polls read falls behind. Past this, the reads skip to the file's
 * last bytes, as a snapshot: a terminal shows the latest output, and a
 * client keeps a bounded amount of it anyway.
 */
export const BACKGROUND_OUTPUT_MAX_BACKLOG_BYTES = 1024 * 1024;

/**
 * Text that the file adds. A snapshot replaces the terminal's output so far:
 * the first one replaces the placeholder of the Bash result, and a later one
 * follows a skip or a file that shrank. Other text appends to it.
 */
export type BackgroundOutput = { text: string; replaces: boolean };

/**
 * Follows the output file `path` of one background command and hands each
 * piece of new text to `publish`, in order. Reads never overlap. A read that
 * fails, for example because the file does not exist yet, is tried again at
 * the next poll. `publish` must not reject: the next read waits for it.
 */
export class BackgroundOutputTail {
  private offset = 0;
  private decoder = new StringDecoder("utf8");
  /** Whether the next text replaces the terminal's output. */
  private replaces = true;
  private stopped = false;
  private reading: Promise<void> = Promise.resolve();
  private readonly timer: ReturnType<typeof setInterval>;

  constructor(
    private readonly path: string,
    private readonly publish: (output: BackgroundOutput) => Promise<void>,
  ) {
    this.timer = setInterval(() => void this.read(false), BACKGROUND_OUTPUT_POLL_MS);
    // A command that runs on must not keep the agent process alive.
    this.timer.unref();
  }

  /**
   * Reads the rest of the file and stops. The command ended, so what the file
   * holds is its whole output, and it goes out before the terminal's exit.
   */
  async finish(): Promise<void> {
    clearInterval(this.timer);
    await this.read(true);
    this.stopped = true;
  }

  /** Stops without reading more: the session ended. */
  stop(): void {
    clearInterval(this.timer);
    this.stopped = true;
  }

  /**
   * Reads what the file adds, one read of at most
   * {@link BACKGROUND_OUTPUT_READ_BYTES} at a time, and publishes each read's
   * text before the next. `toEnd` reads until the end of the file, and ends a
   * character that the command cut off with a replacement character.
   */
  private read(toEnd: boolean): Promise<void> {
    this.reading = this.reading.then(async () => {
      if (this.stopped) return;
      let file;
      try {
        file = await open(this.path, "r");
      } catch {
        // Nothing written yet, or the file is gone: try again at the next
        // poll. At the end, the terminal keeps the output it has.
        return;
      }
      try {
        const { size } = await file.stat();
        // A file that shrank is a new one: its output starts over. Past the
        // backlog, the reads skip to the file's last bytes.
        const start = size < this.offset ? 0 : this.offset;
        const skipTo = Math.max(start, size - BACKGROUND_OUTPUT_MAX_BACKLOG_BYTES);
        if (skipTo !== this.offset) {
          this.offset = skipTo;
          this.decoder = new StringDecoder("utf8");
          this.replaces = true;
        }
        const buffer = Buffer.alloc(BACKGROUND_OUTPUT_READ_BYTES);
        let bytesRead: number;
        do {
          ({ bytesRead } = await file.read(buffer, 0, buffer.length, this.offset));
          this.offset += bytesRead;
          const text = this.decoder.write(buffer.subarray(0, bytesRead));
          if (text !== "") await this.send(text);
        } while (toEnd && bytesRead > 0);
        if (toEnd) {
          const rest = this.decoder.end();
          // A command that wrote nothing still replaces the placeholder.
          if (rest !== "" || this.replaces) await this.send(rest);
        }
      } catch {
        // The read failed: try again at the next poll.
      } finally {
        await file.close();
      }
    });
    return this.reading;
  }

  private async send(text: string): Promise<void> {
    const replaces = this.replaces;
    this.replaces = false;
    await this.publish({ text, replaces });
  }
}

/** What Claude Code's `get_task_output` returns: the end of a shell task's output. */
export interface TaskOutput {
  /** At most the last 8 KiB of the output, decoded as UTF-8. */
  output: string;
  /** The size of the whole output in bytes. */
  total_bytes: number;
  /** Whether `output` holds only the end of the output. */
  truncated: boolean;
}

/**
 * The most bytes at the start of a truncated `output` that may not match the
 * command's bytes: a character that the 8 KiB cut split decodes as U+FFFD.
 */
const CUT_CHARACTER_BYTES = 4;

/**
 * Follows the output of a command that runs in the foreground, read with
 * `read` (Claude Code's `get_task_output`), and hands each piece of new text
 * to `publish`, in order. Claude Code streams no output of a foreground Bash
 * command either: its `tool_progress` carries only the elapsed time, and the
 * output arrives in the tool result. Claude Code writes the output to its task
 * before then, and `get_task_output` reads it, though the task's
 * `task_started` names no output file.
 *
 * The new text is the output past the bytes already sent. When `output` does
 * not hold all of it, or its bytes may not match the command's (not UTF-8),
 * the whole `output` replaces the terminal's output, as a snapshot. A read
 * that ends in U+FFFD may have cut a character that the command is still
 * writing, so it is sent only at the next read. A read that fails is tried
 * again at the next poll. Reads never overlap. `publish` must not reject.
 */
export class TaskOutputPoll {
  private sentBytes = 0;
  private sent = false;
  private stopped = false;
  private reading: Promise<void> = Promise.resolve();
  private readonly timer: ReturnType<typeof setInterval>;

  constructor(
    private readonly read: () => Promise<TaskOutput>,
    private readonly publish: (output: BackgroundOutput) => Promise<void>,
  ) {
    this.timer = setInterval(() => void this.poll(), BACKGROUND_OUTPUT_POLL_MS);
    // A command that runs on must not keep the agent process alive.
    this.timer.unref();
  }

  /**
   * Stops, once a read in progress has published its text. Returns whether
   * any text was published: the tool result then replaces it with the whole
   * output, which a read in progress may have missed the end of.
   */
  async finish(): Promise<boolean> {
    this.stop();
    await this.reading;
    return this.sent;
  }

  /**
   * Stops now and returns whether any text was published, for a caller that
   * cannot wait for a read in progress (the v2 tool result path is
   * synchronous). A read in progress publishes nothing after this: `poll`
   * checks `stopped` after its read and calls `publish` in the same
   * synchronous step.
   */
  end(): boolean {
    this.stop();
    return this.sent;
  }

  /** Stops without waiting: the session ended. */
  stop(): void {
    clearInterval(this.timer);
    this.stopped = true;
  }

  private poll(): Promise<void> {
    this.reading = this.reading.then(async () => {
      if (this.stopped) return;
      let read: TaskOutput;
      try {
        read = await this.read();
      } catch {
        return;
      }
      const output = this.newText(read);
      if (this.stopped || output === undefined) return;
      this.sentBytes = read.total_bytes;
      this.sent = true;
      await this.publish(output);
    });
    return this.reading;
  }

  /** The text that `read` adds to what was sent, or undefined when it adds none yet. */
  private newText({ output, total_bytes, truncated }: TaskOutput): BackgroundOutput | undefined {
    if (total_bytes === this.sentBytes || output.endsWith("�")) return undefined;
    const bytes = Buffer.from(output, "utf8");
    const added = total_bytes - this.sentBytes;
    const exact = truncated
      ? added <= bytes.length - CUT_CHARACTER_BYTES
      : bytes.length === total_bytes;
    // `sentBytes` ends a read that ended in a whole character, so the cut is
    // at a character boundary.
    if (added > 0 && exact) {
      return { text: bytes.subarray(bytes.length - added).toString("utf8"), replaces: false };
    }
    return { text: output, replaces: true };
  }
}

/**
 * Claude Code's `get_task_output` on the SDK's query. Like `mcpAuthenticate`,
 * it is on the query object but not in the public `Query` declaration yet,
 * though the SDK types its control request (`SDKControlGetTaskOutputRequest`).
 */
export type TaskOutputQuery = { getTaskOutput(taskId: string): Promise<TaskOutput> };

export function supportsTaskOutput<T extends object>(query: T): query is T & TaskOutputQuery {
  return typeof (query as Partial<TaskOutputQuery>).getTaskOutput === "function";
}
