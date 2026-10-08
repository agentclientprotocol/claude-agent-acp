# Session rewind extension

The optional ACP v1 and experimental v2 extension operates on an existing live
session. Discover it in initialize's top-level `_meta.sessionRewind` or AIR's
`sessionRewind` capability.

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

## Mutation lifetime and limits

Rewind holds a lifecycle reservation shared with prompt admission, close, delete,
load, resume, dispose and provider recreation. A 15-second adapter deadline, request cancellation or explicit
close/dispose initiates native shutdown. The adapter waits for the pinned local
transport's exit observer (up to ten seconds); SDK asyncDispose alone is not proof
of subprocess exit. Missing/invalid/unconfirmed exit evidence leaves a recovery
fence. Same-ID recreation and further mutations on that connection are rejected;
reconnect the ACP adapter after resolving the native process. Late replies cannot
publish success after invalidation. A timeout
reports an uncertain outcome, never that the mutation was undone.

Deferred/unavailable: undoRewind, switchRewindMark, Desktop rewind-marker UI,
cloud Chat editing, arbitrary settings mutation, remote transport exit guarantees,
and coordinated conversation/file restoration. Transport-specific shutdown
guarantees depend on the pinned native SDK.

## Regression test entry points

Use Node.js 24 on Windows or Linux with the pinned SDK platform optional dependency
installed. No account, real API credentials, or model service is needed.

```sh
npm run test:native:compat
npm run test:native:rewind
```

The native command builds this checkout and runs only `first`, `historical`,
`latest` and `sdk-contract`. The runner contains no file restore, runtime or MCP
replacement scenarios. It starts the real pinned SDK/native CLI with a loopback
streaming provider and an allowlisted child environment. Temporary homes, Claude
config, workspaces and child temporary files stay under this checkout's ignored
`node_modules/.native-rewind` directory. User settings and inherited credentials
are excluded; only a dummy key is sent to loopback. Nonessential native traffic
is disabled and proxy requests to other destinations are refused locally.

The three rewind cases verify three real prompts, invalid target guards, the
same session ID, restart before resend, retained user/assistant replay and the
exact authored context of the next prompt. The SDK contract worker checks the
private `Query.request` response envelope and `transport.waitForExit` against an
actual native process exit. These are offline protocol tests, not model-quality
or network-sandbox tests. The CI native job runs compatibility regressions and
all four native cases on Ubuntu and Windows independently of the existing job.

Every failed assertion, unknown case, process failure or cleanup failure exits
nonzero. Only completed cases print `PASS`. Individual core cases may be selected
after building, for example `node scripts/native/e2e.mjs --rewind-only historical`.
The failure-path check
`node scripts/native/e2e.mjs --rewind-only first --inject-wrong-reply` must exit 1.
The harness does not seed or rewrite transcript fixtures. SDK upgrades must rerun
both compatibility regressions and the real native contract.

## Attribution

The compatible beforeMessage/resumeAtMessage contract and the original session
reservation design build on Nikita Ashikhmin's PR1126, head
`95efec238d4388569266afba06ee70720e0d646b`:
https://github.com/agentclientprotocol/claude-agent-acp/pull/1126.
The implementation uses native same-ID rewind instead of that PR's session
recreation approach and is based on upstream main `966be7a` (0.88.0).
