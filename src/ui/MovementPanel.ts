import {
  clearMovementPreferences,
  MovementConfig,
  movementDefault,
  setMovementPreference,
} from '../player/MovementConfig';
import { MOVEMENT_VERSION_LABEL } from '../player/MovementVersion';

/**
 * Live tuning for the CS convars, shown under **Advanced Settings** on the
 * settings screen.
 *
 * It exists because the movement is being judged by feel, by a person, in the
 * deployed build — and the round trip "it feels wrong" -> guess a number ->
 * commit -> wait for Pages -> play again is far too slow to converge on a feel.
 * With this the reviewer can find the number themselves and report it, which
 * turns a vague note into a change request.
 *
 * It is a *content builder*, not a screen: it owns `element` and nothing else —
 * no positioning, no visibility, no pointer-lock handling. All of that belongs
 * to whatever hosts it, which is `SettingsPanel`. It used to be a floating
 * panel of its own on `O`, and having two independent screens that both
 * released the pointer lock and both paused the sim was two of everything to
 * keep in agreement. `O` still works — it now opens Settings with this section
 * already expanded.
 *
 * Values set here are *preferences* (`setMovementPreference`): they survive a
 * run reset, which reverts the config so a level-up buff cannot compound across
 * restarts. Without that, every death would silently undo the setting the
 * player is halfway through evaluating.
 */

type Field =
  | { kind: 'range'; key: NumericKey; label: string; min: number; max: number; step: number; hu?: (v: number) => string; help: string }
  | { kind: 'toggle'; key: BooleanKey; label: string; help: string };

type NumericKey = {
  [K in keyof typeof MovementConfig]: (typeof MovementConfig)[K] extends number ? K : never;
}[keyof typeof MovementConfig];

type BooleanKey = {
  [K in keyof typeof MovementConfig]: (typeof MovementConfig)[K] extends boolean ? K : never;
}[keyof typeof MovementConfig];

const hu = (perUnit: number) => (v: number) => `${Math.round(v * perUnit)} hu`;

const FIELDS: Field[] = [
  // Sensitivity is deliberately NOT here any more. It moved to the Escape
  // settings screen, which is where a player looks for it — and two sliders
  // over one number is how they drift apart.
  {
    kind: 'range',
    key: 'AIR_ACCEL',
    label: 'sv_airaccelerate',
    min: 5,
    max: 200,
    step: 5,
    help: 'CS:S ships 10; surf servers run 100. Above ~13 the 30 hu cap is what limits gain, not this.',
  },
  {
    kind: 'range',
    key: 'MAX_AIR_WISH_SPEED',
    label: 'air speed cap',
    min: 0.2,
    max: 1.5,
    step: 0.01,
    hu: hu(45),
    help: "Source's hard-coded 30 hu clamp on air wishspeed. This is the ceiling on gain per tick.",
  },
  {
    kind: 'range',
    key: 'GROUND_ACCEL',
    label: 'sv_accelerate',
    min: 1,
    max: 20,
    step: 0.5,
    help: 'CS:S 5. Ground only — irrelevant once you are on a ramp.',
  },
  {
    kind: 'range',
    key: 'FRICTION',
    label: 'sv_friction',
    min: 0,
    max: 12,
    step: 0.25,
    help: 'CS:S 4. Only paid on ticks you are grounded and not jumping.',
  },
  {
    kind: 'range',
    key: 'MAX_GROUND_SPEED',
    label: 'sv_maxspeed',
    min: 3,
    max: 12,
    step: 0.1,
    hu: hu(45),
    help: 'Also the wishspeed both accelerators scale their magnitude off.',
  },
  {
    kind: 'range',
    key: 'JUMP_SPEED',
    label: 'jump speed',
    min: 3,
    max: 12,
    step: 0.05,
    hu: hu(45),
    help: '301.99 hu is sqrt(2 x 800 x 57), the canonical Source jump.',
  },
  {
    kind: 'range',
    key: 'GRAVITY',
    label: 'sv_gravity',
    min: -40,
    max: -5,
    step: 0.2,
    hu: hu(-45),
    help: 'Negative here. -800 hu is CS.',
  },
  {
    kind: 'toggle',
    key: 'AUTO_BHOP',
    label: 'auto bhop',
    help: 'Off = vanilla CS:S, where holding jump does nothing after the first hop.',
  },
  {
    kind: 'toggle',
    key: 'SURF_LANDING_REDIRECT',
    label: 'landing redirect',
    help: 'Off = CS:S. On = this project’s house rule that keeps speed when you drop onto a ramp.',
  },
];

export class MovementPanel {
  /** The content, for a host to place. Never parented or shown by this class. */
  readonly element: HTMLDivElement;

  private readonly rows: (() => void)[] = [];

  constructor() {
    this.element = document.createElement('div');
    this.element.id = 'movement-panel';

    const heading = document.createElement('h2');
    heading.textContent = MOVEMENT_VERSION_LABEL;
    this.element.appendChild(heading);

    const note = document.createElement('p');
    note.className = 'movement-panel-note';
    note.textContent =
      'Every slider is a CS convar, with the Hammer-unit value alongside. These survive a restart.';
    this.element.appendChild(note);

    for (const field of FIELDS) {
      this.element.appendChild(
        field.kind === 'range' ? this.buildRange(field) : this.buildToggle(field),
      );
    }

    const reset = document.createElement('button');
    reset.type = 'button';
    reset.className = 'movement-panel-reset';
    reset.textContent = 'Reset to shipped defaults';
    reset.addEventListener('click', () => {
      clearMovementPreferences();
      this.refresh();
    });
    this.element.appendChild(reset);
  }

  private buildRange(field: Extract<Field, { kind: 'range' }>): HTMLElement {
    const row = document.createElement('label');
    row.className = 'movement-panel-row';
    row.title = field.help;

    const name = document.createElement('span');
    name.className = 'movement-panel-name';
    name.textContent = field.label;

    const value = document.createElement('span');
    value.className = 'movement-panel-value';

    const input = document.createElement('input');
    input.type = 'range';
    input.min = String(field.min);
    input.max = String(field.max);
    input.step = String(field.step);

    const show = () => {
      const v = MovementConfig[field.key];
      value.textContent = field.hu ? `${v.toFixed(2)}  (${field.hu(v)})` : v.toFixed(2);
      value.classList.toggle('is-changed', v !== movementDefault(field.key));
    };
    input.addEventListener('input', () => {
      setMovementPreference(field.key, Number(input.value));
      show();
    });

    this.rows.push(() => {
      input.value = String(MovementConfig[field.key]);
      show();
    });

    row.append(name, value, input);
    return row;
  }

  private buildToggle(field: Extract<Field, { kind: 'toggle' }>): HTMLElement {
    const row = document.createElement('label');
    row.className = 'movement-panel-row movement-panel-row-toggle';
    row.title = field.help;

    const name = document.createElement('span');
    name.className = 'movement-panel-name';
    name.textContent = field.label;

    const input = document.createElement('input');
    input.type = 'checkbox';
    input.addEventListener('change', () => setMovementPreference(field.key, input.checked));

    this.rows.push(() => {
      input.checked = MovementConfig[field.key];
    });

    row.append(name, input);
    return row;
  }

  /** Re-reads every control from the live config. The host calls this on open. */
  refresh(): void {
    for (const row of this.rows) row();
  }
}
