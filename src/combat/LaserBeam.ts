import { CylinderGeometry, Group, Mesh, MeshBasicMaterial, Quaternion, Vector3 } from 'three';

/**
 * One unit cylinder, shared by every beam ever built: radius 1, height 1, axis
 * along +Y, open-ended (no caps, so a beam pointing at the camera doesn't show
 * a flat disc). A beam is this mesh re-scaled and re-oriented per tick — the
 * aim point moves at 128 Hz, and rebuilding a CylinderGeometry that often is
 * exactly the kind of allocation that leaked GPU buffers here before.
 */
const UNIT_CYLINDER = new CylinderGeometry(1, 1, 1, 14, 1, true);
const CYLINDER_AXIS = new Vector3(0, 1, 0);

const segment = new Vector3();
const midpoint = new Vector3();
const orientation = new Quaternion();
const toPoint = new Vector3();

/**
 * Perpendicular distance from `point` to the segment `a`-`b`, clamped to the
 * segment's ends. The beam is a finite segment from the boss to its aim point,
 * so a player *beyond* the aim point must be safe — using an infinite-ray
 * distance instead would let a beam aimed short of the player still hit them.
 */
export function pointSegmentDistance(point: Vector3, a: Vector3, b: Vector3): number {
  segment.copy(b).sub(a);
  const lengthSq = segment.lengthSq();
  if (lengthSq < 1e-9) return point.distanceTo(a);
  toPoint.copy(point).sub(a);
  const t = Math.min(1, Math.max(0, toPoint.dot(segment) / lengthSq));
  return toPoint.sub(segment.multiplyScalar(t)).length();
}

/**
 * Rotates `current` toward `desired` by at most `maxAngle` radians, in place.
 *
 * Deliberately a true axis-angle rotation rather than the cheaper
 * lerp-and-normalise: the beam's aim direction can legitimately end up near
 * antiparallel to the player (the player circles the whole island), and a
 * chord lerp collapses to a zero vector at 180°, which would silently park the
 * beam. Both vectors must be unit length.
 */
export function rotateToward(current: Vector3, desired: Vector3, maxAngle: number): Vector3 {
  const dot = Math.min(1, Math.max(-1, current.dot(desired)));
  const angle = Math.acos(dot);
  if (angle <= maxAngle || angle < 1e-6) return current.copy(desired);

  const axis = segment.copy(current).cross(desired);
  if (axis.lengthSq() < 1e-9) {
    // Exactly antiparallel: any perpendicular axis is a valid way round.
    axis.set(current.z, current.x, current.y).cross(current);
    if (axis.lengthSq() < 1e-9) axis.set(1, 0, 0);
  }
  return current.applyAxisAngle(axis.normalize(), maxAngle).normalize();
}

/**
 * The boss's beam, drawn as two coaxial cylinders: a bright thin core that
 * reads as the laser itself, and a translucent shell drawn at the beam's *real
 * damage radius*.
 *
 * The shell exists because the damage volume is 2.5 units across while a beam
 * that looks like a laser is a few tenths of a unit — without it the player
 * takes damage from apparently empty air and the attack reads as unfair. The
 * shell is the hitbox, made visible.
 *
 * Unlit (`MeshBasicMaterial`) rather than an emissive standard material: a beam
 * should be at full brightness regardless of where the sun is, which is what
 * "unlit" means, and it skips the lighting cost of a mesh that covers a lot of
 * screen.
 */
export class LaserBeam {
  readonly group = new Group();

  private readonly coreMaterial: MeshBasicMaterial;
  private readonly shellMaterial: MeshBasicMaterial;
  private readonly core: Mesh;
  private readonly shell: Mesh;

  constructor() {
    this.coreMaterial = new MeshBasicMaterial({ color: 0xffe9f2, transparent: true, opacity: 1 });
    this.shellMaterial = new MeshBasicMaterial({
      color: 0xff2f6a,
      transparent: true,
      opacity: 0.16,
      // A translucent hull the player can be *inside*; writing depth would make
      // it occlude the world seen through it and z-fight with the core.
      depthWrite: false,
    });
    this.core = new Mesh(UNIT_CYLINDER, this.coreMaterial);
    this.shell = new Mesh(UNIT_CYLINDER, this.shellMaterial);
    this.group.add(this.core, this.shell);
    this.group.visible = false;
  }

  /**
   * Points the beam from `from` to `to`. `coreRadius` grows the visible laser
   * (thin while telegraphing, thick when live); `shellRadius` should be the
   * damage radius currently in effect, or 0 to hide the shell entirely.
   */
  aim(
    from: Vector3,
    to: Vector3,
    coreRadius: number,
    shellRadius: number,
    coreOpacity: number,
  ): void {
    segment.copy(to).sub(from);
    const length = segment.length();
    if (length < 1e-4) {
      this.group.visible = false;
      return;
    }
    midpoint.copy(from).addScaledVector(segment, 0.5);
    orientation.setFromUnitVectors(CYLINDER_AXIS, segment.divideScalar(length));

    for (const mesh of [this.core, this.shell]) {
      mesh.position.copy(midpoint);
      mesh.quaternion.copy(orientation);
    }
    this.core.scale.set(coreRadius, length, coreRadius);
    this.shell.scale.set(shellRadius, length, shellRadius);
    this.shell.visible = shellRadius > 0;
    this.coreMaterial.opacity = coreOpacity;
    this.group.visible = true;
  }

  hide(): void {
    this.group.visible = false;
  }

  /** Frees the two per-beam materials. The unit cylinder is shared and stays. */
  dispose(): void {
    this.coreMaterial.dispose();
    this.shellMaterial.dispose();
  }
}
