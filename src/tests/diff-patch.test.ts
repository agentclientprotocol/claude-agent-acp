import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  creationPatchContent,
  gitPatchText,
  MAX_PATCH_FILE_BYTES,
  patchUpdateFromDiffToolResponse,
  previewPatchContent,
  toolUpdateFromDiffToolResponse,
} from "../diff.js";

const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

async function temporaryFile(content?: string | Buffer, name = "file.ts"): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "claude-acp-patch-"));
  tempDirectories.push(directory);
  const filePath = path.join(directory, name);
  if (content !== undefined) await writeFile(filePath, content);
  return filePath;
}

function patchText(content: unknown): string {
  const block = Array.isArray(content) ? content[0] : content;
  if (!block || block.type !== "diff") throw new Error("Expected diff content");
  return (block._meta as any).jetbrains.air.diffPatch.text;
}

/** The header name that git writes for an absolute path. */
function gitName(filePath: string): string {
  return filePath.replace(/^\/+/u, "");
}

describe("approval patch previews", () => {
  it("builds a compact approval patch from a 12000-line file", async () => {
    const lines = Array.from({ length: 12_000 }, (_, index) => `line ${index + 1}`);
    const filePath = await temporaryFile(`${lines.join("\n")}\n`);
    const content = await previewPatchContent("Edit", {
      file_path: filePath,
      old_string: "line 6000\n",
      new_string: "changed line\n",
    });

    expect(content?.[0]).toMatchObject({ type: "diff", oldText: null, newText: "" });
    expect(patchText(content)).toBe(
      [
        `diff --git a/${gitName(filePath)} b/${gitName(filePath)}`,
        `--- a/${gitName(filePath)}`,
        `+++ b/${gitName(filePath)}`,
        "@@ -5997,7 +5997,7 @@",
        " line 5997",
        " line 5998",
        " line 5999",
        "-line 6000",
        "+changed line",
        " line 6001",
        " line 6002",
        " line 6003",
        "",
      ].join("\n"),
    );
  });

  it("builds an approval patch for every replace_all occurrence", async () => {
    const filePath = await temporaryFile("old\nmiddle\nold\n");
    const patch = patchText(
      await previewPatchContent("Edit", {
        file_path: filePath,
        old_string: "old",
        new_string: "new",
        replace_all: true,
      }),
    );

    expect(patch.match(/^-old$/gmu)).toHaveLength(2);
    expect(patch.match(/^\+new$/gmu)).toHaveLength(2);
  });

  it("builds update and creation approval patches for Write", async () => {
    const existing = await temporaryFile("before\n");
    const missing = await temporaryFile();

    const update = patchText(
      await previewPatchContent("Write", { file_path: existing, content: "after\n" }),
    );
    const creation = patchText(
      await previewPatchContent("Write", { file_path: missing, content: "created\n" }),
    );

    expect(update).toContain("-before\n+after\n");
    expect(creation).toBe(
      [
        `diff --git a/${gitName(missing)} b/${gitName(missing)}`,
        "new file mode 100644",
        "--- /dev/null",
        `+++ b/${gitName(missing)}`,
        "@@ -0,0 +1 @@",
        "+created",
        "",
      ].join("\n"),
    );
  });

  it("returns no preview when the patch would not be exact", async () => {
    const duplicate = await temporaryFile("same\nsame\n");
    const missing = await temporaryFile();
    const crlf = await temporaryFile("one\r\ntwo\r\n");
    const binary = await temporaryFile(Buffer.from([0x61, 0x00, 0x62, 0x0a]));
    const large = await temporaryFile(`${"x".repeat(MAX_PATCH_FILE_BYTES)}\n`);
    const unchanged = await temporaryFile("before\n");

    const previews = await Promise.all([
      previewPatchContent("Edit", { file_path: duplicate, old_string: "same", new_string: "n" }),
      previewPatchContent("Edit", { file_path: missing, old_string: "a", new_string: "b" }),
      previewPatchContent("Edit", { file_path: crlf, old_string: "one", new_string: "1" }),
      previewPatchContent("Edit", { file_path: binary, old_string: "a", new_string: "c" }),
      previewPatchContent("Edit", { file_path: large, old_string: "x", new_string: "y" }),
      previewPatchContent("Edit", { file_path: unchanged, old_string: "b", new_string: "b" }),
      previewPatchContent("Edit", { file_path: unchanged, old_string: "", new_string: "b" }),
      previewPatchContent("Write", { file_path: crlf, content: "one\n" }),
      previewPatchContent("Write", { file_path: unchanged, content: "before\n" }),
      previewPatchContent("Write", { file_path: missing, content: "a\r\nb\r\n" }),
    ]);

    expect(previews).toEqual(Array(previews.length).fill(undefined));
  });

  it("builds a creation patch for an Edit with an empty old_string", async () => {
    const missing = await temporaryFile();
    const empty = await temporaryFile("");

    const creation = patchText(
      await previewPatchContent("Edit", { file_path: missing, old_string: "", new_string: "a\n" }),
    );
    const fill = patchText(
      await previewPatchContent("Edit", { file_path: empty, old_string: "", new_string: "a\n" }),
    );

    expect(creation).toContain("new file mode 100644\n--- /dev/null\n");
    expect(creation).toContain("@@ -0,0 +1 @@\n+a\n");
    expect(fill).toContain(`--- a/${gitName(empty)}\n+++ b/${gitName(empty)}\n@@ -0,0 +1 @@\n`);
  });

  it("keeps the missing final newline marker", async () => {
    const filePath = await temporaryFile("a\nb");
    const patch = patchText(
      await previewPatchContent("Edit", { file_path: filePath, old_string: "b", new_string: "c" }),
    );

    expect(patch).toContain("-b\n\\ No newline at end of file\n+c\n\\ No newline at end of file\n");
  });

  it("strips trailing whitespace from new text like Claude, except in Markdown", async () => {
    const code = await temporaryFile("a\nb\n");
    const markdown = await temporaryFile("a\nb\n", "notes.md");
    const missing = await temporaryFile();

    const edit = patchText(
      await previewPatchContent("Edit", {
        file_path: code,
        old_string: "b",
        new_string: "c  \nd\t",
      }),
    );
    const markdownEdit = patchText(
      await previewPatchContent("Edit", {
        file_path: markdown,
        old_string: "b",
        new_string: "c  ",
      }),
    );
    const write = patchText(
      await previewPatchContent("Write", { file_path: missing, content: "x \ny\u00a0\n" }),
    );

    expect(edit).toContain("-b\n+c\n+d\n");
    expect(markdownEdit).toContain("-b\n+c  \n");
    expect(write).toContain("@@ -0,0 +1,2 @@\n+x\n+y\n");
    expect(patchText(creationPatchContent(missing, "x \ny\u00a0\n"))).toBe(write);
    // Claude does not normalize the Edit input of a file that it cannot read.
    expect(
      patchText(
        await previewPatchContent("Edit", {
          file_path: missing,
          old_string: "",
          new_string: "x \n",
        }),
      ),
    ).toContain("+x \n");
  });

  it("declines a preview when only whitespace would change", async () => {
    const code = await temporaryFile("a \n");

    expect(
      await previewPatchContent("Edit", { file_path: code, old_string: "a", new_string: "a  " }),
    ).toBeUndefined();
    expect(await previewPatchContent("Write", { file_path: code, content: "a \n" })).toBeDefined();
    expect(await previewPatchContent("Write", { file_path: code, content: "a\n" })).toBeDefined();
  });

  it("declines a normalized preview for a path that Claude may not normalize", async () => {
    const filePath = await temporaryFile("a\n");
    // POSIX reads `//dir` as `/dir`, but Claude takes it for a UNC path.
    const uncLike = `/${filePath}`;

    expect(
      await previewPatchContent("Edit", { file_path: uncLike, old_string: "a", new_string: "b " }),
    ).toBeUndefined();
    expect(
      await previewPatchContent("Edit", { file_path: uncLike, old_string: "a", new_string: "b" }),
    ).toBeDefined();
  });

  it("removes the line break of a line that an empty new_string deletes", async () => {
    const filePath = await temporaryFile("keep\ndrop\nkeep\n");
    const repeated = await temporaryFile("x\nx");

    const patch = patchText(
      await previewPatchContent("Edit", {
        file_path: filePath,
        old_string: "drop",
        new_string: "",
      }),
    );
    // Only the occurrence that a line break follows goes with replace_all.
    const all = patchText(
      await previewPatchContent("Edit", {
        file_path: repeated,
        old_string: "x",
        new_string: "",
        replace_all: true,
      }),
    );

    expect(patch).toContain("@@ -1,3 +1,2 @@\n keep\n-drop\n keep\n");
    expect(all).toContain("@@ -1,2 +1 @@\n-x\n x\n");
  });
});

describe("git patch headers", () => {
  const hunk = { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ["-a", "+b"] };

  it("strips the leading slash and converts Windows separators", () => {
    expect(gitPatchText("/work/src/App.ts", "update", [hunk])).toMatch(
      /^diff --git a\/work\/src\/App\.ts b\/work\/src\/App\.ts\n--- a\/work\/src\/App\.ts\n\+\+\+ b\/work\/src\/App\.ts\n/u,
    );
    expect(gitPatchText("C:\\work\\App.ts", "update", [hunk])).toContain(
      "diff --git a/C:/work/App.ts b/C:/work/App.ts\n",
    );
  });

  it("quotes names like git and marks names with a space", () => {
    expect(gitPatchText('/work/a"b.ts', "update", [hunk])).toContain(
      'diff --git "a/work/a\\"b.ts" "b/work/a\\"b.ts"\n--- "a/work/a\\"b.ts"\n',
    );
    expect(gitPatchText("/work/é.ts", "update", [hunk])).toContain(
      'diff --git "a/work/\\303\\251.ts" "b/work/\\303\\251.ts"\n',
    );
    expect(gitPatchText("/work/my file.ts", "update", [hunk])).toContain(
      "diff --git a/work/my file.ts b/work/my file.ts\n--- a/work/my file.ts\t\n+++ b/work/my file.ts\t\n",
    );
  });

  it("writes created and deleted file headers", () => {
    expect(gitPatchText("/f", "create", [{ ...hunk, oldLines: 0, lines: ["+b"] }])).toBe(
      "diff --git a/f b/f\nnew file mode 100644\n--- /dev/null\n+++ b/f\n@@ -0,0 +1 @@\n+b\n",
    );
    expect(gitPatchText("/f", "delete", [{ ...hunk, newLines: 0, lines: ["-a"] }])).toBe(
      "diff --git a/f b/f\ndeleted file mode 100644\n--- a/f\n+++ /dev/null\n@@ -1 +0,0 @@\n-a\n",
    );
  });

  it("uses one header form for previews, tool calls, and hook patches", async () => {
    const filePath = await temporaryFile();
    const preview = patchText(
      await previewPatchContent("Write", { file_path: filePath, content: "x\n" }),
    );
    const toolCall = patchText(creationPatchContent(filePath, "x\n"));
    await writeFile(filePath, "x\n");
    const hook = patchText(
      (
        await patchUpdateFromDiffToolResponse({
          type: "create",
          filePath,
          content: "x\n",
          structuredPatch: [],
          originalFile: null,
        })
      )?.content,
    );

    expect(toolCall).toBe(preview);
    expect(hook).toBe(preview);
  });
});

describe("PostToolUse hook patches", () => {
  it("builds the patch from the written file, not from display hunks", async () => {
    const filePath = await temporaryFile("\tkeep\n\told\n");
    await writeFile(filePath, "\tkeep\n\tnew\n");

    const result = await patchUpdateFromDiffToolResponse({
      filePath,
      oldString: "\told",
      newString: "\tnew",
      originalFile: "\tkeep\n\told\n",
      // Claude converts leading tabs to spaces in structuredPatch.
      structuredPatch: [
        {
          oldStart: 1,
          oldLines: 2,
          newStart: 1,
          newLines: 2,
          lines: ["   keep", "-  old", "+  new"],
        },
      ],
    });

    expect(result?.locations).toEqual([{ path: filePath, line: 1 }]);
    expect(patchText(result?.content)).toContain("@@ -1,2 +1,2 @@\n \tkeep\n-\told\n+\tnew\n");
  });

  it("builds a creation patch for a Write that created the file", async () => {
    const filePath = await temporaryFile("a\nb");

    const result = await patchUpdateFromDiffToolResponse({
      type: "create",
      filePath,
      content: "a\nb",
      structuredPatch: [],
      originalFile: null,
    });

    expect(patchText(result?.content)).toBe(
      [
        `diff --git a/${gitName(filePath)} b/${gitName(filePath)}`,
        "new file mode 100644",
        "--- /dev/null",
        `+++ b/${gitName(filePath)}`,
        "@@ -0,0 +1,2 @@",
        "+a",
        "+b",
        "\\ No newline at end of file",
        "",
      ].join("\n"),
    );
  });

  it("declines a patch that it cannot build exactly", async () => {
    const crlf = await temporaryFile("a\r\nc\r\n");
    const missing = await temporaryFile();
    const changed = await temporaryFile("other\n");

    const results = await Promise.all([
      patchUpdateFromDiffToolResponse({ filePath: crlf, originalFile: "a\nb\n" }),
      patchUpdateFromDiffToolResponse({ filePath: missing, originalFile: "a\n" }),
      patchUpdateFromDiffToolResponse({ type: "update", filePath: changed, originalFile: null }),
      patchUpdateFromDiffToolResponse({ type: "create", filePath: changed, content: "x\n" }),
      patchUpdateFromDiffToolResponse({ filePath: changed, originalFile: "other\n" }),
    ]);

    expect(results).toEqual(Array(results.length).fill(undefined));
  });

  it("leaves a created file to the tool-call content in the standard mapping", () => {
    expect(
      toolUpdateFromDiffToolResponse({
        type: "create",
        filePath: "/file.ts",
        content: "a\n",
        structuredPatch: [],
        originalFile: null,
      }),
    ).toEqual({});
  });
});
