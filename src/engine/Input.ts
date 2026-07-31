const MOUSE_SENSITIVITY = 0.0022;

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
      this.keys.add(e.code);
      if (e.code === 'KeyV') this.cameraToggleQueued = true;
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));

    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === this.canvas;
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
