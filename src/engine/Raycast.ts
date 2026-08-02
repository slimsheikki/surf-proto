import { Vector3 } from 'three';
import { ColliderBox, getColliders } from '../world/Colliders';

export interface RayHit {
  distance: number;
  point: Vector3;
  normal: Vector3;
  collider: ColliderBox;
}

const EPS = 1e-9;
const MISS = -1;

// Scratch vectors reused across every box test. Ray casting is the hot path here
// (~15 rays/tick x 128 ticks/s x ~160 colliders), so nothing in it allocates:
// `rayIntersectBox` writes its hit normal into `boxHitNormal` and returns a bare
// distance, and only the single winning hit per `raycast()` call allocates a
// RayHit. None of these routines are re-entrant — don't call them from inside
// each other except along the paths already written here.
const localOrigin = new Vector3();
const localDir = new Vector3();
const boxHitNormal = new Vector3();
const rayDir = new Vector3();
const bestNormal = new Vector3();
const rayOrigin = new Vector3();
const sweepDir = new Vector3();
const insideLocal = new Vector3();

/**
 * Ray-vs-oriented-box intersection via the slab method in the box's local space.
 * Returns the hit distance, or MISS (-1) for no hit; on a hit the world-space
 * surface normal is left in `boxHitNormal`.
 */
function rayIntersectBox(origin: Vector3, direction: Vector3, box: ColliderBox): number {
  localOrigin.copy(origin).sub(box.position).applyQuaternion(box.invQuaternion);
  localDir.copy(direction).applyQuaternion(box.invQuaternion);

  const o = [localOrigin.x, localOrigin.y, localOrigin.z];
  const d = [localDir.x, localDir.y, localDir.z];
  const h = [box.halfExtents.x, box.halfExtents.y, box.halfExtents.z];

  let tMin = 0;
  let tMax = Infinity;
  let normalAxis = -1;
  let normalSign = 1;

  for (let axis = 0; axis < 3; axis++) {
    if (Math.abs(d[axis]) < EPS) {
      if (o[axis] < -h[axis] || o[axis] > h[axis]) return MISS;
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
    if (tMin > tMax) return MISS;
  }

  if (normalAxis === -1) return MISS; // origin started inside the box; ignore

  boxHitNormal.set(0, 0, 0);
  if (normalAxis === 0) boxHitNormal.x = normalSign;
  else if (normalAxis === 1) boxHitNormal.y = normalSign;
  else boxHitNormal.z = normalSign;
  boxHitNormal.applyQuaternion(box.quaternion).normalize();

  return tMin;
}

/** Nearest collider hit along a ray, within maxDistance. */
export function raycast(origin: Vector3, direction: Vector3, maxDistance: number): RayHit | null {
  const dir = rayDir.copy(direction).normalize();
  let bestDistance = Infinity;
  let bestCollider: ColliderBox | null = null;

  for (const collider of getColliders()) {
    const distance = rayIntersectBox(origin, dir, collider);
    if (distance === MISS || distance > maxDistance || distance >= bestDistance) continue;
    bestDistance = distance;
    bestCollider = collider;
    bestNormal.copy(boxHitNormal);
  }

  if (!bestCollider) return null;
  return {
    distance: bestDistance,
    point: origin.clone().addScaledVector(dir, bestDistance),
    normal: bestNormal.clone(),
    collider: bestCollider,
  };
}

/**
 * Whether a point is inside any collider.
 *
 * `sweep` needs this because its sample ring is spread **horizontally** around
 * the player, while a surf face is banked: at a 51 deg bank, a sample 0.4 out
 * to the side sits 0.31 *into* the slab it is riding on. `rayIntersectBox`
 * already declines to report the box a ray starts inside — but such a ray then
 * flew on and struck the *next* segment's leading end-cap from within the
 * material, and clipping against that cap's backward-facing normal deleted the
 * player's entire forward velocity. That is the "stuck partway along a curved
 * ramp" bug: it needed a multi-segment collision run to appear, so single-box
 * pieces and the standard course's ring (one box per ramp, gaps between) never
 * showed it.
 *
 * Ignoring buried samples outright is the consistent form of the rule
 * `rayIntersectBox` already applies: a sample point inside solid geometry
 * describes no free-space motion, so it must not veto the samples that do.
 */
export function isInsideAnyCollider(point: Vector3): boolean {
  for (const box of getColliders()) {
    insideLocal.copy(point).sub(box.position).applyQuaternion(box.invQuaternion);
    if (
      Math.abs(insideLocal.x) <= box.halfExtents.x &&
      Math.abs(insideLocal.y) <= box.halfExtents.y &&
      Math.abs(insideLocal.z) <= box.halfExtents.z
    ) {
      return true;
    }
  }
  return false;
}

const GROUND_SAMPLE_OFFSETS = [
  new Vector3(0, 0, 0),
  new Vector3(1, 0, 0),
  new Vector3(-1, 0, 0),
  new Vector3(0, 0, 1),
  new Vector3(0, 0, -1),
];

const DOWN = new Vector3(0, -1, 0);

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
    rayOrigin.copy(feetPosition).addScaledVector(offset, radius);
    rayOrigin.y += startUp;
    const hit = raycast(rayOrigin, DOWN, probeDistance + startUp);
    if (hit && (!best || hit.distance < best.distance)) best = hit;
  }
  return best;
}

/**
 * Sweeps the player's intended displacement against level colliders using
 * the same ring-of-points approximation as groundProbe, standing in for a
 * full capsule sweep — sufficient for box/ramp primitives at this scale.
 *
 * `radius` is the lateral extent only: it spreads the ray origins across the
 * player's width, which is what stops the player clipping a ramp edge with the
 * side of the capsule. It deliberately does NOT extend the cast distance. The
 * previous `distance + radius` cast length was dead code — the only extra hits
 * it could report were ones farther away than the requested displacement, and
 * every caller discards those as a miss, so it never changed an outcome. Adding
 * a real forward skin would mean stopping the player `radius` short of every
 * surface, which for a 0.4 radius would visibly hold them off the ramps, so the
 * inflation is simply removed rather than made meaningful.
 */
export function sweep(position: Vector3, displacement: Vector3, radius: number): RayHit | null {
  const distance = displacement.length();
  if (distance < EPS) return null;
  const direction = sweepDir.copy(displacement).divideScalar(distance);

  let best: RayHit | null = null;
  for (const offset of GROUND_SAMPLE_OFFSETS) {
    rayOrigin.copy(position).addScaledVector(offset, radius);
    // Samples buried in geometry are skipped rather than trusted — see
    // `isInsideAnyCollider`. Without this, riding a banked multi-segment ramp
    // stops the player dead at the first seam.
    if (isInsideAnyCollider(rayOrigin)) continue;
    const hit = raycast(rayOrigin, direction, distance);
    if (hit && (!best || hit.distance < best.distance)) best = hit;
  }
  return best;
}
