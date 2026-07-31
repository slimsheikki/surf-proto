import { Vector3 } from 'three';
import { InputFrame } from '../engine/Input';
import { clamp, clipVelocity, degToRad } from '../engine/MathUtils';
import { groundProbe, sweep } from '../engine/Raycast';
import { MovementConfig } from './MovementConfig';

const UP = new Vector3(0, 1, 0);
const WALKABLE_NORMAL_Y = Math.cos(degToRad(MovementConfig.MAX_SLOPE_WALKABLE_DEG));
const SKIN_WIDTH = 0.01;

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
    if (hit && hit.normal.y >= WALKABLE_NORMAL_Y) {
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

    if (this.grounded) {
      applyGroundFriction(this.velocity, dt);
      groundAccelerate(this.velocity, wishDir, dt);
    } else {
      airAccelerate(this.velocity, wishDir, dt);
    }

    const wantsJump = MovementConfig.AUTO_BHOP
      ? input.jumpHeld
      : input.jumpHeld && !this.jumpHeldLastTick;
    if (this.grounded && wantsJump) {
      this.velocity.y = MovementConfig.JUMP_SPEED;
      this.grounded = false;
    }
    this.jumpHeldLastTick = input.jumpHeld;

    this.velocity.y += MovementConfig.GRAVITY * dt;

    this.integrateMovement(dt);
    this.updateGroundState();
  }

  teleport(position: Vector3): void {
    this.position.copy(position);
    this.velocity.set(0, 0, 0);
    this.grounded = false;
  }
}
