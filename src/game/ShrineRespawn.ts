import { Vector3 } from 'three';

/**
 * Where a collected blessing comes back.
 *
 * "Reachable" is the whole problem, and it is not solved by picking a random
 * point and testing it — a point in mid-air over the void passes every cheap
 * test and is still unreachable. It is solved by *construction*: every
 * candidate is generated in the same envelope the course's own hand-placed ring
 * shrines occupy, a little outside the track radius and a dozen units above the
 * track plane, which is the height a player reaches by launching off a face's
 * high edge with speed to spare. If a point in that envelope were unreachable,
 * the authored shrines would be too.
 *
 * That also answers "don't put it back at the start": candidates only ever come
 * from the **endless ring**, never the approach. The approach is one-way — a
 * player on the loop cannot climb back up it — so a blessing respawned there
 * would be gone for the rest of the run.
 */

/** Radial offset from the track radius. Slightly outside, like the authored ones. */
const RADIUS_MIN_OFFSET = -3;
const RADIUS_MAX_OFFSET = 8;
/** Height above the track plane. The authored ring shrines sit at +13 and +16. */
const HEIGHT_MIN = 11;
const HEIGHT_MAX = 17;

/**
 * How far from the player a blessing must appear.
 *
 * The ring is 90 units in radius, so a full lap is about 565 units of travel
 * and this is roughly an eighth of it — far enough that the blessing is
 * something you *go and get* rather than something that materialises in your
 * lap, and near enough that it is not always half a lap of grinding away.
 */
const MIN_PLAYER_DISTANCE = 70;

/** And far enough from the blessings still standing that two never overlap. */
const MIN_SHRINE_SEPARATION = 25;

/**
 * Candidate draws before giving up and taking the best of them.
 *
 * A fallback is required, not optional: a player parked in the middle of the
 * island is more than `MIN_PLAYER_DISTANCE` from nothing, and a loop that
 * insisted on the constraint would spin forever. Taking the furthest candidate
 * degrades the rule to "as far away as this situation allows".
 */
const MAX_ATTEMPTS = 24;

export interface ShrineRespawnContext {
  /** Radius of the surf loop; candidates hug it. */
  trackRadius: number;
  /** World Y of the track plane; candidates float above it. */
  trackY: number;
  /** The loop orbits this, so its X/Z is the ring's centre. */
  islandCenter: Vector3;
  playerPosition: Vector3;
  /** Blessings still standing, so a new one is not planted on top of one. */
  occupied: readonly Vector3[];
}

function candidate(ctx: ShrineRespawnContext): Vector3 {
  const theta = Math.random() * Math.PI * 2;
  const radius =
    ctx.trackRadius + RADIUS_MIN_OFFSET + Math.random() * (RADIUS_MAX_OFFSET - RADIUS_MIN_OFFSET);
  const height = HEIGHT_MIN + Math.random() * (HEIGHT_MAX - HEIGHT_MIN);
  return new Vector3(
    ctx.islandCenter.x + Math.cos(theta) * radius,
    ctx.trackY + height,
    ctx.islandCenter.z + Math.sin(theta) * radius,
  );
}

export function pickShrineRespawnPoint(ctx: ShrineRespawnContext): Vector3 {
  let best: Vector3 | null = null;
  let bestDistance = -1;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const point = candidate(ctx);

    // Overlap with a standing blessing is a hard reject with no fallback — two
    // shrines in the same place is a bug the player can see, whereas one that
    // spawned closer than intended is only a missed preference.
    let clear = true;
    for (const other of ctx.occupied) {
      if (point.distanceToSquared(other) < MIN_SHRINE_SEPARATION * MIN_SHRINE_SEPARATION) {
        clear = false;
        break;
      }
    }
    if (!clear) continue;

    const distance = point.distanceTo(ctx.playerPosition);
    if (distance >= MIN_PLAYER_DISTANCE) return point;
    if (distance > bestDistance) {
      bestDistance = distance;
      best = point;
    }
  }

  return best ?? candidate(ctx);
}
