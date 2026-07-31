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
  /** Approximate arc length of the whole curve. */
  length: number;
  width: number;
  thickness?: number;
  /** Degrees of arc per segment — 2-5 deg matches real surf-map construction for a smooth feel. */
  angleStepDeg?: number;
  color?: number;
  guideWalls?: boolean;
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

function forwardFromAngles(yawDeg: number, pitchDeg: number): Vector3 {
  const yaw = degToRad(yawDeg);
  const pitch = degToRad(pitchDeg);
  return new Vector3(
    Math.sin(yaw) * Math.cos(pitch),
    -Math.sin(pitch),
    -Math.cos(yaw) * Math.cos(pitch),
  ).normalize();
}

/** Builds the (right, normal, forward) orthonormal basis for a slope segment. */
function basisFromForward(forward: Vector3): { right: Vector3; normal: Vector3 } {
  const worldUp = new Vector3(0, 1, 0);
  const right = new Vector3().crossVectors(forward, worldUp).normalize();
  const normal = new Vector3().crossVectors(right, forward).normalize();
  return { right, normal };
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
  const angleStepDeg = params.angleStepDeg ?? DEFAULT_ANGLE_STEP;
  const color = params.color ?? 0x4a7fb5;

  const totalAngleChange =
    mode === 'vertical'
      ? Math.abs((params.endPitchDeg ?? params.startPitchDeg) - params.startPitchDeg)
      : mode === 'horizontal'
        ? Math.abs(params.yawSweepDeg ?? 0)
        : 0;
  const segmentCount = Math.max(1, Math.round(totalAngleChange / angleStepDeg) || 1);
  const segmentLength = params.length / segmentCount;

  const group = new Group();
  const material = new MeshStandardMaterial({ color, roughness: 0.75, metalness: 0.05 });
  const wallMaterial = new MeshStandardMaterial({ color: 0x2a3542, roughness: 0.9 });

  let curPos = params.start.clone();
  let curYaw = params.startYawDeg;
  let curPitch = params.startPitchDeg;

  for (let i = 0; i < segmentCount; i++) {
    const midT = (i + 0.5) / segmentCount;
    const segYaw =
      mode === 'horizontal' ? params.startYawDeg + (params.yawSweepDeg ?? 0) * midT : curYaw;
    const segPitch =
      mode === 'vertical' ? lerp(params.startPitchDeg, params.endPitchDeg ?? params.startPitchDeg, midT) : curPitch;

    const forward = forwardFromAngles(segYaw, segPitch);
    const { right, normal } = basisFromForward(forward);

    const pathMid = curPos.clone().addScaledVector(forward, segmentLength / 2);
    const boxCenter = pathMid.clone().addScaledVector(normal, -thickness / 2);

    const basisMatrix = new Matrix4().makeBasis(right, normal, forward);
    const quaternion = new Quaternion().setFromRotationMatrix(basisMatrix);
    const halfExtents = new Vector3(params.width / 2, thickness / 2, segmentLength / 2);

    registerCollider({ position: boxCenter, quaternion, halfExtents });

    const geometry = new BoxGeometry(params.width, thickness, segmentLength);
    const mesh = new Mesh(geometry, material);
    mesh.position.copy(boxCenter);
    mesh.quaternion.copy(quaternion);
    group.add(mesh);

    if (params.guideWalls) {
      for (const side of [-1, 1]) {
        const wallCenter = boxCenter
          .clone()
          .addScaledVector(right, side * (params.width / 2 + GUIDE_WALL_THICKNESS / 2))
          .addScaledVector(normal, GUIDE_WALL_HEIGHT / 2 - thickness / 2);
        const wallHalfExtents = new Vector3(
          GUIDE_WALL_THICKNESS / 2,
          GUIDE_WALL_HEIGHT / 2,
          segmentLength / 2,
        );
        registerCollider({
          position: wallCenter,
          quaternion,
          halfExtents: wallHalfExtents,
          isWall: true,
        });
        const wallGeometry = new BoxGeometry(
          GUIDE_WALL_THICKNESS,
          GUIDE_WALL_HEIGHT,
          segmentLength,
        );
        const wallMesh = new Mesh(wallGeometry, wallMaterial);
        wallMesh.position.copy(wallCenter);
        wallMesh.quaternion.copy(quaternion);
        group.add(wallMesh);
      }
    }

    curPos = curPos.addScaledVector(forward, segmentLength);
    curYaw = segYaw;
    curPitch = segPitch;
  }

  return { group, endPosition: curPos, endYawDeg: curYaw, endPitchDeg: curPitch };
}
