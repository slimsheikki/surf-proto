import { Upgrade } from '../progression/Upgrades';
import { CARTRIDGE_ICONS } from './CartridgeIcons';

/**
 * An upgrade drawn as the thing it is in the fiction: a cartridge you inject.
 *
 * The art (`public/MEGAFLOW_HP_DASH_UI_ELEMENTS/ICON_Upgrade_*.png`) is a
 * translucent shell with **two recesses moulded into it**, and everything here
 * sits in one of them:
 *
 * - the long rounded debossing across the top carries the name
 * - the big label window carries the pictogram, with the effect line under it
 *
 * **Both rects are measured off the PNGs' own geometry, not chosen** — the same
 * rule `MegaflowHud`'s bar slots follow, and the reason a cartridge stays
 * correct at every size. Measured at 365x404: the pill is `x 50 y 30 265x70`,
 * the window `x 52 y 124 254x206`. They are expressed below as percentages so
 * one `--cart-w` drives the whole component; re-export the art and re-measure
 * rather than nudging them by eye.
 */

/** The two sockets, as fractions of the art. See the note above. */
export const CART_PILL = { left: 13.7, top: 7.43, width: 72.6, height: 17.33 };
export const CART_WINDOW = { left: 14.25, top: 30.69, width: 69.59, height: 50.99 };

/**
 * A name long enough to need the smaller size in the pill.
 *
 * The pill is a fixed slot in the art and cannot grow, so the type has to. Set
 * from the longest name the pool actually holds ("Perpetual Motion").
 */
const LONG_NAME_CHARS = 11;

/**
 * The cartridge body, ready to drop inside a `.upgrade-choice` button.
 *
 * The tier comes from the caller's `rarity-*` class, which is what picks the
 * shell colour — so this markup is identical at every tier and the pictogram
 * never has to know which body it landed on.
 */
export function cartridgeMarkup(upgrade: Upgrade): string {
  const icon = CARTRIDGE_ICONS[upgrade.icon] ?? '';
  const long = upgrade.name.length > LONG_NAME_CHARS ? ' long' : '';
  // The running total is the affordance a tiered pool cannot do without:
  // nothing else on screen says how deep you already are on this Cartridge.
  const owned = upgrade.steps > 0 && upgrade.owned > 0
    ? `<span class="cart-owned">${upgrade.owned}</span>`
    : '';
  return (
    `<span class="cart">` +
    `<span class="cart-name${long}">${upgrade.name}</span>` +
    `<span class="cart-face">` +
    `<svg class="cart-glyph" viewBox="0 0 24 24" aria-hidden="true">${icon}</svg>` +
    `<span class="cart-effect">${upgrade.effect}</span>` +
    `</span>${owned}</span>`
  );
}
