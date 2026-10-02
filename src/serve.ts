import { ndJsonStream } from "@agentclientprotocol/sdk";
import * as v2 from "@agentclientprotocol/sdk/experimental/v2";
import { v1AgentApp, type ClaudeAcpAgent, type Logger } from "./acp-agent.js";
import { nodeToWebReadable, nodeToWebWritable } from "./utils.js";
import { v2AgentApp } from "./v2/agent.js";

/**
 * Serves ACP on stdio.
 *
 * With `experimentalV2`, the connection goes through {@link acpProtocolRouter}.
 * Without it, the adapter serves ACP v1 alone and never routes by protocol
 * version, exactly as before.
 */
export function serveAcp(
  logger: Logger | undefined,
  options: { experimentalV2: boolean },
): { closed: Promise<void>; dispose(): Promise<void> } {
  const output = nodeToWebWritable(process.stdout);
  const input = nodeToWebReadable(process.stdin);
  // The router opens the connection of the negotiated version only when it
  // reads `initialize`, so a client that leaves before then leaves no agent.
  let agent: ClaudeAcpAgent | undefined;
  const onAgent = (created: ClaudeAcpAgent) => {
    agent = created;
  };
  const { closed } = options.experimentalV2
    ? acpProtocolRouter(logger, onAgent).connect(v2.ndJsonStream(output, input))
    : v1AgentApp(logger, onAgent).connect(ndJsonStream(output, input));
  return {
    closed,
    dispose: async () => {
      await agent?.dispose();
    },
  };
}

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
