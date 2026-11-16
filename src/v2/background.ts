/**
 * The `background` lists of a v2 session and of its subagent sessions (see
 * `tasks.ts`, which builds them).
 *
 * A session that reports its background work gets its list on every
 * `state_update` of its own stream, as v2 requires, from the list the core
 * reports when the session starts. A subagent session of such a session
 * reports its own list from its announcement on, also in the parent's mirror
 * of its state (`subagent_update.state`).
 */
import type * as v2 from "@agentclientprotocol/sdk/experimental/v2/unstable";
import type { V2Terminals } from "./terminal.js";

/** An item of a `background` list. */
export type BackgroundItem =
  | { type: "terminal"; terminalId: string }
  | { type: "tool_call"; toolCallId: string }
  | { type: "subagent"; sessionId: string };

/** The work state of a session, as its `state_update` names it. */
export type WorkStateName = "idle" | "running" | "requires_action" | "unknown";

/** A new list of the session `sessionId`, with what its repeated state needs. */
export interface BackgroundReport {
  sessionId: string;
  items: BackgroundItem[];
  /** The session's work state now, or undefined when it has none yet. */
  state: WorkStateName | undefined;
  /** The parent of a subagent session, which mirrors the child's state. */
  parentSessionId?: string;
}

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

/** The final tool call statuses. */
const FINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);

export class V2Background {
  /** The latest list of each session that reports one, and whether a state of the session carried it. */
  private readonly sessions = new Map<string, { items: BackgroundItem[]; reported: boolean }>();

  /**
   * The tool calls that advertise `cancel`, by session and tool call. Like a
   * terminal's (see `V2Terminals.advertiseCancel`), the capability goes with
   * the final status.
   */
  private readonly cancellableToolCalls = new Set<string>();

  constructor(private readonly terminals: V2Terminals) {}

  /**
   * `notification` with the session's list, when it is a `state_update` of a
   * session that reports one, or a `subagent_update` that mirrors the state of
   * such a child. A child of a session that reports its list reports its own
   * from its announcement on: empty, until the agent reports it.
   */
  stamp(notification: v2.UpdateSessionNotification): v2.UpdateSessionNotification {
    const { sessionId, update } = notification;
    if (
      update.sessionUpdate === "tool_call_update" &&
      FINAL_STATUSES.has(String(update.status)) &&
      this.cancellableToolCalls.delete(`${sessionId} ${update.toolCallId}`)
    ) {
      // A tool call that reached its final status can no longer be cancelled.
      return { ...notification, update: { ...update, capabilities: null } };
    }
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
        child = { items: [], reported: false };
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
   * `state` as the current work state of the session `sessionId`, with its
   * list when it reports one: what {@link stamp} makes of the session's
   * `state_update`. Unlike `stamp`, it does not count as a state that carried
   * the list, so a later change of the list is reported as before.
   */
  snapshot(sessionId: string, state: WorkStateName): v2.StateUpdate {
    const session = this.sessions.get(sessionId);
    return session ? withBackground(currentState(state), session.items) : currentState(state);
  }

  /**
   * Records the new list of a session, and returns the updates that report it:
   *
   * - For each terminal or tool call that the list adds, a `terminal_update`
   *   or `tool_call_update` that lets the client cancel it. It comes before
   *   the first list that names it, as v2 requires of an announcement: its
   *   own updates came earlier.
   * - Once a state of the session carried a list, the state again with the
   *   new list, without a stop reason: a repeated `idle` is no new
   *   completion. A subagent's goes to its parent's mirror first, as its
   *   other states do.
   */
  changed(report: BackgroundReport): v2.UpdateSessionNotification[] {
    const { sessionId, items, state, parentSessionId } = report;
    const session = this.sessions.get(sessionId);
    const unchanged = session && JSON.stringify(session.items) === JSON.stringify(items);
    this.sessions.set(sessionId, { items, reported: session?.reported ?? false });
    const known = new Set((session?.items ?? []).map((item) => JSON.stringify(item)));
    const updates: v2.UpdateSessionNotification[] = items.flatMap((item) =>
      known.has(JSON.stringify(item)) ? [] : this.advertiseCancel(sessionId, item, false),
    );
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
   * `sessionId` lists, and the `cancel` capability of each tool call that it
   * lists, whose other fields the core sends. v2 requires them before the
   * state snapshot of `session/resume`, as a replay may not have delivered
   * them.
   */
  currentItems(sessionId: string): v2.UpdateSessionNotification[] {
    return (this.sessions.get(sessionId)?.items ?? []).flatMap((item) =>
      this.advertiseCancel(sessionId, item, true),
    );
  }

  /**
   * The update that lets the client cancel the listed terminal or tool call
   * `item`, unless it advertises that already. `again` sends it anyway, as
   * the item's current state.
   */
  private advertiseCancel(
    sessionId: string,
    item: BackgroundItem,
    again: boolean,
  ): v2.UpdateSessionNotification[] {
    if (item.type === "terminal") {
      const update = this.terminals.advertiseCancel(sessionId, item.terminalId, again);
      return update ? [{ sessionId, update }] : [];
    }
    if (item.type !== "tool_call") return [];
    const key = `${sessionId} ${item.toolCallId}`;
    if (this.cancellableToolCalls.has(key) && !again) return [];
    this.cancellableToolCalls.add(key);
    return [
      {
        sessionId,
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: item.toolCallId,
          capabilities: { cancel: {} },
        },
      },
    ];
  }
}
