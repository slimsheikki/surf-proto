import { Vector3 } from 'three';
import { Enemy } from './Enemy';

const MIN_SPAWN_INTERVAL = 0.6;
const INITIAL_SPAWN_INTERVAL = 2.5;
const DIFFICULTY_RAMP_SECONDS = 45;
const BATCH_GROWTH_SECONDS = 40;

/**
 * Spawns drones ahead of the player's direction of travel, like obstacles in
 * a runner, rather than ringing a static arena — this keeps most of a ramp
 * run clear for pure surfing and turns combat into punctuation, not a
 * constant distraction.
 */
export class SpawnDirector {
  private timeSinceLastSpawn = 0;
  private survivalTime = 0;

  tick(
    dt: number,
    playerPosition: Vector3,
    playerForward: Vector3,
    spawnEnemy: (enemy: Enemy) => void,
  ): void {
    this.survivalTime += dt;
    this.timeSinceLastSpawn += dt;

    const spawnInterval = Math.max(
      MIN_SPAWN_INTERVAL,
      INITIAL_SPAWN_INTERVAL - this.survivalTime / DIFFICULTY_RAMP_SECONDS,
    );
    if (this.timeSinceLastSpawn < spawnInterval) return;
    this.timeSinceLastSpawn = 0;

    const batchSize = 1 + Math.floor(this.survivalTime / BATCH_GROWTH_SECONDS);
    for (let i = 0; i < batchSize; i++) {
      spawnEnemy(this.spawnOne(playerPosition, playerForward));
    }
  }

  private spawnOne(playerPosition: Vector3, playerForward: Vector3): Enemy {
    const lateral = new Vector3(-playerForward.z, 0, playerForward.x);
    const forwardDist = 18 + Math.random() * 10;
    const lateralOffset = (Math.random() - 0.5) * 14;
    const verticalOffset = (Math.random() - 0.3) * 6;

    const position = playerPosition
      .clone()
      .addScaledVector(playerForward, forwardDist)
      .addScaledVector(lateral, lateralOffset)
      .add(new Vector3(0, verticalOffset, 0));

    const hp = 12 + this.survivalTime * 0.4;
    const moveSpeed = 2.5 + Math.min(this.survivalTime / 60, 2);
    const contactDamage = 8;
    return new Enemy(position, hp, moveSpeed, contactDamage);
  }

  reset(): void {
    this.timeSinceLastSpawn = 0;
    this.survivalTime = 0;
  }

  get elapsedSeconds(): number {
    return this.survivalTime;
  }
}
