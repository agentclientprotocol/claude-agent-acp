# Native session controls

These optional ACP v1 and experimental v2 extensions operate on an existing live
session. Discover them in initialize's top-level `_meta.sessionRewind`,
`_meta.sessionRewindFiles`, `_meta.runtime`, and `_meta.sessionMcp`.
They do not implement the whole Claude Desktop UI or cloud chat service.

## Conversation rewind

`_session/rewind` accepts:

```json
{
  "sessionId": "existing-session-id",
  "beforeMessage": {
    "messageId": "user-message-id",
    "messageFingerprint": "sha256:64-lowercase-hex-digits",
    "messageOccurrence": 1
  },
  "resumeAtMessage": {
    "messageId": "preceding-assistant-message-id",
    "messageFingerprint": "sha256:64-lowercase-hex-digits",
    "messageOccurrence": 1
  },
  "interruptIfRunning": false
}
```

The CLI discards the target user prompt and its entire following branch while
retaining the session ID. No replacement prompt is sent, and no file is restored.
A native explicit history anchor is persisted before success; a subsequent
process can resume it before any new prompt has been submitted. The adapter reads
that anchor when the SDK history helper would otherwise replay the old branch.
Transcript writes belong exclusively to Claude Code.

`beforeMessage` must identify a human-authored user message. `resumeAtMessage` is
required for a non-first prompt and is validated against the preceding authored
turn; it is a client guard, not the native truncation boundary. Omit it for the
first prompt. A fingerprint is SHA-256 of UTF-8 concatenated text blocks, without
normalization. Exact IDs must also match the hash. If an ID disappeared, fallback
requires a unique, nonempty, text-only match. Repeated/empty/multimodal fallback is
refused. `messageOccurrence` remains accepted for PR1126 compatibility but cannot
make an ambiguous fallback safe. Split assistant messages whose supplied hash
cannot be matched are refused rather than guessed.

Success is `{ "rewound": true, "sessionId": "same-id" }`. A native refusal or
busy/unsupported state returns `rewound:false` and a `reason`. Invalid guards
return JSON-RPC invalid params. A lost/invalid ACK closes the query and returns an
error; reload is required. Active or queued turns are refused by default. Explicit
`interruptIfRunning:true` first validates the target, cancels the turns, waits for
settlement, and sends the most recently observed user UUID as the native stale
history guard. Live background tasks are refused.

The small native bridge uses SDK 0.3.293's private `Query.request` transport for
`rewind_conversation`. No typed public conversation rewind exists in this pinned
SDK. Runtime support is checked per query; no fork, `resumeDropsTurn`, transcript
rewrite, or new-session fallback is attempted. This private transport dependency
must be revalidated when upgrading the SDK.

## Independent file checkpoint restore

`_session/rewind_files` accepts `{sessionId,beforeMessage,dryRun}`. `dryRun` is a
required boolean. It resolves the same user target and calls native
`Query.rewindFiles(uuid,{dryRun})`. The response includes `sessionId`, `dryRun`,
`canRewind`, and the SDK's paths/counts/skippedLinks when provided. It does not
rewind conversation history. Native checkpoints must have been enabled and must
exist for the target; this extension does not manufacture backups. Enable SDK
`enableFileCheckpointing` at session creation if the client needs restoration.
Restoration can overwrite edits to checkpointed files: the client should show a
fresh preview and obtain its user's intended restore choice. There is no atomic
transaction combining conversation and file rewinds.

## Structured runtime access

`_session/runtime/read` accepts `{sessionId,resource}`. Resources are `context`
(summary), `usage` (skip behaviors), `mcp`, `commands`, and `agents`. It uses the
current query without starting a prompt. Reads have a five-second deadline and
reject stale query results. MCP launch configuration, headers, environment and
raw diagnostic errors are omitted.

`_session/runtime/control` accepts `{sessionId,action,...}`:

| Action             | Additional fields                                |
| ------------------ | ------------------------------------------------ |
| reloadSkills       | none                                             |
| reloadPlugins      | holdOnCacheImpact, optional boolean default true |
| reloadOutputStyles | none                                             |
| reconnectMcp       | serverName                                       |
| toggleMcp          | serverName, enabled                              |
| backgroundTask     | toolUseId (one explicit tool)                    |

Controls are mutually exclusive with session lifecycle changes. Except for
`backgroundTask`, busy sessions are refused. Skills/plugins refresh the adapter's
available commands and agent config options. A currently selected removed agent
is retained until the client changes it. Responses use version 1 and status
`ok` with data or `unavailable` with a reason. Unsupported Query methods are
reported rather than emulated through user prompts.

## Replace host MCP servers

`_session/mcp/state {sessionId}` returns a revision, uncertain flag and host
server names/types, without credentials. `_session/mcp/set` accepts
`{sessionId,expectedRevision,mcpServers}` where mcpServers is the ordinary ACP
stdio/http/sse array (not SDK in-process objects or the ACP MCP transport).

It replaces only the ACP host set through `Query.setMcpServers`. The actual
non-ACP Query option configuration is preserved. Existing main behavior permits
ACP creation parameters to override an option server with the same name; such
names belong to the host set. Settings/plugin-owned or other unowned live names
cannot be taken over. Native status `source` alone does not determine ownership:
a host server may be labelled sdk or dynamic. Revisions start at zero per new
ACP connection/session, advance on an acknowledged set (including partial), and
advance when that same ID's query is recreated. Clients must read state again
when reconnecting to ACP; revisions are not durable database versions.

A native result with per-server errors returns `status:partial`, revision,
added/removed and failed server names. The requested host configuration is kept
for recreation; partial does not claim all native connections succeeded. Raw
errors are redacted. A lost ACK makes the state uncertain and closes the query;
no blind retry occurs. The current creation params and fingerprint are updated
only after acknowledged ok/partial results.

## Mutation lifetime and limits

Rewind, file restore, runtime controls and MCP replacement share lifecycle
reservations. A 15-second adapter deadline, request cancellation or explicit
close/dispose initiates native shutdown. The adapter waits for the pinned local
transport's exit observer (up to ten seconds); SDK asyncDispose alone is not proof
of subprocess exit. Missing/invalid/unconfirmed exit evidence leaves a recovery
fence. Same-ID recreation and further mutations on that connection are rejected;
reconnect the ACP adapter after resolving the native process. Late replies cannot
publish refreshed caches or commit MCP configuration after invalidation. A timeout
reports an uncertain outcome, never that the mutation was undone.

Deferred/unavailable: undoRewind, switchRewindMark, Desktop rewind-marker UI,
cloud Chat editing, arbitrary settings mutation, remote transport exit guarantees,
and automatic coordinated conversation+file restoration. Runtime background,
MCP OAuth and transport-specific failure behavior depend on the native SDK.

## Attribution

The compatible beforeMessage/resumeAtMessage contract and the original session
reservation design build on Nikita Ashikhmin's PR1126, head
`95efec238d4388569266afba06ee70720e0d646b`:
https://github.com/agentclientprotocol/claude-agent-acp/pull/1126.
The implementation uses native same-ID rewind instead of that PR's session
recreation approach and is based on upstream main `966be7a` (0.88.0).
