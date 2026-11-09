import * as v2 from "@agentclientprotocol/sdk/experimental/v2";
import { v1AgentApp, type ClaudeAcpAgent, type Logger } from "./acp-agent.js";
import { nodeToWebReadable, nodeToWebWritable } from "./utils.js";
import { v2AgentApp } from "./v2/agent.js";
import { nativeV2AgentApp, type AgentHandle } from "./v2-native/agent.js";

/**
 * The ACP versions that the adapter serves: `v1` or `v2` alone, or both with
 * `auto`, where the client's `initialize` picks the version.
 */
export type AcpProtocols = "auto" | "v1" | "v2";

/**
 * Reads `CLAUDE_AGENT_ACP_PROTOCOL`: unset, empty, or `auto` serves both
 * versions, and `v1` or `v2` serves that version alone. Throws on any other
 * value, so that a typo such as `CLAUDE_AGENT_ACP_PROTOCOL=1` fails at startup
 * instead of silently serving both.
 */
export function acpProtocolsFromEnv(value: string | undefined): AcpProtocols {
  if (value === undefined || value === "") return "auto";
  if (value === "auto" || value === "v1" || value === "v2") return value;
  throw new Error(
    `CLAUDE_AGENT_ACP_PROTOCOL must be "auto", "v1", or "v2", not ${JSON.stringify(value)}`,
  );
}

/**
 * The implementation that serves ACP v2:
 *
 * - `bridge` (the default): `src/v2/`, which converts each v2 request to v1
 *   and serves it with `ClaudeAcpAgent`.
 * - `native`: `src/v2-native/`, which serves v2 straight from Claude Code.
 *   Experimental: see `docs/v2-native-core.md` for what it does not serve.
 */
export type V2Core = "bridge" | "native";

/**
 * Reads `CLAUDE_AGENT_ACP_V2_CORE`: unset or empty is `bridge`. Throws on any
 * value other than `bridge` and `native`.
 */
export function v2CoreFromEnv(value: string | undefined): V2Core {
  if (value === undefined || value === "") return "bridge";
  if (value === "bridge" || value === "native") return value;
  throw new Error(
    `CLAUDE_AGENT_ACP_V2_CORE must be "bridge" or "native", not ${JSON.stringify(value)}`,
  );
}

/** Serves ACP on stdio through {@link acpProtocolRouter}. */
export function serveAcp(
  logger: Logger | undefined,
  options: { protocols: AcpProtocols; v2Core?: V2Core },
): { closed: Promise<void>; dispose(): Promise<void> } {
  const output = nodeToWebWritable(process.stdout);
  const input = nodeToWebReadable(process.stdin);
  // The router opens the connection of the negotiated version only when it
  // reads `initialize`, so a client that leaves before then leaves no agent.
  let agent: AgentHandle | undefined;
  const onAgent = (created: AgentHandle) => {
    agent = created;
  };
  const { closed } = acpProtocolRouter(logger, onAgent, options.protocols, {
    v2Core: options.v2Core,
    onNativeAgent: onAgent,
  }).connect(v2.ndJsonStream(output, input));
  return {
    closed,
    dispose: async () => {
      await agent?.dispose();
    },
  };
}

/**
 * Routes a connection to the protocol version that the client negotiates in
 * `initialize`. With `auto`, a client that requests version 2 or later gets
 * the draft ACP v2, and every other client gets ACP v1. With `v1`, a v2
 * client is negotiated down to v1. With `v2`, the router rejects the
 * `initialize` of a v1 client as an unsupported protocol version. `onAgent`
 * receives the agent of the connection once the router has opened it, and
 * `onNativeAgent` the agent of a v2 connection that the native core serves
 * (`v2Core: "native"`).
 */
export function acpProtocolRouter(
  logger: Logger | undefined,
  onAgent: (agent: ClaudeAcpAgent) => void,
  protocols: AcpProtocols = "auto",
  {
    v2Core = "bridge",
    onNativeAgent = () => {},
  }: { v2Core?: V2Core; onNativeAgent?: (agent: AgentHandle) => void } = {},
): v2.AgentProtocolRouter {
  const router = v2.agentProtocolRouter();
  if (protocols !== "v2") router.withV1(v1AgentApp(logger, onAgent));
  if (protocols !== "v1") {
    router.withV2(
      v2Core === "native" ? nativeV2AgentApp(logger, onNativeAgent) : v2AgentApp(logger, onAgent),
    );
  }
  return router;
}
