import {
  BoxGeometry,
  Group,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  Quaternion,
  Vector3,
} from 'three';
import { degToRad, radToDeg } from '../engine/MathUtils';
import { registerCollider } from '../world/Colliders';
import {
  buildRampCurve,
  computeRampFrames,
  RampCurveMode,
  RampCurveParams,
} from '../world/RampCurve';
import {
  APPROACH_DESCENT_PITCH_DEG,
  FACE_ANGLE_DEG,
  FACE_METALNESS,
  FACE_ROUGHNESS,
  FACE_THICKNESS,
  PLATFORM_DEPTH,
  RAMP_FACE_WIDTH,
  RAMP_LENGTH,
} from '../world/SurfCourse';
import type { FreePiece } from './MapData';

const WORLD_UP = new Vector3(0, 1, 0);

/**
 * The modular ramp kit the free-map editor is built from, following the CS2
 * surf-mapping taxonomy (docs/CS2_SURF_MAPPING.md): ramp *families* in Half /
 * Full / Inverted *variants*, every piece parameterised by dimensions rather
 * than modelled, every piece exposing entry/exit sockets so pieces snap into
 * chains.
 *
 * The vocabulary, translated to this game's geometry:
 *
 * - **Half** — a single banked face. Every piece the old editor had was one.
 * - **Full** — two faces meeting at a top ridge (an A-frame): surfable on
 *   either side, high edges touching over the piece's centreline.
 * - **Inverted** — two faces forming a V channel: the low edges meet at the
 *   centreline and the player rides the inside. This is the shape every surf
 *   map opens with, so it existing as *one* palette entry matters.
 *
 * Full and Inverted are generated from the Half face by mirroring, per the
 * spec's "mirror whenever practical". The composite emitter offsets each face
 * from the centre path **per segment frame**, along that frame's own rolled
 * basis — so the ridge (or valley) coincides with the centre path exactly, by
 * construction, on straight, vertically curved and horizontally curved paths
 * alike. Pyramids are the one family built differently: each triangular face
 * runs along its own fall line (base-edge midpoint to apex) with zero roll,
 * which keeps every stepped box of the taper coplanar — a smooth face rather
 * than a staircase.
 */
export type RampFamily =
  | 'straight'
  | 'trapezoid'
  | 'reverse-trapezoid'
  | 'pyramid'
  | 'slide'
  | 'vertical-curved'
  | 'horizontal-curved'
  | 'platform';

export type RampVariant = 'half' | 'full' | 'inverted' | 'single';

export interface RampDefinition {
  /** Stable id — stored in maps, so renaming one is a format change. */
  id: string;
  family: RampFamily;
  variant: RampVariant;
  label: string;
  /** One-line palette hint. */
  hint: string;
  /** Dimension defaults a palette drop starts from; all editable per piece. */
  defaults: {
    length: number;
    width: number;
    rollDeg: number;
    pitchDeg: number;
    endWidth?: number;
    yawSweepDeg?: number;
    endPitchDeg?: number;
  };
}

/** Slide channel: narrower and steeper than a surf face — a luge, not a wall. */
const SLIDE_WIDTH = 8;
const SLIDE_ROLL_DEG = 62;
const SLIDE_LENGTH = 40;

/**
 * The library itself: data, not code. The palette, the spline generator and
 * the piece builder all read this list, so adding a family is adding an entry
 * (and, if it needs new geometry, a case in `facesFor`).
 */
export const RAMP_LIBRARY: RampDefinition[] = [
  {
    id: 'straight-half',
    family: 'straight',
    variant: 'half',
    label: 'Straight · half',
    hint: `${RAMP_LENGTH} long · one banked face`,
    defaults: { length: RAMP_LENGTH, width: RAMP_FACE_WIDTH, rollDeg: FACE_ANGLE_DEG, pitchDeg: 0 },
  },
  {
    id: 'straight-full',
    family: 'straight',
    variant: 'full',
    label: 'Straight · full ⌂',
    hint: 'A-frame — surf either side',
    defaults: { length: RAMP_LENGTH, width: RAMP_FACE_WIDTH, rollDeg: FACE_ANGLE_DEG, pitchDeg: 0 },
  },
  {
    id: 'straight-inverted',
    family: 'straight',
    variant: 'inverted',
    label: 'Straight · channel ⌄',
    hint: 'V channel — the classic opener',
    defaults: { length: RAMP_LENGTH, width: RAMP_FACE_WIDTH, rollDeg: FACE_ANGLE_DEG, pitchDeg: 0 },
  },
  {
    id: 'straight-descent',
    family: 'straight',
    variant: 'half',
    label: 'Descent · half',
    hint: `${APPROACH_DESCENT_PITCH_DEG}° drop · gains speed`,
    defaults: {
      length: 33,
      width: RAMP_FACE_WIDTH,
      rollDeg: FACE_ANGLE_DEG,
      pitchDeg: APPROACH_DESCENT_PITCH_DEG,
    },
  },
  {
    id: 'trapezoid-half',
    family: 'trapezoid',
    variant: 'half',
    label: 'Trapezoid · widening',
    hint: 'Face widens along its length',
    defaults: {
      length: RAMP_LENGTH,
      width: RAMP_FACE_WIDTH,
      endWidth: RAMP_FACE_WIDTH * 1.8,
      rollDeg: FACE_ANGLE_DEG,
      pitchDeg: 0,
    },
  },
  {
    id: 'reverse-trapezoid-half',
    family: 'reverse-trapezoid',
    variant: 'half',
    label: 'Rev-trapezoid · narrowing',
    hint: 'Face narrows — a precision check',
    defaults: {
      length: RAMP_LENGTH,
      width: RAMP_FACE_WIDTH * 1.8,
      endWidth: RAMP_FACE_WIDTH,
      rollDeg: FACE_ANGLE_DEG,
      pitchDeg: 0,
    },
  },
  {
    id: 'pyramid-full',
    family: 'pyramid',
    variant: 'full',
    label: 'Pyramid',
    hint: '4 faces to an apex — surf over any side',
    // length/width are the base rectangle; apex height derives from the
    // smaller of the two, keeping the steep pair of faces at PYRAMID_SLOPE.
    defaults: { length: 24, width: 24, rollDeg: 0, pitchDeg: 0 },
  },
  {
    id: 'slide',
    family: 'slide',
    variant: 'single',
    label: 'Slide',
    hint: 'Steep narrow chute — a luge',
    defaults: { length: SLIDE_LENGTH, width: SLIDE_WIDTH, rollDeg: SLIDE_ROLL_DEG, pitchDeg: 8 },
  },
  {
    id: 'vertical-curved-half',
    family: 'vertical-curved',
    variant: 'half',
    label: 'Vertical curve · dive',
    hint: 'Eases level into a descent',
    defaults: {
      length: RAMP_LENGTH,
      width: RAMP_FACE_WIDTH,
      rollDeg: FACE_ANGLE_DEG,
      pitchDeg: 0,
      endPitchDeg: APPROACH_DESCENT_PITCH_DEG,
    },
  },
  {
    id: 'vertical-curved-full',
    family: 'vertical-curved',
    variant: 'full',
    label: 'Vertical curve · full ⌂',
    hint: 'A-frame diving into a descent',
    defaults: {
      length: RAMP_LENGTH,
      width: RAMP_FACE_WIDTH,
      rollDeg: FACE_ANGLE_DEG,
      pitchDeg: 0,
      endPitchDeg: APPROACH_DESCENT_PITCH_DEG,
    },
  },
  {
    id: 'vertical-curved-inverted',
    family: 'vertical-curved',
    variant: 'inverted',
    label: 'Vertical curve · channel ⌄',
    hint: 'V channel diving into a descent',
    defaults: {
      length: RAMP_LENGTH,
      width: RAMP_FACE_WIDTH,
      rollDeg: FACE_ANGLE_DEG,
      pitchDeg: 0,
      endPitchDeg: APPROACH_DESCENT_PITCH_DEG,
    },
  },
  {
    id: 'horizontal-curved-half-l',
    family: 'horizontal-curved',
    variant: 'half',
    label: 'Curve · left 45°',
    hint: 'Banked into the turn',
    defaults: {
      length: RAMP_LENGTH,
      width: RAMP_FACE_WIDTH,
      rollDeg: FACE_ANGLE_DEG,
      pitchDeg: 0,
      yawSweepDeg: 45,
    },
  },
  {
    id: 'horizontal-curved-half-r',
    family: 'horizontal-curved',
    variant: 'half',
    label: 'Curve · right 45°',
    hint: 'Banked into the turn',
    defaults: {
      length: RAMP_LENGTH,
      width: RAMP_FACE_WIDTH,
      rollDeg: -FACE_ANGLE_DEG,
      pitchDeg: 0,
      yawSweepDeg: -45,
    },
  },
  {
    id: 'horizontal-curved-full',
    family: 'horizontal-curved',
    variant: 'full',
    label: 'Curve · full ⌂ 45°',
    hint: 'A-frame through a turn — B mirrors it',
    defaults: {
      length: RAMP_LENGTH,
      width: RAMP_FACE_WIDTH,
      rollDeg: FACE_ANGLE_DEG,
      pitchDeg: 0,
      yawSweepDeg: 45,
    },
  },
  {
    id: 'platform',
    family: 'platform',
    variant: 'single',
    label: 'Checkpoint pad',
    hint: 'Flat · respawn point',
    defaults: { length: PLATFORM_DEPTH, width: 14, rollDeg: 0, pitchDeg: 0 },
  },
];

const BY_ID = new Map(RAMP_LIBRARY.map((def) => [def.id, def]));

export function defFor(id: string): RampDefinition {
  return BY_ID.get(id) ?? BY_ID.get('straight-half')!;
}

/** Curve mode a piece's stored parameters imply. Sweep/endPitch win over straight. */
export function pieceMode(piece: FreePiece): RampCurveMode {
  if (piece.yawSweepDeg !== undefined && piece.yawSweepDeg !== 0) return 'horizontal';
  if (piece.endPitchDeg !== undefined && piece.endPitchDeg !== piece.pitchDeg) return 'vertical';
  return 'straight';
}

/** Centre-path curve params for a piece whose entry point is `start`. */
function centreParams(piece: FreePiece, start: Vector3): RampCurveParams {
  return {
    start,
    startYawDeg: piece.yawDeg,
    startPitchDeg: piece.pitchDeg,
    endPitchDeg: piece.endPitchDeg,
    yawSweepDeg: piece.yawSweepDeg,
    rollDeg: piece.rollDeg,
    length: piece.length,
    width: piece.width,
    endWidth: piece.endWidth,
    thickness: FACE_THICKNESS,
  };
}

export interface PiecePath {
  /** Entry point (leading-edge centreline), world space. */
  entry: Vector3;
  /** Exit point, world space, with the heading a chained piece should take. */
  end: Vector3;
  endYawDeg: number;
  endPitchDeg: number;
}

/**
 * Entry/exit sockets for a piece stored by its **path midpoint** (`x/y/z` —
 * the drag/rotate pivot, see `FreePiece`). The path is walked once from the
 * origin to find where its midpoint falls, then translated so that midpoint
 * lands on the stored position; entry and exit follow. Same frames as the
 * meshes, so a socket can never drift off the geometry it belongs to.
 */
export function piecePath(piece: FreePiece): PiecePath {
  const path = computeRampFrames(centreParams(piece, new Vector3()), pieceMode(piece));

  // Midpoint by arc length: halfway along the middle frame, which for the
  // even segment lengths computeRampFrames emits is the path's true centre.
  const midFrame = path.frames[Math.floor((path.frames.length - 1) / 2)];
  const mid =
    path.frames.length % 2 === 1
      ? midFrame.mid.clone()
      : path.frames[path.frames.length / 2].start.clone();

  const position = new Vector3(piece.x, piece.y, piece.z);
  return {
    entry: position.clone().sub(mid),
    end: position.clone().sub(mid).add(path.end),
    endYawDeg: path.endYawDeg,
    endPitchDeg: path.endPitchDeg,
  };
}

export interface RampBuildOptions {
  colliders: boolean;
  color: number;
  roughness?: number;
  metalness?: number;
}

function faceMaterial(options: RampBuildOptions): MeshStandardMaterial {
  return new MeshStandardMaterial({
    color: options.color,
    roughness: options.roughness ?? FACE_ROUGHNESS,
    metalness: options.metalness ?? FACE_METALNESS,
  });
}

/**
 * Slab thickness for composite (two-face) pieces and pyramids. Deliberately
 * thinner than the half-face `FACE_THICKNESS` (1.4): where two slabs meet at
 * an edge, everything below the surface has to be mitered away, and the miter
 * seam scales with thickness — at 1.4 the apex seam is a 2-unit trench, at
 * 0.5 it is a hairline. The player only ever touches the top surface, so the
 * collider loses nothing.
 */
const COMPOSITE_THICKNESS = 0.5;

/** One box (mesh + optional collider) from a frame's basis at an offset centre. */
function emitBox(
  group: Group,
  material: MeshStandardMaterial,
  frame: { forward: Vector3; right: Vector3; normal: Vector3; width: number; length: number },
  surfaceCenter: Vector3,
  boxLength: number,
  thickness: number,
  withColliders: boolean,
): void {
  const center = surfaceCenter.clone().addScaledVector(frame.normal, -thickness / 2);
  const quaternion = new Quaternion().setFromRotationMatrix(
    new Matrix4().makeBasis(frame.right, frame.normal, frame.forward),
  );
  const halfExtents = new Vector3(frame.width / 2, thickness / 2, boxLength / 2);
  if (withColliders) registerCollider({ position: center.clone(), quaternion: quaternion.clone(), halfExtents });

  const mesh = new Mesh(new BoxGeometry(frame.width, thickness, boxLength), material);
  mesh.position.copy(center);
  mesh.quaternion.copy(quaternion);
  group.add(mesh);
}

/**
 * Two mirrored faces around the centre path — an A-frame (`full`, ridge on the
 * path) or a V channel (`inverted`/slide, valley on the path).
 *
 * The offset is applied **per frame**, along that frame's own rolled basis:
 * each segment's high edge lands exactly on the centre path (full) or its low
 * edge does (inverted), whatever the path is doing — level, diving, or
 * sweeping through a turn. Offsetting only the entry, the first attempt, let
 * the faces splay apart along any curved path; this construction cannot,
 * because the coincidence is re-established at every segment.
 */
function buildCompositeFaces(piece: FreePiece, options: RampBuildOptions, group: Group): void {
  const def = defFor(piece.def);
  const mode = pieceMode(piece);
  const { entry } = piecePath(piece);
  const towardCentre = def.variant === 'full' ? -1 : 1;

  // Ridge miter. A face's slab extends its thickness below the surface, and
  // at the ridge that material juts sideways past the centreline — its deep
  // corner pokes up through the *other* face's surface, so the two slabs
  // visibly cross instead of meeting in an edge. Pulling each face down-slope
  // by thickness·tan(roll) puts the deep corner exactly on the ridge plane:
  // the slabs meet flush there and the apex reads as one clean edge, with a
  // hairline V-seam between the top edges. Valleys need none of this — there
  // the interpenetration is below both surfaces, where nothing can see it.
  const ridgeInset =
    def.variant === 'full'
      ? Math.min(2, COMPOSITE_THICKNESS * Math.tan(degToRad(Math.abs(piece.rollDeg)))) + 0.02
      : 0;

  for (const sign of [1, -1]) {
    const params = centreParams(piece, entry);
    params.rollDeg = Math.abs(piece.rollDeg) * sign;
    const path = computeRampFrames(params, mode);
    const material = faceMaterial(options);

    for (const frame of path.frames) {
      // The frame's `right` is already rolled; whichever way it points, its
      // up-slope end is the high edge. Same vector-first sign discipline as
      // `RampCurve.basisFromForward`.
      const highDir = frame.right.y >= 0 ? frame.right.clone() : frame.right.clone().negate();
      const surfaceCenter = frame.mid
        .clone()
        .addScaledVector(highDir, (frame.width / 2) * towardCentre - ridgeInset);
      emitBox(
        group,
        material,
        frame,
        surfaceCenter,
        frame.length + path.overlapPad,
        COMPOSITE_THICKNESS,
        options.colliders,
      );
    }
  }
}

/** Faces steeper than the walkable cutoff so the pyramid is surfable, with margin. */
const PYRAMID_SLOPE_DEG = 55;

/**
 * A true four-faced pyramid: rectangular base centred on the piece position
 * (which is base height), apex above the centre. Each triangular face is
 * built along its **fall line** — base-edge midpoint to apex — with zero roll
 * and a width taper to a point. With the path on the fall line the taper
 * stays inside one plane, so the stepped boxes are coplanar and the face is
 * smooth to ride; this is why pyramids do not go through the composite
 * emitter above.
 *
 * Apex height comes from the *smaller* base half-dimension at
 * `PYRAMID_SLOPE_DEG`, so the steep pair of faces is always surfable; stretch
 * the base far enough one way and the long pair shallows toward walkable,
 * which is a legitimate mapping choice, not a bug.
 */
function buildPyramid(piece: FreePiece, options: RampBuildOptions, group: Group): void {
  const base = new Vector3(piece.x, piece.y, piece.z);
  const halfL = piece.length / 2;
  const halfW = piece.width / 2;
  const apexHeight = Math.min(halfL, halfW) * Math.tan(degToRad(PYRAMID_SLOPE_DEG));
  const apex = base.clone().add(new Vector3(0, apexHeight, 0));

  const yaw = degToRad(piece.yawDeg);
  const forward = new Vector3(Math.sin(yaw), 0, -Math.cos(yaw));
  const right = new Vector3().crossVectors(WORLD_UP, forward).normalize();

  const sides: { mid: Vector3; edgeLen: number }[] = [
    { mid: base.clone().addScaledVector(forward, -halfL), edgeLen: piece.width },
    { mid: base.clone().addScaledVector(forward, halfL), edgeLen: piece.width },
    { mid: base.clone().addScaledVector(right, -halfW), edgeLen: piece.length },
    { mid: base.clone().addScaledVector(right, halfW), edgeLen: piece.length },
  ];

  for (const side of sides) {
    const toApex = apex.clone().sub(side.mid);
    const slant = toApex.length();
    const horizontal = Math.hypot(toApex.x, toApex.z);
    // Ascending pitch is negative in this convention: `forward.y = -sin(pitch)`.
    const facePitchDeg = -radToDeg(Math.atan2(toApex.y, horizontal));
    const faceYawDeg = radToDeg(Math.atan2(toApex.x, -toApex.z));

    // Same ridge-miter reasoning as `buildCompositeFaces`: opposite faces'
    // slabs would cross at the apex, so each face stops thickness·tan(slope)
    // short of it and the tips meet flush instead.
    const apexInset = COMPOSITE_THICKNESS * Math.tan(degToRad(Math.abs(facePitchDeg))) + 0.02;

    const path = computeRampFrames(
      {
        start: side.mid,
        startYawDeg: faceYawDeg,
        startPitchDeg: facePitchDeg,
        length: Math.max(2, slant - apexInset),
        width: side.edgeLen,
        endWidth: 0.5,
        thickness: FACE_THICKNESS,
      },
      'straight',
    );
    const material = faceMaterial(options);
    for (const frame of path.frames) {
      emitBox(
        group,
        material,
        frame,
        frame.mid,
        frame.length + path.overlapPad,
        COMPOSITE_THICKNESS,
        options.colliders,
      );
    }
  }
}

/**
 * Meshes (and optionally colliders) for one library piece, in world space.
 * Half/single faces are one `buildRampCurve` run; full/inverted composites and
 * pyramids have their own emitters above. Platforms are not built here; they
 * are a pad, not a ramp, and `FreeCourse` owns pads.
 */
export function buildRampPiece(piece: FreePiece, options: RampBuildOptions): Group {
  const group = new Group();
  const def = defFor(piece.def);

  if (def.family === 'pyramid') {
    buildPyramid(piece, options, group);
    return group;
  }
  if (def.variant === 'full' || def.variant === 'inverted' || def.family === 'slide') {
    buildCompositeFaces(piece, options, group);
    return group;
  }

  const params = centreParams(piece, piecePath(piece).entry);
  params.color = options.color;
  params.roughness = options.roughness ?? FACE_ROUGHNESS;
  params.metalness = options.metalness ?? FACE_METALNESS;
  params.guideWalls = false;
  params.registerColliders = options.colliders;
  group.add(buildRampCurve(params, pieceMode(piece)).group);
  return group;
}

/** Fresh piece from a palette definition, centred at a drop point. */
export function pieceFromDef(
  def: RampDefinition,
  id: string,
  x: number,
  y: number,
  z: number,
  yawDeg = 0,
): FreePiece {
  return {
    id,
    def: def.id,
    x,
    y,
    z,
    yawDeg,
    pitchDeg: def.defaults.pitchDeg,
    rollDeg: def.defaults.rollDeg,
    length: def.defaults.length,
    width: def.defaults.width,
    endWidth: def.defaults.endWidth,
    yawSweepDeg: def.defaults.yawSweepDeg,
    endPitchDeg: def.defaults.endPitchDeg,
  };
}
