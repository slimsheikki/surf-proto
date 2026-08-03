import { MovementConfig } from '../player/MovementConfig';

/**
 * Radians of view rotation per mouse count, the CS way: `m_yaw` is 0.022
 * degrees per count and the player's `sensitivity` multiplies it. Browsers
 * report `movementX` in CSS pixels under pointer lock, which tracks raw mouse
 * counts closely enough that a surfer's own sensitivity number means roughly
 * what they expect it to mean.
 *
 * The previous constant was a bare 0.0022 rad/count, i.e. a fixed CS
 * sensitivity of about 5.7 with no way to change it. Sensitivity is not a
 * cosmetic setting for surf — the whole skill is sweeping the view at a rate
 * matched to your speed, and a player evaluating strafe feel on the wrong
 * sensitivity is evaluating the wrong thing.
 */
const M_YAW_RADIANS = (0.022 * Math.PI) / 180;

/**
 * Keys the game consumes. Their browser defaults are suppressed so Space
 * neither scrolls the page nor activates a focused <button> (the upgrade-choice
 * and restart buttons), and WASD never triggers scroll/quick-find.
 */
const GAME_KEY_CODES = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'Space', 'KeyV']);

/**
 * Never steal keys from real text entry — that would break normal page
 * behaviour.
 *
 * Exported because the editor needs exactly the same rule: it has its own
 * global keydown handler driving the fly camera, and any text field the editor
 * grows has to be invisible to it too. One definition, so a field type can't be
 * covered here and missed there.
 */
export function isTextEntryTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

export interface InputFrame {
  moveForward: number; // -1..1
  moveRight: number; // -1..1
  jumpHeld: boolean;
  yawDelta: number;
  pitchDelta: number;
  cameraTogglePressed: boolean;
  /** Edge-triggered: true on the single frame a left click was pressed. */
  attackPressed: boolean;
  /** Edge-triggered: true on the single frame Shift was pressed. */
  dashPressed: boolean;
}

export class InputSystem {
  private keys = new Set<string>();
  private pendingYawDelta = 0;
  private pendingPitchDelta = 0;
  private cameraToggleQueued = false;
  private attackQueued = false;
  private dashQueued = false;
  private locked = false;
  /** Ticks left in the current rendered frame; see `beginFrame`. */
  private stepsRemaining = 1;

  constructor(private readonly canvas: HTMLCanvasElement) {
    window.addEventListener('keydown', (e) => {
      if (isTextEntryTarget(e.target)) return;
      this.keys.add(e.code);
      // e.repeat filters the browser's auto-repeat storm: without it, holding V
      // queued a camera toggle every repeat and flickered first/third person.
      if (e.code === 'KeyV' && !e.repeat) this.cameraToggleQueued = true;
      if ((e.code === 'ShiftLeft' || e.code === 'ShiftRight') && !e.repeat) this.dashQueued = true;
      if (GAME_KEY_CODES.has(e.code)) e.preventDefault();
    });
    window.addEventListener('keyup', (e) => {
      if (isTextEntryTarget(e.target)) return;
      this.keys.delete(e.code);
      // Button activation by Space fires on keyup, so suppress that too.
      if (GAME_KEY_CODES.has(e.code)) e.preventDefault();
    });
    // Losing focus mid-hold would otherwise leave the key latched forever.
    window.addEventListener('blur', () => this.keys.clear());

    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === this.canvas;
      if (!this.locked) this.keys.clear();
    });

    window.addEventListener('mousemove', (e) => {
      if (!this.locked) return;
      const scale = M_YAW_RADIANS * MovementConfig.SENSITIVITY;
      this.pendingYawDelta -= e.movementX * scale;
      this.pendingPitchDelta -= e.movementY * scale;
    });

    window.addEventListener('mousedown', (e) => {
      // Gated on pointer lock so the click that *acquires* the lock — the one
      // that dismisses the start overlay, or reclaims control after a menu —
      // isn't also read as a swing. It is a UI click, not an attack.
      if (!this.locked || e.button !== 0) return;
      this.attackQueued = true;
    });
  }

  requestPointerLock(): void {
    this.canvas.requestPointerLock();
  }

  /**
   * Hands the cursor back. Required whenever a menu with clickable buttons opens:
   * while the pointer is locked the cursor is hidden and every click is delivered
   * to the canvas, so on-screen buttons cannot be pressed at all.
   */
  releasePointerLock(): void {
    if (document.pointerLockElement) document.exitPointerLock();
  }

  isLocked(): boolean {
    return this.locked;
  }

  /**
   * Announces how many sim ticks this rendered frame is about to run, so
   * `consumeFrame` can hand each of them an equal share of the frame's mouse
   * motion rather than giving the first tick all of it.
   *
   * Mouse events only arrive between frames. At 60 fps against a 128 Hz sim
   * that is two ticks per frame, and dumping the whole turn into the first one
   * leaves the second with a stale view angle — a tick that pays out no
   * air-strafe gain, because gain is capped by how far the view has turned
   * away from current velocity. Splitting it evenly is what a CS client does
   * when it builds one usercmd per tick.
   */
  beginFrame(steps: number): void {
    this.stepsRemaining = Math.max(1, steps);
  }

  /** Drains this tick's share of the accumulated mouse/toggle deltas. */
  consumeFrame(): InputFrame {
    let moveForward = 0;
    let moveRight = 0;
    if (this.keys.has('KeyW')) moveForward += 1;
    if (this.keys.has('KeyS')) moveForward -= 1;
    if (this.keys.has('KeyD')) moveRight += 1;
    if (this.keys.has('KeyA')) moveRight -= 1;

    // Subtracting the share rather than dividing down to zero leaves any
    // rounding remainder in the accumulator, so a frame's total view rotation
    // is exactly preserved across its ticks.
    const share = this.stepsRemaining;
    const yawDelta = this.pendingYawDelta / share;
    const pitchDelta = this.pendingPitchDelta / share;
    this.stepsRemaining = Math.max(1, share - 1);

    const frame: InputFrame = {
      moveForward,
      moveRight,
      jumpHeld: this.keys.has('Space'),
      yawDelta,
      pitchDelta,
      cameraTogglePressed: this.cameraToggleQueued,
      attackPressed: this.attackQueued,
      dashPressed: this.dashQueued,
    };

    this.pendingYawDelta -= yawDelta;
    this.pendingPitchDelta -= pitchDelta;
    this.cameraToggleQueued = false;
    this.attackQueued = false;
    this.dashQueued = false;

    return frame;
  }
}
