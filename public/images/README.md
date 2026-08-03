# public/images

Static images copied verbatim into the build. Referenced with
`import.meta.env.BASE_URL` from code — **never** with a hard-coded `/images/...`
in `index.html`, because Vite rewrites `url()` inside CSS with the deploy's base
path but leaves an absolute `src` in the HTML alone, so the hard-coded form
works on localhost and 404s on GitHub Pages.

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
