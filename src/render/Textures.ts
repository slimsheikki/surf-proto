/**
 * Diffuse textures for the NPR look — clean, low-res, hand-painted-feeling.
 *
 * Two sources, one style: small **procedural** gradients/tiles generated on a
 * canvas (zero assets, always in-palette), and **CC0** tiles vendored under
 * `public/` (Kenney / OpenGameArt, all CC0) loaded through `loadPaintedTexture`,
 * which posterizes and recolours them so they read as flat screen-print rather
 * than photographs. Everything here is 64–256px and nearest/near-flat filtered.
 */

import {
  CanvasTexture,
  Color,
  LinearFilter,
  NearestFilter,
  RepeatWrapping,
  SRGBColorSpace,
  type Texture,
  TextureLoader,
} from 'three';

function makeCanvas(size: number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('NPR Textures: 2D canvas context unavailable');
  return { canvas, ctx };
}

function finish(canvas: HTMLCanvasElement, nearest: boolean): CanvasTexture {
  const tex = new CanvasTexture(canvas);
  tex.colorSpace = SRGBColorSpace;
  tex.wrapS = RepeatWrapping;
  tex.wrapT = RepeatWrapping;
  tex.magFilter = nearest ? NearestFilter : LinearFilter;
  tex.minFilter = nearest ? NearestFilter : LinearFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}

/** A flat single-colour tile. */
export function flatTexture(color: number, size = 64): CanvasTexture {
  const { canvas, ctx } = makeCanvas(size);
  ctx.fillStyle = `#${color.toString(16).padStart(6, '0')}`;
  ctx.fillRect(0, 0, size, size);
  return finish(canvas, false);
}

/**
 * A vertical gradient posterized into `bands` steps — the flat cel-gradient that
 * lets a large face carry a subtle lighting hint without a photo.
 */
export function gradientTexture(top: number, bottom: number, bands = 4, size = 128): CanvasTexture {
  const { canvas, ctx } = makeCanvas(size);
  const a = new Color(top);
  const b = new Color(bottom);
  const step = new Color();
  const n = Math.max(2, bands);
  for (let i = 0; i < n; i++) {
    step.copy(a).lerp(b, i / (n - 1));
    ctx.fillStyle = `#${step.getHexString()}`;
    const y0 = Math.floor((i / n) * size);
    const y1 = Math.floor(((i + 1) / n) * size);
    ctx.fillRect(0, y0, size, y1 - y0);
  }
  return finish(canvas, false);
}

/** A clean grid tile (thin ink lines on a flat ground) — the surf-ramp look. */
export function gridTexture(
  ground: number,
  line: number,
  cells = 4,
  size = 128,
): CanvasTexture {
  const { canvas, ctx } = makeCanvas(size);
  ctx.fillStyle = `#${ground.toString(16).padStart(6, '0')}`;
  ctx.fillRect(0, 0, size, size);
  ctx.strokeStyle = `#${line.toString(16).padStart(6, '0')}`;
  ctx.lineWidth = Math.max(1, Math.round(size / 64));
  const cell = size / cells;
  for (let i = 0; i <= cells; i++) {
    const p = Math.round(i * cell) + 0.5;
    ctx.beginPath();
    ctx.moveTo(p, 0);
    ctx.lineTo(p, size);
    ctx.moveTo(0, p);
    ctx.lineTo(size, p);
    ctx.stroke();
  }
  return finish(canvas, false);
}

export interface PaintedTextureOptions {
  /** Posterize each channel to this many levels (0 = leave as-is). */
  posterize?: number;
  /** Multiply the tile by this colour to pull it into palette. */
  tint?: number;
  /** Nearest-neighbour magnification (crunchy retro) vs smooth. */
  nearest?: boolean;
  /** Downsample the source to this px square before use (64–256). */
  resample?: number;
  wrap?: boolean;
}

/**
 * Load a vendored CC0 tile and make it read hand-painted: downsample, posterize,
 * optional palette tint. Returns immediately with a texture that fills in when
 * the image decodes (same pattern the painted sky uses).
 */
export function loadPaintedTexture(url: string, options: PaintedTextureOptions = {}): Texture {
  const { posterize = 0, tint, nearest = false, resample = 128, wrap = true } = options;
  const placeholder = flatTexture(tint ?? 0x808080, 4);

  new TextureLoader().load(url, (loaded) => {
    const src = loaded.image as HTMLImageElement;
    const { canvas, ctx } = makeCanvas(resample);
    ctx.imageSmoothingEnabled = !nearest;
    ctx.drawImage(src, 0, 0, resample, resample);

    if (posterize > 0 || tint !== undefined) {
      const img = ctx.getImageData(0, 0, resample, resample);
      const data = img.data;
      const t = tint !== undefined ? new Color(tint) : null;
      const levels = Math.max(2, posterize);
      for (let i = 0; i < data.length; i += 4) {
        for (let c = 0; c < 3; c++) {
          let v = data[i + c] / 255;
          if (posterize > 0) v = Math.round(v * (levels - 1)) / (levels - 1);
          if (t) v *= c === 0 ? t.r : c === 1 ? t.g : t.b;
          data[i + c] = Math.round(v * 255);
        }
      }
      ctx.putImageData(img, 0, 0);
    }

    placeholder.image = canvas;
    placeholder.colorSpace = SRGBColorSpace;
    placeholder.magFilter = nearest ? NearestFilter : LinearFilter;
    placeholder.minFilter = nearest ? NearestFilter : LinearFilter;
    placeholder.wrapS = wrap ? RepeatWrapping : placeholder.wrapS;
    placeholder.wrapT = wrap ? RepeatWrapping : placeholder.wrapT;
    placeholder.needsUpdate = true;
    loaded.dispose();
  });

  return placeholder;
}
