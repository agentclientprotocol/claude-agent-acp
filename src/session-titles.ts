/**
 * AI-generated session titles.
 *
 * Claude Code's own auto-title generation never runs under the Agent SDK — the
 * latch that arms it is pre-set in the headless path — so `SDKSessionInfo.summary`
 * degrades to the raw first prompt. This module asks the CLI for a real title
 * instead, via the `generate_session_title` control request, and publishes it
 * over ACP as a `session_info_update`.
 *
 * {@link SessionTitles} holds the per-session state and is owned by `Session`.
 * `acp-agent.ts` drives it from four places: {@link SessionTitles.onPrompt} and
 * {@link SessionTitles.onAssistantText} to collect text,
 * {@link SessionTitles.onTurnEnd} at `session_state_changed: idle`, and
 * {@link SessionTitles.reset} on `conversation_reset`.
 */

import type { ContentBlock, PromptRequest } from "@agentclientprotocol/sdk";
import { getSessionInfo, type Query, type SDKSessionInfo } from "@anthropic-ai/claude-agent-sdk";
import type { ClaudeAcpAgent, Session } from "./acp-agent.js";
import { ExplicitTitle } from "./session-index/explicit-title.js";

const MAX_TITLE_LENGTH = 256;

/** How much session text the title is generated from. The CLI caps its own
 *  title input at the same 1000 trailing characters. */
const MAX_TITLE_CONTEXT_LENGTH = 1000;

/** Below this the generator returns null without calling the model, so there is
 *  nothing to gain by asking yet. */
const MIN_TITLE_CONTEXT_LENGTH = 10;

/** `generateSessionTitle` is present on the SDK's runtime `Query` class but is
 *  not declared in `sdk.d.ts` (0.3.220), so it is reached through this optional
 *  shape rather than the published interface. */
type TitleCapableQuery = Query & {
  generateSessionTitle?: (
    description: string,
    options?: { persist?: boolean },
  ) => Promise<string | null>;
};

/** A title already stored for the session, published when generation is
 *  unavailable or yields nothing. */
type TitleFallback = { title: string; lastModified: number };

/** How much of a long text {@link sanitizeTitle} reads first. Collapsed, it
 *  is longer than a title unless it is mostly whitespace. */
const TITLE_SCAN_LENGTH = 4096;

export function sanitizeTitle(text: string): string {
  if (text.length > TITLE_SCAN_LENGTH) {
    // A stored summary can be a whole first prompt of megabytes. The title
    // depends only on the start of the text: collapsing the whitespace of a
    // prefix gives a prefix of the collapsed text. Two more characters than a
    // title hold at least one that is not a space (spaces are collapsed), so
    // the full text is longer than a title and gets the same cut.
    const head = text.slice(0, TITLE_SCAN_LENGTH).replace(/\s+/g, " ").trimStart();
    if (head.length >= MAX_TITLE_LENGTH + 2) {
      return head.slice(0, MAX_TITLE_LENGTH - 1) + "…";
    }
  }
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

/** Rolling text a title is generated from: `previous` plus `text`, keeping only
 *  the trailing {@link MAX_TITLE_CONTEXT_LENGTH} characters. */
export function appendTitleContext(previous: string | undefined, text: string): string {
  const next = (previous ?? "") + text;
  return next.length > MAX_TITLE_CONTEXT_LENGTH ? next.slice(-MAX_TITLE_CONTEXT_LENGTH) : next;
}

/** Whether this SDK still offers on-demand title generation. */
function supportsTitleGeneration(query: Query): boolean {
  return typeof (query as TitleCapableQuery).generateSessionTitle === "function";
}

/** One session's title: the text a generated title is derived from, whether a
 *  title has been settled on, and the last one published. Created with the
 *  session and reachable as `session.titles`. */
export class SessionTitles {
  /** Last title pushed to the client via `session_info_update`, so an unchanged
   *  title is never re-notified. Undefined until the first push. */
  private lastTitle?: string;

  /** Rolling tail of this session's own user + assistant text, capped at
   *  {@link MAX_TITLE_CONTEXT_LENGTH}. Dropped once a title exists. */
  private context?: string;

  /** Set once this session has a title or has asked for one. A title is
   *  generated at most once per session: the SDK reports a generated title in
   *  the same field as a user `/rename`, so re-titling could silently overwrite
   *  one. Released by {@link reset}, and when generation yields nothing. */
  private settled = false;

  /** The title a client set, which no generated title replaces. */
  private readonly explicit = new ExplicitTitle();

  /** The title last stored through {@link setExplicitTitle}, as stored
   *  (with the archive prefix of an archived session): the title the CLI
   *  holds. */
  private persistedTitle?: string;

  /** Client title changes in flight, and the title state before the first. */
  private explicitChanges = 0;
  private beforeExplicit?: { settled: boolean; context: string | undefined };

  get storedTitle(): string | undefined {
    return this.persistedTitle;
  }

  /** The title last published, as the client shows it. */
  get shownTitle(): string | undefined {
    return this.lastTitle;
  }

  constructor(
    private readonly agent: ClaudeAcpAgent,
    private readonly sessionId: string,
  ) {}

  /** Collect a prompt's own text for the title, skipping openers not worth
   *  titling after. No-op once the title is settled. */
  onPrompt(prompt: PromptRequest["prompt"]): void {
    if (this.settled) {
      return;
    }
    const promptText = prompt
      .flatMap((chunk) => (chunk.type === "text" ? [chunk.text] : []))
      .join("\n");

    this.context = appendTitleContext(this.context, `\n${promptText}\n`);
  }

  /** Collect the assistant's own answer for the title. Chunks are appended
   *  verbatim so streamed text reassembles. No-op once the title is settled. */
  onAssistantText(content: ContentBlock): void {
    if (this.settled || content.type !== "text") {
      return;
    }
    this.context = appendTitleContext(this.context, content.text);
  }

  /** Drop the title state so the next turn re-evaluates. Used on
   *  `conversation_reset`, which mounts a fresh transcript. */
  reset(): void {
    this.settled = false;
    this.explicit.reset();
    this.context = undefined;
    this.lastTitle = undefined;
    this.persistedTitle = undefined;
  }

  /** Turn-end title handling. `idle` is the SDK's turn-over signal, so it is
   *  when a title may have landed or become generatable.
   *
   *  `info.customTitle` is non-empty only once the session file holds a real
   *  title — a user `/rename` or one generated earlier; the SDK folds both into
   *  that one field. Adopt it and latch, so neither is ever titled over.
   *
   *  With no title yet, ask the SDK to generate one in the background: it is a
   *  ~2s small-model call and turn-end must not wait on it. Only when that is
   *  not possible do we fall back to `summary`, which for an SDK-driven session
   *  is just the raw first prompt. */
  async onTurnEnd(session: Session): Promise<void> {
    if (this.explicit.settledByClient) {
      // No title is generated over the one the client set, but a custom title
      // stored since by someone else (a `/rename`) is adopted, as before.
      const info = await this.readSessionInfo(session);
      // No client change is in flight, so the stored title is current; an
      // unchanged one is not published again.
      const stored = info?.customTitle;
      if (stored && this.explicit.settledByClient) {
        await this.publish(stored, info.lastModified);
      }
      return;
    }
    // While a client title change is in flight, the session info read below
    // could still hold the previous title.
    if (this.explicit.active) return;
    const info = await this.readSessionInfo(session);
    if (this.explicit.active) return;

    if (info?.customTitle) {
      this.settled = true;
      this.context = undefined;
      await this.publish(info.customTitle, info.lastModified);
      return;
    }

    const fallback = info?.summary
      ? { title: info.summary, lastModified: info.lastModified }
      : undefined;

    if (this.canRequest(session)) {
      this.settled = true;

      this.explicit.track(
        this.requestGenerateTitle(session, fallback).catch((error) => {
          this.agent.logger.error(
            `Session ${this.sessionId}: session title update failed: ${error}`,
          );
        }),
      );

      return;
    }
    // Only while this session has no title of its own: `summary` degrades to the
    // raw first prompt, which must never overwrite a generated title if the
    // persisted one is slow to show up in `info`.
    if (fallback && !this.settled) {
      await this.publish(fallback.title, fallback.lastModified);
    }
  }

  /** Applies a title that the client chose (a rename, an archive or an
   *  unarchive). Settles the title for good, waits for a generation in flight
   *  so that its persisted title cannot land after this one, persists the
   *  title with `persist`, which returns what it stored, if anything, and
   *  publishes `title` unless it is undefined. A change that stored and
   *  publishes nothing leaves the title state as it was. */
  async setExplicitTitle(
    publish: string | ((stored: string | undefined) => string) | undefined,
    persist: () => Promise<string | undefined | void>,
  ): Promise<void> {
    // The state before the first of overlapping changes, which a change that
    // fails or names nothing puts back.
    if (this.explicitChanges++ === 0) {
      this.beforeExplicit = { settled: this.settled, context: this.context };
    }
    const previous = this.beforeExplicit!;
    this.settled = true;
    this.context = undefined;
    let stored: string | undefined;
    try {
      await this.explicit.apply(
        async () => {
          stored = (await persist()) ?? undefined;
          if (stored !== undefined) this.persistedTitle = stored;
          return stored !== undefined || publish !== undefined;
        },
        () => {
          this.settled = previous.settled;
          this.context ??= previous.context;
        },
      );
    } finally {
      if (--this.explicitChanges === 0) this.beforeExplicit = undefined;
    }
    const title = typeof publish === "function" ? publish(stored) : publish;
    if (title === undefined) return;
    this.lastTitle = title;
    await this.agent.client.sessionUpdate({
      sessionId: this.sessionId,
      update: { sessionUpdate: "session_info_update", title },
    });
  }

  /** Records a title the CLI took, as soon as it took it. */
  rememberStoredTitle(title: string): void {
    this.persistedTitle = title;
  }

  /** Read the SDK's stored info for this session. A missing session file or read
   *  error is non-fatal: the title is best-effort and another turn will retry. */
  private async readSessionInfo(session: Session): Promise<SDKSessionInfo | undefined> {
    try {
      return await getSessionInfo(this.sessionId, { dir: session.cwd });
    } catch (error) {
      this.agent.logger.error(`Session ${this.sessionId}: failed to read session info: ${error}`);
      return undefined;
    }
  }

  /** Notify the client of a title, unless it is the one we last sent. */
  private async publish(rawTitle: string, lastModified: number): Promise<void> {
    const title = sanitizeTitle(this.agent.clientTitle?.(rawTitle) ?? rawTitle);
    if (title === this.lastTitle) {
      return;
    }
    this.lastTitle = title;
    await this.agent.client.sessionUpdate({
      sessionId: this.sessionId,
      update: {
        sessionUpdate: "session_info_update",
        title,
        updatedAt: new Date(lastModified).toISOString(),
      },
    });
  }

  /** Whether to ask the SDK for a generated title now: once per session, on a
   *  live query, with enough collected text for the generator to work with. */
  private canRequest(session: Session): boolean {
    if (this.settled || session.queryClosed || session.cancelled) {
      return false;
    }
    if (!supportsTitleGeneration(session.query)) {
      return false;
    }
    return (this.context?.trim().length ?? 0) >= MIN_TITLE_CONTEXT_LENGTH;
  }

  /** Generate a title from the session's own text and publish it. `persist`
   *  writes it to the session file, which is what carries it into
   *  `session/list` and `session/load`. A null or failed generation releases the
   *  latch so a later turn retries, and publishes `fallback` (the stored
   *  summary) so a backend that can't generate titles is no worse off than
   *  before. */
  private async requestGenerateTitle(
    session: Session,
    fallback: TitleFallback | undefined,
  ): Promise<void> {
    const description = this.context?.trim() ?? "";
    let title: string | null = null;

    try {
      title =
        (await (session.query as TitleCapableQuery).generateSessionTitle?.(description, {
          persist: true,
        })) ?? null;
    } catch (error) {
      this.agent.logger.error(
        `Session ${this.sessionId}: failed to generate a session title: ${error}`,
      );
    }

    // A session torn down or replaced while the title was in flight must not
    // adopt it, and a title the client set meanwhile wins.
    if (this.agent.sessions[this.sessionId] !== session || this.explicit.active) {
      return;
    }

    if (!title) {
      this.settled = false;

      if (fallback) {
        await this.publish(fallback.title, fallback.lastModified);
      }
      return;
    }

    this.context = undefined;
    await this.publish(title, Date.now());
  }
}
