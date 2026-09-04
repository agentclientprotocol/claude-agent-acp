#!/usr/bin/env node
//
// Prints the next preview version for this package, e.g. `0.73.1-preview.4`.
//
// The base is package.json's version with the patch incremented, so a preview always
// sorts above the last release and below whatever release follows it. `-preview.N`
// counts from 1 per base and restarts whenever release-please moves package.json on.
//
// Basing the preview on release-please's *predicted* next version would be more
// truthful — it would give `0.74.0-preview.N` when a `feat:` is queued — but the
// prediction moves mid-flight: a `fix:` opens a 0.73.1 release PR, a later `feat:`
// moves it to 0.74.0, and N resets under previews that were already published. If the
// prediction ever moved down, the next preview would sort below the previous one.
// package.json only ever increases, so patch+1 is monotonic in every case:
// 0.73.1-preview.9 < 0.73.2-preview.1 and < 0.74.1-preview.1, whichever way the next
// release goes. The cost is that `0.73.1-preview.4` is not a promise that 0.73.1 will
// ship.
//
// N has to be a number nobody has used, and two sources are consulted because either
// alone is unsafe:
//
//   * the npm registry, authoritative for what is taken — npm versions are immutable
//     and stay reserved even after `npm unpublish`, so a taken N is a hard E403 at
//     publish time — but served from a CDN, so it can lag a publish by minutes;
//   * git tags, written by the workflow after each publish and strongly consistent,
//     which cover that window and any unpublish.
//
// The workflow publishes before it tags, so a version can exist on npm without a tag
// but never the other way round. That asymmetry is why the registry is the authority
// and the tags are only a floor, and why a registry read failure is fatal here rather
// than falling back to the tags alone.
//
// See docs/RELEASES.md.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const DEFAULT_REGISTRY = "https://registry.npmjs.org";
const PREVIEW_ID = "preview";
const FETCH_ATTEMPTS = 3;
const FETCH_TIMEOUT_MS = 10_000;
const BACKOFF_MS = 500;

/** X.Y.Z: no prerelease, no build metadata, no leading zeros. */
const RELEASE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/** The base a preview anticipates: package.json's version with the patch bumped. */
export function bumpPatch(version) {
  const match = RELEASE_VERSION.exec(String(version ?? "").trim());
  if (!match) {
    throw new Error(
      `expected a plain X.Y.Z release version, got ${JSON.stringify(version)}. ` +
        `release-please owns package.json's version; a prerelease or a range here means ` +
        `something else has edited it.`,
    );
  }
  const [, major, minor, patch] = match;
  return `${major}.${minor}.${Number(patch) + 1}`;
}

function escapeRegExp(literal) {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Matcher for `<base>-preview.<n>`. `0731-preview.1` would match a base of `0.73.1`. `n`
 * is a semver-legal numeric identifier, so leading zeros are rejected; npm would never
 * have accepted `preview.01` in the first place.
 */
export function previewPattern(base) {
  return new RegExp(`^${escapeRegExp(base)}-${PREVIEW_ID}\\.(0|[1-9]\\d*)$`);
}

/** The N in `<base>-preview.N`, or null for anything else. */
export function previewNumber(candidate, base) {
  const match = previewPattern(base).exec(String(candidate ?? "").trim());
  return match ? Number(match[1]) : null;
}

/** `refs/tags/v1.2.3`, `v1.2.3` and `1.2.3` all become `1.2.3`. */
export function versionFromTag(tag) {
  return String(tag ?? "")
    .trim()
    .replace(/^refs\/tags\//, "")
    .replace(/^v/, "");
}

/**
 * Highest N among the candidates, or 0 when none match.
 */
export function highestPreviewNumber(candidates, base) {
  let highest = 0;
  for (const candidate of candidates) {
    const n = previewNumber(candidate, base);
    if (n !== null && n > highest) {
      highest = n;
    }
  }
  return highest;
}

export function nextPreviewVersion({ base, registryVersions = [], tags = [] }) {
  const taken = Math.max(
    highestPreviewNumber(registryVersions, base),
    highestPreviewNumber(tags.map(versionFromTag), base),
  );
  return `${base}-${PREVIEW_ID}.${taken + 1}`;
}

/** Every version this package has ever published, per the registry. */
export async function fetchPublishedVersions(name, options = {}) {
  const {
    registry = DEFAULT_REGISTRY,
    fetchImpl = fetch,
    attempts = FETCH_ATTEMPTS,
    backoffMs = BACKOFF_MS,
  } = options;
  const url = `${registry}/${name.replace("/", "%2f")}`;
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await fetchImpl(url, {
        // The abbreviated packument is a fraction of the full one — tens of kilobytes
        // rather than megabytes — and still carries every version key.
        headers: { accept: "application/vnd.npm.install-v1+json" },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (response.status === 404) {
        // Never published. A definite answer, not a failure.
        return [];
      }
      if (!response.ok) {
        throw new Error(`${url} answered ${response.status} ${response.statusText}`);
      }
      const packument = await response.json();
      // `versions` on a packument is always an object keyed by version, so there is
      // none of the "a single version comes back as a bare string" shape that
      // `npm view <pkg> versions --json` has.
      return Object.keys(packument.versions ?? {});
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        await new Promise((resolve) => setTimeout(resolve, backoffMs * 2 ** (attempt - 1)));
      }
    }
  }
  throw new Error(
    `could not read published versions for ${name} after ${attempts} attempts: ${lastError}. ` +
      `Refusing to guess a preview number: the registry is the only record of versions ` +
      `that were published and then unpublished, and those can never be reused.`,
    { cause: lastError },
  );
}

function localPreviewTags(base) {
  try {
    return execFileSync("git", ["tag", "--list", `v${base}-${PREVIEW_ID}.*`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })
      .split("\n")
      .filter(Boolean);
  } catch {
    // No git, no repository, or a clone without tags. Tags are only a floor under the
    // registry, so carry on rather than fail.
    process.stderr.write("warning: could not list git tags; using the registry alone\n");
    return [];
  }
}

function readFlag(argv, name) {
  const index = argv.indexOf(name);
  return index === -1 ? undefined : argv[index + 1];
}

async function main(argv) {
  const packageJsonPath = readFlag(argv, "--package-json") ?? "package.json";
  const manifest = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  const base = bumpPatch(manifest.version);
  const registryVersions = await fetchPublishedVersions(manifest.name, {
    registry: readFlag(argv, "--registry") ?? DEFAULT_REGISTRY,
  });
  const tags = argv.includes("--no-git-tags") ? [] : localPreviewTags(base);

  // Diagnostics on stderr so stdout stays a single machine-readable line.
  process.stderr.write(
    `${manifest.name} ${manifest.version} -> base ${base}; registry high-water ` +
      `${highestPreviewNumber(registryVersions, base)}, tag high-water ` +
      `${highestPreviewNumber(tags.map(versionFromTag), base)}\n`,
  );
  process.stdout.write(`${nextPreviewVersion({ base, registryVersions, tags })}\n`);
}

// Only when invoked as a program, so the helpers above can be imported by the test
// without doing any I/O.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  });
}
