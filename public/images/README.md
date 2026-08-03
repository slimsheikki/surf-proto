# public/images

Static images copied verbatim into the build. Referenced with
`import.meta.env.BASE_URL` from code — **never** with a hard-coded `/images/...`
in `index.html`, because Vite rewrites `url()` inside CSS with the deploy's base
path but leaves an absolute `src` in the HTML alone, so the hard-coded form
works on localhost and 404s on GitHub Pages.

## sky.png

The skybox, 1659 × 948 RGB. `world/Sky.ts` composites it into an equirectangular
canvas at boot — read that file before replacing this one, because the fit is
measured, not guessed.

- **The horizon must stay at 89% of the image height.** `SOURCE_HORIZON_V` is
  `846 / 948`, and it is what puts the painted horizon on the world's horizon.
  A painting whose horizon sits elsewhere needs that constant re-measured (the
  sharpest luminance step across the lower third finds it).
- **Whatever is below the horizon is the entire lower hemisphere.** That strip
  gets stretched over the first 50° below and its last row fills the rest, so it
  wants to be a plain receding ground/haze rather than foreground detail.
- **Any size works**, since the source rects are taken from the image's own
  dimensions — but the composite gives one copy 2048 × 796 px, so about 1600
  wide and 2:1-ish in its sky region is the shape that neither wastes pixels nor
  gets resampled up.
- **The two side edges end up next to each other**, cross-dissolved over a ~25°
  band of sky. Edges that are both cloudy hide that; one cloudy edge against one
  clear edge shows a ghost.
- **The top ~20% is discarded**, dissolved into a flat zenith colour so the
  sphere's pole has nothing to pinch. Do not put anything that matters up there.
- **`SKY_HORIZON_COLOR` is hand-sampled** from the horizon band and drives the
  game's fog and clear colour. A repaint with a different horizon tint wants that
  constant re-sampled, or distant geometry fades into the wrong colour.

## megaflow-logo.png

The main menu's wordmark, 1200 × 800 RGBA. `MainMenu.ts` looks for exactly this
filename; anything else and the menu quietly falls back to the word MEGAFLOW set
in the display face.

Replacing it:

- **Transparent background.** The menu sits on a dark sky backdrop, so a white
  background renders as a white slab around the logo.
- **Around 1200 px wide.** It renders at roughly 456 × 304 CSS px, so 1200 gives
  a HiDPI screen more than it needs. The delivered source was 1536 × 1024 and
  2.72 MB; resampled to 1200 it is 1.11 MB, which matters because this is the
  one image blocking the menu's first paint. The original is in git history.
- **Symmetric-ish framing.** It turns about its vertical axis with the backface
  left visible, so the mirrored reverse is on screen for half of every rotation.
