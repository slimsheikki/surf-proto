/** Mirrors `GameOverScreen` exactly, including its restart wiring. */
export class VictoryScreen {
  private readonly overlay = document.getElementById('victory')!;
  private readonly statsEl = document.getElementById('victory-stats')!;
  private readonly restartButton = document.getElementById('victory-restart-button')!;

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
