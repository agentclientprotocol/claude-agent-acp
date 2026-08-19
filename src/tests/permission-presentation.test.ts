import { describe, expect, it } from "vitest";
import type { PermissionUpdate } from "@anthropic-ai/claude-agent-sdk";
import { normalizeDurablePermissionChangeSet } from "../permissions/normalization.js";
import { buildClaudePermissionPresentation } from "../permissions/presentation.js";

const rule = { toolName: "Bash", ruleContent: "npm test:*" };
describe("Claude permission suggestion normalization", () => {
  it.each([undefined, [], null, "bad"])("omits a durable choice for %j", (suggestions) => {
    expect(normalizeDurablePermissionChangeSet(suggestions)).toBeUndefined();
  });

  it.each(["addRules", "replaceRules", "removeRules"] as const)(
    "supports and snapshots %s",
    (type) => {
      const suggestions: PermissionUpdate[] = [
        { type, rules: [rule], behavior: "allow", destination: "session" },
      ];
      const normalized = normalizeDurablePermissionChangeSet(suggestions);
      expect(normalized?.updates).toEqual(suggestions);
      expect(normalized?.updates).not.toBe(suggestions);
    },
  );

  it("keeps the approved effect stable if the provider mutates its suggestions later", () => {
    const suggestions: PermissionUpdate[] = [
      { type: "addRules", rules: [rule], behavior: "allow", destination: "session" },
    ];
    const normalized = normalizeDurablePermissionChangeSet(suggestions)!;
    suggestions[0] = {
      type: "addRules",
      rules: [{ toolName: "Bash", ruleContent: "rm:*" }],
      behavior: "allow",
      destination: "userSettings",
    };
    expect(normalized.updates).toEqual([
      { type: "addRules", rules: [rule], behavior: "allow", destination: "session" },
    ]);
  });

  it.each(["default", "acceptEdits", "bypassPermissions", "plan", "dontAsk", "auto"] as const)(
    "supports setMode %s",
    (mode) => {
      expect(
        normalizeDurablePermissionChangeSet([{ type: "setMode", mode, destination: "session" }])
          ?.updates,
      ).toEqual([{ type: "setMode", mode, destination: "session" }]);
    },
  );

  it.each(["addDirectories", "removeDirectories"] as const)("supports %s", (type) => {
    expect(
      normalizeDurablePermissionChangeSet([
        { type, directories: ["/one", "/two"], destination: "localSettings" },
      ])?.updates,
    ).toEqual([{ type, directories: ["/one", "/two"], destination: "localSettings" }]);
  });

  it.each([
    [{ type: "future", destination: "session" }],
    [{ type: "setMode", mode: "future", destination: "session" }],
    [{ type: "addRules", rules: [rule], behavior: "future", destination: "session" }],
    [{ type: "addDirectories", directories: ["/work"], destination: "future" }],
    [{ type: "addDirectories", directories: [], destination: "session" }],
  ])("fails closed for an unknown or invalid change set", (suggestions) => {
    expect(normalizeDurablePermissionChangeSet(suggestions)).toBeUndefined();
  });

  it("fails closed when an otherwise valid provider update is not cloneable", () => {
    expect(
      normalizeDurablePermissionChangeSet([
        {
          type: "addRules",
          rules: [rule],
          behavior: "allow",
          destination: "session",
          unexpectedFunction: () => undefined,
        },
      ]),
    ).toBeUndefined();
  });

  it("suppresses every durable option for a forced ask", () => {
    expect(
      normalizeDurablePermissionChangeSet(
        [{ type: "addDirectories", directories: ["/work"], destination: "projectSettings" }],
        true,
      ),
    ).toBeUndefined();
  });
});

describe("Claude permission ACP v1 presentation", () => {
  it("uses Approve Plan as the tool title and keeps the question in permission metadata", () => {
    const presentation = buildClaudePermissionPresentation({
      toolName: "ExitPlanMode",
      input: { plan: "Implement the change" },
      toolUseID: "tool-plan",
    });

    expect(presentation.toolCall.title).toBe("Approve Plan");
    expect(presentation._meta).toEqual({
      permission: { version: 1, title: "Ready to code?" },
    });
  });

  it("uses the human command description as the permission title", () => {
    const input = { command: "npm test", description: "Run the tests" };
    const presentation = buildClaudePermissionPresentation({
      toolName: "Bash",
      input,
      toolUseID: "tool-1",
      displayName: "Run command",
      description: "Run npm tests",
      decisionReason: "Needed to verify the change.",
    });
    expect(presentation._meta).toEqual({
      permission: {
        version: 1,
        title: "Run the tests",
        description: "Reason: Needed to verify the change.",
      },
    });
    expect(presentation.toolCall).toMatchObject({
      toolCallId: "tool-1",
      name: "Bash",
      kind: "execute",
      status: "pending",
      rawInput: input,
      title: "Run the tests",
    });
    expect(presentation.toolCall.rawInput).toBe(input);
  });

  it.each(["Bash", "PowerShell"])(
    "uses the %s tool name when no human command description is available",
    (toolName) => {
      const input = { command: "echo raw command" };
      const presentation = buildClaudePermissionPresentation({
        toolName,
        input,
        toolUseID: `tool-${toolName}`,
      });

      expect(presentation._meta).toEqual({
        permission: { version: 1, title: toolName },
      });
      expect(presentation.toolCall).toMatchObject({
        title: toolName,
        rawInput: input,
      });
    },
  );

  it("keeps the WebFetch URL in structured tool input", () => {
    const input = { url: "https://example.com/docs", prompt: "Read the API reference" };
    const presentation = buildClaudePermissionPresentation({
      toolName: "WebFetch",
      input,
      toolUseID: "tool-web-fetch",
      description: "https://example.com/docs",
    });

    expect(presentation._meta).toEqual({
      permission: { version: 1, title: "Fetch https://example.com/docs" },
    });
    expect(presentation.toolCall).toMatchObject({
      kind: "fetch",
      rawInput: input,
    });
    expect(presentation.toolCall.rawInput).toBe(input);
  });

  it("keeps the WebSearch query out of the permission description", () => {
    const query = "Agent Client Protocol ACP specification subagents v2";
    const presentation = buildClaudePermissionPresentation({
      toolName: "WebSearch",
      input: { query },
      toolUseID: "tool-web-search",
      displayName: "WebSearch",
      description: "Agent Client Protocol ACP specification subagents…",
    });

    expect(presentation._meta).toEqual({
      permission: {
        version: 1,
        title: 'Search "Agent Client Protocol ACP specification subagents v2"',
      },
    });
    expect(presentation.toolCall.title).toBe(
      'Search "Agent Client Protocol ACP specification subagents v2"',
    );
  });

  it.each([
    ["Agent", { description: "Find the implementation" }, "Find the implementation"],
    ["Task", { description: "Review the tests" }, "Review the tests"],
    ["ReviewArtifact", {}, "ReviewArtifact"],
    ["Workflow", {}, "Workflow"],
    ["Monitor", {}, "Monitor"],
  ])("reuses the %s tool-call title", (toolName, input, title) => {
    expect(
      buildClaudePermissionPresentation({
        toolName,
        input,
        toolUseID: `tool-${toolName}`,
        displayName: toolName,
      })._meta,
    ).toEqual({ permission: { version: 1, title } });
  });

  it("reuses tool-call titles and temporarily exposes decisionReason", () => {
    expect(
      buildClaudePermissionPresentation({
        toolName: "Read",
        input: { file_path: "/work/a.ts" },
        toolUseID: "tool-2",
        title: "Claude wants to read /work/a.ts",
        description: "Read a.ts",
        decisionReason: "Needed to inspect the dependency.",
      })._meta,
    ).toEqual({
      permission: {
        version: 1,
        title: "Read /work/a.ts",
        description: "Reason: Needed to inspect the dependency.",
      },
    });
    expect(
      buildClaudePermissionPresentation({
        toolName: "Read",
        input: { file_path: "/work/a.ts" },
        toolUseID: "tool-2b",
        displayName: "Inspect file",
        description: "Read a.ts",
      })._meta,
    ).toEqual({
      permission: {
        version: 1,
        title: "Read /work/a.ts",
      },
    });
    expect(
      buildClaudePermissionPresentation({
        toolName: "Read",
        input: {},
        toolUseID: "tool-3",
        decisionReason: "internal_policy_code",
      })._meta,
    ).toEqual({
      permission: {
        version: 1,
        title: "Read File",
        description: "Reason: internal_policy_code",
      },
    });
  });

  it.each([
    ["Read", { file_path: "/work/AGENTS.md" }, "Read AGENTS.md"],
    ["Edit", { file_path: "/work/a.ts" }, "Edit a.ts"],
    ["Write", { file_path: "/work/a.ts" }, "Write a.ts"],
    ["NotebookEdit", { notebook_path: "/work/a.ipynb" }, "Edit a.ipynb"],
    ["Glob", { pattern: "**/*.ts" }, "Find **/*.ts"],
    ["Grep", { pattern: "permission" }, "Search for permission"],
    ["Bash", { command: "npm test" }, "Run npm test"],
    ["PowerShell", { command: "Get-ChildItem" }, "List files"],
    ["WebFetch", { url: "https://example.com" }, "https://example.com"],
    ["WebSearch", { query: "ACP permissions" }, "ACP permissions"],
    ["Skill", { skill: "testing" }, "Use testing skill"],
    ["mcp__demo__deploy", { target: "staging" }, "Deploy to staging"],
  ])(
    "does not use the %s operation subtitle as a permission explanation",
    (toolName, input, description) => {
      const presentation = buildClaudePermissionPresentation({
        toolName,
        input,
        toolUseID: `tool-${toolName}`,
        description,
      });

      expect(presentation._meta?.permission).not.toHaveProperty("description");
    },
  );

  it("adds a non-duplicated blocked path to standard locations", () => {
    const presentation = buildClaudePermissionPresentation({
      toolName: "Read",
      input: { file_path: "/work/a.ts" },
      toolUseID: "tool-4",
      blockedPath: "/outside/b.ts",
    });
    expect(presentation.toolCall.locations).toEqual([
      { path: "/work/a.ts", line: 1 },
      { path: "/outside/b.ts" },
    ]);
  });

  it("reuses the standard title for an unknown tool", () => {
    const presentation = buildClaudePermissionPresentation({
      toolName: "mcp__demo__deploy",
      input: { target: "staging" },
      toolUseID: "tool-5",
    });
    expect(presentation.toolCall).toMatchObject({ kind: "other", name: "mcp__demo__deploy" });
    expect(presentation._meta).toEqual({
      permission: { version: 1, title: "mcp__demo__deploy" },
    });
  });
});
