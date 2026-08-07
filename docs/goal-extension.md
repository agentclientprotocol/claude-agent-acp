# Goal extension

This document defines a provider-neutral experimental ACP extension implemented by `claude-agent-acp`. It is intentionally shaped like a possible future first-class ACP API: implementations publish `_meta.goal`, not provider-specific metadata such as `_meta.claudeCode.goal`.

## Capability negotiation

An agent advertises support in its `initialize` response:

```json
{
  "_meta": {
    "goal": {
      "version": 1,
      "controlMethod": "_session/goal",
      "actions": ["clear"]
    }
  }
}
```

`actions` is the implementation-supported subset of `set`, `pause`, `resume`, and `clear`. Clients must not infer support for an action that is not advertised. The control request contains `sessionId` and `action`; a future version may add action-specific fields such as an objective for `set`.

## Session state

The current snapshot is published in `session_info_update._meta.goal`. Clearing a goal publishes `goal: null`.

```json
{
  "objective": "Ship the change",
  "status": "active",
  "iterations": 3,
  "lastReason": "Tests still need work",
  "createdAt": 1710000000123,
  "controlMethod": "_session/goal"
}
```

Common statuses are `active`, `paused`, `blocked`, `limited`, and `complete`. Optional fields allow implementations to report budgets, usage, iteration count, and the last continuation reason. Timestamps are Unix milliseconds.

## Lifecycle architecture

A goal belongs to the ACP session, not to an individual `session/prompt` request. Goal activity and prompt activity are independent:

- `status: active` means the persistent objective can drive more work; it does not mean an ACP prompt is currently executing.
- A prompt completes when its current backend turn reaches a quiescent boundary, even when the goal remains active.
- A later autonomous cycle may publish more session updates outside that completed prompt.
- While a turn is running, clients use steering or prompt queueing when advertised. While the session is quiescent, clients may send an ordinary `session/prompt`.

This separation prevents a persistent goal from monopolizing the session's prompt slot and lets clients model “working now” independently from “objective remains active.”

## Claude mapping

Claude's session-scoped `/goal` command installs a Stop hook. The runtime emits internal `active_goal` messages when that hook updates or clears its state; the adapter maps them into the neutral snapshot before the exhaustive SDK message switch. `condition`, `iterations`, `set_at`, and `last_reason` become `objective`, `iterations`, `createdAt`, and `lastReason`. Provider-only bookkeeping such as `tokens_at_start` is not exposed.

Only `clear` is advertised for out-of-band control. The adapter submits `/goal clear` through the existing session prompt queue, preserving the same ordering and lifecycle rules as other Claude commands. Setting a goal remains available through `/goal <condition>` and is not advertised as an extension action because it starts Claude's long-running Stop-hook workflow.
