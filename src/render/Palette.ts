/**
 * The NPR palette — the single source of truth for the cel-shaded look.
 *
 * Jet Set Radio's language is a handful of loud, saturated inks against a huge
 * gradient sky. These are those inks. Colours that used to live as scattered
 * `0x…` literals across ~27 files are being pulled here so the whole game reads
 * as one poster; sites migrate to `PALETTE` stage by stage.
 *
 * **Violet is the player and no enemy may wear it** (CLAUDE.md "one hue, one
 * owner"). `assertNotPlayerHue` operationalizes that — call it from any factory
 * that builds an enemy/boss body so a stray violet can never ship.
 */

import { Color } from 'three';

/** Saturated ink set. Numbers so call sites can pass them straight to Three. */
export const PALETTE = {
  cyan: 0x3fe0ff,
  brightBlue: 0x2b7bff,
  blue: 0x1b4fd6,
  purple: 0x8b5cf6,
  /** The player's hue — crosshair/wordmark/panels/seeds. Owned. */
  playerViolet: 0xb45cff,
  playerVioletBright: 0xd9a5ff,
  lime: 0x7dff43,
  yellow: 0xffe33d,
  orange: 0xff7a1a,
  hotPink: 0xff4d9d,
  white: 0xf5ffff,
  black: 0x0a0a0a,
} as const;

/** A vertical sky: `top` at the zenith, `horizon` at the ground line, `ground` */
/** below (also the hemisphere light's floor and the fog colour). */
export interface SkyPreset {
  readonly top: number;
  readonly horizon: number;
  readonly ground: number;
  /** How hard the gradient bands above the horizon (2–5); the horizon itself */
  /** stays smooth so distant geometry melts in. */
  readonly bands: number;
}

export const SKY_PRESETS = {
  /** Bright arcade daytime — cyan overhead to a warm horizon. */
  day: { top: 0x1fb6ff, horizon: 0xbfe9ff, ground: 0x6fb0c8, bands: 4 },
  /** Purple dusk. */
  dusk: { top: 0x3a1d8a, horizon: 0xff8bd0, ground: 0x5b3aa0, bands: 5 },
  /** Orange sunset — the game's default mood, keyed to the old horizon gold. */
  sunset: { top: 0x2b6fd6, horizon: 0xeab262, ground: 0xb0673a, bands: 4 },
} as const satisfies Record<string, SkyPreset>;

export type SkyPresetName = keyof typeof SKY_PRESETS;

// -------------------------------------------------------------- hue guard

const _hsl = { h: 0, s: 0, l: 0 };
const _probe = new Color();
const _violetHsl = { h: 0, s: 0, l: 0 };
new Color(PALETTE.playerViolet).getHSL(_violetHsl);

/** Circular distance between two hues in [0,1) turns → [0,0.5]. */
function hueDistance(a: number, b: number): number {
  const d = Math.abs(a - b) % 1;
  return d > 0.5 ? 1 - d : d;
}

/**
 * Throws in dev if `color` sits in the player's violet band (and is saturated
 * enough to read as a hue rather than a near-grey). No-op in production so it
 * can never cost a shipped frame. Wire it into enemy/boss material factories.
 */
export function assertNotPlayerHue(color: number): void {
  if (!import.meta.env.DEV) return;
  _probe.set(color).getHSL(_hsl);
  if (_hsl.s > 0.25 && hueDistance(_hsl.h, _violetHsl.h) < 0.055) {
    throw new Error(
      `NPR palette: color #${color.toString(16).padStart(6, '0')} is in the player's ` +
        `violet band — violet is the player's hue, no enemy may wear it.`,
    );
  }
}
