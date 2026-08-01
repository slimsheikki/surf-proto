import {
  RingGeometry,
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
/**
 * Half-angle of the swing arc, so the full sweep is twice this.
 *
 * 35 rather than the 50 this started at. At 50 the arc spanned 100 deg, which
 * with a cleave meant a single swing deleted every drone in front of the player
 * without their having to aim at any of them — the knife stopped being a melee
 * weapon and became an area clear. 70 deg still forgives a sloppy pass at speed
 * but asks the player to actually face what they are cutting.
 */
export const KNIFE_CONE_HALF_ANGLE_DEG = 35;
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
 * already expose `readonly position`, so widening the requirement costs nothing
 * at the call site and leaves `Weapon.ts` untouched — `Game` keeps one array,
 * typed as `KnifeTarget[]`, and hands it to both weapons.
 *
 * The knife measures range from `position` and ignores the inherited
 * `distanceToPlayer` entirely. That is a deliberate departure from the
 * auto-weapon: `Boss.distanceToPlayer` subtracts a ~95-unit engagement radius
 * so that a hovering arena piece reads as "in range" for a hitscan gun. Reusing
 * it here would let a 3.5-unit melee weapon hit the boss from across the arena
 * for ~145 DPS from total safety. Real distances instead mean the boss is
 * simply not a melee target, which is the coherent reading of a 3.5-unit range.
 * (If the boss is ever brought within reach, subtract its body radius here —
 * centre distance under-reports how close its surface is.)
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

    const dx = target.position.x - wielder.position.x;
    const dy = target.position.y - wielder.position.y;
    const dz = target.position.z - wielder.position.z;
    // Range is a true 3D sphere: drones hover, and the player is airborne.
    if (dx * dx + dy * dy + dz * dz > KNIFE_RANGE * KNIFE_RANGE) return false;

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
const CONE_START_OPACITY = 0.6;
/**
 * The flash grows *into* its true size and stops there.
 *
 * It used to overshoot to 1.12, which drew a 3.92-unit reach for a 3.5-unit
 * hitbox — the one part of this effect that was allowed to lie about the thing
 * it exists to teach. Starting slightly under and settling at exactly 1 keeps
 * the pop without the lie.
 */
const CONE_START_SCALE = 0.92;
const CONE_END_SCALE = 1;
const CONE_COLOR = 0x7fe8ff;
/**
 * The band is drawn as an arc at the *outer edge* of reach rather than a filled
 * wedge, spanning this fraction of the radius inward.
 *
 * A filled sector is unreadable in first person: the player stands inside a
 * 3.5-unit volume, so it covers the lower half of the screen as an additive
 * wash instead of a shape. What actually needs communicating is where the reach
 * *ends*, and an arc at that boundary says it without painting over the view.
 */
const CONE_BAND_INNER_FRACTION = 0.72;
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
    const geometry = new RingGeometry(
      KNIFE_RANGE * CONE_BAND_INNER_FRACTION,
      KNIFE_RANGE,
      CONE_SEGMENTS,
      1,
      Math.PI / 2 - half,
      half * 2,
    );
    this.material = new MeshBasicMaterial({
      color: CONE_COLOR,
      transparent: true,
      opacity: CONE_START_OPACITY,
      // Normal blending, deliberately not additive. Additive only adds light, so
      // over the pale sky — which is most of what the player looks at while
      // airborne — the band washed out to almost nothing. This effect exists to
      // teach reach, so it has to read against sky and grey ramp alike.
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
    this.mesh.scale.setScalar(CONE_START_SCALE);
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
    this.mesh.scale.setScalar(
      CONE_START_SCALE + (CONE_END_SCALE - CONE_START_SCALE) * (1 - remaining),
    );
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
