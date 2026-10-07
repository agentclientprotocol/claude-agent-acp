import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as diff from "diff";
import { clearDiffMemo, patchUpdateFromDiffToolResponse, previewPatchContent } from "../diff.js";

vi.mock("diff", async (importOriginal) => {
  const original = await importOriginal<typeof import("diff")>();
  return { ...original, structuredPatch: vi.fn(original.structuredPatch) };
});

const structuredPatch = vi.mocked(diff.structuredPatch);
const tempDirectories: string[] = [];

beforeEach(() => {
  clearDiffMemo();
  structuredPatch.mockClear();
});

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

async function temporaryFile(content: string): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "claude-acp-diff-memo-"));
  tempDirectories.push(directory);
  const filePath = path.join(directory, "file.txt");
  await writeFile(filePath, content);
  return filePath;
}

function patchText(content: unknown): string {
  const block = Array.isArray(content) ? content[0] : content;
  return (block._meta as any).jetbrains.air.diffPatch.text;
}

const before = Array.from({ length: 2000 }, (_, i) => `line ${i}\n`).join("");
const after = before.replace("line 1000\n", "line one thousand\n");

describe("line diff reuse between the approval and the PostToolUse hook", () => {
  it("diffs an Edit once and gives the hook the same patch", async () => {
    const filePath = await temporaryFile(before);
    const preview = await previewPatchContent("Edit", {
      file_path: filePath,
      old_string: "line 1000\n",
      new_string: "line one thousand\n",
    });
    expect(structuredPatch).toHaveBeenCalledTimes(1);

    await writeFile(filePath, after);
    const hook = await patchUpdateFromDiffToolResponse({
      filePath,
      originalFile: before,
      oldString: "line 1000\n",
    });

    expect(structuredPatch).toHaveBeenCalledTimes(1);
    expect(patchText(hook!.content)).toBe(patchText(preview));
    expect(hook!.locations).toEqual([{ path: filePath, line: 998 }]);
  });

  it("diffs again when the written file differs from the preview", async () => {
    const filePath = await temporaryFile(before);
    await previewPatchContent("Edit", {
      file_path: filePath,
      old_string: "line 1000\n",
      new_string: "line one thousand\n",
    });
    const written = before.replace("line 1000\n", "line 1000 changed later\n");
    await writeFile(filePath, written);

    const hook = await patchUpdateFromDiffToolResponse({ filePath, originalFile: before });

    expect(structuredPatch).toHaveBeenCalledTimes(2);
    expect(patchText(hook!.content)).toContain("+line 1000 changed later\n");
  });

  it("diffs again after a diff that ran out of its budget", async () => {
    structuredPatch.mockImplementationOnce(() => undefined as never);
    const filePath = await temporaryFile(before);
    const input = { file_path: filePath, content: after };

    const first = await previewPatchContent("Write", input);
    const second = await previewPatchContent("Write", input);

    expect(structuredPatch).toHaveBeenCalledTimes(2);
    // Without a patch, the approval falls back to the standard diff.
    expect(first).toEqual([{ type: "diff", path: filePath, oldText: before, newText: after }]);
    // The second diff completes and gets the exact patch.
    expect(patchText(second)).toContain("+line one thousand\n");
  });

  it("keeps only a few recent diffs, each until it is read again", async () => {
    const filePath = await temporaryFile(before);
    const write = (i: number) =>
      previewPatchContent("Write", { file_path: filePath, content: `${before}tail ${i}\n` });
    for (let i = 0; i < 6; i++) await write(i);
    expect(structuredPatch).toHaveBeenCalledTimes(6);
    // The most recent diffs are kept; the oldest were pushed out.
    await write(5);
    expect(structuredPatch).toHaveBeenCalledTimes(6);
    await write(0);
    expect(structuredPatch).toHaveBeenCalledTimes(7);
    // A diff that was read again is gone.
    await write(5);
    expect(structuredPatch).toHaveBeenCalledTimes(8);
  });
});
