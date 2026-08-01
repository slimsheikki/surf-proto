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
import { GameCourse } from '../game/Game';
import { registerCollider } from '../world/Colliders';
import { buildRampCurve, forwardFromAngles } from '../world/RampCurve';
import {
  APPROACH_FACE_COLOR,
  CourseStage,
  FACE_METALNESS,
  FACE_ROUGHNESS,
  FACE_SIN,
  FACE_THICKNESS,
  ISLAND_COLOR,
  ISLAND_SHELF_COLOR,
  PLATFORM_COLOR,
  PLATFORM_THICKNESS,
} from '../world/SurfCourse';
import { FreeMap, FreePiece } from './MapData';

const WORLD_UP = new Vector3(0, 1, 0);

/** Level ramps take the ring's grey; pitched ones the approach's warmer tint, exactly as in the standard course. */
const SURF_FACE_COLOR = 0x8a9299;
/** The start pad is tinted apart from checkpoint pads — it is the one piece a map cannot do without. */
const SPAWN_PAD_COLOR = 0x6f8a76;
const SPAWN_PAD_WIDTH = 14;
const SPAWN_PAD_DEPTH = 20;

/**
 * Reserved ids for the two fixtures every map has exactly one of. They are
 * selectable and movable in the editor like any piece, but they are not in
 * `FreeMap.pieces` and cannot be deleted — a map with no start pad has nowhere
 * to spawn, and one with no cylinder has nothing to run toward.
 */
export const SPAWN_ID = '__spawn';
export const BOSS_ID = '__boss';

/** Boss cylinder: the goal marker every free map runs toward. */
const BOSS_PILLAR_RADIUS = 20;
const BOSS_PILLAR_HEIGHT = 24;
const BOSS_PILLAR_RIM_BOX_COUNT = 8;
const BOSS_PILLAR_SHELF_RADIUS = 24;
const BOSS_PILLAR_SHELF_HEIGHT = 4;
/** Emissive cap disc, so the goal is findable from across a map at any light angle. */
const BOSS_BEACON_COLOR = 0xff5c7a;

/**
 * How far below the lowest thing in the map the kill plane sits.
 *
 * Free maps have no stage ladder — a player can build a course that climbs,
 * descends, or loops — so the standard course's trick of hanging the plane
 * under the *next* rest platform has nothing to hang off. One global plane is
 * the honest answer here, and it only needs to clear the lowest ramp's low edge
 * by enough that riding that ramp normally never trips it.
 */
const FREE_KILL_PLANE_MARGIN = 40;

/**
 * Bounds on the radius handed to the boss, which is what sizes its engagement
 * range. Uncapped it would be the map's own extent, so a large map would let
 * the boss shoot the player anywhere in it from the moment they spawn; floored,
 * because a tiny map still needs the boss to be able to reach the ramp beside it.
 */
const BOSS_RADIUS_MIN = 50;
const BOSS_RADIUS_MAX = 140;

/** How close the player has to get before the boss wakes. See `bossTriggerRadius`. */
const BOSS_TRIGGER_MARGIN = 70;

export interface FreeWorld {
  group: Group;
  course: GameCourse;
}

export interface PieceBuildOptions {
  /**
   * Register collision boxes as well as meshes. False while editing (the piece
   * is rebuilt on every drag step and colliders cannot be retired), true when
   * the map is built for play.
   */
  colliders: boolean;
  /** Overrides the piece's own colour — used for the drag-in ghost. */
  color?: number;
}

/** Unit vector along heading `yawDeg`; yaw 0 = -Z, matching `SurfCourse.forwardXZ`. */
export function forwardXZ(yawDeg: number): Vector3 {
  const yaw = degToRad(yawDeg);
  return new Vector3(Math.sin(yaw), 0, -Math.cos(yaw));
}

/**
 * Orientation for an un-banked box on heading `yawDeg`.
 *
 * `right = worldUp × forward` rather than the cross vector itself, for the
 * reason `RampCurve.basisFromForward` spells out: `makeBasis` feeding
 * `setFromRotationMatrix` needs a proper rotation, and the other order is
 * left-handed and yields a garbage quaternion.
 */
function yawQuaternion(yawDeg: number): Quaternion {
  const forward = forwardXZ(yawDeg);
  const right = new Vector3().crossVectors(WORLD_UP, forward).normalize();
  return new Quaternion().setFromRotationMatrix(new Matrix4().makeBasis(right, WORLD_UP, forward));
}

/** Leading-edge centreline point of a piece stored by its centre. See `FreePiece`. */
export function pieceStart(piece: FreePiece): Vector3 {
  const forward = forwardFromAngles(piece.yawDeg, piece.pitchDeg);
  return new Vector3(piece.x, piece.y, piece.z).addScaledVector(forward, -piece.length / 2);
}

function pieceColor(piece: FreePiece): number {
  if (piece.kind === 'platform') return PLATFORM_COLOR;
  return piece.pitchDeg !== 0 ? APPROACH_FACE_COLOR : SURF_FACE_COLOR;
}

/**
 * A flat pad, given the centre of its *top* surface. Shared by checkpoint pads
 * and the start pad so both are the same thing to stand on.
 */
function buildPad(
  group: Group,
  topCenter: Vector3,
  width: number,
  depth: number,
  yawDeg: number,
  color: number,
  withColliders: boolean,
): CourseStage {
  const center = topCenter.clone().addScaledVector(WORLD_UP, -PLATFORM_THICKNESS / 2);
  const halfExtents = new Vector3(width / 2, PLATFORM_THICKNESS / 2, depth / 2);
  const quaternion = yawQuaternion(yawDeg);

  if (withColliders) {
    registerCollider({ position: center.clone(), quaternion: quaternion.clone(), halfExtents });
  }

  const mesh = new Mesh(
    new BoxGeometry(width, PLATFORM_THICKNESS, depth),
    new MeshStandardMaterial({ color, roughness: 0.85, metalness: 0 }),
  );
  mesh.position.copy(center);
  mesh.quaternion.copy(quaternion);
  group.add(mesh);

  // `Game.trackLastStage` tests against world axes, so an off-axis pad has to
  // report the half-extents of its world footprint — same reasoning as
  // `SurfCourse.buildPlatform`, and the same consequence if it is skipped: the
  // checkpoint shrinks on every diagonal heading.
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
 * Meshes (and optionally colliders) for one placed piece, in world space.
 *
 * World space rather than a local build parented under a transform, because
 * `RampCurve` bakes its segment transforms into mesh positions and the
 * colliders it registers are world-space boxes — a parent transform would move
 * the meshes and leave the collision behind. Every free-mode piece is a
 * straight run, so `buildRampCurve` emits a single segment and rebuilding one
 * on every step of a drag costs one box.
 */
export function buildPiece(piece: FreePiece, options: PieceBuildOptions): Group {
  const group = new Group();
  group.userData.pieceId = piece.id;
  const color = options.color ?? pieceColor(piece);

  if (piece.kind === 'platform') {
    buildPad(
      group,
      new Vector3(piece.x, piece.y, piece.z),
      piece.width,
      piece.length,
      piece.yawDeg,
      color,
      options.colliders,
    );
    return group;
  }

  const curve = buildRampCurve(
    {
      start: pieceStart(piece),
      startYawDeg: piece.yawDeg,
      startPitchDeg: piece.pitchDeg,
      rollDeg: piece.rollDeg,
      length: piece.length,
      width: piece.width,
      thickness: FACE_THICKNESS,
      guideWalls: false,
      color,
      roughness: FACE_ROUGHNESS,
      metalness: FACE_METALNESS,
      registerColliders: options.colliders,
    },
    'straight',
  );
  group.add(curve.group);
  return group;
}

/**
 * The start pad. Split out from `buildFreeWorld` so the editor shows the exact
 * pad the player will later stand on, rather than a stand-in that could drift
 * out of agreement with it.
 */
export function buildSpawnPad(
  spawn: FreeMap['spawn'],
  colliders: boolean,
): { group: Group; stage: CourseStage } {
  const group = new Group();
  group.userData.pieceId = SPAWN_ID;
  const stage = buildPad(
    group,
    new Vector3(spawn.x, spawn.y, spawn.z),
    SPAWN_PAD_WIDTH,
    SPAWN_PAD_DEPTH,
    spawn.yawDeg,
    SPAWN_PAD_COLOR,
    colliders,
  );
  return { group, stage };
}

/**
 * The boss cylinder, given the centre of its top surface.
 *
 * Collision is box-only so the cylinder is approximated the same way the
 * standard course's island is — an inscribed square prism plus a ring of radial
 * slabs. The player is not meant to land on it, but a free map can put a ramp
 * anywhere, so it has to be solid rather than a pure sight-line marker.
 */
export function buildBossMarker(boss: FreeMap['boss'], colliders: boolean): Group {
  const group = new Group();
  group.userData.pieceId = BOSS_ID;
  buildBossPillar(group, new Vector3(boss.x, boss.y, boss.z), colliders);
  return group;
}

function buildBossPillar(group: Group, top: Vector3, withColliders: boolean): void {
  const halfHeight = BOSS_PILLAR_HEIGHT / 2;
  const centerY = top.y - halfHeight;

  const body = new Mesh(
    new CylinderGeometry(BOSS_PILLAR_RADIUS, BOSS_PILLAR_RADIUS, BOSS_PILLAR_HEIGHT, 24),
    new MeshStandardMaterial({ color: ISLAND_COLOR, roughness: 0.9, metalness: 0 }),
  );
  body.position.set(top.x, centerY, top.z);
  group.add(body);

  const shelf = new Mesh(
    new CylinderGeometry(
      BOSS_PILLAR_SHELF_RADIUS,
      BOSS_PILLAR_SHELF_RADIUS * 0.55,
      BOSS_PILLAR_SHELF_HEIGHT,
      24,
    ),
    new MeshStandardMaterial({ color: ISLAND_SHELF_COLOR, roughness: 0.95, metalness: 0 }),
  );
  shelf.position.set(top.x, top.y - BOSS_PILLAR_HEIGHT + BOSS_PILLAR_SHELF_HEIGHT / 2, top.z);
  group.add(shelf);

  // Beacon: normal blending and a restrained emissive. Additive washes out
  // against this sky and a hot emissive on a saturated colour clips to white —
  // both already learned the hard way on the slash cone.
  const beacon = new Mesh(
    new CylinderGeometry(BOSS_PILLAR_RADIUS * 0.45, BOSS_PILLAR_RADIUS * 0.45, 0.6, 24),
    new MeshStandardMaterial({
      color: BOSS_BEACON_COLOR,
      emissive: BOSS_BEACON_COLOR,
      emissiveIntensity: 0.9,
      roughness: 0.5,
    }),
  );
  beacon.position.set(top.x, top.y + 0.3, top.z);
  group.add(beacon);

  if (!withColliders) return;

  const inscribedHalf = BOSS_PILLAR_RADIUS / Math.SQRT2;
  registerCollider({
    position: new Vector3(top.x, centerY, top.z),
    quaternion: new Quaternion(),
    halfExtents: new Vector3(inscribedHalf, halfHeight, inscribedHalf),
  });

  const rimInner = inscribedHalf - 1;
  const rimRadialHalf = (BOSS_PILLAR_RADIUS - rimInner) / 2;
  const rimTangentialHalf = BOSS_PILLAR_RADIUS * Math.sin(Math.PI / BOSS_PILLAR_RIM_BOX_COUNT);
  for (let i = 0; i < BOSS_PILLAR_RIM_BOX_COUNT; i++) {
    const thetaDeg = (360 / BOSS_PILLAR_RIM_BOX_COUNT) * i;
    const center = forwardXZ(thetaDeg)
      .multiplyScalar(rimInner + rimRadialHalf)
      .add(new Vector3(top.x, 0, top.z))
      .setY(centerY);
    registerCollider({
      position: center,
      quaternion: yawQuaternion(thetaDeg + 90),
      halfExtents: new Vector3(rimRadialHalf, halfHeight, rimTangentialHalf),
    });
  }
}

/** Lowest surface in the map, used to place the kill plane under all of it. */
function lowestY(map: FreeMap): number {
  let lowest = Math.min(map.spawn.y, map.boss.y - BOSS_PILLAR_HEIGHT);
  for (const piece of map.pieces) {
    // A banked face hangs `FACE_SIN * width / 2` below its centreline; a pitched
    // one drops another half-length of travel. Both matter — the low edge of the
    // last ramp is exactly where a player is when they most need the plane to be
    // below them.
    const bankDrop = piece.kind === 'platform' ? 0 : (FACE_SIN * piece.width) / 2;
    const pitchDrop = (Math.abs(Math.sin(degToRad(piece.pitchDeg))) * piece.length) / 2;
    lowest = Math.min(lowest, piece.y - bankDrop - pitchDrop - FACE_THICKNESS);
  }
  return lowest;
}

/**
 * Builds a playable world from a free map: every placed piece, the start pad,
 * and the boss cylinder, plus the `GameCourse` slice the game loop reads.
 *
 * Caller is responsible for clearing the collider registry first when
 * `colliders` is true — this function only ever adds.
 */
export function buildFreeWorld(map: FreeMap, colliders = true): FreeWorld {
  const group = new Group();
  const stages: CourseStage[] = [];

  const spawnTop = new Vector3(map.spawn.x, map.spawn.y, map.spawn.z);
  // Stage 0 is the start pad, because `Game.restart` puts the player on the
  // course's spawn point and `Game`'s fall recovery falls back to stage 0 until
  // a later checkpoint is touched.
  const spawnPad = buildSpawnPad(map.spawn, colliders);
  group.add(spawnPad.group);
  stages.push(spawnPad.stage);

  for (const piece of map.pieces) {
    const pieceGroup = buildPiece(piece, { colliders });
    group.add(pieceGroup);
    if (piece.kind === 'platform') {
      // Pads double as checkpoints, in placement order. That ordering is the
      // whole reason the editor appends rather than inserts: a player who falls
      // is put back on the last pad they actually stood on, so the order only
      // has to be *an* order, not the route's order.
      stages.push({
        center: new Vector3(piece.x, piece.y, piece.z),
        halfWidth:
          (piece.width / 2) * Math.abs(Math.cos(degToRad(piece.yawDeg))) +
          (piece.length / 2) * Math.abs(Math.sin(degToRad(piece.yawDeg))),
        halfDepth:
          (piece.width / 2) * Math.abs(Math.sin(degToRad(piece.yawDeg))) +
          (piece.length / 2) * Math.abs(Math.cos(degToRad(piece.yawDeg))),
      });
    }
  }

  const bossTop = new Vector3(map.boss.x, map.boss.y, map.boss.z);
  group.add(buildBossMarker(map.boss, colliders));

  // Engagement radius: how far the furthest piece is from the boss, clamped, so
  // the boss can cover a small arena without being able to snipe across a large one.
  let furthest = 0;
  for (const piece of map.pieces) {
    furthest = Math.max(furthest, Math.hypot(piece.x - bossTop.x, piece.z - bossTop.z));
  }
  const trackRadius = Math.min(BOSS_RADIUS_MAX, Math.max(BOSS_RADIUS_MIN, furthest));

  return {
    group,
    course: {
      stages,
      spawnPoint: spawnTop.clone().add(new Vector3(0, 1.2, 0)),
      // `PlayerController` measures yaw in the mirrored convention the geometry
      // headings here do not use; negating is the conversion. See
      // `SurfCourse.playerYawDegForHeading` for why the two disagree.
      spawnYawDeg: -map.spawn.yawDeg,
      islandCenter: bossTop.clone(),
      trackY: bossTop.y,
      trackRadius,
      killPlaneY: lowestY(map) - FREE_KILL_PLANE_MARGIN,
      // The boss is the destination, not a level-10 reward: it wakes when the
      // player gets near the cylinder. Until then a free map runs like the
      // standard one — drones, XP, upgrades — so the ride there still levels
      // the player up enough to have a chance.
      bossTriggerRadius: BOSS_PILLAR_RADIUS + BOSS_TRIGGER_MARGIN,
    },
  };
}
