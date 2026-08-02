import { Health } from '../combat/Health';
import { Knife } from '../combat/Knife';
import { Weapon } from '../combat/Weapon';
import { Dash } from '../player/Dash';
import { MovementConfig } from '../player/MovementConfig';
import { XP_MAGNET } from './XPOrb';

/**
 * Run-scoped perks that live on `Game` rather than on any one subsystem —
 * hooks the game loop reads at the moment the relevant event happens (a kill,
 * an XP pickup). Reset wholesale on restart via `resetRunPerks`, the same
 * copy-the-defaults contract `resetMovementConfig` uses, so a new perk added
 * here is automatically reset without anyone remembering to list it.
 */
export interface RunPerks {
  /** HP restored per drone kill. */
  healOnKill: number;
  /** Multiplier on all XP gained. */
  xpMultiplier: number;
}

const PERK_DEFAULTS: RunPerks = {
  healOnKill: 0,
  xpMultiplier: 1,
};

export function createRunPerks(): RunPerks {
  return { ...PERK_DEFAULTS };
}

export function resetRunPerks(perks: RunPerks): void {
  Object.assign(perks, PERK_DEFAULTS);
}

export interface UpgradeContext {
  weapon: Weapon;
  knife: Knife;
  playerHealth: Health;
  dash: Dash;
  perks: RunPerks;
}

export interface Upgrade {
  id: string;
  name: string;
  description: string;
  apply: (ctx: UpgradeContext) => void;
}

/**
 * The item pool, Megabonk-flavoured: lots of small stacking bonuses across
 * every system, drawn three at a time by both level-ups and shrine blessings.
 * Every entry is repeatable — drawing is without replacement per menu but the
 * pool never shrinks across a run, so builds come from which offers you take,
 * not from exhausting a list.
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
    apply: (ctx) => {
      ctx.weapon.damage += 3;
    },
  },
  {
    id: 'attack-speed',
    name: '+Attack Speed',
    description: 'Attacks per second +0.6',
    apply: (ctx) => {
      ctx.weapon.attacksPerSecond += 0.6;
    },
  },
  {
    id: 'weapon-range',
    name: '+Range',
    description: 'Auto-weapon range +5',
    apply: (ctx) => {
      ctx.weapon.range += 5;
    },
  },
  {
    id: 'velocity-rounds',
    name: 'Velocity Rounds',
    description: 'Shots gain damage with your speed (up to +15)',
    apply: (ctx) => {
      // Already-owned copies fall back to a flat damage bump, so a duplicate
      // draw is never a dead pick.
      if (ctx.weapon.velocityRounds) ctx.weapon.damage += 3;
      ctx.weapon.velocityRounds = true;
    },
  },
  {
    id: 'knife-damage',
    name: '+Knife Damage',
    description: 'Knife damage +12',
    apply: (ctx) => {
      ctx.knife.bonusDamage += 12;
    },
  },
  {
    id: 'knife-reach',
    name: '+Knife Reach',
    description: 'Knife reach +0.8',
    apply: (ctx) => {
      ctx.knife.bonusRange += 0.8;
    },
  },
  {
    id: 'move-speed',
    name: '+Move Speed',
    description: 'Ground & air speed caps up',
    apply: () => {
      MovementConfig.MAX_GROUND_SPEED += 0.6;
      MovementConfig.MAX_AIR_WISH_SPEED += 0.06;
    },
  },
  {
    id: 'max-hp',
    name: '+Max HP',
    description: 'Max HP +20, heal to match',
    apply: (ctx) => {
      ctx.playerHealth.maxHp += 20;
      ctx.playerHealth.heal(20);
    },
  },
  {
    id: 'regen',
    name: 'Regeneration',
    description: 'Recover 1.5 HP per second',
    apply: (ctx) => {
      ctx.playerHealth.regenPerSecond += 1.5;
    },
  },
  {
    id: 'vampiric',
    name: 'Vampiric Edge',
    description: 'Heal 2 HP on every kill',
    apply: (ctx) => {
      ctx.perks.healOnKill += 2;
    },
  },
  {
    id: 'jump-height',
    name: '+Jump Height',
    description: 'Jump speed +0.8 — handy for chaining ramps',
    apply: () => {
      MovementConfig.JUMP_SPEED += 0.8;
    },
  },
  {
    id: 'extra-dash',
    name: 'Extra Dash',
    description: 'Max dash charges +1, granted immediately',
    apply: (ctx) => {
      ctx.dash.maxCharges += 1;
      ctx.dash.charges += 1;
    },
  },
  {
    id: 'dash-recharge',
    name: 'Quick Recovery',
    description: 'Dash recharges 1.2 s faster',
    apply: (ctx) => {
      ctx.dash.rechargeSeconds = Math.max(1.5, ctx.dash.rechargeSeconds - 1.2);
    },
  },
  {
    id: 'magnet',
    name: 'XP Magnet',
    description: 'Orbs home in from 6 units further out',
    apply: () => {
      XP_MAGNET.radius += 6;
    },
  },
  {
    id: 'scholar',
    name: 'Scholar',
    description: 'All XP gained +25%',
    apply: (ctx) => {
      ctx.perks.xpMultiplier += 0.25;
    },
  },
];

export function drawUpgradeChoices(count: number): Upgrade[] {
  const pool = [...UPGRADE_POOL];
  const choices: Upgrade[] = [];
  for (let i = 0; i < count && pool.length > 0; i++) {
    const idx = Math.floor(Math.random() * pool.length);
    choices.push(pool.splice(idx, 1)[0]);
  }
  return choices;
}
