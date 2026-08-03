import { BoxGeometry, Group, Mesh, MeshStandardMaterial } from 'three';
import { clamp, lerp } from '../engine/MathUtils';
import { EYE_HEIGHT } from './CameraRig';
import { buildLeftHand, buildRightHand } from './Hands';
import { PlayerController } from './PlayerController';

/**
 * The player's body, drawn in the world scene for the third-person camera.
 *
 * Deliberately a Minecraft-shaped placeholder: six boxes on a hips/shoulders
 * rig, blocky enough that nobody mistakes it for the final character, rigged
 * properly enough that the real model can be dropped onto the same joints
 * without the animation code changing. The only parts that are *not*
 * placeholder are the gloved hands — those come from `Hands`, the same
 * builders the first-person viewmodel uses, so the fists on this character
 * are the fists the player was just looking at.
 *
 * This class owns no game logic and never writes to the controller: `Game`
 * ticks it on the fixed timestep with a read-only look at the player's state.
 */

/* ------------------------------------------------------------------ *
 * Proportions
 * ------------------------------------------------------------------ */

/**
 * Minecraft's player is built on a 16-per-block pixel grid: an 8-cube head on a
 * 8x12x4 torso, 4x12x4 limbs — 32 px from sole to crown, with the eyes 28 px up.
 *
 * The scale is pinned by the eye line rather than by total height. `EYE_HEIGHT`
 * is where the camera sits in first person, so putting the model's eyes
 * anywhere else means the world visibly rises or drops when the camera is
 * toggled. Solving 28 px = 1.6 units makes the character 1.83 units (82 Hammer
 * units) tall — a little over CS's 72 hu hull, which is the price of Minecraft's
 * big head and is worth paying for the silhouette.
 */
const PIXEL = EYE_HEIGHT / 28;
const px = (n: number): number => n * PIXEL;

const HIP_Y = px(12);
const SHOULDER_Y = px(24);
/** From the shoulder pivot down to the wrist — where the glove goes. */
const ARM_LENGTH = px(12);
/** Torso half-width plus arm half-width: the arms hang flush against the sides. */
const ARM_X = px(6);
const LEG_X = px(2);

/**
 * The hands are authored at world scale in `Hands`, which is correct for a
 * realistic body and slightly lost against Minecraft's 4 px forearms — so the
 * assembly is scaled up as one group onto the blocky arm.
 */
const HAND_SCALE = 1.7;

/* ------------------------------------------------------------------ *
 * Palette
 * ------------------------------------------------------------------ */

const SKIN_COLOR = 0xd7a17c;
const HAIR_COLOR = 0x33261e;
const SHIRT_COLOR = 0x2f6f7e;
const PANTS_COLOR = 0x2b3038;
const BOOT_COLOR = 0x1a1d22;
const EYE_WHITE = 0xeef2f4;
const EYE_PUPIL = 0x1b2733;

/* ------------------------------------------------------------------ *
 * Poses
 * ------------------------------------------------------------------ */

/**
 * Limb rotations, in radians about the joint. Sign conventions, since none of
 * them are guessable: the body is built facing its own -Z (the same convention
 * as the movement code's yaw 0), so for a limb hanging along -Y, **+X swings it
 * forward** and **+Z swings it out to the character's right**.
 */
interface Pose {
  /**
   * Upper body lean about the hips, positive = forward. The torso points along
   * +Y rather than hanging along -Y, so this one is *negated* when applied —
   * the same +X rotation that swings a limb forward tips the chest back.
   */
  torsoPitch: number;
  /** Lead arm, then off-hand arm. */
  armR: { x: number; z: number };
  armL: { x: number; z: number };
  /** Static split; the walk cycle's swing is added on top of this. */
  legR: { x: number; z: number };
  legL: { x: number; z: number };
}

/** Standing and running: arms down with a hair of clearance from the torso. */
const GROUND_POSE: Pose = {
  torsoPitch: 0.05,
  armR: { x: 0.06, z: 0.14 },
  armL: { x: 0.06, z: -0.14 },
  legR: { x: 0, z: 0.02 },
  legL: { x: 0, z: -0.02 },
};

/**
 * Airborne — which on a surf map is most of the run, so this is the pose the
 * character is actually judged on. A skater's line: legs split fore/aft and
 * splayed, off-hand thrown wide for balance, chest tipped into the direction of
 * travel.
 *
 * The lead hand is carried forward and slightly OUT rather than across the
 * chest — held across, it spends the whole run inside the torso's silhouette,
 * and the third-person camera looks at this character's back almost
 * exclusively.
 */
const AIR_POSE: Pose = {
  torsoPitch: 0.24,
  armR: { x: 0.62, z: 0.2 },
  armL: { x: -0.5, z: -0.95 },
  legR: { x: 0.5, z: 0.22 },
  legL: { x: -0.34, z: -0.3 },
};

/** How fast the ground/air pose crossfades. Fast enough to catch a hop, slow enough not to strobe on ramp chatter. */
const AIR_BLEND_RATE = 7;

/* ------------------------------------------------------------------ *
 * Walk cycle
 * ------------------------------------------------------------------ */

/**
 * Stride is driven by distance travelled, not by a clock: a cadence that runs
 * at a fixed rate while the speed changes is the classic ice-skating foot
 * slide. One full cycle per this many units of ground covered.
 */
const STRIDE_LENGTH = 2.6;
const WALK_SWING = 0.62;
/** Speed at which the swing reaches full amplitude. CS walk speed is ~7 u/s. */
const SPEED_FOR_FULL_SWING = 7;
/** Vertical bounce at the top of each step. Small — the camera does not share it. */
const WALK_BOB = px(0.5);

/* ------------------------------------------------------------------ *
 * Lean
 * ------------------------------------------------------------------ */

/**
 * Banking into a turn, from the same smoothed yaw rate the viewmodel sways on.
 * This is the one piece of the animation that reads as *surfing* rather than as
 * a mannequin being flown around: carving a ramp is a continuous turn, so the
 * body is continuously laid over into it.
 */
const LEAN_PER_RAD_PER_SEC = 0.055;
const LEAN_LIMIT = 0.38;
const LEAN_SMOOTHING = 8;

/* ------------------------------------------------------------------ *
 * Dash brace
 * ------------------------------------------------------------------ */

const DASH_DURATION = 0.3;
const DASH_CROUCH = px(1.2);
const DASH_TORSO_PITCH = 0.3;

function easeOutQuad(t: number): number {
  return 1 - (1 - t) * (1 - t);
}

function block(
  wPx: number,
  hPx: number,
  dPx: number,
  color: number,
  roughness = 0.85,
): Mesh {
  return new Mesh(
    new BoxGeometry(px(wPx), px(hPx), px(dPx)),
    new MeshStandardMaterial({ color, metalness: 0.05, roughness }),
  );
}

export class PlayerModel {
  /** Add this to the world scene. Positioned at the player's feet, yawed to their facing. */
  readonly root = new Group();

  /** Everything above the feet. Carries the dash crouch and the walk bob. */
  private readonly body = new Group();
  /** Pivots at the hips; carries torso, head and both arms so the whole upper body leans as one. */
  private readonly torso = new Group();
  private readonly head = new Group();
  private readonly armR = new Group();
  private readonly armL = new Group();
  private readonly legR = new Group();
  private readonly legL = new Group();

  private stridePhase = 0;
  private airBlend = 1;
  private lean = 0;
  private dashTimer = 0;

  constructor() {
    // YXZ, so the roll is applied in the body's own frame after the yaw —
    // i.e. banking about the direction of travel. With the default XYZ order
    // the same roll would be about the world Z axis and the character would
    // cartwheel sideways on every heading but one.
    this.root.rotation.order = 'YXZ';

    this.torso.position.y = HIP_Y;
    this.torso.add(this.buildTorso());

    this.head.position.y = SHOULDER_Y - HIP_Y;
    this.head.add(...this.buildHead());
    this.torso.add(this.head);

    this.armR.position.set(ARM_X, SHOULDER_Y - HIP_Y, 0);
    this.armL.position.set(-ARM_X, SHOULDER_Y - HIP_Y, 0);
    this.armR.add(this.buildArm());
    this.armL.add(this.buildArm());
    this.torso.add(this.armR, this.armL);

    // The same fists as the first-person viewmodel, at the wrist. `Hands`
    // builds them facing -Z with +X right, which is exactly the body's own
    // frame, so they need no reorientation.
    const rightHand = buildRightHand();
    rightHand.scale.setScalar(HAND_SCALE);
    // A shade short of the full arm so the glove overlaps the sleeve's end
    // instead of floating off it.
    rightHand.position.y = -ARM_LENGTH + px(1);
    this.armR.add(rightHand);

    const offHand = buildLeftHand();
    offHand.scale.setScalar(HAND_SCALE);
    offHand.position.y = -ARM_LENGTH + px(1);
    this.armL.add(offHand);

    this.legR.position.set(LEG_X, HIP_Y, 0);
    this.legL.position.set(-LEG_X, HIP_Y, 0);
    this.legR.add(...this.buildLeg());
    this.legL.add(...this.buildLeg());

    this.body.add(this.torso, this.legR, this.legL);
    this.root.add(this.body);
    this.root.visible = false;
  }

  private buildTorso(): Mesh {
    const torso = block(8, 12, 4, SHIRT_COLOR);
    torso.position.y = px(6);
    return torso;
  }

  /**
   * Head, hair and a two-pixel face. The eyes are the whole reason this reads
   * as a character rather than as a stack of crates from behind — they are only
   * ever seen when the camera swings around the front, and that is exactly the
   * moment a faceless block looks broken.
   */
  private buildHead(): Mesh[] {
    const parts: Mesh[] = [];

    const skull = block(8, 8, 8, SKIN_COLOR);
    skull.position.y = px(4);
    parts.push(skull);

    // Hair as a cap over the crown and down the back, in the same grid so it
    // stays flush with the skull's faces.
    const crown = block(8.2, 1.2, 8.2, HAIR_COLOR);
    crown.position.y = px(7.6);
    const nape = block(8.2, 6, 1.2, HAIR_COLOR);
    nape.position.set(0, px(4.4), px(4.1));
    parts.push(crown, nape);

    // Front face is at z = -4px; the plates sit just proud of it so they can
    // never z-fight with the skull.
    for (const side of [-1, 1]) {
      const white = block(2, 1, 0.2, EYE_WHITE, 0.6);
      white.position.set(side * px(2), px(4.6), px(-4.1));
      const pupil = block(1, 1, 0.3, EYE_PUPIL, 0.5);
      pupil.position.set(side * px(2.5), px(4.6), px(-4.15));
      parts.push(white, pupil);
    }

    const brow = block(8.1, 0.6, 0.2, HAIR_COLOR);
    brow.position.set(0, px(6.4), px(-4.05));
    parts.push(brow);

    return parts;
  }

  /** Sleeve hanging from the shoulder pivot; the glove is added separately at the wrist. */
  private buildArm(): Mesh {
    const arm = block(4, 11, 4, SHIRT_COLOR);
    arm.position.y = -px(5.5);
    return arm;
  }

  /** Trouser leg plus a boot, hanging from the hip pivot. */
  private buildLeg(): Mesh[] {
    const leg = block(4, 12, 4, PANTS_COLOR);
    leg.position.y = -px(6);
    const boot = block(4.3, 3, 5, BOOT_COLOR, 0.7);
    // Nudged forward so the toe reads: the foot is the one place a straight
    // extrusion of the leg box looks like a missing part rather than a style.
    boot.position.set(0, -px(10.5), -px(0.5));
    return [leg, boot];
  }

  /** Re-arms the dash brace; a dash mid-brace just restarts the timer. */
  triggerDash(): void {
    this.dashTimer = DASH_DURATION;
  }

  /** The body only exists for the third-person camera; in first person it is inside the lens. */
  setVisible(visible: boolean): void {
    this.root.visible = visible;
  }

  /**
   * @param dt fixed simulation step, never wall-clock.
   * @param controller read-only; this class never writes player state.
   * @param yawDelta radians of yaw applied this tick, for the bank.
   */
  update(dt: number, controller: PlayerController, yawDelta: number): void {
    // Cheap out while hidden, but keep the transform current so a camera
    // toggle never shows a frame of the body standing at a stale position.
    this.root.position.copy(controller.position);

    const speed = controller.speed;
    const airTarget = controller.grounded ? 0 : 1;
    const blend = 1 - Math.exp(-dt * AIR_BLEND_RATE);
    this.airBlend += (airTarget - this.airBlend) * blend;

    const yawRate = dt > 0 ? yawDelta / dt : 0;
    const leanTarget = clamp(yawRate * LEAN_PER_RAD_PER_SEC, -LEAN_LIMIT, LEAN_LIMIT);
    const leanBlend = 1 - Math.exp(-dt * LEAN_SMOOTHING);
    this.lean += (leanTarget - this.lean) * leanBlend;

    this.root.rotation.set(0, controller.yaw, this.lean);

    // Head tracks the look. Same sign as the camera (`+pitch` is up), clamped
    // short of the camera's own limit so the neck never folds through the torso.
    this.head.rotation.x = clamp(controller.pitch, -0.9, 0.7);

    if (this.dashTimer > 0) this.dashTimer = Math.max(this.dashTimer - dt, 0);
    const dashEase = this.dashTimer > 0 ? easeOutQuad(this.dashTimer / DASH_DURATION) : 0;

    // Walk cycle. Only the grounded fraction of the pose uses it; in the air the
    // legs hold the split and the phase is left where it was, so touching down
    // resumes the stride instead of snapping to its start.
    const groundWeight = 1 - this.airBlend;
    const swingAmp = Math.min(1, speed / SPEED_FOR_FULL_SWING) * WALK_SWING * groundWeight;
    if (controller.grounded) {
      this.stridePhase += (speed * dt * 2 * Math.PI) / STRIDE_LENGTH;
    }
    const stride = Math.sin(this.stridePhase);

    this.body.position.y =
      Math.abs(Math.cos(this.stridePhase)) * WALK_BOB * groundWeight - dashEase * DASH_CROUCH;

    const t = this.airBlend;
    // Negated: see `Pose.torsoPitch`.
    this.torso.rotation.x = -(
      lerp(GROUND_POSE.torsoPitch, AIR_POSE.torsoPitch, t) + dashEase * DASH_TORSO_PITCH
    );

    this.armR.rotation.set(
      lerp(GROUND_POSE.armR.x, AIR_POSE.armR.x, t) - stride * swingAmp,
      0,
      lerp(GROUND_POSE.armR.z, AIR_POSE.armR.z, t),
    );
    this.armL.rotation.set(
      lerp(GROUND_POSE.armL.x, AIR_POSE.armL.x, t) + stride * swingAmp,
      0,
      lerp(GROUND_POSE.armL.z, AIR_POSE.armL.z, t),
    );

    this.legR.rotation.set(
      lerp(GROUND_POSE.legR.x, AIR_POSE.legR.x, t) + stride * swingAmp,
      0,
      lerp(GROUND_POSE.legR.z, AIR_POSE.legR.z, t),
    );
    this.legL.rotation.set(
      lerp(GROUND_POSE.legL.x, AIR_POSE.legL.x, t) - stride * swingAmp,
      0,
      lerp(GROUND_POSE.legL.z, AIR_POSE.legL.z, t),
    );
  }

  /** Re-centres the rig. Used on restart. */
  reset(): void {
    this.stridePhase = 0;
    this.airBlend = 1;
    this.lean = 0;
    this.dashTimer = 0;
  }
}
