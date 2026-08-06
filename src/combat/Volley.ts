import {
  Group,
  Mesh,
  type MeshBasicMaterial,
  type MeshStandardMaterial,
  SphereGeometry,
  Vector3,
} from 'three';
import { pickupMaterial, vfxMaterial } from '../render/NprMaterials';
import { WeaponTarget } from './Weapon';

/**
 * The seed volley — a second auto-weapon, and the only Cartridge that adds a
 * weapon rather than a number.
 *
 * Granted and scaled by **Spore**: one more seed per step, so a first common
 * Spore throws two and a legendary out of a gamble opens at five. Sharpened by
 * **Photon**, which buys muzzle speed, turn rate and pierce — Spore is how many
 * you throw, Photon is how many arrive, and those are genuinely different
 * builds.
 *
 * It exists as a *second* weapon rather than a change to the auto-gun because
 * the two have distinct jobs. `Weapon`'s sticky-target rule exists because
 * retargeting sprayed partial damage across a stream of drones and killed
 * nothing; the gun stays the single-target sniper and the volley is the crowd
 * clear, which is the Vampire-Survivors half of the game the docs keep asking
 * for. Critically it fires itself on its own timer, so it never asks the player
 * to stop surfing to use it.
 *
 * Structure mirrors `Boss`'s ring projectiles rather than inventing a second
 * pattern: a fixed pool, shared geometry, and a **hit shell more generous than
 * the visual** — 0.35 drawn against 1.1 tested, the same convention the boss
 * uses at these speeds and for the same reason.
 *
 * **Cleared, never rewound.** Exactly the precedent live blasts and wake points
 * set, for the same reason: a seed lives 1.2 s, so anything a frame could have
 * recorded has long since landed, and the volley re-fires on resume. It costs
 * `Rewind` zero `Frame` fields — only the Spore and Photon step counts ride,
 * like every other Cartridge.
 */

/** Seconds between volleys. Slow enough that a volley reads as an event. */
export const VOLLEY_INTERVAL = 1.4;

/**
 * Acquire range, deliberately wider than the gun's 22.
 *
 * Reach is the volley's identity: it is what you throw at the pack you are
 * surfing *past* without turning to face it.
 */
export const VOLLEY_RANGE = 34;

/**
 * Damage per seed, as a fraction of the gun's.
 *
 * **This fraction is the only brake on the whole weapon.** Seed count is linear
 * in Spore steps and has no ceiling, so nothing else stops Spore + Photon from
 * scaling throughput without bound. Lowered from an initial 0.55 once the count
 * was opened up: twice the seeds must not be twice the damage.
 */
export const VOLLEY_DAMAGE_FRACTION = 0.4;

/** How long a seed lives before it gives up, in seconds. */
const LIFETIME = 1.2;

/**
 * Muzzle speed, and what Photon adds to it — both softcapped.
 *
 * ~4x the 22 u/s enemy speed ceiling at base, which is what lets a seed catch
 * something that is running.
 */
const BASE_SPEED = 90;
function speedBonus(s: number): number {
  return (70 * s) / (s + 5); // -> 160 u/s at infinity
}

/**
 * Steering rate in radians/second, also softcapped.
 *
 * Turn-rate-limited rather than instant, so seeds *arc* toward a target the way
 * `Enemy` steering does and a fast enough enemy can still be missed. A seed
 * that snapped to its target would make Photon meaningless.
 */
const BASE_TURN_RATE = 6;
function turnBonus(s: number): number {
  return (6 * s) / (s + 6); // -> 12 rad/s at infinity
}

/** Enemies one seed passes through before it is spent. */
function pierceFor(photonSteps: number): number {
  return 1 + Math.floor(photonSteps / 3);
}

/** Seeds per volley: the step *is* the projectile. */
export function seedsFor(sporeSteps: number): number {
  return sporeSteps <= 0 ? 0 : 1 + sporeSteps;
}

const VISUAL_RADIUS = 0.35;
const HIT_RADIUS = 1.1;

/**
 * Pool size, fixed.
 *
 * Same bounded-pool contract as `TracerFx` (32) and `SolarWave` (64). 96 covers
 * the worst case the numbers allow — a legendary-fed Spore firing every 1.4 s
 * with seeds living 1.2 s cannot have more than one volley in the air at once,
 * so this is roughly four times what is reachable.
 */
const POOL = 96;

/** Fan half-angle for seeds with no enemy of their own to claim. */
const FAN_HALF_ANGLE = (18 * Math.PI) / 180;

const GEOMETRY = new SphereGeometry(VISUAL_RADIUS, 8, 6);
const SHELL_GEOMETRY = new SphereGeometry(HIT_RADIUS * 0.62, 8, 6);

/**
 * Violet, because violet means *yours*.
 *
 * These first shipped green and that was a mistake: the Swarmer is acid green,
 * the Spitter's bolts are bright, and a player's own projectiles must never be
 * mistaken for something incoming. Violet is the hue the crosshair, the
 * wordmark and every panel already use, and it is now the player's alone — the
 * Seeder gave it up in the same change.
 *
 * Normal blending, not additive. The project has paid for that one already:
 * against the bright sky additive desaturates to white, and a saturated
 * emissive at high intensity clips the same way.
 */
const CORE_COLOR = 0xd9a5ff;
const SHELL_COLOR = 0xb45cff;

class Seed {
  readonly mesh: Mesh;
  readonly shell: Mesh;
  readonly position = new Vector3();
  readonly velocity = new Vector3();
  /** Enemies already hit by this seed, so pierce never double-counts one. */
  readonly hit = new Set<WeaponTarget>();
  active = false;
  age = 0;
  damage = 0;
  pierce = 1;
  turnRate = BASE_TURN_RATE;
  target: WeaponTarget | null = null;

  constructor() {
    this.mesh = new Mesh(
      GEOMETRY,
      pickupMaterial({
        color: CORE_COLOR,
        emissive: CORE_COLOR,
        emissiveIntensity: 0.9,
      }),
    );
    this.shell = new Mesh(
      SHELL_GEOMETRY,
      vfxMaterial({ color: SHELL_COLOR, transparent: true, opacity: 0.28 }),
    );
    this.mesh.add(this.shell);
    this.mesh.visible = false;
  }
}

const UP = new Vector3(0, 1, 0);
const toTarget = new Vector3();
const desired = new Vector3();
const axis = new Vector3();

export class Volley {
  readonly group = new Group();
  private readonly seeds: Seed[] = Array.from({ length: POOL }, () => new Seed());
  private head = 0;
  private timer = 0;

  constructor() {
    for (const seed of this.seeds) this.group.add(seed.mesh);
  }

  /**
   * One tick of the weapon: age and steer what is in flight, then fire if the
   * timer is up.
   *
   * Flight is advanced first and unconditionally — seeds already thrown must
   * keep flying on ticks where there is no target and no volley is due, which
   * is most ticks. Same ordering rule `Weapon.tick` follows for its effects.
   *
   * `sporeSteps` of 0 means the Cartridge is unowned: leftover seeds still age
   * out, but nothing new is thrown.
   */
  tick(
    dt: number,
    playerPosition: Vector3,
    playerForward: Vector3,
    weaponDamage: number,
    sporeSteps: number,
    photonSteps: number,
    targets: readonly WeaponTarget[],
  ): void {
    this.advance(dt, targets);

    const seeds = seedsFor(sporeSteps);
    if (seeds <= 0) {
      // Held at zero rather than accumulating, so picking Spore up mid-run
      // throws its first volley promptly instead of instantly dumping every
      // volley the run has "owed" since the start.
      this.timer = 0;
      return;
    }

    this.timer += dt;
    if (this.timer < VOLLEY_INTERVAL) return;
    this.timer -= VOLLEY_INTERVAL;
    this.fire(playerPosition, playerForward, weaponDamage, seeds, photonSteps, targets);
  }

  private advance(dt: number, targets: readonly WeaponTarget[]): void {
    const hitRadiusSq = HIT_RADIUS * HIT_RADIUS;
    for (const seed of this.seeds) {
      if (!seed.active) continue;

      seed.age += dt;
      if (seed.age >= LIFETIME) {
        this.retire(seed);
        continue;
      }

      // Re-acquire if the claimed target died, so a seed thrown at something
      // the gun kills first is not wasted.
      if (seed.target && seed.target.health.isDead) seed.target = null;

      if (seed.target) {
        const speed = seed.velocity.length();
        toTarget.copy(seed.target.position).sub(seed.position);
        const distance = toTarget.length();
        if (distance > 1e-4) {
          // **A latched constant-speed seek, not a proportional lerp.** The
          // project has this lesson on record from the XP magnet: lerping
          // toward a moving target makes closing velocity vanish at speed, and
          // the shooter here is routinely doing 35 u/s.
          desired.copy(toTarget).divideScalar(distance).multiplyScalar(speed);
          this.steer(seed, desired, speed, dt);
        }
      }

      seed.position.addScaledVector(seed.velocity, dt);
      seed.mesh.position.copy(seed.position);

      for (const target of targets) {
        if (target.health.isDead) continue;
        if (seed.hit.has(target)) continue;
        if (target.position.distanceToSquared(seed.position) > hitRadiusSq) continue;
        target.health.takeDamage(seed.damage);
        target.flashHit();
        seed.hit.add(target);
        seed.pierce -= 1;
        if (seed.pierce <= 0) {
          this.retire(seed);
          break;
        }
        // Re-aim at whatever is next rather than flying on blind.
        seed.target = null;
      }
    }
  }

  /** Rotate the velocity toward `desired`, capped by the turn rate. */
  private steer(seed: Seed, want: Vector3, speed: number, dt: number): void {
    const current = seed.velocity;
    const dot = Math.min(1, Math.max(-1, current.dot(want) / (speed * speed)));
    const angle = Math.acos(dot);
    const maxTurn = seed.turnRate * dt;
    if (angle <= maxTurn || angle < 1e-4) {
      current.copy(want);
      return;
    }
    axis.copy(current).cross(want);
    if (axis.lengthSq() < 1e-8) {
      // Exactly opposed: any perpendicular axis will do to break the tie.
      axis.set(-current.z, 0, current.x);
      if (axis.lengthSq() < 1e-8) axis.set(1, 0, 0);
    }
    axis.normalize();
    current.applyAxisAngle(axis, maxTurn);
    current.setLength(speed);
  }

  /**
   * Throw one volley.
   *
   * **Each seed claims a different enemy** where enough exist, nearest first;
   * the remainder fan within +/-18 degrees of where the player is looking. That
   * split is what makes a volley read as wave-clear rather than overkill on one
   * drone — and it means a volley into empty sky still looks like a volley.
   *
   * **No velocity inheritance.** Physically wrong, right for play: inheriting
   * the player's motion would make forward throws very fast and backward
   * throws crawl, and enemies intercept from behind and beside by design. A
   * fixed muzzle speed plus homing keeps the weapon symmetric around a player
   * who is never standing still.
   */
  private fire(
    playerPosition: Vector3,
    playerForward: Vector3,
    weaponDamage: number,
    seeds: number,
    photonSteps: number,
    targets: readonly WeaponTarget[],
  ): void {
    const speed = BASE_SPEED + speedBonus(photonSteps);
    const turnRate = BASE_TURN_RATE + turnBonus(photonSteps);
    const pierce = pierceFor(photonSteps);
    const damage = weaponDamage * VOLLEY_DAMAGE_FRACTION;

    const claimable = targets
      .filter((t) => !t.health.isDead && t.distanceToPlayer(playerPosition) <= VOLLEY_RANGE)
      .sort(
        (a, b) => a.distanceToPlayer(playerPosition) - b.distanceToPlayer(playerPosition),
      );

    for (let i = 0; i < seeds; i++) {
      const seed = this.seeds[this.head];
      this.head = (this.head + 1) % POOL;

      seed.active = true;
      seed.age = 0;
      seed.damage = damage;
      seed.pierce = pierce;
      seed.turnRate = turnRate;
      seed.hit.clear();
      seed.position.copy(playerPosition);
      seed.target = claimable[i] ?? null;

      if (seed.target) {
        desired.copy(seed.target.position).sub(seed.position);
        if (desired.lengthSq() < 1e-8) desired.copy(playerForward);
        seed.velocity.copy(desired).setLength(speed);
      } else {
        // Nothing left to claim: spread across the fan so the volley still
        // reads as a volley.
        const spread = seeds > 1 ? (i / (seeds - 1) - 0.5) * 2 : 0;
        desired.copy(playerForward);
        desired.y = 0;
        if (desired.lengthSq() < 1e-8) desired.set(0, 0, -1);
        desired.normalize().applyAxisAngle(UP, spread * FAN_HALF_ANGLE);
        seed.velocity.copy(desired).setLength(speed);
      }

      seed.mesh.position.copy(seed.position);
      seed.mesh.visible = true;
    }
  }

  private retire(seed: Seed): void {
    seed.active = false;
    seed.target = null;
    seed.hit.clear();
    seed.mesh.visible = false;
  }

  /** Seeds in flight right now. For probes and the curious. */
  get activeCount(): number {
    let count = 0;
    for (const seed of this.seeds) if (seed.active) count += 1;
    return count;
  }

  /**
   * Wipe every seed in flight. Restart and rewind both call this — see the
   * class comment for why a rewind clears rather than restores.
   */
  clear(): void {
    for (const seed of this.seeds) this.retire(seed);
    this.head = 0;
    this.timer = 0;
  }

  dispose(): void {
    for (const seed of this.seeds) {
      (seed.mesh.material as MeshStandardMaterial).dispose();
      (seed.shell.material as MeshBasicMaterial).dispose();
    }
    GEOMETRY.dispose();
    SHELL_GEOMETRY.dispose();
  }
}
