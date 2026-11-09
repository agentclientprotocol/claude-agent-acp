# The ACP v2 agent

Status: the adapter's only ACP v2 implementation, for every v2 client, JetBrains AIR too. It
serves AIR the AIR extensions that ACP v2 does not cover (see "AIR clients"). `ClaudeAcpAgent`
(`src/acp-agent.ts`) serves ACP v1 only.

## Why

The adapter first served ACP v2 with a bridge, which converted each v2 request to v1, ran it
through `ClaudeAcpAgent`, and converted what came back (see "History"). So every v2 session ran
the v1 core, including the machinery that exists only because of v1:

- **Held prompts.** A v1 `session/prompt` answers when the turn ends, so the core keeps a turn
  queue and settles each turn itself. That needs echo matching, a per-uuid orphan account for
  prompts a cancel settled after they were pushed, owed-trailing-idle debt (turns settle at the
  `result`, and Claude Code's `idle` lags behind it), the steer lane, `cancelledThrough`, and the
  hold for background subagents (`deferredSettle`).
- **AIR branches.** The JetBrains AIR extensions are gated on `air.client` throughout the core.

The v1-only part is about 2,000 lines inline in `acp-agent.ts`, and on the bridge it all ran on
v2 too. For example, `deferredSettle` held a v2 turn open, and the bridge ignored the result.

ACP v2 describes a session the way Claude Code already does. A prompt is inserted into a queue
and answered at insertion, and the session reports whether it is working. Claude Code reports
both, so a v2 core can follow Claude Code's own events instead of rebuilding a turn model.

## How it maps

| ACP v2                             | Claude Code                                                                            |
| ---------------------------------- | -------------------------------------------------------------------------------------- |
| `session/prompt` answers           | `command_lifecycle` `started` for the prompt's uuid, or the prompt's echo              |
| `session/prompt` fails             | `session/cancel` or `cancelled` (-32800), `discarded` or `refused` (-32603)            |
| `state_update` `running`           | a turn starts: a prompt's `started` or echo, or the main conversation's output         |
| `state_update` `idle`              | the turn's `result`, with its stop reason, usage, `_meta.quota` and error              |
| `state_update` `requires_action`   | a turn is open and it waits on the user (see the end of this page)                     |
| `session/cancel`                   | `interrupt({ cancelQueued: true })`, also while idle                                   |
| `session/resume` with `replayFrom` | `getSessionMessages`, mapped like live output                                          |
| `session/fork`                     | `forkSession` (`fork-session.ts`), then a resume of the copy                           |
| `availableCommands`                | `supportedCommands`, filtered by `getAvailableSlashCommands`, and the adapter's `/mcp` |
| `elicitation/create`               | AskUserQuestion, `onElicitation`, `onUserDialog`, and MCP OAuth (see below)            |
| `elicitation/complete`             | `system/elicitation_complete`, and an MCP OAuth sign-in that finished                  |
| output updates                     | the shared SDK mapping (`toAcpNotifications`), translated by `V2UpdateTranslator`      |

The reports that are not Claude's output come from `src/v2/reports.ts`, built as on v1:

| ACP v2                                  | Claude Code                                                                     |
| --------------------------------------- | ------------------------------------------------------------------------------- |
| `usage_update` (`used`, `size`)         | the root `message_start`/`message_delta` usage, the assistant message's usage   |
| `size` before the first result          | an earlier result's window (`contextWindowCache`), else `getContextUsage`       |
| `usage_update` with `cost`              | the turn's `result` (`total_cost_usd`, `modelUsage` for the window, `origin`)   |
| `usage_update` `_meta`                  | the model (`_claude/model`), a `rate_limit_event` (`_claude/rateLimit`)         |
| `_meta.quota` of the turn's `idle`      | the `result`'s `usage` and its increment of `modelUsage`                        |
| `notice`                                | `informational` (not level `info`), a client MCP server `failed` at `init`      |
| `notice` and the `model` option         | `model_refusal_fallback` (the swap of a `retry` that is not `local`)            |
| `plan_removed`, the title again         | `conversation_reset` (also the idle compaction starts over)                     |
| `compaction_update`, summary chunks     | `status` `compacting` and `compact_result`, `compact_boundary`, `PostCompact`   |
| `compaction_update` on replay           | a transcript message with `isCompactSummary`                                    |
| `session_info_update` (title)           | `SessionTitles`: the title Claude Code stores or generates, read at `idle`      |
| `plan_update` of the Task\* list        | TaskCreate/TaskUpdate/TaskList results, the TaskCreated and TaskCompleted hooks |
| `plan_removed` of `plan`                | an empty TodoWrite or Task\* list                                               |
| `tool_call_update` progress             | `tool_progress`                                                                 |
| `running`, then `idle`, no user_message | the adapter's idle `/compact` (`IdleCompaction`)                                |

The session keeps little of its own: a map of prompts that are not inserted yet, whether a turn
is open, and its count of open permission requests and elicitations (`src/v2/session.ts`).

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
such as one that an interrupt stopped before it ran. The `idle` that follows a result is that
result's, also when it comes after the next cycle's first output. A placeholder result
(`num_turns: 0` of a task notification) ends nothing: Claude Code answers queued notifications
with one model call. The idle's usage and `_meta.quota` are the result's (`outcome.ts`, with the
quota helpers of `session-usage.ts` that v1 uses). Without a result, a prompt's turn reports zero
usage and a zero quota, and a cycle that Claude Code started on its own reports neither. The
stop reason is read from the result (`resultEnd`, `result-end.ts`). A failed turn's idle carries
its error instead: an authentication failure (the assistant message's `error`, or the
"run /login" text) is `authRequired` (-32000), and any other failure has the assistant message's
error kind in `data.errorKind`. Claude Code's sign-in message ("Not logged in · Please run /login")
is not shown, live or in a replay, and fails the turn with `authRequired`. A turn whose prompt got
`cancelled` after `started` and before a result is dead: its late result ends nothing.

`session/cancel` answers every prompt not inserted yet with -32800. Claude
Code can still run one that it had taken in before the interrupt arrived, or a cycle that it
started while the client saw no work. The client never saw that work, so it is dropped: its
output, its states, and its permission requests, which are denied (`stopped-work.ts`). An aborted
result after a cancel ends the work that the interrupt stopped as `cancelled`. Claude Code's
interrupt withdraws the open permission requests. Their end reports no `running` before the
idle, and one that the user answers after the cancel reports `running`.

The work that the client saw goes on until its idle, and v2 allows its updates until then. Its
streamed deltas go out (text, thinking, tool use starts), and of its consolidated
messages only the results of the tool calls that the client holds, which an error result ends
`cancelled`. The rest is dropped: the consolidated assistant messages (the tail of a cut-short
text block, a tool use that never streamed) and the results of tool calls that the client never
saw.

A consolidated assistant message adds only the text that did not stream, as on v1
(`unstreamedRemainder`): the tail of a block whose stream was cut short, or the whole text of a
message that never streamed.

## Subagents and background work

`tasks.ts` is written for v2 only, rather than reusing `native-subagents.ts`, which also serves
AIR's draft and restores subagents from history. It follows the subagents RFD, from Claude
Code's task events (with `forwardSubagentText` and `perTaskStopAffordance`):

| ACP v2                                                           | Claude Code                                                                                                                          |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| child session id                                                 | the agent id (`task_id`), the same for every delegation to it                                                                        |
| `subagent_update` announcement, running, on the parent           | `task_started` of a `local_agent` and its Agent or Task call, on the session that made it                                            |
| the parent's outgoing and the child's incoming `session_message` | the prompt of the Agent call (`task_started.prompt`), which the parent is not shown                                                  |
| the child's reply, on the parent                                 | the completed result of a foreground child's Agent call                                                                              |
| the child's traffic, streamed                                    | messages whose `parent_tool_use_id` is the Agent call that launched it                                                               |
| `config_option_update` of the child                              | its hooks' `permission_mode`, `effort`, `agent_type` and `PostModelSwitch` model, and the model of its responses (`child-config.ts`) |
| a SendMessage call, as `session_message`s                        | the call's `task_started` or `resumedAgentId` result for an announced child                                                          |
| a SubagentHandback call, as the child's `session_message`        | the completed call's `message` input                                                                                                 |
| the child's `tool_call_update` progress                          | `tool_progress` whose `parent_tool_use_id` is the child's launch call                                                                |
| a restored child (`subagentLineage`)                             | `task_started` of an agent that this process does not know, under a SendMessage call                                                 |
| `cwd` of the child                                               | the `SubagentStart` hook's `cwd`, when it is not the parent's (such as a worktree)                                                   |
| child `running` / `idle`, mirrored on the parent                 | `task_started` (or a `running` patch) to `task_notification`                                                                         |
| child `requires_action`                                          | a permission request or question whose `agentID` is the announced child                                                              |
| `session/cancel` of a child                                      | `stopTask(agentId)`                                                                                                                  |
| `background` of a session                                        | its background subagents, commands (terminals), task tool calls and other tasks                                                      |
| `terminal/cancel`, `tool_call/cancel`                            | `stopTask` of the listed item's task                                                                                                 |
| the adapter's tool call `task_<taskId>`, listed in `background`  | a live task that no tool call or terminal stands for, such as one a hook started or one that started after its tool call returned    |
| title and body of a workflow's tool call                         | `task_progress` of a `local_workflow` task, with its `workflow_progress` phases and agents (`workflow-progress.ts`)                  |
| a replayed child (`session/resume` with `replayFrom`)            | the subagent transcripts and metadata (`getSubagentMessages`, `subagent-replay.ts`)                                                  |

A child's messages before its announcement wait for it, and a
child that ends before it is announced stays unexposed: its Agent call is then shown with its
final status. A child that its parent waits on (`is_backgrounded` not `true`) is part of the
parent's foreground work, also before its announcement: its requests block the parent too
(`requires_action`), and cancelling the parent stops it. After the parent's `session/cancel`,
of a foreground child's consolidated messages only the results of the tool calls that the client
holds go out until its run ends, as for the root, and its requests are withdrawn, also later ones.
A foreground child that Claude Code reports after the cancel, before the stopped work's result or
idle or the next prompt's start, is stopped the same way. A child's unfinished tool calls get their final
status before its idle: `cancelled` when it was
stopped, `failed` when it failed or a reset ended it, and otherwise a tool call that Claude
dropped before it ran ends `cancelled`. Claude Code's later results for a stopped or failed run's
calls are dropped. When Claude Code mounts a fresh conversation (`conversation_reset`, such as
for `/clear`), each child that works goes `idle` with no stop reason, since nothing says how its
run ended, and every child is forgotten: a later task event of one changes
nothing. A child that a task names as its parent
without a launch call is announced only after that parent. A
background child is listed in its parent's `background` while it works, and cancelling the
parent leaves it running. The client can only watch a child and cancel its run: prompt, close,
resume, delete and config changes on it fail with -32602. A session started with
`perTaskStopAffordance: false` in `_meta.claudeCode.options` lists no background work.

A child's configuration merges each report of its hooks (SubagentStart, SubagentStop,
PreToolUse, PostToolUse, PostToolUseFailure, PostModelSwitch) and of its responses into one set of
options, and the client gets all of them again when one changes, the mode first. What a hook
reports before the child's announcement goes after its prompt. The client is not shown a
SendMessage call: once its message reaches an announced child, it is the sender's outgoing and the
child's incoming `session_message`. A call whose message reached no child, such as one to the
parent, is shown with its final status. A call whose permission request came before its tool use
streamed stays shown, since the request showed it: its updates go out, and its
message goes to the child only. A child's completed SubagentHandback call is its message
to its parent, and its run's result is then no reply. Claude Code resumes an agent from before a
restart under the SendMessage call that resumed it, with a `task_started` or with the call's
`resumedAgentId` result alone. The child is restored from the session's
subagent history (`subagentLineage`): its ancestors are announced first, with
no state, and the session handles its next message, or the result's own updates, only after the
history is read. An agent that the history cannot place stays unexposed, as the RFD forbids
guessing a parent.

After a replay's response, a replayed child whose configuration is not the `model` that the
replay sent gets it again: a live child's whole configuration (such as the mode
that its hooks reported), else the model of its latest response, by the session's model list.

## AIR clients

A v2 client that declares `_meta.jetbrains.air` in `initialize` gets the AIR extensions of
`docs/air-extensions.md` that ACP v2 does not cover, with the wire output that the v1 core gives
AIR. `src/v2/air.ts` reads what the client declared, and every other client gets none of
them. The `initialize` response lists the served capabilities that AIR's agent declaration
lists: `_meta.jetbrains.air.capabilities` is `["agentFileChangeReport", "recommendedValue"]`.

- `recommendedValue`, when declared: the model and effort options lose their `default` rows and
  carry `_meta.jetbrains.air.recommendedValue` (`config.ts`, on the shared
  `buildConfigOptions`). The shown effort is set on the query at the session's start and at each
  model switch (`settleEffortAfterModelSwitch`), as on v1. A failed set at the start fails the
  setup request, as on v1.
- The permission presentation: each permission request carries
  `_meta.jetbrains.air.permission` with its `title`, `description` and `defaultToNo`, next to
  v2's own `title` and `description`. Its tool call's `_meta.claudeCode` follows AIR's rule
  (`permissionToolCallMeta`): no `toolName` and no `parentToolUseId`. The tool call keeps the v2
  rendering that the stream gives it.
- AskUserQuestion's "Other" fields carry AIR's custom answer marker (`customAnswer`, and the
  legacy root key).
- The predicted follow-up prompt (`reports.ts`, on the shared `PromptSuggestions`): the query
  runs with `promptSuggestions: true` before the client's options, and the one prediction after
  a result goes out as `session_info_update._meta.promptSuggestions`. A client prompt and a
  `conversation_reset` clear it with `suggestions: []`, and a prediction that the next prompt
  outran is dropped. Unlike v1, a client that is not AIR gets no `promptSuggestions` option, as
  it would get no prediction.
- `agentFileChangeReport`, when declared (`file-changes.ts`, on the shared reporter of
  `file-change-audit.ts`): the query runs with file checkpointing, and a `session/prompt` whose
  `_meta.jetbrains.air.agentFileChangeReportRequest` is valid gets one report. v1 sends it before
  the prompt's response, at the turn's end. A v2 prompt is answered at its insertion, so the
  report goes out at the end of the turn that serves the prompt, before that turn's idle: the
  session reads the prompt's checkpoint (up to 2 seconds), and the idle waits for it. A turn whose
  plan runs in a fresh context (ExitPlanMode's "Yes, clear context") reads the checkpoint of the
  plan's prompt instead: `/clear` reset Claude Code's file history. A turn that
  ends `cancelled` reports `unavailable` with `cancelled`. Any other turn that ends with an error
  or without a result reports `unavailable` with `providerError`. A prompt that a cancel answers with -32800 before its
  insertion reports `cancelled`, and one that fails otherwise `providerError`.
- `loadReplayEnd`, when declared (`setup.ts`): the update that ends a replay. The agent does not
  advertise it, as on v1.

These AIR extensions are not served, because ACP v2 covers them: the subagent form and
`nativeSubagentSessions` (v2 subagent sessions), `backgroundSubagents` and `asyncTasks` (v2
`background` lists), `planFile` (v2 file plans), `diffPatch` (v2 patch content),
`contextCompaction` (v2 compaction updates), `customInstructions` (v2 `systemPrompt`), and
`sessionFailure` records and their API retry warnings (an idle with `stopReason: "error"` and
its `error`). The goal and async task stop extensions are v1 only.

Not served yet: the AIR tool call contract (`commandTitle`, `subagent`, `skill`, `mcp` and
`is_mcp_tool_call` keys, `rawInputRendering`, and the AIR shapes of `rawInput`, `rawOutput` and
exit codes), which the shared renderer gives only with `air.client`, and the `kind` and
`skillPath` keys of modes and skill commands. `sessionIndex` is not served on v2.

## Layout

- `src/v2/agent.ts`: the request handlers, session setup, and the SDK `query` options.
- `src/v2/session.ts`: one session: its prompts, its state, and the routing of the
  query's messages.
- `src/v2/outcome.ts`: the stop reason, usage, error and `_meta.quota` of each idle.
- `src/v2/stopped-work.ts`: the work that a cancel stopped before the client saw it.
- `src/v2/stream.ts`: the SDK output, and replayed history, as v2 updates.
- `src/v2/tasks.ts`: Claude Code's tasks: subagents as child sessions, and the
  `background` list of each session (see above).
- `src/v2/subagent-replay.ts`: the subagents' histories in a replay, with SendMessage
  deliveries, hand-backs and model changes as live, and a notice for the subagents whose history
  is missing (a launch without metadata, a transcript that cannot be read).
- `src/v2/child-config.ts`: each child session's configuration, and the hooks that
  report it.
- `src/v2/permissions.ts`: `canUseTool` as v2 permission requests, on the session of the
  agent that asks.
- `src/v2/elicitation.ts`: elicitations, for the modes the client advertised. A form
  for AskUserQuestion (on the session of the agent that asks), for an MCP server's form, and for
  the refusal fallback's consent prompt. A URL for an MCP server's URL request and for MCP OAuth.
  All but MCP OAuth are open requests of their session, like permission requests: a cancel or a
  close withdraws them. MCP OAuth starts after the setup response, and a close withdraws it. A
  restart of the query (`restarts.ts`) withdraws it on the old query and starts it again on the
  new one.
  Without form elicitation, AskUserQuestion is disallowed and the refusal fallback is not
  declared. An MCP server's request in a mode the client did not advertise, or that the client
  answers with an error, is answered `cancel`.
- `src/v2/config.ts`: the config options, built and set as v1 builds and sets them
  (`buildConfigOptions` and `configOptionValue`): mode, model (also by an alias such as `opus`),
  effort, Fast mode and ultracode (boolean options), and the custom main-thread agents
  (`supportedAgents`). Effort, Fast mode, ultracode and agent are set with `applyFlagSettings`.
  A model switch rebuilds the options for the new model: effort follows `effortForModelSwitch`,
  and Fast mode and ultracode show only on a model that supports them. The mode follows the v1
  core's rules (`SessionModeManager`): `auto` runs as `acceptEdits`, with a notice, for a model
  that does not support it. A model switch that the adapter did not make (`PostModelSwitch`, such
  as a typed `/model`, or a refusal fallback) updates the options. Claude Code's
  `fast_mode_state` (on `init` and on results of prompts) updates the Fast mode option, with a
  notice when it turns off a Fast mode the user had on. A value that names no entry is rejected
  with -32602 ("Invalid value for config option model: not-a-model") and changes nothing, as on
  v1, which shares `configOptionValue`. A model alias names an entry only by whole
  words (`resolveModelPreference`): `opus`, `opusplan`, `claude-sonnet-5[1m]` and provider ids
  such as `us.anthropic.claude-sonnet-5-v1:0` do, `not-a-model`, `son` and `foo-sonnet` do not.
- `src/v2/clear-context.ts`: ExitPlanMode's "Yes, clear context" option, offered to the
  root's plan. The answer interrupts the cycle, and the turn stays open: the
  session sends Claude Code `/clear`, then sets the chosen mode and sends "Implement the following
  plan" in the fresh conversation. The client sees the plan's tool call
  `completed`, the options, a `usage_update` of an empty context, the markdown plan, then the
  plan's run in the same turn, whose idle has the whole turn's usage. v1 starts a fresh query
  instead (`clear-context-coordinator.ts`); `/clear` is Claude Code's own fresh conversation, and
  keeps the query's tasks and MCP servers.
- `src/v2/setup.ts`: what session setup adds on v1's rules: the client's
  `_meta.claudeCode.options`, `CLAUDE_MODEL_CONFIG`, the models (the `availableModels`
  allowlist, `ANTHROPIC_MODEL` and the settings' `model`, the resumed transcript's model, whose
  row keeps its family alias as on v1 (`aliasResumedModelRow`, such as `fable`)), the
  current title on resume, and AIR's `loadReplayEnd` event.
- `src/v2/commands.ts`: the command list, and the adapter's `/mcp`, whose server list
  replaces Claude Code's text before the turn's idle. The list has the adapter's `/remote-control`
  when the query serves Remote Control.
- `src/v2/file-preview.ts`: the PreToolUse hook that shows an Edit's or Write's exact
  patch before it runs. A patch whose tool call the client does not hold yet waits for the
  call's first publication by the stream or a permission request: a workflow's agents run the
  hook without streaming their tool uses, and a call shown by the hook alone would never end.
- `src/v2/air.ts`: the AIR extensions that the client takes, and the AIR capabilities of
  the `initialize` response (see "AIR clients").
- `src/v2/file-changes.ts`: AIR's file-change reports of a session's turns.
- `src/v2/auth.ts`: `_auth/status_update`, gateway `auth/login`, `auth/logout`, and
  `providers/*`, on the v1 core's state rules (`AuthStatusReporter`, `providers.ts`). The
  identity is read after `initialize`, from each session's account, after a login or logout, and
  at the start of each prompt. A gateway login routes the sessions started after it.
  `providers/set`, `providers/disable`, and an `auth/logout` that
  drops a provider or a gateway login route the live sessions too (see `restarts.ts`).
- `src/v2/restarts.ts`: restarts of a session's query, as on v1: a new query
  resumes the same Claude session without the setup's `_meta` effort, then the old one ends at
  its next turn boundary, and the client's choices are set again as v1's
  `restoreSessionChoices` sets them (model, mode and pre-plan mode, ultracode, Fast mode, the
  effort pin, the agent the client picked) and sent in a `config_option_update`. For a new route,
  each live session restarts at its next turn boundary (no turn open, no prompt of the session
  waiting to go to Claude Code or in its queue, no subagent running, background ones included).
  A session at a turn boundary restarts before the request answers. A busy session keeps its
  query until its next turn boundary, which the request does not wait for, and its prompts go to
  that query meanwhile (the provider RFD lets an Agent leave running sessions on the old route).
  A route restart waits for an account restart of the session that runs, as for a busy session.
  Prompts wait only for a restart that runs, and go to the new query. A resume of the active
  session with other additional directories restarts it the same way, without waiting for it:
  Claude Code reads them only when its process starts. A session whose query does not start
  again stops (see "Differences from the old v2 bridge").
  A `session/cancel` or `session/close` answers the waiting prompts with -32800. The old query's
  background commands end with it: their terminals exit before the list drops them.
- `src/v2/subscription-guard.ts`: the `--hide-claude-auth` subscription guard, on the
  rules of `hide-claude-auth.ts`, which v1 applies too. While no provider or
  gateway login routes the traffic, a session does not start, and a prompt is refused before
  insertion, on an account that a claude.ai subscription would pay for (`authRequired` with the
  `claude_subscription_not_supported` reason) or that holds no accepted credential. A turn that
  fails for a missing login, or a probe that finds another kind of identity, restarts the query at
  the next prompt that finds the session idle, so its start judges the current account. A failed
  restart fails that prompt and keeps the session, for a retry after a sign-in. The guard judges a
  prompt among the session's prompts, so a cancel or close answers one that waits for it with
  -32800, and the prompts keep their order.
- `src/v2/remote-control.ts`: the adapter's `/remote-control`, listed and run on the v1
  core's rules (`remote-control.ts`), as a local command of its own turn (see "Differences from
  the old v2 bridge"), and the messages typed in another client of the session (a human-origin prompt
  echo that this session did not send), shown as user messages.
- `src/v2/reports.ts`: usage, notices, compactions, titles, and the idle
  compaction (see the table above), and the hooks that feed them (PostCompact, TaskCreated,
  TaskCompleted). The context window is seeded as on v1 (`context-window.ts`): a window
  that a result of any session on the same backend reported, else a guess from the model's names
  refined by a background `getContextUsage`, until the session's own result reports it.

The v2 agent shares these with the v1 core:

- the SDK message mapping and tool call rendering (`toAcpNotifications`,
  `streamEventToAcpNotifications`, `tool-calls/*`)
- permission presentation, options and decoding (`permissions/*`)
- the mode catalog (`buildAvailableModes`)
- `promptToClaude`
- the background command helpers: `backgroundBashTaskFromToolResult`, `withRunningTerminal`,
  `withRunningToolCall`, `BackgroundOutputTail`
- the pure subagent helpers (`native-subagents.ts`: `rfdLabels`, `subagentIdentity`,
  `linkedSessionMessages`, `launchReply`, `unexposedControlFallback`, `childModelOption`,
  `responseModelEntry`, `rfdEndState`, `handbackMessage`, `resumedNativeSubagentId`,
  `sendMessageResume`), and the subagent history readers (`subagentHistory`, `subagentLineage`,
  `readSubagentMessages`, `firstResponseModel`, `replaySubagentTerminalState`)

These pieces were extracted from the v1 core so that both cores use the same code:

- `V2UpdateTranslator` and `replayClear` (`v2/update-translator.ts`), taken from the bridge's
  client connection, and the other v2 wire conversions that the bridge used
- `terminalAuthMethods` (`auth-methods.ts`), taken from `ClaudeAcpAgent.initialize`
- `sdkMcpServers` (`mcp-servers.ts`), taken from `ClaudeAcpAgent.createSession`
- `resolveThinkingConfig` and `configuredSettings` (`session-env.ts`), and `sessionSystemPrompt`
  (`client-system-prompt.ts`), taken from `ClaudeAcpAgent.createSession`
- `getAvailableSlashCommands`, exported from `acp-agent.ts`
- `/remote-control` (`remote-control.ts`): its parsing, the check that Claude Code does not offer
  a command of the name, the call and its reply text, and `isRemoteHumanMessage`, taken from
  `acp-agent.ts`
- `AuthStatusReporter` and `cliLogout` (`auth-status-reporter.ts`): the `authStatus` state, the
  `claude auth status` probe and the `_auth/status_update` pushes, taken from `ClaudeAcpAgent`
- the elicitation answers (`elicitation.ts`): `answerAskUserQuestion`, `answerMcpElicitation`,
  `answerUserDialog` and `elicitUnlessWithdrawn`, taken from `ClaudeAcpAgent`'s handlers
- MCP OAuth (`mcp-oauth.ts`): `startMcpServerAuthentication` and its status polling, taken from
  `acp-agent.ts`
- the provider routing (`providers.ts`): `ProviderConfig`, the gateway login methods and their
  validation, the `providers/list` response, `providers/set` validation and model listing, and
  `createEnvForProvider`, taken from `ClaudeAcpAgent`
- `recordStreamedDelta` and `unstreamedRemainder` (`streamed-text.ts`): the record of streamed
  text and thinking, and what a consolidated message adds to it, taken from `acp-agent.ts`
- the token usage helpers (`session-usage.ts`): usage snapshots, the `_meta.quota` shape, the
  `modelUsage` increments and the context window guess, taken from `acp-agent.ts`
- `resultEnd` (`result-end.ts`): the stop reason or error of a result, taken from the subtype
  switch of v1's prompt loop, which reads its results with it too
- `permissionToolCallMeta` (`permissions/presentation.ts`): the `_meta.claudeCode` of a
  permission request's tool call (`mcpServer`, the parent tool use), taken from `canUseTool`
- `informationalNotice` and `mcpServerStartupNotice` (`session-notices.ts`), and
  `replayCompactSummary` (`context-compaction.ts`), taken from `ClaudeAcpAgent`
- `SessionTitles` (`session-titles.ts`) now reads its session and agent through the
  `TitledSession` and `TitleOwner` interfaces, which `ClaudeAcpAgent` matches as it is
- the config options (`session-config-options.ts`): `buildConfigOptions`, the custom agents
  (`discoverCustomAgents`), the capability checks, and `configOptionValue`, the value check of
  `session/set_config_option`, taken from `ClaudeAcpAgent.selectSessionConfigOption`
- Fast mode (`session-fast-mode.ts`): its option and values, and `fastModeStateChange`, taken
  from `syncFastModeState`
- the effort of a model switch (`effortForModelSwitch`, `settleEffortAfterModelSwitch` in
  `session-effort.ts`), taken from `applyConfigOptionValue`
- `withCurrentModelInfo` (`session-model.ts`): the current model's capabilities, also for a
  resumed model outside the allowlist, taken from `ClaudeAcpAgent.createSession`
- the context window (`context-window.ts`): the cross-session cache, its provider key, the
  seed, and `readContextWindow`, taken from `acp-agent.ts`
- `modelRefusalFallback` (`session-notices.ts`): the notice of a refusal fallback, taken from
  `ClaudeAcpAgent`'s `model_refusal_fallback` handler
- `subagentHookOptions` and `orderedSubagentConfiguration` (`subagent-configuration.ts`): a
  child's options from a hook, and their order, taken from `subagentConfigurationHook` and
  `NativeSubagentRuntime.publishConfiguration`. `AGENT_CONFIG_ID` moved to
  `session-config-ids.ts`, and `customAgents` out of `discoverCustomAgents`
- `deliveredCall`, `isDelivery` and `missingHistoryNotice` (`subagent-replay.ts`), taken from
  `RfdSubagentReplay`

## How it is checked

- `src/tests/acp-v2.test.ts` drives the v2 surface through the protocol router with the SDK's
  v2 client, which validates every message against the v2 schema. It started as the bridge's
  v2 tests, and ran against both the bridge and the v2 agent until the bridge was deleted.

- `src/tests/v2.test.ts` drives the core with a Claude Code double, message by message:
  insertion, folding, lifecycle failures, cancel, permission states, config, local commands,
  a crashed query, and replay.
- `src/tests/acp-scenarios-v2.test.ts` runs the 40 scenarios on v2: they pass, send only
  schema-valid v2, report each tool call with a title first, and equal the golden files
  (`acp-scenarios/__snapshots__/v2/`) in full: requests, responses, notifications, permission
  requests, elicitations and errors. The bridge recorded those golden files, and the v2 agent
  matched them before the bridge was deleted.
- The scenario double sends `session_state_changed` when the query asks for it, as the real
  CLI does.
- `src/tests/v2-integration.test.ts` (`npm run test:integration`) runs the adapter's
  process on v2 against the bundled Claude Code CLI, so a CLI that changes the
  frames the core relies on fails it:
  - a prompt answers at insertion, then the turn goes `running` → `idle` with `end_turn`
  - a permission request goes `running` → `requires_action` → `running`
  - `session/cancel` fails a queued prompt with -32800 and goes `idle` with `cancelled`
  - the next prompt runs normally
- A manual run against the bundled Claude Code CLI also checked that Bash runs as display
  terminals.

## Differences from the old v2 bridge

Where the old v2 bridge's behavior differed, the v2 agent follows the spec (or, where noted, the
order of its setup). The bridge's behavior is in the past tense.

- A cancel right after `running`, before any output: the bridge sent `idle(cancelled)` at once,
  without usage. The v2 agent sends it once Claude Code's aborted result arrives, with that
  result's usage, as v2 asks ("After all ongoing operations have been successfully aborted ...
  the Agent MUST send an idle `state_update`").

- A v2 AIR client gets only the AIR extensions that v2 does not cover (see "AIR clients"). The
  bridge served it the v1 core's AIR extensions: `sessionFailure` records (with the "Retrying
  Claude" API retry warnings) and AIR's subagent form, which reports no `background` list, and
  the AIR tool call contract. The v2 agent serves v2's subagent sessions, `background` lists
  and failed idles instead.
- `/remote-control` runs as a local command of its own turn, as v2 asks: `running`, the reply,
  then `idle` with `end_turn`. Sent while Claude works, it waits for the work to end, and the
  prompts after it wait for it: v2 asks to hold a prompt, not to reject it, while foreground work
  runs. The bridge rejected it then (-32600), and otherwise reported no state around it. Its reply
  had no `messageId`, which v2 requires of a chunk, so a v2 client never got it.
- Resuming the active session with other MCP servers keeps its work going and replaces the
  servers on the running query (`setMcpServers`), as v2 asks ("Ongoing work continues, and the
  request's MCP servers and workspace roots replace the previous ones"). The bridge tore the
  session down and started a new query, which cancelled its running work.
- A stopped child's unfinished tool calls end before the idle that reports its cancel, as v2 asks
  of the updates after `session/cancel`. The bridge ended them after the idle. A child that a
  `conversation_reset` ends gets its tool calls ended `failed` before its idle too: v2 asks for a
  final status of a turn's tool calls before its idle. The bridge left them open.
- A SendMessage call that its permission request showed, and whose message goes to the child
  only, names its sender in the child's `session_message` (`senderSessionId`), as the RFD asks
  ("Agents **SHOULD** include participant IDs on the first `session_message`"). The bridge left
  the sender out.
- A resume of a session that is not active replays after Claude Code started, so a replayed
  child's `model` is the session's model list entry at once. The bridge replayed while Claude Code
  started, without the list: it sent the model's id, then the entry after the response. The client
  ended with the same configuration. This is no spec rule: it follows from the order of the setup.
- While the root's turn waits on foreground subagents, it reports `requires_action` only when each
  of them waits on the user. One that still makes progress keeps the turn `running`, as v2 asks.
  The bridge reported `requires_action` as soon as one of them asked.
- ExitPlanMode of a subagent offers no "clear context" option: a fresh context continues the
  root's turn, and cannot clear a subagent's context. The bridge offered it to a subagent's plan
  too.
- An MCP server's URL elicitation that the user accepts keeps the work `requires_action` until
  Claude Code reports it complete (`elicitation_complete`), the tool use ends, or the turn ends:
  `accept` only consents to open the URL. The bridge reported `running` at the answer.
- A session whose query ended without `session/close` (Claude Code exited, or a restart's new
  query did not start) stays active, as v2 keeps a session active until its close or the end of
  the connection. Its requests fail with -32603 and what happened ("Claude Code stopped. Resume
  the session to continue."), until a resume starts it again from its transcript. A close ends
  it, and -32002 follows. The bridge dropped the session, so the client got -32002.
- A prompt that the `--hide-claude-auth` guard still judges keeps its place: a `/remote-control`
  sent after it waits for it, as v2 asks that held prompts be inserted in the order received. The
  bridge ran `/remote-control` before its guard, so it inserted the command first.
- A replayed tool call that the transcript gives no result, such as one that ran when Claude Code
  was killed, ends `failed` after the replay, as v2 asks of replayed work that no longer runs. The
  calls that the active session still runs stay open. The bridge left such a call pending.
- After Claude Code mounts a fresh conversation (`conversation_reset`, such as for `/clear`), the
  context in use is 0, so ExitPlanMode's option reads "clear context (0% used)". The bridge kept
  the old context's figure until the next model request reported usage. This is no spec rule: the
  bridge's figure was stale.

## Not served yet

To an AIR client: the AIR tool call contract and the `kind` and `skillPath` keys (see "AIR
clients"). To any v2 client:

- API retries and prompt suggestions to a client that is not AIR. v1 sends both to AIR only too.
- A `replayFrom` cursor other than `start`: the core rejects it with -32602, such as "Replaying
  from a \_message cursor is not supported", as the spec asks of a cursor type that the Agent does
  not support. It does not replay from another position or resume without a replay.
- The v1-only features: steering (`_session/steering`, whose `steering` marker the v2
  `initialize` response does not carry), and AIR's async task stop and goal extensions.

## History

The old v2 bridge (the former `src/v2/agent.ts` and the v2 mode of `ClaudeAcpAgent`) served v2
by converting each v2 request to v1 and back. The v2 agent, built beside it in its own
directory, replaced it step by step: the shared pieces moved out of `ClaudeAcpAgent` (see the
list above), the gaps were ported one feature at a time, and the v2 agent became the default,
also for AIR, with both implementations held to the same v2 tests and scenarios. Then the bridge
was deleted, and the v2 agent moved into `src/v2/`, beside the bridge's v2 wire conversions that
it kept: the session setup and config conversions (`session-requests.ts`), the prompt and
permission conversions (`prompt.ts`, `permissions.ts`), the `initialize` capabilities
(`initialize.ts`), `V2UpdateTranslator` with its terminals and tool call `_meta`, and the
`background` lists (`V2Background`).

## Spec checks

Beyond the scenarios, `v2.test.ts` covers these requirements of the draft spec:

- A cancel covers only the prompts received before it. A later prompt waits for the interrupt,
  whose `cancelQueued` would end it otherwise. Every covered prompt fails at once, and the run
  of one that Claude Code had taken in already is dropped, its tool uses denied.
- A cancel that ended only queued prompts leaves the next turn's stop reason alone.
- `session/close` sends the cancelled work's final updates and `idle(cancelled)` before its
  response, and nothing after. It ends the work at once, without waiting for Claude Code.
- Closing or deleting a session that does not exist succeeds.
- Stopped work gives its unfinished tool calls a final status before its idle: `cancelled`
  after a cancel, `failed` when the query ends. At any other end, a tool call that Claude dropped
  before it ran ends `cancelled`.
- A session whose query ended stays active until its close: its requests fail with -32603 and
  `data.sessionId`, not -32002, and a resume starts it again from its transcript.
- Resuming the active session checks the request as a new one, keeps its work, and replaces its
  MCP servers and additional directories, which a restart at the next turn boundary applies. A
  different `cwd` is rejected, and so is a `systemPrompt` that the session cannot apply, on every
  setup path before it acts (a fork copies nothing then).
- Config values must have the `id` type, additional directories must be absolute, and terminal
  logins are advertised only with `auth.terminal`.

`requires_action` comes from the session's own open requests, not Claude Code's: it covers
exactly this session's permission requests and elicitations, and, while the turn waits on
foreground subagents, theirs, once each of them waits on one. MCP OAuth is not one: it does not
block a turn. After `session/close` answered, no request of the session goes to the client.
