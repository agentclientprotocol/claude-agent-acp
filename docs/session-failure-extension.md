# Session failure extension

This document defines the provider-neutral experimental session-failure extension implemented by
`claude-agent-acp`. It lets a capable ACP client render failures and non-fatal notices as durable,
structured session state instead of guessing from provider prose in the assistant transcript or a
JSON-RPC error message.

## Capability negotiation

The extension is opt-in. A client advertises it in `initialize`:

```json
{
  "clientCapabilities": {
    "_meta": {
      "jetbrains": {
        "air": {
          "version": 1,
          "capabilities": ["sessionFailure"]
        }
      }
    }
  }
}
```

The adapter enables the extension only when `version` is a finite integer greater than or equal to
`1` and `capabilities` is an array containing `sessionFailure`. Missing, fractional, string, zero,
negative, or non-finite versions do not enable it. This strict check prevents a partially understood
failure contract from changing prompt settlement.

Clients that do not advertise the capability retain the legacy behavior: prompt failures reject the
ACP request through the normal JSON-RPC error path, and provider text that was historically part of
the transcript remains there.

## Wire record

The adapter publishes a record under `_meta.jetbrains.air.sessionFailure`:

```json
{
  "_meta": {
    "jetbrains": {
      "air": {
        "version": 1,
        "sessionFailure": {
          "id": "prompt-uuid:error",
          "revision": 1,
          "phase": "active",
          "category": "rate_limited",
          "source": "claude",
          "safeMessage": "Claude is temporarily rate limited.",
          "retryable": true,
          "retryAfterMs": 30000,
          "actions": ["retry"],
          "turnId": "prompt-uuid"
        }
      }
    }
  }
}
```

Fields have the following contract:

- `id` is the stable identity of one failure lineage.
- `revision` is a positive, monotonically increasing integer within that identity.
- `phase` is `active` or `cleared`. A clear is a tombstone with the same `id` and a higher revision.
- `category` is one of the categories in the table below.
- `source` is `claude`.
- `safeMessage` is safe, adapter-owned user-facing text, except for `advisory`, whose text is the
  sanitized notice supplied by the runtime.
- `retryable` describes whether repeating the failed request can help.
- `actions` is an ordered list of suggested client actions. A client still applies its own capability
  checks before rendering an action.
- `retryAfterMs`, when present, is the minimum delay before Retry should become available.
- `turnId`, when present, associates the record with one prompt turn.
- `severity` is `warning` for a non-fatal advisory. It is omitted for errors so older clients retain
  their historical error default.

Unknown fields must be ignored. Clients should retain the latest revision for every `id`, including
cleared tombstones, so stale or replayed updates cannot reactivate an older revision. Multiple active
identities may coexist; for example, a warning must not erase an actionable error merely because it
arrived later.

## Delivery surfaces

A turn-terminal failure for a negotiated client is attached to the successful ACP `PromptResponse`
in `_meta`. The turn settles with `stopReason: end_turn` instead of rejecting the JSON-RPC request;
the structured record is the authoritative failure result.

Session-scoped, replay-restored, warning, background, and cleared records are sent in a
`session_info_update`. If a terminal failure occurs without a live unsettled turn, it is downgraded to
that session-scoped carrier rather than being lost.

State changes are transactional with delivery: the adapter records a revision as active or cleared
only after the corresponding update is sent successfully. A failed clear remains active and can be
retried at the next qualifying recovery boundary. Updates from a stale query consumer are rejected
and logged rather than mutating the replacement consumer's state.

## Categories and presentation

| Category            | Meaning                                               | Retryable | Suggested actions | Default recovery                        |
| ------------------- | ----------------------------------------------------- | --------: | ----------------- | --------------------------------------- |
| `advisory`          | Non-fatal runtime notice                              |        no | none              | Never auto-clear                        |
| `auth_required`     | Authentication is absent or rejected                  |        no | `login`           | Successful `auth_status`                |
| `bad_request`       | Invalid request or model not found                    |        no | `new_turn`        | Next confirmed attempt when turn-scoped |
| `budget_exhausted`  | Configured session budget reached                     |        no | `new_session`     | Next confirmed attempt when turn-scoped |
| `context_exhausted` | Turn/output limit reached                             |        no | `new_turn`        | Next confirmed attempt when turn-scoped |
| `internal_error`    | Adapter/runtime internal error                        |       yes | `retry`           | Next confirmed attempt when turn-scoped |
| `overloaded`        | Provider temporarily overloaded                       |       yes | `retry`           | Next confirmed attempt when turn-scoped |
| `provider_error`    | Unclassified provider failure                         |       yes | `retry`           | Next confirmed attempt when turn-scoped |
| `quota_exhausted`   | Claude account has no available quota                 |        no | none              | Real model answer                       |
| `rate_limited`      | Provider rate limit                                   |       yes | `retry`           | Next confirmed attempt when turn-scoped |
| `transport_lost`    | Query transport ended exceptionally                   |        no | `new_session`     | New runtime binding                     |
| `worker_shutdown`   | Claude worker announced shutdown and the stream ended |        no | `new_session`     | New runtime binding                     |

The SDK exposes a rate-limit category but not the provider's `Retry-After` header. The adapter
therefore publishes a conservative `retryAfterMs: 30000` floor. This value is a client-throttling
guard, not a claim about the provider's exact reset time.

Account quota deliberately has no `new_session` action: starting another conversation does not
replenish account spend. A client may show administrative guidance from its own product context, but
must not infer that a fresh ACP session repairs the condition.

## Claude SDK mapping

Assistant-message `error` values map as follows:

| Claude SDK error                                    | Session failure category |
| --------------------------------------------------- | ------------------------ |
| `authentication_failed`, `oauth_org_not_allowed`    | `auth_required`          |
| `billing_error`                                     | `quota_exhausted`        |
| `rate_limit`                                        | `rate_limited`           |
| `overloaded`                                        | `overloaded`             |
| `invalid_request`, `model_not_found`                | `bad_request`            |
| `max_output_tokens`                                 | `context_exhausted`      |
| `server_error`, `unknown`, missing, or unrecognized | `provider_error`         |

Additional terminal mappings are:

- Claude's synthetic spend/usage-limit assistant message maps to `quota_exhausted`, even when the SDK
  omits an `error` field.
- `error_max_budget_usd` maps to `budget_exhausted`.
- `error_max_turns` and `error_max_structured_output_retries` map to `provider_error` when terminally
  error-shaped.
- A successful result containing `Please run /login` maps to `auth_required`.
- A pending worker-shutdown notification followed by query EOF maps to `worker_shutdown`.
- An exception from the query iterator maps to `transport_lost`; process-death signatures also evict
  the dead adapter session after its in-flight turns are settled.

Classifier refusal is not a session failure. It uses ACP's `refusal` stop reason and preserves the
explanation as assistant output when available. User cancellation similarly uses `cancelled` rather
than manufacturing a failure record.

## Recovery state machine

Recovery is a property of the active record, not a blanket consequence of any successful result:

The recovery policy is adapter/client behavior, not an additional wire field in version 1.

- `advisory` is never cleared by the adapter's success paths. The client may durably dismiss the exact
  `(id, revision)` in its own session projection; a higher advisory revision must appear again.
- `quota_exhausted` clears only after a non-error result that was preceded by a real top-level model
  message. Claude's `<synthetic>` local-command messages, including `/usage` output and `No response
requested.`, do not prove quota recovery.
- `auth_required` clears only after `auth_status` reports that authentication has finished without an
  error.
- `transport_lost` and `worker_shutdown` are not cleared by a later result from the dead query. Their
  recovery belongs to replacement of the runtime/session binding.
- Other turn-scoped failures clear when a later turn reaches a confirmed result boundary. If that
  attempt also fails, its new active identity remains visible.
- Other session-scoped failures require a real model success rather than a local command.

Publishing another failure is not evidence of recovery and does not clear older active identities.
This matters when a restored quota record and a live turn record overlap: both remain replay-safe
until their own recovery condition is satisfied.

## Identity and revision rules

Live turn failures use `<turnId>:error`. Session-scoped errors use
`<sessionId>:session-error:<queryEpoch>`, advisories use `<sessionId>:notice:<queryEpoch>`, and a
restored usage-limit message uses `<sessionId>:history-error:<messageUuid>`.

The random query epoch prevents a late update from a replaced query consumer from colliding with the
new runtime's session-scoped state. Re-publishing the same identity increments its revision. Clearing
also increments the revision and removes the identity from the adapter's active set only after
delivery succeeds.

## History replay

`session/load` scans top-level assistant history for the SDK's synthetic usage-limit messages. It
recognizes only messages whose model is `<synthetic>` and whose text starts with one of the SDK's
stable usage-limit prefixes; arbitrary model prose is never classified by fuzzy matching.

The latest matching message remains active until a later assistant message with a real model id
proves recovery. Local-command and interruption messages with model `<synthetic>` do not. For a
capable client, the active historical condition is restored as `quota_exhausted` after transcript
replay and the raw spend-limit prose is suppressed. A legacy client receives the original transcript
and no structured record.

## Safety and compatibility invariants

- Provider error strings are not copied into the structured `safeMessage` field.
- Extension-aware JSON-RPC errors omit raw provider detail when the structured record is the carrier.
- A malformed capability declaration never changes legacy prompt semantics.
- Warning severity is explicit; all omitted or unknown severity values are treated by clients as
  errors.
- A send failure cannot silently advance active state or a recovery revision.
- A stale consumer cannot publish into a replacement session.
- Background/autonomous results cannot clear or replace the active user turn's failure.
- Unknown SDK error kinds degrade to `provider_error`, never to success.

## Verification

The executable contract lives primarily in `src/tests/acp-agent.test.ts`, under:

- `usage-limit failure replay`
- `stop reason propagation`
- `model refusal fallback handling`

Repository validation is:

```sh
npm run build
npm run check
npm run test:run
```
