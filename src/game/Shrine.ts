import {
  Group,
  Mesh,
  MeshStandardMaterial,
  OctahedronGeometry,
  TorusGeometry,
  Vector3,
} from 'three';
import { SHRINE_COLLECT_RADIUS } from '../world/SurfCourse';

/** Shared across every shrine; never disposed per-instance. */
const CRYSTAL_GEOMETRY = new OctahedronGeometry(1.5);
const RING_GEOMETRY = new TorusGeometry(2.6, 0.22, 10, 28);

/**
 * Gold, and deliberately not the violet of the seeder or the teal of an XP
 * orb: at surf speed a pickup is identified by colour long before shape, so
 * every pickup family keeps its own. Normal blending and a restrained
 * emissive, for the reasons the slash cone taught — additive washes out
 * against this sky and hot emissives on saturated colours clip to white.
 */
const SHRINE_COLOR = 0xffc94d;
const SHRINE_EMISSIVE = 0xd99a1f;
const RING_COLOR = 0x8a7340;

const BOB_AMPLITUDE = 0.5;
const BOB_RATE = 1.6;
const SPIN_RATE = 0.9;

/**
 * Seconds a collected blessing stays gone before it comes back somewhere else.
 *
 * Long enough that taking one is a real event rather than a resource tap, short
 * enough that a lap of the ring is usually rewarded with a fresh one to chase.
 */
export const SHRINE_RESPAWN_SECONDS = 30;

/** Everything about a shrine that has to survive a rewind. */
export interface ShrineSnapshot {
  collected: boolean;
  respawnRemaining: number;
  x: number;
  y: number;
  z: number;
}

/**
 * A blessing shrine: a floating pickup the player reaches by carrying speed
 * off a face and sailing to it — the course places every one off the surf
 * line, so reaching it *costs* line and airtime. Flying through it opens the
 * free powerup choice immediately: the pause freezes the whole sim, so the
 * flight resumes exactly where it stopped once a power is picked.
 *
 * No collider — it is a pickup, not geometry. Meshes share module-level
 * geometry; each shrine owns its two materials (they dim when spent).
 */
export class Shrine {
  readonly group = new Group();
  collected = false;

  /**
   * Mutable now, because a blessing is no longer a fixture of the level: taking
   * one removes it and it returns somewhere else entirely. Anything that stores
   * a shrine's position must re-read it rather than caching — which is also why
   * it is part of `ShrineSnapshot`.
   */
  readonly position: Vector3;

  /**
   * Where the course authored this shrine. Kept because the position is
   * mutable now: without it, restarting a run would leave every blessing
   * wherever the *previous* run happened to scatter it, and a fresh level would
   * not look like a fresh level.
   */
  private readonly origin: Vector3;

  private respawnRemaining = 0;
  private readonly crystal: Mesh;
  private readonly crystalMaterial: MeshStandardMaterial;
  private readonly ringMaterial: MeshStandardMaterial;
  private bobPhase = 0;

  constructor(position: Vector3) {
    this.position = position.clone();
    this.origin = position.clone();
    this.crystalMaterial = new MeshStandardMaterial({
      color: SHRINE_COLOR,
      emissive: SHRINE_EMISSIVE,
      emissiveIntensity: 1.1,
      roughness: 0.35,
    });
    this.ringMaterial = new MeshStandardMaterial({
      color: RING_COLOR,
      emissive: RING_COLOR,
      emissiveIntensity: 0.35,
      roughness: 0.6,
    });

    this.crystal = new Mesh(CRYSTAL_GEOMETRY, this.crystalMaterial);
    const ring = new Mesh(RING_GEOMETRY, this.ringMaterial);
    ring.rotation.x = Math.PI / 2;
    this.group.add(this.crystal, ring);
    this.placeAt(this.position);
  }

  /**
   * Fixed-tick animation, respawn countdown, and the pickup test. Returns true
   * on the tick it is collected.
   */
  tick(dt: number, playerPosition: Vector3): boolean {
    if (this.collected) {
      // Keep counting even while invisible; `needsRespawn` is the game loop's
      // cue to hand this shrine a new home.
      this.respawnRemaining = Math.max(0, this.respawnRemaining - dt);
      return false;
    }

    this.bobPhase += dt * BOB_RATE;
    this.group.position.y = this.position.y + Math.sin(this.bobPhase) * BOB_AMPLITUDE;
    this.crystal.rotation.y += dt * SPIN_RATE;

    if (playerPosition.distanceToSquared(this.group.position) > SHRINE_COLLECT_RADIUS ** 2) {
      return false;
    }
    this.collected = true;
    this.respawnRemaining = SHRINE_RESPAWN_SECONDS;
    this.setVisible(false);
    return true;
  }

  /** True once the countdown has run out and the shrine is waiting on a position. */
  get needsRespawn(): boolean {
    return this.collected && this.respawnRemaining <= 0;
  }

  /** Brings a collected blessing back somewhere else. */
  respawnAt(position: Vector3): void {
    this.collected = false;
    this.respawnRemaining = 0;
    this.placeAt(position);
    this.setVisible(true);
  }

  /** Un-collects and returns to its authored spot, for a fresh run. */
  reset(): void {
    this.collected = false;
    this.respawnRemaining = 0;
    this.placeAt(this.origin);
    this.setVisible(true);
  }

  capture(): ShrineSnapshot {
    return {
      collected: this.collected,
      respawnRemaining: this.respawnRemaining,
      x: this.position.x,
      y: this.position.y,
      z: this.position.z,
    };
  }

  /**
   * The rewind recorder's write-back. Position travels alongside the collected
   * flag because a shrine is no longer a fixture: rewinding across a pickup has
   * to put the blessing back *where it was taken from*, not wherever it has
   * since respawned.
   */
  restore(snapshot: ShrineSnapshot): void {
    this.collected = snapshot.collected;
    this.respawnRemaining = snapshot.respawnRemaining;
    this.placeAt(new Vector3(snapshot.x, snapshot.y, snapshot.z));
    this.setVisible(!snapshot.collected);
  }

  private placeAt(position: Vector3): void {
    this.position.copy(position);
    this.group.position.copy(position);
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
    this.crystalMaterial.dispose();
    this.ringMaterial.dispose();
  }
}
