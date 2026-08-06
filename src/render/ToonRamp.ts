/**
 * The cel band ramp: a 1-D `NearestFilter` texture the shader samples by
 * clamped N·L. `NearestFilter` + one texel per band is what turns a smooth
 * Lambert falloff into hard steps — the whole "quantize the diffuse" trick in a
 * texture, so band count and shape are data, not shader edits.
 *
 * The darkest band is 0: fully-shadowed facets are lit only by the hemisphere
 * floor (see the lighting override in `NprMaterials`), never pure black.
 */

import { DataTexture, NearestFilter, RedFormat, UnsignedByteType } from 'three';

const cache = new Map<number, DataTexture>();

/** Number of diffuse bands the default look uses. */
export const NPR_BANDS = 4;

/**
 * A `bands`-wide ramp rising 0 → 1 in equal steps. Cached per band count so the
 * whole app shares one texture per distinct ramp.
 */
export function toonRamp(bands: number): DataTexture {
  const n = Math.max(2, Math.floor(bands));
  const hit = cache.get(n);
  if (hit) return hit;

  const data = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    // 0, …, 1 across the bands; step i covers N·L in [i/n, (i+1)/n).
    data[i] = Math.round((i / (n - 1)) * 255);
  }
  const tex = new DataTexture(data, n, 1, RedFormat, UnsignedByteType);
  tex.magFilter = NearestFilter;
  tex.minFilter = NearestFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  cache.set(n, tex);
  return tex;
}
