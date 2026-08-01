import { OctahedronGeometry, Vector3 } from 'three';
import { Blast } from '../combat/Blast';
import { Enemy, EnemyVisual } from './Enemy';

/**
 * Deliberately unlike the drone: bigger, faceted, and violet rather than red.
 * A player has a fraction of a second to decide whether the thing ahead is
 * something to fly through or something to break line around, and colour is
 * the only channel that survives being read at 35 u/s in peripheral vision.
 */
const GEOMETRY = new OctahedronGeometry(0.8);
const SEEDER_VISUAL: EnemyVisual = {
  geometry: GEOMETRY,
  color: 0x9d5cff,
  emissive: 0x5a1fb0,
  emissiveIntensity: 1.1,
};

/**
 * How close the seeder has to be to plant.
 *
 * Deliberately *longer* than the auto-weapon's 22-unit range. A seeder that
 * could only act from inside the weapon's envelope would be dead before it ever
 * did anything, which is the failure mode of every support enemy in a game with
 * an auto-attack. At 30 it gets one blast off on approach, and whether it gets a
 * second depends on the player's line — which is the interesting question.
 */
const SEED_RANGE = 30;
/** Gap between plants, and the grace before the first one after spawning. */
const PLANT_INTERVAL = 2.2;
const FIRST_PLANT_DELAY = 0.9;

/**
 * Rotation, purely cosmetic, but it does real work: a slowly tumbling
 * octahedron is unmistakable against the drones' bobbing spheres even before
 * the colour registers.
 */
const SPIN_RATE = 1.4;

/**
 * A drone that attacks the *ground you are about to be on* instead of ramming
 * you.
 *
 * Everything about how it flies is the base `Enemy` — the same interception
 * solve, the same turn-rate cap — at a lower speed. The one addition is a
 * timer: whenever it is inside `SEED_RANGE`, it plants a `Blast` at the
 * player's near-future position and goes on cooldown.
 *
 * The role this fills is the one the drone cannot. A drone is a thing you meet
 * head-on and shoot; it threatens a player who is *moving into it*. A seeder
 * threatens a player who is **slow**, because a blast is escaped purely by
 * covering ground before the fuse runs out. That makes the pair complementary
 * rather than redundant: between them there is no speed at which the run is
 * safe, and — importantly — the answer to the seeder is always *surf faster*,
 * never *stop and fight*.
 *
 * The blast is not created here. This class has no scene and no entity list,
 * so it records the plant and the game loop collects it on the same tick; that
 * keeps ownership of anything with a mesh in one place.
 */
export class Seeder extends Enemy {
  private plantTimer = FIRST_PLANT_DELAY;
  private pendingPlant: Vector3 | null = null;
  private spin = 0;

  constructor(
    position: Vector3,
    hp: number,
    moveSpeed: number,
    contactDamage: number,
    /** Passed in rather than read from a constant so it scales with the run. See `Difficulty`. */
    readonly blastDamage: number,
  ) {
    super(position, hp, moveSpeed, contactDamage, SEEDER_VISUAL);
  }

  tick(dt: number, playerPosition: Vector3, playerVelocity: Vector3): void {
    this.moveToward(this.aimPoint(playerPosition, playerVelocity), dt);

    this.plantTimer -= dt;
    if (this.plantTimer <= 0 && this.position.distanceTo(playerPosition) <= SEED_RANGE) {
      this.pendingPlant = Blast.plantPoint(playerPosition, playerVelocity);
      this.plantTimer = PLANT_INTERVAL;
    }

    this.updateVisuals(dt);
    this.spin += dt * SPIN_RATE;
    this.mesh.rotation.set(this.spin * 0.6, this.spin, 0);
  }

  /**
   * Hands over a plant recorded this tick, once. Polled by the game loop rather
   * than pushed through a callback, matching how `Knife.tick` reports a swing —
   * the thing that owns the scene stays the thing that adds to it.
   */
  takePlantedBlast(): Vector3 | null {
    const plant = this.pendingPlant;
    this.pendingPlant = null;
    return plant;
  }
}
