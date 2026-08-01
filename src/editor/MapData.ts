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

/**
 * Free-mode map format.
 *
 * Bumped whenever a stored map would be misread by the current loader; the
 * loader drops anything it does not recognise rather than guessing, because a
 * half-understood map is a map the player falls out of.
 */
export const FREE_MAP_VERSION = 1;

/**
 * Palette entry a piece was spawned from. Purely a template identifier — every
 * dimension is stored on the piece itself, so editing a palette preset later
 * never silently reshapes maps already saved.
 */
export type PieceKind = 'surf' | 'descent' | 'short' | 'platform';

/**
 * One placed piece.
 *
 * `x/y/z` is the **centre of the surfable face's centreline**, not the leading
 * edge `RampCurve` takes and not the box centre. That choice is what makes the
 * editor's drag behave: a user dragging a ramp expects it to pivot and settle
 * about the middle of the thing they can see, and rotation about any other
 * anchor swings the piece out from under the cursor. `FreeCourse` steps back
 * half a length along travel to recover the leading edge at build time.
 *
 * For a `platform` the same point is the centre of its *top* surface, so a pad
 * and a ramp both sit at the height you can see them at.
 */
export interface FreePiece {
  id: string;
  kind: PieceKind;
  x: number;
  y: number;
  z: number;
  /** Heading, in the `SurfCourse.forwardXZ` convention: yaw 0 travels toward -Z. */
  yawDeg: number;
  /** Descent along travel. 0 for a level ramp; positive drops. */
  pitchDeg: number;
  /**
   * Bank about the direction of travel. The sign is what makes a channel: two
   * facing pieces need opposite signs. 0 is a floor, not a surf ramp.
   */
  rollDeg: number;
  length: number;
  width: number;
}

export interface FreeMap {
  version: number;
  name: string;
  /** Start pad. Always present, never deletable — a map with no spawn is unplayable. */
  spawn: { x: number; y: number; z: number; yawDeg: number };
  /** Top-surface centre of the boss cylinder: the goal every free map runs toward. */
  boss: { x: number; y: number; z: number };
  pieces: FreePiece[];
}

export interface PalettePreset {
  kind: PieceKind;
  /** Stable id used as the drag payload and the palette element's `data-preset`. */
  id: string;
  label: string;
  hint: string;
  pitchDeg: number;
  rollDeg: number;
  length: number;
  width: number;
}

/**
 * What the side panel offers. Deliberately short: every preset here is a shape
 * that already works in the standard course, so a map assembled purely by
 * dragging is a map made of known-rideable parts. Anything finer — bank, pitch,
 * heading — is a keyboard nudge on the selected piece.
 *
 * Both banks of the plain surf ramp are offered even though `B` flips one into
 * the other, because a channel is the first thing anyone builds and having to
 * discover a key to make one is a bad first minute.
 */
export const PALETTE: PalettePreset[] = [
  {
    kind: 'surf',
    id: 'surf-left',
    label: 'Surf ramp ◤',
    hint: `${RAMP_LENGTH} long · banks left`,
    pitchDeg: 0,
    rollDeg: FACE_ANGLE_DEG,
    length: RAMP_LENGTH,
    width: RAMP_FACE_WIDTH,
  },
  {
    kind: 'surf',
    id: 'surf-right',
    label: 'Surf ramp ◥',
    hint: `${RAMP_LENGTH} long · banks right`,
    pitchDeg: 0,
    rollDeg: -FACE_ANGLE_DEG,
    length: RAMP_LENGTH,
    width: RAMP_FACE_WIDTH,
  },
  {
    kind: 'descent',
    id: 'descent-left',
    label: 'Descent ◤',
    hint: `${APPROACH_DESCENT_PITCH_DEG}° drop · gains speed`,
    pitchDeg: APPROACH_DESCENT_PITCH_DEG,
    rollDeg: FACE_ANGLE_DEG,
    length: 33,
    width: RAMP_FACE_WIDTH,
  },
  {
    kind: 'descent',
    id: 'descent-right',
    label: 'Descent ◥',
    hint: `${APPROACH_DESCENT_PITCH_DEG}° drop · gains speed`,
    pitchDeg: APPROACH_DESCENT_PITCH_DEG,
    rollDeg: -FACE_ANGLE_DEG,
    length: 33,
    width: RAMP_FACE_WIDTH,
  },
  {
    kind: 'short',
    id: 'short-left',
    label: 'Short ramp ◤',
    hint: '26 long · tight corners',
    pitchDeg: 0,
    rollDeg: FACE_ANGLE_DEG,
    length: 26,
    width: RAMP_FACE_WIDTH,
  },
  {
    kind: 'platform',
    id: 'platform',
    label: 'Checkpoint pad',
    hint: 'Flat · respawn point',
    pitchDeg: 0,
    rollDeg: 0,
    length: PLATFORM_DEPTH,
    width: 14,
  },
];

export function findPreset(id: string): PalettePreset | undefined {
  return PALETTE.find((preset) => preset.id === id);
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

export function pieceFromPreset(preset: PalettePreset, x: number, y: number, z: number, yawDeg = 0): FreePiece {
  return {
    id: newPieceId(),
    kind: preset.kind,
    x,
    y,
    z,
    yawDeg,
    pitchDeg: preset.pitchDeg,
    rollDeg: preset.rollDeg,
    length: preset.length,
    width: preset.width,
  };
}

/** Deep copy, so an edit to the live map can never write through to a stored one. */
export function cloneMap(map: FreeMap): FreeMap {
  return {
    version: map.version,
    name: map.name,
    spawn: { ...map.spawn },
    boss: { ...map.boss },
    pieces: map.pieces.map((piece) => ({ ...piece })),
  };
}

function num(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

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
  if (num(data.version, 0) !== FREE_MAP_VERSION) return null;
  if (!Array.isArray(data.pieces)) return null;

  const spawn = (data.spawn ?? {}) as Record<string, unknown>;
  const boss = (data.boss ?? {}) as Record<string, unknown>;

  const pieces: FreePiece[] = [];
  for (const entry of data.pieces) {
    if (typeof entry !== 'object' || entry === null) continue;
    const piece = entry as Record<string, unknown>;
    const kind = piece.kind;
    if (kind !== 'surf' && kind !== 'descent' && kind !== 'short' && kind !== 'platform') continue;
    pieces.push({
      id: newPieceId(),
      kind,
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
    });
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
      kind: 'descent',
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
    kind: 'surf',
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
