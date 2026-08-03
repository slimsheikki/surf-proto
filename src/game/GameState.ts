/**
 * `gameOver` is the only terminal state, and that is deliberate: a run has no
 * win condition. Felling a Monolith is a milestone the run continues past —
 * see `Game.fellBoss` — so the only way out is death and the only screen with a
 * button on it is the game-over one.
 */
export type GameState =
  | 'playing'
  /**
   * A choice overlay is up and the sim is frozen: a shrine blessing, or the
   * banked-power selector the player opened with F.
   */
  | 'pausedForUpgrade'
  /** ReWind is running the recording backwards; the sim is not advancing. */
  | 'rewinding'
  /**
   * Counting the player back in — after a ReWind, or after cashing in banked
   * powers. Deliberately not named for either one: both end with a frozen world
   * and a player who needs a beat to find the ramp again, and they resume
   * through the same code.
   */
  | 'countdown'
  | 'gameOver';
