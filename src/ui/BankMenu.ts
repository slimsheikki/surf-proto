import { MIN_GAMBLE_PICKS, Upgrade, gambleOdds } from '../progression/Upgrades';
import { CountdownToggle } from './CountdownToggle';

/** Matches `UpgradeMenu`'s, and for the same reason — see the note there. */
const ACCEPT_DELAY_MS = 150;

export interface BankDecisionHandlers {
  onSpend: () => void;
  onGamble: () => void;
}

function plural(count: number): string {
  return count === 1 ? 'power' : 'powers';
}

/**
 * The all-in screen, opened by holding F: spend the whole bank one pick at a
 * time, or stake it on a single blind roll.
 *
 * Two pages in one overlay rather than two overlays, the same way the front
 * menu does it — swapping pages never cuts the scrim, so committing to the
 * gamble does not flash the frozen world for a frame before the reveal lands.
 *
 * One keydown listener, registered once and gated on `mode`. `UpgradeMenu` does
 * the same, and the two are never open at once, so a digit is unambiguous at
 * every instant.
 */
export class BankMenu {
  private readonly overlay = document.getElementById('bank-menu')!;
  private readonly decisionEl = document.getElementById('bank-decision')!;
  private readonly resultEl = document.getElementById('bank-result')!;
  private readonly countEl = document.getElementById('bank-count')!;
  private readonly spendEl = document.getElementById('bank-spend') as HTMLButtonElement;
  private readonly gambleEl = document.getElementById('bank-gamble') as HTMLButtonElement;
  private readonly spendBodyEl = document.getElementById('bank-spend-body')!;
  private readonly gambleBodyEl = document.getElementById('bank-gamble-body')!;
  private readonly resultTitleEl = document.getElementById('bank-result-title')!;
  private readonly resultCardEl = document.getElementById('bank-result-card')!;
  private readonly countdownToggle = new CountdownToggle('bank-countdown-toggle');

  private mode: 'off' | 'decision' | 'result' = 'off';
  private handlers: BankDecisionHandlers | null = null;
  private dismiss: (() => void) | null = null;
  private gambleAllowed = false;
  private acceptAfterMs = 0;

  constructor() {
    this.spendEl.addEventListener('click', () => this.chooseSpend());
    this.gambleEl.addEventListener('click', () => this.chooseGamble());
    this.resultCardEl.addEventListener('click', () => this.chooseDismiss());

    window.addEventListener('keydown', (e) => {
      if (this.mode === 'off') return;
      if (e.repeat) return;
      if (performance.now() < this.acceptAfterMs) return;

      if (e.key === 'c' || e.key === 'C') {
        e.preventDefault();
        CountdownToggle.toggle();
        this.countdownToggle.render();
        return;
      }

      if (this.mode === 'result') {
        // `1` and not Space: Space is the jump key, it is routinely held, and a
        // repeat would blow past the reveal before it had been read.
        if (e.key !== '1') return;
        e.preventDefault();
        this.chooseDismiss();
        return;
      }

      if (e.key === '1') {
        e.preventDefault();
        this.chooseSpend();
      } else if (e.key === '2' && this.gambleAllowed) {
        e.preventDefault();
        this.chooseGamble();
      }
    });
  }

  get isOpen(): boolean {
    return this.mode !== 'off';
  }

  showDecision(picks: number, handlers: BankDecisionHandlers): void {
    this.mode = 'decision';
    this.handlers = handlers;
    this.dismiss = null;
    this.gambleAllowed = picks >= MIN_GAMBLE_PICKS;
    this.acceptAfterMs = performance.now() + ACCEPT_DELAY_MS;

    this.countEl.textContent = `${picks} ${plural(picks)} banked`;
    this.spendBodyEl.textContent =
      picks === 1
        ? 'One pick, three to choose from'
        : `${picks} picks, three to choose from each time`;

    if (this.gambleAllowed) {
      const odds = gambleOdds(picks);
      // The bust is quoted next to the prize on purpose. A gamble that only
      // advertises its upside is not one the player is really making.
      this.gambleBodyEl.textContent =
        `One blind roll — ${odds.legendary / 10}% legendary, ` +
        `${odds.epic / 10}% epic, ${odds.common / 10}% bust`;
    } else {
      this.gambleBodyEl.textContent = `Needs ${MIN_GAMBLE_PICKS} banked`;
    }
    this.gambleEl.disabled = !this.gambleAllowed;

    this.countdownToggle.render();
    this.decisionEl.classList.remove('hidden');
    this.resultEl.classList.add('hidden');
    this.overlay.classList.remove('hidden');
  }

  /** The roll, already applied — this only reveals what the stake bought. */
  showResult(upgrade: Upgrade, onDismiss: () => void): void {
    this.mode = 'result';
    this.handlers = null;
    this.dismiss = onDismiss;
    this.acceptAfterMs = performance.now() + ACCEPT_DELAY_MS;

    // A common back from a stake is the outcome the decision screen quoted as
    // the bust, so it says the same word here. "COMMON" reads as a tier name
    // and lands as a shrug; the player should know immediately that they lost.
    this.resultTitleEl.textContent =
      upgrade.rarity === 'common' ? 'BUST' : upgrade.rarity.toUpperCase();
    this.resultTitleEl.className = `rarity-${upgrade.rarity}`;
    this.resultCardEl.className = `upgrade-choice rarity-${upgrade.rarity}`;
    this.resultCardEl.innerHTML =
      `<strong>${upgrade.name}</strong><br/>${upgrade.description}`;

    this.decisionEl.classList.add('hidden');
    this.resultEl.classList.remove('hidden');
    this.overlay.classList.remove('hidden');
  }

  hide(): void {
    this.mode = 'off';
    this.handlers = null;
    this.dismiss = null;
    this.overlay.classList.add('hidden');
  }

  private chooseSpend(): void {
    const handlers = this.handlers;
    if (this.mode !== 'decision' || !handlers) return;
    // Cleared before the callback, which opens the first pick menu — the same
    // contract `UpgradeMenu.choose` keeps.
    this.mode = 'off';
    this.handlers = null;
    this.overlay.classList.add('hidden');
    handlers.onSpend();
  }

  private chooseGamble(): void {
    const handlers = this.handlers;
    if (this.mode !== 'decision' || !handlers || !this.gambleAllowed) return;
    // Not hidden here: the callback rolls and comes straight back with
    // `showResult`, so the overlay stays up and only the page swaps.
    this.mode = 'off';
    this.handlers = null;
    handlers.onGamble();
  }

  private chooseDismiss(): void {
    const dismiss = this.dismiss;
    if (this.mode !== 'result' || !dismiss) return;
    this.mode = 'off';
    this.dismiss = null;
    this.hide();
    dismiss();
  }
}
