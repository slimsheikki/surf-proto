import {
  AmbientLight,
  BufferGeometry,
  DirectionalLight,
  Group,
  Material,
  Mesh,
  PerspectiveCamera,
  Scene,
} from 'three';
import { buildKnifeHand, buildLeftHand, SWING_TIMING } from './KnifeHand';

/* ------------------------------------------------------------------ *
 * Overlay pass
 * ------------------------------------------------------------------ */

/**
 * Narrower than the world camera's 75. A viewmodel sits ~0.5 units from its
 * camera, and at 75 deg that near a box is stretched into an unreadable wedge —
 * CS uses a separate (lower) viewmodel FOV for exactly this reason.
 */
const VIEWMODEL_FOV = 55;
/**
 * The overlay scene contains nothing but the model, all of it within ~1 unit of
 * the camera, so the frustum can be tiny. A tight near plane also keeps the
 * depth range sane for the pass's own `clearDepth()`.
 */
const VIEWMODEL_NEAR = 0.01;
const VIEWMODEL_FAR = 10;

/* ------------------------------------------------------------------ *
 * Rest pose (camera space: -Z is forward, +X right, +Y up)
 * ------------------------------------------------------------------ */

/** Lower-right of frame, knife hand. */
const RIGHT_ARM_BASE = { x: 0.23, y: -0.16, z: -0.53 };
/** Lower-centre-left and further from camera: the off-hand, mostly out of frame. */
const LEFT_ARM_BASE = { x: -0.21, y: -0.3, z: -0.5 };

/* ------------------------------------------------------------------ *
 * Idle motion
 * ------------------------------------------------------------------ */

/**
 * Bob/sway amplitude is scaled by speed/SPEED_FOR_FULL_BOB, so the model
 * settles when the player is slow and works hardest at full surf speed. It
 * never reaches zero — a completely dead viewmodel reads as a bug — but
 * IDLE_MIN_AMPLITUDE keeps the standing pose nearly still.
 */
const SPEED_FOR_FULL_BOB = 40;
const IDLE_MIN_AMPLITUDE = 0.25;
const BOB_RATE_BASE = 3.2;
const BOB_RATE_GAIN = 3.6;
/**
 * Deliberately tiny. This is peripheral motion in the corner of the screen
 * while the player is reading a ramp line at 40 u/s; anything larger competes
 * with the thing they actually need to look at.
 */
const BOB_SWING_X = 0.009;
const BOB_SWING_Y = 0.007;
const BOB_ROLL = 0.03;

/**
 * Mouse sway. `yawDelta` is radians per fixed tick, so it is divided by dt to
 * get a rate before scaling — otherwise the sway would silently depend on the
 * tick rate. The result is clamped and then smoothed, which is what gives the
 * model its sense of weight: it lags the turn and settles after it.
 */
const SWAY_PER_RAD_PER_SEC = 0.011;
const SWAY_LIMIT = 0.055;
const SWAY_SMOOTHING = 11;
/** Vertical sway from pitch is half-weighted; looking up/down moves less mass. */
const SWAY_PITCH_SCALE = 0.5;

/* ------------------------------------------------------------------ *
 * Dash kick
 * ------------------------------------------------------------------ */

/**
 * A single decaying pose, not a phase machine like the slash: both hands
 * briefly brace back and down as if bracing against the sudden speed, then
 * ease back to the idle pose. The dash's own shove
 * (`PlayerController.dashImpulse()`) lands in a single tick, so this window is
 * the follow-through on that push rather than an unrelated flourish.
 */
const DASH_KICK_DURATION = 0.3;
const DASH_KICK_POS = { x: 0, y: -0.035, z: 0.05 };
const DASH_KICK_ROT = { x: -0.1, y: 0, z: 0.04 };

/* ------------------------------------------------------------------ *
 * Slash animation
 * ------------------------------------------------------------------ */

const { WINDUP_SECONDS, SLASH_SECONDS, RECOVER_SECONDS } = SWING_TIMING;

/**
 * Cocked up and to the right, blade rotated toward vertical. Deliberately
 * restrained on Z: this close to the lens, pulling the fist a few more
 * centimetres toward the camera magnifies it into a wall that fills the corner
 * and hides the blade, so the read of the wind-up comes from rotation.
 *
 * Sign notes, because they are not guessable: +rotation.z turns the model
 * counter-clockwise on screen, and the blade sits at roughly 160 deg (up and to
 * the left) at rest. So the wind-up rolls NEGATIVE (clockwise, lifting the tip
 * toward vertical) and the slash rolls POSITIVE through and past the rest angle,
 * dropping the tip below horizontal — a right-to-left downward diagonal.
 */
const WINDUP_POS = { x: 0.05, y: 0.075, z: 0.035 };
const WINDUP_ROT = { x: 0.2, y: -0.2, z: -0.5 };
/**
 * Follow-through: down and across to the left, tip below horizontal. Kept short
 * of the frame edge on purpose — a follow-through that carries the model right
 * out of view reads as the knife disappearing rather than as a swing.
 */
const SLASH_POS = { x: -0.24, y: -0.07, z: -0.04 };
const SLASH_ROT = { x: -0.25, y: 0.5, z: 0.6 };

type SlashPhase = 'idle' | 'windup' | 'slash' | 'recover';

function easeOutQuad(t: number): number {
  return 1 - (1 - t) * (1 - t);
}

/**
 * Fast out of the gate and decelerating hard — this is what makes the swing
 * snap. A linear sweep across the same distance in the same 0.1 s reads as the
 * knife being *carried* across the frame rather than swung.
 */
function easeOutCubic(t: number): number {
  const inv = 1 - t;
  return 1 - inv * inv * inv;
}

function easeInOutQuad(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - 2 * (1 - t) * (1 - t);
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * First-person knife viewmodel: a crude greybox of two gloved fists and a
 * combat knife, rendered in its OWN scene and camera.
 *
 * The separate scene is the whole point. A viewmodel drawn into the world scene
 * is subject to world depth, so the instant the player's eye passes within half
 * a metre of a ramp face the knife is sliced in half by it — which happens
 * constantly on a surf map, where you ride with your shoulder against the
 * geometry. Drawing this pass afterwards over a cleared depth buffer means the
 * model composites on top unconditionally and can never intersect the level.
 *
 * This class owns no game logic: `Game` drives `update`/`triggerSlash` on the
 * fixed timestep, and `main.ts` owns the render pass and visibility.
 */
export class ViewModel {
  readonly scene = new Scene();
  readonly camera = new PerspectiveCamera(
    VIEWMODEL_FOV,
    window.innerWidth / window.innerHeight,
    VIEWMODEL_NEAR,
    VIEWMODEL_FAR,
  );

  /** Both hands. Carries the idle bob so the whole model breathes together. */
  private readonly root = new Group();
  /** Right fist + knife. Carries the slash, so the off-hand stays put. */
  private readonly arm = new Group();

  private bobTime = 0;
  private swayX = 0;
  private swayY = 0;
  private dashKickTimer = 0;

  private phase: SlashPhase = 'idle';
  private phaseTime = 0;
  /** At most one buffered follow-up swing; further clicks are dropped. */
  private queuedSlash = false;

  constructor() {
    // The overlay scene has no background, so the main pass shows through.
    // Lit brighter than the world: the gloves are near-black by spec, and at
    // world light levels they disappear into any shadowed ramp behind them.
    this.scene.add(new AmbientLight(0xffffff, 1.1));
    const key = new DirectionalLight(0xffffff, 2.3);
    key.position.set(0.6, 1, 0.7);
    this.scene.add(key);
    // Cold fill from the left keeps the blade's left face from going black,
    // which is what actually makes it read as steel rather than as a dark box.
    const fill = new DirectionalLight(0xaecbe8, 0.6);
    fill.position.set(-0.8, 0.2, 0.4);
    this.scene.add(fill);

    this.arm.position.set(RIGHT_ARM_BASE.x, RIGHT_ARM_BASE.y, RIGHT_ARM_BASE.z);
    this.arm.add(buildKnifeHand());

    const leftHand = buildLeftHand();
    leftHand.position.set(LEFT_ARM_BASE.x, LEFT_ARM_BASE.y, LEFT_ARM_BASE.z);

    this.root.add(this.arm);
    this.root.add(leftHand);
    this.scene.add(this.root);
  }

  /** Re-arms the dash brace pose; a dash mid-brace just restarts the timer. */
  triggerDash(): void {
    this.dashKickTimer = DASH_KICK_DURATION;
  }

  /** Queues a swing. During an active swing at most one follow-up is buffered. */
  triggerSlash(): void {
    if (this.phase === 'idle') {
      this.phase = 'windup';
      this.phaseTime = 0;
    } else {
      this.queuedSlash = true;
    }
  }

  /**
   * @param dt fixed simulation step, never wall-clock.
   * @param speed player horizontal speed, u/s.
   * @param yawDelta radians of yaw applied this tick.
   * @param pitchDelta radians of pitch applied this tick.
   */
  update(dt: number, speed: number, yawDelta: number, pitchDelta: number): void {
    this.updateIdle(dt, speed, yawDelta, pitchDelta);
    this.updateSlash(dt);
  }

  private updateIdle(dt: number, speed: number, yawDelta: number, pitchDelta: number): void {
    const speedFactor = Math.min(1, Math.max(0, speed / SPEED_FOR_FULL_BOB));
    const amplitude = IDLE_MIN_AMPLITUDE + (1 - IDLE_MIN_AMPLITUDE) * speedFactor;

    this.bobTime += dt * (BOB_RATE_BASE + BOB_RATE_GAIN * speedFactor);

    const yawRate = dt > 0 ? yawDelta / dt : 0;
    const pitchRate = dt > 0 ? pitchDelta / dt : 0;
    // Opposing the turn: swing the mouse right (negative yawDelta by this
    // codebase's convention) and the model lags to the right of frame.
    const targetSwayX = clampAbs(-yawRate * SWAY_PER_RAD_PER_SEC, SWAY_LIMIT);
    const targetSwayY = clampAbs(
      -pitchRate * SWAY_PER_RAD_PER_SEC * SWAY_PITCH_SCALE,
      SWAY_LIMIT * SWAY_PITCH_SCALE,
    );
    const blend = 1 - Math.exp(-dt * SWAY_SMOOTHING);
    this.swayX += (targetSwayX - this.swayX) * blend;
    this.swayY += (targetSwayY - this.swayY) * blend;

    let dashPX = 0;
    let dashPY = 0;
    let dashPZ = 0;
    let dashRX = 0;
    let dashRY = 0;
    let dashRZ = 0;
    if (this.dashKickTimer > 0) {
      this.dashKickTimer = Math.max(this.dashKickTimer - dt, 0);
      const e = easeOutQuad(this.dashKickTimer / DASH_KICK_DURATION);
      dashPX = DASH_KICK_POS.x * e;
      dashPY = DASH_KICK_POS.y * e;
      dashPZ = DASH_KICK_POS.z * e;
      dashRX = DASH_KICK_ROT.x * e;
      dashRY = DASH_KICK_ROT.y * e;
      dashRZ = DASH_KICK_ROT.z * e;
    }

    this.root.position.set(
      Math.sin(this.bobTime) * BOB_SWING_X * amplitude + this.swayX + dashPX,
      Math.sin(this.bobTime * 2) * BOB_SWING_Y * amplitude + this.swayY + dashPY,
      dashPZ,
    );
    this.root.rotation.set(
      -this.swayY * 1.2 + dashRX,
      this.swayX * 1.2 + dashRY,
      Math.sin(this.bobTime) * BOB_ROLL * amplitude - this.swayX * 2.5 + dashRZ,
    );
  }

  private updateSlash(dt: number): void {
    if (this.phase !== 'idle') this.phaseTime += dt;

    let px = 0;
    let py = 0;
    let pz = 0;
    let rx = 0;
    let ry = 0;
    let rz = 0;

    switch (this.phase) {
      case 'windup': {
        const t = Math.min(1, this.phaseTime / WINDUP_SECONDS);
        const e = easeOutQuad(t);
        px = WINDUP_POS.x * e;
        py = WINDUP_POS.y * e;
        pz = WINDUP_POS.z * e;
        rx = WINDUP_ROT.x * e;
        ry = WINDUP_ROT.y * e;
        rz = WINDUP_ROT.z * e;
        if (t >= 1) this.advancePhase('slash');
        break;
      }
      case 'slash': {
        const t = Math.min(1, this.phaseTime / SLASH_SECONDS);
        const e = easeOutCubic(t);
        px = lerp(WINDUP_POS.x, SLASH_POS.x, e);
        py = lerp(WINDUP_POS.y, SLASH_POS.y, e);
        pz = lerp(WINDUP_POS.z, SLASH_POS.z, e);
        rx = lerp(WINDUP_ROT.x, SLASH_ROT.x, e);
        ry = lerp(WINDUP_ROT.y, SLASH_ROT.y, e);
        rz = lerp(WINDUP_ROT.z, SLASH_ROT.z, e);
        if (t >= 1) this.advancePhase('recover');
        break;
      }
      case 'recover': {
        const t = Math.min(1, this.phaseTime / RECOVER_SECONDS);
        const e = easeInOutQuad(t);
        px = SLASH_POS.x * (1 - e);
        py = SLASH_POS.y * (1 - e);
        pz = SLASH_POS.z * (1 - e);
        rx = SLASH_ROT.x * (1 - e);
        ry = SLASH_ROT.y * (1 - e);
        rz = SLASH_ROT.z * (1 - e);
        if (t >= 1) {
          this.phase = 'idle';
          this.phaseTime = 0;
          if (this.queuedSlash) {
            this.queuedSlash = false;
            this.phase = 'windup';
          }
        }
        break;
      }
      case 'idle':
        break;
    }

    this.arm.position.set(
      RIGHT_ARM_BASE.x + px,
      RIGHT_ARM_BASE.y + py,
      RIGHT_ARM_BASE.z + pz,
    );
    this.arm.rotation.set(rx, ry, rz);
  }

  /** Carries the overshoot into the next phase so a long tick can't stall one. */
  private advancePhase(next: SlashPhase): void {
    const spent = next === 'slash' ? WINDUP_SECONDS : SLASH_SECONDS;
    this.phaseTime -= spent;
    this.phase = next;
  }

  /** True while a swing is playing; exposed for tests and debugging. */
  get isSwinging(): boolean {
    return this.phase !== 'idle';
  }

  resize(width: number, height: number): void {
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  /** Drops any in-flight swing and re-centres the model. Used on restart. */
  reset(): void {
    this.phase = 'idle';
    this.phaseTime = 0;
    this.queuedSlash = false;
    this.swayX = 0;
    this.swayY = 0;
    this.dashKickTimer = 0;
    this.arm.position.set(RIGHT_ARM_BASE.x, RIGHT_ARM_BASE.y, RIGHT_ARM_BASE.z);
    this.arm.rotation.set(0, 0, 0);
  }

  dispose(): void {
    this.scene.traverse((object) => {
      if (!(object instanceof Mesh)) return;
      (object.geometry as BufferGeometry).dispose();
      (object.material as Material).dispose();
    });
  }
}

function clampAbs(value: number, limit: number): number {
  return Math.min(limit, Math.max(-limit, value));
}
