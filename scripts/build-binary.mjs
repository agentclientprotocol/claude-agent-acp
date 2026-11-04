#!/usr/bin/env node
// Builds a single-file executable of the agent with `bun build --compile`,
// embedding the Claude CLI binary for the target platform.
//
//   node scripts/build-binary.mjs [--target bun-linux-x64-musl] [--outfile path]
//
// --target defaults to the host. Cross-compiling needs the target's SDK
// platform package installed; the script prints the install command when it
// is missing.

import { spawnSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
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
try {
  sdkRequire.resolve(cliSpecifier);
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

// The entry registers the embedded CLI before importing the agent: index.ts
// starts serving (or, with --cli, spawns the CLI) during its own evaluation,
// and a static import would evaluate it before this module's body runs.
const entry = join(repoRoot, `.binary-entry-${process.pid}.ts`);
writeFileSync(
  entry,
  `import embeddedCli from ${JSON.stringify(cliSpecifier)} with { type: "file" };
import { extractFromBunfs } from "@anthropic-ai/claude-agent-sdk/extract";
import { useEmbeddedClaudeCli } from "./src/claude-cli.ts";

useEmbeddedClaudeCli(() => extractFromBunfs(embeddedCli));
await import("./src/index.ts");
`,
);

try {
  const bun = spawnSync(
    "bun",
    ["build", entry, "--compile", "--target", target, "--outfile", outfile],
    {
      cwd: repoRoot,
      stdio: "inherit",
      shell: process.platform === "win32",
    },
  );
  if (bun.error) {
    console.error(`Could not run bun: ${bun.error.message}. Install it from https://bun.sh.`);
    process.exit(1);
  }
  process.exitCode = bun.status ?? 1;
} finally {
  rmSync(entry, { force: true });
}
