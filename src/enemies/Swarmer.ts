import { TetrahedronGeometry, Vector3 } from 'three';
import { Enemy, EnemyVisual } from './Enemy';

/**
 * Deliberately the smallest silhouette in the roster, and acid-green — a
 * colour nothing else in the game owns (red drone, violet seeder, gold shrine,
 * teal XP), because at 35 u/s colour is the only channel that reads. Small
 * and sharp-cornered where the drone is round: a pack of these must scan as
 * "many little" rather than "several drones" in peripheral vision.
 */
const GEOMETRY = new TetrahedronGeometry(0.34);
const SWARMER_VISUAL: EnemyVisual = {
  geometry: GEOMETRY,
  color: 0x86e02c,
  emissive: 0x4a9a10,
  emissiveIntensity: 0.9,
};

/** Tumble, cosmetic but load-bearing the same way the seeder's spin is: shape motion identifies the type before colour does. */
const TUMBLE_RATE = 2.2;

/**
 * The Flood's body. Everything interesting about swarmers happens outside
 * this class: they arrive in clusters (a spawn *pattern*), they are cheap
 * (0.4× drone HP, `Difficulty`), and they matter through numbers. The class
 * itself is just a drone with a twitchier steering limit — a pack that all
 * whiffed the same way would read as one big drone — and a different body.
 */
export class Swarmer extends Enemy {
  private tumble = Math.random() * Math.PI * 2;

  constructor(position: Vector3, hp: number, moveSpeed: number, contactDamage: number) {
    super(position, hp, moveSpeed, contactDamage, SWARMER_VISUAL);
    this.turnRate = 2.6;
  }

  tick(dt: number, playerPosition: Vector3, playerVelocity: Vector3): void {
    super.tick(dt, playerPosition, playerVelocity);
    this.tumble += dt * TUMBLE_RATE;
    this.mesh.rotation.set(this.tumble, this.tumble * 0.7, 0);
  }
}
