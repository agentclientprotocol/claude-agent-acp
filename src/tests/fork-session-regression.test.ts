import { describe, it, expect } from "vitest";
import { AcpClient, ClaudeAcpAgent } from "../acp-agent.js";

function createMockClient(): AcpClient {
  return {
    sessionUpdate: async () => {},
    requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
    readTextFile: async () => ({ content: "" }),
    writeTextFile: async () => ({}),
  } as unknown as AcpClient;
}

// Regression test for https://github.com/agentclientprotocol/claude-agent-acp/issues/1110
//
// Since #1046, `unstable_forkSession` returned only `{ sessionId }` from the
// raw SDK fork, without registering the new id in `this.sessions`. A client
// that treats the fork reply as a ready session (per the session-fork RFD,
// which says the reply carries the same shape as `session/new`) got
// "Session not found" on the first prompt against the forked id.
describe.skipIf(!process.env.RUN_INTEGRATION_TESTS)("session/fork regression (#1110)", () => {
  it("forked session accepts a prompt immediately, with the reply carrying configOptions like session/new", async () => {
    const agent = new ClaudeAcpAgent(createMockClient());

    try {
      const { sessionId } = await agent.newSession({ cwd: process.cwd(), mcpServers: [] });
      await agent.prompt({
        sessionId,
        prompt: [{ type: "text", text: "The secret code is ABC123. Just confirm you got it." }],
      });

      const forked = await agent.unstable_forkSession({ sessionId, cwd: process.cwd() });

      // Before the fix this was `{ sessionId }` only -- no modes/configOptions,
      // and the id was not registered, so the prompt below threw
      // "Session not found".
      expect(forked.configOptions).toBeDefined();
      expect(forked.configOptions?.length).toBeGreaterThan(0);

      await expect(
        agent.prompt({
          sessionId: forked.sessionId,
          prompt: [{ type: "text", text: "What secret code did I just tell you? Just the code." }],
        }),
      ).resolves.toBeDefined();
    } finally {
      await agent.dispose();
    }
  }, 60000);
});
