import { RequestError } from "@agentclientprotocol/sdk";
import type { SDKActiveGoalMessage } from "@anthropic-ai/claude-agent-sdk";

export const GOAL_EXTENSION_VERSION = 1 as const;
export const GOAL_CONTROL_METHOD = "_session/goal";

export const GOAL_ACTIONS = ["clear"] as const;
export type GoalAction = (typeof GOAL_ACTIONS)[number];

export type GoalCapability = {
  version: typeof GOAL_EXTENSION_VERSION;
  controlMethod: typeof GOAL_CONTROL_METHOD;
  actions: GoalAction[];
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

export type GoalRequest = {
  sessionId: string;
  action: GoalAction;
};

export type GoalControlResponse = Record<string, never>;

export function goalUpdateFromPrompt(prompt: string): GoalSnapshot | null | undefined {
  const match = /^\/goal(?:\s+([\s\S]*))?$/.exec(prompt);
  const argument = match?.[1]?.trim();
  if (!argument) {
    return undefined;
  }
  if (argument === "clear") {
    return null;
  }
  return {
    objective: argument,
    status: "active",
    controlMethod: GOAL_CONTROL_METHOD,
  };
}

export function parseGoalRequest(params: unknown): GoalRequest {
  if (!params || typeof params !== "object") {
    throw RequestError.invalidParams(undefined, "goal params must be an object");
  }
  const { sessionId, action } = params as Record<string, unknown>;
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    throw RequestError.invalidParams(undefined, "goal params require a non-empty sessionId");
  }
  if (!GOAL_ACTIONS.includes(action as GoalAction)) {
    throw RequestError.invalidParams(undefined, 'goal action must be "clear"');
  }
  return { sessionId, action: action as GoalAction };
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
