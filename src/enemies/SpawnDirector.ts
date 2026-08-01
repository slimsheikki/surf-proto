import { Vector3 } from 'three';
import { Enemy } from './Enemy';

const MIN_SPAWN_INTERVAL = 1.2;
const INITIAL_SPAWN_INTERVAL = 2.5;
const DIFFICULTY_RAMP_SECONDS = 45;
const BATCH_GROWTH_SECONDS = 90;
/** Hard cap on batch size — the old `1 + floor(t/40)` grew without limit (~16 drones per spawn at 10 min). */
const MAX_BATCH_SIZE = 2;

const BASE_HP = 10;
const HP_PER_SECOND = 0.25;
const MAX_HP_BONUS = 30;

const BASE_MOVE_SPEED = 9;
const MOVE_SPEED_RAMP_SECONDS = 40;
const MAX_MOVE_SPEED_BONUS = 6;

const CONTACT_DAMAGE = 5;

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
export class SpawnDirector {
  /** Ceiling on simultaneously live drones; the real population is normally far below this. */
  static readonly MAX_LIVE_ENEMIES = 32;

  /**
   * Halts new drones without stopping the run clock — set while the level-10
   * boss is alive so the fight is a duel rather than a duel plus a drone
   * stream. The clock keeps ticking because the survival time is what the HUD
   * shows and what the victory screen reports.
   */
  suspended = false;

  private timeSinceLastSpawn = 0;
  private survivalTime = 0;

  tick(dt: number, ctx: SpawnContext, spawnEnemy: (enemy: Enemy) => void): void {
    this.survivalTime += dt;
    if (this.suspended) return;
    this.timeSinceLastSpawn += dt;

    const spawnInterval = Math.max(
      MIN_SPAWN_INTERVAL,
      INITIAL_SPAWN_INTERVAL - this.survivalTime / DIFFICULTY_RAMP_SECONDS,
    );
    if (this.timeSinceLastSpawn < spawnInterval) return;
    this.timeSinceLastSpawn = 0;

    const capacity = SpawnDirector.MAX_LIVE_ENEMIES - ctx.liveEnemyCount;
    if (capacity <= 0) return;

    const batchSize = Math.min(
      MAX_BATCH_SIZE,
      1 + Math.floor(this.survivalTime / BATCH_GROWTH_SECONDS),
      capacity,
    );
    for (let i = 0; i < batchSize; i++) {
      spawnEnemy(this.spawnOne(ctx));
    }
  }

  private spawnOne(ctx: SpawnContext): Enemy {
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

    const hp = BASE_HP + Math.min(this.survivalTime * HP_PER_SECOND, MAX_HP_BONUS);
    const moveSpeed =
      BASE_MOVE_SPEED +
      Math.min(this.survivalTime / MOVE_SPEED_RAMP_SECONDS, MAX_MOVE_SPEED_BONUS);
    return new Enemy(position, hp, moveSpeed, CONTACT_DAMAGE);
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
