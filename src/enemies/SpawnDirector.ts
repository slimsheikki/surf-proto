import { Vector3 } from 'three';
import { Difficulty, difficultyAt } from './Difficulty';
import { Enemy } from './Enemy';
import { Seeder } from './Seeder';

/** How far ahead along the travel direction drones appear, so they're met head-on. */
const BASE_FORWARD_DIST = 22;
const FORWARD_DIST_PER_SPEED = 0.5;
const MAX_SPEED_LEAD = 12;
const FORWARD_DIST_JITTER = 8;
/** Kept tight so spawns land near the player's actual path, inside the weapon's envelope. */
const LATERAL_SPREAD = 8;
const VERTICAL_SPREAD = 4;

const UP = new Vector3(0, 1, 0);

export interface SpawnContext {
  playerPosition: Vector3;
  /** Unit vector along the player's 3D direction of travel (falls back to look direction when still). */
  travelDirection: Vector3;
  playerSpeed: number;
  /** Live enemies currently in the world, used to enforce the concurrency cap. */
  liveEnemyCount: number;
  /**
   * The player's current level. Together with the run clock this is the whole
   * input to `Difficulty`, and it is the term that keeps growing after the time
   * ramps have topped out — which is what makes an endless run stay a run.
   */
  playerLevel: number;
}

/**
 * Spawns drones ahead of the player's direction of travel, like obstacles in
 * a runner, rather than ringing a static arena — this keeps most of a ramp
 * run clear for pure surfing and turns combat into punctuation, not a
 * constant distraction.
 *
 * Spawn distance scales with the player's speed so a 35 u/s surfer still gets
 * roughly the same fraction of a second of approach time as a 10 u/s one, and
 * both batch size and total live population are capped so entity count can
 * never grow without bound over a long run.
 */
export interface SpawnSnapshot {
  survivalTime: number;
  timeSinceLastSpawn: number;
  suspended: boolean;
}

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

    const capacity = difficulty.liveCap - ctx.liveEnemyCount;
    if (capacity <= 0) return;

    const batchSize = Math.min(difficulty.batchSize, capacity);
    for (let i = 0; i < batchSize; i++) {
      spawnEnemy(this.spawnOne(ctx, difficulty));
    }
  }

  private spawnOne(ctx: SpawnContext, difficulty: Difficulty): Enemy {
    const forward = ctx.travelDirection;
    // Lateral basis from the horizontal component of travel, so spread stays
    // level with the world even when the player is plunging down a 78° ramp.
    const lateral = new Vector3().crossVectors(UP, forward);
    if (lateral.lengthSq() < 1e-6) lateral.set(1, 0, 0);
    lateral.normalize();

    const forwardDist =
      BASE_FORWARD_DIST +
      Math.min(ctx.playerSpeed * FORWARD_DIST_PER_SPEED, MAX_SPEED_LEAD) +
      Math.random() * FORWARD_DIST_JITTER;
    const lateralOffset = (Math.random() - 0.5) * LATERAL_SPREAD;
    const verticalOffset = (Math.random() - 0.35) * VERTICAL_SPREAD;

    const position = ctx.playerPosition
      .clone()
      .addScaledVector(forward, forwardDist)
      .addScaledVector(lateral, lateralOffset)
      .add(new Vector3(0, verticalOffset, 0));

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
