import { MegaflowHud } from './MegaflowHud';
import { UltimateArc } from './UltimateArc';

export interface HudState {
  speed: number;
  /**
   * Flow XP paying out right now, in % of the level bar per second (after the
   * XP multiplier). Zero hides it — see `update`.
   */
  flowXpPctPerSecond: number;
  hpFraction: number;
  xpFraction: number;
  level: number;
  elapsedSeconds: number;
  /** Global wave index (5 per act) — rides the clock cell. */
  wave: number;
  /** Monoliths felled this run. Shown only once it is non-zero — see `update`. */
  bossesFelled: number;
  /** 0..1 fill — whole dash charges plus progress toward the next one. */
  dashFraction: number;
  dashCharges: number;
  dashMaxCharges: number;
  /** 0..1 fill of the ReWind ultimate. */
  ultimateFraction: number;
  /** Unspent powers. Hidden at zero — see `update`. */
  bankedPicks: number;
  /** At the cap, so further level-ups are throwing picks away. */
  picksAtCap: boolean;
  /** 0..1 progress of the F hold toward the all-in screen. */
  bankHoldFraction: number;
}

function formatClock(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.floor(totalSeconds % 60);
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

export class Hud {
  private readonly speedEl = document.getElementById('speed-readout')!;
  private readonly waveEl = document.getElementById('wave-readout')!;
  private readonly felledEl = document.getElementById('felled-readout')!;
  private readonly picksEl = document.getElementById('picks-readout')!;
  private readonly picksHintEl = document.getElementById('picks-hint')!;
  private readonly crosshairEl = document.getElementById('crosshair')!;
  /**
   * The ultimate meter is not a bar in this column any more — it is a half-ring
   * around the crosshair, which is where it is actually read. See `UltimateArc`.
   */
  private readonly ultArc = new UltimateArc();
  /**
   * HP, XP and the dash charges left this column entirely: they are the painted
   * panel in the top-left corner now. What stays down here is the run's
   * *numbers* — the readouts that have no art and are read on purpose rather
   * than at a glance. See `MegaflowHud`.
   */
  private readonly vitals = new MegaflowHud();

  update(state: HudState, dt: number): void {
    // Flow rides the existing speed cell rather than adding a HUD element: it
    // is a property *of* the speed, and the readout only grows while the trickle
    // is actually paying (>= 0.05%/s — below that the suffix is churn, not news).
    this.speedEl.textContent =
      state.flowXpPctPerSecond >= 0.05
        ? `${state.speed.toFixed(1)} u/s +${state.flowXpPctPerSecond.toFixed(1)}%/s`
        : `${state.speed.toFixed(1)} u/s`;
    this.vitals.update(state, dt);
    // The element finally earns its id: run clock and wave share the cell —
    // the clock is the run stat, the wave says what the horde is made of.
    this.waveEl.textContent = `${formatClock(state.elapsedSeconds)} · W${state.wave}`;
    // Hidden at zero rather than shown as "0": the counter is a trophy shelf,
    // and an empty one on every early run is noise on a HUD read at 35 u/s.
    this.felledEl.textContent =
      state.bossesFelled > 0 ? `\u25C6 ${state.bossesFelled}` : '';
    this.felledEl.classList.toggle('hidden', state.bossesFelled === 0);

    // Hidden at zero, which is also the whole affordance for a key that does
    // nothing with an empty bank: the F hint is only on screen while F works.
    // The hint doubles as the hold meter — 2.5 s with no feedback reads as a
    // dead key — and says what the hold is *for* once it is under way.
    //
    // How *many* are banked is the badge's job now, up on the vitals panel next
    // to the bar that filled to earn them. Printing it in both places would put
    // the same number on screen twice at different sizes.
    this.picksEl.classList.toggle('hidden', state.bankedPicks === 0);
    this.picksEl.classList.toggle('at-cap', state.picksAtCap);
    this.picksHintEl.textContent = state.bankHoldFraction > 0 ? 'ALL IN' : 'F';
    this.picksHintEl.style.setProperty('--hold', state.bankHoldFraction.toFixed(3));

    this.ultArc.setCharge(state.ultimateFraction);
  }

  /** Shown and hidden with the rest of the HUD; `#hud` cannot own it because it is centre-screen. */
  setVisible(visible: boolean): void {
    this.crosshairEl.classList.toggle('hidden', !visible);
    this.ultArc.setVisible(visible);
  }

  /**
   * Whether a run is on screen at all. Separate from `setVisible`, which
   * follows pointer lock and takes the aiming aids with it — the vitals panel
   * is not an aiming aid and stays up through a choice screen, for the same
   * reason the readout column does.
   */
  setPanelVisible(visible: boolean): void {
    this.vitals.setVisible(visible);
  }

  /** Drops the bar easing so a fresh run does not sweep in from the last one. */
  resetPanel(): void {
    this.vitals.reset();
  }
}
