import type { Options } from "@anthropic-ai/claude-agent-sdk";
import type { NewSessionRequest } from "@agentclientprotocol/sdk/unstable";

import type { NewSessionMeta } from "../new-session-meta.js";

/** Normalize skills without changing their SDK semantics. Array order and
 *  duplicates do not affect the selected skill set, so neither should rebuild
 *  the underlying Query process. */
function normalizeSkills(skills: Options["skills"]): Options["skills"] {
  return Array.isArray(skills) ? [...new Set(skills)].sort() : skills;
}

/** Whether a changed `_meta.claudeCode.options` key on session/load or
 *  session/resume must rebuild the Query process. Almost every option is read
 *  only when the process starts, so the default is `true`. Every key of the
 *  SDK's `Options` must be classified: an SDK bump that adds or removes an
 *  option fails to compile until it is decided here. */
const OPTION_REBUILDS_SESSION = {
  additionalDirectories: true,
  agentProgressSummaries: true,
  agents: true,
  allowDangerouslySkipPermissions: true,
  allowedTools: true,
  betas: true,
  debug: true,
  debugFile: true,
  disallowedTools: true,
  effort: true,
  enableFileCheckpointing: true,
  env: true,
  executableArgs: true,
  extraArgs: true,
  fallbackModel: true,
  forwardSubagentText: true,
  includeHookEvents: true,
  managedSettings: true,
  maxBudgetUsd: true,
  maxThinkingTokens: true,
  maxTurns: true,
  mcpServers: true,
  model: true,
  outputFormat: true,
  pathToClaudeCodeExecutable: true,
  permissionPrompts: true,
  permissionPromptToolName: true,
  persistSession: true,
  perTaskStopAffordance: true,
  planModeInstructions: true,
  pluginDelivery: true,
  plugins: true,
  projectConfigRoot: true,
  promptSuggestions: true,
  sandbox: true,
  sessionStoreFlush: true,
  settings: true,
  settingSources: true,
  skills: true,
  strictMcpConfig: true,
  supportedDialogKinds: true,
  systemPrompt: true,
  taskBudget: true,
  thinking: true,
  toolAliases: true,
  toolConfig: true,
  tools: true,
  verbatimPrompts: true,
  // Managed or ignored by the adapter.
  agent: false,
  cwd: false,
  executable: false,
  includePartialMessages: false,
  permissionMode: false,
  // Per-call controls for attaching to the stored conversation.
  continue: false,
  forkSession: false,
  resume: false,
  resumeDropsTurn: false,
  resumeSessionAt: false,
  sessionId: false,
  // Callbacks and live objects: they cannot cross JSON-RPC and have no stable serialized form.
  abortController: false,
  canUseTool: false,
  hooks: false,
  onElicitation: false,
  onUserDialog: false,
  sessionStore: false,
  spawnClaudeCodeProcess: false,
  stderr: false,
  // No effect on an already-created session.
  loadTimeoutMs: false,
  title: false,
} as const satisfies Record<keyof Options, boolean>;

/** A JSON value with object keys sorted, so key order never changes a
 *  fingerprint. Functions and class instances (hook callbacks, abort
 *  controllers, in-process MCP servers) cannot cross JSON-RPC and have no
 *  stable serialized form, so they are left out. */
function canonicalJson(value: unknown): unknown {
  if (typeof value === "function") return undefined;
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(canonicalJson);
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return undefined;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalJson((value as Record<string, unknown>)[key])])
      .filter(([, entry]) => entry !== undefined),
  );
}

/** Compute a stable fingerprint of the session-defining params so we can
 *  detect when a loadSession/resumeSession call requires tearing down and
 *  recreating the underlying Query process. Every option classified in
 *  {@link OPTION_REBUILDS_SESSION} is covered, so a warm resume never silently
 *  keeps stale values. MCP servers are sorted by name, and skills are
 *  normalized as a set, so ordering differences don't trigger unnecessary
 *  recreations. */
export function computeSessionFingerprint(params: {
  cwd: string;
  mcpServers?: NewSessionRequest["mcpServers"];
  additionalDirectories?: NewSessionRequest["additionalDirectories"];
  systemPrompt?: NewSessionRequest["systemPrompt"];
  _meta?: NewSessionRequest["_meta"];
}): string {
  const servers = [...(params.mcpServers ?? [])].sort((a, b) => a.name.localeCompare(b.name));
  const meta = params._meta as (NewSessionMeta & Record<string, unknown>) | undefined;
  const options: Record<string, unknown> = Object.fromEntries(
    Object.entries(meta?.claudeCode?.options ?? {}).filter(
      ([key]) => (OPTION_REBUILDS_SESSION as Record<string, boolean>)[key] === true,
    ),
  );
  options.skills = normalizeSkills(options.skills as Options["skills"]);
  return JSON.stringify(
    canonicalJson({
      cwd: params.cwd,
      mcpServers: servers,
      additionalDirectories: params.additionalDirectories,
      additionalRoots: meta?.additionalRoots,
      systemPrompt: meta?.systemPrompt,
      clientSystemPrompt: params.systemPrompt ?? undefined,
      disableBuiltInTools: meta?.disableBuiltInTools,
      emitRawSDKMessages: meta?.claudeCode?.emitRawSDKMessages,
      options,
    }),
  );
}
