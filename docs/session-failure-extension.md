# Session failure extension

This document defines the provider-neutral experimental `sessionFailure` extension implemented by
`claude-agent-acp`. Warnings and errors are durable transcript entries shown in order beside user,
agent, and tool messages. They are not assistant-authored text and not ephemeral chat banners.

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
`1` and `capabilities` contains `sessionFailure`. Otherwise it preserves the legacy ACP behavior.

## Wire record

The record is placed under `_meta.jetbrains.air.sessionFailure`:

```json
{
  "_meta": {
    "jetbrains": {
      "air": {
        "version": 1,
        "sessionFailure": {
          "id": "prompt-uuid:error",
          "revision": 1,
          "category": "limit",
          "severity": "error",
          "title": "You've hit your individual spend limit · run /usage-credits to ask your admin for a higher limit",
          "actions": []
        }
      }
    }
  }
}
```

| Field      | Required | Type                 | Meaning                                                                 |
| ---------- | -------: | -------------------- | ----------------------------------------------------------------------- |
| `id`       |      yes | non-empty string     | Stable identity of one logical incident.                                |
| `revision` |      yes | positive integer     | Monotonically increasing version of that incident.                      |
| `category` |      yes | category enum        | Broad machine-readable visual group.                                    |
| `severity` |      yes | `warning` or `error` | Inline warning or error presentation.                                   |
| `title`    |      yes | string               | Complete normal user-facing presentation.                               |
| `details`  |       no | string               | Long explanation used only when required text is too large for `title`. |
| `actions`  |      yes | ordered string array | Recovery actions recommended by the adapter.                            |

There are no `phase`, `source`, `safeMessage`, `retryable`, `retryAfterMs`, `turnId`, retry-counter,
or provider-code fields. Retry progress belongs in `title` when Claude supplies it. Transcript order
and persistence time come from the receiving ACP event.

## Identity, revisions, and history

`id` identifies one occurrence, not an error type.

- The first record for an incident creates one transcript entry at the current stream position.
- The same `id` with a higher `revision` updates that entry in place without moving it.
- The same or a lower revision is idempotently ignored by the client.
- A later independent occurrence uses a new `id`, even when its category and text are identical.
- Consecutive duplicate notices may reuse one id and increment its revision.
- Different ids are never deduplicated by comparing title or category.

Live turn failures use `<turnId>:error`. Session-scoped incidents use an adapter-session epoch plus an
incident sequence. Notices have their own `:notice:` namespace. A restored usage-limit message uses
`<sessionId>:history-error:<messageUuid>`, which is stable across replay.

Resolved records remain in transcript history. Recovery removes only the adapter's internal active
state; it does not publish a clear tombstone and does not delete or rewrite the historical entry. A
producer may publish a higher revision only when it has a real new user-facing status to show.

## Delivery surfaces

A turn-terminal failure is attached to the successful ACP `PromptResponse` in `_meta`; the response
uses `stopReason: end_turn`. Session-scoped, replay-restored, warning, and background incidents use a
`session_info_update`. The schema is identical on both carriers.

A warning does not end a turn. An error record does not independently invent ACP lifecycle state;
the prompt response or transport lifecycle remains authoritative. If no capable client negotiated
the extension, existing JSON-RPC errors and transcript text remain unchanged.

## Categories

Categories are deliberately broad and drive only iconography and generic accessibility labels.

| Category     | Covers                                                                |
| ------------ | --------------------------------------------------------------------- |
| `connection` | Lost transport, stopped or shutting-down worker, unavailable runtime. |
| `access`     | Authentication required, rejected credentials, denied access.         |
| `limit`      | Rate, quota, token, context, turn, or configured budget limit.        |
| `request`    | Invalid input, unsupported model or operation, rejected request.      |
| `service`    | Provider overload, provider failure, adapter/internal failure.        |
| `unknown`    | A warning or failure that does not fit another group.                 |

Claude SDK conditions map to these groups:

| Claude condition                                                                         | Category                           |
| ---------------------------------------------------------------------------------------- | ---------------------------------- |
| `authentication_failed`, `oauth_org_not_allowed`, synthetic login message                | `access`                           |
| `billing_error`, `rate_limit`, `max_output_tokens`, usage/spend limit, budget/turn limit | `limit`                            |
| `invalid_request`, `model_not_found`                                                     | `request`                          |
| `overloaded`, `server_error`, unknown provider error, adapter internal error             | `service`                          |
| query transport loss, worker shutdown                                                    | `connection`                       |
| model fallback notice                                                                    | `unknown` with `severity: warning` |

Unknown SDK error kinds degrade to `service`; they never become success. Category does not determine
message text or client behavior beyond presentation.

## Severity

- `warning` means the operation may still succeed and normally has no actions while recovery is in
  progress. It does not terminate the turn.
- `error` means the operation cannot continue without user action or another request.

Severity is always explicit.

## Title and details

`title` is the complete normal presentation: what happened, retry progress when present, and a short
next step. The adapter must not replace a real Claude message with category-specific canned wording.

For Claude SDK failures the title is copied from the user-facing text Claude already emitted:

- top-level assistant error text, including synthetic usage-limit and login messages;
- otherwise the terminal SDK result or error text;
- the exact model-fallback notice for warning records.

Adapter-authored fallback text is allowed only when no Claude user-facing message exists, such as a
query iterator throwing, worker-shutdown EOF, or an internal missing-result invariant. Raw thrown
exceptions, stack traces, transport URLs, tokens, headers, environment values, and private paths are
never used as titles.

`details` is reserved exclusively for required explanations too large to fit reasonably in `title`.
If the complete message fits in `title`, `details` must be omitted. It is not a place for status text,
retry counters, provider payloads, or diagnostics.

## Actions

Version 1 defines only:

| Action        | Meaning                                            |
| ------------- | -------------------------------------------------- |
| `retry`       | Retry the operation associated with this incident. |
| `login`       | Start authentication.                              |
| `new_session` | Start a fresh agent session/runtime.               |

The adapter supplies action ordering. The client filters actions it cannot safely execute and ignores
unknown or duplicate values. The client must not infer actions from category.

Current Claude policies are:

- authentication: `login`;
- provider overload/error and recoverable internal error: `retry`;
- transport loss or worker shutdown: `new_session`;
- context or configured session-budget exhaustion: `new_session`;
- account quota and invalid request: no action.

## Internal recovery

Recovery policy is internal adapter state and is not serialized:

- restored quota remains active until a real model answer;
- authentication remains active until successful `auth_status`;
- transport loss and worker shutdown remain active until runtime replacement;
- other turn-scoped failures stop being active at a later confirmed attempt boundary;
- notices are not cleared merely by generic success.

Recovery never removes the transcript record. Publishing another incident is not evidence that an
older one recovered.

## History replay

`session/load` scans top-level assistant history for SDK synthetic usage-limit messages. It recognizes
only `<synthetic>` messages beginning with SDK-owned stable prefixes, not arbitrary model prose. The
latest matching message stays active until a later real-model answer proves recovery.

For a capable client, replay suppresses the duplicate assistant prose and restores one typed error
using the exact stored Claude text as `title`. Legacy clients receive the original transcript and no
typed record.

## Verification

The executable contract lives primarily in `src/tests/acp-agent.test.ts`, under `usage-limit failure
replay`, `stop reason propagation`, and `model refusal fallback handling`.

```sh
npm run build
npm run check
npm run test:run
```
