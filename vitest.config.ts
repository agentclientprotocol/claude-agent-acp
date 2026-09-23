import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    watch: false,
    globals: true,
    environment: "node",
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
