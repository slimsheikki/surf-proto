import { Upgrade } from '../progression/Upgrades';
import { cartridgeMarkup } from './Cartridge';
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
 * Cards on offer: the opening draw, then one entry per reroll.
 *
 * The shrinking *is* the cost. A reroll that kept four cards would be free and
 * therefore automatic — you would always take it until something good appeared,
 * and the choice would move from "which of these" to "how long can I be
 * bothered". Paying a card each time makes the second reroll a real commitment
 * to two, and makes taking the fourth card on sight a defensible decision.
 *
 * Written as data rather than as `4 - rerolls` so the ladder can be retuned
 * without arithmetic, and so the reroll allowance is `length - 1` rather than a
 * second constant that could drift out of agreement with it.
 */
const CHOICE_COUNTS = [4, 3, 2];

/** Reroll key. See the note in `constructor` for why it is not `R`. */
const REROLL_KEY = 'q';

/**
 * The power panel — one pick, whether it came from a tap of F, a spend of a
 * whole bank, or a shrine.
 *
 * Opens on four choices and rerolls down to three, then two. The menu owns that
 * ladder rather than being handed a finished list, which is why `show` takes a
 * *draw function* instead of an array: a reroll has to be able to ask for a
 * fresh set at a new size, and the caller should not have to know the ladder to
 * let it.
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
  private readonly hintEl = document.getElementById('upgrade-hint')!;
  private readonly rerollEl = document.getElementById('upgrade-reroll') as HTMLButtonElement;
  private readonly countdownToggle = new CountdownToggle('upgrade-countdown-toggle');

  /** Non-null only while the menu is open. */
  private pick: ((choice: Upgrade) => void) | null = null;
  /** How the menu asks for a fresh set. Lives and dies with `pick`. */
  private draw: ((count: number) => Upgrade[]) | null = null;
  private choices: Upgrade[] = [];
  /** Index into `CHOICE_COUNTS`. Per-menu, so every pick of a spend opens on four. */
  private rerollsUsed = 0;
  private acceptAfterMs = 0;

  constructor() {
    this.rerollEl.addEventListener('click', () => this.reroll());

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

      // Q, not the R that "reroll" wants, because `Input` reads `KeyR` as
      // `ultimateHeld` and `updateGameplay` fires ReWind on its *rising edge*.
      // The menu does not tick, so `ultimateHeldLastTick` goes stale while it is
      // open: a player still holding the reroll key as they pick would resume
      // into a fresh-looking press and spend the ultimate they never asked to.
      // Q is bound to nothing in `GAME_KEY_CODES`, so it cannot leak anywhere.
      if (e.key === REROLL_KEY || e.key === REROLL_KEY.toUpperCase()) {
        e.preventDefault();
        this.reroll();
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

  /**
   * `draw` is called immediately and again on every reroll, with the number of
   * cards wanted. `label` numbers the pick within a multi-pick spend; blank for
   * a single one.
   */
  show(
    draw: (count: number) => Upgrade[],
    onPick: (choice: Upgrade) => void,
    label = '',
  ): void {
    this.draw = draw;
    this.pick = onPick;
    this.rerollsUsed = 0;
    this.progressEl.textContent = label;
    this.countdownToggle.render();
    this.render();
    this.overlay.classList.remove('hidden');
  }

  private reroll(): void {
    if (!this.pick) return;
    if (this.rerollsUsed >= CHOICE_COUNTS.length - 1) return;
    this.rerollsUsed += 1;
    this.render();
  }

  /**
   * Draws a fresh set at the current size and paints the panel.
   *
   * The accept debounce is reset here rather than in `show`, so it covers
   * rerolls too: a reroll swaps every card under the player's hand, and a digit
   * still on its way down would otherwise take a power nobody had read — which
   * is the exact failure `ACCEPT_DELAY_MS` exists to prevent, just reached by a
   * different route.
   */
  private render(): void {
    const draw = this.draw;
    if (!draw) return;

    this.choices = draw(CHOICE_COUNTS[this.rerollsUsed]);
    this.acceptAfterMs = performance.now() + ACCEPT_DELAY_MS;

    this.choicesEl.innerHTML = '';
    this.choices.forEach((choice, i) => {
      const button = document.createElement('button');
      button.className = `upgrade-choice rarity-${choice.rarity}`;
      button.innerHTML =
        `<span class="upgrade-key">${i + 1}</span>` + cartridgeMarkup(choice);
      button.addEventListener('click', () => this.choose(choice));
      this.choicesEl.appendChild(button);
    });

    const keys = this.choices.map((_, i) => `<kbd>${i + 1}</kbd>`).join(' ');
    this.hintEl.innerHTML = `Press ${keys} to choose`;

    // The next size is quoted, not the current one — the player is deciding what
    // the trade costs, and "reroll for 3" says that where "1 reroll left" does
    // not. Cleared rather than left standing when spent, so the element can
    // never hold copy that outlived the state that wrote it.
    const rerollsLeft = CHOICE_COUNTS.length - 1 - this.rerollsUsed;
    const next = CHOICE_COUNTS[this.rerollsUsed + 1];
    const tail = rerollsLeft > 1 ? `, ${rerollsLeft} left` : ', last one';
    this.rerollEl.textContent = rerollsLeft > 0 ? `↺  Q — Reroll for ${next}${tail}` : '';
    this.rerollEl.classList.toggle('hidden', rerollsLeft === 0);
  }

  private choose(choice: Upgrade): void {
    const pick = this.pick;
    if (!pick) return;
    // Cleared before the callback so a handler that opens another menu (the next
    // pick of a spend) sees a closed menu rather than this one.
    this.pick = null;
    this.draw = null;
    this.choices = [];
    this.hide();
    pick(choice);
  }

  hide(): void {
    this.pick = null;
    this.draw = null;
    this.choices = [];
    this.rerollsUsed = 0;
    this.overlay.classList.add('hidden');
  }
}
