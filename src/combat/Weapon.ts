import { Group, Vector3 } from 'three';
import { Health } from './Health';
import { TracerFx } from './Tracer';

/**
 * Everything the auto-weapon needs from a thing it can shoot. Drones and the
 * level-10 boss are wildly different objects — one is a 10 HP seeker, the other
 * a 2200 HP arena piece — but the weapon only ever asks "where, how far, take
 * this, flash", so it targets both through this interface and contains no
 * special cases for either.
 *
 * `position` is read only to place the cosmetic bolt's end point, and only on
 * the tick the shot is fired. Nothing about damage depends on it.
 */
export interface WeaponTarget {
  readonly health: Health;
  readonly position: Vector3;
  distanceToPlayer(playerPosition: Vector3): number;
  flashHit(): void;
  /**
   * Optional: Standing Wave's resonance slow. Drones and seeders implement it
   * (`Enemy.applySlow`); the boss deliberately does not — an arena piece that
   * can be parked at 30% speed stops being a fight — and optional-chaining at
   * the call site means it needs nothing.
   */
  applySlow?(seconds: number, factor: number): void;
  /**
   * Optional: body radius, for things that travel rather than hit instantly.
   * The hitscan gun never needs it — it resolves at range, not at a position —
   * but a `Volley` spore has to know that a drone is a point and the Monolith is
   * a 5.5-unit sphere, or it flies into the boss's middle before registering.
   * Absent means "treat me as a point", which is right for every enemy but one.
   */
  readonly hitRadius?: number;
}

/**
 * Baseline stats, kept separate from the live fields so upgrades (which mutate
 * the live fields in place) can be undone on restart instead of compounding
 * across runs.
 *
 * The envelope is deliberately wide: the player is surfing at 20-40 u/s almost
 * all the time, so a drone is only inside a short range for a fraction of a
 * second. A 22-unit range at 4 shots/s means a head-on pass yields ~4-5 shots
 * instead of the ~1-2 the old 14/3 numbers allowed.
 */
interface WeaponStats {
  damage: number;
  attacksPerSecond: number;
  range: number;
}

const BASE_STATS: WeaponStats = {
  damage: 7,
  attacksPerSecond: 4,
  range: 22,
};

/**
 * Hitscan auto-attack: no aiming input needed, fires at the nearest enemy in
 * range on a cooldown. Stat-driven so upgrades are just field mutations.
 */
export class Weapon {
  /**
   * Muzzle-to-impact effects. Cosmetic only, and deliberately owned by the
   * weapon rather than by the game loop: the weapon is the only thing that
   * knows a shot happened, and hitscan damage gives it no other way to say so.
   */
  private readonly fx = new TracerFx();
  /**
   * Every bolt and impact flash, under one node. Add this to the scene once at
   * construction and never think about it again — the pool inside is fixed, so
   * this group's child count is bounded no matter how long a run lasts.
   */
  readonly effects: Group = this.fx.group;

  damage = BASE_STATS.damage;
  attacksPerSecond = BASE_STATS.attacksPerSecond;
  range = BASE_STATS.range;
  /**
   * Velocity Rounds upgrade: when true, shots gain damage with carried speed —
   * surf well and the gun hits harder. Half a point per u/s over 10, capped
   * at +15 (reached at 40 u/s).
   */
  velocityRounds = false;
  private cooldown = 0;
  /**
   * Sticky target. Always retargeting the nearest enemy sprays partial damage
   * across a stream of drones that then leave range and heal nothing — at surf
   * speed that meant almost no kills. Committing to one target until it dies or
   * leaves range converts the same DPS into actual kills and XP.
   */
  private target: WeaponTarget | null = null;

  /**
   * Effects are advanced from the `dt` already passed in, and the muzzle point
   * is derived from `playerPosition` and the shot direction inside `TracerFx`,
   * so making combat visible costs the call site nothing beyond parenting
   * `weapon.effects` once.
   *
   * Effects tick first and unconditionally: bolts already in flight must keep
   * flying on ticks where there is no target or the weapon is on cooldown,
   * which is most ticks.
   *
   * `dopplerAps` is Doppler Drive's perk value, passed per tick rather than
   * stored here — a mutable field on this class would have to join `Frame` and
   * `reset()`, and the perk already rides both via `RunPerks`. It prices the
   * cooldown set *after* each shot at the speed the shot was fired at (the
   * cooldown itself is transient and not rewound, same as it ever was).
   */
  tick(
    dt: number,
    playerPosition: Vector3,
    targets: readonly WeaponTarget[],
    playerSpeed = 0,
    dopplerAps = 0,
  ): void {
    this.fx.tick(dt);

    if (this.cooldown > 0) this.cooldown -= dt;

    if (!this.isEngageable(this.target, playerPosition, targets)) {
      this.target = this.pickNearest(playerPosition, targets);
    }
    if (!this.target || this.cooldown > 0) return;

    // Snapshotted before the damage lands. The target routinely dies to this
    // very shot, and the bolt must fly to where the shot went rather than ask a
    // corpse where it is — it is a picture of a past event, not a projectile.
    this.fx.fire(playerPosition, this.target.position);

    const speedBonus = this.velocityRounds
      ? Math.min(15, Math.max(0, playerSpeed - 10) * 0.5)
      : 0;
    this.target.health.takeDamage(this.damage + speedBonus);
    this.target.flashHit();
    // Doppler: the same 10-to-40 u/s window Velocity Rounds prices, applied to
    // rate instead of damage — pitch rises as the source closes.
    const doppler = dopplerAps * Math.min(1, Math.max(0, playerSpeed - 10) / 30);
    this.cooldown = 1 / (this.attacksPerSecond + doppler);
  }

  private isEngageable(
    target: WeaponTarget | null,
    playerPosition: Vector3,
    targets: readonly WeaponTarget[],
  ): target is WeaponTarget {
    return (
      target !== null &&
      !target.health.isDead &&
      target.distanceToPlayer(playerPosition) <= this.range &&
      targets.includes(target)
    );
  }

  private pickNearest(playerPosition: Vector3, targets: readonly WeaponTarget[]): WeaponTarget | null {
    let nearest: WeaponTarget | null = null;
    let nearestDist = this.range;
    for (const target of targets) {
      const dist = target.distanceToPlayer(playerPosition);
      if (dist < nearestDist) {
        nearest = target;
        nearestDist = dist;
      }
    }
    return nearest;
  }

  /**
   * Restores the starting stats, undoing every upgrade applied this run, and
   * drops any bolt still in flight so a restart doesn't open with a shot from
   * the previous run streaking across the course.
   */
  reset(): void {
    this.damage = BASE_STATS.damage;
    this.velocityRounds = false;
    this.attacksPerSecond = BASE_STATS.attacksPerSecond;
    this.range = BASE_STATS.range;
    this.cooldown = 0;
    this.target = null;
    this.fx.clear();
  }

  /**
   * Frees the effect pool's GPU resources. The weapon lives as long as the game
   * does, so nothing calls this in the shipped loop — it exists so a test or a
   * future teardown path can prove the pool releases everything it owns.
   */
  dispose(): void {
    this.fx.dispose();
  }
}
