import { CylinderGeometry, Vector3 } from 'three';
import { BOLT_SPEED } from '../combat/Bolt';
import { Enemy, EnemyVisual } from './Enemy';

/**
 * A flat amber disc — nothing else in the roster is flat, and the warm body
 * pairs it with the pale gold bolts it fires, the same colour-rhyme that binds
 * every enemy to what it throws.
 *
 * **It was emerald, and the Swarmer is already green.** One is a harmless cloud
 * you fly through and the other is the thing shooting at you from thirty units
 * out; they cannot share a hue. Amber also says what the thing it lobs is —
 * hot. It sits near the Monolith's orange ring shots, which is survivable for
 * one specific reason: a Monolith's arrival calls `clearEnemies`, so the two
 * are never on screen together.
 */
const GEOMETRY = new CylinderGeometry(0.78, 0.78, 0.26, 10);
const SPITTER_VISUAL: EnemyVisual = {
  geometry: GEOMETRY,
  color: 0xff9e2c,
  emissive: 0xc96a00,
  emissiveIntensity: 1.0,
};

/**
 * The standoff band. Inside it the spitter backs off; outside the approach
 * radius it closes; in between it sidles. The band sits past the auto-weapon's
 * 22u envelope for the same reason the seeder's SEED_RANGE does — a ranged
 * support enemy that could only act from inside the weapon's reach would be
 * dead before it acted, the classic failure of support enemies against an
 * auto-attack. The player's counter is to *carry the fight to it*, which
 * costs line — the interesting price.
 */
const STANDOFF = 25;
const APPROACH = 35;
/** How far past the standoff band it can still fire. */
const SHOT_RANGE = 40;
const SHOT_INTERVAL = 2.5;
/** Matches the spawn contact grace: a spitter is visible well before its first shot. */
const FIRST_SHOT_DELAY = 1.2;
/** Sideways drift speed scale while holding the band. */
const SIDLE_SCALE = 0.5;
/** Cosmetic disc spin; a flat thing with no motion reads as debris, not a threat. */
const SPIN_RATE = 2.4;

const UP = new Vector3(0, 1, 0);
const scratchTarget = new Vector3();

export interface SpitterShot {
  origin: Vector3;
  velocity: Vector3;
}

/**
 * The ranged one. Holds a standoff band around the player and lobs slow
 * bolts at the interception point — the same lead solve every chaser uses,
 * re-aimed for the bolt's speed rather than its own.
 *
 * Like the seeder it never touches the scene: shots are queued and the game
 * loop polls `takePendingShot`, so the thing that owns the scene stays the
 * thing that adds to it (`Seeder.takePlantedBlast` is the precedent).
 */
export class Spitter extends Enemy {
  private shotTimer = FIRST_SHOT_DELAY;
  private pendingShot: SpitterShot | null = null;
  private spin = Math.random() * Math.PI * 2;

  constructor(
    position: Vector3,
    hp: number,
    moveSpeed: number,
    contactDamage: number,
    /** Injected like the seeder's blast damage, so it scales with the run. */
    readonly boltDamage: number,
  ) {
    super(position, hp, moveSpeed, contactDamage, SPITTER_VISUAL);
  }

  tick(dt: number, playerPosition: Vector3, playerVelocity: Vector3): void {
    const dist = this.position.distanceTo(playerPosition);
    if (dist < STANDOFF) {
      // Back straight out of the band. Away-from-player is well-defined here:
      // the standoff means dist is never near zero.
      scratchTarget
        .copy(this.position)
        .sub(playerPosition)
        .normalize()
        .multiplyScalar(10)
        .add(this.position);
      this.moveToward(scratchTarget, dt);
    } else if (dist > APPROACH) {
      this.moveToward(this.aimPoint(playerPosition, playerVelocity), dt);
    } else {
      // Hold the band: sidle around the player instead of parking, so the
      // auto-weapon's sticky lock has to be earned by actually approaching.
      scratchTarget.copy(playerPosition).sub(this.position).cross(UP).normalize();
      if (scratchTarget.lengthSq() < 0.5) scratchTarget.set(1, 0, 0);
      scratchTarget.multiplyScalar(6).add(this.position);
      this.moveToward(scratchTarget, dt, SIDLE_SCALE);
    }

    this.shotTimer -= dt;
    if (this.shotTimer <= 0 && dist <= SHOT_RANGE) {
      const lead = this.interceptSeconds(playerPosition, playerVelocity, BOLT_SPEED);
      const aim =
        lead === null
          ? scratchTarget.copy(playerPosition)
          : scratchTarget.copy(playerPosition).addScaledVector(playerVelocity, lead);
      aim.sub(this.position);
      if (aim.lengthSq() > 1e-6) {
        this.pendingShot = {
          origin: this.position.clone(),
          velocity: aim.normalize().multiplyScalar(BOLT_SPEED).clone(),
        };
        this.shotTimer = SHOT_INTERVAL;
      }
    }

    this.updateVisuals(dt);
    this.spin += dt * SPIN_RATE;
    this.mesh.rotation.set(0.35, this.spin, 0);
  }

  /** Hands over a shot queued this tick, once. Polled by the game loop. */
  takePendingShot(): SpitterShot | null {
    const shot = this.pendingShot;
    this.pendingShot = null;
    return shot;
  }
}
