import { beforeEach, describe, expect, it } from "vitest";
import type { SessionNotification } from "@agentclientprotocol/sdk";
import { ClaudeAcpAgent, type AcpClient } from "../acp-agent.js";
import { makeMockQuery } from "./helpers.js";

const SESSION_ID = "test-session-id";

describe("session permission updates", () => {
  let agent: ClaudeAcpAgent;
  let capturedPermissionRequest: any;
  let permissionResponse: any;
  let sessionUpdates: SessionNotification[];

  beforeEach(() => {
    capturedPermissionRequest = null;
    permissionResponse = { outcome: { outcome: "cancelled" } };
    sessionUpdates = [];
    const client = {
      sessionUpdate: async (notification: SessionNotification) => {
        sessionUpdates.push(notification);
      },
      requestPermission: async (params: any) => {
        capturedPermissionRequest = params;
        return permissionResponse;
      },
      readTextFile: async () => ({ content: "" }),
      writeTextFile: async () => ({}),
    } as unknown as AcpClient;
    agent = new ClaudeAcpAgent(client);

    agent.sessions[SESSION_ID] = {
      query: makeMockQuery(),
      cwd: process.cwd(),
      modes: {
        currentModeId: "plan",
        availableModes: [
          { id: "default", name: "Manual" },
          { id: "acceptEdits", name: "Accept edits" },
          { id: "plan", name: "Plan" },
        ],
      },
      models: { currentModelId: "opus", availableModels: [] },
      modelInfos: [],
      configOptions: [],
      emittedToolCalls: new Set(["toolu_1"]),
      contextWindowSize: 200_000,
      toolUseCache: {},
    } as any;
  });

  it("maps an ExitPlanMode choice to the selected session mode effect", async () => {
    permissionResponse = { outcome: { outcome: "selected", optionId: "exit-plan-default" } };

    const result = await (agent as any).canUseTool(SESSION_ID)(
      "ExitPlanMode",
      { plan: "do stuff" },
      { signal: new AbortController().signal, toolUseID: "toolu_1" },
    );

    expect(capturedPermissionRequest.options.map((option: any) => option.optionId)).toEqual([
      "exit-plan-default",
      "exit-plan-clear-accept-edits",
      "exit-plan-accept-edits",
      "reject",
    ]);
    expect(capturedPermissionRequest._meta).toEqual({
      permission: { version: 1, title: "Ready to code?" },
    });
    expect(result.updatedPermissions).toEqual([
      { type: "setMode", mode: "default", destination: "session" },
    ]);
    expect(agent.sessions[SESSION_ID].modes.currentModeId).toBe("plan");
    expect(sessionUpdates).toHaveLength(0);
  });

  it("falls an Auto permission effect back when the current model cannot use Auto", async () => {
    const session = agent.sessions[SESSION_ID];
    session.modes.availableModes.push({ id: "auto", name: "Auto" });
    session.models.currentModelId = "haiku";
    session.modelInfos = [{ value: "haiku", displayName: "Haiku", description: "" }];
    permissionResponse = { outcome: { outcome: "selected", optionId: "exit-plan-auto" } };

    const result = await (agent as any).canUseTool(SESSION_ID)(
      "ExitPlanMode",
      { plan: "do stuff" },
      { signal: new AbortController().signal, toolUseID: "toolu_1" },
    );

    expect(result.updatedPermissions).toEqual([
      { type: "setMode", mode: "acceptEdits", destination: "session" },
    ]);
    expect(
      sessionUpdates.filter(
        (notification) => notification.update.sessionUpdate === "agent_message_chunk",
      ),
    ).toHaveLength(1);
  });
});
