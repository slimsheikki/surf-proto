import { Vector3 } from 'three';
import { InputFrame } from '../engine/Input';
import { clamp, clipVelocity, degToRad } from '../engine/MathUtils';
import { groundProbe, sweep } from '../engine/Raycast';
import { MovementConfig } from './MovementConfig';

const UP = new Vector3(0, 1, 0);
const SKIN_WIDTH = 0.01;

/**
 * Tolerance on the walkable-slope test, expressed in normal.y (1e-4 of normal.y
 * is ~0.008 deg of slope at the 45 deg limit — small enough not to retune the
 * angle, large enough to swamp floating-point noise in the collider quaternions).
 *
 * A surface built at *exactly* MAX_SLOPE_WALKABLE_DEG sits precisely on the
 * boundary, where rounding would otherwise decide unpredictably whether the
 * player walks or surfs. Requiring the surface to be strictly shallower than the
 * limit by this epsilon resolves the tie one way: a surface at exactly the
 * configured angle is NOT walkable, i.e. it is surfable. That matches surf-map
 * practice, where a 45 deg ramp is expected to be surfable.
 */
const WALKABLE_NORMAL_EPS = 1e-4;

/**
 * The level-up menu pauses `Game.updateGameplay` entirely, so no momentum is
 * actually lost while a player picks an upgrade — but it does cost them a real
 * half-second where they weren't holding strafe/forward, unlike every other
 * moment in a surf line. This nudge compensates for that missed input window;
 * it is a "welcome back" push in the direction already being travelled, not a
 * real speed buff, so it stays small enough not to read as one.
 *
 * The dash deliberately does NOT use this — see `dashImpulse()`.
 */
const MOMENTUM_BOOST_DURATION = 0.5; // seconds
const MOMENTUM_BOOST_ACCEL = 3; // u/s^2

/**
 * One-shot shove the dash adds along the facing direction. It is an impulse,
 * not a buff: nothing lingers after the tick it fires on, so the player can
 * dash to *redirect* — snapping their momentum toward where they're looking —
 * without the mechanic doubling as a speed upgrade.
 *
 * Sized against `MAX_GROUND_SPEED` (7): a shade over walk speed, enough to feel
 * like a shove and to reach a ramp lip from a standstill, small next to the
 * speeds a real surf line carries so dashing forward at pace is never the
 * fastest way to go fast.
 */
const DASH_IMPULSE_SPEED = 8; // u/s, added instantly

/**
 * Landing on a banked face used to convert the whole fall into a sideways-down
 * slide, so touching down late threw the player off the ramp's low edge before
 * they could strafe back up.
 *
 * That is `PM_ClipVelocity` behaving exactly as Source does — it removes only
 * the component *into* the surface and keeps everything tangent to it, and the
 * fall line lies in the surface plane, so the downhill component survives the
 * clip untouched (`n·d = 0`, hence `v'·d = v·d`). A 20 u/s drop onto a
 * canonical 51.34 deg face lands already sliding down it at ~15.6 u/s.
 *
 * `redirectLandingVelocity` turns that slide along the ramp instead of down it.
 * The hard part is firing on a *landing* and never while riding: cancel the
 * downhill component every tick and the player is glued to the face, which
 * destroys the height-for-speed trade that surfing is. Approach speed into the
 * surface separates the two cleanly, by a factor of about thirty-five:
 *
 * - Riding: gravity adds `GRAVITY·dt` = 0.139 u/s per tick, of which 0.625 of
 *   it (`normal.y`) is into the face — and it is clipped away again every tick,
 *   so it never accumulates. About 0.09 u/s.
 * - Landing: a 20 u/s drop arrives with 20 × 0.625 = 12.5 u/s into the face.
 *
 * Three sits far above the first and far below the second, needs no cross-tick
 * state, and is self-limiting inside the two-iteration sweep loop — after one
 * redirect the approach speed is ~0, so a second iteration cannot re-fire.
 */
const SURF_LANDING_IMPACT_SPEED = 3; // u/s into the surface

/**
 * Below this the surface is a wall rather than a ramp, and shoving the player
 * sideways along a wall would be absurd. Clears every surfable face in the
 * game: ring and straight ramps 0.625, approach descent 0.580, pyramid 0.574,
 * slide 0.470 — while a wall side reads ~0.
 */
const SURF_LANDING_MIN_NORMAL_Y = 0.3;

/**
 * Ceiling on how much the redirect may scale the kept velocity up.
 *
 * Preserving total speed means rescaling the along-ramp component back to the
 * original speed, and for any ordinary landing that is a gentle correction — a
 * 25 u/s surf line touching down needs about 1.1x. But a near-vertical drop has
 * almost no along-ramp motion to preserve the direction of, and without a cap
 * its 0.5 u/s of incidental drift would be amplified into a 20 u/s launch in an
 * essentially arbitrary direction, with a cliff edge either side of whatever
 * guard value was picked. Capping the gain keeps real landings fully
 * speed-preserving and lets a vertical drop degrade smoothly into "lands almost
 * still".
 */
const MAX_LANDING_REDIRECT_GAIN = 3;

const DOWN = new Vector3(0, -1, 0);

/**
 * Rotates a just-clipped landing velocity within the surface plane so it runs
 * *along* the ramp instead of down its fall line, keeping the same speed.
 *
 * Mutates `velocity` in place. Assumes it is already tangent to `normal` (i.e.
 * `clipVelocity` has run), which is what makes step 3 a pure decomposition.
 */
function redirectLandingVelocity(velocity: Vector3, normal: Vector3): void {
  // Fall line: gravity projected into the surface plane.
  const fallLine = DOWN.clone().addScaledVector(normal, normal.y);
  if (fallLine.lengthSq() < 1e-8) return; // level surface — no fall line to cancel
  fallLine.normalize();

  const downhill = velocity.dot(fallLine);
  if (downhill <= 0) return; // already level or climbing; nothing to cancel

  const speed = velocity.length();
  // What remains once the downhill part is removed is purely along the ramp,
  // and it already carries the player's travel direction — no sign logic needed.
  const alongRamp = velocity.clone().addScaledVector(fallLine, -downhill);
  const alongSpeed = alongRamp.length();
  if (alongSpeed < 1e-6) {
    velocity.copy(alongRamp);
    return;
  }

  const gain = Math.min(speed / alongSpeed, MAX_LANDING_REDIRECT_GAIN);
  velocity.copy(alongRamp).multiplyScalar(gain);
}

/**
 * Read the limit off the config on each call rather than caching it at module
 * load, so it stays correct if MAX_SLOPE_WALKABLE_DEG is retuned or reset at
 * runtime. This runs a handful of times per tick; the cos() is free at that rate.
 */
function isWalkableNormal(normalY: number): boolean {
  const limit = Math.cos(degToRad(MovementConfig.MAX_SLOPE_WALKABLE_DEG));
  return normalY >= limit + WALKABLE_NORMAL_EPS;
}

function applyGroundFriction(velocity: Vector3, dt: number): void {
  const speed = Math.hypot(velocity.x, velocity.z);
  if (speed < 1e-6) return;
  const control = Math.max(speed, MovementConfig.STOP_SPEED);
  const drop = control * MovementConfig.FRICTION * dt;
  const newSpeed = Math.max(speed - drop, 0);
  const scale = newSpeed / speed;
  velocity.x *= scale;
  velocity.z *= scale;
}

function groundAccelerate(velocity: Vector3, wishDir: Vector3, dt: number): void {
  const wishspeed = MovementConfig.MAX_GROUND_SPEED;
  const currentSpeed = velocity.dot(wishDir);
  const addSpeed = wishspeed - currentSpeed;
  if (addSpeed <= 0) return;
  const accelSpeed = Math.min(MovementConfig.GROUND_ACCEL * dt * wishspeed, addSpeed);
  velocity.addScaledVector(wishDir, accelSpeed);
}

/**
 * The real PM_AirAccelerate trick: the addSpeed target is capped to a small
 * value, but the acceleration magnitude still scales off the UNCAPPED
 * wishspeed. That asymmetry is what lets turning the mouse while holding a
 * strafe key gain speed indefinitely in the air — never "simplify" this by
 * using the same (capped) value in both places, it silently kills the surf feel.
 */
function airAccelerate(velocity: Vector3, wishDir: Vector3, dt: number): void {
  const wishspeed = MovementConfig.MAX_GROUND_SPEED;
  const cappedWishSpeed = Math.min(wishspeed, MovementConfig.MAX_AIR_WISH_SPEED);
  const currentSpeed = velocity.dot(wishDir);
  const addSpeed = cappedWishSpeed - currentSpeed;
  if (addSpeed <= 0) return;
  const accelSpeed = Math.min(MovementConfig.AIR_ACCEL * wishspeed * dt, addSpeed);
  velocity.addScaledVector(wishDir, accelSpeed);
}

export class PlayerController {
  readonly position: Vector3;
  readonly velocity = new Vector3(0, 0, 0);
  yaw: number;
  pitch = 0;
  grounded = false;
  groundNormal = new Vector3(0, 1, 0);
  private jumpHeldLastTick = false;
  private momentumBoostTimer = 0;

  constructor(spawnPosition: Vector3, spawnYawDeg: number) {
    this.position = spawnPosition.clone();
    this.yaw = degToRad(spawnYawDeg);
  }

  get speed(): number {
    return Math.hypot(this.velocity.x, this.velocity.z);
  }

  private wishDir(input: InputFrame): Vector3 {
    const local = new Vector3(input.moveRight, 0, -input.moveForward);
    if (local.lengthSq() > 1e-6) local.normalize();
    return local.applyAxisAngle(UP, this.yaw);
  }

  private integrateMovement(dt: number): void {
    let remaining = this.velocity.clone().multiplyScalar(dt);
    for (let iter = 0; iter < 2; iter++) {
      const dist = remaining.length();
      if (dist < 1e-6) break;
      const hit = sweep(this.position, remaining, MovementConfig.PLAYER_RADIUS);
      if (!hit || hit.distance >= dist) {
        this.position.add(remaining);
        break;
      }
      const dir = remaining.clone().normalize();
      const moveDist = Math.max(hit.distance - SKIN_WIDTH, 0);
      this.position.addScaledVector(dir, moveDist);
      const leftover = dir.multiplyScalar(dist - moveDist);

      // Measured before the clip: the clip is precisely what destroys it.
      const approach = -this.velocity.dot(hit.normal);
      this.velocity.copy(clipVelocity(this.velocity, hit.normal));
      if (
        approach >= SURF_LANDING_IMPACT_SPEED &&
        !hit.collider.isWall &&
        hit.normal.y >= SURF_LANDING_MIN_NORMAL_Y &&
        !isWalkableNormal(hit.normal.y)
      ) {
        redirectLandingVelocity(this.velocity, hit.normal);
      }

      // `remaining` deliberately keeps the old heading: it is the sub-tick
      // leftover displacement, and the next tick integrates the corrected
      // velocity. Redirecting it too would move the player along a heading the
      // landing only just invented.
      remaining = clipVelocity(leftover, hit.normal);
    }
  }

  private updateGroundState(): void {
    // Never trust a ground hit while moving upward — the very tick after a
    // jump the player has barely left the surface, and a naive downward
    // probe would immediately re-report "grounded" and kill the jump.
    if (this.velocity.y > 0.1) {
      this.grounded = false;
      return;
    }
    const hit = groundProbe(this.position, MovementConfig.PLAYER_RADIUS, MovementConfig.GROUND_PROBE_DIST);
    if (hit && !hit.collider.isWall && isWalkableNormal(hit.normal.y)) {
      this.grounded = true;
      this.groundNormal.copy(hit.normal);
      this.position.y = hit.point.y;
    } else {
      this.grounded = false;
    }
  }

  tick(dt: number, input: InputFrame): void {
    this.yaw += input.yawDelta;
    this.pitch = clamp(
      this.pitch + input.pitchDelta,
      -degToRad(MovementConfig.PITCH_LIMIT_DEG),
      degToRad(MovementConfig.PITCH_LIMIT_DEG),
    );

    const wishDir = this.wishDir(input);

    // Order matters, and it mirrors CGameMovement::FullWalkMove(): the jump is
    // resolved BEFORE anything tests the ground state, because CheckJumpButton()
    // clears the ground entity and the friction check that follows is gated on
    // "still on the ground". So the tick you jump on pays no ground friction and
    // takes the air-movement path — that is exactly why bunnyhopping in CS
    // preserves speed instead of bleeding a few percent on every landing.
    const wantsJump = MovementConfig.AUTO_BHOP
      ? input.jumpHeld
      : input.jumpHeld && !this.jumpHeldLastTick;
    if (this.grounded && wantsJump) {
      this.velocity.y = MovementConfig.JUMP_SPEED;
      this.grounded = false;
    }
    this.jumpHeldLastTick = input.jumpHeld;

    if (this.grounded) {
      // Standing on ground: no vertical velocity, as in Source. Skipping this
      // lets gravity pile up a downward velocity every grounded tick that the
      // collision sweep then has to clip straight back off, burning a sweep
      // iteration for nothing. Walking off a ledge still works — the ground
      // probe stops finding a surface, grounded goes false, and gravity resumes.
      this.velocity.y = 0;
      applyGroundFriction(this.velocity, dt);
      groundAccelerate(this.velocity, wishDir, dt);
    } else {
      airAccelerate(this.velocity, wishDir, dt);
      this.velocity.y += MovementConfig.GRAVITY * dt;
    }

    if (this.momentumBoostTimer > 0) {
      this.momentumBoostTimer = Math.max(this.momentumBoostTimer - dt, 0);
      const speed = this.speed;
      const boostDir =
        speed > 1e-6 ? new Vector3(this.velocity.x, 0, this.velocity.z).divideScalar(speed) : wishDir;
      if (boostDir.lengthSq() > 1e-6) {
        this.velocity.addScaledVector(boostDir, MOMENTUM_BOOST_ACCEL * dt);
      }
    }

    this.integrateMovement(dt);
    this.updateGroundState();
  }

  /** Arms the momentum nudge (see `MOMENTUM_BOOST_ACCEL`) for its next `MOMENTUM_BOOST_DURATION` seconds of ticks. */
  grantMomentumBoost(): void {
    this.momentumBoostTimer = MOMENTUM_BOOST_DURATION;
  }

  /**
   * Shoves the player along the direction they are facing (see
   * `DASH_IMPULSE_SPEED`). Yaw only — pitch is left out on purpose, because a
   * dash that inherited look pitch would be a free ascent while staring up, and
   * height in a surf line has to be earned off a ramp.
   */
  dashImpulse(): void {
    const forward = new Vector3(0, 0, -1).applyAxisAngle(UP, this.yaw);
    this.velocity.addScaledVector(forward, DASH_IMPULSE_SPEED);
  }

  teleport(position: Vector3): void {
    this.position.copy(position);
    this.velocity.set(0, 0, 0);
    this.grounded = false;
    this.momentumBoostTimer = 0;
  }
}
