export const FIXED_DT = 1 / 128;
const MAX_FRAME_DELTA = 0.25; // clamp to avoid spiral-of-death on tab-switch/lag spikes

/**
 * Fixed-timestep accumulator. CS-style movement math is tuned for a
 * consistent dt, so gameplay ticks must never be coupled to render dt.
 */
export class FixedStepLoop {
  private accumulator = 0;
  private lastTime: number | null = null;

  step(nowSeconds: number, tick: (dt: number) => void): void {
    if (this.lastTime === null) {
      this.lastTime = nowSeconds;
      return;
    }
    let frameDelta = nowSeconds - this.lastTime;
    this.lastTime = nowSeconds;
    if (frameDelta > MAX_FRAME_DELTA) frameDelta = MAX_FRAME_DELTA;

    this.accumulator += frameDelta;
    while (this.accumulator >= FIXED_DT) {
      tick(FIXED_DT);
      this.accumulator -= FIXED_DT;
    }
  }
}
