const MOUSE_SENSITIVITY = 0.0022;

/**
 * Keys the game consumes. Their browser defaults are suppressed so Space
 * neither scrolls the page nor activates a focused <button> (the upgrade-choice
 * and restart buttons), and WASD never triggers scroll/quick-find.
 */
const GAME_KEY_CODES = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'Space', 'KeyV', 'KeyE']);

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
  /** Edge-triggered: true on the single frame E was pressed — spends a banked blessing. */
  interactPressed: boolean;
}

export class InputSystem {
  private keys = new Set<string>();
  private pendingYawDelta = 0;
  private pendingPitchDelta = 0;
  private cameraToggleQueued = false;
  private attackQueued = false;
  private dashQueued = false;
  private interactQueued = false;
  private locked = false;

  constructor(private readonly canvas: HTMLCanvasElement) {
    window.addEventListener('keydown', (e) => {
      if (isTextEntryTarget(e.target)) return;
      this.keys.add(e.code);
      // e.repeat filters the browser's auto-repeat storm: without it, holding V
      // queued a camera toggle every repeat and flickered first/third person.
      if (e.code === 'KeyV' && !e.repeat) this.cameraToggleQueued = true;
      if ((e.code === 'ShiftLeft' || e.code === 'ShiftRight') && !e.repeat) this.dashQueued = true;
      if (e.code === 'KeyE' && !e.repeat) this.interactQueued = true;
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
      this.pendingYawDelta -= e.movementX * MOUSE_SENSITIVITY;
      this.pendingPitchDelta -= e.movementY * MOUSE_SENSITIVITY;
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

  /** Drains accumulated mouse/toggle deltas into a single tick's input frame. */
  consumeFrame(): InputFrame {
    let moveForward = 0;
    let moveRight = 0;
    if (this.keys.has('KeyW')) moveForward += 1;
    if (this.keys.has('KeyS')) moveForward -= 1;
    if (this.keys.has('KeyD')) moveRight += 1;
    if (this.keys.has('KeyA')) moveRight -= 1;

    const frame: InputFrame = {
      moveForward,
      moveRight,
      jumpHeld: this.keys.has('Space'),
      yawDelta: this.pendingYawDelta,
      pitchDelta: this.pendingPitchDelta,
      cameraTogglePressed: this.cameraToggleQueued,
      attackPressed: this.attackQueued,
      dashPressed: this.dashQueued,
      interactPressed: this.interactQueued,
    };

    this.pendingYawDelta = 0;
    this.pendingPitchDelta = 0;
    this.cameraToggleQueued = false;
    this.attackQueued = false;
    this.dashQueued = false;
    this.interactQueued = false;

    return frame;
  }
}
