import {
  BackSide,
  CanvasTexture,
  Mesh,
  MeshBasicMaterial,
  SphereGeometry,
  SRGBColorSpace,
} from 'three';

/**
 * The sky: `public/images/sky.png` — a painted sunset cloudscape, teal overhead
 * falling through sage to a gold horizon — wrapped onto an inward-facing sphere.
 *
 * The painting is a flat matte, not a 360° panorama, so it cannot be handed to
 * the sphere as-is: an equirectangular map needs the horizon on the equator and
 * needs its left edge to meet its right edge. Both are fixed by compositing the
 * source into a 2:1 equirect canvas at boot (`paintPanorama`) —
 *
 * - **A tile that closes on itself, repeated twice.** The painting's left and
 *   right edges are different clouds, so a plain repeat leaves a vertical seam
 *   you can stand and stare at. `buildTile` closes the wrap by overlapping the
 *   painting's end onto its own start and cross-dissolving the two, which costs
 *   a band where both cloudscapes are visible at once — and *that* is why the
 *   band is where it is: the overlap is the source's own two edges, and both of
 *   them are cloud, so the dissolve reads as thicker weather rather than as a
 *   ghost over clear sky. The obvious alternative — mirroring every second copy,
 *   which closes the wrap exactly and for free — was tried first and rejected:
 *   it makes the sky bilaterally symmetric about the seam, and a view down that
 *   axis is a butterfly of two huge matched cumulus that the eye catches
 *   instantly. Rolling the painting first to put the axis in clear sky does not
 *   help, because a roll moves the symmetry axis and the discontinuity together.
 * - **Two copies**, because that count least distorts the art: 180° of yaw
 *   against the 70° of pitch below is 2.6:1 on a painting that is 1.96:1, so
 *   clouds come out about half again as wide, which reads as panoramic. One copy
 *   doubles that; four squeeze the clouds narrow and repeat every 90°.
 * - **The horizon is placed on the equator**, which is the whole point — the
 *   painted horizon has to sit where the world's horizon is or the gold band
 *   floats in the sky. The painted ground strip below it is stretched over the
 *   top of the lower hemisphere and the rest filled with its own end colour.
 * - **Nothing is drawn near the pole** — see `ART_TOP_ELEVATION`.
 *
 * The dome is a *skybox*, not scenery: `App` re-centres it on the camera every
 * frame so it can never be approached, exempts it from fog (`fog: false` — the
 * whole point of a sky is to be visible past the fog wall), and it registers
 * **no collider**. That last point is worth stating because of the bug that
 * prompted suspicion of the sky: the "teleported back from mid-air" issue was
 * the old checkpoint kill-plane ladder, not sky geometry — but after that,
 * "the sky is mesh-only, nothing to hit" deserves to be written down.
 */

/**
 * Horizon tint, exported so App can match fog and clear colour to the painting.
 * Sampled from the source's horizon band (rows 800–846), so distant geometry
 * fades into the gold the sky actually is down there.
 */
export const SKY_HORIZON_COLOR = 0xeab262;

/**
 * Built from `BASE_URL`, never a hard-coded `/images/...`: Vite leaves an
 * absolute path alone, so the hard-coded form works on localhost and 404s under
 * the Pages deploy's `/surf-proto/` prefix.
 */
const SKY_IMAGE_URL = `${import.meta.env.BASE_URL}images/sky.png`;

/**
 * Where the painted horizon sits in the source, as a fraction of its height —
 * measured as the sharpest luminance step in the lower third (row 846 of 948).
 * A fraction rather than a pixel row so replacing the asset with a differently
 * sized painting still composes, as long as its horizon is in the same place.
 */
const SOURCE_HORIZON_V = 846 / 948;

/** Copies around the yaw circle — see the note above. */
const COPIES = 2;

/**
 * Width of the cross-dissolve that closes each tile, as a fraction of the tile.
 * Wide enough (about 25° of yaw) that the two cloudscapes fade through each
 * other rather than crossing at a readable line; much wider and the doubled
 * weather starts to be the widest thing in the sky.
 */
const BLEND_FRACTION = 0.14;

/**
 * 2:1 equirect, and 4096 because each copy then gets 2048px for the source's
 * 1659 — upsampled slightly rather than thrown away, which is what a 2048-wide
 * canvas would do. Power of two so mipmaps are never in question.
 */
const CANVAS_W = 4096;
const CANVAS_H = CANVAS_W / 2;
const HORIZON_Y = CANVAS_H / 2;

/**
 * How far below the equator the painted ground strip is stretched — about 50°.
 * The strip is a smooth gradient, so stretching costs no detail, and a ground
 * plane really does compress toward the horizon; the alternative (drawing it at
 * its own scale) crams the whole thing into the first 10° and leaves a hard
 * edge where the flat fill starts.
 */
const GROUND_SPAN = Math.round(CANVAS_H * 0.28);

/**
 * Elevation the painting's top edge is mapped to, and how far below that its
 * clouds dissolve into flat sky.
 *
 * This is the pinch fix, and it is worth being precise about why the obvious
 * version fails. An equirect sphere squeezes each texture row by `1/cos(elev)`,
 * to a point at the pole: at 80° a cloud is smeared 6× wide, and the first cut
 * of this file — painting mapped to the full 90° with a small cap over it — put
 * the source's top corners, which are two big cumulus, straight into that
 * region. Looking up gave a four-bladed pinwheel. Nothing can be drawn near the
 * pole and survive, so nothing *is*: the art stops at 70° (2.9× at worst, and
 * the top of it is veiled anyway), and everything above is flat colour, which
 * pinches into itself invisibly.
 */
const ART_TOP_ELEVATION = 70;
const ART_FEATHER_ELEVATION = 14;
const ART_TOP_Y = Math.round(HORIZON_Y * (1 - ART_TOP_ELEVATION / 90));
const ART_FEATHER_SPAN = Math.round((HORIZON_Y * ART_FEATHER_ELEVATION) / 90);

/**
 * The painting's own clear-sky colour at its top edge (as an `rgb()` body, so
 * the cap can vary its alpha) and at its bottom edge.
 */
const ZENITH_RGB = '40, 103, 125';
const NADIR_COLOR = '#966649';

const DOME_RADIUS = 1200; // well inside the camera's 2000 far plane

/**
 * The painting's clear-sky ramp, sampled per row at the 20th percentile of
 * luminance — that percentile picks sky over cloud, so this is the gradient
 * underneath the cloudscape rather than a grey average of the two. Keyed by
 * fraction of the painting's own sky height, top (0) to horizon (1).
 *
 * It is what shows in the fraction of a second before the PNG decodes, and it
 * is the whole sky if the PNG never arrives — a decent sky either way, which is
 * why the load failure is swallowed rather than surfaced.
 */
const SKY_RAMP: ReadonlyArray<readonly [number, string]> = [
  [0.0, '#28677d'],
  [0.16, '#2c6a81'],
  [0.35, '#3d7b85'],
  [0.55, '#699786'],
  [0.75, '#9fa67b'],
  [0.93, '#deb167'],
  [1.0, '#e7a959'],
];

/**
 * Zenith-to-nadir gradient: flat zenith down to the art's top edge, then the
 * sampled ramp over the band the art occupies, then the ground's own colours.
 * Laid out on the same elevations the painting is, so it reads as a blurred
 * version of the finished sky rather than a different one.
 */
function paintRamp(ctx: CanvasRenderingContext2D): void {
  const artTopV = ART_TOP_Y / CANVAS_H;
  const grad = ctx.createLinearGradient(0, 0, 0, CANVAS_H);
  grad.addColorStop(0, `rgb(${ZENITH_RGB})`);
  for (const [f, color] of SKY_RAMP) grad.addColorStop(artTopV + f * (0.5 - artTopV), color);
  grad.addColorStop(0.52, '#e2a154');
  grad.addColorStop(0.64, '#b3784b');
  grad.addColorStop(1.0, NADIR_COLOR);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);
}

/**
 * Fills everything above the art with the painting's own zenith blue and
 * dissolves the art's top edge into it, so the pole is flat colour and the
 * clouds thin out on the way up rather than ending on a line.
 */
function paintZenithCap(ctx: CanvasRenderingContext2D): void {
  ctx.fillStyle = `rgb(${ZENITH_RGB})`;
  ctx.fillRect(0, 0, CANVAS_W, ART_TOP_Y);

  const cap = ctx.createLinearGradient(0, ART_TOP_Y, 0, ART_TOP_Y + ART_FEATHER_SPAN);
  cap.addColorStop(0.0, `rgba(${ZENITH_RGB}, 1)`);
  cap.addColorStop(0.35, `rgba(${ZENITH_RGB}, 0.55)`);
  cap.addColorStop(0.7, `rgba(${ZENITH_RGB}, 0.2)`);
  cap.addColorStop(1.0, `rgba(${ZENITH_RGB}, 0)`);
  ctx.fillStyle = cap;
  ctx.fillRect(0, ART_TOP_Y, CANVAS_W, ART_FEATHER_SPAN);
}

/**
 * Draws the whole painting once, at the given horizontal placement, with its
 * horizon on the equator: sky into the band under `ART_TOP_ELEVATION`, and the
 * strip below the painted horizon stretched down over `GROUND_SPAN`.
 */
function drawPainting(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement,
  x: number,
  width: number,
): void {
  const srcW = img.naturalWidth;
  const srcH = img.naturalHeight;
  const srcHorizon = Math.round(srcH * SOURCE_HORIZON_V);
  ctx.drawImage(img, 0, 0, srcW, srcHorizon, x, ART_TOP_Y, width, HORIZON_Y - ART_TOP_Y);
  ctx.drawImage(img, 0, srcHorizon, srcW, srcH - srcHorizon, x, HORIZON_Y, width, GROUND_SPAN);
}

/**
 * One tile of the panorama: the painting, wrapped so that its right edge runs
 * back into its left.
 *
 * The painting is laid down `blend` px wider than the tile, so its tail hangs
 * off the right edge, and that tail is then drawn back over the tile's head
 * under an alpha ramp from opaque to clear. What the head shows is therefore the
 * painting's end dissolving into the painting's start over `blend` px — and
 * because the tail lands on column 0 at full opacity, the tile's last column and
 * its first column are neighbours in the source, which is exactly the condition
 * for the repeat to be seamless.
 */
function buildTile(img: HTMLImageElement, width: number): HTMLCanvasElement {
  const blend = Math.round(width * BLEND_FRACTION);
  const tile = document.createElement('canvas');
  tile.width = width;
  tile.height = CANVAS_H;
  const ctx = tile.getContext('2d')!;

  drawPainting(ctx, img, 0, width + blend);

  // The tail, on its own canvas so the ramp can be masked into its alpha —
  // there is no per-pixel opacity on `drawImage` itself. Placing the painting at
  // `-width` puts its final `blend` px in view.
  const tail = document.createElement('canvas');
  tail.width = blend;
  tail.height = CANVAS_H;
  const tailCtx = tail.getContext('2d')!;
  drawPainting(tailCtx, img, -width, width + blend);
  const ramp = tailCtx.createLinearGradient(0, 0, blend, 0);
  ramp.addColorStop(0, 'rgba(0, 0, 0, 1)');
  ramp.addColorStop(1, 'rgba(0, 0, 0, 0)');
  tailCtx.globalCompositeOperation = 'destination-in';
  tailCtx.fillStyle = ramp;
  tailCtx.fillRect(0, 0, blend, CANVAS_H);

  ctx.drawImage(tail, 0, 0);
  return tile;
}

/** Composites the source painting into the equirect canvas. */
function paintPanorama(ctx: CanvasRenderingContext2D, img: HTMLImageElement): void {
  const copyW = CANVAS_W / COPIES;

  // The lower hemisphere first, in the strip's end colour, so the stretched
  // ground has something matching to meet where it runs out.
  ctx.fillStyle = NADIR_COLOR;
  ctx.fillRect(0, HORIZON_Y, CANVAS_W, CANVAS_H - HORIZON_Y);

  const tile = buildTile(img, copyW);
  for (let i = 0; i < COPIES; i++) ctx.drawImage(tile, i * copyW, 0);

  paintZenithCap(ctx);
}

/**
 * Builds the sky dome. One 4096x2048 texture and one sphere, held for the life
 * of the app.
 *
 * Synchronous by contract — `App` builds it in its constructor — so the canvas
 * goes up carrying the sampled gradient and the painting is composited into the
 * *same* canvas when it decodes, with `needsUpdate` re-uploading it. One
 * texture, upgraded in place, and nothing downstream has to know it was async.
 */
export function buildSkyDome(): Mesh {
  const canvas = document.createElement('canvas');
  canvas.width = CANVAS_W;
  canvas.height = CANVAS_H;
  const ctx = canvas.getContext('2d')!;
  paintRamp(ctx);

  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;

  const img = new Image();
  img.addEventListener('load', () => {
    paintPanorama(ctx, img);
    texture.needsUpdate = true;
  });
  // A missing or unreadable painting leaves the sampled gradient up rather than
  // a black dome, which is why nothing is thrown here.
  img.addEventListener('error', () => {});
  img.src = SKY_IMAGE_URL;

  const dome = new Mesh(
    // 64x48 rather than the 32x24 the painted sky used: UVs are interpolated
    // across each triangle, so a coarse sphere visibly kinks the cloud edges of
    // a photographic map even though it was invisible on soft gradients.
    new SphereGeometry(DOME_RADIUS, 64, 48),
    new MeshBasicMaterial({ map: texture, side: BackSide, fog: false, depthWrite: false }),
  );
  // Drawn first, behind everything, and never culled — it surrounds the camera
  // by construction, and letting the frustum test cull a sphere the camera sits
  // inside of is a classic one-frame-of-missing-sky bug.
  dome.renderOrder = -1;
  dome.frustumCulled = false;
  return dome;
}
