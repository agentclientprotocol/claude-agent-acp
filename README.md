# ACP adapter for the Claude Agent SDK

[![npm](https://img.shields.io/npm/v/%40agentclientprotocol%2Fclaude-agent-acp)](https://www.npmjs.com/package/@agentclientprotocol/claude-agent-acp)

Use [Claude Agent SDK](https://platform.claude.com/docs/en/agent-sdk/overview#branding-guidelines) from [ACP-compatible](https://agentclientprotocol.com) clients!

This tool implements an ACP agent by using the official [Claude Agent SDK](https://platform.claude.com/docs/en/agent-sdk/overview), supporting:

- Context @-mentions
- Images
- Tool calls (with permission requests)
- Compact file changes through the negotiated [AIR diff patch extension](docs/air-extensions.md#diff-patch)
- Following
- Edit review
- TODO lists
- Nested subagent transcripts
- Interactive (and background) terminals
- Custom [Slash commands](https://docs.anthropic.com/en/docs/claude-code/slash-commands)
- Client MCP servers
- `/mcp` in the chat: the MCP server status as a list. The adapter runs `/mcp reconnect`, `/mcp enable`, and `/mcp disable` through the SDK control API, because Claude Code refuses them in SDK mode. A reconnect of an ACP server that needs authentication starts MCP OAuth through URL elicitation
- Session-scoped long-running goals for AIR through the [goal extension](docs/air-extensions.md#goal) under `_meta.jetbrains.air.goal`
- Structured errors, recovery, and warnings through the opt-in [session failure extension](docs/air-extensions.md#session-failure)
- Concrete model and effort defaults through the opt-in [recommended config value extension](docs/air-extensions.md#recommended-config-values)
- Tool permission presentation, editable choices, and durable effects through the [permission extension](docs/air-extensions.md#permission-presentation)
- One fact per field in every tool call report, as the [ACP tool call contract](docs/air-extensions.md#tool-call-contract) defines
- All AIR extensions, capabilities, and `_meta` keys: [AIR extensions](docs/air-extensions.md)

Learn more about the [Agent Client Protocol](https://agentclientprotocol.com/).

To try changes that have landed on `main` but are not released yet, install from the
`preview` channel — every push to `main` publishes one. See
[`docs/RELEASES.md`](docs/RELEASES.md#preview-releases).

```sh
npm install @agentclientprotocol/claude-agent-acp@preview
```

### Subagent sessions

A client that declares `clientCapabilities.subagents`, other than JetBrains AIR, gets each Agent or
Task subagent as its own child session, following the [subagents RFD](https://github.com/agentclientprotocol/agent-client-protocol/blob/main/docs/rfds/subagents.mdx):

- `subagent_update` on the parent announces the child before any of its traffic, with the
  parent's `title` and `description` for it, and reports its work state: `running`,
  `requires_action` while one of its requests is open (and `running` again when the last one ends,
  unless a cancel withdrew it: the child is stopping then), and `idle` when its work ends, with
  `end_turn` or `cancelled` when the SDK gives the reason. A failure is `idle` with the `error`
  stop reason and the SDK's error text as its `error`. The child keeps its session for every
  delegation to it.
- The prompt of the Agent or Task call that launches the child, and the message of each
  SendMessage call that resumes it, is a `session_message` in the child's transcript. The tool
  call stays a tool call of the session that made it.
- `session/cancel` on the parent interrupts Claude Code, which stops the foreground children that
  the turn waits on and, currently, background children too. Each stopped child reports `idle`
  with `cancelled` from Claude Code's own events, and the open requests of the foreground ones are
  withdrawn. The adapter ends no child at a cancel itself, so a child that keeps running keeps its
  open requests and its open tool calls. A tool call of a stopped child that Claude Code reports no
  result for, such as the command it was running, ends in the child's session before the cancelled
  prompt resolves. When Claude Code stops a background child after that, or while no prompt runs,
  the tool call ends right after the child reports `idle`. A child that still runs when Claude Code
  exits is `idle` with no stop reason.
- A child whose parent is not yet known when it ends is not exposed, since the RFD forbids
  guessing its parent.
- A replay restores each child under its live session id, from its own transcript: its prompt and
  each SendMessage message are `session_message`s, and its end is an `idle` before the response.
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
  runs, gets no capabilities. A client cannot prompt or otherwise change a child.

An [ACP v2](#experimental-acp-v2) client gets the same without declaring anything, since subagents
are part of v2's baseline. Each child also reports its work state as its own `state_update`, right
after the parent's copy.

JetBrains AIR keeps the earlier draft of the RFD (`subagent_spawned`, `subagent_state_update`),
which it enables with `nativeSubagentSessions` in `_meta.jetbrains.air.capabilities`. See
[AIR extensions](docs/air-extensions.md#native-subagent-sessions).

Without either signal, Agent and Task stay ordinary tool calls and child interactions stay on the
root session. Clients that use the historical `_meta["subagent-transcript"]` capability or the
`forwardSubagentText` session option retain the flattened child transcript.

### Experimental ACP v2

Started with `CLAUDE_AGENT_ACP_EXPERIMENTAL_V2=1`, the adapter also serves the
[draft ACP v2](https://agentclientprotocol.com/protocol/v2/overview): a client that asks for
protocol version 2 or later in `initialize` gets v2, and every other client gets v1, as before.
The draft can still change, and this surface changes with it.

On v2 the adapter serves the session baseline (`session/new`, `session/list`, `session/resume`
with replay, `session/close`, `session/prompt`, `session/cancel`), `session/delete`,
`session/fork`, additional directories, config options (the mode is one), plans, notices,
compaction, display terminals for commands, permission requests, elicitation, providers, auth, and
[subagents](#subagent-sessions). Steering and the AIR extensions are v1 only for now.

## Contribution Policy

This project does not require a Contributor License Agreement (CLA). Instead, contributions are accepted under the following terms:

> By contributing to this project, you agree that your contributions will be licensed under the [Apache License, Version 2.0](https://www.apache.org/licenses/LICENSE-2.0). You affirm that you have the legal right to submit your work, that you are not including code you do not have rights to, and that you understand contributions are made without requiring a Contributor License Agreement (CLA).
