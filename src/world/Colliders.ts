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

const colliders: ColliderBox[] = [];

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

export function getColliders(): readonly ColliderBox[] {
  return colliders;
}

export function clearColliders(): void {
  colliders.length = 0;
}
