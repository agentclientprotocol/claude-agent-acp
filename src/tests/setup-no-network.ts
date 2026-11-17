import { beforeEach, vi } from "vitest";

// `providers/set` lists the gateway's models with `fetch` (gateway-models.ts),
// and a failed listing fails the call. Tests that set an `anthropic` or
// `bedrock` provider would otherwise send that request to their example
// gateway URLs, so every test gets a 404 instead. That means the gateway has
// no listing and leaves the SDK catalog unchanged. Tests of model discovery
// supply their own listing, including authoritative empty results.
beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("No model listing", { status: 404 })),
  );
});
