import { describe, expect, it } from "vitest";
import type { SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import { resultEnd, type ResultEnd } from "../result-end.js";

const LIMITS = ["error_max_turns", "error_max_budget_usd", "error_max_structured_output_retries"];

/** A result of `subtype`, with the error text `text` on `success` and `["a", "b"]` otherwise. */
function result(
  subtype: string,
  stopReason: string | null,
  isError: boolean,
  text = "API Error: 500",
): SDKResultMessage {
  return {
    type: "result",
    subtype,
    stop_reason: stopReason,
    is_error: isError,
    ...(subtype === "success" ? { result: text } : { errors: ["a", "b"] }),
  } as unknown as SDKResultMessage;
}

const failure = (error: string, loginRequired = false): ResultEnd => ({ error, loginRequired });

/** The subtype, `stop_reason` and `is_error` of a result, and how it ends the work. */
type Row = [string, string | null, boolean, ResultEnd];

describe("resultEnd", () => {
  it.each<Row>([
    ...["success", "error_during_execution", ...LIMITS].flatMap((subtype) =>
      [true, false].map((isError): Row => [subtype, "refusal", isError, { stopReason: "refusal" }]),
    ),
    ["success", "max_tokens", true, { stopReason: "max_tokens" }],
    ["success", "max_tokens", false, { stopReason: "max_tokens" }],
    ["success", "end_turn", true, failure("API Error: 500")],
    ["success", null, false, { stopReason: "end_turn" }],
    ["error_during_execution", "max_tokens", true, { stopReason: "max_tokens" }],
    ["error_during_execution", "max_tokens", false, { stopReason: "max_tokens" }],
    ["error_during_execution", "end_turn", true, failure("a, b")],
    ["error_during_execution", null, false, { stopReason: "end_turn" }],
    // A limit ignores `max_tokens`.
    ...LIMITS.flatMap((subtype) =>
      ["max_tokens", null].flatMap((stopReason): Row[] => [
        [subtype, stopReason, true, failure("a, b")],
        [subtype, stopReason, false, { stopReason: "max_turn_requests" }],
      ]),
    ),
  ])("reads %s with stop_reason %s and is_error %s", (subtype, stopReason, isError, expected) => {
    expect(resultEnd(result(subtype, stopReason, isError))).toEqual(expected);
  });

  it.each([null, "max_tokens"])(
    "fails a success error with the /login text, also with stop_reason %s",
    (stopReason) => {
      const text = "Not logged in · Please run /login";
      expect(resultEnd(result("success", stopReason, true, text))).toEqual(failure(text, true));
    },
  );

  it("fails a limit error with its subtype when Claude Code lists no errors", () => {
    const limit = { ...result("error_max_turns", null, true), errors: [] } as SDKResultMessage;
    expect(resultEnd(limit)).toEqual(failure("error_max_turns"));
  });
});
