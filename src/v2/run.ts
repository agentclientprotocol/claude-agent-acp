import * as v2 from "@agentclientprotocol/sdk/experimental/v2";
import { v1AgentApp, type ClaudeAcpAgent, type Logger } from "../acp-agent.js";
import { nodeToWebReadable, nodeToWebWritable } from "../utils.js";
import { v2AgentApp } from "./agent.js";

/**
 * Set this environment variable to `1` to serve the experimental draft ACP v2
 * to clients that request it. Without it the adapter serves ACP v1 only,
 * exactly as before, and never routes by protocol version.
 */
export const EXPERIMENTAL_ACP_V2_ENV = "CLAUDE_AGENT_ACP_EXPERIMENTAL_V2";

/**
 * Routes a connection to the protocol version that the client negotiates in
 * `initialize`: the experimental draft ACP v2 for a client that requests
 * version 2 or later, and ACP v1 otherwise. `onAgent` receives the agent of
 * the connection once the router has opened it.
 */
export function acpProtocolRouter(
  logger: Logger | undefined,
  onAgent: (agent: ClaudeAcpAgent) => void,
): v2.AgentProtocolRouter {
  return v2
    .agentProtocolRouter()
    .withV1(v1AgentApp(logger, onAgent))
    .withV2(v2AgentApp(logger, onAgent));
}

/** Serves ACP on stdio through {@link acpProtocolRouter}. */
export function runAcpWithExperimentalV2(logger?: Logger): {
  closed: Promise<void>;
  dispose(): Promise<void>;
} {
  const stream = v2.ndJsonStream(
    nodeToWebWritable(process.stdout),
    nodeToWebReadable(process.stdin),
  );
  // The router opens the connection of the negotiated version only when it
  // reads `initialize`. Before that, and when the client leaves without
  // initializing, there is no agent.
  let agent: ClaudeAcpAgent | undefined;
  const connection = acpProtocolRouter(logger, (created) => {
    agent = created;
  }).connect(stream);
  if (!connection.closed) {
    throw new Error("The ACP protocol router reports no connection close");
  }
  return {
    closed: connection.closed,
    dispose: async () => {
      await agent?.dispose();
    },
  };
}
