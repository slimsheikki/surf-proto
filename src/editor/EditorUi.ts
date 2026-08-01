import { Editor } from './Editor';
import { PALETTE } from './MapData';
import { deleteMap, listMapNames, loadMap, rememberLastMap, saveMap } from './MapStorage';

export interface EditorUiCallbacks {
  onPlay: () => void;
  onExitToMenu: () => void;
  /** Asked for a fresh starter map when the player hits New. */
  onNewMap: () => void;
}

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

  constructor(
    private readonly editor: Editor,
    private readonly callbacks: EditorUiCallbacks,
  ) {
    this.buildPalette();
    this.wireToolbar();
    this.refreshMapList();
  }

  show(): void {
    this.root.classList.remove('hidden');
    this.nameInput.value = this.editor.mapName;
    this.refreshMapList();
    this.refresh();
  }

  hide(): void {
    this.root.classList.add('hidden');
  }

  /** Redraws everything that reflects editor state. Called on every editor change. */
  refresh(): void {
    this.statusEl.textContent = this.editor.selectionSummary;
    this.snapEl.textContent = this.editor.snapEnabled ? 'Grid snap: on' : 'Grid snap: off';
    this.snapEl.classList.toggle('off', !this.editor.snapEnabled);
    const count = this.editor.pieceCount;
    this.countEl.textContent = `${count} ${count === 1 ? 'piece' : 'pieces'}`;
    this.deletePieceButton.disabled = !this.editor.canDeleteSelection;
  }

  private buildPalette(): void {
    for (const preset of PALETTE) {
      const item = document.createElement('div');
      item.className = 'palette-item';
      item.draggable = true;
      item.dataset.preset = preset.id;
      item.innerHTML = `<strong>${preset.label}</strong><span>${preset.hint}</span>`;

      item.addEventListener('dragstart', (event) => {
        // The payload is set for correctness (a drop with no data is refused by
        // some browsers), but the editor reads its own `pendingPreset` — during
        // `dragover`, which is where the preview is drawn, `getData` returns "".
        event.dataTransfer?.setData('text/plain', preset.id);
        if (event.dataTransfer) event.dataTransfer.effectAllowed = 'copy';
        this.editor.beginPalettePlacement(preset.id);
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

  /**
   * One-shot message in the status line. It is overwritten by the next editor
   * change, which is the right lifetime for a "saved" confirmation — no timer
   * to cancel, and no message left hanging over an unrelated selection.
   */
  private flash(message: string): void {
    this.statusEl.textContent = message;
  }
}
