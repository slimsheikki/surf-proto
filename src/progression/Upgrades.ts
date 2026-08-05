import { Health } from '../combat/Health';
import { SOUND_BLAST_RADIUS } from '../combat/SoundBlast';
import { Weapon } from '../combat/Weapon';
import { Dash } from '../player/Dash';
import { MovementConfig } from '../player/MovementConfig';
import { XP_MAGNET } from './XPOrb';

/**
 * Tier.
 *
 * Common and uncommon together are the *visible* pool — what a pick menu or a
 * shrine blessing usually offers. Epic and legendary can now appear there too,
 * but only just: see `MENU_TIER_ODDS`. The blind gamble is still the only route
 * that reaches them reliably, and that is the entire reason banking picks up
 * instead of tapping F the moment one lands.
 */
export type Rarity = 'common' | 'uncommon' | 'epic' | 'legendary';

/**
 * **The whole progression rule: tier is magnitude.**
 *
 * Every Cartridge owns exactly one *step* — one projectile, +14% damage, one
 * rung up a softcap curve. The tier it rolls says how many of those steps you
 * get at once, and nothing else. An uncommon Spore is two more projectiles, not
 * 1.75 of one; there is no tier at which an upgrade is fractionally better.
 *
 * The ladder is read off what already shipped rather than invented:
 * `epic-overclock` is 2.67x `+Attack Speed`, `legend-apex` is 4.7x `+Damage`.
 * 1 / 2 / 3 / 4 sits inside that band and is legible on a card.
 */
export const STEPS_BY_RARITY: Readonly<Record<Rarity, number>> = {
  common: 1,
  uncommon: 2,
  epic: 3,
  legendary: 4,
};

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
  /**
   * Accumulated steps per Cartridge, indexed by position in `CARTRIDGES`.
   *
   * An array rather than a map so the whole ladder is **one** `Frame` field
   * however many Cartridges exist, and so recording it is a fixed-length copy
   * into a preallocated frame rather than an allocation at 32 Hz. The index is
   * stable because `CARTRIDGES` is a module constant.
   */
  steps: number[];
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
  /** Solar Capacitor: extra ultimate gain multiplier while flow is full (+0.35/step). */
  solarCapacitor: number;
  /** Aurora Wake steps: flow pays +25% and drains slower per step. */
  auroraWake: number;
  /** Bramble: retaliatory flash damage when contact damage lands. 0 = off. */
  mirrorDamage: number;
  /** Echo Chamber: 1 = a dash-blast repeats at 60% from where it fired, 0.35 s later. */
  echoChamber: number;
  /** Standing Wave: fraction of speed the wake strips from chasers (0 = off, cap 0.55). */
  standingWaveSlow: number;
  /** Chorus: 1 = every 8th kill sings a free blast at the victim's position. */
  chorus: number;
}

export interface UpgradeContext {
  weapon: Weapon;
  playerHealth: Health;
  dash: Dash;
  perks: RunPerks;
}

/**
 * One offer, at a tier that has already been rolled.
 *
 * A Cartridge is *instantiated* into this shape the moment it is drawn, so
 * every consumer — the pick menu, the bank screen, a shrine blessing, the
 * gamble — keeps handling a plain object with a fixed rarity and a finished
 * description. Nothing downstream has to know that tiers are rolled at all.
 */
export interface Upgrade {
  id: string;
  name: string;
  /** Pictogram key — the screen-printed mark in the cartridge window. */
  icon: string;
  /**
   * The full sentence, for a reveal that has room for one.
   *
   * Kept separate from `effect` because the cartridge's label window is a
   * fixed socket in the art: a unique's prose ("Ground +2.5, air control
   * +0.25, jump +2, dash charge +1 and 2.5 s faster") runs to six lines in
   * there and spills straight out of the recess.
   */
  description: string;
  /** The short line printed in the cartridge window. Two lines at most. */
  effect: string;
  rarity: Rarity;
  /** Steps this offer grants. 0 for the fixed-tier uniques, which have no ladder. */
  steps: number;
  /** Steps already accumulated on this Cartridge before this offer. */
  owned: number;
  apply: (ctx: UpgradeContext) => void;
}

/**
 * A Cartridge: one drawing, one step, rollable at any tier.
 *
 * `step` is handed both what this pick added and the new accumulated total.
 * Linear stats use `added` and stay additive, so they compose with the flat
 * uniques. **Softcapped stats must use `total`** and apply the *delta along
 * their curve* (see `along`) — writing an absolute value would silently eat
 * whatever a unique had added to the same field.
 */
interface Cartridge {
  id: string;
  name: string;
  icon: string;
  /** The window's effect line, for the tier that was rolled. */
  effect: (steps: number) => string;
  step: (ctx: UpgradeContext, added: number, total: number) => void;
}

/**
 * The change a softcapped stat makes when `added` steps take it to `total`.
 *
 * Always a delta, never an absolute write — see the note on `Cartridge.step`.
 */
function along(curve: (s: number) => number, total: number, added: number): number {
  return curve(total) - curve(total - added);
}

const round1 = (n: number) => Math.round(n * 10) / 10;

/**
 * The Cartridge pool.
 *
 * Twelve of these fold in flat entries that used to be their own rows
 * (`+Damage`, `+Range`, `+Max HP`, `Quick Recovery`, `Extra Dash`, `Mirror
 * Array`...), and eleven are the named systems, which are steps too — their
 * first step is also what switches the system on.
 *
 * Order is load-bearing: `RunPerks.steps` is indexed by position here, so new
 * entries go on the **end**. Reordering mid-run would rewrite a player's whole
 * ladder.
 */
export const CARTRIDGES: Cartridge[] = [
  // -------------------------------------------------------------- offense
  {
    id: 'ember',
    name: 'Ember',
    icon: 'ember',
    effect: (s) => `+${s * 14}% damage`,
    // +14% of the authored base per step, additive, so a unique's flat bump
    // survives alongside it.
    step: (ctx, added) => {
      ctx.weapon.damage += 7 * 0.14 * added;
    },
  },
  {
    id: 'cadence',
    name: 'Cadence',
    icon: 'cadence',
    effect: (s) => `+${round1(s * 0.55)} shots/s`,
    step: (ctx, added) => {
      ctx.weapon.attacksPerSecond += 0.55 * added;
    },
  },
  {
    id: 'beam',
    name: 'Beam',
    icon: 'beam',
    effect: (s) => `+${round1(along(beamRange, s, s))} range`,
    // Softcapped: uncapped range turns the whole course into one kill volume
    // and quietly deletes the decision to surf *toward* a fight.
    step: (ctx, added, total) => {
      ctx.weapon.range += along(beamRange, total, added);
    },
  },

  // ------------------------------------------------------------- movement
  {
    id: 'surf',
    name: 'Surf',
    icon: 'surf',
    effect: (s) => `+${round1((along(surfAirControl, s, s) / (30 / 45)) * 100)}% air`,
    // Both softcapped. `epic-tailwind`'s flat +0.15 air control off a 0.667
    // base is already the pool's one open balance risk; a hard +30% ceiling
    // across every step in a run is deliberately tighter than the uncapped
    // `+Move Speed` this replaces.
    step: (_ctx, added, total) => {
      MovementConfig.MAX_AIR_WISH_SPEED += along(surfAirControl, total, added);
      MovementConfig.MAX_GROUND_SPEED += along(surfGroundSpeed, total, added);
    },
  },
  {
    id: 'updraft',
    name: 'Updraft',
    icon: 'updraft',
    effect: (s) => `+${round1(along(updraftJump, s, s))} jump`,
    step: (_ctx, added, total) => {
      MovementConfig.JUMP_SPEED += along(updraftJump, total, added);
    },
  },
  {
    id: 'pulse',
    name: 'Pulse',
    icon: 'pulse',
    effect: (s) => `−${round1(-along(pulseRecharge, s, s))}s dash`,
    // Replaces Quick Recovery *and* Extra Dash. The curve lands on the old
    // 1.5 s floor asymptotically, so `Math.max(1.5, ...)` disappears rather
    // than being a wall four picks slam into.
    step: (ctx, added, total) => {
      ctx.dash.rechargeSeconds += along(pulseRecharge, total, added);
      const extra = Math.floor(total / 3) - Math.floor((total - added) / 3);
      ctx.dash.maxCharges += extra;
      ctx.dash.charges += extra;
    },
  },

  // ------------------------------------------------------------- survival
  {
    id: 'heartwood',
    name: 'Heartwood',
    icon: 'heartwood',
    effect: (s) => `+${s * 18} max HP`,
    step: (ctx, added) => {
      ctx.playerHealth.maxHp += 18 * added;
      ctx.playerHealth.heal(18 * added);
    },
  },
  {
    id: 'chlorophyll',
    name: 'Chlorophyll',
    icon: 'chlorophyll',
    effect: (s) => `+${round1(s * 1.3)} HP/s`,
    step: (ctx, added) => {
      ctx.playerHealth.regenPerSecond += 1.3 * added;
    },
  },
  {
    id: 'graft',
    name: 'Graft',
    icon: 'graft',
    effect: (s) => `+${round1(s * 1.8)} on kill`,
    step: (ctx, added) => {
      ctx.perks.healOnKill += 1.8 * added;
    },
  },
  {
    id: 'bramble',
    name: 'Bramble',
    icon: 'bramble',
    effect: (s) => `+${s * 12} thorns`,
    // Folds in Mirror Array, which was already exactly this — a flat slider
    // wearing a build-piece name.
    step: (ctx, added) => {
      ctx.perks.mirrorDamage += 12 * added;
    },
  },

  // -------------------------------------------------------------- economy
  {
    id: 'pollen',
    name: 'Pollen',
    icon: 'pollen',
    effect: (s) => `+${round1(along(pollenRadius, s, s))}u magnet`,
    // Softcapped so pickup range cannot outgrow the weapon's 22-unit kill
    // envelope by so much that collecting stops being a positioning decision.
    step: (_ctx, added, total) => {
      XP_MAGNET.radius += along(pollenRadius, total, added);
    },
  },
  {
    id: 'harvest',
    name: 'Harvest',
    icon: 'harvest',
    effect: (s) => `+${s * 20}% XP`,
    step: (ctx, added) => {
      ctx.perks.xpMultiplier += 0.2 * added;
    },
  },

  // ---------------------------------------------- the named systems (11)
  //
  // Steps like everything else. What makes them systems rather than plain
  // numbers is that the first step also switches something on.
  {
    id: 'photosynthesis',
    name: 'Photosynthesis',
    icon: 'photosynthesis',
    effect: (s) => `+${round1(s * 1.2)} HP/s airborne`,
    step: (ctx, added) => {
      ctx.perks.airRegenPerSecond += 1.2 * added;
    },
  },
  {
    id: 'heliotropism',
    name: 'Heliotropism',
    icon: 'heliotropism',
    effect: () => 'orb reach at speed',
    step: (ctx, added) => {
      ctx.perks.heliotropism += added;
    },
  },
  {
    id: 'doppler-drive',
    name: 'Doppler Drive',
    icon: 'doppler',
    effect: (s) => `+${round1(s * 0.5)}/s at speed`,
    step: (ctx, added) => {
      ctx.perks.dopplerAps += 0.5 * added;
    },
  },
  {
    id: 'subwoofer',
    name: 'Subwoofer',
    icon: 'subwoofer',
    effect: (s) => `+${s * 2} blast radius`,
    step: (ctx, added) => {
      // Radius unconditionally — a step must never be silently lost — plus the
      // no-dead-pick rule: drawn before Sound Blast itself, it brings the blast
      // with it.
      ctx.perks.soundBlastRadius += 2 * added;
      if (ctx.perks.soundBlastDamage === 0) ctx.perks.soundBlastDamage += 15;
    },
  },
  {
    id: 'velocity-rounds',
    name: 'Velocity Rounds',
    icon: 'velocity',
    effect: () => 'damage at speed',
    step: (ctx, added, total) => {
      // The first step ever taken arms it; every step past that one falls back
      // to flat damage, so neither a repeat pick nor the extra steps of a high
      // tier are ever dead.
      const wasArmed = total - added > 0;
      ctx.weapon.damage += 3 * (wasArmed ? added : added - 1);
      ctx.weapon.velocityRounds = true;
    },
  },
  {
    id: 'sound-blast',
    name: 'Sound Blast',
    icon: 'soundblast',
    effect: (s) => `+${s * 20} dash blast`,
    step: (ctx, added) => {
      ctx.perks.soundBlastDamage += 20 * added;
    },
  },
  {
    id: 'solar-wave',
    name: 'Solar Wave',
    icon: 'solarwave',
    effect: (s) => `+${s * 10}/s burning wake`,
    step: (ctx, added) => {
      ctx.perks.solarWaveDps += 10 * added;
    },
  },
  {
    id: 'solar-capacitor',
    name: 'Solar Capacitor',
    icon: 'capacitor',
    effect: (s) => `+${s * 35}% ult at flow`,
    step: (ctx, added) => {
      ctx.perks.solarCapacitor += 0.35 * added;
    },
  },
  {
    id: 'aurora-wake',
    name: 'Aurora Wake',
    icon: 'aurora',
    effect: (s) => `+${s * 25}% flow XP`,
    step: (ctx, added) => {
      ctx.perks.auroraWake += added;
    },
  },
  {
    id: 'echo-chamber',
    name: 'Echo Chamber',
    icon: 'echo',
    effect: (s) => `+${s * 10} blast, repeats`,
    step: (ctx, added) => {
      ctx.perks.soundBlastDamage += 10 * added;
      ctx.perks.echoChamber = 1;
    },
  },
  {
    id: 'standing-wave',
    name: 'Standing Wave',
    icon: 'standing',
    effect: () => 'wake drags pursuers',
    step: (ctx, _added, total) => {
      // The one field only this Cartridge writes, so it can be set absolutely
      // from the total instead of walking a delta. Brings a starter wake along
      // if Solar Wave is unowned — the Subwoofer rule again.
      if (ctx.perks.solarWaveDps === 0) ctx.perks.solarWaveDps += 6;
      ctx.perks.standingWaveSlow = Math.min(0.55, 0.3 + 0.1 * (total - 1));
    },
  },
];

// The softcap curves, kept beside each other so the shapes can be compared.
// Each returns the *total* bonus at `s` accumulated steps; `along` turns that
// into the delta a pick applies.
function beamRange(s: number): number {
  return (30 * s) / (s + 7); // -> +30 at infinity, off a base of 22
}
function surfAirControl(s: number): number {
  return (30 / 45) * ((0.3 * s) / (s + 6)); // -> +30% of the authored base
}
function surfGroundSpeed(s: number): number {
  return (4 * s) / (s + 5); // -> 11 u/s at infinity
}
function updraftJump(s: number): number {
  return (4.5 * s) / (s + 5); // -> 11.2 at infinity
}
function pulseRecharge(s: number): number {
  return (-4.5 * s) / (s + 4); // -> 1.5 s at infinity, off a base of 6
}
function pollenRadius(s: number): number {
  return (26 * s) / (s + 6); // -> 44 at infinity, off a base of 18
}

const CARTRIDGE_INDEX = new Map(CARTRIDGES.map((c, i) => [c.id, i]));

/** Steps accumulated on one Cartridge so far this run. */
export function cartridgeSteps(perks: RunPerks, id: string): number {
  const index = CARTRIDGE_INDEX.get(id);
  return index === undefined ? 0 : perks.steps[index];
}

const PERK_DEFAULTS: Omit<RunPerks, 'steps'> = {
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
  // `steps` is built fresh rather than spread out of the defaults: a shared
  // array would be mutated by play and every later run would start pre-levelled.
  return { ...PERK_DEFAULTS, steps: new Array(CARTRIDGES.length).fill(0) };
}

export function resetRunPerks(perks: RunPerks): void {
  Object.assign(perks, PERK_DEFAULTS);
  perks.steps.fill(0);
}

/**
 * Turn a Cartridge into a concrete offer at a rolled tier.
 *
 * The returned `apply` is what books the steps, so the ladder can only ever
 * advance through a pick actually being taken.
 */
function instantiate(cartridge: Cartridge, rarity: Rarity, perks: RunPerks): Upgrade {
  const added = STEPS_BY_RARITY[rarity];
  const index = CARTRIDGE_INDEX.get(cartridge.id) as number;
  return {
    id: cartridge.id,
    name: cartridge.name,
    icon: cartridge.icon,
    description: cartridge.effect(added),
    effect: cartridge.effect(added),
    rarity,
    steps: added,
    owned: perks.steps[index],
    apply: (ctx) => {
      ctx.perks.steps[index] += added;
      cartridge.step(ctx, added, ctx.perks.steps[index]);
    },
  };
}

/**
 * The fixed-tier uniques — no ladder, one named clause, gamble-only.
 *
 * Every entry writes only fields `Rewind`'s `Frame` already records — either
 * directly, or through `DashSnapshot` — so none of them needed the recorder
 * touched. Keep it that way: an upgrade whose field is not in `Frame` is one
 * a rewind silently leaves applied.
 */
const UNIQUES: Omit<Upgrade, 'owned'>[] = [
  {
    id: 'epic-overclock',
    name: 'Overclock',
    icon: 'overclock',
    description: 'Attacks per second +1.6, weapon range +6',
    effect: 'rate + range',
    rarity: 'epic',
    steps: 0,
    apply: (ctx) => {
      ctx.weapon.attacksPerSecond += 1.6;
      ctx.weapon.range += 6;
    },
  },
  {
    id: 'epic-resonance',
    name: 'Resonance',
    icon: 'resonance',
    description: 'Sound Blast +45 damage, heal 4 HP per kill',
    effect: 'blast + heal',
    rarity: 'epic',
    steps: 0,
    apply: (ctx) => {
      ctx.perks.soundBlastDamage += 45;
      ctx.perks.healOnKill += 4;
    },
  },
  {
    id: 'epic-tailwind',
    name: 'Tailwind',
    icon: 'tailwind',
    description: 'Ground cap +1.5, air control +0.15, jump +1.2',
    effect: 'speed + jump',
    rarity: 'epic',
    steps: 0,
    apply: () => {
      MovementConfig.MAX_GROUND_SPEED += 1.5;
      MovementConfig.MAX_AIR_WISH_SPEED += 0.15;
      MovementConfig.JUMP_SPEED += 1.2;
    },
  },
  {
    id: 'epic-bloodstone',
    name: 'Bloodstone',
    icon: 'bloodstone',
    description: 'Max HP +45 (healed), recover 2.5 HP per second',
    effect: 'HP + regen',
    rarity: 'epic',
    steps: 0,
    apply: (ctx) => {
      ctx.playerHealth.maxHp += 45;
      ctx.playerHealth.heal(45);
      ctx.playerHealth.regenPerSecond += 2.5;
    },
  },
  {
    id: 'epic-slipstream',
    name: 'Slipstream',
    icon: 'slipstream',
    description: 'Max dash charges +2 (granted), recharge 2 s faster',
    effect: 'dash charges',
    rarity: 'epic',
    steps: 0,
    apply: (ctx) => {
      ctx.dash.maxCharges += 2;
      ctx.dash.charges += 2;
      ctx.dash.rechargeSeconds = Math.max(1.5, ctx.dash.rechargeSeconds - 2);
    },
  },
  {
    id: 'epic-tuition',
    name: 'Tuition',
    icon: 'tuition',
    description: 'All XP +60%, orbs home in from 10 units further',
    effect: 'XP + magnet',
    rarity: 'epic',
    steps: 0,
    apply: (ctx) => {
      ctx.perks.xpMultiplier += 0.6;
      XP_MAGNET.radius += 10;
    },
  },
  {
    id: 'legend-apex',
    name: 'Apex Predator',
    icon: 'apex',
    description: 'Damage +14, attacks per second +1.2, Velocity Rounds online',
    effect: 'damage + rate',
    rarity: 'legendary',
    steps: 0,
    apply: (ctx) => {
      ctx.weapon.damage += 14;
      ctx.weapon.attacksPerSecond += 1.2;
      ctx.weapon.velocityRounds = true;
    },
  },
  {
    id: 'legend-perpetual',
    name: 'Perpetual Motion',
    icon: 'perpetual',
    description: 'Ground +2.5, air control +0.25, jump +2, dash charge +1 and 2.5 s faster',
    effect: 'all movement',
    rarity: 'legendary',
    steps: 0,
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
    icon: 'vampirelord',
    description: 'Max HP +60 (healed), regen +4 HP/s, heal 8 HP on every kill',
    effect: 'HP + lifesteal',
    rarity: 'legendary',
    steps: 0,
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
    icon: 'corona',
    description: 'Solar wake burns +35/s, Sound Blast +35 damage',
    effect: 'wake + blast',
    rarity: 'legendary',
    steps: 0,
    apply: (ctx) => {
      ctx.perks.solarWaveDps += 35;
      ctx.perks.soundBlastDamage += 35;
    },
  },
  {
    id: 'legend-chorus',
    name: 'Chorus',
    icon: 'chorus',
    description: 'Every 8th kill sings a free Sound Blast where it died',
    effect: 'free blasts',
    rarity: 'legendary',
    steps: 0,
    apply: (ctx) => {
      // Dupes deepen the song instead of double-counting kills.
      if (ctx.perks.chorus > 0) ctx.perks.soundBlastDamage += 25;
      ctx.perks.chorus = 1;
    },
  },
];

/**
 * Tier odds for one level-up card, in permille so a row sums exactly.
 *
 * **An epic in a pick menu should be a story and a legendary a run you
 * remember.** Across a forty-level run at four cards that is ~1.6 epic-or-
 * better in total, against 68% from a single full-stake gamble — and that gap
 * is what keeps banking a real decision rather than a slower way to take the
 * safe thing.
 */
const MENU_TIER_ODDS: Readonly<Record<Rarity, number>> = {
  common: 870,
  uncommon: 120,
  epic: 9,
  legendary: 1,
};

function rollMenuRarity(): Rarity {
  let roll = Math.random() * 1000;
  if ((roll -= MENU_TIER_ODDS.legendary) < 0) return 'legendary';
  if ((roll -= MENU_TIER_ODDS.epic) < 0) return 'epic';
  if ((roll -= MENU_TIER_ODDS.uncommon) < 0) return 'uncommon';
  return 'common';
}

/**
 * `count` choices for one pick.
 *
 * Cartridges are drawn without replacement within a menu, and each one rolls
 * its own tier — so the same Ember can be a common on one level-up and an epic
 * on the next. The pool never shrinks across a run: builds come from which
 * offers you take, not from exhausting a list.
 */
export function drawUpgradeChoices(count: number, perks: RunPerks): Upgrade[] {
  const pool = [...CARTRIDGES];
  const choices: Upgrade[] = [];
  for (let i = 0; i < count && pool.length > 0; i++) {
    const index = Math.floor(Math.random() * pool.length);
    choices.push(instantiate(pool.splice(index, 1)[0], rollMenuRarity(), perks));
  }
  return choices;
}

interface RarityOdds {
  common: number;
  uncommon: number;
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
 * a single common Cartridge for five levels of progress there is no gamble
 * here, just a slower way to take the good outcome.
 *
 * The shape: staking two is a clearly bad bet, four is roughly break-even, five
 * is marginally favourable. That the ratio climbs with the stake is the point —
 * banking toward the cap should feel like it is building toward something.
 */
const GAMBLE_ODDS: readonly RarityOdds[] = [
  { common: 500, uncommon: 340, epic: 150, legendary: 10 }, // 0 — unused
  { common: 500, uncommon: 340, epic: 150, legendary: 10 }, // 1 — unused
  { common: 500, uncommon: 340, epic: 150, legendary: 10 },
  { common: 320, uncommon: 340, epic: 280, legendary: 60 },
  { common: 200, uncommon: 280, epic: 340, legendary: 180 },
  { common: 120, uncommon: 200, epic: 330, legendary: 350 },
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
  if ((roll -= odds.uncommon) < 0) return 'uncommon';
  return 'common';
}

/**
 * One offer of the given tier, for the gamble.
 *
 * Draws from the uniques of that tier *and* the whole Cartridge pool, which is
 * how a Cartridge reaches epic and legendary at all reliably — and it is the
 * only place a x3 or x4 step is likely to come from.
 */
export function drawOfRarity(rarity: Rarity, perks: RunPerks): Upgrade {
  const uniques = UNIQUES.filter((u) => u.rarity === rarity);
  const total = uniques.length + CARTRIDGES.length;
  const roll = Math.floor(Math.random() * total);
  if (roll < uniques.length) return { ...uniques[roll], owned: 0 };
  return instantiate(CARTRIDGES[roll - uniques.length], rarity, perks);
}
