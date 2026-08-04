import { BackSide, Group, Mesh, MeshBasicMaterial, MeshStandardMaterial, TorusGeometry, Vector3 } from 'three';
import type { BlessingAnchor } from '../world/BlessingSpots';

/**
 * The opening the player flies through.
 *
 * A blessing is a gate, not a trinket: it is sized so that a line which looks
 * like it goes through the hole does go through the hole, at the speeds this
 * game is played at. Everything else here is measured off it.
 */
const RING_RADIUS = 4.6;

/** Shared across every shrine; never disposed per-instance. */
const RING_GEOMETRY = new TorusGeometry(RING_RADIUS, 0.3, 12, 40);
/**
 * The glow is a second, fatter torus rather than a sprite or a light: it hugs
 * the ring at any viewing angle, costs no shadow work, and — unlike a light —
 * cannot wash out the ramp underneath the blessing.
 */
const GLOW_GEOMETRY = new TorusGeometry(RING_RADIUS, 1.05, 10, 36);

/** Torus geometry opens along its local Z, so this is the axis aimed down the ramp. */
const RING_AXIS = new Vector3(0, 0, 1);

/**
 * Gold, and deliberately not the violet of the seeder or the teal of an XP
 * orb: at surf speed a pickup is identified by colour long before shape, so
 * every pickup family keeps its own. Normal blending and a restrained
 * emissive, for the reasons the slash cone taught — additive washes out
 * against this sky and hot emissives on saturated colours clip to white.
 */
const SHRINE_COLOR = 0xffc94d;
const SHRINE_EMISSIVE = 0xd99a1f;
const GLOW_COLOR = 0xffd982;

/** Baseline halo strength, and how far the breathing swings it either side. */
const GLOW_OPACITY = 0.17;
const GLOW_PULSE = 0.07;

/**
 * "Hover ever so slightly" — a drift, not a bounce. The old shrine bobbed half
 * a unit, which on a gate the player is aiming through is enough to make a
 * committed line miss.
 */
const BOB_AMPLITUDE = 0.18;
const BOB_RATE = 1.3;

/**
 * How close to the ring's centre counts as flying through it.
 *
 * The ring's own opening, so the pickup volume is the thing the player can see
 * rather than an invisible sphere around it. A point test is safe at this size:
 * the sim runs at 128 Hz, so even a very fast player advances a fraction of a
 * unit per tick and cannot tunnel through a 9-unit gate.
 */
export const SHRINE_COLLECT_RADIUS = RING_RADIUS;

/**
 * Seconds between blessings appearing.
 *
 * Long enough that taking one is a real event rather than a resource tap, short
 * enough that a stretch of the course is usually rewarded with a fresh one to
 * chase. Slots stagger off this at the start of a run, so the map fills up to
 * its cap one blessing at a time rather than all at once.
 */
export const SHRINE_RESPAWN_SECONDS = 30;

/** Everything about a shrine that has to survive a rewind. */
export interface ShrineSnapshot {
  collected: boolean;
  respawnRemaining: number;
  x: number;
  y: number;
  z: number;
  /** Facing travels with position: a restored blessing must face as it did. */
  fx: number;
  fy: number;
  fz: number;
}

/**
 * A blessing: a floating ring the player surfs *through*, hung above a ramp so
 * that reaching it costs line and airtime. Passing through opens the free
 * powerup choice immediately — the pause freezes the whole sim, so the flight
 * resumes exactly where it stopped once a power is picked.
 *
 * No collider — it is a pickup, not geometry. Meshes share module-level
 * geometry; each shrine owns its materials.
 */
export class Shrine {
  readonly group = new Group();
  collected = false;

  /**
   * Mutable, because a blessing is not a fixture of the level: taking one
   * removes it and it returns somewhere else entirely. Anything that stores a
   * shrine's position must re-read it rather than caching — which is also why
   * it is part of `ShrineSnapshot`.
   */
  readonly position: Vector3;

  /** Ramp heading the ring faces, so the line through it is the line down the ramp. */
  readonly forward = new Vector3(0, 0, 1);

  private respawnRemaining = 0;
  private readonly ringMaterial: MeshStandardMaterial;
  private readonly glowMaterial: MeshBasicMaterial;
  private bobPhase = 0;

  constructor(anchor: BlessingAnchor) {
    this.position = anchor.position.clone();
    this.ringMaterial = new MeshStandardMaterial({
      color: SHRINE_COLOR,
      emissive: SHRINE_EMISSIVE,
      emissiveIntensity: 1.1,
      roughness: 0.35,
    });
    this.glowMaterial = new MeshBasicMaterial({
      color: GLOW_COLOR,
      transparent: true,
      opacity: GLOW_OPACITY,
      // Back faces only, and no depth write: the halo reads as light around the
      // ring instead of a solid shell in front of it, and never z-fights with
      // the ring it wraps.
      side: BackSide,
      depthWrite: false,
    });

    this.group.add(new Mesh(RING_GEOMETRY, this.ringMaterial));
    this.group.add(new Mesh(GLOW_GEOMETRY, this.glowMaterial));
    this.placeAt(anchor.position, anchor.forward);
  }

  /**
   * Fixed-tick animation, spawn countdown, and the pickup test. Returns true on
   * the tick it is collected.
   */
  tick(dt: number, playerPosition: Vector3): boolean {
    if (this.collected) {
      // Keep counting even while invisible; `needsRespawn` is the game loop's
      // cue to hand this shrine a home.
      this.respawnRemaining = Math.max(0, this.respawnRemaining - dt);
      return false;
    }

    this.bobPhase += dt * BOB_RATE;
    const bob = Math.sin(this.bobPhase);
    this.group.position.y = this.position.y + bob * BOB_AMPLITUDE;
    this.glowMaterial.opacity = GLOW_OPACITY + bob * GLOW_PULSE;

    if (playerPosition.distanceToSquared(this.group.position) > SHRINE_COLLECT_RADIUS ** 2) {
      return false;
    }
    this.collected = true;
    this.respawnRemaining = SHRINE_RESPAWN_SECONDS;
    this.setVisible(false);
    return true;
  }

  /** True once the countdown has run out and the shrine is waiting on a spot. */
  get needsRespawn(): boolean {
    return this.collected && this.respawnRemaining <= 0;
  }

  /** Brings a blessing into the world at a fresh spot. */
  respawnAt(anchor: BlessingAnchor): void {
    this.collected = false;
    this.respawnRemaining = 0;
    this.placeAt(anchor.position, anchor.forward);
    this.setVisible(true);
  }

  /**
   * Puts the shrine back to dormant for a fresh run, due to appear in
   * `delaySeconds`.
   *
   * Dormant-and-counting rather than placed, even at zero delay: the game loop
   * owns where a blessing goes, so a slot that is due simply reports
   * `needsRespawn` and is given a spot. A run resets every slot to zero, which
   * puts the full complement up on the first tick.
   */
  reset(delaySeconds: number): void {
    this.collected = true;
    this.respawnRemaining = delaySeconds;
    this.setVisible(false);
  }

  capture(): ShrineSnapshot {
    return {
      collected: this.collected,
      respawnRemaining: this.respawnRemaining,
      x: this.position.x,
      y: this.position.y,
      z: this.position.z,
      fx: this.forward.x,
      fy: this.forward.y,
      fz: this.forward.z,
    };
  }

  /**
   * The rewind recorder's write-back. Position and facing travel alongside the
   * collected flag because a shrine is not a fixture: rewinding across a pickup
   * has to put the blessing back *where it was taken from*, not wherever it has
   * since respawned.
   */
  restore(snapshot: ShrineSnapshot): void {
    this.collected = snapshot.collected;
    this.respawnRemaining = snapshot.respawnRemaining;
    this.placeAt(
      new Vector3(snapshot.x, snapshot.y, snapshot.z),
      new Vector3(snapshot.fx, snapshot.fy, snapshot.fz),
    );
    this.setVisible(!snapshot.collected);
  }

  private placeAt(position: Vector3, forward: Vector3): void {
    this.position.copy(position);
    this.group.position.copy(position);
    this.forward.copy(forward);
    if (this.forward.lengthSq() < 1e-6) this.forward.copy(RING_AXIS);
    this.forward.normalize();
    this.group.quaternion.setFromUnitVectors(RING_AXIS, this.forward);
    // Desynchronised bobbing, keyed off position rather than Math.random() so
    // a headless run and a browser run animate identically — and re-keyed on
    // every move, so a respawned shrine does not resume mid-bob.
    this.bobPhase = (position.x + position.z) * 0.7;
  }

  /**
   * Collected blessings vanish outright rather than dimming in place. They used
   * to stay as a dark landmark, which stopped making sense once they respawn:
   * the shrine is not spent, it is *elsewhere*, and leaving a husk behind would
   * advertise a blessing at a spot that no longer has one.
   */
  private setVisible(visible: boolean): void {
    this.group.visible = visible;
  }

  dispose(): void {
    this.ringMaterial.dispose();
    this.glowMaterial.dispose();
  }
}
