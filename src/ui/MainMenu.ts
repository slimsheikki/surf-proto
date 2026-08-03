import { FreeMap } from '../editor/MapData';
import { listMapNames, loadMap } from '../editor/MapStorage';
import { mountLogo } from './Logo';
import { renderMapThumbnails } from './MapThumbnails';

/**
 * The stacked front menu — PLAY / EDITOR / SETTINGS — and the play screen
 * behind PLAY, which lists the standard course alongside every map the player
 * has built.
 *
 * Both pages live in the one overlay rather than in separate screens, so
 * stepping into PLAY and back never cuts the orbiting backdrop behind them.
 *
 * Choices are pickable by number key as well as by click, for the reason the
 * upgrade menu already documents: the rest of the game runs under pointer lock,
 * and a menu reachable only with a cursor is a menu that is unreachable the
 * moment the lock is held. Here the lock is always released first — but the
 * binding costs nothing and keeps one convention across every panel in the game.
 */

export interface MainMenuHandlers {
  onStandard: () => void;
  onEditor: () => void;
  onSettings: () => void;
  /** Play a saved map directly, without going through the editor. */
  onFreeMap: (map: FreeMap) => void;
}

type Page = 'root' | 'play';

export class MainMenu {
  private readonly overlay = document.getElementById('main-menu')!;
  private readonly logo = document.getElementById('menu-logo-img') as HTMLImageElement;
  private readonly logoFallback = document.getElementById('menu-logo-fallback')!;
  private readonly rootPage = document.getElementById('menu-root')!;
  private readonly playPage = document.getElementById('menu-play')!;
  private readonly grid = document.getElementById('menu-map-grid')!;
  private readonly emptyHint = document.getElementById('menu-play-empty')!;
  private readonly rootItems = Array.from(
    document.querySelectorAll<HTMLElement>('#menu-stack [data-action]'),
  );

  private handlers: MainMenuHandlers | null = null;
  private page: Page = 'root';
  /** Tiles on the play page, in display order, so number keys can pick them. */
  private playTiles: (() => void)[] = [];
  /**
   * The standard course's tile image, rendered once from the world App already
   * built at boot. Cached because that world never changes; the *map* tiles are
   * not cached, because the editor can change one between two visits here.
   */
  private standardThumbnail: string | null = null;
  private getStandardThumbnail: () => string | null = () => null;

  constructor() {
    // Art path and the missing-file fallback both live in `Logo.ts` now that the
    // start screen shows the same turning wordmark.
    mountLogo(this.logo, this.logoFallback);

    for (const item of this.rootItems) {
      item.addEventListener('click', () => this.runRootAction(item.dataset.action));
    }
    document.getElementById('menu-play-back')!.addEventListener('click', () => this.showPage('root'));

    // Registered once rather than per show(), so repeated visits cannot stack
    // listeners.
    window.addEventListener('keydown', (event) => {
      if (!this.handlers || this.overlay.classList.contains('hidden')) return;

      if (this.page === 'play' && (event.key === 'Escape' || event.key === 'Backspace')) {
        event.preventDefault();
        this.showPage('root');
        return;
      }

      const index = Number(event.key) - 1;
      if (!Number.isInteger(index) || index < 0) return;
      if (this.page === 'root') {
        if (index >= this.rootItems.length) return;
        event.preventDefault();
        this.runRootAction(this.rootItems[index].dataset.action);
      } else {
        if (index >= this.playTiles.length) return;
        event.preventDefault();
        this.playTiles[index]();
      }
    });
  }

  /**
   * How the play page gets its standard-course picture. App owns that world, so
   * it hands over a thunk rather than the menu reaching into the scene.
   */
  setStandardThumbnailSource(source: () => string | null): void {
    this.getStandardThumbnail = source;
  }

  get isOpen(): boolean {
    return this.handlers !== null;
  }

  show(handlers: MainMenuHandlers): void {
    this.handlers = handlers;
    this.showPage('root');
    this.overlay.classList.remove('hidden');
  }

  hide(): void {
    this.handlers = null;
    this.overlay.classList.add('hidden');
  }

  private showPage(page: Page): void {
    this.page = page;
    this.rootPage.classList.toggle('hidden', page !== 'root');
    this.playPage.classList.toggle('hidden', page !== 'play');
    if (page === 'play') this.buildPlayPage();
  }

  private runRootAction(action: string | undefined): void {
    const handlers = this.handlers;
    if (!handlers) return;
    if (action === 'play') this.showPage('play');
    else if (action === 'editor') this.pick(handlers.onEditor);
    // Settings comes back here afterwards, so the menu stays open behind it.
    else if (action === 'settings') handlers.onSettings();
  }

  /**
   * Clears the handler *before* invoking it: the callback swaps the whole app
   * mode, and a menu that still considered itself open would keep eating number
   * keys on the screen that replaced it.
   */
  private pick(run: () => void): void {
    this.handlers = null;
    this.hide();
    run();
  }

  private buildPlayPage(): void {
    const handlers = this.handlers;
    if (!handlers) return;

    this.grid.replaceChildren();
    this.playTiles = [];

    if (this.standardThumbnail === null) this.standardThumbnail = this.getStandardThumbnail();
    this.addTile({
      title: 'Standard',
      blurb: 'An approach descent into an endless ring of ten banked ramps.',
      thumbnail: this.standardThumbnail,
      onPick: () => this.pick(handlers.onStandard),
    });

    const maps = listMapNames()
      .map((name) => loadMap(name))
      .filter((map): map is FreeMap => map !== null);
    // Rendered per visit rather than cached: the editor can change a map
    // between two trips to this screen, and a stale tile is worse than the few
    // milliseconds a handful of small renders cost.
    const thumbnails = renderMapThumbnails(maps);
    for (const map of maps) {
      this.addTile({
        title: map.name,
        blurb: `${map.pieces.length} piece${map.pieces.length === 1 ? '' : 's'}`,
        thumbnail: thumbnails.get(map.name) ?? null,
        onPick: () => this.pick(() => handlers.onFreeMap(map)),
      });
    }

    this.emptyHint.classList.toggle('hidden', maps.length > 0);
  }

  private addTile(spec: {
    title: string;
    blurb: string;
    thumbnail: string | null;
    onPick: () => void;
  }): void {
    const tile = document.createElement('button');
    tile.type = 'button';
    tile.className = 'map-tile';

    const shot = document.createElement('div');
    shot.className = 'map-tile-shot';
    if (spec.thumbnail) {
      const img = document.createElement('img');
      img.src = spec.thumbnail;
      img.alt = '';
      shot.appendChild(img);
    } else {
      // No GL context, or a map that renders to nothing. The tile still has to
      // be pickable, so it degrades to a plain frame rather than a broken image.
      shot.classList.add('is-empty');
    }

    const key = document.createElement('span');
    key.className = 'menu-key';
    key.textContent = String(this.playTiles.length + 1);

    const title = document.createElement('strong');
    title.textContent = spec.title;

    const blurb = document.createElement('span');
    blurb.className = 'map-tile-blurb';
    blurb.textContent = spec.blurb;

    tile.append(shot, key, title, blurb);
    tile.addEventListener('click', spec.onPick);

    this.grid.appendChild(tile);
    this.playTiles.push(spec.onPick);
  }
}
