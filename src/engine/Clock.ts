export const FIXED_DT = 1 / 128;
const MAX_FRAME_DELTA = 0.25; // clamp to avoid spiral-of-death on tab-switch/lag spikes

/**
 * Fixed-timestep accumulator. CS-style movement math is tuned for a
 * consistent dt, so gameplay ticks must never be coupled to render dt.
 */
export class FixedStepLoop {
  private accumulator = 0;
  private lastTime: number | null = null;

  /**
   * `beforeSteps` is handed the number of ticks about to run, *before* the
   * first of them. That count is not a diagnostic: mouse motion arrives once
   * per rendered frame, and at 60 fps a 128 Hz sim runs two ticks per frame, so
   * without knowing the count up front the input system hands the whole frame's
   * mouse delta to the first tick and nothing to the second.
   *
   * That halves air-strafe gain. Gain per tick is capped at
   * `AIR_SPEED_CAP - (velocity . wishDir)`, and a tick where the view does not
   * turn is a tick where that dot product has already caught up to the cap and
   * pays out nothing. Spreading the same total turn across both ticks pays out
   * on both, which is what a CS client generating one usercmd per tick does.
   */
  step(nowSeconds: number, tick: (dt: number) => void, beforeSteps?: (steps: number) => void): void {
    if (this.lastTime === null) {
      this.lastTime = nowSeconds;
      return;
    }
    let frameDelta = nowSeconds - this.lastTime;
    this.lastTime = nowSeconds;
    if (frameDelta > MAX_FRAME_DELTA) frameDelta = MAX_FRAME_DELTA;

    this.accumulator += frameDelta;
    const steps = Math.floor(this.accumulator / FIXED_DT);
    if (steps <= 0) return;
    beforeSteps?.(steps);
    for (let i = 0; i < steps; i++) {
      tick(FIXED_DT);
      this.accumulator -= FIXED_DT;
    }
  }
}
