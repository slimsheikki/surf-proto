import {
  AmbientLight,
  BoxGeometry,
  BufferGeometry,
  DirectionalLight,
  ExtrudeGeometry,
  Group,
  Material,
  Mesh,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  PerspectiveCamera,
  Scene,
  Shape,
  SphereGeometry,
} from 'three';

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
 * Palette
 * ------------------------------------------------------------------ */

const GLOVE_COLOR = 0x33383f;
const CUFF_COLOR = 0x4a515a;
const BLADE_COLOR = 0xd2d8de;
const GUARD_COLOR = 0x2a2f36;
const HANDLE_COLOR = 0x24282e;
const POMMEL_COLOR = 0x5a616b;
const GRIP_RIDGE_COLOR = 0x14171b;

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
 * Slash animation
 * ------------------------------------------------------------------ */

const WINDUP_SECONDS = 0.06;
const SLASH_SECONDS = 0.1;
const RECOVER_SECONDS = 0.09;

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

function box(
  width: number,
  height: number,
  depth: number,
  color: number,
  metalness = 0.15,
  roughness = 0.8,
): Mesh {
  return new Mesh(
    new BoxGeometry(width, height, depth),
    new MeshStandardMaterial({ color, metalness, roughness }),
  );
}

/** Like `box`, but clearcoated -- for the polished-metal fittings (guard, pommel). */
function physicalBox(
  width: number,
  height: number,
  depth: number,
  color: number,
  metalness: number,
  roughness: number,
  clearcoat: number,
): Mesh {
  return new Mesh(
    new BoxGeometry(width, height, depth),
    new MeshPhysicalMaterial({ color, metalness, roughness, clearcoat, clearcoatRoughness: 0.12 }),
  );
}

/**
 * Drop-point blade silhouette: a straight ricasso at the guard, an edge that
 * bellies out and sweeps up, a spine that stays flat until it eases down to
 * meet the point near the spine line. Built as a flat 2D outline in (length,
 * width) and extruded for thickness, since that is the natural plane for a
 * blade profile -- the extrude's depth axis becomes the thickness.
 *
 * `rotateY(90deg)` afterwards swaps that thickness onto local X and the
 * length onto local Z: for a point (x, y, z) the rotation gives
 * (x', y', z') = (z, y, -x), so the shape's length axis (x, running 0..L from
 * guard to tip) lands on z' running 0..-L -- tip at negative Z, matching
 * where the rest of this file already expects the blade to point.
 */
function buildBladeGeometry(length: number, baseWidth: number, thickness: number): BufferGeometry {
  const hw = baseWidth / 2;
  const shape = new Shape();
  shape.moveTo(0, hw);
  shape.lineTo(0, -hw);
  shape.lineTo(length * 0.6, -hw * 0.55);
  shape.lineTo(length, hw * 0.05);
  shape.lineTo(length * 0.82, hw * 0.9);
  shape.closePath();

  const geometry = new ExtrudeGeometry(shape, { depth: thickness, bevelEnabled: false });
  geometry.rotateY(Math.PI / 2);
  // Centers thickness on X=0 and shifts the base off the knife group's origin
  // to just past the guard, matching the old box blade's -0.128-centred span.
  geometry.translate(-thickness / 2, -hw * 0.05, -0.01);
  return geometry;
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
    this.arm.add(this.buildRightHand());
    this.arm.add(this.buildKnife());

    const leftHand = this.buildLeftHand();
    leftHand.position.set(LEFT_ARM_BASE.x, LEFT_ARM_BASE.y, LEFT_ARM_BASE.z);

    this.root.add(this.arm);
    this.root.add(leftHand);
    this.scene.add(this.root);
  }

  /** Blocky gloved fist, angled inward as if closed around the grip. */
  private buildRightHand(): Group {
    const hand = new Group();
    const fist = box(0.085, 0.085, 0.11, GLOVE_COLOR);
    fist.position.set(0, 0, 0.03);
    const cuff = box(0.075, 0.078, 0.05, CUFF_COLOR);
    cuff.position.set(0.004, -0.006, 0.115);
    hand.add(fist, cuff);
    hand.rotation.set(0.1, -0.28, 0.18);
    return hand;
  }

  /** Off-hand: lower, further left and forward, only its top edge in frame. */
  private buildLeftHand(): Group {
    const hand = new Group();
    const fist = box(0.08, 0.08, 0.105, GLOVE_COLOR);
    const cuff = box(0.07, 0.072, 0.05, CUFF_COLOR);
    cuff.position.set(-0.004, -0.008, 0.11);
    hand.add(fist, cuff);
    hand.rotation.set(-0.12, 0.34, -0.22);
    return hand;
  }

  /**
   * Held in the right fist. The group is canted so the blade runs
   * up-and-across toward screen centre rather than straight down the barrel of
   * the camera — pointing it dead ahead foreshortens it into a stub.
   */
  private buildKnife(): Group {
    const knife = new Group();
    const bladeLength = 0.235;
    const handleLength = 0.11;

    const handle = box(0.03, 0.042, handleLength, HANDLE_COLOR, 0.1, 0.85);
    handle.position.set(0, 0, 0.055);

    // Three wrapped bands standing for a ridged tactical grip on an otherwise
    // flat handle box -- the detail that reads as gripped rather than moulded.
    const ridges = [-0.032, 0, 0.032].map((dz) => {
      const ridge = box(0.034, 0.046, 0.012, GRIP_RIDGE_COLOR, 0.05, 0.8);
      ridge.position.set(0, 0, 0.055 + dz);
      return ridge;
    });

    // Pommel: a small polished cap at the butt end, the one place on a real
    // knife's handle where bare metal shows.
    const pommel = new Mesh(
      new SphereGeometry(0.019, 8, 6),
      new MeshPhysicalMaterial({ color: POMMEL_COLOR, metalness: 0.4, roughness: 0.35, clearcoat: 0.4, clearcoatRoughness: 0.15 }),
    );
    pommel.position.set(0, 0, 0.055 + handleLength / 2 + 0.006);

    // A bolster block sits behind the crossguard so blade and grip don't meet
    // in a bare seam, both polished steel rather than the guard's old flat matte.
    const guard = physicalBox(0.085, 0.02, 0.022, GUARD_COLOR, 0.45, 0.35, 0.4);
    const bolster = physicalBox(0.05, 0.03, 0.014, GUARD_COLOR, 0.45, 0.35, 0.4);
    bolster.position.set(0, 0, 0.012);

    // Metalness is deliberately moderate rather than near-1: this scene has no
    // environment map, and a fully metallic PBR material has almost no diffuse
    // term of its own -- it relies on reflections for its colour, so pushed too
    // high it reads as flat black except for one direct specular glint. Kept
    // partly dielectric, the surface still catches the key/fill lights as
    // overall brightness, with the clearcoat layered on for a polished sheen.
    const blade = new Mesh(
      buildBladeGeometry(bladeLength, 0.05, 0.012),
      new MeshPhysicalMaterial({
        color: BLADE_COLOR,
        metalness: 0.55,
        roughness: 0.22,
        clearcoat: 0.5,
        clearcoatRoughness: 0.12,
      }),
    );
    // Slight drop toward the point, as on a real combat knife: the brief asks
    // for a blade angled forward-and-slightly-down while the knife as a whole
    // is canted up across the frame, and this is where the two reconcile.
    blade.rotation.x = -0.08;

    knife.add(handle, ...ridges, pommel, guard, bolster, blade);
    // Pushed forward of the fist's front face so the crossbar is actually
    // visible between glove and blade; the handle stays buried in the grip.
    knife.position.set(0.002, 0.024, -0.055);
    knife.rotation.set(0.38, 0.55, -0.4);
    return knife;
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

    this.root.position.set(
      Math.sin(this.bobTime) * BOB_SWING_X * amplitude + this.swayX,
      Math.sin(this.bobTime * 2) * BOB_SWING_Y * amplitude + this.swayY,
      0,
    );
    this.root.rotation.set(
      -this.swayY * 1.2,
      this.swayX * 1.2,
      Math.sin(this.bobTime) * BOB_ROLL * amplitude - this.swayX * 2.5,
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
