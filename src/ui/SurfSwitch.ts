/**
 * The one on/off control in this game.
 *
 * Every boolean setting is drawn with the same iOS-shaped switch the map
 * picker's Beginner/Advanced mode row uses (`.surf-switch` in `styles.css`) —
 * previously the same question was asked three different ways on three screens:
 * a native checkbox on the convar bench, a button whose *label* flipped
 * ("Mute music" / "Unmute music"), and a ☑/☐ glyph on the power screens. A
 * label that flips says what pressing it would do; a switch says what the
 * setting *is*, which is the thing a player is actually scanning for.
 *
 * It holds no state. `get` is read on every `sync()`, so two switches over one
 * setting on two screens can never disagree — the same contract `CountdownToggle`
 * has always had.
 */

export interface SwitchSpec {
  label: string;
  /** Sits under the label in small type. Optional — the convar bench uses tooltips instead. */
  hint?: string;
  get: () => boolean;
  set: (on: boolean) => void;
  /** `sm` is the compact track used inside a row that is already a button. */
  size?: 'md' | 'sm';
}

export interface SwitchRow {
  element: HTMLElement;
  /** Re-reads the setting and repaints. Hosts call this when they open. */
  sync: () => void;
}

/** The bare switch button, for a host that owns its own row layout. */
export function createSwitchButton(size: 'md' | 'sm' = 'md'): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = size === 'sm' ? 'surf-switch surf-switch-sm' : 'surf-switch';
  button.setAttribute('role', 'switch');
  button.setAttribute('aria-checked', 'false');
  return button;
}

/**
 * The same track and knob as a non-interactive element, for a host that is
 * already one button end to end (`CountdownToggle`). A `<button>` nested in a
 * button is invalid markup and would take the click twice.
 */
export function createSwitchIndicator(size: 'md' | 'sm' = 'md'): HTMLSpanElement {
  const span = document.createElement('span');
  span.className = size === 'sm' ? 'surf-switch surf-switch-sm' : 'surf-switch';
  span.setAttribute('aria-hidden', 'true');
  span.setAttribute('aria-checked', 'false');
  return span;
}

/** A labelled row: name (and hint) on the left, switch on the right. */
export function createSwitchRow(spec: SwitchSpec): SwitchRow {
  const row = document.createElement('div');
  row.className = 'switch-row';

  const text = document.createElement('div');
  text.className = 'switch-text';

  const label = document.createElement('span');
  label.className = 'switch-label';
  label.textContent = spec.label;
  text.appendChild(label);

  if (spec.hint) {
    const hint = document.createElement('p');
    hint.className = 'switch-hint';
    hint.textContent = spec.hint;
    text.appendChild(hint);
  }

  const button = createSwitchButton(spec.size);
  button.setAttribute('aria-label', spec.label);

  const sync = () => button.setAttribute('aria-checked', String(spec.get()));
  button.addEventListener('click', () => {
    spec.set(!spec.get());
    sync();
  });
  sync();

  row.append(text, button);
  return { element: row, sync };
}
