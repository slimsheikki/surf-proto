/**
 * The banded gradient sky — the loudest single piece of the JSR identity.
 *
 * A tall posterized ramp painted onto an inward sphere: hard colour bands above
 * the horizon, a smooth sliver *at* the horizon so distant geometry (and the
 * fog, keyed to the same horizon colour) melts in with no seam, and the ground
 * colour below. Painted to a `CanvasTexture` on a `MeshBasicMaterial` rather
 * than a raw `ShaderMaterial` so it rides Three's colour management exactly like
 * the old painted dome — same flags, drop-in swap.
 */

import {
  BackSide,
  CanvasTexture,
  Color,
  Mesh,
  MeshBasicMaterial,
  SphereGeometry,
  SRGBColorSpace,
} from 'three';
import type { SkyPreset } from './Palette';

const DOME_RADIUS = 1200;
const CANVAS_H = 512;

/** Fraction of the dome height the horizon sits at (V=0 top … V=1 bottom). */
const HORIZON_V = 0.5;
/** How tall (in sky fraction t) the smooth blend at the horizon line is. */
const HORIZON_FEATHER = 0.09;

/** Colour along the sky at height `t` (0 = horizon, 1 = zenith), horizon → mid → top. */
function skyColor(out: Color, horizon: Color, mid: Color | null, top: Color, t: number): Color {
  if (!mid) return out.copy(horizon).lerp(top, t);
  return t < 0.5
    ? out.copy(horizon).lerp(mid, t * 2)
    : out.copy(mid).lerp(top, (t - 0.5) * 2);
}

function paintSky(preset: SkyPreset): CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 4;
  canvas.height = CANVAS_H;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('SkyGradient: 2D canvas context unavailable');

  const top = new Color(preset.top);
  const mid = preset.mid !== undefined ? new Color(preset.mid) : null;
  const horizon = new Color(preset.horizon);
  const ground = new Color(preset.ground);
  const c = new Color();

  const horizonY = Math.round(HORIZON_V * CANVAS_H);
  const bands = Math.max(2, preset.bands);

  // Sky: horizon → mid → top, quantized into flat bands, with a smooth feather
  // at the horizon line so distant geometry (and the fog) melt in seamlessly.
  for (let y = 0; y < horizonY; y++) {
    const t = 1 - y / horizonY; // 0 at horizon, 1 at zenith
    const banded = Math.round(t * bands) / bands;
    const w = Math.min(1, t / HORIZON_FEATHER); // 0 at horizon → 1 above feather
    const tt = t * (1 - w) + banded * w;
    skyColor(c, horizon, mid, top, tt);
    ctx.fillStyle = `#${c.getHexString()}`;
    ctx.fillRect(0, y, 4, 1);
  }
  // Ground: horizon → ground below the line.
  for (let y = horizonY; y < CANVAS_H; y++) {
    const t = (y - horizonY) / (CANVAS_H - horizonY);
    c.copy(horizon).lerp(ground, Math.min(1, t * 1.6));
    ctx.fillStyle = `#${c.getHexString()}`;
    ctx.fillRect(0, y, 4, 1);
  }

  const tex = new CanvasTexture(canvas);
  tex.colorSpace = SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/**
 * An inward gradient dome. Same behaviour flags as the painted sky
 * (`Sky.buildSkyDome`) so App can swap one for the other: fog-exempt,
 * depth-write off, drawn first, never culled. App re-centres it on the camera
 * each frame, so it reads as infinitely far.
 */
export function buildSkyGradientDome(preset: SkyPreset): Mesh {
  const geometry = new SphereGeometry(DOME_RADIUS, 32, 24);
  const material = new MeshBasicMaterial({
    map: paintSky(preset),
    side: BackSide,
    fog: false,
    depthWrite: false,
  });
  const mesh = new Mesh(geometry, material);
  mesh.renderOrder = -1;
  mesh.frustumCulled = false;
  return mesh;
}
