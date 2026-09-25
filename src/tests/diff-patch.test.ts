import { ClientCapabilities } from "../tool-calls/client-capabilities.js";
import { applyPatch } from "diff";
import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  gitPatchText,
  MAX_PATCH_FILE_BYTES,
  patchUpdateFromDiffToolResponse,
  previewPatchContent,
  toolUpdateFromDiffToolResponse,
} from "../diff.js";
import { buildClaudePermissionPresentation } from "../permissions/presentation.js";
import { toolInfoFromToolUse } from "../tools.js";
import { WriteReporter } from "../tool-calls/reporters/file-edit.js";

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

  it("reads the Write alias keys that the CLI accepts", async () => {
    const existing = await temporaryFile("before\n");

    for (const input of [
      { path: existing, content: "after\n" },
      { file_path: existing, file_text: "after\n" },
      { path: existing, file_content: "after\n" },
    ]) {
      expect(patchText(await previewPatchContent("Write", input))).toContain("-before\n+after\n");
    }
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
      previewPatchContent("Write", { file_path: unchanged, content: "before\n" }),
    ]);

    expect(previews).toEqual(Array(previews.length).fill(undefined));
    // A Write always shows what it changes: a notice for a file that the
    // adapter cannot show, and the standard diff of a text without an exact patch.
    expect(await previewPatchContent("Write", { file_path: crlf, content: "one\n" })).toMatchObject(
      [{ type: "content" }],
    );
    expect(
      await previewPatchContent("Write", { file_path: missing, content: "a\r\nb\r\n" }),
    ).toEqual([{ type: "diff", path: missing, oldText: null, newText: "a\r\nb\r\n" }]);
  });

  it("returns no preview when a replace_all result can exceed the size limit", async () => {
    const longText = "b".repeat(4096);
    const small = await temporaryFile(`${"a".repeat(200)}\n`);
    const over = await temporaryFile(`${"a".repeat(512)}\n`);
    // Each of 1 MiB matches grows by 4 KiB: an unguarded replacement builds
    // 4 GiB before the line diff starts.
    const huge = await temporaryFile("a".repeat(MAX_PATCH_FILE_BYTES));

    const edit = (file_path: string) =>
      previewPatchContent("Edit", {
        file_path,
        old_string: "a",
        new_string: longText,
        replace_all: true,
      });

    expect(await edit(small)).toBeDefined();
    expect(await edit(over)).toBeUndefined();
    expect(await edit(huge)).toBeUndefined();
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

  it("marks the final newline of a Write that changes only that newline", async () => {
    const added = await temporaryFile("same");
    const removed = await temporaryFile("same\n");

    expect(
      patchText(await previewPatchContent("Write", { file_path: added, content: "same\n" })),
    ).toContain("@@ -1 +1 @@\n-same\n\\ No newline at end of file\n+same\n");
    expect(
      patchText(await previewPatchContent("Write", { file_path: removed, content: "same" })),
    ).toContain("@@ -1 +1 @@\n-same\n+same\n\\ No newline at end of file\n");
    // The PostToolUse hook builds the same patch from the written file.
    await writeFile(added, "same\n");
    const hook = await patchUpdateFromDiffToolResponse({
      type: "update",
      filePath: added,
      content: "same\n",
      originalFile: "same",
      structuredPatch: [],
    });
    expect(patchText(hook?.content)).toContain(
      "@@ -1 +1 @@\n-same\n\\ No newline at end of file\n+same\n",
    );
  });

  it("uses the tool input as it is", async () => {
    const code = await temporaryFile("a\nb\n");
    const missing = await temporaryFile();

    const edit = patchText(
      await previewPatchContent("Edit", { file_path: code, old_string: "b", new_string: "c  " }),
    );
    const write = patchText(
      await previewPatchContent("Write", { file_path: missing, content: "x \ny\n" }),
    );

    expect(edit).toContain("-b\n+c  \n");
    expect(write).toContain("@@ -0,0 +1,2 @@\n+x \n+y\n");
  });

  it("builds the patch of a Write that changes hundreds of lines of a large file", async () => {
    const lines = Array.from({ length: 5000 }, (_, index) => `line ${index}\n`);
    const oldText = lines.join("");
    const newText = lines
      .map((line, index) => (index % 25 === 0 ? `changed ${index}\n` : line))
      .join("");
    const filePath = await temporaryFile(oldText);

    const started = performance.now();
    const patch = patchText(
      await previewPatchContent("Write", { file_path: filePath, content: newText }),
    );

    // 200 changed lines. The async diff ran out of its 500 ms budget here.
    expect(performance.now() - started).toBeLessThan(1000);
    expect(applyPatch(oldText, patch)).toBe(newText);
  });

  it("builds patches that turn the old text into the new text", async () => {
    let seed = 7;
    const random = (limit: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % limit;
    };
    for (let round = 0; round < 200; round++) {
      const oldLines = Array.from({ length: random(40) }, () => `v${random(4)}\n`);
      const newLines = [...oldLines];
      for (let edit = random(4); edit >= 0; edit--) {
        const at = random(newLines.length + 1);
        if (random(2) === 0) newLines.splice(at, 1);
        else newLines.splice(at, 0, `n${random(4)}\n`);
      }
      const oldText = oldLines.join("") + (random(3) === 0 ? "tail" : "");
      const newText = newLines.join("") + (random(3) === 0 ? "tail" : "");
      if (oldText === newText || oldText === "" || newText === "") continue;
      const filePath = await temporaryFile(oldText);

      const content = await previewPatchContent("Write", { file_path: filePath, content: newText });

      expect(applyPatch(oldText, patchText(content)), `round ${round}`).toBe(newText);
    }
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

  it("sends no content when there is no preview", async () => {
    const missing = await temporaryFile();
    const input = { file_path: missing, old_string: "old", new_string: "new" };
    const presentation = buildClaudePermissionPresentation({
      toolName: "Edit",
      input,
      toolUseID: "tool-edit",
      capabilities: new ClientCapabilities(false, false, true, {
        client: true,
        rawInputRendering: false,
        planFile: false,
      }),
      previewContent: await previewPatchContent("Edit", input),
    });

    // The tool_call already carries the standard diff.
    expect(presentation.toolCall.content).toBeUndefined();
    expect(presentation.toolCall.rawInput).toEqual({ file_path: missing });
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

  it("writes a created file header", () => {
    expect(gitPatchText("/f", "create", [{ ...hunk, oldLines: 0, lines: ["+b"] }])).toBe(
      "diff --git a/f b/f\nnew file mode 100644\n--- /dev/null\n+++ b/f\n@@ -0,0 +1 @@\n+b\n",
    );
  });

  it("uses one header form for previews and hook patches", async () => {
    const filePath = await temporaryFile();
    const preview = patchText(
      await previewPatchContent("Write", { file_path: filePath, content: "x\n" }),
    );
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

    expect(hook).toBe(preview);
  });
});

describe("tool-call diff content", () => {
  it("sends the standard diff for an Edit snippet in both modes", () => {
    const toolUse = {
      id: "edit",
      name: "Edit",
      input: { file_path: "/work/a.ts", old_string: "old", new_string: "new" },
    };
    const standard = [{ type: "diff", path: "/work/a.ts", oldText: "old", newText: "new" }];

    expect(toolInfoFromToolUse(toolUse, false, undefined, true).content).toEqual(standard);
    expect(toolInfoFromToolUse(toolUse, false, undefined, false).content).toEqual(standard);
  });

  it("sends a Write diff at tool use only to a client without diffPatch", () => {
    const toolUse = {
      id: "write",
      name: "Write",
      input: { file_path: "/work/a.ts", content: "a\n" },
    };

    // The input does not tell whether the file exists. The patch comes from the
    // approval preview or from the PostToolUse hook.
    expect(toolInfoFromToolUse(toolUse, false, undefined, true).content).toEqual([]);
    expect(toolInfoFromToolUse(toolUse, false, undefined, false).content).toEqual([
      { type: "diff", path: "/work/a.ts", oldText: null, newText: "a\n" },
    ]);
  });
});

describe("Write tool calls for an existing file", () => {
  const air = new ClientCapabilities(false, false, true, {
    client: true,
    rawInputRendering: false,
    planFile: false,
  });

  it("does not read the file at tool use", async () => {
    const filePath = await temporaryFile("before\n");
    const toolUse = {
      id: "write",
      name: "Write",
      input: { file_path: filePath, content: "after\n" },
    };

    expect(toolInfoFromToolUse(toolUse, false, undefined, true).content).toEqual([]);
  });

  it("shows the standard diff in the approval of a Write whose diff exceeds the budget", async () => {
    // Every line changes, so the line diff runs out of its time budget.
    const oldText = Array.from({ length: 20_000 }, (_, index) => `old ${index}\n`).join("");
    const newText = Array.from({ length: 20_000 }, (_, index) => `new ${index}\n`).join("");
    const filePath = await temporaryFile(oldText);

    const preview = await previewPatchContent("Write", { file_path: filePath, content: newText });

    expect(preview).toBeDefined();
    expect(preview!.length).toBeGreaterThan(0);
  });

  it("sends no hook patch when the previous text is larger than the limit", async () => {
    const filePath = await temporaryFile("small\n");

    const result = await patchUpdateFromDiffToolResponse({
      type: "update",
      filePath,
      content: "small\n",
      structuredPatch: [],
      originalFile: "x".repeat(MAX_PATCH_FILE_BYTES + 1),
    });

    expect(result).toBeUndefined();
  });

  it("shows a created file that cannot have a patch in the hook result", async () => {
    // No approval ran, and CRLF text has no exact patch, so the hook is the
    // only report that shows the created file.
    const filePath = await temporaryFile("a\r\nb\r\n");
    const result = await new WriteReporter().hookResult(
      { type: "create", filePath, content: "a\r\nb\r\n", structuredPatch: [], originalFile: null },
      { capabilities: air },
    );

    expect(result.content).toEqual([
      { type: "diff", path: filePath, oldText: null, newText: "a\r\nb\r\n" },
    ]);
  });

  it("shows in the approval that the Write overwrites a file whose text is unknown", async () => {
    const filePath = await temporaryFile(Buffer.from([0x61, 0x00, 0x62, 0x0a]));
    const input = { file_path: filePath, content: "text\n" };
    const presentation = buildClaudePermissionPresentation({
      toolName: "Write",
      input,
      toolUseID: "write",
      capabilities: air,
      previewContent: await previewPatchContent("Write", input),
    });

    expect(presentation.toolCall.content).toEqual([
      {
        type: "content",
        content: {
          type: "text",
          text: `Overwrites the existing file \`${filePath}\`. The adapter cannot show its current content.`,
        },
      },
    ]);
  });

  it("shows the standard diff in the approval of a Write whose text cannot have a patch", async () => {
    const filePath = await temporaryFile("before\n");
    const input = { file_path: filePath, content: "a\r\nb\r\n" };

    expect(await previewPatchContent("Write", input)).toEqual([
      { type: "diff", path: filePath, oldText: "before\n", newText: "a\r\nb\r\n" },
    ]);
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

  it("keeps the standard diff for an Edit that fills an empty file", async () => {
    // Claude reports the same response for a created file and for an existing
    // empty file, so the hook cannot choose the creation header.
    const filePath = await temporaryFile("a\n");

    const result = await patchUpdateFromDiffToolResponse({
      filePath,
      oldString: "",
      newString: "a\n",
      originalFile: "",
      structuredPatch: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 1, lines: ["+a"] }],
    });

    expect(result).toBeUndefined();
  });

  it("builds no patch for a Write that changed nothing", async () => {
    // The file changed after the Write. The Write itself wrote the same text.
    const filePath = await temporaryFile("changed later\n");
    const response = {
      type: "update",
      filePath,
      content: "same\n",
      originalFile: "same\n",
      structuredPatch: [],
    };

    expect(await patchUpdateFromDiffToolResponse(response)).toBeUndefined();
    // The standard diff then shows that the text stayed the same.
    expect(toolUpdateFromDiffToolResponse(response).content).toEqual([
      { type: "diff", path: filePath, oldText: "same\n", newText: "same\n" },
    ]);
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

  it("maps structured hunks to the standard diff", () => {
    expect(
      toolUpdateFromDiffToolResponse({
        filePath: "/file.ts",
        structuredPatch: [
          { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ["-old", "+new"] },
        ],
      }),
    ).toEqual({
      content: [{ type: "diff", path: "/file.ts", oldText: "old", newText: "new" }],
      locations: [{ path: "/file.ts", line: 1 }],
    });
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
