import { Quaternion, Vector3 } from 'three';

/** An oriented box collider used for both ground/ramp probing and movement sweeps. */
export interface ColliderBox {
  position: Vector3;
  quaternion: Quaternion;
  halfExtents: Vector3;
  /** Marks guide-wall/perimeter geometry that should never register as walkable ground. */
  isWall?: boolean;
}

const colliders: ColliderBox[] = [];

export function registerCollider(box: ColliderBox): void {
  colliders.push(box);
}

export function getColliders(): readonly ColliderBox[] {
  return colliders;
}

export function clearColliders(): void {
  colliders.length = 0;
}
