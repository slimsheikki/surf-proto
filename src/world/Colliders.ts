import { Quaternion, Vector3 } from 'three';

/** The fields a caller supplies when registering a collider. */
export interface ColliderBoxInit {
  position: Vector3;
  quaternion: Quaternion;
  halfExtents: Vector3;
  /** Marks guide-wall/perimeter geometry that should never register as walkable ground. */
  isWall?: boolean;
}

/**
 * An oriented box collider used for both ground/ramp probing and movement sweeps.
 *
 * `invQuaternion` is derived once at registration time rather than per ray test:
 * the course registers ~160 of these and the controller fires ~15 rays a tick at
 * 128 Hz, so cloning-and-inverting inside the slab test was allocating on the
 * order of a million throwaway quaternions a second.
 *
 * Consequence of the cache: treat a registered collider as immutable. If level
 * geometry ever needs to move, re-register it (or refresh `invQuaternion`)
 * instead of writing to `quaternion` in place.
 */
export interface ColliderBox extends ColliderBoxInit {
  readonly invQuaternion: Quaternion;
}

/**
 * A convex volume, stored as the intersection of half-spaces: a point is
 * inside when `normal · p + offset <= 0` for every plane.
 *
 * This exists so a curved ramp's collision can be the *same triangles as its
 * visible surface*, extruded downward. Oriented boxes cannot do that: a curve
 * approximated by independent boxes leaves each segment's end-cap standing
 * proud of its neighbour, and the movement sweep hits that cap head-on and
 * clips away the player's whole forward velocity. Sinking the boxes to hide
 * the caps only trades the stall for collision sitting below what you can
 * see. Welded convex wedges have neither problem — adjacent wedges share a
 * face exactly, so a ray leaves one and enters the next at the same point,
 * and there is no cap in between. It is also what real surf maps do; the CS2
 * mapping guide compiles curved ramps as *Multiple Convex Hulls* for exactly
 * this reason.
 *
 * `bound`/`boundRadius` is a broadphase sphere — a curved piece is many more
 * wedges than it was boxes, and the raycaster is a linear scan.
 */
export interface ColliderConvex {
  planes: { normal: Vector3; offset: number }[];
  bound: Vector3;
  boundRadius: number;
  isWall?: boolean;
}

const colliders: ColliderBox[] = [];
const convexColliders: ColliderConvex[] = [];

export function registerCollider(box: ColliderBoxInit): ColliderBox {
  const collider: ColliderBox = {
    position: box.position,
    quaternion: box.quaternion,
    halfExtents: box.halfExtents,
    isWall: box.isWall,
    invQuaternion: box.quaternion.clone().invert(),
  };
  colliders.push(collider);
  return collider;
}

/**
 * Registers the convex volume swept by triangle `a,b,c` extruded straight
 * down by `depth`. Straight down, rather than along the surface normal, is
 * what lets neighbouring wedges weld: two triangles sharing a top edge
 * produce prisms sharing a whole vertical face, whatever angle they meet at.
 *
 * Degenerate triangles (a taper running out to a point, a zero-length
 * segment) are skipped rather than registered — their plane normals are
 * meaningless and would let rays through.
 */
export function registerPrism(
  a: Vector3,
  b: Vector3,
  c: Vector3,
  depth: number,
  isWall?: boolean,
): ColliderConvex | null {
  const ab = new Vector3().subVectors(b, a);
  const ac = new Vector3().subVectors(c, a);
  const faceNormal = new Vector3().crossVectors(ab, ac);
  if (faceNormal.lengthSq() < 1e-10) return null;
  faceNormal.normalize();
  // Orient upward so "inside" is beneath the surface.
  if (faceNormal.y < 0) faceNormal.negate();

  const planes: { normal: Vector3; offset: number }[] = [
    { normal: faceNormal.clone(), offset: -faceNormal.dot(a) },
  ];

  const bottom = new Vector3(0, -depth, 0);
  const aB = a.clone().add(bottom);
  const down = faceNormal.clone().negate();
  planes.push({ normal: down, offset: -down.dot(aB) });

  const corners = [a, b, c];
  for (let i = 0; i < 3; i++) {
    const p = corners[i];
    const q = corners[(i + 1) % 3];
    const other = corners[(i + 2) % 3];
    // Vertical side plane containing edge p->q.
    const normal = new Vector3().subVectors(q, p).cross(new Vector3(0, -1, 0));
    if (normal.lengthSq() < 1e-10) return null;
    normal.normalize();
    let offset = -normal.dot(p);
    if (normal.dot(other) + offset > 0) {
      normal.negate();
      offset = -offset;
    }
    planes.push({ normal, offset });
  }

  const bound = new Vector3()
    .add(a)
    .add(b)
    .add(c)
    .divideScalar(3)
    .add(new Vector3(0, -depth / 2, 0));
  const boundRadius =
    Math.max(bound.distanceTo(a), bound.distanceTo(b), bound.distanceTo(c)) + depth / 2 + 1e-3;

  const convex: ColliderConvex = { planes, bound, boundRadius, isWall };
  convexColliders.push(convex);
  return convex;
}

export function getColliders(): readonly ColliderBox[] {
  return colliders;
}

export function getConvexColliders(): readonly ColliderConvex[] {
  return convexColliders;
}

export function clearColliders(): void {
  colliders.length = 0;
  convexColliders.length = 0;
}
