import { UltimateArc } from './UltimateArc';

export interface HudState {
  speed: number;
  hpFraction: number;
  xpFraction: number;
  level: number;
  elapsedSeconds: number;
  /** Monoliths felled this run. Shown only once it is non-zero — see `update`. */
  bossesFelled: number;
  /** 0..1 fill — whole dash charges plus progress toward the next one. */
  dashFraction: number;
  dashCharges: number;
  dashMaxCharges: number;
  /** 0..1 fill of the ReWind ultimate. */
  ultimateFraction: number;
}

function formatClock(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.floor(totalSeconds % 60);
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

export class Hud {
  private readonly speedEl = document.getElementById('speed-readout')!;
  private readonly hpFillEl = document.getElementById('bar-hp-fill')!;
  private readonly xpFillEl = document.getElementById('bar-xp-fill')!;
  private readonly levelEl = document.getElementById('level-readout')!;
  private readonly waveEl = document.getElementById('wave-readout')!;
  private readonly felledEl = document.getElementById('felled-readout')!;
  private readonly dashFillEl = document.getElementById('bar-dash-fill')!;
  private readonly dashReadoutEl = document.getElementById('dash-readout')!;
  private readonly crosshairEl = document.getElementById('crosshair')!;
  /**
   * The ultimate meter is not a bar in this column any more — it is a half-ring
   * around the crosshair, which is where it is actually read. See `UltimateArc`.
   */
  private readonly ultArc = new UltimateArc();

  update(state: HudState): void {
    this.speedEl.textContent = `${state.speed.toFixed(1)} u/s`;
    this.hpFillEl.style.width = `${Math.max(0, Math.min(1, state.hpFraction)) * 100}%`;
    this.xpFillEl.style.width = `${Math.max(0, Math.min(1, state.xpFraction)) * 100}%`;
    this.levelEl.textContent = `Lv ${state.level}`;
    this.waveEl.textContent = formatClock(state.elapsedSeconds);
    // Hidden at zero rather than shown as "0": the counter is a trophy shelf,
    // and an empty one on every early run is noise on a HUD read at 35 u/s.
    this.felledEl.textContent =
      state.bossesFelled > 0 ? `\u25C6 ${state.bossesFelled}` : '';
    this.felledEl.classList.toggle('hidden', state.bossesFelled === 0);
    this.dashFillEl.style.width = `${Math.max(0, Math.min(1, state.dashFraction)) * 100}%`;
    this.dashReadoutEl.textContent = `Dash ${state.dashCharges}/${state.dashMaxCharges}`;

    this.ultArc.setCharge(state.ultimateFraction);
  }

  /** Shown and hidden with the rest of the HUD; `#hud` cannot own it because it is centre-screen. */
  setVisible(visible: boolean): void {
    this.crosshairEl.classList.toggle('hidden', !visible);
    this.ultArc.setVisible(visible);
  }
}
