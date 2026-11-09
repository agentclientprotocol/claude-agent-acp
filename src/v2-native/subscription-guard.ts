/**
 * The `--hide-claude-auth` subscription guard on the native core: this
 * integration never bills a claude.ai subscription. The policy is the v1
 * core's (`hide-claude-auth.ts`), which the bridge applies to v2 sessions:
 *
 * - It holds while the flag is on and no provider or gateway login routes
 *   the traffic away from the CLI's own login.
 * - A session does not start on an account that a subscription would pay
 *   for (`authRequired` with the `claude_subscription_not_supported`
 *   reason), or that holds no credential this integration accepts
 *   (`authRequired`).
 * - Each prompt reads the account that the query cached at its start, and is
 *   refused, before it is inserted, on the same terms.
 * - The cached account goes stale when the user signs out or logs in
 *   elsewhere. A turn that fails for a missing login, or an auth status
 *   probe that finds another kind of identity than the session started on,
 *   restarts the query at the next prompt that finds the session idle (see
 *   `restarts.ts`), so its start judges the current account.
 *
 * The `/remote-control` command that the adapter runs is not guarded, as on
 * the bridge, where it answers before the guard runs.
 */
import type { AccountInfo, Query } from "@anthropic-ai/claude-agent-sdk";
import type { Logger } from "../acp-agent.js";
import { type AuthStatusKind, fromAccountInfo } from "../auth-status.js";
import {
  billsClaudeSubscription,
  claudeLoginRequiredError,
  type ClaudeSubscriptionGuardState,
  claudeSubscriptionNotSupportedError,
  holdsNonSubscriptionCredential,
  refuseClaudeSubscriptionTurn,
  shouldHideClaudeAuth,
  warnClaudeSubscriptionGuardDegraded,
} from "../hide-claude-auth.js";

/** What the guard needs of the connection's auth state (`NativeAuth`). */
export interface GuardAuth {
  /** Whether a provider or a gateway login routes the traffic. */
  overridesRoute(): boolean;
  /** Reports the account a session's query cached, as the identity. */
  publishAccount(sessionId: string, account: AccountInfo): void;
}

type GuardedSession = {
  state: ClaudeSubscriptionGuardState;
  /** The kind of identity the session's query started on, if its account told. */
  kind: AuthStatusKind | undefined;
};

export class SubscriptionGuard {
  private readonly sessions = new Map<string, GuardedSession>();

  constructor(
    private readonly auth: GuardAuth,
    private readonly logger: Logger,
    /** The session's account may have changed: restart it at its next prompt. */
    private readonly accountMayHaveChanged: (sessionId: string) => void,
  ) {}

  /** Whether the guard holds now (see the module doc). */
  active(): boolean {
    return shouldHideClaudeAuth() && !this.auth.overridesRoute();
  }

  /**
   * A session's query started on `account`. Throws the refusal when the
   * guard holds and the account is one it refuses.
   */
  sessionStarted(sessionId: string, account: AccountInfo | undefined, apiKeyHelper?: string): void {
    const session: GuardedSession = {
      state: {},
      kind: fromAccountInfo(account, apiKeyHelper)?.kind,
    };
    if (this.active()) {
      if (!account) {
        warnClaudeSubscriptionGuardDegraded({
          sessionId,
          guardState: session.state,
          logger: this.logger,
          cause: "the CLI reported no account at initialize",
        });
      } else if (billsClaudeSubscription(account)) {
        throw claudeSubscriptionNotSupportedError();
      } else if (!holdsNonSubscriptionCredential(account)) {
        throw claudeLoginRequiredError();
      }
    }
    this.sessions.set(sessionId, session);
  }

  /**
   * A prompt of `sessionId` is about to go to `query`: rejects with the
   * refusal when the guard holds and refuses the cached account. `undefined`
   * while the guard is off, so the prompt goes on in the same call.
   */
  beforePrompt(sessionId: string, query: Pick<Query, "accountInfo">): Promise<void> | undefined {
    if (!this.active()) return undefined;
    let session = this.sessions.get(sessionId);
    if (!session) this.sessions.set(sessionId, (session = { state: {}, kind: undefined }));
    return refuseClaudeSubscriptionTurn({
      sessionId,
      query,
      guardState: session.state,
      logger: this.logger,
      // The guard reads the account anyway: it keeps the identity current.
      onAccount: (account) => this.auth.publishAccount(sessionId, account),
    });
  }

  /** A turn of `sessionId` failed for a missing login: the user signed out. */
  signedOut(sessionId: string): void {
    if (shouldHideClaudeAuth()) this.accountMayHaveChanged(sessionId);
  }

  /** An auth status probe read `kind`: a session started on another kind restarts. */
  probed(kind: AuthStatusKind): void {
    if (!this.active()) return;
    for (const [sessionId, session] of this.sessions) {
      // No kind: the account said nothing that this read could contradict.
      if (session.kind && session.kind !== kind) this.accountMayHaveChanged(sessionId);
    }
  }

  sessionEnded(sessionId: string): void {
    this.sessions.delete(sessionId);
  }
}
