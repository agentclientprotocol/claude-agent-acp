import js from "@eslint/js";
import tseslint from "@typescript-eslint/eslint-plugin";
import tsparser from "@typescript-eslint/parser";
import prettierConfig from "eslint-config-prettier";
import globals from "globals";

/**
 * Rules that reject a module specifier matching `regex` in static imports and
 * re-exports (type-only ones too), `import()` calls and `import("...")` types.
 */
function protocolBoundary(regex, message) {
  // esquery regex literals end at the first `/`, so spell it `\x2F`.
  const literal = `/${regex.replaceAll("/", "\\x2F")}/`;
  return {
    "no-restricted-imports": ["error", { patterns: [{ regex, message }] }],
    "no-restricted-syntax": [
      "error",
      { selector: `ImportExpression[source.value=${literal}]`, message },
      { selector: `TSImportType[argument.literal.value=${literal}]`, message },
    ],
  };
}

export default [
  {
    ignores: ["node_modules/", "dist/", "coverage/", "*.min.js", "*.config.js", ".github/"],
  },
  js.configs.recommended,
  {
    files: ["src/**/*.ts"],
    languageOptions: {
      ecmaVersion: 2020,
      sourceType: "module",
      parser: tsparser,
      parserOptions: {
        project: "./tsconfig.json",
      },
      globals: {
        ...globals.node,
      },
    },
    plugins: {
      "@typescript-eslint": tseslint,
    },
    rules: {
      ...tseslint.configs.recommended.rules,
      "@typescript-eslint/explicit-function-return-type": "off",
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
        },
      ],
      "no-console": "off",
      "no-constant-condition": "off",
      "default-case": "error",
      "prefer-const": "error",
      "no-var": "error",
      eqeqeq: ["error", "smart"],
      curly: ["error", "all"],
    },
  },
  // `src/v2/` must not import the v1 agent (`src/v1/`, or `src/acp-agent.ts`, which re-exports it).
  {
    files: ["src/v2/**/*.ts"],
    rules: protocolBoundary(
      "^(\\.\\./)+(v1/|acp-agent\\.js$)",
      "src/v2/ must not import the v1 agent. Move what both versions need into a shared module in src/.",
    ),
  },
  // Shared modules must not import either agent. The entry points wire the agents up.
  {
    files: ["src/**/*.ts"],
    ignores: [
      "src/v1/**",
      "src/v2/**",
      "src/tests/**",
      "src/index.ts",
      "src/lib.ts",
      "src/serve.ts",
      "src/binary-entry.ts",
      "src/acp-agent.ts",
    ],
    rules: protocolBoundary(
      "^(\\./|(\\.\\./)+)(v1/|v2/|acp-agent\\.js$)",
      "Shared modules must not import src/v1/, src/v2/ or src/acp-agent.ts. Move the code into the shared module, or pass it in from the agent.",
    ),
  },
  prettierConfig,
];
