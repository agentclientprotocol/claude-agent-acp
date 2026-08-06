import { RequestError } from "@agentclientprotocol/sdk";
import type { SDKActiveGoalMessage } from "@anthropic-ai/claude-agent-sdk";

export const GOAL_EXTENSION_VERSION = 1 as const;
export const GOAL_CONTROL_METHOD = "_session/goal";

export type GoalControlAction = "set" | "pause" | "resume" | "clear";

export type GoalCapability = {
  version: typeof GOAL_EXTENSION_VERSION;
  controlMethod: typeof GOAL_CONTROL_METHOD;
  actions: GoalControlAction[];
};

export type GoalStatus = "active" | "paused" | "blocked" | "limited" | "complete";

export type GoalSnapshot = {
  objective: string;
  status: GoalStatus;
  iterations?: number;
  lastReason?: string | null;
  createdAt?: number;
  updatedAt?: number;
  tokenBudget?: number | null;
  tokensUsed?: number;
  timeUsedSeconds?: number;
  controlMethod: typeof GOAL_CONTROL_METHOD;
};

export type GoalControlRequest = {
  sessionId: string;
  action: "clear";
};

export type GoalControlResponse = Record<string, never>;

export function parseGoalControlRequest(params: unknown): GoalControlRequest {
  if (!params || typeof params !== "object") {
    throw RequestError.invalidParams(undefined, "goal params must be an object");
  }
  const { sessionId, action } = params as Record<string, unknown>;
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    throw RequestError.invalidParams(undefined, "goal params require a non-empty sessionId");
  }
  if (action !== "clear") {
    throw RequestError.invalidParams(undefined, 'goal action must be "clear"');
  }
  return { sessionId, action };
}

export function toGoalSnapshot(message: SDKActiveGoalMessage): GoalSnapshot | null {
  if (message.value === null) {
    return null;
  }
  return {
    objective: message.value.condition.trim(),
    status: "active",
    iterations: message.value.iterations,
    lastReason: message.value.last_reason ?? null,
    createdAt: message.value.set_at,
    controlMethod: GOAL_CONTROL_METHOD,
  };
}
