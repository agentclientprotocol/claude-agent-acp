# Subagent sessions

A client that declares `clientCapabilities.subagents`, other than JetBrains AIR, gets each Agent or
Task subagent as its own child session, following the [subagents RFD](https://github.com/agentclientprotocol/agent-client-protocol/blob/main/docs/rfds/subagents.mdx):

- `subagent_update` on the parent announces the child before any of its traffic, with the
  parent's `title` and `description` for it, and reports its work state: `running`,
  `requires_action` while one of its requests is open (and `running` again when the last one ends,
  unless a cancel withdrew it: the child is stopping then), and `idle` when its work ends, with
  `end_turn` or `cancelled` when the SDK gives the reason. A failure is `idle` with the `error`
  stop reason and the SDK's error text as its `error`. The child keeps its session for every
  delegation to it.
- A child that still works when Claude Code starts a fresh conversation, such as for `/clear`, is
  `unknown`, and loses its `cancel` capability. Claude Code can keep such a child running, but the
  adapter forgets the children of the old conversation, so it reports nothing more for it and
  cannot stop it. Its unfinished tool calls keep their status. An idle child keeps its state.
- A child that runs outside its parent's working directory, such as an Agent call with
  `isolation: "worktree"`, gets its `cwd` on `subagent_update` before its first tool call. The
  adapter takes it from the `cwd` of the child's own hooks: its SubagentStart hook runs before its
  first model request. It sends `cwd: null` when the child is back in its parent's directory. A
  child in its parent's directory gets no `cwd`, and no child gets `additionalDirectories`: Claude
  Code gives a subagent the session's additional directories, so it inherits them. A replay
  announces a child with the `cwd` that its transcript recorded, and clears it with the child's
  current state (see below) when that directory no longer exists.
- Session messages replace the Agent or Task call that launches the child, which its parent is
  not shown:
  - The launch's prompt is a `session_message` in both transcripts: the parent's outgoing view and
    the child's incoming one. Both use the launch's tool use id, and each names the other with the
    RFD's `recipientMessageId` and `senderMessageId`.
  - A foreground child's answer, from the launch's result, is the child's `session_message` to
    the parent. In Claude Code's hand-back mode, the child's `SubagentHandback` call is its
    message to the parent instead, in both transcripts and linked the same way.
  - A launch whose child is never exposed is shown as a tool call after all, with its final
    status.
- On v1, the parent's prompt turn ends at its result, also while a background child that it
  launched or resumed still runs. The child's updates and requests follow the prompt response: the
  RFD has a client keep receiving child events after it. The parent's summary when the child ends
  comes from a followup cycle out of a turn. Its result ends no turn, and a plan approval it asks
  for has no clear-context option.
- A SendMessage call that resumes the child is not shown either. Its message is a
  `session_message` in both transcripts, the sender's outgoing view and the child's incoming one,
  linked like a launch's prompt. A SendMessage call whose message resumes no announced child,
  such as one to the parent, is shown as a tool call, with its final status.
- Every message is one whole `session_message`. The adapter sends no `session_message_chunk`: it
  has each message's full text before it reports it, from the input or the result of the tool call
  that sent it.
- A tool call that the client is shown and that operates on an announced child of another session
  carries the RFD's `session` content, `{ "type": "session", "sessionId": "<child>" }`, after its
  other content: a TaskStop call whose `task_id`, or a SendMessage call whose `to`, is the child's
  agent id; a SendMessage call that resumed the child and stays shown because a permission request
  showed it first; and, on v1, an Agent or Task call that stays shown for the same reason. A
  `tool_call_update` without content carries none, since it would replace the content the client
  holds. A call that names the child by its name gets no reference: Claude Code resolves the
  name, and the adapter cannot tell which agent it picked.
- `session/cancel` on the parent interrupts Claude Code, which stops the foreground children that
  the turn waits on. Background children keep running, as the RFD prefers; a client stops one with
  its own `cancel`. Each stopped child reports `idle` with `cancelled` from Claude Code's own
  events, and its open requests are withdrawn. The adapter ends no child at a cancel itself, so a
  child that keeps running keeps its open requests and its open tool calls. To spare background
  children, the adapter declares the SDK option `perTaskStopAffordance`, which a client can turn
  off in `_meta.claudeCode.options`. That option spares background workflows too, which a client
  cannot stop, so the adapter stops them after the interrupt, as Claude Code did without it.
  Background commands keep running after a cancel either way. A tool call of a stopped child that Claude Code reports no
  result for, such as the command it was running, ends in the child's session before the cancelled
  prompt resolves. When Claude Code stops a background child after that, or while no prompt runs,
  the tool call ends right after the child reports `idle`. A child that still runs when Claude Code
  exits is `idle`, since its work ended with the process: with no stop reason on v1, and on v2
  with the `error` stop reason and the error that ends the root's work.
- A child whose parent is not yet known when it ends is not exposed, since the RFD forbids
  guessing its parent.
- A replay restores each child under its live session id, from its own transcript, with the same
  session messages and `session` references as live, and its end is an `idle` before the response.
  Each replayed child's current state follows the response: on v1, the response is what separates
  a replayed child state from a current one.
  A launch without Claude Code's metadata file for the child stays an ordinary tool call of the
  parent, and a notice, for a client that takes notices, says that subagent history is missing.
- After a load or resume, with or without replay, a SendMessage that resumes an agent from before
  it runs that agent in its session from before. Before the agent's traffic, each of its ancestors
  that the client was not told about in this connection is announced, parent before child and
  with no work state, as the RFD requires. An agent whose launch the session's history does not
  record stays unexposed.
- Each running child is announced with the `cancel` capability. `session/cancel` with the child's
  session id stops that child's current work, through the SDK's `Query.stopTask`, and not its
  parent's: Claude Code also stops the foreground children it waits on, and the parent's turn goes
  on. Each stopped child reports `idle` with `cancelled` from Claude Code's own events, and its
  requests that the stop withdraws report no `running` first. A replayed child, which no longer
  runs, gets no capabilities. A client cannot prompt or otherwise change a child: any other request
  that names an announced child of a running session fails with `-32602` (Invalid params),
  `session/close` and `session/delete` too.

An [ACP v2](../README.md#experimental-acp-v2) client gets the same without declaring anything, since subagents
are part of v2's baseline. Each child also reports its work state as its own `state_update`, right
after the parent's copy. A replay ends each child's history with a `replay_complete` on the child's
session. On v2, the parent's `replay_complete` is what separates a replayed child state from a
current one, so each replayed child's current state follows the root session's `replay_complete`
and comes before the response: on its parent, with the cleared `cwd`, and then as the child's own
`idle`. The notice that subagent history is missing follows the root's `replay_complete` too.

JetBrains AIR keeps the earlier draft of the RFD (`subagent_spawned`, `subagent_state_update`),
which it enables with `nativeSubagentSessions` in `_meta.jetbrains.air.capabilities`. See
[AIR extensions](air-extensions.md#native-subagent-sessions).

Without either signal, Agent and Task stay ordinary tool calls and child interactions stay on the
root session. Clients that use the historical `_meta["subagent-transcript"]` capability or the
`forwardSubagentText` session option retain the flattened child transcript.
