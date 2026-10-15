import { beforeEach, vi } from "vitest";

// `providers/set` lists the gateway's models with `fetch` (gateway-models.ts),
// and a failed listing fails the call. Tests that set an `anthropic` or
// `bedrock` provider would otherwise send that request to their example
// gateway URLs, so every test gets an empty listing instead. An empty listing
// narrows the picker to no model: a test that checks the picker after
// `providers/set` stubs `fetch` with the models it expects. This default is
// deliberate: listing fixture models for every test would hide which tests
// depend on a listing.
beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ data: [], modelSummaries: [] }))),
  );
});
