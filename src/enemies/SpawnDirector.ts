import { Vector3 } from 'three';
import { Difficulty, difficultyAt, ELITE_DAMAGE_MULT, ELITE_HP_MULT } from './Difficulty';
import { Enemy } from './Enemy';
import { Lancer } from './Lancer';
import { Seeder } from './Seeder';
import { Swarmer } from './Swarmer';
import { pickPatternPoints } from './SpawnPlacement';
import { ArchetypeId, drawArchetype, drawPattern, waveAt } from './Waves';

export interface SpawnContext {
  playerPosition: Vector3;
  /** Unit vector along the player's 3D direction of travel (falls back to look direction when still). */
  travelDirection: Vector3;
  playerSpeed: number;
  /**
   * Enemies inside the local fight (`EntityManager.countEnemiesWithin`), used
   * to enforce the concurrency cap. Deliberately NOT the total live count:
   * enemies persist forever now, so counting far stragglers would starve
   * spawning near a player who outruns the swarm — the better you surf, the
   * emptier the game would get, which is backwards.
   */
  nearbyEnemyCount: number;
  /**
   * The player's current level. Together with the run clock this is the whole
   * input to `Difficulty`, and it is the term that keeps growing after the time
   * ramps have topped out — which is what makes an endless run stay a run.
   */
  playerLevel: number;
  /**
   * Monoliths felled — the act index for `Waves`. Needs no rewind state of its
   * own: `bossEpoch` truncates the rewind window at any boss transition, so
   * this is constant across every reachable frame.
   */
  bossesFelled: number;
}

export interface SpawnSnapshot {
  survivalTime: number;
  timeSinceLastSpawn: number;
  suspended: boolean;
}

/**
 * Spawns the horde on a ring around the player — near enough to be felt
 * immediately, never inside the corridor the player is about to fly through
 * (`SpawnPlacement` holds that geometry and its rationale). A moving player
 * reads it as wading through a field of threats the intercept AI arcs in from
 * the sides; a still player gets encircled, which keeps the combat layer's
 * pressure pointed at its one commandment: keep surfing.
 *
 * Both batch size and the *local* population are capped — the cap counts only
 * enemies near the fight, because enemies persist once spawned and a cap on
 * the global count would starve the fight as stragglers accumulate.
 */
export class SpawnDirector {
  /**
   * Halts new drones without stopping the run clock — set while a Monolith is
   * alive so the fight is a duel rather than a duel plus a drone stream. The
   * clock keeps ticking because the survival time is what the HUD shows and
   * what the game-over screen reports.
   */
  suspended = false;

  private timeSinceLastSpawn = 0;
  private survivalTime = 0;

  tick(dt: number, ctx: SpawnContext, spawnEnemy: (enemy: Enemy) => void): void {
    this.survivalTime += dt;
    if (this.suspended) return;
    this.timeSinceLastSpawn += dt;

    const difficulty = difficultyAt(ctx.playerLevel, this.survivalTime);
    const { spec } = waveAt(ctx.playerLevel, ctx.bossesFelled);
    if (this.timeSinceLastSpawn < difficulty.spawnInterval * spec.cadenceScale) return;
    this.timeSinceLastSpawn = 0;

    const capacity = difficulty.liveCap - ctx.nearbyEnemyCount;
    if (capacity <= 0) return;

    // The wave decides the batch's *shape*; the difficulty curve still owns
    // its size, except that a drawn cluster is sized like a cluster — and the
    // capacity cap binds either way, so a pattern can never bust the budget.
    const pattern = drawPattern(spec);
    let desired = difficulty.batchSize;
    if (pattern === 'cluster' && spec.clusterSize) {
      const [min, max] = spec.clusterSize;
      desired = min + Math.floor(Math.random() * (max - min + 1));
    }
    const points = pickPatternPoints(ctx, pattern, Math.min(desired, capacity));

    // Archetypes are drawn per-spawn rather than per-batch, so a batch is a
    // mix and the player never gets a lull of "only drones" to relax into.
    for (const position of points) {
      const elite = Math.random() < spec.eliteChance;
      spawnEnemy(this.buildEnemy(drawArchetype(spec), difficulty, position, elite));
    }
  }

  /**
   * The single construction site for every spawned enemy. Elite stat
   * multipliers are applied to the numbers *before* construction and
   * `markElite` handles only look and drops — that split is what lets the
   * rewind replay recorded (already-multiplied) stats through the same
   * constructors without compounding them.
   */
  private buildEnemy(
    archetype: ArchetypeId,
    difficulty: Difficulty,
    position: Vector3,
    elite: boolean,
  ): Enemy {
    const hpMult = elite ? ELITE_HP_MULT : 1;
    const damageMult = elite ? ELITE_DAMAGE_MULT : 1;

    let enemy: Enemy;
    switch (archetype) {
      case 'seeder':
        enemy = new Seeder(
          position,
          difficulty.seederHp * hpMult,
          difficulty.seederSpeed,
          difficulty.seederContactDamage * damageMult,
          difficulty.blastDamage * damageMult,
        );
        break;
      case 'swarmer':
        enemy = new Swarmer(
          position,
          difficulty.swarmerHp * hpMult,
          difficulty.swarmerSpeed,
          difficulty.swarmerContactDamage * damageMult,
        );
        break;
      case 'lancer':
        enemy = new Lancer(
          position,
          difficulty.lancerHp * hpMult,
          difficulty.lancerSpeed,
          difficulty.lancerContactDamage * damageMult,
        );
        break;
      default:
        // 'drone' — and, until Stage 4 lands, the bulwark/spitter entries the
        // act-2 tables already name fall back to drones so the tables can
        // ship ahead of the classes.
        enemy = new Enemy(
          position,
          difficulty.droneHp * hpMult,
          difficulty.droneSpeed,
          difficulty.droneContactDamage * damageMult,
        );
        break;
    }
    if (elite) enemy.markElite();
    return enemy;
  }

  /**
   * The run clock and the spawn cadence, for the rewind recorder. Both are
   * private and both must travel: the clock is what the HUD and the game-over
   * screen report, and difficulty is a function of it.
   */
  capture(): SpawnSnapshot {
    return {
      survivalTime: this.survivalTime,
      timeSinceLastSpawn: this.timeSinceLastSpawn,
      suspended: this.suspended,
    };
  }

  restore(snapshot: SpawnSnapshot): void {
    this.survivalTime = snapshot.survivalTime;
    this.timeSinceLastSpawn = snapshot.timeSinceLastSpawn;
    this.suspended = snapshot.suspended;
  }

  reset(): void {
    this.timeSinceLastSpawn = 0;
    this.survivalTime = 0;
    this.suspended = false;
  }

  get elapsedSeconds(): number {
    return this.survivalTime;
  }
}
