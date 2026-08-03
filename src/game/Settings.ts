import { MovementConfig, setMovementPreference } from '../player/MovementConfig';

/**
 * Player-facing settings — the two that decide how the game *feels* to aim and
 * look with, kept apart from the movement tuning panel on `O`.
 *
 * That panel is a workbench for the CS convars and it changes what the movement
 * *is*. These two change nothing about the simulation; they are the settings a
 * player expects to find before they will judge anything else, and they are the
 * reason this is persisted to `localStorage` while the tuning panel's values are
 * not. Somebody who has dialled in their sensitivity should not have to do it
 * again tomorrow.
 *
 * Sensitivity lives here but is *stored* in `MovementConfig`, because that is
 * where `InputSystem` reads it. This module owns the number and writes it
 * through, so there is exactly one source of truth rather than two that drift.
 */

const STORAGE_KEY = 'surf-proto.settings.v1';

/** Vertical FOV in degrees — three.js's convention, which is what the camera takes. */
export const DEFAULT_FOV = 75;
export const MIN_FOV = 60;
export const MAX_FOV = 120;

export const MIN_SENSITIVITY = 0.5;
export const MAX_SENSITIVITY = 15;

/** Authored default, captured at module load before anything can write to it. */
const DEFAULT_SENSITIVITY = MovementConfig.SENSITIVITY;

export interface SettingsState {
  fov: number;
  sensitivity: number;
}

const state: SettingsState = {
  fov: DEFAULT_FOV,
  sensitivity: MovementConfig.SENSITIVITY,
};

const listeners: ((s: SettingsState) => void)[] = [];

export function getSettings(): Readonly<SettingsState> {
  return state;
}

/** Notified on every change, including the one `loadSettings` performs at boot. */
export function onSettingsChanged(listener: (s: SettingsState) => void): void {
  listeners.push(listener);
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

export function setFov(fov: number): void {
  state.fov = clamp(fov, MIN_FOV, MAX_FOV);
  commit();
}

export function setSensitivity(sensitivity: number): void {
  state.sensitivity = clamp(sensitivity, MIN_SENSITIVITY, MAX_SENSITIVITY);
  // Written through rather than mirrored: `InputSystem` reads MovementConfig,
  // and a preference is what survives the run reset that reverts upgrade buffs.
  setMovementPreference('SENSITIVITY', state.sensitivity);
  commit();
}

export function resetSettings(): void {
  state.fov = DEFAULT_FOV;
  state.sensitivity = DEFAULT_SENSITIVITY;
  setMovementPreference('SENSITIVITY', DEFAULT_SENSITIVITY);
  commit();
}

function commit(): void {
  save();
  for (const listener of listeners) listener(state);
}

/**
 * Reads any stored settings and applies them. Call once at boot, before the
 * first frame — every listener fires, so the camera gets its FOV and the input
 * system its sensitivity without anyone having to opt in.
 *
 * Storage is best-effort in both directions: private browsing modes throw on
 * access rather than returning null, and a settings panel is not worth taking
 * the whole app down for.
 */
export function loadSettings(): void {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<SettingsState>;
      if (typeof parsed.fov === 'number') state.fov = clamp(parsed.fov, MIN_FOV, MAX_FOV);
      if (typeof parsed.sensitivity === 'number') {
        state.sensitivity = clamp(parsed.sensitivity, MIN_SENSITIVITY, MAX_SENSITIVITY);
      }
    }
  } catch {
    // Unreadable or corrupt storage: the defaults above are already correct.
  }
  setMovementPreference('SENSITIVITY', state.sensitivity);
  for (const listener of listeners) listener(state);
}

function save(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Storage disabled — the settings still apply for this session.
  }
}
