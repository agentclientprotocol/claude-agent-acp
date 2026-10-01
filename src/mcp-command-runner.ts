import type { ContentBlock, PromptResponse, SessionNotification } from "@agentclientprotocol/sdk";
import type { McpServerStatus, Query } from "@anthropic-ai/claude-agent-sdk";
import {
  formatMcpStatus,
  formatMcpStatusUnavailable,
  formatUnknownMcpServer,
  needsReconnect,
  parseMcpCommand,
  type McpCommand,
  type McpReconnectNote,
  type McpReconnectResult,
} from "./mcp-command.js";

/** The part of a turn that a `/mcp` answer waits for. */
export type McpCommandTurn = {
  settled?: boolean;
  completion?: Promise<void>;
};

/** The part of a session that a `/mcp` answer reads. */
export type McpCommandSession = {
  query: Query;
  turnQueue?: readonly McpCommandTurn[];
};

/** What the `/mcp` answer needs from the agent. */
export type McpCommandHost = {
  sessionUpdate(notification: SessionNotification): Promise<void>;
  logError(message: string): void;
  /** The MCP OAuth flow for one server of the session, or `undefined` when
   *  the client cannot show the authorization URL or the query has no OAuth
   *  control. The flow resolves true when the server is authenticated, and
   *  stops when `signal` aborts. */
  mcpOAuth(
    sessionId: string,
    query: Query,
  ): ((server: string, signal: AbortSignal) => Promise<boolean>) | undefined;
};

/** The place of one `session/prompt` in the prompt order of its session. */
export type PromptAdmission = {
  /** Aborts on `session/cancel` while the prompt waits for its place or
   *  answers `/mcp`. */
  readonly signal: AbortSignal;
  /** Let the next prompt of the session go. A model prompt calls it when its
   *  turn is in the turn queue. The admission also releases when the prompt
   *  ends. Idempotent. */
  release(): void;
};

/** The admission chain of one session. `tail` settles when every admitted
 *  prompt has released. `open` maps the abort of each prompt that has not
 *  released to true for a `/mcp` prompt. */
type AdmissionChain = { tail: Promise<void>; open: Map<AbortController, boolean> };

// Deliberately no `usage`: the prompt did not run a model turn.
const CANCELLED: PromptResponse = { stopReason: "cancelled" };

/** The `/mcp` command of a prompt, or `null` for a prompt that goes to Claude Code. */
function mcpCommandOf(prompt: readonly ContentBlock[]): McpCommand | null {
  return prompt.length === 1 && prompt[0]?.type === "text" ? parseMcpCommand(prompt[0].text) : null;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const ABORTED = Symbol("aborted");

/** Wait for `operation` unless `signal` aborts first. Resolves to the value of
 *  the operation, or to `ABORTED` on abort. A rejection passes through. */
async function untilAborted<T>(
  operation: Promise<T>,
  signal: AbortSignal,
): Promise<T | typeof ABORTED> {
  if (signal.aborted) return ABORTED;
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<typeof ABORTED>((resolve) => {
        onAbort = () => resolve(ABORTED);
        signal.addEventListener("abort", onAbort, { once: true });
      }),
    ]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

/** Answers a `/mcp` prompt in the adapter, without a Claude Code turn.
 *  Claude Code's own `/mcp` tells the user to open a terminal, and its
 *  `/mcp reconnect` would run the reconnect a second time.
 *
 *  A `/mcp` answer is not an entry of the turn queue, because the consumer of
 *  the query stream matches each entry to a Claude Code message. The runner
 *  therefore admits every prompt of a session through one chain. A `/mcp`
 *  prompt waits until each earlier prompt has entered the turn queue or
 *  finished its `/mcp` answer. A model prompt waits the same way while a
 *  `/mcp` prompt is in the chain, and goes at once otherwise, as before. So the
 *  prompt order holds. A cancel also cancels the prompts that wait in the
 *  chain, as it cancels the queued turns. */
export class McpCommandRunner {
  private readonly chains = new Map<string, AdmissionChain>();
  /** The `/mcp` answer in progress for each session. */
  private readonly answering = new Map<string, Promise<void>>();

  constructor(private readonly host: McpCommandHost) {}

  /** Run `run` for the prompt `prompt` when its place in the admission chain
   *  comes. When the prompt need not wait, `run` runs at once, in the same
   *  synchronous section. A prompt that a cancel reaches while it waits
   *  answers `cancelled` and does not run. */
  admit(
    sessionId: string,
    prompt: readonly ContentBlock[],
    run: (admission: PromptAdmission) => Promise<PromptResponse | void>,
  ): Promise<PromptResponse | void> {
    const isMcp = mcpCommandOf(prompt) !== null;
    const chain = this.chains.get(sessionId);
    const waits = chain !== undefined && (isMcp || [...chain.open.values()].some(Boolean));
    const ahead = waits ? chain.tail : undefined;
    const current: AdmissionChain = chain ?? { tail: Promise.resolve(), open: new Map() };
    this.chains.set(sessionId, current);
    const abort = new AbortController();
    current.open.set(abort, isMcp);
    let markReleased!: () => void;
    const released = new Promise<void>((resolve) => (markReleased = resolve));
    const previous = current.tail;
    current.tail = chain ? previous.then(() => released) : released;

    const release = () => {
      if (!current.open.delete(abort)) return;
      markReleased();
      if (current.open.size === 0 && this.chains.get(sessionId) === current) {
        this.chains.delete(sessionId);
      }
    };
    const admission: PromptAdmission = { signal: abort.signal, release };
    // A cancel ends the wait at once. The released waiter does not let a later
    // prompt overtake an earlier one, because the tail chains on `previous`.
    const response = ahead
      ? untilAborted(ahead, abort.signal).then((result) =>
          result === ABORTED || abort.signal.aborted ? CANCELLED : run(admission),
        )
      : run(admission);
    return response.finally(release);
  }

  /** Abort every prompt of the session that waits in the admission chain,
   *  and the `/mcp` answer in progress. */
  cancel(sessionId: string): void {
    for (const abort of this.chains.get(sessionId)?.open.keys() ?? []) abort.abort();
  }

  /** The `/mcp` answers in progress in every session. A provider update waits
   *  for them before it closes the queries. */
  inProgress(): Promise<void>[] {
    return [...this.answering.values()];
  }

  /** Answer the prompt when it is a `/mcp` command. Returns `null` for any
   *  other prompt, which then goes to Claude Code. `signal` is the signal of
   *  the prompt admission. */
  run(
    sessionId: string,
    session: McpCommandSession,
    prompt: readonly ContentBlock[],
    signal: AbortSignal,
  ): Promise<PromptResponse> | null {
    const command = mcpCommandOf(prompt);
    if (!command) return null;
    const answer = this.answer(sessionId, session, command, signal);
    const done = answer.then(
      () => {},
      () => {},
    );
    this.answering.set(sessionId, done);
    void done.then(() => {
      if (this.answering.get(sessionId) === done) this.answering.delete(sessionId);
    });
    return answer;
  }

  /** The answer waits for the earlier turns, so it follows their output. */
  private async answer(
    sessionId: string,
    session: McpCommandSession,
    command: McpCommand,
    signal: AbortSignal,
  ): Promise<PromptResponse> {
    const earlierTurns = (session.turnQueue ?? [])
      .filter((turn) => !turn.settled)
      .map((turn) => turn.completion);
    if (
      earlierTurns.length > 0 &&
      (await untilAborted(Promise.all(earlierTurns), signal)) === ABORTED
    ) {
      return CANCELLED;
    }

    let markdown: string | null;
    try {
      if (command.action === "status") {
        const statuses = await untilAborted(session.query.mcpServerStatus(), signal);
        markdown = statuses === ABORTED ? null : formatMcpStatus(statuses);
      } else {
        markdown = await this.reconnect(sessionId, session.query, command.server, signal);
      }
    } catch (error) {
      if (signal.aborted) return CANCELLED;
      this.host.logError(`Session ${sessionId}: /mcp failed: ${error}`);
      markdown = formatMcpStatusUnavailable(errorText(error));
    }
    if (markdown === null || signal.aborted) return CANCELLED;
    await this.host.sessionUpdate({
      sessionId,
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: markdown } },
    });
    return { stopReason: "end_turn" };
  }

  /** Reconnect the named server, or every server that is not connected and
   *  not disabled. A server that needs authentication goes through the MCP
   *  OAuth flow when the client can show the authorization URL. One failed
   *  server does not stop the others. Returns the updated status Markdown, or
   *  `null` when `signal` aborts. */
  private async reconnect(
    sessionId: string,
    query: Query,
    server: string | undefined,
    signal: AbortSignal,
  ): Promise<string | null> {
    const statuses = await untilAborted(query.mcpServerStatus(), signal);
    if (statuses === ABORTED) return null;
    let note: McpReconnectNote | undefined;
    let targets: McpServerStatus[];
    if (server !== undefined) {
      const target = statuses.find((status) => status.name === server);
      if (!target) return formatUnknownMcpServer(server, statuses);
      if (target.status === "disabled") {
        note = { kind: "disabled", server };
        targets = [];
      } else {
        targets = [target];
      }
    } else {
      targets = statuses.filter(needsReconnect);
      if (targets.length === 0 && statuses.length > 0) note = { kind: "nothing-to-reconnect" };
    }

    const oauth = this.host.mcpOAuth(sessionId, query);
    const results: McpReconnectResult[] = [];
    for (const target of targets) {
      if (signal.aborted) return null;
      try {
        if (target.status === "needs-auth" && oauth) {
          const authenticated = await oauth(target.name, signal);
          if (signal.aborted) return null;
          results.push({
            server: target.name,
            outcome: authenticated ? "authenticated" : "not-authenticated",
          });
        } else {
          if ((await untilAborted(query.reconnectMcpServer(target.name), signal)) === ABORTED) {
            return null;
          }
          results.push({ server: target.name, outcome: "reconnected" });
        }
      } catch (error) {
        if (signal.aborted) return null;
        this.host.logError(`Session ${sessionId}: failed to reconnect MCP server ${target.name}`);
        results.push({ server: target.name, outcome: "failed", error: errorText(error) });
      }
    }
    const updated = await untilAborted(query.mcpServerStatus(), signal);
    if (updated === ABORTED) return null;
    return formatMcpStatus(updated, { results, note });
  }
}
