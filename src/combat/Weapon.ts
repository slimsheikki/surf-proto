import { Vector3 } from 'three';
import { Enemy } from '../enemies/Enemy';

/**
 * Hitscan auto-attack: no aiming input needed, fires at the nearest enemy in
 * range on a cooldown. Stat-driven so upgrades are just field mutations.
 */
export class Weapon {
  damage = 6;
  attacksPerSecond = 3;
  range = 14;
  private cooldown = 0;

  tick(dt: number, playerPosition: Vector3, enemies: readonly Enemy[]): void {
    if (this.cooldown > 0) {
      this.cooldown -= dt;
      return;
    }

    let nearest: Enemy | null = null;
    let nearestDist = this.range;
    for (const enemy of enemies) {
      const dist = enemy.distanceToPlayer(playerPosition);
      if (dist < nearestDist) {
        nearest = enemy;
        nearestDist = dist;
      }
    }
    if (!nearest) return;

    nearest.health.takeDamage(this.damage);
    nearest.flashHit();
    this.cooldown = 1 / this.attacksPerSecond;
  }
}
