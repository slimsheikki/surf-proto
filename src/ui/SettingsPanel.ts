import {
  getSettings,
  MAX_FOV,
  MAX_MUSIC_VOLUME,
  MAX_SENSITIVITY,
  MIN_FOV,
  MIN_MUSIC_VOLUME,
  MIN_SENSITIVITY,
  resetSettings,
  setFov,
  setMusicVolume,
  setSensitivity,
} from '../game/Settings';

/**
 * The in-run settings screen, on `Escape`. It doubles as the pause screen,
 * which is not a shortcut — it is the only arrangement that makes `Escape`
 * work at all.
 *
 * Under pointer lock the browser owns `Escape`: pressing it releases the lock
 * and the keydown is never delivered to the page, so "Escape opens settings"
 * cannot be implemented as a key handler. What the page *does* reliably get is
 * `pointerlockchange`. So `App` opens this on losing the lock and closes it on
 * `Escape` — which works, because by then the page has focus and the key is
 * ours again. The result is exactly the asked-for gesture, and the pause that
 * losing pointer lock already caused now has a screen worth looking at instead
 * of a bare "click to start".
 *
 * Each row is a slider *and* a number field over the same value, because the
 * two answer different questions: a slider is for finding a feel by sweeping,
 * a number field is for typing in the sensitivity you already know you use.
 */

interface Row {
  label: string;
  hint: string;
  min: number;
  max: number;
  step: number;
  get: () => number;
  set: (value: number) => void;
  format: (value: number) => string;
}

/**
 * Mute is the one control here that is not a number, so it is a button beside
 * Reset rather than a row — and it is driven through `MusicManager` rather than
 * the settings store, because the manager owns the live audio elements and the
 * store only remembers what it settled on.
 */
export interface MusicControls {
  isMuted: () => boolean;
  /** Flips it and persists whatever it became. */
  toggleMute: () => void;
}

export class SettingsPanel {
  private readonly root: HTMLDivElement;
  private readonly refreshers: (() => void)[] = [];
  private open = false;

  constructor(
    private readonly onClose: () => void,
    private readonly music: MusicControls,
  ) {
    this.root = document.createElement('div');
    this.root.id = 'settings-panel';
    this.root.className = 'overlay hidden';

    const card = document.createElement('div');
    card.className = 'settings-card';

    const heading = document.createElement('h1');
    heading.textContent = 'Settings';
    card.appendChild(heading);

    const rows: Row[] = [
      {
        label: 'Field of view',
        hint: 'Vertical FOV. Wider shows more of the ramp you are riding across.',
        min: MIN_FOV,
        max: MAX_FOV,
        step: 1,
        get: () => getSettings().fov,
        set: setFov,
        format: (v) => `${Math.round(v)}°`,
      },
      {
        label: 'Sensitivity',
        hint: 'CS sensitivity: degrees of yaw per mouse count is m_yaw (0.022) × this.',
        min: MIN_SENSITIVITY,
        max: MAX_SENSITIVITY,
        step: 0.05,
        get: () => getSettings().sensitivity,
        set: setSensitivity,
        format: (v) => v.toFixed(2),
      },
      {
        label: 'Music volume',
        hint: 'Background music. A new track is drawn at the start of every run.',
        // Percent rather than the stored 0..1 gain: a slider from 0 to 1 in
        // steps of 0.01 puts "0.35" in the number field, which reads as a
        // developer value. The store still keeps the gain.
        min: MIN_MUSIC_VOLUME * 100,
        max: MAX_MUSIC_VOLUME * 100,
        step: 1,
        get: () => getSettings().musicVolume * 100,
        set: (value) => setMusicVolume(value / 100),
        format: (v) => `${Math.round(v)}%`,
      },
    ];
    for (const row of rows) card.appendChild(this.buildRow(row));

    const actions = document.createElement('div');
    actions.className = 'settings-actions';

    const mute = document.createElement('button');
    mute.type = 'button';
    const syncMute = () => {
      const muted = this.music.isMuted();
      mute.textContent = muted ? 'Unmute music' : 'Mute music';
      mute.classList.toggle('active', muted);
    };
    mute.addEventListener('click', () => {
      this.music.toggleMute();
      syncMute();
    });
    syncMute();
    this.refreshers.push(syncMute);

    const reset = document.createElement('button');
    reset.type = 'button';
    reset.textContent = 'Reset to defaults';
    reset.addEventListener('click', () => {
      resetSettings();
      this.refresh();
    });

    const resume = document.createElement('button');
    resume.type = 'button';
    resume.className = 'primary';
    resume.textContent = 'Resume';
    resume.addEventListener('click', () => this.onClose());

    actions.append(mute, reset, resume);
    card.appendChild(actions);

    const hint = document.createElement('p');
    hint.className = 'overlay-hint';
    // `O` is mentioned here and nowhere else in-game; a player who wants the
    // convars will find them, and one who does not is never shown them.
    hint.innerHTML = 'Press <kbd>ESC</kbd> to resume &mdash; <kbd>O</kbd> for movement tuning';
    card.appendChild(hint);

    this.root.appendChild(card);
    document.body.appendChild(this.root);
  }

  private buildRow(row: Row): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'settings-row';

    const label = document.createElement('label');
    label.className = 'settings-label';
    label.textContent = row.label;

    const readout = document.createElement('span');
    readout.className = 'settings-value';

    const slider = document.createElement('input');
    slider.type = 'range';
    slider.min = String(row.min);
    slider.max = String(row.max);
    slider.step = String(row.step);

    const field = document.createElement('input');
    field.type = 'number';
    field.className = 'settings-number';
    field.min = String(row.min);
    field.max = String(row.max);
    field.step = String(row.step);

    const hint = document.createElement('p');
    hint.className = 'settings-hint';
    hint.textContent = row.hint;

    const sync = () => {
      const value = row.get();
      slider.value = String(value);
      // Only rewrite the field when it does not already hold this value, so
      // typing "8" on the way to "8.5" does not get rewritten to "8" under the
      // caret on the first keystroke.
      if (Number(field.value) !== value) field.value = String(Number(value.toFixed(2)));
      readout.textContent = row.format(value);
    };

    slider.addEventListener('input', () => {
      row.set(Number(slider.value));
      sync();
    });
    field.addEventListener('input', () => {
      // Clamping happens in the store; an out-of-range or half-typed entry is
      // simply not applied yet, and `blur` puts the field back in sync.
      const value = Number(field.value);
      if (field.value !== '' && Number.isFinite(value)) {
        row.set(value);
        slider.value = String(row.get());
        readout.textContent = row.format(row.get());
      }
    });
    field.addEventListener('blur', sync);

    this.refreshers.push(sync);

    const head = document.createElement('div');
    head.className = 'settings-head';
    head.append(label, readout);

    const controls = document.createElement('div');
    controls.className = 'settings-controls';
    controls.append(slider, field);

    wrap.append(head, controls, hint);
    return wrap;
  }

  private refresh(): void {
    for (const sync of this.refreshers) sync();
  }

  get isOpen(): boolean {
    return this.open;
  }

  show(): void {
    if (this.open) return;
    this.open = true;
    this.refresh();
    this.root.classList.remove('hidden');
  }

  hide(): void {
    if (!this.open) return;
    this.open = false;
    this.root.classList.add('hidden');
  }
}
