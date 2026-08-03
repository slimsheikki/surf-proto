import { Mesh, MeshStandardMaterial, SphereGeometry, Vector3 } from 'three';

const GEOMETRY = new SphereGeometry(0.18, 8, 8);
/**
 * An orb is 0.18 units across and is usually seen for well under a second while
 * the player flies past at 30 u/s, so it has to be bright to be seen at all.
 * The old teal emissive (0x1a6b7a) was a fraction of the body colour's value
 * and left orbs looking like unlit plastic; this pushes the glow up to the body
 * colour itself. Kept a shade cooler and much dimmer overall than a bolt's
 * flare — pickups should be noticeable, not mistaken for incoming fire.
 */
const MATERIAL = new MeshStandardMaterial({
  color: 0x7fe8ff,
  emissive: 0x5fd4ef,
  emissiveIntensity: 1.9,
});

/** Distance at which an orb notices the player and starts homing. */
const MAGNET_RADIUS_DEFAULT = 12;
/**
 * Live magnet radius, mutable because upgrades grow it. A module-level box
 * rather than per-orb state so an upgrade applies to orbs already in flight;
 * `resetXpMagnet` restores it on run restart (same contract as
 * `resetMovementConfig`).
 */
export const XP_MAGNET = { radius: MAGNET_RADIUS_DEFAULT };

export function resetXpMagnet(): void {
  XP_MAGNET.radius = MAGNET_RADIUS_DEFAULT;
}
const COLLECT_RADIUS = 1;
/**
 * Homing speed must exceed the player's travel speed, or an orb can never close
 * the gap on someone surfing away from it. Surf speeds reach ~40 u/s, so this
 * sits above that. Note a *proportional* pull (lerping a fraction of the
 * remaining distance each tick) is the wrong shape here: its closing speed
 * vanishes exactly where it's needed most, right next to a fast-moving player.
 */
const MAGNET_SPEED = 55;
/** Extra speed per unit of distance, so far-off orbs streak in rather than crawl. */
const MAGNET_SPEED_PER_UNIT = 4;

const toPlayer = new Vector3();

let rewindIdCounter = 0;
function nextRewindId(): number {
  rewindIdCounter += 1;
  return rewindIdCounter;
}

export class XPOrb {
  readonly mesh: Mesh;
  readonly position: Vector3;
  collected = false;

  /**
   * Latched once the player comes within MAGNET_RADIUS. Without the latch a
   * player travelling faster than the orb closes would leave the radius again
   * and strand it mid-flight.
   *
   * Public because the rewind recorder carries it: an orb restored mid-flight
   * with the latch cleared would stop dead and hang in the air.
   */
  magnetised = false;

  /** Stable identity across a rewind; see `Enemy.rewindId`. */
  rewindId = nextRewindId();

  constructor(
    position: Vector3,
    public readonly value: number,
  ) {
    this.position = position.clone();
    this.mesh = new Mesh(GEOMETRY, MATERIAL);
    this.mesh.position.copy(this.position);
  }

  tick(dt: number, playerPosition: Vector3): void {
    toPlayer.copy(playerPosition).sub(this.position);
    let dist = toPlayer.length();

    if (dist < XP_MAGNET.radius) this.magnetised = true;

    if (this.magnetised && dist > 1e-6) {
      const pullSpeed = MAGNET_SPEED + dist * MAGNET_SPEED_PER_UNIT;
      // Clamp the step to the remaining distance so the orb settles on the
      // player instead of overshooting past them at 128 Hz.
      const step = Math.min(pullSpeed * dt, dist);
      this.position.addScaledVector(toPlayer.divideScalar(dist), step);
      dist -= step;
    }

    if (dist < COLLECT_RADIUS) this.collected = true;
    this.mesh.position.copy(this.position);
  }
}
