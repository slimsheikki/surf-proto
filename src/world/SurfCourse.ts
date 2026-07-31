import { BoxGeometry, Group, Mesh, MeshStandardMaterial, Quaternion, Vector3 } from 'three';
import { degToRad } from '../engine/MathUtils';
import { registerCollider } from './Colliders';
import { buildRampCurve } from './RampCurve';

const PLATFORM_THICKNESS = 0.6;
const IDENTITY = new Quaternion();

export interface CourseStage {
  /** Top-surface center of the rest platform. */
  center: Vector3;
  halfWidth: number;
  halfDepth: number;
}

export interface SurfCourse {
  group: Group;
  spawnPoint: Vector3;
  spawnYawDeg: number;
  /** Rest-platform stages, in course order — used for the fall-out-of-bounds recovery. */
  stages: CourseStage[];
}

function forwardXZ(yawDeg: number): Vector3 {
  const yaw = degToRad(yawDeg);
  return new Vector3(Math.sin(yaw), 0, -Math.cos(yaw));
}

function buildPlatform(
  group: Group,
  topCenter: Vector3,
  width: number,
  depth: number,
  color: number,
): CourseStage {
  const boxCenter = topCenter.clone().addScaledVector(new Vector3(0, 1, 0), -PLATFORM_THICKNESS / 2);
  const halfExtents = new Vector3(width / 2, PLATFORM_THICKNESS / 2, depth / 2);
  registerCollider({ position: boxCenter, quaternion: IDENTITY.clone(), halfExtents });

  const mesh = new Mesh(
    new BoxGeometry(width, PLATFORM_THICKNESS, depth),
    new MeshStandardMaterial({ color, roughness: 0.85 }),
  );
  mesh.position.copy(boxCenter);
  group.add(mesh);

  return { center: topCenter.clone(), halfWidth: width / 2, halfDepth: depth / 2 };
}

/**
 * Lays out the vertical slice's surf course: a handful of small rest
 * platforms ("stages", per real surf-map convention) linked by curved ramp
 * runs. The course is continuous curved ramp surface for the great majority
 * of its length — platforms exist only to give the player a place to stop
 * and reset between runs, not to be a play area in their own right.
 */
export function buildSurfCourse(): SurfCourse {
  const group = new Group();
  const stages: CourseStage[] = [];

  // Stage 0: start platform.
  const platform0Center = new Vector3(0, 0, 0);
  stages.push(buildPlatform(group, platform0Center, 10, 10, 0x53627a));

  // Ramp 1: vertical curve, shallow (45°) rising in steepness to 70° as you
  // descend — the core "surf and gain speed" teaching moment.
  const ramp1Start = platform0Center.clone().add(forwardXZ(0).multiplyScalar(5));
  const ramp1 = buildRampCurve(
    {
      start: ramp1Start,
      startYawDeg: 0,
      startPitchDeg: 45,
      endPitchDeg: 70,
      length: 32,
      width: 7,
      guideWalls: true,
      color: 0x4a7fb5,
    },
    'vertical',
  );
  group.add(ramp1.group);

  // Stage 1 platform at the bottom of ramp 1.
  stages.push(buildPlatform(group, ramp1.endPosition, 8, 8, 0x53627a));

  // Ramp 2: horizontal curve turn at a constant ~50° descent, teaching the
  // player to carry speed through a direction change instead of a hard corner.
  const ramp2Start = ramp1.endPosition
    .clone()
    .add(forwardXZ(ramp1.endYawDeg).multiplyScalar(4));
  const ramp2 = buildRampCurve(
    {
      start: ramp2Start,
      startYawDeg: ramp1.endYawDeg,
      startPitchDeg: 50,
      yawSweepDeg: 80,
      length: 26,
      width: 7,
      guideWalls: true,
      color: 0x4a9f6b,
    },
    'horizontal',
  );
  group.add(ramp2.group);

  // Stage 2 platform at the end of the turn.
  stages.push(buildPlatform(group, ramp2.endPosition, 8, 8, 0x53627a));

  // Ramp 3: ski-jump launch — steep descent (78°) curving up into an upward
  // exit tangent (-25°, i.e. above horizontal) to flick the player airborne.
  const ramp3Start = ramp2.endPosition
    .clone()
    .add(forwardXZ(ramp2.endYawDeg).multiplyScalar(4));
  const ramp3 = buildRampCurve(
    {
      start: ramp3Start,
      startYawDeg: ramp2.endYawDeg,
      startPitchDeg: 78,
      endPitchDeg: -25,
      length: 18,
      width: 7,
      guideWalls: true,
      color: 0xb5824a,
    },
    'vertical',
  );
  group.add(ramp3.group);

  // Landing platform beyond an airborne gap.
  const landingCenter = ramp3.endPosition
    .clone()
    .add(forwardXZ(ramp3.endYawDeg).multiplyScalar(6))
    .add(new Vector3(0, -2, 0));
  stages.push(buildPlatform(group, landingCenter, 10, 10, 0x53627a));

  return {
    group,
    spawnPoint: platform0Center.clone().add(new Vector3(0, 1.2, 0)),
    spawnYawDeg: 0,
    stages,
  };
}
