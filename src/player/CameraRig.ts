import { PerspectiveCamera, Vector3 } from 'three';
import { PlayerController } from './PlayerController';

const EYE_HEIGHT = 1.6;
const THIRD_PERSON_DISTANCE = 5;
const THIRD_PERSON_HEIGHT = 1.5;

export type CameraMode = 'first' | 'third';

/**
 * Look direction for a given yaw/pitch, in the *same* convention the rest of the
 * movement code uses: forward at yaw 0 is -Z, and increasing yaw swings toward
 * -X. Equivalent to `(0,0,-1).applyAxisAngle(UP, yaw)` with pitch applied, and
 * to where `camera.rotation.set(pitch, yaw, 0, 'YXZ')` actually points.
 *
 * The X term is negative, and that sign matters. This previously read
 * `+sin(yaw)`, which is mirrored about the X axis and therefore agrees with the
 * real facing only at yaw 0 and 180. It went unnoticed because the old course was
 * a straight run spawning at yaw 0; on a circular track the yaw sweeps through
 * every heading, and a mirrored look vector puts the third-person camera on the
 * wrong side of the player for three quarters of the loop.
 */
function lookDirFromAngles(yaw: number, pitch: number): Vector3 {
  return new Vector3(
    -Math.sin(yaw) * Math.cos(pitch),
    Math.sin(pitch),
    -Math.cos(yaw) * Math.cos(pitch),
  ).normalize();
}

/**
 * Renders the player's yaw/pitch from either a first-person eye position or
 * a third-person over-the-shoulder offset. Movement math never reads camera
 * state — this class only ever reads FROM the controller, never writes to it.
 */
export class CameraRig {
  mode: CameraMode = 'first';

  constructor(private readonly camera: PerspectiveCamera) {}

  toggle(): void {
    this.mode = this.mode === 'first' ? 'third' : 'first';
  }

  update(controller: PlayerController): void {
    const { yaw, pitch } = controller;
    const eyePosition = controller.position.clone().add(new Vector3(0, EYE_HEIGHT, 0));
    const lookDir = lookDirFromAngles(yaw, pitch);

    if (this.mode === 'first') {
      this.camera.position.copy(eyePosition);
    } else {
      this.camera.position
        .copy(eyePosition)
        .addScaledVector(lookDir, -THIRD_PERSON_DISTANCE)
        .add(new Vector3(0, THIRD_PERSON_HEIGHT, 0));
    }

    this.camera.rotation.set(pitch, yaw, 0, 'YXZ');
  }
}
