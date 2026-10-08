# Session summary: "subagent not detected / early end_turn" investigation

Date: 2026-10-08. Repo: claude-agent-acp at `b2dbc8f` (0.87.0), branch `main`. Nothing committed.

## Original report

Bundle `acp_logs/acp-debug-4efe08ab-20261008-092627/` (IntelliJ AIR, Windows, thread
`acp:4efe08ab`, ACP session `ad493872-519d-4db5-a149-604dac7a6686`). Claim: a subagent runs
that the UI does not detect, and the server reports `end_turn` too early.

## Conclusions (verified)

1. **No subagent ran at dump time, and both `end_turn`s were correct.**
   - The replay/transport logs (`07-replay…acplog`, `05-transport…jsonl`) cover only the
     process launched 06:17:31Z (initialize → `session/resume`). They have no subagent ids.
   - Prompt #4 started the fast lane as a background Bash (`brnie2ttt`); the model said "I
     commit when it finishes" and the turn ended. Prompt #5 also ended.
   - At 06:24:51 the task finished (`async_task_state_update` stopped, then completed in the
     same ms). Claude Code started an **autonomous main-agent turn** (task-notification): Read
     output, 6 foreground Bash calls. At dump, a foreground Bash
     `toolu_01RCMwYrpwtQEbJAyy5WLzpW` was `in_progress`, with no `run_in_background`.
   - The client projection said `status=WaitingForUser`. That is the bug the user perceived as
     a "hidden subagent".
2. **The subagent seen in the UI was earlier.** "Update tests for scope change"
   (`a233408f50ff81765`, only in `03-events` / `02-projection`, the client's cross-process
   log). Its generation 1 ended while its own shells ran. A shell's notification woke it as
   `…:generation:2` (seq 2383–2397) about 9.6 h before this process. The client recorded it
   correctly.
3. **Generation = the same SDK agent resumed with full context.** Same agent id; the
   transcript continues. Evidence: generation 2 stopped `b6t4692py` and deleted temp files from
   generation 1, though its prompt was only the task notification. The adapter mints a new ACP
   child session id, `<taskId>:generation:N` (`src/native-subagents.ts` `openGeneration` /
   `nextChildSessionId`), because the earlier child already got a terminal state. Triggers:
   - a repeated `task_started` for a finished task id;
   - a `task_updated` patch `running`/`pending`, or a SendMessage resume (`taskResumed`).
4. **Async tasks** (`src/async-tasks.ts`, `docs/air-extensions.md` "Async tasks"):
   - An async task is only a backgrounded non-agent task (shell, workflow, …).
   - Foreground Bash is a plain tool call.
   - Subagents (`local_agent` / `subagent_type`) are never async tasks; native subagent
     sessions report them.
   - Monitor tasks are hidden.
   - Liveness follows the SDK background-task list ("level"). A task missing from it gets
     `stopped`, and a later event corrects it to `completed`. The client keeps only the
     `stopped` (client-side bug, minor).
   - The hold: a prompt stays open only for live background **subagents** it spawned
     (`turnAwaitingSubagents`, `src/acp-agent.ts` ~4507). Shells never hold a turn.
5. **The real gap: agent-initiated turns after `end_turn` have no state signal.**
   - The adapter receives SDK `session_state_changed: running/idle` (`src/acp-agent.ts`
     ~5195) and uses it only internally.
   - The only trace on the wire is `usage_update._meta["_claude/origin"] =
     {kind:"task-notification"}` at the **end** of the cycle (~6052).
   - Subagents and async tasks are fine. The user confirmed in AIR that their states display
     correctly with no prompt open.

## Protocol analysis (verified against the installed `@agentclientprotocol/sdk` 1.7.0 schema)

- **ACP v1:**
  - A turn is a client `session/prompt`, and its JSON-RPC response (stop reason) is final, so
    an ended prompt cannot be re-marked running.
  - There is no session-state update. The v1 `SessionUpdate` kinds lack `state_update`.
    (`subagent_update` has a child `StateUpdate`, unstable.)
  - Updates outside a prompt are not forbidden and already happen.
- **ACP v2 (draft, `experimental/v2`):** clean.
  - `PromptResponse` is only `{messageId}`.
  - `state_update` (`running`, `requires_action`, `idle` + `stopReason`/`usage`) describes
    foreground work per session, not per request.
  - The server's v2 bridge `src/v2/prompt.ts` emits it only around client prompts. Gap: also
    emit it for autonomous cycles.
  - `docs/acp-v2.md`, referenced there, does not exist.
- **v1 workaround options** (all are conventions or extensions; none is pure protocol):
  - **A. Reuse the AIR `asyncTasks` extension** for the autonomous cycle. AIR already
    renders it, and it gives a stop control. Semantics stretch: "background" vs foreground.
  - **B. Synthetic `tool_call`** (precedent: legacy "Compact conversation" card,
    `src/context-compaction.ts`):
    - Lifecycle: open `in_progress` at SDK `running` with no prompt; close
      `completed`/`failed` at the autonomous result or `idle`.
    - Folded prompt (#1233) → close at the fold. Process exit → `failed`.
    - Kind `think`/`other`; title from the triggering `task_notification`.
    - Does **not** change AIR's `WaitingForUser` unless AIR treats it as busy.
    - Replay: rebuild from the persisted `<task-notification>`, or skip it.
  - **C. Client heuristic with no server change:**
    - Start: root `tool_call` or message chunk with no prompt.
    - End: `usage_update` with `_claude/origin`.
    - Late start (31.6 s vs 27.1 s in the repro).
    - The end marker is not sent for every outcome (`if (lastAssistantTotalUsage !== null)`).
  - **D. A new extension** mirroring v2 `state_update`.
- My recommendation so far:
  - v2: `state_update` for autonomous cycles.
  - AIR v1: option A, or a `state_update`-like extension.
  - Generic v1 clients: option B as the fallback.
  - The user prefers no new extension; undecided.

## Live repro tooling (`.agents/repro/`)

- `client.mjs` is a minimal ACP client.
  - Spawns `<repo>/dist/index.js` and advertises AIR caps (`nativeSubagentSessions`,
    `asyncTasks`).
  - Auto-allows permissions and keeps listening after the prompt resolves.
  - Logs the raw wire both ways.
  - Args: `<repo> <cwd> <timedLog> <promptFile> <listenAfterMs> <transportOut>`.
  - `transportOut` is the `{"dir":"IN"|"OUT","payload":{...}}` format the user asked for.
  - Example: `npm run build && node .agents/repro/client.mjs $PWD /tmp/acpan/work
    /tmp/run.jsonl .agents/repro/prompt-autonomous-turn.txt 150000
    acp_logs/repro_autonomous_turn_transport.jsonl`.
  - Notes:
    - Uses your local Claude login.
    - `session/set_mode bypassPermissions` fails with "Internal error"; harmless in `auto`.
    - The stock ACP SDK 1.7.0 client rejects AIR extension updates with "Invalid params";
      that is why the raw wire is logged.
- `prompt-subagent-outlives-turn.txt` reproduces: subagent generation 2 running after
  `end_turn`. AIR displays it correctly.
- `prompt-autonomous-turn.txt` reproduces **the reported bug**:
  - `end_turn` at 9.4 s; the background task completes at 27.1 s.
  - Four root tool calls (one 30 s sleep) and a message from 31.6–78.7 s, with no prompt open.
  - The only marker is the `usage_update` with origin `task-notification` at 78.8 s.
  - Side note: the model echoed a `<system-reminder>` into its first reply text.
- `run-*.timed.jsonl` are the timed wire logs of those runs (`WIRE` = agent→client, with `t`
  in seconds and `promptOpen`).
- `sum.py` summarizes an IntelliJ `.acplog`.

## State of the workspace (check before continuing)

**Removed outside this session** (not by me; recreate only if asked):
- `acp_logs/` (the original bundle, `repro_transport.jsonl`,
  `repro_autonomous_turn_transport.jsonl`)
- `.agents/issue.md`
- `src/tests/subagent-outlives-turn-repro.test.ts`: the mock repro via the acp-scenarios
  harness
- the `afterTurns` hook in `src/tests/acp-scenarios/harness.ts`

The lost transport logs can be regenerated with `client.mjs`.

**Unrelated or untouched:**
- `package-lock.json` is modified, not by me.
- `stash@{0}` is an unrelated bundle (`acp-debug-200ea2a5`).

**Content of the removed `.agents/issue.md`, for restoring:**
- Title: "Agent-initiated turns after `end_turn` are invisible to the client's session state".
- Sections:
  - **Summary:** subagents and async tasks are fine; agent-initiated tool calls after the
    turn ended are the problem.
  - **Reproduction:** the autonomous-turn prompt and its timings.
  - **Cause:** v1 has no session state, and the prompt response is final.
  - **Options:** v2 `state_update` is clean; v1 has no clean protocol option (heuristic,
    reuse asyncTasks, synthetic card, new extension).

## Open next steps (offered, not started)

- Restore `.agents/issue.md`, optionally with option B detailed.
- Prototype: v2 `state_update` for autonomous cycles in `src/v2/prompt.ts` / turn events,
  and/or v1 option A or B behind capability checks.
- Acceptance test: the acp-scenarios lifecycle plus the live `prompt-autonomous-turn.txt`
  run.
- Report client bugs:
  - AIR drops the `stopped` → `completed` correction.
  - AIR derives busy only from an open prompt.

## User preferences seen

- Wants claims verified against code, logs, or schema, and asks pointed follow-ups.
- Wants live repros against the real agent, not only mocks.
- Prefers no new extensions if possible.
- Wants raw transport logs as `{"dir","payload":object}` JSON lines under `acp_logs/`.
