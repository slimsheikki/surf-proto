import { getSettings, setCountdownOnResume } from '../game/Settings';

/**
 * The "3-2-1 countdown on resume" tickbox that sits on the power screens.
 *
 * Deliberately not an `<input type="checkbox">`. Under pointer lock the cursor
 * is hidden and clicks go to the canvas, so a native control on a run screen is
 * a control the player cannot reach — the same trap that once froze the game on
 * its first level-up. The state is drawn as a glyph and toggled by `C`, handled
 * inside the owning menu's existing keydown listener; the click path stays for
 * the case where the lock has been dropped.
 *
 * Holds no state of its own. `Settings` is the single source of truth, so two
 * of these on two overlays can never disagree.
 */
export class CountdownToggle {
  private readonly root: HTMLButtonElement;

  constructor(elementId: string) {
    this.root = document.getElementById(elementId) as HTMLButtonElement;
    this.root.addEventListener('click', () => CountdownToggle.toggle());
    this.render();
  }

  /** Flips the setting for every toggle at once — they all read the same value. */
  static toggle(): void {
    setCountdownOnResume(!getSettings().countdownOnResume);
  }

  render(): void {
    const on = getSettings().countdownOnResume;
    this.root.textContent = `${on ? '☑' : '☐'}  C — 3-2-1 countdown on resume`;
  }
}
