/**
 * The master NPR switch — the "classic look" fallback used for A/B tuning.
 *
 * Flipping `uNprEnabled` only swaps the *shader* branch (banded cel ↔ stock
 * lighting). Sky and lights are Three-scene objects, not shader branches, so a
 * full classic look also needs App to rebuild those; App subscribes here and
 * does that. Keep this module dependency-free so anything can import it.
 */

import { nprUniforms } from './NprUniforms';

type Listener = (enabled: boolean) => void;

const listeners = new Set<Listener>();

export const NPR = {
  /** Cel shading on by default — this is the game's look now. */
  enabled: true,
};

/** Set the master toggle; updates the shared uniform and notifies subscribers. */
export function setNprEnabled(enabled: boolean): void {
  NPR.enabled = enabled;
  nprUniforms.uNprEnabled.value = enabled ? 1 : 0;
  for (const listener of listeners) listener(enabled);
}

/** Subscribe to master-toggle changes (App uses this to swap sky + lights). */
export function onNprChanged(listener: Listener): void {
  listeners.add(listener);
}

// Keep the uniform honest with the default above even if nothing calls the setter.
nprUniforms.uNprEnabled.value = NPR.enabled ? 1 : 0;
