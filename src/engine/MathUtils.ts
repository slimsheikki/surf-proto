import { Vector3 } from 'three';

/**
 * `PM_ClipVelocity` / `CGameMovement::ClipVelocity`.
 *
 * Projects velocity to be tangent to a surface, removing only the
 * into-surface component. This is the actual surf mechanic: on a banked
 * ramp, gravity keeps pulling velocity into the surface every tick, and
 * this keeps redirecting it back along the slope instead of stopping it,
 * which is what lets the player accelerate while sliding across it.
 *
 * The second pass is not a tidy-up — it is in Source verbatim ("iterate once
 * to make sure we aren't still moving through the plane"). One subtraction
 * leaves a residual into-plane component whenever `normal` is not exactly unit
 * length, and the collider quaternions here are built from rotation matrices,
 * so they are unit to about 1e-7 and no better. Without the re-projection that
 * residual accumulates over a long ramp ride and slowly sinks the player into
 * the face.
 */
export function clipVelocity(
  velocity: Vector3,
  normal: Vector3,
  overbounce = 1.0,
): Vector3 {
  const backoff = velocity.dot(normal) * overbounce;
  const out = velocity.clone().sub(normal.clone().multiplyScalar(backoff));
  const adjust = out.dot(normal);
  if (adjust < 0) out.addScaledVector(normal, -adjust);
  return out;
}

export function degToRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

export function radToDeg(rad: number): number {
  return (rad * 180) / Math.PI;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
