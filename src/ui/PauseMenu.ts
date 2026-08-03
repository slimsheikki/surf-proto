/**
 * The mid-run pause screen, on `Escape`: CONTINUE / RESTART / QUIT.
 *
 * It is the same stacked list as the front menu, deliberately — a player who
 * has seen one has learned the other, and the number keys mean the same thing
 * on both.
 *
 * `Escape` cannot open this with a key handler, and that is a browser
 * constraint rather than a choice. Under pointer lock the browser owns the key:
 * it releases the lock and never delivers the keydown. What the page *does*
 * reliably get is `pointerlockchange`, so `App` opens this on losing the lock —
 * and the pause that losing the lock already caused finally has a menu on it.
 * `Escape` pressed *here* is delivered normally, because the lock is gone by
 * then, and it means CONTINUE.
 */

export interface PauseMenuHandlers {
  onContinue: () => void;
  onRestart: () => void;
  onQuit: () => void;
}

interface Item {
  label: string;
  run: (handlers: PauseMenuHandlers) => void;
}

const ITEMS: Item[] = [
  { label: 'Continue', run: (h) => h.onContinue() },
  { label: 'Restart', run: (h) => h.onRestart() },
  { label: 'Quit', run: (h) => h.onQuit() },
];

export class PauseMenu {
  private readonly root: HTMLDivElement;
  private handlers: PauseMenuHandlers | null = null;

  constructor() {
    this.root = document.createElement('div');
    this.root.id = 'pause-menu';
    this.root.className = 'overlay hidden';

    const page = document.createElement('div');
    page.className = 'menu-page';

    const heading = document.createElement('h1');
    heading.className = 'menu-title';
    heading.textContent = 'Paused';
    page.appendChild(heading);

    const stack = document.createElement('nav');
    stack.id = 'pause-stack';
    ITEMS.forEach((item, index) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'menu-item';

      const key = document.createElement('span');
      key.className = 'menu-key';
      key.textContent = String(index + 1);

      const label = document.createElement('span');
      label.className = 'menu-label';
      label.textContent = item.label;

      button.append(key, label);
      button.addEventListener('click', () => this.choose(index));
      stack.appendChild(button);
    });
    page.appendChild(stack);

    const hint = document.createElement('p');
    hint.className = 'overlay-hint';
    hint.innerHTML = 'Press <kbd>ESC</kbd> to continue &mdash; <kbd>O</kbd> for settings';
    page.appendChild(hint);

    this.root.appendChild(page);
    document.body.appendChild(this.root);

    // Registered once rather than per show(), so repeated pauses cannot stack
    // listeners. Escape is handled by App, which owns the pointer lock and has
    // to distinguish "close settings" from "continue".
    window.addEventListener('keydown', (event) => {
      if (!this.handlers) return;
      const index = Number(event.key) - 1;
      if (!Number.isInteger(index) || index < 0 || index >= ITEMS.length) return;
      event.preventDefault();
      this.choose(index);
    });
  }

  get isOpen(): boolean {
    return this.handlers !== null;
  }

  show(handlers: PauseMenuHandlers): void {
    this.handlers = handlers;
    this.root.classList.remove('hidden');
  }

  hide(): void {
    this.handlers = null;
    this.root.classList.add('hidden');
  }

  /** CONTINUE, without the player having to click it — what `Escape` maps to. */
  continue(): void {
    const handlers = this.handlers;
    if (!handlers) return;
    this.hide();
    handlers.onContinue();
  }

  private choose(index: number): void {
    const handlers = this.handlers;
    if (!handlers) return;
    // Cleared before the callback runs: every one of these changes the app's
    // mode, and a menu that still considered itself open would keep eating
    // number keys on whatever screen replaced it.
    this.hide();
    ITEMS[index].run(handlers);
  }
}
