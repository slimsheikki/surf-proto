/**
 * The shared 3-2-1 that hands control back to the player.
 *
 * Two things end with a frozen world and a player who needs a moment to find
 * the ramp again: a ReWind, and cashing in banked powers. Both count back in
 * through this, which is the whole reason it lives outside `UltimateEffect` —
 * the purple flames and the `REWIND` label belong to the ultimate, but the
 * digit does not, and a level-up that dragged the ultimate's identity onto the
 * screen with it would be reading the wrong thing to the player.
 *
 * Driven from the fixed sim tick like `Banner` and `DashEffect`, so it obeys
 * whatever pause the rest of the game is under.
 */

/**
 * Seconds per beat.
 *
 * A full second each reads as a proper "3... 2... 1..." and, more usefully,
 * buys the player time to work out where they are before the world starts
 * moving again — they are usually mid-air on a ramp when it starts.
 */
const COUNTDOWN_BEAT_SECONDS = 1;
const COUNTDOWN_BEATS = 3;
export const COUNTDOWN_SECONDS = COUNTDOWN_BEAT_SECONDS * COUNTDOWN_BEATS;

export class Countdown {
  private readonly root = document.getElementById('countdown')!;
  private readonly digitEl = document.getElementById('countdown-digit')!;

  begin(): void {
    this.digitEl.textContent = '';
    this.digitEl.classList.remove('beat');
    this.root.classList.remove('hidden');
  }

  /**
   * `remaining` counts down from {@link COUNTDOWN_SECONDS}, so the digit shown
   * is the number of whole beats left — 3 for the first second, then 2, then 1,
   * and never 0 (the panel is torn down the moment it would be).
   */
  set(remaining: number): void {
    const beat = Math.max(
      1,
      Math.min(COUNTDOWN_BEATS, Math.ceil(remaining / COUNTDOWN_BEAT_SECONDS)),
    );
    if (this.digitEl.textContent === String(beat)) return;
    this.digitEl.textContent = String(beat);
    // Restart the pop by re-adding the class on a changed digit. This is the one
    // place a keyframe restart is wanted, and it is safe here because the digit
    // only changes once a second.
    this.digitEl.classList.remove('beat');
    void this.digitEl.offsetWidth;
    this.digitEl.classList.add('beat');
  }

  end(): void {
    this.root.classList.add('hidden');
    this.digitEl.textContent = '';
    this.digitEl.classList.remove('beat');
  }

  /** Same teardown, named for the restart path that calls it. */
  reset(): void {
    this.end();
  }
}
