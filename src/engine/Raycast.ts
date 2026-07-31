import { Vector3 } from 'three';
import { ColliderBox, getColliders } from '../world/Colliders';

export interface RayHit {
  distance: number;
  point: Vector3;
  normal: Vector3;
  collider: ColliderBox;
}

const EPS = 1e-9;

/** Ray-vs-oriented-box intersection via the slab method in the box's local space. */
function rayIntersectBox(
  origin: Vector3,
  direction: Vector3,
  box: ColliderBox,
): { distance: number; normal: Vector3 } | null {
  const invQuat = box.quaternion.clone().invert();
  const localOrigin = origin.clone().sub(box.position).applyQuaternion(invQuat);
  const localDir = direction.clone().applyQuaternion(invQuat);

  const o = [localOrigin.x, localOrigin.y, localOrigin.z];
  const d = [localDir.x, localDir.y, localDir.z];
  const h = [box.halfExtents.x, box.halfExtents.y, box.halfExtents.z];

  let tMin = 0;
  let tMax = Infinity;
  let normalAxis = -1;
  let normalSign = 1;

  for (let axis = 0; axis < 3; axis++) {
    if (Math.abs(d[axis]) < EPS) {
      if (o[axis] < -h[axis] || o[axis] > h[axis]) return null;
      continue;
    }
    const ood = 1 / d[axis];
    const tNeg = (-h[axis] - o[axis]) * ood;
    const tPos = (h[axis] - o[axis]) * ood;
    const negIsNear = tNeg < tPos;
    const tNear = negIsNear ? tNeg : tPos;
    const tFar = negIsNear ? tPos : tNeg;

    if (tNear > tMin) {
      tMin = tNear;
      normalAxis = axis;
      normalSign = negIsNear ? -1 : 1;
    }
    if (tFar < tMax) tMax = tFar;
    if (tMin > tMax) return null;
  }

  if (normalAxis === -1) return null; // origin started inside the box; ignore

  const localNormal = new Vector3(0, 0, 0);
  if (normalAxis === 0) localNormal.x = normalSign;
  else if (normalAxis === 1) localNormal.y = normalSign;
  else localNormal.z = normalSign;

  const worldNormal = localNormal.applyQuaternion(box.quaternion).normalize();
  return { distance: tMin, normal: worldNormal };
}

/** Nearest collider hit along a ray, within maxDistance. */
export function raycast(origin: Vector3, direction: Vector3, maxDistance: number): RayHit | null {
  const dir = direction.clone().normalize();
  let best: RayHit | null = null;
  for (const collider of getColliders()) {
    const hit = rayIntersectBox(origin, dir, collider);
    if (hit && hit.distance <= maxDistance && (!best || hit.distance < best.distance)) {
      best = {
        distance: hit.distance,
        point: origin.clone().addScaledVector(dir, hit.distance),
        normal: hit.normal,
        collider,
      };
    }
  }
  return best;
}

const GROUND_SAMPLE_OFFSETS = [
  new Vector3(0, 0, 0),
  new Vector3(1, 0, 0),
  new Vector3(-1, 0, 0),
  new Vector3(0, 0, 1),
  new Vector3(0, 0, -1),
];

/**
 * Casts short downward rays from a small ring of points at the player's feet
 * to find the ground/ramp surface beneath them. A single center ray misses
 * cases where the player straddles a platform edge or ramp seam.
 */
export function groundProbe(
  feetPosition: Vector3,
  radius: number,
  probeDistance: number,
): RayHit | null {
  const startUp = 0.05; // start slightly above feet to avoid spawning inside geometry
  let best: RayHit | null = null;
  for (const offset of GROUND_SAMPLE_OFFSETS) {
    const origin = feetPosition
      .clone()
      .addScaledVector(offset, radius)
      .add(new Vector3(0, startUp, 0));
    const hit = raycast(origin, new Vector3(0, -1, 0), probeDistance + startUp);
    if (hit && (!best || hit.distance < best.distance)) best = hit;
  }
  return best;
}

/**
 * Sweeps the player's intended displacement against level colliders using
 * the same ring-of-points approximation as groundProbe, standing in for a
 * full capsule sweep — sufficient for box/ramp primitives at this scale.
 */
export function sweep(
  position: Vector3,
  displacement: Vector3,
  radius: number,
): RayHit | null {
  const distance = displacement.length();
  if (distance < EPS) return null;
  const direction = displacement.clone().divideScalar(distance);

  let best: RayHit | null = null;
  for (const offset of GROUND_SAMPLE_OFFSETS) {
    const origin = position.clone().addScaledVector(offset, radius);
    const hit = raycast(origin, direction, distance + radius);
    if (hit && (!best || hit.distance < best.distance)) best = hit;
  }
  return best;
}
