/**
 * The ultimate charge meter that gates ReWind.
 *
 * It is charged by the three things the game wants the player doing — going
 * fast, staying in the air, and killing — and by nothing else. That is the
 * whole design brief of this project restated as an economy: the combat layer
 * must never make you stop surfing to fight, so the ability that rescues a
 * botched line is paid for by surfing well, not by farming.
 *
 * ## Why the requirement scales with level
 *
 * Two of the three sources inflate over a run and one does not:
 *
 * - **Kills** inflate hard. `Difficulty` raises spawn interval, batch size and
 *   the live cap with level, and the player's weapon grows too, so kills per
 *   second at level 20 are several times what they are at level 1.
 * - **Speed** inflates mildly — the move-speed upgrade lifts the air wish cap,
 *   which does raise what a good line tops out at.
 * - **Air time** does not inflate at all. A ramp is a ramp.
 *
 * Left unscaled, the meter would take ~45 s early and ~15 s late, and a rewind
 * every fifteen seconds is not an ultimate. So every gain is divided by
 * `levelScale`, which is a straight line in level. That deliberately makes the
 * *late* game lean more on surfing than on killing to charge: the kill term is
 * the one being deflated hardest relative to its own growth, which is the
 * balance this game wants anyway.
 *
 * All three constants are expressed as **fraction of the bar per second at
 * level 1**, so they can be read as a budget: a strong line at ~28 u/s, mostly
 * airborne, killing roughly one enemy a second, earns about
 * `0.0110 + 0.0060 + 0.0055 = 0.0225` per second and fills in ~44 s. Walking
 * around at 7 u/s killing nothing earns nothing at all.
 */

/** Speed below which surfing earns nothing. `MAX_GROUND_SPEED` — you have to beat a walk. */
const SPEED_FLOOR = 7;
/** Fraction of the bar per second, per u/s above the floor. 21 u/s over the floor pays 0.0110/s. */
const CHARGE_PER_SPEED_UNIT = 0.00052;
/** Fraction of the bar per second while airborne — the surf tax rebate. */
const CHARGE_PER_AIR_SECOND = 0.006;
/** Fraction of the bar per kill. */
const CHARGE_PER_KILL = 0.0055;

/**
 * Requirement growth per level, as a fraction of the level-1 requirement.
 *
 * Not picked by feel — it is lifted straight from the term it has to cancel.
 * `difficultyAt` divides the spawn interval by `1 + 0.07 * (level - 1)`, so
 * using the same 0.07 here makes the kill term's contribution **level-neutral
 * by construction**: twice the drones arriving means twice the requirement, and
 * a kill is worth the same fraction of a bar at level 30 as at level 1. If that
 * divisor in `Difficulty.ts` is ever retuned, this should move with it.
 *
 * The two terms it does *not* cancel are the ones that should drift. Air time
 * is flat over a run (a ramp is a ramp) and speed grows only a little, so both
 * are slowly deflated by the rising requirement — which is why the meter takes
 * a shade longer late. That is the right direction: a rewind is worth far more
 * at level 30, where dying costs half an hour, than at level 2.
 *
 * Measured against modelled kill rates of 1.0/s at level 1, 3.5/s at 10 and
 * 5.5/s at 20 (spawn rate, discounted for escapes): 45 s, 44 s, 46 s to fill.
 */
const LEVEL_GROWTH = 0.07;

export class Ultimate {
  /** 0..1. The HUD bar reads this directly. */
  charge = 0;

  /**
   * Level scale captured on the most recent `tick`, so `registerKill` — which
   * fires later in the same tick, from the entity cull — is paid at the same
   * rate as the surfing that tick.
   */
  private levelScale = 1;

  tick(dt: number, speed: number, airborne: boolean, level: number): void {
    this.levelScale = 1 + LEVEL_GROWTH * Math.max(0, level - 1);
    if (this.charge >= 1) return;

    let gain = Math.max(0, speed - SPEED_FLOOR) * CHARGE_PER_SPEED_UNIT;
    if (airborne) gain += CHARGE_PER_AIR_SECOND;
    this.add(gain * dt);
  }

  registerKill(): void {
    this.add(CHARGE_PER_KILL);
  }

  private add(amount: number): void {
    this.charge = Math.min(1, this.charge + amount / this.levelScale);
  }

  get isReady(): boolean {
    return this.charge >= 1;
  }

  /**
   * Spends the whole bar. Called the moment ReWind activates rather than when
   * it finishes, so letting go of R after half a second still costs the
   * ultimate — the ability is a commitment, and a free "peek at the last 15
   * seconds" would be a different (and much worse) mechanic.
   */
  consume(): void {
    this.charge = 0;
  }

  reset(): void {
    this.charge = 0;
    this.levelScale = 1;
  }
}
