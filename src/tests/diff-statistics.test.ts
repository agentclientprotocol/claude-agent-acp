import { describe, expect, it } from "vitest";
import { toolUpdateFromDiffToolResponse } from "../tools.js";

describe("diff statistics", () => {
  it("counts each block independently without reading full file content", () => {
    const result = toolUpdateFromDiffToolResponse({
      filePath: "/file.ts",
      get originalFile() {
        throw new Error("The patch already contains the changes");
      },
      get content() {
        throw new Error("The patch already contains the changes");
      },
      structuredPatch: [
        {
          oldStart: 1,
          oldLines: 3,
          newStart: 1,
          newLines: 2,
          lines: [" context", "-first", "-second", "+replacement"],
        },
        {
          oldStart: 1_000_000,
          oldLines: 0,
          newStart: 999_999,
          newLines: 2,
          lines: ["+first", "+second"],
        },
      ],
    });

    expect(result.content?.map((block) => block._meta)).toEqual([
      { jetbrains: { air: { version: 1, diffStats: { version: 1, added: 1, removed: 2 } } } },
      { jetbrains: { air: { version: 1, diffStats: { version: 1, added: 2, removed: 0 } } } },
    ]);
  });

  it("counts patch operations when an EOF change produces equal displayed texts", () => {
    const result = toolUpdateFromDiffToolResponse({
      filePath: "/file.ts",
      structuredPatch: [
        {
          oldStart: 1,
          oldLines: 1,
          newStart: 1,
          newLines: 1,
          lines: ["-same", "\\ No newline at end of file", "+same"],
        },
      ],
    });

    expect(result.content).toEqual([
      {
        type: "diff",
        path: "/file.ts",
        oldText: "same",
        newText: "same",
        _meta: {
          jetbrains: { air: { version: 1, diffStats: { version: 1, added: 1, removed: 1 } } },
        },
      },
    ]);
  });

  it("publishes zero counts for a block with only context", () => {
    const result = toolUpdateFromDiffToolResponse({
      filePath: "/file.ts",
      structuredPatch: [
        { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: [" unchanged"] },
      ],
    });

    expect(result.content?.[0]._meta).toEqual({
      jetbrains: { air: { version: 1, diffStats: { version: 1, added: 0, removed: 0 } } },
    });
  });

  it.each([
    { oldLines: 2, newLines: 1, lines: ["-old", "+new"] },
    { oldLines: 1, newLines: 2, lines: ["-old", "+new"] },
    { oldLines: 1, newLines: 1, lines: ["?unsupported"] },
    { oldLines: "1", newLines: 1, lines: ["-old", "+new"] },
  ])("omits statistics for an inconsistent patch: %j", (hunk) => {
    const result = toolUpdateFromDiffToolResponse({
      filePath: "/file.ts",
      structuredPatch: [{ oldStart: 1, newStart: 1, ...hunk }],
    });

    expect(result.content).toHaveLength(1);
    expect(result.content?.[0]).not.toHaveProperty("_meta");
  });
});
