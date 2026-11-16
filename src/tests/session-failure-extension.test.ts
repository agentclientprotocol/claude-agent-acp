import { describe, expect, it } from "vitest";
import { apiRetryWarning } from "../session-failure-extension.js";

describe("apiRetryWarning", () => {
  // Each input is one the bundled CLI sends: the CLI derives `error` from the
  // status (`IIt`), and an error with no HTTP response has a null status.
  it.each([
    {
      name: "a no_response retry, which the CLI sends with a 0 ms delay",
      message: {
        error_status: null,
        error: "unknown" as const,
        retry_delay_ms: 0,
        no_response: { waited_ms: 180_000, retry_wait_ms: 600_000 },
      },
      details: "Connection error: no HTTP response. Next attempt now.",
    },
    {
      name: "a background rate-limit wait in minutes, rounded up",
      message: { error_status: 429, error: "rate_limit" as const, retry_delay_ms: 1_740_500 },
      details: "HTTP 429 (rate limited). Next attempt in 30m.",
    },
    {
      name: "a wait just under 120 s in seconds",
      message: { error_status: 529, error: "overloaded" as const, retry_delay_ms: 119_000 },
      details: "HTTP 529 (overloaded). Next attempt in 119s.",
    },
    {
      name: "a wait of 120 s in minutes",
      message: { error_status: 529, error: "overloaded" as const, retry_delay_ms: 120_000 },
      details: "HTTP 529 (overloaded). Next attempt in 2m.",
    },
    {
      name: "a credential error, which has no HTTP status",
      message: {
        error_status: null,
        error: "cloud_credential_error" as const,
        retry_delay_ms: 1_100,
      },
      details: "No HTTP status (cloud credential error). Next attempt in 1s.",
    },
    {
      name: "a message with no error kind as unknown",
      message: { error_status: 503, error: undefined, retry_delay_ms: 600 },
      details: "HTTP 503. Next attempt in 1s.",
    },
  ])("describes $name", ({ message, details }) => {
    expect(apiRetryWarning({ attempt: 1, max_retries: 10, ...message }).details).toBe(details);
  });
});
