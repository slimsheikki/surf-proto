import {
  BufferGeometry,
  DoubleSide,
  Float32BufferAttribute,
  Group,
  Mesh,
  MeshStandardMaterial,
  Vector3,
} from 'three';
import { degToRad, radToDeg } from '../engine/MathUtils';
import { registerPrism } from '../world/Colliders';
import { computeRampFrames, RampCurveMode, RampCurveParams } from '../world/RampCurve';
import { gridCellFor, useRampTexture, uvPerUnit } from '../world/RampTexture';
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
  const material = new MeshStandardMaterial({
    color: options.color,
    roughness: options.roughness ?? FACE_ROUGHNESS,
    metalness: options.metalness ?? FACE_METALNESS,
    // The skin is one open-ish shell assembled from strips; double-sided
    // costs a little overdraw and buys immunity to any strip's winding.
    side: DoubleSide,
  });
  useRampTexture(material, options.color);
  return material;
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
  /** Direction of travel at this ring, for the collision lead-in/run-out. */
  forward: Vector3;
}

interface FaceStrip {
  rings: FaceRing[];
  thickness: number;
  /**
   * How far the *collision* runs past each end of the visible face, so a piece's
   * end planes are buried inside its neighbour instead of standing in the open.
   * See `emitStripColliders`.
   */
  pad: number;
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
function faceRings(
  params: RampCurveParams,
  mode: RampCurveMode,
  edge: FaceEdgeMode,
): { rings: FaceRing[]; pad: number } {
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
    rings.push({ high, low, ny: Math.max(frame.normal.y, 0.3), forward: frame.forward.clone() });
  }
  return { rings, pad: path.overlapPad };
}

/**
 * Collision for one face strip: the *same* triangles the skin below is lofted
 * from, each extruded straight down into a convex wedge.
 *
 * This is the whole point of the convex primitive. Collision built from
 * independent oriented boxes could never agree with a smooth curved surface:
 * each segment's end-cap stood proud of its neighbour and stopped the player
 * dead, and sinking the boxes to bury those caps only moved the error into
 * collision sitting below what you can see. Wedges cut from the visible
 * triangles share their faces exactly — a ray leaves one and enters the next
 * at the same point, with no cap between them and no gap — so what you ride
 * *is* what you see, on every ramp shape.
 */
function emitStripColliders(strip: FaceStrip): void {
  const rings = padStripEnds(strip);
  const lastQuad = rings.length - 2;
  for (let i = 0; i + 1 < rings.length; i++) {
    const a = rings[i];
    const b = rings[i + 1];
    // Same diagonal the skin uses, so collision and mesh are the same solid.
    const depth = strip.thickness / Math.max(a.ny, 0.3) + COLLIDER_UNDER_DEPTH;
    // The strip's two end caps, tagged so the controller can tell them from the
    // lateral edge walls they are otherwise identical to. See `ColliderConvex.capPlane`.
    // In (a.high, b.high, b.low) the trailing edge b.high->b.low is edge 1; in
    // (a.high, b.low, a.low) the leading edge a.low->a.high is edge 2.
    registerPrism(a.high, b.high, b.low, depth, undefined, i === lastQuad ? 1 : undefined);
    registerPrism(a.high, b.low, a.low, depth, undefined, i === 0 ? 2 : undefined);
  }
}

/**
 * Slides the first and last rings out along travel, so a piece's collision runs
 * a little past both visible ends.
 *
 * Without this, two pieces butted socket-on-socket still crack apart at the face
 * edges, because `faceRings` builds ring `i` at the segment *boundary*
 * `frames[i].start` but with that segment's *midpoint* basis — so a piece's two
 * end rings are each half an angle step off their nominal heading, and two
 * perfectly snapped neighbours meet with a full step of yaw discontinuity in the
 * width axis. On the shipped course that opens a triangular notch, nil at the
 * ridge and 0.19 at the low edge, at every curved join.
 *
 * A notch is not merely a hole to fall through. The far side of it is the next
 * piece's leading edge, and `registerPrism` builds that as an *exactly vertical*
 * plane pointing backwards along travel — so a sweep sample that crosses the gap
 * strikes it head-on and `clipVelocity` deletes the player's entire forward
 * component. That is the dead stop, and it is the same failure that end-caps
 * caused between box segments before collision moved to welded wedges.
 *
 * `computeRampFrames` has always computed the right number for this
 * (`overlapPad`, sized to the daylight half a step of rotation opens across the
 * face) and the box builder has always used it. The prism path simply never
 * picked it up. This is also, exactly, what real surf mapping does: the CS2
 * guide's curved-ramp method slides the clip edges "so that the faces overlap
 * once".
 *
 * Mesh geometry is untouched — this is collision only, so nothing visibly
 * lengthens. The trade is that collision reaches `pad` (~0.41 at the stock width
 * 18 / 2 deg step, under half a player width) past a free-standing exit, which
 * costs a sliver of airtime off the end of a chain and is the cheaper side of
 * this bargain by a wide margin.
 */
function padStripEnds(strip: FaceStrip): FaceRing[] {
  const rings = strip.rings;
  if (rings.length < 2) return rings;

  // `overlapPad` is zero for a single-segment piece, and a straight-to-straight
  // butt joint still cracks by a few thousandths from float noise at map-scale
  // coordinates — which is *worse* than a wide one, because a hit closer than
  // `SKIN_WIDTH` yields exactly zero progress and burns a bump for nothing.
  const pad = Math.max(strip.pad, MIN_JOIN_PAD);

  const first = rings[0];
  const last = rings[rings.length - 1];
  const padded = rings.slice();

  padded[0] = slideRing(first, -pad);
  // A taper that runs out to a point (pyramid faces, `endWidth: 0`) has a
  // degenerate last ring; sliding it past the apex would invert the triangles.
  if (last.high.distanceToSquared(last.low) > 1e-6) {
    padded[padded.length - 1] = slideRing(last, pad);
  }
  return padded;
}

/**
 * Moves a ring along its own travel direction, both edges together, so the
 * extension stays in that segment's face plane and adds no lip of its own.
 */
function slideRing(ring: FaceRing, distance: number): FaceRing {
  return {
    high: ring.high.clone().addScaledVector(ring.forward, distance),
    low: ring.low.clone().addScaledVector(ring.forward, distance),
    ny: ring.ny,
    forward: ring.forward,
  };
}

/**
 * Floor on the lead-in, for pieces whose own `overlapPad` is zero — every
 * single-segment piece, i.e. every straight. 0.05 (2.25 hu) is far below
 * anything a player can perceive and comfortably above both the 2-decimal
 * rounding the shipped map stores its coordinates at and `SKIN_WIDTH`.
 */
const MIN_JOIN_PAD = 0.05;

/**
 * Extra depth under a face's own thickness. The visible slab is thin, and a
 * thin collider is fine for a ray sweep — but it leaves the player's lateral
 * sample points, which are spread horizontally and so sit *below* a banked
 * surface, dangling under the volume. Carrying the wedges deeper keeps those
 * samples inside solid geometry, where `sweep` knows to ignore them.
 */
const COLLIDER_UNDER_DEPTH = 1.5;

type UV = readonly [number, number];

/**
 * Texture coordinates for one face strip, in the strip's own surface metric
 * rather than in world space.
 *
 * This is the whole reason the ramps can carry a grid at all. A world-space
 * projection is the cheap answer, but a surf face is a wall banked 51 deg, so
 * every projection plane is oblique to it and the grid arrives on the one
 * surface the player spends the entire ride looking at stretched by 1/cos of
 * the bank. Measuring along the face instead — real distance down the path,
 * real distance across it — puts square cells on every piece whatever its
 * bank, pitch, sweep or taper, and makes tiling exact at every seam because
 * adjacent quads share both the vertex and the number.
 *
 * - `across[i]` is the *half* width at ring `i`: the high edge is at `-across`
 *   and the low edge at `+across`, so the grid is centred on the path and a
 *   taper closes symmetrically onto its apex instead of sliding sideways.
 * - `along[i]` accumulates centreline distance. Centreline, not per-edge,
 *   because a curve's outer edge is longer than its inner one: accumulating
 *   separately would keep texel density perfect but fan the cross-lines out of
 *   parallel, and on a grid the fanning is the thing you notice.
 * - `drop[i]` is the vertical distance to the under-side, for the side walls
 *   and end caps to continue into.
 *
 * All three are already in UV units, at the piece's fitted cell size.
 */
function stripUv(strip: FaceStrip): { across: number[]; along: number[]; drop: number[] } {
  const widths = strip.rings.map((ring) => ring.high.distanceTo(ring.low));
  const k = uvPerUnit(gridCellFor(Math.max(...widths)));

  const across = widths.map((width) => (width / 2) * k);
  const drop = strip.rings.map((ring) => (strip.thickness / ring.ny) * k);

  const centre = (i: number) =>
    strip.rings[i].high.clone().add(strip.rings[i].low).multiplyScalar(0.5);
  const along = [0];
  for (let i = 1; i < strip.rings.length; i++) {
    along.push(along[i - 1] + centre(i).distanceTo(centre(i - 1)) * k);
  }

  return { across, along, drop };
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
  const uvs: number[] = [];
  const quad = (
    a: Vector3, ua: UV,
    b: Vector3, ub: UV,
    c: Vector3, uc: UV,
    d: Vector3, ud: UV,
  ) => {
    positions.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
    positions.push(a.x, a.y, a.z, c.x, c.y, c.z, d.x, d.y, d.z);
    uvs.push(ua[0], ua[1], ub[0], ub[1], uc[0], uc[1]);
    uvs.push(ua[0], ua[1], uc[0], uc[1], ud[0], ud[1]);
  };

  for (const strip of strips) {
    const bottoms = strip.rings.map((ring) => ({
      high: ring.high.clone().setY(ring.high.y - strip.thickness / ring.ny),
      low: ring.low.clone().setY(ring.low.y - strip.thickness / ring.ny),
    }));
    const { across, along, drop } = stripUv(strip);

    for (let i = 0; i + 1 < strip.rings.length; i++) {
      const a = strip.rings[i];
      const b = strip.rings[i + 1];
      const ab = bottoms[i];
      const bb = bottoms[i + 1];
      // top surface
      quad(a.high, [-across[i], along[i]], b.high, [-across[i + 1], along[i + 1]],
           b.low, [across[i + 1], along[i + 1]], a.low, [across[i], along[i]]);
      // under-side — the same across/along as the surface directly above it
      quad(ab.low, [across[i], along[i]], bb.low, [across[i + 1], along[i + 1]],
           bb.high, [-across[i + 1], along[i + 1]], ab.high, [-across[i], along[i]]);
      // high-edge wall, running on down past the surface's own high edge
      quad(a.high, [-across[i], along[i]], ab.high, [-across[i] - drop[i], along[i]],
           bb.high, [-across[i + 1] - drop[i + 1], along[i + 1]], b.high, [-across[i + 1], along[i + 1]]);
      // low-edge wall, likewise past the low edge
      quad(a.low, [across[i], along[i]], b.low, [across[i + 1], along[i + 1]],
           bb.low, [across[i + 1] + drop[i + 1], along[i + 1]], ab.low, [across[i] + drop[i], along[i]]);
    }
    const first = strip.rings[0];
    const firstB = bottoms[0];
    const n = strip.rings.length - 1;
    const last = strip.rings[n];
    const lastB = bottoms[n];
    // entry cap — continues *backwards* along travel off the leading edge
    quad(first.high, [-across[0], along[0]], first.low, [across[0], along[0]],
         firstB.low, [across[0], along[0] - drop[0]], firstB.high, [-across[0], along[0] - drop[0]]);
    // exit cap — forwards off the trailing edge
    quad(last.high, [-across[n], along[n]], lastB.high, [-across[n], along[n] + drop[n]],
         lastB.low, [across[n], along[n] + drop[n]], last.low, [across[n], along[n]]);
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new Float32BufferAttribute(uvs, 2));
  geometry.computeVertexNormals();
  return geometry;
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
      strips.push({ ...faceRings(face.params, 'straight', 'centre'), thickness: COMPOSITE_THICKNESS });
    }
  } else if (def.variant === 'full' || def.variant === 'inverted' || def.family === 'slide') {
    const { entry } = piecePath(piece);
    const edge: FaceEdgeMode = def.variant === 'full' ? 'ridge' : 'valley';
    for (const sign of [1, -1]) {
      const params = centreParams(piece, entry);
      params.rollDeg = Math.abs(piece.rollDeg) * sign;
      strips.push({ ...faceRings(params, mode, edge), thickness: COMPOSITE_THICKNESS });
    }
  } else {
    const params = centreParams(piece, piecePath(piece).entry);
    strips.push({ ...faceRings(params, mode, 'centre'), thickness: FACE_THICKNESS });
  }

  // Mesh and collision are now built from the *same* strips: one lofted skin
  // to look at, the identical triangles extruded into welded wedges to ride.
  // Every construction that used to reconcile a box chain with a smooth
  // surface -- shingle sinks, circumscribed widths, ridge miters and ridge
  // overlaps, per-seam pads -- is gone with the boxes that needed it.
  if (options.colliders) for (const strip of strips) emitStripColliders(strip);

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
