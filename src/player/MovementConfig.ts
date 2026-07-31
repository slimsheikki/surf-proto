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
