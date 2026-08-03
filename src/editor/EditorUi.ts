import { Editor } from './Editor';
import { encodeMapCode, decodeMapCode, shareUrlFor } from './MapCode';
import { RAMP_LIBRARY, RampFamily } from './RampLibrary';
import { generateThumbnails } from './Thumbnails';
import {
  deleteMap,
  listMapNames,
  loadMap,
  rememberLastMap,
  saveMap,
  uniqueMapName,
} from './MapStorage';

export interface EditorUiCallbacks {
  onPlay: () => void;
  onExitToMenu: () => void;
  /** Asked for a fresh starter map when the player hits New. */
  onNewMap: () => void;
}

/**
 * Length past which a share link is likely to be mangled somewhere between here
 * and the recipient. Nothing refuses to produce one — browsers handle far more
 * than this — but chat clients, link previewers and email wrapping start
 * truncating around here, and the player should find that out before their
 * friend does.
 */
const LONG_CODE_CHARS = 2000;

/**
 * DOM side of the editor: the palette you drag pieces out of, the save/load
 * toolbar, and the status line.
 *
 * Kept apart from `Editor` because they fail differently. `Editor` is
 * three-dimensional state that has to stay consistent with what is drawn;
 * this is a handful of elements and listeners, and everything here is either
 * a call into `Editor` or a call into `MapStorage`.
 */
export class EditorUi {
  private readonly root = document.getElementById('editor-ui')!;
  private readonly paletteEl = document.getElementById('editor-palette-items')!;
  private readonly nameInput = document.getElementById('map-name') as HTMLInputElement;
  private readonly mapList = document.getElementById('map-list') as HTMLSelectElement;
  private readonly statusEl = document.getElementById('editor-status')!;
  private readonly snapEl = document.getElementById('editor-snap')!;
  private readonly countEl = document.getElementById('editor-count')!;
  private readonly deletePieceButton = document.getElementById(
    'editor-delete-piece',
  ) as HTMLButtonElement;
  private readonly splineButton = document.getElementById('editor-spline') as HTMLButtonElement;
  private readonly splineClearButton = document.getElementById(
    'editor-spline-clear',
  ) as HTMLButtonElement;

  private readonly sharePanel = document.getElementById('share-panel')!;
  private readonly shareTitle = document.getElementById('share-title')!;
  private readonly shareText = document.getElementById('share-text') as HTMLTextAreaElement;
  private readonly shareHint = document.getElementById('share-hint')!;
  private readonly shareCopyButton = document.getElementById('share-copy') as HTMLButtonElement;
  private readonly shareLoadButton = document.getElementById('share-load') as HTMLButtonElement;

  constructor(
    private readonly editor: Editor,
    private readonly callbacks: EditorUiCallbacks,
  ) {
    this.buildPalette();
    this.wireToolbar();
    this.wireSharePanel();
    this.refreshMapList();
  }

  show(): void {
    this.root.classList.remove('hidden');
    this.nameInput.value = this.editor.mapName;
    this.refreshMapList();
    this.refresh();
  }

  hide(): void {
    this.closeSharePanel();
    this.root.classList.add('hidden');
  }

  /** Says where a map that arrived from a share link came from, and that it is not saved yet. */
  flashImported(name: string): void {
    this.flash(`Imported “${name}” from a share link — press Save to keep it`);
  }

  /** Redraws everything that reflects editor state. Called on every editor change. */
  refresh(): void {
    this.statusEl.textContent = this.editor.selectionSummary;
    this.snapEl.textContent = this.editor.snapEnabled ? 'Grid snap: on' : 'Grid snap: off';
    this.snapEl.classList.toggle('off', !this.editor.snapEnabled);
    const count = this.editor.pieceCount;
    this.countEl.textContent = `${count} ${count === 1 ? 'piece' : 'pieces'}`;
    this.deletePieceButton.disabled = !this.editor.canDeleteSelection;
    this.splineButton.textContent = this.editor.splineMode ? '✓ Spline (P)' : 'Spline (P)';
    this.splineButton.classList.toggle('active', this.editor.splineMode);
    this.splineClearButton.disabled = this.editor.splinePointCount === 0;
  }

  /**
   * The palette is generated from `RAMP_LIBRARY`, grouped by family, in a
   * content-browser layout: a grid of 3D thumbnail tiles rendered from each
   * definition's real geometry (`Thumbnails.ts`), with the prose hint demoted
   * to a hover tooltip. The palette stays a *view* of the library, per the
   * data-driven rule: adding a ramp family is adding a definition, never
   * touching this file.
   */
  private buildPalette(): void {
    const familyLabels: Record<RampFamily, string> = {
      straight: 'Straight',
      trapezoid: 'Trapezoid',
      'reverse-trapezoid': 'Trapezoid',
      pyramid: 'Pyramid',
      halfpipe: 'Halfpipe',
      slide: 'Slide',
      'vertical-curved': 'Vertical curve',
      'horizontal-curved': 'Horizontal curve',
      platform: 'Platforms',
    };
    const thumbnails = generateThumbnails();

    let lastHeader = '';
    for (const def of RAMP_LIBRARY) {
      const header = familyLabels[def.family];
      if (header !== lastHeader) {
        const heading = document.createElement('div');
        heading.className = 'palette-family';
        heading.textContent = header;
        this.paletteEl.appendChild(heading);
        lastHeader = header;
      }

      const item = document.createElement('div');
      item.className = 'palette-item';
      item.draggable = true;
      item.dataset.preset = def.id;
      item.title = `${def.label} — ${def.hint}`;

      const thumb = thumbnails.get(def.id);
      // Tile label: the family header already says the family, so strip that
      // prefix off the definition label and keep only the variant.
      const prefix = `${header} ·`;
      const short = def.label.startsWith(prefix) ? def.label.slice(prefix.length).trim() : def.label;
      item.innerHTML =
        (thumb ? `<img src="${thumb}" alt="" draggable="false" />` : '') +
        `<span>${short}</span>`;

      item.addEventListener('dragstart', (event) => {
        // The payload is set for correctness (a drop with no data is refused by
        // some browsers), but the editor reads its own `pendingDef` — during
        // `dragover`, which is where the preview is drawn, `getData` returns "".
        event.dataTransfer?.setData('text/plain', def.id);
        if (event.dataTransfer) event.dataTransfer.effectAllowed = 'copy';
        this.editor.beginPalettePlacement(def.id);
      });
      item.addEventListener('dragend', () => this.editor.endPalettePlacement());

      this.paletteEl.appendChild(item);
    }
  }

  private wireToolbar(): void {
    this.nameInput.addEventListener('input', () => {
      this.editor.mapName = this.nameInput.value.trim() || 'Untitled';
    });

    // Deletion is also on Del/Backspace, but a key nobody is told about is a
    // feature nobody has: the palette is where pieces come from, so it is where
    // the control for getting rid of one belongs.
    this.deletePieceButton.addEventListener('click', () => this.editor.deleteSelected());

    this.splineButton.addEventListener('click', () =>
      this.editor.setSplineMode(!this.editor.splineMode),
    );
    this.splineClearButton.addEventListener('click', () => {
      this.editor.clearSpline();
      this.flash('Spline cleared — the generated ramps stay as ordinary pieces');
    });

    document.getElementById('editor-save')!.addEventListener('click', () => {
      const map = this.editor.getMap();
      this.flash(saveMap(map) ? `Saved “${map.name}”` : 'Could not save — browser storage is unavailable');
      this.refreshMapList(map.name);
    });

    document.getElementById('editor-load')!.addEventListener('click', () => {
      const name = this.mapList.value;
      if (!name) return;
      const map = loadMap(name);
      if (!map) {
        this.flash(`Could not load “${name}”`);
        return;
      }
      this.editor.setMap(map);
      rememberLastMap(name);
      this.nameInput.value = map.name;
      this.flash(`Loaded “${name}”`);
    });

    document.getElementById('editor-delete')!.addEventListener('click', () => {
      const name = this.mapList.value;
      if (!name) return;
      deleteMap(name);
      this.refreshMapList();
      this.flash(`Deleted “${name}”`);
    });

    document.getElementById('editor-new')!.addEventListener('click', () => {
      this.callbacks.onNewMap();
      this.nameInput.value = this.editor.mapName;
    });

    document.getElementById('editor-share')!.addEventListener('click', () => void this.openShare());
    document.getElementById('editor-import')!.addEventListener('click', () => this.openImport());

    document.getElementById('editor-play')!.addEventListener('click', () => this.callbacks.onPlay());
    document.getElementById('editor-menu')!.addEventListener('click', () => this.callbacks.onExitToMenu());
  }

  private refreshMapList(selected?: string): void {
    const names = listMapNames();
    this.mapList.innerHTML = '';
    if (names.length === 0) {
      const option = document.createElement('option');
      option.value = '';
      option.textContent = 'No saved maps';
      this.mapList.appendChild(option);
      this.mapList.disabled = true;
      return;
    }
    this.mapList.disabled = false;
    for (const name of names) {
      const option = document.createElement('option');
      option.value = name;
      option.textContent = name;
      this.mapList.appendChild(option);
    }
    if (selected && names.includes(selected)) this.mapList.value = selected;
  }

  // ------------------------------------------------------------ share panel

  private wireSharePanel(): void {
    document.getElementById('share-close')!.addEventListener('click', () => this.closeSharePanel());
    this.shareCopyButton.addEventListener('click', () => void this.copyShareText());
    this.shareLoadButton.addEventListener('click', () => void this.loadPastedCode());
    // Esc closes the panel rather than falling through to the editor, which
    // takes Esc as "back to the main menu" — losing the map you were sharing.
    this.sharePanel.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      this.closeSharePanel();
    });
  }

  /** Encodes the current map, shows the link, and puts it on the clipboard. */
  private async openShare(): Promise<void> {
    const map = this.editor.getMap();
    this.shareTitle.textContent = `Share “${map.name}”`;
    this.shareText.value = 'Encoding…';
    this.shareHint.textContent = '';
    this.shareCopyButton.classList.remove('hidden');
    this.shareLoadButton.classList.add('hidden');
    this.sharePanel.classList.remove('hidden');

    const url = shareUrlFor(await encodeMapCode(map));
    this.shareText.value = url;
    this.shareText.select();

    const copied = await this.copyToClipboard(url);
    const size =
      url.length > LONG_CODE_CHARS
        ? ` ${url.length} characters — long enough that some chat apps may cut it; if it arrives broken, send it as a file or split the map up.`
        : ` ${url.length} characters.`;
    this.shareHint.textContent =
      (copied ? 'Copied to the clipboard.' : 'Select the text above and copy it.') + size;
  }

  private openImport(): void {
    this.shareTitle.textContent = 'Import a map';
    this.shareText.value = '';
    this.shareHint.textContent = 'Paste a share link or code, then press Load map.';
    this.shareCopyButton.classList.add('hidden');
    this.shareLoadButton.classList.remove('hidden');
    this.sharePanel.classList.remove('hidden');
    this.shareText.focus();
  }

  private async loadPastedCode(): Promise<void> {
    const map = await decodeMapCode(this.shareText.value);
    if (!map) {
      this.shareHint.textContent =
        'That is not a share link this build understands — check it copied whole.';
      return;
    }
    // Renamed on collision, or the first Save would overwrite the recipient's
    // own map of the same name. `MapStorage` keys purely by name.
    map.name = uniqueMapName(map.name);
    this.editor.setMap(map);
    this.nameInput.value = map.name;
    this.closeSharePanel();
    this.flash(`Imported “${map.name}” — press Save to keep it`);
  }

  /**
   * The clipboard write is best-effort. It is refused outright without a user
   * gesture, over plain HTTP, and by some embedded webviews — which is why the
   * text is always on screen and selectable rather than only copied. A "Copied!"
   * that silently didn't is worse than no button at all.
   */
  private async copyToClipboard(text: string): Promise<boolean> {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      return false;
    }
  }

  private async copyShareText(): Promise<void> {
    const copied = await this.copyToClipboard(this.shareText.value);
    this.shareText.select();
    this.shareHint.textContent = copied
      ? 'Copied to the clipboard.'
      : 'Copying was blocked — select the text above and copy it by hand.';
  }

  private closeSharePanel(): void {
    this.sharePanel.classList.add('hidden');
  }

  /**
   * One-shot message in the status line. It is overwritten by the next editor
   * change, which is the right lifetime for a "saved" confirmation — no timer
   * to cancel, and no message left hanging over an unrelated selection.
   */
  private flash(message: string): void {
    this.statusEl.textContent = message;
  }
}
