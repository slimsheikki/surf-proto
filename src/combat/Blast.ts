import { DoubleSide, Group, Mesh, MeshBasicMaterial, SphereGeometry, Vector3 } from 'three';

/**
 * Radius of the danger volume, and the fuse before it goes off.
 *
 * These two numbers *are* the mechanic, and they are chosen together. A player
 * escapes iff they cover more than `RADIUS` in `FUSE` seconds from where the
 * blast was planted, so the speed that survives is `RADIUS / FUSE` — about 7
 * u/s here, before the planting lead is accounted for. Walk speed is exactly
 * 7.0 and a surf line runs 20-40, so the rule the player learns is simply
 * *keep moving*: a blast is lethal to someone standing on a platform, someone
 * who has just botched a landing and bled their speed, or someone hovering to
 * fight, and irrelevant to someone actually surfing.
 *
 * That asymmetry is the point. The combat layer is not allowed to make the
 * player stop surfing, and this is the one enemy that actively punishes them
 * for having stopped.
 */
export const BLAST_RADIUS = 7;
export const BLAST_FUSE = 1;

/**
 * How far ahead of the player, in seconds of their current velocity, the centre
 * is placed.
 *
 * Small but not zero. At zero, a blast is a pure "you are standing still"
 * check; a modest lead pushes the escape threshold up to
 * `RADIUS / (FUSE - LEAD)` — around 10 u/s — so it also catches the genuinely
 * slow recovery, which is the state a player is most often in when they are
 * about to die anyway. A lead near the fuse would instead land the blast on top
 * of wherever a straight line is going, which every surfer is on all the time,
 * and the attack would become undodgeable-by-default rather than dodgeable.
 */
export const BLAST_LEAD_SECONDS = 0.3;
/** Cap on that lead, so a 40 u/s player doesn't get blasts planted in empty sky ahead of them. */
const MAX_LEAD_DISTANCE = 10;

/** Bright flash on detonation, then a quick fade. Cosmetic only — damage is resolved on one tick. */
const AFTERGLOW = 0.28;

const SHELL_COLOR = 0xffb347;
const FILL_COLOR = 0xff7a3c;
const DETONATION_COLOR = 0xfff0b0;

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

    this.shellMaterial = new MeshBasicMaterial({
      color: SHELL_COLOR,
      wireframe: true,
      transparent: true,
      opacity: SHELL_OPACITY,
      depthWrite: false,
    });
    this.shell = new Mesh(SHELL_GEOMETRY, this.shellMaterial);
    this.shell.scale.setScalar(this.radius);

    this.fillMaterial = new MeshBasicMaterial({
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
      this.pulsePhase += dt * 9;

      const filled = Math.min(1, 1 - this.fuse / BLAST_FUSE);
      this.fill.scale.setScalar(Math.max(0.001, filled * this.radius));
      // The shell breathes harder as the fuse runs down, so the last third
      // reads as urgent from peripheral vision alone.
      this.shell.scale.setScalar(this.radius * (1 + Math.sin(this.pulsePhase) * 0.02 * filled));
      this.fillMaterial.opacity = FILL_OPACITY + filled * 0.14;

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
   * Where a blast aimed at a moving player belongs. Exported as a helper rather
   * than done at the call site so the lead rule lives next to the constants
   * that justify it.
   */
  static plantPoint(playerPosition: Vector3, playerVelocity: Vector3): Vector3 {
    const lead = playerVelocity.clone().multiplyScalar(BLAST_LEAD_SECONDS);
    if (lead.length() > MAX_LEAD_DISTANCE) lead.setLength(MAX_LEAD_DISTANCE);
    return playerPosition.clone().add(lead);
  }
}
