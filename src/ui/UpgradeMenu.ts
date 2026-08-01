import { Upgrade } from '../progression/Upgrades';

/**
 * Level-up choice panel.
 *
 * Choices are pickable by number key as well as by click. That is not a
 * convenience: the run happens under pointer lock, so the cursor is hidden and
 * captured by the canvas, and a mouse-only menu would need the lock handed back
 * every level-up — which yanks the player out of the game several times a run.
 * Keys let play continue uninterrupted; the click path stays for discoverability
 * and is what the released cursor is for if the lock does get dropped.
 */
export class UpgradeMenu {
  private readonly overlay = document.getElementById('upgrade-menu')!;
  private readonly choicesEl = document.getElementById('upgrade-choices')!;

  /** Non-null only while the menu is open. */
  private pick: ((choice: Upgrade) => void) | null = null;
  private choices: Upgrade[] = [];

  constructor() {
    // Registered once, not per show(), so repeated level-ups can't stack listeners.
    window.addEventListener('keydown', (e) => {
      if (!this.pick) return;
      const index = Number(e.key) - 1;
      if (!Number.isInteger(index) || index < 0 || index >= this.choices.length) return;
      e.preventDefault();
      this.choose(this.choices[index]);
    });
  }

  get isOpen(): boolean {
    return this.pick !== null;
  }

  show(choices: Upgrade[], onPick: (choice: Upgrade) => void): void {
    this.choices = choices;
    this.pick = onPick;

    this.choicesEl.innerHTML = '';
    choices.forEach((choice, i) => {
      const button = document.createElement('button');
      button.className = 'upgrade-choice';
      button.innerHTML =
        `<span class="upgrade-key">${i + 1}</span>` +
        `<strong>${choice.name}</strong><br/>${choice.description}`;
      button.addEventListener('click', () => this.choose(choice));
      this.choicesEl.appendChild(button);
    });
    this.overlay.classList.remove('hidden');
  }

  private choose(choice: Upgrade): void {
    const pick = this.pick;
    if (!pick) return;
    // Cleared before the callback so a handler that opens another menu (a double
    // level-up from one orb) sees a closed menu rather than this one.
    this.pick = null;
    this.choices = [];
    this.hide();
    pick(choice);
  }

  hide(): void {
    this.pick = null;
    this.choices = [];
    this.overlay.classList.add('hidden');
  }
}
