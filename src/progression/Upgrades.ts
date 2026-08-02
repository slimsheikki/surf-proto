import { Health } from '../combat/Health';
import { Weapon } from '../combat/Weapon';
import { Dash } from '../player/Dash';
import { MovementConfig } from '../player/MovementConfig';

export interface UpgradeContext {
  weapon: Weapon;
  playerHealth: Health;
  dash: Dash;
}

export interface Upgrade {
  id: string;
  name: string;
  description: string;
  apply: (ctx: UpgradeContext) => void;
}

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
