import {
  AdditiveBlending,
  CircleGeometry,
  DoubleSide,
  Mesh,
  MeshBasicMaterial,
  Vector3,
} from 'three';
import { WeaponTarget } from './Weapon';

/* ------------------------------------------------------------------ *
 * Stats
 * ------------------------------------------------------------------ */

/** 3.5 units is ~158 Hammer units at this project's 1:45 scale — knife range. */
export const KNIFE_RANGE = 3.5;
/** Half-angle of the damage cone, measured off the yaw-plane forward vector. */
export const KNIFE_CONE_HALF_ANGLE_DEG = 50;
export const KNIFE_COOLDOWN = 0.55;
export const KNIFE_BASE_DAMAGE = 45;

/* ------------------------------------------------------------------ *
 * Speed bonus
 *
 * Isolated on purpose: delete `speedBonus()` and its three constants and the
 * knife is a flat 45-damage cleave with nothing else to unpick.
 *
 * The knife is a melee weapon in a game where the player is never on the
 * ground and never slower than they choose to be. Flat damage would make it a
 * button to mash whenever a drone drifts close. Scaling it off carried speed
 * turns it into the payoff for holding a good surf line: a stationary player
 * does 45, a surfer at 40 u/s does 80 (45 + capped 35).
 * ------------------------------------------------------------------ */

/** Speed below which the knife pays no bonus at all. */
export const SPEED_BONUS_MIN_SPEED = 10;
/** Extra damage per u/s above the threshold. */
export const SPEED_BONUS_PER_UNIT = 1.0;
/** Cap, reached at 45 u/s — just past the top of the normal surf band. */
export const SPEED_BONUS_MAX = 35;

function speedBonus(speed: number): number {
  const over = Math.max(0, speed - SPEED_BONUS_MIN_SPEED);
  return Math.min(SPEED_BONUS_MAX, over * SPEED_BONUS_PER_UNIT);
}

/** Damage a swing at this speed would deal. Exported for HUD/tests. */
export function knifeDamageAtSpeed(speed: number): number {
  return KNIFE_BASE_DAMAGE + speedBonus(speed);
}

const CONE_COS_LIMIT = Math.cos((KNIFE_CONE_HALF_ANGLE_DEG * Math.PI) / 180);

/* ------------------------------------------------------------------ *
 * Targets
 * ------------------------------------------------------------------ */

/**
 * The auto-weapon's target contract plus a world position.
 *
 * `WeaponTarget` alone is not enough: it answers "how far" but not "which way",
 * and a cone test needs a direction. Both concrete targets (`Enemy`, `Boss`)
 * already expose `readonly position`, so widening the requirement here costs
 * nothing at the call site and leaves `Weapon.ts` untouched — `Game` keeps one
 * array, typed as `KnifeTarget[]`, and hands it to both weapons.
 *
 * Distance still goes through `distanceToPlayer` rather than through
 * `position`, deliberately: the boss subtracts its own engagement radius there
 * so that a 5.5-unit sphere hovering over the island reads as reachable. Using
 * raw positions would silently make the knife the one weapon that can never
 * touch the boss.
 */
export interface KnifeTarget extends WeaponTarget {
  readonly position: Vector3;
}

/** Everything the knife needs to know about the player. */
export interface KnifeWielder {
  readonly position: Vector3;
  readonly yaw: number;
  readonly speed: number;
}

export interface KnifeSwing {
  /** Damage dealt to each target hit, after the speed bonus. */
  damage: number;
  /** How many targets were inside the cone. Zero for a whiff. */
  hitCount: number;
}

/**
 * Manual melee attack: a cleaving cone swing on the left mouse button.
 *
 * Contrast with `Weapon`, which is a single-target auto-attack that needs no
 * input. The knife is the opposite trade in every respect — it must be aimed,
 * it must be timed, it hits everything in front of you, and it rewards speed.
 */
export class Knife {
  readonly range = KNIFE_RANGE;
  readonly coneHalfAngleDeg = KNIFE_CONE_HALF_ANGLE_DEG;

  private cooldown = 0;
  /**
   * At most one buffered swing. Holding or spamming the button during the
   * cooldown must not bank a burst of swings that all land the moment it ends.
   */
  private queued = false;

  /**
   * @returns the swing that fired this tick, or null. A swing is returned even
   * when it hits nothing — a whiff is still a swing, and the caller needs it to
   * play the animation and show the reach.
   */
  tick(
    dt: number,
    wielder: KnifeWielder,
    targets: readonly KnifeTarget[],
    attackPressed: boolean,
  ): KnifeSwing | null {
    if (this.cooldown > 0) this.cooldown -= dt;
    if (attackPressed) this.queued = true;
    if (!this.queued || this.cooldown > 0) return null;

    this.queued = false;
    this.cooldown = KNIFE_COOLDOWN;
    return this.swing(wielder, targets);
  }

  private swing(wielder: KnifeWielder, targets: readonly KnifeTarget[]): KnifeSwing {
    const damage = knifeDamageAtSpeed(wielder.speed);
    let hitCount = 0;
    for (const target of targets) {
      if (!this.isInCone(wielder, target)) continue;
      target.health.takeDamage(damage);
      target.flashHit();
      hitCount++;
    }
    return { damage, hitCount };
  }

  /**
   * Yaw-plane cone test. Pitch is ignored on purpose: the player is airborne
   * permanently and is constantly looking up or down the ramp they are riding,
   * so a full 3D cone would make the knife whiff for reasons that have nothing
   * to do with aim. Horizontally it still has to be pointed at the target.
   */
  private isInCone(wielder: KnifeWielder, target: KnifeTarget): boolean {
    if (target.health.isDead) return false;
    if (target.distanceToPlayer(wielder.position) > KNIFE_RANGE) return false;

    const dx = target.position.x - wielder.position.x;
    const dz = target.position.z - wielder.position.z;
    const flatDistSq = dx * dx + dz * dz;
    // Directly overhead / inside the player: there is no meaningful direction
    // to test, and something that close is unambiguously hit.
    if (flatDistSq < 1e-6) return true;

    // Same convention as PlayerController.wishDir: -Z at yaw 0, toward -X as yaw grows.
    const fx = -Math.sin(wielder.yaw);
    const fz = -Math.cos(wielder.yaw);
    const cos = (dx * fx + dz * fz) / Math.sqrt(flatDistSq);
    return cos >= CONE_COS_LIMIT;
  }

  /** Damage the next swing would deal at this speed. */
  previewDamage(speed: number): number {
    return knifeDamageAtSpeed(speed);
  }

  get isReady(): boolean {
    return this.cooldown <= 0;
  }

  reset(): void {
    this.cooldown = 0;
    this.queued = false;
  }
}

/* ------------------------------------------------------------------ *
 * Cone effect
 * ------------------------------------------------------------------ */

const CONE_FADE_SECONDS = 0.18;
const CONE_START_OPACITY = 0.55;
const CONE_END_SCALE = 1.12;
const CONE_COLOR = 0x7fe8ff;
/** Roughly chest height on a 1.6-eye-height player whose origin is at the feet. */
const CONE_HEIGHT = 1.1;
const CONE_SEGMENTS = 40;

/**
 * A one-shot world-space flash of the knife's *actual* hit volume: same radius,
 * same angular width, same yaw-plane orientation as `Knife.isInCone` tests.
 * Drawn in the world rather than on the viewmodel so the player can see their
 * reach against the drones they missed, and learn it in one or two swings.
 *
 * Built from the same constants as the hit test, so it cannot drift out of sync
 * with the hitbox if those are retuned.
 */
export class SlashCone {
  readonly mesh: Mesh;
  private readonly material: MeshBasicMaterial;
  private timer = 0;

  constructor() {
    const half = (KNIFE_CONE_HALF_ANGLE_DEG * Math.PI) / 180;
    // The sector is built centred on local +Y. After the -90 deg X rotation
    // below that maps to world -Z, which is forward at yaw 0 — so applying the
    // player's yaw on top points the wedge exactly where the cone test does.
    const geometry = new CircleGeometry(KNIFE_RANGE, CONE_SEGMENTS, Math.PI / 2 - half, half * 2);
    this.material = new MeshBasicMaterial({
      color: CONE_COLOR,
      transparent: true,
      opacity: CONE_START_OPACITY,
      blending: AdditiveBlending,
      depthWrite: false,
      side: DoubleSide,
    });
    this.mesh = new Mesh(geometry, this.material);
    this.mesh.visible = false;
    // Additive and depth-writeless: draw late so it lands over solid geometry.
    this.mesh.renderOrder = 10;
  }

  /** Restarts the flash at the player's current position and facing. */
  trigger(playerPosition: Vector3, yaw: number): void {
    this.timer = CONE_FADE_SECONDS;
    this.mesh.position.set(playerPosition.x, playerPosition.y + CONE_HEIGHT, playerPosition.z);
    this.mesh.rotation.set(-Math.PI / 2, yaw, 0, 'YXZ');
    this.mesh.scale.setScalar(1);
    this.material.opacity = CONE_START_OPACITY;
    this.mesh.visible = true;
  }

  tick(dt: number): void {
    if (this.timer <= 0) return;
    this.timer -= dt;
    if (this.timer <= 0) {
      this.mesh.visible = false;
      return;
    }
    // 1 at trigger, 0 at the end of the fade.
    const remaining = this.timer / CONE_FADE_SECONDS;
    this.material.opacity = CONE_START_OPACITY * remaining;
    this.mesh.scale.setScalar(1 + (CONE_END_SCALE - 1) * (1 - remaining));
  }

  hide(): void {
    this.timer = 0;
    this.mesh.visible = false;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}
