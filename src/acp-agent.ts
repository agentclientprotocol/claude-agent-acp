import {
  agent as acpAgent,
  AgentContext,
  AuthenticateRequest,
  AuthMethod,
  AvailableCommand,
  CancelNotification,
  ClientCapabilities,
  CompleteElicitationNotification,
  CreateElicitationRequest,
  CreateElicitationResponse,
  ForkSessionRequest,
  ForkSessionResponse,
  InitializeRequest,
  InitializeResponse,
  ListSessionsRequest,
  ListSessionsResponse,
  LoadSessionRequest,
  LoadSessionResponse,
  LogoutRequest,
  methods,
  ndJsonStream,
  NewSessionRequest,
  NewSessionResponse,
  PermissionOption,
  PromptRequest,
  PromptResponse,
  ReadTextFileRequest,
  ReadTextFileResponse,
  RequestError,
  RequestPermissionRequest,
  RequestPermissionResponse,
  ResumeSessionRequest,
  ResumeSessionResponse,
  SessionConfigOption,
  SessionModeState,
  SessionNotification,
  SetSessionConfigOptionRequest,
  SetSessionConfigOptionResponse,
  SetSessionModeRequest,
  SetSessionModeResponse,
  CloseSessionRequest,
  CloseSessionResponse,
  DeleteSessionRequest,
  DeleteSessionResponse,
  WriteTextFileRequest,
  WriteTextFileResponse,
  StopReason,
} from "@agentclientprotocol/sdk";
import {
  AgentInfo,
  CanUseTool,
  deleteSession,
  FastModeState,
  getSessionInfo,
  getSessionMessages,
  listSessions,
  McpServerConfig,
  ModelInfo,
  ModelUsage,
  OnElicitation,
  OnUserDialog,
  Options,
  PermissionMode,
  PermissionResult,
  PermissionUpdate,
  Query,
  query,
  Settings,
  SDKAssistantMessageError,
  SDKMessage,
  SDKMessageOrigin,
  SDKPartialAssistantMessage,
  SDKUserMessage,
  SlashCommand,
  ThinkingConfig,
} from "@anthropic-ai/claude-agent-sdk";
import { ContentBlockParam } from "@anthropic-ai/sdk/resources";
import { BetaContentBlock, BetaRawContentBlockDelta } from "@anthropic-ai/sdk/resources/beta.mjs";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import packageJson from "../package.json" with { type: "json" };
import {
  applyAskElicitationResponse,
  askUserQuestionsToCreateRequest,
  createElicitationResponseToElicitResult,
  ElicitationSupport,
  extractAskUserQuestions,
  extractRefusalFallbackPrompt,
  mcpElicitationToCreateRequest,
  REFUSAL_FALLBACK_DIALOG_KIND,
  refusalFallbackResultFromResponse,
  refusalFallbackToCreateRequest,
} from "./elicitation.js";
import { SettingsManager } from "./settings.js";
import {
  applyTaskCreate,
  applyTaskUpdate,
  ClaudePlanEntry,
  createPostToolUseHook,
  createTaskHook,
  parseTaskCreateOutput,
  planEntries,
  registerHookCallback,
  TaskState,
  taskStateToPlanEntries,
  toolInfoFromToolUse,
  toolUpdateFromDiffToolResponse,
  toolUpdateFromToolResult,
} from "./tools.js";
import { nodeToWebReadable, nodeToWebWritable, Pushable, unreachable } from "./utils.js";

export const CLAUDE_CONFIG_DIR =
  process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude");

const execFileAsync = promisify(execFile);

const MAX_TITLE_LENGTH = 256;

function sanitizeTitle(text: string): string {
  // Replace newlines and collapse whitespace
  const sanitized = text
    .replace(/[\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (sanitized.length <= MAX_TITLE_LENGTH) {
    return sanitized;
  }
  return sanitized.slice(0, MAX_TITLE_LENGTH - 1) + "…";
}

/**
 * Logger interface for customizing logging output
 */
export interface Logger {
  log: (...args: any[]) => void;
  error: (...args: any[]) => void;
}

type AccumulatedUsage = {
  inputTokens: number;
  outputTokens: number;
  cachedReadTokens: number;
  cachedWriteTokens: number;
};

type UsageSnapshot = {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
};

const ZERO_USAGE = Object.freeze({
  input_tokens: 0,
  output_tokens: 0,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
});

const DEFAULT_CONTEXT_WINDOW = 200000;

/** Floor after `session/cancel` before the adapter forces the active prompt
 *  loop to return "cancelled". `query.interrupt()` normally makes the SDK
 *  yield a trailing idle within milliseconds, and the loop returns through its
 *  usual path — so this timer is armed and cleared, never fired, on healthy
 *  cancels. It only trips when the SDK is genuinely wedged (e.g. a
 *  `TaskOutput { block: true }` poll against a hung background task — issue
 *  #680) and never yields. The value is deliberately loose: it's an
 *  "obviously stuck" ceiling, not a guess at interrupt latency, so it can't
 *  pre-empt a slow-but-healthy interrupt. */
const DEFAULT_FORCE_CANCEL_GRACE_MS = 30_000;

/** Error surfaced when the SDK declares a turn over (`session_state_changed:
 *  idle`, its authoritative turn-over signal) without ever emitting the turn's
 *  `result` — a model stream that dropped mid-turn, or an async agent that
 *  completed/stalled without the host turn resolving (issue #825). */
const TURN_NO_RESULT_MESSAGE =
  "The turn ended without a result: the agent went idle while this prompt was still in flight " +
  "(e.g. the model stream dropped mid-turn). Any partial output may be incomplete; please retry.";

/** Internal model-selection state. Mirrors the shape the ACP SDK exposed as
 *  `SessionModelState` before model selection moved entirely into
 *  `SessionConfigOption` (category "model"). Retained internally to track the
 *  current model and build the "model" config option. */
type SessionModelState = {
  availableModels: Array<{ modelId: string; name: string; description?: string }>;
  currentModelId: string;
};

/** One in-flight `prompt()` call. A persistent per-session consumer (see
 *  `runConsumer`) drains the SDK query stream for the whole session and settles
 *  each Turn's deferred when that turn's outcome is known, so `prompt()` itself
 *  holds no loop. Turns are processed FIFO: the SDK echoes queued user messages
 *  back in submission order, so `turnQueue[0]` is the turn currently running. */
type Turn = {
  /** uuid stamped on the pushed `SDKUserMessage`; the SDK echoes it back so the
   *  consumer can match the replayed user message to this turn. */
  promptUuid: string;
  /** Local-only slash commands (e.g. `/clear`) return a result without an echo,
   *  so the consumer can't promote them via the replay; it falls back to
   *  promoting the queue head when the result arrives. */
  isLocalOnlyCommand: boolean;
  /** Set once the deferred has been resolved/rejected, so the consumer never
   *  settles a turn twice (idle + handoff + stream-end can all race). */
  settled: boolean;
  /** Set when a `command_lifecycle` "started" frame arrives for this turn's
   *  uuid (msg_lifecycle_v1 CLIs): the SDK dispatched the command into a turn.
   *  Read by cancel() to seed the orphan's state — a started orphan's turn may
   *  still emit a result, an undispatched one may be dropped without one. */
  commandStarted?: boolean;
  /** Set when a terminal `command_lifecycle` frame arrives for this turn's
   *  uuid while the turn is still queued (msg_lifecycle_v1 CLIs). The command
   *  is already finished SDK-side, so a later cancel() must not seed an
   *  orphan entry for it — no terminal frame will ever come to drain it.
   *  "completed"/"discarded" leave nothing outstanding; "cancelled" after a
   *  dispatch means the dead turn's result may still arrive (seeded as a
   *  zombie) unless it already passed (`commandResultSeen`), and without a
   *  dispatch means dropped (nothing coming). */
  commandFinished?: "completed" | "discarded" | "cancelled";
  /** Set when a user-turn result arrives while this command is known
   *  dispatched (`commandStarted`) with no terminal frame yet. Turns run
   *  sequentially and frames arrive in stream order, so the turn this command
   *  was dispatched into IS the turn that emitted that result — including
   *  when the command was FOLDED into another turn (their shared result).
   *  Read by cancel() and the force-cancel wedge path so neither seeds an
   *  orphan entry for a result that has already passed: such an entry could
   *  never be drained by its result and would swallow an unrelated later
   *  echo-less one instead. */
  commandResultSeen?: boolean;
  /** Task ids of the background subagents launched while this turn was the
   *  active one — including during its held-open drain window, so an agent
   *  chain (a followup that launches another subagent) extends the hold.
   *  A turn only waits on its OWN spawned subagents: a long-running agent
   *  from an earlier turn must not stall every later prompt's settlement.
   *  Known residual: task_started carries no lineage, so a spawn made by a
   *  PREVIOUS turn's followup chain while a later turn happens to be held
   *  is attributed to the holder — extending that hold behind a foreign
   *  chain. Bounded: the hold still ends at drain, hand-off, or cancel. */
  spawnedTaskIds?: Set<string>;
  /** Set instead of settling when the turn's terminal result arrives while
   *  subagents it spawned are still live (`spawnedTaskIds` ∩
   *  `session.liveBackgroundTasks`). The turn is held open — its
   *  `session/prompt` stays pending — so the subagents' streamed output,
   *  their permission requests (which would otherwise block on an RPC a
   *  client that stops consuming at the prompt response never answers —
   *  issue #866), and the model's task-notification followup summary all
   *  land inside the turn.
   *
   *  The CLI does NOT hold its trailing idle for background agents (observed
   *  on 2.1.206: `idle` follows the result immediately while the subagent
   *  still runs), so the hold spans multiple idle cycles: user result →
   *  idle → (subagent works) → task_notification → followup turn → idle.
   *  The stored outcome (the result's stop reason and usage snapshot) is
   *  what the turn settles with once its spawned subagents have settled —
   *  at the followup's terminal result (the summary has streamed by then),
   *  or at an idle with none of its subagents left (no followup came). A
   *  cancel or the next turn's echo hand-off settles it earlier, so a
   *  long-running subagent never holds the prompt hostage.
   *
   *  Accepted residuals. (1) A subagent that ends WITHOUT waking the model —
   *  its task_notification lost or skipped (only the terminal task_updated
   *  patch is guaranteed per transition) — leaves no followup result and no
   *  further idle, so the held turn parks until `session/cancel` or the next
   *  prompt (either settles it: the echo hand-off or ensureActiveTurn's
   *  held-turn hand-off). Settling at the prune sites instead would preempt
   *  the followup summary in the normal ordering (prunes precede the
   *  notification), and a grace timer was judged not worth the machinery —
   *  the same rescue contract as the adapter's other wedge classes (issue
   *  #825's out-of-scope notes). (2) Drained-ness is judged by live-task
   *  membership only: with parallel subagents, a notification that prunes
   *  the last task during an earlier task's still-streaming followup lets
   *  that followup's result settle the turn before the LAST task's summary
   *  streams — degrading to post-turn delivery for it, never worse than the
   *  pre-hold behavior (pending wakes are not countable: notifications can
   *  batch into one followup). */
  deferredSettle?: PromptResponse;
  resolve: (response: PromptResponse) => void;
  reject: (error: unknown) => void;
};

type Session = {
  query: Query;
  input: Pushable<SDKUserMessage>;
  cancelled: boolean;
  /** FIFO of in-flight prompts. The head is the turn the SDK is currently
   *  processing; later entries are queued and will be echoed in order. */
  turnQueue?: Turn[];
  /** The turn whose messages the consumer is currently attributing output to
   *  (the head of `turnQueue` once its user message has been echoed). */
  activeTurn?: Turn | null;
  /** Count of result messages the consumer should treat as orphans and skip
   *  (not promote/attribute to the current head). When cancel() settles+removes
   *  a queued turn, that turn's user message was already pushed to the SDK, so
   *  the SDK still runs it and emits a result with no uuid we can match. Because
   *  the SDK processes input FIFO, those orphan results arrive (in submission
   *  order) before the next live turn's, so skipping exactly this many leaves
   *  the genuine head untouched. On CLIs with the interrupt receipt, orphans
   *  the interrupt dropped (absent from `still_queued`) are uncounted as soon
   *  as the receipt arrives (see cancel()). Reset to 0 on every activation as
   *  a backstop against a dropped queued input this can't see (older CLIs, a
   *  receipt lost to a failed control round-trip). Only used when the CLI does
   *  NOT emit lifecycle frames (see `orphanCommands` for the msg_lifecycle_v1
   *  lane); a count can't express command coalescing — N queued commands can
   *  fold into ONE turn emitting one result, leaving a stale skip of N-1. */
  pendingOrphanResults?: number;
  /** msg_lifecycle_v1 lane of the orphan accounting (see
   *  `pendingOrphanResults` for the count lane): the uuids of cancelled queued
   *  turns whose SDK-side command may still produce an unaccounted result,
   *  keyed to what we know of its fate. "pending" = not seen dispatched; if
   *  the SDK drops it (interrupt, `cancelled` before "started") no result
   *  ever comes. "started" = dispatched into a turn whose result is still
   *  coming; exactly one terminal lifecycle frame will follow. "zombie" = its
   *  turn was aborted/failed after dispatch with no result seen since
   *  (`cancelled` after "started"); no more lifecycle frames come, but the
   *  dead turn's error result may still arrive. Entries are removed the
   *  moment their result is covered: EVERY user-turn result covers ALL
   *  started and zombie entries at once (turns run sequentially and frames
   *  arrive in stream order, so at any result the started entries were
   *  dispatched into — possibly folded into — the emitting turn, and any
   *  zombie's late result has already passed or never existed), whether that
   *  result was attributed to the active turn or skipped echo-less (see
   *  recordResultForOrphanCommands / ensureActiveTurn). A command's own
   *  terminal frame also drains its entry ("completed" is emitted after any
   *  result its turn produced; a bare `cancelled` deletes a pending entry —
   *  dropped without running — and zombifies a started one). An echo-less
   *  result is an orphan's iff this map is non-empty (FIFO: orphan turns run
   *  before any live turn's). Cleared on every activation, same self-heal as
   *  the count (covers a lost frame, which can leak an entry — each state
   *  bounds the damage to one wrong skip). */
  orphanCommands?: Map<string, "pending" | "started" | "zombie">;
  /** True once a `system`/init advertised the msg_lifecycle_v1 capability, so
   *  cancel() routes orphan accounting to `orphanCommands` (exact, per-uuid)
   *  instead of `pendingOrphanResults` (count, coalescing-blind). */
  msgLifecycleV1?: boolean;
  /** The long-lived consumer task. Lazily started on the first `prompt()` and
   *  kept alive for the session so between-turn/background messages are still
   *  drained and forwarded. */
  consumer?: Promise<void>;
  /** Set once the SDK query stream has terminated (it ran to `done` or threw a
   *  non-process error). The query iterator is not reusable afterward, so a
   *  later `prompt()` rejects instead of enqueueing onto a dead stream and
   *  hanging (or silently restarting a consumer that resolves `end_turn`
   *  without ever reaching the model). */
  queryClosed?: boolean;
  cwd: string;
  /** Serialized snapshot of session-defining params (cwd, mcpServers) used to
   *  detect when loadSession/resumeSession is called with changed values. */
  sessionFingerprint: string;
  settingsManager: SettingsManager;
  accumulatedUsage: AccumulatedUsage;
  modes: SessionModeState;
  models: SessionModelState;
  modelInfos: ModelInfo[];
  configOptions: SessionConfigOption[];
  /** Custom main-thread agent personas the user (or a plugin/project) has
   *  configured, discovered via `supportedAgents()` with Claude Code's built-in
   *  subagents filtered out. Empty when none are configured, in which case the
   *  "agent" config option is omitted entirely. */
  agents: AgentInfo[];
  /** The currently selected main-thread agent name, or "default" for the
   *  standard Claude Code agent (no `agent` flag applied). */
  currentAgent: string;
  /** Whether Fast mode is currently enabled for this session. Tracked as the
   *  user's intent so it persists across model switches; the Fast mode config
   *  option is only surfaced while the selected model supports it. */
  fastModeEnabled: boolean;
  abortController: AbortController;
  /** Signal the consumer races `query.next()` against. Aborted by cancel()
   *  (after a grace period) to force the active turn to settle "cancelled" when
   *  the SDK is wedged and `query.next()` never yields again (issue #680).
   *  Distinct from `abortController`: this only wakes the consumer; it does NOT
   *  touch the SDK query/subprocess. The consumer re-arms it after each fire.
   *  Undefined until the consumer is started by the first prompt. */
  cancelController?: AbortController;
  /** Pending grace-period timer that aborts `cancelController`. Cleared when the
   *  active turn settles normally so the backstop never fires after a clean
   *  cancel. */
  forceCancelTimer?: ReturnType<typeof setTimeout>;
  emitRawSDKMessages: boolean | SDKMessageFilter[];
  /** Context window size of the session's current model, carried across
   *  prompts so mid-stream usage_update notifications report a correct `size`
   *  before the turn's first result message arrives. Seeded from the SDK's
   *  getContextUsage report at session creation (DEFAULT_CONTEXT_WINDOW when
   *  that and the text heuristic both fail), refreshed the same way on model
   *  switches, and confirmed by each result's modelUsage. */
  contextWindowSize: number;
  /** Accumulated task list for the session, keyed by task ID. Task IDs are
   *  per-session, so this state must not be shared across sessions. */
  taskState: TaskState;
  /** Last session title we pushed to the client via `session_info_update`.
   *  The SDK auto-generates a title in a background task and persists it to the
   *  session file; we poll it on each turn-end (`session_state_changed: idle`)
   *  and only notify the client when it actually changes. Undefined until the
   *  first title is observed. */
  lastTitle?: string;
  /** Caches `tool_use` blocks by id so the matching `tool_result` can recover
   *  the tool name/input when mapping it to a `tool_call_update`. Per-session
   *  (tool_use ids are only unique within a session) and pruned at
   *  `tool_result` time so a long-running session doesn't accumulate every
   *  tool call for its whole lifetime. */
  toolUseCache: ToolUseCache;
  /** Tracks which tool_use ids we've already emitted a `tool_call` for, so the
   *  second source to encounter a tool call sends a `tool_call_update` instead
   *  of a duplicate `tool_call`. The SDK can invoke `canUseTool` (→ a permission
   *  request, which emits the tool_call eagerly so the client has it before
   *  being asked to approve it) either before or after the assistant message's
   *  tool_use block streams; this set makes the two paths converge regardless of
   *  order. Pruned at `tool_result` time alongside `toolUseCache`. */
  emittedToolCalls: Set<string>;
  /** Registry of live background tasks, keyed by task id: populated at
   *  `task_started`, pruned when the task settles (a `task_notification` or
   *  a terminal `task_updated` patch), and reconciled against
   *  `background_tasks_changed`'s replace-semantics payload so a lost
   *  bookend can't leak an entry. One structure for both of its concerns so
   *  a future terminal path can't prune one and not the other:
   *
   *  `parentToolUseId` — the tool_use id of the Agent/Task call that spawned
   *  the task. For subagent tasks the SDK keys its registry by agent id, so
   *  `task_started.task_id` IS the `agentID` that `canUseTool` later
   *  receives. Lets the permission flow attribute a subagent's
   *  eagerly-emitted `tool_call` (and the permission request itself) to its
   *  parent tool call via `_meta.claudeCode.parentToolUseId`, matching the
   *  streamed subagent path. Best-effort: a `canUseTool` that races ahead of
   *  the consumer processing `task_started` omits the attribution from the
   *  eager tool_call, and the streamed tool_use chunk's refining
   *  `tool_call_update` — which carries the message-level
   *  `parent_tool_use_id` — restores it for merging clients; that recovery
   *  is what makes best-effort acceptable here.
   *
   *  `isSubagent` — whether the task is a Task/Agent-tool subagent
   *  (`task_started` carried a `subagent_type`). Read by
   *  `turnAwaitingSubagents` (with `spawnedTaskIds`) to decide whether a
   *  turn's settlement is deferred (see `Turn.deferredSettle`), so the
   *  subagents' post-result output and permission requests stay inside the
   *  turn (issues #864/#866). Deliberately false for non-subagent background
   *  tasks (e.g. a `run_in_background` dev server): those can outlive every
   *  turn, and the model's contract with them is a wake-on-exit
   *  notification, not a turn-scoped drain — a hold must NEVER wait on a
   *  shell.
   *
   *  `endedPerLevel` — a `background_tasks_changed` payload did not include
   *  this subagent entry. The level's universe is BACKGROUND tasks only, so
   *  a live sync (foreground) subagent is legitimately absent — its entry is
   *  kept for permission attribution — but a hold must stop waiting on the
   *  id: an absent id can equally be a leaked async entry whose settle
   *  bookends were lost, and waiting on it would park the hold forever.
   *  Non-subagent entries are simply deleted instead (shells are always in
   *  the level's universe). */
  liveBackgroundTasks: Map<
    string,
    {
      parentToolUseId?: string;
      isSubagent: boolean;
      /** Absent-from-level lifecycle, one field so the illegal
       *  armed-but-not-ended state is unrepresentable: undefined = live per
       *  the level signal; "ended" = a level omitted the task (holds stop
       *  waiting on it; attribution is kept); "sweep-armed" = a turn
       *  activation saw it ended — the NEXT activation deletes it. The
       *  one-activation grace exists for the absent-mark race (a level
       *  payload built before a live async agent's registration): a
       *  corrective inclusive level resets the field to undefined — one
       *  assignment, disarming any in-flight sweep — if it arrives within a
       *  full turn, keeping the agent's attribution; eager deletion would
       *  be irreversible, since levels never ADD entries. A re-mark
       *  preserves an in-flight arm (`??=`), keeping a continuously absent
       *  entry on its two-activation clock. */
      endedPerLevel?: "ended" | "sweep-armed";
    }
  >;
  /** Whether any top-level assistant text reached the client since the last
   *  stretch boundary. Set as a side effect of sending in the consumer's
   *  `sendUpdate`, never at an emission site; read at the terminal `result`
   *  to tell a turn whose answer was already delivered from one that only
   *  ever carried it on `result` (issue #453). Session-level (not
   *  consumer-scoped) so cancel()'s inline settle can clear it.
   *
   *  The CURRENT boundary set — a new clear site must be added here: the
   *  result case's `finally` (user-turn results), settleActive's wasHeld
   *  clear (every held-turn settle lane: drain settle, both hand-offs,
   *  stream-done), failActive, the force-cancel backstop, the idle
   *  cancelled-settle, the autonomous-result close (only with no turn
   *  active OR queued — see its queued-turn guard), and cancel()'s inline
   *  mirror.
   *
   *  Deliberately NOT reset on turn activation: activation can fire
   *  mid-message (see the echo hand-off), so a flag cleared there would
   *  forget text that already streamed and the result text would be emitted
   *  a second time. Neither the consolidated `assistant` message nor a
   *  `stream_event` carries `origin`, so an autonomous cycle's prose is
   *  indistinguishable from a user turn's here and sets the flag too; the
   *  autonomous-result close normally ends that stretch so a replayed
   *  prompt behind it still delivers, and only in the racing window (a
   *  turn already active or queued when the autonomous result lands) does
   *  the replayed turn stay silent rather than risk a duplicate. */
  emittedAssistantText: boolean;
  /** The most recent `session_state_changed` state the consumer processed.
   *  Read by cancel() to decide whether the interrupt will produce a
   *  trailing idle worth pre-counting: interrupting a RUNNING cycle yields
   *  one; interrupting an already-idle session (the common held-turn shape)
   *  yields none, and a pre-counted debt that never drains would mask one
   *  future issue-#825 detection. */
  lastSessionState?: "idle" | "running" | "requires_action";
  /** How many trailing `session_state_changed: idle` messages are already
   *  accounted for: every result is followed by one (user-turn results that
   *  terminate a turn — settle, reject, or orphan skip — and autonomous
   *  cycles alike), as is a cancelled turn settled by the next turn's echo
   *  hand-off or by cancel()'s inline settle of a held turn whose interrupt
   *  pre-empts a running cycle — the reason this lives on the Session:
   *  cancel() must be able to record the debt. The idle handler absorbs
   *  owed idles; an idle that arrives when NONE is owed while the active
   *  turn is still unsettled means the SDK ended the turn without ever
   *  emitting its result, so the turn will never settle on its own (issue
   *  #825). Stream-level debt, deliberately NOT reset per turn: a lagged
   *  idle can arrive after the next turn has already activated (issue
   *  #773), and the debt is what attributes it to the turn that owed it.
   *  Over-counting (an idle the SDK never emits) is benign: the counter
   *  just absorbs one future idle, and detection degrades to the status quo
   *  rather than misfiring. */
  owedTrailingIdles: number;
  /** Maps the ACP `messageId` we expose to clients (see `messageIdForGrouping`)
   *  to the SDK message uuid that the Agent SDK's rewind/resume APIs key on
   *  (`Query.rewindFiles` takes a user-message uuid; `resumeSessionAt` takes an
   *  `SDKAssistantMessage.uuid`). For assistant turns the two differ — the ACP
   *  id is the Anthropic API message id (`msg_…`), available at `message_start`
   *  so streamed chunks can carry it, while the uuid only arrives on the
   *  consolidated message — so a client can only ask to rewind/fork by the id it
   *  was given, and we need this table to translate it back.
   *
   *  Populated as a byproduct of the message loop (the consolidated message
   *  carries both ids) and of `replaySessionHistory` on load, so no extra
   *  `getSessionMessages` read is needed at rewind time. Last-write-wins
   *  naturally yields the turn-boundary uuid when one `msg_…` spans several
   *  content-block messages.
   *
   *  NOT READ YET — recorded now so the mapping exists if/when we wire up
   *  fork/rewind. */
  messageIdToUuid: Map<string, string>;
};

/** Result-message origin kinds that mark an AUTONOMOUS cycle — work the
 *  model did on its own (a task-notification followup, a peer/coordinator/
 *  observer message it handled) rather than the user's prompt. Absent,
 *  `human`, and `channel` origins are the user's own turn (this adapter's
 *  prompts arrive as the ACP channel on some CLI configurations — ALL
 *  channel servers are treated as user, so a foreign channel integration's
 *  autonomously-handled result is misclassified as the user's; accepted,
 *  see below), and `auto-continuation` continues the user's turn, so its
 *  result is the turn's real terminal.
 *
 *  Deliberately fail-OPEN: an unknown future kind defaults to the user
 *  lane. Misrouting a USER result into the autonomous lane hangs the
 *  prompt un-detectably (the result is skipped, its trailing idle absorbed
 *  as owed, so the #825 detector can't fire); misrouting an autonomous
 *  result into the user lane is the bounded misattribution class this set
 *  exists to reduce. */
const AUTONOMOUS_RESULT_ORIGINS: ReadonlySet<SDKMessageOrigin["kind"]> = new Set([
  "task-notification",
  "peer",
  "coordinator",
  "observer",
  "observer-activity",
]);

/** Whether this turn's terminal result arrived but its settlement is being
 *  held for background subagents it spawned (see Turn.deferredSettle). The
 *  single spelling of the hold predicate, shared by the consumer's settle
 *  lanes and cancel(). */
function isHeldOpen(
  turn: Turn | null | undefined,
): turn is Turn & { deferredSettle: PromptResponse } {
  return turn != null && turn.deferredSettle !== undefined && !turn.settled;
}

/** Disarm the force-cancel backstop (see Session.forceCancelTimer). Every
 *  path that settles the active turn must run this so a timer can never fire
 *  on an already-settled turn — and must leave the field undefined, or the
 *  arm site's !forceCancelTimer guard would refuse to arm the backstop for
 *  the NEXT turn's cancel. */
function disarmForceCancel(session: Session): void {
  if (session.forceCancelTimer) {
    clearTimeout(session.forceCancelTimer);
    session.forceCancelTimer = undefined;
  }
}

/** Compute a stable fingerprint of the session-defining params so we can
 *  detect when a loadSession/resumeSession call requires tearing down and
 *  recreating the underlying Query process.  MCP servers are sorted by name
 *  so that ordering differences don't trigger unnecessary recreations. */
function computeSessionFingerprint(params: {
  cwd: string;
  mcpServers?: NewSessionRequest["mcpServers"];
}): string {
  const servers = [...(params.mcpServers ?? [])].sort((a, b) => a.name.localeCompare(b.name));
  return JSON.stringify({ cwd: params.cwd, mcpServers: servers });
}

export type SDKMessageFilter = {
  type: string;
  subtype?: string;
  origin?: SDKMessageOrigin["kind"];
};

/**
 * Extra metadata that can be given when creating a new session.
 */
export type NewSessionMeta = {
  claudeCode?: {
    /**
     * Options forwarded to Claude Code when starting a new session.
     * Those parameters will be ignored and managed by ACP:
     *   - cwd
     *   - includePartialMessages
     *   - allowDangerouslySkipPermissions
     *   - permissionMode
     *   - canUseTool
     *   - executable
     * Those parameters will be used and updated to work with ACP:
     *   - hooks (merged with ACP's hooks)
     *   - mcpServers (merged with ACP's mcpServers)
     *   - disallowedTools (merged with ACP's disallowedTools)
     *   - tools (passed through; defaults to claude_code preset if not provided)
     */
    options?: Options;
    /**
     * When set, raw SDK messages are emitted as extNotification("_claude/sdkMessage", message)
     * in addition to normal processing.
     * - true: emit all messages
     * - false/undefined: emit nothing (default)
     * - SDKMessageFilter[]: emit only messages matching at least one filter
     */
    emitRawSDKMessages?: boolean | SDKMessageFilter[];
  };
  additionalRoots?: string[];
};

/**
 * Extra metadata for 'gateway' authentication requests.
 */
type GatewayAuthMeta = {
  /**
   * These parameters are mapped to environment variables to:
   * - Redirect API calls via baseUrl
   * - Inject custom headers
   * - Bypass the default Claude login requirement
   */
  gateway: {
    baseUrl: string;
    headers: Record<string, string>;
  };
};

type GatewayAuthRequest = AuthenticateRequest & { _meta?: GatewayAuthMeta };

/**
 * Extra metadata that the agent provides for each tool_call / tool_update update.
 */
export type ToolUpdateMeta = {
  claudeCode?: {
    /* The name of the tool that was used in Claude Code. */
    toolName: string;
    /* The structured output provided by Claude Code. */
    toolResponse?: unknown;
    /* For a tool call made inside a subagent: the tool_use id of the
       Agent/Task call that spawned the subagent. Mirrors the SDK's
       `parent_tool_use_id` on streamed subagent messages. */
    parentToolUseId?: string;
  };
  /* Terminal metadata for Bash tool execution, matching codex-acp's _meta protocol. */
  terminal_info?: {
    terminal_id: string;
  };
  terminal_output?: {
    terminal_id: string;
    data: string;
  };
  terminal_exit?: {
    terminal_id: string;
    exit_code: number;
    signal: string | null;
  };
};

export type ToolUseCache = {
  [key: string]: {
    type: "tool_use" | "server_tool_use" | "mcp_tool_use";
    id: string;
    name: string;
    input: unknown;
  };
};

type StreamedToolInput = {
  id: string;
  name: string;
  partialJson: string;
  /** Offset into `partialJson` the scanner has consumed; each delta only scans
   *  the newly appended fragment, so total scan work stays linear. */
  scannedTo: number;
  inString: boolean;
  escaped: boolean;
  objectDepth: number;
  arrayDepth: number;
  /** Offset of the most recent comma at the top level of the input object
   *  (-1 before the first). Everything before it is a complete field. */
  lastTopLevelComma: number;
  /** The comma offset the last emitted refinement was sliced at (-1 before the
   *  first), so a field boundary only triggers one recovery attempt. */
  emittedThroughComma: number;
};

export type StreamedToolInputCache = Map<string, Map<number, StreamedToolInput>>;

/**
 * Advance the lexer state across the fragment appended since the last delta:
 * just enough JSON awareness (string/escape, nesting depth) to spot commas
 * that sit at the top level of the input object — everything before such a
 * comma is a set of complete fields. Returns true once the input object's
 * closing brace arrives.
 */
function scanStreamedToolInput(state: StreamedToolInput): boolean {
  let complete = false;
  for (let index = state.scannedTo; index < state.partialJson.length; index++) {
    const character = state.partialJson[index];
    if (state.inString) {
      if (state.escaped) {
        state.escaped = false;
      } else if (character === "\\") {
        state.escaped = true;
      } else if (character === '"') {
        state.inString = false;
      }
      continue;
    }

    if (character === '"') {
      state.inString = true;
    } else if (character === "{") {
      state.objectDepth++;
    } else if (character === "}") {
      state.objectDepth--;
      if (state.objectDepth === 0) {
        complete = true;
      }
    } else if (character === "[") {
      state.arrayDepth++;
    } else if (character === "]") {
      state.arrayDepth--;
    } else if (character === "," && state.objectDepth === 1 && state.arrayDepth === 0) {
      state.lastTopLevelComma = index;
    }
  }
  state.scannedTo = state.partialJson.length;
  return complete;
}

/** Parse the complete top-level fields before a top-level comma by closing the
 *  object at that boundary. */
function recoveredToolInput(prefix: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(prefix + "}");
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

export async function claudeCliPath(): Promise<string> {
  if (process.env.CLAUDE_CODE_EXECUTABLE) {
    return process.env.CLAUDE_CODE_EXECUTABLE;
  }
  // The SDK's CLI is a native binary shipped as a platform-specific optional
  // dependency of @anthropic-ai/claude-agent-sdk. Resolve via a require bound
  // to the SDK so nested installs are found even when npm doesn't hoist.
  const { createRequire } = await import("node:module");
  const req = createRequire(import.meta.resolve("@anthropic-ai/claude-agent-sdk"));
  const ext = process.platform === "win32" ? ".exe" : "";
  // On linux, both glibc and musl variants may be installed side-by-side
  // (e.g. bunx hydrates every optional dep), so picking one by trial is
  // unreliable: the wrong binary segfaults at runtime instead of failing to
  // spawn. Detect the runtime libc and prefer the matching variant, falling
  // back to the other only if the preferred one isn't installed.
  const candidates =
    process.platform === "linux"
      ? isMuslLibc()
        ? [
            `@anthropic-ai/claude-agent-sdk-linux-${process.arch}-musl/claude${ext}`,
            `@anthropic-ai/claude-agent-sdk-linux-${process.arch}/claude${ext}`,
          ]
        : [
            `@anthropic-ai/claude-agent-sdk-linux-${process.arch}/claude${ext}`,
            `@anthropic-ai/claude-agent-sdk-linux-${process.arch}-musl/claude${ext}`,
          ]
      : [`@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/claude${ext}`];
  for (const candidate of candidates) {
    try {
      return req.resolve(candidate);
    } catch {
      // try next candidate
    }
  }
  throw new Error(
    `Claude native binary not found for ${process.platform}-${process.arch}. ` +
      `Reinstall @anthropic-ai/claude-agent-sdk without --omit=optional, or set CLAUDE_CODE_EXECUTABLE.`,
  );
}

function isMuslLibc(): boolean {
  // process.report.getReport().header.glibcVersionRuntime is populated when
  // Node is dynamically linked against glibc, and absent on musl.
  const report = process.report?.getReport() as
    { header?: { glibcVersionRuntime?: string } } | undefined;
  return !report?.header?.glibcVersionRuntime;
}

function shouldHideClaudeAuth(): boolean {
  return process.argv.includes("--hide-claude-auth");
}

/** Returned to clients when a prompt or cancel targets a session whose SDK
 *  query stream has already ended (ran to `done` or died). The stream is not
 *  revivable, so the only recovery is a fresh session. */
const SESSION_ENDED_MESSAGE = "The Claude Agent session has ended. Please start a new session.";

// Bypass Permissions doesn't work if we are a root/sudo user
const IS_ROOT = (process.geteuid?.() ?? process.getuid?.()) === 0;
const ALLOW_BYPASS = !IS_ROOT || !!process.env.IS_SANDBOX;

// Slash commands that the SDK handles locally without replaying the user
// message and without invoking the model.
const LOCAL_ONLY_COMMANDS = new Set(["/context", "/heapdump", "/extra-usage"]);

// The Claude SDK persists local slash command invocations (e.g. `/model`) and
// their output as user messages in the session transcript, wrapping the
// payload in these XML-like markers that the CLI uses for its own display.
// The live prompt loop drops them; replay must strip them too or they leak
// into the UI on session/load.
const LOCAL_COMMAND_MARKERS = [
  "command-name",
  "command-message",
  "command-args",
  "local-command-stdout",
  "local-command-stderr",
].map((tag) => ({ open: `<${tag}>`, close: `</${tag}>` }));

// Single-pass scanner that removes each `<tag>…</tag>` marker (matching the
// nearest closing tag of the same name, like a lazy regex would).
function stripMarkerTags(text: string): string {
  const dead = new Set<string>();
  let result = "";
  let copiedUpTo = 0;
  let i = 0;
  while (i < text.length) {
    if (text[i] === "<") {
      const marker = LOCAL_COMMAND_MARKERS.find(
        (m) => !dead.has(m.open) && text.startsWith(m.open, i),
      );
      if (marker) {
        const end = text.indexOf(marker.close, i + marker.open.length);
        if (end !== -1) {
          result += text.slice(copiedUpTo, i);
          i = copiedUpTo = end + marker.close.length;
          continue;
        }
        // No closing marker remains anywhere ahead, and `indexOf` only ever
        // searches forward from here on, so stop treating this tag as an
        // opener — that avoids rescanning the tail for it on every match.
        dead.add(marker.open);
      }
    }
    i++;
  }
  return result + text.slice(copiedUpTo);
}

/**
 * Return user-message content with local-command marker tags removed, or
 * `null` if nothing meaningful remains (caller should skip the message).
 * Preserves real prose that's mixed in alongside the markers — e.g. a
 * message like `<command-name>…</command-name>hi` becomes `hi`.
 */
export function stripLocalCommandMetadata(content: unknown): unknown | null {
  if (typeof content === "string") {
    const stripped = stripMarkerTags(content);
    return stripped.trim() === "" ? null : stripped;
  }
  if (!Array.isArray(content)) return content;

  const kept: unknown[] = [];
  for (const block of content) {
    if (
      block &&
      typeof block === "object" &&
      "type" in block &&
      (block as { type: unknown }).type === "text" &&
      "text" in block &&
      typeof (block as { text: unknown }).text === "string"
    ) {
      const stripped = stripMarkerTags((block as { text: string }).text);
      if (stripped.trim() === "") continue;
      kept.push({ ...(block as object), text: stripped });
    } else {
      kept.push(block);
    }
  }
  if (kept.length === 0) return null;
  return kept;
}

export function isLocalCommandMetadata(content: unknown): boolean {
  return stripLocalCommandMetadata(content) === null;
}

/**
 * True for the synthetic assistant message the CLI injects into the transcript
 * when a turn fails authentication (e.g. "Not logged in · Please run /login",
 * "Session expired. Please run /login to sign in again."). The `/login`
 * instruction is Claude Code TUI-specific and meaningless to ACP clients
 * (issue #863). The live prompt loop suppresses the text and fails the turn
 * with `authRequired` so the client can run its own auth flow; replay must
 * skip it too — both for parity with what the client saw live and because the
 * message stays in the transcript forever, so it would resurface on every
 * session/load even after the user has logged back in.
 *
 * Takes the API message (`message.message`), which replay only knows as
 * `unknown`. The persisted record's structured `error: "authentication_failed"`
 * marker is stripped by `getSessionMessages`, so the synthetic model + text is
 * all both paths have to match on.
 */
export function isSyntheticLoginMessage(apiMessage: unknown): boolean {
  if (!apiMessage || typeof apiMessage !== "object") {
    return false;
  }
  const { model, content } = apiMessage as { model?: unknown; content?: unknown };
  if (model !== "<synthetic>" || !Array.isArray(content) || content.length !== 1) {
    return false;
  }
  const block = content[0] as { type?: unknown; text?: unknown } | null;
  return (
    !!block &&
    block.type === "text" &&
    typeof block.text === "string" &&
    block.text.includes("Please run /login")
  );
}

const PERMISSION_MODE_ALIASES: Record<string, PermissionMode> = {
  auto: "auto",
  default: "default",
  // Claude Code 2.1.200 renamed the "default" mode to "Manual" and accepts
  // `"defaultMode": "manual"` in settings.json; honor the same alias here.
  manual: "default",
  acceptedits: "acceptEdits",
  dontask: "dontAsk",
  plan: "plan",
  bypasspermissions: "bypassPermissions",
  bypass: "bypassPermissions",
};

export function resolvePermissionMode(
  defaultMode?: unknown,
  logger: Logger = console,
): PermissionMode {
  if (defaultMode === undefined) {
    return "default";
  }

  if (typeof defaultMode !== "string") {
    logger.error("Ignoring permissions.defaultMode from settings: expected a string.");
    return "default";
  }

  const normalized = defaultMode.trim().toLowerCase();
  if (normalized === "") {
    logger.error("Ignoring permissions.defaultMode from settings: expected a non-empty string.");
    return "default";
  }

  const mapped = PERMISSION_MODE_ALIASES[normalized];
  if (!mapped) {
    logger.error(`Ignoring permissions.defaultMode from settings: unknown value '${defaultMode}'.`);
    return "default";
  }

  if (mapped === "bypassPermissions" && !ALLOW_BYPASS) {
    logger.error(
      "Ignoring permissions.defaultMode from settings: bypassPermissions is not available when running as root.",
    );
    return "default";
  }

  return mapped;
}

/**
 * Builds the label for the "Always Allow" permission option so the user can see
 * the exact scope they are committing to. Uses the SDK-provided suggestions
 * when available (e.g. `Bash(npm test:*)`) and falls back to naming the whole
 * tool so "Always Allow" is never a blank check without disclosure.
 */
export function describeAlwaysAllow(
  suggestions: PermissionUpdate[] | undefined,
  toolName: string,
): string {
  if (!suggestions || suggestions.length === 0) {
    return `Always Allow all ${toolName}`;
  }

  const ruleLabels: string[] = [];
  const directories: string[] = [];

  for (const update of suggestions) {
    if (update.type === "addRules" && update.behavior === "allow") {
      for (const rule of update.rules) {
        ruleLabels.push(
          rule.ruleContent ? `${rule.toolName}(${rule.ruleContent})` : `all ${rule.toolName}`,
        );
      }
    } else if (update.type === "addDirectories") {
      directories.push(...update.directories);
    }
  }

  const parts: string[] = [];
  if (ruleLabels.length > 0) {
    parts.push(ruleLabels.join(", "));
  }
  if (directories.length > 0) {
    parts.push(`access to ${directories.join(", ")}`);
  }

  if (parts.length === 0) {
    return `Always Allow all ${toolName}`;
  }

  return `Always Allow ${parts.join(" and ")}`;
}

/**
 * Client-facing surface the agent calls back into. This is the subset of ACP
 * client methods the agent actually uses, expressed as a narrow interface so
 * tests can supply lightweight mocks. In production it is backed by
 * {@link ClientConnection} over the SDK's typed `AgentContext`.
 */
export interface AcpClient {
  sessionUpdate(params: SessionNotification): Promise<void>;
  /** `signal`, when aborted, sends `$/cancel_request` for the in-flight
   *  permission request so the client can dismiss its prompt (and settle our
   *  await) instead of leaving the dialog open after the turn was cancelled. */
  requestPermission(
    params: RequestPermissionRequest,
    signal?: AbortSignal,
  ): Promise<RequestPermissionResponse>;
  readTextFile(params: ReadTextFileRequest): Promise<ReadTextFileResponse>;
  writeTextFile(params: WriteTextFileRequest): Promise<WriteTextFileResponse>;
  /** `signal`, when aborted, sends `$/cancel_request` for the in-flight
   *  elicitation so the client can dismiss its prompt and settle our await. */
  unstable_createElicitation(
    params: CreateElicitationRequest,
    signal?: AbortSignal,
  ): Promise<CreateElicitationResponse>;
  unstable_completeElicitation(params: CompleteElicitationNotification): Promise<void>;
  /** Send a custom (extension) notification, e.g. `_claude/sdkMessage`. */
  extNotification(method: string, params: Record<string, unknown>): Promise<void>;
}

/**
 * Bridges {@link AcpClient} to the connection-scoped {@link AgentContext}
 * exposed by `AgentApp.connect(...)` as `connection.client`. The peer handle is
 * valid for the entire connection lifetime, so it is captured once at
 * construction.
 */
class ClientConnection implements AcpClient {
  constructor(private readonly ctx: AgentContext) {}

  sessionUpdate(params: SessionNotification): Promise<void> {
    return this.ctx.notify(methods.client.session.update, params);
  }

  requestPermission(
    params: RequestPermissionRequest,
    signal?: AbortSignal,
  ): Promise<RequestPermissionResponse> {
    return this.ctx.request(methods.client.session.requestPermission, params, {
      cancellationSignal: signal,
    });
  }

  readTextFile(params: ReadTextFileRequest): Promise<ReadTextFileResponse> {
    return this.ctx.request(methods.client.fs.readTextFile, params);
  }

  writeTextFile(params: WriteTextFileRequest): Promise<WriteTextFileResponse> {
    return this.ctx.request(methods.client.fs.writeTextFile, params);
  }

  unstable_createElicitation(
    params: CreateElicitationRequest,
    signal?: AbortSignal,
  ): Promise<CreateElicitationResponse> {
    return this.ctx.request(methods.client.elicitation.create, params, {
      cancellationSignal: signal,
    });
  }

  unstable_completeElicitation(params: CompleteElicitationNotification): Promise<void> {
    return this.ctx.notify(methods.client.elicitation.complete, params);
  }

  extNotification(method: string, params: Record<string, unknown>): Promise<void> {
    return this.ctx.notify(method, params);
  }
}

export class ClaudeAcpAgent {
  sessions: {
    [key: string]: Session;
  };
  client: AcpClient;
  clientCapabilities?: ClientCapabilities;
  logger: Logger;
  gatewayAuthRequest?: GatewayAuthRequest;
  /** Grace period before a `session/cancel` forces a wedged prompt loop to
   *  return "cancelled". See {@link DEFAULT_FORCE_CANCEL_GRACE_MS}. Mutable so
   *  tests can shrink it. */
  forceCancelGraceMs: number = DEFAULT_FORCE_CANCEL_GRACE_MS;

  constructor(client: AcpClient, logger?: Logger) {
    this.sessions = {};
    this.client = client;
    this.logger = logger ?? console;
  }

  async initialize(request: InitializeRequest): Promise<InitializeResponse> {
    this.clientCapabilities = request.clientCapabilities;

    // Bypasses standard auth by routing requests through a custom Anthropic-protocol gateway.
    // Only offered when the client advertises `auth._meta.gateway` capability.
    const supportsGatewayAuth = request.clientCapabilities?.auth?._meta?.gateway === true;

    const gatewayAuthMethod: AuthMethod = {
      id: "gateway",
      name: "Custom model gateway",
      description: "Use a custom gateway to authenticate and access models",
      _meta: {
        gateway: {
          protocol: "anthropic",
        },
      },
    };

    const gatewayBedrockAuthMethod: AuthMethod = {
      id: "gateway-bedrock",
      name: "Custom model gateway",
      description: "Use a custom gateway to authenticate and access models",
      _meta: {
        gateway: {
          protocol: "bedrock",
        },
      },
    };

    const supportsTerminalAuth = request.clientCapabilities?.auth?.terminal === true;
    const supportsMetaTerminalAuth = request.clientCapabilities?._meta?.["terminal-auth"] === true;

    // Detect remote environments where the OAuth browser redirect to localhost
    // won't work. This matches the SDK's internal isRemote check. In these cases,
    // the `auth login` subcommand would fall back to a device-code-like manual
    // flow, which doesn't work well over ACP, so we offer the TUI login instead.
    const isRemote = !!(
      process.env.NO_BROWSER ||
      process.env.SSH_CONNECTION ||
      process.env.SSH_CLIENT ||
      process.env.SSH_TTY ||
      process.env.CLAUDE_CODE_REMOTE
    );
    const terminalAuthMethods: AuthMethod[] = [];

    if (isRemote) {
      const remoteLoginMethod: AuthMethod = {
        description: "Run `claude /login` in the terminal",
        name: "Log in with Claude",
        id: "claude-login",
        type: "terminal",
        args: ["--cli"],
      };

      if (supportsMetaTerminalAuth) {
        remoteLoginMethod._meta = {
          "terminal-auth": {
            command: process.execPath,
            args: [...process.argv.slice(1), "--cli"],
            label: "Claude Login",
          },
        };
      }

      if (!shouldHideClaudeAuth() && (supportsTerminalAuth || supportsMetaTerminalAuth)) {
        terminalAuthMethods.push(remoteLoginMethod);
      }
    } else {
      const claudeLoginMethod: AuthMethod = {
        description: "Use Claude subscription ",
        name: "Claude Subscription",
        id: "claude-ai-login",
        type: "terminal",
        args: ["--cli", "auth", "login", "--claudeai"],
      };

      const consoleLoginMethod: AuthMethod = {
        description: "Use Anthropic Console (API usage billing)",
        name: "Anthropic Console",
        id: "console-login",
        type: "terminal",
        args: ["--cli", "auth", "login", "--console"],
      };

      if (supportsMetaTerminalAuth) {
        const baseArgs = process.argv.slice(1);
        claudeLoginMethod._meta = {
          "terminal-auth": {
            command: process.execPath,
            args: [...baseArgs, "--cli", "auth", "login", "--claudeai"],
            label: "Claude Login",
          },
        };
        consoleLoginMethod._meta = {
          "terminal-auth": {
            command: process.execPath,
            args: [...baseArgs, "--cli", "auth", "login", "--console"],
            label: "Anthropic Console Login",
          },
        };
      }

      if (!shouldHideClaudeAuth() && (supportsTerminalAuth || supportsMetaTerminalAuth)) {
        terminalAuthMethods.push(claudeLoginMethod);
      }
      if (supportsTerminalAuth || supportsMetaTerminalAuth) {
        terminalAuthMethods.push(consoleLoginMethod);
      }
    }

    return {
      protocolVersion: 1,
      agentCapabilities: {
        _meta: {
          claudeCode: {
            promptQueueing: true,
          },
        },
        promptCapabilities: {
          image: true,
          embeddedContext: true,
        },
        mcpCapabilities: {
          http: true,
          sse: true,
        },
        auth: {
          logout: {},
        },
        loadSession: true,
        sessionCapabilities: {
          additionalDirectories: {},
          close: {},
          delete: {},
          fork: {},
          list: {},
          resume: {},
        },
      },
      agentInfo: {
        name: packageJson.name,
        title: "Claude Agent",
        version: packageJson.version,
      },
      authMethods: [
        ...terminalAuthMethods,
        ...(supportsGatewayAuth ? [gatewayAuthMethod, gatewayBedrockAuthMethod] : []),
      ],
    };
  }

  async newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
    const response = await this.createSession(params, {
      // Revisit these meta values once we support resume
      resume: (params._meta as NewSessionMeta | undefined)?.claudeCode?.options?.resume,
    });
    // Needs to happen after we return the session
    setTimeout(() => {
      this.sendAvailableCommandsUpdate(response.sessionId);
    }, 0);
    return response;
  }

  async unstable_forkSession(params: ForkSessionRequest): Promise<ForkSessionResponse> {
    const response = await this.createSession(
      {
        cwd: params.cwd,
        mcpServers: params.mcpServers ?? [],
        additionalDirectories: params.additionalDirectories,
        _meta: params._meta,
      },
      {
        resume: params.sessionId,
        forkSession: true,
      },
    );
    // Needs to happen after we return the session
    setTimeout(() => {
      this.sendAvailableCommandsUpdate(response.sessionId);
    }, 0);
    return response;
  }

  async resumeSession(params: ResumeSessionRequest): Promise<ResumeSessionResponse> {
    const result = await this.getOrCreateSession(params);

    // Needs to happen after we return the session
    setTimeout(() => {
      this.sendAvailableCommandsUpdate(params.sessionId);
    }, 0);
    return result;
  }

  async loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse> {
    const result = await this.getOrCreateSession(params);

    await this.replaySessionHistory(params.sessionId);

    // Send available commands after replay so it doesn't interleave with history
    setTimeout(() => {
      this.sendAvailableCommandsUpdate(params.sessionId);
    }, 0);

    return result;
  }

  async listSessions(params: ListSessionsRequest): Promise<ListSessionsResponse> {
    const sdk_sessions = await listSessions({ dir: params.cwd ?? undefined });
    const sessions = [];

    for (const session of sdk_sessions) {
      if (!session.cwd) continue;
      sessions.push({
        sessionId: session.sessionId,
        cwd: session.cwd,
        title: sanitizeTitle(session.summary),
        updatedAt: new Date(session.lastModified).toISOString(),
      });
    }
    return {
      sessions,
    };
  }

  /** Read the SDK-maintained title for a session and, if it changed since the
   *  last time we looked, notify the client with a `session_info_update`. The
   *  SDK has no push event for the title it auto-generates in the background, so
   *  we pull it at turn-end. A missing session file or read error is non-fatal:
   *  the title is best-effort and another turn will retry. */
  private async maybeUpdateSessionTitle(sessionId: string, session: Session): Promise<void> {
    let info;
    try {
      info = await getSessionInfo(sessionId, { dir: session.cwd });
    } catch (error) {
      this.logger.error(`Session ${sessionId}: failed to read session info: ${error}`);
      return;
    }
    // `customTitle` is a user-set `/rename`; `summary` is the auto-generated
    // title (or first prompt). Prefer the explicit title when present.
    const rawTitle = info?.customTitle ?? info?.summary;
    if (!rawTitle) {
      return;
    }
    const title = sanitizeTitle(rawTitle);
    if (title === session.lastTitle) {
      return;
    }
    session.lastTitle = title;
    await this.client.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: "session_info_update",
        title,
        updatedAt: new Date(info!.lastModified).toISOString(),
      },
    });
  }

  async authenticate(_params: AuthenticateRequest): Promise<void> {
    if (_params.methodId === "gateway" || _params.methodId === "gateway-bedrock") {
      this.gatewayAuthRequest = _params as GatewayAuthRequest;
      return;
    }
    throw new Error("Method not implemented.");
  }

  async logout(_params: LogoutRequest): Promise<void> {
    // Clear in-memory gateway credentials supplied via `authenticate`. The
    // gateway method never touches the on-disk credential store, so dropping
    // this reference is the whole logout for that path.
    this.gatewayAuthRequest = undefined;

    // For the Claude/Console login methods the credentials live in the native
    // CLI's store (keychain or config dir), which only the binary can clear.
    // `claude auth logout` is non-interactive and idempotent.
    const cliPath = await claudeCliPath();
    try {
      await execFileAsync(cliPath, ["auth", "logout"]);
    } catch (error) {
      const stderr =
        typeof error === "object" && error && "stderr" in error
          ? String((error as { stderr: unknown }).stderr).trim()
          : undefined;
      throw RequestError.internalError(
        { stderr: stderr || undefined },
        `claude auth logout failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async prompt(params: PromptRequest): Promise<PromptResponse> {
    const session = this.sessions[params.sessionId];
    if (!session) {
      throw new Error("Session not found");
    }
    // The SDK query stream already terminated (see `queryClosed`); its iterator
    // can't be revived, so enqueueing here would hang on a deferred that never
    // settles. Fail clearly and let the client start a fresh session.
    if (session.queryClosed) {
      throw RequestError.internalError(undefined, SESSION_ENDED_MESSAGE);
    }

    const userMessage = promptToClaude(params);
    const promptUuid = randomUUID();
    userMessage.uuid = promptUuid;

    // Local-only commands (e.g. `/clear`) return a result without replaying the
    // user message, so the consumer can't promote the turn from the echo.
    const firstText = params.prompt[0]?.type === "text" ? params.prompt[0].text : "";
    const isLocalOnlyCommand =
      firstText.startsWith("/") && LOCAL_ONLY_COMMANDS.has(firstText.split(" ", 1)[0]);

    // Each prompt is a Turn whose deferred the persistent consumer settles once
    // the turn's outcome is known. `prompt()` owns no loop: it enqueues the
    // turn, pushes the user message onto the streaming input, makes sure the
    // consumer is running, and awaits the deferred.
    const turn: Turn = {
      promptUuid,
      isLocalOnlyCommand,
      settled: false,
      resolve: () => {},
      reject: () => {},
    };
    const response = new Promise<PromptResponse>((resolve, reject) => {
      turn.resolve = resolve;
      turn.reject = reject;
    });

    session.turnQueue ??= [];
    session.turnQueue.push(turn);
    session.input.push(userMessage);
    this.ensureConsumer(session, params.sessionId);
    return response;
  }

  /** Lazily start the per-session consumer that drains the SDK query stream for
   *  the session's whole life. Idempotent: only the first `prompt()` starts it. */
  private ensureConsumer(session: Session, sessionId: string): void {
    if (session.consumer) {
      return;
    }
    // Wake-up channel so cancel() can force the consumer to settle the active
    // turn "cancelled" even when query.next() is wedged and never yields again
    // (issue #680). The consumer re-arms it after each fire.
    session.cancelController = new AbortController();
    session.consumer = this.runConsumer(session, { sessionId });
    session.consumer.catch((error) => {
      this.logger.error(`Session ${sessionId}: consumer terminated unexpectedly: ${error}`);
    });
  }

  /** The single, long-lived consumer of the SDK query stream for a session. It
   *  forwards every message as ACP `sessionUpdate`s (so background/between-turn
   *  output streams live, not just while a prompt is awaiting) and settles each
   *  Turn's deferred when that turn ends. Replaces the per-prompt message loop;
   *  `params` only carries the (session-invariant) `sessionId`. */
  private async runConsumer(session: Session, params: { sessionId: string }): Promise<void> {
    // Per-turn scratch, reset whenever a turn becomes active. Kept as consumer
    // locals (rather than per-Turn fields) because they describe the message
    // currently being processed, which is sequential — exactly one turn is
    // active at a time. Mirrors the locals the old per-prompt loop held.
    let lastAssistantTotalUsage: number | null = null;
    let lastAssistantUsage: UsageSnapshot | null = null;
    let lastAssistantModel: string | null = null;
    // When the Claude SDK classifies a turn as failed (e.g. rate limit, auth
    // problem, billing), it sets a categorical `error` field on the
    // `SDKAssistantMessage` that precedes the final `result` message. We capture
    // it here so the subsequent `RequestError.internalError` can forward it to
    // clients as structured `data`, sparing them from pattern-matching on text.
    let lastAssistantError: SDKAssistantMessageError | undefined;
    // When a streaming classifier refuses a turn, the assistant message carries
    // stop_reason "refusal" and structured stop_details. We capture the
    // human-readable explanation so the terminal `result` can surface it.
    let lastRefusalExplanation: string | null = null;
    // Tracks whether we're inside a compaction. The SDK emits the terminal
    // `status` (compact_result success/failed) twice for a single failed
    // compaction, and the two messages are indistinguishable — so we report the
    // outcome only while a compaction is in progress, then clear this.
    let compactionInProgress = false;
    // Anthropic API message id of the assistant message currently being
    // streamed, captured from `message_start` so the streamed chunks that follow
    // (whose delta events don't carry it) can all be tagged with the same,
    // replay-stable id.
    let currentStreamMessageId: string | undefined;
    // The text/thinking blocks that have actually streamed live as
    // `stream_event` deltas for the message the next consolidated `assistant`
    // will repeat, in stream order, each accumulated to its full streamed text.
    // The consolidated handler diffs each assembled block against these and
    // forwards only the un-streamed remainder — nothing if it streamed in full
    // (the common case), the whole block if it never streamed (a non-streaming
    // gateway), or just the tail if the stream was cut short mid-block. Matching
    // on content rather than the Anthropic message id makes dedupe robust to
    // gateways that don't carry a stable/matching id across the stream and the
    // consolidated message. Reset after each consolidated message consumes it.
    const streamedBlocks: { index: number; type: "text" | "thinking"; text: string }[] = [];
    // Tool-use blocks start streaming before their JSON input. Keep the
    // partial input per parent message and block index so completed top-level
    // fields can refine the pending tool call while it streams. Entries are
    // dropped at block/message boundaries; the whole map is swept when a turn
    // settles, since an interrupted subagent stream (keyed by a
    // parent_tool_use_id that never recurs) has no boundary event of its own.
    const streamedToolInputs: StreamedToolInputCache = new Map();
    // Stop reason accumulated for the active turn (result subtype, refusal,
    // max_tokens, …). Reset per turn; read when the turn settles at idle.
    let stopReason: StopReason = "end_turn";
    /** The consumer's single send chokepoint: every `sessionUpdate` in this
     *  loop goes through here (never `this.client.sessionUpdate` directly) so
     *  answer-delivery tracking is a property of sending, not something each
     *  emission site must remember. A top-level `agent_message_chunk` marks
     *  the stretch's answer as delivered; subagent-attributed chunks are
     *  recognizable by the `parentToolUseId` meta that toAcpNotifications
     *  stamps from `parent_tool_use_id`, and never reach the top-level feed
     *  as the turn's answer. */
    const sendUpdate = async (notification: SessionNotification) => {
      const { update } = notification;
      if (update.sessionUpdate === "agent_message_chunk") {
        const claudeMeta = update._meta?.claudeCode as
          { parentToolUseId?: string | null } | undefined;
        if (!claudeMeta?.parentToolUseId) {
          session.emittedAssistantText = true;
        }
      }
      await this.client.sessionUpdate(notification);
    };

    const resetTurnScratch = () => {
      lastAssistantTotalUsage = null;
      lastAssistantUsage = null;
      lastAssistantModel = null;
      lastAssistantError = undefined;
      lastRefusalExplanation = null;
      compactionInProgress = false;
      // Do NOT reset currentStreamMessageId or streamedBlocks here. Turn
      // activation can fire mid-message (the replayed user echo with
      // --replay-user-messages lands between a message's blocks); clearing the
      // streamed-content record on activation would drop the blocks that
      // streamed before the echo, so the consolidated assistant message would
      // re-emit them as duplicates. streamedBlocks is bounded instead by being
      // cleared when each consolidated message consumes it. #785 stopped
      // resetting the streamed-content tracking here but left this line.
      stopReason = "end_turn";
      session.accumulatedUsage = {
        inputTokens: 0,
        outputTokens: 0,
        cachedReadTokens: 0,
        cachedWriteTokens: 0,
      };
    };

    /** Promote a queued turn to active: it becomes the one output is attributed
     *  to, and its scratch starts fresh. Clears the cancelled flag so a turn
     *  enqueued after a prior cancel isn't treated as cancelled. Also clears any
     *  leftover orphan-skip count: since the SDK echoes/runs input FIFO, every
     *  orphan from a prior cancel has already arrived by the time a live turn
     *  activates, so a non-zero remainder means the SDK dropped a queued turn on
     *  interrupt (no orphan emitted) — drop the stale count so a later echo-less
     *  result isn't wrongly skipped. */
    const activateTurn = (turn: Turn) => {
      session.activeTurn = turn;
      session.cancelled = false;
      session.pendingOrphanResults = 0;
      session.orphanCommands?.clear();
      // Two-phase sweep of registry entries the level signal ended (see
      // the endedPerLevel field doc): armed at the first activation,
      // deleted at the second — the same activation-time self-heal as the
      // orphan lanes, and the growth bound for leaked entries whose settle
      // bookends never arrive. The one-activation grace lets a corrective
      // inclusive level rescue a live async agent that a racing payload
      // absent-marked (deletion is irreversible: levels never ADD entries).
      // Local-only commands don't advance the clock: two quick /context
      // calls would otherwise burn the whole grace in seconds of wall time
      // while the corrective level is still in flight, and they interact
      // with no tasks — a later real turn still bounds growth.
      if (!turn.isLocalOnlyCommand) {
        for (const [taskId, record] of session.liveBackgroundTasks) {
          if (!record.endedPerLevel) {
            continue;
          }
          if (record.endedPerLevel === "sweep-armed") {
            session.liveBackgroundTasks.delete(taskId);
          } else {
            record.endedPerLevel = "sweep-armed";
          }
        }
      }
      resetTurnScratch();
    };

    /** Ensure there is an active turn before a user-turn result that carries no
     *  echo to activate it, by promoting the queue head. Most turns are
     *  activated by their replayed user message before their result, but some
     *  legitimately produce a result with no matching echo: local-only commands
     *  (e.g. `/context`) and compaction (`/compact`, whose only user messages
     *  are the generated summary and a `<local-command-stdout>` replay — neither
     *  carries the prompt's uuid). Promoting the head settles those.
     *
     *  But an echo-less result can also be an ORPHAN: cancel() settles+removes a
     *  queued turn whose user message was already pushed, so the SDK still runs
     *  it and emits a result with no uuid to match. Promoting the head for an
     *  orphan would misattribute its stop reason/usage to an unrelated later
     *  prompt. `session.pendingOrphanResults` counts exactly how many such
     *  orphans are still expected (FIFO, they arrive before any live turn's
     *  result), so we skip those and only promote once the count is drained. */
    const ensureActiveTurn = () => {
      if (session.activeTurn) {
        if (!isHeldOpen(session.activeTurn)) {
          return;
        }
        // A held turn (Turn.deferredSettle) already produced its result, so
        // this incoming user-turn result cannot be its — it belongs to the
        // next queued command (an echo-less one, e.g. `/context` sent while
        // the hold drains; a normal prompt's echo would have handed the held
        // turn off before its result). Settle the held turn with its
        // recorded outcome — the user moving on outranks the hold, same
        // contract as the echo hand-off — and fall through to promote the
        // queue head, which this result belongs to. Without this, the head
        // would never be promoted (echo-less turns have no other promotion
        // path) and its prompt would hang, while this result's outcome
        // overwrote the held turn's. Orphan lanes below are necessarily
        // empty while a turn is held: orphans are seeded by cancel(), which
        // inline-settles a held turn, and activation cleared older ones.
        // settleActive also closes the held turn's delivery stretch, so the
        // promoted command's own delivery decision is not judged against the
        // held turn's followup text (issue #453) — the caller snapshots the
        // flag AFTER this runs.
        settleActive(session.activeTurn.deferredSettle);
      }
      // Orphan accounting runs BEFORE the head check: an orphan's echo-less
      // result can arrive with an EMPTY queue (the common post-cancel
      // timeline — the active turn settled at the interrupt's idle and the
      // user hasn't typed yet), and it must still be consumed here. Skipping
      // the bookkeeping when there is nothing to promote would leave a
      // phantom entry/count that swallows the next live echo-less result
      // (e.g. /compact) instead.
      if ((session.pendingOrphanResults ?? 0) > 0) {
        session.pendingOrphanResults!--;
        return;
      }
      // msg_lifecycle_v1 lane. Attribute this echo-less result using the
      // entries' states — turns run sequentially and frames arrive in stream
      // order, so at any result: every "zombie" is from an already-dead turn
      // whose own result already passed before the frame that created the
      // newest entry (or never existed), every "started" entry was dispatched
      // into THE turn that emitted this result (an older turn's entries got
      // their terminal frames before a newer turn's "started" frames), and a
      // "pending" entry was not dispatched before it. One result therefore
      // covers ALL started and zombie entries at once (N coalesced commands
      // share ONE result); their outstanding terminal frames then no-op on
      // the missing entries. NOTE this ordering argument is asserted from
      // observed CLI behavior, not a documented wire contract — if a dead
      // turn's late result could lag past the NEXT turn's dispatch frames,
      // deleting a zombie and a started entry on one result would
      // double-consume it. The unexpected-transition logging in the frame
      // handler is the tripwire for that class of drift.
      if (session.orphanCommands?.size) {
        let consumedOrphanResult = false;
        let oldestPending: string | undefined;
        for (const [uuid, state] of session.orphanCommands) {
          if (state === "started" || state === "zombie") {
            consumedOrphanResult = true;
            session.orphanCommands.delete(uuid);
          } else {
            oldestPending ??= uuid;
          }
        }
        if (consumedOrphanResult) {
          return;
        }
        if (oldestPending !== undefined) {
          // No dispatch was seen before this result, so it is very likely a
          // live turn's — but a lost "started" frame would mean it IS the
          // orphan's (dup-over-loss: prefer one wrong skip over
          // misattributing a dead turn's outcome to a live prompt). Grant
          // each pending entry exactly one skip, like the count lane did.
          session.orphanCommands.delete(oldestPending);
          return;
        }
      }
      const head = firstUnsettledQueuedTurn();
      if (!head) {
        return;
      }
      activateTurn(head);
    };

    /** Result-time bookkeeping that must run whether or not the result can be
     *  attributed to a turn. (1) Latch `commandResultSeen` on every queued
     *  turn whose command is known dispatched with no terminal frame yet —
     *  the emitting turn is the one it was dispatched (possibly folded) into,
     *  so its result has now passed; a later cancel() must not seed an orphan
     *  entry that waits for it (see Turn.commandResultSeen). (2) When a turn
     *  is ACTIVE, the result is attributed to it and never reaches
     *  ensureActiveTurn — but it still covers the map's started entries
     *  (commands folded into the active turn share its result) and zombies
     *  (their late results have already passed or never existed), so drain
     *  them here or they would zombify/linger and swallow a later live
     *  echo-less result. */
    const recordResultForOrphanCommands = () => {
      for (const turn of session.turnQueue ?? []) {
        if (!turn.settled && turn.commandStarted && !turn.commandFinished) {
          turn.commandResultSeen = true;
        }
      }
      if (session.activeTurn && session.orphanCommands?.size) {
        for (const [uuid, state] of session.orphanCommands) {
          if (state === "started" || state === "zombie") {
            session.orphanCommands.delete(uuid);
          }
        }
      }
    };

    /** The unsettled in-flight turn owning this prompt uuid, if any. */
    const findUnsettledTurn = (uuid: string) =>
      (session.turnQueue ?? []).find((t) => t.promptUuid === uuid && !t.settled);

    /** The first queued turn still awaiting its outcome, if any — the single
     *  spelling of "a prompt is pending" shared by the head promotion and
     *  the autonomous stretch-close guard. */
    const firstUnsettledQueuedTurn = () => (session.turnQueue ?? []).find((t) => !t.settled);

    /** Whether any background subagent this turn spawned is still live —
     *  while true, the turn's settlement stays deferred so the subagent's
     *  output and permission requests land inside it (see
     *  Turn.deferredSettle). */
    const turnAwaitingSubagents = (turn: Turn) => {
      if (!turn.spawnedTaskIds?.size) {
        return false;
      }
      for (const taskId of turn.spawnedTaskIds) {
        const record = session.liveBackgroundTasks.get(taskId);
        // The isSubagent read is defense in depth for the shells-never-defer
        // contract: spawnedTaskIds only ever holds subagent ids today, but a
        // future add site must not silently let a long-lived shell hold a
        // prompt open. endedPerLevel entries are kept for attribution only —
        // the level signal says the task is gone (or its bookends were
        // lost), so a hold must not wait on them.
        if (record?.isSubagent && !record.endedPerLevel) {
          return true;
        }
      }
      return false;
    };

    /** Settle the active turn's stored deferred outcome once none of its
     *  spawned subagents is live. The single drain rule shared by the
     *  followup-result and idle settle sites, so the two lanes can't drift. */
    const settleDeferredIfDrained = () => {
      const turn = session.activeTurn;
      if (isHeldOpen(turn) && !turnAwaitingSubagents(turn)) {
        settleActive(turn.deferredSettle);
      }
    };

    /** Settle the active turn with `outcome` now — unless subagents it
     *  spawned are still live, in which case store the outcome and hold the
     *  turn open (see Turn.deferredSettle). Every result-time settle of a
     *  turn that can have spawned subagents must route through here: a site
     *  calling settleActive directly bypasses the hold and re-opens the
     *  out-of-turn permission deadlock (issue #866) through its lane. */
    const settleOrDefer = (outcome: PromptResponse) => {
      if (
        session.activeTurn &&
        !session.activeTurn.settled &&
        turnAwaitingSubagents(session.activeTurn)
      ) {
        session.activeTurn.deferredSettle = outcome;
      } else {
        settleActive(outcome);
      }
    };

    /** Settle the active turn's deferred exactly once, disarm the force-cancel
     *  backstop (the turn is over), and drop it from the queue. */
    const settleActive = (result: PromptResponse) => {
      const turn = session.activeTurn;
      if (!turn || turn.settled) {
        return;
      }
      // Captured before the settled flip below (isHeldOpen tests !settled).
      const wasHeld = isHeldOpen(turn);
      turn.settled = true;
      disarmForceCancel(session);
      session.turnQueue = (session.turnQueue ?? []).filter((t) => t !== turn);
      session.activeTurn = null;
      streamedToolInputs.clear();
      if (wasHeld) {
        // Settling a held turn is its delivery-stretch boundary: the turn's
        // answer finished long ago, so text streamed since the last boundary
        // is normally its followups' — left latched it would suppress a
        // following replayed turn's issue-#453 result-text fallback (the
        // common post-hold sequence). Known trade: at the echo hand-off an
        // incoming turn's pre-echo deltas share this one boolean, so a
        // STREAMING replay on a usage-omitting backend could re-emit its
        // answer — the flag cannot attribute text to a turn before its
        // echo, and the suppression direction is the common one, so the
        // clear wins. Every held-settle lane inherits this: the drain
        // settle, both hand-offs, and stream-done; cancel()'s inline mirror
        // carries its own copy.
        session.emittedAssistantText = false;
      }
      turn.resolve(result);
    };

    /** Reject the active turn (auth required, error result, …) without tearing
     *  down the consumer: the stream continues to idle and later turns proceed. */
    const failActive = (error: unknown) => {
      disarmForceCancel(session);
      const turn = session.activeTurn;
      if (!turn || turn.settled) {
        return;
      }
      turn.settled = true;
      session.turnQueue = (session.turnQueue ?? []).filter((t) => t !== turn);
      session.activeTurn = null;
      streamedToolInputs.clear();
      // A failed turn's stretch is over, and some failure lanes (the issue
      // #825 idle-fail) never see the result whose `finally` would close it —
      // start the next stretch clean, or its stale delivery record would
      // suppress the next turn's issue-#453 result-text fallback.
      session.emittedAssistantText = false;
      turn.reject(error);
    };

    /** Reject every in-flight turn — used when the stream dies. */
    const failAllTurns = (error: unknown) => {
      disarmForceCancel(session);
      const turns = session.activeTurn
        ? [session.activeTurn, ...(session.turnQueue ?? []).filter((t) => t !== session.activeTurn)]
        : [...(session.turnQueue ?? [])];
      session.activeTurn = null;
      session.turnQueue = [];
      for (const turn of turns) {
        if (!turn.settled) {
          const wasHeld = isHeldOpen(turn);
          turn.settled = true;
          if (wasHeld) {
            // A held turn's answer already streamed and its outcome is
            // recorded — a stream death during the post-answer hold is a
            // background failure, not the turn's. Resolve with the real
            // outcome, mirroring the stream-done path.
            turn.resolve(turn.deferredSettle);
          } else {
            turn.reject(error);
          }
        }
      }
    };

    // The wake-up channel cancel()/teardown aborts to force the active turn to
    // settle "cancelled" even when query.next() is wedged (issue #680). Re-armed
    // after each fire so the consumer keeps serving later turns.
    let cancelController = session.cancelController!;

    // The in-flight query.next(), kept across abort wake-ups that don't
    // consume a message, so no yielded message is ever dropped — async
    // generators serialize next() calls, so racing a SECOND next() while one
    // is pending would make the abandoned one swallow a message (e.g. a
    // force-cancelled turn's late result, whose orphan accounting below
    // depends on actually seeing it).
    let pendingNext: Promise<{ kind: "message"; result: IteratorResult<SDKMessage, void> }> | null =
      null;

    try {
      while (true) {
        pendingNext ??= session.query
          .next()
          .then((result) => ({ kind: "message" as const, result }));
        const nextMessage = pendingNext;
        // Fresh abort listener per iteration, removed when next() wins, so a
        // long-lived session doesn't accumulate listeners on one signal.
        let onAbort!: () => void;
        const abortRace = new Promise<"abort">((resolve) => {
          onAbort = () => resolve("abort");
          cancelController.signal.addEventListener("abort", onAbort, { once: true });
        });
        const raced = await Promise.race([nextMessage, abortRace]);
        cancelController.signal.removeEventListener("abort", onAbort);

        if (raced === "abort") {
          // cancel()/teardown woke us: settle the active turn "cancelled" per
          // the ACP contract. The SDK never acknowledged this turn (that's why
          // the force-cancel backstop fired), so if it later recovers from the
          // wedge it will still emit the turn's result — with no live turn to
          // match — followed by its trailing idle. Pre-count it as an orphan
          // so that late result is skipped (not promoted onto the next queued
          // prompt) and its trailer is recorded as owed, not read as the next
          // turn being abandoned. Stale counts self-heal: activation resets
          // them (see activateTurn).
          if (session.activeTurn && !session.activeTurn.settled) {
            // Seed by what the frames already told us, mirroring cancel()'s
            // queued-turn sweep — the consumer may have drained the wedged
            // turn's result and/or terminal frame before the backstop fired,
            // and an entry seeded for a result or frame that is already
            // spent would never drain (it would swallow an unrelated later
            // echo-less result instead).
            const active = session.activeTurn;
            if (active.commandFinished === "completed" || active.commandFinished === "discarded") {
              // Finished SDK-side; any result already passed. Nothing to
              // track.
            } else if (active.commandFinished === "cancelled") {
              // Aborted after dispatch: its late result may still come —
              // unless it already did.
              if (!active.commandResultSeen) {
                this.trackOrphanCommand(session, active.promptUuid, "zombie");
              }
            } else if (active.commandResultSeen) {
              // Its result was already consumed (dropped at the cancelled
              // guard); only the terminal frame is outstanding, which no-ops
              // with no entry. Nothing to track.
            } else {
              // The wedged turn WAS dispatched (it's active), so track it
              // "started": its late result (if the SDK recovers) is skipped
              // echo-less, and its terminal frame — or that skip plus
              // activation's clear when the frame is lost to the wedge — is
              // what drains it.
              this.trackOrphanCommand(session, active.promptUuid, "started");
            }
          }
          settleActive({ stopReason: "cancelled", usage: sessionUsage(session) });
          // The cancelled turn's result may never come (that's why the
          // backstop fired) — close its delivery stretch here so partial
          // streamed text can't suppress the next turn's issue-#453 fallback.
          // If a late orphan result does arrive, its `finally` clears again;
          // FIFO ordering means no live turn's text can have streamed yet.
          session.emittedAssistantText = false;
          // If the session is being torn down, abandon the in-flight next()
          // (swallowing any later rejection so it can't surface as unhandled)
          // and stop; otherwise re-arm and keep consuming — `pendingNext`
          // stays in flight so its eventual message is processed, not dropped.
          if (!this.sessions[params.sessionId]) {
            void nextMessage.catch(() => {});
            return;
          }
          cancelController = new AbortController();
          session.cancelController = cancelController;
          continue;
        }

        // A message arrived: this next() is consumed; arm a fresh one next pass.
        pendingNext = null;

        const { value: message, done } = raced.result as IteratorResult<SDKMessage, void>;

        if (done || !message) {
          // The stream ended. Settle the in-flight turns FIRST, then release the
          // stream resources — same order as the error paths (failAllTurns before
          // closeQueryStream). Settling is the user-facing contract; resource
          // release is best-effort cleanup, so a throw there must not pre-empt a
          // turn's real outcome.
          //
          // Settle the turn that was in flight so its prompt() doesn't hang:
          // cancelled if a cancel is pending, otherwise the outcome a
          // deferred turn already recorded (see Turn.deferredSettle) or the
          // accumulated scratch outcome. The scratch currently still equals
          // a deferred turn's stored outcome (followup results never mutate
          // it), but the stored one is the authoritative source.
          const inFlight = session.activeTurn;
          settleActive(
            session.cancelled
              ? { stopReason: "cancelled", usage: sessionUsage(session) }
              : (inFlight?.deferredSettle ?? { stopReason, usage: sessionUsage(session) }),
          );
          // Queued turns the SDK never started never ran, so reject them rather
          // than reporting a success (end_turn) — or a misleading "cancelled" —
          // for a prompt that produced no output. (A cancel already settled the
          // turns that were queued at cancel time and removed them, so anything
          // still here was enqueued afterward and was not part of the cancel.)
          for (const queued of [...(session.turnQueue ?? [])]) {
            if (!queued.settled) {
              queued.settled = true;
              queued.reject(RequestError.internalError(undefined, SESSION_ENDED_MESSAGE));
            }
          }
          session.turnQueue = [];
          // The query iterator can't be revived, so close the session's stream
          // (marks queryClosed, drops the consumer handle, releases the dead
          // subprocess/settings resources) — a later prompt() then rejects up
          // front rather than restarting a consumer on the exhausted stream.
          this.closeQueryStream(session);
          return;
        }

        if (
          session.emitRawSDKMessages &&
          shouldEmitRawMessage(session.emitRawSDKMessages, message)
        ) {
          await this.client.extNotification("_claude/sdkMessage", {
            sessionId: params.sessionId,
            message: message as Record<string, unknown>,
          });
        }

        // CLIs 2.1.206+ (capability msg_lifecycle_v1) report the fate of every
        // uuid-stamped queued command (queued/started/completed/cancelled/
        // discarded) as `command_lifecycle` frames — 2-3 per prompt, since
        // prompt() stamps a uuid on every message. The frame is @internal and
        // absent from the SDKMessage union, so handle it BEFORE the exhaustive
        // switch: it must not reach `unreachable`'s error log, and a `case`
        // for it wouldn't typecheck. It feeds only the orphan accounting (see
        // Session.orphanCommands); turn settlement stays driven by
        // echoes/results/idle. (Raw-mode emission above still forwards these
        // frames.)
        if ((message as { type: string }).type === "command_lifecycle") {
          const frame = message as unknown as { command_uuid: string; state: string };
          switch (frame.state) {
            case "started": {
              // Remember dispatch on the live turn so a cancel() that orphans
              // it seeds the right state (see Turn.commandStarted)...
              const queued = findUnsettledTurn(frame.command_uuid);
              if (queued) {
                queued.commandStarted = true;
              }
              // ...and promote an already-orphaned command: once dispatched,
              // a bare `cancelled` no longer means "dropped without running".
              const state = session.orphanCommands?.get(frame.command_uuid);
              if (state === "pending") {
                session.orphanCommands!.set(frame.command_uuid, "started");
              } else if (state === "zombie") {
                // "started" after the command's terminal frame: the ordering
                // the whole lane rests on has been violated (frames are
                // per-uuid FIFO). Surface it — a silent drift here degrades
                // into swallowed or misattributed results.
                this.logger.error(
                  `Session ${params.sessionId}: command_lifecycle "started" for ${frame.command_uuid} after its terminal frame; orphan accounting may be off for this cancel.`,
                );
              }
              break;
            }
            case "completed":
            case "discarded":
            case "cancelled": {
              // Terminal frames. Latch the fate on a still-queued turn so a
              // later cancel() doesn't seed an orphan entry for a command
              // whose one-and-only terminal frame has already been consumed
              // (nothing would ever drain that entry).
              const queued = findUnsettledTurn(frame.command_uuid);
              if (queued) {
                queued.commandFinished = frame.state as "completed" | "discarded" | "cancelled";
              }
              if (frame.state === "cancelled") {
                // Ambiguous by design (dup-over-loss): dropped before
                // dispatch (no result will ever come — safe to forget) vs
                // consumed into a turn that was aborted/failed. For the
                // latter, any result the dead turn managed to emit has
                // already deleted the entry (see
                // recordResultForOrphanCommands / ensureActiveTurn), so a
                // still-"started" entry means no result was seen since
                // dispatch — it becomes a zombie for the next
                // echo-less-result skip.
                const state = session.orphanCommands?.get(frame.command_uuid);
                if (state === "pending") {
                  session.orphanCommands?.delete(frame.command_uuid);
                } else if (state === "started") {
                  session.orphanCommands?.set(frame.command_uuid, "zombie");
                }
                break;
              }
              // Exactly-one-terminal: the command is finished. "completed" is
              // emitted after any result its turn produced (fresh turn) or the
              // command folded into another turn whose result is attributed
              // elsewhere — either way no echo-less result remains to skip.
              // "discarded" = session ended with it still queued; no result.
              session.orphanCommands?.delete(frame.command_uuid);
              break;
            }
            default:
              // "queued" carries no fate information. Anything else is a
              // state this adapter doesn't know — likely a CLI that grew the
              // v1 vocabulary. The entry still drains by result coverage or
              // activation's clear (bounded damage), but log it so the
              // degradation is visible instead of silent.
              if (frame.state !== "queued") {
                this.logger.error(
                  `Session ${params.sessionId}: unknown command_lifecycle state "${frame.state}" for ${frame.command_uuid}; treating as uninformative.`,
                );
              }
              break;
          }
          continue;
        }

        switch (message.type) {
          case "system":
            switch (message.subtype) {
              case "init":
                // Latch the lifecycle capability so cancel() routes orphan
                // accounting through `orphanCommands` (per-uuid, exact)
                // instead of the coalescing-blind count. Never unlatch: init
                // re-emits per turn and the capability can't be lost mid-CLI.
                if (message.capabilities?.includes("msg_lifecycle_v1")) {
                  session.msgLifecycleV1 = true;
                }
                // A fresh `system`/init (e.g. after reinitialize) can carry an
                // updated Fast mode state; reconcile it with what we seeded at
                // session creation.
                await this.syncFastModeState(message.session_id, session, message.fast_mode_state);
                break;
              case "status": {
                // These banners count as delivered text (via sendUpdate), so
                // an echo-less turn that only ever emits them (e.g. `/compact`,
                // promoted at its own result) doesn't have its result text
                // re-emitted by the issue-#453 fallback.
                if (message.status === "compacting") {
                  compactionInProgress = true;
                  await sendUpdate({
                    sessionId: message.session_id,
                    update: {
                      sessionUpdate: "agent_message_chunk",
                      content: { type: "text", text: "Compacting..." },
                    },
                  });
                } else if (message.compact_result === "success" && compactionInProgress) {
                  // The SDK signals manual `/compact` completion with a status
                  // message carrying `compact_result`, not the `compact_boundary`
                  // message (which only fires when there's content to compact).
                  compactionInProgress = false;
                  await sendUpdate({
                    sessionId: message.session_id,
                    update: {
                      sessionUpdate: "agent_message_chunk",
                      content: { type: "text", text: "\n\nCompacting completed." },
                    },
                  });
                } else if (message.compact_result === "failed" && compactionInProgress) {
                  compactionInProgress = false;
                  const reason = message.compact_error ? `: ${message.compact_error}` : ".";
                  await sendUpdate({
                    sessionId: message.session_id,
                    update: {
                      sessionUpdate: "agent_message_chunk",
                      content: { type: "text", text: `\n\nCompacting failed${reason}` },
                    },
                  });
                }
                break;
              }
              case "compact_boundary": {
                // Refresh the displayed usage immediately so the client doesn't
                // keep showing the stale pre-compaction size (e.g. "944k/1m")
                // right after the user sees "Compacting completed", which is
                // confusing and wrong.
                //
                // Prefer the SDK's authoritative post-compaction `used` via
                // getContextUsage — it reflects the real retained context
                // (system prompt + tools + surviving messages), which the
                // per-message API usage numbers can't give us until the next
                // turn's result. If the control request fails, fall back to the
                // used:0 approximation: directionally correct (context just
                // dropped dramatically) and replaced within seconds by the next
                // result message.
                //
                // `size` keeps coming from session.contextWindowSize —
                // compaction frees occupancy, it doesn't change the model's
                // window.
                //
                // The "Compacting completed." text is emitted from the `status`
                // handler (keyed on `compact_result`), not here, so the failure
                // path gets a message too.
                const usedTokens = await fetchContextUsedTokens(session.query, this.logger);
                lastAssistantUsage = null;
                lastAssistantTotalUsage = usedTokens ?? 0;
                await sendUpdate({
                  sessionId: message.session_id,
                  update: {
                    sessionUpdate: "usage_update",
                    used: lastAssistantTotalUsage,
                    size: session.contextWindowSize,
                  },
                });
                break;
              }
              case "local_command_output": {
                await sendUpdate({
                  sessionId: message.session_id,
                  update: {
                    sessionUpdate: "agent_message_chunk",
                    content: { type: "text", text: message.content },
                  },
                });
                break;
              }
              case "session_state_changed": {
                session.lastSessionState = message.state;
                if (message.state === "idle") {
                  // A non-cancelled turn normally settled at its terminal
                  // `result` already (issue #773), and that result recorded an
                  // owed trailing idle — absorbed here via the decrement. We
                  // must NOT settle `activeTurn` on an owed idle: `idle`
                  // carries no turn identity, and it can lag (the SDK flushes
                  // held-back results / drains background agents first), so by
                  // the time it arrives the SDK may have echoed the NEXT turn
                  // and activated it — settling now would resolve that new
                  // turn prematurely with end_turn and ~zero usage, dropping
                  // its real result. A cancelled turn relies on `idle`: its
                  // `result` is dropped at the `session.cancelled` guard, so
                  // it never settles at a result and must settle here.
                  //
                  // An idle that is NOT owed while the active turn is still
                  // unsettled is the issue #825 signature: `idle` is the SDK's
                  // authoritative turn-over signal (it fires after held-back
                  // results flush and background agents drain), so a turn that
                  // reaches it without a result will never get one — the model
                  // stream dropped mid-turn, or an async agent
                  // completed/stalled without the host turn resolving. Fail
                  // the turn NOW so its session/prompt gets a terminal
                  // response, instead of leaving it hanging until the next
                  // prompt drains the wreckage.
                  // A cancelled turn still consumed tokens: its dropped result
                  // already fed the accumulator (the usage tally at the result
                  // handler runs before the `session.cancelled` guard), so
                  // report it — clients metering spend would otherwise lose
                  // the interrupted turn's tokens entirely (issue #844). Zero
                  // when the cancel pre-empted the result (wedge/force-cancel).
                  if (session.cancelled && session.activeTurn && !session.activeTurn.settled) {
                    settleActive({ stopReason: "cancelled", usage: sessionUsage(session) });
                    // An interrupt can pre-empt the turn's result entirely
                    // (nothing ran the result-case `finally`), so close the
                    // delivery stretch here: idle is the SDK's authoritative
                    // turn-over signal, and stale partial-text state would
                    // suppress the next turn's issue-#453 fallback.
                    session.emittedAssistantText = false;
                  } else if (isHeldOpen(session.activeTurn)) {
                    // A turn held open for its background subagents (see
                    // Turn.deferredSettle). Idles keep their normal cadence
                    // during the hold — the CLI emits one per processing
                    // cycle (the turn's own trailer, then one per followup),
                    // NOT one final "all drained" signal — so each one
                    // absorbs an outstanding trailer debt, and the turn only
                    // settles once none of its spawned subagents is left
                    // (the followup-result settle usually got there first;
                    // this is the fallback when no followup came). Mid-hold
                    // idles never fall through: a held turn HAS its result,
                    // so reading its idle as "turn abandoned without a
                    // result" (issue #825) would fail a healthy prompt.
                    if (session.owedTrailingIdles > 0) {
                      session.owedTrailingIdles--;
                    }
                    settleDeferredIfDrained();
                  } else if (session.owedTrailingIdles > 0) {
                    // Absorb a settled turn's trailing idle. Also covers a
                    // cancel that landed between a turn's counted result and
                    // this lagged idle (no active turn to settle): the idle
                    // still belongs to that settled turn, and skipping the
                    // decrement would leak the debt permanently.
                    session.owedTrailingIdles--;
                  } else if (
                    !session.cancelled &&
                    session.activeTurn &&
                    !session.activeTurn.settled
                  ) {
                    // Deliberately only the ACTIVE turn: a queued turn that
                    // was never echoed is NOT failed here, because an idle
                    // can legitimately precede the SDK picking up freshly
                    // pushed input (the idle was emitted before the SDK read
                    // it) — failing the queue head on that race would reject
                    // a prompt the SDK is about to run. A turn abandoned
                    // before its echo therefore still hangs until cancel or
                    // the next prompt; only a timer could tell those apart.
                    this.logger.error(
                      `Session ${params.sessionId}: SDK went idle without emitting a result ` +
                        `for the active turn; failing the in-flight prompt (issue #825)`,
                    );
                    failActive(
                      RequestError.internalError(
                        errorKindData("no_result"),
                        TURN_NO_RESULT_MESSAGE,
                      ),
                    );
                  }
                  // The SDK generates the session title in a background task and
                  // persists it to the session file; `idle` is the turn-over
                  // signal, so it's the point at which a new title may have
                  // landed. Push it to the client if it changed.
                  await this.maybeUpdateSessionTitle(params.sessionId, session);
                }
                break;
              }
              case "memory_recall": {
                const isSynthesis = message.mode === "synthesize";
                const locations = isSynthesis
                  ? []
                  : message.memories.map((m) => ({ path: m.path }));
                const content = isSynthesis
                  ? message.memories
                      .filter(
                        (m): m is (typeof message.memories)[number] & { content: string } =>
                          typeof m.content === "string",
                      )
                      .map((m) => ({
                        type: "content" as const,
                        content: { type: "text" as const, text: m.content },
                      }))
                  : [];
                const count = message.memories.length;
                const title = isSynthesis
                  ? "Recalled synthesized memory"
                  : `Recalled ${count} ${count === 1 ? "memory" : "memories"}`;
                await sendUpdate({
                  sessionId: message.session_id,
                  update: {
                    sessionUpdate: "tool_call",
                    toolCallId: message.uuid,
                    title,
                    kind: "read",
                    status: "completed",
                    ...(locations.length > 0 && { locations }),
                    ...(content.length > 0 && { content }),
                    _meta: {
                      claudeCode: {
                        toolName: "memory_recall",
                        toolResponse: { mode: message.mode },
                      },
                    } satisfies ToolUpdateMeta,
                  },
                });
                break;
              }
              case "commands_changed": {
                // Push the full slash-command list after a mid-session change
                // (e.g. skills discovered dynamically as the agent works in a
                // subdirectory). The client should REPLACE its cached command
                // list with this payload: supportedCommands() is captured once
                // at initialize and never reflects mid-session changes, so we
                // forward message.commands directly rather than re-querying.
                await sendUpdate({
                  sessionId: message.session_id,
                  update: {
                    sessionUpdate: "available_commands_update",
                    availableCommands: getAvailableSlashCommands(message.commands),
                  },
                });
                break;
              }
              case "mirror_error": {
                // The SDK failed to persist session history (SessionStore
                // append rejected/timed out after retry) — potential data loss
                // the user should know about rather than a silent gap on
                // resume. Log it and surface a warning in the conversation.
                this.logger.error(
                  `Session ${message.session_id}: failed to persist history: ${message.error}`,
                );
                break;
              }
              case "permission_denied": {
                // A tool call was auto-denied (by a rule, the classifier,
                // dontAsk mode, etc.) before running. The tool_use block was
                // already emitted as a `tool_call`, so mark it failed with the
                // rejection reason — otherwise the client shows a tool call
                // that silently never resolves.
                const reason = message.decision_reason ?? message.message;
                await sendUpdate({
                  sessionId: message.session_id,
                  update: {
                    sessionUpdate: "tool_call_update",
                    toolCallId: message.tool_use_id,
                    status: "failed",
                    content: [
                      {
                        type: "content",
                        content: { type: "text", text: `Permission denied: ${reason}` },
                      },
                    ],
                    _meta: {
                      claudeCode: {
                        toolName: message.tool_name,
                        toolResponse: {
                          decisionReasonType: message.decision_reason_type,
                          decisionReason: message.decision_reason,
                          message: message.message,
                        },
                      },
                    } satisfies ToolUpdateMeta,
                  },
                });
                break;
              }
              case "informational": {
                // Free-form notice from the SDK (e.g. why a UserPromptSubmit/Stop
                // hook blocked continuation). Surface the text so the user sees it
                // instead of a silent stop. ACP's agent_message_chunk has no
                // severity field, so fold the level into the text for the more
                // prominent levels ('info' is transcript-only noise — leave plain).
                // Sending via sendUpdate also marks the notice as this stretch's
                // delivered text: a hook-blocked turn's result repeats the block
                // reason with zero output tokens, and the issue-#453 fallback
                // must not emit it a second time.
                const text =
                  message.level === "info"
                    ? message.content
                    : `**${message.level[0].toUpperCase()}${message.level.slice(1)}:** ${message.content}`;
                await sendUpdate({
                  sessionId: message.session_id,
                  update: {
                    sessionUpdate: "agent_message_chunk",
                    content: { type: "text", text },
                  },
                });
                break;
              }
              case "hook_started":
              case "hook_progress":
              case "hook_response":
              case "files_persisted":
              case "task_progress":
                break;
              case "task_started":
                // For subagent tasks `task_id` is the subagent's agent id (the
                // SDK keys its task registry by agent id) and `tool_use_id` is
                // the Agent/Task tool_use that spawned it — recorded so the
                // subagent's permission requests, which reach canUseTool with
                // only `agentID`, can attribute their eagerly-emitted
                // tool_call to the parent tool call. Non-subagent tasks (e.g.
                // background Bash) land here too; their task_ids never match
                // an agentID, so those entries are inert for attribution.
                //
                // `isSubagent` marks Task/Agent-tool subagents — the tasks
                // whose completion wakes the model for a followup, so the
                // ones worth deferring turn settlement for. A sync subagent
                // is pruned (terminal task_updated) before its turn's result
                // can arrive, so registry membership at result time means an
                // async subagent. Their spawn is also recorded on the active
                // turn: a turn only ever waits on its own subagents, and a
                // spawn during a held-open drain window (an agent chain)
                // extends that turn's hold.
                session.liveBackgroundTasks.set(message.task_id, {
                  parentToolUseId: message.tool_use_id,
                  isSubagent: !!message.subagent_type,
                });
                if (message.subagent_type && session.activeTurn && !session.activeTurn.settled) {
                  (session.activeTurn.spawnedTaskIds ??= new Set()).add(message.task_id);
                }
                break;
              case "task_notification":
                // The task settled — no further tool calls can originate
                // from it, so its registry entry can be dropped.
                session.liveBackgroundTasks.delete(message.task_id);
                break;
              case "task_updated":
                // terminal-status task_updated patch and a (deduplicated)
                // task_notification when a task settles, but only the patch is
                // guaranteed per transition — prune on it too so the registry
                // can't grow for the session's lifetime if a notification is
                // skipped.
                if (
                  message.patch.status === "completed" ||
                  message.patch.status === "failed" ||
                  message.patch.status === "killed"
                ) {
                  session.liveBackgroundTasks.delete(message.task_id);
                }
                break;
              case "worker_shutting_down":
                // A Remote Control worker announced a graceful teardown. This is a
                // live-tail signal for remote clients to explain why a session went
                // away; it's not meaningful for a local stdio ACP session.
                break;
              case "elicitation_complete": {
                // A url-mode MCP elicitation finished server-side. Let the client
                // dismiss any UI it opened for it. Only meaningful when the
                // client supports url elicitation; ignore failures otherwise.
                if (this.clientCapabilities?.elicitation?.url) {
                  try {
                    await this.client.unstable_completeElicitation({
                      elicitationId: message.elicitation_id,
                    });
                  } catch (error) {
                    this.logger.error(`Failed to complete elicitation: ${error}`);
                  }
                }
                break;
              }
              case "plugin_install":
              case "notification":
              case "api_retry":
              case "thinking_tokens":
                // Todo: process via status api: https://docs.claude.com/en/docs/claude-code/hooks#hook-output
                break;
              case "model_refusal_fallback": {
                // The SDK retried a refused turn on the fallback model and made
                // the swap persistent for the session. Without a notice the
                // user just sees regenerated output; without the state sync the
                // client's model picker (and the model-dependent options
                // rebuilt from it) keeps advertising a model the session is no
                // longer running.
                //
                // Current CLIs only emit direction "retry" (persistent swap).
                // "revert"/"sticky" are retained in the SDK enum for older
                // CLIs, where "revert" marked a turn-only fallback — for that
                // direction the session stays on the original model, so skip
                // the persistent-swap claim and the state sync.
                const persistent = message.direction !== "revert";
                const category = message.api_refusal_category
                  ? ` (${message.api_refusal_category})`
                  : "";
                const explanation = message.api_refusal_explanation
                  ? `\n\n${message.api_refusal_explanation}`
                  : "";
                const outcome = persistent
                  ? `The session will continue on ${message.fallback_model}.`
                  : `The session stays on ${message.original_model}.`;
                await sendUpdate({
                  sessionId: message.session_id,
                  update: {
                    sessionUpdate: "agent_message_chunk",
                    content: {
                      type: "text",
                      text: `**Model fallback:** ${message.original_model} declined this request${category}; retried with ${message.fallback_model}. ${outcome}${explanation}`,
                    },
                  },
                });
                if (persistent) {
                  await this.syncModelAfterRefusalFallback(
                    params.sessionId,
                    session,
                    message.fallback_model,
                  );
                }
                break;
              }
              case "model_refusal_no_fallback":
                // The refusal ends the turn as an error; the terminal `result`
                // handler settles it with ACP's `refusal` stop reason and
                // streams `lastRefusalExplanation`. The assistant frame's
                // stop_details is the primary source for that explanation —
                // this structured banner is the backup source when the frame
                // carried none (older CLIs, gateways that drop stop_details).
                //
                // `refused_user_message_uuid` is explicitly null when the
                // refused turn was not human-authored (a background
                // task-notification followup or auto-continuation) — don't
                // let those pollute the user turn's explanation. `undefined`
                // (older CLIs that omit the field) can't be attributed either
                // way, so keep seeding — the same exposure the assistant-frame
                // capture already has.
                if (!lastRefusalExplanation && message.refused_user_message_uuid !== null) {
                  lastRefusalExplanation = message.api_refusal_explanation ?? message.content;
                }
                break;
              // `control_request_progress` only reports on side_question
              // control requests, which this adapter never issues.
              case "control_request_progress":
                break;
              case "background_tasks_changed":
                // A level signal: the full live background-task set on every
                // membership change, with REPLACE semantics. Used only to
                // reconcile `liveBackgroundTasks` — dropping (or, for
                // subagent entries, unpinning) any entry whose settle
                // bookend (task_notification / terminal task_updated) was
                // lost, so a leaked subagent entry can't defer its spawning
                // turn's settlement forever. Growth of retained
                // (endedPerLevel) subagent entries is bounded by the
                // activation-time sweep in activateTurn, not here. It never
                // ADDS entries (the payload carries no attribution or
                // subagent marker), so the unspecified ordering vs. the edge
                // bookends is safe: a level that precedes its task_started
                // simply no-ops here.
                if (session.liveBackgroundTasks.size > 0) {
                  const live = new Set(message.tasks.map((t) => t.task_id));
                  for (const [taskId, record] of session.liveBackgroundTasks) {
                    if (live.has(taskId)) {
                      // The level proves the task live in the background
                      // universe (e.g. a foreground agent was backgrounded
                      // after an earlier absent-marking, or that marking was
                      // a racing payload built before the task registered) —
                      // un-end it so a hold waits on it again, and disarm
                      // the activation sweep.
                      record.endedPerLevel = undefined;
                      continue;
                    }
                    if (record.isSubagent) {
                      // The level's universe is BACKGROUND tasks only, so a
                      // live sync (foreground) subagent is legitimately
                      // absent — deleting its entry would strand its
                      // permission attribution (#859). Keep the entry but
                      // stop any hold from waiting on the id: an absent id
                      // can equally be a leaked async entry whose settle
                      // bookends were lost.
                      record.endedPerLevel ??= "ended";
                    } else {
                      session.liveBackgroundTasks.delete(taskId);
                    }
                  }
                }
                break;
              default:
                unreachable(message, this.logger);
                break;
            }
            break;
          case "result": {
            // A result from an autonomous cycle — a task-notification
            // followup, or a peer/coordinator/observer message the model
            // handled on its own (see AUTONOMOUS_RESULT_ORIGINS) — is not
            // the user's prompt's. Autonomous results must never touch the
            // user-turn lifecycle (stop reason, settles, failActive,
            // slash-command output forwarding), though their cost is real.
            const isAutonomousResult =
              message.origin != null && AUTONOMOUS_RESULT_ORIGINS.has(message.origin.kind);

            try {
              // Reconcile the Fast mode toggle with the SDK's reported state.
              // Gated to user-driven turns like every other side effect below;
              // an autonomous cycle's state lands on the next user turn's
              // result. Runs even when the turn errors or was cancelled.
              if (!isAutonomousResult) {
                await this.syncFastModeState(params.sessionId, session, message.fast_mode_state);
              }

              // A user-turn result needs an active turn so its stop reason is
              // attributed and the turn settles at idle. Local-only commands carry
              // no user-message echo to promote them, so do it here from the head.
              // Promote BEFORE accumulating usage, since activation resets the
              // accumulator — promoting after would discard this result's tokens.
              // The orphan bookkeeping runs first: it covers folded/zombie
              // commands whose shared or late result this is, even when the
              // result is the ACTIVE turn's (ensureActiveTurn never looks at
              // the map in that case).
              if (!isAutonomousResult) {
                recordResultForOrphanCommands();
                ensureActiveTurn();
              }

              // A result closes the stretch of output it terminates: snapshot
              // the delivery record — AFTER ensureActiveTurn, whose held-turn
              // hand-off closes the held stretch, so an echo-less command
              // promoted here is judged on its own delivery, not on the held
              // turn's followup text — and before the handling below can emit
              // anything of its own; the `finally` then clears it so every
              // exit from this case (the cancelled-guard and refusal breaks
              // included) starts the next stretch clean. Clearing up front
              // instead would let result-time emissions (refusal explanation,
              // result-text forwarding) taint the next stretch and suppress a
              // following replayed turn's fallback. Autonomous cycles run
              // alongside a user turn and must not clear its flag (they exit
              // through the early break below, which the gated `finally`
              // leaves alone).
              const deliveredAssistantText = session.emittedAssistantText;

              // Every user-turn result terminates a turn (settle, reject, or
              // orphan skip) and the SDK follows it with a trailing
              // `session_state_changed: idle` — record the debt so the idle
              // handler absorbs that idle rather than reading it as a turn the
              // SDK abandoned (issue #825). One exclusion: the cancelled ACTIVE
              // turn's own result. It is dropped at the `session.cancelled`
              // guard, and either the idle itself settles the turn (consuming
              // the trailer) or the next echo's hand-off does (which records
              // the debt there instead) — counting here too would double it.
              // Results skipped while cancelled with NO active turn — orphaned
              // queued turns the SDK still ran, or a force-cancelled turn's
              // late result after the backstop settled it — get no such settle,
              // so their trailers must be counted here or they'd later be read
              // as the next healthy turn being abandoned and false-fail it.
              // Autonomous results (followups, peer/channel/coordinator
              // cycles) are counted too: each is its own processing cycle with
              // its own trailing idle, and that idle can lag past the next
              // prompt's echo — which, un-owed, would be read as the fresh
              // turn being abandoned (#825 false-fail). That lag was mostly
              // unreachable when such cycles only ran with no pending turn,
              // but a held turn settling AT a followup result unblocks the
              // client at exactly that point, making the race the common
              // case.
              // The cancelled-ACTIVE-turn exclusion applies only to that
              // turn's OWN result — a followup result arriving inside the
              // cancel window still gets its own trailer and must be counted,
              // or that idle would later false-fail the next prompt.
              if (isAutonomousResult || !session.cancelled || !session.activeTurn) {
                session.owedTrailingIdles++;
              }

              // Accumulate usage into the user turn's tally. Skip autonomous
              // results: their cost is real but is reported separately via the
              // usage_update below, and `session.accumulatedUsage` is only reset on
              // turn activation — so folding an autonomous result that lands
              // after the next turn is active (but before it settles) would leak
              // those tokens into that turn's PromptResponse.usage.
              if (!isAutonomousResult) {
                session.accumulatedUsage.inputTokens += message.usage.input_tokens;
                session.accumulatedUsage.outputTokens += message.usage.output_tokens;
                session.accumulatedUsage.cachedReadTokens += message.usage.cache_read_input_tokens;
                session.accumulatedUsage.cachedWriteTokens +=
                  message.usage.cache_creation_input_tokens;
              }

              const matchingModelUsage = lastAssistantModel
                ? getMatchingModelUsage(message.modelUsage, lastAssistantModel)
                : null;
              // Only overwrite when we have an authoritative value — a miss
              // (e.g. a turn with no top-level assistant message) would
              // otherwise discard the window learned on a prior turn and
              // leave the next prompt's mid-stream updates reporting 200k.
              if (matchingModelUsage) {
                session.contextWindowSize = matchingModelUsage.contextWindow;
              }

              // Send usage_update notification
              if (lastAssistantTotalUsage !== null) {
                await sendUpdate({
                  sessionId: params.sessionId,
                  update: {
                    sessionUpdate: "usage_update",
                    used: lastAssistantTotalUsage,
                    size: session.contextWindowSize,
                    cost: {
                      amount: message.total_cost_usd,
                      currency: "USD",
                    },
                    ...(message.origin && {
                      _meta: { "_claude/origin": message.origin },
                    }),
                  },
                });
              }

              if (session.cancelled) {
                if (!isAutonomousResult) {
                  stopReason = "cancelled";
                }
                break;
              }

              // A held turn (see Turn.deferredSettle) settles at its
              // followup's terminal result: this is the earliest point at which
              // the promised summary has fully streamed — the trailing idle
              // would work too, but a client should not wait out another idle
              // round-trip for a response whose content is already complete.
              // (While the turn still awaits another of its subagents —
              // parallel spawns — the helper holds; the next notification's
              // followup settles it instead. Other autonomous origins — peer/
              // channel/coordinator cycles — reach here too: settling a
              // drained hold at their results is as good as the idle
              // fallback.) Then stop: everything below is user-turn
              // lifecycle, and an autonomous outcome must never touch it —
              // its is_error or "Please run /login" text would otherwise
              // failActive a live turn (the held one, or the user's next
              // prompt) whose own result recorded a different outcome.
              if (isAutonomousResult) {
                settleDeferredIfDrained();
                // With no turn in flight OR QUEUED (also after the settle
                // above), the stretch holds only autonomous prose — close
                // it, so a replayed next prompt isn't silently suppressed by
                // the issue-#453 delivery check. A live turn's flag may
                // guard the USER's already-streamed text — and so may a
                // QUEUED turn's: with mid-message echo lag its deltas stream
                // before the echo activates it (activeTurn still null), and
                // clearing then would re-emit that answer via the fallback,
                // the duplicate direction the flag's doc forbids.
                if (!session.activeTurn && !firstUnsettledQueuedTurn()) {
                  session.emittedAssistantText = false;
                }
                break;
              }

              // A refusal can arrive on any result subtype (and may even set
              // is_error), so handle it before the subtype switch — otherwise the
              // is_error throw below would surface it as an internal error. The
              // refused assistant message carries no visible content, so surface
              // the classifier's explanation (when available) and report ACP's
              // dedicated `refusal` stop reason.
              if (message.stop_reason === "refusal") {
                if (lastRefusalExplanation) {
                  await sendUpdate({
                    sessionId: params.sessionId,
                    update: {
                      sessionUpdate: "agent_message_chunk",
                      content: { type: "text", text: lastRefusalExplanation },
                    },
                  });
                }
                stopReason = "refusal";
                // Through the deferral gate, not settleActive: a refusal can
                // land on a turn whose spawned subagents are still live, and
                // settling it out from under them would strand their output
                // and permission requests out-of-turn (issue #866's deadlock,
                // through the refusal lane).
                settleOrDefer({ stopReason: "refusal", usage: sessionUsage(session) });
                break;
              }

              switch (message.subtype) {
                case "success": {
                  if (message.result.includes("Please run /login")) {
                    failActive(RequestError.authRequired());
                    break;
                  }
                  if (message.stop_reason === "max_tokens") {
                    stopReason = "max_tokens";
                    break;
                  }
                  if (message.is_error) {
                    failActive(
                      RequestError.internalError(errorKindData(lastAssistantError), message.result),
                    );
                    break;
                  }
                  // The result text is forwarded in two cases. Local-only
                  // commands (no model invocation): the result IS the command
                  // output. Otherwise the result is normally a trailing copy of
                  // text that already streamed — but a cache-replayed turn
                  // generates no tokens, and some CLIs then skip streaming
                  // entirely and answer on the `result` alone: no `stream_event`
                  // deltas, no consolidated `assistant` message (issue #453).
                  // Forward it rather than end the turn silently:
                  // `deliveredAssistantText` covers whatever already reached the
                  // client (a turn that showed its answer cannot emit it twice),
                  // and the output-token check keeps the fallback to the
                  // replayed turns it was reported for. `?? 0`: typed non-null,
                  // but third-party backends have been observed omitting usage
                  // token fields (see snapshotFromUsage), and the replay lane
                  // was reported from exactly such a backend — treat a missing
                  // count as the replay signature rather than silently disabling
                  // the fallback there. (Autonomous results never get here —
                  // they exit at the early break above — so no background
                  // prose can be injected into the feed.)
                  if (
                    session.activeTurn?.isLocalOnlyCommand ||
                    (!deliveredAssistantText && (message.usage.output_tokens ?? 0) === 0)
                  ) {
                    for (const notification of toAcpNotifications(
                      message.result,
                      "assistant",
                      params.sessionId,
                      session.toolUseCache,
                      this.client,
                      this.logger,
                    )) {
                      await sendUpdate(notification);
                    }
                  }
                  break;
                }
                case "error_during_execution": {
                  if (message.stop_reason === "max_tokens") {
                    stopReason = "max_tokens";
                    break;
                  }
                  if (message.is_error) {
                    failActive(
                      RequestError.internalError(
                        errorKindData(lastAssistantError),
                        message.errors.join(", ") || message.subtype,
                      ),
                    );
                    break;
                  }
                  stopReason = "end_turn";
                  break;
                }
                case "error_max_budget_usd":
                case "error_max_turns":
                case "error_max_structured_output_retries":
                  if (message.is_error) {
                    failActive(
                      RequestError.internalError(
                        errorKindData(lastAssistantError),
                        message.errors.join(", ") || message.subtype,
                      ),
                    );
                    break;
                  }
                  stopReason = "max_turn_requests";
                  break;
                default:
                  unreachable(message, this.logger);
                  break;
              }
              // Settle the user turn at its terminal result so the client unlocks
              // as soon as the answer is done, rather than waiting for the SDK's
              // trailing `idle` (which can lag while background work runs — issue
              // #773). The consumer keeps draining afterward (absorbing idle and
              // forwarding any background output).
              //
              // One exception: while background subagents this turn spawned are
              // still live, settling now would strand their remaining work
              // outside any turn — ACP allows out-of-turn session/update, but
              // many clients stop consuming at the prompt response, and a
              // subagent's permission request would block on an RPC nobody
              // answers (issues #864/#866). Hold the turn open instead: store
              // the outcome and settle with it once the subagents are done —
              // at their followup's terminal result (see the deferred-settle
              // block above the subtype switch) or at an idle with none of
              // them left — so the subagents' streamed output, their
              // permission requests, and the model's promised summary all land
              // inside the turn. `session/cancel` and the next prompt's echo
              // hand-off still settle a deferred turn early, so a long-running
              // subagent never holds the prompt hostage.
              //
              // is_error/auth already settled via failActive (activeTurn is null
              // then, so both branches no-op); cancellation is left to the
              // idle/abort path. settleActive is idempotent, so a duplicate
              // idle is a no-op.
              if (!session.cancelled) {
                settleOrDefer({ stopReason, usage: sessionUsage(session) });
              }
            } finally {
              if (!isAutonomousResult) {
                session.emittedAssistantText = false;
              }
            }
            break;
          }
          case "stream_event": {
            // `message_start` carries the Anthropic API message id; capture it
            // so the streamed chunks that follow (whose delta events don't carry
            // it) can all be tagged with the same, replay-stable id.
            if (message.event.type === "message_start") {
              currentStreamMessageId = message.event.message.id || undefined;
              // A new top-level message starts: clear any streamed-content
              // residue from a prior message that never reached its
              // consolidated reset — a cancelled turn breaks out before the
              // reset, and the synthetic-auth/system/local-command paths
              // `break` early too. Block indices restart at 0 each message, so
              // leftover entries would otherwise collide with this message's
              // blocks and re-emit (or truncate) already-streamed text. Gated on
              // `parent_tool_use_id === null` so a subagent stream can't clear
              // the top-level record. Fires once, before any of this message's
              // blocks, so it doesn't disturb the mid-message turn-activation
              // path the way resetting on turn activation would.
              if (message.parent_tool_use_id === null) {
                streamedBlocks.length = 0;
              }
            }
            // Accumulate the text/thinking actually streamed live, so the
            // `assistant` case below can diff its assembled blocks against what
            // already reached the client as chunks and forward only the
            // remainder. Gated on `parent_tool_use_id === null` so a subagent
            // stream can't attribute its content to the top-level message.
            // Contiguous deltas of the same block (same index and type) extend
            // the current entry; anything else opens a new one.
            if (
              message.parent_tool_use_id === null &&
              message.event.type === "content_block_delta"
            ) {
              const delta = message.event.delta;
              const chunk =
                delta.type === "text_delta"
                  ? { type: "text" as const, text: delta.text }
                  : delta.type === "thinking_delta"
                    ? { type: "thinking" as const, text: delta.thinking }
                    : undefined;
              // Skip empty deltas (some gateways emit empty thinking chunks —
              // #793): appending "" is a no-op, but pushing a "" entry would
              // create a block the consolidated handler's `text.length > 0`
              // guard can never consume, stalling the diff cursor and
              // re-emitting the next block as a duplicate.
              if (chunk?.text) {
                const index = message.event.index;
                const last = streamedBlocks[streamedBlocks.length - 1];
                if (last && last.index === index && last.type === chunk.type) {
                  last.text += chunk.text;
                } else {
                  streamedBlocks.push({ index, type: chunk.type, text: chunk.text });
                }
              }
            }
            if (
              message.parent_tool_use_id === null &&
              (message.event.type === "message_start" || message.event.type === "message_delta")
            ) {
              if (message.event.type === "message_start") {
                lastAssistantUsage = snapshotFromUsage(message.event.message.usage);
                const model = message.event.message.model;
                if (model && model !== "<synthetic>") {
                  lastAssistantModel = model;
                  // Only upgrade from the default — once the SDK has given us
                  // an authoritative window (seeded at session creation,
                  // refreshed on model switches in `applyConfigOptionValue`,
                  // confirmed by each `result`), trust it over the heuristic.
                  if (session.contextWindowSize === DEFAULT_CONTEXT_WINDOW) {
                    const inferred = inferContextWindowFromModel(model);
                    if (inferred !== null) {
                      session.contextWindowSize = inferred;
                    }
                  }
                }
              } else {
                const usage = message.event.usage;
                const prev: Readonly<UsageSnapshot> = lastAssistantUsage ?? ZERO_USAGE;
                // Per Anthropic API, message_delta usage fields are *cumulative*;
                // nullable fields (input_tokens and the cache fields) fall back
                // to the prior snapshot when the server omits them from this
                // delta. Only output_tokens is guaranteed non-null.
                lastAssistantUsage = {
                  input_tokens: usage.input_tokens ?? prev.input_tokens,
                  output_tokens: usage.output_tokens,
                  cache_read_input_tokens:
                    usage.cache_read_input_tokens ?? prev.cache_read_input_tokens,
                  cache_creation_input_tokens:
                    usage.cache_creation_input_tokens ?? prev.cache_creation_input_tokens,
                };
              }

              const nextUsage = totalTokens(lastAssistantUsage);
              if (nextUsage !== lastAssistantTotalUsage) {
                lastAssistantTotalUsage = nextUsage;
                await sendUpdate({
                  sessionId: params.sessionId,
                  update: {
                    sessionUpdate: "usage_update",
                    used: nextUsage,
                    size: session.contextWindowSize,
                  },
                });
              }
            }
            for (const notification of streamEventToAcpNotifications(
              message,
              params.sessionId,
              session.toolUseCache,
              this.client,
              this.logger,
              {
                clientCapabilities: this.clientCapabilities,
                cwd: session.cwd,
                taskState: session.taskState,
                emittedToolCalls: session.emittedToolCalls,
                messageId: currentStreamMessageId,
                streamedToolInputs,
              },
            )) {
              // sendUpdate records delivery; a subagent stream's chunks carry
              // the stamped parentToolUseId meta and are excluded there.
              await sendUpdate(notification);
            }
            break;
          }
          case "user":
          case "assistant": {
            // Record the ACP messageId -> SDK uuid mapping for this message
            // (including replays). The consolidated message carries both ids, so
            // this is where we learn the uuid the SDK's rewind/resume APIs key on
            // for the id we hand clients. Not read yet (see messageIdToUuid).
            const mappedMessageId = messageIdForGrouping(message);
            if (mappedMessageId && typeof message.uuid === "string" && message.uuid.length > 0) {
              session.messageIdToUuid.set(mappedMessageId, message.uuid);
            }

            // A replayed user message echoes a queued turn back in submission
            // order. The first echo promotes that turn to active; if a different
            // turn is still active, it is handed off (settled end_turn) first.
            // Done before the `cancelled` guard so a turn enqueued after a cancel
            // is still promoted — activateTurn() clears the flag. The turn's own
            // echo is then dropped from the feed (the client already shows it).
            if (message.type === "user" && "uuid" in message && message.uuid) {
              const queued = findUnsettledTurn(message.uuid);
              if (queued) {
                // Only (re)activate if this isn't already the active turn — a
                // turn promoted early (e.g. by a result that preceded its echo)
                // must not have its accumulated usage reset by its own echo.
                if (session.activeTurn !== queued) {
                  if (session.activeTurn) {
                    // Hand off the previous turn. If a cancel is pending for it
                    // (its trailing idle hasn't arrived yet), settle it
                    // "cancelled" per the ACP contract rather than "end_turn" —
                    // otherwise a cancel followed quickly by the next prompt
                    // would report the cancelled turn as a normal completion.
                    if (session.cancelled) {
                      // The cancelled turn settles here, but the trailing idle
                      // its interrupt produces is still in flight — record the
                      // debt so that lagged idle is absorbed rather than read
                      // as the freshly-activated turn ending without a result
                      // (which would false-fail a healthy turn — issue #825).
                      // Counted for a DEFERRED turn too, even though its own
                      // result already recorded a debt that may still be
                      // outstanding: the interrupt can produce a trailer of
                      // its own, and over-counting is benign (absorbs one
                      // future idle) while under-counting risks the false
                      // fail this debt exists to prevent.
                      session.owedTrailingIdles++;
                      // Before activateTurn resets the accumulator, so the
                      // usage still belongs to the cancelled turn.
                      settleActive({ stopReason: "cancelled", usage: sessionUsage(session) });
                    } else if (isHeldOpen(session.activeTurn)) {
                      // A turn held open for its background subagents (see
                      // Turn.deferredSettle) hands off with the real outcome
                      // its result recorded, not a guessed end_turn — the
                      // user moving on must not block behind a long-running
                      // subagent, but it must not rewrite the stop reason
                      // either. Its trailing-idle debt stands and is absorbed
                      // when the drain idle eventually arrives.
                      settleActive(session.activeTurn.deferredSettle);
                    } else {
                      settleActive({ stopReason: "end_turn", usage: sessionUsage(session) });
                    }
                  }
                  // Unlike the no-result teardown lanes, this hand-off must
                  // NOT clear emittedAssistantText for a NON-held previous
                  // turn (a held one's settleActive above closes its own
                  // stretch): the echo can land
                  // mid-message, so deltas already streamed belong to the turn
                  // being activated — clearing would forget them and let its
                  // result re-emit the answer.
                  activateTurn(queued);
                }
                break;
              }
              if ("isReplay" in message && message.isReplay) {
                // Unrelated replay (e.g. the echo of an already-settled turn).
                break;
              }
            }

            if (session.cancelled) {
              break;
            }

            // Snapshot the latest top-level assistant usage and model so the
            // next `result` can emit a usage_update tied to the right context
            // window. Subagent messages are excluded to keep the snapshot
            // aligned with what the user's current selection is producing.
            if (message.type === "assistant" && message.parent_tool_use_id === null) {
              lastAssistantUsage = snapshotFromUsage(message.message.usage);
              lastAssistantTotalUsage = totalTokens(lastAssistantUsage);
              if (message.message.model && message.message.model !== "<synthetic>") {
                lastAssistantModel = message.message.model;
              }
              if (message.error) {
                lastAssistantError = message.error;
              }
              if (message.message.stop_reason === "refusal") {
                // Keep any explanation already seeded by a
                // `model_refusal_no_fallback` banner — the banner/frame
                // ordering is CLI-dependent, and a frame whose stop_details
                // was dropped (the case the banner backup exists for) must
                // not clobber the seed back to null.
                lastRefusalExplanation =
                  message.message.stop_details?.explanation ?? lastRefusalExplanation;
              }
            }

            // Strip <command-*>/<local-command-stdout> markers and render any
            // remaining prose. Skill bodies and built-in slash commands (e.g.
            // /usage, /status, /model) arrive wrapped in these tags; pure-marker
            // payloads (e.g. /compact's malformed output) strip to null and are
            // skipped. Mirrors the replay path at replaySessionHistory.
            if (
              message.message.role !== "system" &&
              typeof message.message.content === "string" &&
              message.message.content.includes("<local-command-stdout>")
            ) {
              const stripped = stripLocalCommandMetadata(message.message.content);
              if (typeof stripped === "string") {
                for (const notification of toAcpNotifications(
                  stripped,
                  message.message.role,
                  params.sessionId,
                  session.toolUseCache,
                  this.client,
                  this.logger,
                  {
                    clientCapabilities: this.clientCapabilities,
                    parentToolUseId: message.parent_tool_use_id,
                    cwd: session.cwd,
                    taskState: session.taskState,
                    messageId: messageIdForGrouping(message),
                  },
                )) {
                  await sendUpdate(notification);
                }
              } else {
                this.logger.log(message.message.content);
              }
              break;
            }

            if (
              typeof message.message.content === "string" &&
              message.message.content.includes("<local-command-stderr>")
            ) {
              this.logger.error(message.message.content);
              break;
            }
            // Skip these user messages for now, since they seem to just be messages we don't want in the feed
            if (
              message.type === "user" &&
              (typeof message.message.content === "string" ||
                (Array.isArray(message.message.content) &&
                  message.message.content.length === 1 &&
                  message.message.content[0].type === "text"))
            ) {
              break;
            }
            if (message.message.role === "system") {
              break;
            }

            if (message.type === "assistant" && isSyntheticLoginMessage(message.message)) {
              failActive(RequestError.authRequired());
              break;
            }

            let content: typeof message.message.content;
            if (message.type === "assistant" && message.parent_tool_use_id === null) {
              // Top-level assistant message: each text/thinking block may have
              // already been streamed live as deltas. Diff each against what
              // streamed (`streamedBlocks`, in document order) and forward only
              // the un-streamed remainder — nothing if it streamed in full (the
              // common case), the whole block if it never streamed (a
              // non-streaming gateway), or just the tail if the stream was cut
              // short mid-block. `streamPos` walks the streamed blocks in step
              // with the assembled text/thinking blocks; tool_use and other
              // blocks pass through untouched (their own `toolUseCache` collapses
              // the streamed/assembled pair) without advancing it.
              const blocks = message.message.content;
              const kept: typeof blocks = [];
              let streamPos = 0;
              for (const item of blocks) {
                if (item.type !== "text" && item.type !== "thinking") {
                  kept.push(item);
                  continue;
                }
                const full = item.type === "text" ? item.text : item.thinking;
                // Empty assembled blocks carry nothing (some gateways emit an
                // empty `thinking` block before the real text) — drop them.
                if (full.length === 0) {
                  continue;
                }
                // A streamed block of the same type whose accumulated text is a
                // prefix of this one was already (at least partly) delivered as
                // chunks; consume it and forward only what's left. A non-empty
                // streamed text is required so an empty/aborted streamed block
                // doesn't swallow the assembled copy.
                const streamed = streamedBlocks[streamPos];
                if (
                  streamed &&
                  streamed.type === item.type &&
                  streamed.text.length > 0 &&
                  full.startsWith(streamed.text)
                ) {
                  streamPos++;
                  const remainder = full.slice(streamed.text.length);
                  if (remainder.length === 0) {
                    continue;
                  }
                  // Overwrite in place with just the un-streamed tail (the
                  // assembled message isn't read again after this) so the block
                  // keeps its exact SDK type.
                  if (item.type === "text") {
                    item.text = remainder;
                  } else {
                    item.thinking = remainder;
                  }
                  kept.push(item);
                  continue;
                }
                // Not matched: never streamed (or the stream diverged from the
                // assembled text) — forward the block in full.
                kept.push(item);
              }
              content = kept;
              // Consumed: reset so the next message's blocks accumulate fresh and
              // the record stays bounded to the in-flight message.
              streamedBlocks.length = 0;
            } else if (message.type === "assistant") {
              // Subagent assistant message (`parent_tool_use_id !== null`). It is
              // never streamed live and its text/thinking is internal to the tool
              // call — keep dropping it so subagent prose doesn't leak into the
              // top-level feed.
              content = message.message.content.filter(
                (item) => item.type !== "text" && item.type !== "thinking",
              );
            } else {
              content = message.message.content;
            }

            for (const notification of toAcpNotifications(
              content,
              message.message.role,
              params.sessionId,
              session.toolUseCache,
              this.client,
              this.logger,
              {
                clientCapabilities: this.clientCapabilities,
                parentToolUseId: message.parent_tool_use_id,
                cwd: session.cwd,
                taskState: session.taskState,
                emittedToolCalls: session.emittedToolCalls,
                messageId: messageIdForGrouping(message),
                toolUseResult: message.type === "user" ? message.tool_use_result : undefined,
              },
            )) {
              // sendUpdate records delivery. Subagent text/thinking is
              // filtered out of `content` above; blocks that do pass through
              // (e.g. a subagent image) carry the stamped parentToolUseId
              // meta and are excluded there.
              await sendUpdate(notification);
            }
            break;
          }
          case "tool_progress": {
            await sendUpdate({
              sessionId: message.session_id,
              update: {
                sessionUpdate: "tool_call_update",
                toolCallId: message.tool_use_id,
                status: "in_progress",
                _meta: {
                  claudeCode: {
                    toolName: message.tool_name,
                    toolResponse: { elapsedTimeSeconds: message.elapsed_time_seconds },
                  },
                } satisfies ToolUpdateMeta,
              },
            });
            break;
          }
          case "rate_limit_event": {
            if (lastAssistantTotalUsage !== null) {
              await sendUpdate({
                sessionId: message.session_id,
                update: {
                  sessionUpdate: "usage_update",
                  used: lastAssistantTotalUsage,
                  size: session.contextWindowSize,
                  _meta: { "_claude/rateLimit": message.rate_limit_info },
                },
              });
            }
            break;
          }
          // `conversation_reset` (from `/clear`, plan-mode exit, fresh-session
          // flows) is safe to drop: turn lifecycle here is driven by
          // results/idle, and the client owns its own transcript view.
          case "tool_use_summary":
          case "auth_status":
          case "prompt_suggestion":
          case "conversation_reset":
            break;
          default:
            unreachable(message, this.logger);
            break;
        }
      }
      // `while (true)` only exits via the `done` return above or the catch
      // below, so there is no normal fall-through here.
    } catch (error) {
      // The query stream itself died (a transport/process error surfaced from
      // query.next()). Turn-level failures (auth, error results) are handled
      // inline via failActive and never reach here. Reject every in-flight turn;
      // if the process is gone, tear the session down so the client starts fresh.
      const message = error instanceof Error ? error.message : String(error);
      const processDied =
        error instanceof Error &&
        (message.includes("ProcessTransport") ||
          message.includes("terminated process") ||
          message.includes("process exited with") ||
          message.includes("process terminated by signal") ||
          message.includes("Failed to write to process stdin"));
      // Either way the query iterator is finished and the consumer is exiting,
      // so release its resources via closeQueryStream (idempotent). A process
      // death is unrecoverable, so additionally evict the session so the client
      // starts fresh; other stream errors keep the session so prompt()/cancel()
      // can answer with a clear "session ended" error.
      if (processDied) {
        this.logger.error(`Session ${params.sessionId}: Claude Agent process died: ${message}`);
        failAllTurns(
          RequestError.internalError(
            undefined,
            "The Claude Agent process exited unexpectedly. Please start a new session.",
          ),
        );
        this.closeQueryStream(session);
        delete this.sessions[params.sessionId];
      } else {
        this.logger.error(`Session ${params.sessionId}: query stream error: ${message}`);
        failAllTurns(error);
        this.closeQueryStream(session);
      }
    }
  }

  /** Route one orphaned command into the session's orphan-accounting lane:
   *  the per-uuid map on msg_lifecycle_v1 CLIs (drained by the command's own
   *  terminal lifecycle frame and the echo-less-result skip), the plain count
   *  elsewhere (the count lane can't express per-command states, so `state`
   *  only matters on the map lane). Both orphan-producing paths — cancel()'s
   *  queued-turn sweep and the consumer's force-cancel wedge path — must seed
   *  through here so the lane split stays a single mechanism.
   *
   *  Known window: `msgLifecycleV1` is only learnable from the stream's first
   *  `system`/init (the control-channel initialize carries no capabilities),
   *  so a cancel that beats that drain seeds the COUNT lane on a
   *  lifecycle-capable CLI — where command coalescing can leave the count
   *  stale by N-1 (the pre-map bug, confined to this sub-second window and
   *  still healed by the next activation's reset). Structural until the SDK
   *  exposes capabilities before the stream starts. */
  private trackOrphanCommand(
    session: Session,
    uuid: string,
    state: "pending" | "started" | "zombie",
  ): void {
    if (session.msgLifecycleV1) {
      session.orphanCommands ??= new Map();
      session.orphanCommands.set(uuid, state);
    } else {
      session.pendingOrphanResults = (session.pendingOrphanResults ?? 0) + 1;
    }
  }

  async cancel(params: CancelNotification): Promise<void> {
    const session = this.sessions[params.sessionId];
    if (!session) {
      return;
    }
    // The stream already ended (see closeQueryStream): every in-flight turn was
    // settled when it closed, and there is no live query to interrupt. Calling
    // query.interrupt() on a finished iterator could reject and surface from
    // this fire-and-forget notification, so there is nothing to do here.
    if (session.queryClosed) {
      return;
    }
    session.cancelled = true;
    // Capture the orphan-accounting lane before anything can await: the
    // consumer latches msgLifecycleV1 when it drains the first system/init,
    // which can happen DURING the awaited interrupt() below — the receipt
    // reconciliation must act on the same lane the seeding used, or a
    // count-lane orphan would be left for the map-lane receipt path (which
    // never decrements the count) to miss.
    const lifecycleLane = session.msgLifecycleV1 === true;
    // Settle queued turns that haven't started yet (no echo seen) right away —
    // they have no in-flight SDK work to interrupt. The active turn is settled
    // by the consumer when it observes the interrupt's trailing idle (or via the
    // backstop below). Mirrors the old pendingMessages cancellation.
    const orphanedTurns: Turn[] = [];
    if (session.turnQueue) {
      for (const turn of session.turnQueue) {
        if (turn !== session.activeTurn && !turn.settled) {
          turn.settled = true;
          // Deliberately no `usage`: a queued turn never ran, so the session
          // accumulator (the active turn's tally) is not its spend.
          turn.resolve({ stopReason: "cancelled" });
          orphanedTurns.push(turn);
        }
      }
      // Each removed queued turn's user message was already pushed to the SDK,
      // which processes input FIFO and will still emit a result for it with no
      // uuid to match. Track those so the consumer skips them (see
      // ensureActiveTurn) rather than misattributing them to the head.
      // msg_lifecycle_v1 CLIs get per-uuid tracking drained by the command's
      // own terminal lifecycle frame — exact under command coalescing, where
      // N queued commands fold into ONE turn emitting one result and a plain
      // count would go stale by N-1 and swallow a later echo-less result.
      // Older CLIs keep the count and its activation-time self-heal (they
      // never see lifecycle frames, so commandStarted/commandFinished stay
      // unset and every turn takes the plain-seed path below).
      for (const turn of orphanedTurns) {
        if (turn.commandFinished === "completed" || turn.commandFinished === "discarded") {
          // The command already finished SDK-side and its terminal frame was
          // consumed while the turn sat queued — nothing is left to skip, and
          // a seeded entry would never drain.
          continue;
        }
        if (turn.commandFinished === "cancelled") {
          // Terminal frame already consumed. Dispatched-then-aborted: the
          // dead turn's late result may still come — seed the zombie the
          // frame handler would have made — unless that result already
          // passed pre-cancel (commandResultSeen: e.g. the command folded
          // into the active turn and their shared result was attributed
          // there), in which case a zombie would be a phantom that swallows
          // an unrelated later result. Never dispatched: dropped, no result
          // coming, nothing to track.
          if (turn.commandStarted && !turn.commandResultSeen) {
            this.trackOrphanCommand(session, turn.promptUuid, "zombie");
          }
          continue;
        }
        if (turn.commandStarted && turn.commandResultSeen) {
          // Dispatched and its turn's result already passed; only its
          // terminal frame is outstanding, which no-ops with no entry.
          continue;
        }
        this.trackOrphanCommand(
          session,
          turn.promptUuid,
          turn.commandStarted ? "started" : "pending",
        );
      }
      session.turnQueue = session.turnQueue.filter(
        (turn) => turn === session.activeTurn && !turn.settled,
      );
    }

    // A deferred active turn (see Turn.deferredSettle) already has its
    // result — it is only held open for its background subagents, which the
    // interrupt below tears down. Settle it "cancelled" NOW: during the hold
    // the session is typically already in state idle (the CLI's trailer
    // fired at the result), so the interrupt may produce no fresh idle for
    // the consumer's cancelled-settle path to run on, and the cancel would
    // otherwise stall until the force-cancel backstop. Any outstanding
    // trailer debt is absorbed by the idle handler when its idle does come.
    // The turn's own usage snapshot is reported per the cancelled-usage
    // contract (issue #844).
    {
      const active = session.activeTurn;
      if (isHeldOpen(active)) {
        active.settled = true;
        // Mirror settleActive's invariants (it is consumer-scoped and
        // unreachable from here): disarm the backstop — none should be
        // armed for a held turn, but a drift here must not leave a timer
        // firing on a settled turn — and drop the turn from the queue.
        disarmForceCancel(session);
        session.turnQueue = (session.turnQueue ?? []).filter((t) => t !== active);
        session.activeTurn = null;
        // Settling a held turn closes its delivery stretch: any streamed
        // text since the last boundary was its followups', and left latched
        // it would suppress a following replayed turn's issue-#453 fallback.
        session.emittedAssistantText = false;
        // When the interrupt below pre-empts a live cycle — running, or
        // blocked on a permission request (requires_action, the #866 shape
        // users cancel out of) — it produces a trailer idle with no counted
        // result; with the hold's own trailer typically already absorbed,
        // that idle would be un-owed and could lag past the next prompt's
        // echo — read as the fresh turn ending without a result (issue #825
        // false-fail). Pre-count it unless the session sits idle: there the
        // interrupt emits nothing, and a debt that never drains would mask
        // one future #825 detection. (lastSessionState is last-CONSUMED, so
        // both stale reads exist and both are accepted one-cycle windows: a
        // running transition still in the backlog reads as stale idle and
        // under-counts — that false-fail additionally needs the trailer to
        // lag past the next echo — while a cycle already completed into the
        // backlog reads as stale non-idle and over-counts, masking one
        // future #825 detection. Undefined — no state event consumed —
        // pre-counts; that only occurs on CLIs whose missing idle events
        // also disable the detector the debt could mask.)
        if (session.lastSessionState !== "idle") {
          session.owedTrailingIdles++;
        }
        active.resolve({ stopReason: "cancelled", usage: active.deferredSettle.usage });
      }
    }

    // Arm a backstop before interrupting: if a turn is actively consuming the
    // query and interrupt() doesn't make the SDK yield (e.g. a wedged TaskOutput
    // block — issue #680), force the consumer to settle the active turn
    // "cancelled" after the floor elapses so the pending session/prompt still
    // resolves per the ACP cancellation contract instead of hanging forever. The
    // consumer clears this timer when interrupt() works and it settles through
    // the normal idle path, so on healthy cancels it is armed but never fires.
    //
    // Arm at most once per turn: the floor is an absolute ceiling from the first
    // cancel, so a client that re-sends cancel (each call still retries
    // interrupt() below) can't keep pushing the deadline out.
    if (
      session.activeTurn &&
      session.cancelController &&
      !session.cancelController.signal.aborted &&
      !session.forceCancelTimer
    ) {
      const cancelController = session.cancelController;
      session.forceCancelTimer = setTimeout(() => {
        this.logger.error(
          `Session ${params.sessionId}: cancel floor elapsed without the SDK yielding; forcing "cancelled". The underlying query may still be wedged — a new session may be required.`,
        );
        cancelController.abort();
      }, this.forceCancelGraceMs);
    }

    const receipt = await session.query.interrupt();
    // On CLIs advertising `interrupt_receipt_v1`, the receipt's `still_queued`
    // lists exactly which queued messages survive the interrupt and will still
    // run. An orphaned turn whose uuid is absent was dropped by the interrupt
    // and will never emit a result — uncount it now instead of leaving a stale
    // skip that activateTurn's reset only clears once a later live ECHO
    // arrives: an echo-less result in between (a local-only command like
    // `/context`) would be wrongly swallowed by the leftover count. Subtracting
    // a count (rather than tracking uuids) stays race-safe against the
    // consumer draining concurrently: dropped uuids produce no results, so the
    // consumer's decrements only ever consume the still-queued share. Unknown
    // uuids in the receipt (internally-enqueued messages) are ignored, per its
    // contract. Older CLIs resolve `undefined` (guard the FIELD, not just the
    // receipt, so a bare `{}` success from a gateway can't read as "everything
    // was dropped") — keep the count-everything behavior and its
    // activation-time self-heal.
    if (Array.isArray(receipt?.still_queued) && orphanedTurns.length > 0) {
      const stillQueued = new Set(receipt.still_queued);
      if (lifecycleLane) {
        // Lifecycle lane: forget dropped orphans by uuid. Only entries still
        // "pending" — an orphan absent from `still_queued` because it was
        // DISPATCHED before the interrupt (not dropped) has usually been
        // promoted to "started" by its lifecycle frame by now, and its own
        // terminal frame must stay in charge of its fate. (If that frame is
        // still in the consumer's backlog we mis-forget — the same exposure
        // the count lane has always had for a dropped-then-run command.)
        // Mostly redundant with the "cancelled"-frame removal, but a receipt
        // survives paths where that frame was never emitted.
        for (const turn of orphanedTurns) {
          if (
            !stillQueued.has(turn.promptUuid) &&
            session.orphanCommands?.get(turn.promptUuid) === "pending"
          ) {
            session.orphanCommands.delete(turn.promptUuid);
          }
        }
      } else {
        const dropped = orphanedTurns.filter((turn) => !stillQueued.has(turn.promptUuid)).length;
        if (dropped > 0) {
          session.pendingOrphanResults = Math.max(0, (session.pendingOrphanResults ?? 0) - dropped);
        }
      }
    }
  }

  /** Mark a session's SDK query stream as permanently ended and release the
   *  resources tied to it: drop the consumer handle, dispose the settings
   *  watchers, end the input stream, and close the query (which terminates the
   *  subprocess). The query iterator is not revivable, so `prompt()`/`cancel()`
   *  consult `queryClosed` and fail/short-circuit instead of acting on a dead
   *  stream. Idempotent (guarded by `queryClosed`), so the consumer's done/error
   *  paths and a later `teardownSession` can all call it without double-releasing.
   *
   *  Deliberately does NOT abort `session.abortController`: that controller may be
   *  CLIENT-supplied (`_meta.claudeCode.options.abortController`) and reused, so
   *  aborting it on a spontaneous stream end would cancel the client's own work
   *  or make a sibling session born aborted. `query.close()` already terminates
   *  the subprocess; aborting the signal belongs in `teardownSession` (explicit
   *  destroy), not here. Also does NOT remove the session from the map — that is
   *  `teardownSession`'s job — so prompt() can still answer with a clear "session
   *  ended" error after an unexpected stream close. The leftover session object
   *  is a lightweight husk (its heavy resources are released here) and is evicted
   *  on the next closeSession/deleteSession or when the connection's `dispose()`
   *  runs. */
  private closeQueryStream(session: Session): void {
    if (session.queryClosed) {
      return;
    }
    session.queryClosed = true;
    session.consumer = undefined;
    session.settingsManager.dispose();
    session.input.end();
    session.query.close();
  }

  /** Cleanly tear down a session: cancel in-flight work, release stream
   *  resources, and remove it from the session map. */
  private async teardownSession(sessionId: string): Promise<void> {
    const session = this.sessions[sessionId];
    if (!session) {
      return;
    }
    await this.cancel({ sessionId });
    // cancel() arms the force-cancel floor and interrupts gracefully, but a
    // wedged consumer only wakes when `cancelController` aborts — closeQueryStream
    // below doesn't touch it. Since we're tearing the session down anyway, wake
    // the consumer now so the in-flight prompt() resolves immediately instead of
    // after the floor, and clear the timer so it can't outlive the deleted
    // session (it isn't unref'd and would otherwise keep the event loop alive
    // until it fires).
    disarmForceCancel(session);
    session.cancelController?.abort();
    this.closeQueryStream(session);
    // Abort the SDK abort signal only on explicit destroy. closeQueryStream
    // leaves it alone (it may be a client-owned controller — see its doc), but
    // here the client has asked us to close the session, so signalling abort is
    // appropriate; query.close() above has already torn the subprocess down.
    session.abortController.abort();
    delete this.sessions[sessionId];
  }

  /** Tear down all active sessions. Called when the ACP connection closes. */
  async dispose(): Promise<void> {
    await Promise.all(Object.keys(this.sessions).map((id) => this.teardownSession(id)));
  }

  async closeSession(params: CloseSessionRequest): Promise<CloseSessionResponse> {
    if (!this.sessions[params.sessionId]) {
      throw new Error("Session not found");
    }
    await this.teardownSession(params.sessionId);
    return {};
  }

  async deleteSession(params: DeleteSessionRequest): Promise<DeleteSessionResponse> {
    // Tear down any active in-memory state first so the on-disk file isn't
    // recreated by an outstanding query writing to it.
    if (this.sessions[params.sessionId]) {
      await this.teardownSession(params.sessionId);
    }
    await deleteSession(params.sessionId);
    return {};
  }

  async setSessionMode(params: SetSessionModeRequest): Promise<SetSessionModeResponse> {
    const session = this.sessions[params.sessionId];
    if (!session) {
      throw new Error("Session not found");
    }
    // The SDK query stream already ended (see closeQueryStream); the session is
    // a husk and `query.setPermissionMode` below would act on a closed query.
    // Fail with the same clear message prompt()/cancel() give for a dead stream.
    if (session.queryClosed) {
      throw RequestError.internalError(undefined, SESSION_ENDED_MESSAGE);
    }

    await this.applySessionMode(params.sessionId, params.modeId);
    await this.updateConfigOption(params.sessionId, MODE_CONFIG_ID, params.modeId);
    return {};
  }

  async setSessionConfigOption(
    params: SetSessionConfigOptionRequest,
  ): Promise<SetSessionConfigOptionResponse> {
    const session = this.sessions[params.sessionId];
    if (!session) {
      throw new Error("Session not found");
    }
    // The SDK query stream already ended (see closeQueryStream); the session is
    // a husk and the `query.setModel`/`setPermissionMode`/`applyFlagSettings`
    // calls this triggers would act on a closed query. Fail with the same clear
    // message prompt()/cancel() give for a dead stream.
    if (session.queryClosed) {
      throw RequestError.internalError(undefined, SESSION_ENDED_MESSAGE);
    }

    const option = session.configOptions.find((o) => o.id === params.configId);
    if (!option) {
      throw new Error(`Unknown config option: ${params.configId}`);
    }

    // Fast mode carries a boolean value (for Clients that opted into boolean
    // config options) or the "on"/"off" select fallback, so it bypasses the
    // string-only validation the select-style options below rely on.
    if (params.configId === FAST_MODE_CONFIG_ID) {
      await this.applyFastMode(session, resolveFastModeEnabled(params));
      return { configOptions: session.configOptions };
    }

    if (typeof params.value !== "string") {
      throw new Error(`Invalid value for config option ${params.configId}: ${params.value}`);
    }

    const allValues =
      "options" in option && Array.isArray(option.options)
        ? option.options.flatMap((o) => ("options" in o ? o.options : [o]))
        : [];
    let validValue = allValues.find((o) => o.value === params.value);

    // The option's reported currentValue is always a valid target, even when
    // it has no options entry: a session running an out-of-picker model
    // (resumed onto an allowlist-excluded model, or a refusal fallback)
    // reports a currentValue that isn't selectable, and a client
    // round-tripping it must not get "Invalid value". It flows through the
    // normal apply path below — re-asserting an already-current value is
    // harmless and can repair SDK drift.
    if (!validValue && option.currentValue === params.value) {
      validValue = { value: params.value, name: params.value };
    }

    // For model options, fall back to resolveModelPreference when the exact
    // value doesn't match.  This lets callers use human-friendly aliases like
    // "opus" or "sonnet" instead of full model IDs like "claude-opus-4-6".
    // Resolve against session.modelInfos first: those entries carry
    // `resolvedModel`, so a full model id (in either hint spelling) lands on
    // the right row via the exact tier instead of a fuzzier one picking a
    // same-family sibling from a different context lane. The options-derived
    // list (which never carries `resolvedModel`) remains as a fallback for
    // resolutions that don't map back onto a selectable option (e.g. a fuzzy
    // hit on an out-of-picker verbatim entry).
    if (!validValue && params.configId === MODEL_CONFIG_ID) {
      const toOptionValue = (resolved: ModelInfo | null) =>
        resolved ? allValues.find((o) => o.value === resolved.value) : undefined;
      validValue = toOptionValue(resolveModelPreference(session.modelInfos, params.value));
      if (!validValue) {
        const optionInfos: ModelInfo[] = allValues.map((o) => ({
          value: o.value,
          displayName: o.name,
          description: o.description ?? "",
        }));
        validValue = toOptionValue(resolveModelPreference(optionInfos, params.value));
      }
    }

    if (!validValue) {
      throw new Error(`Invalid value for config option ${params.configId}: ${params.value}`);
    }

    // Use the canonical option value so downstream code always receives the
    // model ID rather than the caller-supplied alias.
    const resolvedValue = validValue.value;

    if (params.configId === MODE_CONFIG_ID) {
      await this.applySessionMode(params.sessionId, resolvedValue);
      await this.client.sessionUpdate({
        sessionId: params.sessionId,
        update: {
          sessionUpdate: "current_mode_update",
          currentModeId: resolvedValue,
        },
      });
    } else if (params.configId === MODEL_CONFIG_ID) {
      await this.sessions[params.sessionId].query.setModel(resolvedValue);
    }
    // Effort SDK sync is handled inside applyConfigOptionValue so that direct
    // effort changes and effort changes induced by a model switch go through
    // the same path.

    await this.applyConfigOptionValue(params.sessionId, session, params.configId, resolvedValue);

    return { configOptions: session.configOptions };
  }

  private async applySessionMode(sessionId: string, modeId: string): Promise<void> {
    switch (modeId) {
      case "auto":
      case "default":
      case "acceptEdits":
      case "bypassPermissions":
      case "dontAsk":
      case "plan":
        break;
      default:
        throw new Error("Invalid Mode");
    }

    const session = this.sessions[sessionId];
    if (!session) {
      throw new Error("Session not found");
    }
    if (!session.modes.availableModes.some((mode) => mode.id === modeId)) {
      throw new Error(`Mode ${modeId} is not available in this session`);
    }

    try {
      await session.query.setPermissionMode(modeId);
    } catch (error) {
      if (error instanceof Error) {
        if (!error.message) {
          error.message = "Invalid Mode";
        }
        throw error;
      } else {
        // eslint-disable-next-line preserve-caught-error
        throw new Error("Invalid Mode");
      }
    }
  }

  private async replaySessionHistory(sessionId: string): Promise<void> {
    const toolUseCache: ToolUseCache = {};
    const messages = await getSessionMessages(sessionId);

    for (const message of messages) {
      // Backfill the ACP messageId -> SDK uuid mapping for messages we didn't
      // observe live (resumed/loaded sessions), so rewind/resume can translate
      // a client-supplied id without an extra getSessionMessages read. Not read
      // yet (see Session.messageIdToUuid).
      const replayMessageId = messageIdForGrouping(message);
      const replaySession = this.sessions[sessionId];
      if (replaySession && replayMessageId && message.uuid) {
        replaySession.messageIdToUuid.set(replayMessageId, message.uuid);
      }

      // The live prompt loop converts the synthetic "Please run /login"
      // assistant message into an authRequired error instead of showing its
      // TUI-specific text; skip it on replay too (issue #863).
      if (message.type === "assistant" && isSyntheticLoginMessage(message.message)) {
        continue;
      }

      // @ts-expect-error - untyped in SDK but we handle all of these
      let content: unknown = message.message.content;
      // @ts-expect-error - untyped in SDK but we handle all of these
      if (message.message.role === "user") {
        content = stripLocalCommandMetadata(content);
        if (content === null) continue;
      }

      for (const notification of toAcpNotifications(
        // @ts-expect-error - untyped in SDK but we handle all of these
        content,
        // @ts-expect-error - untyped in SDK but we handle all of these
        message.message.role,
        sessionId,
        toolUseCache,
        this.client,
        this.logger,
        {
          registerHooks: false,
          clientCapabilities: this.clientCapabilities,
          cwd: this.sessions[sessionId]?.cwd,
          taskState: this.sessions[sessionId]?.taskState,
          messageId: replayMessageId,
        },
      )) {
        await this.client.sessionUpdate(notification);
      }
    }
  }

  async readTextFile(params: ReadTextFileRequest): Promise<ReadTextFileResponse> {
    const response = await this.client.readTextFile(params);
    return response;
  }

  async writeTextFile(params: WriteTextFileRequest): Promise<WriteTextFileResponse> {
    const response = await this.client.writeTextFile(params);
    return response;
  }

  /** Forward a permission request to the client, wiring the tool call's
   *  `signal` through as a `cancellationSignal`. When the turn is cancelled
   *  while the client's prompt is still open the signal aborts, the SDK sends
   *  `$/cancel_request`, and the client settles the request (a `cancelled`
   *  outcome or a `requestCancelled` rejection). Either way we surface the same
   *  "Tool use aborted" the callers already expect, so a cancelled dialog no
   *  longer leaves the `await` hanging. */
  private async requestPermissionFromClient(
    params: RequestPermissionRequest,
    toolName: string,
    signal: AbortSignal,
    parentToolUseId?: string,
  ): Promise<RequestPermissionResponse> {
    // The SDK may invoke `canUseTool` (and therefore this permission request)
    // before the assistant message's tool_use block streams to us. Some ACP clients
    // expect the `tool_call` a permission request references to already exist,
    // so emit it now if it hasn't been sent yet. The streamed tool_use chunk
    // later refines it with a `tool_call_update` rather than emitting a
    // duplicate (see `emittedToolCalls` in `toAcpNotifications`).
    await this.ensureToolCallEmitted(
      params.sessionId,
      toolName,
      params.toolCall.toolCallId,
      params.toolCall.rawInput,
      parentToolUseId,
    );
    try {
      return await this.client.requestPermission(params, signal);
    } catch (error) {
      if (signal.aborted) {
        throw new Error("Tool use aborted", { cause: error });
      }
      throw error;
    }
  }

  /** Emit the `tool_call` a permission request references if it hasn't been sent
   *  yet, so the client has the tool call before being asked to approve it. The
   *  matching streamed tool_use chunk later refines it with a `tool_call_update`
   *  instead of emitting a duplicate (see `emittedToolCalls`). Built via the same
   *  `toolCallNotification` helper as the streamed path so the two are identical.
   *  Tools the stream renders as a plan (TodoWrite) or suppresses (Task*) are
   *  emitted too: a permission request referencing a tool call the client has
   *  never seen can trip strict clients (issue #851), so the reference must
   *  always resolve. Since the streamed path never completes those calls, they
   *  are resolved at tool_result time instead (see `toAcpNotifications`).
   *  `parentToolUseId` attributes a subagent's tool call to the Agent/Task call
   *  that spawned it, matching the streamed path's `_meta`. */
  private async ensureToolCallEmitted(
    sessionId: string,
    toolName: string,
    toolCallId: string,
    toolInput: unknown,
    parentToolUseId?: string,
  ): Promise<void> {
    const session = this.sessions[sessionId];
    if (!session) {
      return;
    }
    if (session.emittedToolCalls.has(toolCallId)) {
      return;
    }
    session.emittedToolCalls.add(toolCallId);
    const supportsTerminalOutput = this.clientCapabilities?._meta?.["terminal_output"] === true;
    const update = toolCallNotification(
      { id: toolCallId, name: toolName, input: toolInput },
      toolInput,
      supportsTerminalOutput,
      session.cwd,
    );
    if (parentToolUseId) {
      update._meta = {
        ...update._meta,
        claudeCode: {
          ...(update._meta?.claudeCode || {}),
          parentToolUseId,
        },
      };
    }
    await this.client.sessionUpdate({ sessionId, update });
  }

  canUseTool(sessionId: string): CanUseTool {
    return async (toolName, toolInput, { signal, suggestions, toolUseID, agentID }) => {
      const alwaysAllowLabel = describeAlwaysAllow(suggestions, toolName);
      const supportsTerminalOutput = this.clientCapabilities?._meta?.["terminal_output"] === true;
      const session = this.sessions[sessionId];
      if (!session) {
        return {
          behavior: "deny",
          message: "Session not found",
        };
      }

      // When the tool call originates inside a subagent, attribute the eagerly
      // emitted tool_call (and the permission request itself) to the Agent/Task
      // tool call that spawned the subagent, mirroring the streamed subagent
      // path's `_meta.claudeCode.parentToolUseId` (see `liveBackgroundTasks`).
      const parentToolUseId = agentID
        ? session.liveBackgroundTasks.get(agentID)?.parentToolUseId
        : undefined;
      if (agentID && !parentToolUseId) {
        // The attribution rests on an undocumented SDK invariant
        // (task_started.task_id === canUseTool's agentID for subagent tasks;
        // verified against the bundled CLI). Should an SDK bump break it — or
        // the consumer lose the race with task_started — the lookup misses and
        // the request goes out unattributed; log it so the regression is
        // observable rather than silent.
        this.logger.log(
          `[claude-agent-acp] No parent tool_use recorded for subagent ${agentID}; ` +
            `sending the ${toolName} permission request unattributed`,
        );
      }

      // AskUserQuestion is surfaced to us as a normal permission check (the SDK
      // routes it through canUseTool whenever a callback is registered, rather
      // than the interactive dialog). Present it as an ACP form elicitation and
      // feed the answers back as updatedInput for the tool's own call() to read.
      if (toolName === "AskUserQuestion" && this.clientCapabilities?.elicitation?.form) {
        // Like permission requests, the elicitation references this toolUseID, so
        // make sure the tool_call has surfaced to the client before we send it.
        await this.ensureToolCallEmitted(
          sessionId,
          toolName,
          toolUseID,
          toolInput,
          parentToolUseId,
        );
        return this.handleAskUserQuestion(sessionId, toolInput, toolUseID, signal);
      }

      if (toolName === "ExitPlanMode") {
        const optionsAll: PermissionOption[] = [
          { kind: "allow_always", name: 'Yes, and use "auto" mode', optionId: "auto" },
          {
            kind: "allow_always",
            name: "Yes, and auto-accept edits",
            optionId: "acceptEdits",
          },
          { kind: "allow_once", name: "Yes, and manually approve edits", optionId: "default" },
          { kind: "reject_once", name: "No, keep planning", optionId: "plan" },
        ];
        if (ALLOW_BYPASS) {
          optionsAll.unshift({
            kind: "allow_always",
            name: "Yes, and bypass permissions",
            optionId: "bypassPermissions",
          });
        }
        // Filter against the session's currently-advertised modes so we never
        // present options the active model can't honor (e.g. `auto` on Haiku).
        // `bypassPermissions` is already covered by `availableModes` via
        // `buildAvailableModes`/`ALLOW_BYPASS`. The `plan` option is a
        // "keep planning" reject path; it's always present in `availableModes`.
        const options = optionsAll.filter((o) =>
          session.modes.availableModes.some((m) => m.id === o.optionId),
        );

        const response = await this.requestPermissionFromClient(
          {
            options,
            sessionId,
            toolCall: {
              toolCallId: toolUseID,
              rawInput: toolInput,
              ...toolInfoFromToolUse(
                { name: toolName, input: toolInput, id: toolUseID },
                supportsTerminalOutput,
                session?.cwd,
              ),
              // `claudeCode` metas always carry `toolName` (see ToolUpdateMeta),
              // so clients can rely on one shape everywhere.
              ...(parentToolUseId
                ? { _meta: { claudeCode: { toolName, parentToolUseId } } satisfies ToolUpdateMeta }
                : {}),
            },
          },
          toolName,
          signal,
          parentToolUseId,
        );

        if (signal.aborted || response.outcome?.outcome === "cancelled") {
          throw new Error("Tool use aborted");
        }
        const selectedMode =
          response.outcome?.outcome === "selected" ? response.outcome.optionId : undefined;
        const selectedModeWasOffered = options.some((option) => option.optionId === selectedMode);
        if (
          selectedModeWasOffered &&
          (selectedMode === "default" ||
            selectedMode === "acceptEdits" ||
            selectedMode === "auto" ||
            selectedMode === "bypassPermissions")
        ) {
          await this.client.sessionUpdate({
            sessionId,
            update: {
              sessionUpdate: "current_mode_update",
              currentModeId: selectedMode,
            },
          });
          await this.updateConfigOption(sessionId, MODE_CONFIG_ID, selectedMode);

          return {
            behavior: "allow",
            updatedInput: toolInput,
            updatedPermissions: suggestions ?? [
              { type: "setMode", mode: selectedMode, destination: "session" },
            ],
          };
        } else {
          return {
            behavior: "deny",
            message: "User rejected request to exit plan mode.",
          };
        }
      }

      if (session.modes.currentModeId === "bypassPermissions") {
        return {
          behavior: "allow",
          updatedInput: toolInput,
          updatedPermissions: suggestions ?? [
            { type: "addRules", rules: [{ toolName }], behavior: "allow", destination: "session" },
          ],
        };
      }

      const response = await this.requestPermissionFromClient(
        {
          options: [
            {
              kind: "allow_always",
              name: alwaysAllowLabel,
              optionId: "allow_always",
            },
            { kind: "allow_once", name: "Allow", optionId: "allow" },
            { kind: "reject_once", name: "Reject", optionId: "reject" },
          ],
          sessionId,
          toolCall: {
            toolCallId: toolUseID,
            rawInput: toolInput,
            ...toolInfoFromToolUse(
              { name: toolName, input: toolInput, id: toolUseID },
              supportsTerminalOutput,
              session?.cwd,
            ),
            // `claudeCode` metas always carry `toolName` (see ToolUpdateMeta),
            // so clients can rely on one shape everywhere.
            ...(parentToolUseId
              ? { _meta: { claudeCode: { toolName, parentToolUseId } } satisfies ToolUpdateMeta }
              : {}),
          },
        },
        toolName,
        signal,
        parentToolUseId,
      );
      if (signal.aborted || response.outcome?.outcome === "cancelled") {
        throw new Error("Tool use aborted");
      }
      if (
        response.outcome?.outcome === "selected" &&
        (response.outcome.optionId === "allow" || response.outcome.optionId === "allow_always")
      ) {
        // If Claude Code has suggestions, it will update their settings already
        if (response.outcome.optionId === "allow_always") {
          return {
            behavior: "allow",
            updatedInput: toolInput,
            updatedPermissions: suggestions ?? [
              {
                type: "addRules",
                rules: [{ toolName }],
                behavior: "allow",
                destination: "session",
              },
            ],
          };
        }
        return {
          behavior: "allow",
          updatedInput: toolInput,
        };
      } else {
        return {
          behavior: "deny",
          message: "User refused permission to run tool",
        };
      }
    };
  }

  /**
   * Handle elicitation requests that originate from MCP servers by forwarding
   * them to the client over ACP. Modes the client did not advertise (or
   * requests we can't represent) are declined.
   */
  private handleMcpElicitation(sessionId: string, support: ElicitationSupport): OnElicitation {
    return async (request, { signal }) => {
      const isUrl = request.mode === "url";
      if ((isUrl && !support.url) || (!isUrl && !support.form)) {
        return { action: "decline" };
      }

      const createRequest = mcpElicitationToCreateRequest(request, sessionId);
      if (!createRequest) {
        return { action: "decline" };
      }

      try {
        const response = await this.client.unstable_createElicitation(createRequest, signal);
        if (signal.aborted) {
          return { action: "cancel" };
        }
        return createElicitationResponseToElicitResult(response);
      } catch (error) {
        // A cancellation we requested (signal aborted) settles as a cancel, not
        // a hard decline — the elicitation was abandoned, not refused.
        if (signal.aborted) {
          return { action: "cancel" };
        }
        this.logger.error(`Failed to forward MCP elicitation: ${error}`);
        return { action: "decline" };
      }
    };
  }

  /**
   * Present the built-in AskUserQuestion tool's questions as an ACP form
   * elicitation and return the answers as the tool's `updatedInput`. Called from
   * `canUseTool` since that is where the SDK routes the tool's permission check.
   */
  private async handleAskUserQuestion(
    sessionId: string,
    toolInput: Record<string, unknown>,
    toolUseID: string,
    signal: AbortSignal,
  ): Promise<PermissionResult> {
    const questions = extractAskUserQuestions(toolInput);
    if (!questions) {
      return { behavior: "deny", message: "AskUserQuestion called with no valid questions." };
    }

    const createRequest = askUserQuestionsToCreateRequest(questions, sessionId, toolUseID);
    let response;
    try {
      response = await this.client.unstable_createElicitation(createRequest, signal);
    } catch (error) {
      // A cancellation we requested (signal aborted) settles as an aborted tool
      // use, matching the post-response check below.
      if (signal.aborted) {
        throw new Error("Tool use aborted", { cause: error });
      }
      this.logger.error(`Failed to present AskUserQuestion elicitation: ${error}`);
      return { behavior: "deny", message: "Could not present the question to the user." };
    }
    if (signal.aborted) {
      throw new Error("Tool use aborted");
    }

    const outcome = applyAskElicitationResponse(response, toolInput, questions);
    if (outcome.action === "cancel") {
      throw new Error("Tool use aborted");
    }
    return { behavior: "allow", updatedInput: outcome.updatedInput };
  }

  /**
   * Handle `request_user_dialog` control requests — blocking dialogs the CLI
   * asks the host to render. Only kinds declared in `supportedDialogKinds`
   * are ever emitted; everything unexpected is answered `cancelled` (the
   * required answer for unrecognized kinds), which applies the dialog's
   * default behavior CLI-side. Today the only declared kind is the
   * refusal-fallback consent prompt, rendered as an ACP form elicitation.
   */
  private handleUserDialog(sessionId: string): OnUserDialog {
    return async (request, { signal }) => {
      if (request.dialogKind !== REFUSAL_FALLBACK_DIALOG_KIND) {
        return { behavior: "cancelled" };
      }
      const prompt = extractRefusalFallbackPrompt(request.payload);
      if (!prompt) {
        this.logger.error(
          `refusal_fallback_prompt payload had an unexpected shape; cancelling the dialog: ${JSON.stringify(request.payload)}`,
        );
        return { behavior: "cancelled" };
      }
      let response: CreateElicitationResponse;
      try {
        response = await this.client.unstable_createElicitation(
          refusalFallbackToCreateRequest(prompt, sessionId),
          signal,
        );
      } catch (error) {
        // A cancellation we requested (signal aborted) is expected teardown;
        // anything else is a client failure. Either way the safe answer is
        // `cancelled` — the CLI applies the dialog's default (keep the
        // refusal) rather than switching models without consent.
        if (!signal.aborted) {
          this.logger.error(`Failed to present refusal fallback elicitation: ${error}`);
        }
        return { behavior: "cancelled" };
      }
      if (signal.aborted) {
        return { behavior: "cancelled" };
      }
      return { behavior: "completed", result: refusalFallbackResultFromResponse(response) };
    };
  }

  private async sendAvailableCommandsUpdate(sessionId: string): Promise<void> {
    const session = this.sessions[sessionId];
    if (!session) return;
    const commands = await session.query.supportedCommands();
    await this.client.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: "available_commands_update",
        availableCommands: getAvailableSlashCommands(commands),
      },
    });
  }

  private async updateConfigOption(
    sessionId: string,
    configId: string,
    value: string,
  ): Promise<void> {
    const session = this.sessions[sessionId];
    if (!session) return;

    await this.applyConfigOptionValue(sessionId, session, configId, value);

    await this.client.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: "config_option_update",
        configOptions: session.configOptions,
      },
    });
  }

  private async applyConfigOptionValue(
    sessionId: string,
    session: Session,
    configId: string,
    value: string,
  ): Promise<void> {
    if (configId === MODE_CONFIG_ID) {
      session.modes = { ...session.modes, currentModeId: value };
      session.configOptions = session.configOptions.map((o) =>
        o.id === configId && typeof o.currentValue === "string" ? { ...o, currentValue: value } : o,
      );
    } else if (configId === MODEL_CONFIG_ID) {
      // `ModelInfo.supportsAutoMode` is the canonical SDK signal for clamping
      // modes below; its `displayName`/`description` also let us infer the
      // context window for semantic aliases (e.g. `default`) whose ID alone
      // carries no "1m" token.
      const newModelInfo = session.modelInfos.find((m) => m.value === value);
      if (session.models.currentModelId !== value) {
        // The cached context window was learned for the previous model. The
        // SDK is already running the new model here (user-driven switches call
        // `query.setModel` before this, and the refusal-fallback sync only
        // reconciles a switch the SDK already made), so ask it for the new
        // window; fall back to the text heuristic so mid-stream updates
        // between now and the next `result` reflect the user's selection
        // instead of the old model's window.
        session.contextWindowSize =
          (await fetchContextWindowSize(session.query, this.logger)) ??
          inferContextWindowFromModel(
            value,
            newModelInfo?.resolvedModel,
            newModelInfo?.displayName,
            newModelInfo?.description,
          ) ??
          DEFAULT_CONTEXT_WINDOW;
      }
      session.models = { ...session.models, currentModelId: value };

      // Recompute availableModes for the new model and clamp the current
      // mode if the SDK no longer offers it (today: "auto" on Haiku). An
      // unknown model (an SDK-initiated refusal fallback to a model outside
      // the user's `availableModels` allowlist — user-driven switches are
      // validated against the options first) tells us nothing about its
      // capabilities, so keep the current modes rather than spuriously
      // downgrading (e.g. kicking the user out of "auto" for a model that
      // does support it).
      const newAvailableModes = newModelInfo
        ? buildAvailableModes(newModelInfo)
        : session.modes.availableModes;
      // Capture BEFORE mutating session.modes so the log message reflects
      // the invalidated mode rather than "default".
      const previousModeId = session.modes.currentModeId;
      let modeDowngraded = false;
      if (!newAvailableModes.some((m) => m.id === previousModeId)) {
        session.modes = {
          availableModes: newAvailableModes,
          currentModeId: "default",
        };
        try {
          await session.query.setPermissionMode("default");
        } catch (err) {
          // Failing the entire model switch over a bookkeeping sync error is
          // worse UX than logging and continuing; the user explicitly asked
          // to change models. The next setPermissionMode from the user will
          // either succeed or surface a fresh error.
          this.logger.error(
            `Failed to sync permissionMode to "default" after model switch invalidated "${previousModeId}":`,
            err,
          );
        }
        modeDowngraded = true;
      } else {
        session.modes = { ...session.modes, availableModes: newAvailableModes };
      }

      // Rebuild config options since effort levels depend on the selected model
      const effortOpt = session.configOptions.find((o) => o.id === EFFORT_CONFIG_ID);
      const currentEffort =
        typeof effortOpt?.currentValue === "string" ? effortOpt.currentValue : undefined;
      session.configOptions = buildConfigOptions(
        session.modes,
        session.models,
        session.modelInfos,
        currentEffort,
        session.agents,
        session.currentAgent,
        {
          // The toggle follows the newly selected model: it disappears when the
          // model lacks fast support and reappears (with the retained user
          // intent) when a supporting model is selected again.
          supported: newModelInfo?.supportsFastMode ?? false,
          enabled: session.fastModeEnabled,
          useBooleanOption: clientSupportsBooleanConfigOptions(this.clientCapabilities),
        },
      );

      // Sync effort with the SDK if it changed after the model switch
      const newEffortOpt = session.configOptions.find((o) => o.id === EFFORT_CONFIG_ID);
      const newEffort =
        typeof newEffortOpt?.currentValue === "string" ? newEffortOpt.currentValue : undefined;
      if (newEffort !== currentEffort) {
        await session.query.applyFlagSettings({
          effortLevel: toSdkEffortLevel(newEffort),
        });
      }

      // Emit current_mode_update only after session.modes AND
      // session.configOptions have been fully reconciled. This way, a failure
      // in the configOptions/effort rebuild above can't leave the client with
      // a clamped currentModeId but stale configOptions, and the notification
      // still precedes the caller's config_option_update so order-sensitive
      // clients update currentModeId before re-rendering the option list.
      if (modeDowngraded) {
        await this.client.sessionUpdate({
          sessionId,
          update: {
            sessionUpdate: "current_mode_update",
            currentModeId: "default",
          },
        });
      }
    } else if (configId === AGENT_CONFIG_ID) {
      // Live agent switch — no subprocess restart needed. Apply the SDK flag
      // first so a rejected control request leaves both `currentAgent` and the
      // config option untouched (no UI/SDK desync). Passing `null` clears the
      // flag layer back to the standard Claude Code agent; the change takes
      // effect on the next turn (SDK >= 0.3.161).
      await session.query.applyFlagSettings({
        agent: value === DEFAULT_AGENT_ID ? null : value,
      });
      session.currentAgent = value;
      session.configOptions = session.configOptions.map((o) =>
        o.id === configId && typeof o.currentValue === "string" ? { ...o, currentValue: value } : o,
      );
    } else {
      session.configOptions = session.configOptions.map((o) =>
        o.id === configId && typeof o.currentValue === "string" ? { ...o, currentValue: value } : o,
      );
      if (configId === EFFORT_CONFIG_ID) {
        await session.query.applyFlagSettings({
          effortLevel: toSdkEffortLevel(value),
        });
      }
    }
  }

  /** Reconcile adapter model state after the SDK persistently swapped the
   *  session's model out from under us (refusal fallback). The SDK already
   *  made the switch, so this must NOT call `query.setModel` — it only
   *  updates our bookkeeping (currentModelId, context window, mode clamping,
   *  effort/Fast-mode options) via the same `applyConfigOptionValue` path a
   *  user-driven model change takes, then notifies the client. */
  private async syncModelAfterRefusalFallback(
    sessionId: string,
    session: Session,
    fallbackModel: string,
  ): Promise<void> {
    // Map the SDK-reported model onto one of the session's model options
    // (handles display names and `resolvedModel` ids). The fallback model may
    // not be among the options — e.g. excluded by the user's
    // `availableModels` allowlist — in which case we track the raw id: the
    // picker shows no selection, but the model-dependent bookkeeping and any
    // later `setModel` round-trip stay truthful to what the SDK is running.
    const resolved = resolveModelPreference(session.modelInfos, fallbackModel);
    const value = resolved?.value ?? fallbackModel;
    if (session.models.currentModelId === value) return;

    try {
      await this.updateConfigOption(sessionId, MODEL_CONFIG_ID, value);
    } catch (err) {
      // This runs on the consumer loop: a throw here tears down the query
      // stream (failAllTurns + closeQueryStream) and bricks the session —
      // far worse than stale bookkeeping. The user-driven RPC path lets the
      // same errors propagate to fail just that request; here we log and
      // move on, matching the setPermissionMode containment inside
      // applyConfigOptionValue.
      this.logger.error(
        `Failed to reconcile model state after refusal fallback to "${fallbackModel}":`,
        err,
      );
    }
  }

  /** Replace the Fast mode option in `session.configOptions` so it reflects
   *  `enabled` (and the client's current boolean-capability). A no-op when the
   *  option isn't present, so callers must confirm the current model surfaces
   *  it first. */
  private refreshFastModeOption(session: Session, enabled: boolean): void {
    const refreshed = createFastModeConfigOption(
      enabled,
      clientSupportsBooleanConfigOptions(this.clientCapabilities),
    );
    session.configOptions = session.configOptions.map((o) =>
      o.id === FAST_MODE_CONFIG_ID ? refreshed : o,
    );
  }

  /** Toggle Fast mode for a session: push the SDK flag, record the user's
   *  intent, and refresh the Fast mode config option in place. Only reached
   *  once the option exists (i.e. the current model supports fast mode), so the
   *  option is guaranteed to be present in `configOptions`. */
  private async applyFastMode(session: Session, enabled: boolean): Promise<void> {
    // Apply the SDK flag first so a rejected control request leaves both the
    // session state and the config option untouched (no UI/SDK desync).
    await session.query.applyFlagSettings({ fastMode: enabled });
    session.fastModeEnabled = enabled;
    this.refreshFastModeOption(session, enabled);
  }

  /** Reconcile the session's Fast mode toggle with an SDK-reported
   *  `fast_mode_state` (delivered on `system`/init and on user-turn `result`s).
   *  The SDK can flip fast mode independently of the user — e.g. back to `on`
   *  once a rate-limit `cooldown` clears — so we mirror definitive on/off
   *  changes into the config option and notify the client.
   *
   *  Guards, in order:
   *   - absent state: nothing to reconcile.
   *   - no Fast mode option: the current model doesn't support fast mode, so the
   *     reported state reflects capability, not the user's intent. Leave the
   *     retained setting untouched so it's correct when a supporting model is
   *     reselected (the source of the earlier intent-clobber bug was mutating it
   *     here).
   *   - `cooldown`: a transient suspension of an already-enabled fast mode.
   *     Leave the toggle as-is rather than flapping it — and never let a stray
   *     cooldown spuriously enable a toggle the user has off. */
  private async syncFastModeState(
    sessionId: string,
    session: Session,
    state: FastModeState | undefined,
  ): Promise<void> {
    if (state === undefined) {
      return;
    }
    if (!session.configOptions.some((o) => o.id === FAST_MODE_CONFIG_ID)) {
      return;
    }
    if (state === "cooldown") {
      return;
    }
    const enabled = state === "on";
    if (enabled === session.fastModeEnabled) {
      return;
    }
    session.fastModeEnabled = enabled;
    this.refreshFastModeOption(session, enabled);
    await this.client.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: "config_option_update",
        configOptions: session.configOptions,
      },
    });
  }

  private async getOrCreateSession(params: {
    sessionId: string;
    cwd: string;
    mcpServers?: NewSessionRequest["mcpServers"];
    additionalDirectories?: NewSessionRequest["additionalDirectories"];
    _meta?: NewSessionRequest["_meta"];
  }): Promise<NewSessionResponse> {
    const existingSession = this.sessions[params.sessionId];
    if (existingSession) {
      const fingerprint = computeSessionFingerprint(params);
      if (fingerprint === existingSession.sessionFingerprint) {
        return {
          sessionId: params.sessionId,
          modes: existingSession.modes,
          configOptions: existingSession.configOptions,
        };
      }

      // Session-defining params changed (e.g. cwd pointed at a git worktree,
      // or MCP servers reconfigured). Tear down the existing session and
      // recreate it so the underlying Query process picks up the new values.
      await this.teardownSession(params.sessionId);
    }

    const response = await this.createSession(
      {
        cwd: params.cwd,
        mcpServers: params.mcpServers ?? [],
        additionalDirectories: params.additionalDirectories,
        _meta: params._meta,
      },
      {
        resume: params.sessionId,
      },
    );

    return {
      sessionId: response.sessionId,
      modes: response.modes,
      configOptions: response.configOptions,
    };
  }

  /**
   * Ensures the requested `cwd` is an absolute path that points at an existing
   * directory before we create a session. Throws an `invalidParams` error with
   * an actionable message so clients (e.g. Zed) can surface it to the user
   * instead of failing later with an opaque SDK error.
   */
  private async validateCwd(cwd: string): Promise<void> {
    if (!path.isAbsolute(cwd)) {
      throw RequestError.invalidParams(
        { cwd },
        `\`cwd\` must be an absolute path, but received: ${cwd}`,
      );
    }

    let stats: Stats;
    try {
      stats = await fs.stat(cwd);
    } catch {
      throw RequestError.invalidParams(
        { cwd },
        `\`cwd\` does not exist on the machine running the agent: ${cwd}`,
      );
    }

    if (!stats.isDirectory()) {
      throw RequestError.invalidParams({ cwd }, `\`cwd\` is not a directory: ${cwd}`);
    }
  }

  private async createSession(
    params: NewSessionRequest,
    creationOpts: { resume?: string; forkSession?: boolean } = {},
  ): Promise<NewSessionResponse> {
    // Validate `cwd` up front. The ACP spec requires an absolute path, and the
    // directory must actually exist on the machine running the agent. Without
    // this check a session is created against a missing directory and the
    // failure only surfaces later as a confusing "native binary failed to
    // launch" error from the SDK (see issue #749).
    await this.validateCwd(params.cwd);

    // We want to create a new session id unless it is resume,
    // but not resume + forkSession.
    let sessionId;
    if (creationOpts.forkSession) {
      sessionId = randomUUID();
    } else if (creationOpts.resume) {
      sessionId = creationOpts.resume;
    } else {
      sessionId = randomUUID();
    }

    const input = new Pushable<SDKUserMessage>();

    const settingsManager = new SettingsManager(params.cwd, {
      logger: this.logger,
    });
    await settingsManager.initialize();

    const mcpServers: Record<string, McpServerConfig> = {};
    if (Array.isArray(params.mcpServers)) {
      for (const server of params.mcpServers) {
        if ("type" in server && (server.type === "http" || server.type === "sse")) {
          // HTTP or SSE type MCP server
          mcpServers[server.name] = {
            type: server.type,
            url: server.url,
            headers: server.headers
              ? Object.fromEntries(server.headers.map((e) => [e.name, e.value]))
              : undefined,
          };
        } else if (!("type" in server)) {
          // Stdio type MCP server (with or without explicit type field)
          mcpServers[server.name] = {
            type: "stdio",
            command: server.command,
            args: server.args,
            env: server.env
              ? Object.fromEntries(server.env.map((e) => [e.name, e.value]))
              : undefined,
          };
        }
      }
    }

    let systemPrompt: Options["systemPrompt"] = { type: "preset", preset: "claude_code" };
    if (params._meta?.systemPrompt) {
      const customPrompt = params._meta.systemPrompt;
      if (typeof customPrompt === "string") {
        systemPrompt = customPrompt;
      } else if (
        typeof customPrompt === "object" &&
        customPrompt !== null &&
        !Array.isArray(customPrompt)
      ) {
        // Forward all preset options (append, excludeDynamicSections, and
        // anything the SDK adds later) while locking type/preset.
        systemPrompt = {
          ...(customPrompt as object),
          type: "preset",
          preset: "claude_code",
        } as Options["systemPrompt"];
      }
    }

    const permissionMode = resolvePermissionMode(
      settingsManager.getSettings().permissions?.defaultMode,
      this.logger,
    );

    // Extract options from _meta if provided
    const sessionMeta = params._meta as NewSessionMeta | undefined;
    const userProvidedOptions = sessionMeta?.claudeCode?.options;

    // Configure thinking behavior from environment variable
    const thinking = resolveThinkingConfig(process.env.MAX_THINKING_TOKENS, this.logger);

    // Parse model configuration from environment (e.g. Bedrock model overrides)
    const modelConfig = parseModelConfig(process.env.CLAUDE_MODEL_CONFIG);

    // Elicitation modes the connected client advertised. We only forward
    // elicitations (and only re-enable AskUserQuestion) for modes the client
    // can actually render.
    const elicitationSupport: ElicitationSupport = {
      form: !!this.clientCapabilities?.elicitation?.form,
      url: !!this.clientCapabilities?.elicitation?.url,
    };

    // AskUserQuestion surfaces as a `permission_ask_user_question` dialog that
    // we render as a form elicitation. Without form-elicitation support there
    // is no way to present it over ACP, so keep it disabled in that case.
    const disallowedTools = elicitationSupport.form ? [] : ["AskUserQuestion"];

    // Resolve which built-in tools to expose.
    // Explicit tools array from _meta.claudeCode.options takes precedence.
    // disableBuiltInTools is a legacy shorthand for tools: [] — kept for
    // backward compatibility but callers should prefer the tools array.
    const tools: Options["tools"] =
      userProvidedOptions?.tools ??
      (params._meta?.disableBuiltInTools === true ? [] : { type: "preset", preset: "claude_code" });

    const abortController = userProvidedOptions?.abortController || new AbortController();

    // Per-session task state. Created here (rather than in the session record
    // below) so the TaskCreated/TaskCompleted hook callbacks can close over
    // the same Map that the streaming message handler will read from.
    const taskState: TaskState = new Map();

    const options: Options = {
      systemPrompt,
      settingSources: ["user", "project", "local"],
      ...(thinking !== undefined && { thinking }),
      ...userProvidedOptions,
      // CLAUDE_MODEL_CONFIG env var is a fallback for model
      // configuration (e.g. Bedrock model ID overrides). When the caller
      // provides settings via _meta, we intentionally ignore the env var —
      // the caller is assumed to have full control over model configuration.
      ...(!userProvidedOptions?.settings &&
        modelConfig && {
          settings: {
            ...(modelConfig.modelOverrides && { modelOverrides: modelConfig.modelOverrides }),
            ...(modelConfig.availableModels && { availableModels: modelConfig.availableModels }),
          },
        }),
      env: {
        ...process.env,
        ...userProvidedOptions?.env,
        ...createEnvForGateway(this.gatewayAuthRequest),
        // Opt-in to session state events like when the agent is idle
        CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: "1",
      },
      // Override certain fields that must be controlled by ACP
      cwd: params.cwd,
      includePartialMessages: true,
      mcpServers: { ...(userProvidedOptions?.mcpServers || {}), ...mcpServers },
      // If we want bypassPermissions to be an option, we have to allow it here.
      // But it doesn't work in root mode, so we only activate it if it will work.
      allowDangerouslySkipPermissions: ALLOW_BYPASS,
      permissionMode,
      canUseTool: this.canUseTool(sessionId),
      // Forward MCP elicitation requests onto ACP elicitation. Only attached
      // when the client advertised support, so non-supporting clients keep the
      // SDK's default (auto-decline) behavior. (AskUserQuestion is handled in
      // canUseTool, not here.)
      ...(elicitationSupport.form || elicitationSupport.url
        ? { onElicitation: this.handleMcpElicitation(sessionId, elicitationSupport) }
        : {}),
      // Render the CLI's refusal-fallback consent prompt ("<model> declined —
      // retry with <fallback>?") as an ACP form elicitation. Declaring the
      // kind is the opt-in: the CLI never emits an undeclared dialog, and the
      // flow instead degrades to the classic refusal error ending the turn.
      // Gated on form elicitation since that's the only ACP surface that can
      // present a choice outside a tool call.
      ...(elicitationSupport.form
        ? {
            onUserDialog: this.handleUserDialog(sessionId),
            supportedDialogKinds: [REFUSAL_FALLBACK_DIALOG_KIND],
          }
        : {}),
      pathToClaudeCodeExecutable: process.env.CLAUDE_CODE_EXECUTABLE ?? (await claudeCliPath()),
      extraArgs: {
        ...userProvidedOptions?.extraArgs,
        "replay-user-messages": "",
      },
      disallowedTools: [...(userProvidedOptions?.disallowedTools || []), ...disallowedTools],
      tools,
      hooks: {
        ...userProvidedOptions?.hooks,
        PostToolUse: [
          ...(userProvidedOptions?.hooks?.PostToolUse || []),
          {
            hooks: [
              createPostToolUseHook(this.logger, {
                onEnterPlanMode: async () => {
                  await this.client.sessionUpdate({
                    sessionId,
                    update: {
                      sessionUpdate: "current_mode_update",
                      currentModeId: "plan",
                    },
                  });
                  await this.updateConfigOption(sessionId, MODE_CONFIG_ID, "plan");
                },
              }),
            ],
          },
        ],
        TaskCreated: [
          ...(userProvidedOptions?.hooks?.TaskCreated || []),
          {
            hooks: [
              createTaskHook({
                taskState,
                onChange: async () => {
                  await this.client.sessionUpdate({
                    sessionId,
                    update: {
                      sessionUpdate: "plan",
                      entries: taskStateToPlanEntries(taskState),
                    },
                  });
                },
              }),
            ],
          },
        ],
        TaskCompleted: [
          ...(userProvidedOptions?.hooks?.TaskCompleted || []),
          {
            hooks: [
              createTaskHook({
                taskState,
                onChange: async () => {
                  await this.client.sessionUpdate({
                    sessionId,
                    update: {
                      sessionUpdate: "plan",
                      entries: taskStateToPlanEntries(taskState),
                    },
                  });
                },
              }),
            ],
          },
        ],
      },
      ...creationOpts,
      abortController,
    };

    // Prefer the official ACP `additionalDirectories` field. Fall back to the
    // legacy `_meta.additionalRoots` extension for clients that haven't been
    // updated yet. Either source is merged with directories supplied via
    // `_meta.claudeCode.options.additionalDirectories` (SDK pass-through).
    const acpAdditionalDirectories =
      params.additionalDirectories ?? sessionMeta?.additionalRoots ?? [];
    options.additionalDirectories = [
      ...(userProvidedOptions?.additionalDirectories ?? []),
      ...acpAdditionalDirectories,
    ];

    if (creationOpts?.resume === undefined || creationOpts?.forkSession) {
      // Set our own session id if not resuming an existing session.
      options.sessionId = sessionId;
    }

    // Handle abort controller from meta options
    if (abortController?.signal.aborted) {
      throw new Error("Cancelled");
    }

    const q = query({
      prompt: input,
      options,
    });

    let initializationResult;
    try {
      initializationResult = await q.initializationResult();
    } catch (error) {
      if (
        creationOpts.resume &&
        error instanceof Error &&
        (error.message === "Query closed before response received" ||
          error.message.includes("No conversation found with session ID"))
      ) {
        throw RequestError.resourceNotFound(sessionId);
      }
      throw error;
    }

    if (
      shouldHideClaudeAuth() &&
      initializationResult.account.subscriptionType &&
      !this.gatewayAuthRequest
    ) {
      throw RequestError.authRequired(
        undefined,
        "This integration does not support using claude.ai subscriptions.",
      );
    }

    // Apply user's `availableModels` allowlist from settings.json before any
    // downstream model handling. The SDK only enforces this allowlist in its
    // own UI, not in `initializationResult.models`, so we filter here to keep
    // configOptions, the current-model resolver, and the stored modelInfos
    // consistent with what the user configured.
    const settingsAvailableModels = settingsManager.getSettings().availableModels;
    const settingsModelOverrides = settingsManager.getSettings().modelOverrides;
    const allowedModels = Array.isArray(settingsAvailableModels)
      ? applyAvailableModelsAllowlist(
          initializationResult.models,
          settingsAvailableModels,
          settingsModelOverrides,
        )
      : initializationResult.models;

    const models = await getAvailableModels(
      q,
      allowedModels,
      initializationResult.models,
      settingsManager,
      this.logger,
      creationOpts.resume !== undefined,
    );

    // Gate `auto` (and future model-specific modes) on the resolved model's
    // `ModelInfo`. See `buildAvailableModes` for the canonical SDK signal.
    // A resumed session can be running a model outside the `availableModels`
    // allowlist (currentModelId is then the verbatim live id, see
    // `matchResumedModel`); its capabilities are still known to the SDK's
    // unfiltered list, so fall back to that before treating the model as
    // unknown — otherwise auto mode would be spuriously clamped and the
    // Fast-mode/Effort options hidden for a model that supports them.
    const allowlistedModelInfo = allowedModels.find((m) => m.value === models.currentModelId);
    const fallbackModelInfo = allowlistedModelInfo
      ? undefined
      : (resolveModelPreference(initializationResult.models, models.currentModelId) ?? undefined);
    const currentModelInfo = allowlistedModelInfo ?? fallbackModelInfo;
    // Register the fallback-resolved capabilities under the verbatim live id
    // so every modelInfos consumer (buildConfigOptions' effort lookup, later
    // rebuilds via session.modelInfos) agrees with the gating below. The
    // picker options themselves come from `models.availableModels`, so this
    // adds no selectable entry. The spread keeps every capability flag
    // (current and future); the identity fields are overridden because the
    // fuzzy-matched sibling's resolvedModel/displayName/description can
    // describe a different context lane and would poison later resolvedModel
    // matching (syncModelAfterRefusalFallback) and context-window inference
    // (applyConfigOptionValue) if they traveled under this id.
    const modelInfos = fallbackModelInfo
      ? [
          ...allowedModels,
          {
            ...fallbackModelInfo,
            value: models.currentModelId,
            displayName: models.currentModelId,
            description: "",
            resolvedModel: undefined,
          },
        ]
      : allowedModels;
    const availableModes = buildAvailableModes(currentModelInfo);

    // Clamp `permissionMode` if the resolved session does not offer it. The
    // common case is `permissions.defaultMode: "auto"` resolving to a model
    // that does not support auto mode (e.g. Haiku); without this clamp the
    // SDK would later throw `"auto mode unavailable for this model"` from
    // `setPermissionMode`. Keep `permissionMode` as the resolved user intent
    // (matches what was passed into `options.permissionMode` above) and use
    // `effectiveMode` for the post-clamp value the session actually runs in.
    let effectiveMode: PermissionMode = permissionMode;
    if (!availableModes.some((m) => m.id === effectiveMode)) {
      if (effectiveMode === "auto") {
        this.logger.error(
          `permissions.defaultMode "auto" is not available for model ` +
            `"${models.currentModelId}"; falling back to "default".`,
        );
      } else {
        this.logger.error(
          `permissions.defaultMode "${effectiveMode}" is not available in ` +
            `this session; falling back to "default".`,
        );
      }
      effectiveMode = "default";
      // Sync the SDK so it doesn't keep "auto" cached internally. Wrapped in
      // try/catch since failing here would abort session creation entirely.
      try {
        await q.setPermissionMode("default");
      } catch (err) {
        this.logger.error("Failed to sync clamped permissionMode to SDK:", err);
      }
    }

    const modes = {
      currentModeId: effectiveMode,
      availableModes,
    };

    const agents = await discoverCustomAgents(q);
    // Only adopt the requested agent as the selected value if it's one we
    // actually surface in the picker. A built-in (filtered out above) or
    // otherwise-unknown name would leave the config option's `currentValue`
    // pointing at an entry not in its own `options` list, which clients render
    // as a blank/invalid selection.
    const requestedAgent = userProvidedOptions?.agent;
    const currentAgent =
      requestedAgent && agents.some((a) => a.name === requestedAgent)
        ? requestedAgent
        : DEFAULT_AGENT_ID;

    // Seed Fast mode from the SDK's reported state so the UI reflects reality
    // (the CLI may start a session with fast mode already on, or force it off
    // when `fastModePerSessionOptIn` is set). The toggle is only surfaced while
    // the resolved model advertises `supportsFastMode`.
    const fastModeEnabled =
      initializationResult.fast_mode_state !== undefined &&
      fastModeStateEnabled(initializationResult.fast_mode_state);
    const fastMode: FastModeOptionState = {
      supported: currentModelInfo?.supportsFastMode ?? false,
      enabled: fastModeEnabled,
      useBooleanOption: clientSupportsBooleanConfigOptions(this.clientCapabilities),
    };

    const configOptions = buildConfigOptions(
      modes,
      models,
      modelInfos,
      settingsManager.getSettings().effortLevel,
      agents,
      currentAgent,
      fastMode,
    );

    // Apply the initial effort level to the SDK so it matches the UI default
    const initialEffort = configOptions.find((o) => o.id === EFFORT_CONFIG_ID);
    if (
      initialEffort &&
      typeof initialEffort.currentValue === "string" &&
      initialEffort.currentValue !== "default"
    ) {
      await q.applyFlagSettings({
        effortLevel: initialEffort.currentValue as Settings["effortLevel"],
      });
    }
    // Seed the context window from the SDK's authoritative report. Text
    // inference alone misses aliases that resolve to extended-context models
    // with no "1m" token anywhere in their id or description (e.g. `sonnet` →
    // claude-sonnet-5, natively ~1M): those streamed `usage_update.size:
    // 200000` until the first result's modelUsage corrected it — again on
    // every process restart or session re-creation, since the learned window
    // lives only on the Session (issue #596).
    //
    // The inference fallback is deliberately keyed to the allowlisted entry: a
    // fallback-resolved sibling's resolvedModel/displayName/description can
    // describe a different context lane than the verbatim live id (e.g. an
    // "opus[1m]" row matched for a bare 200k id), so on the fallback path only
    // the id itself is a trustworthy window signal.
    const contextWindowSize =
      (await fetchContextWindowSize(q, this.logger)) ??
      inferContextWindowFromModel(
        models.currentModelId,
        allowlistedModelInfo?.resolvedModel,
        allowlistedModelInfo?.displayName,
        allowlistedModelInfo?.description,
      ) ??
      DEFAULT_CONTEXT_WINDOW;

    this.sessions[sessionId] = {
      query: q,
      input: input,
      cancelled: false,
      cwd: params.cwd,
      sessionFingerprint: computeSessionFingerprint(params),
      settingsManager,
      accumulatedUsage: {
        inputTokens: 0,
        outputTokens: 0,
        cachedReadTokens: 0,
        cachedWriteTokens: 0,
      },
      modes,
      models,
      modelInfos,
      configOptions,
      agents,
      currentAgent,
      fastModeEnabled,
      abortController,
      emitRawSDKMessages: sessionMeta?.claudeCode?.emitRawSDKMessages ?? false,
      contextWindowSize,
      taskState,
      toolUseCache: {},
      emittedToolCalls: new Set(),
      liveBackgroundTasks: new Map(),
      emittedAssistantText: false,
      owedTrailingIdles: 0,
      messageIdToUuid: new Map(),
    };

    return {
      sessionId,
      modes,
      configOptions,
    };
  }
}

function shouldEmitRawMessage(
  config: boolean | SDKMessageFilter[],
  message: { type: string; subtype?: string; origin?: SDKMessageOrigin },
): boolean {
  if (config === true) return true;
  if (config === false) return false;
  return config.some(
    (f) =>
      f.type === message.type &&
      (f.subtype === undefined || f.subtype === message.subtype) &&
      (f.origin === undefined || f.origin === message.origin?.kind),
  );
}

function sessionUsage(session: Session) {
  return {
    inputTokens: session.accumulatedUsage.inputTokens,
    outputTokens: session.accumulatedUsage.outputTokens,
    cachedReadTokens: session.accumulatedUsage.cachedReadTokens,
    cachedWriteTokens: session.accumulatedUsage.cachedWriteTokens,
    totalTokens:
      session.accumulatedUsage.inputTokens +
      session.accumulatedUsage.outputTokens +
      session.accumulatedUsage.cachedReadTokens +
      session.accumulatedUsage.cachedWriteTokens,
  };
}

/** Sum all four fields as a proxy for post-turn context occupancy: the current
 *  turn's output becomes next turn's input. Per the Anthropic API, input_tokens
 *  excludes cache tokens — cache_read and cache_creation are reported
 *  separately — so summing all four is not double-counting. */
function totalTokens(usage: UsageSnapshot): number {
  return (
    usage.input_tokens +
    usage.output_tokens +
    usage.cache_read_input_tokens +
    usage.cache_creation_input_tokens
  );
}

/** Error kinds this adapter invents itself, alongside the SDK's categorical
 *  `SDKAssistantMessageError` kinds: `no_result` marks a turn the SDK declared
 *  over without ever emitting its result (issue #825). */
type AgentErrorKind = SDKAssistantMessageError | "no_result";

/**
 * Build the `data` payload attached to a `RequestError.internalError` when we
 * have a categorical error — from the Claude SDK, or one of the adapter's own
 * kinds. Returns `undefined` when no categorical error is available, matching
 * the previous behavior of passing `undefined` to `RequestError.internalError`.
 *
 * The `errorKind` field is a convention for ACP clients to dispatch on
 * without having to pattern-match the human-readable message text. Clients
 * that don't understand it fall back to the existing message-based rendering.
 */
function errorKindData(
  errorKind: AgentErrorKind | undefined,
): { errorKind: AgentErrorKind } | undefined {
  return errorKind ? { errorKind } : undefined;
}

/** Project a nullable API usage object into our non-null snapshot shape.
 *  Both SDK message_start and assistant message `usage` have `number | null`
 *  cache fields; we coerce absent values to 0 so `totalTokens` never hits
 *  NaN. `input_tokens`/`output_tokens` are typed `number` by the SDK but
 *  synthetic or third-party-backend stream events have been observed emitting
 *  them as null/undefined — coerce those too so a malformed upstream event
 *  can't leak NaN into the wire `used` field. Delta events have different
 *  semantics (cumulative + prev fallback) and are handled inline. */
function snapshotFromUsage(usage: {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}): UsageSnapshot {
  return {
    input_tokens: usage.input_tokens ?? 0,
    output_tokens: usage.output_tokens ?? 0,
    cache_read_input_tokens: usage.cache_read_input_tokens ?? 0,
    cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
  };
}

function createEnvForGateway(request?: GatewayAuthRequest) {
  if (!request?._meta) {
    return {};
  }
  const customHeaders = Object.entries(request._meta.gateway.headers)
    .map(([key, value]) => `${key}: ${value}`)
    .join("\n");

  if (request.methodId === "gateway-bedrock") {
    return {
      CLAUDE_CODE_USE_BEDROCK: "1",
      AWS_BEARER_TOKEN_BEDROCK: " ", // Must be non-empty to bypass pass configuration check
      ANTHROPIC_BEDROCK_BASE_URL: request._meta.gateway.baseUrl,
      ANTHROPIC_CUSTOM_HEADERS: customHeaders,
    };
  }
  return {
    ANTHROPIC_BASE_URL: request._meta.gateway.baseUrl,
    ANTHROPIC_CUSTOM_HEADERS: customHeaders,
    ANTHROPIC_AUTH_TOKEN: " ", // Must be specified to bypass claude login requirement
  };
}

/**
 * Build the list of permission modes the agent will advertise for the given
 * model. `auto` is gated by `ModelInfo.supportsAutoMode === true`, which is
 * the SDK's model-level availability signal. `undefined`/`false` both exclude
 * `auto`. `bypassPermissions` is still gated by `ALLOW_BYPASS`.
 */
function buildAvailableModes(modelInfo: ModelInfo | undefined): SessionModeState["availableModes"] {
  const modes: SessionModeState["availableModes"] = [];

  // Only advertise "auto" when the SDK reports the model supports it.
  if (modelInfo?.supportsAutoMode === true) {
    modes.push({
      id: "auto",
      name: "Auto",
      description: "Use a model classifier to approve/deny permission prompts",
    });
  }

  modes.push(
    {
      // Claude Code 2.1.200 renamed this mode to "Manual" across its surfaces;
      // the wire id stays "default" ("manual" is only an accepted input alias).
      id: "default",
      name: "Manual",
      description: "Standard behavior, prompts for dangerous operations",
    },
    {
      id: "acceptEdits",
      name: "Accept Edits",
      description: "Auto-accept file edit operations",
    },
    {
      id: "plan",
      name: "Plan Mode",
      description: "Planning mode, no actual tool execution",
    },
    {
      id: "dontAsk",
      name: "Don't Ask",
      description: "Don't prompt for permissions, deny if not pre-approved",
    },
  );

  if (ALLOW_BYPASS) {
    modes.push({
      id: "bypassPermissions",
      name: "Bypass Permissions",
      description: "Bypass all permission checks",
    });
  }

  return modes;
}

// Translate a UI effort value into the flag-layer payload. The SDK
// shallow-merges `applyFlagSettings`, drops `undefined` during JSON transport,
// and only clears a key when an explicit `null` is sent — see
// `applyFlagSettings` in @anthropic-ai/claude-agent-sdk. Mapping both the
// `"default"` sentinel and `undefined` (effort option absent for the model) to
// `null` ensures any previously-applied flag is actually cleared.
function toSdkEffortLevel(value: string | undefined): Settings["effortLevel"] | null {
  return value === undefined || value === "default" ? null : (value as Settings["effortLevel"]);
}

// `supportedAgents()` always returns Claude Code's built-in subagents — the
// ones used for Task-tool delegation (Explore, Plan, etc.) — even when the user
// has configured none of their own. Those aren't meaningful *main-thread*
// personas, so we filter them out and only surface the Agent picker when the
// user (or a plugin/project) has configured custom agents. Update this set if
// the SDK's built-in roster changes.
export const BUILTIN_AGENT_NAMES = new Set([
  "claude",
  "general-purpose",
  "Explore",
  "Plan",
  "statusline-setup",
]);

// Value of the synthetic "Default" entry in the agent picker, which maps to the
// standard Claude Code agent (`applyFlagSettings({ agent: null })`). It is a
// reserved sentinel: a custom agent named exactly this would collide with it
// (two options sharing the value, selection silently routing to `null`), so we
// exclude that name from discovery.
export const DEFAULT_AGENT_ID = "default";

/** Discover user/plugin/project-configured main-thread agents, excluding the
 *  built-in subagents and the reserved "default" sentinel. Returns an empty
 *  list if discovery fails so a flaky control request never blocks session
 *  creation. */
export async function discoverCustomAgents(q: Query): Promise<AgentInfo[]> {
  try {
    const agents = await q.supportedAgents();
    return agents.filter((a) => !BUILTIN_AGENT_NAMES.has(a.name) && a.name !== DEFAULT_AGENT_ID);
  } catch {
    return [];
  }
}

/** Stable ids for the session config options surfaced via `configOptions`.
 *  Centralized so the option declarations in `buildConfigOptions` and the
 *  handlers in `setSessionConfigOption`/`applyConfigOptionValue` reference the
 *  same identifiers and can't drift apart. */
export const MODE_CONFIG_ID = "mode";
export const MODEL_CONFIG_ID = "model";
export const EFFORT_CONFIG_ID = "effort";
export const AGENT_CONFIG_ID = "agent";
export const FAST_MODE_CONFIG_ID = "fast";

/** Select-fallback values used when the client has not opted into boolean
 *  config options (see {@link createFastModeConfigOption}). */
export const FAST_MODE_ON = "on";
export const FAST_MODE_OFF = "off";
const FAST_MODE_DESCRIPTION = "Faster responses on supported models";

/** Map the SDK's tri-state `fast_mode_state` onto the boolean config toggle.
 *  `cooldown` (fast mode temporarily suspended after a rate limit, per the SDK
 *  docs) keeps the toggle on so it reflects the user's intent — only an
 *  explicit `off` clears it. */
export function fastModeStateEnabled(state: FastModeState): boolean {
  return state !== "off";
}

/** Whether the Client advertised support for boolean session config options
 *  (`session.configOptions.boolean`). Agents MUST only send `type: "boolean"`
 *  config options to Clients that opt in; otherwise we fall back to a `select`.
 *  See https://agentclientprotocol.com/rfds/boolean-config-option. */
export function clientSupportsBooleanConfigOptions(
  clientCapabilities?: ClientCapabilities | null,
): boolean {
  return clientCapabilities?.session?.configOptions?.boolean != null;
}

/** Build the Fast mode config option. When the Client supports boolean config
 *  options we expose a native `type: "boolean"` toggle; otherwise we degrade to
 *  a two-value `select` ("on"/"off") so older Clients still get a usable
 *  control. */
export function createFastModeConfigOption(
  enabled: boolean,
  useBooleanOption: boolean,
): SessionConfigOption {
  const base = {
    id: FAST_MODE_CONFIG_ID,
    name: "Fast mode",
    description: FAST_MODE_DESCRIPTION,
    category: "model_config",
  } as const;

  if (useBooleanOption) {
    return { ...base, type: "boolean", currentValue: enabled };
  }

  return {
    ...base,
    type: "select",
    currentValue: enabled ? FAST_MODE_ON : FAST_MODE_OFF,
    options: [
      { value: FAST_MODE_ON, name: "On" },
      { value: FAST_MODE_OFF, name: "Off" },
    ],
  };
}

/** Resolve the requested Fast mode value from a `session/set_config_option`
 *  request. Accepts a native boolean (boolean-capable Clients) or the
 *  "on"/"off" select-fallback strings. */
export function resolveFastModeEnabled(params: SetSessionConfigOptionRequest): boolean {
  const value = params.value;
  if (typeof value === "boolean") {
    return value;
  }
  if (value === FAST_MODE_ON) {
    return true;
  }
  if (value === FAST_MODE_OFF) {
    return false;
  }
  throw new Error(`Invalid value for config option ${FAST_MODE_CONFIG_ID}: ${value}`);
}

/** Per-model Fast mode state threaded into {@link buildConfigOptions}. The
 *  option is only surfaced when the current model `supported`s fast mode. */
export type FastModeOptionState = {
  supported: boolean;
  enabled: boolean;
  /** Whether the Client opted into boolean config options. */
  useBooleanOption: boolean;
};

export function buildConfigOptions(
  modes: SessionModeState,
  models: SessionModelState,
  modelInfos: ModelInfo[],
  currentEffortLevel?: string,
  agents: AgentInfo[] = [],
  currentAgent: string = DEFAULT_AGENT_ID,
  fastMode?: FastModeOptionState,
): SessionConfigOption[] {
  const options: SessionConfigOption[] = [
    {
      id: MODE_CONFIG_ID,
      name: "Mode",
      description: "Session permission mode",
      category: "mode",
      type: "select",
      currentValue: modes.currentModeId,
      options: modes.availableModes.map((m) => ({
        value: m.id,
        name: m.name,
        description: m.description,
      })),
    },
    {
      id: MODEL_CONFIG_ID,
      name: "Model",
      description: "AI model to use",
      category: "model",
      type: "select",
      currentValue: models.currentModelId,
      options: models.availableModels.map((m) => ({
        value: m.modelId,
        name: m.name,
        description: m.description ?? undefined,
      })),
    },
  ];

  // Add effort level option based on the currently selected model
  const currentModelInfo = modelInfos.find((m) => m.value === models.currentModelId);
  const supportedLevels = currentModelInfo?.supportsEffort
    ? (currentModelInfo.supportedEffortLevels ?? [])
    : [];

  if (supportedLevels.length > 0) {
    const effortOptions = [
      { value: "default", name: "Default" },
      ...supportedLevels.map((level) => ({
        value: level,
        name: level
          .split(/[_-]/)
          .map((part) => (part ? part.charAt(0).toUpperCase() + part.slice(1) : part))
          .join(" "),
      })),
    ];

    const includes = (l: string) => l === "default" || (supportedLevels as string[]).includes(l);
    const validEffort =
      currentEffortLevel && includes(currentEffortLevel) ? currentEffortLevel : "default";

    options.push({
      id: EFFORT_CONFIG_ID,
      name: "Effort",
      description: "Available effort levels for this model",
      category: "thought_level",
      type: "select",
      currentValue: validEffort,
      options: effortOptions,
    });
  }

  // Surface the Fast mode toggle only when the current model supports it. The
  // option renders as a native boolean toggle for Clients that opted in, and a
  // two-value select otherwise.
  if (fastMode?.supported) {
    options.push(createFastModeConfigOption(fastMode.enabled, fastMode.useBooleanOption));
  }

  // Only surface the Agent picker when there's a real choice — i.e. the user
  // has configured at least one custom agent (built-ins are filtered out in
  // discoverCustomAgents). With none configured, "Default" would be the only
  // entry, so we omit the option entirely.
  if (agents.length > 0) {
    options.push({
      id: AGENT_CONFIG_ID,
      name: "Agent",
      description: "Main-thread agent persona",
      type: "select",
      currentValue: currentAgent,
      options: [
        { value: DEFAULT_AGENT_ID, name: "Default", description: "Standard Claude Code agent" },
        ...agents.map((a) => ({
          value: a.name,
          name: a.name,
          description: a.description || undefined,
        })),
      ],
    });
  }

  return options;
}

// Claude Code CLI persists display strings like "opus[1m]" in settings,
// but the SDK model list uses IDs like "claude-opus-4-6-1m".
const MODEL_CONTEXT_HINT_PATTERN = /\[(\d+m)\]$/i;

// The id-suffix spelling of a context hint ("-1m" in "claude-opus-4-6-1m");
// shared by the strip and canonicalize helpers below so the two can't drift.
const CONTEXT_HINT_SUFFIX_PATTERN = /-(\d+m)$/i;

/** Remove context-window hints — the display form "[1m]" and the SDK id
 *  suffix form "-1m" — from a model string. Those digits describe context
 *  size, not model identity or generation version. */
function stripContextHints(s: string): string {
  return s.replace(/\[\d+m\]/gi, "").replace(CONTEXT_HINT_SUFFIX_PATTERN, "");
}

/** Canonicalize a model id for exact comparison: trimmed, lowercased, with
 *  the id-suffix hint spelling unified to the bracket form ("-1m" → "[1m]").
 *  The hint itself is kept — bare and 1M ids must stay distinct. */
function canonicalizeModelId(s: string): string {
  return s.trim().toLowerCase().replace(CONTEXT_HINT_SUFFIX_PATTERN, "[$1]");
}

/** The context hint a model string carries ("1m" for either spelling), or
 *  null for a bare id. */
function contextHintOf(s: string): string | null {
  return canonicalizeModelId(s).match(MODEL_CONTEXT_HINT_PATTERN)?.[1] ?? null;
}

// Captures a model family version: `4-6`/`4.7` for dated generations, or a
// bare `5` for single-number ones like "Sonnet 5". Used to keep a pinned
// `claude-opus-4-6` from matching the `opus` alias once it points at 4.7.
const MODEL_FAMILY_VERSION_PATTERN = /\b(\d+)(?:[-.](\d+))?\b/;

function extractModelFamilyVersion(s: string): string | null {
  const match = stripContextHints(s).match(MODEL_FAMILY_VERSION_PATTERN);
  if (!match) return null;
  return match[2] ? `${match[1]}.${match[2]}` : match[1];
}

function modelVersionsCompatible(preference: string, candidate: ModelInfo): boolean {
  const preferred = extractModelFamilyVersion(preference);
  if (!preferred) return true;
  const candidateVersion =
    extractModelFamilyVersion(candidate.value) ??
    extractModelFamilyVersion(candidate.displayName) ??
    extractModelFamilyVersion(candidate.description);
  if (!candidateVersion) return true;
  return preferred === candidateVersion;
}

function tokenizeModelPreference(model: string): { tokens: string[]; contextHint?: string } {
  const lower = model.trim().toLowerCase();
  const contextHint = lower.match(MODEL_CONTEXT_HINT_PATTERN)?.[1]?.toLowerCase();

  const normalized = lower.replace(MODEL_CONTEXT_HINT_PATTERN, " $1 ");
  const rawTokens = normalized.split(/[^a-z0-9]+/).filter(Boolean);
  const tokens = rawTokens
    .map((token) => {
      if (token === "opusplan") return "opus";
      if (token === "best" || token === "default") return "";
      return token;
    })
    .filter((token) => token && token !== "claude")
    .filter((token) => /[a-z]/.test(token) || token.endsWith("m"));

  return { tokens, contextHint };
}

function scoreModelMatch(model: ModelInfo, tokens: string[], contextHint?: string): number {
  const haystack = `${model.value} ${model.displayName}`.toLowerCase();
  let score = 0;
  let nonHintMatched = false;
  for (const token of tokens) {
    if (haystack.includes(token)) {
      if (token !== contextHint) nonHintMatched = true;
      score += token === contextHint ? 3 : 1;
    }
  }
  if (contextHint && !nonHintMatched) return 0;
  return score;
}

export function resolveModelPreference(models: ModelInfo[], preference: string): ModelInfo | null {
  const trimmed = preference.trim();
  if (!trimmed) return null;

  const lower = trimmed.toLowerCase();

  // Exact match on value or display name. Values compare on the canonical
  // hint spelling so "opus-1m" hits an "opus[1m]" row (and vice versa).
  const canonicalPreference = canonicalizeModelId(trimmed);
  const directMatch = models.find(
    (model) =>
      model.value === trimmed ||
      canonicalizeModelId(model.value) === canonicalPreference ||
      model.displayName.toLowerCase() === lower,
  );
  if (directMatch) return directMatch;

  // Exact match on the alias's canonical resolved id (e.g. a pinned
  // "claude-sonnet-5" against the "sonnet" row's `resolvedModel`). SDK-
  // reported and unambiguous, so it's tried before the fuzzier tiers below.
  // Compared on the canonical hint spelling so a "-1m"-suffix pin matches a
  // "[1m]"-spelled resolvedModel instead of falling into the substring tier
  // (which would land on the bare 200k sibling). "default" is skipped first
  // since it shares a resolvedModel with whichever alias the CLI currently
  // recommends — a specific pin should land on that named alias, not
  // "default".
  const matchesResolved = (model: ModelInfo) =>
    model.resolvedModel != null && canonicalizeModelId(model.resolvedModel) === canonicalPreference;
  const resolvedMatch =
    models.find((model) => model.value !== "default" && matchesResolved(model)) ??
    models.find(matchesResolved);
  if (resolvedMatch) return resolvedMatch;

  // Substring match. Skips candidates whose context hint disagrees with the
  // preference's — a bare row must not absorb a 1M-hinted preference (nor
  // vice versa); such pairs fall through to the tokenized tier, which
  // weighs hints in its scoring and still finds the best same-family row.
  const preferenceHint = contextHintOf(trimmed);
  const includesMatch = models.find((model) => {
    if (!modelVersionsCompatible(trimmed, model)) return false;
    if (contextHintOf(model.value) !== preferenceHint) return false;
    const value = model.value.toLowerCase();
    const display = model.displayName.toLowerCase();
    return value.includes(lower) || display.includes(lower) || lower.includes(value);
  });
  if (includesMatch) return includesMatch;

  // Tokenized matching for aliases like "opus[1m]"
  const { tokens, contextHint } = tokenizeModelPreference(trimmed);
  if (tokens.length === 0) return null;

  let bestMatch: ModelInfo | null = null;
  let bestScore = 0;
  for (const model of models) {
    if (!modelVersionsCompatible(trimmed, model)) continue;
    const score = scoreModelMatch(model, tokens, contextHint);
    if (0 < score && (!bestMatch || bestScore < score)) {
      bestMatch = model;
      bestScore = score;
    }
  }

  return bestMatch;
}

/** Map the live model reported by a resumed session onto the picker's model
 *  list. The CLI restores a resumed session's model from the transcript's
 *  last assistant message, which records the concrete API id (e.g.
 *  "claude-opus-4-6") with any "[1m]" context hint dropped. Tiers, in order:
 *  1. Exact match with the Default entry's resolution — when a named alias
 *     shares Default's resolvedModel verbatim, the live id can't tell the
 *     two apart, and a never-customized session should stay on Default.
 *  2. Exact resolvedModel match on a named row. Checked before the
 *     hint-stripped Default comparison so a live "claude-sonnet-5[1m]" lands
 *     on the "sonnet[1m]" row rather than a Default that resolves to the
 *     bare "claude-sonnet-5" — the two rows differ in context window, which
 *     drives `contextWindowSize` and capability gating downstream.
 *  3. Hint-stripped match with Default's resolution — a session that never
 *     left the default resumes as the bare transcript id, and shouldn't show
 *     a concrete picker entry.
 *  4. `resolveModelPreference` over the picker entries.
 *  5. A model with no picker counterpart (e.g. excluded by an
 *     `availableModels` allowlist) is tracked verbatim, mirroring
 *     `syncModelAfterRefusalFallback`: the picker shows no selection, but the
 *     model-dependent bookkeeping stays truthful to what the SDK is running. */
export function matchResumedModel(models: ModelInfo[], liveModel: string): ModelInfo {
  const live = canonicalizeModelId(liveModel);
  const defaultEntry = models.find((m) => m.value === "default");
  const defaultResolved = defaultEntry?.resolvedModel
    ? canonicalizeModelId(defaultEntry.resolvedModel)
    : undefined;

  if (defaultEntry && defaultResolved === live) {
    return defaultEntry;
  }

  // No default-row exclusion needed: a default row matching `live` exactly
  // already returned at the tier above.
  const exactMatch = models.find(
    (m) => m.resolvedModel && canonicalizeModelId(m.resolvedModel) === live,
  );
  if (exactMatch) return exactMatch;

  if (
    defaultEntry &&
    defaultResolved &&
    stripContextHints(defaultResolved) === stripContextHints(live)
  ) {
    return defaultEntry;
  }

  return (
    resolveModelPreference(models, liveModel) ?? {
      value: liveModel,
      displayName: liveModel,
      description: "",
    }
  );
}

function resolveSettingsModel(
  models: ModelInfo[],
  settingsModel: unknown,
  logger: Logger,
): ModelInfo | null {
  if (settingsModel === undefined) {
    return null;
  }
  if (typeof settingsModel !== "string") {
    const typeLabel = settingsModel === null ? "null" : typeof settingsModel;
    logger.error(`Ignoring model from settings: expected a string, got ${typeLabel}.`);
    return null;
  }
  return resolveModelPreference(models, settingsModel);
}

/**
 * Restrict the SDK's model list to the user's `availableModels` allowlist
 * (already merged-and-deduped across settings sources by `SettingsManager`).
 * The user's exact entries become the model IDs surfaced via configOptions
 * and passed to `setModel`, which prevents Claude Code from silently
 * substituting a date-pinned variant (e.g. `haiku` →
 * `claude-haiku-4-5-20251001`) that the user may not have access to.
 *
 * Display info and capability flags are copied from the closest SDK match so
 * the UI still renders sensible names and effort levels.
 *
 * Semantics from https://code.claude.com/docs/en/model-config#restrict-model-selection:
 * - `undefined` is handled by the caller (no allowlist applied).
 * - The Default option is unaffected by `availableModels` — it always remains
 *   available, even when the allowlist is `[]`.
 */
export function applyAvailableModelsAllowlist(
  sdkModels: ModelInfo[],
  allowlist: string[],
  settingsModelOverrides?: Record<string, string>,
): ModelInfo[] {
  // Default is always preserved per the docs. Synthesize one if the SDK
  // didn't surface it so downstream code (e.g. `getAvailableModels` picking
  // `models[0]` as a fallback) still has something to work with.
  const defaultModel = sdkModels.find((m) => m.value === "default") ?? {
    value: "default",
    displayName: "Default",
    description: "",
  };
  const result: ModelInfo[] = [defaultModel];
  const seen = new Set<string>([defaultModel.value]);

  const sdkModelsWithoutDefault = sdkModels.filter((m) => m.value !== "default");

  // Bedrock/Vertex deployments enforce short aliases (e.g. "claude-opus-4-6")
  // in availableModels but require provider-specific IDs at the API. We still
  // resolve `sdkMatch` against the alias (`trimmed`) — that's what the
  // matching heuristics above are built for, and override targets (ARNs,
  // opaque provider IDs) often won't textually resemble anything in
  // `sdkModelsWithoutDefault`. Only the entry's surfaced `value` becomes the
  // override target, so it's what `setModel` ends up passing to the API.
  for (const entry of allowlist) {
    const trimmed = entry.trim();
    if (!trimmed || seen.has(trimmed)) continue;

    const overridden = settingsModelOverrides?.[trimmed];
    const effective = overridden ?? trimmed;
    if (seen.has(effective)) continue;

    const sdkMatch = resolveModelPreference(sdkModelsWithoutDefault, trimmed);
    if (sdkMatch) {
      result.push({ ...sdkMatch, value: effective });
    } else {
      result.push({ value: effective, displayName: trimmed, description: "" });
    }
    seen.add(effective);
  }

  // The custom model option (ANTHROPIC_CUSTOM_MODEL_OPTION) is exempt from the
  // allowlist, the same way Default is. Per the model-config docs it adds an
  // entry "without replacing the built-in aliases" and "appears at the bottom of
  // the /model picker", so we append it last and skip the allowlist filter; this
  // keeps a slim alias allowlist from hiding the custom model row.
  // https://code.claude.com/docs/en/model-config#add-a-custom-model-option
  const customModelOption = process.env.ANTHROPIC_CUSTOM_MODEL_OPTION?.trim();
  if (customModelOption && !seen.has(customModelOption)) {
    const customModel = sdkModels.find((m) => m.value === customModelOption);
    if (customModel) {
      result.push(customModel);
      seen.add(customModel.value);
    }
  }

  return result;
}

/** Read the model a resumed session is actually running (via the
 *  `getContextUsage` control request — the same source `/context` prints) and
 *  map it onto the picker. Best-effort: a control-request failure is logged
 *  and returns null so callers keep their current choice; failing the whole
 *  session/load over an unreadable report would be worse. */
async function readResumedLiveModel(
  query: Query,
  models: ModelInfo[],
  logger: Logger,
): Promise<ModelInfo | null> {
  try {
    const liveModel = (await query.getContextUsage()).model;
    return liveModel ? matchResumedModel(models, liveModel) : null;
  } catch (error) {
    logger.error("Failed to read the resumed session's live model:", error);
    return null;
  }
}

async function getAvailableModels(
  query: Query,
  models: ModelInfo[],
  sdkModels: ModelInfo[],
  settingsManager: SettingsManager,
  logger: Logger,
  isResumedSession: boolean,
): Promise<SessionModelState> {
  const settings = settingsManager.getSettings();

  let currentModel = models[0];
  let resolvedFromInput: string | undefined;

  // Model priority (highest to lowest):
  // 1. ANTHROPIC_MODEL environment variable
  // 2. settings.model (user configuration)
  // 3. the resumed session's live model (resumed sessions only)
  // 4. models[0] (default first model)
  if (process.env.ANTHROPIC_MODEL) {
    const match = resolveModelPreference(models, process.env.ANTHROPIC_MODEL);
    if (match) {
      currentModel = match;
      resolvedFromInput = process.env.ANTHROPIC_MODEL;
    }
  } else if (typeof settings.model === "string") {
    const match = resolveSettingsModel(models, settings.model, logger);
    if (match) {
      currentModel = match;
      resolvedFromInput = settings.model;
    }
  }

  // A resumed session restores the model it was previously running (the CLI
  // re-reads it from the transcript), so without an env/settings override the
  // freshly-computed default above can disagree with what the session actually
  // runs — session/load then reports a model the session isn't using (issue
  // #845). Ask the CLI for the live model and reflect it. No `setModel` here:
  // the SDK is already running this model, and pushing a picker alias back
  // (e.g. "opus[1m]") could change the live model rather than describe it.
  if (resolvedFromInput === undefined && isResumedSession) {
    currentModel = (await readResumedLiveModel(query, models, logger)) ?? currentModel;
  }

  // Skip the setModel round-trip when we can prove the SDK has already landed
  // on the same model. Two cases qualify:
  //  (a) No override applied — currentModel is the SDK's own default (or, on
  //      resume, the live model read back from the SDK above); nothing to sync.
  //  (b) The resolver returned the user's input verbatim AND that value exists
  //      in the SDK's original model list — meaning no fuzzy match or
  //      allowlist rewrite was involved, and the SDK (which reads the same
  //      ANTHROPIC_MODEL / settings.json) will have arrived at the same entry.
  //      This only holds for fresh sessions: a resumed session lands on the
  //      transcript's model regardless of env/settings, so the override must
  //      be re-asserted to keep the reported model truthful.
  // Anything else (fuzzy match, allowlist-synthesized value, alias) gets a
  // setModel call so we don't drift from the user's intended pin.
  const sdkSawSameValue = sdkModels.some((m) => m.value === currentModel.value);
  const skipSetModel =
    resolvedFromInput === undefined ||
    (!isResumedSession && currentModel.value === resolvedFromInput && sdkSawSameValue);
  if (!skipSetModel) {
    try {
      await query.setModel(currentModel.value);
    } catch (error) {
      // On a fresh session the pin is a defining option — fail loudly. A
      // resumed session already runs fine on the transcript's model, so
      // failing the whole session/load over the re-assert would be worse
      // than loading with the pin unapplied (mirrors the setPermissionMode
      // containment in createSession). The SDK then stayed on the
      // transcript's model, so read that back rather than reporting the
      // pin the session isn't running.
      if (!isResumedSession) throw error;
      logger.error(`Failed to re-assert model "${currentModel.value}" on resume:`, error);
      currentModel = (await readResumedLiveModel(query, models, logger)) ?? currentModel;
    }
  }

  return {
    availableModels: models.map((model) => ({
      modelId: model.value,
      name: model.displayName,
      description: model.description,
    })),
    currentModelId: currentModel.value,
  };
}

function getAvailableSlashCommands(commands: SlashCommand[]): AvailableCommand[] {
  const UNSUPPORTED_COMMANDS = [
    "clear",
    "cost",
    "keybindings-help",
    "login",
    "logout",
    "output-style:new",
    "release-notes",
    "todos",
  ];

  return commands
    .map((command) => {
      const input = command.argumentHint
        ? {
            hint: Array.isArray(command.argumentHint)
              ? command.argumentHint.join(" ")
              : command.argumentHint,
          }
        : null;
      let name = command.name;
      if (command.name.endsWith(" (MCP)")) {
        name = `mcp:${name.replace(" (MCP)", "")}`;
      }
      return {
        name,
        description: command.description || "",
        input,
      };
    })
    .filter((command: AvailableCommand) => !UNSUPPORTED_COMMANDS.includes(command.name));
}

function formatUriAsLink(uri: string): string {
  try {
    if (uri.startsWith("file://")) {
      const path = uri.slice(7); // Remove "file://"
      const name = path.split("/").pop() || path;
      return `[@${name}](${uri})`;
    } else if (uri.startsWith("zed://")) {
      const parts = uri.split("/");
      const name = parts[parts.length - 1] || uri;
      return `[@${name}](${uri})`;
    }
    return uri;
  } catch {
    return uri;
  }
}

export function promptToClaude(prompt: PromptRequest): SDKUserMessage {
  const content: any[] = [];
  const context: any[] = [];

  for (const chunk of prompt.prompt) {
    switch (chunk.type) {
      case "text": {
        let text = chunk.text;
        // change /mcp:server:command args -> /server:command (MCP) args
        const mcpMatch = text.match(/^\/mcp:([^:\s]+):(\S+)(?:\s(.*))?$/);
        if (mcpMatch) {
          const [, server, command, args] = mcpMatch;
          text = `/${server}:${command} (MCP)${args ? ` ${args}` : ""}`;
        }
        content.push({ type: "text", text });
        break;
      }
      case "resource_link": {
        const formattedUri = formatUriAsLink(chunk.uri);
        content.push({
          type: "text",
          text: formattedUri,
        });
        break;
      }
      case "resource": {
        if ("text" in chunk.resource) {
          const formattedUri = formatUriAsLink(chunk.resource.uri);
          content.push({
            type: "text",
            text: formattedUri,
          });
          context.push({
            type: "text",
            text: `\n<context ref="${chunk.resource.uri}">\n${chunk.resource.text}\n</context>`,
          });
        }
        // Ignore blob resources (unsupported)
        break;
      }
      case "image":
        if (chunk.data) {
          content.push({
            type: "image",
            source: {
              type: "base64",
              data: chunk.data,
              media_type: chunk.mimeType,
            },
          });
        } else if (chunk.uri && chunk.uri.startsWith("http")) {
          content.push({
            type: "image",
            source: {
              type: "url",
              url: chunk.uri,
            },
          });
        }
        break;
      // Ignore audio and other unsupported types
      default:
        break;
    }
  }

  content.push(...context);

  return {
    type: "user",
    message: {
      role: "user",
      content: content,
    },
    session_id: prompt.sessionId,
    parent_tool_use_id: null,
  };
}

/**
 * Resolves the ACP `messageId` for a Claude SDK message (live) or a persisted
 * transcript message (replay) so chunk grouping is identical in both views.
 *
 * Assistant turns are keyed by the Anthropic API message id (`message.id`),
 * which is identical at `message_start`, on the consolidated assistant message,
 * and in the persisted transcript — unlike the per-`stream_event` uuid, which is
 * unique per event and never persisted. User messages have no API id, but they
 * are never streamed, so their (stable) SDK uuid is used instead. ACP message
 * ids are opaque strings, so no particular format is required.
 */
export function messageIdForGrouping(message: {
  type?: string;
  uuid?: string | null;
  message?: unknown;
}): string | undefined {
  if (message.type === "assistant") {
    const inner = message.message;
    const apiId =
      inner && typeof inner === "object" && "id" in inner
        ? (inner as { id?: unknown }).id
        : undefined;
    if (typeof apiId === "string" && apiId.length > 0) {
      return apiId;
    }
  }
  return typeof message.uuid === "string" && message.uuid.length > 0 ? message.uuid : undefined;
}

/**
 * Stamps an ACP `messageId` onto a session update, but only on the message/
 * thought chunk variants that carry one — tool_call/plan/etc. updates never do.
 * No-op when `messageId` is falsy, so callers can pass it through unconditionally.
 */
function applyMessageId(
  update: SessionNotification["update"],
  messageId: string | undefined,
): void {
  if (
    messageId &&
    (update.sessionUpdate === "agent_message_chunk" ||
      update.sessionUpdate === "user_message_chunk" ||
      update.sessionUpdate === "agent_thought_chunk")
  ) {
    update.messageId = messageId;
  }
}

/** Built-in tools that drive the task list (headless/SDK sessions use these
 *  instead of TodoWrite). Their tool_use/tool_result are surfaced as `plan`
 *  snapshots rather than as tool_calls. */
function isTaskTool(toolName: string): boolean {
  return (
    toolName === "TaskCreate" ||
    toolName === "TaskUpdate" ||
    toolName === "TaskList" ||
    toolName === "TaskGet"
  );
}

/** Whether the streamed tool_use path surfaces this tool as a standalone
 *  `tool_call`. TodoWrite is rendered as a `plan` and Task* tools are
 *  suppressed (their plan snapshot is emitted at tool_result time), so neither
 *  produces a streamed tool_call/tool_call_update — which means a
 *  permission-surfaced tool_call for them (see `ensureToolCallEmitted`) must be
 *  resolved explicitly at tool_result time. */
function shouldEmitToolCall(toolName: string): boolean {
  return toolName !== "TodoWrite" && !isTaskTool(toolName);
}

/** Build the `tool_call` (or, with `refine`, the `tool_call_update`)
 *  notification for a tool_use. Shared by every site that surfaces a tool call:
 *  the streamed tool_use path (first encounter → tool_call, later encounter →
 *  refine) and the permission flow (`ensureToolCallEmitted`), so they can't
 *  drift. The initial `tool_call` carries `status: "pending"` and, for Bash, the
 *  `terminal_info` _meta that the later `terminal_output`/`terminal_exit`
 *  updates key off of; a refining `tool_call_update` carries neither. */
function toolCallNotification(
  toolUse: { id: string; name: string; input: unknown },
  rawInput: unknown,
  supportsTerminalOutput: boolean,
  cwd?: string,
  refine = false,
): SessionNotification["update"] {
  if (refine) {
    return {
      _meta: { claudeCode: { toolName: toolUse.name } } satisfies ToolUpdateMeta,
      toolCallId: toolUse.id,
      sessionUpdate: "tool_call_update",
      rawInput,
      ...toolInfoFromToolUse(toolUse, supportsTerminalOutput, cwd),
    };
  }
  return {
    _meta: {
      claudeCode: { toolName: toolUse.name },
      ...(toolUse.name === "Bash" && supportsTerminalOutput
        ? { terminal_info: { terminal_id: toolUse.id } }
        : {}),
    } satisfies ToolUpdateMeta,
    toolCallId: toolUse.id,
    sessionUpdate: "tool_call",
    rawInput,
    status: "pending",
    ...toolInfoFromToolUse(toolUse, supportsTerminalOutput, cwd),
  };
}

/** Refine a pending tool call from the complete top-level fields recovered
 *  from its still-streaming input. Shares `toolInfoFromToolUse` with the
 *  consolidated path but never carries `content`: content built from partial
 *  input is misleading (an Edit missing its `new_string` renders as a pure
 *  deletion) or invalid (a Write diff without `content` lacks the required
 *  `newText`), and the consolidated message supplies it moments later. */
function streamedInputRefinement(
  toolUse: { id: string; name: string },
  input: Record<string, unknown>,
  supportsTerminalOutput: boolean,
  cwd?: string,
): SessionNotification["update"] | undefined {
  // TodoWrite/Task* never surfaced a tool_call to refine (plan lane).
  if (!shouldEmitToolCall(toolUse.name)) {
    return undefined;
  }
  const { title, kind, locations } = toolInfoFromToolUse(
    { ...toolUse, input },
    supportsTerminalOutput,
    cwd,
  );
  return {
    _meta: { claudeCode: { toolName: toolUse.name } } satisfies ToolUpdateMeta,
    toolCallId: toolUse.id,
    sessionUpdate: "tool_call_update",
    rawInput: input,
    title,
    kind,
    ...(locations ? { locations } : {}),
  };
}

/**
 * Convert an SDKAssistantMessage (Claude) to a SessionNotification (ACP).
 * Only handles text, image, and thinking chunks for now.
 */
export function toAcpNotifications(
  content: string | ContentBlockParam[] | BetaContentBlock[] | BetaRawContentBlockDelta[],
  role: "assistant" | "user",
  sessionId: string,
  toolUseCache: ToolUseCache,
  client: AcpClient,
  logger: Logger,
  options?: {
    registerHooks?: boolean;
    clientCapabilities?: ClientCapabilities;
    parentToolUseId?: string | null;
    cwd?: string;
    taskState?: TaskState;
    // Tracks tool_use ids already emitted as a `tool_call` so a permission
    // request (which emits the tool_call eagerly) and the streamed tool_use
    // chunk don't both emit one — whichever arrives second emits a
    // `tool_call_update` instead. Mutated in place. When omitted, the
    // tool_call/update decision falls back to `toolUseCache` presence (the
    // historical single-source behavior).
    emittedToolCalls?: Set<string>;
    // Opaque id identifying the message these chunks belong to (ACP message ids
    // are opaque strings — no particular format is required). Attached to
    // user/agent message and thought chunks so clients can group streamed chunks
    // into a single message. Omit it (leave undefined) when unknown — never send
    // an explicit `null`.
    messageId?: string;
    // The SDK user message's `tool_use_result`: the structured Output object of
    // the tool_result this message carries (shape is per-tool). Used to render
    // Agent/Task results from the structured subagent report instead of the raw
    // text (which ends in a model-directed agentId/usage trailer).
    toolUseResult?: unknown;
  },
): SessionNotification[] {
  const taskState = options?.taskState ?? new Map();
  const registerHooks = options?.registerHooks !== false;
  const supportsTerminalOutput = options?.clientCapabilities?._meta?.["terminal_output"] === true;
  if (typeof content === "string") {
    if (content.length === 0) {
      return [];
    }
    const update: SessionNotification["update"] = {
      sessionUpdate: role === "assistant" ? "agent_message_chunk" : "user_message_chunk",
      content: {
        type: "text",
        text: content,
      },
    };
    applyMessageId(update, options?.messageId);

    if (options?.parentToolUseId) {
      update._meta = {
        ...update._meta,
        claudeCode: {
          ...(update._meta?.claudeCode || {}),
          parentToolUseId: options.parentToolUseId,
        },
      };
    }

    return [{ sessionId, update }];
  }

  // `tool_use_result` is message-level and carries no tool_use_id of its own:
  // it describes "the" tool_result block of the message it rode in on. If
  // several tool_result blocks were ever batched into one message it couldn't
  // be attributed, so it is only honored when the message carries exactly one.
  const toolUseResult =
    options?.toolUseResult !== undefined &&
    content.filter((c) => typeof c === "object" && c !== null && c.type === "tool_result")
      .length === 1
      ? options.toolUseResult
      : undefined;

  const output = [];
  // Only handle the first chunk for streaming; extend as needed for batching
  for (const chunk of content) {
    let update: SessionNotification["update"] | null = null;
    switch (chunk.type) {
      case "text":
      case "text_delta": {
        if (chunk.text) {
          update = {
            sessionUpdate: role === "assistant" ? "agent_message_chunk" : "user_message_chunk",
            content: {
              type: "text",
              text: chunk.text,
            },
          };
        }
        break;
      }
      case "image":
        update = {
          sessionUpdate: role === "assistant" ? "agent_message_chunk" : "user_message_chunk",
          content: {
            type: "image",
            data: chunk.source.type === "base64" ? chunk.source.data : "",
            mimeType: chunk.source.type === "base64" ? chunk.source.media_type : "",
            uri: chunk.source.type === "url" ? chunk.source.url : undefined,
          },
        };
        break;
      case "thinking":
      case "thinking_delta": {
        // Recent models default `thinking.display` to "omitted", which streams
        // signature-only thinking blocks whose text is empty.
        if (chunk.thinking) {
          update = {
            sessionUpdate: "agent_thought_chunk",
            content: {
              type: "text",
              text: chunk.thinking,
            },
          };
        }
        break;
      }
      case "tool_use":
      case "server_tool_use":
      case "mcp_tool_use": {
        const alreadyCached = chunk.id in toolUseCache;
        toolUseCache[chunk.id] = chunk;
        if (chunk.name === "TodoWrite") {
          // @ts-expect-error - sometimes input is empty object or undefined
          if (Array.isArray(chunk.input?.todos)) {
            update = {
              sessionUpdate: "plan",
              entries: planEntries(chunk.input as { todos: ClaudePlanEntry[] }),
            };
          }
        } else if (isTaskTool(chunk.name)) {
          // Task* tool_use is suppressed; the plan update is emitted at
          // tool_result time once we have the task ID (for TaskCreate) and
          // confirmation that the change took effect.
        } else {
          // Only register hooks on first encounter to avoid double-firing
          if (registerHooks && !alreadyCached) {
            // Capture the tool name in the closure rather than re-reading the
            // cache when the hook fires. The cache entry is pruned at
            // tool_result time, and a PostToolUse hook can fire after that, so
            // closing over the name keeps the diff working without depending on
            // (or pinning) the cache entry's lifetime.
            const toolName = chunk.name;
            registerHookCallback(chunk.id, {
              onPostToolUseHook: async (toolUseId, toolInput, toolResponse) => {
                // Both `Edit` and `Write` produce a structuredPatch in their
                // PostToolUse tool_response. For Edit the diff replaces the
                // optimistic content built at tool_use time. For Write the
                // optimistic content (built from `input.content` alone with
                // `oldText: null`) shows "creation" semantics regardless of
                // whether the file existed; the structuredPatch from the
                // hook lets us emit the real diff for `type: "update"`. The
                // helper returns `{}` if the response shape isn't usable.
                const editDiff =
                  toolName === "Edit" || toolName === "Write"
                    ? toolUpdateFromDiffToolResponse(toolResponse)
                    : {};
                const update: SessionNotification["update"] = {
                  _meta: {
                    claudeCode: {
                      toolResponse,
                      toolName,
                    },
                  } satisfies ToolUpdateMeta,
                  toolCallId: toolUseId,
                  sessionUpdate: "tool_call_update",
                  ...editDiff,
                };
                await client.sessionUpdate({
                  sessionId,
                  update,
                });
              },
            });
          }

          let rawInput;
          try {
            rawInput = JSON.parse(JSON.stringify(chunk.input));
          } catch {
            // ignore if we can't turn it to JSON
          }

          // Emit a `tool_call` only the first time this id surfaces to the
          // client; afterwards refine it with a `tool_call_update`. The first
          // surface may be this stream chunk OR an earlier permission request
          // (see `ensureToolCallEmitted`), so emission is tracked separately
          // from `toolUseCache`. Without an `emittedToolCalls` set we fall back
          // to cache presence — the historical streaming-only behavior.
          const emittedToolCalls = options?.emittedToolCalls;
          const alreadyEmitted = emittedToolCalls ? emittedToolCalls.has(chunk.id) : alreadyCached;
          emittedToolCalls?.add(chunk.id);

          if (alreadyEmitted) {
            // Already surfaced (full assistant message after streaming, or a
            // permission request emitted it first) — refine with a
            // tool_call_update rather than emitting a duplicate tool_call.
            update = toolCallNotification(
              chunk,
              rawInput,
              supportsTerminalOutput,
              options?.cwd,
              true,
            );
          } else {
            // First surface (streaming content_block_start or replay) — send as
            // tool_call (with terminal_info for Bash).
            update = toolCallNotification(chunk, rawInput, supportsTerminalOutput, options?.cwd);
          }
        }
        break;
      }

      case "tool_result":
      case "tool_search_tool_result":
      case "web_fetch_tool_result":
      case "web_search_tool_result":
      case "code_execution_tool_result":
      case "bash_code_execution_tool_result":
      case "text_editor_code_execution_tool_result":
      case "mcp_tool_result": {
        const wasEmitted = options?.emittedToolCalls?.has(chunk.tool_use_id) === true;
        options?.emittedToolCalls?.delete(chunk.tool_use_id);
        const toolUse = toolUseCache[chunk.tool_use_id];
        if (!toolUse) {
          // The permission flow may have surfaced this tool_call even though
          // its tool_use never reached the cache (e.g. the assistant message
          // carrying it was dropped by the cancelled-turn guard and a straggler
          // result landed later). Resolve the surfaced call anyway so it can't
          // stay pending in the client forever; without the cache entry the
          // tool name is unknown, so no claudeCode meta is attached.
          if (wasEmitted) {
            output.push({
              sessionId,
              update: {
                toolCallId: chunk.tool_use_id,
                sessionUpdate: "tool_call_update" as const,
                status:
                  "is_error" in chunk && chunk.is_error
                    ? ("failed" as const)
                    : ("completed" as const),
                rawOutput: chunk.content,
              },
            });
          }
          logger.error(
            `[claude-agent-acp] Got a tool result for tool use that wasn't tracked: ${chunk.tool_use_id}`,
          );
          break;
        }

        // A permission request may have surfaced a plan-rendered (TodoWrite) or
        // suppressed (Task*) tool as a real tool_call so the request referenced
        // a tool call the client knows about (see `ensureToolCallEmitted`,
        // issue #851). The branches below never emit a tool_call_update for
        // those tools, which would leave the surfaced call pending in the
        // client forever — resolve it here. `wasEmitted` is only ever true for
        // these tools via the permission flow: the streamed plan/suppressed
        // branches don't record emissions.
        if (wasEmitted && !shouldEmitToolCall(toolUse.name)) {
          output.push({
            sessionId,
            update: {
              _meta: {
                claudeCode: {
                  toolName: toolUse.name,
                  ...(options?.parentToolUseId ? { parentToolUseId: options.parentToolUseId } : {}),
                },
              } satisfies ToolUpdateMeta,
              toolCallId: chunk.tool_use_id,
              sessionUpdate: "tool_call_update" as const,
              status:
                "is_error" in chunk && chunk.is_error
                  ? ("failed" as const)
                  : ("completed" as const),
              rawOutput: chunk.content,
            },
          });
        }

        if (isTaskTool(toolUse.name)) {
          // Headless/SDK sessions emit Task* tools instead of TodoWrite.
          // TaskCreate / TaskUpdate mutate the accumulated task list; TaskList
          // and TaskGet are read-only so we just suppress their tool_call /
          // tool_result events. The plan update is emitted as a snapshot of
          // the accumulated state, mirroring the legacy TodoWrite behavior.
          const isError = "is_error" in chunk && chunk.is_error;
          if (!isError) {
            if (toolUse.name === "TaskCreate") {
              applyTaskCreate(
                taskState,
                toolUse.input as Parameters<typeof applyTaskCreate>[1],
                parseTaskCreateOutput(chunk.content),
              );
            } else if (toolUse.name === "TaskUpdate") {
              applyTaskUpdate(taskState, toolUse.input as Parameters<typeof applyTaskUpdate>[1]);
            }
          }
          if (!isError && (toolUse.name === "TaskCreate" || toolUse.name === "TaskUpdate")) {
            update = {
              sessionUpdate: "plan",
              entries: taskStateToPlanEntries(taskState),
            };
          }
        } else if (toolUse.name !== "TodoWrite") {
          const { _meta: toolMeta, ...toolUpdate } = toolUpdateFromToolResult(
            chunk,
            toolUseCache[chunk.tool_use_id],
            supportsTerminalOutput,
            toolUseResult,
          );

          // When terminal output is supported, send terminal_output as a
          // separate notification to match codex-acp's streaming lifecycle:
          //   1. tool_call       → _meta.terminal_info  (already sent above)
          //   2. tool_call_update → _meta.terminal_output (sent here)
          //   3. tool_call_update → _meta.terminal_exit  (sent below with status)
          if (toolMeta?.terminal_output) {
            output.push({
              sessionId,
              update: {
                _meta: {
                  terminal_output: toolMeta.terminal_output,
                  ...(options?.parentToolUseId
                    ? { claudeCode: { parentToolUseId: options.parentToolUseId } }
                    : {}),
                },
                toolCallId: chunk.tool_use_id,
                sessionUpdate: "tool_call_update" as const,
              },
            });
          }

          update = {
            _meta: {
              claudeCode: {
                toolName: toolUse.name,
              },
              ...(toolMeta?.terminal_exit ? { terminal_exit: toolMeta.terminal_exit } : {}),
            } satisfies ToolUpdateMeta,
            toolCallId: chunk.tool_use_id,
            sessionUpdate: "tool_call_update",
            status: "is_error" in chunk && chunk.is_error ? "failed" : "completed",
            rawOutput: chunk.content,
            ...toolUpdate,
          };
        }
        // The tool_use is fully resolved now — drop it so a long session doesn't
        // retain every tool call. The PostToolUse hook (Edit/Write diffs) closes
        // over the tool name and no longer reads the cache, so pruning here is
        // safe regardless of hook/result ordering.
        delete toolUseCache[chunk.tool_use_id];
        break;
      }

      case "document":
      case "search_result":
      case "redacted_thinking":
      case "input_json_delta":
      case "citations_delta":
      case "signature_delta":
      case "container_upload":
      case "compaction":
      case "compaction_delta":
      case "advisor_tool_result":
      case "mid_conv_system":
      case "fallback":
        break;

      default:
        unreachable(chunk, logger);
        break;
    }
    if (update) {
      if (options?.parentToolUseId) {
        update._meta = {
          ...update._meta,
          claudeCode: {
            ...(update._meta?.claudeCode || {}),
            parentToolUseId: options.parentToolUseId,
          },
        };
      }
      applyMessageId(update, options?.messageId);
      output.push({ sessionId, update });
    }
  }

  return output;
}

export function streamEventToAcpNotifications(
  message: SDKPartialAssistantMessage,
  sessionId: string,
  toolUseCache: ToolUseCache,
  client: AcpClient,
  logger: Logger,
  options?: {
    clientCapabilities?: ClientCapabilities;
    cwd?: string;
    taskState?: TaskState;
    emittedToolCalls?: Set<string>;
    messageId?: string;
    streamedToolInputs?: StreamedToolInputCache;
  },
): SessionNotification[] {
  const event = message.event;
  const streamKey = message.parent_tool_use_id ?? "";
  const streamedToolInputs = options?.streamedToolInputs;
  const forwardedOptions = {
    clientCapabilities: options?.clientCapabilities,
    parentToolUseId: message.parent_tool_use_id,
    cwd: options?.cwd,
    taskState: options?.taskState,
    emittedToolCalls: options?.emittedToolCalls,
    messageId: options?.messageId,
  };
  switch (event.type) {
    case "content_block_start": {
      const block = event.content_block;
      if (
        streamedToolInputs &&
        (block.type === "tool_use" ||
          block.type === "server_tool_use" ||
          block.type === "mcp_tool_use")
      ) {
        let inputsForMessage = streamedToolInputs.get(streamKey);
        if (!inputsForMessage) {
          inputsForMessage = new Map();
          streamedToolInputs.set(streamKey, inputsForMessage);
        }
        inputsForMessage.set(event.index, {
          id: block.id,
          name: block.name,
          partialJson: "",
          scannedTo: 0,
          inString: false,
          escaped: false,
          objectDepth: 0,
          arrayDepth: 0,
          lastTopLevelComma: -1,
          emittedThroughComma: -1,
        });
      }
      return toAcpNotifications(
        [block],
        "assistant",
        sessionId,
        toolUseCache,
        client,
        logger,
        forwardedOptions,
      );
    }
    case "content_block_delta": {
      if (event.delta.type === "input_json_delta") {
        const streamedInput = streamedToolInputs?.get(streamKey)?.get(event.index);
        if (!streamedInput) return [];

        streamedInput.partialJson += event.delta.partial_json;
        if (scanStreamedToolInput(streamedInput)) {
          // Input complete: the consolidated assistant message replays the
          // block with its full input and refines the call there; emitting
          // here too would send a duplicate identical update.
          const inputsForMessage = streamedToolInputs?.get(streamKey);
          inputsForMessage?.delete(event.index);
          if (inputsForMessage?.size === 0) streamedToolInputs?.delete(streamKey);
          return [];
        }
        if (streamedInput.lastTopLevelComma <= streamedInput.emittedThroughComma) {
          return [];
        }
        streamedInput.emittedThroughComma = streamedInput.lastTopLevelComma;
        const input = recoveredToolInput(
          streamedInput.partialJson.slice(0, streamedInput.lastTopLevelComma),
        );
        if (!input) return [];
        const supportsTerminalOutput =
          options?.clientCapabilities?._meta?.["terminal_output"] === true;
        const update = streamedInputRefinement(
          streamedInput,
          input,
          supportsTerminalOutput,
          options?.cwd,
        );
        if (!update) return [];
        if (message.parent_tool_use_id) {
          update._meta = {
            ...update._meta,
            claudeCode: {
              ...(update._meta?.claudeCode || {}),
              parentToolUseId: message.parent_tool_use_id,
            },
          };
        }
        applyMessageId(update, options?.messageId);
        return [{ sessionId, update }];
      }
      return toAcpNotifications(
        [event.delta],
        "assistant",
        sessionId,
        toolUseCache,
        client,
        logger,
        forwardedOptions,
      );
    }
    // No content. `ping` is a Messages-API keep-alive event that the SDK's
    // `BetaRawMessageStreamEvent` union doesn't include even though the
    // wire format emits it; the `as never` cast lets us no-op it here
    // instead of letting it fall through to `unreachable`.
    case "ping" as never:
    case "message_delta":
      return [];
    // A message boundary ends every input stream on this lane: message_stop is
    // the normal end, and a message_start clears anything a prior message on
    // the lane left behind (e.g. a stream cut short mid-block).
    case "message_start":
    case "message_stop":
      streamedToolInputs?.delete(streamKey);
      return [];
    case "content_block_stop": {
      const inputsForMessage = streamedToolInputs?.get(streamKey);
      inputsForMessage?.delete(event.index);
      if (inputsForMessage?.size === 0) streamedToolInputs?.delete(streamKey);
      return [];
    }

    default:
      unreachable(event, logger);
      return [];
  }
}

/** Run a `session/prompt` while honoring `$/cancel_request` for it. ACP clients
 *  normally stop a turn with the `session/cancel` notification, but `signal`
 *  (the prompt request's abort signal) also fires when the client sends the
 *  generic `$/cancel_request` for this prompt — the protocol's complementary
 *  cancellation fallback. Route that to the same `agent.cancel` path so a client
 *  using only the generic mechanism still stops the turn (and the prompt
 *  resolves "cancelled" instead of running to completion).
 *
 *  The listener is scoped to this call: once the prompt settles it is removed,
 *  so a later teardown-time abort of the (per-request) signal can't cancel a
 *  subsequent turn. `signal` also aborts on connection close, in which case
 *  cancelling the in-flight turn is the desired behavior anyway. */
export async function runPromptWithCancellation(
  agent: Pick<ClaudeAcpAgent, "prompt" | "cancel" | "logger">,
  params: PromptRequest,
  signal: AbortSignal,
): Promise<PromptResponse> {
  const onAbort = () => {
    // Fire-and-forget: nothing awaits this listener, so swallow (and log) any
    // rejection rather than surfacing it as an unhandled rejection.
    agent.cancel({ sessionId: params.sessionId }).catch((error) => {
      agent.logger.error(`Failed to cancel prompt via $/cancel_request: ${error}`);
    });
  };
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    return await agent.prompt(params);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

export function runAcp() {
  const input = nodeToWebWritable(process.stdout);
  const output = nodeToWebReadable(process.stdin);

  const stream = ndJsonStream(input, output);

  // `connect(...)` returns a connection-scoped peer handle (`connection.client`)
  // that stays valid for the whole connection, so the agent captures it once.
  // Handlers close over `agent`, which is assigned synchronously right after
  // `connect()` returns — before the connection processes any inbound message.
  // It cannot be `const`: its value depends on `connection.client`, which does
  // not exist until `connect()` has been called.
  // eslint-disable-next-line prefer-const
  let agent: ClaudeAcpAgent;
  const connection = acpAgent({ name: "claude-code-acp" })
    .onRequest(methods.agent.initialize, (ctx) => agent.initialize(ctx.params))
    .onRequest(methods.agent.session.new, (ctx) => agent.newSession(ctx.params))
    .onRequest(methods.agent.session.load, (ctx) => agent.loadSession(ctx.params))
    .onRequest(methods.agent.session.fork, (ctx) => agent.unstable_forkSession(ctx.params))
    .onRequest(methods.agent.session.list, (ctx) => agent.listSessions(ctx.params))
    .onRequest(methods.agent.session.delete, (ctx) => agent.deleteSession(ctx.params))
    .onRequest(methods.agent.session.resume, (ctx) => agent.resumeSession(ctx.params))
    .onRequest(methods.agent.session.close, (ctx) => agent.closeSession(ctx.params))
    .onRequest(methods.agent.session.setMode, (ctx) => agent.setSessionMode(ctx.params))
    .onRequest(methods.agent.session.setConfigOption, (ctx) =>
      agent.setSessionConfigOption(ctx.params),
    )
    .onRequest(methods.agent.authenticate, (ctx) => agent.authenticate(ctx.params))
    .onRequest(methods.agent.logout, (ctx) => agent.logout(ctx.params))
    .onRequest(methods.agent.session.prompt, (ctx) =>
      runPromptWithCancellation(agent, ctx.params, ctx.signal),
    )
    .onNotification(methods.agent.session.cancel, (ctx) => agent.cancel(ctx.params))
    .connect(stream);

  agent = new ClaudeAcpAgent(new ClientConnection(connection.client));
  return { connection, agent };
}

function commonPrefixLength(a: string, b: string) {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) {
    i++;
  }
  return i;
}

/** Best-effort first guess of a model's context window, used only as a
 *  fallback when the SDK's authoritative `getContextUsage` is unavailable (and
 *  until a `result` message arrives with the `modelUsage` value).
 *
 *  Anthropic 1M-context variants encode "1m" as a distinct token in the SDK
 *  model ID (e.g., "claude-opus-4-6-1m"), which `\b1m\b` catches without also
 *  matching things like "10m" or embedded substrings. Semantic aliases like
 *  `default` carry no such token in the ID, but their `resolvedModel` and the
 *  SDK's human-facing `displayName`/`description` can (e.g.
 *  "claude-opus-4-8[1m]", "Opus 4.7 (1M context)"), so callers pass those too.
 *  This text scan can't catch every model — some resolve to extended-context
 *  models with no "1m" anywhere (e.g. `sonnet` → claude-sonnet-5, natively
 *  ~1M) — which is why `fetchContextWindowSize` is preferred wherever a live
 *  query is available. A miss falls back to the default window and is
 *  corrected by `result.modelUsage` within one turn. */
function inferContextWindowFromModel(...texts: Array<string | undefined>): number | null {
  if (texts.some((text) => text != null && /\b1m\b/i.test(text))) return 1_000_000;
  return null;
}

/** Fetch the SDK's authoritative context-window occupancy via the
 *  `getContextUsage` control request. Unlike the per-message API usage numbers
 *  (which only count message tokens), this `totalTokens` includes the system
 *  prompt, tool schemas, MCP tools, and memory-file overhead — the real
 *  occupancy the user sees. Returns `null` on any control-request failure. */
async function fetchContextUsedTokens(query: Query, logger: Logger): Promise<number | null> {
  try {
    const usage = await query.getContextUsage();
    return usage.totalTokens;
  } catch (error) {
    logger.error("Failed to fetch context usage from SDK:", error);
    return null;
  }
}

/** Fetch the current model's full context window (`rawMaxTokens`) via the
 *  `getContextUsage` control request — the same source `/context` prints.
 *  This is the only pre-`result` signal that covers semantic aliases whose
 *  text carries no "1m" token (e.g. `sonnet` → claude-sonnet-5, natively
 *  ~1M), so it's the primary window source at session creation and on model
 *  switches; `inferContextWindowFromModel` remains the fallback. A returned
 *  window is still superseded by each `result.modelUsage.contextWindow`.
 *
 *  (Older CLIs under-reported extended 1M windows here — commit 20ef663
 *  dropped the field for that reason — but the CLI vendored by the pinned
 *  SDK reports them correctly again.) Returns `null` on any control-request
 *  failure or a nonsensical (non-positive) window. */
async function fetchContextWindowSize(query: Query, logger: Logger): Promise<number | null> {
  try {
    const usage = await query.getContextUsage();
    return usage.rawMaxTokens > 0 ? usage.rawMaxTokens : null;
  } catch (error) {
    logger.error("Failed to fetch context window size from SDK:", error);
    return null;
  }
}

/** Translate the legacy `MAX_THINKING_TOKENS` env var into the SDK's `thinking`
 *  option. The `maxThinkingTokens` option it used to feed is deprecated and
 *  reduced to on/off on current models, so map the value to explicit thinking
 *  config instead: unset → `undefined` (SDK default, adaptive on models that
 *  support it); `0` → disabled; a positive integer → a fixed token budget.
 *  Anything else is ignored with a warning. */
function resolveThinkingConfig(
  raw: string | undefined,
  logger: Logger,
): ThinkingConfig | undefined {
  if (raw === undefined) return undefined;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed < 0) {
    logger.error(`Ignoring MAX_THINKING_TOKENS: expected a non-negative integer, got '${raw}'.`);
    return undefined;
  }
  return parsed === 0 ? { type: "disabled" } : { type: "enabled", budgetTokens: parsed };
}

function parseModelConfig(
  raw: string | undefined,
): { modelOverrides?: Record<string, string>; availableModels?: string[] } | undefined {
  if (!raw) return undefined;
  const parsed = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("CLAUDE_MODEL_CONFIG must be a JSON object");
  }
  const result: { modelOverrides?: Record<string, string>; availableModels?: string[] } = {};
  if (parsed.modelOverrides !== undefined) result.modelOverrides = parsed.modelOverrides;
  if (parsed.availableModels !== undefined) result.availableModels = parsed.availableModels;
  return Object.keys(result).length > 0 ? result : undefined;
}

function getMatchingModelUsage(modelUsage: Record<string, ModelUsage>, currentModel: string) {
  let bestKey: string | null = null;
  let bestLen = 0;

  for (const key of Object.keys(modelUsage)) {
    const len = commonPrefixLength(key, currentModel);
    if (len > bestLen) {
      bestLen = len;
      bestKey = key;
    }
  }

  if (bestKey) {
    return modelUsage[bestKey];
  }
}
