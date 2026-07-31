import { Mesh, MeshStandardMaterial, SphereGeometry, Vector3 } from 'three';

const GEOMETRY = new SphereGeometry(0.18, 8, 8);
const MATERIAL = new MeshStandardMaterial({
  color: 0x7fe8ff,
  emissive: 0x1a6b7a,
  emissiveIntensity: 1.2,
});

const MAGNET_RADIUS = 4;
const COLLECT_RADIUS = 0.6;
const MAGNET_PULL_STRENGTH = 6;

export class XPOrb {
  readonly mesh: Mesh;
  readonly position: Vector3;
  collected = false;

  constructor(
    position: Vector3,
    public readonly value: number,
  ) {
    this.position = position.clone();
    this.mesh = new Mesh(GEOMETRY, MATERIAL);
    this.mesh.position.copy(this.position);
  }

  tick(dt: number, playerPosition: Vector3): void {
    const dist = this.position.distanceTo(playerPosition);
    if (dist < MAGNET_RADIUS) {
      const t = 1 - Math.exp(-MAGNET_PULL_STRENGTH * dt);
      this.position.lerp(playerPosition, t);
    }
    if (dist < COLLECT_RADIUS) this.collected = true;
    this.mesh.position.copy(this.position);
  }
}
