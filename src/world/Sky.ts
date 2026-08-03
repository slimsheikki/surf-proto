import {
  BackSide,
  CanvasTexture,
  Mesh,
  MeshBasicMaterial,
  SphereGeometry,
  SRGBColorSpace,
} from 'three';

/**
 * A Ghibli-flavoured sky: bright cerulean fading to a warm pale horizon, piled
 * with big soft cumulus. Painted onto a canvas at startup and wrapped on an
 * inward-facing sphere — the project ships zero assets, and a generated sky
 * keeps that true while looking nothing like a flat clear-colour.
 *
 * The dome is a *skybox*, not scenery: `App` re-centres it on the camera every
 * frame so it can never be approached, exempts it from fog (`fog: false` — the
 * whole point of a sky is to be visible past the fog wall), and it registers
 * **no collider**. That last point is worth stating because of the bug that
 * prompted suspicion of the sky: the "teleported back from mid-air" issue was
 * the old checkpoint kill-plane ladder, not sky geometry — but after that,
 * "the sky is mesh-only, nothing to hit" deserves to be written down.
 */

/** Horizon tint, exported so App can match fog and clear colour to the painting. */
export const SKY_HORIZON_COLOR = 0xdcedf6;

const DOME_RADIUS = 1200; // well inside the camera's 2000 far plane
const CANVAS_W = 2048;
const CANVAS_H = 1024;

/**
 * Deterministic PRNG (mulberry32). The sky must paint identically on every
 * load — a cloudscape that reshuffles per refresh reads as a bug, and
 * deterministic rendering keeps headless and browser runs comparable.
 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** One puffy cumulus: a cluster of soft radial blobs over a flatter base. */
function paintCloud(
  ctx: CanvasRenderingContext2D,
  rand: () => number,
  cx: number,
  cy: number,
  scale: number,
  alpha: number,
): void {
  const puffCount = 7 + Math.floor(rand() * 6);
  for (let i = 0; i < puffCount; i++) {
    // Puffs spread wide and sit higher toward the cluster's middle, giving the
    // flat-bottomed, domed-top silhouette of fair-weather cumulus.
    const dx = (rand() - 0.5) * 2.2 * scale;
    const lift = (1 - Math.abs(dx) / (1.1 * scale)) * 0.55 * scale;
    const dy = -lift * (0.4 + rand() * 0.6);
    const r = scale * (0.35 + rand() * 0.4) * (1 - Math.abs(dx) / (2.6 * scale));

    const grad = ctx.createRadialGradient(cx + dx, cy + dy, r * 0.15, cx + dx, cy + dy, r);
    grad.addColorStop(0, `rgba(255, 253, 248, ${alpha})`);
    grad.addColorStop(0.65, `rgba(250, 248, 244, ${alpha * 0.85})`);
    grad.addColorStop(1, 'rgba(248, 246, 242, 0)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(cx + dx, cy + dy, r, 0, Math.PI * 2);
    ctx.fill();
  }
  // A whisper of warm grey under the base, which is what makes a cloud sit in
  // the sky instead of floating as a white smudge.
  const base = ctx.createRadialGradient(cx, cy + scale * 0.25, scale * 0.2, cx, cy + scale * 0.25, scale * 1.4);
  base.addColorStop(0, `rgba(196, 205, 216, ${alpha * 0.28})`);
  base.addColorStop(1, 'rgba(196, 205, 216, 0)');
  ctx.fillStyle = base;
  ctx.beginPath();
  ctx.ellipse(cx, cy + scale * 0.28, scale * 1.5, scale * 0.5, 0, 0, Math.PI * 2);
  ctx.fill();
}

function paintSky(): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = CANVAS_W;
  canvas.height = CANVAS_H;
  const ctx = canvas.getContext('2d')!;
  const rand = mulberry32(20260802);

  // Vertical gradient. On an equirect sphere v=0 is straight up, v=0.5 the
  // horizon, v=1 straight down: deep cerulean overhead, near-white at the
  // horizon with a whisper of cream, soft haze-blue below (visible from the
  // start tower, which looks *down* on a lot of sky).
  const grad = ctx.createLinearGradient(0, 0, 0, CANVAS_H);
  grad.addColorStop(0.0, '#3f7fc4');
  grad.addColorStop(0.22, '#5f9bd8');
  grad.addColorStop(0.42, '#a8cdea');
  grad.addColorStop(0.5, '#e8f3f7');
  grad.addColorStop(0.56, '#f4ede1');
  grad.addColorStop(0.68, '#c3d8e8');
  grad.addColorStop(1.0, '#9fbfd8');
  ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

  // A band of great slow cumulus above the horizon, a few small drifters
  // higher up, and faint distant banks hugging the horizon line.
  for (let i = 0; i < 7; i++) {
    const cx = (i / 7 + rand() * 0.09) * CANVAS_W;
    const cy = CANVAS_H * (0.36 + rand() * 0.08);
    paintCloud(ctx, rand, cx, cy, 90 + rand() * 70, 0.9);
  }
  for (let i = 0; i < 6; i++) {
    paintCloud(ctx, rand, rand() * CANVAS_W, CANVAS_H * (0.2 + rand() * 0.1), 34 + rand() * 30, 0.7);
  }
  for (let i = 0; i < 9; i++) {
    paintCloud(ctx, rand, rand() * CANVAS_W, CANVAS_H * (0.47 + rand() * 0.02), 55 + rand() * 45, 0.35);
  }

  return canvas;
}

/**
 * Builds the sky dome. Cheap to hold forever: one 2048x1024 texture, one
 * sphere, painted once at boot.
 */
export function buildSkyDome(): Mesh {
  const texture = new CanvasTexture(paintSky());
  texture.colorSpace = SRGBColorSpace;

  const dome = new Mesh(
    new SphereGeometry(DOME_RADIUS, 32, 24),
    new MeshBasicMaterial({ map: texture, side: BackSide, fog: false, depthWrite: false }),
  );
  // Drawn first, behind everything, and never culled — it surrounds the camera
  // by construction, and letting the frustum test cull a sphere the camera sits
  // inside of is a classic one-frame-of-missing-sky bug.
  dome.renderOrder = -1;
  dome.frustumCulled = false;
  return dome;
}
