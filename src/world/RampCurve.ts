import {
  BoxGeometry,
  Group,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  Quaternion,
  Vector3,
} from 'three';
import { degToRad, lerp } from '../engine/MathUtils';
import { registerCollider } from './Colliders';

export type RampCurveMode = 'straight' | 'vertical' | 'horizontal';

export interface RampCurveParams {
  /** Path position at the start of the curve (top surface, not box center). */
  start: Vector3;
  startYawDeg: number;
  /** Slope angle in degrees; positive = descending along the direction of travel. */
  startPitchDeg: number;
  /** Only used in 'vertical' mode: slope angle at the end of the curve. */
  endPitchDeg?: number;
  /** Only used in 'horizontal' mode: total yaw change swept across the curve. */
  yawSweepDeg?: number;
  /**
   * Bank of the surfable face about the direction of travel, in degrees.
   *
   * This is what makes a piece a *surf ramp* rather than a chute. At 0 the face
   * is a floor and the player walks on it; at 90 it is a vertical wall. In
   * between — real surf ramps live around 45-70 — the face is an inclined wall
   * whose fall line runs sideways, across the face, while the direction of
   * travel runs along the ramp's length. The player slides down the face and
   * air-strafes back up it, tracing an arc along the wall, which is the actual
   * shape of surf movement.
   *
   * Sign picks which way the face leans: positive banks the surface so its
   * downhill side is toward -right, negative toward +right. Two opposing pieces
   * with equal and opposite roll form a channel the player can zig-zag along.
   */
  rollDeg?: number;
  /** Sweeps the bank across the piece (defaults to `rollDeg`, i.e. constant). */
  endRollDeg?: number;
  /** Approximate arc length of the whole curve. */
  length: number;
  width: number;
  /**
   * Width at the far end of the piece. Defaults to `width` (constant). A taper
   * is what makes a trapezoid or pyramid ramp: the surface stays centred on the
   * path and both edges move. Realised as stepped segments, like everything
   * else here — the collision engine is oriented boxes, so a smoothly tapered
   * face would be a mesh the sweep could not test.
   */
  endWidth?: number;
  thickness?: number;
  /** Degrees of arc per segment — 2-5 deg matches real surf-map construction for a smooth feel. */
  angleStepDeg?: number;
  color?: number;
  /** Surface material roughness; defaults to the original ramp look. */
  roughness?: number;
  /** Surface material metalness; defaults to the original ramp look. */
  metalness?: number;
  guideWalls?: boolean;
  /**
   * Whether the segments register collision boxes. Defaults to true, which is
   * what every level piece wants.
   *
   * The map editor sets it false: it rebuilds a piece's meshes on every nudge of
   * a drag, and `registerCollider` caches an inverse quaternion per box with no
   * way to retire one, so an editing session would otherwise pile up thousands
   * of stale colliders. The world is rebuilt from scratch — colliders and all —
   * when the editor hands a map over to be played.
   */
  registerColliders?: boolean;
}

export interface RampCurveResult {
  group: Group;
  /** Path position at the end of the curve (top surface), for chaining the next piece. */
  endPosition: Vector3;
  endYawDeg: number;
  endPitchDeg: number;
}

const DEFAULT_THICKNESS = 0.4;
const DEFAULT_ANGLE_STEP = 4;
const GUIDE_WALL_HEIGHT = 1.4;
const GUIDE_WALL_THICKNESS = 0.3;

const WORLD_UP = new Vector3(0, 1, 0);

/**
 * Unit direction of travel for a heading/slope pair, in the same yaw convention
 * `SurfCourse.forwardXZ` uses (yaw 0 = -Z) with positive pitch descending.
 *
 * Exported because anything that positions a ramp by its *centre* rather than by
 * its leading edge — the map editor does, since a centre is what a user drags —
 * has to step back along exactly this vector to recover the `start` this module
 * takes.
 */
export function forwardFromAngles(yawDeg: number, pitchDeg: number): Vector3 {
  const yaw = degToRad(yawDeg);
  const pitch = degToRad(pitchDeg);
  return new Vector3(
    Math.sin(yaw) * Math.cos(pitch),
    -Math.sin(pitch),
    -Math.cos(yaw) * Math.cos(pitch),
  ).normalize();
}

/**
 * Builds the (right, normal, forward) orthonormal basis for a slope segment,
 * matching the box geometry's local axes: local +X = width, +Y = surface
 * normal, +Z = forward/down-slope.
 *
 * The handedness here is load-bearing. `Matrix4.makeBasis(right, normal,
 * forward)` is fed straight into `Quaternion.setFromRotationMatrix()`, which
 * assumes a *proper* rotation (determinant +1). A left-handed triple gives
 * determinant -1 and the quaternion extraction silently returns garbage — for a
 * 45 deg slope it produces (0, 0, 0, 0.707), a non-unit scaled identity, so
 * every collider and mesh ends up axis-aligned and every raycast reports a
 * flat-ground normal of (0, 1, 0). So: `right` cross `normal` must equal
 * `+forward`, which means `right = worldUp x forward` (NOT `forward x worldUp`).
 */
function basisFromForward(
  forward: Vector3,
  yawDeg: number,
  rollDeg = 0,
): { right: Vector3; normal: Vector3 } {
  const right = new Vector3().crossVectors(WORLD_UP, forward);
  if (right.lengthSq() < 1e-12) {
    // Degenerate case: `forward` is (near) vertical, so worldUp x forward
    // collapses to a zero vector and normalizing it would yield NaN. Substitute
    // the closed-form value of the same expression with the cos(pitch) scale
    // factor divided out; it stays finite at pitch = +/-90 deg and keeps the
    // width axis yaw-continuous with the neighbouring segments.
    const yaw = degToRad(yawDeg);
    right.set(-Math.cos(yaw), 0, -Math.sin(yaw));
  }
  right.normalize();
  const normal = new Vector3().crossVectors(forward, right).normalize();

  if (rollDeg !== 0) {
    // Bank the face about the travel axis. Rotating both axes by the same
    // rotation about `forward` keeps the triple right-handed (R(a) x R(b) =
    // R(a x b) = R(forward) = forward), so the quaternion stays proper.
    const roll = degToRad(rollDeg);
    right.applyAxisAngle(forward, roll);
    normal.applyAxisAngle(forward, roll);
  }
  return { right, normal };
}

/** One segment of a ramp path: enough to place a box, or to chain a socket. */
export interface RampFrame {
  /** Path point (centreline) at the segment's leading edge. */
  start: Vector3;
  /** Path point at the segment's middle — where the box is centred. */
  mid: Vector3;
  forward: Vector3;
  right: Vector3;
  normal: Vector3;
  width: number;
  length: number;
}

export interface RampPath {
  frames: RampFrame[];
  /** Path point past the last segment, for chaining the next piece. */
  end: Vector3;
  endYawDeg: number;
  endPitchDeg: number;
}

/**
 * Pure geometry walk shared by the mesh builder below and by anything that
 * needs the path without the meshes — the editor's socket snapping and its
 * spline generator both do. Splitting this out is what keeps a piece's sockets
 * and its collision from ever disagreeing: both are derived from the same
 * frames, sampled the same way.
 */
export function computeRampFrames(params: RampCurveParams, mode: RampCurveMode): RampPath {
  const angleStepDeg = params.angleStepDeg ?? DEFAULT_ANGLE_STEP;
  const startRoll = params.rollDeg ?? 0;
  const endRoll = params.endRollDeg ?? startRoll;
  const endWidth = params.endWidth ?? params.width;

  const totalAngleChange = Math.max(
    mode === 'vertical'
      ? Math.abs((params.endPitchDeg ?? params.startPitchDeg) - params.startPitchDeg)
      : mode === 'horizontal'
        ? Math.abs(params.yawSweepDeg ?? 0)
        : 0,
    // A banked piece that also twists needs segments for the roll sweep alone.
    Math.abs(endRoll - startRoll),
  );
  const segmentCount = Math.max(
    1,
    Math.round(totalAngleChange / angleStepDeg) || 1,
    // A taper needs steps of its own or it degenerates to one average-width
    // box. Two units of width change per segment keeps the side steps small.
    Math.ceil(Math.abs(endWidth - params.width) / 2),
  );
  const segmentLength = params.length / segmentCount;

  const frames: RampFrame[] = [];
  let curPos = params.start.clone();
  let curYaw = params.startYawDeg;
  let curPitch = params.startPitchDeg;

  for (let i = 0; i < segmentCount; i++) {
    const midT = (i + 0.5) / segmentCount;
    const segYaw =
      mode === 'horizontal' ? params.startYawDeg + (params.yawSweepDeg ?? 0) * midT : curYaw;
    const segPitch =
      mode === 'vertical' ? lerp(params.startPitchDeg, params.endPitchDeg ?? params.startPitchDeg, midT) : curPitch;

    // Roll is sampled at the segment midpoint, exactly like pitch and yaw, so a
    // banked piece that also twists hands each segment the bank its own centre
    // sits at — the segments then meet with only half a step of bank mismatch at
    // each seam instead of a full one.
    const segRoll = lerp(startRoll, endRoll, midT);

    const forward = forwardFromAngles(segYaw, segPitch);
    const { right, normal } = basisFromForward(forward, segYaw, segRoll);

    frames.push({
      start: curPos.clone(),
      mid: curPos.clone().addScaledVector(forward, segmentLength / 2),
      forward,
      right,
      normal,
      width: lerp(params.width, endWidth, midT),
      length: segmentLength,
    });

    curPos = curPos.addScaledVector(forward, segmentLength);
    curYaw = segYaw;
    curPitch = segPitch;
  }

  return { frames, end: curPos, endYawDeg: curYaw, endPitchDeg: curPitch };
}

/**
 * Builds one curved (or straight) ramp segment-chain, mirroring real surf-map
 * construction: a sequence of short flat wedge segments, each rotated a few
 * degrees from the last, with edges kept exactly coincident so there's no
 * seam that would kick the player's velocity unpredictably.
 */
export function buildRampCurve(
  params: RampCurveParams,
  mode: RampCurveMode,
): RampCurveResult {
  const thickness = params.thickness ?? DEFAULT_THICKNESS;
  const color = params.color ?? 0x4a7fb5;
  const withColliders = params.registerColliders ?? true;

  const group = new Group();
  const material = new MeshStandardMaterial({
    color,
    roughness: params.roughness ?? 0.75,
    metalness: params.metalness ?? 0.05,
  });
  const wallMaterial = new MeshStandardMaterial({ color: 0x2a3542, roughness: 0.9 });

  const path = computeRampFrames(params, mode);

  for (const frame of path.frames) {
    const { forward, right, normal } = frame;
    const boxCenter = frame.mid.clone().addScaledVector(normal, -thickness / 2);

    const basisMatrix = new Matrix4().makeBasis(right, normal, forward);
    const quaternion = new Quaternion().setFromRotationMatrix(basisMatrix);
    const halfExtents = new Vector3(frame.width / 2, thickness / 2, frame.length / 2);

    if (withColliders) registerCollider({ position: boxCenter, quaternion, halfExtents });

    const geometry = new BoxGeometry(frame.width, thickness, frame.length);
    const mesh = new Mesh(geometry, material);
    mesh.position.copy(boxCenter);
    mesh.quaternion.copy(quaternion);
    group.add(mesh);

    if (params.guideWalls) {
      for (const side of [-1, 1]) {
        const wallCenter = boxCenter
          .clone()
          .addScaledVector(right, side * (frame.width / 2 + GUIDE_WALL_THICKNESS / 2))
          .addScaledVector(normal, GUIDE_WALL_HEIGHT / 2 - thickness / 2);
        const wallHalfExtents = new Vector3(
          GUIDE_WALL_THICKNESS / 2,
          GUIDE_WALL_HEIGHT / 2,
          frame.length / 2,
        );
        if (withColliders) {
          registerCollider({
            position: wallCenter,
            quaternion,
            halfExtents: wallHalfExtents,
            isWall: true,
          });
        }
        const wallGeometry = new BoxGeometry(
          GUIDE_WALL_THICKNESS,
          GUIDE_WALL_HEIGHT,
          frame.length,
        );
        const wallMesh = new Mesh(wallGeometry, wallMaterial);
        wallMesh.position.copy(wallCenter);
        wallMesh.quaternion.copy(quaternion);
        group.add(wallMesh);
      }
    }
  }

  return { group, endPosition: path.end, endYawDeg: path.endYawDeg, endPitchDeg: path.endPitchDeg };
}
