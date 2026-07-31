/** Tunable CS-surf-style movement constants. Tune by feel, not by theory. */
export const MovementConfig = {
  GROUND_ACCEL: 10, // sv_accelerate
  AIR_ACCEL: 12, // sv_airaccelerate — the clamp below is what limits it, not this
  MAX_GROUND_SPEED: 7, // sv_maxspeed
  MAX_AIR_WISH_SPEED: 0.6, // small clamp that makes air-strafe speed gain possible at all
  FRICTION: 6, // sv_friction
  STOP_SPEED: 1.5, // sv_stopspeed
  GRAVITY: -20,
  JUMP_SPEED: 6.5,
  GROUND_PROBE_DIST: 0.3,
  MAX_SLOPE_WALKABLE_DEG: 45, // steeper than this = ramp/slide surface, not walkable ground
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
