# The native ACP v2 core

Status: experimental, opt-in with `CLAUDE_AGENT_ACP_V2_CORE=native`. The default v2 core is
still the bridge.

## Why

The adapter serves ACP v2 through a bridge today: `src/v2/` converts each v2 request to v1, runs
it through `ClaudeAcpAgent`, and converts what comes back. So every v2 session runs the v1 core,
including the machinery that exists only because of v1:

- **Held prompts.** A v1 `session/prompt` answers when the turn ends, so the core keeps a turn
  queue and settles each turn itself. That needs echo matching, a per-uuid orphan account for
  prompts a cancel settled after they were pushed, owed-trailing-idle debt (turns settle at the
  `result`, and Claude Code's `idle` lags behind it), the steer lane, `cancelledThrough`, and the
  hold for background subagents (`deferredSettle`).
- **AIR branches.** The JetBrains AIR extensions are gated on `air.client` throughout the core.

The v1-only part is about 2,000 lines inline in `acp-agent.ts`, and it all runs on v2 too. For
example, `deferredSettle` holds a v2 turn open and `v2/prompt.ts` ignores the result.

ACP v2 describes a session the way Claude Code already does. A prompt is inserted into a queue
and answered at insertion, and the session reports whether it is working. Claude Code reports
both, so a v2 core can follow Claude Code's own events instead of rebuilding a turn model.

## How it maps

| ACP v2                             | Claude Code                                                                       |
| ---------------------------------- | --------------------------------------------------------------------------------- |
| `session/prompt` answers           | `command_lifecycle` `started` for the prompt's uuid, or the prompt's echo         |
| `session/prompt` fails             | `command_lifecycle` `cancelled` (-32800), `discarded` or `refused` (-32603)       |
| `state_update` `running`           | a turn starts: a prompt's `started`, or the turn's `system/init`                  |
| `state_update` `idle`              | the turn's `result`, with its stop reason, usage and error                        |
| `state_update` `requires_action`   | a turn is open and a permission request of the session is open                    |
| `session/cancel`                   | `interrupt({ cancelQueued: true })`, which also ends the queued prompts           |
| `session/resume` with `replayFrom` | `getSessionMessages`, mapped like live output                                     |
| output updates                     | the shared SDK mapping (`toAcpNotifications`), translated by `V2UpdateTranslator` |

The session keeps little of its own: a map of prompts that are not inserted yet, whether a turn
is open, and its count of open permission requests (`src/v2-native/session.ts`).

Claude Code's `session_state_changed` is not the foreground state. It stays `running` while
background subagents work: across the turn's `result`, the next prompts' turns, and the turn
that Claude Code starts on its own when a subagent ends. The bundled CLI shows it (a background
subagent that sleeps 20 seconds):

```text
 0.4  session_state_changed running · command_lifecycle started (P1) · system init
 9.3  result "launched" · command_lifecycle completed (P1)
12.1  command_lifecycle started (P2) · system init
15.3  result "second" · command_lifecycle completed (P2)
33.3  task_notification completed · background_tasks_changed []
33.4  system init
35.9  result · session_state_changed idle
```

So each turn is foreground work from its start to its `result`, as v2 asks ("When foreground
work ends, the Agent MUST report `idle`, even if background activity continues"). An `idle`
without a result, or the `completed` or `cancelled` frame of the turn's prompt, also ends a turn,
such as one that an interrupt stopped before it ran.

## Subagents and background work

`tasks.ts` is written for v2 only, rather than reusing `native-subagents.ts`, which also serves
AIR's draft and restores subagents from history. It follows the subagents RFD, from Claude
Code's task events (with `forwardSubagentText` and `perTaskStopAffordance`):

| ACP v2                                                 | Claude Code                                                                        |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| child session id                                       | the agent id (`task_id`), the same for every delegation to it                      |
| `subagent_update` announcement, on the parent's stream | `task_started` of a `local_agent`; the parent is `parent_task_id`, or the root     |
| the child's traffic                                    | messages whose `parent_tool_use_id` is the Agent call that launched it             |
| incoming `session_message` in the child                | the first user text of each run: the delegation                                    |
| `cwd` of the child                                     | the `SubagentStart` hook's `cwd`, when it is not the parent's (such as a worktree) |
| child `running` / `idle`, mirrored on the parent       | `task_started` (or a `running` patch) to `task_notification`                       |
| child `requires_action`                                | a permission request whose `agentID` is the child                                  |
| `session/cancel` of a child                            | `stopTask(agentId)`                                                                |
| `background` of a session                              | its background subagents, commands (terminals), task tool calls and other tasks    |
| `terminal/cancel`, `tool_call/cancel`                  | `stopTask` of the listed item's task                                               |

A child that its parent waits on (`is_backgrounded: false`) is part of the parent's foreground
work: its requests block the parent too (`requires_action`), and cancelling the parent stops
it. A background child is listed in its parent's `background` while it works, and cancelling
the parent leaves it running. The client can only watch a child and cancel its run: prompt,
close, resume, delete and config changes on it fail with -32602.

## Layout

- `src/v2-native/agent.ts`: the request handlers, session setup, and the SDK `query` options.
- `src/v2-native/session.ts`: one session: its prompts, its state, and the routing of the
  query's messages.
- `src/v2-native/stream.ts`: the SDK output, and replayed history, as v2 updates.
- `src/v2-native/tasks.ts`: Claude Code's tasks: subagents as child sessions, and the
  `background` list of each session (see below).
- `src/v2-native/permissions.ts`: `canUseTool` as v2 permission requests, on the session of the
  agent that asks.
- `src/v2-native/config.ts`: the mode and model config options.
- `src/v2-native/auth.ts`: `_auth/status_update`, gateway `auth/login`, `auth/logout`, and
  `providers/*`, on the v1 core's state rules (`AuthStatusReporter`, `providers.ts`). The
  identity is read after `initialize`, from each session's account, after a login or logout, and
  at the start of each prompt, as on the bridge.

About 2,600 lines in total. The native core shares these with v1 and the bridge:

- the SDK message mapping and tool call rendering (`toAcpNotifications`,
  `streamEventToAcpNotifications`, `tool-calls/*`)
- permission presentation, options and decoding (`permissions/*`)
- the mode catalog (`buildAvailableModes`)
- `promptToClaude`
- the v2 converters (`v2/session.ts`, `v2/permission.ts`, `v2/prompt.ts`)
- the `background` stamping and the `cancel` advertisement of listed items (`V2Background`)
- the background command helpers: `backgroundBashTaskFromToolResult`, `withRunningTerminal`,
  `withRunningToolCall`, `BackgroundOutputTail`

These pieces were extracted so that both cores use the same code:

- `V2UpdateTranslator` and `replayClear` (`v2/update-translator.ts`), taken from the bridge's
  client connection
- `terminalAuthMethods` (`auth-methods.ts`), taken from `ClaudeAcpAgent.initialize`
- `sdkMcpServers` (`mcp-servers.ts`), taken from `ClaudeAcpAgent.createSession`
- `AuthStatusReporter` and `cliLogout` (`auth-status-reporter.ts`): the `authStatus` state, the
  `claude auth status` probe and the `_auth/status_update` pushes, taken from `ClaudeAcpAgent`
- the provider routing (`providers.ts`): `ProviderConfig`, the gateway login methods and their
  validation, the `providers/list` response, `providers/set` validation and model listing, and
  `createEnvForProvider`, taken from `ClaudeAcpAgent`

## How it is checked

- `src/tests/v2-native.test.ts` drives the core with a Claude Code double, message by message:
  insertion, folding, lifecycle failures, cancel, permission states, config, local commands,
  a crashed query, and replay.
- `src/tests/acp-scenarios-v2-native.test.ts` runs every scenario of the shared suite on the
  native core. All 40 send only schema-valid v2. 39 pass. `ask-user-question` stops, because
  the native core sends no form elicitations. `SAME_AS_BRIDGE` lists the scenarios whose session
  updates equal the bridge's golden file, which today is only `session-setup`. The differences
  are listed below.
- The scenario double now sends `session_state_changed` when the query asks for it, as the real
  CLI does. The bridge and v1 scenario golden files did not change.
- A manual run against the bundled Claude Code CLI checked the following:
  - a prompt answers at insertion
  - Bash runs as display terminals
  - a permission request goes `running` → `requires_action` → `running`
  - `session/cancel` fails a queued prompt with -32800 and goes `idle` with `cancelled`
  - the next prompt runs normally

## Intended differences from the bridge

- The turn's `running` comes before the prompt's `user_message`. v2 allows this.
- Output that comes after `session/cancel`, until the turn's `result`, is still sent: the work is
  still stopping. The bridge drops the output of stopped work.
- A text block that an interrupt cut short does not get its tail from the consolidated message.

## Not served yet

- Session methods:
  - `session/fork` (not advertised)
- A gateway login, `providers/set`, `providers/disable` or `auth/logout` routes only the sessions
  started after it. The bridge recreates the queries of live sessions between turns; on the
  native core they keep their route until they are closed and resumed.
- Elicitation (and so `requires_action` for a question):
  - AskUserQuestion (the tool is disallowed)
  - MCP elicitation (the SDK declines)
  - the refusal-fallback dialog
  - MCP OAuth
- Subagents:
  - the child's configuration (`config_option_update` from the `SubagentStart` hook)
  - the incoming view of a SendMessage, which the child's transcript does not show
  - replaying children's history on resume (`getSubagentMessages`)
  - a subagent whose parent Claude Code no longer tracks, such as after a restart, stays
    unexposed: its traffic is the root's
- Reports:
  - `usage_update` (context window, cost)
  - quota `_meta`
  - `session_info_update` (titles)
  - notices (API retries, rate limits, model fallback)
  - compaction updates
  - prompt suggestions
  - task-hook plans (TaskCreate)
- An Edit's patch before it runs (the bridge's PreToolUse preview). The permission request does
  show it.
- Session options:
  - `_meta.claudeCode.options`
  - effort, fast mode, ultracode and agent options
  - the thinking and model env (`MAX_THINKING_TOKENS`, `CLAUDE_MODEL_CONFIG`)
  - the `availableModels` allowlist
  - model preference from settings (the model starts at `default`)
- Resume:
  - the mode and model of the transcript's last turn
  - replaying compactions
  - `replayFrom` other than `start`
- ExitPlanMode's "clear context" option.
- The v1-only features: AIR extensions, steering, Remote Control, idle compaction, the Claude
  subscription guard, MCP startup failure notices, and file change reports.

## Replacing the bridge

1. Move the SDK mapping out of `acp-agent.ts`: `toAcpNotifications`,
   `streamEventToAcpNotifications`, `promptToClaude`, `messageIdForGrouping`, and the helpers
   they use. The native core imports them from `acp-agent.ts` today, which is its only tie to
   the v1 core's module.
2. Port the gaps one feature at a time, each in a module that the native core owns. Start with
   what clients use most: `usage_update` and titles. Several of
   these are protocol-neutral modules already (`context-compaction.ts`, `session-titles.ts`).
   Others are typed for v1 (`native-subagents.ts`, `background-work.ts`).
3. Ratchet `NATIVE_STOPS` and `SAME_AS_BRIDGE`, and make `native` the default once it serves
   what v2 clients need.
4. Delete the bridge: `v2/agent.ts`, `v2/prompt.ts`, `v2/background.ts`, the v1 request
   conversions, and the v2 paths of `ClaudeAcpAgent`. Those paths are the `v2` option, the
   `foreground` and `background` hooks, `ForegroundEvents`, `foregroundWork`, and the
   `this.v2` branches. The v1 core then serves v1 and AIR only. `ClientCapabilities.v2` stays:
   the shared renderer uses it.

## Spec checks

Beyond the scenarios, `v2-native.test.ts` covers these requirements of the draft spec:

- A cancel covers only the prompts received before it. A later prompt waits for the interrupt,
  whose `cancelQueued` would end it otherwise. A prompt not pushed yet fails at once.
- A cancel that ended only queued prompts leaves the next turn's stop reason alone.
- `session/close` sends the cancelled work's final updates and `idle(cancelled)` before its
  response, and nothing after. It waits up to 5 seconds for Claude Code to end the work.
- Closing or deleting a session that does not exist succeeds.
- Stopped work gives its unfinished tool calls a final status before its idle: `cancelled`
  after a cancel, `failed` after an error.
- A session whose query ended is no longer active (-32002 with `data.sessionId`), and a resume
  starts it again from its transcript.
- Resuming the active session checks the request as a new one, keeps its work, and replaces its
  MCP servers. A different `cwd` or other additional directories are rejected.
- Config values must have the `id` type, additional directories must be absolute, and terminal
  logins are advertised only with `auth.terminal`.

`requires_action` comes from the session's own open requests, not Claude Code's: it covers
exactly this session's permission requests, and will cover its elicitations.
