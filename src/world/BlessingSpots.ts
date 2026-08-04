import { Vector3 } from 'three';
import { degToRad } from '../engine/MathUtils';
import type { FreeMap, FreePiece } from '../editor/MapData';
import { defFor, pieceFrames } from '../editor/RampLibrary';

/**
 * Where blessings are allowed to appear, and how they are oriented when they do.
 *
 * "Reachable" is the whole problem, and picking a random point in the sky and
 * testing it does not solve it — a point over the void passes every cheap test
 * and is still unreachable. It is solved by **construction**: every candidate is
 * derived from a ramp piece the map actually contains, hung a fixed clearance
 * above that piece's own high edge. A blessing can therefore only ever appear
 * over something the player can ride to, because the ramp under it is what put
 * it there.
 *
 * This replaces the old ring-annulus sampler, which assumed the generated
 * approach-and-ring course. A free map has no ring — on `MegaFlow Demo V1`,
 * `trackRadius` is a boss engagement radius and `islandCenter`/`trackY` are the
 * boss pillar, so sampling around them scattered blessings into empty sky. That
 * is why the shipped course had no reachable blessings at all.
 */

/**
 * How far above a piece's high edge a blessing floats.
 *
 * Far enough that the ring clears the surface and reads as something to fly up
 * *through*, close enough that carrying speed off the face is all it takes —
 * the authored ring shrines of the old course sat 8-14 above their faces, and
 * this is the same ask.
 */
const RIDE_CLEARANCE = 8;

/** Candidate spots sampled along each piece, as fractions of its length. */
const SAMPLE_FRACTIONS = [0.25, 0.5, 0.75];

/**
 * How far apart two standing blessings must be.
 *
 * The demo course spans roughly 435 x 416 units, so five blessings at this
 * separation still have room to scatter — and the player is never offered two
 * of them from one line, which is what "nowhere near each other" is protecting.
 */
const MIN_SEPARATION = 70;

/**
 * And how far from the player one may appear. Below this a blessing pops into
 * view already collected-adjacent, which reads as a freebie rather than
 * something to go and get.
 */
const MIN_PLAYER_DISTANCE = 45;

/**
 * How far a returning blessing must land from the spot it was taken from.
 *
 * Without this the pool is free to hand a slot its own anchor straight back,
 * and a blessing that reappears where it was collected reads as a fixture of
 * the map on a timer rather than something that moved. Deliberately smaller
 * than `MIN_SEPARATION`: it only has to break the *sense* of returning, and
 * making it as strict as the separation rule would thin the pool for no gain.
 */
const MIN_RETURN_DISTANCE = 55;

/**
 * What fraction of the best score an anchor must reach to be drawn from when
 * nothing is outright eligible.
 *
 * Only the fallback path uses this, and it exists because a strict argmax is a
 * *pure function of where the other blessings are*. Take one and let it come
 * back while the other four have not moved, and the same anchor wins again —
 * the exact "it respawned where it was" bug, dressed up as a scoring rule. A
 * band plus a draw keeps the graceful-degradation promise and still moves.
 * Relative rather than absolute so it stays a *near-best* band on a map with
 * real spread instead of quietly widening to the whole pool.
 */
const FALLBACK_SCORE_FRACTION = 0.8;

export interface BlessingAnchor {
  position: Vector3;
  /**
   * Ramp heading at this spot. The ring faces along it, so the natural line
   * down the ramp passes through the opening rather than across it.
   */
  forward: Vector3;
}

/**
 * How far a piece's high edge sits above its centre path.
 *
 * A banked face lifts `sin(roll) * width/2` above its centreline. A `full`
 * A-frame is the exception and the reason this is not one expression: its two
 * faces meet *over* the path, so the path already is the ridge — adding the
 * bank rise there would hang every blessing a face-height too high.
 */
function pieceTopRise(piece: FreePiece): number {
  if (defFor(piece.def).variant === 'full') return 0;
  return Math.sin(degToRad(Math.abs(piece.rollDeg))) * (piece.width / 2);
}

/**
 * Every spot on a map a blessing may occupy.
 *
 * Pyramids are skipped: their stored anchor is the base centre and their apex
 * rises by a different rule than the bank, so a clearance measured from the
 * path would put the ring inside the geometry.
 */
export function blessingAnchorsForMap(map: FreeMap): BlessingAnchor[] {
  const anchors: BlessingAnchor[] = [];

  for (const piece of map.pieces) {
    if (defFor(piece.def).family === 'pyramid') continue;

    const frames = pieceFrames(piece);
    if (frames.length === 0) continue;
    const lift = pieceTopRise(piece) + RIDE_CLEARANCE;

    for (const fraction of SAMPLE_FRACTIONS) {
      const frame = frames[Math.min(frames.length - 1, Math.floor(fraction * frames.length))];
      const forward = frame.forward.clone();
      // A degenerate frame would make `setFromUnitVectors` produce a non-unit
      // quaternion and the ring would render skewed; fall back to world forward.
      if (forward.lengthSq() < 1e-6) forward.set(0, 0, 1);
      anchors.push({
        position: frame.mid.clone().add(new Vector3(0, lift, 0)),
        forward: forward.normalize(),
      });
    }
  }

  return anchors;
}

export interface BlessingSpotContext {
  anchors: readonly BlessingAnchor[];
  playerPosition: Vector3;
  /** Blessings still standing, so a new one is never planted on top of one. */
  occupied: readonly Vector3[];
  /**
   * Where the blessing being placed last stood, when it has stood anywhere.
   * Kept out of `occupied` on purpose — that list is about not stacking two
   * rings, this is about a returning one visibly having moved.
   */
  avoid?: Vector3 | null;
}

/**
 * Picks where the next blessing appears, or null when the map offers nowhere.
 *
 * Every rule is a preference with a graceful floor rather than a hard reject: a
 * cramped map, or a player parked in the middle of the only clear space, must
 * still get a blessing somewhere. Each anchor is scored by its distance to the
 * nearest thing it should avoid, so when nothing satisfies all three the
 * least-bad spots still win — the constraint degrades to "as far away as this
 * map allows" instead of failing to place anything.
 *
 * **Both paths draw at random, and that is the point.** The fallback used to
 * take the single highest score, which is deterministic given the other
 * blessings — so a slot that came back while its neighbours stood still was
 * handed its own anchor again, every time. A blessing that reappears where it
 * was collected is indistinguishable from one that never moved.
 */
export function pickBlessingSpot(ctx: BlessingSpotContext): BlessingAnchor | null {
  if (ctx.anchors.length === 0) return null;

  const eligible: BlessingAnchor[] = [];
  const scored: { anchor: BlessingAnchor; score: number }[] = [];
  let bestScore = -Infinity;

  for (const anchor of ctx.anchors) {
    let nearestOccupied = Infinity;
    for (const other of ctx.occupied) {
      nearestOccupied = Math.min(nearestOccupied, anchor.position.distanceTo(other));
    }
    const playerDistance = anchor.position.distanceTo(ctx.playerPosition);
    const returnDistance = ctx.avoid ? anchor.position.distanceTo(ctx.avoid) : Infinity;

    if (
      nearestOccupied >= MIN_SEPARATION &&
      playerDistance >= MIN_PLAYER_DISTANCE &&
      returnDistance >= MIN_RETURN_DISTANCE
    ) {
      eligible.push(anchor);
    }

    // Scaled against its own rule before they are combined, so the weakest of
    // the three by *proportion* decides — otherwise the return rule, being the
    // shortest distance, would look worst at every anchor and swamp the rest.
    const score = Math.min(
      nearestOccupied / MIN_SEPARATION,
      playerDistance / MIN_PLAYER_DISTANCE,
      returnDistance / MIN_RETURN_DISTANCE,
    );
    scored.push({ anchor, score });
    bestScore = Math.max(bestScore, score);
  }

  if (eligible.length > 0) return eligible[Math.floor(Math.random() * eligible.length)];

  const band = bestScore * FALLBACK_SCORE_FRACTION;
  const nearBest = scored.filter((entry) => entry.score >= band);
  return nearBest[Math.floor(Math.random() * nearBest.length)].anchor;
}
