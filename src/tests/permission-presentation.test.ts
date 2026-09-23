import { ClientCapabilities } from "../tool-calls/client-capabilities.js";
import { describe, expect, it } from "vitest";
import type { PermissionUpdate } from "@anthropic-ai/claude-agent-sdk";
import { normalizeDurablePermissionChangeSet } from "../permissions/normalization.js";
import { buildClaudePermissionPresentation } from "../permissions/presentation.js";

const rule = { toolName: "Bash", ruleContent: "npm test:*" };

/** An AIR client, which gets the permission contract of `docs/air-extensions.md`. */
function airCapabilities(terminalOutput = false, terminalOutputDelta = false, diffPatch = false) {
  return new ClientCapabilities(terminalOutput, terminalOutputDelta, diffPatch, {
    client: true,
    rawInputRendering: false,
    planContentDelta: false,
    planFile: false,
  });
}
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
  it("uses the provider-built patch for an edit confirmation", () => {
    const previewContent = [
      {
        type: "diff" as const,
        path: "/work/file.ts",
        oldText: null,
        newText: "",
        _meta: {
          jetbrains: {
            air: { version: 1, diffPatch: { version: 1, format: "git_patch", text: "patch" } },
          },
        },
      },
    ];
    const presentation = buildClaudePermissionPresentation({
      toolName: "Edit",
      input: { file_path: "/work/file.ts", old_string: "old", new_string: "new" },
      toolUseID: "tool-edit",
      capabilities: airCapabilities(false, false, true),
      previewContent,
    });

    expect(presentation.toolCall.content).toBe(previewContent);
    expect(presentation.toolCall.content).toEqual([
      expect.objectContaining({ oldText: null, newText: "" }),
    ]);
  });

  it("uses Approve Plan as the tool title and keeps the question in permission metadata", () => {
    const presentation = buildClaudePermissionPresentation({
      capabilities: airCapabilities(),
      toolName: "ExitPlanMode",
      input: { plan: "Implement the change" },
      toolUseID: "tool-plan",
    });

    expect(presentation.toolCall.title).toBe("Approve Plan");
    expect(presentation._meta).toEqual({
      jetbrains: { air: { version: 1, permission: { version: 1, title: "Ready to code?" } } },
    });
  });

  it("forwards the CLI's defaultToNo hint in the permission record", () => {
    const presentation = buildClaudePermissionPresentation({
      capabilities: airCapabilities(),
      toolName: "Bash",
      input: { command: "rm -rf build" },
      toolUseID: "tool-1",
      defaultToNo: true,
    });
    expect(presentation._meta).toEqual({
      jetbrains: {
        air: { version: 1, permission: { version: 1, title: "rm -rf build", defaultToNo: true } },
      },
    });
    expect(
      buildClaudePermissionPresentation({
        capabilities: airCapabilities(),
        toolName: "Bash",
        input: { command: "rm -rf build" },
        toolUseID: "tool-1",
        defaultToNo: false,
      })._meta,
    ).toEqual({
      jetbrains: { air: { version: 1, permission: { version: 1, title: "rm -rf build" } } },
    });
  });

  it("keeps command descriptions and decision reasons in their presentation fields", () => {
    const input = { command: "npm test", description: "Run the tests" };
    const presentation = buildClaudePermissionPresentation({
      capabilities: airCapabilities(),
      toolName: "Bash",
      input,
      toolUseID: "tool-1",
      displayName: "Run command",
      description: "Run npm tests",
      decisionReason: "Needed to verify the change.",
    });
    expect(presentation._meta).toMatchObject({
      jetbrains: {
        air: { version: 1, permission: { description: "Reason: Needed to verify the change." } },
      },
    });
    // The client holds the rest of the tool call already.
    expect(presentation.toolCall).toEqual({
      toolCallId: "tool-1",
      title: "npm test",
      rawInput: input,
    });
    expect(presentation.toolCall.rawInput).toBe(input);
  });

  // `command` is required, so this only shows while the input is still
  // streaming; both shells share the standard terminal card in that state.
  it.each(["Bash", "PowerShell"])(
    "uses the Terminal fallback for %s when no command is available yet",
    (toolName) => {
      const input = {};
      const presentation = buildClaudePermissionPresentation({
        capabilities: airCapabilities(),
        toolName,
        input,
        toolUseID: `tool-${toolName}`,
      });

      expect(presentation._meta).toEqual({
        jetbrains: { air: { version: 1, permission: { version: 1, title: "Terminal" } } },
      });
      expect(presentation.toolCall).toMatchObject({ title: "Terminal", rawInput: input });
    },
  );

  it.each([
    ["Bash", "ls -la ~/.config/zed"],
    ["PowerShell", "Get-ChildItem $HOME\\.config\\zed"],
  ])(
    "shows the exact %s command instead of its model-authored description",
    (toolName, command) => {
      const input = { command, description: "List files in current directory" };
      const presentation = buildClaudePermissionPresentation({
        capabilities: airCapabilities(),
        toolName,
        input,
        toolUseID: `tool-${toolName}`,
      });

      expect(presentation._meta).toMatchObject({
        jetbrains: { air: { version: 1, permission: { title: command } } },
      });
      expect(presentation.toolCall.title).toBe(command);
    },
  );

  describe.each(["Bash", "PowerShell"])("%s command fidelity", (toolName) => {
    it.each([
      { label: "quoted spaces and tabs", command: 'echo "a  b\tc"' },
      { label: "newlines after comments", command: "echo first # first command\necho second" },
      { label: "surrounding whitespace", command: " \techo first\n" },
      {
        label: "commands longer than 4,000 characters",
        command: `echo "${"x".repeat(4_001)}"\necho last`,
      },
    ])("preserves $label in the approval title", ({ command }) => {
      const input = { command, description: "Run the requested command" };
      const presentation = buildClaudePermissionPresentation({
        toolName,
        input,
        toolUseID: `tool-${toolName}`,
        capabilities: airCapabilities(true),
      });

      expect(presentation._meta).toEqual({
        jetbrains: { air: { version: 1, permission: { version: 1, title: command } } },
      });
      expect(presentation.toolCall.title).toBe(command);
      expect(presentation.toolCall.rawInput).toBe(input);
    });
  });

  it("keeps the WebFetch URL in structured tool input", () => {
    const input = { url: "https://example.com/docs", prompt: "Read the API reference" };
    const presentation = buildClaudePermissionPresentation({
      capabilities: airCapabilities(),
      toolName: "WebFetch",
      input,
      toolUseID: "tool-web-fetch",
      description: "https://example.com/docs",
    });

    expect(presentation._meta).toEqual({
      jetbrains: {
        air: { version: 1, permission: { version: 1, title: "Fetch https://example.com/docs" } },
      },
    });
    expect(presentation.toolCall).toEqual({
      toolCallId: "tool-web-fetch",
      title: "Fetch https://example.com/docs",
      rawInput: input,
    });
    expect(presentation.toolCall.rawInput).toBe(input);
  });

  it("keeps the WebSearch query out of the permission description", () => {
    const query = "Agent Client Protocol ACP specification subagents v2";
    const presentation = buildClaudePermissionPresentation({
      capabilities: airCapabilities(),
      toolName: "WebSearch",
      input: { query },
      toolUseID: "tool-web-search",
      displayName: "WebSearch",
      description: "Agent Client Protocol ACP specification subagents…",
    });

    expect(presentation._meta).toEqual({
      jetbrains: {
        air: {
          version: 1,
          permission: {
            version: 1,
            title: 'Search "Agent Client Protocol ACP specification subagents v2"',
          },
        },
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
        capabilities: airCapabilities(),
        toolName,
        input,
        toolUseID: `tool-${toolName}`,
        displayName: toolName,
      })._meta,
    ).toEqual({ jetbrains: { air: { version: 1, permission: { version: 1, title } } } });
  });

  it("reuses tool-call titles and temporarily exposes decisionReason", () => {
    expect(
      buildClaudePermissionPresentation({
        capabilities: airCapabilities(),
        toolName: "Read",
        input: { file_path: "/work/a.ts" },
        toolUseID: "tool-2",
        title: "Claude wants to read /work/a.ts",
        description: "Read a.ts",
        decisionReason: "Needed to inspect the dependency.",
      })._meta,
    ).toEqual({
      jetbrains: {
        air: {
          version: 1,
          permission: {
            version: 1,
            title: "Read /work/a.ts",
            description: "Reason: Needed to inspect the dependency.",
          },
        },
      },
    });
    expect(
      buildClaudePermissionPresentation({
        capabilities: airCapabilities(),
        toolName: "Read",
        input: { file_path: "/work/a.ts" },
        toolUseID: "tool-2b",
        displayName: "Inspect file",
        description: "Read a.ts",
      })._meta,
    ).toEqual({
      jetbrains: {
        air: {
          version: 1,
          permission: {
            version: 1,
            title: "Read /work/a.ts",
          },
        },
      },
    });
    expect(
      buildClaudePermissionPresentation({
        capabilities: airCapabilities(),
        toolName: "Read",
        input: {},
        toolUseID: "tool-3",
        decisionReason: "internal_policy_code",
      })._meta,
    ).toEqual({
      jetbrains: {
        air: {
          version: 1,
          permission: {
            version: 1,
            title: "Read File",
            description: "Reason: internal_policy_code",
          },
        },
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
        capabilities: airCapabilities(),
        toolName,
        input,
        toolUseID: `tool-${toolName}`,
        description,
      });

      expect((presentation._meta as any)?.jetbrains?.air?.permission).not.toHaveProperty(
        "description",
      );
    },
  );

  it("adds a non-duplicated blocked path to standard locations", () => {
    const presentation = buildClaudePermissionPresentation({
      capabilities: airCapabilities(),
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
      capabilities: airCapabilities(),
      toolName: "mcp__demo__deploy",
      input: { target: "staging" },
      toolUseID: "tool-5",
    });
    expect(presentation.toolCall).toEqual({
      toolCallId: "tool-5",
      title: "mcp__demo__deploy",
      rawInput: { target: "staging" },
    });
    expect(presentation._meta).toEqual({
      jetbrains: { air: { version: 1, permission: { version: 1, title: "mcp__demo__deploy" } } },
    });
  });
});

describe("Claude permission presentation for a client that is not AIR", () => {
  it("repeats the whole tool call and sends no AIR key", () => {
    const input = { command: "npm test", description: "Run the tests" };
    const presentation = buildClaudePermissionPresentation({
      toolName: "Bash",
      input,
      toolUseID: "tool-1",
      title: "Run npm test?",
      decisionReason: "Needed to verify the change.",
      capabilities: new ClientCapabilities(true),
    });
    expect(presentation).toEqual({
      toolCall: {
        toolCallId: "tool-1",
        name: "Bash",
        status: "pending",
        rawInput: input,
        title: "npm test",
        kind: "execute",
        content: [{ type: "terminal", terminalId: "tool-1" }],
      },
    });
  });

  it("keeps the Write file text in rawInput and adds a blocked path", () => {
    const input = { file_path: "/work/a.ts", content: "x" };
    const presentation = buildClaudePermissionPresentation({
      toolName: "Write",
      input,
      toolUseID: "tool-2",
      cwd: "/work",
      blockedPath: "/outside/b.ts",
    });
    expect(presentation.toolCall).toEqual({
      toolCallId: "tool-2",
      name: "Write",
      status: "pending",
      rawInput: input,
      title: "Write a.ts",
      kind: "edit",
      content: [{ type: "diff", path: "/work/a.ts", oldText: null, newText: "x" }],
      locations: [{ path: "/work/a.ts" }, { path: "/outside/b.ts" }],
    });
    expect(presentation).not.toHaveProperty("_meta");
  });

  it("shows the input of a network request that has no content", () => {
    const presentation = buildClaudePermissionPresentation({
      toolName: "SandboxNetworkAccess",
      input: { host: "example.com" },
      toolUseID: "tool-3",
    });
    expect(presentation.toolCall).toMatchObject({
      title: "example.com",
      content: [
        {
          type: "content",
          content: { type: "text", text: '```json\n{\n  "host": "example.com"\n}\n```' },
        },
      ],
    });
  });
});
