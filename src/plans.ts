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
 * ({@link PLAN_MODE_PLAN_ID}). */
export const CHECKLIST_PLAN_ID = "plan";

/** The plan operation that shows the checklist `entries`: `plan_update`, or
 * `plan_removed` for an empty checklist. */
export function checklistPlanOperation(
  entries: PlanEntry[],
): { sessionUpdate: "plan_update"; plan: PlanItems & { type: "items" } } | PlanRemovalUpdate {
  if (entries.length === 0) return { sessionUpdate: "plan_removed", planId: CHECKLIST_PLAN_ID };
  return {
    sessionUpdate: "plan_update",
    plan: { type: "items", planId: CHECKLIST_PLAN_ID, entries },
  };
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

/** The updates that dismiss the plans of a conversation that a reset (`/clear`)
 * replaced: the checklist, and the approved ExitPlanMode plan. AIR keeps its
 * approved plans, each joined to its approval card in the transcript (see
 * planModeUpdate). Without plan operations, a legacy empty `plan` clears the
 * one plan the client holds. */
export function resetPlanUpdates(
  planOperations: boolean,
  airClient: boolean,
): SessionNotification["update"][] {
  const updates = [checklistPlanUpdate([], planOperations)];
  if (planOperations && !airClient) {
    updates.push({ sessionUpdate: "plan_removed", planId: PLAN_MODE_PLAN_ID });
  }
  return updates;
}
