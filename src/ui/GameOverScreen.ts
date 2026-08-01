function formatClock(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.floor(totalSeconds % 60);
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

/**
 * The one screen that ends a run.
 *
 * It reports Monoliths felled alongside level and time because the run is
 * endless: with no victory screen left, this is the only place the player is
 * told what they actually achieved, and "reached level 24, 2 felled" is the
 * score. Zero is left unmentioned rather than printed as "0 felled" — a first
 * run that died at level 6 does not need to be told it failed at something it
 * never got near.
 */
export class GameOverScreen {
  private readonly overlay = document.getElementById('game-over')!;
  private readonly statsEl = document.getElementById('game-over-stats')!;
  private readonly restartButton = document.getElementById('restart-button')!;

  constructor(onRestart: () => void) {
    this.restartButton.addEventListener('click', onRestart);
  }

  show(level: number, elapsedSeconds: number, bossesFelled = 0): void {
    const felled =
      bossesFelled > 0 ? ` — ${bossesFelled} Monolith${bossesFelled === 1 ? '' : 's'} felled` : '';
    this.statsEl.textContent = `Survived ${formatClock(elapsedSeconds)} — reached level ${level}${felled}`;
    this.overlay.classList.remove('hidden');
  }

  hide(): void {
    this.overlay.classList.add('hidden');
  }
}
