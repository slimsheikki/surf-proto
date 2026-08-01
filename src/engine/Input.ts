const MOUSE_SENSITIVITY = 0.0022;

/**
 * Keys the game consumes. Their browser defaults are suppressed so Space
 * neither scrolls the page nor activates a focused <button> (the upgrade-choice
 * and restart buttons), and WASD never triggers scroll/quick-find.
 */
const GAME_KEY_CODES = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'Space', 'KeyV']);

/** Never steal keys from real text entry — that would break normal page behaviour. */
function isTextEntryTarget(target: EventTarget | null): boolean {
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
}

export class InputSystem {
  private keys = new Set<string>();
  private pendingYawDelta = 0;
  private pendingPitchDelta = 0;
  private cameraToggleQueued = false;
  private locked = false;

  constructor(private readonly canvas: HTMLCanvasElement) {
    window.addEventListener('keydown', (e) => {
      if (isTextEntryTarget(e.target)) return;
      this.keys.add(e.code);
      // e.repeat filters the browser's auto-repeat storm: without it, holding V
      // queued a camera toggle every repeat and flickered first/third person.
      if (e.code === 'KeyV' && !e.repeat) this.cameraToggleQueued = true;
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
  }

  requestPointerLock(): void {
    this.canvas.requestPointerLock();
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
    };

    this.pendingYawDelta = 0;
    this.pendingPitchDelta = 0;
    this.cameraToggleQueued = false;

    return frame;
  }
}
