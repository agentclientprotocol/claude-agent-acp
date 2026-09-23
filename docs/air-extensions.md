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

The agent list does not depend on the capabilities that AIR declares.
An extension is active only when the client declared its capability.
The response to a client that is not AIR has no `_meta.jetbrains` key.

### Capabilities

| Capability               | Advertised | What the adapter does when the client declares it                                       | Section                                                 |
| ------------------------ | ---------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `diffPatch`              | yes        | Sends an exact Git patch in the diff block of an Edit or a Write.                       | [Diff patch](#diff-patch)                               |
| `sessionFailure`         | yes        | Sends warnings and errors as typed transcript records.                                  | [Session failure](#session-failure)                     |
| `recommendedValue`       | yes        | Replaces the `default` model and effort rows with concrete values and a recommendation. | [Recommended config values](#recommended-config-values) |
| `asyncTasks`             | yes        | Publishes background work that is not a subagent as async tasks.                        | [Async tasks](#async-tasks)                             |
| `agentFileChangeReport`  | yes        | Accepts a report request on `session/prompt` and sends the changed file list.           | [Agent file-change report](#agent-file-change-report)   |
| `nativeSubagentSessions` | yes        | Reports an Agent or Task subagent as a native ACP child session.                        | [Native subagent sessions](#native-subagent-sessions)   |
| `planFile`               | yes        | Sends the path of the plan file in place of the plan text of an ExitPlanMode.           | [Plan file](#plan-file)                                 |
| `rawInputRendering`      | no         | Sends no display copy of readable input in `content`. The client renders `rawInput`.    | [Tool call contract](#tool-call-contract)               |

The adapter also reads `planContentDelta`, but the capability has no effect.
Claude does not stream a plan, so the adapter never sends `contentDelta` (see [Plan file](#plan-file)).

The goal extension has no client capability.
The agent advertises the `goal` object, and the client uses the control method when it wants to.

## AIR metadata keys

Every payload goes into `_meta.jetbrains.air`, next to `version: 1`.
The adapter merges a payload into an existing `_meta` and keeps the other namespaces.
The adapter sends these keys only to an AIR client. "AIR" in the Gate column means an AIR client without a further capability.

| Key                            | Message and field path                                                                | Shape                                                                  | Gate                                           |
| ------------------------------ | ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | ---------------------------------------------- |
| `capabilities`                 | `initialize` response `_meta.jetbrains.air`                                           | string array                                                           | AIR                                            |
| `goal`                         | `initialize` response `_meta.jetbrains.air`                                           | `{version: 1, controlMethod, actions}`                                 | AIR                                            |
| `goal`                         | `session_info_update._meta.jetbrains.air`                                             | goal snapshot or `null`                                                | AIR                                            |
| `diffPatch`                    | tool call and permission request `content[]` of type `diff`, `_meta.jetbrains.air`    | `{version: 1, format: "git_patch", text}`                              | `diffPatch`                                    |
| `permission`                   | `session/request_permission` request `_meta.jetbrains.air`                            | `{version: 1, title, description?, defaultToNo?}`                      | AIR                                            |
| `recommendedValue`             | `model` and effort config options, `_meta.jetbrains.air`                              | option value string                                                    | `recommendedValue`                             |
| `asyncTasks`                   | Bash `tool_call_update._meta.jetbrains.air`                                           | `{backgrounded: true}`                                                 | `asyncTasks`                                   |
| `agentFileChangeReportRequest` | `session/prompt` request `_meta.jetbrains.air` (client to agent)                      | `{version: 1, requestId}`                                              | `agentFileChangeReport`                        |
| `agentFileChangeReport`        | `session_info_update._meta.jetbrains.air`                                             | report object                                                          | `agentFileChangeReport`                        |
| `sessionFailure`               | `session_info_update._meta.jetbrains.air` or `PromptResponse._meta.jetbrains.air`     | failure record                                                         | `sessionFailure`                               |
| `commandTitle`                 | Bash and PowerShell tool call `_meta.jetbrains.air`                                   | the `description` input string                                         | AIR                                            |
| `subagent`                     | Agent and Task tool call `_meta.jetbrains.air`                                        | `true`                                                                 | AIR                                            |
| `skill`                        | Skill tool call `_meta.jetbrains.air`                                                 | `{name, path?}`                                                        | AIR                                            |
| `contextCompaction`            | compaction tool call or `compaction_update`, `_meta.jetbrains.air`                    | `{version: 1, trigger?, preTokens?, postTokens?, durationMs?, error?}` | AIR                                            |
| `customAnswer`                 | elicitation schema property `_meta.jetbrains.air`                                     | `{questionId, isCustomAnswer: true}`                                   | AIR, when the client supports form elicitation |
| `kind`                         | session mode `_meta.jetbrains.air` and mode config option value `_meta.jetbrains.air` | `standard`, `plan`, `auto_review`, or `full_access`                    | AIR                                            |
| `fork`                         | `session/fork` request `_meta.jetbrains.air` (client to agent)                        | `{version: 1, messageId, messageFingerprint?, messageOccurrence?}`     | none                                           |

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
It sends the resulting patch only when it can predict the written bytes exactly.
The adapter applies the input normalization of Claude:

- Claude removes the trailing whitespace of each line of the new text, except for a `.md` or `.mdx` path.
  For an `Edit`, it does this only when it can read the file.
- An `Edit` with an empty `new_string` also removes the line break after `old_string`.
  This applies when `old_string` does not end with a line break and the file holds `old_string` and a line break.

This keeps a 12,000-line file out of the approval payload when the change is small.
The adapter sends no preview patch in these cases, and the tool call keeps its standard diff:

- The file is larger than 1 MiB, is binary, is not valid UTF-8, or contains a CR.
- The new text is larger than 1 MiB, or contains a NUL or a CR.
- The `Edit` file is missing for a non-empty `old_string`.
- The `old_string` does not match exactly once, and `replace_all` is not set.
- The change leaves the file unchanged.
- The `Edit` path is a UNC path, a `\??\` path, or a path under `/net` or `/Network`, and the normalization changes the new text.
  Claude can skip the normalization for such a path.

An `Edit` input holds a snippet, not the file.
The tool call therefore shows the standard diff of the snippet until a preview or the final patch replaces it.
A `Write` tool call shows a creation patch of its content only when the file is missing.
For an existing file, it shows the standard diff from the current text, and the preview or the final patch replaces it.
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

Claude can run work in the background, for example a backgrounded Bash command, a workflow, or a monitor.
The adapter publishes that work as async tasks when the client declares `asyncTasks`.
Without the capability, the adapter sends no async task update.
A subagent task (`local_agent`) is not an async task. Native subagent sessions report it.

### Updates

- `async_task_spawned` has `asyncTaskId`, `name`, `taskType`, `description`, `showInTranscript`, `canStop: true`, and optional `outputFilePath` and `toolCallId`.
  `taskType` is `shell`, `workflow`, `monitor`, `task`, or the SDK value.
  `showInTranscript` is `false` when the SDK asks to skip the transcript.
- `async_task_progress` carries only the changed fields: `description`, `summary`, `lastToolName`, `usage`, `outputFilePath`, and `toolCallId`.
- `async_task_state_update` carries `state` (`running`, `paused`, `completed`, `failed`, or `stopped`) and an optional `summary`.
- The Bash `tool_call_update` of a backgrounded command carries `_meta.jetbrains.air.asyncTasks.backgrounded: true`.
  The card then shows backgrounded work instead of finished work.

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

| Field      | Required | Type                 | Meaning                                                                                            |
| ---------- | -------: | -------------------- | -------------------------------------------------------------------------------------------------- |
| `id`       |      yes | non-empty string     | Stable identity of one incident.                                                                   |
| `revision` |      yes | positive integer     | Increasing version of that incident.                                                               |
| `category` |      yes | category             | Broad visual group.                                                                                |
| `severity` |      yes | `warning` or `error` | Inline warning or error presentation.                                                              |
| `title`    |      yes | string               | The complete user-facing text.                                                                     |
| `details`  |       no | string               | Long text that does not fit in `title`.                                                            |
| `reason`   |       no | string               | A machine-readable refinement, for example of the `--hide-claude-auth` guard on a sign-in failure. |
| `actions`  |      yes | ordered string array | Recovery actions that the adapter recommends.                                                      |

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

| Claude condition                                                              | Category     | Severity | Actions                |
| ----------------------------------------------------------------------------- | ------------ | -------- | ---------------------- |
| `authentication_failed`, `oauth_org_not_allowed`, the synthetic login message | `access`     | error    | `login`                |
| `verification_required`, `cloud_credential_error`                             | `access`     | error    | `retry`                |
| `billing_error`, `account_on_hold`, a usage or spend limit                    | `limit`      | error    | none                   |
| `rate_limit`                                                                  | `limit`      | error    | `retry`                |
| `max_output_tokens`, a turn limit                                             | `limit`      | error    | `new_session`          |
| a configured session budget                                                   | `limit`      | error    | `new_session`          |
| `invalid_request`, `model_not_found`                                          | `request`    | error    | none                   |
| `overloaded`                                                                  | `service`    | error    | `retry`                |
| `server_error`, an unknown provider error                                     | `service`    | error    | `retry`                |
| an adapter internal error                                                     | `service`    | error    | `retry`, `new_session` |
| transport loss, worker shutdown                                               | `connection` | error    | `new_session`          |
| an API retry (`api_retry`), `connection` when no HTTP response came           | as above     | warning  | none                   |
| a model fallback notice                                                       | `unknown`    | warning  | none                   |

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

- the top-level assistant error text, including the synthetic usage-limit and login messages;
- otherwise the terminal SDK result or error text;
- the exact model-fallback notice for a warning.

The adapter writes its own text only when Claude sent none, for example when the query iterator throws.
Raw exceptions, stack traces, transport URLs, tokens, headers, environment values, and private paths are never a title.
`details` is only for a required explanation that is too large for `title`.
It is not a place for status text, retry counters, provider payloads, or diagnostics.

### Recovery

Recovery is internal adapter state and is not sent:

- a restored quota failure stays active until a real model answer;
- a sign-in failure stays active until a successful `auth_status`;
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
- Without either signal, Agent and Task stay ordinary tool calls. AIR gets `_meta.jetbrains.air.subagent: true` on them.
  Child interactions stay on the root session.
- A client that uses the older `_meta["subagent-transcript"]` capability or the `forwardSubagentText` session option keeps the flat child transcript.

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

| Old key                                                   | New key                                        |
| --------------------------------------------------------- | ---------------------------------------------- |
| `initialize._meta.goal`, `session_info_update._meta.goal` | `_meta.jetbrains.air.goal`, same shape         |
| mode `_meta.kind`, config option value `_meta.kind`       | `_meta.jetbrains.air.kind`                     |
| elicitation property `_meta._askUserQuestionCustomAnswer` | `_meta.jetbrains.air.customAnswer`, same value |
| tool call `_meta.contextCompaction`                       | `_meta.jetbrains.air.contextCompaction`        |

The adapter does not send `_meta.claudeCode.title`, `claudeCode.subagent`, `claudeCode.skill`, or `claudeCode.skillPath` to any client.
AIR reads `_meta.jetbrains.air.commandTitle`, `subagent`, and `skill` instead.
The adapter also no longer sends the diff statistics `_meta.jetbrains.air.diffStats`.
