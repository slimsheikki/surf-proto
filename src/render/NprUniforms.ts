/**
 * The one shared uniform bag every NPR material references.
 *
 * Because these objects are shared by reference across every patched material,
 * writing `nprUniforms.uNprEnabled.value = 0` flips the whole game at once with
 * no per-material walk — that is what makes the master A/B toggle and the retro
 * switches a single assignment each. See `NprMaterials.patchToon`.
 */

import { Color, type Texture, type IUniform } from 'three';
import { PALETTE } from './Palette';

export interface NprUniforms {
  /** Master cel-shading switch. 1 = NPR lighting, 0 = stock Three lighting. */
  uNprEnabled: IUniform<number>;
  /** NearestFilter band ramp sampled by clamped N·L (set at boot). */
  uToonRamp: IUniform<Texture | null>;
  // Fresnel rim (only compiled where the NPR_RIM define is set — characters).
  uRimColor: IUniform<Color>;
  uRimPower: IUniform<number>;
  uRimStrength: IUniform<number>;
  // Retro toggles — all default 0/off, subtle by design.
  /** Ordered Bayer screen-door transparency. */
  uDither: IUniform<number>;
  /** Posterize final colour to N levels/channel (0 = off; used when > 1.5). */
  uQuantize: IUniform<number>;
  /** Affine-ish texture UV wobble (needs a map). */
  uAffine: IUniform<number>;
  uAffineAmp: IUniform<number>;
  /** PS1 vertex snap/jitter. */
  uVertexWobble: IUniform<number>;
  /** Screen grid the snapped vertex lands on (higher = finer). */
  uSnap: IUniform<number>;
  // Inverted-hull outline — shared so all outlines are one program and collapse
  // to nothing when NPR is toggled off (width is multiplied by uNprEnabled).
  /** Screen-stable outline width, in NDC half-units (~fraction of screen). */
  uOutlineWidth: IUniform<number>;
  uOutlineColor: IUniform<Color>;
}

export const nprUniforms: NprUniforms = {
  uNprEnabled: { value: 1 },
  uToonRamp: { value: null },
  uRimColor: { value: new Color(PALETTE.white) },
  uRimPower: { value: 3.0 },
  uRimStrength: { value: 0.5 },
  uDither: { value: 0 },
  uQuantize: { value: 0 },
  uAffine: { value: 0 },
  uAffineAmp: { value: 0.01 },
  uVertexWobble: { value: 0 },
  uSnap: { value: 160 },
  uOutlineWidth: { value: 0.009 },
  uOutlineColor: { value: new Color(PALETTE.black) },
};
