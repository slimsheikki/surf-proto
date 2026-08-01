import { Scene, Vector3 } from 'three';
import { Enemy } from '../enemies/Enemy';
import { XPOrb } from '../progression/XPOrb';

/** Plain arrays with update-and-cull loops — an ECS would be pure overhead at this entity count. */
export class EntityManager {
  readonly enemies: Enemy[] = [];
  readonly orbs: XPOrb[] = [];

  constructor(private readonly scene: Scene) {}

  addEnemy(enemy: Enemy): void {
    this.enemies.push(enemy);
    this.scene.add(enemy.mesh);
  }

  addOrb(orb: XPOrb): void {
    this.orbs.push(orb);
    this.scene.add(orb.mesh);
  }

  get entityCount(): number {
    return this.enemies.length + this.orbs.length;
  }

  cullDeadEnemies(onKilled: (enemy: Enemy) => void): void {
    for (let i = this.enemies.length - 1; i >= 0; i--) {
      const enemy = this.enemies[i];
      if (enemy.health.isDead) {
        onKilled(enemy);
        this.removeEnemyAt(i);
      }
    }
  }

  cullCollectedOrbs(onCollected: (orb: XPOrb) => void): void {
    for (let i = this.orbs.length - 1; i >= 0; i--) {
      const orb = this.orbs[i];
      if (orb.collected) {
        onCollected(orb);
        this.removeOrbAt(i);
      }
    }
  }

  /**
   * Drops drones the player has left far behind. Deliberately callback-free:
   * leaving play is not a kill, so it must never award XP.
   * Returns how many were removed (handy for diagnostics/tests).
   */
  cullDistantEnemies(playerPosition: Vector3, maxDistance: number): number {
    const maxDistSq = maxDistance * maxDistance;
    let removed = 0;
    for (let i = this.enemies.length - 1; i >= 0; i--) {
      if (this.enemies[i].position.distanceToSquared(playerPosition) > maxDistSq) {
        this.removeEnemyAt(i);
        removed += 1;
      }
    }
    return removed;
  }

  /** Same for orbs dropped mid-surf that the player rocketed past and will never come back for. */
  cullDistantOrbs(playerPosition: Vector3, maxDistance: number): number {
    const maxDistSq = maxDistance * maxDistance;
    let removed = 0;
    for (let i = this.orbs.length - 1; i >= 0; i--) {
      if (this.orbs[i].position.distanceToSquared(playerPosition) > maxDistSq) {
        this.removeOrbAt(i);
        removed += 1;
      }
    }
    return removed;
  }

  clear(): void {
    this.clearEnemies();
    for (let i = this.orbs.length - 1; i >= 0; i--) this.removeOrbAt(i);
  }

  /**
   * Drops every live drone but keeps XP orbs, which the player has already
   * earned. Used when the boss arrives, so the fight starts clean without
   * confiscating loot that is still in flight.
   */
  clearEnemies(): void {
    for (let i = this.enemies.length - 1; i >= 0; i--) this.removeEnemyAt(i);
  }

  /** Single teardown path: every removal unparents the mesh and frees the per-enemy material. */
  private removeEnemyAt(index: number): void {
    const enemy = this.enemies[index];
    this.scene.remove(enemy.mesh);
    enemy.dispose();
    this.enemies.splice(index, 1);
  }

  /** Orbs share one module-level geometry+material, so unparenting is the whole teardown. */
  private removeOrbAt(index: number): void {
    this.scene.remove(this.orbs[index].mesh);
    this.orbs.splice(index, 1);
  }
}
