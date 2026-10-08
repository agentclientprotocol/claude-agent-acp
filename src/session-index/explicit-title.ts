/**
 * The client-set title of a session (`_session/rename`), as `SessionTitles`
 * guards it against generated titles: once a client named the session, or
 * while a rename is in flight, no generated title is adopted, and a rename
 * waits for a generation in flight, whose persisted title would otherwise
 * land after it.
 */
export class ExplicitTitle {
  /** Set once a client named the session. Released by {@link reset}. */
  private named = false;
  /** Renames in flight. */
  private pending = 0;
  /** The title generation in flight. */
  private generation?: Promise<void>;

  /** Whether a generated title must not be adopted. */
  get active(): boolean {
    return this.named || this.pending > 0;
  }

  reset(): void {
    this.named = false;
  }

  /** Tracks a title generation until it ends. */
  track(generation: Promise<void>): void {
    this.generation = generation;
    void generation.finally(() => {
      if (this.generation === generation) this.generation = undefined;
    });
  }

  /** Persists a client title after the generation in flight. `persist`
   *  tells whether the session is named now. When it fails or names nothing
   *  (an archive of an archived session), and no other rename named the
   *  session, `restore` puts the title state back, so a later turn may still
   *  generate a title. */
  async apply(persist: () => Promise<boolean>, restore: () => void): Promise<void> {
    this.pending++;
    try {
      await this.generation;
      if (await persist()) this.named = true;
      else if (!this.named && this.pending === 1) restore();
    } catch (error) {
      if (!this.named && this.pending === 1) restore();
      throw error;
    } finally {
      this.pending--;
    }
  }
}
