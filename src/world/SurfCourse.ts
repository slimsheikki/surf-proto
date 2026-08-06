import { BoxGeometry, CylinderGeometry, Group, Matrix4, Mesh, Quaternion, Vector3 } from 'three';
import { degToRad } from '../engine/MathUtils';
import { getColliders, registerCollider } from './Colliders';
import { buildRampCurve } from './RampCurve';
import { envMaterial } from '../render/NprMaterials';

/**
 * Bank of a surfable face, measured from horizontal. This is the *only* angle in
 * the ring: every ramp in the loop is pitched dead level along the direction of
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
 *
 * The one deliberate exception is the approach descent ramp, which is banked by
 * exactly this much *and* pitched along travel (see
 * `APPROACH_DESCENT_PITCH_DEG`). Its normal still reads (0, 0.625, 0.781) in its
 * own — pitched — frame; measured against world up it reads
 * cos(51.34) * cos(22) = 0.580, i.e. even further from standable. Trading a
 * little of the up component for forward drop is the whole point of that piece.
 */
export const FACE_ANGLE_DEG = 51.34;
/** Horizontal run per unit of face slope-extent: cos(51.34 deg) = 0.625. */
export const FACE_COS = Math.cos(degToRad(FACE_ANGLE_DEG));
/** Vertical rise per unit of face slope-extent: sin(51.34 deg) = 0.781. */
export const FACE_SIN = Math.sin(degToRad(FACE_ANGLE_DEG));

/** The 64 hu base plinth under a real ramp face, at 45 hu per game unit. */
export const FACE_THICKNESS = 1.4;

/** Number of ramps in the ring. The loop is endless, so there is no "last" one. */
const LOOP_SEGMENT_COUNT = 10;
/** Angular pitch between consecutive ramps — also the yaw the player turns per segment. */
const SEGMENT_ARC_DEG = 360 / LOOP_SEGMENT_COUNT;

/**
 * Mean radius of the ring, and the radial wobble applied to alternate segments.
 *
 * The wobble is load-bearing, not decoration. Even segments sit at
 * `TRACK_RADIUS + TRACK_RADIUS_WOBBLE`, odd at `TRACK_RADIUS -
 * TRACK_RADIUS_WOBBLE`, so consecutive ramps are offset laterally by twice the
 * wobble. A straight ballistic line out of one ramp therefore lands off the side
 * of the next even before the ring's curvature is accounted for, which is what
 * forces the player to air-strafe across every gap instead of coasting.
 *
 * It is deliberately small. At the old +/-5 the 10-unit step between consecutive
 * faces cost more lateral correction than the airtime allowed, so every
 * transition landed the player low on the next face with less height left to
 * trade back for speed — the momentum bleed the playtest reported. +/-3 keeps a
 * ballistic line clearly off the next face (a 6-unit miss against a face whose
 * horizontal half-span is `FACE_COS * RAMP_FACE_WIDTH / 2` = 5.6) while leaving
 * the correction inside what one gap's worth of air-strafing can supply.
 */
const TRACK_RADIUS = 90;
const TRACK_RADIUS_WOBBLE = 3;

/**
 * Height of every face centreline. Ramps are level along travel, so a ring of
 * them closes on itself with no net descent — which is the whole reason an
 * endless loop is possible here. Nothing steps down anywhere.
 */
const TRACK_Y = 0;

export const RAMP_LENGTH = 50;
/**
 * Slope-extent of a face — its hypotenuse, not its horizontal span. 18 gives a
 * +/-7.03 vertical band around the centreline, which is the height a player who
 * lands low on a face has left to trade back for speed. This and `RAMP_LENGTH`
 * were both raised (16 -> 18, 44 -> 50) against the same playtest note: more
 * ramp and more recoverable band per gap crossed.
 */
export const RAMP_FACE_WIDTH = 18;

/**
 * Arc allotted to one segment of the ring, and the open air left over once a
 * `RAMP_LENGTH` ramp has been laid along it.
 *
 * The gap is *derived*, never authored: the ring must close on itself, so the
 * ten (ramp + gap) pairs are pinned to the circumference at `TRACK_RADIUS` and
 * the only free choice is how much of each arc the ramp itself eats. At
 * `RAMP_LENGTH` 50 that leaves `RAMP_ARC_GAP` = 6.55 of arc, roughly half the
 * 12.55 the 44-unit ramps left.
 *
 * Shrinking it is the direct fix for "hard to keep the momentum of surfing":
 * airtime between ramps is dead time in which the player only falls, and every
 * unit fallen is height they land lower on the next face with. What the gap must
 * *not* do is close — an air-strafe between ramps is the point of the layout, so
 * `RAMP_LENGTH` must stay strictly under `SEGMENT_ARC_LENGTH`. Note the real
 * free-flight distance is longer than this arc figure (~8.3 units at the current
 * numbers), because the ramps are straight chords laid on the arc and the wobble
 * offsets consecutive ones sideways.
 */
const SEGMENT_ARC_LENGTH = (2 * Math.PI * TRACK_RADIUS) / LOOP_SEGMENT_COUNT;
const RAMP_ARC_GAP = SEGMENT_ARC_LENGTH - RAMP_LENGTH;

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

export const PLATFORM_THICKNESS = 1.4;
/** Platform long axis runs along travel, so the player crosses it lengthways. */
export const PLATFORM_DEPTH = 20;
export const PLATFORM_WIDTH = 14;
/**
 * Height of a start platform's top surface above the centreline of the face it
 * hands the player onto.
 *
 * This is not decoration either: the platform sits `PLATFORM_OUTWARD_OFFSET`
 * toward the face's high side, where the face has already climbed
 * `PLATFORM_OUTWARD_OFFSET * FACE_SIN / FACE_COS` = 4.37 above its centreline,
 * so the top has to clear that or the ramp pokes up through the walking surface
 * and the player steps into a wall instead of onto a slope. 6 leaves a 1.6-unit
 * drop onto a point 5.6 slope-units above the centreline.
 */
export const PLATFORM_TOP_ABOVE_FACE = 6;
/**
 * How far outboard of a face's centreline a start platform sits, measured across
 * travel (toward the face's high edge). At 70% of the face's horizontal half-span
 * the player steps off onto the *upper* part of the face with almost the whole
 * slope beneath them — the same rule a real surf start follows. Centring it on
 * the centreline instead would give a bigger drop but land the player mid-face at
 * walk speed, where they slide off the open low edge in about a second and a half.
 */
export const PLATFORM_OUTWARD_OFFSET = 3.5;

/**
 * The approach run: an elevated platform outside the ring, a banked ramp that
 * descends to track level, and a level banked straight that feeds segment 0.
 *
 * The ring is dead level, so nothing in it can *give* the player speed — a lap
 * only preserves what they arrive with. The approach is where the speed comes
 * from: `START_PLATFORM_TOP_Y` of altitude, surfed off on a face that is banked
 * like every other face but also pitched `APPROACH_DESCENT_PITCH_DEG` along
 * travel, so gravity has a forward component to pour into the player instead of
 * a purely sideways one.
 *
 * The descent's length is not authored, it is solved: the face centreline has to
 * fall from `APPROACH_DESCENT_START_Y` to exactly `TRACK_Y` at
 * `APPROACH_DESCENT_PITCH_DEG`, so the length is that drop over sin(pitch). The
 * centreline starts `PLATFORM_TOP_ABOVE_FACE` below the platform top for the
 * reason that constant documents, which means the *ramp* descends 49 while the
 * *player* descends the full 55 from the platform surface to track level. (Total
 * drop is what pays for the speed, so nothing is lost by the ramp being 131 long
 * rather than the 147 a full-55 centreline drop would need.)
 */
const START_PLATFORM_TOP_Y = 55;
export const APPROACH_DESCENT_PITCH_DEG = 26;
const APPROACH_DESCENT_START_Y = START_PLATFORM_TOP_Y - PLATFORM_TOP_ABOVE_FACE;

/**
 * The descent is a *staircase* of faces, not one long ramp, and the reason is a
 * hard limit rather than a stylistic choice.
 *
 * A banked face pulls the player across itself at a rate set by the bank, so they
 * cross its width and leave over the low edge after a fixed time — about 1.5 s
 * with no correction, and not much more than 3 s with good air-strafing. The
 * distance that buys is the entry speed times that time, and the descent is
 * entered at a walk. Measured against this geometry, one face carries a player
 * **45-55 units of run and no further, at any pitch**: raising the pitch shortens
 * the run needed but does not lengthen the ride, so the two only meet if the face
 * asks for less than ~45. The single 121-unit descent this replaces asked for
 * 121, and every input in a swept grid of strafe directions and mouse rates fell
 * off it around 50 — the drop-in was simply not completable.
 *
 * Widening the face is not the way out either. A face's high edge stands
 * `FACE_SIN * width / 2` above its centreline, so a wider face pokes up through
 * the start platform (see `PLATFORM_TOP_ABOVE_FACE`); measured at width 36 the
 * player never got off the pad at all, peaking at walking speed.
 *
 * So the altitude is spent across `APPROACH_DESCENT_FACE_COUNT` faces, each short
 * enough to be ridden in one pass, with the bank **alternating** between them.
 * Alternating is what makes the chain work: a face's high edge sits
 * `FACE_SIN * width / 2` above its centreline on the side its bank leans away
 * from, so mirroring the next face puts its high edge exactly where the previous
 * face's low edge dropped the player. They land high on the new face with the
 * whole slope beneath them again, which is the same handoff the start platform
 * gives — and it is how real surf maps stage a long descent, as a zig-zag between
 * opposing walls rather than one endless slide.
 */
const APPROACH_DESCENT_FACE_COUNT = 2;
/**
 * How far each staircase face's centreline sits below the previous face's
 * trailing centreline.
 *
 * A full `FACE_SIN * width` (14.06) would line the next face's high edge up
 * exactly with the previous low edge, landing the player precisely on the top
 * corner with no margin. Three quarters of it drops them a little way down the
 * new face instead, which leaves room for the altitude the gap crossing costs and
 * still keeps most of the slope in hand.
 */
export const APPROACH_STAIR_DROP = FACE_SIN * RAMP_FACE_WIDTH * 0.75;
/**
 * Air gap between staircase faces — deliberately tighter than the ring's
 * `RAMP_ARC_GAP`.
 *
 * The ring's gap is sized for a player already travelling 25-40 u/s. The approach
 * is entered at a walk and the first gap is crossed at more like 16-24, and airtime
 * is where lateral drift accumulates unchecked: the slower the crossing, the
 * further sideways the player has gone by the time the next face's along-range
 * arrives. At the ring's 6.55 the slow crossings sailed past face 1 entirely; at 4
 * they land. The gap still has to be crossed by air, which is the point.
 */
export const APPROACH_STAIR_GAP = 4;
/**
 * Sideways stagger between consecutive staircase faces, toward the direction the
 * player is already drifting.
 *
 * Mirroring the bank alone is not enough, and the reason is worth keeping: a player
 * does not leave a face at its trailing end, they leave over its *low edge*
 * partway along, still carrying the lateral velocity that took them there. Line the
 * next face's high edge up exactly with the previous low edge and that residual
 * drift — a few u/s, over the half-second the gap takes — carries them past it, so
 * the face they were supposed to land on slides by just out of reach. Measured with
 * no stagger: every autopilot fell into the gap between the two faces.
 *
 * Offsetting the next face further along the drift direction puts its high edge
 * where the player actually arrives rather than where they left. It is the same
 * trick as `TRACK_RADIUS_WOBBLE` in the ring, for the same reason.
 */
export const APPROACH_STAIR_LATERAL = 6;
/**
 * Height the last staircase face's *centreline* finishes at, above `TRACK_Y`.
 *
 * Not zero, and this is the subtlest number in the approach. The player does not
 * ride a face's centreline, they ride down to its **low edge**, a full
 * `FACE_SIN * width / 2` below it. Land the last face's centreline on `TRACK_Y` —
 * level with the straight's own centreline, which looks like the obvious answer —
 * and the player arrives that 7 units *under* the straight's surface, sails
 * beneath it, and falls out of the level. Measured: every ballistic exit off the
 * last face missed the straight, 0 out of 45.
 *
 * So the chain has to finish high enough that the low edge, not the centreline,
 * meets the straight's face. One vertical half-span plus a little margin does it:
 * the player crosses the gap around `TRACK_Y` and settles onto the straight's high
 * half, which is exactly where a surfer wants to arrive.
 */
const APPROACH_STAIR_EXIT_Y = FACE_SIN * (RAMP_FACE_WIDTH / 2) + 2;
/**
 * Horizontal run of one staircase face — solved, not authored, so the chain lands
 * on `APPROACH_STAIR_EXIT_Y` exactly however the constants above are retuned.
 *
 * The faces must together give up `APPROACH_DESCENT_START_Y -
 * APPROACH_STAIR_EXIT_Y`. The
 * `APPROACH_DESCENT_FACE_COUNT - 1` steps between them contribute
 * `APPROACH_STAIR_DROP` each for free, and each face's own pitch contributes
 * `run * tan(pitch)`. What is left over, split between the faces, is the run.
 * Assert-worthy invariant: this must come out under ~45, or the faces are back to
 * being longer than a player can ride.
 */
export const APPROACH_STAIR_RUN =
  (APPROACH_DESCENT_START_Y -
    APPROACH_STAIR_EXIT_Y -
    (APPROACH_DESCENT_FACE_COUNT - 1) * APPROACH_STAIR_DROP) /
  (APPROACH_DESCENT_FACE_COUNT * Math.tan(degToRad(APPROACH_DESCENT_PITCH_DEG)));
/** Length along the sloped face, which is its horizontal run un-foreshortened. */
const APPROACH_STAIR_LENGTH =
  APPROACH_STAIR_RUN / Math.cos(degToRad(APPROACH_DESCENT_PITCH_DEG));
/**
 * Level banked straight between the end of the journey and the ring. Long
 * enough for the player to settle onto a line and stop trading altitude for
 * speed before the first gap, short enough that they do not simply slide off the
 * open low edge while doing it.
 */
const APPROACH_STRAIGHT_LENGTH = 70;

/* ------------------------------------------------------------------ *
 * The journey — the linear surf map between the descent and the ring
 *
 * The ring is the arena the run *ends* in (the Monolith arrives over the
 * island); the journey is the map the player surfs to get there. It is built
 * from the same single proven piece — one straight banked face — arranged with
 * the three handoff rules the approach staircase and the ring already paid to
 * learn: alternate the bank so the next face's high edge catches where the
 * previous low edge dropped the player; stagger each face toward the drift the
 * player is already carrying; and step the centreline down enough that they
 * arrive mid-face with slope in hand. Variety comes entirely from layout —
 * heading, pitch, width — never from new geometry.
 * ------------------------------------------------------------------ */

/** Air gap between journey faces. Ring-adjacent speeds, so wider than the staircase's 4. */
const JOURNEY_GAP = 5;
/**
 * Centreline step-down per level-section gap: half a face's vertical extent.
 * The player leaves a face's low edge `FACE_SIN * width / 2` below its
 * centreline; dropping the next centreline by the same amount lands them
 * mid-face with half the slope still beneath them. (The staircase uses 0.75 of
 * the *full* extent because its faces descend as well; level faces need less.)
 */
const JOURNEY_LEVEL_STEP = FACE_SIN * RAMP_FACE_WIDTH * 0.6;
/**
 * Extra step-down where a fast, steeply-falling exit has to be caught: into
 * and out of the dive. Ballistic probes found level-step spacing left the
 * catch band above where those exits actually arrive (dive-to-climb measured
 * 2/48 landings; the climb pair 0/48 before its own step was added).
 */
const JOURNEY_DIVE_ENTRY_EXTRA = 4;
const JOURNEY_DIVE_EXIT_STEP = 12;
/** Step-down between the two climb faces — ascending exits fall back quickly. */
const JOURNEY_CLIMB_STEP = 6;
/** Sideways stagger per gap, toward the previous face's low edge — same rule as the staircase. */
const JOURNEY_STAGGER = 6;
/** Gap a checkpoint platform sits in. Wider than JOURNEY_GAP so the pad reads as a rest, not a wall. */
const JOURNEY_CP_GAP = 9;

/** Slalom: how far each turn swings off the base heading. The ring turns 36 deg per gap; this stays under it. */
const JOURNEY_SLALOM_YAW_DEG = 24;
/** The dive: pitched like the approach staircase, entered much faster. */
const JOURNEY_DIVE_PITCH_DEG = 22;
/**
 * The climb — the piece of the course that is *not* downhill. Ascending faces
 * trade the player's speed back into height (v² = v0² − 2gh), so this is a
 * speed check: arrive off the dive at 25+ u/s and it costs a comfortable
 * fraction; arrive at a walk and it cannot be completed. The checkpoint layout
 * makes failure cost a retry of the dive, never a soft-lock: there is
 * deliberately NO checkpoint between the dive and the climb, because a player
 * respawning on one would start the climb at walk speed, which is impossible,
 * forever. The pre-dive platform is the retry point — falling out of the climb
 * re-runs the dive and arrives with speed again.
 */
const JOURNEY_CLIMB_PITCH_DEG = -12;
/** Narrow-section face width: two thirds of standard, a precision check at speed. */
const JOURNEY_NARROW_WIDTH = 12;
export const FACE_ROUGHNESS = 0.85;
export const FACE_METALNESS = 0;
/**
 * Greybox palette: one medium grey, nudged a couple of points toward a different
 * hue per segment. Enough to tell at a glance which ramp of the loop a
 * screenshot is from, far too little to read as decoration.
 */
export const SEGMENT_FACE_COLORS = [0x8a9299, 0x8f929e, 0x8a9a99, 0x958f96];
/** The approach reads as one continuous piece, so both of its ramps share a tint. */
export const APPROACH_FACE_COLOR = 0x9a8f86;
export const PLATFORM_COLOR = 0x6f7780;
export const ISLAND_COLOR = 0x5d646b;
export const ISLAND_SHELF_COLOR = 0x4d545a;

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
  /**
   * Unit *horizontal* vector along the section's heading. For a pitched face
   * (the approach descent) the real travel direction is this tilted down by
   * `pitchDeg`; the face normal is perpendicular to that, not to this.
   */
  travelDir: Vector3;
  /** Unit horizontal vector across the section's heading (the player's right). */
  crossDir: Vector3;
  /** World-space normal of the surfable face. */
  normal: Vector3;
  /** Index of the ramp in the ring, 0..LOOP_SEGMENT_COUNT-1, or -1 for the approach. */
  segmentIndex: number;
  /** Radius of this ramp's face centreline from the island's axis; 0 for the approach. */
  radius: number;
  /** Descent along travel, in degrees. 0 for every ring face; 22 for the approach descent. */
  pitchDeg: number;
}

export interface SurfCourse {
  group: Group;
  spawnPoint: Vector3;
  spawnYawDeg: number;
  /**
   * Rest-platform stages, in course order — used for the fall-out-of-bounds
   * recovery. `[0]` is the elevated start platform; between it and the final
   * ring re-entry platform sit the journey's checkpoints, one per section
   * boundary (except between the dive and the climb — see
   * `JOURNEY_CLIMB_PITCH_DEG` for why a checkpoint there would soft-lock).
   * The player crosses each pad's window on the way through, which arms it, so
   * a fall costs the current section rather than the whole run.
   */
  stages: CourseStage[];
  /**
   * Blessing shrines: floating pickups the player reaches by carrying speed
   * off a face and sailing to them. `Game` builds the actual objects — the
   * course only knows where they hang.
   */
  shrines: Vector3[];
  /**
   * Global kill plane: safely under everything (the island's shelf bottoms out
   * at −29). Falling below it ends the run — the prompt detection lives in
   * `Game`'s doomed check, so this only needs to be *below the course*, never
   * cleverly close to it. The old per-checkpoint ladder is gone; it is what
   * produced invisible mid-air teleport planes when a checkpoint went unarmed.
   */
  killPlaneY: number;
  /**
   * The journey's face specs in course order, for headless verification — the
   * ballistic-handoff probes need real edges, not reconstructed colliders.
   */
  journey: { start: Vector3; yawDeg: number; pitchDeg: number; length: number; width: number; bankSign: number }[];
  /**
   * The intended surf line: the centreline point at the leading edge of every
   * ramp in the ring, in loop order. Purely informational — nothing in the game
   * loop needs it — but it makes the course's shape inspectable (headless physics
   * tests fly a bot along it, and it is the natural input for any future
   * ghost/AI or minimap work) without re-deriving the layout from the colliders.
   */
  surfPath: Vector3[];
  /**
   * Same, for the approach: the centreline leading edge of each descent staircase
   * face in order, then of the level straight. So the first entry is where the
   * start platform hands over, and the last — `approachPath[
   * APPROACH_DESCENT_FACE_COUNT]` — is where the descent has finished spending its
   * altitude and sits at `trackY`.
   */
  approachPath: Vector3[];
  /** Every banked face in the course, in build order. See `BankedFace`. */
  faces: BankedFace[];
  /** Axis of the floating island, at the height of its top surface. */
  islandCenter: Vector3;
  islandRadius: number;
  /** Mean radius of the surf ring; individual ramps wobble +/-`trackRadiusWobble` around it. */
  trackRadius: number;
  /** Radial offset applied to alternate ring segments. See `TRACK_RADIUS_WOBBLE`. */
  trackRadiusWobble: number;
  /** Height of every face centreline — the ring is dead level. */
  trackY: number;
  loopSegmentCount: number;
  /** Length of one ring ramp along travel. */
  rampLength: number;
  /**
   * Open arc between consecutive ring ramps, i.e. what is left of a segment's
   * share of the circumference after its ramp. Derived, not authored — see
   * `RAMP_ARC_GAP`. The actual free-flight distance is a little longer.
   */
  rampArcGap: number;
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
 * Horizontal direction toward the high edge of a face banked `+FACE_ANGLE_DEG`
 * on heading `yawDeg`.
 *
 * A positive roll tilts the normal toward the player's right, which means the
 * surface *rises* toward their left — so the high side is `-crossXZ`. Anything
 * that wants to sit high on a face (start platforms) or reason about which way
 * the fall line runs should go through this rather than re-deriving the sign.
 */
function faceHighSideXZ(yawDeg: number): Vector3 {
  return crossXZ(yawDeg).negate();
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
 * Radius of segment `i`'s face centreline. Even segments push out, odd pull in;
 * with an even segment count the alternation closes cleanly at the seam between
 * segment 9 and segment 0.
 *
 * The parity is not free, even though the ring looks the same either way. The
 * approach runs *along segment 0's chord*, backwards from its leading edge, and
 * consecutive chords of the ring cross each other: the chord of an inner segment
 * (radius `TRACK_RADIUS - TRACK_RADIUS_WOBBLE`) crosses the chord line of an
 * outer neighbour 13.5 units beyond its own trailing end, while an *outer*
 * segment's chord crosses an inner neighbour's line 13.5 units *before* its
 * leading edge — i.e. right where the approach has to be. With segment 0 inner,
 * segment 9's ramp physically intersects the approach straight (verified: 4.3
 * units of box interpenetration, and a surfer wedges in the resulting pocket).
 * Making segment 0 the outer segment puts segment 9 inside the approach's line
 * with several units of clearance, and costs nothing else — the ring is
 * geometrically the same course either way.
 */
function segmentRadius(index: number): number {
  return TRACK_RADIUS + (index % 2 === 0 ? TRACK_RADIUS_WOBBLE : -TRACK_RADIUS_WOBBLE);
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
    envMaterial({ color, roughness: 0.85, metalness: 0 }),
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
    envMaterial({ color: ISLAND_COLOR, roughness: 0.9, metalness: 0 }),
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
    envMaterial({ color: ISLAND_SHELF_COLOR, roughness: 0.95, metalness: 0 }),
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

interface BankedRampSpec {
  /** Centreline point at the leading edge — what `RampCurve` takes as `start`. */
  start: Vector3;
  yawDeg: number;
  /** Descent along travel; 0 for every face in the ring. */
  pitchDeg: number;
  length: number;
  /** Face slope-extent. Defaults to the standard `RAMP_FACE_WIDTH`; the journey's narrow section shrinks it. */
  width?: number;
  /**
   * Which way the face leans: +1 puts its high edge toward `faceHighSideXZ`, -1
   * mirrors it. Every ring face is +1; the descent staircase alternates so each
   * face catches the player where the previous one dropped them.
   */
  bankSign?: number;
  color: number;
  /** Recorded on the produced `BankedFace`s. */
  segmentIndex: number;
  sectionIndex: number;
  radius: number;
}

/**
 * One banked face — a ring segment or an approach piece — plus the `BankedFace`
 * bookkeeping for it.
 *
 * The bank is always `+FACE_ANGLE_DEG`, which puts the face's fall line along the
 * player's right and its high edge on their left. In the ring, travelling with
 * theta increasing, the player's right is *inward*: the low edge is on the island
 * side and the high edge outside, so losing height slides the player toward the
 * island and gaining it climbs them away. The approach inherits the same handing
 * because it runs on segment 0's heading. `guideWalls` is off and there is no
 * retaining wall anywhere, so the low edge is always open and falling out is
 * always possible.
 */
function buildBankedRamp(group: Group, faces: BankedFace[], spec: BankedRampSpec): Vector3 {
  const forward = forwardXZ(spec.yawDeg);
  const cross = crossXZ(spec.yawDeg);

  const firstCollider = getColliders().length;
  const piece = buildRampCurve(
    {
      start: spec.start,
      startYawDeg: spec.yawDeg,
      startPitchDeg: spec.pitchDeg,
      rollDeg: FACE_ANGLE_DEG * (spec.bankSign ?? 1),
      length: spec.length,
      width: spec.width ?? RAMP_FACE_WIDTH,
      thickness: FACE_THICKNESS,
      guideWalls: false,
      color: spec.color,
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
      sectionIndex: spec.sectionIndex,
      side: (spec.bankSign ?? 1) >= 0 ? 'left' : 'right',
      travelDir: forward.clone(),
      crossDir: cross.clone(),
      normal: WORLD_UP.clone().applyQuaternion(collider.quaternion).normalize(),
      segmentIndex: spec.segmentIndex,
      radius: spec.radius,
      pitchDeg: spec.pitchDeg,
    });
  }

  return piece.endPosition.clone();
}

/**
 * One ramp of the ring: a single banked face, level along travel, tangent to the
 * circle at `SEGMENT_ARC_DEG * index`.
 */
function buildLoopSegment(
  group: Group,
  faces: BankedFace[],
  index: number,
): { faceStart: Vector3; faceEnd: Vector3 } {
  const thetaDeg = SEGMENT_ARC_DEG * index;
  const yawDeg = travelYawDeg(thetaDeg);
  const radius = segmentRadius(index);

  // `RampCurve` takes a point on the face's centreline — halfway up the slope —
  // at the leading edge of the piece. The ring's radius is defined on that same
  // centreline, so the face straddles it: `FACE_COS * width / 2` of horizontal
  // span and `FACE_SIN * width / 2` of height to either side.
  const faceMid = radialOut(thetaDeg).multiplyScalar(radius).setY(TRACK_Y);
  const faceStart = faceMid.clone().addScaledVector(forwardXZ(yawDeg), -RAMP_LENGTH / 2);

  const faceEnd = buildBankedRamp(group, faces, {
    start: faceStart,
    yawDeg,
    pitchDeg: 0,
    length: RAMP_LENGTH,
    color: SEGMENT_FACE_COLORS[index % SEGMENT_FACE_COLORS.length],
    segmentIndex: index,
    sectionIndex: index,
    radius,
  });

  return { faceStart, faceEnd };
}

/**
 * Lays out the surf course: an approach run that feeds an endless ring of ten
 * banked ramps orbiting a floating island.
 *
 * The shape follows from what a surf ramp actually is. A face is rolled 51.34 deg
 * about the direction of travel, so gravity pulls the player sideways down the
 * face rather than forward along it; they air-strafe back up it, and the ride is
 * an oscillation along the wall rather than a slide down a chute. Four
 * consequences drive this layout:
 *
 * 1. A face that is *level* along travel never accelerates the player forward, so
 *    a closed ring of level faces has zero net drop and the course has no end.
 *    There is no stage ladder and no final platform — segment 9 hands the player
 *    back to segment 0.
 * 2. The corollary: the ring cannot give speed, only keep it. The approach exists
 *    to supply it, by pitching one face along travel and spending
 *    `START_PLATFORM_TOP_Y` of altitude on it. The approach's straight is
 *    collinear with segment 0 — same heading, same bank, same centreline height —
 *    so arriving on the ring is not a transition at all, just the next ramp.
 * 3. Turning is free. A joint that changes heading costs nothing in speed here,
 *    because the surfaces meeting at it are both level, so the ring can bend a
 *    full `SEGMENT_ARC_DEG` per segment.
 * 4. The ramps deliberately do *not* touch. Each pair is separated by open air,
 *    and two independent things push a ballistic line off the next face: the ring
 *    curves away from the tangent the player leaves on, and the radial wobble
 *    offsets consecutive faces by `2 * TRACK_RADIUS_WOBBLE` sideways. So every gap
 *    has to be air-strafed across; the player is never sliding along one
 *    continuous surface. `RAMP_ARC_GAP` is the smallest gap that keeps that true.
 */
export function buildSurfCourse(): SurfCourse {
  const group = new Group();
  const stages: CourseStage[] = [];
  const surfPath: Vector3[] = [];
  const approachPath: Vector3[] = [];
  const faces: BankedFace[] = [];

  buildIsland(group);

  let firstSegmentStart: Vector3 | null = null;
  for (let index = 0; index < LOOP_SEGMENT_COUNT; index++) {
    const { faceStart } = buildLoopSegment(group, faces, index);
    surfPath.push(faceStart.clone());
    if (index === 0) firstSegmentStart = faceStart.clone();
  }

  // Everything before the ring is laid out backwards from segment 0 so that
  // heading, bank handing, centreline height and where each piece stops are all
  // derived from the ring rather than hand-placed beside it. Change the ring's
  // radius, count or ramp length and the whole run follows.
  const approachYawDeg = travelYawDeg(0);
  const approachForward = forwardXZ(approachYawDeg);
  const approachHighSide = faceHighSideXZ(approachYawDeg);

  // Level straight: ends one gap short of segment 0's leading edge, on segment
  // 0's own centreline, so the handoff onto the ring is indistinguishable from
  // any other gap in the loop.
  const straightEnd = firstSegmentStart!.clone().addScaledVector(approachForward, -RAMP_ARC_GAP);
  const straightStart = straightEnd
    .clone()
    .addScaledVector(approachForward, -APPROACH_STRAIGHT_LENGTH);

  /* ---------------------------------------------------------------- *
   * The journey, dry pass: walk the section list forward in local space
   * collecting face specs, checkpoint pads and shrine points, then translate
   * the whole chain so its exit lands exactly where the straight needs it.
   * Building forward is what makes heading changes (the slalom) sane; the
   * translation at the end is what keeps the ring the fixed reference.
   * ---------------------------------------------------------------- */
  interface JourneyFace {
    start: Vector3;
    yawDeg: number;
    pitchDeg: number;
    length: number;
    bankSign: number;
    width: number;
    color: number;
  }
  const journeyFaces: JourneyFace[] = [];
  const journeyPads: Vector3[] = [];
  const shrines: Vector3[] = [];

  const cursor = new Vector3();
  let prevYaw = approachYawDeg;
  let prevBank = -1; // the staircase above ends on −1, so the journey opens +1

  /** Horizontal direction of the previous face's low edge — where the player drifts. */
  const lowSide = () => faceHighSideXZ(prevYaw).multiplyScalar(-prevBank);

  const pushFace = (
    yawDeg: number,
    pitchDeg: number,
    length: number,
    bankSign: number,
    color: number,
    width = RAMP_FACE_WIDTH,
  ): void => {
    journeyFaces.push({ start: cursor.clone(), yawDeg, pitchDeg, length, bankSign, width, color });
    cursor.addScaledVector(forwardXZ(yawDeg), length * Math.cos(degToRad(pitchDeg)));
    cursor.y -= length * Math.sin(degToRad(pitchDeg));
    prevYaw = yawDeg;
    prevBank = bankSign;
  };
  /** Open air to the next face: forward, staggered toward the drift, stepped down. */
  const gap = (along: number, stepDown: number): void => {
    cursor.addScaledVector(forwardXZ(prevYaw), along).addScaledVector(lowSide(), JOURNEY_STAGGER);
    cursor.y -= stepDown;
  };
  /** Checkpoint pad centred in a widened gap, at local centreline height — the re-entry pattern. */
  const checkpoint = (): void => {
    journeyPads.push(cursor.clone().addScaledVector(forwardXZ(prevYaw), JOURNEY_CP_GAP / 2));
    gap(JOURNEY_CP_GAP, JOURNEY_LEVEL_STEP);
  };
  /** Shrine hung above the current cursor — reachable by launching off the piece just built. */
  const shrineHere = (up: number, along = 0): void => {
    shrines.push(cursor.clone().addScaledVector(forwardXZ(prevYaw), along).add(new Vector3(0, up, 0)));
  };

  const A = approachYawDeg;
  const S = JOURNEY_SLALOM_YAW_DEG;
  const C = SEGMENT_FACE_COLORS;

  // Cruise: two level faces to settle onto after the staircase.
  pushFace(A, 0, 45, 1, C[0]);
  shrineHere(9, 2.5);
  gap(JOURNEY_GAP, JOURNEY_LEVEL_STEP);
  pushFace(A, 0, 45, -1, C[1]);
  checkpoint();

  // Slalom: the ring turns 36 deg per gap, so ±24 swings are well inside proven
  // turning. Banks follow the turn (high edge outside), not strict alternation.
  pushFace(A + S, 0, 38, 1, C[2]);
  gap(JOURNEY_GAP, JOURNEY_LEVEL_STEP);
  pushFace(A, 0, 38, -1, C[3]);
  shrineHere(12, 3);
  gap(JOURNEY_GAP, JOURNEY_LEVEL_STEP);
  pushFace(A - S, 0, 38, -1, C[0]);
  gap(JOURNEY_GAP, JOURNEY_LEVEL_STEP);
  pushFace(A, 0, 38, 1, C[1]);
  checkpoint(); // pre-dive: the retry point for the whole dive-and-climb passage
  cursor.y -= JOURNEY_DIVE_ENTRY_EXTRA;

  // The dive: staircase numbers (they are speed-for-altitude, already tuned),
  // entered much faster than the approach's walk.
  pushFace(A, JOURNEY_DIVE_PITCH_DEG, 45, -1, APPROACH_FACE_COLOR);
  gap(APPROACH_STAIR_GAP, APPROACH_STAIR_DROP);
  pushFace(A, JOURNEY_DIVE_PITCH_DEG, 45, 1, APPROACH_FACE_COLOR);
  shrineHere(14, 4);
  gap(JOURNEY_GAP, JOURNEY_DIVE_EXIT_STEP);

  // The climb — deliberately NO checkpoint since the dive (see the constant's
  // doc: a respawn here would face the ascent at walk speed, forever).
  pushFace(A, JOURNEY_CLIMB_PITCH_DEG, 30, -1, APPROACH_FACE_COLOR);
  gap(APPROACH_STAIR_GAP, JOURNEY_CLIMB_STEP);
  pushFace(A, JOURNEY_CLIMB_PITCH_DEG, 30, 1, APPROACH_FACE_COLOR);
  shrineHere(8, 2);
  checkpoint(); // earned: the climb is behind them

  // Narrow: standard handoffs, two-thirds width — a precision check at speed.
  pushFace(A, 0, 40, -1, C[2], JOURNEY_NARROW_WIDTH);
  gap(JOURNEY_GAP, JOURNEY_LEVEL_STEP);
  pushFace(A, 0, 40, 1, C[3], JOURNEY_NARROW_WIDTH);
  shrineHere(11, 2);
  gap(JOURNEY_GAP, JOURNEY_LEVEL_STEP);

  // Final descent onto the straight's line. Its end obeys the staircase's exit
  // rule: finish one half-span-plus-margin above the straight's centreline so
  // the player's low-edge exit meets the straight's face, not the air under it.
  pushFace(A, 15, 45, -1, APPROACH_FACE_COLOR);

  // Translate the whole chain so the final face's end lands one stair-gap
  // before the straight, `APPROACH_STAIR_EXIT_Y` above its centreline.
  const journeyOffset = straightStart
    .clone()
    .addScaledVector(approachForward, -APPROACH_STAIR_GAP)
    .add(new Vector3(0, APPROACH_STAIR_EXIT_Y, 0))
    .sub(cursor);
  for (const face of journeyFaces) face.start.add(journeyOffset);
  for (const pad of journeyPads) pad.add(journeyOffset);
  for (const shrine of shrines) shrine.add(journeyOffset);

  // Descent staircase, laid out backwards from the journey's entry exactly as
  // it used to be from the straight: same solved run, same internal drop, same
  // alternation and stagger — only its exit target moved. Every face shares the
  // journey-entry centreline laterally; the alternating bank does the lateral
  // work. See `APPROACH_DESCENT_FACE_COUNT`.
  const journeyEntry = journeyFaces[0].start;
  const stairExitDescent = APPROACH_DESCENT_START_Y - APPROACH_STAIR_EXIT_Y;
  const descentStartY = journeyEntry.y + APPROACH_STAIR_EXIT_Y + stairExitDescent;
  const staircaseSpan =
    APPROACH_DESCENT_FACE_COUNT * APPROACH_STAIR_RUN +
    APPROACH_DESCENT_FACE_COUNT * APPROACH_STAIR_GAP;
  const descentStart = journeyEntry
    .clone()
    .addScaledVector(approachForward, -staircaseSpan)
    .setY(descentStartY);

  const stairPitchDrop = APPROACH_STAIR_RUN * Math.tan(degToRad(APPROACH_DESCENT_PITCH_DEG));
  for (let face = 0; face < APPROACH_DESCENT_FACE_COUNT; face++) {
    const faceStart = descentStart
      .clone()
      .addScaledVector(approachForward, face * (APPROACH_STAIR_RUN + APPROACH_STAIR_GAP))
      .addScaledVector(approachHighSide, -face * APPROACH_STAIR_LATERAL)
      .setY(descentStartY - face * (stairPitchDrop + APPROACH_STAIR_DROP));
    buildBankedRamp(group, faces, {
      start: faceStart,
      yawDeg: approachYawDeg,
      pitchDeg: APPROACH_DESCENT_PITCH_DEG,
      length: APPROACH_STAIR_LENGTH,
      bankSign: face % 2 === 0 ? 1 : -1,
      color: APPROACH_FACE_COLOR,
      segmentIndex: -1,
      sectionIndex: face,
      radius: 0,
    });
    approachPath.push(faceStart.clone());
    // The tutorial shrine: over the second stair face, but high and pulled
    // toward the high side, so the default descent line passes under it —
    // the smoke autopilot collected the first placement without deviating,
    // which is a freebie, not a shrine.
    if (face === 1) {
      shrines.push(
        faceStart
          .clone()
          .addScaledVector(approachHighSide, -5)
          .add(new Vector3(0, 13, 0)),
      );
    }
  }

  // Emit the journey's faces and checkpoint pads (world space now).
  journeyFaces.forEach((face, i) => {
    buildBankedRamp(group, faces, {
      start: face.start,
      yawDeg: face.yawDeg,
      pitchDeg: face.pitchDeg,
      length: face.length,
      width: face.width,
      bankSign: face.bankSign,
      color: face.color,
      segmentIndex: -1,
      sectionIndex: APPROACH_DESCENT_FACE_COUNT + 1 + i,
      radius: 0,
    });
    approachPath.push(face.start.clone());
  });

  // Ring shrines: high over two of the gaps, plus one hung toward the island —
  // all reached by launching off a face's high edge with speed to spare.
  for (const thetaDeg of [126, 270]) {
    shrines.push(
      radialOut(thetaDeg)
        .multiplyScalar(TRACK_RADIUS + 4)
        .setY(TRACK_Y + 13),
    );
  }
  shrines.push(radialOut(198).multiplyScalar(ISLAND_RADIUS + 18).setY(TRACK_Y + 16));

  // The straight is now reached across a gap like every other joint in the course,
  // so it is built exactly where it belongs. That gap is also what retired the
  // seam-bury this used to need: butted directly against a pitched face, a level
  // piece's leading cap protruded through that face's surface as an uphill wall,
  // because a banked piece's trailing edge stops being perpendicular to travel once
  // the piece is also pitched — rolling the width axis about a downward-tilted
  // forward gives it an along-travel component, raking the edge forward on the high
  // side by `(width / 2) * sin(roll) * sin(pitch)`. A body riding in at 30 u/s came
  // out at 6.4. Open air between the pieces cannot rake into anything.
  //
  // With an even `APPROACH_DESCENT_FACE_COUNT` the last staircase face leans
  // opposite to the ring, which is what makes this handoff work: the player leaves
  // its low edge on the same side as the straight's high edge, and the straight is
  // collinear with segment 0, so from here to the ring is one unbroken line.
  buildBankedRamp(group, faces, {
    start: straightStart,
    yawDeg: approachYawDeg,
    pitchDeg: 0,
    length: APPROACH_STRAIGHT_LENGTH,
    color: APPROACH_FACE_COLOR,
    segmentIndex: -1,
    sectionIndex: APPROACH_DESCENT_FACE_COUNT,
    radius: 0,
  });
  approachPath.push(straightStart.clone());

  // Elevated start platform, butted up against the descent's leading edge and
  // pushed `PLATFORM_OUTWARD_OFFSET` toward the face's high side, so the player
  // steps off the front onto the *upper* part of the face with the whole slope
  // beneath them. It sits in the air *before* the ramp rather than overhanging
  // it: the face's high edge tops out `FACE_SIN * RAMP_FACE_WIDTH / 2` above its
  // centreline, well above the platform's top, so any overlap of the two
  // footprints would poke ramp up through the walking surface.
  const startPlatformTop = descentStart
    .clone()
    .addScaledVector(approachForward, -PLATFORM_DEPTH / 2)
    .addScaledVector(approachHighSide, PLATFORM_OUTWARD_OFFSET)
    .setY(descentStartY + PLATFORM_TOP_ABOVE_FACE);
  stages.push(buildPlatform(group, startPlatformTop, PLATFORM_WIDTH, PLATFORM_DEPTH, approachYawDeg));

  // Journey checkpoints, in course order between the start pad and the ring
  // re-entry — the order is what the fall-recovery's kill-plane ladder reads.
  for (const pad of journeyPads) {
    stages.push(buildPlatform(group, pad, PLATFORM_WIDTH, PLATFORM_DEPTH, approachYawDeg));
  }

  // Ring re-entry platform: the run's checkpoint, centred in the gap between the
  // approach straight and segment 0, on their shared centreline at track level.
  // The player flies through that window on their way in, which arms it, and from
  // then on a fall off the ring puts them back here instead of at the top of the
  // approach.
  //
  // It is deliberately the only flat surface anywhere near the surf line, and at
  // `PLATFORM_DEPTH` it is three times longer than the `RAMP_ARC_GAP` window it
  // sits in, so it overhangs ~6.7 units into each neighbouring face and its
  // outboard half is buried in them. Two consequences worth knowing: the entry
  // gap is no longer purely air at centreline height, and a player whose line
  // passes exactly through y = `TRACK_Y` here lands on a walkable surface and
  // pays ground friction. Both are the price of a checkpoint the player cannot
  // miss on the way in; the ring's other nine gaps are untouched.
  const reentryPlatformTop = straightEnd
    .clone()
    .addScaledVector(approachForward, RAMP_ARC_GAP / 2)
    .setY(TRACK_Y);
  stages.push(
    buildPlatform(group, reentryPlatformTop, PLATFORM_WIDTH, PLATFORM_DEPTH, approachYawDeg),
  );

  const spawnPoint = startPlatformTop.clone().add(new Vector3(0, 1.2, 0));

  return {
    group,
    spawnPoint,
    spawnYawDeg: playerYawDegForHeading(approachYawDeg),
    stages,
    shrines,
    killPlaneY: TRACK_Y - 45,
    journey: journeyFaces.map((f) => ({
      start: f.start.clone(),
      yawDeg: f.yawDeg,
      pitchDeg: f.pitchDeg,
      length: f.length,
      width: f.width,
      bankSign: f.bankSign,
    })),
    surfPath,
    approachPath,
    faces,
    islandCenter: new Vector3(0, ISLAND_TOP_Y, 0),
    islandRadius: ISLAND_RADIUS,
    trackRadius: TRACK_RADIUS,
    trackRadiusWobble: TRACK_RADIUS_WOBBLE,
    trackY: TRACK_Y,
    loopSegmentCount: LOOP_SEGMENT_COUNT,
    rampLength: RAMP_LENGTH,
    rampArcGap: RAMP_ARC_GAP,
    trackFaceHalfHeight: (FACE_SIN * RAMP_FACE_WIDTH) / 2,
    trackFaceHalfRun: (FACE_COS * RAMP_FACE_WIDTH) / 2,
  };
}
