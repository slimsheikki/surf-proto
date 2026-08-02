import { CatmullRomCurve3, Vector3 } from 'three';
import { radToDeg } from '../engine/MathUtils';
import { FACE_ANGLE_DEG, RAMP_FACE_WIDTH } from '../world/SurfCourse';
import { forwardFromAngles } from '../world/RampCurve';
import { FreePiece, newPieceId } from './MapData';
import { piecePath } from './RampLibrary';

/**
 * The spline-to-ramps generator: the editor's design spline is a *path
 * planner*, never geometry. This module reads the guide curve and assembles
 * pieces from the modular library to recreate it — straights where it runs
 * straight, horizontal curves where it bends, vertical curves where its slope
 * changes — and the output is ordinary `FreePiece`s the player can then move,
 * retune or delete by hand.
 *
 * The chain is exact even where the spline is only approximated: each piece is
 * placed on the previous piece's exit socket (`RampLibrary.piecePath`), with
 * the same small gap the standard course leaves between ring ramps, so
 * whatever the guide does the result is rideable. The spline positions the
 * chain; the sockets connect it.
 */

/** Target arc length of one generated piece, and the floor a tight bend can shrink it to. */
const CHORD = 34;
const MIN_CHORD = 16;
/** Bends flatter than this are absorbed into a straight; the eye cannot see 5° over 34 units. */
const STRAIGHT_MAX_SWEEP_DEG = 6;
/** One piece never turns more than this; a tighter bend becomes several pieces. */
const MAX_SWEEP_DEG = 70;
/** Slope change that earns a vertical-curved transition rather than a pitched straight. */
const VCURVE_MIN_DELTA_DEG = 12;
const MAX_PITCH_DEG = 32;
/** Gap between consecutive generated pieces — the ring leaves 6.55; lower here because generated chains include curves. */
const PIECE_GAP = 3;
/** Runaway guard: a pathological spline stops producing rather than hanging the editor. */
const MAX_PIECES = 200;

/** Heading of a horizontal direction in the `forwardXZ` convention (yaw 0 = -Z). */
function yawOfDir(dir: Vector3): number {
  return radToDeg(Math.atan2(dir.x, -dir.z));
}

function wrapDeg(deg: number): number {
  return ((deg + 180) % 360 + 360) % 360 - 180;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Assembles library pieces along a guide spline. Returns new pieces with fresh
 * ids; the caller owns removing the previous generation.
 */
export function generatePiecesFromSpline(points: { x: number; y: number; z: number }[]): FreePiece[] {
  if (points.length < 2) return [];

  const curve = new CatmullRomCurve3(
    points.map((p) => new Vector3(p.x, p.y, p.z)),
    false,
    'catmullrom',
    0.5,
  );
  const total = curve.getLength();
  if (total < MIN_CHORD) return [];

  // Equal-arc samples every ~2 units: fine enough that a chord's endpoints land
  // within a unit of the true curve, coarse enough to stay instant on edit.
  const sampleStep = 2;
  const samples = curve.getSpacedPoints(Math.max(2, Math.round(total / sampleStep)));
  const step = total / (samples.length - 1);

  const pieces: FreePiece[] = [];

  // The chain's live cursor: where the next piece's entry socket must land.
  let chainPos: Vector3 | null = null;
  let chainYaw = 0;
  let chainPitch = 0;
  let rollSign = 1;

  let i = 0;
  while (i < samples.length - Math.ceil(MIN_CHORD / step) && pieces.length < MAX_PIECES) {
    const remaining = (samples.length - 1 - i) * step;
    let chordLen = Math.min(CHORD, remaining);

    let a = samples[i];
    let m = samples[Math.min(i + Math.round(chordLen / 2 / step), samples.length - 1)];
    let b = samples[Math.min(i + Math.round(chordLen / step), samples.length - 1)];

    if (chainPos === null) {
      chainPos = a.clone();
      chainYaw = yawOfDir(new Vector3().subVectors(m, a));
    }

    // Sweep this chord asks of the chain: from the chain's current heading to
    // the chord's exit heading. Halve the chord when the ask is too tight, so
    // a hairpin becomes several moderate curves instead of one illegal one.
    let exitYaw = yawOfDir(new Vector3().subVectors(b, m));
    let sweep = wrapDeg(exitYaw - chainYaw);
    while (Math.abs(sweep) > MAX_SWEEP_DEG && chordLen > MIN_CHORD) {
      chordLen = Math.max(MIN_CHORD, chordLen / 2);
      m = samples[Math.min(i + Math.round(chordLen / 2 / step), samples.length - 1)];
      b = samples[Math.min(i + Math.round(chordLen / step), samples.length - 1)];
      exitYaw = yawOfDir(new Vector3().subVectors(b, m));
      sweep = wrapDeg(exitYaw - chainYaw);
    }
    sweep = clamp(sweep, -MAX_SWEEP_DEG, MAX_SWEEP_DEG);

    // Slope the chord wants, positive descending — `forward.y = -sin(pitch)`.
    const targetPitch = clamp(
      radToDeg(Math.asin(clamp(-(b.y - a.y) / chordLen, -1, 1))),
      -MAX_PITCH_DEG,
      MAX_PITCH_DEG,
    );

    const straightEnough = Math.abs(sweep) < STRAIGHT_MAX_SWEEP_DEG;
    const pitchJump = Math.abs(targetPitch - chainPitch) >= VCURVE_MIN_DELTA_DEG;

    const piece: FreePiece = {
      id: newPieceId(),
      def: 'straight-half',
      x: 0,
      y: 0,
      z: 0,
      yawDeg: chainYaw,
      pitchDeg: chainPitch,
      rollDeg: FACE_ANGLE_DEG * rollSign,
      length: chordLen,
      width: RAMP_FACE_WIDTH,
    };

    if (!straightEnough) {
      // Bank into the turn: positive sweep turns left, and positive roll banks
      // the downhill side left, so the high edge lands on the outside.
      piece.def = sweep >= 0 ? 'horizontal-curved-half-l' : 'horizontal-curved-half-r';
      piece.yawSweepDeg = sweep;
      piece.pitchDeg = targetPitch;
      rollSign = Math.sign(sweep) || rollSign;
      piece.rollDeg = FACE_ANGLE_DEG * rollSign;
    } else if (pitchJump) {
      piece.def = 'vertical-curved-half';
      piece.endPitchDeg = targetPitch;
    } else {
      piece.pitchDeg = targetPitch;
    }

    // Land the piece's entry socket on the chain cursor: `piecePath` at the
    // origin reports where the entry sits relative to the stored midpoint, so
    // the midpoint to store is the cursor minus that offset.
    const atOrigin = piecePath(piece);
    piece.x = chainPos.x - atOrigin.entry.x;
    piece.y = chainPos.y - atOrigin.entry.y;
    piece.z = chainPos.z - atOrigin.entry.z;

    const placed = piecePath(piece);
    pieces.push(piece);

    chainYaw = placed.endYawDeg;
    chainPitch = placed.endPitchDeg;
    chainPos = placed.end.addScaledVector(forwardFromAngles(chainYaw, chainPitch), PIECE_GAP);

    i += Math.max(1, Math.round((chordLen + PIECE_GAP) / step));
  }

  return pieces;
}
