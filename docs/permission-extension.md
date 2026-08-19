# Permission extension

This document defines the experimental permission presentation extension implemented by
`claude-agent-acp`. The adapter uses standard ACP permission requests and responses, while `_meta`
adds compact request presentation text.

The extension does not replace ACP permissions. `RequestPermissionRequest.toolCall`, `options`,
`RequestPermissionResponse.outcome`, and each option's standard `kind` remain authoritative. A client
that does not understand the extension can ignore `_meta` and render the ordinary ACP request.

## Request lifecycle

When the Claude Agent SDK invokes `canUseTool`, the adapter:

1. stops immediately if the tool-call signal is already aborted;
2. ensures the referenced ACP `tool_call` has been emitted;
3. validates and snapshots any SDK `suggestions: PermissionUpdate[]`;
4. builds a tool-specific presentation and ordered option list;
5. sends `session/request_permission` with the tool-call cancellation signal;
6. validates that the selected option was offered in the exact request;
7. maps the selection to a Claude SDK `PermissionResult`.

The eager `tool_call` announcement always precedes the permission request. If the announcement fails,
its de-duplication marker is removed so the normal streamed tool-use path may retry it.

Request-level presentation metadata requires no capability negotiation. It is an additive `_meta`
record and may be ignored by clients that do not render it.

## Request presentation

The request-level record is placed under `RequestPermissionRequest._meta.permission`:

```json
{
  "sessionId": "session-1",
  "toolCall": {
    "toolCallId": "toolu_1",
    "name": "Bash",
    "status": "pending",
    "rawInput": { "command": "npm test" }
  },
  "options": [
    { "optionId": "allow-once", "name": "Yes", "kind": "allow_once" },
    { "optionId": "reject", "name": "No", "kind": "reject_once" }
  ],
  "_meta": {
    "permission": {
      "version": 1,
      "title": "npm test",
      "description": "Reason: Needed to verify the change."
    }
  }
}
```

| Field         | Required | Type             | Meaning                                   |
| ------------- | -------: | ---------------- | ----------------------------------------- |
| `version`     |      yes | integer `1`      | Permission presentation schema version.   |
| `title`       |      yes | non-empty string | The standard tool-call operation title.   |
| `description` |       no | string           | Temporary diagnostic SDK decision reason. |

The permission title deliberately duplicates `toolCall.title`: one operation has one heading across
the tool card and approval UI. Commands, paths, URLs, and other structured details also remain in
`rawInput`, `content`, and `locations`.

`description` temporarily carries the SDK's non-blank `decisionReason` for diagnostics, prefixed
with `Reason: `. The SDK `description` operation subtitle is not copied there.

## Tool-call presentation

The permission request carries the same standard ACP tool information used for normal tool updates:

- `name`, `kind`, `title`, `content`, and `locations` come from `toolInfoFromToolUse`;
- `status` is `pending`;
- `rawInput` is the original SDK input object;
- `blockedPath` is appended to `locations` when it is valid and not already present;
- subagent calls include `_meta.claudeCode.parentToolUseId` on the tool call;
- Sandbox Network and Computer Use requests synthesize JSON content when the normal renderer has no
  content.

Compact text removes control characters, collapses whitespace where appropriate, and enforces length
limits. Invalid optional presentation text is omitted instead of being truncated into misleading UI.

Permission options are fixed. When a durable suggestion contains a command prefix, path, host, or
other rule, the adapter includes that value directly in `PermissionOption.name`, for example
`Yes, and don't ask again for npm test commands`. Selecting the option applies the exact snapshotted
Claude SDK `PermissionUpdate`; the client cannot edit it. A selected reject is distinct from
`{ "outcome": "cancelled" }`: cancellation aborts the tool use instead of returning a user rejection.

## Standard option ids

| Option id                      | Meaning                                                     |
| ------------------------------ | ----------------------------------------------------------- |
| `allow-once`                   | Allow this call without changing permission state.          |
| `allow-with-updates`           | Allow and apply the displayed durable effect.               |
| `allow-skill-exact`            | Allow the exact Skill invocation in local settings.         |
| `allow-skill-prefix`           | Allow the parameterized Skill prefix in local settings.     |
| `exit-plan-auto`               | Exit plan mode and set session mode to `auto`.              |
| `exit-plan-bypass`             | Exit plan mode and set session mode to `bypassPermissions`. |
| `exit-plan-accept-edits`       | Exit plan mode and set session mode to `acceptEdits`.       |
| `exit-plan-default`            | Exit plan mode and set session mode to `default`.           |
| `exit-plan-clear-auto`         | Clear context, continue the plan, and use `auto`.           |
| `exit-plan-clear-bypass`       | Clear context, continue the plan, and bypass permissions.   |
| `exit-plan-clear-accept-edits` | Clear context, continue the plan, and accept edits.         |
| `reject`                       | Deny the call, optionally returning feedback to Claude.     |

The adapter stably groups options as `allow_once`, `allow_always`, then reject kinds. Options of the
same kind retain their builder order. Clients must return the selected option id unchanged.

## Durable SDK suggestions

Claude may provide `suggestions: PermissionUpdate[]`. Before a suggestion can appear as a durable
choice, the adapter validates the complete array and takes a structured clone. Validation recognizes:

- `addRules`, `replaceRules`, and `removeRules`;
- `setMode` for known Claude permission modes;
- `addDirectories` and `removeDirectories`;
- known destinations and rule behaviors;
- bounded array sizes and bounded non-empty strings.

Unknown update types, invalid values, oversized bundles, non-cloneable data, and empty suggestion
arrays are omitted. The snapshot prevents the label shown to the user from diverging from the effect
returned after a delayed response.

An SDK suggestion is offered only when the tool-specific builder can accurately describe the entire
effect. The adapter never labels one part of a mixed bundle while silently applying the rest.

When `matchedAskRule` is present, all persistent choices are suppressed. A configured `ask` rule must
continue asking; accepting a generated allow rule that cannot override it would be misleading.

## Tool-specific behavior

| Tool family                 | Permission choices and effects                                                                                     |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Bash / PowerShell           | One-time allow; exact representable SDK bundle with its complete effect in the option label; reject.               |
| Read / Glob / Grep          | One-time allow; matching session-scoped read grant; reject.                                                        |
| Edit / Write / NotebookEdit | One-time allow; matching session edit grant, including `.claude` handling; reject.                                 |
| WebFetch                    | One-time allow; generated `domain:<hostname>` local rule; reject.                                                  |
| Skill                       | One-time allow; exact skill and optional `prefix:*` local rules; reject.                                           |
| EnterPlanMode               | Enter plan mode once, or reject and continue implementing.                                                         |
| ExitPlanMode                | One keep-context and one clear-context elevated mode (`auto` > bypass > accept edits), manual approval, or reject. |
| SandboxNetworkAccess        | One-time allow; exact SDK host rule when representable; reject.                                                    |
| Computer Use MCP            | One-time allow; exact representable SDK allow suggestion; reject.                                                  |
| MCP                         | One-time allow; exact representable SDK allow suggestion for that tool; reject.                                    |
| WebSearch / Agent / Task    | One-time allow; generated whole-tool local rule; reject.                                                           |
| ReviewArtifact / Workflow   | Generic fallback behavior until SDK renderer state is available.                                                   |
| Monitor / unknown tools     | Generic fallback behavior.                                                                                         |

Generated WebFetch, Skill, and non-MCP fallback effects use `localSettings`. Filesystem grants are
offered only when the SDK bundle is session-scoped and covers the current path. Shell labels may
describe command rules, read paths, additional directories, or a representable combination.

`AskUserQuestion` is not a permission dialog. With ACP form elicitation support it is routed through
ACP elicitation; without that support it is disabled when the Claude session is created.

## Permission modes and bypass

The session exposes the Claude modes available for the current model using Claude Code's labels:
`Manual`, `Accept edits`, `Plan`, conditional `Auto`, and conditional `Bypass permissions`. The
internal `dontAsk` SDK mode is accepted from settings for compatibility but is not advertised as a
user-selectable mode.

The ACP mode ids are the Claude SDK wire ids: `default`, `acceptEdits`, `plan`, `auto`, and
`bypassPermissions`. `Manual` deliberately retains the SDK id `default`; `manual` is only a settings
input alias. The adapter does not invent parallel ids for presentation labels.

Like Claude Code, `ExitPlanMode` offers one elevated keep-context choice by priority: `auto`, then
`bypassPermissions`, then `acceptEdits`. A non-empty plan also gets exactly one clear-context choice
with the same priority. This requires no ACP capability or setting: after selection the adapter
interrupts the old private Claude query, hides that internal rejection from the client, creates a
new private query under the same public ACP session, and continues the pending turn with
`Implement the following plan:` followed by the complete plan. Mode, model, agent, effort, Fast
mode, and accumulated turn usage are preserved.

The SDK cannot reapply `allowedPrompts` through a public control request, so those renderer hints do
not survive this internal handoff. Ultraplan remains unavailable because its required renderer state
is not exposed by the SDK.

The adapter does not auto-allow a callback merely because the session advertises
`bypassPermissions`. Claude Code applies bypass before invoking `canUseTool`. A request that still
reaches the callback is bypass-immune, safety-sensitive, interactive, or forced by an explicit ask
rule and must remain visible to the user.

## Cancellation and failures

The SDK tool-call `AbortSignal` is forwarded to the ACP client. The adapter also races the client
request locally against the same signal, so a client that ignores cancellation cannot leave Claude's
tool call waiting forever.

These cases all abort the tool use with `Tool use aborted`:

- the signal was already aborted;
- the signal aborts while the permission request is open;
- the client returns a cancelled outcome;
- the client rejects after cancellation.

A normal selected reject returns `behavior: "deny"`, `decisionClassification: "user_reject"`, and
the default refusal message.

## Client requirements

A client implementing version 1 should:

- render standard ACP tool-call content and locations as the action subject;
- treat request `_meta.permission.title` and `description` as optional presentation hints;
- preserve option ids;
- ignore unknown `_meta` fields and future feature names;
- settle the request when its cancellation signal fires.

The client must not infer storage scope, lifetime, or permission effects from `kind` or button text.
The adapter owns the Claude `PermissionUpdate` and applies it only after validating the response.

## Current limits

The SDK does not expose enough renderer state to reproduce every Claude Code dialog. Version 1 does
not implement:

- Bash output-redirection rewriting;
- classifier-specific prompt state;
- ExitPlanMode Ultraplan actions;
- Computer Use macOS/TCC or application-allowlist dialogs;
- structured permission lifetime or storage metadata for clients.

These omissions do not weaken the one-time choice. When a durable effect cannot be represented
honestly, the adapter sends only one-time allow and reject.

## Verification

The executable contract lives in:

- `src/tests/permission-presentation.test.ts` for capability and request presentation;
- `src/tests/permission-options.test.ts` for tool-specific option construction;
- `src/tests/permission-effects.test.ts` for response validation and effects;
- `src/tests/acp-agent.test.ts` for request ordering, cancellation, bypass, and subagent attribution;
- `src/tests/session-config-options.test.ts` for plan-mode integration;
- `src/tests/live-capability-*-audit.test.ts` for opt-in live SDK audits.

```sh
npm run build
npm run check
npm run test:run
```
