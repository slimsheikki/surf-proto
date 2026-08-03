/**
 * Passive XP for holding real speed — the "flow" in MEGAFLOW.
 *
 * Surfing already pays in ultimate charge; this is a second, deliberately
 * smaller dividend: keep genuine speed up and the XP bar creeps on its own.
 * Two constraints shape everything here, both descended from the project's
 * one-line brief (combat must never make the player stop surfing):
 *
 * - **It rewards *sustained* speed, not a spike.** `flow` spools from 0 to 1
 *   over FLOW_BUILD_SECONDS above the floor and drains roughly 3x faster below
 *   it, so a single fast hop pays almost nothing while a held line pays in
 *   full — and losing the line costs the multiplier within a second and a
 *   half.
 * - **It must never compete with killing.** The payout is a percentage of the
 *   *current* level requirement per second, so it scales itself to any level
 *   without retuning, and the cap keeps even an extreme sustained 60 u/s line
 *   at 45+ seconds per level. A single drone is 3 XP — around a tenth of a
 *   mid-game bar — so one kill outpays tens of seconds of flow at typical
 *   speeds. Enemies stay the food; flow is seasoning on a good line.
 *
 * Speed here is the controller's horizontal `speed`, the same measure the
 * ultimate charges on: a straight-down plummet builds no flow, converting the
 * drop along a face does.
 */

/**
 * Below this, no flow builds. More than double the walk cap (7, upgradeable to
 * ~11), and the grounded clamp caps *actual* velocity at the walk cap, so flow
 * is unreachable on foot by construction — even a walk-speed dash (7 + 8
 * impulse) lands just under it. It can only be surfed for.
 */
const FLOW_MIN_SPEED = 16;
/** Seconds of qualifying speed to reach full flow. */
const FLOW_BUILD_SECONDS = 4;
/** Seconds from full flow to empty once the speed is gone. */
const FLOW_DRAIN_SECONDS = 1.5;
/**
 * % of the level bar per second, per u/s above the floor, at full flow:
 * 30 u/s pays 0.7%/s, 40 u/s pays 1.2%/s.
 */
const FLOW_XP_PCT_PER_UNIT = 0.05;
/** Ceiling on the payout — reached at 60 u/s, i.e. ~45 s per level flat out. */
const FLOW_XP_PCT_CAP = 2.2;

export class FlowXP {
  /**
   * 0..1 — how established the current run of speed is. Public because it
   * travels in `Rewind`'s `Frame`: the XP it granted rides `LevelSnapshot`,
   * so the meter that granted it has to ride alongside or a rewind would hand
   * back full-rate flow the player had not re-earned (or confiscate one they
   * had).
   */
  flow = 0;
  /**
   * What flow is paying right now, in % of the level bar per second, before
   * the XP multiplier. The HUD shows it beside the speed readout so the
   * mechanic is legible without a new element.
   */
  ratePctPerSecond = 0;

  /**
   * Advances the meter and returns this tick's payout rate, in %/s of
   * `xpToNext`.
   *
   * The two optional multipliers are Aurora Wake's: `rateMultiplier` scales
   * the payout and is applied AFTER the cap — at 60+ u/s the perk still pays,
   * rather than being dead exactly where flow is strongest — and
   * `drainTimeMultiplier` stretches how long the glow survives below the
   * floor. Defaults keep every existing call site (and probe) bit-identical.
   */
  tick(dt: number, speed: number, rateMultiplier = 1, drainTimeMultiplier = 1): number {
    if (speed >= FLOW_MIN_SPEED) {
      this.flow = Math.min(1, this.flow + dt / FLOW_BUILD_SECONDS);
    } else {
      this.flow = Math.max(0, this.flow - dt / (FLOW_DRAIN_SECONDS * drainTimeMultiplier));
    }
    const excess = Math.max(0, speed - FLOW_MIN_SPEED);
    this.ratePctPerSecond =
      Math.min(FLOW_XP_PCT_CAP, excess * FLOW_XP_PCT_PER_UNIT) * this.flow * rateMultiplier;
    return this.ratePctPerSecond;
  }

  /** For the rewind recorder: the meter is the one piece of state here. */
  capture(): number {
    return this.flow;
  }

  restore(flow: number): void {
    this.flow = flow;
    // Recomputed on the next gameplay tick; zeroed rather than left stale so
    // the HUD does not advertise a payout while the world is frozen or
    // rewinding.
    this.ratePctPerSecond = 0;
  }

  reset(): void {
    this.flow = 0;
    this.ratePctPerSecond = 0;
  }
}
