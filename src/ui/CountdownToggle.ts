import { getSettings, setCountdownOnResume } from '../game/Settings';
import { createSwitchIndicator } from './SurfSwitch';

/**
 * The "3-2-1 countdown on resume" switch that sits on the power screens.
 *
 * Deliberately not an `<input type="checkbox">`. Under pointer lock the cursor
 * is hidden and clicks go to the canvas, so a native control on a run screen is
 * a control the player cannot reach — the same trap that once froze the game on
 * its first level-up. The whole row is one button, toggled by `C` inside the
 * owning menu's existing keydown listener; the click path stays for the case
 * where the lock has been dropped.
 *
 * The state used to be drawn as a ☑/☐ glyph. It is now the same `.surf-switch`
 * every other boolean in the game uses — rendered *inside* the button rather
 * than as its own control, so there is still exactly one click target and the
 * key remains the primary way in.
 *
 * Holds no state of its own. `Settings` is the single source of truth, so two
 * of these on two overlays can never disagree.
 */
export class CountdownToggle {
  private readonly root: HTMLButtonElement;
  private readonly knob: HTMLElement;

  constructor(elementId: string) {
    this.root = document.getElementById(elementId) as HTMLButtonElement;
    this.root.classList.add('switch-line');
    this.root.replaceChildren();

    const label = document.createElement('span');
    label.textContent = 'C — 3-2-1 countdown on resume';

    // Inert by construction: the row's own click handler owns the toggle.
    this.knob = createSwitchIndicator('sm');

    this.root.append(label, this.knob);
    // Repaints itself on the click path. The `C` path is repainted by the menu
    // that owns the key handler, and every menu repaints on show, so the other
    // copies are correct the next time they are looked at.
    this.root.addEventListener('click', () => {
      CountdownToggle.toggle();
      this.render();
    });
    this.render();
  }

  /** Flips the setting for every toggle at once — they all read the same value. */
  static toggle(): void {
    setCountdownOnResume(!getSettings().countdownOnResume);
  }

  render(): void {
    this.knob.setAttribute('aria-checked', String(getSettings().countdownOnResume));
  }
}
