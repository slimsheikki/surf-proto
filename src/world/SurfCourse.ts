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
  /**
   * The intended surf line: the top-surface path point at the start of every
   * ramp piece, plus the final lip. Purely informational — nothing in the game
   * loop needs it — but it makes the course's shape inspectable (headless
   * physics tests fly a bot along it, and it is the natural input for any future
   * ghost/AI or minimap work) without re-deriving the layout from the colliders.
   */
  surfPath: Vector3[];
}

/**
 * Ramp surfaces are planes tilted about a horizontal axis, so the width is the
 * player's room for error across the surfable line. 9 units is ~11 player
 * widths: wide enough that a sloppy transfer still lands on the ramp, narrow
 * enough that the guide walls read as a channel to follow.
 */
const RAMP_WIDTH = 9;

/**
 * Mirrors MovementConfig.PLAYER_RADIUS. Duplicated rather than imported so the
 * world module doesn't depend on player tuning; it is only used to pad
 * clearances, so a small drift between the two is harmless.
 */
const PLAYER_RADIUS = 0.4;

/** Extra clearance on top of the computed transfer drop, in world units. */
const TRANSFER_CLEARANCE = 0.5;

const RAMP_COLORS = [0x4a7fb5, 0x4a9f6b, 0xb5824a, 0x8f5fb5, 0x4aa5b5, 0xb5a24a];
const PLATFORM_COLOR = 0x53627a;
const START_PLATFORM_SIZE = 9;
const REST_PLATFORM_SIZE = 9;
const FINAL_PLATFORM_SIZE = 16;

/**
 * One plane of surfable ramp. Pitch is constant across a piece — real surf
 * ramps are flat wedges, and a single collider per piece means a seam-free
 * surface for however long the piece runs.
 */
interface PieceSpec {
  /** Yaw change applied at the joint *before* this piece (deg, before the stage's turn sign). */
  yawStepDeg: number;
  /** Slope of this piece (deg, positive = descending). Never below ~50: see STAGE_PIECES. */
  pitchDeg: number;
  /** Arc length of the piece. */
  length: number;
}

/**
 * The repeating shape of a stage: two ramp pieces that get shallower as the
 * player descends (58 -> 50 deg), i.e. *concave*, the profile real surf maps
 * use. Riding it, the slope flattens out beneath you, so gravity keeps pressing
 * you into the surface and the ramp keeps redirecting speed along itself instead
 * of dropping away and leaving you in free fall. (Built the other way round —
 * steepening as you descend — the surface outruns the player and they simply
 * free-fall past it, which is what an earlier 45 -> 70 version of this course
 * did: zero ticks of surface contact.)
 *
 * Two properties of the joint between the pieces are load-bearing:
 *
 * 1. The pitch *must* drop across a joint that also turns. A player leaving
 *    piece N is travelling at piece N's slope; a piece N+1 that is yawed but
 *    equally steep descends more slowly along their path than they do, so they
 *    only rejoin it far downhill. Dropping pitch across the joint shortens that
 *    reunion to a brief air-strafe hop, which is what keeps ramp contact high.
 * 2. Pitch can only fall so far before the surface becomes walkable (45 deg) and
 *    the player lands and skids to a halt on friction, so the budget has to be
 *    reset. That is what the rest platform at the end of each stage is for:
 *    crossing it bleeds the speed and re-arms the whole 58 -> 50 sweep.
 *
 * Lengths grow down the stage because the player is faster there and a piece is
 * consumed in proportion to speed.
 */
const STAGE_PIECES: readonly PieceSpec[] = [
  // The first yaw step of a stage happens where the player is at walking speed
  // on the platform, so it can be much larger than a mid-air transfer.
  { yawStepDeg: 34, pitchDeg: 58, length: 95 },
  { yawStepDeg: 18, pitchDeg: 50, length: 120 },
];

const STAGE_COUNT = 6;
/** The last stage runs longer: nothing follows it, so the player can just let it build. */
const FINALE_LENGTH_SCALE = 1.5;

function forwardXZ(yawDeg: number): Vector3 {
  const yaw = degToRad(yawDeg);
  return new Vector3(Math.sin(yaw), 0, -Math.cos(yaw));
}

/**
 * Distance from the center of an axis-aligned square platform to the edge the
 * player leaves along `yawDeg`.
 *
 * Not `size / 2`: on a diagonal heading the boundary is up to sqrt(2) times
 * further out. Getting this wrong puts the top of the next ramp *inside* the
 * platform, so the player walks out over a surface that is already metres below
 * their feet and free-falls that much longer before the ramp catches them —
 * which measured as a full extra second of air at every stage entry.
 */
function platformEdgeDistance(size: number, yawDeg: number): number {
  const yaw = degToRad(yawDeg);
  return size / 2 / Math.max(Math.abs(Math.sin(yaw)), Math.abs(Math.cos(yaw)));
}

/**
 * Vertical offset applied to the start of a piece that turns, so the previous
 * piece's surface stays the higher of the two across the whole joint.
 *
 * Why it is needed: consecutive ramp boxes only share their top edge exactly
 * when they have the same yaw. Rotate one about the joint and its surface rises
 * above its neighbour on one side by tan(pitch) * yawStep * (distance from the
 * centreline) — and what pokes through is the new box's uphill end cap, a face
 * whose normal is exactly opposite the direction the player is travelling.
 * Hitting it deletes essentially all of their velocity (measured: a 90 deg turn
 * built without this offset drops a 30 u/s bot to under 1 u/s within a few
 * segments). Sinking the new piece by the worst-case rise buries that cap under
 * the previous surface, leaving a small step *down* — which costs a fraction of
 * a second of air instead of the whole run's speed.
 */
function transferDrop(prevPitchDeg: number, yawStepDeg: number): number {
  if (yawStepDeg === 0) return 0;
  return (
    Math.tan(degToRad(prevPitchDeg)) *
      Math.abs(degToRad(yawStepDeg)) *
      (RAMP_WIDTH / 2 + PLAYER_RADIUS) +
    TRANSFER_CLEARANCE
  );
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
 * Lays out the surf course: six stages of concave ramp, each stage two planes of
 * 58 then 50 deg linked by a short turning hop, each stage bookended by one small
 * rest platform. Roughly 1140 units of descent in total.
 *
 * The shape of the whole thing is set by two facts about the movement code.
 * First, speed on a surf ramp only comes from height: v = sqrt(2 g h), so a run
 * that never stops accelerating gets absurdly fast rather than long — a single
 * uninterrupted descent this tall would end well over 100 u/s. Second, flat
 * ground is the only thing here with friction. So the course is deliberately
 * *staged*: each stage is a continuous ~215-unit slide that takes the player
 * from walking pace to ~50 u/s, and the small platform at its end is both the
 * checkpoint, the speed bleed, and the reset of the concave pitch budget.
 *
 * Measured with an autopilot that steers down the fall line: ~60% of ticks in
 * ramp contact, ~28% airborne between pieces, ~12% on flat platforms — about
 * 7:1 surfing to standing, which is the ratio this course exists to produce.
 *
 * Every platform is returned in `stages`, in course order, so the fall-out
 * plane and the checkpoint respawn both derive from real geometry.
 */
export function buildSurfCourse(): SurfCourse {
  const group = new Group();
  const stages: CourseStage[] = [];
  const surfPath: Vector3[] = [];

  let platformCenter = new Vector3(0, 0, 0);
  let platformSize = START_PLATFORM_SIZE;
  stages.push(buildPlatform(group, platformCenter, platformSize, platformSize, PLATFORM_COLOR));

  let yawDeg = 0;
  for (let stage = 0; stage < STAGE_COUNT; stage++) {
    // Turn direction flips every two stages: long enough to feel like a sweeping
    // spiral, often enough that the player isn't leaning the same way all run.
    const turn = Math.floor(stage / 2) % 2 === 0 ? 1 : -1;
    const lengthScale = stage === STAGE_COUNT - 1 ? FINALE_LENGTH_SCALE : 1;
    const color = RAMP_COLORS[stage % RAMP_COLORS.length];

    let pieceStart = new Vector3();
    let prevPitchDeg = 0;
    for (let i = 0; i < STAGE_PIECES.length; i++) {
      const spec = STAGE_PIECES[i];
      // The very first piece runs dead ahead of the spawn heading so the player
      // starts pointed down the course with nothing to correct.
      const yawStepDeg = stage === 0 && i === 0 ? 0 : spec.yawStepDeg * turn;
      yawDeg += yawStepDeg;

      if (i === 0) {
        // Launch off the far lip of the rest platform, along the new heading.
        pieceStart = platformCenter
          .clone()
          .addScaledVector(forwardXZ(yawDeg), platformEdgeDistance(platformSize, yawDeg));
      } else {
        pieceStart.y -= transferDrop(prevPitchDeg, yawStepDeg);
      }

      surfPath.push(pieceStart.clone());
      const piece = buildRampCurve(
        {
          start: pieceStart,
          startYawDeg: yawDeg,
          startPitchDeg: spec.pitchDeg,
          length: spec.length * lengthScale,
          width: RAMP_WIDTH,
          guideWalls: true,
          color,
        },
        'straight',
      );
      group.add(piece.group);
      pieceStart = piece.endPosition.clone();
      prevPitchDeg = spec.pitchDeg;
    }

    // The next platform's top sits flush with the lip the player arrives on, its
    // near edge at that lip, so the ramp runs straight onto it: the landing
    // clips off the vertical velocity, then friction does the rest.
    const isFinal = stage === STAGE_COUNT - 1;
    platformSize = isFinal ? FINAL_PLATFORM_SIZE : REST_PLATFORM_SIZE;
    platformCenter = pieceStart
      .clone()
      .addScaledVector(forwardXZ(yawDeg), platformEdgeDistance(platformSize, yawDeg));
    surfPath.push(pieceStart.clone());
    stages.push(buildPlatform(group, platformCenter, platformSize, platformSize, PLATFORM_COLOR));
  }

  return {
    group,
    spawnPoint: stages[0].center.clone().add(new Vector3(0, 1.2, 0)),
    spawnYawDeg: 0,
    stages,
    surfPath,
  };
}
