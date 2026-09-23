import { describe, it, expect, vi } from "vitest";
import {
  bumpPatch,
  previewNumber,
  versionFromTag,
  highestPreviewNumber,
  nextPreviewVersion,
  fetchPublishedVersions,
} from "./next-preview-version.mjs";

const PACKAGE = "@agentclientprotocol/claude-agent-acp";

/** A packument response, abbreviated the way the registry returns it. */
function packument(versions) {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    json: async () => ({ name: PACKAGE, versions }),
  };
}

function failure(status, statusText = "Internal Server Error") {
  return { ok: false, status, statusText, json: async () => ({}) };
}

describe("bumpPatch", () => {
  it("increments the patch", () => {
    expect(bumpPatch("0.73.0")).toBe("0.73.1");
    expect(bumpPatch("1.0.0")).toBe("1.0.1");
    expect(bumpPatch("0.0.0")).toBe("0.0.1");
  });

  it("increments numerically rather than by concatenation", () => {
    expect(bumpPatch("0.73.9")).toBe("0.73.10");
    expect(bumpPatch("0.73.19")).toBe("0.73.20");
  });

  it("trims surrounding whitespace", () => {
    expect(bumpPatch(" 0.73.0 ")).toBe("0.73.1");
  });

  // release-please owns package.json's version, so anything that is not a plain
  // release means something else has edited it. Failing loudly beats guessing.
  it.each([
    ["a two-part version", "0.73"],
    ["a four-part version", "0.73.0.1"],
    ["a prerelease", "0.73.0-preview.1"],
    ["build metadata", "0.73.0+build.1"],
    ["a v prefix", "v0.73.0"],
    ["a range", "^0.73.0"],
    ["leading zeros", "01.2.3"],
    ["the empty string", ""],
    ["undefined", undefined],
  ])("throws on %s", (_label, version) => {
    expect(() => bumpPatch(version)).toThrow(/plain X\.Y\.Z release version/);
  });
});

describe("previewNumber", () => {
  it("reads N out of a matching version", () => {
    expect(previewNumber("0.73.1-preview.1", "0.73.1")).toBe(1);
    expect(previewNumber("0.73.1-preview.10", "0.73.1")).toBe(10);
  });

  it("treats zero as a number rather than as no match", () => {
    expect(previewNumber("0.73.1-preview.0", "0.73.1")).toBe(0);
  });

  it.each([
    ["a plain release", "0.73.1"],
    ["a different base", "0.73.2-preview.1"],
    ["a missing number", "0.73.1-preview"],
    ["leading zeros in N", "0.73.1-preview.01"],
    ["a dotted N", "0.73.1-preview.1.2"],
    ["build metadata", "0.73.1-preview.1+build.5"],
    ["another prerelease id", "0.73.1-alpha.1"],
    // Proves the base's dots are escaped rather than matching any character.
    ["a base whose dots are elided", "0731-preview.1"],
    // Proves the pattern is anchored at the start.
    ["a base with a numeric prefix", "10.73.1-preview.1"],
  ])("returns null for %s", (_label, candidate) => {
    expect(previewNumber(candidate, "0.73.1")).toBeNull();
  });
});

describe("versionFromTag", () => {
  it("strips a refs/tags/ prefix and a v", () => {
    expect(versionFromTag("refs/tags/v0.73.1-preview.3")).toBe("0.73.1-preview.3");
    expect(versionFromTag("v0.73.1")).toBe("0.73.1");
    expect(versionFromTag("0.73.1")).toBe("0.73.1");
  });
});

describe("highestPreviewNumber", () => {
  it("is 0 when nothing matches", () => {
    expect(highestPreviewNumber([], "0.73.1")).toBe(0);
    expect(highestPreviewNumber(["0.73.1", "0.72.1-preview.4"], "0.73.1")).toBe(0);
  });

  // Sorted as strings, `preview.9` would beat `preview.10`.
  it("compares numerically, not lexicographically", () => {
    expect(highestPreviewNumber(["0.73.1-preview.9", "0.73.1-preview.10"], "0.73.1")).toBe(10);
    expect(highestPreviewNumber(["0.73.1-preview.10", "0.73.1-preview.9"], "0.73.1")).toBe(10);
  });

  it("ignores order and duplicates", () => {
    const candidates = [
      "0.73.1-preview.2",
      "0.73.1-preview.7",
      "0.73.1-preview.2",
      "0.73.1-preview.5",
    ];
    expect(highestPreviewNumber(candidates, "0.73.1")).toBe(7);
  });

  it("counts only the requested base", () => {
    const candidates = ["0.72.1-preview.99", "0.73.1-preview.3", "0.74.1-preview.42"];
    expect(highestPreviewNumber(candidates, "0.73.1")).toBe(3);
  });
});

describe("nextPreviewVersion", () => {
  it("starts at 1 with no history", () => {
    expect(nextPreviewVersion({ base: "0.73.1" })).toBe("0.73.1-preview.1");
  });

  it("continues from the registry", () => {
    const registryVersions = ["0.73.0", "0.73.1-preview.1", "0.73.1-preview.2", "0.73.1-preview.3"];
    expect(nextPreviewVersion({ base: "0.73.1", registryVersions })).toBe("0.73.1-preview.4");
  });

  // The registry is CDN-served and can lag a publish by minutes; the tag the previous
  // run wrote is what closes that window.
  it("uses the tags as a floor when the registry is behind", () => {
    const next = nextPreviewVersion({
      base: "0.73.1",
      registryVersions: ["0.73.1-preview.1"],
      tags: ["refs/tags/v0.73.1-preview.3"],
    });
    expect(next).toBe("0.73.1-preview.4");
  });

  // The converse: publish succeeded but the tag step did not, so the registry is
  // ahead. It stays authoritative.
  it("keeps the registry authoritative when the tags are behind", () => {
    const next = nextPreviewVersion({
      base: "0.73.1",
      registryVersions: ["0.73.1-preview.1", "0.73.1-preview.2", "0.73.1-preview.3"],
      tags: ["v0.73.1-preview.1"],
    });
    expect(next).toBe("0.73.1-preview.4");
  });

  it("restarts at 1 once a release moves the base", () => {
    const next = nextPreviewVersion({
      base: "0.73.1",
      registryVersions: ["0.72.1-preview.7", "0.73.0"],
      tags: ["v0.72.1-preview.7"],
    });
    expect(next).toBe("0.73.1-preview.1");
  });

  it("composes with bumpPatch", () => {
    const next = nextPreviewVersion({
      base: bumpPatch("0.73.0"),
      registryVersions: ["0.73.0"],
      tags: ["v0.73.0"],
    });
    expect(next).toBe("0.73.1-preview.1");
  });
});

describe("fetchPublishedVersions", () => {
  const options = (fetchImpl) => ({ fetchImpl, backoffMs: 0 });

  it("returns the version keys of the packument", async () => {
    const fetchImpl = vi.fn(async () => packument({ "0.73.0": {}, "0.73.1-preview.1": {} }));
    await expect(fetchPublishedVersions(PACKAGE, options(fetchImpl))).resolves.toEqual([
      "0.73.0",
      "0.73.1-preview.1",
    ]);
  });

  it("requests the abbreviated packument at the scope-encoded URL", async () => {
    const fetchImpl = vi.fn(async () => packument({}));
    await fetchPublishedVersions(PACKAGE, options(fetchImpl));
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://registry.npmjs.org/@agentclientprotocol%2fclaude-agent-acp");
    expect(init.headers.accept).toBe("application/vnd.npm.install-v1+json");
  });

  it("honours a custom registry", async () => {
    const fetchImpl = vi.fn(async () => packument({}));
    await fetchPublishedVersions(PACKAGE, {
      ...options(fetchImpl),
      registry: "http://127.0.0.1:4873",
    });
    expect(fetchImpl.mock.calls[0][0]).toBe(
      "http://127.0.0.1:4873/@agentclientprotocol%2fclaude-agent-acp",
    );
  });

  it("tolerates a packument with no versions", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({ name: PACKAGE }),
    }));
    await expect(fetchPublishedVersions(PACKAGE, options(fetchImpl))).resolves.toEqual([]);
  });

  // A 404 is a definite answer — the package has never been published — so it must not
  // be retried or turned into a failure.
  it("treats 404 as an empty history without retrying", async () => {
    const fetchImpl = vi.fn(async () => failure(404, "Not Found"));
    await expect(fetchPublishedVersions(PACKAGE, options(fetchImpl))).resolves.toEqual([]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("retries a server error and resolves", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(failure(500))
      .mockResolvedValueOnce(packument({ "0.73.0": {} }));
    await expect(fetchPublishedVersions(PACKAGE, options(fetchImpl))).resolves.toEqual(["0.73.0"]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("retries a network failure and resolves", async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(packument({ "0.73.0": {} }));
    await expect(fetchPublishedVersions(PACKAGE, options(fetchImpl))).resolves.toEqual(["0.73.0"]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  // Guessing N after a failed read risks reusing a version that was published and then
  // unpublished, which npm reserves forever.
  it("gives up rather than guessing when every attempt fails", async () => {
    const fetchImpl = vi.fn(async () => failure(500));
    await expect(fetchPublishedVersions(PACKAGE, options(fetchImpl))).rejects.toThrow(
      /could not read published versions for @agentclientprotocol\/claude-agent-acp after 3 attempts/,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
});
