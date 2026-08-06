import {
  getSettings,
  MAX_FOV,
  MAX_MUSIC_VOLUME,
  MAX_SENSITIVITY,
  MIN_FOV,
  MIN_MUSIC_VOLUME,
  MIN_SENSITIVITY,
  resetSettings,
  setEnemiesEnabled,
  setFov,
  setMusicVolume,
  setNprEnabledSetting,
  setRampOutlines,
  setRetroAffine,
  setRetroDither,
  setRetroNearest,
  setRetroQuantize,
  setRetroVertexWobble,
  setSensitivity,
} from '../game/Settings';
import { MovementPanel } from './MovementPanel';
import { createSwitchRow } from './SurfSwitch';

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
 *
 * Every on/off entry here is a `SurfSwitch` — the same control the map picker's
 * mode row uses — so a boolean is asked the same way everywhere in the game.
 *
 * **Advanced Settings** folds the CS convar bench (`MovementPanel`) in
 * underneath, collapsed by default. It used to be a floating panel of its own on
 * `O`, and two independent screens that both released the pointer lock and both
 * paused the sim was two of everything to keep in agreement. `O` now opens this
 * screen with that section already expanded.
 */

/** The combat layer's master switch, under Advanced Settings. */
const ENEMIES_SWITCH = {
  label: 'Enemies',
  hint: 'Off is movement only: no drones, no seeders, no Monoliths. Takes effect immediately, mid-run included.',
  get: () => getSettings().enemiesEnabled,
  set: setEnemiesEnabled,
};

/**
 * The cel-renderer switches, under Advanced → Visuals. The master toggle first,
 * then the environment-outline choice, then the subtle retro effects that ship
 * off. Every one is live — flip it and the world updates on the next frame.
 */
const VISUAL_SWITCHES = [
  {
    label: 'Cel shading',
    hint: 'Jet Set Radio look: banded shading, gradient sky, black outlines, rim light. Off falls back to the classic realistic pass.',
    get: () => getSettings().nprEnabled,
    set: setNprEnabledSetting,
  },
  {
    label: 'Ramp outlines',
    hint: 'Black outlines on the environment too, not just characters. Bolder and more comic, a little busier and heavier at speed.',
    get: () => getSettings().rampOutlines,
    set: setRampOutlines,
  },
  {
    label: 'Dithering',
    hint: 'Ordered Bayer screen-door transparency instead of smooth alpha. Retro; off by default.',
    get: () => getSettings().retroDither,
    set: setRetroDither,
  },
  {
    label: 'Colour banding',
    hint: 'Posterize the final image to a few levels per channel. Retro; off by default.',
    get: () => getSettings().retroQuantize,
    set: setRetroQuantize,
  },
  {
    label: 'UV wobble',
    hint: 'Slight affine texture warp, PS1-style. Retro; off by default.',
    get: () => getSettings().retroAffine,
    set: setRetroAffine,
  },
  {
    label: 'Vertex wobble',
    hint: 'Tiny vertex snap/jitter, PS1-style. Retro; off by default.',
    get: () => getSettings().retroVertexWobble,
    set: setRetroVertexWobble,
  },
  {
    label: 'Nearest textures',
    hint: 'Crunchy nearest-neighbour texture filtering. Retro; off by default.',
    get: () => getSettings().retroNearest,
    set: setRetroNearest,
  },
];

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
 * Music on/off is drawn as a switch like every other boolean, but it is driven
 * through `MusicManager` rather than the settings store, because the manager
 * owns the live audio elements and the store only remembers what it settled on.
 * The switch reads "Music", so it is on when the game is *not* muted.
 */
export interface MusicControls {
  isMuted: () => boolean;
  /** Flips it and persists whatever it became. */
  toggleMute: () => void;
}

export class SettingsPanel {
  private readonly root: HTMLDivElement;
  private readonly refreshers: (() => void)[] = [];
  private readonly movementPanel = new MovementPanel();
  private readonly advanced: HTMLDivElement;
  private readonly advancedToggle: HTMLButtonElement;
  private readonly closeButton: HTMLButtonElement;
  private readonly hint: HTMLParagraphElement;
  private open = false;
  private advancedOpen = false;

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

    // Music is a boolean, so it is a switch — it used to be a button beside
    // Reset whose *label* flipped, which reads as an action rather than as the
    // state it actually shows. Enemies is not here: it belongs to Advanced
    // Settings, with the other switches that change what the game is.
    card.appendChild(
      this.buildSwitch({
        label: 'Music',
        hint: 'Background music. A new track is drawn at the start of every run.',
        get: () => !this.music.isMuted(),
        set: () => this.music.toggleMute(),
      }),
    );

    const actions = document.createElement('div');
    actions.className = 'settings-actions';

    const reset = document.createElement('button');
    reset.type = 'button';
    reset.textContent = 'Reset to defaults';
    reset.addEventListener('click', () => {
      resetSettings();
      this.refresh();
    });

    this.closeButton = document.createElement('button');
    this.closeButton.type = 'button';
    this.closeButton.className = 'primary';
    this.closeButton.textContent = 'Resume';
    this.closeButton.addEventListener('click', () => this.onClose());

    actions.append(reset, this.closeButton);

    // Collapsed by default and out of the tab order of a first-time player's
    // attention: these are convars, and someone who wants them is looking for
    // them. Not a <details> element — the arrow and the open state have to be
    // driven from `O` as well as from a click, and a class is one mechanism
    // rather than two.
    this.advancedToggle = document.createElement('button');
    this.advancedToggle.type = 'button';
    this.advancedToggle.className = 'settings-advanced-toggle';
    this.advancedToggle.addEventListener('click', () => this.setAdvanced(!this.advancedOpen));
    card.appendChild(this.advancedToggle);

    this.advanced = document.createElement('div');
    this.advanced.className = 'settings-advanced hidden';
    // Enemies lives here and only here: it changes what the game *is*, which is
    // what this section is for, and one control over one setting is how the
    // sliders were kept from drifting.
    const advancedGameplay = document.createElement('div');
    advancedGameplay.className = 'settings-advanced-gameplay';
    const advancedHeading = document.createElement('h2');
    advancedHeading.textContent = 'Gameplay';
    advancedGameplay.append(advancedHeading, this.buildSwitch(ENEMIES_SWITCH));
    this.advanced.appendChild(advancedGameplay);

    const advancedVisuals = document.createElement('div');
    advancedVisuals.className = 'settings-advanced-gameplay';
    const visualsHeading = document.createElement('h2');
    visualsHeading.textContent = 'Visuals';
    advancedVisuals.appendChild(visualsHeading);
    for (const spec of VISUAL_SWITCHES) advancedVisuals.appendChild(this.buildSwitch(spec));
    this.advanced.appendChild(advancedVisuals);

    this.advanced.appendChild(this.movementPanel.element);
    card.appendChild(this.advanced);

    // Appended after the advanced block so Reset and Resume stay the last
    // controls on the screen whether or not the section is expanded.
    card.appendChild(actions);

    this.hint = document.createElement('p');
    this.hint.className = 'overlay-hint';
    card.appendChild(this.hint);

    this.setAdvanced(false);
    this.root.appendChild(card);
    document.body.appendChild(this.root);
  }

  private setAdvanced(open: boolean): void {
    this.advancedOpen = open;
    this.advanced.classList.toggle('hidden', !open);
    this.advancedToggle.classList.toggle('is-open', open);
    this.advancedToggle.textContent = open ? '▾  Advanced Settings' : '▸  Advanced Settings';
    if (open) this.movementPanel.refresh();
  }

  /**
   * Every switch on this screen repaints the whole screen when it is flipped,
   * so a control that mirrors another's value can never be left showing a stale
   * one — the "two controls over one value drift apart" trap the sliders were
   * kept out of.
   */
  private buildSwitch(spec: {
    label: string;
    hint: string;
    get: () => boolean;
    set: (on: boolean) => void;
  }): HTMLElement {
    const row = createSwitchRow({
      ...spec,
      set: (on) => {
        spec.set(on);
        this.refresh();
      },
    });
    this.refreshers.push(row.sync);
    return row.element;
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

  /**
   * `exit` names where closing this screen *goes*, not where it was opened
   * from — which are not the same thing and were briefly conflated. Opened from
   * the pause menu it hands back to the pause menu, so "Resume" there would be a
   * lie about what the button does; opened with `O` mid-flight it really does
   * resume. Nothing but the wording changes.
   */
  show(exit: 'resume' | 'back' = 'resume', expandAdvanced = false): void {
    this.closeButton.textContent = exit === 'resume' ? 'Resume' : 'Back';
    this.hint.innerHTML =
      exit === 'resume'
        ? 'Press <kbd>ESC</kbd> to resume'
        : 'Press <kbd>ESC</kbd> to go back';
    if (expandAdvanced) this.setAdvanced(true);
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
