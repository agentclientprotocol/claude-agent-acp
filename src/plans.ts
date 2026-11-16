/**
 * The session updates that show the session's plans. A client with the `plan`
 * capability (every v2 client, and a v1 client that asks for it) tracks plans
 * by ID and gets `plan_update` and `plan_removed`; any other client gets the
 * legacy `plan` update, which holds one ID-less plan per session.
 */
import type {
  PlanEntry,
  PlanItems,
  PlanRemoved,
  SessionNotification,
} from "@agentclientprotocol/sdk/unstable";
import { PLAN_MODE_PLAN_ID } from "./exit-plan.js";

type PlanRemovalUpdate = PlanRemoved & { sessionUpdate: "plan_removed" };

/** The ID of the session's checklist, from TodoWrite and the Task tools. Every
 * update replaces it whole. An approved ExitPlanMode plan is a separate plan
 * ({@link PLAN_MODE_PLAN_ID}), and so is a subagent's TodoWrite checklist in
 * its parent's session ({@link subagentChecklistPlanId}). */
export const CHECKLIST_PLAN_ID = "plan";

/** The ID of the TodoWrite checklist of the subagent that the tool call
 * `parentToolUseId` launched, when the checklist goes to its parent's session.
 * Claude Code keeps a TodoWrite list per agent, so it is a separate plan from
 * the main conversation's checklist. The Task tools share one task list
 * between all agents of a session, so their checklist is always
 * {@link CHECKLIST_PLAN_ID}. */
export function subagentChecklistPlanId(parentToolUseId: string): string {
  return `${CHECKLIST_PLAN_ID}:${parentToolUseId}`;
}

/** The plan operation that shows the checklist `entries` as the plan `planId`:
 * `plan_update`, or `plan_removed` for an empty checklist. */
export function checklistPlanOperation(
  entries: PlanEntry[],
  planId: string = CHECKLIST_PLAN_ID,
): { sessionUpdate: "plan_update"; plan: PlanItems & { type: "items" } } | PlanRemovalUpdate {
  if (entries.length === 0) return { sessionUpdate: "plan_removed", planId };
  return { sessionUpdate: "plan_update", plan: { type: "items", planId, entries } };
}

/** The update that shows the checklist `entries`: a plan operation (see
 * {@link checklistPlanOperation}), else a legacy `plan`, which with no entries
 * clears the client's plan. */
export function checklistPlanUpdate(
  entries: PlanEntry[],
  planOperations: boolean,
): SessionNotification["update"] {
  return planOperations ? checklistPlanOperation(entries) : { sessionUpdate: "plan", entries };
}

/** The plan IDs of the subagent checklists that the client holds in a session
 * (see {@link subagentChecklistPlanId}). */
export type SubagentChecklists = Set<string>;

/**
 * The update that shows the TodoWrite checklist `entries` of the agent that
 * made the call: the main conversation, or the subagent that the tool call
 * `parentToolUseId` launched.
 *
 * A subagent's checklist gets its own plan ID, recorded in `shown` while the
 * client holds it, when it goes to the parent's session. It does not with
 * `childSessions` (native subagent sessions), where it goes to the subagent's
 * own session, which holds no other checklist. A client without plan
 * operations holds one plan per session, so there a subagent's checklist
 * replaces the main one.
 */
export function todoWritePlanUpdate(
  entries: PlanEntry[],
  options: {
    planOperations: boolean;
    parentToolUseId?: string | null;
    childSessions: boolean;
    shown?: SubagentChecklists;
  },
): SessionNotification["update"] {
  const { planOperations, parentToolUseId, childSessions, shown } = options;
  if (!planOperations || !parentToolUseId || childSessions) {
    return checklistPlanUpdate(entries, planOperations);
  }
  const planId = subagentChecklistPlanId(parentToolUseId);
  if (entries.length === 0) shown?.delete(planId);
  else shown?.add(planId);
  return checklistPlanOperation(entries, planId);
}

/** The updates that dismiss the plans of a conversation that a reset (`/clear`)
 * replaced: the checklist, the subagent checklists in `subagentChecklists`
 * (which it then empties), and the approved ExitPlanMode plan. AIR keeps its
 * approved plans, each joined to its approval card in the transcript (see
 * planModeUpdate). Without plan operations, a legacy empty `plan` clears the
 * one plan the client holds. */
export function resetPlanUpdates(
  planOperations: boolean,
  airClient: boolean,
  subagentChecklists?: SubagentChecklists,
): SessionNotification["update"][] {
  const updates = [checklistPlanUpdate([], planOperations)];
  if (planOperations) {
    for (const planId of subagentChecklists ?? []) {
      updates.push({ sessionUpdate: "plan_removed", planId });
    }
  }
  subagentChecklists?.clear();
  if (planOperations && !airClient) {
    updates.push({ sessionUpdate: "plan_removed", planId: PLAN_MODE_PLAN_ID });
  }
  return updates;
}
