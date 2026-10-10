# Native session controls

These optional ACP v1 and experimental v2 extensions operate on an existing live
session. Discover them in initialize's top-level `_meta.sessionRewind`,
`_meta.sessionRewindFiles`, `_meta.runtime`, and `_meta.sessionMcp`.
They do not implement the whole Claude Desktop UI or cloud chat service.

本提案在一个分支中整合对话回退、文件 checkpoint、运行状态/刷新、MCP 替换、
单条排队消息撤回与 summary/full 上下文诊断；`test:native` 统一运行全部十项原生用例。

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
(summary by default, explicit `detail: "full"` for native category counts),
`usage` (skip behaviors), `mcp`, `commands`, `agents`, and `queuedMessages`.
Full context may use the provider token-count API; other resources reject detail. It uses the
current query without starting a prompt. Reads have a five-second deadline and
reject stale query results. MCP launch configuration, headers, environment and
raw diagnostic errors are omitted.

`_session/runtime/control` accepts `{sessionId,action,...}`:

| Action              | Additional fields                                |
| ------------------- | ------------------------------------------------ |
| reloadSkills        | none                                             |
| reloadPlugins       | holdOnCacheImpact, optional boolean default true |
| reloadOutputStyles  | none                                             |
| reconnectMcp        | serverName                                       |
| toggleMcp           | serverName, enabled                              |
| backgroundTask      | toolUseId (one explicit tool)                    |
| cancelQueuedMessage | messageId (one pending adapter prompt)           |

Controls are mutually exclusive with session lifecycle changes. Except for
`backgroundTask` and pending-only `cancelQueuedMessage`, busy sessions are refused.
Queue inventory/context reads and single cancellation remain available while a provider
change waits for accepted turns. See [queue and context contracts](queued-message-context-controls.md). Skills/plugins refresh the adapter's
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

## Regression test entry points

Use Node.js 24 on Windows or Linux, with the SDK's platform optional dependency
installed (`npm ci --include=optional`). No account, API credentials or model
service is needed. From the repository root:

```sh
npm run test:native:compat
npm run test:native
npm run test:native:rewind
```

`test:native` builds this checkout and runs `scripts/native/e2e.mjs`. Each case
creates a fresh temporary home, Claude config and workspace, launches the real
pinned SDK/native CLI, and points it at a loopback Anthropic streaming fixture.
The child environment is allowlisted; inherited tokens, provider overrides and
user settings are excluded. A dummy key is only sent to loopback, and outbound
proxy requests are refused locally. Native nonessential traffic is disabled.
The MCP fixtures are local Node processes. Temporary files and owned processes
are cleaned up on completion or failure; cleanup failures fail the run too.
This is an offline protocol regression, not a model-quality or network-sandbox test.

The suite asserts:

- Three actual prompts before first, historical and latest same-ID rewind;
  invalid guards fail; no provider call during rewind or process restart;
  replay and the subsequent resend contain exactly the retained authored turns.
- Native Read/Edit tool results, checkpoint preview without writes, actual
  restore, preservation of unrelated files and conversation history.
- Runtime read/reload response shapes without new prompts or chat changes.
- MCP replacement, protected servers, revision fencing, connected status after
  recreation, and close during a genuinely pending MCP handshake. Interrupted
  replacement must fail and its MCP process must exit before recovery succeeds.
- Native pending-message cancellation preserves the foreground and a queued survivor;
  context summary avoids counting while explicit full reaches the loopback count endpoint.
- A separate worker exercises `cancelAsyncMessage`, the real private `Query.request` envelope and
  `transport.waitForExit` plus actual exit state. SDK shape drift, unsupported
  controls, timeouts and malformed acknowledgements cannot count as success.

`test:native:compat` runs focused Vitest regressions for unknown acknowledgements,
wrong targets, missing exit evidence and lifecycle fences. The independent CI
`native` job runs this and the complete native suite on Node 24, on Ubuntu and
Windows; it does not depend on the existing upstream build job.

For focused rewind checks, `test:native:rewind` (or, after a build,
`node scripts/native/e2e.mjs --rewind-only`) runs only `first`, `historical`,
`latest` and `sdk-contract`. The shared SDK worker also verifies queued cancellation; the other three cases
exercise rewind. The default `test:native` runs all ten cases in this integrated checkout. Individual cases can also be selected:

```sh
node scripts/native/e2e.mjs historical files
node scripts/native/e2e.mjs --rewind-only sdk-contract
```

Every failed assertion, unknown case, process failure or cleanup failure exits
nonzero. Success prints one `PASS` per completed case. No old transcript fixture
is seeded and no transcript is rewritten by the harness. SDK upgrades must pass
both the compatibility regressions and the real native contract again.
To check the runner's failure path, run
`node scripts/native/e2e.mjs --rewind-only first --inject-wrong-reply`.
This deliberately corrupts the local provider reply and must exit 1.

## Upstream compatibility

This refresh targets upstream main `4e1fc1e` (adapter 0.89.1, ACP SDK 1.8.0).
Claude Agent SDK remains pinned to 0.3.293. It preserves custom instructions,
event-loop yielding, v2 commands in setup responses, the v2 `error` stop reason,
and `cancelled` status for interrupted tool calls.

Unsupported archive requests are rejected before cancelling native work or waiting
for its reservation. They leave the active control and live prompts unchanged.
Session index operations share the native-control reservation. Rename and
unarchive wait for an in-flight control; archive and delete cancel it and wait
for shutdown. All four reject an unconfirmed native exit before changing storage.
Close remains idempotent. The upstream deletion policy is unchanged: an AIR
client that negotiated `sessionIndex` permanently deletes; an AIR client without
that capability archives on `session/delete`; other clients use SDK deletion.

本次基于上游 `4e1fc1e`（适配器 0.89.1、ACP SDK 1.8.0），Claude Agent SDK
仍锁定 0.3.293。保留上游自定义指令、事件循环让步、v2 setup commands、正式
error 停止原因与工具 cancelled 状态。索引改名/归档/取消归档/删除共享原生
控制互斥锁，退出未确认时禁止修改存储。未协商 index 的 archive 请求先返回
method-not-found，不取消已有控制或影响仍在运行的消息。已协商 sessionIndex 的 AIR 客户端
执行永久删除；未协商的 AIR 客户端在 session/delete 时归档；其它客户端
继续使用 SDK 删除。close 保持幂等。

## Attribution

The compatible beforeMessage/resumeAtMessage contract and the original session
reservation design build on Nikita Ashikhmin's PR1126, head
`95efec238d4388569266afba06ee70720e0d646b`:
https://github.com/agentclientprotocol/claude-agent-acp/pull/1126.
The implementation uses native same-ID rewind instead of that PR's session
recreation approach. This refresh targets upstream main `4e1fc1e` (0.89.1)
with ACP SDK 1.8.0 and Claude Agent SDK 0.3.293.
