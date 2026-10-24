# Background work RFD experiment

This branch prototypes [RFD 2452](https://github.com/agentclientprotocol/agent-client-protocol/pull/2452)
at revision `33c473ba0723a0f6ffcfcbb54fd780c05df7b208`. It is an opt-in local
experiment, not a released protocol implementation.

Build with `npm ci --ignore-scripts` and `npm run build`. Launch with
`ACP_BACKGROUND_WORK_EXPERIMENT=1 node dist/index.js`. Omit the environment
variable to restore normal behavior. No package publication is needed.

The message-stream bridge works on ACP v1 and v2. It reuses the installed
native asynchronous-task adapter and its private negotiation internally. Known
background shells keep the existing tool call `in_progress`; state snapshots
reference that tool. `tool_call/cancel` is translated to the existing native
task stop request. A successful response is acceptance only. A native terminal
event finalizes the tool. ACP v1 represents cancellation as `failed` because its
tool status enum has no `cancelled`; ACP v2 uses `cancelled`.

Native replace-semantics task levels establish whether the list is complete.
Before a native level arrives, after a malformed level, or while any native task
cannot be mapped to an announced tool, `background` is `null`. This includes
unmapped monitors, scheduled tasks and subagents. The prototype does not claim
their full RFD support. Forks start with `background: []`. Reconnects remain
unreported until native current state and referenced entities are available.

This bridge does not upgrade the SDK schema. A client must accept the draft
fields and raw `tool_call/cancel`, and must treat repeated `idle` snapshots
without a stop reason as list changes rather than new completions. The private
negotiation can also select the adapter's existing client-specific tool rendering;
this is a bounded experiment, not general client capability negotiation.

Suggested manual evaluation: start a bounded background shell, finish the
foreground turn, cancel one shell, and separately allow a shell to finish while
idle. Verify that the tool remains in progress and listed until native evidence
ends it. Send foreground `session/cancel` while background work is listed, then
close the session. Reconnect and fork must not invent live tools from history.
Exercise pending permissions separately; deterministic protocol tests are not
evidence of live native permission or session-close behavior.

A tool already reported final before native background discovery is never revived.
That task remains unreported by this bridge. Native subagents also remain unreported
while associated, including an idle child whose own background state is unknown.

Codex list disappearance proves the process ended but supplies no exit outcome.
The existing native adapter reports this as stopped, represented here as cancelled
(v2) or failed (v1); only an explicit native command completion supplies a reliable
completed/failed outcome. This is a known limit of the experiment.
