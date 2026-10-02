import { defineConfig } from "vitest/config";

// Runs that exercise the real Claude CLI opt in with these variables.
const usesRealCli =
  Boolean(process.env.RUN_INTEGRATION_TESTS) || process.env.RUN_LIVE_CAPABILITY_AUDIT === "true";

export default defineConfig({
  test: {
    watch: false,
    globals: true,
    environment: "node",
    // The agent runs `claude auth status` in the background on every
    // initialize and prompt. Pointing it at a CLI that exits at once keeps
    // tests off the machine's real CLI and Claude config, and stops a run
    // from outliving its test (it wrote into temp config dirs being deleted).
    env: usesRealCli ? {} : { CLAUDE_CODE_EXECUTABLE: "/usr/bin/false" },
    include: [
      "src/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}",
      // Release tooling lives in scripts/ rather than src/ so it stays outside tsc's
      // rootDir and out of the published tarball; its tests have to follow it there.
      "scripts/**/*.{test,spec}.mjs",
    ],
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
    },
  },
  resolve: {
    alias: {
      "@": "/src",
    },
  },
});
