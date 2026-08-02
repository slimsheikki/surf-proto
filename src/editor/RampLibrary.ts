import {
  BufferGeometry,
  DoubleSide,
  Float32BufferAttribute,
  Group,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  Quaternion,
  Vector3,
} from 'three';
import { degToRad, radToDeg } from '../engine/MathUtils';
import { registerCollider } from '../world/Colliders';
import { computeRampFrames, RampCurveMode, RampCurveParams } from '../world/RampCurve';
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
    // The skin is one open-ish shell assembled from strips; double-sided
    // costs a little overdraw and buys immunity to any strip's winding.
    side: DoubleSide,
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

/**
 * One face of a piece, described by its surface edges: a pair of edge points
 * per path boundary plus the surface normal's up-component there. The visual
 * skin is lofted between these rings, and the collision boxes are placed
 * against the same frames — both come from one `computeRampFrames` walk, so
 * they cannot disagree beyond the box discretisation.
 */
interface FaceRing {
  high: Vector3;
  low: Vector3;
  /** Surface normal's y at this ring, for the vertical under-side drop. */
  ny: number;
}

interface FaceStrip {
  rings: FaceRing[];
  thickness: number;
}

type FaceEdgeMode = 'centre' | 'ridge' | 'valley';

/**
 * Walks a face's path and returns its boundary rings. `edge` says where the
 * path runs on the face: down the middle (half faces, pyramid faces), along
 * the high edge (`ridge` — A-frame faces hang down from it), or along the low
 * edge (`valley` — channel faces rise from it). Widths interpolate linearly
 * across boundaries, which is what makes a taper a straight-edged triangle
 * instead of a staircase.
 */
function faceRings(params: RampCurveParams, mode: RampCurveMode, edge: FaceEdgeMode): FaceRing[] {
  const path = computeRampFrames(params, mode);
  const frames = path.frames;
  const count = frames.length;
  const endWidth = params.endWidth ?? params.width;

  const rings: FaceRing[] = [];
  for (let i = 0; i <= count; i++) {
    const frame = frames[Math.min(i, count - 1)];
    const position = i < count ? frames[i].start : path.end;
    const width = params.width + (endWidth - params.width) * (i / count);
    const highDir = frame.right.y >= 0 ? frame.right.clone() : frame.right.clone().negate();

    let high: Vector3;
    let low: Vector3;
    if (edge === 'ridge') {
      high = position.clone();
      low = position.clone().addScaledVector(highDir, -width);
    } else if (edge === 'valley') {
      low = position.clone();
      high = position.clone().addScaledVector(highDir, width);
    } else {
      high = position.clone().addScaledVector(highDir, width / 2);
      low = position.clone().addScaledVector(highDir, -width / 2);
    }
    rings.push({ high, low, ny: Math.max(frame.normal.y, 0.3) });
  }
  return rings;
}

/**
 * Lofts face strips into one watertight `BufferGeometry`: top surface, an
 * under-side offset **vertically** below it, and side/end walls. The vertical
 * drop is the load-bearing choice — where two faces meet (a ridge, a valley,
 * a pyramid hip or apex) their shared edge points drop to the same place, so
 * the skins meet exactly instead of the old stepped boxes' crossings and
 * hairline seams. Flat-shaded on purpose: each quad is a real facet of the
 * collision surface, and smooth normals would lie about where the box edges
 * are.
 */
function skinGeometry(strips: FaceStrip[]): BufferGeometry {
  const positions: number[] = [];
  const quad = (a: Vector3, b: Vector3, c: Vector3, d: Vector3) => {
    positions.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
    positions.push(a.x, a.y, a.z, c.x, c.y, c.z, d.x, d.y, d.z);
  };

  for (const strip of strips) {
    const bottoms = strip.rings.map((ring) => ({
      high: ring.high.clone().setY(ring.high.y - strip.thickness / ring.ny),
      low: ring.low.clone().setY(ring.low.y - strip.thickness / ring.ny),
    }));

    for (let i = 0; i + 1 < strip.rings.length; i++) {
      const a = strip.rings[i];
      const b = strip.rings[i + 1];
      const ab = bottoms[i];
      const bb = bottoms[i + 1];
      quad(a.high, b.high, b.low, a.low); // top surface
      quad(ab.low, bb.low, bb.high, ab.high); // under-side
      quad(a.high, ab.high, bb.high, b.high); // high-edge wall
      quad(a.low, b.low, bb.low, ab.low); // low-edge wall
    }
    const first = strip.rings[0];
    const firstB = bottoms[0];
    const last = strip.rings[strip.rings.length - 1];
    const lastB = bottoms[bottoms.length - 1];
    quad(first.high, first.low, firstB.low, firstB.high); // entry cap
    quad(last.high, lastB.high, lastB.low, last.low); // exit cap
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  return geometry;
}

/**
 * Collision boxes for one face path: the stepped-box run the sweep engine
 * needs. Two discretisation rules, both audit-driven — the visible skin is
 * smooth and the boxes are not, and every divergence is something the player
 * feels:
 *
 * - **Inscribed widths.** A tapered segment's box takes the *narrower* of its
 *   two boundary widths, so collision never reaches past the visible edge.
 *   Boxes at the segments' midpoint width overhung the taper by up to 1.4
 *   units — an invisible ledge the player could stand on beyond the visible
 *   ramp. The cost runs the other way: up to half a width-step of visible
 *   edge is unbacked, which reads as sliding off the edge marginally early.
 * - **Shingled seams.** On a *banked* curve, consecutive segments' lateral
 *   axes are not parallel — the frame rotates about the world-horizontal (or
 *   vertical) axis while the face is rolled away from it — so a segment's
 *   leading end-cap lands skewed across its predecessor's trailing edge and
 *   pokes above that surface. The sweep hits that end-cap head-on and
 *   `clipVelocity` deletes the whole forward component: the player simply
 *   stops dead, mid-ramp. Boxes therefore overlap **forward only** and each
 *   is sunk along its own normal by however much its leading edge would
 *   otherwise rise above the previous surface, so every seam is a step *down*
 *   in the direction of travel and nothing is ever a wall. The cost is a
 *   shallow, monotone drift of collision below the visible surface — at the
 *   2 deg segment step it totals well under 0.1 across a whole curve.
 *
 * The shingle is directional, like the pieces themselves: it guarantees a
 * smooth ride along the piece's travel direction, not against it.
 */
/** Clearance added per seam so the leading edge is strictly under, not merely level. */
const SHINGLE_EPSILON = 0.002;
function emitFaceColliders(
  params: RampCurveParams,
  mode: RampCurveMode,
  thickness: number,
  surfaceOffsetAlongHighDir: number,
  widthBonus = 0,
): void {
  const path = computeRampFrames(params, mode);
  const count = path.frames.length;
  const endWidth = params.endWidth ?? params.width;

  /** Top-surface centre of segment `i`, before its shingle offset. */
  const surfaceCentre = (i: number): Vector3 => {
    const frame = path.frames[i];
    const highDir = frame.right.y >= 0 ? frame.right.clone() : frame.right.clone().negate();
    return frame.mid.clone().addScaledVector(highDir, surfaceOffsetAlongHighDir);
  };

  // Shingle offsets: how far each segment is sunk along its own normal so its
  // leading edge never rises above the previous segment's surface. See the
  // block comment above for why a raw chain leaves a wall there.
  const sink: number[] = [0];
  for (let i = 1; i < count; i++) {
    const prev = path.frames[i - 1];
    const here = path.frames[i];
    const planePoint = surfaceCentre(i - 1).addScaledVector(prev.normal, -sink[i - 1]);
    const leadCentre = surfaceCentre(i)
      .addScaledVector(here.forward, -here.length / 2)
      .addScaledVector(here.normal, -sink[i - 1]);

    // Worst corner of this segment's leading edge, measured against the plane
    // the previous segment's top surface lies in.
    let worst = 0;
    for (const t of [-here.width / 2, here.width / 2]) {
      const corner = leadCentre.clone().addScaledVector(here.right, t);
      worst = Math.max(worst, corner.sub(planePoint).dot(prev.normal));
    }
    const alignment = Math.max(0.2, here.normal.dot(prev.normal));
    sink[i] = sink[i - 1] + Math.max(0, worst / alignment) + SHINGLE_EPSILON;
  }

  path.frames.forEach((frame, i) => {
    // Circumscribed width: the *wider* of the segment's two boundaries, so a
    // taper's collision covers every point of the visible face. Inscribed
    // widths (the previous choice, to avoid an invisible ledge) left crescent
    // holes at each width step; the player riding the low edge dropped through
    // one, fell below the surface, and was then stopped dead by the next
    // segment's end-cap. A hole that drops you is far worse than a hand's
    // width of collision past a visible edge — at one unit of width per
    // segment that overhang is at most 0.5.
    const widthA = params.width + (endWidth - params.width) * (i / count);
    const widthB = params.width + (endWidth - params.width) * ((i + 1) / count);
    const boxWidth = Math.max(0.5, Math.max(widthA, widthB)) + widthBonus;

    // Forward-only overlap: a box may reach over the seam ahead of it, never
    // back over the one behind it. Reaching backward is what puts a box's
    // leading end-cap above its predecessor's surface.
    const padForward = i === count - 1 ? 0 : path.overlapPad;
    const boxLength = frame.length + padForward;

    const highDir = frame.right.y >= 0 ? frame.right.clone() : frame.right.clone().negate();
    const center = frame.mid
      .clone()
      .addScaledVector(highDir, surfaceOffsetAlongHighDir)
      .addScaledVector(frame.normal, -sink[i] - thickness / 2)
      .addScaledVector(frame.forward, padForward / 2);
    const quaternion = new Quaternion().setFromRotationMatrix(
      new Matrix4().makeBasis(frame.right, frame.normal, frame.forward),
    );
    registerCollider({
      position: center,
      quaternion,
      halfExtents: new Vector3(boxWidth / 2, thickness / 2, boxLength / 2),
    });
  });
}

/** Faces steeper than the walkable cutoff so the pyramid is surfable, with margin. */
const PYRAMID_SLOPE_DEG = 55;

/**
 * The four faces of a pyramid: rectangular base centred on the piece position
 * (which is base height), apex above the centre, each face built along its
 * fall line (base-edge midpoint to apex). The *visual* taper runs to exactly
 * zero width over the full slant, so the face edges are the hip lines and all
 * four skins share the apex point — a mathematically exact pyramid. The
 * *collision* run keeps a small apex inset so opposite faces' boxes meet
 * flush instead of crossing; the sub-visual difference is a hand's width at
 * the tip of a spike nobody rides.
 */
function pyramidFaceParams(piece: FreePiece): { params: RampCurveParams; colliderLength: number }[] {
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

  return sides.map((side) => {
    const toApex = apex.clone().sub(side.mid);
    const slant = toApex.length();
    const horizontal = Math.hypot(toApex.x, toApex.z);
    // Ascending pitch is negative in this convention: `forward.y = -sin(pitch)`.
    const facePitchDeg = -radToDeg(Math.atan2(toApex.y, horizontal));
    const faceYawDeg = radToDeg(Math.atan2(toApex.x, -toApex.z));
    const apexInset = COMPOSITE_THICKNESS * Math.tan(degToRad(Math.abs(facePitchDeg))) + 0.02;

    return {
      params: {
        start: side.mid,
        startYawDeg: faceYawDeg,
        startPitchDeg: facePitchDeg,
        length: slant,
        width: side.edgeLen,
        endWidth: 0,
        thickness: COMPOSITE_THICKNESS,
      },
      colliderLength: Math.max(2, slant - apexInset),
    };
  });
}

/**
 * Meshes (and optionally colliders) for one library piece, in world space.
 *
 * The visible piece is **one watertight mesh**: every face is lofted into a
 * single `BufferGeometry` by `skinGeometry`, so there are no stepped-box
 * seams, no gaps and no overlapping shells anywhere on a piece. Collision is
 * emitted separately as the oriented-box runs the sweep engine requires —
 * from the same frame walk, so the box tops are exact chords of the visible
 * surface. Platforms are not built here; they are a pad, not a ramp, and
 * `FreeCourse` owns pads.
 */
export function buildRampPiece(piece: FreePiece, options: RampBuildOptions): Group {
  const group = new Group();
  const def = defFor(piece.def);
  const mode = pieceMode(piece);
  const strips: FaceStrip[] = [];

  if (def.family === 'pyramid') {
    for (const face of pyramidFaceParams(piece)) {
      strips.push({ rings: faceRings(face.params, 'straight', 'centre'), thickness: COMPOSITE_THICKNESS });
      if (options.colliders) {
        emitFaceColliders({ ...face.params, length: face.colliderLength }, 'straight', COMPOSITE_THICKNESS, 0);
      }
    }
  } else if (def.variant === 'full' || def.variant === 'inverted' || def.family === 'slide') {
    const { entry } = piecePath(piece);
    const isRidge = def.variant === 'full';
    const edge: FaceEdgeMode = isRidge ? 'ridge' : 'valley';
    const towardCentre = isRidge ? -1 : 1;

    /**
     * An A-frame's ridge is **convex**, so each face's collision is widened to
     * reach slightly *past* the ridge: the overshoot descends below the
     * opposite face's surface, where it can never be touched, and in exchange
     * the ridge line itself is solid. The previous construction did the
     * opposite — it held each face short of the ridge so their slabs would not
     * cross — which left an uncovered slit exactly along the peak, and a
     * player tracking the ridge dropped into it and was stopped by the next
     * segment's end-cap. A valley needs none of this: there the two faces
     * already meet on the path and their slabs cross harmlessly underneath.
     */
    const ridgeOverlap = isRidge ? COMPOSITE_THICKNESS * 2 : 0;

    for (const sign of [1, -1]) {
      const params = centreParams(piece, entry);
      params.rollDeg = Math.abs(piece.rollDeg) * sign;
      strips.push({ rings: faceRings(params, mode, edge), thickness: COMPOSITE_THICKNESS });
      if (options.colliders) {
        emitFaceColliders(
          params,
          mode,
          COMPOSITE_THICKNESS,
          (params.width / 2) * towardCentre + (ridgeOverlap / 2) * -towardCentre,
          ridgeOverlap,
        );
      }
    }
  } else {
    const params = centreParams(piece, piecePath(piece).entry);
    strips.push({ rings: faceRings(params, mode, 'centre'), thickness: FACE_THICKNESS });
    if (options.colliders) emitFaceColliders(params, mode, FACE_THICKNESS, 0);
  }

  const mesh = new Mesh(skinGeometry(strips), faceMaterial(options));
  group.add(mesh);
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
