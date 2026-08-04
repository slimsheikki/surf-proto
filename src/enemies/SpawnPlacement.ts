import { Vector3 } from 'three';
import { pointSegmentDistance } from '../combat/LaserBeam';
import { isInsideAnyCollider } from '../engine/Raycast';

/**
 * Where an enemy is allowed to materialize.
 *
 * The previous spawner placed everything in a forward cone 22-42 units dead
 * ahead of travel, which read fine at walking pace and was an ambush at surf
 * speed: at 35 u/s the player crossed the whole gap in under a second, often
 * colliding with a drone that had existed for a handful of frames. The rework
 * inverts the shape — enemies appear on a ring *around* the player and the one
 * region that is explicitly forbidden is the collision corridor the player is
 * about to fly through.
 *
 * Two rules produce the Megabonk feel this is chasing:
 *
 * - **Moving players get spawns beside and behind them.** The corridor
 *   rejection keeps the windshield clear, and above `SLOW_SPEED` an increasing
 *   share of draws is forced into the rear half. Enemies still end up ahead of
 *   a traveling player — off the line, where the intercept AI can arc them in
 *   from the side — but nothing ever pops into the flight path itself.
 * - **A still player gets the full 360°.** No corridor, no bias: camp and the
 *   ring closes evenly around you. This is the same job the seeder's
 *   plant-on-a-still-player fallback does — the combat layer's pressure always
 *   points the same way: keep surfing.
 *
 * Placement alone cannot promise a damage-free reaction window (a legal spawn
 * 6 u off the corridor can still brush a passing player in ~0.35 s), so the
 * hard "no instant damage" guarantee lives in `Enemy`'s spawn contact grace,
 * not here. This module buys visibility and avoidability; the grace buys the
 * number.
 *
 * Candidate rejection follows `pickShrineRespawnPoint`'s shape: N draws with
 * hard rejects, then a best-effort fallback so the loop can never spin. The
 * fallback prefers a pure side point because the lateral axis is perpendicular
 * to the velocity by construction — it can never sit in the corridor.
 */

// Tunables — exported so probes assert against the same numbers the game runs.
export const RING_MIN = 16;
export const RING_MAX = 28;
/** The band slides out with speed so a fast player still gets a beat of approach. */
export const SPEED_LEAD_FACTOR = 0.3;
export const SPEED_LEAD_MAX = 8;
/** Below this speed the player is "still": no corridor, no rear bias, full surround. */
export const SLOW_SPEED = 10;
/** No candidate may sit within this distance of the projected travel segment. */
export const CORRIDOR_HALF_WIDTH = 6;
export const CORRIDOR_SECONDS = 1.5;
/** At full speed, up to this fraction of draws is forced into the rear half. */
export const REAR_BIAS_MAX = 0.5;
/** Speed span over which the rear bias ramps from 0 to its max, starting at SLOW_SPEED. */
const REAR_BIAS_RAMP = 20;
export const VERTICAL_SPREAD = 6;
export const MAX_ATTEMPTS = 12;
/**
 * Straggler recycling — the Megabonk repositioning rule. An enemy this far
 * *behind* the travel direction has been left for dead on a one-way descent:
 * it will never re-engage on its own, and it costs a steering solve and a
 * rewind sample forever. Instead of persisting in place (the old rule, written
 * for a course that looped back through its stragglers) it re-enters the ring.
 * Never a despawn — same entity, same rewind identity, health kept.
 */
export const REPOSITION_DISTANCE = 120;
/** Per-enemy gap between relocations, so a borderline straggler doesn't strobe. */
export const REPOSITION_COOLDOWN = 3;
/** Scatter radius for cluster members around their anchor. */
export const CLUSTER_RADIUS = 4;
/** Flank anchors sit at ±(90° ± this) off the travel direction. */
export const FLANK_JITTER_RAD = Math.PI / 12;

const UP = new Vector3(0, 1, 0);

export interface PlacementContext {
  playerPosition: Vector3;
  /** Unit vector along the player's 3D travel (look direction when still). */
  travelDirection: Vector3;
  playerSpeed: number;
}

/**
 * How a batch is arranged. `ring` scatters members independently around the
 * band; `cluster` packs them around one shared anchor (the swarm read);
 * `flankPair` splits them across two anchors at ±90°, the ambush read.
 */
export type SpawnPattern = 'ring' | 'cluster' | 'flankPair';

/**
 * Horizontal basis for the ring. The lateral axis comes from the *horizontal*
 * component of travel (same construction the old spawner used), so the ring
 * stays level with the world even when the player is plunging down a steep
 * ramp; the corridor check below uses the full 3D velocity separately.
 */
function ringBasis(travelDirection: Vector3): { forwardH: Vector3; lateral: Vector3 } {
  const lateral = new Vector3().crossVectors(UP, travelDirection);
  if (lateral.lengthSq() < 1e-6) lateral.set(1, 0, 0);
  lateral.normalize();
  const forwardH = new Vector3().crossVectors(lateral, UP).normalize();
  return { forwardH, lateral };
}

function speedLead(playerSpeed: number): number {
  return Math.min(SPEED_LEAD_MAX, playerSpeed * SPEED_LEAD_FACTOR);
}

/** True when `point` sits inside the corridor the player is about to fly through. */
function corridorViolated(point: Vector3, ctx: PlacementContext): boolean {
  const end = ctx.playerPosition
    .clone()
    .addScaledVector(ctx.travelDirection, ctx.playerSpeed * CORRIDOR_SECONDS);
  return pointSegmentDistance(point, ctx.playerPosition, end) < CORRIDOR_HALF_WIDTH;
}

/**
 * Best-effort landing spot once the draws are exhausted (a band buried in
 * geometry, e.g. spawning against a wall of ramps). Side first — lateral is
 * perpendicular to the velocity, so a side point is corridor-safe at any
 * speed — then rear, then overhead. If everything is buried, the side point
 * ships anyway: enemies ignore geometry in flight, so a buried frame is a
 * cosmetic blink, not a stuck enemy.
 */
function fallbackPoint(ctx: PlacementContext, forwardH: Vector3, lateral: Vector3): Vector3 {
  const d = RING_MIN + speedLead(ctx.playerSpeed);
  const side = Math.random() < 0.5 ? 1 : -1;
  const candidates = [
    ctx.playerPosition.clone().addScaledVector(lateral, side * d).addScaledVector(UP, 2),
    ctx.playerPosition.clone().addScaledVector(lateral, -side * d).addScaledVector(UP, 2),
    ctx.playerPosition.clone().addScaledVector(forwardH, -d).addScaledVector(UP, 2),
    ctx.playerPosition.clone().addScaledVector(UP, 18),
  ];
  for (const candidate of candidates) {
    if (!isInsideAnyCollider(candidate)) return candidate;
  }
  return candidates[0];
}

/** One corridor-safe, geometry-free point on the ring band around the player. */
export function pickSpawnPoint(ctx: PlacementContext): Vector3 {
  const { forwardH, lateral } = ringBasis(ctx.travelDirection);
  const lead = speedLead(ctx.playerSpeed);
  const moving = ctx.playerSpeed >= SLOW_SPEED;
  const rearBias = moving
    ? REAR_BIAS_MAX * Math.min(1, (ctx.playerSpeed - SLOW_SPEED) / REAR_BIAS_RAMP)
    : 0;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    // θ measured off the forward axis; π is directly behind.
    let theta = Math.random() * Math.PI * 2;
    if (rearBias > 0 && Math.random() < rearBias) {
      theta = Math.PI / 2 + Math.random() * Math.PI;
    }
    const radius = RING_MIN + lead + Math.random() * (RING_MAX - RING_MIN);
    const candidate = ctx.playerPosition
      .clone()
      .addScaledVector(forwardH, Math.cos(theta) * radius)
      .addScaledVector(lateral, Math.sin(theta) * radius);
    candidate.y += (Math.random() * 2 - 1) * VERTICAL_SPREAD;

    if (moving && corridorViolated(candidate, ctx)) continue;
    if (isInsideAnyCollider(candidate)) continue;
    return candidate;
  }
  return fallbackPoint(ctx, forwardH, lateral);
}

/**
 * Cube scatter around an anchor, squashed vertically so a group reads as a
 * pack rather than a column. Members that land inside geometry snap to the
 * anchor — the anchor is already validated, and a moment of overlap between
 * pack members is invisible.
 */
function scatterAround(anchor: Vector3, count: number, radius: number): Vector3[] {
  const points: Vector3[] = [];
  for (let i = 0; i < count; i++) {
    const candidate = anchor
      .clone()
      .add(
        new Vector3(
          (Math.random() * 2 - 1) * radius,
          (Math.random() * 2 - 1) * radius * 0.5,
          (Math.random() * 2 - 1) * radius,
        ),
      );
    points.push(isInsideAnyCollider(candidate) ? anchor.clone() : candidate);
  }
  return points;
}

/**
 * A flank anchor at ±(90° ± jitter). Sitting a whole ring radius off an axis
 * perpendicular to the velocity, it is corridor-safe by construction; only
 * geometry can invalidate it, in which case the general picker takes over.
 */
function flankAnchor(
  ctx: PlacementContext,
  forwardH: Vector3,
  lateral: Vector3,
  sign: 1 | -1,
): Vector3 {
  const theta = sign * (Math.PI / 2 + (Math.random() * 2 - 1) * FLANK_JITTER_RAD);
  const radius = (RING_MIN + RING_MAX) / 2 + speedLead(ctx.playerSpeed);
  const candidate = ctx.playerPosition
    .clone()
    .addScaledVector(forwardH, Math.cos(theta) * radius)
    .addScaledVector(lateral, Math.sin(theta) * radius);
  candidate.y += (Math.random() * 2 - 1) * 3;
  return isInsideAnyCollider(candidate) ? pickSpawnPoint(ctx) : candidate;
}

/** `count` spawn points arranged per `pattern`. Capacity decisions stay with the caller. */
export function pickPatternPoints(
  ctx: PlacementContext,
  pattern: SpawnPattern,
  count: number,
): Vector3[] {
  if (count <= 0) return [];
  if (pattern === 'cluster') {
    return scatterAround(pickSpawnPoint(ctx), count, CLUSTER_RADIUS);
  }
  if (pattern === 'flankPair') {
    const { forwardH, lateral } = ringBasis(ctx.travelDirection);
    const anchors = [
      flankAnchor(ctx, forwardH, lateral, 1),
      flankAnchor(ctx, forwardH, lateral, -1),
    ];
    const points: Vector3[] = [];
    for (let i = 0; i < count; i++) {
      points.push(...scatterAround(anchors[i % 2], 1, 2));
    }
    return points;
  }
  const points: Vector3[] = [];
  for (let i = 0; i < count; i++) {
    points.push(pickSpawnPoint(ctx));
  }
  return points;
}
