/**
 * The MEGAFLOW wordmark, mounted into an <img> with a text fallback.
 *
 * Two screens show it now — the front menu and the start screen a run opens on
 * — and both need the same two pieces of care, which is why this is shared
 * rather than copied:
 *
 * - The `error` listener is attached *before* `src`, never after: setting `src`
 *   can fail synchronously from cache, and a handler registered afterwards
 *   would miss the event and leave an empty heading where the game's name goes.
 *   A broken-image icon there is the worst thing the front door can show.
 * - The path is built from `BASE_URL` rather than hard-coded. Vite rewrites
 *   `url()` inside CSS with the deploy's base path but leaves an absolute `src`
 *   in HTML alone, so `/images/...` would 404 on Pages and work only locally.
 */
export function mountLogo(img: HTMLImageElement, fallback: HTMLElement): void {
  img.addEventListener('error', () => {
    img.classList.add('hidden');
    fallback.classList.remove('hidden');
  });
  img.src = `${import.meta.env.BASE_URL}images/megaflow-logo.png`;
}

/**
 * The same wordmark as a ready-made heading, for the screens that build their
 * markup in code rather than in `index.html`.
 *
 * `.screen-logo` is what pins it to the top of the viewport, and that is the
 * whole point of sharing it: the start screen and the pause screen are the two
 * things a player flips between mid-run, and the logo must not jump between
 * them.
 */
export function createLogoHeading(): HTMLElement {
  const heading = document.createElement('h1');
  heading.className = 'menu-logo screen-logo';

  const img = document.createElement('img');
  img.alt = 'MEGAFLOW';

  const fallback = document.createElement('span');
  fallback.className = 'hidden';
  fallback.textContent = 'MEGAFLOW';

  heading.append(img, fallback);
  mountLogo(img, fallback);
  return heading;
}
