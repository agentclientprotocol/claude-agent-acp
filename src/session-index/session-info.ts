/**
 * A session index row as the client sees it: the `SessionInfo` of
 * `session/list` and of `_session/list/changes`, with the flat row fields of
 * the RFDs in `_meta.jetbrains.air`.
 */

import type { SessionInfo } from "@agentclientprotocol/sdk";
import { withAirMeta } from "../air-extension.js";
import { deriveActivity, selectCost, type OwnSessionState } from "./activity.js";
import type { LiveRecord } from "./live-registry.js";
import type { IndexRow } from "./session-index.js";

function iso(ms: number | undefined): string | undefined {
  return ms === undefined || !Number.isFinite(ms) ? undefined : new Date(ms).toISOString();
}

/** The `SessionInfo` of `row`. `own` is what this connection knows of a
 *  session it runs, `live` the registry record of the session. */
export function sessionInfoOf(
  row: IndexRow,
  own: OwnSessionState | undefined,
  live: LiveRecord | undefined,
  now: number,
): SessionInfo {
  const activity = deriveActivity({
    own,
    live,
    facts: row.facts,
    transcriptMtimeMs: row.mtimeMs,
    now,
  });
  const cost = selectCost(own, row.facts);
  const { facts } = row;
  // The row fields of the session list extensions RFD and RFD #2161, flat;
  // each is omitted when unknown, except `archived`.
  const fields: Record<string, unknown> = {
    archived: row.archived,
    lastPromptAt: iso(facts.lastPromptAt),
    model: facts.model,
    forkedFrom: facts.forkedFrom,
    state: activity?.state,
    lastTurnEndedAt: activity?.lastTurnEndedAt,
    cost: cost === undefined ? undefined : { amount: cost, currency: "USD" },
  };
  let meta: Record<string, unknown> | undefined;
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) meta = withAirMeta(meta, key, value);
  }
  return {
    sessionId: row.sessionId,
    cwd: row.cwd,
    title: row.title,
    updatedAt: new Date(row.updatedAtMs).toISOString(),
    _meta: meta,
  };
}

/** What a change of the row is compared by: everything but `updatedAt`,
 *  which alone is no change. */
export function changeSignature(info: SessionInfo): string {
  return JSON.stringify([info.sessionId, info.cwd, info.title, info._meta ?? null]);
}
