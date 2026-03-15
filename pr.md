fix: stale PostToolUse notifications and background task output leak

## Problem

Two independent bugs caused stale or garbled output in ACP clients (agent-shell):

1. **PostToolUse hook race**: The SDK fires `PostToolUse` hooks ~42ms before the streaming handler registers callbacks, causing `"No onPostToolUseHook found"` errors and lost `session/update` notifications. For subagent child tool uses, the gap is 10-60+ seconds.

2. **Background task output leak**: The SDK handles background task completion differently depending on task type. For `local_agent` tasks (subagents), the SDK internally defers the `result` message via its `iP()` function (minified; likely `hasRunningDeferrableTasks`) — the turn stays open until the agent task finishes. But for `local_bash` tasks (`run_in_background` Bash commands), the SDK does **not** defer — it emits `result` immediately, then yields `task_notification` followed by an internal model turn *after* the result. `prompt()` returned at the first `result`, leaving the internal turn in the iterator buffer. The next `prompt()` call processed stale background task output instead of the user's actual input — the model responded to its own background task completion rather than "yes". This asymmetry is why the fix only tracks `local_bash` tasks: `local_agent` is already handled by the SDK. It also points at the ideal upstream fix: extending the SDK's `iP()` / `hasRunningDeferrableTasks` to include `local_bash` tasks would eliminate the leak at the source, making the adapter's poll loop, queue peeking, and SDK internal API access unnecessary. The entire Fix 2 is a workaround for this gap.

### Three contamination layers

The background task leak manifests through three independent mechanisms. All three must be understood to evaluate why the indefinite poll (Fix 2) is the only viable solution:

1. **Layer 1 — Iterator-level internal turns**: The SDK yields `task_notification → assistant → result` (sometimes with `init` / `stream_event` interspersed) through the query iterator after the user turn's `result`. If `prompt()` returns at the first `result`, these leak into the next `prompt()` call's iterator buffer. **This is what Fix 2 directly addresses.**

2. **Layer 2 — SDK context injection**: The SDK injects `<task-notification>` and `<system-reminder>` content directly into the LLM's conversation history as **user-role messages**, before the adapter's prompt loop runs. This is a separate mechanism from the iterator — these messages never appear on the ACP wire (confirmed: zero `task_notification`, `task_started`, or `local_command_output` in `traffic.eld` debug captures). The model sees system-dominated content, concludes "the user hasn't said anything," responds to the notifications, and `end_turn`s without addressing the real question. **Keeping the turn open also fixes this**: if the turn never ends while tasks are pending, there is no "next turn" for the SDK to inject stale notifications into.

3. **Layer 3 — `local_command_output` forwarding**: The adapter's `local_command_output` handler (system message case) forwards linter/hook output as `agent_message_chunk` to ACP clients. This is visible agent text that the user didn't request. **Not addressed by this PR** — it's a separate contamination vector unrelated to background tasks.

### Why the user's prompt gets "swallowed"

The user-visible symptom is that they must send the same message twice. Below is a complete walkthrough from the debug logs (`x.acp-debug-20260315-000100/`) showing the exact sequence.

#### Step 1: Background task launched during previous turn

The agent launched a codex review as a background bash task. ACP wire traffic shows the task ID and output path in `tool_call_update` notifications:

```jsonc
// ACP wire — tool_call_update with backgroundTaskId
{"jsonrpc":"2.0","method":"session/update","params":{
  "sessionId":"dc75a7b7-…",
  "update":{
    "_meta":{"claudeCode":{
      "toolResponse":{"stdout":"","stderr":"","backgroundTaskId":"bsmr1wpsf"},
      "toolName":"Bash"}},
    "toolCallId":"toolu_01UabGxp5WKpecR7S9fXGKAP",
    "sessionUpdate":"tool_call_update"}}}

// Separate tool_call_update with the output file path (same toolCallId)
{"jsonrpc":"2.0","method":"session/update","params":{
  "sessionId":"dc75a7b7-…",
  "update":{
    "_meta":{"terminal_output":{
      "terminal_id":"toolu_01UabGxp5WKpecR7S9fXGKAP",
      "data":"Command running in background with ID: bsmr1wpsf. Output is being written to: /private/tmp/claude-504/…/tasks/bsmr1wpsf.output"}},
    "toolCallId":"toolu_01UabGxp5WKpecR7S9fXGKAP",
    "sessionUpdate":"tool_call_update"}}}
```

The turn ends normally (`end_turn`). The background task is still running. **Note**: `task_notification`, `task_started`, and `local_command_output` never appear in `traffic.eld` — they are purely SDK-internal.

#### Step 2: User sends their next prompt

```
;; ACP wire (log.txt:6610) — user's actual question
{"jsonrpc":"2.0","method":"session/prompt","id":4,
 "params":{"sessionId":"dc75a7b7-…",
  "prompt":[{"type":"text","text":"this should be very little added code, right?
    everything about the subcommand parsing, selectors, targets, etc.
    should all be shared code between plan and init?"}]}}
```

#### Step 3: Adapter consumes stale internal turn (Layer 1 — working)

```
;; claude-agent-acp STDERR (log.txt:6615,6619)
Session dc75a7b7-…: consuming background task result
Session dc75a7b7-…: consuming background task result
```

The `backgroundInitPending` mechanism detects the stale `init → result` cycle and consumes it. Layer 1 is working.

#### Step 4: Model responds — but to the wrong content (Layer 2 — broken)

Despite Layer 1 consuming the iterator-level leak, the SDK has already injected `<task-notification>` and system content into the LLM's conversation history as user-role messages. The model's thinking stream reveals it:

```
;; ACP wire (log.txt:6623-6696) — agent_thought_chunk stream
"The user hasn't said anything - these are just system notifications
 about linter changes to BUILD.bazel and terraform.go (reordering
 the srcs list alphabetically), and a background task completing.
 The linter changes look fine - just alphabetical sorting of the
 srcs list. Nothing for me to do here unless the user asks something.

 Wait, I should check if the user is actually prompting me or if
 this is just notifications. Looking at the message, there's no
 user text - just system reminders and a task notification."
```

The model explicitly says "the user hasn't said anything" and "there's no user text" — even though the user's question is present in the `session/prompt` request. The SDK-injected content dominates the context.

#### Step 5: Visible response addresses linter output, not the user's question

```
;; ACP wire (log.txt:7106-7146) — agent_message_chunk stream
"Linter reordered the `srcs` list in BUILD.bazel alphabetically
 — looks correct. Everything checks out."
```

The model responds to the linter/system content and `end_turn`s. The user's actual question about shared code between plan and init is never addressed.

#### What the user sees in agent-shell

```
╭─ Agent ─────────────────────────────────────────────────────────╮
│ Full review running in background. I'll share results when it   │
│ completes.                                                      │
╰─────────────────────────────────────────────────────────────────╯

> this should be very little added code, right? everything about
> the subcommand parsing, selectors, targets, etc. should all be
> shared code between plan and init?

╭─ Agent ─────────────────────────────────────────────────────────╮
│ Linter reordered the `srcs` list in BUILD.bazel alphabetically  │
│ — looks correct. Everything checks out.                         │
╰─────────────────────────────────────────────────────────────────╯

> this should be very little added code, right? everything about
> the subcommand parsing, selectors, targets, etc. should all be
> shared code between plan and init?

╭─ Agent ─────────────────────────────────────────────────────────╮
│ Yes — the `plan` subcommand reuses the existing selector,       │
│ target, and output infrastructure. The new code is mostly…      │
╰─────────────────────────────────────────────────────────────────╯
```

The user must send the identical message twice. The first attempt is consumed by the model responding to SDK-injected system content. Only the second attempt gets a real answer.

#### Observed in this investigation session

This exact pattern reproduced live during the investigation. Three `<task-notification>` messages from subagent `find` commands leaked into the conversation. The `[bg-task-leak]` warning fired:

```
[bg-task-leak] result received with 1 unresolved background task(s) [b4oxxatfz]
  but no task_notification in queue — possible internal turn leak into next prompt
```

The user's question about the `[bg-task-leak]` warning was swallowed — the model responded to the stale `<task-notification>` instead. The user had to resend.

## Root Cause Analysis

### Bug 1: PostToolUse hook timing

The SDK fires hooks synchronously from its tool execution path, but streaming events that trigger `registerHookCallback()` are consumed asynchronously from the query iterator. For fast tools, the hook fires before the `content_block_start` event is processed (~42ms gap). For subagent child tools, the gap is 10-60+ seconds because messages are relayed only when the subagent finishes.

### Bug 2: SDK internal turns from background tasks

Reading the minified SDK source revealed the root cause: the SDK's `iP()` function (minified; likely `hasRunningDeferrableTasks()` or `shouldDeferResult()` based on usage) checks whether to defer the `result` message for running background tasks, but only includes `local_agent` tasks — NOT `local_bash` tasks. Similarly, the internal queue class `q4` (likely `InputStreamQueue` or `MessageBuffer`) is where we peek for buffered `task_notification` messages. When a background Bash task completes after the turn's `result`, the SDK emits:

```
[148] result/success         <- prompt() returns here (premature)
[149] system/task_notification <- bg task completed
[150] system/init            <- internal turn starts
[151-167] stream_event deltas <- model responds to task completion
[168] assistant message
[172] result/success         <- internal turn ends (leaked to next prompt)
```

Verified: the Claude TUI hides this by rendering internal turns inline, but ACP clients can't — they see the stale output on the next prompt.

**Wire-level evidence**: `task_notification`, `task_started`, and `local_command_output` never appear in ACP wire traffic (`traffic.eld` captures from agent-shell debug sessions). These are purely SDK-internal messages that the adapter sees through the query iterator but that never cross the ACP protocol boundary. This distinction matters for debugging: ACP clients cannot observe or intercept these messages — only the adapter can.

## Independence Proof

Empirically verified both fixes are independently necessary:
- Reverted fire-and-stash -> 10 PostToolUse tests fail, bg-task-leak tests pass
- Reverted internal turn fix -> bg-task-leak tests fail, PostToolUse tests pass

## Fix 1: Non-blocking fire-and-stash (tools.ts)

When the hook fires before registration:
1. Stash `{ toolInput, toolResponse }` and return `{ continue: true }` immediately
2. When `registerHookCallback()` runs later, find stash, execute callback, clean up
3. Periodic sweep (60s, 5min TTL, `unref()`) cleans orphaned entries

Handles both the 42ms race and 10-60s subagent delay with zero blocking.

## Fix 2: Indefinite poll loop for internal turn consumption (acp-agent.ts)

After receiving a `result/success`, the adapter keeps the turn open indefinitely until all background tasks resolve or the user cancels. This fixes both Layer 1 (iterator-level internal turns are consumed before `prompt()` returns) and Layer 2 (no stale notifications exist to inject into the next turn's context). It also aligns with the turn-based nature of ACP — the agent shouldn't appear idle while background work is pending. The competing Agent Communication Protocol (agentcommunicationprotocol.dev) validates this design: runs stay `in-progress` until terminal state, with no concept of "done but also not done."

### Secondary benefit: agent-shell rendering continuity

Keeping the turn open also fixes the "idle then flood" rendering behavior observed in agent-shell. Without this fix, the old sequence was: (1) agent finishes main work, `prompt()` returns `end_turn`, (2) background task continues running, (3) agent-shell sees `end_turn` and stops rendering agent output, (4) background task output arrives but agent-shell doesn't render it (UI appears idle), (5) user sends next message, (6) agent-shell starts rendering again and floods all buffered content at once. With the indefinite poll loop, the turn stays open while background tasks run, so agent-shell continues to render `sessionUpdate` notifications (tool_call_update, agent_message_chunk) live. This was confirmed by Codex analysis and by the E2E poll harness — Turn A held open ~43s while the background task ran, with output activity logged throughout. The same edge-case gaps apply: error/cancellation paths can still cause premature `end_turn` (see Known limitations).

### Design evolution

The fix went through several iterations based on review feedback:

1. **v1: Peek once with setTimeout(0)** — yielded one macrotask tick, peeked at `queue[0]`. Race condition: `task_notification` could arrive later.
2. **v2: Poll loop with 30s inactivity timeout** — polled every 1s for up to 30s of inactivity. File growth reset the timer. Risk: timeout could fire before slow tasks complete, reintroducing contamination.
3. **v3 (current): Indefinite poll, no timeout** — the turn stays open until `task_notification` arrives or the user cancels. This is the only design that fully prevents contamination.

### How it works

1. Track `local_bash` background tasks via `task_started` messages (Map with outputPath, taskType, toolUseId, firstSeenAt, lastActivityAt). Ignore `local_agent` — SDK handles those via its internal `iP()` check.
2. Cache output paths from `terminal_output` even before `task_started` arrives (earlyOutputPaths Map), to handle SDK message ordering variations.
3. After `result/success`, if `pendingTaskIds` is non-empty, enter the poll loop:
   - Poll every 1s
   - Check cancellation each iteration (returns `{ stopReason: "cancelled" }`)
   - Scan the full SDK internal queue (`inputStream.queue`) for any `task_notification` — not just `queue[0]`, to handle other system messages queued before it
   - Monitor output file growth via `fsp.stat()` as a per-task heartbeat
   - Log aggregated task summary immediately on entry and every 30s, including per-task `inactiveFor` and a warning: "cancellation risks later prompt contamination"
   - Log per-task output activity on file size changes
4. When `task_notification` is found in queue, save the prompt response and continue the outer message loop to consume the internal turn.

### Key design decisions

- **No timeout**: A timeout that fires before `task_notification` arrives reintroduces the exact contamination bug we're fixing — and there is no recovery path. Once the turn ends with tasks pending, the SDK will inject `<task-notification>` into the next turn's conversation context as user-role messages (Layer 2). The adapter cannot intercept or filter SDK-level context injection — it only controls what it pushes via `session.input.push()`, not what the SDK adds alongside it. A "pump prompt" strategy (sending a synthetic prompt to consume the notification) fails for the same reason: the pump prompt text faces the same contamination as a real user prompt. The only clean options are: wait for the task (current design), or kill the task on cancel. The user can always cancel.
- **Queue scanning**: We scan `queueArr.some(...)` instead of just `queue[0]` because the SDK may queue other system messages (e.g., `init`) before the `task_notification`.
- **Output path caching**: The `earlyOutputPaths` Map handles the case where `terminal_output` (with the background task ID and output file path) arrives before `task_started`. When `task_started` fires, it merges the cached path.
- **Only `result/success` path**: The poll loop only runs for successful results. Error paths (`max_tokens`, `error_during_execution`, etc.) return/throw immediately — this is a documented known limitation. The internal turn still leaks for error results, but this is rare and less impactful.

### Known limitations

- **Error result paths don't drain**: If the main result is `max_tokens` or any `error_*` variant, the function returns/throws immediately without waiting for background tasks. Internal turns can still leak in these cases. Documented in the `error_during_execution` test.
- **SDK internal access**: Uses `inputStream.queue` which is not a public API. The `task_type === "local_bash"` filter relies on an untyped SDK field verified by reading minified source. Both are documented as workarounds pending upstream SDK changes.
- **Indefinite wait risk**: If `task_notification` never arrives (hung task, SDK bug), `prompt()` blocks forever. The 30s progress logs make this visible, and cancellation is the escape hatch.
- **`local_command_output` forwarding (Layer 3)**: The adapter forwards `local_command_output` system messages as `agent_message_chunk` to ACP clients. This causes linter/hook output to appear as visible agent text unrelated to the user's question. This is a separate contamination vector not addressed by this PR — it's independent of background tasks and would need its own fix (gating or reclassifying the output).

## Changes

### Source
- **`src/tools.ts`**: Fire-and-stash mechanism replacing blocking Promise.race
- **`src/acp-agent.ts`**: Indefinite poll loop for bg task internal turn consumption, structured logging, earlyOutputPaths ordering fix, pendingTaskIds Map with rich metadata (taskType, toolUseId, firstSeenAt, lastActivityAt)
- **`src/embed.d.ts`**: Type declaration shim for single-file bun build module

### Tests (159 pass, 6 skipped, 0 flaky)
- **`src/tests/bg-task-leak.test.ts`** (16 tests): Full SDK message sequence from real trace data
  - Sync/async internal turn consumption
  - Cross-prompt stale message isolation
  - local_agent vs local_bash filtering
  - Aggregated log fires immediately + every 30s (escaped by cancellation)
  - Terminal statuses (completed/failed/stopped)
  - error_during_execution known limitation
  - Multiple back-to-back internal turns
  - Task_notification arriving during poll (500ms, 5s delays)
  - Cancellation during poll loop returns immediately
  - Queue scan detects task_notification behind other messages
- **`src/tests/tools.test.ts`** (10 new tests): Fire-and-stash contract
  - Happy path, 42ms race, subagent delay, batch, error handling
  - All deterministic (fake timers + microtask flushing, zero real delays)

### Infrastructure
- **`bin/test`**: Local CI mirror — parses `.github/workflows/ci.yml` with `yq`
- **`src/tests/authorization.test.ts`**: Type fix for `auth` extension property
- Build fixes: SDK import path correction, embed module declaration

## E2E Verification

Standalone harness (`x.bg-task-leak-harness.mjs`) spawns real ACP agent, launches background Bash tasks via subagents, and validates Turn B responds to "yes" (not stale background output):

- **Pre-fix**: 3/3 leak detected — Turn B returned in 1ms with "The background task completed... still waiting on your answer"
- **Post-fix**: 3/3 clean — Turn B returned in 9-19s with file creation tool calls

## Codex Review Summary

5 rounds of automated review (Codex CLI `--sandbox read-only`). Final findings:

| Severity | Finding | Status |
|----------|---------|--------|
| High | Indefinite poll loop can block forever | Intentional — timeout reintroduces the bug. Cancellation is the escape. 30s progress logs provide visibility. |
| Medium | Error/max_tokens paths don't drain internal turns | Known limitation, documented in test. Follow-up. |
| Low | Stale `toolUseCallbacks` sweep comment (tools.ts) | Pre-existing, outside our diff. |

## Risk

**Low for fire-and-stash**: Happy path unchanged. Stash path replaces 5s block with immediate return.

**Medium for internal turn fix**: Accesses SDK internals (`inputStream.queue`) not in public API. The `task_type === "local_bash"` filter relies on an untyped SDK field verified by reading the minified SDK source. Both are documented as workarounds pending upstream SDK changes. The indefinite poll loop is a deliberate tradeoff: it prevents prompt contamination at the cost of requiring cancellation if a task never resolves. This tradeoff is forced — no timeout-based alternative exists that doesn't reintroduce contamination, because there is no recovery mechanism once the turn ends with pending tasks (the SDK's context injection cannot be intercepted by the adapter).

## Test plan

- [x] `npm run lint` + `npm run test:run` — 159 tests pass, 0 lint errors
- [x] E2E harness: 3/3 iterations clean (background task consumed during Turn A)
- [x] 5 rounds of Codex review — all findings addressed or documented as known limitations
- [x] Fire-and-stash independence empirically proven (revert -> 10 tests fail)
- [ ] Manual: verify no `[hook-trace]` errors in agent-shell during subagent workloads
- [ ] Manual: verify `[bg-task-poll]` logs appear in stderr during background task waits
- [x] E2E: long-running background task poll loop harness (tracked as `claude-code-acp-uzw`) — verified ~35s background task triggers poll loop, logs output file activity and aggregated summaries to STDERR, consumes `task_notification` cleanly, Turn B responds to "yes" without contamination (results in `x.poll-harness-results.txt`)
- [ ] Upstream: file SDK issue for `local_bash` result deferral
