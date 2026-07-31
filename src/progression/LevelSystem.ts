export class LevelSystem {
  level = 1;
  xp = 0;
  private xpToNext = 6;

  addXp(amount: number, onLevelUp: () => void): void {
    this.xp += amount;
    while (this.xp >= this.xpToNext) {
      this.xp -= this.xpToNext;
      this.level += 1;
      this.xpToNext = 5 + this.level * 3;
      onLevelUp();
    }
  }

  get progress(): number {
    return this.xp / this.xpToNext;
  }
}
