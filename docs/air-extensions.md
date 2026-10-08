# AIR extensions in claude-agent-acp

Status: Experimental

This document is the wire contract of the JetBrains AIR extensions that `claude-agent-acp` implements.
It describes only this adapter.

## Contents

- [Purpose and scope](#purpose-and-scope)
- [Compatibility rule](#compatibility-rule)
- [Negotiation](#negotiation)
- [AIR metadata keys](#air-metadata-keys)
- [JetBrains shared keys](#jetbrains-shared-keys)
- [Zed conventions](#zed-conventions)
- [Tool call contract](#tool-call-contract)
- [Claude tools and ACP fields](#claude-tools-and-acp-fields)
- [Diff patch](#diff-patch)
- [Plan file](#plan-file)
- [Permission presentation](#permission-presentation)
- [Goal](#goal)
- [Recommended config values](#recommended-config-values)
- [Async tasks](#async-tasks)
- [Agent file-change report](#agent-file-change-report)
- [Session failure](#session-failure)
- [Native subagent sessions](#native-subagent-sessions)
- [Session index](#session-index)
- [Context compaction](#context-compaction)
- [Question custom answers](#question-custom-answers)
- [Session fork point](#session-fork-point)
- [Presentation hints](#presentation-hints)
- [Removed keys](#removed-keys)

## Purpose and scope

AIR is the ACP client that JetBrains builds.
AIR needs some data that standard ACP does not define.
This adapter sends that data as opt-in extensions under the `_meta.jetbrains.air` namespace.

`jetbrains` owns the non-standard contract.
`air` names the client whose rendering rules the contract follows.
The two levels keep other JetBrains ACP clients from reading this metadata by accident.

Each extension is experimental.
Each extension is shaped so that it can become a first-class ACP API later.

## Compatibility rule

An AIR client declares `initialize.clientCapabilities._meta.jetbrains.air` (see [Client declaration](#client-declaration)).
Every extension in this document applies only to an AIR client.

A client that does not declare `_meta.jetbrains.air` is not AIR. Zed is such a client.
It gets the same information in the same fields as from the upstream adapter:

- the standard ACP fields with the upstream values, and the [Zed conventions](#zed-conventions);
- the upstream `_meta` keys: `claudeCode.toolName`, `claudeCode.parentToolUseId`, the full `claudeCode.toolResponse`, `claudeCode.promptQueueing`, and the `_claude/*` keys;
- the keys of other teams: `steering`, `quota`, `authStatus`, and `gateway`.

It gets no key that exists only for AIR.
It gets no `_meta.jetbrains.air` key at all, and none of the removed upstream copies of an AIR key (see [Removed keys](#removed-keys)).

The adapter leaves out only repeated data for such a client:

- A `tool_call_update` leaves out a top-level field whose value did not change since the previous report of the same tool call.
  An update with nothing new is not sent.
- A `tool_call_update` keeps every `_meta` key, also an unchanged one.
  ACP defines the merge only for the top-level tool call fields, not for `_meta` keys.
  So a client that reads each update alone still gets `claudeCode.toolName` and `claudeCode.parentToolUseId`.
- Streamed subagent text is not sent again in full when the complete message arrives, for a client that gets the complete message.
- A compaction summary is not sent again in full when the chunks that went out before it hold the same text.

Every client gets `session/list` in pages of at most 1000 sessions.
A page with more sessions after it has a `nextCursor`, as ACP defines.
A client that does not follow `nextCursor` sees only the newest 1000 sessions of the directory.
An unknown cursor gives an `invalidParams` error.

`src/tests/acp-scenarios.test.ts` compares the traffic of a plain client and of Zed with recordings of origin/main.

## Negotiation

### Client declaration

AIR declares its capabilities in the `initialize` request:

```json
{
  "clientCapabilities": {
    "_meta": {
      "jetbrains": {
        "air": {
          "version": 1,
          "capabilities": ["diffPatch", "rawInputRendering", "sessionFailure"]
        }
      }
    }
  }
}
```

The adapter accepts a capability only when all of these are true:

- `version` is a finite integer and is at least `1`.
- `capabilities` is an array.
- The array contains the exact capability name.

A malformed declaration enables no capability.

### Agent declaration

The `initialize` response of an AIR client carries the agent side of the extension:

```json
{
  "_meta": {
    "jetbrains": {
      "air": {
        "version": 1,
        "capabilities": [
          "sessionFailure",
          "agentFileChangeReport",
          "nativeSubagentSessions",
          "asyncTasks",
          "recommendedValue",
          "diffPatch",
          "planFile"
        ],
        "goal": {
          "version": 1,
          "controlMethod": "_session/goal",
          "actions": ["set", "clear"]
        }
      }
    },
    "steering": { "supported": true }
  }
}
```

The agent list does not depend on the capabilities that AIR declares, except `sessionIndex`: the agent lists it, together with `sessionArchive`, `sessionRename` and `sessionListSubscribe`, only for a client that declared `sessionIndex`.
An extension is active only when the client declared its capability. The client does not declare `sessionArchive`, `sessionRename` and `sessionListSubscribe`.
The response to a client that is not AIR has no `_meta.jetbrains` key.

### Capabilities

| Capability               | Advertised          | What the adapter does when the client declares it                                                            | Section                                                 |
| ------------------------ | ------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------- |
| `diffPatch`              | yes                 | Sends an exact Git patch in the diff block of an Edit or a Write.                                            | [Diff patch](#diff-patch)                               |
| `sessionFailure`         | yes                 | Sends warnings and errors as typed transcript records.                                                       | [Session failure](#session-failure)                     |
| `recommendedValue`       | yes                 | Replaces the `default` model and effort rows with concrete values and a recommendation.                      | [Recommended config values](#recommended-config-values) |
| `asyncTasks`             | yes                 | Publishes background work that is not a subagent as async tasks.                                             | [Async tasks](#async-tasks)                             |
| `agentFileChangeReport`  | yes                 | Accepts a report request on `session/prompt` and sends the changed file list.                                | [Agent file-change report](#agent-file-change-report)   |
| `nativeSubagentSessions` | yes                 | Reports an Agent or Task subagent as a native ACP child session.                                             | [Native subagent sessions](#native-subagent-sessions)   |
| `planFile`               | yes                 | Sends the path of the plan file in place of the plan text of an ExitPlanMode.                                | [Plan file](#plan-file)                                 |
| `sessionIndex`           | on request          | Pages, orders and annotates `session/list`; adds rename, archive and a list subscription.                    | [Session index](#session-index)                         |
| `sessionArchive`         | with `sessionIndex` | Nothing on its own: the agent lists it to tell that it supports `_session/archive` and `_session/unarchive`. | [Archive](#archive)                                     |
| `sessionRename`          | with `sessionIndex` | Nothing on its own: the agent lists it to tell that it supports `_session/rename`.                           | [Rename](#rename)                                       |
| `sessionListSubscribe`   | with `sessionIndex` | Nothing on its own: the agent lists it to tell that it supports `_session/list/subscribe`.                   | [List subscription](#list-subscription)                 |
| `rawInputRendering`      | no                  | Sends no display copy of readable input in `content`. The client renders `rawInput`.                         | [Tool call contract](#tool-call-contract)               |

The adapter ignores `planContentDelta`.
Claude does not stream a plan, so the adapter never sends `contentDelta` (see [Plan file](#plan-file)).

The goal extension has no client capability.
The agent advertises the `goal` object, and the client uses the control method when it wants to.

## AIR metadata keys

Every payload goes into `_meta.jetbrains.air`, next to `version: 1`.
The adapter merges a payload into an existing `_meta` and keeps the other namespaces.
The adapter sends these keys only to an AIR client. "AIR" in the Gate column means an AIR client without a further capability.

| Key                            | Message and field path                                                                | Shape                                                                  | Gate                                                                                   |
| ------------------------------ | ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `capabilities`                 | `initialize` response `_meta.jetbrains.air`                                           | string array                                                           | AIR                                                                                    |
| `goal`                         | `initialize` response `_meta.jetbrains.air`                                           | `{version: 1, controlMethod, actions}`                                 | AIR                                                                                    |
| `goal`                         | `session_info_update._meta.jetbrains.air`                                             | goal snapshot or `null`                                                | AIR                                                                                    |
| `diffPatch`                    | tool call and permission request `content[]` of type `diff`, `_meta.jetbrains.air`    | `{version: 1, format: "git_patch", text}`                              | `diffPatch`                                                                            |
| `permission`                   | `session/request_permission` request `_meta.jetbrains.air`                            | `{version: 1, title, description?, defaultToNo?}`                      | AIR                                                                                    |
| `recommendedValue`             | `model` and effort config options, `_meta.jetbrains.air`                              | option value string                                                    | `recommendedValue`                                                                     |
| `asyncTasks`                   | Bash `tool_call_update._meta.jetbrains.air`                                           | `{backgrounded: true}`                                                 | `asyncTasks`                                                                           |
| `agentFileChangeReportRequest` | `session/prompt` request `_meta.jetbrains.air` (client to agent)                      | `{version: 1, requestId}`                                              | `agentFileChangeReport`                                                                |
| `agentFileChangeReport`        | `session_info_update._meta.jetbrains.air`                                             | report object                                                          | `agentFileChangeReport`                                                                |
| `sessionFailure`               | `session_info_update._meta.jetbrains.air` or `PromptResponse._meta.jetbrains.air`     | failure record                                                         | `sessionFailure`                                                                       |
| `commandTitle`                 | Bash and PowerShell tool call `_meta.jetbrains.air`                                   | the `description` input string                                         | AIR                                                                                    |
| `subagent`                     | Agent and Task tool call `_meta.jetbrains.air`                                        | `true`                                                                 | AIR                                                                                    |
| `skill`                        | Skill tool call `_meta.jetbrains.air`                                                 | `{name, path?}`                                                        | AIR                                                                                    |
| `contextCompaction`            | compaction tool call or `compaction_update`, `_meta.jetbrains.air`                    | `{version: 1, trigger?, preTokens?, postTokens?, durationMs?, error?}` | AIR                                                                                    |
| `customAnswer`                 | elicitation schema property `_meta.jetbrains.air`                                     | `{questionId, isCustomAnswer: true}`                                   | AIR, when the client supports form elicitation                                         |
| `kind`                         | session mode `_meta.jetbrains.air` and mode config option value `_meta.jetbrains.air` | `standard`, `plan`, `auto_review`, or `full_access`                    | AIR                                                                                    |
| `kind`                         | available command `_meta.jetbrains.air` of a skill                                    | `skill`                                                                | AIR, when the skill's `SKILL.md` is found; not for a built-in command or an MCP prompt |
| `skillPath`                    | available command `_meta.jetbrains.air` of a skill                                    | absolute path of the skill's `SKILL.md`                                | AIR, together with `kind: "skill"`                                                     |
| `fork`                         | `session/fork` request `_meta.jetbrains.air` (client to agent)                        | `{version: 1, messageId, messageFingerprint?, messageOccurrence?}`     | none                                                                                   |

## JetBrains shared keys

These keys are JetBrains conventions outside the AIR namespace.
Other JetBrains ACP clients and adapters use them too.
The adapter keeps them where they are.

| Key                     | Where                                                                                                                                     | Meaning                                                                            |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `terminal_output_delta` | client `initialize` `clientCapabilities._meta.terminal_output_delta: true`; tool call `_meta.terminal_output_delta = {terminal_id, data}` | The client appends the command output. The flag also enables the terminal channel. |
| `is_mcp_tool_call`      | `tool_call._meta.is_mcp_tool_call: true`, AIR only                                                                                        | The tool call is an MCP tool call (`mcp__*`).                                      |
| `steering`              | `initialize` response `_meta.steering = {supported: true}`                                                                                | The agent accepts `_session/steering` for a running turn.                          |
| `quota`                 | `PromptResponse._meta.quota`                                                                                                              | Token usage of the turn, also split by model.                                      |
| `authStatus`            | `initialize` response `agentCapabilities._meta.authStatus`                                                                                | The agent pushes `_auth/status_update`. The object carries no payload.             |

## Zed conventions

The adapter keeps these Zed and upstream conventions unchanged for every client.
An AIR client that declares `terminal_output_delta` gets appends instead of `terminal_output`.

- A client that declares `clientCapabilities._meta.terminal_output: true` gets the terminal channel.
  A command tool call then has `content: [{type: "terminal", terminalId}]` and `_meta.terminal_info = {terminal_id}`.
  The output goes in `_meta.terminal_output = {terminal_id, data}`.
  The end sends `_meta.terminal_exit = {terminal_id, exit_code, signal: null}`.
- A client that declares neither `terminal_output` nor `terminal_output_delta` gets no terminal.
  The command output is a `console` code block in `content`.
- A client that declares `clientCapabilities._meta["terminal-auth"]: true` gets `_meta["terminal-auth"] = {command, args, label}` on the terminal login methods.
- The upstream `_meta.claudeCode.*` keys stay as they are.
  Examples are `claudeCode.toolName`, `claudeCode.parentToolUseId`, `claudeCode.toolResponse`, `claudeCode.nonExecutionKind`, and `claudeCode.options` on `session/new`.
  A client that is not AIR gets the full PostToolUse `toolResponse`. AIR gets only its `status` and `isAsync` markers.

The terminal id is the tool use id.
Claude reports a command once, when it ends, so the output travels in one update.
`rawOutput.formatted_output` and `rawOutput.exit_code` are not sent.

## Tool call contract

An AIR client gets the standard ACP tool call shape, and each fact goes in exactly one field.
A client that is not AIR gets the upstream fields (see [Compatibility rule](#compatibility-rule)).
The table [Claude tools and ACP fields](#claude-tools-and-acp-fields) names the differences.

| Fact                                                                                    | The only field that carries it                                                          |
| --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Tool parameters                                                                         | `rawInput`, once they are complete, and again only when they change                     |
| File text of an Edit or a Write                                                         | the diff in `content`, a patch when `diffPatch` is negotiated, never also in `rawInput` |
| Result to show (read text, search hits, subagent report, fetch answer, MCP text result) | `content`                                                                               |
| Result without a display form (ExitPlanMode rejection reason)                           | `rawOutput`                                                                             |
| Command output                                                                          | the terminal channel, or a code block in `content` without one                          |
| Status, title, kind, locations                                                          | the field itself, only when it changes                                                  |

Rules:

- An update carries only the fields that changed since the last report of that tool call.
- For an AIR client, the adapter also leaves out the unchanged `_meta` keys of a `tool_call_update`.
  It compares the keys of `claudeCode`, the keys of `jetbrains.air`, `is_mcp_tool_call`, and `terminal_info`.
  It never leaves out `terminal_output`, `terminal_output_delta`, `terminal_exit`, or `mcp_output_delta`, because the client appends their data.
  An AIR client merges these `_meta` keys into the tool call.
  A client that is not AIR gets the full `_meta` on each update.
- `rawInput` goes out only when the input is complete. A partial input can refine the title, the kind, and the locations.
- Input is never copied into `title` or `_meta`, with two exceptions.
  The `title` of a command, a read, a search, or a fetch names the command, the path, the query, or the URL.
  Zed shows the title as that label.
  `_meta.jetbrains.air.commandTitle` carries the description of a shell command for AIR.
- Some input is text that the user reads: a plan to approve, a subagent prompt, a question, a command description, a fetch prompt.
  A client that declares `rawInputRendering` gets no copy of it in `content`.
  Every other client gets one display copy of that input in `content`, so Zed keeps its rendering.
  A command with a terminal never gets a display copy.
- The raw `tool_result` goes to `rawOutput` only when no other field carries the result.
- `title` is a short label. It is not the output.
- A progress beat of a tool call that the client does not know goes to the parent tool call.
  Its `_meta.claudeCode.toolName` then names the parent tool, or is absent when the adapter does not know that tool.
- Streamed message text is not sent again in full when the complete message arrives. This applies to subagents too.
- A compaction summary is not sent again in full at the end when the chunks that went out before it hold the same text.

### Adapter structure

- A `ToolReporter` per Claude tool reads the SDK data once and produces tool facts.
- One `AcpToolCallRenderer` turns the facts into ACP fields.
  It reads the client choices from one `ClientCapabilities` object.
- A `ToolCallFieldTracker` drops the fields that an earlier report of the same tool call already sent, for every client.
- The `jetbrains.air` capabilities are AIR capabilities.
  The adapter does not treat them as a generic client feature.
- `ClientCapabilities.air.client` is true for an AIR client. Each AIR-only choice of the renderer reads it.

## Claude tools and ACP fields

The table shows the fields that differ between AIR and a client that is not AIR.
A field that the table does not name is the same for every client.

For every tool, a client that is not AIR also gets these upstream fields:

- The first `tool_call` of a streamed tool use carries `rawInput: {}`. Each partial refinement carries the partial input as `rawInput`.
- `rawOutput` repeats the raw `tool_result` unless the terminal channel carried it. AIR gets `rawOutput` only when no other field carries the result.
- The PostToolUse hook sends an update with the full `claudeCode.toolResponse` for every tool.
- A permission denial carries `claudeCode.toolResponse = {decisionReasonType, decisionReason, message}`.
- A permission request repeats the whole tool call (see [Tool call of the request](#tool-call-of-the-request)).
- Each `plan` of the Task* tools goes out, also when it repeats the previous plan.
- The streamed text of a subagent goes out on the root session.
  AIR gets it only with native subagent sessions, the `subagent-transcript` capability, or the `forwardSubagentText` option.

| Claude tool                                                    | Shape for every client                                                                                                        | AIR                                                                                                                                                                                            | A client that is not AIR                                                                         |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `Bash`, `PowerShell`                                           | `kind: execute`, `title` is the command. Terminal channel or a `console` code block, see [Zed conventions](#zed-conventions). | `_meta.jetbrains.air.commandTitle` holds the description. With `rawInputRendering`, no copy of the description in `content`. With `asyncTasks`, `_meta.jetbrains.air.asyncTasks.backgrounded`. | The final update repeats `content: [{type: "terminal"}]`.                                        |
| `Read`                                                         | `kind: read`, `title: "Read <path>"` with the line range, `locations` with the line. The file text goes to `content`.         | none                                                                                                                                                                                           | none                                                                                             |
| `Write`                                                        | `kind: edit`, `title: "Write <path>"`, a `diff` block with the new content. The PostToolUse hook sends the final diff.        | `rawInput` has no `content`. With `diffPatch`, a creation patch in the tool call for a missing file, and an exact patch after the write.                                                       | `rawInput` keeps `content`.                                                                      |
| `Edit`                                                         | `kind: edit`, `title: "Edit <path>"`, a `diff` block of the snippet. The PostToolUse hook sends the final diff.               | `rawInput` has no `old_string` or `new_string`. With `diffPatch`, an exact preview patch in the permission request and an exact patch after the edit.                                          | `rawInput` keeps `old_string` and `new_string`.                                                  |
| `NotebookEdit`                                                 | The result text goes to `content`, unless AIR shows the cell source.                                                          | `kind: edit`, a title such as `Edit cell <id> in <path>`, the cell source in `rawInput` and, without `rawInputRendering`, once in `content`.                                                   | `title: "NotebookEdit"`, `kind: other`, no content before the result.                            |
| `Glob`, `Grep`                                                 | `kind: search`, a title that names the pattern. `Grep` uses the equivalent grep command line. The result goes to `content`.   | none                                                                                                                                                                                           | none                                                                                             |
| `WebFetch`                                                     | `kind: fetch`, `title: "Fetch <url>"`. The answer goes to `content`.                                                          | With `rawInputRendering`, no copy of the prompt in `content`.                                                                                                                                  | none                                                                                             |
| `WebSearch`                                                    | `kind: fetch`, `title: "Search \"<query>\""`. The hits go to `content`.                                                       | none                                                                                                                                                                                           | none                                                                                             |
| `Agent`, `Task`                                                | `kind: think`, `title` is the description. The report goes to `content` without the model-directed trailer.                   | `_meta.jetbrains.air.subagent: true`. With `rawInputRendering`, no copy of the prompt in `content`. With native subagent sessions, the subagent is a child session.                            | none                                                                                             |
| `ExitPlanMode`                                                 | `kind: switch_mode`, `title: "Approve Plan"`, `title: "Exited Plan Mode"` after the approval.                                 | `rawInput.planFilePath` in place of the plan text with `planFile`. The rejection reason goes to `rawOutput` only. With `rawInputRendering`, no copy of the plan in `content`.                  | The rejection reason goes to `content` and to `rawOutput`, and the approval text to `rawOutput`. |
| `AskUserQuestion`                                              | `kind: other`. The questions go to ACP form elicitation.                                                                      | `title: "Asking for your input"`. With `rawInputRendering`, no copy of the questions in `content`. See [Question custom answers](#question-custom-answers).                                    | The title of a single question is the question.                                                  |
| `Skill`                                                        | `kind: other`, `title: "Load skill: <name>"`.                                                                                 | `_meta.jetbrains.air.skill`.                                                                                                                                                                   | none                                                                                             |
| `TodoWrite`, `TaskCreate`, `TaskUpdate`, `TaskList`, `TaskGet` | The stream reports them as a standard `plan` with entries. Only a permission request shows them as a tool call.               | A plan that repeats the previous plan is not sent.                                                                                                                                             | Every plan goes out.                                                                             |
| `ReportFindings`                                               | `kind: think`, `title: "Report <n> findings"`.                                                                                | With `rawInputRendering`, no copy of the findings in `content`.                                                                                                                                | none                                                                                             |
| MCP tools (`mcp__*`) and other tools                           | `kind: other`, `title` is the tool name. The result text goes to `content`.                                                   | `_meta.is_mcp_tool_call` for MCP.                                                                                                                                                              | none                                                                                             |
| Context compaction                                             | `compaction_update` when the client declares `session.compaction`. Otherwise a synthetic tool call.                           | Both forms carry `_meta.jetbrains.air.contextCompaction`.                                                                                                                                      | See [Context compaction](#context-compaction).                                                   |
| Background work that is not a subagent                         | none                                                                                                                          | With `asyncTasks`, async task updates.                                                                                                                                                         | none                                                                                             |

## Diff patch

The diff patch extension lets the adapter send one compact Git patch instead of file text snapshots.
It applies to an ACP `diff` content block.

### Activation

The adapter uses patch mode only when the client declares `diffPatch`.
The agent advertises `diffPatch` to an AIR client.
Without the client declaration, the adapter sends the standard `oldText` and `newText` values.

### Diff content

Patch mode puts the payload at `_meta.jetbrains.air.diffPatch`:

```json
{
  "type": "diff",
  "path": "/workspace/src/App.ts",
  "oldText": null,
  "newText": "",
  "_meta": {
    "jetbrains": {
      "air": {
        "version": 1,
        "diffPatch": {
          "version": 1,
          "format": "git_patch",
          "text": "diff --git a/workspace/src/App.ts b/workspace/src/App.ts\n--- a/workspace/src/App.ts\n+++ b/workspace/src/App.ts\n@@ -1 +1 @@\n-old\n+new\n"
        }
      }
    }
  }
}
```

| Field     | Type    | Meaning                                          |
| --------- | ------- | ------------------------------------------------ |
| `version` | integer | Must equal `1`.                                  |
| `format`  | string  | Must equal `git_patch`.                          |
| `text`    | string  | One unified Git patch for the file of the block. |

The patch rules:

- The patch contains file headers and at least one `@@` hunk. The headers follow `git diff`.
- The path loses its leading slash and gets the `a/` and `b/` prefixes.
- A Windows path uses forward slashes.
- The adapter quotes a path as Git does with the default `core.quotePath`.
  A double quote, a backslash, a control byte, or a non-ASCII byte makes Git quote the path.
- A `---` or `+++` line ends with a tab when the path contains a space.
- An added file has a `new file mode 100644` line and uses `/dev/null` as the old file header.
- No Claude file tool deletes a file, so the adapter never sends a deleted file.
- A file without a final newline ends with the `\ No newline at end of file` marker.
- A patch never contains a CR byte. A file with a CR gets the standard diff.

In patch mode, `oldText: null` and `newText: ""` are placeholders that satisfy the ACP schema.
They are not file snapshots or changed fragments.
The receiver must use `diffPatch.text` as the change payload.
The receiver derives line counts and changed fragments from the patch.

### Fallback

When the adapter cannot build an exact patch, it sends the standard ACP diff.
That diff contains meaningful `oldText` and `newText` values and has no `diffPatch`.

A block that carries `diffPatch` has no usable text fields.
A receiver that rejects the patch must show the change as unavailable.
It must not render the placeholders as an empty file.
Unknown fields do not make a valid payload invalid.

### Claude behavior

Before an `Edit` or `Write` approval, the adapter reads the target file and applies the tool input in memory.
The preview uses the tool input as it is.
Claude can remove the trailing whitespace of a line before it writes, so the preview can differ in that whitespace.
The PostToolUse hook then sends the patch of the written file.
An `Edit` with an empty `new_string` also removes the line break after `old_string`, and the preview does the same.
This applies when `old_string` does not end with a line break and the file holds `old_string` and a line break.

This keeps a 12,000-line file out of the approval payload when the change is small.
The adapter sends no preview patch in these cases, and the tool call keeps its standard diff:

- The file is larger than 1 MiB, is binary, is not valid UTF-8, or contains a CR.
- The new text is larger than 1 MiB, or contains a NUL or a CR.
- The `Edit` file is missing for a non-empty `old_string`.
- The `old_string` does not match exactly once, and `replace_all` is not set.
- The change leaves the file unchanged.

An `Edit` input holds a snippet, not the file.
The tool call therefore shows the standard diff of the snippet until a preview or the final patch replaces it.
A live `Write` tool call shows the path and no diff, because its input does not tell whether the file exists.
The adapter reads the file only for the approval preview, so a session without approvals reads no file before the Write.
The approval shows the patch, the standard diff of a text that cannot have an exact patch,
or a notice that the Write overwrites a file that the adapter cannot show.
The PostToolUse hook then sends the patch of the written file.
The `Write` tool call keeps the file text out of `rawInput`, because a patch holds it.
A `Write` of a loaded session history shows the standard diff without old text, because it has no preview and no hook.
The adapter does not read the file on disk for it: the disk shows a later state than the history.
When the adapter cannot read the current text, the tool call shows a notice that the `Write` overwrites an existing file.
The notice holds no file text, so `rawInput` keeps `content`.

After the tool runs, the adapter diffs the SDK `originalFile` against the file on disk.
It does not use the SDK `structuredPatch` hunks for a patch.
Claude converts leading tabs and CRLF line endings in those hunks, so they do not match the file.
If the written file is too large, binary, or contains a CR or a byte order mark, the adapter sends the standard diff.
A created file gets a creation patch.

## Plan file

AIR shows a plan in one of two modes:

- Streamed text: the agent sends the plan text, and with `planContentDelta` it appends the text in `_meta.jetbrains.air.contentDelta`.
- Plan file: the agent sends the path of a file that holds the plan. The plan card of AIR opens the file.

This adapter uses the plan file mode by default.
Claude writes the plan to a file under `plansDirectory` with Write and Edit while it drafts the plan.
The default `plansDirectory` is `~/.claude/plans/`.
The file is the single source of the plan, so AIR reads the plan from the file and not from a copy.
Claude does not stream a plan, so the adapter never uses the streamed text mode.

### Activation

The agent advertises `planFile` to an AIR client in the `initialize` response (see [Agent declaration](#agent-declaration)).
AIR reads `rawInput.planFilePath` only from an agent that advertised `planFile`.
The adapter sends the path only when the client declares `planFile` too:

```json
{
  "clientCapabilities": {
    "_meta": {
      "jetbrains": { "air": { "version": 1, "capabilities": ["planFile"] } }
    }
  }
}
```

### Claude source

The model calls ExitPlanMode with no plan.
The CLI adds two keys to the complete input: `plan` holds the text of the plan file, and `planFilePath` holds its absolute path.
The CLI adds them only when the plan file exists.

| Stage                                    | What the adapter gets                                    |
| ---------------------------------------- | -------------------------------------------------------- |
| Streamed tool input                      | The input of the model: no `plan` and no `planFilePath`. |
| Complete assistant message               | `plan` and `planFilePath`.                               |
| `canUseTool`                             | `plan` and `planFilePath`.                               |
| Structured tool result, PostToolUse hook | `plan` and `filePath` in the `tool_response`.            |

The adapter keeps the plan text for its own use.
The clear-context choice continues the turn with the plan text.

### ExitPlanMode reports

For a `planFile` client, each ExitPlanMode report that carries `rawInput` has the path and no plan text:

```json
{ "rawInput": { "planFilePath": "/Users/me/.claude/plans/tidy-plan.md" } }
```

| Report             | Fields                                                                                                    |
| ------------------ | --------------------------------------------------------------------------------------------------------- |
| `tool_call`        | `title: "Approve Plan"`, `kind: switch_mode`, no `rawInput` while the input streams, and empty `content`. |
| Refinement         | `rawInput.planFilePath` when the complete message arrives.                                                |
| Permission request | `toolCall.rawInput.planFilePath`, and the `Ready to code?` permission title.                              |
| Result             | `status`, `title: "Exited Plan Mode"`, the rejection reason in `rawOutput`, and `rawInput.planFilePath`.  |

The path is absolute, and it names a regular file.
The field tracker drops a `rawInput` that repeats the value that the client holds.
The result sends the path of the structured result when the input named no file.
While the adapter does not know the path, a report carries no `planFilePath` key.
The adapter never sends a blank path, because AIR reads a present non-file value as a retraction.
Without `rawInputRendering`, a `planFile` client gets no copy of the plan in `content` either.

### Fallback

The plan text goes out as before in these cases:

- The client does not declare `planFile`.
- The input names no plan file. An older CLI sends the plan only inline.
- The plan file does not exist.

`rawInput` then is the SDK input with `plan`, and the input `planFilePath` when it is present.
AIR then shows the in-memory `plan` text.
A client that is not AIR always gets the whole SDK input, like upstream.

## Permission presentation

The adapter uses standard ACP permission requests and responses.
The optional `_meta.jetbrains.air.permission` record adds compact presentation text for an AIR client.
`RequestPermissionRequest.toolCall`, `options`, `RequestPermissionResponse.outcome`, and the `kind` of each option stay authoritative.
The record needs no further capability. A client that is not AIR gets no record.

### Request lifecycle

When the Claude Agent SDK calls `canUseTool`, the adapter:

1. stops at once if the tool-call signal is already aborted;
2. makes sure that the ACP `tool_call` was sent;
3. validates the SDK `suggestions: PermissionUpdate[]` and takes a snapshot of them;
4. builds the presentation and the ordered option list for the tool;
5. sends `session/request_permission` with the cancellation signal of the tool call;
6. checks that the selected option was offered in that exact request;
7. maps the selection to a Claude SDK `PermissionResult`.

The `tool_call` always goes out before the permission request.
If that announcement fails, the adapter removes its duplicate marker, so the streamed tool-use path can send it again.

### Request

```json
{
  "sessionId": "session-1",
  "toolCall": {
    "toolCallId": "toolu_1",
    "title": "npm test",
    "rawInput": { "command": "npm test", "description": "Run the tests" }
  },
  "options": [
    { "optionId": "allow-once", "name": "Yes", "kind": "allow_once" },
    { "optionId": "reject", "name": "No", "kind": "reject_once" }
  ],
  "_meta": {
    "jetbrains": {
      "air": {
        "version": 1,
        "permission": {
          "version": 1,
          "title": "npm test",
          "description": "Reason: Needed to verify the change."
        }
      }
    }
  }
}
```

| Field         | Required | Type             | Meaning                                                                                                                                    |
| ------------- | -------: | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `version`     |      yes | integer `1`      | The schema version of the record.                                                                                                          |
| `title`       |      yes | non-empty string | The approval heading.                                                                                                                      |
| `description` |       no | string           | The SDK `decisionReason` with the prefix `Reason: `. It is a temporary diagnostic.                                                         |
| `defaultToNo` |       no | `true`           | A stray keystroke must not approve the request. The reject options come first. A client that pre-selects an option must focus the decline. |

The permission title is normally the same as `toolCall.title`. One operation has one heading on the tool card and in the approval.
`ExitPlanMode` is the exception. Its permission title is `Ready to code?`.
The adapter does not copy the SDK `description` subtitle into the record.

### Tool call of the request

For AIR, the request `toolCall` carries `toolCallId`, `title`, and `rawInput`.
The client already has the rest of the tool call, because the adapter sends the `tool_call` first.

- `title` is the standard tool call title. A Sandbox Network request uses the host. A Computer Use request uses the display name.
- `rawInput` is the SDK input. An Edit or a Write leaves out the file text, because the diff holds it.
  An ExitPlanMode for a `planFile` client carries the plan file path and not the plan text (see [Plan file](#plan-file)).
- `content` is present only with an exact preview patch for a `diffPatch` client.
- `locations` is present only when a valid `blockedPath` is not a location of the tool call yet.
- `_meta.claudeCode.mcpServer` names the MCP server of an `mcp__*` tool.

A client that is not AIR gets the upstream request `toolCall`: `toolCallId`, `name`, `status: pending`, the whole `rawInput`, `title`, `kind`, `content`, and `locations`.
Its `_meta.claudeCode` carries `toolName`, and `parentToolUseId` for a subagent tool call, next to `mcpServer`.
A Sandbox Network or Computer Use request without content shows its input as a JSON code block.

Compact text removes control characters, collapses whitespace where it is safe, and enforces length limits.
The adapter omits an invalid optional text. It does not truncate it into misleading UI.
A shell title (`Bash`, `PowerShell`) keeps the full command, with its whitespace and line breaks, and has no length limit.

### Options

The options are fixed. The client cannot edit them.
When a durable suggestion holds a command prefix, a path, a host, or another rule, the option name contains that value.
An example is `Yes, and don't ask again for npm test commands`.
The selected option applies the exact snapshot of the Claude SDK `PermissionUpdate`.
A selected reject is not the same as `{ "outcome": "cancelled" }`. Cancellation stops the tool use.

| Option id                      | Meaning                                                         |
| ------------------------------ | --------------------------------------------------------------- |
| `allow-once`                   | Allow this call without a change to the permission state.       |
| `allow-with-updates`           | Allow and apply the durable effect that the name shows.         |
| `allow-skill-exact`            | Allow the exact Skill invocation in local settings.             |
| `allow-skill-prefix`           | Allow the parameterized Skill prefix in local settings.         |
| `exit-plan-auto`               | Exit plan mode and set the session mode to `auto`.              |
| `exit-plan-bypass`             | Exit plan mode and set the session mode to `bypassPermissions`. |
| `exit-plan-accept-edits`       | Exit plan mode and set the session mode to `acceptEdits`.       |
| `exit-plan-default`            | Exit plan mode and set the session mode to `default`.           |
| `exit-plan-clear-auto`         | Clear the context, continue the plan, and use `auto`.           |
| `exit-plan-clear-bypass`       | Clear the context, continue the plan, and bypass permissions.   |
| `exit-plan-clear-accept-edits` | Clear the context, continue the plan, and accept edits.         |
| `reject`                       | Deny the call. Feedback to Claude is optional.                  |

The adapter groups the options as `allow_once`, then `allow_always`, then the reject kinds.
Options of the same kind keep their builder order.
The client must return the selected option id unchanged.

### Durable SDK suggestions

Before a suggestion can become a durable choice, the adapter validates the complete array and clones it.
The validation recognizes:

- `addRules`, `replaceRules`, and `removeRules`;
- `setMode` for known Claude permission modes;
- `addDirectories` and `removeDirectories`;
- known destinations and rule behaviors;
- bounded array sizes and bounded non-empty strings.

The adapter omits unknown update types, invalid values, oversized bundles, data that cannot be cloned, and empty arrays.
The snapshot keeps the shown label equal to the effect that the adapter applies after a late response.
The adapter offers a suggestion only when the tool builder can describe the whole effect.
It never labels one part of a mixed bundle and applies the rest silently.
When `matchedAskRule` is present, the adapter offers no persistent choice. A configured `ask` rule must keep asking.

### Choices per tool

| Tool family               | Choices and effects                                                                                                          |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Bash, PowerShell          | One-time allow; an exact representable SDK bundle with its complete effect in the label; reject.                             |
| Read, Glob, Grep          | One-time allow; a matching session-scoped read grant; reject.                                                                |
| Edit, Write, NotebookEdit | One-time allow; a matching session edit grant, including `.claude` handling; reject.                                         |
| WebFetch                  | One-time allow; a generated `domain:<hostname>` local rule; reject.                                                          |
| Skill                     | One-time allow; exact skill and optional `prefix:*` local rules; reject.                                                     |
| EnterPlanMode             | Enter plan mode once, or reject and continue.                                                                                |
| ExitPlanMode              | One keep-context and one clear-context elevated mode (`auto` before bypass before accept edits), manual approval, or reject. |
| SandboxNetworkAccess      | One-time allow; the exact SDK host rule when representable; reject.                                                          |
| Computer Use MCP          | One-time allow; an exact representable SDK allow suggestion; reject.                                                         |
| MCP                       | One-time allow; an exact representable SDK allow suggestion for that tool; reject.                                           |
| WebSearch, Agent, Task    | One-time allow; a generated whole-tool local rule; reject.                                                                   |
| ReviewArtifact, Workflow  | The generic fallback until the SDK exposes the renderer state.                                                               |
| Monitor, unknown tools    | The generic fallback.                                                                                                        |

Generated WebFetch, Skill, and non-MCP fallback effects use `localSettings`.
The adapter offers a filesystem grant only when the SDK bundle is session-scoped and covers the current path.
A shell label can describe command rules, read paths, additional directories, or a representable combination.
`AskUserQuestion` is not a permission dialog. See [Question custom answers](#question-custom-answers).

### Permission modes

The session offers the Claude modes of the current model with the Claude Code labels:
`Manual`, `Accept edits`, `Plan`, `Auto` when available, and `Bypass permissions` when available.
The mode ids are the Claude SDK ids: `default`, `acceptEdits`, `plan`, `auto`, and `bypassPermissions`.
`Manual` keeps the SDK id `default`. `manual` is only a settings alias.
The adapter accepts the internal `dontAsk` mode from settings but does not offer it.

A host removes `Bypass permissions` with `_meta.claudeCode.options.allowDangerouslySkipPermissions: false` on `session/new` and on `session/load`.
A `bypassPermissions` settings default then falls back to `default`.

`ExitPlanMode` offers one elevated keep-context choice by priority: `auto`, then `bypassPermissions`, then `acceptEdits`.
A non-empty plan also gets one clear-context choice with the same priority.
After that choice, the adapter stops the old private Claude query and hides that internal rejection.
It starts a new private query under the same ACP session.
It continues the turn with `Implement the following plan:` and the complete plan.
The mode, model, agent, effort, Fast mode, and turn usage stay the same.
The SDK cannot apply `allowedPrompts` again, so those hints do not survive the handoff.

The adapter does not allow a callback only because the session mode is `bypassPermissions`.
Claude Code applies bypass before it calls `canUseTool`.
A request that still arrives is bypass-immune, safety-sensitive, interactive, or forced by an explicit ask rule.

### Cancellation and failures

The adapter forwards the SDK `AbortSignal` of the tool call to the client.
It also races the request against the same signal, so a client that ignores cancellation cannot block the tool call.
These cases stop the tool use with `Tool use aborted`:

- the signal was already aborted;
- the signal aborts while the request is open;
- the client returns a cancelled outcome;
- the client rejects after cancellation.

A normal selected reject returns `behavior: "deny"`, `decisionClassification: "user_reject"`, and the default refusal message.

### Client requirements

A client that implements version 1:

- renders the standard tool call content and locations as the action subject;
- treats `title` and `description` of the record as optional hints;
- keeps option ids unchanged;
- ignores unknown `_meta` fields and future feature names;
- settles the request when its cancellation signal fires.

The client must not infer scope, lifetime, or effect from `kind` or the button text.
The adapter owns the Claude `PermissionUpdate` and applies it only after it validates the response.

### Current limits

The SDK does not expose enough renderer state for every Claude Code dialog. Version 1 does not implement:

- Bash output-redirection rewriting;
- classifier-specific prompt state;
- ExitPlanMode Ultraplan actions;
- Computer Use macOS TCC or application allowlist dialogs;
- structured permission lifetime or storage metadata for clients.

When a durable effect cannot be shown honestly, the adapter offers only one-time allow and reject.

## Goal

The goal extension exposes a long-running, session-scoped objective.
It is shaped like a possible future first-class ACP API.
The payload has no provider-specific fields.

The goal extension applies only to an AIR client.

### Capability

The `initialize` response to AIR advertises the goal support:

```json
{ "version": 1, "controlMethod": "_session/goal", "actions": ["set", "clear"] }
```

`actions` is the subset of `set`, `pause`, `resume`, and `clear` that the adapter supports.
A client must not assume support for an action that is not advertised.

### Control request

The client sends `_session/goal` with `sessionId` and `action`.
`set` also requires a non-blank `objective`.
Any other action fails with `invalidParams`.

When a goal turn runs, the adapter injects the matching `/goal` command at steering priority `now`.
The command then cannot wait behind the Stop-hook workflow.
On an idle session, the adapter uses the ordinary prompt lifecycle.
Cancelling a turn does not clear the goal. A client uses the control method to replace or remove it.

### Session state

The adapter publishes the current snapshot in `session_info_update._meta.jetbrains.air.goal`.
Clearing a goal publishes `goal: null`.

```json
{
  "objective": "Ship the change",
  "status": "active",
  "iterations": 3,
  "lastReason": "Tests still need work",
  "createdAt": 1710000000123,
  "controlMethod": "_session/goal"
}
```

The statuses are `active`, `paused`, `blocked`, `limited`, and `complete`.
Timestamps are Unix milliseconds.

### Lifecycle

A goal belongs to the ACP session, not to one `session/prompt` request.
Goal activity and prompt activity are independent:

- `status: active` means that the objective can drive more work. It does not mean that a prompt runs now.
- A prompt completes when its backend turn reaches a quiet boundary, also when the goal stays active.
- A later autonomous cycle can publish more session updates outside that completed prompt.
- While a turn runs, a client uses steering or prompt queueing when advertised.
  While the session is quiet, a client can send an ordinary `session/prompt`.

This separation keeps a goal from holding the prompt slot of the session.
A client can show "working now" apart from "objective still active".

### Claude mapping

The Claude `/goal` command installs a Stop hook for the session.
The runtime sends internal `active_goal` messages when that hook updates or clears its state.
The adapter maps them into the neutral snapshot:
`condition`, `iterations`, `set_at`, and `last_reason` become `objective`, `iterations`, `createdAt`, and `lastReason`.
The adapter does not expose provider bookkeeping such as `tokens_at_start`.

Some Claude runtime versions start the goal without the first `active_goal` message.
The adapter therefore publishes a minimal active snapshot when it submits `/goal <condition>`.
It publishes `goal: null` for `/goal clear`.
While that command is pending, the adapter ignores late updates for the previous goal.
A matching runtime `active_goal` stays authoritative and adds the iteration, reason, and timestamp.
A failed command restores the previous state.

## Recommended config values

The `recommendedValue` extension lets a client show concrete model and effort choices without an ambiguous `default` row.
Permission modes and the other config options are outside this extension.

### Activation

The adapter enables the extension only when the client declares `recommendedValue`.
Otherwise it keeps the `default` rows, the current values, and the metadata exactly as before.

### Config option metadata

For each selector that the extension changes, the adapter writes the recommendation at `_meta.jetbrains.air.recommendedValue`:

```json
{
  "id": "model",
  "type": "select",
  "currentValue": "sonnet",
  "options": [
    { "value": "opus", "name": "Claude Opus" },
    { "value": "sonnet", "name": "Claude Sonnet" },
    { "value": "haiku", "name": "Claude Haiku" }
  ],
  "_meta": { "jetbrains": { "air": { "version": 1, "recommendedValue": "sonnet" } } }
}
```

`recommendedValue` always names one of the option values of that selector.
It is independent of `currentValue`. An explicit user choice stays current.

### Model

The SDK `default` model entry can carry a `resolvedModel` that names the model that Claude recommends.
The adapter matches that id exactly to a named model. It accepts the `-1m` and `[1m]` suffix spellings as equal.
It then removes the `default` row and sends the named value as `recommendedValue`.
When the session still uses the SDK default, the same value is the `currentValue`.

If the adapter cannot map the recommendation to a named model, it keeps the `default` row and omits `recommendedValue`.
The client then never gets a value that it cannot select.

Short SDK labels that match their model family get the concrete version from the model metadata.
For example, `Sonnet` becomes `Sonnet 5`, and `Claude Haiku` becomes `Claude Haiku 4.5`.
The adapter omits a context suffix such as `(1M context)` from the label, because the description keeps it.
Custom labels stay unchanged.
If two entries would get the same label, the adapter keeps the original labels.
This label change applies to every client.

### Effort

When the current model supports effort, the adapter removes the `default` effort row and recommends `medium`.
An explicit or settings effort stays the `currentValue`.
An absent or `default` current effort shows as `medium`.

The adapter applies the shown effort to the SDK at session creation and at a model switch.
The selection then matches the effort that Claude uses.
An explicit SDK `options.effort` and a picker choice stay pinned across model switches while the new model supports them.
Otherwise each switch reads the settings of the new model again and then falls back to the recommendation.
A switch to a model without effort support clears the override.
A client without the capability still lets the SDK choose the effort.

If the effort sync fails after the model switched, the adapter reports the new model.
It never shows the unapplied effort as current.
It keeps the last applied value when the new model offers it.
Otherwise it omits the effort selector until a later switch succeeds.
If a model offers no `medium` effort, the adapter uses the first effort that the SDK offers.

### SDK upgrade check

The test suite pins the SDK version whose Opus label was verified.
Before an SDK update, run the live contract test in an authenticated environment:

```sh
RUN_INTEGRATION_TESTS=true npx vitest run src/tests/model-presentation.test.ts
```

Review the changes to the Opus entries and labels before you update the version guard.
The live test only initializes the SDK. It sends no model prompt.

## Async tasks

Claude can run work in the background, for example a backgrounded Bash command or a workflow.
The adapter publishes that work as async tasks when the client declares `asyncTasks`.
Without the capability, the adapter sends no async task update.
A subagent task (`local_agent`) is not an async task. Native subagent sessions report it.
A task that a `Monitor` tool call started is not an async task either.
Monitor streams its output to the model only, so the client gets nothing for it.
The SDK reports such a task as `local_bash`, so the adapter finds it by the tool of its tool call.
The `Monitor` tool call stays in the transcript.
The adapter also ignores a `local_monitor` task.
A task that a subagent tool call started goes to the subagent session.
Its spawn, progress and state updates go there also after the subagent finished.

### Updates

- `async_task_spawned` has `asyncTaskId`, `name`, `taskType`, `description`, `showInTranscript`, `canStop: true`, and optional `outputFilePath` and `toolCallId`.
  `taskType` is `shell`, `workflow`, `monitor`, `task`, or the SDK value.
  `showInTranscript` is `false` when the SDK asks to skip the transcript.
- `async_task_progress` carries only the changed fields: `description`, `summary`, `lastToolName`, `usage`, `outputFilePath`, and `toolCallId`.
- `async_task_state_update` carries `state` (`running`, `paused`, `completed`, `failed`, or `stopped`) and an optional `summary`.
- The Bash `tool_call_update` of a backgrounded command carries `_meta.jetbrains.air.asyncTasks.backgrounded: true`.
  The card then shows backgrounded work instead of finished work.
  Only structured data sets the marker: the `backgroundTaskId` of the tool result, a known background task of the tool call, or a `run_in_background` input.

### Task id and output path

An async task comes only from structured data.
The sources are `tool_use_result.backgroundTaskId` and the SDK `task_started`, `task_updated`, and `task_notification`.
The text of a tool result never creates a task, because a foreground command can print any text.
The output path comes from `output_file` of the SDK events when they have it.
Otherwise the adapter reads the text of the tool result of the task's own tool call.
It takes only an absolute path that ends with `tasks/<task id>.output`, followed by a period, whitespace or the end of the text.
The path starts after the nearest `": "` before that end on the same line, so it can hold spaces.
A path never holds the end of another path.
A POSIX, a Windows drive, and a UNC path count. A path across a line does not.
The tool result can come before or after the SDK names the task.
A subagent tool result has no `tool_use_result`, so this text is the only path source there.

### Tool call of a task

The adapter sends `async_task_spawned` only after it knows the tool call that started the task.
The SDK gives that id as `tool_use_id` of `task_started`, `task_progress`, or `task_notification`.
The structured Bash result of a backgrounded command also gives it.
Until the id arrives, the adapter holds the task. It sends no update of a held task.
The progress and state updates of a held task follow its spawn, in their order.
A held task gets its spawn without `toolCallId` when it ends first, or when the prompt result ends the turn.
An id that arrives after such a spawn goes out as `toolCallId` in `async_task_progress`.
The adapter never guesses the tool call from the command text.

### Liveness

The SDK background task list is authoritative for liveness.
When an announced task leaves that list, the adapter reports `stopped`.
A later terminal event can correct that state to `completed` or `failed`.
At shutdown, the adapter finishes each open task as `failed` or `stopped`.

### Stop request

The client sends `_session/async_task/stop`:

```json
{ "sessionId": "session-1", "asyncTaskId": "task-1" }
```

The adapter calls the SDK `stopTask`, publishes `stopped`, and returns `{ "stopped": true }`.
It also adds one `Task stopped by user: <name>.` line to the transcript.
It returns `{ "stopped": false }` for an unknown, finished, or already stopping task.

## Agent file-change report

Standard ACP describes a change from one tool call. It has no complete file list for one prompt turn.
The version 1 `agentFileChangeReport` extension adds that list.

### Request

The client declares `agentFileChangeReport` and adds this object to `session/prompt`:

```json
{
  "_meta": {
    "jetbrains": {
      "air": {
        "agentFileChangeReportRequest": { "version": 1, "requestId": "a-unique-request-id" }
      }
    }
  }
}
```

The request object must have exactly the keys `version` and `requestId`, and `version` must be `1`.
The request id has 1 to 128 characters: ASCII letters, digits, `.`, `_`, `:`, and `-`.
The adapter ignores a malformed request and a repeated request id.

### Report

The adapter sends one `session_info_update` before the `PromptResponse`:

```json
{
  "sessionUpdate": "session_info_update",
  "_meta": {
    "jetbrains": {
      "air": {
        "version": 1,
        "agentFileChangeReport": {
          "version": 1,
          "requestId": "a-unique-request-id",
          "status": "reported",
          "paths": ["/workspace/src/App.ts"],
          "declaredComplete": false,
          "truncated": false
        }
      }
    }
  }
}
```

- Each path is an absolute canonical path in the working directory or in an additional workspace directory.
- The adapter drops paths outside these roots, the roots themselves, and paths with control characters. It then sets `truncated: true`.
- The report has no file content, diff, line count, or path order guarantee.
- The adapter sends at most 1,024 paths. Each path has at most 4,096 characters.
- The serialized report has at most 256 KiB.

### Claude source

With the capability, the adapter enables SDK file checkpointing for the session.
At the end of the turn, it asks the SDK for a dry-run rewind of the turn checkpoint.
The files that the rewind would restore are the report.
Checkpoints cover the Claude file tools. They do not cover Bash and most subagents.
The adapter therefore always sends `declaredComplete: false`.

### Unavailable report

The adapter sends `status: "unavailable"` with a `reason`:

| Reason          | Cause                                                     |
| --------------- | --------------------------------------------------------- |
| `cancelled`     | The prompt was cancelled.                                 |
| `timeout`       | The checkpoint preview did not answer within 2 seconds.   |
| `invalidOutput` | The checkpoint preview cannot rewind or has no file list. |
| `providerError` | The turn failed, or the checkpoint preview failed.        |

A report failure does not change the prompt outcome.
The client must match the request id.
It must ignore a duplicate, stale, malformed, or unavailable report.
Rollback is outside this extension.

## Session failure

The `sessionFailure` extension sends warnings and errors as durable transcript entries.
The client shows them in order beside user, agent, and tool messages.
They are not assistant text and not temporary banners.

### Activation

The extension is active when the client declares `sessionFailure`.
Without it, the existing JSON-RPC errors and transcript text stay unchanged.

### Record

```json
{
  "_meta": {
    "jetbrains": {
      "air": {
        "version": 1,
        "sessionFailure": {
          "id": "prompt-uuid:error",
          "revision": 1,
          "category": "limit",
          "severity": "error",
          "title": "You've hit your individual spend limit · run /usage-credits to ask your admin for a higher limit",
          "actions": []
        }
      }
    }
  }
}
```

| Field      | Required | Type                 | Meaning                                            |
| ---------- | -------: | -------------------- | -------------------------------------------------- |
| `id`       |      yes | non-empty string     | Stable identity of one incident.                   |
| `revision` |      yes | positive integer     | Increasing version of that incident.               |
| `category` |      yes | category             | Broad visual group.                                |
| `severity` |      yes | `warning` or `error` | Inline warning or error presentation.              |
| `title`    |      yes | string               | The complete user-facing text.                     |
| `details`  |       no | string               | Long text that does not fit in `title`.            |
| `reason`   |       no | string               | A machine-readable refinement of the failure kind. |
| `actions`  |      yes | ordered string array | Recovery actions that the adapter recommends.      |

The record has no `phase`, `source`, `safeMessage`, `retryable`, `retryAfterMs`, `turnId`, retry counter, or provider code.
Retry progress goes in `title` when Claude supplies it.
The transcript order and the time come from the ACP event that carries the record.

### Identity and revisions

`id` identifies one occurrence, not an error type.

- The first record of an incident creates one transcript entry at the current stream position.
- The same `id` with a higher `revision` updates that entry in place without moving it.
- The client ignores the same or a lower revision.
- A later, independent occurrence gets a new `id`, also when its category and text are equal.
- Consecutive updates of the same notice can reuse one id with a higher revision.
- The client never deduplicates different ids by title or category.

A live turn failure uses `<turnId>:error`.
A session-scoped incident uses `<sessionId>:session-error:<epoch>:<n>`.
A notice uses `<sessionId>:notice:<epoch>:<n>`. An equal consecutive notice reuses its id.
A replayed usage-limit failure uses the stored user-message UUID as the turn id, so it keeps its live id.
Malformed history without a user message before it uses `<sessionId>:history-error:<messageUuid>`.

A resolved record stays in the transcript history.
Recovery removes only the internal active state of the adapter.
It does not publish a clear record, and it does not delete or rewrite the entry.

### Delivery

- A turn-terminal failure goes on the `PromptResponse._meta` with `stopReason: end_turn`.
- A session-scoped, replayed, warning, or background incident goes in a `session_info_update`.
- A warning does not end a turn.
- An error record does not create ACP lifecycle state. The prompt response or the transport stays authoritative.

### Categories and actions

| Claude condition                                                    | Category     | Severity | Actions                |
| ------------------------------------------------------------------- | ------------ | -------- | ---------------------- |
| `verification_required`, `cloud_credential_error`                   | `service`    | error    | `retry`                |
| `billing_error`, `account_on_hold`, a usage or spend limit          | `limit`      | error    | none                   |
| `rate_limit`                                                        | `limit`      | error    | `retry`                |
| `max_output_tokens`, a turn limit                                   | `limit`      | error    | `new_session`          |
| a configured session budget                                         | `limit`      | error    | `new_session`          |
| `invalid_request`, `model_not_found`                                | `request`    | error    | none                   |
| `overloaded`                                                        | `service`    | error    | `retry`                |
| `server_error`, an unknown provider error                           | `service`    | error    | `retry`                |
| an adapter internal error                                           | `service`    | error    | `retry`, `new_session` |
| transport loss, worker shutdown                                     | `connection` | error    | `new_session`          |
| an API retry (`api_retry`), `connection` when no HTTP response came | as above     | warning  | none                   |
| a model fallback notice                                             | `unknown`    | warning  | none                   |

`authentication_failed`, `oauth_org_not_allowed`, and the synthetic login message get no session failure. The prompt ends with the ACP `authRequired` error.

An unknown SDK error kind becomes `service`. It never becomes a success.
The category drives only the icon and a generic accessibility label.
It does not decide the text or the client behavior.

`warning` means that the operation can still succeed. It does not end the turn.
An SDK `api_retry` reuses the id of the active turn failure. Its title is `Retrying Claude, attempt <n> of <max>.` or `Reconnecting to Claude, attempt <n> of <max>.`
The adapter skips an `api_retry` for a sign-in failure, because the sign-in error follows.
A later terminal failure updates that record with a higher revision.
`error` means that the operation cannot continue without a user action or another request.

The actions of version 1 are `retry`, `login`, and `new_session`.
The adapter orders the actions.
The client filters the actions that it cannot run safely and ignores unknown or duplicate values.
The client must not infer actions from the category.

The model fallback notice also has a standard ACP form.
The client can declare `clientCapabilities.session.notices` from the ACP Session Notices RFD.
Then the adapter sends the notice as an ACP `notice` update and sends no AIR advisory record.
This rule applies also when the client declares `sessionFailure`.

### Title and details

`title` is the complete normal text: what happened, the retry progress when present, and a short next step.
The adapter copies the title from the user-facing text that Claude already sent:

- the top-level assistant error text, including the synthetic usage-limit message;
- otherwise the terminal SDK result or error text;
- the exact model-fallback notice for a warning.

The adapter writes its own text only when Claude sent none, for example when the query iterator throws.
Raw exceptions, stack traces, transport URLs, tokens, headers, environment values, and private paths are never a title.
`details` is only for a required explanation that is too large for `title`.
It is not a place for status text, retry counters, provider payloads, or diagnostics.

### Recovery

Recovery is internal adapter state and is not sent:

- a restored quota failure stays active until a real model answer;
- transport loss and worker shutdown stay active until the runtime is replaced;
- another turn failure stops being active at a later confirmed attempt;
- a generic success does not clear a notice.

Recovery never removes the transcript record.
A new incident does not prove that an older incident recovered.

### History replay

`session/load` scans the top-level assistant history for the SDK synthetic usage-limit messages.
It matches only `<synthetic>` messages that start with the stable SDK prefixes. It does not match model prose.
Each match is replayed as a typed record at its original position.
The latest match stays active until a later real model answer proves recovery.
For a client with the capability, replay suppresses the duplicate assistant text and uses the stored Claude text as `title`.
A client without the capability gets the original transcript and no typed record.

## Native subagent sessions

The adapter implements the draft [ACP subagent RFD](https://github.com/agentclientprotocol/agent-client-protocol/pull/1992).
This section covers only the AIR bridge.

- The canonical client field is `clientCapabilities.subagents: {}`.
- Released ACP SDKs can strip that draft field.
  AIR can instead declare `nativeSubagentSessions` in `_meta.jetbrains.air.capabilities`.
- Either signal enables native subagent sessions. The canonical field takes precedence when it is available.
- The agent advertises `nativeSubagentSessions` to AIR, and `agentCapabilities.sessionCapabilities.subagents` to every client.
- With native sessions, the adapter sends `subagent_spawned` and `subagent_state_update`.
  The child output goes to the child session. The Agent or Task tool call is not the subagent card.
- `subagent_spawned` can carry an optional `prompt`: the exact prompt of the child session.
  The source is the `task_started` prompt, else the Agent or Task input `prompt`.
  A resumed generation gets the SendMessage `message` text.
  The field is absent when the adapter has no prompt. The adapter does not truncate it.
- Without either signal, Agent and Task stay ordinary tool calls. AIR gets `_meta.jetbrains.air.subagent: true` on them.
  Child interactions stay on the root session.
- A client that uses the older `_meta["subagent-transcript"]` capability or the `forwardSubagentText` session option keeps the flat child transcript.

## Session index

The session index makes `session/list` a bounded, ordered page with row metadata, and adds rename, archive and a list subscription.

### Activation

AIR declares `sessionIndex` in `_meta.jetbrains.air.capabilities`.
Unlike the other capabilities, the agent advertises `sessionIndex` only to a client that declared it, and never under ACP v2.
Exactly when it advertises `sessionIndex`, the agent also advertises `sessionArchive` (it supports `_session/archive` and `_session/unarchive`), `sessionRename` (it supports `_session/rename`) and `sessionListSubscribe` (it supports `_session/list/subscribe` and `_session/list/unsubscribe`).
The client does not declare these three; declaring them without `sessionIndex` enables nothing.
Everything in this section applies only to such a client, except where [Delete and close](#delete-and-close) says otherwise.
A client without the capability gets the `session/list` of before: the SDK `listSessions` call, pages of 1000 by file mtime, `offset:N` cursors, and no row `_meta`.
It gets no new notification, and the adapter starts no watcher for it.
The new methods answer it with `-32601`.

### List request

```json
{
  "cwd": "/Users/me/repo",
  "cursor": null,
  "_meta": {
    "jetbrains": {
      "air": {
        "version": 1,
        "list": { "limit": 50, "includeWorktrees": false, "archived": "unarchived" }
      }
    }
  }
}
```

- `limit` is an integer of at least 1; omitted or `null` is 50. The adapter clamps it to 200 and never returns more. Another value (a string, a fraction, 0 or less) is `-32602`.
- `includeWorktrees` is a boolean, `false` when omitted or `null`. Another value is `-32602`.
  Without it, `cwd` matches exactly (after resolving symlinks, as the CLI does): a session of another path that shares the project directory name (`/ws/app.v2` and `/ws/app-v2`, `/a/b` and `/a-b`) is not listed.
  With `true`, the page also holds the sessions of the same subdirectory of `cwd` in every other existing worktree of its repository, as the Codex TUI expands a cwd: for `/repo/packages/a`, `/wt1/packages/a` if that directory exists. For a cwd at a worktree root, that is the worktree roots.
- `archived` and `includeWorktrees` treat `null` as omitted.
- `archived` is one of three strings: `"unarchived"` lists the unarchived sessions only, `"archived"` the archived sessions only, and `"all"` both together, in one order.
  Omitted or `null` is `"unarchived"`. Any other value, including a boolean, is `-32602`.
  The filter applies before pagination.
- Without `cwd` the page holds the sessions of all projects.

### List response

- Rows are ordered by the last user activity descending, then by session id: `lastPromptAt`, else `updatedAt` for a row without it.
  A session the agent kept working on after the last prompt does not move up, as in Codex Desktop and the AIR session tree.
  With `archived: "all"`, archived and unarchived rows merge on the same key.
- Every row has `updatedAt`: the time of the last message of any kind, capped at the transcript mtime.
  A rename, an archive, or another metadata record moves neither `updatedAt` nor the order.
- The cursor is opaque. It holds the position (the order key and session id of the last row) and the `cwd`, `includeWorktrees` and `archived` it was issued for; another value of any of them rejects it with `-32602`. `limit` may change from page to page.
- A deleted session is never listed, whatever `archived` says.
- A page with `nextCursor` is never empty, and a page never repeats a row of the pages before it.
- With `includeWorktrees`, the worktrees come from `<git-common-dir>/worktrees/*/gitdir`, without running git; a worktree whose directory no longer exists is left out.
  A path longer than the CLI's 200-character directory name limit matches directories by name prefix, so such a directory counts only when one of its transcripts belongs to the path (its last `relocated` cwd, else its first `cwd`), as the SDK checks.
  A row's `cwd` is the session's own directory, so it can be a worktree path.
- A row's `title` is the effective title of its transcript. A named session ranks its names as AIR does: the last top-level `agentName` of any record, else the last `customTitle` of a `custom-title` record (tail, the CLI's `custom-title.json` sidecar, head). A session without a name has the title the SDK gives it: the AI title, the last prompt, a summary or the first prompt (AIR ranks the first prompt above the last one).
  Names are read from the 64 KB head and tail, as the SDK reads titles; the CLI writes its title records again as the transcript grows. When the tail has no agent name but a custom title, or the head has an agent name, the 4 MB before the tail are searched for a later one.
  The `[archived] ` prefix of an archived session is not part of the title (see [Archive](#archive)).
- Sidechain and subagent transcripts, transcripts without a message, and transcripts without a title are not listed.
- A session copied to two project directories is listed once, from the larger file; its title comes from that file.
- A transcript continued in another session (a `continued-in` record) whose successor has history is not listed, as in the SDK list.
- On macOS a project directory whose name differs from the cwd's encoding in case only is the cwd's directory, as the file system resolves it for the SDK.
- A row's `cwd` comes from the transcript (the last `relocated` record, else the first `cwd`, else the last `cwd` or one of its parents) when it encodes to the project directory name.
  Otherwise it is the requested path of that directory, else the `cwd` of another session in the same directory, read further if the page does not hold one.
- `updatedAt` needs the last message and the order key the last prompt: when the 64 KB tail window lacks either, the window grows up to 4 MB to find it, reading only the new bytes each step. A last message longer than that gives the last `timestamp` of the file's last 64 KB, so title records appended after it move nothing.
  The directory name is never decoded.

Each row carries `_meta.jetbrains.air` with flat row fields of the RFDs. `archived` is always there (see [Archive](#archive)); every other field is omitted when unknown:

```json
{
  "archived": false,
  "lastPromptAt": "2026-10-06T09:57:40.000Z",
  "model": "claude-opus-5-5",
  "forkedFrom": "8f0c1d2e-0000-4000-8000-000000000000",
  "state": "idle",
  "lastTurnEndedAt": "2026-10-06T09:58:10.000Z",
  "cost": { "amount": 1.23, "currency": "USD" }
}
```

- `lastPromptAt` is the time of the last real user prompt in the transcript tail: prompt text (the predicate of the SDK title extractor) or an image or a document, but not a tool result, a meta or compact summary record, a slash command or an interrupt. When a long answer or tool output follows the last prompt, the tail window grows (256 KB, 1 MB, 4 MB) to find it; it is omitted only when the last 4 MB hold no prompt.
- `model` is the model of the last assistant message in the tail; messages the CLI makes up (`<synthetic>`) do not count.
- `forkedFrom` is the parent session id that the SDK `forkSession` and the CLI fork write on every copied record (`forkedFrom.sessionId`). Sessions started any other way have none.
- `state` is `running`, `idle`, `requires_action`, or `error`, never `unknown`. `error` means the session is not running and its last turn ended with an error; a user cancel or interrupt is no error, and a new turn clears it:
  - a session this connection runs: the SDK `session_state_changed` state; `error` instead of `idle` when its last turn failed (an error result, `is_error` or an `error_*` subtype, that was not a cancel). A session whose query failed here (not a cancel) is reported as any other session, but `error` until its transcript shows a prompt or a turn end after the failure, unless a busy or waiting interactive CLI holds it;
  - a session no live Claude Code process holds: `idle`, or `error` when its last turn ended with an API error (an assistant record with `isApiErrorMessage: true`, also when the CLI's turn-end records follow it, with no prompt after it);
  - a session that an interactive CLI holds (not an `sdk-*` entrypoint) whose registry status is newer than the transcript: `busy` and `shell` are `running`, `waiting` is `requires_action`, `idle` is `idle`, or `error` after such an API error;
  - any other held session: `idle` after a finished turn (an assistant `end_turn`, a user interrupt, or the CLI turn-end records), `error` after a turn that ended with an API error, `running` for an unfinished turn written in the last 10 minutes, and no state otherwise.
- The live processes come from `<config>/sessions/<pid>.json`, with the liveness rules of Claude Desktop: `kill(pid, 0)` (or `EPERM`), a matching `procStart`, no foreign `pidDomain`, and records older than 24 hours only with a matching `procStart`.
  The adapter never reads the `.key` files there and never changes the directory.
- `lastTurnEndedAt` is when the last turn ended.
- `cost` is the `total_cost_usd` of the last result of a session this connection runs, else the last `cost-state` record of the transcript. It is sent only when it is greater than 0.

### Rename

`_session/rename { "sessionId": "…", "title": "…" }` returns `{}`.

- A blank title is `-32602`. The adapter collapses whitespace and keeps the first 200 characters, trimmed, as the CLI does. An `[archived] ` prefix of the requested title is dropped: a rename never changes the archive state.
- The title is stored as the title records of [Archive](#archive): a `custom-title` and an `agent-name` record. An archived session keeps its `[archived] ` prefix (and the title is cut to 200 characters with it), so a rename does not unarchive it.
- A session that runs here on a CLI without the `rename_session` control request is refused with `-32600`: its CLI holds the title and would write it back.
- A session this connection runs is renamed through its CLI (`rename_session` control request), which writes the records and the sidecar of its own transcript.
  A title generation in flight finishes first, and no generated title replaces the new one, also after a reload.
  The adapter then sends `session_info_update { title }` with the title as stored, without the archive prefix.
  Copies of the session in other project directories get the records and sidecar from the adapter.
- Any other session gets the records in every transcript of the session and the CLI's `custom-title.json` sidecar next to each (mode 0600, written atomically).
- A session that another live process holds is refused with `data.reason: "thread_active_writer"`, also one that runs here and that another process resumed too.
  A session whose query closed here counts as any other session. A CLI that this adapter started and is still exiting is no other process: the adapter waits for it to exit, at most 8 seconds, and refuses with `thread_active_writer` if it is still running then. Where the parent of a process cannot be told (Windows), a lone holder of a session whose CLI this connection runs or just closed is taken for that CLI; any other holder is another process.
  A transcript whose last line is incomplete gets no record while a process may still be writing it.

### Archive

`_session/archive { "sessionId": "…" }` and `_session/unarchive { "sessionId": "…" }` return `{}`.
Both are idempotent and work for a session that is not loaded.

The archive state lives in the session title, in the format of AIR's own Claude integration, so AIR's native Claude path and this adapter read and write the same state:

- A session is archived when its effective title (see [List response](#list-response)), with whitespace collapsed, starts with `[archived] `.
- Archive appends the title records of `[archived] ` plus the current title without the prefix; unarchive appends those of the title without the prefix. The title is cut to the CLI's limit, its first 200 characters, trimmed; a session without a title is `Session ` plus the first 8 characters of its id.
- The title records are two lines, appended together to every transcript of the session:

  ```json
  {"type":"custom-title","customTitle":"[archived] Fix the parser","sessionId":"…"}
  {"type":"agent-name","agentName":"[archived] Fix the parser","sessionId":"…"}
  ```

  A transcript already in the requested state gets nothing. A `custom-title.json` sidecar that the adapter finds is rewritten with the same title (also one left in the other state next to a transcript already in the requested state); the adapter creates none. The CLI of a session that runs here writes the sidecar of its own transcript, as for a rename.
  The current title is the effective title of each transcript. For a session that runs here, it is the title last stored through its CLI while the last custom title of its transcript is that title (the CLI writes the agent name later); otherwise the transcript's.
  Every `[archived] ` prefix of the current title is removed before one is added, so unarchive also unarchives a title stored with the prefix twice.
  A new session archived before it has a title gets `[archived] Session …`, and keeps `Session …` as its name once unarchived: no title is generated for a named session.

- The list shows the title without the prefix, and so does the `session_info_update { title }` of a loaded session for an AIR client. Another client, and the `claude --resume` picker, show the title as stored, with the prefix.
- A session marked archived by a marker file `<config>/acp/archived/<sessionId>` is archived too. Archive, unarchive and delete remove the marker; the adapter never writes one.

- Neither loads, resumes, closes or cancels the session: a session that runs on this connection keeps running.
  Closing, loading or resuming a session does not change its archive state.
  AIR's native Claude path stops the session's processes before it archives; the adapter leaves them running and refuses a session held elsewhere instead (below).
- A session this connection runs is retitled through its CLI (`rename_session`), as for [Rename](#rename): the CLI keeps the title in memory and writes it again, so only its own write cannot be overtaken. A title generation in flight finishes first, and no generated title replaces the archived one. Its copies in other project directories get the records from the adapter as a best effort: a copy whose last line is incomplete is left alone, and an archive marker of the session is then kept.
- A session that another live process holds is refused with `data.reason: "thread_active_writer"`, with the holder rules of [Rename](#rename): that process holds the title in memory and would write it back.
- After either, a session loaded on this connection gets `session_info_update` with `_meta.jetbrains.air.archived` set to the new state; no standard field changes.
- Neither changes `updatedAt` or the list order: the title records are metadata.
- A session without a transcript (unknown, deleted, or removed by the CLI cleanup) is `-32002`, also when it still has an archive marker; unarchive then drops the marker. Unarchive never brings back a deleted session.
  Only a new session that runs on this connection and has not finished a turn yet may have no transcript: it can be archived before the CLI writes one, and the CLI writes the title with it.
  A loaded session whose query ended, that finished a turn, or that was loaded, resumed or forked from history needs its transcript.
- Rename, archive, unarchive and delete of one session run one at a time.

In all of the session index methods and in a `sessionIndex` client's `session/delete`, a session id matches in any case, and each transcript is handled under the spelling of its own file name.
Loading an archived session does not unarchive it.
The CLI cleanup still deletes old transcripts (`cleanupPeriodDays`), archived or not.

### List subscription

`_session/list/subscribe { "cwd": "…" }` returns `{ "subscriptionId": "…" }`.
From then on the agent sends `_session/list/changes` notifications for the sessions of that `cwd`:

```json
{
  "subscriptionId": "5b0c…",
  "sessions": [
    {
      "sessionId": "…",
      "cwd": "/Users/me/repo",
      "title": "…",
      "updatedAt": "…",
      "_meta": { "jetbrains": { "air": { "version": 1, "archived": false, "state": "running" } } }
    }
  ],
  "removed": ["…"]
}
```

- `cwd` is required and must be an absolute path; a missing, non-string or relative `cwd` is `-32602`. Other parameters are ignored.
- The scope is the sessions of `cwd` and of the same subdirectory in every existing linked worktree of its repository, as a list with `includeWorktrees: true` resolves it, in any archive state. Sidechain and subagent transcripts are left out, as in the list.
- `sessions` holds the full current row of each session in scope that appeared, or whose `title`, `lastPromptAt`, `state`, `lastTurnEndedAt`, `cost`, `model`, `forkedFrom` or `archived` changed since the last row sent for it on this subscription. A row is exactly the row of `session/list`, `_meta.jetbrains.air` included.
- A change of `updatedAt` alone sends nothing; the new `updatedAt` comes with the next change.
- `removed` holds the ids of sessions that left the scope: deleted (the transcript is gone), or moved to a path outside it.
- Archive and unarchive are row changes (`archived`): their title records are a transcript change, and the removal of an archive marker is one too. The agent applies no archive filter: the client filters.
- A session is sent at most once a second per subscription. All changes of one pass go in one notification per subscription.
- Changes are tracked from the moment subscribe returns: the client subscribes first, then reads the first page with `session/list`. A row the page also holds may be sent.
- A transcript change is sent 150 ms after the last change of a burst, at most 1 s after the first; the state of a session that this connection runs is sent at once.
- Delivery is best effort: there is no resync and no sequence number. A rescan every 10 s, and one 1 s after the adapter starts watching a project directory, sends any difference it finds as a normal change. The client should still read the list now and then.

`_session/list/unsubscribe { "subscriptionId": "…" }` returns `{}`.
It is idempotent, and an unknown id also returns `{}`.

- A subscription lives until unsubscribe or until the connection closes; it has no time limit.
- A connection has at most 128 subscriptions. The 129th subscribe is `-32602` with `data.reason: "too_many_subscriptions"`.
- A second subscription of the same `cwd` is independent: it has its own id, its own unsubscribe and its own notifications.
- The adapter watches, without recursion, the project directories of the scope, the projects directory (for a new project directory), `<config>/sessions` and `<config>/acp/archived` (the archive markers), and the nearest existing parent of any of these that does not exist yet. All subscriptions of one `cwd` share that watching, which ends with the last of them.
- The first subscription of a `cwd` stats every transcript of the scope before it returns, then reads the row of each in the background, newest first; `session/list` shares these reads.
- A transcript event names the file: only that transcript is read again. A registry event names the record: only the sessions whose record changed get their `state` recomputed.
- `session/list` starts or renews nothing.

### Delete and close

`session/delete`:

- a `sessionIndex` client: deletes every transcript of the session (empty ones too) and every `<sessionId>/` directory, also one left without a transcript by an earlier failed delete, then its archive marker. Anything left behind fails the request and keeps the marker. A session that another live process holds is refused with `thread_active_writer`, as for rename; a session that runs here is checked after its CLI is closed. An unknown session is `-32002`, also when an archive marker was left over (the marker is dropped).
- an AIR client without `sessionIndex`: archives the session instead of deleting it (the title records of [Archive](#archive)), because AIR uses delete for "Done" and can reopen the session. A session that runs here is closed first, and its CLI is waited for, as for a `sessionIndex` client's delete; a session that another live process holds is refused with `thread_active_writer`. The list hides archived sessions from such a client too: those whose custom title, as the SDK list reports it, is archived, and those with an archive marker. That list does not read agent names. A session without a transcript fails with the error of the SDK delete, as before.
  A `sessionIndex` client sees such a session as archived (`archived: true`), as AIR's native Claude path does.
- any other client: the SDK delete, as before.

`session/close` of a session that is not loaded returns `{}` for every client.

`session/load` and `session/resume` of a `sessionIndex` client refuse a session that another live Claude Code process holds with `thread_active_writer` (the holder rules of [Rename](#rename)), instead of starting a second writer, also when this connection runs the session too. The CLI that runs it here is its own. Other clients open it as before.

### Errors

| Case                                               | Error                                                               |
| -------------------------------------------------- | ------------------------------------------------------------------- |
| Another live Claude Code process holds the session | `-32600` with `data: { reason: "thread_active_writer", sessionId }` |
| Unknown session                                    | `-32002` with `data: { sessionId }`                                 |
| Invalid parameters or cursor                       | `-32602`                                                            |

### Relation to the RFDs

The session index is the `_meta` form of two ACP RFDs: "Session list extensions: limit, order, row metadata and change hints" and "Session Archive and Unarchive" (#2161).
Names and semantics follow them; the transport differs, and so does the `archived` list filter (see [Relation to ACP RFD #2161](#relation-to-acp-rfd-2161)):

| Extension                                                                                         | RFD                                                                    |
| ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| capability `sessionIndex` (`_meta.jetbrains.air`)                                                 | `sessionCapabilities.list.limit`                                       |
| capability `sessionArchive` (`_meta.jetbrains.air`)                                               | `sessionCapabilities.archive` (#2161)                                  |
| capability `sessionRename` (`_meta.jetbrains.air`)                                                | `sessionCapabilities.setTitle` (#1987)                                 |
| `_meta.jetbrains.air.list.limit`                                                                  | `session/list` `limit`                                                 |
| `_meta.jetbrains.air.list.includeWorktrees`                                                       | `session/list` `includeWorktrees`                                      |
| `_meta.jetbrains.air.list.archived` (`"unarchived"`, `"archived"`, `"all"`)                       | `session/list` `archived` (#2161), a boolean there                     |
| row `_meta.jetbrains.air.lastPromptAt`, `model`, `forkedFrom`, `state`, `lastTurnEndedAt`, `cost` | `SessionInfo` fields of the same names; the RFD `state` has no `error` |
| row `_meta.jetbrains.air.archived`                                                                | `SessionInfo.archived` (#2161)                                         |
| `session_info_update` `_meta.jetbrains.air.archived`                                              | `SessionInfoUpdate.archived` (#2161)                                   |
| capability `sessionListSubscribe`, `_session/list/subscribe`, `_session/list/unsubscribe`         | none                                                                   |
| `_session/list/changes { subscriptionId, sessions, removed }`                                     | none                                                                   |
| `_session/archive`, `_session/unarchive`                                                          | `session/archive`, `session/unarchive` (#2161)                         |
| `_session/rename`                                                                                 | `session/set_title` (#1987)                                            |

### Relation to ACP RFD #2161

The archive follows the semantics of the ACP "Session Archive and Unarchive" RFD (#2161): the archive state of every row, the state report in `session_info_update`, idempotency, `-32002` for unknown and deleted sessions, an unchanged `updatedAt`, and execution left alone.
It differs in transport, until the RFD lands in the SDK, and in the list filter:

- the list parameter has three values, not two: `"unarchived"` is the RFD's `false` (and the default of both), `"all"` its `true`, and `"archived"`, the archived sessions only, has no RFD counterpart;
- the methods are `_session/archive` and `_session/unarchive`, not `session/archive` and `session/unarchive`;
- the capability is `sessionArchive` in `_meta.jetbrains.air.capabilities`, advertised together with `sessionIndex`, not `sessionCapabilities.archive`;
- the list parameter is `_meta.jetbrains.air.list.archived`, and the state is `_meta.jetbrains.air.archived` on rows and in `session_info_update`, not the `archived` fields;
- an AIR client without `sessionIndex` still archives with `session/delete` (see [Delete and close](#delete-and-close)), which the RFD asks clients not to do.

## Context compaction

The adapter implements the ACP session compaction RFD for a client that declares `clientCapabilities.session.compaction`.
It then sends `compaction_update` and `compaction_summary_chunk`.
Every other client gets a synthetic tool call:
`toolCallId` is the compaction id, `title: "Compact conversation"`, `kind: think`.

For AIR, both forms carry `_meta.jetbrains.air.contextCompaction`:

```json
{
  "version": 1,
  "trigger": "automatic",
  "preTokens": 180000,
  "postTokens": 42000,
  "durationMs": 5300
}
```

| Field        | Meaning                                                               |
| ------------ | --------------------------------------------------------------------- |
| `version`    | Must equal `1`.                                                       |
| `trigger`    | `manual` or `automatic`.                                              |
| `preTokens`  | The context size before the compaction.                               |
| `postTokens` | The context size after the compaction.                                |
| `durationMs` | The duration of the compaction.                                       |
| `error`      | The error of a failed compaction. Only the tool call form carries it. |

The standard `toolCallId` or `compactionId` and the `status` own the identity and the phase.
The `compaction_update` form puts the error in the standard `error` field.
The tool call form also puts the error in `content` once, as `Compaction failed: <error>`.

A client that is not AIR gets the upstream fields and no `contextCompaction` key.
The tool call form carries `_meta.claudeCode.toolName: "compact"`, and the facts in `rawOutput` at the end.
The `compaction_update` form carries no `_meta`.

## Question custom answers

`AskUserQuestion` goes to the client as an ACP form elicitation.
Without form elicitation support, the adapter disables the tool when it creates the Claude session.

Each question gets a select field and a companion text field named `Other`.
For AIR, the companion field carries `_meta.jetbrains.air.customAnswer`:

```json
{ "questionId": "<select field key>", "isCustomAnswer": true }
```

`questionId` names the select field of the same question.
A client can render the companion as the free-text choice of that question.

For AIR, the companion field also carries the same value under the root key `_meta._askUserQuestionCustomAnswer`.
Released AIR versions read only that key.
A client that is not AIR gets neither key.

## Session fork point

AIR can fork a session at one agent message.
It adds this object to the `session/fork` request:

```json
{
  "_meta": {
    "jetbrains": {
      "air": {
        "fork": {
          "version": 1,
          "messageId": "msg-12",
          "messageFingerprint": "sha256:<64 hex>",
          "messageOccurrence": 1
        }
      }
    }
  }
}
```

- The adapter reads the object only when `version` is `1` and `messageId` is not blank.
  Otherwise it ignores the object and forks the whole session.
- An id with a `:segment:<n>` suffix also matches the message without the suffix.
- The adapter looks for the id in the live session, then in the active history, then in all stored branches.
- `messageFingerprint` is optional. It is `sha256:` and the SHA-256 hex digest of the message text.
  The adapter uses it when no message has the id, together with `messageOccurrence`.
- `messageOccurrence` is a positive integer. It counts equal messages on the branch of the target message.
  When only one stored message has the fingerprint, the adapter uses that message.
- When no message matches, the request fails with `invalidParams`.
- The fork keeps the history up to that message.

## Presentation hints

Each session mode and each value of the mode config option carries `_meta.jetbrains.air.kind`:

| Mode id             | Label              | `kind`        |
| ------------------- | ------------------ | ------------- |
| `default`           | Manual             | `standard`    |
| `acceptEdits`       | Accept edits       | `standard`    |
| `plan`              | Plan               | `plan`        |
| `auto`              | Auto               | `auto_review` |
| `bypassPermissions` | Bypass permissions | `full_access` |

The adapter sends the key only to an AIR client.

## Removed keys

These keys moved into the AIR namespace. The adapter sends the new key only to AIR, and the old key to no client.

| Old key                                                   | New key                                 |
| --------------------------------------------------------- | --------------------------------------- |
| `initialize._meta.goal`, `session_info_update._meta.goal` | `_meta.jetbrains.air.goal`, same shape  |
| mode `_meta.kind`, config option value `_meta.kind`       | `_meta.jetbrains.air.kind`              |
| tool call `_meta.contextCompaction`                       | `_meta.jetbrains.air.contextCompaction` |

The adapter does not send `_meta.claudeCode.title`, `claudeCode.subagent`, `claudeCode.skill`, or `claudeCode.skillPath` to any client.
AIR reads `_meta.jetbrains.air.commandTitle`, `subagent`, and `skill` instead.
The adapter also no longer sends the diff statistics `_meta.jetbrains.air.diffStats`.
