import { defineConfig, type ViteUserConfig } from "vitest/config";

// Runs that exercise the real Claude CLI opt in with these variables.
const usesRealCli =
  Boolean(process.env.RUN_INTEGRATION_TESTS) || process.env.RUN_LIVE_CAPABILITY_AUDIT === "true";

// The agent runs `claude auth status` in the background on every
// initialize and prompt. Pointing it at a CLI that exits at once keeps
// tests off the machine's real CLI and Claude config, and stops a run
// from outliving its test (it wrote into temp config dirs being deleted).
const env: Record<string, string> = usesRealCli ? {} : { CLAUDE_CODE_EXECUTABLE: "/usr/bin/false" };

const resolve: ViteUserConfig["resolve"] = {
  alias: {
    "@": "/src",
  },
};

/** The options that every project shares. */
const shared = {
  globals: true,
  environment: "node",
  // Applies to real-CLI runs too: the gateway listing runs in the test process,
  // and tests point `providers/set` at fake URLs like gateway.example.com.
  setupFiles: ["src/tests/setup-no-network.ts"],
} as const;

export default defineConfig({
  test: {
    watch: false,
    projects: [
      {
        resolve,
        test: {
          ...shared,
          name: "unit",
          env,
          include: [
            "src/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}",
            // Release tooling lives in scripts/ rather than src/ so it stays outside tsc's
            // rootDir and out of the published tarball; its tests have to follow it there.
            "scripts/**/*.{test,spec}.mjs",
          ],
        },
      },
      {
        // The bridge's ACP v2 tests and v2 scenarios again, against the
        // native v2 core (`src/v2-native/`), so both cores are held to them.
        resolve,
        test: {
          ...shared,
          name: "v2-native-core",
          env: { ...env, V2_CORE_UNDER_TEST: "native" },
          include: ["src/tests/acp-v2.test.ts", "src/tests/acp-scenarios-v2.test.ts"],
        },
      },
    ],
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
    },
  },
});
