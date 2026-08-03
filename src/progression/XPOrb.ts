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

/**
 * Distance at which an orb notices the player and starts homing.
 *
 * 18 covers most of the auto-weapon's 22-unit kill envelope, which is what
 * decides whether a kill made *while surfing* ever pays out: an orb that never
 * latches is an orb the player has already left behind. The old 12 left a
 * 12-22 shell where the weapon routinely killed and the loot routinely
 * evaporated — at 35+ u/s that read as "the XP didn't register".
 */
const MAGNET_RADIUS_DEFAULT = 18;
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
 * the gap on someone surfing away from it. Note a *proportional* pull (lerping
 * a fraction of the remaining distance each tick) is the wrong shape here: its
 * closing speed vanishes exactly where it's needed most, right next to a
 * fast-moving player.
 */
const MAGNET_SPEED = 55;
/** Extra speed per unit of distance, so far-off orbs streak in rather than crawl. */
const MAGNET_SPEED_PER_UNIT = 4;
/**
 * The pull also has to *stay* ahead of the player, and a constant cannot: this
 * movement has no top speed (airaccelerate 100, and the landing redirect turns
 * height into speed), so the old fixed 55 was outrun on any long descent. The
 * orb then trailed at the equilibrium gap where pull equals player speed —
 * measured 1.27u at 62 u/s, just outside the 1u collect radius, forever. The
 * lead keeps the pull 25% over whatever the player is actually doing, so a
 * magnetised orb always converges. At or below 44 u/s (55 / 1.25) the max()
 * resolves to the old constant and the tuned behaviour is bit-identical.
 */
const MAGNET_SPEED_LEAD = 1.25;

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

  /**
   * `playerSpeed` is the player's full 3D speed this tick; it feeds the pull's
   * lead so the orb can never be outrun (see MAGNET_SPEED_LEAD). Defaulted so
   * a stationary caller reads exactly as before.
   */
  tick(dt: number, playerPosition: Vector3, playerSpeed = 0): void {
    toPlayer.copy(playerPosition).sub(this.position);
    let dist = toPlayer.length();

    if (dist < XP_MAGNET.radius) this.magnetised = true;

    if (this.magnetised && dist > 1e-6) {
      const pullSpeed =
        Math.max(MAGNET_SPEED, playerSpeed * MAGNET_SPEED_LEAD) + dist * MAGNET_SPEED_PER_UNIT;
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
