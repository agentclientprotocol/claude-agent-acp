import * as v2 from "@agentclientprotocol/sdk/experimental/v2";
import { v1AgentApp, type ClaudeAcpAgent, type Logger } from "./acp-agent.js";
import { isAirClient } from "./air-extension.js";
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
 * - `native` (the default): `src/v2-native/`, which serves v2 straight from
 *   Claude Code. See `docs/v2-native-core.md` for what it does not serve. A
 *   JetBrains AIR client still gets the bridge (see {@link airClientsOnBridge}).
 * - `bridge`: `src/v2/`, which converts each v2 request to v1 and serves it
 *   with `ClaudeAcpAgent`. The fallback until the bridge is deleted.
 */
export type V2Core = "bridge" | "native";

/**
 * Reads `CLAUDE_AGENT_ACP_V2_CORE`: unset or empty is `native`. Throws on any
 * value other than `bridge` and `native`.
 */
export function v2CoreFromEnv(value: string | undefined): V2Core {
  if (value === undefined || value === "") return "native";
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
 * receives the v1 core's agent of the connection once the router has opened
 * it (a v1 connection, or a v2 one that the bridge serves), and
 * `onNativeAgent` the agent of a v2 connection that the native core serves
 * (`v2Core: "native"`, the default, for every client but JetBrains AIR).
 */
export function acpProtocolRouter(
  logger: Logger | undefined,
  onAgent: (agent: ClaudeAcpAgent) => void,
  protocols: AcpProtocols = "auto",
  {
    v2Core = "native",
    onNativeAgent = () => {},
  }: { v2Core?: V2Core; onNativeAgent?: (agent: AgentHandle) => void } = {},
): v2.AgentProtocolRouter {
  const router = v2.agentProtocolRouter();
  if (protocols !== "v2") router.withV1(v1AgentApp(logger, onAgent));
  if (protocols !== "v1") {
    router.withV2(
      v2Core === "native"
        ? airClientsOnBridge(nativeV2AgentApp(logger, onNativeAgent), v2AgentApp(logger, onAgent))
        : v2AgentApp(logger, onAgent),
    );
  }
  return router;
}

/**
 * Serves a v2 connection with `native`, or with `bridge` when its `initialize`
 * declares `_meta.jetbrains.air` in its capabilities. The native core serves no
 * AIR extension, and the bridge serves a v2 AIR client the v1 core's:
 * `sessionFailure` records (with the "Retrying Claude" warnings), prompt
 * suggestions, file change reports, the AIR permission presentation and
 * `recommendedValue`, and AIR's subagent form.
 */
function airClientsOnBridge(
  native: v2.AgentConnector,
  bridge: v2.AgentConnector,
): v2.AgentConnector {
  return {
    connect(stream, options) {
      let resolveClosed!: () => void;
      const closed = new Promise<void>((resolve) => (resolveClosed = resolve));
      let startRequested = options?.deferConnectHandlers !== true;
      let selected: v2.AgentConnectionLifecycle | undefined;
      let started = false;
      const start = () => {
        if (!startRequested || started || !selected?.startConnectHandlers) return;
        started = true;
        selected.startConnectHandlers();
      };
      const reader = stream.readable.getReader();
      void (async () => {
        // The router hands over a stream whose first message is the
        // `initialize` that it routed.
        const first = await reader.read();
        if (first.done) {
          reader.releaseLock();
          await stream.writable.close();
          return;
        }
        const params = (first.value as { params?: { capabilities?: unknown } }).params;
        let pending: v2.AnyMessage | undefined = first.value;
        const readable = new ReadableStream<v2.AnyMessage>({
          async pull(controller) {
            if (pending !== undefined) {
              controller.enqueue(pending);
              pending = undefined;
              return;
            }
            const next = await reader.read();
            if (next.done) controller.close();
            else controller.enqueue(next.value);
          },
          cancel: (reason) => reader.cancel(reason),
        });
        const agent = isAirClient(params?.capabilities) ? bridge : native;
        const connection = agent.connect(
          { readable, writable: stream.writable },
          { deferConnectHandlers: true },
        ) as v2.AgentConnectionLifecycle;
        selected = connection;
        start();
        await connection.closed;
      })()
        .catch(async (error: unknown) => {
          await stream.writable.abort(error).catch(() => {});
        })
        .finally(resolveClosed);
      return {
        closed,
        startConnectHandlers() {
          startRequested = true;
          start();
        },
      };
    },
  };
}
