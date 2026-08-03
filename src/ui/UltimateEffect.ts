/**
 * Every visual the ReWind ultimate owns: the activation burst, the purple
 * flames that hold for the length of the rewind, and the seconds readout.
 *
 * Not the 3-2-1 that follows it — that is `Countdown`, and it is shared with
 * the banked-power selector, which resumes the same way and has no business
 * wearing the ultimate's colours.
 *
 * Driven imperatively from `tick(dt)` on the fixed sim step, like `Banner` and
 * `DashEffect` and for the same two reasons. A CSS `@keyframes` animation needs
 * a forced-reflow hack to restart on a rapid re-trigger, and — the one that
 * matters more here — the rewind has no fixed duration. It lasts exactly as
 * long as the player holds the button, so nothing about it can be expressed as
 * a timed animation in the first place.
 *
 * The one exception is the *idle* flicker of the flames, which is a CSS
 * animation: it loops forever, never retriggers, and wants to be free-running
 * rather than locked to the sim.
 */

/** Life of the expanding shockwave ring. Short — it is punctuation, not an effect. */
const BURST_SECONDS = 0.55;
/**
 * Fraction of the burst over which the full-screen wash decays.
 *
 * Much shorter than the ring on purpose. The ring gives the activation its
 * shape and the wash gives it its hit, and if the two decay together they read
 * as one soft purple event instead of a blast.
 */
const FLASH_FRACTION = 0.3;
/** Peak opacity of that wash. Enough to feel, short of blinding. */
const FLASH_PEAK = 0.62;
/** How long the flames take to climb in and fall away either side of the rewind. */
const FLAME_FADE_SECONDS = 0.35;

export class UltimateEffect {
  private readonly root = document.getElementById('ult-fx')!;
  private readonly burstEl = document.getElementById('ult-burst')!;
  private readonly flamesEl = document.getElementById('ult-flames')!;
  private readonly labelEl = document.getElementById('ult-label')!;
  private readonly secondsEl = document.getElementById('ult-seconds')!;

  private burstRemaining = 0;
  /** 0..1, ramped toward `flameTarget`. Held at 1 for the whole rewind. */
  private flame = 0;
  private flameTarget = 0;
  private mode: 'off' | 'rewinding' | 'countdown' = 'off';

  /** Fires the activation flash and starts the flames climbing. */
  beginRewind(): void {
    this.mode = 'rewinding';
    this.burstRemaining = BURST_SECONDS;
    this.flameTarget = 1;
    this.root.classList.remove('hidden');
    this.labelEl.textContent = '◀◀ REWIND';
  }

  /** Live readout of how far back the playback head has scrubbed. */
  setRewoundSeconds(seconds: number): void {
    this.secondsEl.textContent = `-${seconds.toFixed(1)}s`;
  }

  /**
   * The rewind is over and `Countdown` has the digit. The flames stay up for
   * the three beats — the ultimate is still the reason the world is stopped.
   */
  setResuming(): void {
    this.mode = 'countdown';
    this.labelEl.textContent = 'RESUMING';
  }

  /** Lets the flames fall away and hides the panel once they have. */
  end(): void {
    this.mode = 'off';
    this.flameTarget = 0;
    this.labelEl.textContent = '';
    this.secondsEl.textContent = '';
  }

  tick(dt: number): void {
    if (this.mode === 'off' && this.flame <= 0 && this.burstRemaining <= 0) return;

    if (this.burstRemaining > 0) {
      this.burstRemaining = Math.max(this.burstRemaining - dt, 0);
      const progress = 1 - this.burstRemaining / BURST_SECONDS;
      // Snap to full instantly and decay — a burst that ramps up is a bloom,
      // not an impact.
      this.burstEl.style.setProperty('--ult-burst', String(1 - progress));
      this.burstEl.style.setProperty('--ult-burst-scale', String(0.15 + progress * 1.85));
      const flash = Math.max(0, 1 - progress / FLASH_FRACTION) * FLASH_PEAK;
      this.root.style.setProperty('--ult-flash', flash.toFixed(3));
    } else {
      this.burstEl.style.setProperty('--ult-burst', '0');
      this.root.style.setProperty('--ult-flash', '0');
    }

    const step = dt / FLAME_FADE_SECONDS;
    if (this.flame < this.flameTarget) this.flame = Math.min(this.flameTarget, this.flame + step);
    else if (this.flame > this.flameTarget) this.flame = Math.max(this.flameTarget, this.flame - step);
    this.flamesEl.style.setProperty('--ult-flame', this.flame.toFixed(3));
    this.root.style.setProperty('--ult-tint', (this.flame * 0.55).toFixed(3));

    if (this.mode === 'off' && this.flame <= 0 && this.burstRemaining <= 0) {
      this.root.classList.add('hidden');
    }
  }

  /** Hard reset for a restart — no fade, nothing left on screen. */
  reset(): void {
    this.mode = 'off';
    this.flame = 0;
    this.flameTarget = 0;
    this.burstRemaining = 0;
    this.root.classList.add('hidden');
    this.root.style.setProperty('--ult-flash', '0');
    this.labelEl.textContent = '';
    this.secondsEl.textContent = '';
  }
}
