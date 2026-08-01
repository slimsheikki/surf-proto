import { Vector3 } from 'three';
import { Health } from './Health';

/**
 * Everything the auto-weapon needs from a thing it can shoot. Drones and the
 * level-10 boss are wildly different objects — one is a 10 HP seeker, the other
 * a 2200 HP arena piece — but the weapon only ever asks "how far, take this,
 * flash", so it targets both through this interface and contains no special
 * cases for either.
 */
export interface WeaponTarget {
  readonly health: Health;
  distanceToPlayer(playerPosition: Vector3): number;
  flashHit(): void;
}

/**
 * Baseline stats, kept separate from the live fields so upgrades (which mutate
 * the live fields in place) can be undone on restart instead of compounding
 * across runs.
 *
 * The envelope is deliberately wide: the player is surfing at 20-40 u/s almost
 * all the time, so a drone is only inside a short range for a fraction of a
 * second. A 22-unit range at 4 shots/s means a head-on pass yields ~4-5 shots
 * instead of the ~1-2 the old 14/3 numbers allowed.
 */
interface WeaponStats {
  damage: number;
  attacksPerSecond: number;
  range: number;
}

const BASE_STATS: WeaponStats = {
  damage: 7,
  attacksPerSecond: 4,
  range: 22,
};

/**
 * Hitscan auto-attack: no aiming input needed, fires at the nearest enemy in
 * range on a cooldown. Stat-driven so upgrades are just field mutations.
 */
export class Weapon {
  damage = BASE_STATS.damage;
  attacksPerSecond = BASE_STATS.attacksPerSecond;
  range = BASE_STATS.range;
  private cooldown = 0;
  /**
   * Sticky target. Always retargeting the nearest enemy sprays partial damage
   * across a stream of drones that then leave range and heal nothing — at surf
   * speed that meant almost no kills. Committing to one target until it dies or
   * leaves range converts the same DPS into actual kills and XP.
   */
  private target: WeaponTarget | null = null;

  tick(dt: number, playerPosition: Vector3, targets: readonly WeaponTarget[]): void {
    if (this.cooldown > 0) this.cooldown -= dt;

    if (!this.isEngageable(this.target, playerPosition, targets)) {
      this.target = this.pickNearest(playerPosition, targets);
    }
    if (!this.target || this.cooldown > 0) return;

    this.target.health.takeDamage(this.damage);
    this.target.flashHit();
    this.cooldown = 1 / this.attacksPerSecond;
  }

  private isEngageable(
    target: WeaponTarget | null,
    playerPosition: Vector3,
    targets: readonly WeaponTarget[],
  ): target is WeaponTarget {
    return (
      target !== null &&
      !target.health.isDead &&
      target.distanceToPlayer(playerPosition) <= this.range &&
      targets.includes(target)
    );
  }

  private pickNearest(playerPosition: Vector3, targets: readonly WeaponTarget[]): WeaponTarget | null {
    let nearest: WeaponTarget | null = null;
    let nearestDist = this.range;
    for (const target of targets) {
      const dist = target.distanceToPlayer(playerPosition);
      if (dist < nearestDist) {
        nearest = target;
        nearestDist = dist;
      }
    }
    return nearest;
  }

  /** Restores the starting stats, undoing every upgrade applied this run. */
  reset(): void {
    this.damage = BASE_STATS.damage;
    this.attacksPerSecond = BASE_STATS.attacksPerSecond;
    this.range = BASE_STATS.range;
    this.cooldown = 0;
    this.target = null;
  }
}
