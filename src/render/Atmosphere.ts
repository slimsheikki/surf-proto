/**
 * One preset → the whole atmosphere. Sky dome, hemisphere fill light, and fog
 * colour all come from a single `SkyPreset`, so top / horizon / ground / fog can
 * never drift out of agreement — the coupling CLAUDE.md relies on ("distant
 * geometry fades into the *sky's* colour") made structural.
 */

import { HemisphereLight, type Mesh } from 'three';
import { SKY_PRESETS, type SkyPresetName, type SkyPreset } from './Palette';
import { buildSkyGradientDome } from './SkyGradient';

/** Sky-vs-ground fill strength. Lifts shadowed facets off pure black. */
export const HEMI_INTENSITY = 0.85;
/** The banded key light. Paired down from the classic 1.1 so the top band of */
/** the toon ramp doesn't clip against the hemisphere floor. */
export const SUN_INTENSITY = 1.0;

export interface Atmosphere {
  readonly sky: Mesh;
  readonly hemisphere: HemisphereLight;
  /** Fog + clear colour — the horizon the gradient melts into. */
  readonly horizon: number;
  readonly preset: SkyPreset;
}

export function makeAtmosphere(name: SkyPresetName): Atmosphere {
  const preset = SKY_PRESETS[name];
  return {
    sky: buildSkyGradientDome(preset),
    hemisphere: new HemisphereLight(preset.top, preset.ground, HEMI_INTENSITY),
    horizon: preset.horizon,
    preset,
  };
}
