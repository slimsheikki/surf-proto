export interface HudState {
  speed: number;
  hpFraction: number;
  xpFraction: number;
  level: number;
  elapsedSeconds: number;
  /** Monoliths felled this run. Shown only once it is non-zero — see `update`. */
  bossesFelled: number;
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
  }
}
