/**
 * Tunable CS:S movement constants.
 *
 * The whole set is pinned to one scale: **1 game unit = 45 Hammer units**, which
 * falls out of matching CS's `sv_maxspeed` 320 to a 7 u/s walk (320/45.7). Every
 * other quantity below is the CS value divided by that same factor, so ramp
 * angles and dimensions taken from real surf maps transfer directly. Keep the
 * scale consistent when retuning: mixing scales is what made gravity wrong here
 * originally (it was set to 20, i.e. 800/40, which is ~12% heavy for a 45 hu
 * speed scale and made ramps shed the player faster than CS does).
 *
 * Every field carries the Hammer-unit value it was derived from in its comment.
 * When adding a knob, write the CS convar it corresponds to — the point of this
 * file is that a surfer can read it and recognise their config.
 */
export const MovementConfig = {
  /**
   * How much of gravity the Glider leaves you paying while you hold jump,
   * airborne and descending. **1 = the Cartridge is unowned**, which is why
   * this is a multiplier rather than a flag: with nothing taken the whole
   * feature costs one multiply by one.
   *
   * Floored at 0.25 by the Cartridge and never allowed to reach 0 — a true
   * float would let a player park in the air and wait a wave out, and this
   * game has no standing still in it.
   *
   * Not a CS convar. Nothing in Source does this; it is ours.
   */
  GLIDE_GRAVITY_SCALE: 1,
  /** `sv_accelerate` 5 (CS:S default; HL2's 10 made ground movement twitchier than CS). */
  GROUND_ACCEL: 5,
  /**
   * `sv_airaccelerate`. CS:S ships 10, but essentially every CS:S surf server
   * runs 100 — at 100 the per-tick air gain is limited purely by the 30 hu
   * `AIR_SPEED_CAP` below, which is the snappy strafe response surfers expect.
   * At 10 the cap is never reached (10 x 320 / 128 = 25 hu) and ramps feel slow
   * to build on.
   */
  AIR_ACCEL: 100,
  /** `sv_maxspeed` 320 / 45.7. Also the `wishspeed` fed to both accelerators. */
  MAX_GROUND_SPEED: 7,
  /**
   * Source's hard-coded air-acceleration clamp: `if (wishspd > 30) wishspd = 30`.
   * 30 hu / 45 = 0.6667. This is the ceiling on how much velocity may be added
   * *along the wish direction* per tick — and because the acceleration magnitude
   * is computed from the UNCAPPED wishspeed, it is exactly what makes
   * air-strafing gain speed without bound. See `airAccelerate`.
   */
  MAX_AIR_WISH_SPEED: 30 / 45,
  /** `sv_friction` 4. */
  FRICTION: 4,
  /** `sv_stopspeed` 75 / 45. */
  STOP_SPEED: 75 / 45,
  /** `sv_gravity` 800 / 45. */
  GRAVITY: -800 / 45,
  /**
   * `sqrt(2 * sv_gravity * GAMEMOVEMENT_JUMP_HEIGHT)` = sqrt(2 x 800 x 57)
   * = 301.993 hu/s, the canonical Source jump velocity, / 45.
   */
  JUMP_SPEED: 301.99337 / 45,
  /** `sv_maxvelocity` 3500 / 45, clamped per axis by `checkVelocity`. */
  MAX_VELOCITY: 3500 / 45,
  /**
   * `NON_JUMP_VELOCITY` 140 / 45. Above this rising speed `CategorizePosition`
   * refuses to ground the player at all, which is what stops the tick after a
   * jump from immediately re-grounding and eating the jump.
   */
  NON_JUMP_VELOCITY: 140 / 45,
  /**
   * `CategorizePosition` traces exactly 2 hu down to decide "am I standing on
   * something". 2 / 45. Note this is far shorter than the old 0.3 (13.5 hu)
   * probe — a long probe grounds a player who is genuinely airborne.
   */
  GROUND_TRACE_DIST: 2 / 45,
  /**
   * `player->GetStepSize()` 18 / 45, the reach of `StayOnGround`. After a
   * grounded move Source pulls the player back down onto a walkable surface
   * within one step height, which is what keeps you glued to shallow slopes and
   * stairs instead of tapping down them like a dropped ball.
   */
  STEP_SIZE: 18 / 45,
  /**
   * Source treats a surface as standable when its normal.y >= 0.7, i.e. up to
   * acos(0.7) = 45.573 deg. Anything steeper never grounds the player, so they
   * stay in the airborne state where air-strafing works — that threshold is
   * exactly what makes a surf ramp surfable, so it is matched precisely rather
   * than rounded to 45.
   */
  MAX_SLOPE_WALKABLE_DEG: 45.573,
  /**
   * Jump fires every tick while grounded and held, chaining hops with zero
   * landing friction.
   *
   * Vanilla CS:S does NOT do this — `CheckJumpButton` early-outs on
   * `m_nOldButtons & IN_JUMP`, so every hop needs a fresh press and a perfectly
   * timed one at that. Left on by default because this is a game about flow,
   * but it is a knob so the vanilla feel can be compared directly.
   */
  AUTO_BHOP: true,
  /**
   * Half the CS player hull width (32 hu wide -> 16 hu). Kept at 0.4 (18 hu) for
   * now rather than 16/45, so this version changes only the movement maths and
   * not the size of the thing being moved.
   */
  PLAYER_RADIUS: 0.4,
  PITCH_LIMIT_DEG: 89,
  /**
   * Mouse sensitivity expressed the CS way: degrees of yaw per mouse count is
   * `m_yaw (0.022) * sensitivity`. Browsers report `movementX` in CSS pixels,
   * which tracks raw counts closely enough for this to mean what a surfer
   * expects it to mean.
   */
  SENSITIVITY: 5.7,
  /**
   * Off = CS:S behaviour. Landing on a banked face converts the fall into a
   * slide down the fall line, exactly as `PM_ClipVelocity` does, because that
   * *is* surfing: you drop onto a ramp, you slide, and you strafe the slide into
   * forward speed.
   *
   * On = this project's earlier house rule, which re-pointed that component
   * *along* the ramp so a late landing kept its speed instead of being thrown
   * off the low edge. It is kept as a toggle because it was a deliberate design
   * choice, but it is not Source and it is not surf.
   */
  SURF_LANDING_REDIRECT: false,
  /**
   * Off = W and S are read only while the player is standing on a walkable
   * ("flat") surface. Airborne — which, by the ramp invariant, is every tick of
   * every surf — the wish direction comes from A and D alone.
   *
   * Not Source, and deliberately so. In CS a surfer simply *knows* not to touch
   * W: holding it points the wish direction along travel, where `v . wishDir` is
   * already at or past the 30 hu cap, so `airAccelerate` pays out nothing and the
   * strafe that would have gained speed instead does not — and a W+A diagonal is
   * a worse strafe than A on its own. Here that knowledge is not assumed. The key
   * that does nothing but throw your line away simply stops being live once you
   * leave the ground.
   *
   * On = CS behaviour, W/S live everywhere, for anyone who wants to strafe the
   * way their muscle memory already does.
   */
  AIR_FORWARD_INPUT: false,
  /**
   * Beginner Mode's training wheel. On, and airborne, and holding W with neither
   * strafe key down, the wish direction is synthesized as the strafe that climbs
   * the face being ridden — the A or D a surfer would be holding, read off the
   * ramp itself rather than guessed from the player.
   *
   * It teaches rather than carries. The synthesized direction is a plain unit
   * vector fed to the ordinary `airAccelerate`: a beginner gains speed under
   * exactly the same law as anyone else, they are only spared the keyboard half
   * of it. The thing that actually makes the speed — sweeping the view — is
   * still entirely theirs, so graduating is just pressing A or D themselves,
   * which takes over instantly and changes nothing about the physics.
   *
   * Owned by `Settings`, which persists it and writes it through here. Ignored
   * when `AIR_FORWARD_INPUT` is on, because there W is a real input again and
   * two meanings for one key is no meaning at all.
   */
  SURF_ASSIST: false,
};

/**
 * Snapshot of the authored defaults, taken at module load before any gameplay
 * code can touch them. `MovementConfig` is a mutable singleton that the upgrade
 * system writes into (MAX_GROUND_SPEED, MAX_AIR_WISH_SPEED, JUMP_SPEED, ...),
 * so without this the buffs from one run would carry into the next and compound
 * across restarts forever.
 */
const DEFAULTS: typeof MovementConfig = { ...MovementConfig };

/** The authored value of a single field, for a tuning UI's "reset" affordance. */
export function movementDefault<K extends keyof typeof MovementConfig>(
  key: K,
): (typeof MovementConfig)[K] {
  return DEFAULTS[key];
}

/**
 * Overrides the player has dialled in by hand, held *separately* from the live
 * config.
 *
 * They cannot simply be read back off `MovementConfig` at reset time: the
 * upgrade pool writes into the same object (`MAX_AIR_WISH_SPEED += 0.06`), so
 * snapshotting the live value would bank a run's buffs as if they were a
 * preference and compound them across every restart. Writing preferences here
 * keeps the two kinds of mutation from ever seeing each other.
 */
const preferences: Partial<typeof MovementConfig> = {};

/**
 * Sets a tuning field as a *preference*: applied now and re-applied on every
 * run reset, instead of being reverted to the authored default.
 */
export function setMovementPreference<K extends keyof typeof MovementConfig>(
  key: K,
  value: (typeof MovementConfig)[K],
): void {
  preferences[key] = value;
  MovementConfig[key] = value;
}

/** Drops every hand-dialled override, restoring the authored defaults. */
export function clearMovementPreferences(): void {
  for (const key of Object.keys(preferences)) delete preferences[key as keyof typeof preferences];
  Object.assign(MovementConfig, DEFAULTS);
}

/**
 * Restores every tuning field to its authored default. Call this whenever a run
 * is (re)started, before any upgrades are applied.
 *
 * This copies the whole config rather than an explicit list of "upgradeable"
 * fields, so it keeps working when someone adds a new upgrade that mutates a
 * field nobody thought of — then puts the player's own preferences back on top.
 */
export function resetMovementConfig(): void {
  Object.assign(MovementConfig, DEFAULTS, preferences);
}
