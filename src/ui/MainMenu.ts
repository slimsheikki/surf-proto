export type GameMode = 'standard' | 'free';

/**
 * Mode select, shown at boot and returned to from either mode.
 *
 * Choices are pickable by number key as well as by click, for the reason the
 * upgrade menu already documents: the rest of the game runs under pointer lock,
 * and a menu the player can reach only with a cursor is a menu that is
 * unreachable the moment the lock is held. Here the lock is always released
 * first — but the binding costs nothing and keeps one convention across every
 * panel in the game.
 */
export class MainMenu {
  private readonly overlay = document.getElementById('main-menu')!;
  private readonly buttons = Array.from(
    document.querySelectorAll<HTMLElement>('#main-menu [data-mode]'),
  );

  private pick: ((mode: GameMode) => void) | null = null;

  constructor() {
    for (const button of this.buttons) {
      button.addEventListener('click', () => this.choose(button.dataset.mode as GameMode));
    }
    // Registered once rather than per show(), so repeated visits to the menu
    // cannot stack listeners.
    window.addEventListener('keydown', (event) => {
      if (!this.pick) return;
      const index = Number(event.key) - 1;
      if (!Number.isInteger(index) || index < 0 || index >= this.buttons.length) return;
      event.preventDefault();
      this.choose(this.buttons[index].dataset.mode as GameMode);
    });
  }

  get isOpen(): boolean {
    return this.pick !== null;
  }

  show(onPick: (mode: GameMode) => void): void {
    this.pick = onPick;
    this.overlay.classList.remove('hidden');
  }

  hide(): void {
    this.pick = null;
    this.overlay.classList.add('hidden');
  }

  private choose(mode: GameMode | undefined): void {
    const pick = this.pick;
    if (!pick || !mode) return;
    this.pick = null;
    this.hide();
    pick(mode);
  }
}
