/**
 * Claude Code's requests for user input that are not permission checks, as
 * ACP v2 elicitations of one session:
 *
 * - AskUserQuestion: a form, on the session of the agent that asks (the root
 *   or a subagent's child session), with the question's `toolCallId`.
 * - An MCP server's elicitation (`onElicitation`): a form or a URL. A mode
 *   that the client did not advertise is answered `cancel`.
 * - The refusal fallback's consent prompt (`onUserDialog`): a form.
 * - MCP OAuth: a URL, sent after the setup response (see `mcp-oauth.ts`).
 *
 * The first three are open requests of their session while they wait
 * (`requires_action`), and a cancel or close withdraws them with
 * `$/cancel_request`, as it does a permission request. An MCP server's URL
 * request that the user accepts stays open until Claude Code reports it
 * complete: `accept` only consents to open the URL, and the work waits for
 * the user to finish there. Building the elicitations and reading the
 * answers is shared with v1 (`elicitation.ts`).
 */
import type {
  CompleteElicitationNotification,
  CreateElicitationRequest,
  CreateElicitationResponse,
} from "@agentclientprotocol/sdk/unstable";
import type { CanUseTool, Options, Query } from "@anthropic-ai/claude-agent-sdk";
import type { Logger } from "../acp-agent.js";
import {
  answerAskUserQuestion,
  answerMcpElicitation,
  answerUserDialog,
  elicitUnlessWithdrawn,
  REFUSAL_FALLBACK_DIALOG_KIND,
  type Elicit,
  type ElicitationSupport,
} from "../elicitation.js";
import { startMcpServerAuthentication } from "../mcp-oauth.js";
import type { RequestTarget } from "./tasks.js";

/** What the elicitations need of the connection and the session. */
export interface ElicitationHost {
  readonly sessionId: string;
  readonly logger: Logger;
  /** The modes that the client advertised in `initialize`. */
  readonly support: ElicitationSupport;
  createElicitation(
    request: CreateElicitationRequest,
    signal: AbortSignal,
  ): Promise<CreateElicitationResponse>;
  completeElicitation(params: CompleteElicitationNotification): Promise<void>;
  /** The session of the agent `agentId` (see `NativeSession.target`). */
  target(agentId: string | undefined): Promise<RequestTarget>;
  /** The session's query, once it started. */
  query(): Query | undefined;
}

export class SessionElicitations {
  /** Whether Claude Code takes `annotations[question].unanswered` (`ask_user_question_unanswered_v1`). */
  private reportUnanswered = false;
  /**
   * Aborted by `session/close`: stops the MCP OAuth runs. A query that ended
   * on its own fails their next `mcpServerStatus`, which ends them too.
   */
  private readonly closed = new AbortController();
  /** The accepted URL requests that wait for their `elicitation_complete`, by elicitation id. */
  private readonly awaitingCompletion = new Map<string, Set<() => void>>();
  /** The elicitation ids that Claude Code reported complete in the open turn. */
  private readonly completedIds = new Set<string>();

  constructor(private readonly host: ElicitationHost) {}

  /**
   * The query options: the elicitation callbacks for the modes the client
   * renders. Without form elicitation AskUserQuestion is disallowed, and the
   * refusal fallback is not declared, so Claude Code ends the turn with the
   * refusal instead.
   */
  queryOptions(): Pick<
    Options,
    "onElicitation" | "onUserDialog" | "supportedDialogKinds" | "disallowedTools"
  > {
    const { support, sessionId, logger } = this.host;
    return {
      ...(support.form || support.url
        ? {
            onElicitation: async (request, { signal }) =>
              answerMcpElicitation(request, {
                sessionId,
                support,
                logger,
                elicit: this.elicit(await this.host.target(undefined), signal, true),
              }),
          }
        : {}),
      ...(support.form
        ? {
            onUserDialog: async (request, { signal }) =>
              answerUserDialog(request, {
                sessionId,
                logger,
                elicit: this.elicit(await this.host.target(undefined), signal),
              }),
            supportedDialogKinds: [REFUSAL_FALLBACK_DIALOG_KIND],
          }
        : { disallowedTools: ["AskUserQuestion"] }),
    };
  }

  /** `canUseTool` that asks AskUserQuestion's questions, and leaves the other tools to `permissions`. */
  canUseTool(permissions: CanUseTool): CanUseTool {
    return async (toolName, toolInput, options) => {
      if (toolName !== "AskUserQuestion" || !this.host.support.form) {
        return permissions(toolName, toolInput, options);
      }
      const target = await this.host.target(options.agentID);
      return answerAskUserQuestion(toolInput, {
        sessionId: target.sessionId,
        toolUseID: options.toolUseID,
        reportUnanswered: () => this.reportUnanswered,
        logger: this.host.logger,
        elicit: this.elicit(target, options.signal),
      });
    };
  }

  /** A `system/init` of the session: it lists Claude Code's capabilities. */
  init(capabilities: readonly string[] | undefined): void {
    if (capabilities?.includes("ask_user_question_unanswered_v1")) this.reportUnanswered = true;
  }

  /** Claude Code's `elicitation_complete`: a URL elicitation of an MCP server finished. */
  completed(elicitationId: string): void {
    this.completedIds.add(elicitationId);
    for (const release of this.awaitingCompletion.get(elicitationId) ?? []) release();
    if (!this.host.support.url || this.closed.signal.aborted) return;
    this.host.completeElicitation({ elicitationId }).catch((error) => {
      this.host.logger.error(`Failed to complete elicitation: ${error}`);
    });
  }

  /**
   * Starts OAuth in the background for the servers of `serverNames` that
   * Claude Code reports as `needs-auth`. Call it only once the setup
   * response is sent: v2 asks for no elicitation before it.
   */
  authenticateMcpServers(serverNames: readonly string[]): void {
    startMcpServerAuthentication(
      {
        urlElicitation: this.host.support.url,
        createElicitation: (request, signal) => this.host.createElicitation(request, signal),
        completeElicitation: (params) => this.host.completeElicitation(params),
        logger: this.host.logger,
      },
      {
        key: this,
        sessionId: this.host.sessionId,
        currentQuery: () => (this.closed.signal.aborted ? undefined : this.host.query()),
        closed: this.closed.signal,
      },
      new Set(serverNames),
    );
  }

  /** The session closes: the OAuth runs stop, and withdraw their elicitations. */
  close(): void {
    this.closed.abort();
  }

  /**
   * The open turn ended: its accepted URL requests no longer hold it. A
   * server that never reports its completion holds only its turn.
   */
  turnEnded(): void {
    for (const releases of [...this.awaitingCompletion.values()]) {
      for (const release of [...releases]) release();
    }
    this.completedIds.clear();
  }

  /**
   * Sends an elicitation as an open request of `target`. With
   * `holdAcceptedUrl`, an accepted URL request then stays open (see the
   * module doc).
   */
  private elicit(target: RequestTarget, toolSignal: AbortSignal, holdAcceptedUrl = false): Elicit {
    return (request) =>
      target.openRequest(toolSignal, async (signal) => {
        const outcome = await elicitUnlessWithdrawn(signal, (signal) =>
          this.host.createElicitation(request, signal),
        );
        const elicitationId = (request as { elicitationId?: unknown }).elicitationId;
        if (
          holdAcceptedUrl &&
          request.mode === "url" &&
          typeof elicitationId === "string" &&
          "response" in outcome &&
          outcome.response.action === "accept"
        ) {
          // Opened before this request settles, so the state stays
          // `requires_action`. Claude Code gets the answer at once: the MCP
          // server waits for the user's interaction itself.
          void target.openRequest(toolSignal, (signal) =>
            this.untilCompleted(elicitationId, signal),
          );
        }
        return outcome;
      });
  }

  /**
   * Resolves once Claude Code reports the elicitation `elicitationId`
   * complete, `signal` aborts (the tool use ended, or a cancel or close
   * withdrew it), or the turn ends.
   */
  private untilCompleted(elicitationId: string, signal: AbortSignal): Promise<void> {
    if (this.completedIds.has(elicitationId) || signal.aborted) return Promise.resolve();
    return new Promise((resolve) => {
      const releases = this.awaitingCompletion.get(elicitationId) ?? new Set<() => void>();
      this.awaitingCompletion.set(elicitationId, releases);
      const release = () => {
        signal.removeEventListener("abort", release);
        releases.delete(release);
        if (releases.size === 0) this.awaitingCompletion.delete(elicitationId);
        resolve();
      };
      signal.addEventListener("abort", release, { once: true });
      releases.add(release);
    });
  }
}
