/**
 * `victory` is terminal like `gameOver`: it is only reachable by killing the
 * level-10 boss, and the only way out of either is a restart.
 */
export type GameState = 'playing' | 'pausedForUpgrade' | 'gameOver' | 'victory';
