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
 * Shared by two triggers: the level-up menu, and a manual dash (Shift).
 *
 * The level-up menu pauses `Game.updateGameplay` entirely, so no momentum is
 * actually lost while a player picks an upgrade — but it does cost them a real
 * half-second where they weren't holding strafe/forward, unlike every other
 * moment in a surf line. This nudge compensates for that missed input window;
 * it is a "welcome back" push in the direction already being travelled, not a
 * real speed buff, so it stays small enough not to read as one. A dash spends
 * a charge (see `Dash`) to fire the identical nudge on demand.
 */
const MOMENTUM_BOOST_DURATION = 0.5; // seconds
const MOMENTUM_BOOST_ACCEL = 3; // u/s^2

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
      this.velocity.copy(clipVelocity(this.velocity, hit.normal));
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

  teleport(position: Vector3): void {
    this.position.copy(position);
    this.velocity.set(0, 0, 0);
    this.grounded = false;
    this.momentumBoostTimer = 0;
  }
}
