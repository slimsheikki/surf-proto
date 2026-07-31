export interface HudState {
  speed: number;
  hpFraction: number;
  xpFraction: number;
  level: number;
  elapsedSeconds: number;
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

  update(state: HudState): void {
    this.speedEl.textContent = `${state.speed.toFixed(1)} u/s`;
    this.hpFillEl.style.width = `${Math.max(0, Math.min(1, state.hpFraction)) * 100}%`;
    this.xpFillEl.style.width = `${Math.max(0, Math.min(1, state.xpFraction)) * 100}%`;
    this.levelEl.textContent = `Lv ${state.level}`;
    this.waveEl.textContent = formatClock(state.elapsedSeconds);
  }
}
