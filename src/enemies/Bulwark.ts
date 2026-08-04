import { DodecahedronGeometry, Vector3 } from 'three';
import { Enemy, EnemyVisual } from './Enemy';

/**
 * Deep cobalt and more than twice anyone else's size — the read at 35 u/s is
 * "boulder", and the colour sits far from the drone's red and the seeder's
 * violet so a mixed pack sorts itself at a glance.
 */
const GEOMETRY = new DodecahedronGeometry(0.9);
const BULWARK_VISUAL: EnemyVisual = {
  geometry: GEOMETRY,
  color: 0x2b4fd8,
  emissive: 0x1a2f9e,
  emissiveIntensity: 0.9,
};

/** Ponderous tumble; the seeder-spin rule — shape motion identifies the type before colour does. */
const TUMBLE_RATE = 0.5;

/**
 * The moving wall. No behaviour overrides at all: at its speed the intercept
 * solve almost never finds a solution against a surfer, so the base class's
 * direct-chase fallback already produces exactly the slow, inevitable advance
 * the archetype wants. What makes it a bulwark is scale — a big body, a
 * matching contact radius (the one real seam it needed; a 2.2-scale mesh with
 * the default 1.3 reach would overlap the player without ever hitting), heavy
 * contact damage, and a double orb drop so grinding one down pays.
 *
 * Its job in a wave is to *shape lines*: one bulwark on a transfer is a
 * decision, five in BULWARK MARCH are a wall with gaps.
 */
export class Bulwark extends Enemy {
  private tumble = Math.random() * Math.PI * 2;

  constructor(position: Vector3, hp: number, moveSpeed: number, contactDamage: number) {
    super(position, hp, moveSpeed, contactDamage, BULWARK_VISUAL);
    this.baseScale = 2.2;
    this.contactRadius = 2.4;
    this.xpOrbCount = 2;
    // Even more committed than a drone — a wall should not feint.
    this.turnRate = 1.2;
  }

  tick(dt: number, playerPosition: Vector3, playerVelocity: Vector3): void {
    super.tick(dt, playerPosition, playerVelocity);
    this.tumble += dt * TUMBLE_RATE;
    this.mesh.rotation.set(this.tumble, this.tumble * 0.6, 0);
  }
}
