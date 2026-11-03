import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BACKGROUND_OUTPUT_MAX_BACKLOG_BYTES,
  BACKGROUND_OUTPUT_READ_BYTES,
  type BackgroundOutput,
  BackgroundOutputTail,
} from "../background-output.js";

describe("BackgroundOutputTail", () => {
  let dir: string;
  let file: string;
  let published: BackgroundOutput[];
  let tail: BackgroundOutputTail | undefined;
  const follow = () =>
    (tail = new BackgroundOutputTail(file, async (output) => void published.push(output)));

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "background-output-"));
    file = path.join(dir, "bg1.output");
    published = [];
  });

  afterEach(async () => {
    tail?.stop();
    await rm(dir, { recursive: true, force: true });
  });

  it("replaces the terminal's output with the file's first text, then appends what the file adds", async () => {
    await writeFile(file, "building\n");
    follow();
    await vi.waitFor(() => expect(published).toHaveLength(1), { timeout: 2000 });
    await appendFile(file, "done\n");
    await vi.waitFor(() => expect(published).toHaveLength(2), { timeout: 2000 });

    expect(published).toEqual([
      { text: "building\n", replaces: true },
      { text: "done\n", replaces: false },
    ]);
  });

  it("waits for a file that does not exist yet", async () => {
    follow();
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(published).toEqual([]);

    await writeFile(file, "started\n");
    await vi.waitFor(() => expect(published).toHaveLength(1), { timeout: 2000 });
    expect(published[0]).toEqual({ text: "started\n", replaces: true });
  });

  it("holds a character that a read splits until its last byte is written", async () => {
    const check = Buffer.from("✓", "utf8");
    await writeFile(file, check.subarray(0, 1));
    follow();
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(published).toEqual([]);

    await appendFile(file, check.subarray(1));
    await tail!.finish();
    expect(published).toEqual([{ text: "✓", replaces: true }]);
  });

  it("reads the rest of the file on finish, and nothing after", async () => {
    await writeFile(file, "a");
    follow();
    await appendFile(file, "b");
    await tail!.finish();
    await appendFile(file, "c");
    await new Promise((resolve) => setTimeout(resolve, 700));

    expect(published.map((output) => output.text).join("")).toBe("ab");
  });

  it("sends at most the backlog, read by read, from the file's last bytes as a snapshot", async () => {
    // More than the backlog, written faster than the polls read it.
    const skipped = "x".repeat(BACKGROUND_OUTPUT_MAX_BACKLOG_BYTES);
    const kept = "y".repeat(BACKGROUND_OUTPUT_MAX_BACKLOG_BYTES - 4) + "end\n";
    await writeFile(file, skipped + kept);
    follow();
    await tail!.finish();

    expect(published.map((output) => output.text).join("")).toBe(kept);
    expect(published[0].replaces).toBe(true);
    expect(published.slice(1).every((output) => !output.replaces)).toBe(true);
    expect(
      published.every((output) => Buffer.byteLength(output.text) <= BACKGROUND_OUTPUT_READ_BYTES),
    ).toBe(true);
  });

  it("starts over with a snapshot when the file shrinks", async () => {
    await writeFile(file, "old output\n");
    follow();
    await vi.waitFor(() => expect(published).toHaveLength(1), { timeout: 2000 });
    await writeFile(file, "new\n");
    await tail!.finish();

    expect(published).toEqual([
      { text: "old output\n", replaces: true },
      { text: "new\n", replaces: true },
    ]);
  });

  it("replaces the placeholder with an empty output when the command wrote nothing", async () => {
    await writeFile(file, "");
    follow();
    await tail!.finish();

    expect(published).toEqual([{ text: "", replaces: true }]);
  });

  it("publishes nothing on finish when the file never appeared", async () => {
    follow();
    await tail!.finish();

    expect(published).toEqual([]);
  });

  it("reads nothing after stop", async () => {
    follow();
    tail!.stop();
    await writeFile(file, "late\n");
    await new Promise((resolve) => setTimeout(resolve, 700));

    expect(published).toEqual([]);
  });
});
