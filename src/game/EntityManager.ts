import { Scene } from 'three';
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

  cullDeadEnemies(onKilled: (enemy: Enemy) => void): void {
    for (let i = this.enemies.length - 1; i >= 0; i--) {
      const enemy = this.enemies[i];
      if (enemy.health.isDead) {
        onKilled(enemy);
        this.scene.remove(enemy.mesh);
        enemy.dispose();
        this.enemies.splice(i, 1);
      }
    }
  }

  cullCollectedOrbs(onCollected: (orb: XPOrb) => void): void {
    for (let i = this.orbs.length - 1; i >= 0; i--) {
      const orb = this.orbs[i];
      if (orb.collected) {
        onCollected(orb);
        this.scene.remove(orb.mesh);
        this.orbs.splice(i, 1);
      }
    }
  }

  clear(): void {
    for (const enemy of this.enemies) {
      this.scene.remove(enemy.mesh);
      enemy.dispose();
    }
    for (const orb of this.orbs) this.scene.remove(orb.mesh);
    this.enemies.length = 0;
    this.orbs.length = 0;
  }
}
