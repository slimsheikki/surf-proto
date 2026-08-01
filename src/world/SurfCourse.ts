import {
  BoxGeometry,
  Group,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  Quaternion,
  Vector3,
} from 'three';
import { degToRad } from '../engine/MathUtils';
import { getColliders, registerCollider } from './Colliders';
import { buildRampCurve } from './RampCurve';

/**
 * Bank of a surfable face, measured from horizontal. This is the *only* angle in
 * the course: every ramp face is pitched dead level along the direction of
 * travel and rolled by this much about that direction.
 *
 * 51.34 deg is what real Momentum Mod / CS surf ramps measure: the face normal
 * comes out at (0, 0.625, 0.781) in the wall's own frame — zero along travel,
 * and an up component of 0.625 that sits below Source's 0.7 standable cutoff, so
 * the player never grounds on the face and air-strafing stays available for the
 * whole ride. Both of those properties are contract, not taste: a face whose
 * normal leans along travel is a chute the player slides straight down, and a
 * face shallower than acos(0.7) = 45.573 deg is a floor they walk on.
 */
const FACE_ANGLE_DEG = 51.34;
/** Horizontal run per unit of face slope-extent: cos(51.34 deg) = 0.625. */
const FACE_COS = Math.cos(degToRad(FACE_ANGLE_DEG));
/** Vertical rise per unit of face slope-extent: sin(51.34 deg) = 0.781. */
const FACE_SIN = Math.sin(degToRad(FACE_ANGLE_DEG));

/** The 64 hu base plinth under a real ramp face, at 45 hu per game unit. */
const FACE_THICKNESS = 1.4;

const PLATFORM_THICKNESS = 1.4;
/** Platform long axis runs along travel, so the player crosses it lengthways. */
const PLATFORM_DEPTH = 18;
const FINAL_PLATFORM_SIZE = 20;
// A pad's width across travel is not a constant: an entry pad spans the channel
// it feeds, so `entryPad()` derives it from that stage's face run and slot width.

const RETAINING_WALL_HEIGHT = 12;
const RETAINING_WALL_THICKNESS = 1.5;

const SECTION_LENGTH = 34;
/**
 * Ramps are level along travel, so a section cannot descend on its own. All net
 * descent in the course comes from stepping the next section's bottom edge down
 * by this much at the joint.
 */
const SECTION_DROP = 8;
const SECTIONS_PER_STAGE = 3;

const FACE_ROUGHNESS = 0.85;
const FACE_METALNESS = 0;
/**
 * Greybox palette: one medium grey, nudged a couple of points toward a different
 * hue per stage. Enough to tell at a glance which stage a screenshot is from,
 * far too little to read as decoration.
 */
const STAGE_FACE_COLORS = [0x8a9299, 0x8a9a99, 0x8f929e, 0x958f96];
const PLATFORM_COLOR = 0x6f7780;
const RETAINING_WALL_COLOR = 0x3a4046;

const WORLD_UP = new Vector3(0, 1, 0);

export interface CourseStage {
  /** Top-surface center of the rest platform. */
  center: Vector3;
  halfWidth: number;
  halfDepth: number;
}

/**
 * One surfable face, recorded so the geometry's defining property is checkable
 * without re-deriving the layout: `normal` is read back off the *registered
 * collider*, not from the numbers that built it, so a probe comparing it against
 * `travelDir`/`crossDir` is testing what the player will actually ride.
 */
export interface BankedFace {
  stageIndex: number;
  sectionIndex: number;
  /** Which wall of the V — the two must lean toward each other. */
  side: 'left' | 'right';
  /** Unit vector along the section's heading. */
  travelDir: Vector3;
  /** Unit horizontal vector across the section's heading (the player's right). */
  crossDir: Vector3;
  /** World-space normal of the surfable face. */
  normal: Vector3;
}

export interface SurfCourse {
  group: Group;
  spawnPoint: Vector3;
  spawnYawDeg: number;
  /** Rest-platform stages, in course order — used for the fall-out-of-bounds recovery. */
  stages: CourseStage[];
  /**
   * The intended surf line: the centreline point at the start of every channel
   * section. Purely informational — nothing in the game loop needs it — but it
   * makes the course's shape inspectable (headless physics tests fly a bot along
   * it, and it is the natural input for any future ghost/AI or minimap work)
   * without re-deriving the layout from the colliders.
   */
  surfPath: Vector3[];
  /** Every banked face in the course, in build order. See `BankedFace`. */
  faces: BankedFace[];
}

/**
 * A run of surf channel: two opposing banked walls forming a V along one
 * heading, level from end to end.
 *
 * `faceWidth` is the face's slope-extent — its hypotenuse, not its horizontal
 * span — so a wall spans `0.625 * faceWidth` horizontally and `0.781 *
 * faceWidth` vertically. `bottomGap` is the width of the open slot between the
 * two low edges; it is open on purpose, so falling out of the channel is
 * possible and the player has to keep working the face.
 */
interface StageSpec {
  faceWidth: number;
  bottomGap: number;
  /** Yaw change applied at each joint *within* the stage (deg, signed). */
  yawStepDeg: number;
}

/**
 * Stage 1 is the tutorial: the same 51.34 deg face, but 20 units of slope-extent
 * instead of 13.66 gives a ~15.6-unit vertical band to oscillate in rather than
 * ~10.7, so a badly timed strafe still leaves face under the player instead of
 * dropping them out of the bottom. Its turns are gentle for the same reason.
 *
 * Stages 2-4 run the canonical face width and alternate turn direction, so the
 * player leads with the other hand each stage instead of learning one arc.
 */
const STAGES: readonly StageSpec[] = [
  { faceWidth: 20, bottomGap: 5, yawStepDeg: 12 },
  { faceWidth: 13.66, bottomGap: 4, yawStepDeg: -16 },
  { faceWidth: 13.66, bottomGap: 4, yawStepDeg: 20 },
  { faceWidth: 13.66, bottomGap: 4, yawStepDeg: -20 },
];

/** Unit vector along the heading `yawDeg` (yaw 0 = -Z, matching the player's spawn look). */
function forwardXZ(yawDeg: number): Vector3 {
  const yaw = degToRad(yawDeg);
  return new Vector3(Math.sin(yaw), 0, -Math.cos(yaw));
}

/** Unit horizontal vector across the heading — the player's right hand. */
function crossXZ(yawDeg: number): Vector3 {
  const yaw = degToRad(yawDeg);
  return new Vector3(Math.cos(yaw), 0, Math.sin(yaw));
}

/**
 * Lateral placement of a pad that a player *enters a channel from*.
 *
 * A pad centred on the channel centreline sits directly over the open slot
 * between the two low edges, so walking straight off it drops the player through
 * the gap without ever touching a face — an instant fall, which is a
 * particularly bad way to open the tutorial stage. Real surf starts put the pad
 * so the player steps off and lands *on a ramp face*.
 *
 * So an entry pad is shifted onto the left face and widened to span from the
 * right-hand low edge across to the left-hand high edge. That keeps its far edge
 * out over the channel, so it still catches a player arriving anywhere across
 * the width, while everything left of the slot is face to step onto.
 */
function entryPad(spec: StageSpec): { width: number; lateralOffset: number; spawnLateral: number } {
  const faceRun = FACE_COS * spec.faceWidth;
  return {
    width: spec.bottomGap + faceRun,
    lateralOffset: -faceRun / 2,
    /**
     * Near the left face's *high* edge, not its middle. The pad's top is level
     * with the high edge, so standing further down the face means falling the
     * height difference before touching anything — from the midpoint that is
     * most of the face, and the player arrives already low with little slope
     * left to work. At 85% out the drop is a couple of units and they land high
     * with the whole face beneath them.
     */
    spawnLateral: -(spec.bottomGap / 2 + faceRun * 0.85),
  };
}

/**
 * Orientation for an un-banked box aligned to a heading: local +X across travel,
 * +Y up, +Z along travel.
 *
 * The `right` axis is `worldUp x forward` (which points along -cross, i.e. the
 * player's left) rather than the cross vector itself, for the same reason
 * `RampCurve.basisFromForward` does it: `makeBasis` feeding
 * `setFromRotationMatrix` requires a proper rotation, and `cross x up` is
 * left-handed. Every box built with it is symmetric in X, so which way the
 * width axis points is immaterial — the handedness is not.
 */
function yawQuaternion(yawDeg: number): Quaternion {
  const forward = forwardXZ(yawDeg);
  const right = new Vector3().crossVectors(WORLD_UP, forward).normalize();
  return new Quaternion().setFromRotationMatrix(new Matrix4().makeBasis(right, WORLD_UP, forward));
}

function buildBox(
  group: Group,
  center: Vector3,
  halfExtents: Vector3,
  quaternion: Quaternion,
  color: number,
  isWall = false,
): void {
  registerCollider({ position: center.clone(), quaternion: quaternion.clone(), halfExtents, isWall });

  const mesh = new Mesh(
    new BoxGeometry(halfExtents.x * 2, halfExtents.y * 2, halfExtents.z * 2),
    new MeshStandardMaterial({ color, roughness: 0.85, metalness: 0 }),
  );
  mesh.position.copy(center);
  mesh.quaternion.copy(quaternion);
  group.add(mesh);
}

/** Platform, given the center of its *top* surface and the heading its long axis follows. */
function buildPlatform(
  group: Group,
  topCenter: Vector3,
  width: number,
  depth: number,
  yawDeg: number,
): CourseStage {
  const center = topCenter.clone().addScaledVector(WORLD_UP, -PLATFORM_THICKNESS / 2);
  const halfExtents = new Vector3(width / 2, PLATFORM_THICKNESS / 2, depth / 2);
  buildBox(group, center, halfExtents, yawQuaternion(yawDeg), PLATFORM_COLOR);

  // `Game.trackLastStage` tests the player against these half-extents on world
  // axes, so a platform turned off-axis reports the half-extents of its
  // world-space footprint rather than its own 14 x 18. Reporting the local
  // values would shrink the checkpoint trigger on every diagonal heading, and a
  // checkpoint the player can stand on without arming is worse than one that
  // arms slightly early.
  const yaw = degToRad(yawDeg);
  const c = Math.abs(Math.cos(yaw));
  const s = Math.abs(Math.sin(yaw));
  return {
    center: topCenter.clone(),
    halfWidth: (width / 2) * c + (depth / 2) * s,
    halfDepth: (width / 2) * s + (depth / 2) * c,
  };
}

/**
 * One wall of a channel section: the banked face plus the retaining wall behind
 * its high edge.
 *
 * `side` is -1 for the wall on the player's left, +1 for the right. The face's
 * low edge sits `bottomGap / 2` out from the centreline at `bottomY` and the
 * face climbs *outward* from there, so the surface leans back over the channel
 * and its normal points up and inward — which is what puts the fall line across
 * the face instead of along it.
 *
 * The roll passed to `buildRampCurve` is `-side * FACE_ANGLE_DEG`: positive roll
 * banks a face so its downhill side faces the player's right, which is the left
 * wall of a channel.
 */
function buildChannelWall(
  group: Group,
  faces: BankedFace[],
  sectionStart: Vector3,
  yawDeg: number,
  spec: StageSpec,
  side: -1 | 1,
  color: number,
  stageIndex: number,
  sectionIndex: number,
): void {
  const forward = forwardXZ(yawDeg);
  const cross = crossXZ(yawDeg);
  const horizontalSpan = FACE_COS * spec.faceWidth;
  const verticalSpan = FACE_SIN * spec.faceWidth;

  // `RampCurve` takes a point on the face's centreline, i.e. halfway up the
  // slope, at the leading edge of the piece.
  const faceStart = sectionStart
    .clone()
    .addScaledVector(cross, side * (spec.bottomGap / 2 + horizontalSpan / 2))
    .addScaledVector(WORLD_UP, verticalSpan / 2);

  const firstCollider = getColliders().length;
  const piece = buildRampCurve(
    {
      start: faceStart,
      startYawDeg: yawDeg,
      startPitchDeg: 0,
      rollDeg: -side * FACE_ANGLE_DEG,
      length: SECTION_LENGTH,
      width: spec.faceWidth,
      thickness: FACE_THICKNESS,
      // A guide rail along a banked face would fence off the low edge, turning
      // the channel into a trough the player cannot fall out of — and the rail
      // itself is a wall the player would grind along at the bottom of every arc.
      guideWalls: false,
      color,
      roughness: FACE_ROUGHNESS,
      metalness: FACE_METALNESS,
    },
    'straight',
  );
  group.add(piece.group);

  for (const collider of getColliders().slice(firstCollider)) {
    if (collider.isWall) continue;
    faces.push({
      stageIndex,
      sectionIndex,
      side: side < 0 ? 'left' : 'right',
      travelDir: forward.clone(),
      crossDir: cross.clone(),
      normal: WORLD_UP.clone().applyQuaternion(collider.quaternion).normalize(),
    });
  }

  // Retaining wall: a plain vertical slab standing on the face's high edge, so
  // the corridor reads as enclosed and an over-strafe hits something instead of
  // flying off into the skybox. No ceiling — the third-person camera rides above
  // the player and would spend the whole run inside it.
  const highEdgeLateral = spec.bottomGap / 2 + horizontalSpan;
  const wallCenter = sectionStart
    .clone()
    .addScaledVector(cross, side * (highEdgeLateral + RETAINING_WALL_THICKNESS / 2))
    .addScaledVector(WORLD_UP, verticalSpan + RETAINING_WALL_HEIGHT / 2)
    .addScaledVector(forward, SECTION_LENGTH / 2);
  buildBox(
    group,
    wallCenter,
    new Vector3(RETAINING_WALL_THICKNESS / 2, RETAINING_WALL_HEIGHT / 2, SECTION_LENGTH / 2),
    yawQuaternion(yawDeg),
    RETAINING_WALL_COLOR,
    true,
  );
}

/**
 * Lays out the surf course: four stages, each three sections of banked channel
 * bookended by platforms, ~112 units of descent in total.
 *
 * The shape follows from what a surf ramp actually is. A face is level along
 * travel and rolled 51.34 deg about it, so it never accelerates the player
 * forward and never grounds them: gravity pulls them sideways down the face,
 * they air-strafe back up it, and the ride is an oscillation along a corridor
 * rather than a slide down a chute. Two consequences drive the layout:
 *
 * 1. Level ramps cannot descend, so every unit of drop is a *step* — 8 units at
 *    each joint inside a stage, plus one face-height at each stage boundary,
 *    where the landing platform sits at the old channel's floor and the new
 *    channel's floor starts a full face below it.
 * 2. Turning is free. A joint that changes heading costs nothing in speed here,
 *    because the surfaces meeting at it are both level — there is no pitched end
 *    cap for the player to slam into, which is what made turns expensive on the
 *    old fall-line course. So the course can turn at every joint.
 *
 * Every platform is returned in `stages`, in course order, so the fall-out plane
 * and the checkpoint respawn both derive from real geometry.
 */
export function buildSurfCourse(): SurfCourse {
  const group = new Group();
  const stages: CourseStage[] = [];
  const surfPath: Vector3[] = [];
  const faces: BankedFace[] = [];

  let yawDeg = 0;
  let bottomY = 0;
  // Centreline point at the entrance of the section about to be built: the
  // middle of the open slot between the two low edges, at the channel's floor.
  let sectionStart = new Vector3(0, bottomY, 0);

  // Stage 1's start platform. Its top sits level with the channel's *high*
  // edges, a face-height above the floor, because that is where a surf start
  // has to be: the player steps off and lands high on a face with the whole
  // slope beneath them to work with.
  const firstPad = entryPad(STAGES[0]);
  const firstPadTop = sectionStart
    .clone()
    .addScaledVector(forwardXZ(yawDeg), -PLATFORM_DEPTH / 2)
    .addScaledVector(crossXZ(yawDeg), firstPad.lateralOffset)
    .setY(bottomY + FACE_SIN * STAGES[0].faceWidth);
  stages.push(
    buildPlatform(group, firstPadTop, firstPad.width, PLATFORM_DEPTH, yawDeg),
  );
  // Stand the player over the left face rather than the pad's centre, so simply
  // holding forward puts them on a ramp instead of into the slot.
  const spawnPoint = firstPadTop
    .clone()
    .addScaledVector(crossXZ(yawDeg), firstPad.spawnLateral - firstPad.lateralOffset)
    .add(new Vector3(0, 1.2, 0));

  for (let stageIndex = 0; stageIndex < STAGES.length; stageIndex++) {
    const spec = STAGES[stageIndex];
    const color = STAGE_FACE_COLORS[stageIndex % STAGE_FACE_COLORS.length];

    if (stageIndex > 0) {
      // The previous stage's landing platform is this stage's start platform, so
      // its top is already fixed: drop the new channel's floor a face-height
      // below it, which is exactly the start-platform rule read backwards.
      bottomY = stages[stages.length - 1].center.y - FACE_SIN * spec.faceWidth;
      sectionStart.setY(bottomY);
    }

    for (let sectionIndex = 0; sectionIndex < SECTIONS_PER_STAGE; sectionIndex++) {
      if (sectionIndex > 0) {
        yawDeg += spec.yawStepDeg;
        bottomY -= SECTION_DROP;
        sectionStart.setY(bottomY);
      }

      surfPath.push(sectionStart.clone());
      for (const side of [-1, 1] as const) {
        buildChannelWall(
          group,
          faces,
          sectionStart,
          yawDeg,
          spec,
          side,
          color,
          stageIndex,
          sectionIndex,
        );
      }

      // Sections butt end-to-end: the next one starts where this one ended.
      sectionStart = sectionStart.addScaledVector(forwardXZ(yawDeg), SECTION_LENGTH);
    }

    // Landing platform, just past the channel's end and level with its floor —
    // where a real surf map puts its landing pad, so the player arrives on it
    // rather than into its side. Doubles as the next stage's start platform.
    const isFinal = stageIndex === STAGES.length - 1;
    const depth = isFinal ? FINAL_PLATFORM_SIZE : PLATFORM_DEPTH;
    // A non-final landing pad is also the next stage's entry pad, so it takes the
    // entry offset for the channel it feeds. The final pad feeds nothing, so it
    // stays centred and square.
    const nextPad = isFinal ? null : entryPad(STAGES[stageIndex + 1]);
    const width = nextPad ? nextPad.width : FINAL_PLATFORM_SIZE;
    const padTop = sectionStart.clone().addScaledVector(forwardXZ(yawDeg), depth / 2);
    if (nextPad) padTop.addScaledVector(crossXZ(yawDeg), nextPad.lateralOffset);
    stages.push(buildPlatform(group, padTop, width, depth, yawDeg));
    sectionStart = sectionStart.addScaledVector(forwardXZ(yawDeg), depth);
  }

  return {
    group,
    spawnPoint,
    spawnYawDeg: 0,
    stages,
    surfPath,
    faces,
  };
}
