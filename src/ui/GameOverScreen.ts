export class GameOverScreen {
  private readonly overlay = document.getElementById('game-over')!;
  private readonly statsEl = document.getElementById('game-over-stats')!;
  private readonly restartButton = document.getElementById('restart-button')!;

  constructor(onRestart: () => void) {
    this.restartButton.addEventListener('click', onRestart);
  }

  show(level: number, elapsedSeconds: number): void {
    const minutes = Math.floor(elapsedSeconds / 60);
    const seconds = Math.floor(elapsedSeconds % 60);
    this.statsEl.textContent = `Survived ${minutes}:${seconds.toString().padStart(2, '0')} — reached level ${level}`;
    this.overlay.classList.remove('hidden');
  }

  hide(): void {
    this.overlay.classList.add('hidden');
  }
}
