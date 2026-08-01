import {
  BoxGeometry,
  CylinderGeometry,
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
 * 51.34 deg is what real Momentum Mod / CS surf ramps measure. Reading the face
 * normal in the ramp's own frame (travel, up, cross-travel) it comes out at
 * (0, 0.625, 0.781): zero along travel, and an up component of 0.625 that sits
 * below Source's 0.7 standable cutoff, so the player never grounds on the face
 * and air-strafing stays available for the whole ride. Both of those properties
 * are contract, not taste: a face whose normal leans along travel is a chute the
 * player slides straight down, and a face shallower than acos(0.7) = 45.573 deg
 * is a floor they walk on.
 */
const FACE_ANGLE_DEG = 51.34;
/** Horizontal run per unit of face slope-extent: cos(51.34 deg) = 0.625. */
const FACE_COS = Math.cos(degToRad(FACE_ANGLE_DEG));
/** Vertical rise per unit of face slope-extent: sin(51.34 deg) = 0.781. */
const FACE_SIN = Math.sin(degToRad(FACE_ANGLE_DEG));

/** The 64 hu base plinth under a real ramp face, at 45 hu per game unit. */
const FACE_THICKNESS = 1.4;

/** Number of ramps in the ring. The loop is endless, so there is no "last" one. */
const LOOP_SEGMENT_COUNT = 10;
/** Angular pitch between consecutive ramps — also the yaw the player turns per segment. */
const SEGMENT_ARC_DEG = 360 / LOOP_SEGMENT_COUNT;

/**
 * Mean radius of the ring, and the radial wobble applied to alternate segments.
 *
 * The wobble is load-bearing, not decoration. Even segments sit at
 * `TRACK_RADIUS - TRACK_RADIUS_WOBBLE`, odd at `TRACK_RADIUS +
 * TRACK_RADIUS_WOBBLE`, so consecutive ramps are offset laterally by twice the
 * wobble. A straight ballistic line out of one ramp therefore lands off the side
 * of the next even before the ring's curvature is accounted for, which is what
 * forces the player to air-strafe across every gap instead of coasting.
 */
const TRACK_RADIUS = 90;
const TRACK_RADIUS_WOBBLE = 5;

/**
 * Height of every face centreline. Ramps are level along travel, so a ring of
 * them closes on itself with no net descent — which is the whole reason an
 * endless loop is possible here. Nothing steps down anywhere.
 */
const TRACK_Y = 0;

const RAMP_LENGTH = 44;
/** Slope-extent of a face — its hypotenuse, not its horizontal span. */
const RAMP_FACE_WIDTH = 16;

/** The floating island the ring orbits: scenery, sight-line anchor, and boss perch. */
const ISLAND_RADIUS = 40;
const ISLAND_HEIGHT = 24;
/** Top surface of the island, level with the ring. Nothing exists below it — it floats. */
const ISLAND_TOP_Y = 0;
const ISLAND_RADIAL_SEGMENTS = 24;
/** Boxes in the rim ring that approximates the cylinder's collider. See `buildIsland`. */
const ISLAND_RIM_BOX_COUNT = 12;
/** Wider, thinner disc slung under the rim, so the island reads as floating rock, not a peg. */
const ISLAND_SHELF_RADIUS = 47;
const ISLAND_SHELF_HEIGHT = 5;

const PLATFORM_THICKNESS = 1.4;
/** Platform long axis runs along travel, so the player crosses it lengthways. */
const PLATFORM_DEPTH = 20;
const PLATFORM_WIDTH = 14;
/**
 * Height of the start platform's top surface above the face centreline. The
 * platform sits over the centreline radius, so this is exactly the drop the
 * player takes when they walk off the front of it, less however much of the face
 * has already risen to meet them at `PLATFORM_OUTWARD_OFFSET`.
 */
const PLATFORM_TOP_ABOVE_TRACK = 6;
/**
 * How far outboard of face 0's centreline the start platform sits, measured
 * across travel. At 70% of the face's horizontal half-span the surface under the
 * player has climbed to y = 4.37, so stepping off the front is a 1.6-unit drop
 * onto a point 5.6 slope-units above the centreline, with 13.6 of the face's 16
 * below them. The platform's inner edge lands near the centreline and its outer
 * half hangs past the ring's high edge.
 */
const PLATFORM_OUTWARD_OFFSET = 3.5;

const FACE_ROUGHNESS = 0.85;
const FACE_METALNESS = 0;
/**
 * Greybox palette: one medium grey, nudged a couple of points toward a different
 * hue per segment. Enough to tell at a glance which ramp of the loop a
 * screenshot is from, far too little to read as decoration.
 */
const SEGMENT_FACE_COLORS = [0x8a9299, 0x8f929e, 0x8a9a99, 0x958f96];
const PLATFORM_COLOR = 0x6f7780;
const ISLAND_COLOR = 0x5d646b;
const ISLAND_SHELF_COLOR = 0x4d545a;

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
  /**
   * Which wall of the V — the two must lean toward each other. The loop has a
   * single face per segment rather than a channel, and it is always the wall
   * rising away from the island on the player's left, so this is always `left`;
   * the field is kept for shape compatibility.
   */
  side: 'left' | 'right';
  /** Unit vector along the section's heading. */
  travelDir: Vector3;
  /** Unit horizontal vector across the section's heading (the player's right). */
  crossDir: Vector3;
  /** World-space normal of the surfable face. */
  normal: Vector3;
  /** Index of the ramp in the ring, 0..LOOP_SEGMENT_COUNT-1. */
  segmentIndex: number;
  /** Radius of this ramp's face centreline from the island's axis. */
  radius: number;
}

export interface SurfCourse {
  group: Group;
  spawnPoint: Vector3;
  spawnYawDeg: number;
  /**
   * Rest-platform stages, in course order — used for the fall-out-of-bounds
   * recovery. The loop is endless, so there is exactly one: the start platform.
   * Recovery that wants to drop the player back onto the ring near where they
   * fell should use the `island*`/`track*` fields below instead.
   */
  stages: CourseStage[];
  /**
   * The intended surf line: the centreline point at the leading edge of every
   * ramp in the ring, in loop order. Purely informational — nothing in the game
   * loop needs it — but it makes the course's shape inspectable (headless physics
   * tests fly a bot along it, and it is the natural input for any future
   * ghost/AI or minimap work) without re-deriving the layout from the colliders.
   */
  surfPath: Vector3[];
  /** Every banked face in the course, in build order. See `BankedFace`. */
  faces: BankedFace[];
  /** Axis of the floating island, at the height of its top surface. */
  islandCenter: Vector3;
  islandRadius: number;
  /** Mean radius of the surf ring; individual ramps wobble +/-5 around it. */
  trackRadius: number;
  /** Height of every face centreline — the ring is dead level. */
  trackY: number;
  loopSegmentCount: number;
  /**
   * Half the vertical extent of a face, i.e. how far above `trackY` its high edge
   * sits and how far below its low edge hangs.
   */
  trackFaceHalfHeight: number;
  /**
   * Half the *horizontal* extent of a face: the high edge is this far outside its
   * segment's radius, the low edge this far inside. Together with
   * `trackFaceHalfHeight` this is what a fall-recovery routine needs to put a
   * player back high on a face at an arbitrary angle around the ring.
   */
  trackFaceHalfRun: number;
}

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
 * Outward radial direction at ring angle `thetaDeg`. Reusing the yaw convention
 * for the ring angle keeps one definition of "which way is theta" in the file:
 * `forwardXZ(theta)` points away from the island, and `forwardXZ(theta + 90)` is
 * the tangent the ramp there runs along.
 */
function radialOut(thetaDeg: number): Vector3 {
  return forwardXZ(thetaDeg);
}

/** Heading a ramp at ring angle `thetaDeg` travels along (tangent, theta increasing). */
function travelYawDeg(thetaDeg: number): number {
  return thetaDeg + 90;
}

/**
 * Converts a geometry heading (the `forwardXZ` convention used everywhere in this
 * file) into the yaw the *player* has to hold to face along it.
 *
 * These are not the same number, and the difference is a live inconsistency in
 * the movement code rather than a choice made here. `PlayerController.wishDir`
 * rotates (0, 0, -1) about +Y by `yaw`, giving a forward of
 * (-sin yaw, 0, -cos yaw), and `CameraRig`'s `camera.rotation.set(pitch, yaw, 0,
 * 'YXZ')` looks along exactly the same vector — so what the player sees and what
 * W moves them along agree with each other, and both are the mirror of
 * `forwardXZ(yaw) = (sin yaw, 0, -cos yaw)`. The two conventions coincide only at
 * yaw 0 and 180, which is why the old straight-line course (spawn yaw 0) never
 * tripped over it.
 *
 * Since the spawn yaw is consumed by `PlayerController`, it has to be expressed
 * in the controller's convention: negate the heading. (`Game.travelDirection` and
 * `CameraRig.lookDirFromAngles` still use the flipped form; both are outside this
 * file's remit, and the third-person camera offset being mirrored is a
 * pre-existing bug, not something introduced here.)
 */
function playerYawDegForHeading(headingDeg: number): number {
  return -headingDeg;
}

/**
 * Radius of segment `i`'s face centreline. Even segments pull in, odd push out;
 * with an even segment count the alternation closes cleanly at the seam between
 * segment 9 and segment 0.
 */
function segmentRadius(index: number): number {
  return TRACK_RADIUS + (index % 2 === 0 ? -TRACK_RADIUS_WOBBLE : TRACK_RADIUS_WOBBLE);
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
  // world-space footprint rather than its own 14 x 20. Reporting the local
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
 * The floating island: a plain cylinder whose top surface is level with the ring,
 * with nothing under it.
 *
 * Collision is box-only, so the cylinder cannot be represented exactly. It is
 * approximated by a square prism inscribed in the circle (half-extent
 * `R / sqrt(2)`, so its corners touch the rim) plus a ring of
 * `ISLAND_RIM_BOX_COUNT` radial slabs filling the four circular segments the
 * square leaves uncovered. The rim boxes overshoot the true radius by ~3% at
 * their corners, which is fine here: the island is scenery and a boss perch, the
 * player is never meant to land on it, and both errors are far smaller than the
 * ~45-unit clearance between the island rim and the ring's lowest edge.
 *
 * The shelf disc under the rim is mesh-only — no collider — because it sits
 * entirely below the island and nothing can reach it.
 */
function buildIsland(group: Group): void {
  const body = new Mesh(
    new CylinderGeometry(ISLAND_RADIUS, ISLAND_RADIUS, ISLAND_HEIGHT, ISLAND_RADIAL_SEGMENTS),
    new MeshStandardMaterial({ color: ISLAND_COLOR, roughness: 0.9, metalness: 0 }),
  );
  body.position.set(0, ISLAND_TOP_Y - ISLAND_HEIGHT / 2, 0);
  group.add(body);

  const shelf = new Mesh(
    new CylinderGeometry(
      ISLAND_SHELF_RADIUS,
      ISLAND_SHELF_RADIUS * 0.55,
      ISLAND_SHELF_HEIGHT,
      ISLAND_RADIAL_SEGMENTS,
    ),
    new MeshStandardMaterial({ color: ISLAND_SHELF_COLOR, roughness: 0.95, metalness: 0 }),
  );
  shelf.position.set(0, ISLAND_TOP_Y - ISLAND_HEIGHT + ISLAND_SHELF_HEIGHT / 2, 0);
  group.add(shelf);

  const halfHeight = ISLAND_HEIGHT / 2;
  const centerY = ISLAND_TOP_Y - halfHeight;
  const inscribedHalf = ISLAND_RADIUS / Math.SQRT2;

  registerCollider({
    position: new Vector3(0, centerY, 0),
    quaternion: new Quaternion(),
    halfExtents: new Vector3(inscribedHalf, halfHeight, inscribedHalf),
  });

  // Rim ring: each slab spans one `360 / N` sector, running from just inside the
  // inscribed square's edge out to the true radius.
  const rimInner = inscribedHalf - 1;
  const rimRadialHalf = (ISLAND_RADIUS - rimInner) / 2;
  const rimTangentialHalf = ISLAND_RADIUS * Math.sin(Math.PI / ISLAND_RIM_BOX_COUNT);
  for (let i = 0; i < ISLAND_RIM_BOX_COUNT; i++) {
    const thetaDeg = (360 / ISLAND_RIM_BOX_COUNT) * i;
    const center = radialOut(thetaDeg)
      .multiplyScalar(rimInner + rimRadialHalf)
      .setY(centerY);
    // `yawQuaternion(theta + 90)` puts local +Z along the tangent and local +X
    // along the outward radial, which is the axis the slab's depth runs on.
    registerCollider({
      position: center,
      quaternion: yawQuaternion(thetaDeg + 90),
      halfExtents: new Vector3(rimRadialHalf, halfHeight, rimTangentialHalf),
    });
  }
}

/**
 * One ramp of the ring: a single banked face, level along travel, tangent to the
 * circle at `thetaDeg`.
 *
 * The bank is `+FACE_ANGLE_DEG`, which puts the face's fall line along the
 * player's right. Travelling with theta increasing, the player's right is
 * *inward*, so the low edge is on the island side and the high edge outside:
 * losing height slides the player toward the island, gaining it climbs them
 * away. `guideWalls` is off and there is no retaining wall, so the low edge is
 * open and falling out of the loop is always possible.
 */
function buildLoopSegment(
  group: Group,
  faces: BankedFace[],
  index: number,
): { faceStart: Vector3; faceMid: Vector3 } {
  const thetaDeg = SEGMENT_ARC_DEG * index;
  const yawDeg = travelYawDeg(thetaDeg);
  const radius = segmentRadius(index);
  const forward = forwardXZ(yawDeg);
  const cross = crossXZ(yawDeg);

  // `RampCurve` takes a point on the face's centreline — halfway up the slope —
  // at the leading edge of the piece. The ring's radius is defined on that same
  // centreline, so the face straddles it: `FACE_COS * width / 2` of horizontal
  // span and `FACE_SIN * width / 2` of height to either side.
  const faceMid = radialOut(thetaDeg).multiplyScalar(radius).setY(TRACK_Y);
  const faceStart = faceMid.clone().addScaledVector(forward, -RAMP_LENGTH / 2);

  const firstCollider = getColliders().length;
  const piece = buildRampCurve(
    {
      start: faceStart,
      startYawDeg: yawDeg,
      startPitchDeg: 0,
      rollDeg: FACE_ANGLE_DEG,
      length: RAMP_LENGTH,
      width: RAMP_FACE_WIDTH,
      thickness: FACE_THICKNESS,
      guideWalls: false,
      color: SEGMENT_FACE_COLORS[index % SEGMENT_FACE_COLORS.length],
      roughness: FACE_ROUGHNESS,
      metalness: FACE_METALNESS,
    },
    'straight',
  );
  group.add(piece.group);

  for (const collider of getColliders().slice(firstCollider)) {
    if (collider.isWall) continue;
    faces.push({
      stageIndex: 0,
      sectionIndex: index,
      side: 'left',
      travelDir: forward.clone(),
      crossDir: cross.clone(),
      normal: WORLD_UP.clone().applyQuaternion(collider.quaternion).normalize(),
      segmentIndex: index,
      radius,
    });
  }

  return { faceStart, faceMid };
}

/**
 * Lays out the surf course: an endless ring of ten banked ramps orbiting a
 * floating island.
 *
 * The shape follows from what a surf ramp actually is. A face is level along
 * travel and rolled 51.34 deg about it, so it never accelerates the player
 * forward and never grounds them: gravity pulls them sideways down the face,
 * they air-strafe back up it, and the ride is an oscillation along the wall
 * rather than a slide down a chute. Three consequences drive this layout:
 *
 * 1. Level ramps cannot descend, so a closed ring of them has zero net drop and
 *    the course has no end. There is no stage ladder and no final platform —
 *    segment 9 hands the player back to segment 0.
 * 2. Turning is free. A joint that changes heading costs nothing in speed here,
 *    because the surfaces meeting at it are both level, so the ring can bend a
 *    full `SEGMENT_ARC_DEG` per segment.
 * 3. The ramps deliberately do *not* touch. Each pair is separated by open air,
 *    and two independent things push a ballistic line off the next face: the
 *    ring curves away from the tangent the player leaves on, and the radial
 *    wobble offsets consecutive faces by `2 * TRACK_RADIUS_WOBBLE` sideways. So
 *    every gap has to be air-strafed across; the player is never sliding along
 *    one continuous surface.
 */
export function buildSurfCourse(): SurfCourse {
  const group = new Group();
  const stages: CourseStage[] = [];
  const surfPath: Vector3[] = [];
  const faces: BankedFace[] = [];

  buildIsland(group);

  let firstSegmentStart: Vector3 | null = null;
  for (let index = 0; index < LOOP_SEGMENT_COUNT; index++) {
    const { faceStart } = buildLoopSegment(group, faces, index);
    surfPath.push(faceStart.clone());
    if (index === 0) firstSegmentStart = faceStart.clone();
  }

  // Start platform. It runs along segment 0's heading and is butted up against
  // that ramp's leading edge, sitting in the gap *before* the ring rather than
  // overhanging it from outside: the face's high edge tops out at `FACE_SIN *
  // RAMP_FACE_WIDTH / 2` = 6.25, which is above the platform's 6.0 top, so any
  // overlap of the two footprints would poke ramp up through the platform's
  // walking surface. Sitting in the gap avoids that entirely.
  //
  // Across travel it is pushed `PLATFORM_OUTWARD_OFFSET` outboard, so its inner
  // edge is about level with the face centreline and the rest of it hangs outside
  // the ring's high edge. The player therefore steps off the front onto the
  // *upper* part of face 0, a short drop with almost the whole slope beneath them
  // — the same rule a real surf start follows. Centring it on the face centreline
  // instead would give the full 6-unit drop but land the player mid-face at walk
  // speed, where they slide off the open low edge in about a second and a half.
  const startYaw = travelYawDeg(0);
  const platformTop = firstSegmentStart!
    .clone()
    .addScaledVector(forwardXZ(startYaw), -PLATFORM_DEPTH / 2)
    .addScaledVector(radialOut(0), PLATFORM_OUTWARD_OFFSET)
    .setY(TRACK_Y + PLATFORM_TOP_ABOVE_TRACK);
  stages.push(buildPlatform(group, platformTop, PLATFORM_WIDTH, PLATFORM_DEPTH, startYaw));

  const spawnPoint = platformTop.clone().add(new Vector3(0, 1.2, 0));

  return {
    group,
    spawnPoint,
    spawnYawDeg: playerYawDegForHeading(startYaw),
    stages,
    surfPath,
    faces,
    islandCenter: new Vector3(0, ISLAND_TOP_Y, 0),
    islandRadius: ISLAND_RADIUS,
    trackRadius: TRACK_RADIUS,
    trackY: TRACK_Y,
    loopSegmentCount: LOOP_SEGMENT_COUNT,
    trackFaceHalfHeight: (FACE_SIN * RAMP_FACE_WIDTH) / 2,
    trackFaceHalfRun: (FACE_COS * RAMP_FACE_WIDTH) / 2,
  };
}
