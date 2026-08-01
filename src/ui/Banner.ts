/**
 * A transient headline across the middle of the screen.
 *
 * This replaces the victory screen, and the replacement is the point. Killing
 * a Monolith used to end the run and hand the player a panel with a button on
 * it; now it is a milestone in a run that does not end, so it gets an
 * announcement that does not stop anything — no pause, no pointer-lock
 * handover, no click required. The player is very likely mid-air on a ramp
 * when it fires, and anything that took the controls away at that moment would
 * drop them off the course as its reward for winning.
 *
 * Timing is driven from the fixed-step tick rather than a `setTimeout`, for the
 * same reason everything else in the game loop is: a timer that keeps running
 * while the game is paused would expire behind a level-up menu.
 */
export class Banner {
  private readonly root = document.getElementById('banner')!;
  private readonly titleEl = document.getElementById('banner-title')!;
  private readonly subtitleEl = document.getElementById('banner-subtitle')!;

  private remaining = 0;

  show(title: string, subtitle: string, seconds: number): void {
    this.titleEl.textContent = title;
    this.subtitleEl.textContent = subtitle;
    this.remaining = seconds;
    this.root.classList.remove('hidden');
  }

  tick(dt: number): void {
    if (this.remaining <= 0) return;
    this.remaining -= dt;
    // Fades over its last second, so it leaves without a visible pop.
    this.root.style.opacity = String(Math.max(0, Math.min(1, this.remaining)));
    if (this.remaining <= 0) this.hide();
  }

  hide(): void {
    this.remaining = 0;
    this.root.style.opacity = '1';
    this.root.classList.add('hidden');
  }
}
