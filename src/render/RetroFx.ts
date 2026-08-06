/**
 * The optional retro toggles — slight affine UV wobble, tiny vertex snap,
 * ordered dithering, colour quantization, nearest-neighbour texture filtering.
 * Subtle by design and **off by default**; each is one flag that writes the
 * shared retro uniforms (so every material updates at once) plus the ramp
 * texture's filter mode. Wired to the settings switches under Advanced.
 */

import { nprUniforms } from './NprUniforms';
import { setRampTextureNearest } from '../world/RampTexture';

export interface RetroState {
  /** Ordered Bayer screen-door transparency. */
  dither: boolean;
  /** Posterize the final colour. */
  quantize: boolean;
  /** Affine-ish texture UV wobble. */
  affine: boolean;
  /** PS1 vertex snap/jitter. */
  vertexWobble: boolean;
  /** Nearest-neighbour texture filtering (crunchy). */
  nearest: boolean;
}

/** Levels/channel when colour quantization is on. */
const QUANTIZE_LEVELS = 6;

export function applyRetro(state: RetroState): void {
  nprUniforms.uDither.value = state.dither ? 1 : 0;
  nprUniforms.uQuantize.value = state.quantize ? QUANTIZE_LEVELS : 0;
  nprUniforms.uAffine.value = state.affine ? 1 : 0;
  nprUniforms.uVertexWobble.value = state.vertexWobble ? 1 : 0;
  setRampTextureNearest(state.nearest);
}
