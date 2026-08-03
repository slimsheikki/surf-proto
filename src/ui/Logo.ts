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
