import { Group, Vector3 } from 'three';
import { degToRad } from '../engine/MathUtils';
import {
  buildRampCurve,
  computeRampFrames,
  forwardFromAngles,
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
 * spec's "mirror whenever practical" — and *practical* has a precise meaning
 * here: the two faces of a composite are parallel copies of the centre path,
 * which is only exact while the path is straight and the width constant. A
 * horizontally curved Full would need the inner face's arc shortened to stay
 * concentric, and a tapered Full would need converging face paths; both are
 * real geometry problems, not plumbing, so curved and tapered families ship
 * Half-only rather than shipping wrong.
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
    id: 'pyramid-half',
    family: 'pyramid',
    variant: 'half',
    label: 'Pyramid · half',
    hint: 'Narrows to a point — bail or jump',
    defaults: {
      length: RAMP_LENGTH,
      width: RAMP_FACE_WIDTH * 1.6,
      endWidth: 2,
      rollDeg: FACE_ANGLE_DEG,
      pitchDeg: 0,
    },
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

/**
 * Centreline offsets of a definition's faces, relative to the piece's centre
 * path, at the entry basis. One face (offset zero) for half/single pieces; two
 * mirrored faces for full and inverted composites.
 *
 * The offset is derived with real vectors rather than trig-by-hand: take the
 * face's rolled `right` axis, find which way is up-slope, and step the
 * centreline half a width down from the ridge (full) or up from the valley
 * (inverted). Doing it this way keeps every sign correct for free — the same
 * reason `RampCurve.basisFromForward` builds its basis from cross products.
 */
function facesFor(piece: FreePiece): { rollDeg: number; offset: Vector3 }[] {
  const def = defFor(piece.def);
  if (def.variant !== 'full' && def.variant !== 'inverted' && def.family !== 'slide') {
    return [{ rollDeg: piece.rollDeg, offset: new Vector3() }];
  }

  const forward = forwardFromAngles(piece.yawDeg, piece.pitchDeg);
  const right = new Vector3().crossVectors(WORLD_UP, forward).normalize();
  const halfWidth = piece.width / 2;
  const faces: { rollDeg: number; offset: Vector3 }[] = [];

  for (const sign of [1, -1]) {
    const rollDeg = Math.abs(piece.rollDeg) * sign;
    const rolledRight = right.clone().applyAxisAngle(forward, degToRad(rollDeg));
    const highDir = rolledRight.y >= 0 ? rolledRight : rolledRight.clone().negate();
    // A slide is an inverted (valley) composite with its own proportions.
    const towardCentre = def.variant === 'full' ? -1 : 1;
    faces.push({ rollDeg, offset: highDir.multiplyScalar(halfWidth * towardCentre) });
  }
  return faces;
}

export interface RampBuildOptions {
  colliders: boolean;
  color: number;
  roughness?: number;
  metalness?: number;
}

/**
 * Meshes (and optionally colliders) for one library piece, in world space —
 * one `buildRampCurve` run per face. Platforms are not built here; they are a
 * pad, not a ramp, and `FreeCourse` owns pads.
 */
export function buildRampPiece(piece: FreePiece, options: RampBuildOptions): Group {
  const group = new Group();
  const { entry } = piecePath(piece);
  const mode = pieceMode(piece);

  for (const face of facesFor(piece)) {
    const params = centreParams(piece, entry.clone().add(face.offset));
    params.rollDeg = face.rollDeg;
    params.color = options.color;
    params.roughness = options.roughness ?? FACE_ROUGHNESS;
    params.metalness = options.metalness ?? FACE_METALNESS;
    params.guideWalls = false;
    params.registerColliders = options.colliders;
    group.add(buildRampCurve(params, mode).group);
  }
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
