/**
 * The `activity` and `usage` of a session list row.
 *
 * A session that this connection runs reports the SDK's own state, and
 * `error` when it is idle and its last turn failed with an error (not a
 * cancel). Another session reports what the CLI registry and the transcript
 * tell:
 *
 * - no live process holds it: `idle`, or `error` when its last turn ended
 *   with an API error;
 * - an interactive CLI that is not driven by an SDK holds it, and its registry
 *   status is newer than the transcript: the registry status (an idle one is
 *   `error` after such a turn);
 * - otherwise the transcript tail: a finished turn is `idle` (`error` after
 *   an API error), an unfinished turn written in the last 10 minutes is
 *   `running`, and anything else has no known state.
 *
 * A user interrupt is no error. A new turn clears it.
 *
 * The SDK-driven CLIs (`entrypoint: sdk-*`, which includes the ones this
 * adapter starts) keep `busy` in the registry long after a turn ends, so their
 * registry status is not used.
 */

import type { LiveRecord } from "./live-registry.js";
import type { TranscriptFacts } from "./transcript-scan.js";

export type ActivityState = "running" | "idle" | "requires_action" | "error";

export type SessionActivity = {
  state?: ActivityState;
  lastTurnEndedAt?: string;
};

/** What this connection knows about a session it runs. */
export type OwnSessionState = {
  state?: ActivityState;
  /** Epoch ms of the end of the last turn. */
  lastTurnEndedAt?: number;
  /** `total_cost_usd` of the last result. */
  costUsd?: number;
  /** The last turn failed with an error (not a cancel). */
  lastTurnFailed?: boolean;
  /** The query of the session failed here at this time (epoch ms) and no
   *  longer runs: the session is reported as any other one, `error` until
   *  its transcript shows a prompt or a turn end after it. */
  queryFailedAt?: number;
};

const RECENT_UNFINISHED_TURN_MS = 10 * 60 * 1000;

function registryState(status: string | undefined): ActivityState | undefined {
  switch (status) {
    case "busy":
    case "shell":
      return "running";
    case "waiting":
      return "requires_action";
    case "idle":
      return "idle";
    default:
      return undefined;
  }
}

function usesRegistryStatus(record: LiveRecord, transcriptMtimeMs: number): boolean {
  return (
    record.kind === "interactive" &&
    !(record.entrypoint ?? "").startsWith("sdk-") &&
    record.statusUpdatedAt !== undefined &&
    record.statusUpdatedAt > transcriptMtimeMs
  );
}

function iso(ms: number | undefined): string | undefined {
  return ms === undefined || !Number.isFinite(ms) ? undefined : new Date(ms).toISOString();
}

export function deriveActivity(input: {
  own?: OwnSessionState;
  live?: LiveRecord;
  facts: TranscriptFacts;
  transcriptMtimeMs: number;
  now: number;
}): SessionActivity | undefined {
  const { live, facts, transcriptMtimeMs, now } = input;
  const failedAt = input.own?.queryFailedAt;
  const own = failedAt === undefined ? input.own : undefined;
  let state: ActivityState | undefined;
  // A finished turn that ended with an API error, or this connection's query
  // of the session failed and nothing was written since.
  const failed =
    (facts.turnState === "finished" && facts.lastTurnError === true) ||
    (failedAt !== undefined &&
      !((facts.lastPromptAt ?? 0) > failedAt) &&
      !((facts.lastTurnEndedAt ?? 0) > failedAt));
  if (own) {
    state = own.state ?? "idle";
    if (state === "idle" && own.lastTurnFailed) state = "error";
  } else if (!live) {
    state = failed ? "error" : "idle";
  } else if (usesRegistryStatus(live, transcriptMtimeMs)) {
    // A busy or waiting CLI wins; an idle one shows how its turn ended.
    state = registryState(live.status);
    if (state === "idle" && failed) state = "error";
  } else if (failed) {
    state = "error";
  } else if (facts.turnState === "finished") {
    state = "idle";
  } else if (
    facts.turnState === "unfinished" &&
    now - transcriptMtimeMs < RECENT_UNFINISHED_TURN_MS
  ) {
    state = "running";
  }
  const lastTurnEndedAt = iso(own?.lastTurnEndedAt ?? facts.lastTurnEndedAt);
  if (state === undefined && lastTurnEndedAt === undefined) return undefined;
  return {
    ...(state !== undefined && { state }),
    ...(lastTurnEndedAt !== undefined && { lastTurnEndedAt }),
  };
}

/** The cost of a session: the last result of a session this connection runs,
 *  else the last `cost-state` of the transcript. Only a positive amount. */
export function selectCost(own: OwnSessionState | undefined, facts: TranscriptFacts) {
  const amount = own?.costUsd !== undefined && own.costUsd > 0 ? own.costUsd : facts.costUsd;
  return amount !== undefined && Number.isFinite(amount) && amount > 0 ? amount : undefined;
}
