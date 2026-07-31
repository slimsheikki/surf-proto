const INITIAL_LEVEL = 1;
const INITIAL_XP_TO_NEXT = 6;

/** XP curve for reaching `level + 1` from `level`. */
function xpRequiredAfterReaching(level: number): number {
  return 5 + level * 3;
}

export class LevelSystem {
  level = INITIAL_LEVEL;
  xp = 0;
  private xpToNext = INITIAL_XP_TO_NEXT;

  addXp(amount: number, onLevelUp: () => void): void {
    this.xp += amount;
    while (this.xp >= this.xpToNext) {
      this.xp -= this.xpToNext;
      this.level += 1;
      this.xpToNext = xpRequiredAfterReaching(this.level);
      onLevelUp();
    }
  }

  get progress(): number {
    return this.xp / this.xpToNext;
  }

  /** XP still needed for the next level — exposed mainly so tests/HUD can assert the curve. */
  get xpToNextLevel(): number {
    return this.xpToNext;
  }

  /**
   * Full restart of progression. `xpToNext` is private and grows on every
   * level-up, so a restart that only reassigned `level`/`xp` from outside left
   * a level-1 player needing a late-game XP threshold to level up again.
   */
  reset(): void {
    this.level = INITIAL_LEVEL;
    this.xp = 0;
    this.xpToNext = INITIAL_XP_TO_NEXT;
  }
}
