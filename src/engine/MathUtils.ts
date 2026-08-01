import { Vector3 } from 'three';

/**
 * Projects velocity to be tangent to a surface, removing only the
 * into-surface component. This is the actual surf mechanic: on a downhill
 * ramp, gravity keeps pulling velocity into the surface every tick, and
 * this keeps redirecting it back along the slope instead of stopping it,
 * which is what lets the player accelerate while sliding down.
 */
export function clipVelocity(
  velocity: Vector3,
  normal: Vector3,
  overbounce = 1.0,
): Vector3 {
  const backoff = velocity.dot(normal) * overbounce;
  return velocity.clone().sub(normal.clone().multiplyScalar(backoff));
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
