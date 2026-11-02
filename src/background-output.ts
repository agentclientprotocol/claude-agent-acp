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
 * Text that the file adds. The first is a snapshot that replaces the
 * terminal's output so far, the placeholder of the Bash result. Each later
 * one appends to it.
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
  private readonly decoder = new StringDecoder("utf8");
  private replaced = false;
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

  private read(toEnd: boolean): Promise<void> {
    this.reading = this.reading.then(async () => {
      if (this.stopped) return;
      let text = "";
      try {
        const file = await open(this.path, "r");
        try {
          do {
            const buffer = Buffer.alloc(BACKGROUND_OUTPUT_READ_BYTES);
            const { bytesRead } = await file.read(buffer, 0, buffer.length, this.offset);
            if (bytesRead === 0) break;
            this.offset += bytesRead;
            text += this.decoder.write(buffer.subarray(0, bytesRead));
          } while (toEnd);
        } finally {
          await file.close();
        }
      } catch {
        // Nothing written yet, or the file is gone: try again at the next
        // poll. At the end, the terminal keeps the output it has.
        return;
      }
      // At the end, a sequence that the command cut off is replaced, not held.
      if (toEnd) text += this.decoder.end();
      if (text === "" && (this.replaced || !toEnd)) return;
      const replaces = !this.replaced;
      this.replaced = true;
      await this.publish({ text, replaces });
    });
    return this.reading;
  }
}
