import { Scene, Vector3 } from 'three';
import { Blast } from '../combat/Blast';
import { Bolt } from '../combat/Bolt';
import { Enemy } from '../enemies/Enemy';
import { XPOrb } from '../progression/XPOrb';

/** Plain arrays with update-and-cull loops — an ECS would be pure overhead at this entity count. */
export class EntityManager {
  readonly enemies: Enemy[] = [];
  readonly orbs: XPOrb[] = [];
  /**
   * Live area attacks. Kept apart from `enemies` because a blast is not a
   * target: it has no health, the auto-weapon must never lock onto one, and it
   * outlives the seeder that planted it — killing the planter does not defuse
   * what is already ticking.
   */
  readonly blasts: Blast[] = [];
  /** Live spitter projectiles. Apart from `enemies` for the same reasons as blasts, which they outlive-their-shooter exactly like. */
  readonly bolts: Bolt[] = [];

  constructor(private readonly scene: Scene) {}

  addEnemy(enemy: Enemy): void {
    this.enemies.push(enemy);
    this.scene.add(enemy.mesh);
  }

  addBlast(blast: Blast): void {
    this.blasts.push(blast);
    this.scene.add(blast.group);
  }

  addBolt(bolt: Bolt): void {
    this.bolts.push(bolt);
    this.scene.add(bolt.mesh);
  }

  addOrb(orb: XPOrb): void {
    this.orbs.push(orb);
    this.scene.add(orb.mesh);
  }

  get entityCount(): number {
    return this.enemies.length + this.orbs.length + this.blasts.length + this.bolts.length;
  }

  /** Drops blasts that have finished detonating. They expire on their own clock, so there is no distance cull. */
  cullSpentBlasts(): void {
    for (let i = this.blasts.length - 1; i >= 0; i--) {
      if (this.blasts[i].finished) this.removeBlastAt(i);
    }
  }

  /** Drops bolts that hit, fizzled on terrain, or timed out. */
  cullSpentBolts(): void {
    for (let i = this.bolts.length - 1; i >= 0; i--) {
      if (this.bolts[i].finished) this.removeBoltAt(i);
    }
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

  // Enemies deliberately have no distance cull — Vampire-Survivors persistence:
  // an enemy leaves the world by dying, by a Monolith's arrival (`clearEnemies`,
  // a duel rule, not a distance rule), by rewind reconciliation, or by the run
  // ending. What changed with the wave rework is what "left behind" means: a
  // straggler far *behind* the travel direction is ring-relocated back to the
  // fight (`Enemy.relocateTo`, same entity and rewind identity, health kept).
  // The original rule — persist in place, it re-engages when the loop returns —
  // was written for the ring course; on a one-way descent a dropped straggler
  // never re-engages and only accrues sim and rewind cost. See docs/STATE.md.

  /**
   * Enemies inside the local fight, for the spawn director's concurrency cap.
   *
   * With persistence, counting *all* live enemies would let far stragglers eat
   * the cap and starve spawning near the player — outrunning the swarm would
   * make the game emptier, backwards. The radius keeps the cap meaning what it
   * always meant ("how busy is the fight around the player"); it just no longer
   * kills anything for crossing it.
   */
  countEnemiesWithin(playerPosition: Vector3, radius: number): number {
    const radiusSq = radius * radius;
    let count = 0;
    for (const enemy of this.enemies) {
      if (enemy.position.distanceToSquared(playerPosition) <= radiusSq) count += 1;
    }
    return count;
  }

  // Orbs deliberately have no distance cull. Dropped XP is earned, and there is
  // no distance at which it stops being plausibly collectable — courses loop and
  // the player comes back. An uncollected orb hovers where it fell until the
  // magnet reaches it, a rewind reconciles it, or the run itself ends
  // (`clear`). That is a design rule, not an oversight — the cull this replaced
  // deleted live loot three different ways. See docs/STATE.md.

  /**
   * Drops every enemy the predicate rejects. The rewind uses this to delete
   * enemies that had not spawned yet at the frame being restored — going
   * through the same `removeEnemyAt` as every other path, so the mesh is
   * unparented and the per-enemy material freed exactly once.
   */
  retainEnemies(keep: (enemy: Enemy) => boolean): void {
    for (let i = this.enemies.length - 1; i >= 0; i--) {
      if (!keep(this.enemies[i])) this.removeEnemyAt(i);
    }
  }

  /** Same for orbs — an orb collected after the rewind point must exist again. */
  retainOrbs(keep: (orb: XPOrb) => boolean): void {
    for (let i = this.orbs.length - 1; i >= 0; i--) {
      if (!keep(this.orbs[i])) this.removeOrbAt(i);
    }
  }

  clear(): void {
    this.clearEnemies();
    for (let i = this.orbs.length - 1; i >= 0; i--) this.removeOrbAt(i);
    this.clearBlasts();
    this.clearBolts();
  }

  /**
   * Wipes live area attacks. Used when a Monolith arrives and when a run
   * restarts: a blast planted a second before the arena changed would otherwise
   * detonate under a player who never saw it planted.
   */
  clearBlasts(): void {
    for (let i = this.blasts.length - 1; i >= 0; i--) this.removeBlastAt(i);
  }

  /** Same occasions as `clearBlasts`, same reasoning — in-flight shots don't survive an arena change. */
  clearBolts(): void {
    for (let i = this.bolts.length - 1; i >= 0; i--) this.removeBoltAt(i);
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

  /** Blasts share their geometry but own their two materials. */
  private removeBlastAt(index: number): void {
    this.scene.remove(this.blasts[index].group);
    this.blasts[index].dispose();
    this.blasts.splice(index, 1);
  }

  /** Orbs share one module-level geometry+material, so unparenting is the whole teardown. */
  private removeOrbAt(index: number): void {
    this.scene.remove(this.orbs[index].mesh);
    this.orbs.splice(index, 1);
  }

  /** Bolts share geometry+material like orbs — unparenting is the whole teardown. */
  private removeBoltAt(index: number): void {
    this.scene.remove(this.bolts[index].mesh);
    this.bolts.splice(index, 1);
  }
}
