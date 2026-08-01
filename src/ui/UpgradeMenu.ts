import { Upgrade } from '../progression/Upgrades';

export class UpgradeMenu {
  private readonly overlay = document.getElementById('upgrade-menu')!;
  private readonly choicesEl = document.getElementById('upgrade-choices')!;

  show(choices: Upgrade[], onPick: (choice: Upgrade) => void): void {
    this.choicesEl.innerHTML = '';
    for (const choice of choices) {
      const button = document.createElement('button');
      button.className = 'upgrade-choice';
      button.innerHTML = `<strong>${choice.name}</strong><br/>${choice.description}`;
      button.addEventListener('click', () => onPick(choice));
      this.choicesEl.appendChild(button);
    }
    this.overlay.classList.remove('hidden');
  }

  hide(): void {
    this.overlay.classList.add('hidden');
  }
}
