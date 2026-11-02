/**
 * The `background` lists of the v2 sessions of a connection (see
 * `background-work.ts`, which builds them).
 *
 * A session that reports its background work gets its list on every
 * `state_update` of its own stream, as v2 requires, from the list the agent
 * reports when the session starts. A subagent session of such a session
 * reports its own list from its announcement on, also in the parent's mirror
 * of its state (`subagent_update.state`).
 */
import type * as v2 from "@agentclientprotocol/sdk/experimental/v2/unstable";
import type { BackgroundItem, BackgroundReport, WorkStateName } from "../background-work.js";
import type { V2Terminals } from "./terminal.js";

/** `state` as the current work state of a session, with no stop reason. */
function currentState(state: WorkStateName): v2.StateUpdate {
  if (state === "idle") return { state: "idle" };
  if (state === "running") return { state: "running" };
  if (state === "requires_action") return { state: "requires_action" };
  return { state: "unknown" };
}

/** The `state_update` that reports `state` as the session's current work state. */
export function stateUpdate(state: WorkStateName): v2.SessionUpdate {
  return { sessionUpdate: "state_update", ...currentState(state) };
}

/** `state` with the list `background`. */
function withBackground(state: v2.StateUpdate, background: BackgroundItem[]): v2.StateUpdate {
  return { ...state, background } as v2.StateUpdate;
}

export class V2Background {
  /**
   * The latest list of each session that reports one, whether a state of the
   * session carried it, and the parent of a subagent session.
   */
  private readonly sessions = new Map<
    string,
    { items: BackgroundItem[]; reported: boolean; parent?: string }
  >();

  constructor(private readonly terminals: V2Terminals) {}

  /**
   * `notification` with the session's list, when it is a `state_update` of a
   * session that reports one, or a `subagent_update` that mirrors the state of
   * such a child. A child of a session that reports its list reports its own
   * from its announcement on: empty, until the agent reports it.
   */
  stamp(notification: v2.UpdateSessionNotification): v2.UpdateSessionNotification {
    const { sessionId, update } = notification;
    if (update.sessionUpdate === "state_update") {
      const session = this.sessions.get(sessionId);
      if (!session) return notification;
      session.reported = true;
      return { ...notification, update: { ...update, background: session.items } };
    }
    if (update.sessionUpdate === "subagent_update" && this.sessions.has(sessionId)) {
      const subagent = update as Extract<v2.SessionUpdate, { sessionUpdate: "subagent_update" }>;
      let child = this.sessions.get(subagent.sessionId);
      if (!child) {
        child = { items: [], reported: false, parent: sessionId };
        this.sessions.set(subagent.sessionId, child);
      }
      if (subagent.state) {
        return {
          ...notification,
          update: { ...subagent, state: withBackground(subagent.state, child.items) },
        };
      }
    }
    return notification;
  }

  /**
   * Records the new list of a session, and returns the updates that report it:
   *
   * - For each terminal that the list adds, a `terminal_update` that lets the
   *   client cancel it. It also comes before the first list that names the
   *   terminal, as v2 requires: the terminal's own updates came earlier.
   * - Once a state of the session carried a list, the state again with the
   *   new list, without a stop reason: a repeated `idle` is no new
   *   completion. A subagent's goes to its parent's mirror first, as its
   *   other states do.
   */
  changed(report: BackgroundReport): v2.UpdateSessionNotification[] {
    const { sessionId, items, state, parentSessionId } = report;
    const session = this.sessions.get(sessionId);
    const unchanged = session && JSON.stringify(session.items) === JSON.stringify(items);
    this.sessions.set(sessionId, {
      items,
      reported: session?.reported ?? false,
      parent: parentSessionId ?? session?.parent,
    });
    const known = new Set(
      (session?.items ?? []).flatMap((item) => (item.type === "terminal" ? [item.terminalId] : [])),
    );
    const updates: v2.UpdateSessionNotification[] = items.flatMap((item) => {
      if (item.type !== "terminal" || known.has(item.terminalId)) return [];
      const update = this.terminals.advertiseCancel(sessionId, item.terminalId);
      return update ? [{ sessionId, update }] : [];
    });
    if (session?.reported && state && !unchanged) {
      if (parentSessionId) {
        updates.push({
          sessionId: parentSessionId,
          update: { sessionUpdate: "subagent_update", sessionId, state: currentState(state) },
        });
      }
      updates.push({ sessionId, update: stateUpdate(state) });
    }
    return updates;
  }

  /**
   * The current `terminal_update` of each terminal that the session
   * `sessionId` lists. v2 requires it before the state snapshot of
   * `session/resume`, as a replay may not have delivered it.
   */
  currentTerminals(sessionId: string): v2.UpdateSessionNotification[] {
    return (this.sessions.get(sessionId)?.items ?? []).flatMap((item) => {
      if (item.type !== "terminal") return [];
      const update = this.terminals.advertiseCancel(sessionId, item.terminalId, true);
      return update ? [{ sessionId, update }] : [];
    });
  }

  /** The subagent sessions that the session `sessionId` lists. */
  listedSubagents(sessionId: string): string[] {
    return (this.sessions.get(sessionId)?.items ?? []).flatMap((item) =>
      item.type === "subagent" ? [item.sessionId] : [],
    );
  }

  /** Forgets the list of a session, and those of its subagent sessions. */
  forget(sessionId: string): void {
    this.sessions.delete(sessionId);
    for (const [child, { parent }] of this.sessions) {
      if (parent === sessionId) this.forget(child);
    }
  }
}
