import { Vector3 } from 'three';
import { Difficulty, difficultyAt } from './Difficulty';
import { Enemy } from './Enemy';
import { Seeder } from './Seeder';
import { pickSpawnPoint } from './SpawnPlacement';

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
    if (this.timeSinceLastSpawn < difficulty.spawnInterval) return;
    this.timeSinceLastSpawn = 0;

    const capacity = difficulty.liveCap - ctx.nearbyEnemyCount;
    if (capacity <= 0) return;

    const batchSize = Math.min(difficulty.batchSize, capacity);
    for (let i = 0; i < batchSize; i++) {
      spawnEnemy(this.spawnOne(ctx, difficulty));
    }
  }

  private spawnOne(ctx: SpawnContext, difficulty: Difficulty): Enemy {
    const position = pickSpawnPoint(ctx);

    // Seeders are drawn per-spawn rather than as a scheduled wave, so a batch
    // is a mix and the player never gets a lull of "only drones" to relax into.
    if (Math.random() < difficulty.seederChance) {
      return new Seeder(
        position,
        difficulty.seederHp,
        difficulty.seederSpeed,
        difficulty.seederContactDamage,
        difficulty.blastDamage,
      );
    }
    return new Enemy(
      position,
      difficulty.droneHp,
      difficulty.droneSpeed,
      difficulty.droneContactDamage,
    );
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
