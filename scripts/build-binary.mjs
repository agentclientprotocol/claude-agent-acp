#!/usr/bin/env node
// Builds an executable of the agent with `bun build --compile` and copies the
// target platform's Claude CLI next to it. Both files go in the release
// archive: the executable runs the CLI from its own directory.
//
//   node scripts/build-binary.mjs [--target bun-linux-x64-musl] [--outfile path]
//
// --target defaults to the host. Cross-compiling needs the target's SDK
// platform package installed; the script prints the install command when it
// is missing.

import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function hostTarget() {
  const os = process.platform === "win32" ? "windows" : process.platform;
  // Node linked against glibc reports its version; musl builds don't.
  const musl =
    process.platform === "linux" && !process.report.getReport().header.glibcVersionRuntime;
  return `bun-${os}-${process.arch}${musl ? "-musl" : ""}`;
}

const { values } = parseArgs({
  options: {
    target: { type: "string", default: hostTarget() },
    outfile: { type: "string" },
  },
});
const target = values.target;

// Bun targets look like `bun-<os>-<arch>` with optional `-musl`, `-baseline` or
// `-modern` suffixes; the SDK names its packages `<platform>-<arch>[-musl]`.
const match = /^bun-(linux|darwin|windows)-(x64|arm64|aarch64)(?:-.+)?$/.exec(target);
if (!match) {
  console.error(
    `Unsupported target "${target}". Expected e.g. bun-linux-x64, bun-darwin-arm64, bun-windows-x64.`,
  );
  process.exit(1);
}
const [, os, rawArch] = match;
const platform = os === "windows" ? "win32" : os;
const arch = rawArch === "aarch64" ? "arm64" : rawArch;
const musl = target.split("-").includes("musl");
const exe = os === "windows" ? ".exe" : "";
const cliPackage = `@anthropic-ai/claude-agent-sdk-${platform}-${arch}${musl ? "-musl" : ""}`;
const cliSpecifier = `${cliPackage}/claude${exe}`;
const outfile = resolve(values.outfile ?? join(repoRoot, "dist-bin", `claude-agent-acp${exe}`));

// Resolve from the SDK, the way claudeCliPath() does at runtime, so a nested
// install is checked rather than only a hoisted one.
const sdkRequire = createRequire(
  createRequire(join(repoRoot, "package.json")).resolve("@anthropic-ai/claude-agent-sdk"),
);
let cliPath;
try {
  cliPath = sdkRequire.resolve(cliSpecifier);
} catch {
  const sdkVersion = JSON.parse(
    readFileSync(
      join(dirname(sdkRequire.resolve("@anthropic-ai/claude-agent-sdk")), "package.json"),
      "utf8",
    ),
  ).version;
  console.error(
    `${cliSpecifier} is not installed. npm only installs the host's platform package; for ${target} run:\n\n` +
      `  npm install --no-save --force ${cliPackage}@${sdkVersion}\n`,
  );
  process.exit(1);
}

const bun = spawnSync(
  "bun",
  ["build", "src/binary-entry.ts", "--compile", "--target", target, "--outfile", outfile],
  { cwd: repoRoot, stdio: "inherit", shell: process.platform === "win32" },
);
if (bun.error) {
  console.error(`Could not run bun: ${bun.error.message}. Install it from https://bun.sh.`);
  process.exit(1);
}
if (bun.status !== 0) process.exit(bun.status ?? 1);

// The executable runs the CLI from its own directory (src/binary-entry.ts).
const cliOutfile = join(dirname(outfile), `claude${exe}`);
copyFileSync(cliPath, cliOutfile);
chmodSync(cliOutfile, 0o755);
console.log(`Copied ${cliSpecifier} to ${cliOutfile}`);
