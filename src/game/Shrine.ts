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

  private readonly crystal: Mesh;
  private readonly crystalMaterial: MeshStandardMaterial;
  private readonly ringMaterial: MeshStandardMaterial;
  private bobPhase: number;

  constructor(readonly position: Vector3) {
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
    this.group.position.copy(position);
    // Desynchronised bobbing, keyed off position rather than Math.random() so
    // a headless run and a browser run animate identically.
    this.bobPhase = (position.x + position.z) * 0.7;
  }

  /** Fixed-tick animation plus the pickup test. Returns true on the tick it is collected. */
  tick(dt: number, playerPosition: Vector3): boolean {
    this.bobPhase += dt * BOB_RATE;
    this.group.position.y = this.position.y + Math.sin(this.bobPhase) * BOB_AMPLITUDE;
    this.crystal.rotation.y += dt * SPIN_RATE;

    if (this.collected) return false;
    if (playerPosition.distanceToSquared(this.group.position) > SHRINE_COLLECT_RADIUS ** 2) {
      return false;
    }
    this.collected = true;
    this.setSpent(true);
    return true;
  }

  /** Un-collects for a fresh run. */
  reset(): void {
    this.setCollected(false);
  }

  /**
   * Puts the collected flag back where it was, dimming or relighting to match.
   * The rewind recorder uses this: rewinding past a shrine you flew through has
   * to hand the blessing back, and a shrine that stayed dark would be a
   * landmark promising something it no longer gives.
   */
  setCollected(collected: boolean): void {
    this.collected = collected;
    this.setSpent(collected);
  }

  /** Spent shrines stay visible but go dark — a landmark, no longer a promise. */
  private setSpent(spent: boolean): void {
    this.crystalMaterial.emissiveIntensity = spent ? 0.1 : 1.1;
    this.crystalMaterial.opacity = spent ? 0.45 : 1;
    this.crystalMaterial.transparent = spent;
    this.ringMaterial.emissiveIntensity = spent ? 0.05 : 0.35;
  }

  dispose(): void {
    this.crystalMaterial.dispose();
    this.ringMaterial.dispose();
  }
}
