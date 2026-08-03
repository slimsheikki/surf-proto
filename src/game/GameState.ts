/**
 * `gameOver` is the only terminal state, and that is deliberate: a run has no
 * win condition. Felling a Monolith is a milestone the run continues past —
 * see `Game.fellBoss` — so the only way out is death and the only screen with a
 * button on it is the game-over one.
 */
export type GameState =
  | 'playing'
  | 'pausedForUpgrade'
  /** ReWind is running the recording backwards; the sim is not advancing. */
  | 'rewinding'
  /** ReWind has picked its moment and is counting the player back in. */
  | 'rewindCountdown'
  | 'gameOver';
