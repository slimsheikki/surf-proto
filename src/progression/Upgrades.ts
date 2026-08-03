import { Health } from '../combat/Health';
import { SOUND_BLAST_RADIUS } from '../combat/SoundBlast';
import { Weapon } from '../combat/Weapon';
import { Dash } from '../player/Dash';
import { MovementConfig } from '../player/MovementConfig';
import { XP_MAGNET } from './XPOrb';

/**
 * Run-scoped perks that live on `Game` rather than on any one subsystem —
 * hooks the game loop reads at the moment the relevant event happens (a kill,
 * an XP pickup, a dash). Reset wholesale on restart via `resetRunPerks`, the
 * same copy-the-defaults contract `resetMovementConfig` uses, so a new perk
 * added here is automatically reset without anyone remembering to list it.
 *
 * Every field here must also ride `Rewind`'s `Frame` — an upgrade whose field
 * is not recorded is one a rewind silently leaves applied.
 */
export interface RunPerks {
  /** HP restored per drone kill. */
  healOnKill: number;
  /** Multiplier on all XP gained. */
  xpMultiplier: number;
  /** Damage of the shockwave a dash emits. 0 = perk not owned. See `SoundBlast`. */
  soundBlastDamage: number;
  /** Reach of every sound-based blast (dash, echo, Chorus). Subwoofer grows it. */
  soundBlastRadius: number;
  /** Damage per second of the burning wake. 0 = perk not owned. See `SolarWave`. */
  solarWaveDps: number;
  /** Photosynthesis: HP per second, paid only while airborne. */
  airRegenPerSecond: number;
  /** Heliotropism stacks: orb notice radius grows with speed. See `heliotropismBonus`. */
  heliotropism: number;
  /** Doppler Drive: extra attacks/s at full speed, scaled by the 10-40 u/s window. */
  dopplerAps: number;
  /** Solar Capacitor: extra ultimate gain multiplier while flow is full (+0.35/stack). */
  solarCapacitor: number;
  /** Aurora Wake stacks: flow pays +25% and drains slower per stack. */
  auroraWake: number;
  /** Mirror Array: retaliatory flash damage when contact damage lands. 0 = off. */
  mirrorDamage: number;
  /** Echo Chamber: 1 = a dash-blast repeats at 60% from where it fired, 0.35 s later. */
  echoChamber: number;
  /** Standing Wave: fraction of speed the wake strips from chasers (0 = off, cap 0.55). */
  standingWaveSlow: number;
  /** Chorus: 1 = every 8th kill sings a free blast at the victim's position. */
  chorus: number;
}

const PERK_DEFAULTS: RunPerks = {
  healOnKill: 0,
  xpMultiplier: 1,
  soundBlastDamage: 0,
  soundBlastRadius: SOUND_BLAST_RADIUS,
  solarWaveDps: 0,
  airRegenPerSecond: 0,
  heliotropism: 0,
  dopplerAps: 0,
  solarCapacitor: 0,
  auroraWake: 0,
  mirrorDamage: 0,
  echoChamber: 0,
  standingWaveSlow: 0,
  chorus: 0,
};

export function createRunPerks(): RunPerks {
  return { ...PERK_DEFAULTS };
}

export function resetRunPerks(perks: RunPerks): void {
  Object.assign(perks, PERK_DEFAULTS);
}

export interface UpgradeContext {
  weapon: Weapon;
  playerHealth: Health;
  dash: Dash;
  perks: RunPerks;
}

/**
 * Tier.
 *
 * Common and rare together are the *visible* pool — everything a pick menu or a
 * shrine blessing can offer. Epic and legendary are gamble-only: the blind roll
 * is the sole route to them, and that is the entire reason banking picks up
 * instead of tapping F the moment one lands.
 */
export type Rarity = 'common' | 'rare' | 'epic' | 'legendary';

export interface Upgrade {
  id: string;
  name: string;
  description: string;
  rarity: Rarity;
  apply: (ctx: UpgradeContext) => void;
}

/**
 * The item pool, Megabonk-flavoured: lots of small stacking bonuses across
 * every system, drawn three at a time by picks and shrine blessings, plus a
 * gamble-only tail of bigger ones. Every entry is repeatable — drawing is
 * without replacement per menu but the pool never shrinks across a run, so
 * builds come from which offers you take, not from exhausting a list.
 *
 * Movement-touching entries mutate `MovementConfig` (restored by
 * `resetMovementConfig`); everything else mutates live subsystem fields that
 * their own `reset()` restores. An upgrade must never hold state of its own —
 * that is what makes restart cheap and correct.
 */
export const UPGRADE_POOL: Upgrade[] = [
  {
    id: 'damage',
    name: '+Damage',
    description: 'Weapon damage +3',
    rarity: 'common',
    apply: (ctx) => {
      ctx.weapon.damage += 3;
    },
  },
  {
    id: 'attack-speed',
    name: '+Attack Speed',
    description: 'Attacks per second +0.6',
    rarity: 'common',
    apply: (ctx) => {
      ctx.weapon.attacksPerSecond += 0.6;
    },
  },
  {
    id: 'weapon-range',
    name: '+Range',
    description: 'Auto-weapon range +5',
    rarity: 'common',
    apply: (ctx) => {
      ctx.weapon.range += 5;
    },
  },
  {
    id: 'velocity-rounds',
    name: 'Velocity Rounds',
    description: 'Shots gain damage with your speed (up to +15)',
    rarity: 'rare',
    apply: (ctx) => {
      // Already-owned copies fall back to a flat damage bump, so a duplicate
      // draw is never a dead pick.
      if (ctx.weapon.velocityRounds) ctx.weapon.damage += 3;
      ctx.weapon.velocityRounds = true;
    },
  },
  {
    id: 'sound-blast',
    name: 'Sound Blast',
    description: 'Dashing emits a shockwave for 20 damage (stacks)',
    rarity: 'rare',
    apply: (ctx) => {
      ctx.perks.soundBlastDamage += 20;
    },
  },
  {
    id: 'solar-wave',
    name: 'Solar Wave',
    description: 'Leave a fading solar wake that burns pursuers for 10/s (stacks)',
    rarity: 'rare',
    apply: (ctx) => {
      ctx.perks.solarWaveDps += 10;
    },
  },

  // ------------------------------------------- the solarpunk / sound batch
  {
    id: 'photosynthesis',
    name: 'Photosynthesis',
    description: 'Regenerate 1.2 HP/s while airborne (stacks)',
    rarity: 'common',
    apply: (ctx) => {
      ctx.perks.airRegenPerSecond += 1.2;
    },
  },
  {
    id: 'heliotropism',
    name: 'Heliotropism',
    description: 'XP orbs notice you from further out the faster you go',
    rarity: 'common',
    apply: (ctx) => {
      ctx.perks.heliotropism += 1;
    },
  },
  {
    id: 'doppler-drive',
    name: 'Doppler Drive',
    description: 'Attack rate rises with speed, up to +0.5/s (stacks)',
    rarity: 'common',
    apply: (ctx) => {
      ctx.perks.dopplerAps += 0.5;
    },
  },
  {
    id: 'subwoofer',
    name: 'Subwoofer',
    description: 'Sound Blast radius +2; grants the blast at +15 damage if unowned',
    rarity: 'common',
    apply: (ctx) => {
      // Radius unconditionally — a stack must never be silently lost — plus
      // the Velocity Rounds rule: drawn before Sound Blast itself, it brings
      // the blast with it so it is never a dead pick.
      ctx.perks.soundBlastRadius += 2;
      if (ctx.perks.soundBlastDamage === 0) ctx.perks.soundBlastDamage += 15;
    },
  },
  {
    id: 'solar-capacitor',
    name: 'Solar Capacitor',
    description: 'Ultimate charges +35% faster while flow is full (stacks)',
    rarity: 'rare',
    apply: (ctx) => {
      ctx.perks.solarCapacitor += 0.35;
    },
  },
  {
    id: 'aurora-wake',
    name: 'Aurora Wake',
    description: 'Flow XP +25% and the glow fades slower off-line (stacks)',
    rarity: 'rare',
    apply: (ctx) => {
      ctx.perks.auroraWake += 1;
    },
  },
  {
    id: 'mirror-array',
    name: 'Mirror Array',
    description: 'Enemies that touch you take a 14-damage flash (stacks)',
    rarity: 'rare',
    apply: (ctx) => {
      ctx.perks.mirrorDamage += 14;
    },
  },
  {
    id: 'echo-chamber',
    name: 'Echo Chamber',
    description: 'Sound Blast +10 damage and repeats at 60% where it fired',
    rarity: 'rare',
    apply: (ctx) => {
      ctx.perks.soundBlastDamage += 10;
      ctx.perks.echoChamber = 1;
    },
  },
  {
    id: 'standing-wave',
    name: 'Standing Wave',
    description: 'Your solar wake also drags pursuers to 70% speed',
    rarity: 'rare',
    apply: (ctx) => {
      // First pick strips 30%, repeats deepen by 10% toward a 55% cap. Brings
      // a starter wake along if Solar Wave is unowned — same no-dead-pick rule
      // as Subwoofer.
      if (ctx.perks.solarWaveDps === 0) ctx.perks.solarWaveDps += 6;
      ctx.perks.standingWaveSlow =
        ctx.perks.standingWaveSlow === 0
          ? 0.3
          : Math.min(0.55, ctx.perks.standingWaveSlow + 0.1);
    },
  },
  {
    id: 'move-speed',
    name: '+Move Speed',
    description: 'Ground & air speed caps up',
    rarity: 'rare',
    apply: () => {
      MovementConfig.MAX_GROUND_SPEED += 0.6;
      MovementConfig.MAX_AIR_WISH_SPEED += 0.06;
    },
  },
  {
    id: 'max-hp',
    name: '+Max HP',
    description: 'Max HP +20, heal to match',
    rarity: 'common',
    apply: (ctx) => {
      ctx.playerHealth.maxHp += 20;
      ctx.playerHealth.heal(20);
    },
  },
  {
    id: 'regen',
    name: 'Regeneration',
    description: 'Recover 1.5 HP per second',
    rarity: 'rare',
    apply: (ctx) => {
      ctx.playerHealth.regenPerSecond += 1.5;
    },
  },
  {
    id: 'vampiric',
    name: 'Vampiric Edge',
    description: 'Heal 2 HP on every kill',
    rarity: 'rare',
    apply: (ctx) => {
      ctx.perks.healOnKill += 2;
    },
  },
  {
    id: 'jump-height',
    name: '+Jump Height',
    description: 'Jump speed +0.8 — handy for chaining ramps',
    rarity: 'common',
    apply: () => {
      MovementConfig.JUMP_SPEED += 0.8;
    },
  },
  {
    id: 'extra-dash',
    name: 'Extra Dash',
    description: 'Max dash charges +1, granted immediately',
    rarity: 'rare',
    apply: (ctx) => {
      ctx.dash.maxCharges += 1;
      ctx.dash.charges += 1;
    },
  },
  {
    id: 'dash-recharge',
    name: 'Quick Recovery',
    description: 'Dash recharges 1.2 s faster',
    rarity: 'common',
    apply: (ctx) => {
      ctx.dash.rechargeSeconds = Math.max(1.5, ctx.dash.rechargeSeconds - 1.2);
    },
  },
  {
    id: 'magnet',
    name: 'XP Magnet',
    description: 'Orbs home in from 6 units further out',
    rarity: 'common',
    apply: () => {
      XP_MAGNET.radius += 6;
    },
  },
  {
    id: 'scholar',
    name: 'Scholar',
    description: 'All XP gained +25%',
    rarity: 'rare',
    apply: (ctx) => {
      ctx.perks.xpMultiplier += 0.25;
    },
  },

  // ------------------------------------------------------------ gamble-only
  //
  // Everything below is unreachable from a pick menu. It exists to be won on a
  // blind roll, which is what makes staking a full bank worth doing.
  //
  // Every entry writes only fields `Rewind`'s `Frame` already records — either
  // directly, or through `DashSnapshot` — so none of them needed the recorder
  // touched. Keep it that way: an upgrade whose field is not in `Frame` is one
  // a rewind silently leaves applied.
  {
    id: 'epic-overclock',
    name: 'Overclock',
    description: 'Attacks per second +1.6, weapon range +6',
    rarity: 'epic',
    apply: (ctx) => {
      ctx.weapon.attacksPerSecond += 1.6;
      ctx.weapon.range += 6;
    },
  },
  {
    id: 'epic-resonance',
    name: 'Resonance',
    description: 'Sound Blast +45 damage, heal 4 HP per kill',
    rarity: 'epic',
    apply: (ctx) => {
      ctx.perks.soundBlastDamage += 45;
      ctx.perks.healOnKill += 4;
    },
  },
  {
    id: 'epic-tailwind',
    name: 'Tailwind',
    description: 'Ground cap +1.5, air control +0.15, jump +1.2',
    rarity: 'epic',
    apply: () => {
      MovementConfig.MAX_GROUND_SPEED += 1.5;
      MovementConfig.MAX_AIR_WISH_SPEED += 0.15;
      MovementConfig.JUMP_SPEED += 1.2;
    },
  },
  {
    id: 'epic-bloodstone',
    name: 'Bloodstone',
    description: 'Max HP +45 (healed), recover 2.5 HP per second',
    rarity: 'epic',
    apply: (ctx) => {
      ctx.playerHealth.maxHp += 45;
      ctx.playerHealth.heal(45);
      ctx.playerHealth.regenPerSecond += 2.5;
    },
  },
  {
    id: 'epic-slipstream',
    name: 'Slipstream',
    description: 'Max dash charges +2 (granted), recharge 2 s faster',
    rarity: 'epic',
    apply: (ctx) => {
      ctx.dash.maxCharges += 2;
      ctx.dash.charges += 2;
      ctx.dash.rechargeSeconds = Math.max(1.5, ctx.dash.rechargeSeconds - 2);
    },
  },
  {
    id: 'epic-tuition',
    name: 'Tuition',
    description: 'All XP +60%, orbs home in from 10 units further',
    rarity: 'epic',
    apply: (ctx) => {
      ctx.perks.xpMultiplier += 0.6;
      XP_MAGNET.radius += 10;
    },
  },
  {
    id: 'legend-apex',
    name: 'Apex Predator',
    description: 'Damage +14, attacks per second +1.2, Velocity Rounds online',
    rarity: 'legendary',
    apply: (ctx) => {
      ctx.weapon.damage += 14;
      ctx.weapon.attacksPerSecond += 1.2;
      ctx.weapon.velocityRounds = true;
    },
  },
  {
    id: 'legend-perpetual',
    name: 'Perpetual Motion',
    description: 'Ground +2.5, air control +0.25, jump +2, dash charge +1 and 2.5 s faster',
    rarity: 'legendary',
    apply: (ctx) => {
      MovementConfig.MAX_GROUND_SPEED += 2.5;
      MovementConfig.MAX_AIR_WISH_SPEED += 0.25;
      MovementConfig.JUMP_SPEED += 2;
      ctx.dash.maxCharges += 1;
      ctx.dash.charges += 1;
      ctx.dash.rechargeSeconds = Math.max(1.5, ctx.dash.rechargeSeconds - 2.5);
    },
  },
  {
    id: 'legend-vampire-lord',
    name: 'Vampire Lord',
    description: 'Max HP +60 (healed), regen +4 HP/s, heal 8 HP on every kill',
    rarity: 'legendary',
    apply: (ctx) => {
      ctx.playerHealth.maxHp += 60;
      ctx.playerHealth.heal(60);
      ctx.playerHealth.regenPerSecond += 4;
      ctx.perks.healOnKill += 8;
    },
  },
  {
    id: 'legend-corona',
    name: 'Corona',
    description: 'Solar wake burns +35/s, Sound Blast +35 damage',
    rarity: 'legendary',
    apply: (ctx) => {
      ctx.perks.solarWaveDps += 35;
      ctx.perks.soundBlastDamage += 35;
    },
  },
  {
    id: 'legend-chorus',
    name: 'Chorus',
    description: 'Every 8th kill sings a free Sound Blast where it died',
    rarity: 'legendary',
    apply: (ctx) => {
      // Dupes deepen the song instead of double-counting kills.
      if (ctx.perks.chorus > 0) ctx.perks.soundBlastDamage += 25;
      ctx.perks.chorus = 1;
    },
  },
];

/** The tiers a pick menu may offer. Epic and legendary are gamble-only. */
const VISIBLE_RARITIES: readonly Rarity[] = ['common', 'rare'];

/**
 * Three choices for one pick.
 *
 * Filtered to the visible tiers — 24 entries since the solarpunk/sound batch
 * (the original fifteen, minus two knife picks, plus Sound Blast, Solar Wave
 * and the nine visible solar/sound perks). Worth knowing when tuning: drawing
 * 3 of 24 without replacement re-offers any *specific* stacking perk notably
 * less often than the original 3-of-15 did.
 */
export function drawUpgradeChoices(count: number): Upgrade[] {
  const pool = UPGRADE_POOL.filter((upgrade) => VISIBLE_RARITIES.includes(upgrade.rarity));
  const choices: Upgrade[] = [];
  for (let i = 0; i < count && pool.length > 0; i++) {
    const idx = Math.floor(Math.random() * pool.length);
    choices.push(pool.splice(idx, 1)[0]);
  }
  return choices;
}

interface RarityOdds {
  common: number;
  rare: number;
  epic: number;
  legendary: number;
}

/**
 * Blind-roll odds by picks staked, in permille so a row can be asserted to sum
 * exactly rather than within an epsilon. Indexed by stake; rows 0 and 1 are
 * copies of row 2 and never reached, since the gamble needs two.
 *
 * The common row is the bust, and it has to stay felt — twelve percent at a
 * full stake, not three. A guaranteed pick is *best of three*, which is already
 * worth more than an average one, so without a real chance of walking away with
 * a single `+Damage` for five levels of progress there is no gamble here, just
 * a slower way to take the good outcome.
 *
 * The shape: staking two is a clearly bad bet, four is roughly break-even, five
 * is marginally favourable. That the ratio climbs with the stake is the point —
 * banking toward the cap should feel like it is building toward something.
 */
const GAMBLE_ODDS: readonly RarityOdds[] = [
  { common: 500, rare: 340, epic: 150, legendary: 10 }, // 0 — unused
  { common: 500, rare: 340, epic: 150, legendary: 10 }, // 1 — unused
  { common: 500, rare: 340, epic: 150, legendary: 10 },
  { common: 320, rare: 340, epic: 280, legendary: 60 },
  { common: 200, rare: 280, epic: 340, legendary: 180 },
  { common: 120, rare: 200, epic: 330, legendary: 350 },
];

/** Smallest stake the gamble accepts. Below it, banking would mean nothing. */
export const MIN_GAMBLE_PICKS = 2;

/** Percentage odds for a stake, for the menu to quote before the player commits. */
export function gambleOdds(picks: number): RarityOdds {
  const row = GAMBLE_ODDS[Math.max(MIN_GAMBLE_PICKS, Math.min(GAMBLE_ODDS.length - 1, picks))];
  return { ...row };
}

export function rollGambleRarity(picks: number): Rarity {
  const odds = gambleOdds(picks);
  let roll = Math.random() * 1000;
  if ((roll -= odds.legendary) < 0) return 'legendary';
  if ((roll -= odds.epic) < 0) return 'epic';
  if ((roll -= odds.rare) < 0) return 'rare';
  return 'common';
}

/**
 * One entry of the given tier.
 *
 * Falls down the ladder when a tier is empty rather than trusting it not to be:
 * this is the one call that can be handed a rarity with nothing behind it, and
 * a pool edit should cost a weaker roll, not `undefined.apply`.
 */
export function drawOfRarity(rarity: Rarity): Upgrade {
  const ladder: Rarity[] = ['legendary', 'epic', 'rare', 'common'];
  for (let i = Math.max(0, ladder.indexOf(rarity)); i < ladder.length; i++) {
    const tier = UPGRADE_POOL.filter((upgrade) => upgrade.rarity === ladder[i]);
    if (tier.length > 0) return tier[Math.floor(Math.random() * tier.length)];
  }
  return UPGRADE_POOL[0];
}
