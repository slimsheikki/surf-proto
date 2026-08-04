import { BOSS_LEVEL_INTERVAL } from './Difficulty';
import type { SpawnPattern } from './SpawnPlacement';

/**
 * What the horde is made of, act by act.
 *
 * `Difficulty` answers "how hard": every stat, the cadence, the caps — one
 * curve, two inputs, scaling forever. This file answers "made of what": each
 * act (the ten levels between Monoliths) is five authored waves that decide
 * the archetype mix, how a batch is arranged, and how often an elite rides
 * along. Waves overlay composition on the difficulty curve; they never scale
 * numbers themselves. That split is what keeps the guarded
 * `difficultyAt(1, 120)` contract meaningful — a wave can change *who* shows
 * up, but the early game's cadence and stats are still exactly the tuned ones.
 *
 * The wave index is a pure function of the player's level and the Monolith
 * count. Both already travel through the rewind (`LevelSnapshot`, and
 * `bossEpoch` fences any window that could straddle a boss), so waves rewind
 * for free with no recorded state of their own.
 *
 * Composition rails, carried over from the retired `seederChance` comment in
 * `Difficulty`: drones stay at weight ≥ .25 in every wave, and area-denial
 * types (seeder + spitter) stay ≤ .6 combined — a wave the auto-weapon has
 * nothing meaningful to shoot at while blasts pile up on the surf line is
 * pressure without counterplay. One deliberate tuning change rides in with
 * the tables: seeders now start at level 3 (wave 2's boundary) at a flat .15
 * draw, replacing the old level-4 ramp — wave boundaries and the old onset
 * level could not both hold, and a clean boundary is worth one level.
 */

export type ArchetypeId = 'drone' | 'seeder' | 'swarmer' | 'lancer' | 'bulwark' | 'spitter';

export interface WaveSpec {
  /** Banner flavor, all-caps by convention ("THE FLOOD"). */
  name: string;
  /** Relative archetype draw weights; normalized at draw time. */
  weights: Partial<Record<ArchetypeId, number>>;
  /** Relative batch-arrangement weights; normalized at draw time. */
  patterns: Partial<Record<SpawnPattern, number>>;
  /** Batch size range used when the `cluster` pattern is drawn. */
  clusterSize?: [min: number, max: number];
  /**
   * Multiplies `difficultyAt`'s spawn interval, and must stay ≥ 1: waves may
   * thin the stream for breathing room, never exceed it — the baseline
   * cadence is the one thing `Ultimate.LEVEL_GROWTH` is pinned against.
   */
  cadenceScale: number;
  /** Per-spawn probability of the elite affix. */
  eliteChance: number;
}

export interface WaveInfo {
  /** 0-based act index — literally `bossesFelled`. */
  act: number;
  /** 1..WAVES_PER_ACT within the act. */
  waveInAct: number;
  /** 1-based across the whole run; what the HUD and banners show. */
  globalWave: number;
  spec: WaveSpec;
}

export const WAVES_PER_ACT = 5;
/** Two levels per wave — derived, so a retuned boss interval moves the waves with it. */
const LEVELS_PER_WAVE = BOSS_LEVEL_INTERVAL / WAVES_PER_ACT;

/**
 * The authored acts. Act 3 and beyond remix these — see `remixSpec` — so
 * nothing past this table ever needs authoring.
 */
const ACT_WAVES: readonly (readonly WaveSpec[])[] = [
  // ---- Act 1: the roster walks in one archetype at a time.
  [
    {
      name: 'FIRST CONTACT',
      weights: { drone: 1 },
      patterns: { ring: 1 },
      cadenceScale: 1,
      eliteChance: 0,
    },
    {
      name: 'SEEDFALL',
      weights: { drone: 0.85, seeder: 0.15 },
      patterns: { ring: 1 },
      cadenceScale: 1,
      eliteChance: 0,
    },
    {
      name: 'THE FLOOD',
      weights: { drone: 0.5, swarmer: 0.45, seeder: 0.05 },
      patterns: { ring: 0.4, cluster: 0.6 },
      clusterSize: [4, 6],
      cadenceScale: 1,
      eliteChance: 0,
    },
    {
      name: 'LANCEFALL',
      weights: { drone: 0.45, lancer: 0.3, seeder: 0.15, swarmer: 0.1 },
      patterns: { ring: 0.7, flankPair: 0.3 },
      cadenceScale: 1,
      eliteChance: 0,
    },
    {
      name: 'VANGUARD',
      weights: { drone: 0.35, lancer: 0.25, swarmer: 0.2, seeder: 0.2 },
      patterns: { ring: 0.5, cluster: 0.25, flankPair: 0.25 },
      clusterSize: [4, 6],
      cadenceScale: 1,
      eliteChance: 0.12,
    },
  ],
  // ---- Act 2: the heavy and the ranged join; formations get meaner.
  [
    {
      name: 'BULWARK MARCH',
      weights: { drone: 0.4, bulwark: 0.25, swarmer: 0.35 },
      patterns: { ring: 0.7, cluster: 0.3 },
      clusterSize: [4, 6],
      cadenceScale: 1,
      eliteChance: 0.08,
    },
    {
      name: 'SPITFIRE',
      weights: { drone: 0.35, spitter: 0.3, lancer: 0.2, swarmer: 0.15 },
      patterns: { ring: 0.8, flankPair: 0.2 },
      cadenceScale: 1,
      eliteChance: 0.08,
    },
    {
      name: 'PINCER',
      weights: { drone: 0.4, lancer: 0.25, swarmer: 0.25, bulwark: 0.1 },
      patterns: { flankPair: 0.7, ring: 0.3 },
      cadenceScale: 1,
      eliteChance: 0.1,
    },
    {
      name: 'SEEDSTORM',
      weights: { seeder: 0.3, spitter: 0.3, drone: 0.25, swarmer: 0.15 },
      patterns: { ring: 0.6, cluster: 0.4 },
      clusterSize: [4, 6],
      cadenceScale: 1,
      eliteChance: 0.12,
    },
    {
      name: 'VANGUARD II',
      weights: { drone: 0.3, lancer: 0.2, swarmer: 0.15, seeder: 0.15, bulwark: 0.1, spitter: 0.1 },
      patterns: { ring: 0.4, cluster: 0.3, flankPair: 0.3 },
      clusterSize: [5, 7],
      cadenceScale: 1,
      eliteChance: 0.25,
    },
  ],
];

/** Remixes are pure functions of (act, waveInAct); cached because `waveAt` runs every tick. */
const remixCache = new Map<string, WaveSpec>();

/**
 * Acts past the authored two: start from the same wave slot in the alternating
 * authored act, fold in the *other* act's slot at half weight so the full
 * roster shows up everywhere, and escalate elites and cluster size with the
 * act count. Stat and density escalation is not this function's job — that
 * keeps coming from `difficultyAt`'s uncapped level term.
 */
function remixSpec(act: number, waveInAct: number): WaveSpec {
  const key = `${act}:${waveInAct}`;
  const cached = remixCache.get(key);
  if (cached) return cached;

  const base = ACT_WAVES[act % ACT_WAVES.length][waveInAct - 1];
  const other = ACT_WAVES[(act + 1) % ACT_WAVES.length][waveInAct - 1];

  const weights: Partial<Record<ArchetypeId, number>> = { ...base.weights };
  for (const [id, weight] of Object.entries(other.weights) as [ArchetypeId, number][]) {
    weights[id] = (weights[id] ?? 0) + weight * 0.5;
  }

  const growth = Math.min(2, act - 1);
  const spec: WaveSpec = {
    name: base.name,
    weights,
    patterns: base.patterns,
    clusterSize: base.clusterSize
      ? [base.clusterSize[0], base.clusterSize[1] + growth]
      : undefined,
    cadenceScale: base.cadenceScale,
    eliteChance: Math.min(0.4, base.eliteChance + 0.06 * (act - 1)),
  };
  remixCache.set(key, spec);
  return spec;
}

function specFor(act: number, waveInAct: number): WaveSpec {
  if (act < ACT_WAVES.length) return ACT_WAVES[act][waveInAct - 1];
  return remixSpec(act, waveInAct);
}

/**
 * The wave in effect for a given player level and Monolith count.
 *
 * The within-act level is clamped on both sides: a player who overshoots a
 * boss threshold mid-fight (flow XP, the felling award) sits on the act's
 * last wave until the Monolith falls, and the first post-boss levels land in
 * the next act's opening wave.
 */
export function waveAt(level: number, bossesFelled: number): WaveInfo {
  const act = Math.max(0, bossesFelled);
  const withinAct = Math.min(
    BOSS_LEVEL_INTERVAL,
    Math.max(1, level - BOSS_LEVEL_INTERVAL * act),
  );
  const waveInAct = Math.min(WAVES_PER_ACT, Math.max(1, Math.ceil(withinAct / LEVELS_PER_WAVE)));
  return {
    act,
    waveInAct,
    globalWave: act * WAVES_PER_ACT + waveInAct,
    spec: specFor(act, waveInAct),
  };
}

function drawWeighted<K extends string>(weights: Partial<Record<K, number>>, fallback: K): K {
  let total = 0;
  for (const weight of Object.values(weights)) total += weight as number;
  if (total <= 0) return fallback;
  let roll = Math.random() * total;
  for (const [key, weight] of Object.entries(weights) as [K, number][]) {
    roll -= weight;
    if (roll <= 0) return key;
  }
  return fallback;
}

export function drawArchetype(spec: WaveSpec): ArchetypeId {
  return drawWeighted(spec.weights, 'drone');
}

export function drawPattern(spec: WaveSpec): SpawnPattern {
  return drawWeighted(spec.patterns, 'ring');
}
