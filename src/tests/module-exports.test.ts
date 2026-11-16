import { describe, expect, it } from "vitest";
import packageJson from "../../package.json" with { type: "json" };

describe("module runtime exports", () => {
  /**
   * The public runtime exports of lib.ts, the package's only entry point, must change only deliberately; consumers import these names.
   */
  it("lib.ts exports the expected names", async () => {
    expect(Object.keys(await import("../lib.js")).sort()).toEqual([
      "AUTH_STATUS_UPDATE_METHOD",
      "serveAcp",
    ]);
  });

  it("package.json exposes lib.ts as the only module entry point", () => {
    expect(Object.keys(packageJson.exports)).toEqual([".", "./package.json"]);
    expect(packageJson.exports["."]).toEqual({
      types: "./dist/lib.d.ts",
      import: "./dist/lib.js",
    });
  });
});
