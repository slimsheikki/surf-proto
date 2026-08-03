import {
  APPROACH_DESCENT_PITCH_DEG,
  APPROACH_STAIR_DROP,
  APPROACH_STAIR_GAP,
  APPROACH_STAIR_LATERAL,
  FACE_ANGLE_DEG,
  FACE_SIN,
  PLATFORM_DEPTH,
  PLATFORM_OUTWARD_OFFSET,
  PLATFORM_TOP_ABOVE_FACE,
  RAMP_FACE_WIDTH,
  RAMP_LENGTH,
} from '../world/SurfCourse';
import { degToRad } from '../engine/MathUtils';
import { defFor } from './RampLibrary';

/**
 * Free-mode map format.
 *
 * Version 2 is the modular-library format: pieces reference a `RampDefinition`
 * id and may carry curve/taper parameters, and a map may carry the spline its
 * ramps were generated from. Version 1 maps (pre-library) are still parsed —
 * every v1 piece was a single straight banked face, which is exactly the
 * library's `straight-half`, so the upgrade is lossless.
 */
export const FREE_MAP_VERSION = 2;

/**
 * One placed piece.
 *
 * `def` names the `RampDefinition` this piece was spawned from; the family and
 * variant (half face, A-frame, channel...) live there. Every dimension is
 * stored on the piece itself, so editing a library default later never
 * silently reshapes maps already saved.
 *
 * `x/y/z` is the **midpoint of the piece's centre path**, not the leading edge
 * `RampCurve` takes and not a box centre. That choice is what makes the
 * editor's drag behave: a user dragging a ramp expects it to pivot and settle
 * about the middle of the thing they can see, and rotation about any other
 * anchor swings the piece out from under the cursor. `RampLibrary.piecePath`
 * walks the path to recover the entry point at build time.
 *
 * For a `platform` the same point is the centre of its *top* surface, so a pad
 * and a ramp both sit at the height you can see them at.
 */
export interface FreePiece {
  id: string;
  /** `RampDefinition` id, or `platform`. */
  def: string;
  x: number;
  y: number;
  z: number;
  /** Heading, in the `SurfCourse.forwardXZ` convention: yaw 0 travels toward -Z. */
  yawDeg: number;
  /** Descent along travel. 0 for a level ramp; positive drops. */
  pitchDeg: number;
  /**
   * Bank about the direction of travel. The sign is what makes a channel: two
   * facing pieces need opposite signs. 0 is a floor, not a surf ramp. For
   * full/inverted composites the sign is ignored — they are symmetric.
   */
  rollDeg: number;
  length: number;
  width: number;
  /** Width at the far end (trapezoid/pyramid taper). Constant when absent. */
  endWidth?: number;
  /** Total yaw swept along the piece (horizontal curve). Straight when absent. */
  yawSweepDeg?: number;
  /** Pitch at the far end (vertical curve). Constant pitch when absent. */
  endPitchDeg?: number;
}

export interface FreeMap {
  version: number;
  name: string;
  /** Start pad. Always present, never deletable — a map with no spawn is unplayable. */
  spawn: { x: number; y: number; z: number; yawDeg: number };
  /** Top-surface centre of the boss cylinder: the goal every free map runs toward. */
  boss: { x: number; y: number; z: number };
  pieces: FreePiece[];
  /**
   * Control points of the design spline, if the map has one. The spline is a
   * guide, not geometry — it generates and regenerates library pieces in the
   * editor and is ignored entirely by the play-mode builder.
   */
  spline?: { x: number; y: number; z: number }[];
}

/**
 * Ids only have to be unique within one editing session — they are never
 * compared across maps and never persisted as references. A counter is enough,
 * and unlike a random id it makes a saved map diffable.
 */
let nextPieceId = 1;

export function newPieceId(): string {
  return `p${nextPieceId++}`;
}

/** Deep copy, so an edit to the live map can never write through to a stored one. */
export function cloneMap(map: FreeMap): FreeMap {
  return {
    version: map.version,
    name: map.name,
    spawn: { ...map.spawn },
    boss: { ...map.boss },
    pieces: map.pieces.map((piece) => ({ ...piece })),
    spline: map.spline?.map((point) => ({ ...point })),
  };
}

function num(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** Optional numeric field: absent stays absent, anything non-finite is dropped. */
function optNum(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** v1 stored a `kind` per piece; each maps onto exactly one library definition. */
const V1_KIND_TO_DEF: Record<string, string> = {
  surf: 'straight-half',
  descent: 'straight-descent',
  short: 'straight-half',
  platform: 'platform',
};

/**
 * Rebuilds a map from whatever came out of storage, field by field.
 *
 * Nothing here trusts the input: a stored map is user-writable (it is plain
 * localStorage) and a single NaN coordinate reaching `RampCurve` produces a
 * collider whose slab test never terminates a sweep, which reads to the player
 * as the level silently swallowing them. Returns null rather than a
 * best-effort map when the shape is wrong outright.
 */
export function parseMap(raw: unknown): FreeMap | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const data = raw as Record<string, unknown>;
  const version = num(data.version, 0);
  if (version !== 1 && version !== FREE_MAP_VERSION) return null;
  if (!Array.isArray(data.pieces)) return null;

  const spawn = (data.spawn ?? {}) as Record<string, unknown>;
  const boss = (data.boss ?? {}) as Record<string, unknown>;

  const pieces: FreePiece[] = [];
  for (const entry of data.pieces) {
    if (typeof entry !== 'object' || entry === null) continue;
    const piece = entry as Record<string, unknown>;

    // v1 pieces name a kind; v2 pieces name a definition. Either way the id is
    // validated against the live library — `defFor` falls back to the basic
    // straight face rather than dropping the piece, so a map from a newer build
    // with an unknown family degrades to something rideable instead of a hole.
    let defId: string;
    if (version === 1) {
      const mapped = typeof piece.kind === 'string' ? V1_KIND_TO_DEF[piece.kind] : undefined;
      if (!mapped) continue;
      defId = mapped;
    } else {
      defId = typeof piece.def === 'string' ? defFor(piece.def).id : 'straight-half';
    }

    pieces.push({
      id: newPieceId(),
      def: defId,
      x: num(piece.x, 0),
      y: num(piece.y, 0),
      z: num(piece.z, 0),
      yawDeg: num(piece.yawDeg, 0),
      pitchDeg: num(piece.pitchDeg, 0),
      rollDeg: num(piece.rollDeg, 0),
      // A zero-extent piece would build a degenerate box; clamp rather than drop
      // the piece, so a corrupted number costs the player a resize and not a ramp.
      length: Math.max(2, num(piece.length, RAMP_LENGTH)),
      width: Math.max(2, num(piece.width, RAMP_FACE_WIDTH)),
      endWidth: optNum(piece.endWidth),
      yawSweepDeg: optNum(piece.yawSweepDeg),
      endPitchDeg: optNum(piece.endPitchDeg),
    });
  }

  let spline: FreeMap['spline'];
  if (Array.isArray(data.spline)) {
    spline = [];
    for (const entry of data.spline) {
      if (typeof entry !== 'object' || entry === null) continue;
      const point = entry as Record<string, unknown>;
      spline.push({ x: num(point.x, 0), y: num(point.y, 0), z: num(point.z, 0) });
    }
    if (spline.length === 0) spline = undefined;
  }

  return {
    version: FREE_MAP_VERSION,
    name: typeof data.name === 'string' && data.name.trim() ? data.name : 'Untitled',
    spawn: {
      x: num(spawn.x, 0),
      y: num(spawn.y, 60),
      z: num(spawn.z, 150),
      yawDeg: num(spawn.yawDeg, 0),
    },
    boss: { x: num(boss.x, 0), y: num(boss.y, 0), z: num(boss.z, 0) },
    pieces,
    spline,
  };
}

/**
 * The map a player sees the first time they open free mode: a start pad, a
 * two-face alternating descent, a level straight, and the boss cylinder at the
 * end of it.
 *
 * Generated rather than hand-typed, from the same rules the standard course's
 * approach follows — alternating bank, a lateral stagger toward the drift, a
 * step down per gap. That matters more than it looks: the starter map is the
 * only worked example of a rideable chain the player ever gets, so if its
 * numbers drift out of agreement with the real approach it teaches a shape that
 * does not work.
 */
export function createStarterMap(): FreeMap {
  const yawDeg = 0; // Travels toward -Z.
  const pieces: FreePiece[] = [];

  const pitch = degToRad(APPROACH_DESCENT_PITCH_DEG);
  const descentLength = 33;
  const descentRun = descentLength * Math.cos(pitch);
  const descentDrop = descentLength * Math.sin(pitch);

  // Leading edge of the first face. Everything else is chained off it.
  let x = 0;
  let y = 62;
  let z = 150;
  let bankSign = 1;

  for (let face = 0; face < 2; face++) {
    pieces.push({
      id: newPieceId(),
      def: 'straight-descent',
      // Centre, not leading edge — see `FreePiece`.
      x,
      y: y - descentDrop / 2,
      z: z - descentRun / 2,
      yawDeg,
      pitchDeg: APPROACH_DESCENT_PITCH_DEG,
      rollDeg: FACE_ANGLE_DEG * bankSign,
      length: descentLength,
      width: RAMP_FACE_WIDTH,
    });

    // Advance to the next leading edge: past this face, across the gap, one
    // stair-drop lower, and staggered toward the side the player drifts off.
    z -= descentRun + APPROACH_STAIR_GAP;
    y -= descentDrop + APPROACH_STAIR_DROP;
    x += APPROACH_STAIR_LATERAL * bankSign;
    bankSign = -bankSign;
  }

  const straightLength = 70;
  pieces.push({
    id: newPieceId(),
    def: 'straight-half',
    x,
    y,
    z: z - straightLength / 2,
    yawDeg,
    pitchDeg: 0,
    rollDeg: FACE_ANGLE_DEG * bankSign,
    length: straightLength,
    width: RAMP_FACE_WIDTH,
  });
  z -= straightLength;

  // Start pad: `PLATFORM_TOP_ABOVE_FACE` over the first face's centreline and
  // pushed toward its high edge, so the player steps onto the upper part of the
  // slope with the whole face beneath them rather than into its high side.
  // High side of a `+roll` face on this heading is -X (see `faceHighSideXZ`).
  return {
    version: FREE_MAP_VERSION,
    name: 'Starter run',
    spawn: {
      x: -PLATFORM_OUTWARD_OFFSET,
      y: 62 + PLATFORM_TOP_ABOVE_FACE,
      z: 150 + PLATFORM_DEPTH / 2,
      yawDeg,
    },
    // Boss cylinder past the end of the straight, level with it: the last face
    // hands the player out over open air with the goal dead ahead.
    boss: { x, y: y - FACE_SIN * (RAMP_FACE_WIDTH / 2), z: z - 60 },
    pieces,
  };
}
