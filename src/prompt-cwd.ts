/**
 * Moving a live session to a new working directory between turns.
 *
 * ACP has no in-session cwd primitive: `session/new` and `session/load` carry
 * `cwd`, but `session/prompt` does not, so a GUI client whose user navigates to
 * another folder between turns would have to recreate the session and lose the
 * conversation. A prompt can therefore carry the directory the client wants in
 * `_meta.claudeCode.cwd`; before that prompt runs, the adapter moves the
 * session with the Claude Code CLI's `set_cwd` control request — the headless
 * twin of `/cd`, marked `@internal` and absent from the SDK's public `Query`
 * declaration. The load/resume path that tears a session down and recreates it
 * for a changed `cwd` (see `getOrCreateSession`) stays as the fallback for
 * SDKs and CLIs without the control.
 */
import { RequestError, type NewSessionRequest } from "@agentclientprotocol/sdk/unstable";
import type { Query } from "@anthropic-ai/claude-agent-sdk";

/**
 * The runtime `set_cwd` control of the pinned Agent SDK's `Query`. Like
 * `enableRemoteControl`, the method is not in the public `Query` declaration
 * yet (the CLI marks the control `@internal`), so every use goes through
 * {@link supportsSetCwd} and a session behind an SDK without it cannot move.
 */
export type SetCwdQuery = Query & {
  setCwd(path: string): Promise<unknown>;
};

export function supportsSetCwd(query: Query): query is SetCwdQuery {
  return typeof (query as Partial<SetCwdQuery>).setCwd === "function";
}

/** The `set_cwd` response of a CLI that moved the session: `cwd` is the
 *  directory the CLI reports after the move, `transcript_relocated` whether
 *  the transcript moved with it. */
export type SetCwdOkResponse = {
  status: "ok";
  cwd?: string;
  changed?: boolean;
  transcript_relocated?: boolean;
};

/** The `set_cwd` response of a CLI that requires the directory to be trusted
 *  first. `trust_root` is the ancestor directory whose trust answers the
 *  request, when the CLI names one. */
export type SetCwdNeedsTrustResponse = {
  status: "needs_trust";
  trust_root?: string;
};

/** What {@link parseSetCwdResponse} reads off the wire: the fields a move
 *  decision needs, with the CLI's reported `cwd` filled in. */
export type ParsedSetCwdResponse =
  { status: "ok"; cwd: string } | { status: "needs_trust"; trustRoot?: string };

/** The session state a cwd move reads and updates. A projection of the agent's
 *  `Session`, so this module stays independent from it: the CLI has already
 *  moved when the state is written, so the stored cwd, the fingerprint a later
 *  load/resume compares against, the watched project settings and the
 *  checkpoint report's workspace roots all follow the move. */
export type PromptCwdSession = {
  query: Query;
  cwd: string;
  sessionFingerprint: string;
  creationParams?: NewSessionRequest;
  settingsManager: { setCwd(cwd: string): Promise<void> };
  fileChangeReporter?: { setWorkspace(cwd: string): void };
};

/** What the move needs from the agent: its `cwd` validation and its session
 *  fingerprint, both owned there so every caller applies the same rules. */
export type PromptCwdHost = {
  validateCwd(cwd: string): Promise<void>;
  fingerprint(creationParams: NewSessionRequest): string;
};

/**
 * The working directory a prompt asks for, from `_meta.claudeCode.cwd`.
 *
 * An absent, non-object, or non-string cwd means "no move"; an empty string
 * means the same. Anything else is returned as sent and answered by
 * `validateCwd`, so a relative or nonexistent path fails the prompt with the
 * same `invalidParams` error a session/new with that cwd would get.
 */
export function promptCwdFromMeta(meta: unknown): string | undefined {
  const claudeCode =
    meta && typeof meta === "object" && !Array.isArray(meta)
      ? (meta as Record<string, unknown>).claudeCode
      : undefined;
  const cwd =
    claudeCode && typeof claudeCode === "object" && !Array.isArray(claudeCode)
      ? (claudeCode as Record<string, unknown>).cwd
      : undefined;
  return typeof cwd === "string" && cwd !== "" ? cwd : undefined;
}

/**
 * Moves `session` to `requestedCwd` before the prompt that asked for it runs.
 *
 * Throws when the SDK of the session's query has no `set_cwd` control, the
 * directory fails the agent's `cwd` validation, the CLI refuses the move, or
 * the CLI answers `needs_trust`: the trust error names the trust root, so the
 * client can tell the user which directory to trust in Claude Code. On `ok`
 * the session state follows the directory the CLI reports. The move itself is
 * the CLI's to refuse — a turn that started between the caller's busy check
 * and this call lands here as that refusal.
 */
export async function moveSessionCwd(
  session: PromptCwdSession,
  requestedCwd: string,
  host: PromptCwdHost,
): Promise<void> {
  const query = session.query;
  if (!supportsSetCwd(query)) {
    throw RequestError.invalidRequest(
      undefined,
      "The Claude Agent SDK of this session has no set_cwd control, so the session cannot move to a new working directory. Update @anthropic-ai/claude-agent-sdk and restart the agent.",
    );
  }
  await host.validateCwd(requestedCwd);
  let response: unknown;
  try {
    response = await query.setCwd(requestedCwd);
  } catch (error) {
    throw RequestError.invalidRequest(
      { cwd: requestedCwd },
      `Claude Code refused to move the session to ${requestedCwd}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  const outcome = parseSetCwdResponse(response, requestedCwd);
  if (outcome.status === "needs_trust") {
    throw RequestError.invalidRequest(
      {
        cwd: requestedCwd,
        ...(outcome.trustRoot !== undefined ? { trustRoot: outcome.trustRoot } : {}),
      },
      outcome.trustRoot !== undefined
        ? `Claude Code has not trusted ${outcome.trustRoot}, the directory that covers ${requestedCwd}. Trust it in Claude Code, then send the prompt again.`
        : `Claude Code requires ${requestedCwd} to be a trusted directory before the session can move there. Trust it in Claude Code, then send the prompt again.`,
    );
  }
  // The CLI reports the directory it actually moved to, and the state follows
  // it rather than the request: a load/resume with the same directory then
  // matches the fingerprint and reuses the session instead of recreating it.
  const movedCwd = outcome.cwd;
  session.cwd = movedCwd;
  if (session.creationParams) {
    session.creationParams = { ...session.creationParams, cwd: movedCwd };
  }
  session.sessionFingerprint = host.fingerprint(
    session.creationParams ?? { cwd: movedCwd, mcpServers: [] },
  );
  // The workspace follows first: it cannot throw, while the settings reload
  // below can, and the roots must not stay behind the already-recorded cwd.
  session.fileChangeReporter?.setWorkspace(movedCwd);
  await session.settingsManager.setCwd(movedCwd);
}

/** Reads a `set_cwd` response off the wire. Only `status: "ok"` counts as a
 *  move: an unrecognized response fails the prompt instead of claiming a move
 *  the prompt would then run outside of. */
function parseSetCwdResponse(response: unknown, requestedCwd: string): ParsedSetCwdResponse {
  const record =
    response && typeof response === "object" && !Array.isArray(response)
      ? (response as Record<string, unknown>)
      : undefined;
  if (record?.status === "ok") {
    const cwd = record.cwd;
    return {
      status: "ok",
      cwd: typeof cwd === "string" && cwd !== "" ? cwd : requestedCwd,
    };
  }
  if (record?.status === "needs_trust") {
    const trustRoot = record.trust_root;
    return {
      status: "needs_trust",
      ...(typeof trustRoot === "string" && trustRoot !== "" ? { trustRoot } : {}),
    };
  }
  throw RequestError.internalError(
    { response },
    `Claude Code answered the move to ${requestedCwd} with an unrecognized response`,
  );
}
