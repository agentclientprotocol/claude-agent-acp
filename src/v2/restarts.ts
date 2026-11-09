/**
 * Restarts of a v2 session's query: a new
 * query resumes the same Claude session under the same id, and takes over
 * from the old one between turns.
 *
 * Claude Code reads the LLM route (the env of a provider or a gateway login)
 * and its account once, when its process starts. So a query must start again
 * when either changes:
 *
 * - The route: `providers/set`, `providers/disable`, and an `auth/logout`
 *   that drops a provider or a gateway login. Each live session restarts at
 *   its next turn boundary: no turn is open, no prompt of the session waits
 *   to go to Claude Code or in its queue, and no subagent runs, background
 *   ones included. A session at a turn boundary restarts right away, and the
 *   request that changed the route answers once it did. A busy session's
 *   restart is due at its next turn boundary, which the request does not
 *   wait for: until then the session keeps its query, and its prompts go to
 *   that query under the old route (the provider RFD lets an Agent leave
 *   running sessions on it). That restart starts under the route in force
 *   when it runs.
 *   A session that cannot start again stops: its requests then fail with
 *   what happened, until a resume starts it again.
 * - The additional directories: a resume of the active session with other
 *   ones restarts it as for a new route, and does not wait for it. Claude
 *   Code reads them once, when its process starts, and the SDK has no call
 *   that changes them on a running query.
 * - The account, under `--hide-claude-auth` (see `subscription-guard.ts`):
 *   the next prompt that finds the session at a turn boundary restarts it
 *   first, so the guard judges the new account. If the restart fails, such
 *   as when the guard refuses the account, the prompt fails with its error
 *   and the session stays as it was, for a retry after a sign-in.
 *
 * The new query starts before the old one ends, so a failed start leaves the
 * session as it was. The old one ends at its next turn boundary after that,
 * so work that started on it during the start, such as a turn that Claude
 * Code started on its own, is not cut. Its background commands end with it
 * (their terminals exit), as when a query ends. The new query starts without
 * the effort of the setup's `_meta`, and the client's choices are set again
 * on it (`SessionConfig.restoreFrom`), which then reports its options in a
 * `config_option_update`. Ending the old query withdraws its MCP OAuth
 * runs, and the new one starts OAuth for the setup's MCP servers that still
 * need it, as a setup does. One restart of a session runs at
 * a time: a route restart waits for an account restart that runs, as for a
 * busy session.
 *
 * Prompts wait only for a restart that runs, from the new query's start to
 * the old one's end, and go to the new query. A `session/cancel` or
 * `session/close` answers them with -32800, and stops the work that runs on
 * the old query while the restart waits for it.
 */
import { RequestError } from "@agentclientprotocol/sdk/unstable";
import type * as v2 from "@agentclientprotocol/sdk/experimental/v2/unstable";
import type { Logger } from "../acp-agent.js";
import { withoutEffort } from "../session-effort.js";
import type { V2Session } from "./session.js";
import { afterSetupResponse } from "./setup.js";

/** The request that set the session up, whose options a restart starts with again. */
export type SetupParams = v2.NewSessionRequest | v2.ResumeSessionRequest | v2.ForkSessionRequest;

/** What the restarts need of the agent. */
export interface RestartHost {
  readonly logger: Logger;
  /** The active session `sessionId`. */
  active(sessionId: string): V2Session | undefined;
  /**
   * Starts a new query that resumes `sessionId`, with the options of `params`
   * and the current route. The new session is active once it resolves.
   */
  start(sessionId: string, params: SetupParams): Promise<V2Session>;
  /** `previous` could not start again: the session stops. */
  lost(sessionId: string, previous: V2Session): Promise<void>;
  send(notification: v2.UpdateSessionNotification): void;
}

/** A route restart of a busy session: waiting for its turn boundary, then running. */
type Reroute = { done: Promise<void>; started: boolean };

export class SessionRestarts {
  /** The setup request of each live session. */
  private readonly setups = new Map<string, SetupParams>();
  /** The sessions whose account may have changed: their next prompt at a turn boundary restarts them. */
  private readonly accountChanged = new Set<string>();
  /** The route restarts that wait for the session's turn boundary. Prompts do not wait for them. */
  private readonly reroutes = new Map<string, Reroute>();
  /** The restarts that run: from the new query's start to the old one's end. */
  private readonly swaps = new Map<string, Promise<void>>();
  /** The session that each running restart replaces. */
  private readonly retiring = new Map<string, V2Session>();
  /** The sessions that `session/close` closes: a restart that runs does not track them again. */
  private readonly closingSessions = new Set<string>();
  /** The prompts that wait for a restart, each with what rejects it. */
  private readonly held = new Map<string, Set<(error: unknown) => void>>();

  constructor(private readonly host: RestartHost) {}

  /** The session started from `params`, or a resume of the active session brought new ones. */
  track(sessionId: string, params: SetupParams): void {
    if (this.closingSessions.has(sessionId)) return;
    this.setups.set(sessionId, params);
  }

  /**
   * A resume of the active session brought other additional directories:
   * the session restarts with `params`, as for a new route (see the module
   * doc). Does not wait for it.
   */
  rootsChanged(sessionId: string, params: SetupParams): void {
    this.track(sessionId, params);
    void this.rerouteSession(sessionId);
  }

  /**
   * The session is no longer active, such as when its query ended. A route
   * restart that is due does not run.
   */
  forget(sessionId: string): void {
    this.setups.delete(sessionId);
    this.accountChanged.delete(sessionId);
  }

  /**
   * The route changed: restarts every live session at its next turn
   * boundary. Resolves once each session that is at one now restarted, or
   * was closed or lost. Their restarts start in this call, so a prompt that
   * comes after it waits for them (`beforePrompt`). The busy sessions'
   * restarts are only due: a failure of one stops its session later
   * (`RestartHost.lost`).
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
   * restart that runs, or an account restart that is due. `undefined` when
   * none is: the prompt goes on in the same call, so prompts keep their
   * order. A route restart that waits for a turn boundary does not hold it:
   * the prompt goes to the current query.
   */
  beforePrompt(sessionId: string): Promise<void> | undefined {
    const running = this.swaps.get(sessionId);
    if (running) return this.hold(sessionId, running);
    const session = this.host.active(sessionId);
    if (this.accountChanged.has(sessionId) && session?.atTurnBoundary(true)) {
      return this.hold(sessionId, this.swap(sessionId, session, { keepOnFailure: true }));
    }
    return undefined;
  }

  /**
   * Whether a restart runs: its new query starts MCP OAuth once it took
   * over, so the setup response of the session it replaces need not.
   */
  restarting(sessionId: string): boolean {
    return this.swaps.has(sessionId);
  }

  /** What a request other than a prompt waits for: a restart that runs. */
  settled(sessionId: string): Promise<void> | undefined {
    return this.swaps.get(sessionId)?.catch(() => {});
  }

  /**
   * `session/cancel`: the prompts that wait for a restart fail with -32800,
   * and work that runs on the query that a restart replaces stops too (the
   * restart waits for it).
   */
  cancelled(sessionId: string): void {
    this.release(sessionId, RequestError.requestCancelled());
    const retiring = this.retiring.get(sessionId);
    // Until the new query started, the old one is the active session, which the cancel stops.
    if (retiring && retiring !== this.host.active(sessionId)) void retiring.cancel();
  }

  /**
   * `session/close`: the prompts that wait fail with -32800, and a route
   * restart that waits for a turn boundary is dropped (the closed session
   * reaches none). Resolves once a restart that runs is done, so the close
   * ends the session that it started.
   */
  async closing(sessionId: string): Promise<void> {
    this.closingSessions.add(sessionId);
    this.forget(sessionId);
    this.release(sessionId, RequestError.requestCancelled());
    // The close stops the old query's work too, which the restart waits for.
    await this.retiring.get(sessionId)?.close();
    await this.swaps.get(sessionId)?.catch(() => {});
  }

  /** `session/close` closed the session. */
  closed(sessionId: string): void {
    this.closingSessions.delete(sessionId);
    this.forget(sessionId);
  }

  /** Waits for the restarts that run, so no new query starts after the agent's sessions closed. */
  async dispose(): Promise<void> {
    for (const sessionId of [...this.setups.keys(), ...this.retiring.keys()]) {
      this.closingSessions.add(sessionId);
      this.forget(sessionId);
      this.release(sessionId, RequestError.requestCancelled());
    }
    await Promise.all([...this.retiring.values()].map((session) => session.close()));
    await Promise.all([...this.swaps.values()].map((swap) => swap.catch(() => {})));
  }

  /**
   * Restarts the session for a new route. At a turn boundary, with no restart
   * that runs, the restart starts in this call, and the result resolves once
   * it is done. Otherwise it is due at the next turn boundary, and the result
   * resolves at once.
   */
  private async rerouteSession(sessionId: string): Promise<void> {
    const failed = (error: unknown) => {
      this.host.logger.error(`Session ${sessionId}: could not restart for the new route`, error);
    };
    const session = this.host.active(sessionId);
    if (session && !this.swaps.has(sessionId) && session.atTurnBoundary(true)) {
      // A restart due at the boundary that came has not resumed yet: this
      // one runs in its place.
      this.reroutes.delete(sessionId);
      await this.swap(sessionId, session, { keepOnFailure: false }).catch(failed);
      return;
    }
    const waiting = this.reroutes.get(sessionId);
    // One that waits starts under the route in force when it runs. One that
    // started may have read the route before this change: it runs again.
    if (waiting && !waiting.started) return;
    const reroute: Reroute = { done: Promise.resolve(), started: false };
    const current = () => this.reroutes.get(sessionId) === reroute;
    reroute.done = (async () => {
      await waiting?.done;
      let session: V2Session | undefined;
      for (;;) {
        // After an account restart that runs, on the session it started.
        await this.swaps.get(sessionId)?.catch(() => {});
        session = this.host.active(sessionId);
        if (!current() || !session) return;
        // `false` once the session closed.
        if (!(await session.turnBoundary(true)) || !current()) return;
        // A restart can start at the boundary too, and a prompt that it held
        // can end the boundary again before this resumes: wait again then.
        if (
          !this.swaps.has(sessionId) &&
          this.host.active(sessionId) === session &&
          session.atTurnBoundary(true)
        ) {
          break;
        }
      }
      if (!this.setups.has(sessionId)) return;
      reroute.started = true;
      await this.swap(sessionId, session, { keepOnFailure: false });
    })()
      .catch(failed)
      .finally(() => {
        if (current()) this.reroutes.delete(sessionId);
      });
    this.reroutes.set(sessionId, reroute);
  }

  /**
   * Starts the new query, then ends the old one and sets the client's choices
   * on the new one. With `keepOnFailure`, a failed start rejects and leaves
   * `previous` active. Otherwise the session is lost.
   */
  private swap(
    sessionId: string,
    previous: V2Session,
    { keepOnFailure }: { keepOnFailure: boolean },
  ): Promise<void> {
    const run = (async () => {
      const params = this.setups.get(sessionId);
      if (!params) return;
      this.host.logger.log(`Restarting the query of session ${sessionId}`);
      let session: V2Session;
      try {
        // The client's effort pin is restored below instead.
        session = await this.host.start(sessionId, withoutEffort(params));
      } catch (error) {
        if (keepOnFailure) throw error;
        this.host.logger.error(`Session ${sessionId}: could not start again`, error);
        await this.host.lost(sessionId, previous);
        return;
      }
      // The new query read the account in force.
      this.accountChanged.delete(sessionId);
      session.reports.restartedFrom(previous.reports);
      // Work that started on the old query while the new one started, such
      // as a turn that Claude Code started on its own, ends first. New
      // prompts wait for this restart meanwhile (`beforePrompt`).
      await previous.turnBoundary(true);
      await previous.retire();
      // A close during the restart closes the new session next.
      if (this.closingSessions.has(sessionId)) return;
      await session.config.restoreFrom(previous.config);
      this.host.send({
        sessionId,
        update: { sessionUpdate: "config_option_update", configOptions: session.config.options() },
      });
      // Closing the old query withdrew its MCP OAuth runs. The servers of a
      // resume that came during the restart are tracked by now.
      afterSetupResponse(session, this.setups.get(sessionId) ?? params);
    })().finally(() => {
      if (this.swaps.get(sessionId) === run) this.swaps.delete(sessionId);
      if (this.retiring.get(sessionId) === previous) this.retiring.delete(sessionId);
    });
    this.retiring.set(sessionId, previous);
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
        if (holds.size === 0 && this.held.get(sessionId) === holds) this.held.delete(sessionId);
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
