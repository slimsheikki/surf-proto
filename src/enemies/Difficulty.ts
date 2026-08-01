/**
 * Every number that gets harder over a run, in one place.
 *
 * There is no "win" state: the Monolith is a milestone, not an ending, and the
 * run continues until the player dies. That makes the difficulty curve the
 * thing that has to keep being interesting indefinitely, so it is worth having
 * it be inspectable rather than scattered across the spawner, the drone, and
 * the boss.
 *
 * Two inputs drive it. **Elapsed time** carries the first minute or two, which
 * is what the original ramps were tuned against and is left alone here.
 * **Player level** carries everything after that, and unlike the time terms it
 * is never capped out — a level-30 player is fighting something meaningfully
 * worse than a level-20 one. Level is the right axis for the late game because
 * the player's own power comes from levels too, so both sides of the fight
 * scale off the same clock.
 */

/** Level at which the first Monolith arrives, and the gap between each one after. */
export const FIRST_BOSS_LEVEL = 10;
export const BOSS_LEVEL_INTERVAL = 10;

/** Level the AoE seeders start appearing at. Before this the run is pure drones. */
const SEEDER_FIRST_LEVEL = 4;

/**
 * Ceiling on drone speed, and it is a design constraint rather than a tuning
 * knob: a drone that can outrun a surfing player stops being an obstacle to be
 * met head-on and becomes a thing that hounds them from behind, which is
 * exactly the "stop surfing to fight" failure the whole combat layer exists to
 * avoid. Anything above about 22 starts keeping pace with a mediocre line.
 */
const MAX_DRONE_SPEED = 22;
const MAX_SEEDER_SPEED = 16;

/** Population ceiling. Raised with level, but bounded — this is a frame-time budget, not a difficulty dial. */
const BASE_LIVE_CAP = 32;
const LIVE_CAP_PER_LEVEL = 2;
const MAX_LIVE_CAP = 64;

const MAX_BATCH_SIZE = 6;
/**
 * Floors on the spawn interval, and they are two different things.
 *
 * `TIME_FLOOR` is the original ramp's own floor and must stay: the time term
 * bottoms out here about a minute in, so a level-1 player sees exactly the
 * cadence the early game was tuned against. `MIN_SPAWN_INTERVAL` is the hard
 * stop the *level* term is allowed to push it down to.
 *
 * Collapsing the two — dividing an unfloored time term by the level term —
 * looked equivalent and was not: it put a level-1 player at two minutes on a
 * 0.45 s cadence instead of 1.2 s, nearly tripling the early-game spawn rate as
 * a side effect of a change that was supposed to only affect the late game.
 */
const TIME_FLOOR_SPAWN_INTERVAL = 1.2;
const MIN_SPAWN_INTERVAL = 0.45;

export interface Difficulty {
  droneHp: number;
  droneSpeed: number;
  droneContactDamage: number;
  seederHp: number;
  seederSpeed: number;
  seederContactDamage: number;
  blastDamage: number;
  /** Probability that any one spawn is a seeder rather than a drone. 0 before `SEEDER_FIRST_LEVEL`. */
  seederChance: number;
  spawnInterval: number;
  batchSize: number;
  liveCap: number;
}

/**
 * The full difficulty picture at a given moment.
 *
 * `level` is the player's current level (1-based) and `elapsedSeconds` the run
 * clock. Both are needed: a player who levels fast should meet a harder run
 * sooner, and a player who is barely levelling should still see the run tighten
 * as the clock runs.
 */
export function difficultyAt(level: number, elapsedSeconds: number): Difficulty {
  const t = Math.max(0, elapsedSeconds);
  // Levels *past the first*, so a level-1 player sees exactly the original numbers.
  const n = Math.max(0, level - 1);

  return {
    droneHp: (10 + Math.min(t * 0.25, 30)) * (1 + 0.16 * n),
    droneSpeed: Math.min(MAX_DRONE_SPEED, 9 + Math.min(t / 40, 6) + 0.22 * n),
    droneContactDamage: 5 * (1 + 0.1 * n),

    seederHp: (18 + Math.min(t * 0.3, 30)) * (1 + 0.16 * n),
    seederSpeed: Math.min(MAX_SEEDER_SPEED, 7 + 0.15 * n),
    seederContactDamage: 3 * (1 + 0.1 * n),
    blastDamage: 16 * (1 + 0.1 * n),
    // Ramps in slowly and tops out well short of half: seeders are pressure,
    // and a wave made mostly of them would be a wave the auto-weapon has
    // nothing to shoot at while blasts pile up on the surf line.
    seederChance:
      level < SEEDER_FIRST_LEVEL ? 0 : Math.min(0.35, 0.06 * (level - SEEDER_FIRST_LEVEL + 1)),

    spawnInterval: Math.max(
      MIN_SPAWN_INTERVAL,
      Math.max(TIME_FLOOR_SPAWN_INTERVAL, 2.5 - t / 45) / (1 + 0.07 * n),
    ),
    batchSize: Math.min(MAX_BATCH_SIZE, 1 + Math.floor(t / 90) + Math.floor(n / 5)),
    liveCap: Math.min(MAX_LIVE_CAP, BASE_LIVE_CAP + LIVE_CAP_PER_LEVEL * n),
  };
}

export interface BossScale {
  hp: number;
  damage: number;
}

/**
 * How much harder the `index`-th Monolith is (0 for the first).
 *
 * HP grows faster than damage on purpose. By the second Monolith the player has
 * had twenty upgrades and is deleting the first one's health bar in seconds, so
 * the fight needs length to still be a fight; damage scaled at the same rate
 * would just make it a one-shot, and the boss's attacks are dodgeable patterns
 * whose *difficulty* should come from the player having to hold a clean line,
 * not from the numbers.
 */
export function bossScaleFor(index: number): BossScale {
  return { hp: 1 + 0.8 * index, damage: 1 + 0.22 * index };
}

/** Level the `index`-th Monolith (0-based) arrives at. */
export function bossLevelFor(index: number): number {
  return FIRST_BOSS_LEVEL + BOSS_LEVEL_INTERVAL * index;
}
