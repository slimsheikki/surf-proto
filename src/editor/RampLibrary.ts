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
import { computeRampFrames, RampCurveMode, RampCurveParams, RampFrame } from '../world/RampCurve';
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
  | 'halfpipe'
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
 * Half-pipe cross-section: two mirrored circular arcs meeting at the bottom of
 * the centre path — a **half-round pipe**, the concrete drainage kind, laid on
 * its back and ridden inside.
 *
 * **The trough is walkable, and that is a deliberate, human-made call.** A
 * semicircle's bottom is horizontal: `normal.y` there is 1.0 against the 0.7
 * standable cutoff, so a player who arrives slowly grounds out and can walk
 * `2R·sin(45.573°) = 1.429·R` of floor — **12.9 units at the shipped width**.
 * Everything past that band is steeper than the cutoff and surfs normally, so
 * a rider carrying speed pendulums across it without ever touching down; it is
 * the slow arrival that stands up.
 *
 * An earlier build truncated the arc at 50° to make that impossible. It was
 * unimpeachable against the invariant and it read as a **V**, which is not the
 * shape this piece exists to be. Rounding it back out is the shape winning the
 * argument, knowingly. If the standable floor ever proves to be the problem in
 * play, raising this one constant off 0 walks the bottom back out of reach —
 * at 50° nothing on the piece is standable, and it looks like a V again.
 */
const HALFPIPE_THETA_MIN_DEG = 0;
/**
 * The rim, and the limit here is collision rather than looks. A prism's solid
 * thickness is `depth · cos θ`, so a wall approaching vertical thins toward
 * nothing and a fast player would pass straight through it. 84° keeps the
 * thinnest facet at 0.51 units against a 0.4 player radius; 88° drops it to
 * 0.32 and 90° — a truly vertical rim — is exactly zero.
 *
 * Stopping 6° short costs almost nothing to look at: depth/mouth lands at
 * 0.450 against a true semicircle's 0.500.
 */
const HALFPIPE_THETA_MAX_DEG = 84;
/**
 * Facets per wall. Twelve puts each facet 7° apart, which is what keeps the
 * seams from catching: the movement clip loop treats two planes within
 * `acos(0.99) = 8.11°` as one surface and bails with the already-clipped
 * velocity, instead of resolving every seam as a two-plane wedge event.
 *
 * The cost is texture density. These chords are 1.10 units against a 2.84 grid
 * cell, so `gridCellFor` fits one cell per facet and the pipe wears a grid
 * about 0.39× the size of the one on a straight ramp beside it. Unavoidable
 * for a small-radius arc cut fine enough to read as round, and cosmetic.
 */
const HALFPIPE_STRIPS_PER_WALL = 12;
/**
 * Vertical shell drop, one value for the whole section — see
 * `FaceStrip.verticalDrop`. With `COLLIDER_UNDER_DEPTH` on top it keeps every
 * prism's solid thickness between 3.09 under the trough and 0.51 at the rim,
 * never under the 0.4 player radius, and reads like the rest of the kit
 * (`FACE_THICKNESS` is 1.4).
 */
const HALFPIPE_SHELL_DROP = 1.6;
/**
 * Degrees of pitch per segment *along* a curved pipe, against the kit's usual 2.
 *
 * Every other family carries one or two strips, so subdividing its length every
 * 2° costs two prisms a step. A pipe carries 24, so the same step would put
 * **1296 prisms on a single descending piece** — 38% again on top of the whole
 * default course, and the collider broadphase is a linear scan. At 6° it is
 * 432.
 *
 * Free to look at and free to ride. The along-length sagitta at 6° is 0.09
 * units against a 0.4 player radius, and 6° is under the same
 * `acos(0.99) = 8.11°` the cross-section is cut to — so the movement clip loop
 * still reads consecutive segments as one surface and nothing catches.
 */
const HALFPIPE_ANGLE_STEP_DEG = 6;
/**
 * The descending pipe's profile. Positive pitch descends, so this drops
 * steeply, eases through level and finishes tilted *back up* by
 * `EXIT_PITCH` — a slight ramp off the end rather than a nose into the floor.
 *
 * 53° of total swing at `HALFPIPE_ANGLE_STEP_DEG` is 9 segments, so the piece
 * costs 432 prisms against a straight pipe's 48. That is the most expensive
 * thing in the kit by some way (a curved A-frame is 92) — worth knowing before
 * a map is paved with them.
 */
const HALFPIPE_DESCENT_LENGTH = 60;
const HALFPIPE_DESCENT_PITCH_DEG = 45;
const HALFPIPE_DESCENT_EXIT_PITCH_DEG = -8;
/**
 * Mouth opening across, which fixes the radius at `width / (2·sin θmax)`. The
 * kit's standard face width, so a pipe reads as the same gauge of piece as the
 * ramps it chains with. Depth follows at 0.450 × this.
 */
const HALFPIPE_WIDTH = RAMP_FACE_WIDTH;

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
  // The three half-pipes differ in length and nothing else, and they must stay
  // adjacent: `EditorUi.buildPalette` starts a new heading whenever the family
  // changes between consecutive entries, so splitting them emits the heading
  // three times. The length is in the label because it cannot be in the tile —
  // `Thumbnails` frames each definition to its own bounds, so all three render
  // identically.
  {
    id: 'halfpipe-short',
    family: 'halfpipe',
    variant: 'inverted',
    label: 'Halfpipe · short',
    hint: '30 long · half-round pipe',
    defaults: { length: 30, width: HALFPIPE_WIDTH, rollDeg: 0, pitchDeg: 0 },
  },
  {
    id: 'halfpipe-medium',
    family: 'halfpipe',
    variant: 'inverted',
    label: 'Halfpipe · medium',
    hint: `${RAMP_LENGTH} long · half-round pipe`,
    defaults: { length: RAMP_LENGTH, width: HALFPIPE_WIDTH, rollDeg: 0, pitchDeg: 0 },
  },
  {
    id: 'halfpipe-long',
    family: 'halfpipe',
    variant: 'inverted',
    label: 'Halfpipe · long',
    hint: '80 long · half-round pipe',
    defaults: { length: 80, width: HALFPIPE_WIDTH, rollDeg: 0, pitchDeg: 0 },
  },
  {
    id: 'halfpipe-descent',
    family: 'halfpipe',
    variant: 'inverted',
    label: 'Halfpipe · descent',
    hint: 'Drops steeply, eases out, kicks up at the exit',
    // Same section as the straight pipes; only the *path* curves. The pitch
    // runs from a steep drop to a shallow climb, and `computeRampFrames`
    // interpolates it linearly along the length — so the profile is a steep
    // entry that keeps easing, passes through level, and finishes tilted back
    // up. The exit kick is what hands a rider air off the end instead of
    // spitting them at the floor.
    //
    // 45° of entry rather than the editor's 50° clamp so there is somewhere
    // left to nudge it with `T`.
    defaults: {
      length: HALFPIPE_DESCENT_LENGTH,
      width: HALFPIPE_WIDTH,
      rollDeg: 0,
      pitchDeg: HALFPIPE_DESCENT_PITCH_DEG,
      endPitchDeg: HALFPIPE_DESCENT_EXIT_PITCH_DEG,
    },
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

/**
 * Centre-path curve params for a piece whose entry point is `start`.
 *
 * The segment step is decided here rather than at any one call site because
 * `piecePath` and the mesh/collider walk both go through this: hand them
 * different steps and a curved piece discretises two different ways, its
 * midpoint lands somewhere else, and the geometry sits off the position the
 * editor is showing you.
 */
function centreParams(piece: FreePiece, start: Vector3): RampCurveParams {
  return {
    start,
    angleStepDeg:
      defFor(piece.def).family === 'halfpipe' ? HALFPIPE_ANGLE_STEP_DEG : undefined,
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
}

interface FaceStrip {
  rings: FaceRing[];
  thickness: number;
  /**
   * Overrides the per-ring `thickness / ny` under-side drop with one vertical
   * distance for the whole strip.
   *
   * Every family but the half-pipe is built from strips of *equal* tilt — the
   * mirrored ±roll pairs are symmetric — so each picks the same drop and their
   * under-sides and end caps land flush. A curved cross-section is deliberately
   * unequal: across a half-pipe wall `thickness / ny` runs 0.82 to 2.31, which
   * would staircase the under-side and the entry/exit caps at every interior
   * seam and leave the redundant interior wall quads at mismatched lengths,
   * z-fighting in the open. One drop for the whole section keeps them flush and
   * makes those quads exactly coincident — buried between two solids, so
   * invisible.
   */
  verticalDrop?: number;
}

/** The under-side offset for a strip: its override, or the per-ring default. */
function ringDrop(strip: FaceStrip, ring: FaceRing): number {
  return strip.verticalDrop ?? strip.thickness / ring.ny;
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
  for (let i = 0; i + 1 < strip.rings.length; i++) {
    const a = strip.rings[i];
    const b = strip.rings[i + 1];
    // Same diagonal the skin uses, so collision and mesh are the same solid.
    const depth = (strip.verticalDrop ?? strip.thickness / Math.max(a.ny, 0.3)) + COLLIDER_UNDER_DEPTH;
    registerPrism(a.high, b.high, b.low, depth);
    registerPrism(a.high, b.low, a.low, depth);
  }
}

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
  const drop = strip.rings.map((ring) => ringDrop(strip, ring) * k);

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
      high: ring.high.clone().setY(ring.high.y - ringDrop(strip, ring)),
      low: ring.low.clone().setY(ring.low.y - ringDrop(strip, ring)),
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
 * Arc radius that puts the mouth's across-extent at exactly `width`.
 *
 * Written against both ends of the arc rather than just the rim so it stays
 * correct if `HALFPIPE_THETA_MIN_DEG` is ever lifted off the bottom — see the
 * note there. At θmin = 0 the `sin` term is 0 and this is `width / 2·sin θmax`.
 */
function halfpipeRadius(width: number): number {
  return (
    width /
    (2 * (Math.sin(degToRad(HALFPIPE_THETA_MAX_DEG)) - Math.sin(degToRad(HALFPIPE_THETA_MIN_DEG))))
  );
}

/**
 * The half-pipe's strips: two mirrored arcs, `HALFPIPE_STRIPS_PER_WALL` facets
 * each, walking the same frames every other family walks.
 *
 * The section is built in the **un-rolled** basis. Roll never moves path
 * positions — it only rotates `right`/`normal` about `forward` — so forcing it
 * to zero leaves the sockets, `piecePath` and any chain snapped to them
 * byte-identical, and buys a basis where `right.y` is exactly 0 and the arc
 * maths stays closed-form. The arc *is* the bank: tipping a pipe rolls one
 * wall down toward flat and the other up past vertical, where its collider
 * thins to nothing. Pitch is fine and does the useful thing — it tilts the
 * whole run of the pipe without touching the section. `pyramidFaceParams`
 * ignores `rollDeg` for the same reason.
 *
 * Both walls' innermost ring sits exactly on the path point, so the crease
 * closes by construction rather than by tolerance — the same property the V
 * channel relies on.
 */
function halfpipeStrips(piece: FreePiece): FaceStrip[] {
  const params = centreParams(piece, piecePath(piece).entry);
  params.rollDeg = 0;

  const path = computeRampFrames(params, pieceMode(piece));
  const frames = path.frames;
  const count = frames.length;

  const radius = halfpipeRadius(piece.width);
  const inner0 = degToRad(HALFPIPE_THETA_MIN_DEG);
  const outer0 = degToRad(HALFPIPE_THETA_MAX_DEG);
  const step = (outer0 - inner0) / HALFPIPE_STRIPS_PER_WALL;
  const cosMin = Math.cos(inner0);
  const sinMin = Math.sin(inner0);

  const point = (frame: RampFrame, position: Vector3, wall: number, theta: number) =>
    position
      .clone()
      .addScaledVector(frame.normal, radius * (cosMin - Math.cos(theta)))
      .addScaledVector(frame.right, wall * radius * (Math.sin(theta) - sinMin));

  const strips: FaceStrip[] = [];
  for (const wall of [1, -1]) {
    for (let s = 0; s < HALFPIPE_STRIPS_PER_WALL; s++) {
      const inner = inner0 + step * s;
      const outer = inner + step;
      const rings: FaceRing[] = [];
      // Same ring/frame pairing `faceRings` uses: the closing ring reuses the
      // last segment's basis rather than inventing one past the end.
      for (let i = 0; i <= count; i++) {
        const frame = frames[Math.min(i, count - 1)];
        const position = i < count ? frames[i].start : path.end;
        rings.push({
          low: point(frame, position, wall, inner),
          high: point(frame, position, wall, outer),
          // cos(pitch)·cos(theta), exact because `right.y` is 0 here. Inert
          // while `verticalDrop` is set, but kept true so the ring contract
          // still holds if that override is ever dropped.
          ny: Math.max(frame.normal.y * Math.cos((inner + outer) / 2), 0.3),
        });
      }
      strips.push({ rings, thickness: COMPOSITE_THICKNESS, verticalDrop: HALFPIPE_SHELL_DROP });
    }
  }
  return strips;
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

  // Checked by family, and *before* the variant test below: a half-pipe is
  // stored as an `inverted` variant, so falling through would build it as a
  // plain V channel — placing, snapping, saving and playing without a single
  // error to say it had.
  if (def.family === 'halfpipe') {
    strips.push(...halfpipeStrips(piece));
  } else if (def.family === 'pyramid') {
    for (const face of pyramidFaceParams(piece)) {
      strips.push({ rings: faceRings(face.params, 'straight', 'centre'), thickness: COMPOSITE_THICKNESS });
    }
  } else if (def.variant === 'full' || def.variant === 'inverted' || def.family === 'slide') {
    const { entry } = piecePath(piece);
    const edge: FaceEdgeMode = def.variant === 'full' ? 'ridge' : 'valley';
    for (const sign of [1, -1]) {
      const params = centreParams(piece, entry);
      params.rollDeg = Math.abs(piece.rollDeg) * sign;
      strips.push({ rings: faceRings(params, mode, edge), thickness: COMPOSITE_THICKNESS });
    }
  } else {
    const params = centreParams(piece, piecePath(piece).entry);
    strips.push({ rings: faceRings(params, mode, 'centre'), thickness: FACE_THICKNESS });
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
