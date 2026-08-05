import { DEFAULT_MUSIC_VOLUME } from '../audio/MusicManager';
import { MovementConfig, setMovementPreference } from '../player/MovementConfig';

/**
 * Player-facing settings — the ones that decide how the game *feels* to aim and
 * look with, plus how loud it is, kept apart from the movement tuning panel on
 * `O`.
 *
 * That panel is a workbench for the CS convars and it changes what the movement
 * *is*. What is kept here instead is what a player expects to be remembered
 * about them, which is why this is persisted to `localStorage` while the tuning
 * panel's values are not. Somebody who has dialled in their sensitivity should
 * not have to do it again tomorrow.
 *
 * `beginnerMode` is the one entry that does change the simulation. It is here
 * rather than on the workbench because it is chosen on the map picker by a
 * player who has never heard of a convar, and because forgetting it overnight
 * would strand exactly the person it exists for.
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

/** Music is stored as a 0..1 gain — the panel is what shows it as a percentage. */
export const MIN_MUSIC_VOLUME = 0;
export const MAX_MUSIC_VOLUME = 1;

/** Authored default, captured at module load before anything can write to it. */
const DEFAULT_SENSITIVITY = MovementConfig.SENSITIVITY;

export interface SettingsState {
  fov: number;
  sensitivity: number;
  /** 0..1, applied to `MusicManager` by whoever owns it (`App`). */
  musicVolume: number;
  musicMuted: boolean;
  /**
   * Whether cashing in banked powers hands control back through the 3-2-1
   * rather than dropping the player straight into a moving world.
   *
   * A preference, not a difficulty knob: the countdown is three seconds of live
   * look to find the ramp again, which some players want and some read as the
   * interruption they were trying to avoid. Toggled from the selection menu
   * itself, where it is actually noticed.
   */
  countdownOnResume: boolean;
  /**
   * Beginner Mode: W holds your line on a ramp instead of doing nothing.
   *
   * The one setting here that *does* change the simulation, which is why it is
   * written through to `MovementConfig.SURF_ASSIST` the way sensitivity is
   * rather than being read from here by the controller. It lives in this module
   * anyway because it has to survive a session — the player who needs it is
   * exactly the one who will not think to go and find it again tomorrow — and
   * because the map picker is where it is chosen, not the convar workbench.
   *
   * Defaults ON. A first-time player cannot ask for help they do not know
   * exists, and it is one click on the screen they just came through to leave.
   */
  beginnerMode: boolean;
  /**
   * Whether the combat layer exists at all. Off means no drones, no seeders, no
   * Monoliths — just the movement, which is the point of the game and the thing
   * people practise. It lives here rather than on the convar bench because it
   * is a run-shaping choice a player makes about the game, not a number about
   * the movement, and because someone who has switched combat off to learn a
   * map should not have it back tomorrow without asking.
   *
   * `Game` reads it live every tick, so flipping it mid-run takes effect on the
   * next one — see `Game.applyEnemiesSetting`.
   */
  enemiesEnabled: boolean;
}

const state: SettingsState = {
  fov: DEFAULT_FOV,
  sensitivity: MovementConfig.SENSITIVITY,
  musicVolume: DEFAULT_MUSIC_VOLUME,
  musicMuted: false,
  countdownOnResume: true,
  beginnerMode: true,
  enemiesEnabled: true,
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

export function setMusicVolume(volume: number): void {
  state.musicVolume = clamp(volume, MIN_MUSIC_VOLUME, MAX_MUSIC_VOLUME);
  commit();
}

export function setMusicMuted(muted: boolean): void {
  state.musicMuted = muted;
  commit();
}

export function setCountdownOnResume(enabled: boolean): void {
  state.countdownOnResume = enabled;
  commit();
}

export function setBeginnerMode(enabled: boolean): void {
  state.beginnerMode = enabled;
  // A preference, like sensitivity: `resetMovementConfig` runs on every restart
  // to strip a run's upgrade buffs, and the mode must not be stripped with them.
  setMovementPreference('SURF_ASSIST', enabled);
  commit();
}

export function setEnemiesEnabled(enabled: boolean): void {
  state.enemiesEnabled = enabled;
  commit();
}

export function resetSettings(): void {
  state.fov = DEFAULT_FOV;
  state.sensitivity = DEFAULT_SENSITIVITY;
  state.musicVolume = DEFAULT_MUSIC_VOLUME;
  state.musicMuted = false;
  state.countdownOnResume = true;
  state.beginnerMode = true;
  state.enemiesEnabled = true;
  setMovementPreference('SENSITIVITY', DEFAULT_SENSITIVITY);
  setMovementPreference('SURF_ASSIST', true);
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
      if (typeof parsed.musicVolume === 'number') {
        state.musicVolume = clamp(parsed.musicVolume, MIN_MUSIC_VOLUME, MAX_MUSIC_VOLUME);
      }
      if (typeof parsed.musicMuted === 'boolean') state.musicMuted = parsed.musicMuted;
      if (typeof parsed.countdownOnResume === 'boolean') {
        state.countdownOnResume = parsed.countdownOnResume;
      }
      // Absent from a blob written before Beginner Mode existed, which leaves
      // the default above standing — an existing player is a new player as far
      // as this feature is concerned, and they can switch it off on the way in.
      if (typeof parsed.beginnerMode === 'boolean') state.beginnerMode = parsed.beginnerMode;
      // Same story as Beginner Mode for an older blob: absent means the default
      // above stands, which is the game with its combat layer switched on.
      if (typeof parsed.enemiesEnabled === 'boolean') state.enemiesEnabled = parsed.enemiesEnabled;
    }
  } catch {
    // Unreadable or corrupt storage: the defaults above are already correct.
  }
  setMovementPreference('SENSITIVITY', state.sensitivity);
  setMovementPreference('SURF_ASSIST', state.beginnerMode);
  for (const listener of listeners) listener(state);
}

function save(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Storage disabled — the settings still apply for this session.
  }
}
