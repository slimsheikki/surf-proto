import { ConeGeometry, Quaternion, Vector3 } from 'three';
import { Enemy, EnemyVisual } from './Enemy';

/**
 * Bone-white and elongated, and the elongation is the telegraph: the spike's
 * long axis points where the dash will go, so the threat is legible before
 * the flash finishes.
 */
const GEOMETRY = new ConeGeometry(0.32, 1.7, 6);
const LANCER_VISUAL: EnemyVisual = {
  geometry: GEOMETRY,
  color: 0xf2ede2,
  emissive: 0xcfc6b4,
  emissiveIntensity: 0.7,
};

const WINDUP_SECONDS = 0.5;
const DASH_SECONDS = 0.8;
/**
 * The one sanctioned exception to the "no enemy above 22 u/s" law (see
 * `MAX_DRONE_SPEED` in `Difficulty`). The dash is a committed straight line:
 * aimed once at windup start, never steered after, announced by half a second
 * of flare, and followed by a long recovery — so it can scare a surfer and
 * still cannot hound one. Sustained pursuit (the drift) stays far under the
 * ceiling; this number is a lunge, not a speed.
 */
const DASH_SPEED = 34;
const RECOVER_SECONDS = 2.5;
/** Drift is deliberately lazy — the lancer's job is the dash, not the chase. */
const DRIFT_SPEED_SCALE = 0.5;
/** Range at which the windup arms. Just outside the auto-weapon's 22u envelope. */
const DASH_TRIGGER_RANGE = 24;
/** Emissive multiplier at full windup — the flare that says "move". */
const WINDUP_FLARE = 2.5;

const CONE_UP = new Vector3(0, 1, 0);
const scratchDir = new Vector3();
const scratchQuat = new Quaternion();

type LancerPhase = 'recover' | 'drift' | 'windup' | 'dash';

/**
 * The dodge test. Drifts in slowly, flares for half a second while pointing
 * at its committed line, then lances down it far faster than it could ever
 * chase — one strafe off the line and it overshoots into 2.5 s of recovery.
 *
 * Spawns in `recover`, which is longer than the materialize and the spawn
 * grace combined, so a lancer can never open with a dash the player had no
 * time to see arm.
 *
 * The dash bypasses `moveToward` entirely: no turn-rate, no aim error, and —
 * deliberately — no Standing Wave slow, because a telegraphed commitment that
 * could be dragged mid-flight would punish the player for a dodge they had
 * already won.
 */
export class Lancer extends Enemy {
  private phase: LancerPhase = 'recover';
  private phaseTimer = RECOVER_SECONDS;
  private readonly dashTarget = new Vector3();
  private readonly dashDir = new Vector3();

  constructor(position: Vector3, hp: number, moveSpeed: number, contactDamage: number) {
    super(position, hp, moveSpeed, contactDamage, LANCER_VISUAL);
  }

  tick(dt: number, playerPosition: Vector3, playerVelocity: Vector3): void {
    switch (this.phase) {
      case 'recover':
        this.moveToward(this.aimPoint(playerPosition, playerVelocity), dt, DRIFT_SPEED_SCALE);
        this.phaseTimer -= dt;
        if (this.phaseTimer <= 0) this.phase = 'drift';
        this.orientAlong(this.heading);
        break;

      case 'drift':
        this.moveToward(this.aimPoint(playerPosition, playerVelocity), dt, DRIFT_SPEED_SCALE);
        this.orientAlong(this.heading);
        if (this.position.distanceTo(playerPosition) <= DASH_TRIGGER_RANGE) {
          this.phase = 'windup';
          this.phaseTimer = WINDUP_SECONDS;
          // Aimed once, here, and never again: the flare that follows is an
          // honest promise about where the dash will go.
          this.dashTarget.copy(this.aimPoint(playerPosition, playerVelocity));
        }
        break;

      case 'windup': {
        this.phaseTimer -= dt;
        const progress = 1 - Math.max(0, this.phaseTimer) / WINDUP_SECONDS;
        this.material.emissiveIntensity =
          this.baseEmissiveIntensity * (1 + (WINDUP_FLARE - 1) * progress);
        scratchDir.copy(this.dashTarget).sub(this.position);
        if (scratchDir.lengthSq() > 1e-6) this.orientAlong(scratchDir.normalize());
        if (this.phaseTimer <= 0) {
          this.dashDir.copy(this.dashTarget).sub(this.position);
          if (this.dashDir.lengthSq() < 1e-6) this.dashDir.copy(this.heading);
          this.dashDir.normalize();
          this.phase = 'dash';
          this.phaseTimer = DASH_SECONDS;
        }
        break;
      }

      case 'dash':
        this.position.addScaledVector(this.dashDir, DASH_SPEED * dt);
        this.orientAlong(this.dashDir);
        this.phaseTimer -= dt;
        if (this.phaseTimer <= 0) {
          this.phase = 'recover';
          this.phaseTimer = RECOVER_SECONDS;
          this.material.emissiveIntensity = this.baseEmissiveIntensity;
        }
        break;
    }

    this.updateVisuals(dt);
  }

  /** Points the cone's long axis along `dir` (unit). */
  private orientAlong(dir: Vector3): void {
    if (dir.lengthSq() < 1e-6) return;
    this.mesh.quaternion.copy(scratchQuat.setFromUnitVectors(CONE_UP, dir));
  }
}
