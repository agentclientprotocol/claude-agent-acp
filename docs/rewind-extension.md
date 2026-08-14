# Rewind extension

This document defines an experimental ACP extension implemented by `claude-agent-acp`. It gives clients the Claude Code CLI's `/rewind`: returning a session to an earlier user message by restoring the working tree, the conversation, or both.

Only files and transcript move. The ACP session id is unchanged, so clients keep their handle.

## Capability discovery

An agent advertises support in its `initialize` response:

```json
{
  "_meta": {
    "claudeCode": {
      "rewindSession": { "modes": ["files", "conversation", "both"] }
    }
  }
}
```

Presence of `rewindSession` means both methods below are served. `modes` is the accepted `mode` set, so a client can offer only what the agent implements rather than probing. Clients that do not see the key should not call the methods.

The key is `rewindSession` rather than `rewind` because [#872](https://github.com/agentclientprotocol/claude-agent-acp/pull/872) proposes `_meta.claudeCode.rewind` for fork-at-a-message, which is a different operation: it mints a new session and leaves the original intact, where a rewind mutates the original in place. The two can be advertised together without ambiguity.

## Listing rewind points

`_session/rewind_points` returns the user messages a session can be rewound to, oldest first.

```json
{
  "points": [
    {
      "messageId": "0b6f…",
      "resumeAtMessageId": null,
      "text": "Add a health check endpoint",
      "index": 1
    },
    {
      "messageId": "9c21…",
      "resumeAtMessageId": "4af0…",
      "text": "Now cache the result",
      "index": 2
    }
  ]
}
```

The two ids are not interchangeable, because the two halves of a rewind anchor at different messages:

- `messageId` identifies the user turn itself and is what a file rewind keys on. It is the same id the message chunks for that turn carried, so clients can match it against what they rendered.
- `resumeAtMessageId` is the assistant message immediately **before** that turn, which is what a conversation rewind keys on. It is `null` for a session's first prompt, which has nothing before it to resume at; requesting a conversation rewind of that turn is refused.

Points are read from the session transcript rather than from in-process state, so turns from before a resume are listed too. Only top-level user messages appear: subagent turns, tool results and synthetic `<...>` envelopes are omitted.

Clients that retained the `messageId` on the chunks they rendered can skip this call and go straight to `_session/rewind`.

## Rewinding

`_session/rewind` takes the `messageId` of the turn to rewind to.

```json
{
  "sessionId": "5f0c…",
  "messageId": "9c21…",
  "mode": "both",
  "dryRun": true
}
```

`mode` is `files` (the default), `conversation`, or `both`. `dryRun` previews without applying.

```json
{
  "files": {
    "canRewind": true,
    "filesChanged": ["/repo/src/server.ts"],
    "insertions": 12,
    "deletions": 3
  },
  "conversation": { "rewound": false, "messagesDropped": 4 }
}
```

Each half is present only when the requested mode asked for it. On a `dryRun` the conversation half reports `rewound: false` and `messagesDropped` is what _would_ be dropped.

## Semantics

The two modes are different mechanisms, not one operation with a flag.

`files` restores tracked files from the checkpoints taken before each edit. The conversation is untouched, so the agent still has the edits in context and believes they are on disk.

`conversation` truncates the transcript at `resumeAtMessageId`, inclusive. The dropped turns leave both the transcript and the model's context permanently. This is what distinguishes a rewind from `session/fork`, which branches the conversation and leaves the original intact.

`both` is the pair, and the only mode that leaves the tree and the agent's memory agreeing. The other two deliberately desynchronize them, which is occasionally what you want and otherwise a hazard worth surfacing in the client's confirmation.

Ordering and refusals:

- The file half runs first. A conversation rewind replaces the backend query that the file half operates on.
- A refused file rewind in `both` mode skips the conversation half, rather than leaving the agent with no memory of edits still on disk.
- A rewind is refused while a turn is in flight. Cancel first.

## Checkpointing

File rewind depends on the Claude Agent SDK's file checkpointing, which this agent enables by default. Snapshotting costs disk and I/O on every edit, so a client that offers no rewind can turn it off when creating the session:

```json
{
  "_meta": {
    "claudeCode": { "options": { "enableFileCheckpointing": false } }
  }
}
```

With checkpointing off, `_session/rewind` reports `canRewind: false` for the `files` half; the `conversation` half is unaffected.

## When a conversation rewind becomes durable

A conversation rewind takes effect immediately for the agent: the dropped turns are out of its context from the moment `_session/rewind` returns. It reaches the transcript on disk only when the next turn is written.

That leaves a window with a sharp edge. Between the rewind and the next `session/prompt`:

- `_session/rewind_points` and `session/load` still read the untruncated transcript from disk, so both still show the dropped turns.
- Anything that restarts the agent process and resumes the session, rather than continuing the live one, reloads that untruncated transcript and **silently undoes the rewind**.

Clients must therefore not tear down and resume a session to refresh their view of a rewind. Send the next prompt first; after that the truncation is on disk and a later reload replays the rewound history correctly.

## Client responsibilities

After a conversation rewind the client is still displaying turns that no longer exist, and ACP has no "history changed" notification. Given the window above, the safe handling is to leave the rendered history in place and tell the user those turns are no longer in the agent's context, rather than re-rendering from `session/load`.

After a file rewind, buffers or editors holding the changed files are stale and should be reloaded. `filesChanged` on the `dryRun` response lists them; the applied response reports `skippedLinks`, a count of tracked files left alone because a symlink, hard link or other non-regular file was found at the tracked path.
