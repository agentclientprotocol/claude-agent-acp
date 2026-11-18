/** Fresh native facts for resumed queries and their standard model controls.
 * Both protocol cores keep this state on the Query's session, never in a cache.
 */
import { RequestError } from "@agentclientprotocol/sdk/unstable";
import type { ModelInfo, Query } from "@anthropic-ai/claude-agent-sdk";
import {
  readNativeContext,
  contextHintOf,
  stripContextHints,
  type NativeContext,
} from "./context-window.js";
import { effortFlagSettings } from "./session-effort.js";
import { readUltracodeSettings } from "./session-ultracode.js";

export type NativeQuery = Pick<
  Query,
  "getContextUsage" | "setModel" | "applyFlagSettings" | "close"
>;

export type NativeConfiguration = NativeContext & { effort?: string; ultracode?: boolean };

export async function readNativeConfiguration(
  query: Pick<Query, "getContextUsage">,
): Promise<NativeConfiguration> {
  const context = await readNativeContext(query);
  const settings = await readUltracodeSettings(query);
  return { ...context, effort: settings?.effort, ultracode: settings?.requested };
}

/** Only exact SDK identity and an explicit context lane establish a match. */
export function matchesNativeModel(
  value: string,
  offered: readonly ModelInfo[],
  actual: NativeContext,
): boolean {
  const row = offered.find((model) => model.value === value);
  const identity = row?.resolvedModel ?? value;
  const context = contextHintOf(value) ?? contextHintOf(identity);
  const model = stripContextHints(identity);
  return (
    (actual.model === value || actual.model === identity || actual.model === model) &&
    (context === null || actual.size === Number(context.slice(0, -1)) * 1_000_000)
  );
}

/** Verify on the same resumed Query that will receive the next prompt.
 * A native write can have taken effect even when its response rejects.
 */
export async function selectNativeModel(
  query: NativeQuery,
  value: string,
  offered: readonly ModelInfo[],
  publish: (actual: NativeConfiguration) => Promise<void>,
  invalidate: () => Promise<void>,
  ultracode = false,
): Promise<NativeConfiguration> {
  const before = await readNativeConfiguration(query);
  if (matchesNativeModel(value, offered, before)) {
    await publish(before);
    return before;
  }
  const effort = before.effort;
  if (
    effort !== "default" &&
    effort !== "low" &&
    effort !== "medium" &&
    effort !== "high" &&
    effort !== "xhigh" &&
    effort !== "max"
  ) {
    throw RequestError.invalidRequest(
      undefined,
      "Claude Code did not report native effort. Reconnect before changing the model.",
    );
  }
  await invalidate();
  try {
    await query.setModel(value);
    const actual = await readNativeConfiguration(query);
    await publish(actual);
    if (!matchesNativeModel(value, offered, actual)) {
      throw RequestError.invalidRequest(
        undefined,
        "Claude Code did not apply the selected model and context. Reconnect before retrying.",
      );
    }
    return actual;
  } catch (error) {
    try {
      await query.setModel(before.model);
      const restored = await readNativeConfiguration(query);
      await publish(restored);
      if (restored.model !== before.model || restored.size !== before.size) {
        throw new Error("Claude Code could not restore the prior model and context", {
          cause: error,
        });
      }
      await query.applyFlagSettings(effortFlagSettings(effort, before.ultracode ?? ultracode));
      const complete = await readNativeConfiguration(query);
      await publish(complete);
      if (complete.effort !== before.effort)
        throw new Error("Claude Code could not restore native effort", { cause: error });
    } catch (restoration) {
      query.close();
      throw Object.assign(
        RequestError.invalidRequest(
          undefined,
          `Native restoration failed. Reconnect before retrying: ${String(restoration)}`,
        ),
        { cause: restoration },
      );
    }
    throw error;
  }
}

export async function prepareNativePrompt(
  query: NativeQuery,
  models: { native?: NativeConfiguration; verifiedModel?: string },
  offered: readonly ModelInfo[],
): Promise<NativeConfiguration | undefined> {
  if (!models.native) return undefined;
  const actual = await readNativeConfiguration(query);
  if (
    models.verifiedModel !== undefined &&
    !matchesNativeModel(models.verifiedModel, offered, actual)
  ) {
    throw RequestError.invalidRequest(
      undefined,
      "The native model changed after selection. Reconnect and select it again before prompting.",
    );
  }
  models.verifiedModel = undefined;
  return actual;
}

export async function selectNativeEffort(
  query: NativeQuery,
  value: string,
  publish: (actual: NativeConfiguration) => Promise<void>,
  invalidate: () => Promise<void>,
  ultracode = false,
): Promise<void> {
  const before = await readNativeConfiguration(query);
  if (!["default", "low", "medium", "high", "xhigh", "max"].includes(before.effort ?? ""))
    throw RequestError.invalidRequest(
      undefined,
      "Claude Code did not report native effort. Reconnect before changing effort.",
    );
  if (before.effort === value) {
    await publish(before);
    return;
  }
  await invalidate();
  try {
    await query.applyFlagSettings(effortFlagSettings(value, before.ultracode ?? ultracode));
    const actual = await readNativeConfiguration(query);
    await publish(actual);
    if (actual.model !== before.model || actual.size !== before.size || actual.effort !== value) {
      throw RequestError.invalidRequest(
        undefined,
        "Claude Code did not apply the selected effort. Reconnect before retrying.",
      );
    }
  } catch (error) {
    try {
      await query.applyFlagSettings(
        effortFlagSettings(before.effort, before.ultracode ?? ultracode),
      );
      const restored = await readNativeConfiguration(query);
      await publish(restored);
      if (
        restored.model !== before.model ||
        restored.size !== before.size ||
        restored.effort !== before.effort
      )
        throw new Error("Native effort restoration could not be verified", { cause: error });
    } catch (restoration) {
      query.close();
      throw Object.assign(
        RequestError.invalidRequest(
          undefined,
          `Native restoration failed. Reconnect before retrying: ${String(restoration)}`,
        ),
        { cause: restoration },
      );
    }
    throw error;
  }
}
