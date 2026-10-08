import type { Query } from "@anthropic-ai/claude-agent-sdk";

/** Aborting a control request does not undo it. Terminate its query before the
 * caller releases the session reservation. A failed shutdown keeps a fence. */
export async function boundedNativeMutation<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  shutdown: () => Promise<void>,
  controller: AbortController,
  timeoutMs = 15_000,
): Promise<T> {
  let abort!: () => void;
  const stopped = new Promise<never>((_, reject) => {
    abort = () => {
      void shutdown().then(
        () => reject(new Error("Native mutation interrupted; outcome uncertain, reload required")),
        () =>
          reject(new Error("Native shutdown unconfirmed; reconnect ACP before further mutations")),
      );
    };
    controller.signal.addEventListener("abort", abort, { once: true });
  });
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    if (controller.signal.aborted) {
      abort();
      return await stopped;
    }
    const pending = operation(controller.signal).then(
      async (result) => {
        if (controller.signal.aborted) return await stopped;
        return result;
      },
      async (error) => {
        if (controller.signal.aborted) return await stopped;
        throw error;
      },
    );
    return await Promise.race([pending, stopped]);
  } finally {
    clearTimeout(timer);
    controller.signal.removeEventListener("abort", abort);
  }
}

/** Query.close starts cleanup but is synchronous. For the pinned SDK's local
 * transport, wait for the actual child exit before allowing another query. */
export async function awaitNativeExit(query: Query, timeoutMs = 10_000): Promise<void> {
  const transport = (
    query as unknown as {
      transport?: {
        process?: { exitCode?: unknown; signalCode?: unknown };
        waitForExit?: unknown;
      };
    }
  ).transport;
  if (typeof transport?.waitForExit !== "function")
    throw new Error("Native process exit observer unavailable; shutdown unconfirmed");
  const exited: unknown = transport.waitForExit();
  if (!exited || typeof (exited as PromiseLike<unknown>).then !== "function")
    throw new Error("Native process exit observer returned no promise; shutdown unconfirmed");
  const dispose = query[Symbol.asyncDispose];
  const disposal = typeof dispose === "function" ? dispose.call(query) : undefined;
  const cleanup = Promise.all([
    disposal,
    Promise.resolve(exited).catch((error) => {
      const process = transport.process;
      const code = process?.exitCode;
      const signal = process?.signalCode;
      const hasExitCode = typeof code === "number" && Number.isSafeInteger(code) && code >= 0;
      const hasExitSignal = typeof signal === "string" && /^SIG[A-Z0-9]+$/.test(signal);
      if (!hasExitCode && !hasExitSignal) throw error;
    }),
  ]);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      cleanup,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Native process exit timed out")), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
