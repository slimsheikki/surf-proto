import { Group, Mesh, MeshBasicMaterial, SphereGeometry, Vector3 } from 'three';
import { WeaponTarget } from './Weapon';

/**
 * Solar Wave: a fading trail of sunlight in the player's wake that burns
 * anything following it.
 *
 * The anti-pursuit weapon. Every enemy in this game intercepts from behind or
 * beside a player who never stops, so the space just vacated is exactly where
 * the chasers are — a damaging wake turns the act of surfing away from a pack
 * into the attack on it, which is the combat brief ("never stop surfing to
 * fight") stated as a weapon.
 *
 * Mechanically a ring buffer of burn points dropped by distance travelled
 * (not by time — a slow player must not condense the same trail into a
 * shorter, denser one), each alive for a fixed burn time and damaging enemies
 * inside its radius every tick. Damage is DoT with no hit flash: a chaser
 * sitting in the wake would strobe white at 128 Hz.
 *
 * Rewind: the trail is cleared on rewind like live blasts are, and for the
 * same reason — points live ~1.6 s, everything recorded has long since gone
 * out, and the wake re-grows the moment play resumes. The *perk level*
 * (`RunPerks.solarWaveDps`) rides `Rewind`'s `Frame` like every upgrade field.
 */

/** One trail point per this many units travelled. */
const POINT_SPACING = 0.9;
/** Seconds a point burns before fading out. */
const POINT_LIFETIME = 1.6;
/** How close an enemy must be to a point to burn. */
const BURN_RADIUS = 2.2;
/**
 * No trail below this speed. It is a *wake* — standing still must not paint a
 * permanent bonfire under a camping player, and the floor keeps it a reward
 * for moving (walk cap is 7; this needs real travel).
 */
const MIN_TRAIL_SPEED = 10;
/**
 * Ring-buffer bound. spacing x capacity = ~58 units of live trail, more than
 * a full lifetime's worth at 35 u/s, so the cap only ever bites above ~36 u/s
 * — where the trail is at its longest and dropping the oldest point early is
 * invisible.
 */
const MAX_POINTS = 64;
/** Trail hovers this far above the player's feet — mid-shin, where the board would be. */
const TRAIL_LIFT = 0.55;

const TRAIL_COLOR = 0xffc257;
const POINT_RADIUS = 0.5;
const POINT_BASE_OPACITY = 0.55;

interface TrailPoint {
  readonly position: Vector3;
  age: number;
  active: boolean;
  readonly mesh: Mesh;
  readonly material: MeshBasicMaterial;
}

/** Shared by every point; materials are per-point because opacity fades individually. */
const POINT_GEOMETRY = new SphereGeometry(POINT_RADIUS, 10, 8);

export class SolarWave {
  /** Add to the scene once; the pool lives under it and is bounded, like the weapon's tracer group. */
  readonly group = new Group();

  private readonly points: TrailPoint[] = [];
  /** Next pool slot to (re)use — the ring buffer head. */
  private head = 0;
  private readonly lastDrop = new Vector3();
  private hasDropped = false;

  constructor() {
    for (let i = 0; i < MAX_POINTS; i++) {
      const material = new MeshBasicMaterial({
        color: TRAIL_COLOR,
        transparent: true,
        opacity: 0,
        // Normal blending, not additive — the wake has to read over the bright
        // sky exactly like every other effect here.
        depthWrite: false,
      });
      const mesh = new Mesh(POINT_GEOMETRY, material);
      mesh.visible = false;
      mesh.renderOrder = 9;
      this.group.add(mesh);
      this.points.push({ position: new Vector3(), age: 0, active: false, mesh, material });
    }
  }

  /**
   * Advances ages, drops a new point if the player has moved far enough at
   * speed, and burns enemies standing in the wake. `dps <= 0` (perk not owned)
   * still ages out any leftover points but drops and burns nothing.
   */
  tick(
    dt: number,
    playerPosition: Vector3,
    playerSpeed: number,
    dps: number,
    targets: readonly WeaponTarget[],
  ): void {
    for (const point of this.points) {
      if (!point.active) continue;
      point.age += dt;
      if (point.age >= POINT_LIFETIME) {
        point.active = false;
        point.mesh.visible = false;
        continue;
      }
      const remaining = 1 - point.age / POINT_LIFETIME;
      point.material.opacity = POINT_BASE_OPACITY * remaining;
      // Shrinks as it cools; the newest points are the hottest part of the wake.
      point.mesh.scale.setScalar(0.5 + 0.5 * remaining);
    }

    if (dps <= 0) return;

    if (playerSpeed >= MIN_TRAIL_SPEED) {
      if (!this.hasDropped || this.lastDrop.distanceToSquared(playerPosition) >= POINT_SPACING * POINT_SPACING) {
        this.drop(playerPosition);
      }
    } else {
      // A slow spell breaks the chain, so speeding back up starts a fresh
      // trail at the player rather than drawing a line across the gap.
      this.hasDropped = false;
    }

    const burnRadiusSq = BURN_RADIUS * BURN_RADIUS;
    for (const target of targets) {
      if (target.health.isDead) continue;
      for (const point of this.points) {
        if (!point.active) continue;
        if (target.position.distanceToSquared(point.position) > burnRadiusSq) continue;
        target.health.takeDamage(dps * dt);
        // One burn per enemy per tick — overlapping points must not multiply
        // the advertised DPS.
        break;
      }
    }
  }

  private drop(playerPosition: Vector3): void {
    const point = this.points[this.head];
    this.head = (this.head + 1) % MAX_POINTS;
    point.position.copy(playerPosition);
    point.position.y += TRAIL_LIFT;
    point.age = 0;
    point.active = true;
    point.mesh.position.copy(point.position);
    point.mesh.scale.setScalar(1);
    point.material.opacity = POINT_BASE_OPACITY;
    point.mesh.visible = true;
    this.lastDrop.copy(playerPosition);
    this.hasDropped = true;
  }

  /** How many points are burning right now. For probes and the curious. */
  get activeCount(): number {
    let count = 0;
    for (const point of this.points) if (point.active) count += 1;
    return count;
  }

  /** Wipes the wake. Restart and rewind both call this — see the class comment. */
  clear(): void {
    for (const point of this.points) {
      point.active = false;
      point.age = 0;
      point.mesh.visible = false;
    }
    this.hasDropped = false;
    this.head = 0;
  }

  dispose(): void {
    for (const point of this.points) point.material.dispose();
    POINT_GEOMETRY.dispose();
  }
}
