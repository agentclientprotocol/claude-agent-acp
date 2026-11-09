/**
 * Restarts of a native session's query, as the bridge restarts them: a new
 * query resumes the same Claude session under the same id, and takes over
 * from the old one between turns.
 *
 * Claude Code reads the LLM route (the env of a provider or a gateway login)
 * and its account once, when its process starts. So a query must start again
 * when either changes:
 *
 * - The route: `providers/set`, `providers/disable`, and an `auth/logout`
 *   that drops a provider or a gateway login. Each live session restarts at
 *   its next turn boundary: no turn is open, no prompt waits in Claude Code's
 *   queue, and no subagent runs. A running turn is never cut. Prompts that
 *   come meanwhile wait, and go to the new query. The request that changed
 *   the route answers once every live session restarted, as on the bridge.
 *   A session that cannot start again is no longer active.
 * - The account, under `--hide-claude-auth` (see `subscription-guard.ts`):
 *   the next prompt that finds the session at a turn boundary restarts it
 *   first, so the guard judges the new account. If the restart fails, such
 *   as when the guard refuses the account, the prompt fails with its error
 *   and the session stays as it was, for a retry after a sign-in.
 *
 * The new query starts before the old one ends, so a failed start leaves the
 * session as it was. The old one is idle then, and ends right after: its
 * background commands end with it (their terminals exit), as when a query
 * ends. The model and mode the client chose are set again on the new query,
 * which then reports its options in a `config_option_update`, as on the
 * bridge.
 *
 * A `session/cancel` or `session/close` answers the prompts that wait for a
 * restart with -32800.
 */
import { RequestError } from "@agentclientprotocol/sdk/unstable";
import type * as v2 from "@agentclientprotocol/sdk/experimental/v2/unstable";
import type { Logger } from "../acp-agent.js";
import { MODEL_CONFIG_ID } from "../session-model.js";
import { MODE_CONFIG_ID } from "../session-mode.js";
import type { NativeSession } from "./session.js";

/** The request that set the session up, whose options a restart starts with again. */
export type SetupParams = v2.NewSessionRequest | v2.ResumeSessionRequest | v2.ForkSessionRequest;

/** What the restarts need of the agent. */
export interface RestartHost {
  readonly logger: Logger;
  /** The active session `sessionId`. */
  active(sessionId: string): NativeSession | undefined;
  /**
   * Starts a new query that resumes `sessionId`, with the options of `params`
   * and the current route. The new session is active once it resolves.
   */
  start(sessionId: string, params: SetupParams): Promise<NativeSession>;
  /** `previous` could not start again: the session is no longer active. */
  lost(sessionId: string, previous: NativeSession): Promise<void>;
  send(notification: v2.UpdateSessionNotification): void;
}

/** A route restart of one session: waiting for its turn boundary, then running. */
type Reroute = { done: Promise<void>; started: boolean };

export class SessionRestarts {
  /** The setup request of each live session. */
  private readonly setups = new Map<string, SetupParams>();
  /** The sessions whose account may have changed: their next prompt at a turn boundary restarts them. */
  private readonly accountChanged = new Set<string>();
  private readonly reroutes = new Map<string, Reroute>();
  /** The restarts that run: from the new query's start to the old one's end. */
  private readonly swaps = new Map<string, Promise<void>>();
  /** The prompts that wait for a restart, each with what rejects it. */
  private readonly held = new Map<string, Set<(error: unknown) => void>>();

  constructor(private readonly host: RestartHost) {}

  /** The session started from `params`, or a resume of the active session brought new ones. */
  track(sessionId: string, params: SetupParams): void {
    this.setups.set(sessionId, params);
  }

  /**
   * The session is no longer active, such as when its query ended. A route
   * restart that waits is dropped, and the prompts that wait for it then
   * find no active session (-32002).
   */
  forget(sessionId: string): void {
    this.setups.delete(sessionId);
    this.accountChanged.delete(sessionId);
  }

  /**
   * The route changed: restarts every live session at its next turn
   * boundary. Resolves once each one restarted, or was closed or lost.
   */
  async reroute(): Promise<void> {
    await Promise.all([...this.setups.keys()].map((sessionId) => this.rerouteSession(sessionId)));
  }

  /** The session's account may have changed: its next prompt at a turn boundary restarts it. */
  accountMayHaveChanged(sessionId: string): void {
    if (this.setups.has(sessionId)) this.accountChanged.add(sessionId);
  }

  /**
   * What a prompt of `sessionId` waits for before it goes to the session: a
   * restart that is due. `undefined` when none is: the prompt goes on in the
   * same call, so prompts keep their order.
   */
  beforePrompt(sessionId: string): Promise<void> | undefined {
    const running = this.reroutes.get(sessionId)?.done ?? this.swaps.get(sessionId);
    if (running) return this.hold(sessionId, running);
    const session = this.host.active(sessionId);
    if (this.accountChanged.has(sessionId) && session?.atTurnBoundary(true)) {
      return this.hold(sessionId, this.swap(sessionId, session, { keepOnFailure: true }));
    }
    return undefined;
  }

  /** What a request other than a prompt waits for: a restart that runs. */
  settled(sessionId: string): Promise<void> | undefined {
    return this.swaps.get(sessionId)?.catch(() => {});
  }

  /** `session/cancel`: the prompts that wait for a restart fail with -32800. */
  cancelled(sessionId: string): void {
    this.release(sessionId, RequestError.requestCancelled());
  }

  /**
   * `session/close`: the prompts that wait fail with -32800, and a route
   * restart that waits for a turn boundary is dropped (the closed session
   * reaches none). Resolves once a restart that runs is done, so the close
   * ends the session that it started.
   */
  async closing(sessionId: string): Promise<void> {
    this.forget(sessionId);
    this.release(sessionId, RequestError.requestCancelled());
    await this.swaps.get(sessionId)?.catch(() => {});
  }

  /** Waits for the restarts that run, so no new query starts after the agent's sessions closed. */
  async dispose(): Promise<void> {
    for (const sessionId of [...this.setups.keys()]) {
      this.forget(sessionId);
      this.release(sessionId, RequestError.requestCancelled());
    }
    await Promise.all([...this.swaps.values()].map((swap) => swap.catch(() => {})));
  }

  private rerouteSession(sessionId: string): Promise<void> {
    const waiting = this.reroutes.get(sessionId);
    // One that waits starts under the route in force when it runs. One that
    // started may have read the route before this change: it runs again.
    if (waiting && !waiting.started) return waiting.done;
    const reroute: Reroute = { done: Promise.resolve(), started: false };
    reroute.done = (async () => {
      await waiting?.done;
      const session = this.host.active(sessionId);
      // `false` once the session closed.
      if (!session || !(await session.turnBoundary(true))) return;
      if (this.host.active(sessionId) !== session || !this.setups.has(sessionId)) return;
      reroute.started = true;
      await this.swap(sessionId, session, { keepOnFailure: false });
    })()
      .catch((error: unknown) => {
        this.host.logger.error(`Session ${sessionId}: could not restart for the new route`, error);
      })
      .finally(() => {
        if (this.reroutes.get(sessionId) === reroute) this.reroutes.delete(sessionId);
      });
    this.reroutes.set(sessionId, reroute);
    return reroute.done;
  }

  /**
   * Starts the new query, then ends the old one and sets the client's choices
   * on the new one. With `keepOnFailure`, a failed start rejects and leaves
   * `previous` active. Otherwise the session is lost.
   */
  private swap(
    sessionId: string,
    previous: NativeSession,
    { keepOnFailure }: { keepOnFailure: boolean },
  ): Promise<void> {
    const run = (async () => {
      const params = this.setups.get(sessionId);
      if (!params) return;
      this.host.logger.log(`Restarting the query of session ${sessionId}`);
      let session: NativeSession;
      try {
        session = await this.host.start(sessionId, params);
      } catch (error) {
        if (keepOnFailure) throw error;
        this.host.logger.error(`Session ${sessionId}: could not start again`, error);
        await this.host.lost(sessionId, previous);
        return;
      }
      // The new query read the account in force.
      this.accountChanged.delete(sessionId);
      session.reports.restartedFrom(previous.reports);
      await previous.retire();
      await restoreChoices(session, previous, this.host.logger);
      this.host.send({
        sessionId,
        update: { sessionUpdate: "config_option_update", configOptions: session.config.options() },
      });
    })().finally(() => {
      if (this.swaps.get(sessionId) === run) this.swaps.delete(sessionId);
    });
    this.swaps.set(sessionId, run);
    return run;
  }

  /** Waits for `work`, unless a cancel or close of the session comes first. */
  private hold(sessionId: string, work: Promise<void>): Promise<void> {
    return new Promise((resolve, reject) => {
      let holds = this.held.get(sessionId);
      if (!holds) this.held.set(sessionId, (holds = new Set()));
      const settle = (error?: unknown) => {
        if (!holds.delete(settle)) return;
        if (error === undefined) resolve();
        else reject(error);
      };
      holds.add(settle);
      work.then(
        () => settle(),
        (error: unknown) => settle(error ?? new Error("The restart failed")),
      );
    });
  }

  private release(sessionId: string, error: unknown): void {
    const holds = this.held.get(sessionId);
    this.held.delete(sessionId);
    for (const settle of [...(holds ?? [])]) settle(error);
  }
}

/**
 * Sets the model, then the mode, of `previous` on `session`: the model
 * decides which modes it serves. A value the new query refuses is logged.
 */
async function restoreChoices(
  session: NativeSession,
  previous: NativeSession,
  logger: Logger,
): Promise<void> {
  for (const configId of [MODEL_CONFIG_ID, MODE_CONFIG_ID]) {
    const value = currentValue(previous, configId);
    if (value === undefined || value === currentValue(session, configId)) continue;
    try {
      await session.config.set({ sessionId: session.sessionId, configId, type: "id", value });
    } catch (error) {
      logger.error(`Could not restore ${configId} "${value}" after the query restart:`, error);
    }
  }
}

function currentValue(session: NativeSession, configId: string): string | undefined {
  const option = session.config.options().find((entry) => entry.configId === configId);
  return option && typeof option.currentValue === "string" ? option.currentValue : undefined;
}
