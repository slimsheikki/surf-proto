const DASH_FX_SECONDS = 0.4;
/** Lines flash in over the front slice of the effect, then fade over the rest. */
const DASH_LINE_ATTACK_FRACTION = 0.25;

/**
 * Anime-style "dash" readout: radial speed lines from the screen edges plus a
 * few soft puffs kicked up behind the player, both driven imperatively from
 * `tick(dt)` on the fixed sim step rather than a CSS animation/wall-clock
 * timer — the same reason `Banner` does it that way, and it sidesteps the
 * usual headache of restarting a CSS keyframe animation on a rapid re-trigger
 * (dashing twice within one fade just resets `remaining`, no reflow tricks).
 */
export class DashEffect {
  private readonly root = document.getElementById('dash-fx')!;
  private readonly puffs = Array.from(document.querySelectorAll<HTMLElement>('#dash-fx .dash-puff'));
  private remaining = 0;

  trigger(): void {
    this.remaining = DASH_FX_SECONDS;
    this.root.classList.remove('hidden');
  }

  tick(dt: number): void {
    if (this.remaining <= 0) return;
    this.remaining = Math.max(this.remaining - dt, 0);
    const progress = 1 - this.remaining / DASH_FX_SECONDS; // 0 -> 1 over the effect's life

    const lineOpacity =
      progress < DASH_LINE_ATTACK_FRACTION
        ? progress / DASH_LINE_ATTACK_FRACTION
        : 1 - (progress - DASH_LINE_ATTACK_FRACTION) / (1 - DASH_LINE_ATTACK_FRACTION);
    this.root.style.setProperty('--dash-line-opacity', String(Math.max(0, lineOpacity)));

    // Punchy: full strength immediately, fading only over the back half, so the
    // puff reads as a kicked-up cloud rather than a slow fade-in.
    const puffOpacity = progress < 0.5 ? 1 : 1 - (progress - 0.5) / 0.5;
    for (const puff of this.puffs) {
      puff.style.opacity = String(Math.max(0, puffOpacity));
      puff.style.transform = `translate(-50%, ${progress * 55}px) scale(${0.5 + progress * 1.2})`;
    }

    if (this.remaining <= 0) this.root.classList.add('hidden');
  }
}
