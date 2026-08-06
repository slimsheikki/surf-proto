import { Color, DoubleSide, Group, Mesh, MeshBasicMaterial, SphereGeometry, Vector3 } from 'three';
import { vfxMaterial } from '../render/NprMaterials';

/**
 * Radius of the danger volume, and the fuse before it goes off.
 *
 * Retuned from the original 1 s on-your-line intercept, which play showed was
 * nearly unavoidable at surf speed: the old velocity-lead (0.3 s, capped 10u)
 * planted the centre on the flight line with its edge ~3u from the player's
 * face. The blast is now **area denial**: planted a fixed medium distance
 * ahead (see `plantPoint`), with two full seconds of telegraph — the claim is
 * "that patch of your line is spoken for; be past it or around it in 2 s". A
 * surfer holding any real speed clears it on the straight; the players it
 * catches are the ones who dawdle into the claimed ground, and the
 * still-player fallback below keeps the old "keep moving" rule alive.
 */
export const BLAST_RADIUS = 7;
export const BLAST_FUSE = 2;

/**
 * How far ahead of the player, along their travel direction, the centre lands.
 *
 * A fixed distance, not a velocity lead — the old lead scaled with speed and
 * capped in exactly the band where it sat dead on the line. 15 puts the
 * sphere's near edge (15 − radius 7 = 8u) clearly off the player at plant
 * time: never directly on you, never so far it reads as someone else's
 * problem.
 */
export const BLAST_PLANT_AHEAD = 15;
/**
 * Below this speed there is no meaningful "ahead", so the blast plants on the
 * player instead. At a 2 s fuse even walk speed (7) clears the 7u radius with
 * room to spare — the fallback is not a kill, it is the eviction notice that
 * keeps the seeder the enemy that punishes *not* surfing.
 */
export const BLAST_MIN_LEAD_SPEED = 5;

/** Bright flash on detonation, then a quick fade. Cosmetic only — damage is resolved on one tick. */
const AFTERGLOW = 0.28;

const SHELL_COLOR = 0xffb347;
const FILL_COLOR = 0xff7a3c;
const DETONATION_COLOR = 0xfff0b0;
/**
 * What the fill heats toward as the fuse runs down. The 2 s telegraph is long
 * enough that "how full is the sphere" alone under-reads at a glance, so the
 * last stretch also *changes colour* — orange cooking to near-white — which is
 * the channel that survives peripheral vision at 35 u/s.
 */
const FILL_HOT = new Color(0xffe08a);
const FILL_BASE = new Color(FILL_COLOR);
const FILL_SCRATCH = new Color();

const SHELL_OPACITY = 0.5;
const FILL_OPACITY = 0.16;

/**
 * Unit spheres, scaled per instance. Shared because a late-game wave can have a
 * dozen of these live.
 *
 * The shell is deliberately coarse. A 16x12 wireframe looks fine from outside
 * and is a thicket from *inside* — which is exactly where the player is when
 * they most need to see the world in order to leave it. Ten segments still read
 * unmistakably as a sphere and leave the view through it mostly clear.
 */
const SHELL_GEOMETRY = new SphereGeometry(1, 10, 6);
const FILL_GEOMETRY = new SphereGeometry(1, 16, 12);

/**
 * A telegraphed area attack: a sphere that announces itself, fills up, and then
 * detonates once.
 *
 * Spherical rather than a disc on the ground, and that is not a shortcut. The
 * player spends most of a run airborne against a banked wall, so a circle
 * painted on the floor is a circle they are nowhere near and cannot judge
 * distance to. A sphere is the actual damage volume, drawn at the actual size.
 *
 * The read is split across two meshes on purpose. The wireframe shell is at
 * full radius from the first frame, so *where the edge is* is legible
 * immediately and never moves. The solid fill grows from nothing to that same
 * radius over the fuse, so *how long is left* is legible from the same glance.
 * One mesh doing both jobs would mean the boundary moves while you are trying
 * to leave it.
 *
 * Normal blending, not additive: the sky here is bright, and additive washes to
 * white against it — the same mistake the slash cone already paid for.
 */
export class Blast {
  readonly group = new Group();
  readonly position: Vector3;
  /** True once the detonation and its afterglow are done; the owner then culls it. */
  finished = false;

  private readonly shell: Mesh;
  private readonly fill: Mesh;
  private readonly shellMaterial: MeshBasicMaterial;
  private readonly fillMaterial: MeshBasicMaterial;

  private fuse = BLAST_FUSE;
  private afterglow = AFTERGLOW;
  private detonated = false;
  private pulsePhase = 0;

  constructor(
    position: Vector3,
    private readonly damage: number,
    readonly radius: number = BLAST_RADIUS,
  ) {
    this.position = position.clone();

    this.shellMaterial = vfxMaterial({
      color: SHELL_COLOR,
      wireframe: true,
      transparent: true,
      opacity: SHELL_OPACITY,
      depthWrite: false,
    });
    this.shell = new Mesh(SHELL_GEOMETRY, this.shellMaterial);
    this.shell.scale.setScalar(this.radius);

    this.fillMaterial = vfxMaterial({
      color: FILL_COLOR,
      transparent: true,
      opacity: FILL_OPACITY,
      depthWrite: false,
      // Double-sided so the volume still reads when the camera is inside it.
      // Front faces alone are culled from within, which meant the one situation
      // that matters most — you are in the blast, it is about to go off — was
      // the one situation with no fill drawn at all.
      side: DoubleSide,
    });
    this.fill = new Mesh(FILL_GEOMETRY, this.fillMaterial);
    this.fill.scale.setScalar(0.001);

    this.group.position.copy(this.position);
    this.group.add(this.shell, this.fill);
  }

  /**
   * One fixed-timestep update. Damage is resolved on exactly one tick — the
   * tick the fuse runs out — rather than continuously while the player is
   * inside. A single check is what makes the attack learnable: being in the
   * volume is not dangerous, being in it *when it goes off* is.
   */
  tick(dt: number, playerPosition: Vector3, dealDamage: (amount: number) => void): void {
    if (this.finished) return;

    if (!this.detonated) {
      this.fuse -= dt;

      const filled = Math.min(1, 1 - this.fuse / BLAST_FUSE);
      // The pulse quickens AND widens as the fuse runs down, and the fill
      // cooks from orange toward white — three redundant channels (size,
      // rhythm, colour) so "it is about to land" is legible from any one of
      // them, at any angle, from inside or outside the volume.
      this.pulsePhase += dt * (7 + 8 * filled);
      this.fill.scale.setScalar(Math.max(0.001, filled * this.radius));
      this.shell.scale.setScalar(
        this.radius * (1 + Math.sin(this.pulsePhase) * (0.015 + 0.045 * filled * filled)),
      );
      this.fillMaterial.opacity = FILL_OPACITY + filled * 0.18;
      this.fillMaterial.color.copy(FILL_SCRATCH.copy(FILL_BASE).lerp(FILL_HOT, filled * filled));
      this.shellMaterial.opacity = SHELL_OPACITY + filled * 0.25;

      if (this.fuse > 0) return;

      this.detonated = true;
      if (playerPosition.distanceTo(this.position) <= this.radius) dealDamage(this.damage);

      this.fill.scale.setScalar(this.radius);
      this.shell.scale.setScalar(this.radius);
      this.shellMaterial.color.setHex(DETONATION_COLOR);
      this.fillMaterial.color.setHex(DETONATION_COLOR);
      return;
    }

    this.afterglow -= dt;
    const remaining = Math.max(0, this.afterglow / AFTERGLOW);
    this.fillMaterial.opacity = 0.55 * remaining;
    this.shellMaterial.opacity = 0.8 * remaining;
    if (this.afterglow <= 0) this.finished = true;
  }

  /** Geometry is shared; the two materials are per-instance and must be freed. */
  dispose(): void {
    this.shellMaterial.dispose();
    this.fillMaterial.dispose();
  }

  /**
   * Where a blast aimed at a moving player belongs: a fixed medium distance
   * ahead along their travel direction — claimed ground, not an intercept.
   * Exported as a helper rather than done at the call site so the rule lives
   * next to the constants that justify it. Falls back to the player's own
   * position when they are too slow to have a meaningful "ahead".
   */
  static plantPoint(playerPosition: Vector3, playerVelocity: Vector3): Vector3 {
    const speed = playerVelocity.length();
    if (speed < BLAST_MIN_LEAD_SPEED) return playerPosition.clone();
    return playerPosition
      .clone()
      .addScaledVector(playerVelocity, BLAST_PLANT_AHEAD / speed);
  }
}
