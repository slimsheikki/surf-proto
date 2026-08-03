import { Upgrade } from '../progression/Upgrades';
import { CountdownToggle } from './CountdownToggle';

/**
 * How long after a screen change number keys are ignored.
 *
 * A spend of five picks is five of these menus back to back, and a fast double
 * tap of `1` would otherwise chain two of them before the player had read the
 * second. Wall-clock is right here and only here: this is keypress debounce,
 * not gameplay timing, and the sim is frozen so there is no tick to hang it on.
 */
const ACCEPT_DELAY_MS = 150;

/**
 * The three-choice power panel — one pick, whether it came from a tap of F, a
 * spend of a whole bank, or a shrine.
 *
 * Choices are pickable by number key as well as by click. That is not a
 * convenience: the run happens under pointer lock, so the cursor is hidden and
 * captured by the canvas, and a mouse-only menu would need the lock handed back
 * every time — which yanks the player out of the game. Keys let play continue
 * uninterrupted; the click path stays for discoverability and is what the
 * released cursor is for if the lock does get dropped.
 */
export class UpgradeMenu {
  private readonly overlay = document.getElementById('upgrade-menu')!;
  private readonly choicesEl = document.getElementById('upgrade-choices')!;
  private readonly progressEl = document.getElementById('upgrade-progress')!;
  private readonly countdownToggle = new CountdownToggle('upgrade-countdown-toggle');

  /** Non-null only while the menu is open. */
  private pick: ((choice: Upgrade) => void) | null = null;
  private choices: Upgrade[] = [];
  private acceptAfterMs = 0;

  constructor() {
    // Registered once, not per show(), so repeated picks can't stack listeners.
    window.addEventListener('keydown', (e) => {
      if (!this.pick) return;
      // Auto-repeat would carry a held key straight through into whatever screen
      // replaces this one.
      if (e.repeat) return;
      if (performance.now() < this.acceptAfterMs) return;

      if (e.key === 'c' || e.key === 'C') {
        e.preventDefault();
        CountdownToggle.toggle();
        this.countdownToggle.render();
        return;
      }

      const index = Number(e.key) - 1;
      if (!Number.isInteger(index) || index < 0 || index >= this.choices.length) return;
      e.preventDefault();
      this.choose(this.choices[index]);
    });
  }

  get isOpen(): boolean {
    return this.pick !== null;
  }

  /** `label` numbers the pick within a multi-pick spend; blank for a single one. */
  show(choices: Upgrade[], onPick: (choice: Upgrade) => void, label = ''): void {
    this.choices = choices;
    this.pick = onPick;
    this.acceptAfterMs = performance.now() + ACCEPT_DELAY_MS;
    this.progressEl.textContent = label;
    this.countdownToggle.render();

    this.choicesEl.innerHTML = '';
    choices.forEach((choice, i) => {
      const button = document.createElement('button');
      button.className = `upgrade-choice rarity-${choice.rarity}`;
      button.innerHTML =
        `<span class="upgrade-key">${i + 1}</span>` +
        `<span class="upgrade-rarity">${choice.rarity}</span>` +
        `<strong>${choice.name}</strong><br/>${choice.description}`;
      button.addEventListener('click', () => this.choose(choice));
      this.choicesEl.appendChild(button);
    });
    this.overlay.classList.remove('hidden');
  }

  private choose(choice: Upgrade): void {
    const pick = this.pick;
    if (!pick) return;
    // Cleared before the callback so a handler that opens another menu (the next
    // pick of a spend) sees a closed menu rather than this one.
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
