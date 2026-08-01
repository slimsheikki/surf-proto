import {
  AdditiveBlending,
  BufferGeometry,
  Group,
  IcosahedronGeometry,
  Material,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  SphereGeometry,
  Vector3,
} from 'three';
import { Health } from '../combat/Health';
import { LaserBeam, pointSegmentDistance, rotateToward } from '../combat/LaserBeam';

/* ------------------------------------------------------------------ *
 * Identity and trigger
 * ------------------------------------------------------------------ */

export const BOSS_SPAWN_LEVEL = 10;
export const BOSS_NAME = 'THE MONOLITH';

/**
 * Boss HP, sized against measured player DPS rather than a guess.
 *
 * Reaching level 10 means nine upgrade picks from a five-card pool. Measured
 * end-of-run weapon DPS (see the headless TTK probe):
 *   - all nine picks offensive: 136 DPS
 *   - a realistic greedy-offense build: ~112 DPS
 *   - picks spread evenly across the pool: ~66 DPS
 * At 2200 HP that is a 16 s fight for the min-max build, ~20 s for a typical
 * offensive one and ~33 s for a defensive one — i.e. the intended 20-30 s band
 * for the builds most players actually assemble. 1500 HP put the common case
 * at 11-13 s, which is not a boss fight; the number was raised deliberately.
 */
export const BOSS_MAX_HP = 2200;

/* ------------------------------------------------------------------ *
 * Body
 * ------------------------------------------------------------------ */

/** ~7 units across, per the brief: big enough to read from across the loop. */
/**
 * Body radius. At the real fight distance (~91 units from the track) a 3.5
 * radius subtends only ~4.5 deg — legible by colour, but it doesn't read as a
 * boss. 5.5 roughly doubles that without crowding the island it hovers over.
 */
const BODY_RADIUS = 5.5;
/** Height above the surf track's plane, not above the island mesh. */
const HOVER_HEIGHT = 18;
const BODY_COLOR = 0x161122;
const BODY_EMISSIVE = 0x8c1440;
const BODY_EMISSIVE_INTENSITY = 1.5;
const HIT_EMISSIVE = 0xffd27a;
/**
 * Very short: the auto-weapon lands 4-8 hits a second, so a flash long enough
 * to see individually would just leave the boss permanently lit.
 */
const HIT_FLASH_DURATION = 0.07;
const HALO_COLOR = 0xff5c8a;
const IDLE_YAW_RATE = 0.35;
const IDLE_PITCH_RATE = 0.11;
const BOB_AMPLITUDE = 0.9;
const BOB_RATE = 0.8;

/**
 * Slack added to the boss's engagement bubble on top of the exact track-to-boss
 * distance, covering the height the player gains climbing a ramp face and any
 * wobble in the loop's radius. See `distanceToPlayer` for why the bubble exists.
 */
const ENGAGE_MARGIN = 25;

/* ------------------------------------------------------------------ *
 * Attack 1 - tracking laser
 * ------------------------------------------------------------------ */

/** Warning line tracks the player this long before the beam can hurt anyone. */
const BEAM_TELEGRAPH_SECONDS = 1;
const BEAM_LIVE_SECONDS = 2.5;
/** Damage applies within this distance of the beam segment. */
const BEAM_DAMAGE_RADIUS = 2.5;
const BEAM_DPS = 22;

/**
 * The core of the fight. The beam's aim direction rotates about the boss at a
 * capped angular rate, so escaping is a matter of out-running the sweep.
 *
 * A player circling the island at radius R, with the boss at distance D from
 * the track, moves at angular rate v/D. So a turn rate w catches everyone
 * slower than `v = w * D` and loses everyone faster. With the shipped loop
 * (track radius 90, boss 18 up => D = 91.8):
 *   phase 1: 0.20 rad/s -> escapes above ~18 u/s
 *   phase 2: 0.28 rad/s -> escapes above ~26 u/s
 *   phase 3: 0.45 rad/s -> escapes above ~41 u/s
 * Typical surf speed is 20-40 u/s and walking caps at 7, so surfing well is
 * always an answer and standing still never is.
 *
 * Phase 3 is deliberately set *above* a comfortable cruise. Measured at 0.32
 * a player holding 32+ u/s took literally zero damage across a 40 s fight,
 * which is not a boss — it's scenery. 0.45 means the last third of the fight
 * has to be surfed near the top of the speed range, so the encounter finally
 * has a failure mode for a good player rather than only for a bad one.
 */
const BEAM_TURN_RATE_BY_PHASE = [0.2, 0.28, 0.45];

/**
 * How fast the beam's far end extends or retracts, in u/s. Only matters when
 * the player's *radial* distance from the boss changes; the angular chase above
 * is what decides hits. Fast enough not to be a second, invisible dodge.
 */
const BEAM_REACH_SPEED = 120;

const BEAM_TELEGRAPH_CORE_RADIUS = 0.09;
const BEAM_LIVE_CORE_RADIUS = 0.5;
/** The telegraph shows a hint of the damage volume, the live beam shows all of it. */
const BEAM_TELEGRAPH_SHELL_SCALE = 0.35;

/* ------------------------------------------------------------------ *
 * Attack 2 - radial burst (phase 2+)
 * ------------------------------------------------------------------ */

/**
 * Projectiles per ring.
 *
 * 12 was measured as pure decoration: at a track radius of 90 it leaves ~47
 * units of arc between neighbours, so the ring landed 9 damage once across a
 * 40 s fight. The gap between pellets has to be comparable to the player's own
 * width for threading to mean anything, so this is set from the arc instead of
 * picked: 36 pellets leaves ~15.7 units of arc, wide enough to fly through
 * cleanly on a chosen line and narrow enough that drifting into one is a real
 * possibility.
 */
const RING_PROJECTILE_COUNT = 36;
const RING_SPEED = 18;
const RING_PROJECTILE_RADIUS = 0.8;
const RING_HIT_RADIUS = 1.4;
const RING_DAMAGE = 9;
/** Belt and braces next to the distance cull: nothing outlives this. */
const RING_MAX_LIFETIME = 14;
/**
 * Vertical spread of a ring's arrival heights about the track plane, in units.
 * A ring solved to arrive at exactly track level would sail under anyone riding
 * high on a ramp face — the faces span roughly +/-6 units around the plane — so
 * each pellet is given its own arrival height across that band and the ring
 * lands as a wall rather than a washing line.
 */
const RING_ARRIVAL_SPREAD = 6;

/* ------------------------------------------------------------------ *
 * Attack 3 - homing orbs (phase 3)
 * ------------------------------------------------------------------ */

const ORB_MIN_COUNT = 2;
const ORB_MAX_COUNT = 3;
/**
 * Must exceed surf speed or an orb launched from the island centre can never
 * close on a player already circling at 25-40 u/s — the same problem the drones
 * solve with interception maths.
 */
const ORB_SPEED = 30;
/** Capped steering is what makes them dodgeable: commit, whiff, fly past. */
const ORB_TURN_RATE = 0.9;
const ORB_LIFETIME = 8;
const ORB_RADIUS = 0.55;
const ORB_HIT_RADIUS = 1.3;
const ORB_DAMAGE = 12;
/** Spread so a pair doesn't fly as one object. */
const ORB_LAUNCH_SPREAD = 0.35;

/* ------------------------------------------------------------------ *
 * Phases
 * ------------------------------------------------------------------ */

const PHASE_2_HP_FRACTION = 0.66;
const PHASE_3_HP_FRACTION = 0.33;

interface PhaseTuning {
  /** Gap between the end of one beam and the start of the next telegraph. */
  beamCooldown: number;
  beamTurnRate: number;
  /** null = this phase does not use the pattern. */
  ringInterval: number | null;
  orbInterval: number | null;
}

const PHASES: PhaseTuning[] = [
  { beamCooldown: 5, beamTurnRate: BEAM_TURN_RATE_BY_PHASE[0], ringInterval: null, orbInterval: null },
  { beamCooldown: 3.5, beamTurnRate: BEAM_TURN_RATE_BY_PHASE[1], ringInterval: 6, orbInterval: null },
  { beamCooldown: 2.5, beamTurnRate: BEAM_TURN_RATE_BY_PHASE[2], ringInterval: 4.5, orbInterval: 5 },
];

/** Fraction of an interval waited before a pattern's first use in a new phase. */
const NEW_PHASE_LEAD_IN = 0.4;

/**
 * How far past the surf loop a projectile or orb may travel before it is
 * culled. Everything the boss emits starts at the island centre and flies
 * outward, so a horizontal-distance test against the loop is a complete
 * containment check.
 */
const OUTWARD_CULL_MARGIN = 30;

/* ------------------------------------------------------------------ *
 * Shared GPU resources
 * ------------------------------------------------------------------ */

/**
 * Colour is the whole identification scheme for things flying at the player:
 * cyan is the player's own auto-attack, hot orange is a ring pellet, magenta is
 * a homing orb. Three saturated, well-separated hues so a glance at a streak
 * says whether to dodge it and which way it will behave.
 */
const RING_COLOR = 0xff8a3c;
const ORB_COLOR = 0xff5ce8;
/** Bright enough to read as a light source against the grey course at speed. */
const PROJECTILE_EMISSIVE_INTENSITY = 2.6;
const PROJECTILE_SHELL_OPACITY = 0.32;

/**
 * Geometry *and* material are module-level and shared by every projectile and
 * orb: neither ever changes colour, so there is nothing per-instance to own and
 * therefore nothing per-instance to leak. Removal is unparenting, exactly as
 * with XP orbs. (The boss body and its beam do have per-instance materials, and
 * those are disposed in `Boss.dispose`.)
 *
 * Each projectile is drawn as a core plus a translucent additive shell, on the
 * same reasoning as the beam's shell: the shell radius is the *hit radius*, so
 * the glow the player dodges is the volume that actually damages them. A ring
 * pellet's damage radius is 1.4 against a 0.8 body, and an orb's is 1.3 against
 * a 0.55 body — drawing only the body means being hit by apparently empty air.
 * No hitbox changes here; this makes the existing ones visible.
 */
const PROJECTILE_GEOMETRY = new SphereGeometry(RING_PROJECTILE_RADIUS, 10, 8);
const PROJECTILE_MATERIAL = new MeshStandardMaterial({
  color: RING_COLOR,
  emissive: RING_COLOR,
  emissiveIntensity: PROJECTILE_EMISSIVE_INTENSITY,
  roughness: 1,
  metalness: 0,
});
const PROJECTILE_SHELL_GEOMETRY = new SphereGeometry(RING_HIT_RADIUS, 12, 10);
const PROJECTILE_SHELL_MATERIAL = new MeshBasicMaterial({
  color: RING_COLOR,
  transparent: true,
  opacity: PROJECTILE_SHELL_OPACITY,
  blending: AdditiveBlending,
  depthWrite: false,
});
const ORB_GEOMETRY = new SphereGeometry(ORB_RADIUS, 10, 8);
const ORB_MATERIAL = new MeshStandardMaterial({
  color: ORB_COLOR,
  emissive: ORB_COLOR,
  emissiveIntensity: PROJECTILE_EMISSIVE_INTENSITY,
  roughness: 1,
  metalness: 0,
});
const ORB_SHELL_GEOMETRY = new SphereGeometry(ORB_HIT_RADIUS, 12, 10);
const ORB_SHELL_MATERIAL = new MeshBasicMaterial({
  color: ORB_COLOR,
  transparent: true,
  opacity: PROJECTILE_SHELL_OPACITY,
  blending: AdditiveBlending,
  depthWrite: false,
});

/**
 * A glowing core with its damage-radius shell parented to it, so the pair moves
 * and is unparented as one object and the emit/cull code stays unchanged.
 */
function glowingProjectile(
  coreGeometry: BufferGeometry,
  coreMaterial: Material,
  shellGeometry: BufferGeometry,
  shellMaterial: Material,
): Mesh {
  const core = new Mesh(coreGeometry, coreMaterial);
  core.add(new Mesh(shellGeometry, shellMaterial));
  return core;
}

const UP = new Vector3(0, 1, 0);
const scratchDir = new Vector3();

type BeamState = 'cooldown' | 'telegraph' | 'live';

/** A ring-burst pellet: straight-line, no steering, damage on contact. */
class RingProjectile {
  readonly mesh = glowingProjectile(
    PROJECTILE_GEOMETRY,
    PROJECTILE_MATERIAL,
    PROJECTILE_SHELL_GEOMETRY,
    PROJECTILE_SHELL_MATERIAL,
  );
  readonly position: Vector3;
  age = 0;

  constructor(
    origin: Vector3,
    private readonly velocity: Vector3,
  ) {
    this.position = origin.clone();
    this.mesh.position.copy(this.position);
  }

  tick(dt: number): void {
    this.position.addScaledVector(this.velocity, dt);
    this.mesh.position.copy(this.position);
    this.age += dt;
  }
}

/** A slow seeker with a capped turn rate and a hard lifetime. */
class HomingOrb {
  readonly mesh = glowingProjectile(ORB_GEOMETRY, ORB_MATERIAL, ORB_SHELL_GEOMETRY, ORB_SHELL_MATERIAL);
  readonly position: Vector3;
  age = 0;

  private readonly heading: Vector3;

  constructor(origin: Vector3, launchDirection: Vector3) {
    this.position = origin.clone();
    this.heading = launchDirection.clone().normalize();
    this.mesh.position.copy(this.position);
  }

  tick(dt: number, playerPosition: Vector3): void {
    scratchDir.copy(playerPosition).sub(this.position);
    const distance = scratchDir.length();
    if (distance > 1e-4) {
      rotateToward(this.heading, scratchDir.divideScalar(distance), ORB_TURN_RATE * dt);
    }
    this.position.addScaledVector(this.heading, ORB_SPEED * dt);
    this.mesh.position.copy(this.position);
    this.age += dt;
  }
}

/**
 * The level-10 boss: a single large hovering solid parked over the island the
 * surf loop orbits, fought while the player keeps circling.
 *
 * Everything it owns — body, beam, projectiles, orbs — hangs off one `group`,
 * so `Game` attaches and detaches the whole fight with a single `scene.add` /
 * `scene.remove` pair and cannot leave a stray mesh behind.
 *
 * It deliberately does *not* extend `Enemy`: drones chase an intercept solution
 * and die in a couple of seconds, which is the opposite of a stationary
 * 2200 HP arena piece. It instead satisfies `WeaponTarget` (`health`,
 * `distanceToPlayer`, `flashHit`), which is the whole contract the auto-weapon
 * needs, so the weapon shoots it without knowing bosses exist.
 */
export class Boss {
  readonly group = new Group();
  readonly health = new Health(BOSS_MAX_HP);
  readonly name = BOSS_NAME;
  /** Hover anchor. The body bobs around this; `firePoint` is where beams start. */
  readonly position: Vector3;
  readonly firePoint: Vector3;

  private readonly body: Mesh;
  private readonly halo: Mesh;
  private readonly bodyMaterial: MeshStandardMaterial;
  private readonly haloMaterial: MeshBasicMaterial;
  private readonly beam = new LaserBeam();

  private readonly projectiles: RingProjectile[] = [];
  private readonly orbs: HomingOrb[] = [];

  /** Squared horizontal radius past which anything the boss emitted is gone. */
  private readonly outwardCullRadiusSq: number;
  /** See `distanceToPlayer`. */
  private readonly engageRadius: number;

  private phaseIndex = 0;
  private age = 0;
  private flashTimer = 0;

  private beamState: BeamState = 'cooldown';
  private beamTimer = PHASES[0].beamCooldown;
  private readonly beamAimDir = new Vector3(1, 0, 0);
  private beamAimReach = 0;
  private readonly beamAimPoint = new Vector3();

  private ringTimer = 0;
  private orbTimer = 0;

  constructor(
    islandCenter: Vector3,
    private readonly trackRadius: number,
    private readonly trackY: number,
  ) {
    // Anchored to the track's plane rather than to the island mesh's own
    // origin, so "18 units up" means 18 units above the surface the player
    // rides no matter where the island's pivot ends up.
    this.position = new Vector3(islandCenter.x, trackY + HOVER_HEIGHT, islandCenter.z);
    this.firePoint = this.position.clone();

    const trackToBoss = Math.hypot(trackRadius, this.position.y - trackY);
    this.engageRadius = trackToBoss + ENGAGE_MARGIN;
    const outwardCullRadius = trackRadius + OUTWARD_CULL_MARGIN;
    this.outwardCullRadiusSq = outwardCullRadius * outwardCullRadius;

    this.bodyMaterial = new MeshStandardMaterial({
      color: BODY_COLOR,
      emissive: BODY_EMISSIVE,
      emissiveIntensity: BODY_EMISSIVE_INTENSITY,
      roughness: 0.35,
      metalness: 0.4,
      flatShading: true,
    });
    this.body = new Mesh(new IcosahedronGeometry(BODY_RADIUS, 0), this.bodyMaterial);

    // Wireframe shell: gives the silhouette an outline that survives being seen
    // against the sky from 90 units away, where the flat-shaded solid alone
    // reads as a dark blob.
    this.haloMaterial = new MeshBasicMaterial({
      color: HALO_COLOR,
      wireframe: true,
      transparent: true,
      opacity: 0.5,
    });
    this.halo = new Mesh(new IcosahedronGeometry(BODY_RADIUS * 1.22, 0), this.haloMaterial);

    this.group.add(this.body, this.halo, this.beam.group);
    this.syncBody();
  }

  /* ---------------- read-only state for HUD / callers ---------------- */

  get hpFraction(): number {
    return Math.max(0, this.health.hp / this.health.maxHp);
  }

  /** 1-based, matching how it is shown to the player. */
  get phase(): number {
    return this.phaseIndex + 1;
  }

  get isAlive(): boolean {
    return !this.health.isDead;
  }

  /** Live emitted-entity count, so leaks are assertable from a test. */
  get emittedCount(): number {
    return this.projectiles.length + this.orbs.length;
  }

  /** Whether the beam is currently able to damage the player. */
  get beamIsLive(): boolean {
    return this.beamState === 'live';
  }

  get aimPoint(): Vector3 {
    return this.beamAimPoint;
  }

  /**
   * Distance the auto-weapon measures against its `range` stat.
   *
   * This is *not* the centre-to-centre distance, and it can't be: the weapon's
   * range is 22 units, tuned for drones that fly past within a few metres,
   * while the boss hovers over the island centre — 91.8 units from the surf
   * track on the shipped loop. A literal distance would make the boss
   * permanently unshootable and the fight unwinnable.
   *
   * So the boss reports its distance to the edge of an engagement bubble sized
   * from the actual geometry (track-to-boss distance plus margin): anywhere on
   * or near the loop reads as point-blank, and the target is still dropped if
   * the player somehow gets far outside the loop. The bubble is derived rather
   * than hardcoded so it stays correct if the loop's radius changes.
   */
  distanceToPlayer(playerPosition: Vector3): number {
    return Math.max(0, this.position.distanceTo(playerPosition) - this.engageRadius);
  }

  flashHit(): void {
    this.flashTimer = HIT_FLASH_DURATION;
    this.bodyMaterial.emissive.setHex(HIT_EMISSIVE);
  }

  /* ---------------------------- simulation ---------------------------- */

  /**
   * One fixed-timestep update. `dealDamage` is called with the damage done to
   * the player this tick — the boss never touches player state directly.
   */
  tick(dt: number, playerPosition: Vector3, dealDamage: (amount: number) => void): void {
    this.age += dt;
    this.updatePhase();
    this.syncBody();

    if (this.flashTimer > 0) {
      this.flashTimer -= dt;
      if (this.flashTimer <= 0) this.bodyMaterial.emissive.setHex(BODY_EMISSIVE);
    }

    this.updateBeam(dt, playerPosition, dealDamage);
    this.updateRingBursts(dt);
    this.updateOrbLaunches(dt, playerPosition);
    this.updateProjectiles(dt, playerPosition, dealDamage);
    this.updateOrbs(dt, playerPosition, dealDamage);
  }

  private get tuning(): PhaseTuning {
    return PHASES[this.phaseIndex];
  }

  private updatePhase(): void {
    const fraction = this.hpFraction;
    const next = fraction > PHASE_2_HP_FRACTION ? 0 : fraction > PHASE_3_HP_FRACTION ? 1 : 2;
    if (next === this.phaseIndex) return;
    this.phaseIndex = next;

    // A new pattern should announce itself shortly after the phase flips rather
    // than a full interval later, which would read as nothing having changed.
    const { ringInterval, orbInterval } = this.tuning;
    if (ringInterval !== null) this.ringTimer = ringInterval * NEW_PHASE_LEAD_IN;
    if (orbInterval !== null) this.orbTimer = orbInterval * NEW_PHASE_LEAD_IN;
  }

  private syncBody(): void {
    this.firePoint.copy(this.position);
    this.firePoint.y += Math.sin(this.age * BOB_RATE) * BOB_AMPLITUDE;
    for (const mesh of [this.body, this.halo]) {
      mesh.position.copy(this.firePoint);
      mesh.rotation.y = this.age * IDLE_YAW_RATE;
      mesh.rotation.x = this.age * IDLE_PITCH_RATE;
    }
  }

  /* ------------------------------- beam ------------------------------- */

  private updateBeam(
    dt: number,
    playerPosition: Vector3,
    dealDamage: (amount: number) => void,
  ): void {
    this.beamTimer -= dt;

    if (this.beamTimer <= 0) {
      if (this.beamState === 'cooldown') {
        this.beginBeam(playerPosition);
      } else if (this.beamState === 'telegraph') {
        this.beamState = 'live';
        this.beamTimer = BEAM_LIVE_SECONDS;
      } else {
        this.beamState = 'cooldown';
        this.beamTimer = this.tuning.beamCooldown;
        this.beam.hide();
        return;
      }
    }
    if (this.beamState === 'cooldown') return;

    this.chaseAim(dt, playerPosition);

    const live = this.beamState === 'live';
    this.beam.aim(
      this.firePoint,
      this.beamAimPoint,
      live ? BEAM_LIVE_CORE_RADIUS : BEAM_TELEGRAPH_CORE_RADIUS,
      BEAM_DAMAGE_RADIUS * (live ? 1 : BEAM_TELEGRAPH_SHELL_SCALE),
      live ? 1 : 0.85,
    );

    if (!live) return;
    if (pointSegmentDistance(playerPosition, this.firePoint, this.beamAimPoint) < BEAM_DAMAGE_RADIUS) {
      dealDamage(BEAM_DPS * dt);
    }
  }

  /**
   * Starts a beam locked exactly onto the player, so the telegraph second is
   * the player's whole warning *and* their whole head start: the aim point
   * begins on top of them and immediately starts falling behind at whatever
   * rate their speed beats the sweep.
   */
  private beginBeam(playerPosition: Vector3): void {
    this.beamState = 'telegraph';
    this.beamTimer = BEAM_TELEGRAPH_SECONDS;
    scratchDir.copy(playerPosition).sub(this.firePoint);
    const distance = scratchDir.length();
    this.beamAimReach = Math.max(distance, 1);
    if (distance > 1e-4) this.beamAimDir.copy(scratchDir.divideScalar(distance));
    this.updateAimPoint();
  }

  private chaseAim(dt: number, playerPosition: Vector3): void {
    scratchDir.copy(playerPosition).sub(this.firePoint);
    const distance = scratchDir.length();
    if (distance > 1e-4) {
      rotateToward(
        this.beamAimDir,
        scratchDir.divideScalar(distance),
        this.tuning.beamTurnRate * dt,
      );
      const reachStep = BEAM_REACH_SPEED * dt;
      const reachError = distance - this.beamAimReach;
      this.beamAimReach += Math.max(-reachStep, Math.min(reachStep, reachError));
    }
    this.updateAimPoint();
  }

  private updateAimPoint(): void {
    this.beamAimPoint.copy(this.firePoint).addScaledVector(this.beamAimDir, this.beamAimReach);
  }

  /* ---------------------------- ring burst ---------------------------- */

  private updateRingBursts(dt: number): void {
    const interval = this.tuning.ringInterval;
    if (interval === null) return;
    this.ringTimer -= dt;
    if (this.ringTimer > 0) return;
    this.ringTimer = interval;
    this.emitRing();
  }

  /**
   * A ring in the horizontal plane, *descending*: fired flat it would sail 18
   * units over the player's head forever, since the boss hovers that far above
   * the track. The sink rate is solved from the geometry so a pellet arrives at
   * track height just as it reaches the loop — which is the only place it can
   * ever meet the player.
   */
  private emitRing(): void {
    const phaseOffset = Math.random() * Math.PI * 2;
    for (let i = 0; i < RING_PROJECTILE_COUNT; i++) {
      const angle = phaseOffset + (i / RING_PROJECTILE_COUNT) * Math.PI * 2;
      const arrivalY = this.trackY + (Math.random() * 2 - 1) * RING_ARRIVAL_SPREAD;
      const sinkRate = (this.firePoint.y - arrivalY) * (RING_SPEED / this.trackRadius);
      const velocity = new Vector3(
        Math.cos(angle) * RING_SPEED,
        -sinkRate,
        Math.sin(angle) * RING_SPEED,
      );
      const projectile = new RingProjectile(this.firePoint, velocity);
      this.projectiles.push(projectile);
      this.group.add(projectile.mesh);
    }
  }

  private updateProjectiles(
    dt: number,
    playerPosition: Vector3,
    dealDamage: (amount: number) => void,
  ): void {
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const projectile = this.projectiles[i];
      projectile.tick(dt);

      if (projectile.position.distanceTo(playerPosition) < RING_HIT_RADIUS) {
        dealDamage(RING_DAMAGE);
        this.removeProjectileAt(i);
        continue;
      }
      if (projectile.age > RING_MAX_LIFETIME || this.isOutside(projectile.position)) {
        this.removeProjectileAt(i);
      }
    }
  }

  /* ---------------------------- homing orbs ---------------------------- */

  private updateOrbLaunches(dt: number, playerPosition: Vector3): void {
    const interval = this.tuning.orbInterval;
    if (interval === null) return;
    this.orbTimer -= dt;
    if (this.orbTimer > 0) return;
    this.orbTimer = interval;

    const count = ORB_MIN_COUNT + Math.floor(Math.random() * (ORB_MAX_COUNT - ORB_MIN_COUNT + 1));
    scratchDir.copy(playerPosition).sub(this.firePoint);
    if (scratchDir.lengthSq() < 1e-6) scratchDir.set(1, 0, 0);
    scratchDir.normalize();
    // Fan the launch headings apart around the world up axis; the turn-rate cap
    // then pulls them back in, so they arrive as a spread rather than a stack.
    const lateral = new Vector3().crossVectors(UP, scratchDir);
    if (lateral.lengthSq() < 1e-6) lateral.set(1, 0, 0);
    lateral.normalize();

    for (let i = 0; i < count; i++) {
      const offset = (i - (count - 1) / 2) * ORB_LAUNCH_SPREAD;
      const heading = scratchDir.clone().addScaledVector(lateral, offset);
      const orb = new HomingOrb(this.firePoint, heading);
      this.orbs.push(orb);
      this.group.add(orb.mesh);
    }
  }

  private updateOrbs(
    dt: number,
    playerPosition: Vector3,
    dealDamage: (amount: number) => void,
  ): void {
    for (let i = this.orbs.length - 1; i >= 0; i--) {
      const orb = this.orbs[i];
      orb.tick(dt, playerPosition);

      if (orb.position.distanceTo(playerPosition) < ORB_HIT_RADIUS) {
        dealDamage(ORB_DAMAGE);
        this.removeOrbAt(i);
        continue;
      }
      if (orb.age > ORB_LIFETIME || this.isOutside(orb.position)) {
        this.removeOrbAt(i);
      }
    }
  }

  /* ------------------------------ teardown ------------------------------ */

  /** Horizontal-distance containment test against the surf loop. */
  private isOutside(position: Vector3): boolean {
    const dx = position.x - this.position.x;
    const dz = position.z - this.position.z;
    return dx * dx + dz * dz > this.outwardCullRadiusSq;
  }

  private removeProjectileAt(index: number): void {
    this.group.remove(this.projectiles[index].mesh);
    this.projectiles.splice(index, 1);
  }

  private removeOrbAt(index: number): void {
    this.group.remove(this.orbs[index].mesh);
    this.orbs.splice(index, 1);
  }

  /**
   * Full teardown: every emitted entity unparented, every per-instance material
   * and the two body geometries freed. Shared projectile/orb resources are
   * module-level and outlive the boss on purpose.
   */
  dispose(): void {
    for (let i = this.projectiles.length - 1; i >= 0; i--) this.removeProjectileAt(i);
    for (let i = this.orbs.length - 1; i >= 0; i--) this.removeOrbAt(i);
    this.beam.hide();
    this.beam.dispose();
    this.group.remove(this.body, this.halo, this.beam.group);
    this.body.geometry.dispose();
    this.halo.geometry.dispose();
    this.bodyMaterial.dispose();
    this.haloMaterial.dispose();
  }
}
