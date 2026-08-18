import { describe, expect, it } from "vitest";
import { normalizeDurablePermissionChangeSet } from "../permissions/normalization.js";
import { buildClaudePermissionOptions, PERMISSION_OPTION_ID } from "../permissions/options.js";
import { buildClaudePermissionPresentation } from "../permissions/presentation.js";
import { mapClaudePermissionResponse } from "../permissions/response.js";

const rule = { toolName: "Bash", ruleContent: "npm test:*" };
describe("Claude permission options and response mapping", () => {
  const build = (
    toolName: string,
    durableChangeSet?: ReturnType<typeof normalizeDurablePermissionChangeSet>,
    input: Record<string, unknown> = {},
    displayName?: string,
    allowPersistentOptions = true,
    availableModes: readonly string[] = [],
    contextUsedPercent?: number,
  ) =>
    buildClaudePermissionOptions({
      toolName,
      displayName,
      input,
      cwd: "/workspace",
      durableChangeSet,
      allowPersistentOptions,
      availableModes,
      contextUsedPercent,
    });

  it("builds the native Bash static-suggestions option from the exact update bundle", () => {
    const changeSet = normalizeDurablePermissionChangeSet([
      { type: "addRules", rules: [rule], behavior: "allow", destination: "session" },
      { type: "addDirectories", directories: ["/work"], destination: "session" },
    ]);
    expect(build("Bash", changeSet, { command: "npm test" })).toEqual([
      { optionId: PERMISSION_OPTION_ID.allowOnce, name: "Yes", kind: "allow_once" },
      {
        optionId: PERMISSION_OPTION_ID.allowWithUpdates,
        name: "Yes, and allow access to work/ and npm test commands",
        kind: "allow_always",
      },
      { optionId: PERMISSION_OPTION_ID.reject, name: "No", kind: "reject_once" },
    ]);
  });

  it.each([
    [
      "Bash",
      [
        {
          type: "addRules",
          rules: [{ toolName: "Bash", ruleContent: "npm test:*" }],
          behavior: "allow",
          destination: "session",
        },
      ],
      "Yes, and don't ask again for npm test commands",
    ],
    [
      "PowerShell",
      [
        {
          type: "addRules",
          rules: [{ toolName: "PowerShell", ruleContent: "Get-Process:*" }],
          behavior: "allow",
          destination: "session",
        },
      ],
      "Yes, and don't ask again for Get-Process commands",
    ],
    [
      "Bash",
      [
        {
          type: "addRules",
          rules: [{ toolName: "Read", ruleContent: "/outside/**" }],
          behavior: "allow",
          destination: "session",
        },
      ],
      "Yes, allow reading from outside/ from this project",
    ],
    [
      "Bash",
      [{ type: "addDirectories", directories: ["/outside"], destination: "session" }],
      "Yes, and always allow access to outside/ from this project",
    ],
  ] as const)("ports the native static shell label for %s", (toolName, updates, expected) => {
    const changeSet = normalizeDurablePermissionChangeSet(updates);
    expect(build(toolName, changeSet)[1]?.name).toBe(expected);
  });

  it("uses Claude Code's `similar` truncation for long command lists", () => {
    const changeSet = normalizeDurablePermissionChangeSet([
      {
        type: "addRules",
        rules: [
          { toolName: "Bash", ruleContent: "a-very-long-command-name-one:*" },
          { toolName: "Bash", ruleContent: "a-very-long-command-name-two:*" },
        ],
        behavior: "allow",
        destination: "session",
      },
    ]);
    expect(build("Bash", changeSet)[1]?.name).toBe("Yes, and don't ask again for similar commands");
  });

  it("uses the shortest distinguishing parent for paths with the same basename", () => {
    const changeSet = normalizeDurablePermissionChangeSet([
      {
        type: "addRules",
        rules: [
          { toolName: "Read", ruleContent: "/repos/codex-acp/src/**" },
          { toolName: "Read", ruleContent: "/repos/claude-agent-acp/src/**" },
          { toolName: "Bash", ruleContent: "ls -R:*" },
        ],
        behavior: "allow",
        destination: "session",
      },
    ]);
    expect(build("Bash", changeSet)[1]?.name).toBe(
      "Yes, and allow codex-acp/src/ and claude-agent-acp/src/ access and ls -R commands",
    );
  });

  it("does not repeat an identical path in the durable option", () => {
    const changeSet = normalizeDurablePermissionChangeSet([
      {
        type: "addRules",
        rules: [
          { toolName: "Read", ruleContent: "/repos/codex-acp/src/**" },
          { toolName: "Read", ruleContent: "/repos/codex-acp/src/**" },
        ],
        behavior: "allow",
        destination: "session",
      },
    ]);
    expect(build("Bash", changeSet)[1]?.name).toBe(
      "Yes, allow reading from src/ from this project",
    );
  });

  it.each([
    "Bash",
    "PowerShell",
    "Read",
    "Edit",
    "Write",
    "NotebookEdit",
    "Glob",
    "Grep",
    "WebFetch",
    "SandboxNetworkAccess",
    "mcp__example__write_tool",
    "mcp__computer-use__click",
  ])("offers only one-time allow and reject for %s without a representable update", (toolName) => {
    expect(build(toolName).map((option) => option.name)).toEqual(["Yes", "No"]);
  });

  it("uses generated native effects instead of applying an unrelated provider suggestion", () => {
    const bashChangeSet = normalizeDurablePermissionChangeSet([
      { type: "addRules", rules: [rule], behavior: "allow", destination: "session" },
    ]);
    expect(build("Read", bashChangeSet, { file_path: "/workspace/a.ts" })).toHaveLength(2);
    expect(build("WebFetch", bashChangeSet, { url: "https://example.com" })[1]?.name).toBe(
      "Yes, and don't ask again for example.com",
    );
  });

  it("preserves an MCP tool's exact provider suggestion", () => {
    const toolName = "mcp__example__write_tool";
    const changeSet = normalizeDurablePermissionChangeSet([
      {
        type: "addRules",
        rules: [{ toolName }],
        behavior: "allow",
        destination: "localSettings",
      },
    ]);
    const offered = build(toolName, changeSet, {}, "Write tool");
    expect(offered.map((option) => option.name)).toEqual([
      "Yes",
      "Yes, and don't ask again for Write tool commands",
      "No",
    ]);
    const result = mapClaudePermissionResponse(
      { outcome: { outcome: "selected", optionId: PERMISSION_OPTION_ID.allowWithUpdates } },
      toolName,
      { value: "new" },
      "tool-mcp-write",
      offered,
      changeSet,
    );
    expect(result.behavior === "allow" && result.updatedPermissions).toEqual(changeSet?.updates);
  });

  it.each([
    ["Read", { file_path: "/workspace/a.ts" }, "Yes, during this session"],
    [
      "Read",
      { file_path: "/outside/a.ts" },
      "Yes, allow reading from outside/ during this session",
    ],
    ["Edit", { file_path: "/workspace/a.ts" }, "Yes, allow all edits during this session"],
    [
      "Write",
      { file_path: "/outside/a.ts" },
      "Yes, allow all edits in outside/ during this session",
    ],
    [
      "NotebookEdit",
      { notebook_path: "/workspace/a.ipynb" },
      "Yes, allow all edits during this session",
    ],
    ["Glob", {}, "Yes, during this session"],
    ["Grep", {}, "Yes, during this session"],
  ] as const)("builds the native session label for %s", (toolName, input, durableName) => {
    const readOnly = toolName === "Read" || toolName === "Glob" || toolName === "Grep";
    const outside = Object.values(input).some(
      (value) => typeof value === "string" && value.startsWith("/outside"),
    );
    const changeSet = normalizeDurablePermissionChangeSet(
      readOnly
        ? [
            {
              type: "addRules",
              rules: [{ toolName: "Read", ruleContent: outside ? "/outside/**" : "/workspace/**" }],
              behavior: "allow",
              destination: "session",
            },
          ]
        : outside
          ? [{ type: "addDirectories", directories: ["/outside"], destination: "session" }]
          : [{ type: "setMode", mode: "acceptEdits", destination: "session" }],
    );
    expect(build(toolName, changeSet, input).map((option) => option.name)).toEqual([
      "Yes",
      durableName,
      "No",
    ]);
  });

  it("does not call a persistent filesystem update a session grant", () => {
    const changeSet = normalizeDurablePermissionChangeSet([
      { type: "addDirectories", directories: ["/outside"], destination: "localSettings" },
    ]);
    expect(build("Read", changeSet, { file_path: "/outside/a.ts" })).toHaveLength(2);
  });

  it("does not offer a path-specific filesystem effect for a different in-project path", () => {
    const read = normalizeDurablePermissionChangeSet([
      {
        type: "addRules",
        rules: [{ toolName: "Read", ruleContent: "/outside/**" }],
        behavior: "allow",
        destination: "session",
      },
    ]);
    const write = normalizeDurablePermissionChangeSet([
      { type: "addDirectories", directories: ["/outside"], destination: "session" },
    ]);
    expect(build("Read", read, { file_path: "/workspace/a.ts" })).toHaveLength(2);
    expect(build("Edit", write, { file_path: "/workspace/a.ts" })).toHaveLength(2);
  });

  it("resolves relative permission paths from the session cwd", () => {
    const changeSet = normalizeDurablePermissionChangeSet([
      {
        type: "addRules",
        rules: [{ toolName: "Read", ruleContent: "src/**" }],
        behavior: "allow",
        destination: "session",
      },
    ]);
    expect(build("Read", changeSet, { file_path: "/workspace/src/a.ts" })[1]?.name).toBe(
      "Yes, during this session",
    );
  });

  it("recognizes a backslash glob suffix in a provider path rule", () => {
    const changeSet = normalizeDurablePermissionChangeSet([
      {
        type: "addRules",
        rules: [{ toolName: "Read", ruleContent: "/outside\\**" }],
        behavior: "allow",
        destination: "session",
      },
    ]);
    expect(build("Read", changeSet, { file_path: "/outside/a.ts" })[1]?.name).toBe(
      "Yes, allow reading from outside/ during this session",
    );
  });

  it("treats acceptEdits as broad only for ordinary write paths", () => {
    const changeSet = normalizeDurablePermissionChangeSet([
      { type: "setMode", mode: "acceptEdits", destination: "session" },
    ]);
    expect(build("Edit", changeSet, { file_path: "/workspace/a.ts" })[1]?.name).toBe(
      "Yes, allow all edits during this session",
    );
    expect(
      build("Edit", changeSet, { file_path: "/workspace/.claude/settings.json" }),
    ).toHaveLength(2);
    expect(build("Read", changeSet, { file_path: "/workspace/a.ts" })).toHaveLength(2);
  });

  it("builds WebFetch and sandbox-host labels from provider data", () => {
    const webFetch = normalizeDurablePermissionChangeSet([
      {
        type: "addRules",
        rules: [{ toolName: "WebFetch", ruleContent: "domain:example.com" }],
        behavior: "allow",
        destination: "localSettings",
      },
    ]);
    expect(build("WebFetch", webFetch, { url: "https://example.com/a" })[1]?.name).toBe(
      "Yes, and don't ask again for example.com",
    );
    const network = normalizeDurablePermissionChangeSet([
      {
        type: "addRules",
        rules: [{ toolName: "SandboxNetworkAccess", ruleContent: "example.com" }],
        behavior: "allow",
        destination: "localSettings",
      },
    ]);
    expect(build("SandboxNetworkAccess", network, { host: "example.com" })[1]?.name).toBe(
      "Yes, and don't ask again for example.com",
    );
  });

  it("uses Claude Code's special session label for its own settings", () => {
    const changeSet = normalizeDurablePermissionChangeSet([
      {
        type: "addRules",
        rules: [{ toolName: "Edit", ruleContent: "/workspace/.claude/**" }],
        behavior: "allow",
        destination: "session",
      },
    ]);
    expect(build("Edit", changeSet, { file_path: ".claude/settings.json" })[1]?.name).toBe(
      "Yes, and allow Claude to edit its own settings for this session",
    );
  });

  it("builds Claude Code's exact and prefix Skill options from tool input", () => {
    expect(build("Skill", undefined, { skill: "deploy prod" })).toMatchObject([
      { optionId: PERMISSION_OPTION_ID.allowOnce, name: "Yes" },
      {
        optionId: PERMISSION_OPTION_ID.allowSkillExact,
        name: "Yes, and don't ask again for deploy prod",
      },
      {
        optionId: PERMISSION_OPTION_ID.allowSkillPrefix,
        name: "Yes, and don't ask again for deploy:* commands",
      },
      { optionId: PERMISSION_OPTION_ID.reject, name: "No" },
    ]);
  });

  it("suppresses generated Skill rules when a configured ask rule forced the prompt", () => {
    expect(build("Skill", undefined, { skill: "deploy prod" }, undefined, false)).toEqual([
      { optionId: PERMISSION_OPTION_ID.allowOnce, name: "Yes", kind: "allow_once" },
      { optionId: PERMISSION_OPTION_ID.reject, name: "No", kind: "reject_once" },
    ]);
  });

  it("keeps EnterPlanMode at its two reachable one-time choices", () => {
    expect(build("EnterPlanMode")).toMatchObject([
      {
        optionId: PERMISSION_OPTION_ID.allowOnce,
        name: "Yes, enter plan mode",
      },
      { optionId: PERMISSION_OPTION_ID.reject, name: "No, start implementing now" },
    ]);
  });

  it("offers only the highest-priority elevated ExitPlanMode choice", () => {
    const options = build("ExitPlanMode", undefined, {}, undefined, true, [
      "auto",
      "default",
      "acceptEdits",
      "bypassPermissions",
    ]);
    expect(options).toMatchObject([
      { optionId: PERMISSION_OPTION_ID.exitPlanDefault, name: "Yes, manually approve edits" },
      { optionId: PERMISSION_OPTION_ID.exitPlanAuto, name: "Yes, and use auto mode" },
      { optionId: PERMISSION_OPTION_ID.reject, name: "No, keep planning" },
    ]);
    expect(options[2]?._meta).toBeUndefined();
  });

  it.each([
    [
      ["bypassPermissions", "acceptEdits"],
      PERMISSION_OPTION_ID.exitPlanBypass,
      "Yes, and bypass permissions",
    ],
    [["acceptEdits"], PERMISSION_OPTION_ID.exitPlanAcceptEdits, "Yes, auto-accept edits"],
    [[], PERMISSION_OPTION_ID.exitPlanAcceptEdits, "Yes, auto-accept edits"],
  ] as const)("falls back through the native ExitPlanMode priority", (modes, optionId, name) => {
    expect(build("ExitPlanMode", undefined, {}, undefined, true, modes)).toMatchObject([
      { optionId: PERMISSION_OPTION_ID.exitPlanDefault, name: "Yes, manually approve edits" },
      { optionId, name },
      { optionId: PERMISSION_OPTION_ID.reject, name: "No, keep planning" },
    ]);
  });

  it.each([
    [
      ["auto", "bypassPermissions", "acceptEdits"],
      PERMISSION_OPTION_ID.exitPlanClearAuto,
      "Yes, clear context (73% used) and use auto mode",
    ],
    [
      ["bypassPermissions", "acceptEdits"],
      PERMISSION_OPTION_ID.exitPlanClearBypass,
      "Yes, clear context (73% used) and bypass permissions",
    ],
    [
      ["acceptEdits"],
      PERMISSION_OPTION_ID.exitPlanClearAcceptEdits,
      "Yes, clear context (73% used) and auto-accept edits",
    ],
  ] as const)(
    "offers one clear-context ExitPlanMode choice using native priority",
    (modes, optionId, name) => {
      expect(
        build("ExitPlanMode", undefined, { plan: "Implement it" }, undefined, true, modes, 73),
      ).toContainEqual(expect.objectContaining({ optionId, name }));
    },
  );

  it("does not offer clear-context ExitPlanMode without a plan", () => {
    expect(
      build("ExitPlanMode", undefined, {}, undefined, true, ["auto"], 73).map(
        (option) => option.optionId,
      ),
    ).not.toContain(PERMISSION_OPTION_ID.exitPlanClearAuto);
  });

  it("recognizes real Computer Use MCP tools and preserves their exact durable suggestion", () => {
    const toolName = "mcp__computer-use__click";
    const changeSet = normalizeDurablePermissionChangeSet([
      {
        type: "addRules",
        rules: [{ toolName }],
        behavior: "allow",
        destination: "localSettings",
      },
    ]);
    const offered = build(toolName, changeSet, {}, "Click");
    expect(offered.map((option) => option.name)).toEqual([
      "Yes",
      "Yes, and don't ask again for Click",
      "No",
    ]);
    const result = mapClaudePermissionResponse(
      {
        outcome: {
          outcome: "selected",
          optionId: PERMISSION_OPTION_ID.allowWithUpdates,
        },
      },
      toolName,
      { x: 10, y: 20 },
      "tool-computer-use",
      offered,
      changeSet,
    );
    expect(result.behavior === "allow" && result.updatedPermissions).toEqual(changeSet?.updates);
  });

  it("reuses the Computer Use MCP tool-call title", () => {
    expect(
      buildClaudePermissionPresentation({
        toolName: "mcp__computer-use__screenshot",
        input: {},
        toolUseID: "tool-computer-use",
      })._meta,
    ).toEqual({
      permission: { version: 1, title: "mcp__computer-use__screenshot" },
    });
  });

  it("uses the provider display name for a matching generic-tool rule", () => {
    const changeSet = normalizeDurablePermissionChangeSet([
      {
        type: "addRules",
        rules: [{ toolName: "mcp__demo__deploy" }],
        behavior: "allow",
        destination: "localSettings",
      },
    ]);
    expect(build("mcp__demo__deploy", changeSet, {}, "Deploy")[1]?.name).toBe(
      "Yes, and don't ask again for Deploy commands",
    );
  });

  it("refuses to route AskUserQuestion through permission options", () => {
    expect(() => build("AskUserQuestion")).toThrow("handled by ACP elicitation");
  });
});
