import { Group, Mesh, MeshStandardMaterial, SphereGeometry, Vector3 } from 'three';
import { WeaponTarget } from './Weapon';

/**
 * The volley: a fan of homing spores thrown at the pack on a slow timer.
 *
 * The crowd weapon, and deliberately a *second* weapon rather than a change to
 * `Weapon`. The auto-gun's sticky-target rule exists because retargeting sprayed
 * partial damage across a stream of drones and killed nothing; leaving it alone
 * and adding a wide, cheap, many-target attack beside it gives the two distinct
 * jobs — the gun is the single-target sniper, the volley clears the wave you are
 * surfing through.
 *
 * **Homing is not flavour.** A straight-line projectile fired at a 3D target by
 * a shooter travelling at 35 u/s misses nearly always, and this game has no
 * aiming input to compensate with. The seek is the same shape `XPOrb` uses and
 * for the same reason recorded in `CLAUDE.md`: a proportional lerp toward a
 * moving target fails at speed, because its closing velocity vanishes exactly
 * where it is needed. Spores fly at a constant speed and *steer*, turn-rate
 * limited like `Enemy`'s heading, so they arc onto a target instead of snapping
 * to it — and something fast enough can still be missed.
 *
 * **No velocity inheritance.** Physically wrong, right for play: inheriting the
 * player's velocity would make forward shots very fast and backward shots crawl,
 * and every enemy in this game intercepts from behind or beside. A fixed muzzle
 * speed keeps the weapon symmetric around a player who is never standing still.
 *
 * **Rewind: spores are cleared and never restored**, exactly like live blasts
 * and wake points and for the same reason — they live 1.2 s, so anything
 * recorded has long since landed, and the volley re-fires the moment play
 * resumes. The *perk levels* ride `Rewind`'s `Frame` like every upgrade field.
 */

/** Seconds between volleys. Slow enough that a volley reads as an event, not a stream. */
const VOLLEY_INTERVAL = 1.4;
/**
 * Acquire radius, against the auto-weapon's 22. Reach is the volley's identity:
 * it is the attack that touches the pack you have already surfed past.
 */
const VOLLEY_RANGE = 34;
/**
 * Damage per spore as a fraction of the gun's. Breadth, not raw throughput — a
 * six-spore volley must not simply be a better version of the gun, and this is
 * the brake on the Ember x Prism x Spore stack.
 */
const SPORE_DAMAGE_FRACTION = 0.55;
/**
 * Seconds a spore flies. At the 90 u/s base that is 108 units of travel, which
 * is deliberately more than `VOLLEY_RANGE`: a spore should chase a drone that
 * has left the acquire radius rather than evaporate at its edge.
 */
const SPORE_LIFETIME = 1.2;
const SPORE_VISUAL_RADIUS = 0.35;
/**
 * Hit radius, added to whatever the target declares via `WeaponTarget.hitRadius`.
 * Generous against a 0.35 visual, following the convention `Boss`'s own
 * projectiles set (a 0.8 pellet with a 1.4 hit shell) — at these closing speeds
 * a tight test reads as passing straight through.
 */
const SPORE_HIT_RADIUS = 1.1;
/**
 * Pool bound. Six spores every 1.4 s living 1.2 s is ~6 live at the design
 * ceiling; 96 leaves room for a stacked Photon build without ever growing.
 * Same fixed-pool contract as `TracerFx` (32) and `SolarWave` (64).
 */
const MAX_SPORES = 96;

const BASE_SPEED = 90;
const BASE_TURN_RATE = 6;
/** Launch spread when a volley has more spores than it has enemies to aim at. */
const FAN_SPREAD = (18 * Math.PI) / 180;

/**
 * Green because nothing else here is. `Shrine.ts` states the rule — at surf
 * speed a thing is identified by colour long before shape, so every family keeps
 * its own — and gold, teal, red, violet and pink are all spoken for. It is also
 * simply what a spore looks like.
 */
const SPORE_COLOR = 0x9dff6b;
const SPORE_EMISSIVE = 0x5fd42c;

/** Spores per volley. 0 means the perk is unowned and nothing fires. */
export function volleySporeCount(spores: number): number {
  return spores <= 0 ? 0 : 2 + Math.floor(0.55 * spores);
}

/** Photon's curves. Both softcapped: a spore that outruns its own steering misses. */
export function volleySpeed(photon: number): number {
  return BASE_SPEED + (70 * photon) / (photon + 5);
}

export function volleyTurnRate(photon: number): number {
  return BASE_TURN_RATE + (6 * photon) / (photon + 6);
}

export function volleyPierce(photon: number): number {
  return 1 + Math.floor(photon / 3);
}

interface Spore {
  readonly position: Vector3;
  /** Direction only; magnitude is re-applied from the live speed every tick. */
  readonly heading: Vector3;
  target: WeaponTarget | null;
  pierceLeft: number;
  damage: number;
  age: number;
  active: boolean;
  /**
   * Targets this spore has already damaged. Pierce must carry a spore *through*
   * a drone to the next one, not let it sit inside the first dealing damage
   * every tick until its pierce runs out.
   */
  readonly hits: WeaponTarget[];
  readonly mesh: Mesh;
}

const GEOMETRY = new SphereGeometry(SPORE_VISUAL_RADIUS, 8, 8);
const WORLD_UP = new Vector3(0, 1, 0);

const toTarget = new Vector3();
const turnAxis = new Vector3();

export class Volley {
  /** Add to the scene once; the pool inside is fixed, so this never grows. */
  readonly group = new Group();

  private readonly spores: Spore[] = [];
  /** Next pool slot to (re)use — a ring, like `SolarWave`'s points. */
  private head = 0;
  private cooldown = 0;
  private readonly inRange: WeaponTarget[] = [];

  constructor() {
    for (let i = 0; i < MAX_SPORES; i++) {
      const mesh = new Mesh(
        GEOMETRY,
        new MeshStandardMaterial({
          color: SPORE_COLOR,
          emissive: SPORE_EMISSIVE,
          emissiveIntensity: 1.6,
        }),
      );
      mesh.visible = false;
      this.group.add(mesh);
      this.spores.push({
        position: new Vector3(),
        heading: new Vector3(),
        target: null,
        pierceLeft: 0,
        damage: 0,
        age: 0,
        active: false,
        hits: [],
        mesh,
      });
    }
  }

  /**
   * Flies every live spore and launches a volley when the timer comes up.
   *
   * `spores` and `photon` are the raw perk stacks; the curves live in this file
   * so the tuning and the thing being tuned stay together. `damage` is the gun's
   * current damage, so the volley rides every damage upgrade without knowing any
   * of them exist.
   *
   * Live spores are advanced unconditionally, before the ownership check: a
   * rewind can restore a frame from before the perk was taken while spores from
   * after it are still in the air, and they must land or expire rather than hang
   * frozen in the sky.
   */
  tick(
    dt: number,
    playerPosition: Vector3,
    targets: readonly WeaponTarget[],
    damage: number,
    spores: number,
    photon: number,
  ): void {
    const speed = volleySpeed(photon);
    const turnRate = volleyTurnRate(photon);
    for (const spore of this.spores) {
      if (spore.active) this.advance(spore, dt, speed, turnRate, targets);
    }

    const count = volleySporeCount(spores);
    if (count <= 0) return;

    if (this.cooldown > 0) {
      this.cooldown -= dt;
      return;
    }

    // Acquire by the target's own reported distance, so the Monolith reads as
    // engageable from the loop exactly as it does for the gun; order by *true*
    // distance, so the pack gets the spores first and only the leftovers make
    // the long flight out to it. Sorting by the reported distance instead would
    // put a point-blank-reading boss at the head of every volley and starve the
    // crowd weapon of crowds.
    this.inRange.length = 0;
    for (const target of targets) {
      if (target.health.isDead) continue;
      if (target.distanceToPlayer(playerPosition) > VOLLEY_RANGE) continue;
      this.inRange.push(target);
    }
    if (this.inRange.length === 0) return; // Nothing to shoot: hold the volley rather than spend it.
    this.inRange.sort(
      (a, b) =>
        a.position.distanceToSquared(playerPosition) - b.position.distanceToSquared(playerPosition),
    );

    this.cooldown = VOLLEY_INTERVAL;
    const pierce = volleyPierce(photon);
    const spread = damage * SPORE_DAMAGE_FRACTION;
    for (let i = 0; i < count; i++) {
      this.launch(playerPosition, this.inRange[i % this.inRange.length], spread, pierce, i);
    }
  }

  private launch(
    playerPosition: Vector3,
    target: WeaponTarget,
    damage: number,
    pierce: number,
    index: number,
  ): void {
    const spore = this.spores[this.head];
    this.head = (this.head + 1) % MAX_SPORES;

    spore.position.copy(playerPosition);
    spore.heading.copy(target.position).sub(playerPosition);
    if (spore.heading.lengthSq() < 1e-8) spore.heading.set(0, 0, 1);
    spore.heading.normalize();

    // Spores past the first pass share a target with an earlier one, so they fan
    // out at launch instead of stacking into one bright dot. Homing pulls them
    // back in; the spread is what makes a volley read as a volley.
    const lap = Math.floor(index / this.inRange.length);
    if (lap > 0) {
      const sign = lap % 2 === 1 ? 1 : -1;
      spore.heading.applyAxisAngle(WORLD_UP, sign * FAN_SPREAD * Math.ceil(lap / 2));
    }

    spore.target = target;
    spore.pierceLeft = pierce;
    spore.damage = damage;
    spore.age = 0;
    spore.active = true;
    spore.hits.length = 0;
    spore.mesh.position.copy(spore.position);
    spore.mesh.visible = true;
  }

  private advance(
    spore: Spore,
    dt: number,
    speed: number,
    turnRate: number,
    targets: readonly WeaponTarget[],
  ): void {
    spore.age += dt;
    if (spore.age >= SPORE_LIFETIME) {
      this.retire(spore);
      return;
    }

    if (!spore.target || spore.target.health.isDead || spore.hits.includes(spore.target)) {
      spore.target = this.nearestTo(spore, targets);
    }

    if (spore.target) {
      toTarget.copy(spore.target.position).sub(spore.position);
      const dist = toTarget.length();
      if (dist > 1e-6) {
        toTarget.divideScalar(dist);
        // Turn-rate limited steering: rotate the heading toward the target by at
        // most `turnRate * dt`, about the axis between them. Snapping the heading
        // straight onto the target would make spores unmissable and delete the
        // point of Photon.
        const cos = Math.min(1, Math.max(-1, spore.heading.dot(toTarget)));
        const angle = Math.acos(cos);
        const maxTurn = turnRate * dt;
        if (angle <= maxTurn) {
          spore.heading.copy(toTarget);
        } else {
          turnAxis.crossVectors(spore.heading, toTarget);
          // Degenerate only when the two are exactly opposed, where every axis is
          // equally valid; world up is as good as any and keeps the turn planar.
          if (turnAxis.lengthSq() < 1e-12) turnAxis.copy(WORLD_UP);
          spore.heading.applyAxisAngle(turnAxis.normalize(), maxTurn).normalize();
        }
      }
    }

    spore.position.addScaledVector(spore.heading, speed * dt);
    spore.mesh.position.copy(spore.position);

    for (const target of targets) {
      if (target.health.isDead) continue;
      if (spore.hits.includes(target)) continue;
      const reach = SPORE_HIT_RADIUS + (target.hitRadius ?? 0);
      if (spore.position.distanceToSquared(target.position) > reach * reach) continue;

      target.health.takeDamage(spore.damage);
      target.flashHit();
      spore.hits.push(target);
      spore.pierceLeft -= 1;
      if (spore.pierceLeft <= 0) {
        this.retire(spore);
        return;
      }
    }
  }

  /** Nearest live target this spore has not already hit, within its own reach. */
  private nearestTo(spore: Spore, targets: readonly WeaponTarget[]): WeaponTarget | null {
    let nearest: WeaponTarget | null = null;
    let nearestDistSq = VOLLEY_RANGE * VOLLEY_RANGE;
    for (const target of targets) {
      if (target.health.isDead) continue;
      if (spore.hits.includes(target)) continue;
      const distSq = spore.position.distanceToSquared(target.position);
      if (distSq < nearestDistSq) {
        nearest = target;
        nearestDistSq = distSq;
      }
    }
    return nearest;
  }

  private retire(spore: Spore): void {
    spore.active = false;
    spore.target = null;
    spore.hits.length = 0;
    spore.mesh.visible = false;
  }

  /** How many spores are in the air. For probes and the curious. */
  get activeCount(): number {
    let count = 0;
    for (const spore of this.spores) if (spore.active) count += 1;
    return count;
  }

  /**
   * Wipes every spore in flight and re-arms the timer. Restart and rewind both
   * call this — see the class comment for why a rewind does not restore them.
   */
  clear(): void {
    for (const spore of this.spores) this.retire(spore);
    this.head = 0;
    this.cooldown = 0;
  }

  dispose(): void {
    for (const spore of this.spores) (spore.mesh.material as MeshStandardMaterial).dispose();
    GEOMETRY.dispose();
  }
}
