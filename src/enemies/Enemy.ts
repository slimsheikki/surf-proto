import { Mesh, MeshStandardMaterial, SphereGeometry, Vector3 } from 'three';
import { Health } from '../combat/Health';

const GEOMETRY = new SphereGeometry(0.45, 12, 10);
const BODY_COLOR = 0xd23c5c;
/**
 * Idle glow. The old 0x330008 was near-black: a drone read as a dark speck
 * against the grey course and was routinely noticed only by the damage it had
 * already done. This is a modest lift — deliberately *dimmer* than anything in
 * flight, because projectiles are the things that have to win the player's eye
 * and a swarm of drones glowing as hard as the boss's ring would drown them.
 */
const BASE_EMISSIVE = 0x8c1830;
const BASE_EMISSIVE_INTENSITY = 0.85;
const FLASH_EMISSIVE = 0xffcc55;
const CONTACT_COOLDOWN = 0.5;
const FLASH_DURATION = 0.12;
/** Don't aim further ahead than this — a long lead against a curving ramp run just flies off into space. */
const MAX_LEAD_SECONDS = 1.6;
/**
 * Steering limit, radians/second. This is the single most important knob for
 * making drones dangerous but *dodgeable*: re-solving the interception every
 * tick with unlimited steering is perfect terminal homing, so every drone hits.
 * A turn-rate cap means a drone commits to an approach and a player who changes
 * line — which surfing does constantly — makes it whiff and fly past.
 */
const TURN_RATE = 1.8;
/** Per-drone aim error, so a swarm produces near-misses instead of 100% contact. */
const MIN_AIM_ERROR = 1.2;
const MAX_AIM_ERROR = 4;
/** Range over which that aim error fades to zero as the drone closes in. */
const AIM_ERROR_FADE_DIST = 3;

/**
 * A small hovering drone. Drifts toward the player's full 3D position (not
 * ground-snapped) so it's naturally encountered mid-air while surfing —
 * combat is meant to punctuate a ramp run, not require standing on flat ground.
 *
 * Drones are much slower than a surfing player and always will be: chasing the
 * player's *current* position therefore means they simply trail behind forever.
 * Instead they solve for an interception point on the player's current
 * trajectory, which lets a 12-15 u/s drone meaningfully threaten a 30 u/s
 * surfer approaching it head-on without ever being able to hound them from
 * behind (which would break the surf flow).
 */
export class Enemy {
  readonly mesh: Mesh;
  readonly health: Health;
  readonly position: Vector3;

  private readonly material: MeshStandardMaterial;
  private contactCooldown = 0;
  private flashTimer = 0;
  private bobPhase = Math.random() * Math.PI * 2;
  /** Current heading; steered toward the intercept solution at a bounded rate. */
  private readonly heading = new Vector3();
  private readonly aimError: Vector3;

  constructor(
    position: Vector3,
    hp: number,
    public moveSpeed: number,
    public contactDamage: number,
  ) {
    this.position = position.clone();
    this.health = new Health(hp);
    this.material = new MeshStandardMaterial({
      color: BODY_COLOR,
      emissive: BASE_EMISSIVE,
      emissiveIntensity: BASE_EMISSIVE_INTENSITY,
    });
    this.mesh = new Mesh(GEOMETRY, this.material);
    this.mesh.position.copy(this.position);
    this.aimError = new Vector3(
      Math.random() - 0.5,
      Math.random() - 0.5,
      Math.random() - 0.5,
    )
      .normalize()
      .multiplyScalar(MIN_AIM_ERROR + Math.random() * (MAX_AIM_ERROR - MIN_AIM_ERROR));
  }

  /**
   * Smallest positive t with |(P - E) + V t| = speed * t, i.e. the time at
   * which the drone and the player arrive at the same point. Returns null when
   * no interception exists (the usual case for a player faster than the drone
   * and heading away), in which case the caller falls back to a direct chase.
   */
  private interceptSeconds(playerPosition: Vector3, playerVelocity: Vector3): number | null {
    const rx = playerPosition.x - this.position.x;
    const ry = playerPosition.y - this.position.y;
    const rz = playerPosition.z - this.position.z;

    const a =
      playerVelocity.x * playerVelocity.x +
      playerVelocity.y * playerVelocity.y +
      playerVelocity.z * playerVelocity.z -
      this.moveSpeed * this.moveSpeed;
    const b = 2 * (rx * playerVelocity.x + ry * playerVelocity.y + rz * playerVelocity.z);
    const c = rx * rx + ry * ry + rz * rz;

    if (Math.abs(a) < 1e-6) {
      if (Math.abs(b) < 1e-6) return null;
      const t = -c / b;
      return t > 0 ? Math.min(t, MAX_LEAD_SECONDS) : null;
    }

    const disc = b * b - 4 * a * c;
    if (disc < 0) return null;
    const root = Math.sqrt(disc);
    const t1 = (-b - root) / (2 * a);
    const t2 = (-b + root) / (2 * a);
    const positives = [t1, t2].filter((t) => t > 1e-4);
    if (positives.length === 0) return null;
    return Math.min(Math.min(...positives), MAX_LEAD_SECONDS);
  }

  tick(dt: number, playerPosition: Vector3, playerVelocity: Vector3): void {
    const lead = this.interceptSeconds(playerPosition, playerVelocity);
    const target =
      lead === null
        ? playerPosition.clone()
        : new Vector3(
            playerPosition.x + playerVelocity.x * lead,
            playerPosition.y + playerVelocity.y * lead,
            playerPosition.z + playerVelocity.z * lead,
          );
    // Aim error fades as the drone closes, so whether an attack connects is
    // decided by the turn-rate cap rather than by a flat handicap: a 40 u/s
    // head-on pass crosses the last few metres too fast to correct and whiffs,
    // while a drone approaching a slow or hovering player has time to line up.
    const rawDist = this.position.distanceTo(target);
    target.addScaledVector(this.aimError, Math.min(1, rawDist / AIM_ERROR_FADE_DIST));

    const desired = target.sub(this.position);
    const dist = desired.length();
    if (dist > 1e-4) {
      desired.divideScalar(dist);
      if (this.heading.lengthSq() < 1e-6) {
        this.heading.copy(desired);
      } else {
        // Rotate the heading toward the desired direction, at most TURN_RATE*dt.
        const angle = Math.acos(Math.min(1, Math.max(-1, this.heading.dot(desired))));
        const maxTurn = TURN_RATE * dt;
        if (angle <= maxTurn || angle < 1e-6) {
          this.heading.copy(desired);
        } else {
          const t = maxTurn / angle;
          this.heading.lerp(desired, t).normalize();
        }
      }
      this.position.addScaledVector(this.heading, this.moveSpeed * dt);
    }

    this.bobPhase += dt * 3;
    this.mesh.position.copy(this.position);
    this.mesh.position.y += Math.sin(this.bobPhase) * 0.15;

    if (this.contactCooldown > 0) this.contactCooldown -= dt;
    if (this.flashTimer > 0) {
      this.flashTimer -= dt;
      this.material.emissive.setHex(this.flashTimer > 0 ? FLASH_EMISSIVE : BASE_EMISSIVE);
    }
  }

  distanceToPlayer(playerPosition: Vector3): number {
    return this.position.distanceTo(playerPosition);
  }

  canDealContactDamage(): boolean {
    return this.contactCooldown <= 0;
  }

  triggerContactCooldown(): void {
    this.contactCooldown = CONTACT_COOLDOWN;
  }

  flashHit(): void {
    this.flashTimer = FLASH_DURATION;
    this.material.emissive.setHex(FLASH_EMISSIVE);
  }

  dispose(): void {
    this.material.dispose();
  }
}
