# public/images

Static images copied verbatim into the build. Referenced with
`import.meta.env.BASE_URL` from code — **never** with a hard-coded `/images/...`
in `index.html`, because Vite rewrites `url()` inside CSS with the deploy's base
path but leaves an absolute `src` in the HTML alone, so the hard-coded form
works on localhost and 404s on GitHub Pages.

## megaflow-logo.png — expected, not yet committed

The main menu's wordmark. Drop the file here under exactly this name:

```
public/images/megaflow-logo.png
```

Nothing else needs changing — `MainMenu.ts` already points at it, and until it
exists the menu falls back to the word MEGAFLOW set in the display face.

What the art wants:

- **Transparent background.** The menu sits on a dark sky backdrop, so a white
  background renders as a white slab around the logo.
- **Wide.** It is laid out to fit inside 620 × 230 CSS px, aspect preserved. A
  source around 1200–1600 px wide keeps it crisp on a HiDPI screen.
- **Symmetric-ish framing.** It turns about its vertical axis and the backface
  is left visible, so the mirrored reverse is on screen for half of every
  rotation.
