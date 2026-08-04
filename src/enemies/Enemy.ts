import { BufferGeometry, Mesh, MeshStandardMaterial, SphereGeometry, Vector3 } from 'three';
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
/** Scale-in time for a fresh spawn — the visual announcement that something just arrived. */
export const MATERIALIZE_SECONDS = 0.6;
const MATERIALIZE_START_SCALE = 0.15;
/** Emissive boost at the start of the materialize, fading to the visual's base. */
const MATERIALIZE_EMISSIVE_BOOST = 2.5;
/**
 * How long a fresh spawn cannot deal contact damage. This — not spawn
 * placement — is the hard "no instant hit" guarantee: the corridor rejection
 * in `SpawnPlacement` keeps enemies out of the windshield, but a legal spawn
 * beside the path can still brush a 40 u/s player in ~0.35 s, faster than
 * anyone can react. Riding the contact cooldown makes the window exact and
 * unconditional (fallback spawns included), and keeps it inside the one field
 * the rewind already deliberately declines to restore.
 */
export const SPAWN_CONTACT_GRACE = 1.2;
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
 * How an enemy looks. Split out so a subclass can be a different shape and
 * colour without reimplementing any of the steering below — the seeder has to
 * read as a different threat at a glance, and everything else about it is this
 * class's behaviour with one extra timer.
 */
export interface EnemyVisual {
  /** Shared across instances of that enemy type; never disposed per-enemy. */
  geometry: BufferGeometry;
  color: number;
  emissive: number;
  emissiveIntensity: number;
}

const DRONE_VISUAL: EnemyVisual = {
  geometry: GEOMETRY,
  color: BODY_COLOR,
  emissive: BASE_EMISSIVE,
  emissiveIntensity: BASE_EMISSIVE_INTENSITY,
};

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
let rewindIdCounter = 0;
function nextRewindId(): number {
  rewindIdCounter += 1;
  return rewindIdCounter;
}

export class Enemy {
  readonly mesh: Mesh;
  readonly health: Health;
  readonly position: Vector3;

  /**
   * Identity that survives being destroyed and rebuilt.
   *
   * The rewind plays the world backwards at 128 Hz, and enemies come and go
   * across that window. Reconciling the live list against a recorded frame *by
   * index* would be wrong the moment anything was culled — the arrays are
   * spliced, so every enemy after the gap shifts and would be teleported into
   * its neighbour's recorded position. Matching on this instead means a
   * re-created enemy resumes being the same enemy, and the common case (nothing
   * changed between two frames) does no work at all.
   *
   * Mutable so `Rewind` can stamp a rebuilt enemy with the id it is standing in
   * for; ids are only ever compared, never ordered.
   */
  rewindId = nextRewindId();

  protected readonly material: MeshStandardMaterial;
  /** Starts at the spawn grace — a fresh enemy is visible before it is dangerous. */
  private contactCooldown = SPAWN_CONTACT_GRACE;
  private flashTimer = 0;
  /**
   * Scale-in progress. Deliberately not rewound: `finishMaterialize` is called
   * on rewind reconstruction so rebuilt enemies stand at full size instead of
   * replaying the pop-in mid-playback.
   */
  private materializeRemaining = MATERIALIZE_SECONDS;
  /**
   * Resting mesh scale. Subclasses that are physically bigger (the Bulwark)
   * set this instead of writing `mesh.scale`, so the materialize ramp and the
   * elite affix compose with it instead of fighting over the transform.
   */
  protected baseScale = 1;
  /**
   * Standing Wave's resonance slow. Transient and deliberately NOT rewound —
   * the same documented limit as heading, aim error and contact cooldown: it
   * lives well under a second (the wake refreshes it every tick), and a rebuilt
   * enemy picking it up fresh is invisible next to being in the right place.
   * Never write `moveSpeed` for this: it is recorded per-enemy by the rewind
   * but not restored onto retained enemies, so a direct write would bake the
   * slow in permanently across a rewind.
   */
  private slowRemaining = 0;
  private slowFactor = 1;
  private bobPhase = Math.random() * Math.PI * 2;
  private readonly baseEmissive: number;
  private readonly baseEmissiveIntensity: number;
  /** Current heading; steered toward the intercept solution at a bounded rate. */
  private readonly heading = new Vector3();
  private readonly aimError: Vector3;

  constructor(
    position: Vector3,
    hp: number,
    public moveSpeed: number,
    public contactDamage: number,
    visual: EnemyVisual = DRONE_VISUAL,
  ) {
    this.position = position.clone();
    this.health = new Health(hp);
    this.baseEmissive = visual.emissive;
    this.baseEmissiveIntensity = visual.emissiveIntensity;
    this.material = new MeshStandardMaterial({
      color: visual.color,
      emissive: visual.emissive,
      emissiveIntensity: visual.emissiveIntensity * MATERIALIZE_EMISSIVE_BOOST,
    });
    this.mesh = new Mesh(visual.geometry, this.material);
    this.mesh.position.copy(this.position);
    this.mesh.scale.setScalar(MATERIALIZE_START_SCALE);
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
    this.moveToward(this.aimPoint(playerPosition, playerVelocity), dt);
    this.updateVisuals(dt);
  }

  /**
   * The point this enemy is currently steering at: the interception solution
   * plus its personal aim error. Split from the movement so a subclass can
   * steer at something else — or at nothing — without losing the lead solve.
   */
  protected aimPoint(playerPosition: Vector3, playerVelocity: Vector3): Vector3 {
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
    return target;
  }

  /**
   * Steers the heading toward `target` at no more than `TURN_RATE` and advances
   * along it. `speedScale` lets a subclass ease off without changing the
   * enemy's declared `moveSpeed`, which is what the interception solve uses.
   */
  protected moveToward(target: Vector3, dt: number, speedScale = 1): void {
    const desired = target.clone().sub(this.position);
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
      // The slow scales the advance, not `moveSpeed` (see the field note) and
      // not the interception solve — a slowed chaser still aims like itself,
      // it just arrives late, which is exactly what a resonance drag should do.
      const slow = this.slowRemaining > 0 ? this.slowFactor : 1;
      this.position.addScaledVector(this.heading, this.moveSpeed * speedScale * slow * dt);
    }
  }

  /**
   * Applies Standing Wave's drag. Keeps the strongest factor and the longest
   * remaining time, so overlapping wake touches can never *weaken* a slow.
   */
  applySlow(seconds: number, factor: number): void {
    this.slowRemaining = Math.max(this.slowRemaining, seconds);
    this.slowFactor = Math.min(this.slowFactor, factor);
  }

  /** Bob, mesh sync, and the timed states. Every subclass needs all of it. */
  protected updateVisuals(dt: number): void {
    this.bobPhase += dt * 3;
    this.mesh.position.copy(this.position);
    this.mesh.position.y += Math.sin(this.bobPhase) * 0.15;

    if (this.materializeRemaining > 0) {
      this.materializeRemaining -= dt;
      if (this.materializeRemaining <= 0) {
        this.finishMaterialize();
      } else {
        const t = 1 - this.materializeRemaining / MATERIALIZE_SECONDS;
        this.mesh.scale.setScalar(
          this.baseScale * (MATERIALIZE_START_SCALE + (1 - MATERIALIZE_START_SCALE) * t),
        );
        this.material.emissiveIntensity =
          this.baseEmissiveIntensity * (MATERIALIZE_EMISSIVE_BOOST - (MATERIALIZE_EMISSIVE_BOOST - 1) * t);
      }
    }

    // Decremented here rather than in `tick`, deliberately: `Seeder` overrides
    // `tick` and every subclass funnels through this method, so the slow can
    // never silently stop expiring on a subclass.
    if (this.slowRemaining > 0) {
      this.slowRemaining -= dt;
      if (this.slowRemaining <= 0) this.slowFactor = 1;
    }

    if (this.contactCooldown > 0) this.contactCooldown -= dt;
    if (this.flashTimer > 0) {
      this.flashTimer -= dt;
      this.material.emissive.setHex(this.flashTimer > 0 ? FLASH_EMISSIVE : this.baseEmissive);
    }
  }

  /**
   * Snaps to full size and resting glow. Called by `Rewind` when it rebuilds
   * an enemy from a recorded frame — a reconstructed enemy was already fully
   * present when the frame was recorded, so it must not replay the scale-in.
   */
  finishMaterialize(): void {
    this.materializeRemaining = 0;
    this.mesh.scale.setScalar(this.baseScale);
    this.material.emissiveIntensity = this.baseEmissiveIntensity;
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
