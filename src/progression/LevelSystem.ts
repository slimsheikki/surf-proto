const INITIAL_LEVEL = 1;
const INITIAL_XP_TO_NEXT = 6;

/**
 * Ceiling on unspent picks.
 *
 * `level` keeps climbing past it — difficulty, boss cadence and ultimate
 * scaling all read `level`, not this — but a pick earned at the cap is lost.
 * That waste is the whole pressure behind cashing in: without it, banking
 * costs nothing and F is a chore rather than a decision. The HUD goes red at
 * the cap so the loss is never silent.
 */
export const PICK_CAP = 5;

/** XP curve for reaching `level + 1` from `level`. */
function xpRequiredAfterReaching(level: number): number {
  return 5 + level * 3;
}

export interface LevelSnapshot {
  level: number;
  xp: number;
  xpToNext: number;
  bankedPicks: number;
}

export class LevelSystem {
  level = INITIAL_LEVEL;
  xp = 0;
  /**
   * Upgrade picks earned and not yet spent.
   *
   * Lives here rather than on `Game` — and therefore inside the one snapshot
   * `Rewind` already records — so the recorder needs no new `Frame` field, no
   * `write()` line and no `applyFrame()` line, and `reset()` already covers it
   * on restart. It also means rewinding across a cash-in refunds the picks in
   * the same motion that un-applies the stats they bought.
   */
  bankedPicks = 0;
  private xpToNext = INITIAL_XP_TO_NEXT;

  /**
   * Grants XP and banks a pick per level gained, returning the number of levels
   * crossed.
   *
   * The pick is granted right here rather than through a callback because there
   * is nothing left for a caller to do with the event: a level-up no longer
   * opens anything. That is also what makes the old double-level-up bug
   * impossible — a single fat orb (or the boss's 45 XP, roughly two levels)
   * crosses two thresholds and banks two picks, where the callback version
   * opened two menus and silently threw the first one's choice away.
   */
  addXp(amount: number): number {
    this.xp += amount;
    let gained = 0;
    while (this.xp >= this.xpToNext) {
      this.xp -= this.xpToNext;
      this.level += 1;
      this.xpToNext = xpRequiredAfterReaching(this.level);
      gained += 1;
      // Dropped at the cap, deliberately. See PICK_CAP.
      if (this.bankedPicks < PICK_CAP) this.bankedPicks += 1;
    }
    return gained;
  }

  get progress(): number {
    return this.xp / this.xpToNext;
  }

  get atPickCap(): boolean {
    return this.bankedPicks >= PICK_CAP;
  }

  /** Clamped rather than asserted: a spend can never drive the bank negative. */
  spendPicks(count: number): void {
    this.bankedPicks = Math.max(0, this.bankedPicks - count);
  }

  /** XP still needed for the next level — exposed mainly so tests/HUD can assert the curve. */
  get xpToNextLevel(): number {
    return this.xpToNext;
  }

  /**
   * Progression state as one value, for the rewind recorder.
   *
   * `xpToNext` is private and grows with every level-up, so a rewind that only
   * put `level` and `xp` back would leave the player needing the *old*
   * threshold — the same class of bug `reset()` documents below.
   */
  capture(): LevelSnapshot {
    return {
      level: this.level,
      xp: this.xp,
      xpToNext: this.xpToNext,
      bankedPicks: this.bankedPicks,
    };
  }

  restore(snapshot: LevelSnapshot): void {
    this.level = snapshot.level;
    this.xp = snapshot.xp;
    this.xpToNext = snapshot.xpToNext;
    this.bankedPicks = snapshot.bankedPicks;
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
    this.bankedPicks = 0;
  }
}
