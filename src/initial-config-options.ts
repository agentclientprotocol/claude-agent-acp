/**
 * The unstable "Session options" RFD, as both cores serve it: `session/options`
 * answers with what a session would start with, and a setup request's
 * `configOptions` set the initial values of the session's config options.
 */
import { RequestError } from "@agentclientprotocol/sdk/unstable";
import type { Logger } from "./logger.js";

/**
 * What a core advertises as `options` in its session capabilities:
 * `session/options`, and `configOptions` on its setup requests.
 */
export const SESSION_OPTIONS_CAPABILITY = {};

const INVALID_PARAMS = RequestError.invalidParams().code;

/**
 * The entries of a setup request's `configOptions`. Omitted and `null` are no
 * entries. Two entries with the same `configId` fail with `-32602`. Call it
 * before the session starts, so a refused request starts none.
 */
export function initialConfigOptions<E extends { configId: string }>(
  entries: readonly E[] | null | undefined,
): readonly E[] {
  const seen = new Set<string>();
  for (const { configId } of entries ?? []) {
    if (seen.has(configId)) {
      throw RequestError.invalidParams(
        { configId },
        `\`configOptions\` sets ${configId} more than once. Send one entry for each config option.`,
      );
    }
    seen.add(configId);
  }
  return entries ?? [];
}

/**
 * Sets each entry with `set`, in list order. `set` checks an entry against the
 * options as the entries before it left them, so a model entry decides which
 * effort levels a later entry can pick.
 *
 * An entry that `set` refuses is skipped, and the entries after it still
 * apply. The option keeps its value, which the setup response reports:
 *
 * - `-32602`: an unknown `configId`, a value of another type than the
 *   option's, or a value that the option does not offer.
 * - Any other failure, such as a model that Claude Code refuses. It is logged.
 */
export async function applyInitialConfigOptions<E extends { configId: string }>(
  entries: readonly E[],
  set: (entry: E) => Promise<unknown>,
  logger: Logger,
): Promise<void> {
  for (const entry of entries) {
    try {
      await set(entry);
    } catch (error) {
      if (error instanceof RequestError && error.code === INVALID_PARAMS) continue;
      logger.error(`Could not set the initial value of config option ${entry.configId}:`, error);
    }
  }
}
