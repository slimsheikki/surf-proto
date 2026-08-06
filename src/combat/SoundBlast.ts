import { Mesh, MeshBasicMaterial, SphereGeometry, Vector3 } from 'three';
import { vfxMaterial } from '../render/NprMaterials';
import { WeaponTarget } from './Weapon';

/**
 * Sound Blast: dashing emits a damaging shockwave around the player.
 *
 * Piggybacked on the dash on purpose — the dash is the one button the player
 * already presses *while surfing* (a redirect, not a stop), so an attack hung
 * off it costs zero attention and never asks anyone to stop moving. The blast
 * is instantaneous on the dash tick: the enemies it hits die in the same
 * tick's kill pass, so their orbs drop while the dasher is still close enough
 * for the magnet to latch them.
 */

/**
 * Default reach of the shockwave — the value `RunPerks.soundBlastRadius`
 * starts at; Subwoofer stacks grow the live number. Well past CONTACT_RADIUS
 * (1.3) so it clears the swarm that was about to land a hit — the blast's job
 * is turning a panic dash *out* of a crowd into an attack *on* the crowd —
 * while staying a third of the auto-weapon's 22-unit envelope, so it never
 * becomes the primary gun.
 */
export const SOUND_BLAST_RADIUS = 7;

/**
 * Damages everything in range and reports how many were hit. Pure — the
 * caller owns the entity list and the visual — so a headless probe can assert
 * the damage rule without a scene. Radius is a parameter because three
 * different powers fire this (dash blast, echo, Chorus, the mirror flash) at
 * different sizes.
 *
 * Targets are the drone/seeder list only, never the boss: `Boss` is an arena
 * piece whose `distanceToPlayer` already lies for the hitscan gun's benefit,
 * and a shockwave that reached it from across the arena would repeat the
 * knife's boss bug in reverse. True distances against real drone positions.
 */
export function applySoundBlast(
  targets: readonly WeaponTarget[],
  center: Vector3,
  damage: number,
  radius: number = SOUND_BLAST_RADIUS,
): number {
  const radiusSq = radius * radius;
  let hit = 0;
  for (const target of targets) {
    if (target.health.isDead) continue;
    if (target.position.distanceToSquared(center) > radiusSq) continue;
    target.health.takeDamage(damage);
    target.flashHit();
    hit += 1;
  }
  return hit;
}

/* ------------------------------------------------------------------ *
 * Effect
 * ------------------------------------------------------------------ */

const BLAST_FADE_SECONDS = 0.35;
const BLAST_START_OPACITY = 0.45;
/** Starts small and rings out to the true damage radius — the same honesty rule as the old slash cone. */
const BLAST_START_RADIUS = 1.2;
const BLAST_COLOR = 0xcfe8ff;

/**
 * A one-shot expanding shell at the exact damage radius, one reused mesh
 * retriggered per blast. Normal blending, deliberately not additive: additive
 * only adds light, and over the bright sky — which is most of the frame while
 * airborne — it washes out to nothing (the lesson every effect in this project
 * has now learned once).
 */
export class SoundBlastFx {
  readonly mesh: Mesh;
  private readonly material: MeshBasicMaterial;
  private timer = 0;
  /** Set per trigger, so the shell always dies exactly where that blast's damage reached. */
  private targetRadius = SOUND_BLAST_RADIUS;

  constructor() {
    this.material = vfxMaterial({
      color: BLAST_COLOR,
      transparent: true,
      opacity: BLAST_START_OPACITY,
      depthWrite: false,
    });
    this.mesh = new Mesh(new SphereGeometry(1, 24, 16), this.material);
    this.mesh.visible = false;
    // Depth-writeless: draw late so it lands over solid geometry.
    this.mesh.renderOrder = 10;
  }

  trigger(center: Vector3, radius: number = SOUND_BLAST_RADIUS): void {
    this.timer = BLAST_FADE_SECONDS;
    this.targetRadius = radius;
    this.mesh.position.copy(center);
    this.mesh.scale.setScalar(BLAST_START_RADIUS);
    this.material.opacity = BLAST_START_OPACITY;
    this.mesh.visible = true;
  }

  tick(dt: number): void {
    if (this.timer <= 0) return;
    this.timer -= dt;
    if (this.timer <= 0) {
      this.mesh.visible = false;
      return;
    }
    const remaining = this.timer / BLAST_FADE_SECONDS;
    // Eases out toward the full radius as it fades, so the shell dies exactly
    // where the damage reached.
    const grown = 1 - remaining * remaining;
    this.mesh.scale.setScalar(BLAST_START_RADIUS + (this.targetRadius - BLAST_START_RADIUS) * grown);
    this.material.opacity = BLAST_START_OPACITY * remaining;
  }

  hide(): void {
    this.timer = 0;
    this.mesh.visible = false;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}
