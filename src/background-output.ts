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
