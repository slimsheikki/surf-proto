/**
 * Tunable CS-surf-style movement constants.
 *
 * The whole set is pinned to one scale: **1 game unit = 45 Hammer units**, which
 * falls out of matching CS's `sv_maxspeed` 320 to a 7 u/s walk (320/45.7). Every
 * other quantity below is the CS value divided by that same factor, so ramp
 * angles and dimensions taken from real surf maps transfer directly. Keep the
 * scale consistent when retuning: mixing scales is what made gravity wrong here
 * originally (it was set to 20, i.e. 800/40, which is ~12% heavy for a 45 hu
 * speed scale and made ramps shed the player faster than CS does).
 */
export const MovementConfig = {
  GROUND_ACCEL: 10, // sv_accelerate
  AIR_ACCEL: 12, // sv_airaccelerate — the clamp below is what limits it, not this
  MAX_GROUND_SPEED: 7, // sv_maxspeed 320 / 45.7
  MAX_AIR_WISH_SPEED: 0.6, // ~30 u/s air-accel clamp; the reason air-strafing gains speed
  FRICTION: 6, // sv_friction
  STOP_SPEED: 1.5, // sv_stopspeed
  GRAVITY: -17.8, // CS gravity 800 / 45
  JUMP_SPEED: 6.7, // CS jump ~301 u/s -> ~57 hu apex, matched at this gravity
  GROUND_PROBE_DIST: 0.3,
  /**
   * Source treats a surface as standable when its normal.y >= 0.7, i.e. up to
   * acos(0.7) = 45.573 deg. Anything steeper never grounds the player, so they
   * stay in the airborne state where air-strafing works — that threshold is
   * exactly what makes a surf ramp surfable, so it is matched precisely rather
   * than rounded to 45.
   */
  MAX_SLOPE_WALKABLE_DEG: 45.573,
  /** Jump fires every tick while grounded and held, chaining hops with zero landing friction. */
  AUTO_BHOP: true,
  PLAYER_RADIUS: 0.4,
  PITCH_LIMIT_DEG: 89,
};

/**
 * Snapshot of the authored defaults, taken at module load before any gameplay
 * code can touch them. `MovementConfig` is a mutable singleton that the upgrade
 * system writes into (MAX_GROUND_SPEED, MAX_AIR_WISH_SPEED, JUMP_SPEED, ...),
 * so without this the buffs from one run would carry into the next and compound
 * across restarts forever.
 */
const DEFAULTS: typeof MovementConfig = { ...MovementConfig };

/**
 * Restores every tuning field to its authored default. Call this whenever a run
 * is (re)started, before any upgrades are applied.
 *
 * This copies the whole config rather than an explicit list of "upgradeable"
 * fields, so it keeps working when someone adds a new upgrade that mutates a
 * field nobody thought of.
 */
export function resetMovementConfig(): void {
  Object.assign(MovementConfig, DEFAULTS);
}
