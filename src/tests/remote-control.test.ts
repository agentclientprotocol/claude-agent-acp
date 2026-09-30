import { describe, it, expect, vi } from "vitest";
import type { AgentSideConnection as AcpClient } from "@agentclientprotocol/sdk";
import { ClaudeAcpAgent } from "../acp-agent.js";
import { mockSessionState } from "./session-doubles.js";

function createAgent(query: Record<string, unknown>) {
  const sessionUpdate = vi.fn(async () => {});
  const client = { sessionUpdate } as unknown as AcpClient;
  const agent = new ClaudeAcpAgent(client, { log: () => {}, error: () => {} });
  agent.sessions["session-1"] = mockSessionState({ query });
  return { agent, sessionUpdate };
}

const prompt = (text: string) => ({
  sessionId: "session-1",
  prompt: [{ type: "text" as const, text }],
});

describe("/remote-control", () => {
  it.each(["/remote-control", "/rc"])(
    "starts Remote Control for %s and reports the URL",
    async (command) => {
      const enableRemoteControl = vi.fn(async () => ({
        session_url: "https://claude.ai/code/session_123",
      }));
      const { agent, sessionUpdate } = createAgent({ enableRemoteControl });

      const response = await agent.prompt(prompt(command));

      expect(response.stopReason).toBe("end_turn");
      expect(enableRemoteControl).toHaveBeenCalledWith(true, undefined);
      expect(sessionUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          update: expect.objectContaining({
            sessionUpdate: "agent_message_chunk",
            content: {
              type: "text",
              text: expect.stringContaining("https://claude.ai/code/session_123"),
            },
          }),
        }),
      );
    },
  );

  it("passes the argument as the session name", async () => {
    const enableRemoteControl = vi.fn(async () => ({ session_url: "https://claude.ai/code/s" }));
    const { agent } = createAgent({ enableRemoteControl });

    await agent.prompt(prompt("/remote-control My laptop session"));

    expect(enableRemoteControl).toHaveBeenCalledWith(true, "My laptop session");
  });

  it("reports the failure to the user when Remote Control cannot start", async () => {
    const enableRemoteControl = vi.fn(async () => {
      throw new Error("Remote Control is disabled by policy");
    });
    const { agent, sessionUpdate } = createAgent({ enableRemoteControl });

    const response = await agent.prompt(prompt("/rc"));

    expect(response.stopReason).toBe("end_turn");
    expect(sessionUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          content: {
            type: "text",
            text: expect.stringContaining("Remote Control is disabled by policy"),
          },
        }),
      }),
    );
  });

  it("advertises the command only when the query supports it", async () => {
    const supportedCommands = async () => [{ name: "compact", description: "", argumentHint: "" }];
    const supported = createAgent({ enableRemoteControl: vi.fn(), supportedCommands });
    const unsupported = createAgent({ supportedCommands });

    await (supported.agent as any).sendAvailableCommandsUpdate("session-1");
    await (unsupported.agent as any).sendAvailableCommandsUpdate("session-1");

    const names = (update: ReturnType<typeof createAgent>["sessionUpdate"]) =>
      (update.mock.calls as any[][])[0][0].update.availableCommands.map((c: any) => c.name);
    expect(names(supported.sessionUpdate)).toEqual(["compact", "remote-control"]);
    expect(names(unsupported.sessionUpdate)).toEqual(["compact"]);
  });
});
