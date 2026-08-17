import { describe, expect, it } from "vitest";
import type { PermissionUpdate } from "@anthropic-ai/claude-agent-sdk";
import { normalizeDurablePermissionChangeSet } from "../permissions/normalization.js";
import { buildClaudePermissionOptions, PERMISSION_OPTION_ID } from "../permissions/options.js";
import { mapClaudePermissionResponse } from "../permissions/response.js";

const rule = { toolName: "Bash", ruleContent: "npm test:*" };

describe("Claude permission response effects", () => {
  const build = (
    toolName: string,
    durableChangeSet?: ReturnType<typeof normalizeDurablePermissionChangeSet>,
    input: Record<string, unknown> = {},
    displayName?: string,
    allowPersistentOptions = true,
    availableModes: readonly string[] = [],
  ) =>
    buildClaudePermissionOptions({
      toolName,
      displayName,
      input,
      cwd: "/workspace",
      durableChangeSet,
      allowPersistentOptions,
      availableModes,
    });

  it.each([
    [PERMISSION_OPTION_ID.allowSkillExact, "deploy prod"],
    [PERMISSION_OPTION_ID.allowSkillPrefix, "deploy:*"],
  ])("applies the native Skill effect for %s", (optionId, ruleContent) => {
    const input = { skill: "deploy prod" };
    const result = mapClaudePermissionResponse(
      { outcome: { outcome: "selected", optionId } },
      "Skill",
      input,
      "tool-skill",
      build("Skill", undefined, input),
    );
    expect(result.behavior === "allow" && result.updatedPermissions).toEqual([
      {
        type: "addRules",
        rules: [{ toolName: "Skill", ruleContent }],
        behavior: "allow",
        destination: "localSettings",
      },
    ]);
  });

  it("applies generated WebFetch and fallback durable effects", () => {
    const webInput = { url: "https://example.com/path" };
    const web = mapClaudePermissionResponse(
      {
        outcome: {
          outcome: "selected",
          optionId: PERMISSION_OPTION_ID.allowWithUpdates,
        },
      },
      "WebFetch",
      webInput,
      "tool-web",
      build("WebFetch", undefined, webInput),
    );
    expect(web.behavior === "allow" && web.updatedPermissions).toEqual([
      {
        type: "addRules",
        rules: [{ toolName: "WebFetch", ruleContent: "domain:example.com" }],
        behavior: "allow",
        destination: "localSettings",
      },
    ]);

    const fallback = mapClaudePermissionResponse(
      {
        outcome: {
          outcome: "selected",
          optionId: PERMISSION_OPTION_ID.allowWithUpdates,
        },
      },
      "mcp__demo__deploy",
      { target: "staging" },
      "tool-mcp",
      build("mcp__demo__deploy"),
    );
    expect(fallback.behavior === "allow" && fallback.updatedPermissions).toEqual([
      {
        type: "addRules",
        rules: [{ toolName: "mcp__demo__deploy" }],
        behavior: "allow",
        destination: "localSettings",
      },
    ]);
  });

  it.each([
    ["Read", { file_path: "/outside/a.ts" }, "Read"],
    ["Glob", { path: "/outside" }, "Read"],
    ["Grep", { path: "/outside" }, "Read"],
    ["Edit", { file_path: "/outside/a.ts" }, "Edit"],
    ["Write", { file_path: "/outside/a.ts" }, "Edit"],
    ["NotebookEdit", { notebook_path: "/outside/a.ipynb" }, "Edit"],
  ] as const)(
    "applies the exact provider filesystem effect for %s",
    (toolName, input, ruleTool) => {
      const changeSet = normalizeDurablePermissionChangeSet([
        {
          type: "addRules",
          rules: [{ toolName: ruleTool, ruleContent: "/outside/**" }],
          behavior: "allow",
          destination: "session",
        },
      ])!;
      const result = mapClaudePermissionResponse(
        {
          outcome: {
            outcome: "selected",
            optionId: PERMISSION_OPTION_ID.allowWithUpdates,
          },
        },
        toolName,
        input,
        `tool-${toolName}`,
        build(toolName, changeSet, input),
        changeSet,
      );
      expect(result.behavior === "allow" && result.updatedPermissions).toEqual(changeSet.updates);
    },
  );

  it("suppresses generated durable effects when an ask rule forced the prompt", () => {
    expect(
      build("WebFetch", undefined, { url: "https://example.com" }, undefined, false),
    ).toHaveLength(2);
    expect(build("mcp__demo__deploy", undefined, {}, undefined, false)).toHaveLength(2);
  });

  it("allows EnterPlanMode temporarily without changing mode before the tool runs", () => {
    expect(
      mapClaudePermissionResponse(
        { outcome: { outcome: "selected", optionId: PERMISSION_OPTION_ID.allowOnce } },
        "EnterPlanMode",
        {},
        "tool-enter-plan",
        build("EnterPlanMode"),
      ),
    ).toEqual({
      behavior: "allow",
      updatedInput: {},
      toolUseID: "tool-enter-plan",
      decisionClassification: "user_temporary",
    });
  });

  it("applies the selected ExitPlanMode mode and maps rejection", () => {
    const input = { plan: "Implement it" };
    const offered = build("ExitPlanMode", undefined, input, undefined, true, [
      "auto",
      "default",
      "acceptEdits",
    ]);
    const approved = mapClaudePermissionResponse(
      {
        outcome: {
          outcome: "selected",
          optionId: PERMISSION_OPTION_ID.exitPlanAuto,
        },
      },
      "ExitPlanMode",
      input,
      "tool-plan",
      offered,
    );
    expect(approved.behavior === "allow" && approved.updatedPermissions).toEqual([
      { type: "setMode", mode: "auto", destination: "session" },
    ]);

    const acceptEditsOffered = build("ExitPlanMode", undefined, input, undefined, true, [
      "default",
      "acceptEdits",
    ]);
    const acceptEdits = mapClaudePermissionResponse(
      {
        outcome: {
          outcome: "selected",
          optionId: PERMISSION_OPTION_ID.exitPlanAcceptEdits,
        },
      },
      "ExitPlanMode",
      input,
      "tool-plan",
      acceptEditsOffered,
    );
    expect(acceptEdits.behavior === "allow" && acceptEdits.updatedPermissions).toEqual([
      { type: "setMode", mode: "acceptEdits", destination: "session" },
    ]);

    const rejected = mapClaudePermissionResponse(
      {
        outcome: {
          outcome: "selected",
          optionId: PERMISSION_OPTION_ID.reject,
        },
      },
      "ExitPlanMode",
      input,
      "tool-plan",
      offered,
    );
    expect(rejected).toMatchObject({
      behavior: "deny",
      message: "User chose to keep planning",
      interrupt: true,
      decisionClassification: "user_reject",
    });
  });

  it("interrupts the old query when ExitPlanMode clears context", () => {
    const input = { plan: "Implement it" };
    const offered = build("ExitPlanMode", undefined, input, undefined, true, ["auto"]);
    expect(
      mapClaudePermissionResponse(
        {
          outcome: {
            outcome: "selected",
            optionId: PERMISSION_OPTION_ID.exitPlanClearAuto,
          },
        },
        "ExitPlanMode",
        input,
        "tool-plan",
        offered,
      ),
    ).toEqual({
      behavior: "deny",
      message: "User accepted the plan and requested a fresh context",
      interrupt: true,
      toolUseID: "tool-plan",
      decisionClassification: "user_reject",
    });
  });

  it("maps one-time allow without remembered updates", () => {
    expect(
      mapClaudePermissionResponse(
        { outcome: { outcome: "selected", optionId: PERMISSION_OPTION_ID.allowOnce } },
        "Bash",
        { command: "pwd" },
        "tool-1",
        build("Bash"),
      ),
    ).toEqual({
      behavior: "allow",
      updatedInput: { command: "pwd" },
      toolUseID: "tool-1",
      decisionClassification: "user_temporary",
    });
  });

  it("maps durable allow to the snapshotted provider effect", () => {
    const suggestions: PermissionUpdate[] = [
      { type: "addRules", rules: [rule], behavior: "allow", destination: "session" },
    ];
    const changeSet = normalizeDurablePermissionChangeSet(suggestions);
    const result = mapClaudePermissionResponse(
      { outcome: { outcome: "selected", optionId: PERMISSION_OPTION_ID.allowWithUpdates } },
      "Bash",
      { command: "npm test" },
      "tool-2",
      build("Bash", changeSet),
      changeSet,
    );
    expect(result).toMatchObject({
      behavior: "allow",
      toolUseID: "tool-2",
      decisionClassification: "user_permanent",
    });
    expect(result.behavior === "allow" && result.updatedPermissions).toEqual(suggestions);
    expect(result.behavior === "allow" && result.updatedPermissions).not.toBe(suggestions);
  });

  it("distinguishes explicit reject from cancellation", () => {
    expect(
      mapClaudePermissionResponse(
        { outcome: { outcome: "selected", optionId: PERMISSION_OPTION_ID.reject } },
        "Bash",
        {},
        "tool-3",
        build("Bash"),
      ),
    ).toEqual({
      behavior: "deny",
      message: "User refused permission to run tool",
      toolUseID: "tool-3",
      decisionClassification: "user_reject",
    });
    expect(() =>
      mapClaudePermissionResponse(
        { outcome: { outcome: "cancelled" } },
        "Bash",
        {},
        "tool-3",
        build("Bash"),
      ),
    ).toThrow("Tool use aborted");
  });

  it("fails closed for an unavailable or unknown selection", () => {
    expect(() =>
      mapClaudePermissionResponse(
        { outcome: { outcome: "selected", optionId: PERMISSION_OPTION_ID.allowWithUpdates } },
        "Bash",
        {},
        "tool-4",
        build("Bash"),
      ),
    ).toThrow("Permission option was not offered");
    expect(() =>
      mapClaudePermissionResponse(
        { outcome: { outcome: "selected", optionId: "future" } },
        "Bash",
        {},
        "tool-4",
        build("Bash"),
      ),
    ).toThrow("Permission option was not offered");
  });
});
