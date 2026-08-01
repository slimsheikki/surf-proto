const PHASE_NUMERALS = ['I', 'II', 'III'];

export interface BossBarState {
  name: string;
  hpFraction: number;
  /** 1-based phase, as shown to the player. */
  phase: number;
}

/**
 * The boss's health bar across the top of the screen. Plain DOM over the canvas,
 * like the rest of the HUD — there is no WebGL UI layer in this project.
 *
 * Only shown while the fight is live; `hide` is the resting state, so nothing
 * lingers over the game-over or victory screens.
 */
export class BossBar {
  private readonly root = document.getElementById('boss-bar')!;
  private readonly nameEl = document.getElementById('boss-name')!;
  private readonly phaseEl = document.getElementById('boss-phase')!;
  private readonly fillEl = document.getElementById('boss-hp-fill')!;

  update(state: BossBarState): void {
    const fraction = Math.max(0, Math.min(1, state.hpFraction));
    this.nameEl.textContent = state.name;
    this.phaseEl.textContent = `PHASE ${PHASE_NUMERALS[state.phase - 1] ?? state.phase}`;
    this.fillEl.style.width = `${fraction * 100}%`;
    // Phase drives the bar's colour as well as the label, so the escalation is
    // visible without reading text mid-surf.
    this.root.dataset.phase = String(state.phase);
    this.root.classList.remove('hidden');
  }

  hide(): void {
    this.root.classList.add('hidden');
  }
}
