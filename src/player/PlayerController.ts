import { Vector3 } from 'three';
import { InputFrame } from '../engine/Input';
import { clamp, clipVelocity, degToRad } from '../engine/MathUtils';
import { groundProbe, sweep } from '../engine/Raycast';
import { MovementConfig } from './MovementConfig';

const UP = new Vector3(0, 1, 0);
/** Scratch for `dashImpulse`, so the hot path allocates nothing. */
const FACING = new Vector3();

/**
 * Source stops a swept hull `DIST_EPSILON` (1/32 hu) short of what it hits.
 * 0.01 (0.45 hu) is larger than that on purpose: collision here is a ring of
 * rays rather than a real hull sweep, and `sweep` discards any sample that
 * starts inside geometry, so a sample left flush against a surface would be
 * classified as buried on the next bump and stop contributing.
 */
const SKIN_WIDTH = 0.01;

/**
 * `MAX_CLIP_PLANES` and `numbumps` from `CGameMovement::TryPlayerMove`.
 *
 * Four bumps, not two. The count is the number of *distinct surfaces* one
 * tick's displacement may be redirected around, and a surf line spends most of
 * its time in exactly the places that need more than two: a ramp seam where two
 * faces meet, or a ramp running into the wall it is banked against. With two,
 * the leftover displacement past the second surface is simply dropped and the
 * player stalls for a tick.
 */
const MAX_BUMPS = 4;
const MAX_CLIP_PLANES = 5;

/**
 * Two surfaces closer in angle than this are treated as the same surface.
 *
 * Source needs no such rule because it sweeps a real hull: once velocity has
 * been clipped against a plane, the hull is no longer in contact with it.
 * Collision here is a ring of rays standing in for that hull, and on a *banked*
 * face some of those rays sit fractionally proud of the surface they are riding,
 * so the same ramp can be reported twice within one tick. Fed to the multi-plane
 * solver that reads as a crease between two near-parallel planes, whose cross
 * product is nearly zero — and the player stops dead on an open ramp.
 *
 * Bailing out of the bump loop instead keeps the velocity already clipped
 * against that surface, which is the correct answer, and forfeits only the
 * sub-tick leftover displacement.
 */
const DUPLICATE_PLANE_DOT = 0.99;

/**
 * How far above a surface the player is left when settled onto it: Source's
 * `DIST_EPSILON`, 1/32 hu.
 *
 * Snapping *exactly* onto the surface puts the next tick's sweep ray origins
 * precisely on the collider boundary, where `isInsideAnyCollider` — which tests
 * with `<=` — classifies them as buried and discards them. All five samples
 * discarded means the sweep reports nothing and a grounded player walks through
 * walls. The offset is far below anything visible and far above float noise at
 * these coordinates.
 */
const GROUND_SNAP_EPS = 1 / 32 / 45;

/**
 * The level-up menu pauses `Game.updateGameplay` entirely, so no momentum is
 * actually lost while a player picks an upgrade — but it does cost them a real
 * half-second where they weren't holding strafe/forward, unlike every other
 * moment in a surf line. This nudge compensates for that missed input window;
 * it is a "welcome back" push in the direction already being travelled, not a
 * real speed buff, so it stays small enough not to read as one.
 *
 * The dash deliberately does NOT use this — see `dashImpulse()`.
 */
const MOMENTUM_BOOST_DURATION = 0.5; // seconds
const MOMENTUM_BOOST_ACCEL = 3; // u/s^2

/**
 * One-shot shove the dash adds along the facing direction. It is an impulse,
 * not a buff: nothing lingers after the tick it fires on, so the player can
 * dash to *redirect* — snapping their momentum toward where they're looking —
 * without the mechanic doubling as a speed upgrade.
 */
const DASH_IMPULSE_SPEED = 8; // u/s, added instantly

/**
 * How long Beginner Mode remembers the face it was last riding.
 *
 * A rider is not in contact every tick — they clip the ramp, fly for a few
 * ticks, clip it again — so the assist has to bridge the gaps or it would
 * strobe on and off, which is a strafe key being hammered rather than held, and
 * the gain law pays out on neither. Short enough that leaving a ramp for good
 * drops the assist within a few ticks of the last touch.
 */
const ASSIST_RIDE_HOLD = 0.35; // seconds

/**
 * How square-on to the fall line the view has to be before the assist will
 * change its mind about which key climbs. 0.2 is about 12 degrees either side
 * of looking straight up or down the slope — the only place the two keys are
 * genuinely ambiguous.
 */
const ASSIST_SIDE_DEAD_BAND = 0.2;

/**
 * Tolerance on the walkable-slope test, expressed in normal.y (1e-4 of normal.y
 * is ~0.008 deg of slope at the 45 deg limit — small enough not to retune the
 * angle, large enough to swamp floating-point noise in the collider quaternions).
 *
 * A surface built at *exactly* MAX_SLOPE_WALKABLE_DEG sits precisely on the
 * boundary, where rounding would otherwise decide unpredictably whether the
 * player walks or surfs. Requiring the surface to be strictly shallower than the
 * limit by this epsilon resolves the tie one way: a surface at exactly the
 * configured angle is NOT walkable, i.e. it is surfable. That matches surf-map
 * practice, where a 45 deg ramp is expected to be surfable.
 */
const WALKABLE_NORMAL_EPS = 1e-4;

/**
 * Every place a move can destroy the player's velocity, named.
 *
 * This bug class — a player stopped dead on geometry that looks fine — has been
 * chased three times now, and each time the hard part was not the fix but
 * proving *which* of these fired. They cannot be told apart from outside: every
 * one of them but `duplicate-plane-bail` leaves the same zeroed velocity behind,
 * and that one leaves no trace at all.
 */
export type MoveDiagnosticSite =
  | 'max-clip-planes'
  | 'duplicate-plane-bail'
  | 'no-satisfying-clip'
  | 'degenerate-crease'
  | 'reverse-stop'
  | 'no-progress'
  | 'ground-speed-clamp';

let moveDiagnostics: ((site: MoveDiagnosticSite) => void) | null = null;

/**
 * Installs a sink for the above, for a probe. Null by default and null in the
 * game — the call sites are `?.()`, so this costs six undefined-checks a tick
 * and allocates nothing.
 */
export function setMoveDiagnostics(sink: ((site: MoveDiagnosticSite) => void) | null): void {
  moveDiagnostics = sink;
}

// --------------------------------------------------------------- landing redirect
//
// Everything in this block is off by default (`SURF_LANDING_REDIRECT`) and is
// NOT Source behaviour. It is kept because it was a deliberate house rule, and
// because having it as a toggle is the only way to judge it against the real
// thing. See the flag's comment in MovementConfig.

/** Approach speed into a face that separates a landing from a rider's drift. */
const SURF_LANDING_IMPACT_SPEED = 3; // u/s into the surface
/** Below this the surface is a wall, and shoving a player sideways along a wall is absurd. */
const SURF_LANDING_MIN_NORMAL_Y = 0.3;
/** Ceiling on the redirect's gain, so a near-vertical drop degrades instead of launching. */
const MAX_LANDING_REDIRECT_GAIN = 3;

const DOWN = new Vector3(0, -1, 0);

function redirectLandingVelocity(velocity: Vector3, normal: Vector3): void {
  const fallLine = DOWN.clone().addScaledVector(normal, normal.y);
  if (fallLine.lengthSq() < 1e-8) return;
  fallLine.normalize();

  const downhill = velocity.dot(fallLine);
  if (downhill <= 0) return;

  const speed = velocity.length();
  const alongRamp = velocity.clone().addScaledVector(fallLine, -downhill);
  const alongSpeed = alongRamp.length();
  if (alongSpeed < 1e-6) {
    velocity.copy(alongRamp);
    return;
  }

  const gain = Math.min(speed / alongSpeed, MAX_LANDING_REDIRECT_GAIN);
  velocity.copy(alongRamp).multiplyScalar(gain);
}

// ------------------------------------------------------------------ primitives

/**
 * Read the limit off the config on each call rather than caching it at module
 * load, so it stays correct if MAX_SLOPE_WALKABLE_DEG is retuned or reset at
 * runtime. This runs a handful of times per tick; the cos() is free at that rate.
 */
function isWalkableNormal(normalY: number): boolean {
  const limit = Math.cos(degToRad(MovementConfig.MAX_SLOPE_WALKABLE_DEG));
  return normalY >= limit + WALKABLE_NORMAL_EPS;
}

/** `CGameMovement::CheckVelocity` — `sv_maxvelocity`, clamped per axis, not by magnitude. */
function checkVelocity(velocity: Vector3): void {
  const max = MovementConfig.MAX_VELOCITY;
  velocity.x = clamp(velocity.x, -max, max);
  velocity.y = clamp(velocity.y, -max, max);
  velocity.z = clamp(velocity.z, -max, max);
}

/**
 * `CGameMovement::Friction`.
 *
 * Source measures the FULL 3D speed here and scales all three components, not
 * just the horizontal ones. It only ever runs while grounded, where `FullWalkMove`
 * has already zeroed vertical velocity, so the two agree — but matching the
 * shape keeps it correct if that ever stops being true.
 */
function applyGroundFriction(velocity: Vector3, dt: number): void {
  const speed = velocity.length();
  if (speed < 0.1 / 45) return; // Source: `if (speed < 0.1f) return` in hu
  const control = Math.max(speed, MovementConfig.STOP_SPEED);
  const drop = control * MovementConfig.FRICTION * dt;
  const newSpeed = Math.max(speed - drop, 0);
  velocity.multiplyScalar(newSpeed / speed);
}

/** `CGameMovement::Accelerate`. */
function groundAccelerate(velocity: Vector3, wishDir: Vector3, wishSpeed: number, dt: number): void {
  const currentSpeed = velocity.dot(wishDir);
  const addSpeed = wishSpeed - currentSpeed;
  if (addSpeed <= 0) return;
  const accelSpeed = Math.min(MovementConfig.GROUND_ACCEL * dt * wishSpeed, addSpeed);
  velocity.addScaledVector(wishDir, accelSpeed);
}

/**
 * `CGameMovement::AirAccelerate`.
 *
 * The real trick, verbatim from Source: the `addSpeed` target is capped to
 * `wishspd` (30 hu), but the acceleration magnitude is computed from the
 * UNCAPPED `wishspeed`. That asymmetry is what lets turning the mouse while
 * holding a strafe key gain speed indefinitely — never "simplify" this by using
 * the same value in both places, it silently kills the surf feel.
 *
 * The consequence worth understanding: per tick you may add at most
 * `AIR_SPEED_CAP - (v . wishDir)` along the wish direction. Hold A and sweep the
 * mouse left and `v . wishDir` stays near zero because the wish direction stays
 * near-perpendicular to travel, so every tick pays out the full cap — added
 * sideways, which rotates velocity while lengthening it.
 */
function airAccelerate(
  velocity: Vector3,
  wishDir: Vector3,
  wishSpeed: number,
  dt: number,
  controlFactor = 1,
): void {
  /*
   * `controlFactor` scales the **wish-speed cap**, not `AIR_ACCEL`, and that is
   * not a stylistic choice — scaling the accel term does nothing at all.
   *
   * At the shipped `sv_airaccelerate` of 100 the per-tick gain is limited
   * purely by this cap: `100 * 7 * (1/128)` is 5.47 against a cap of 0.667, so
   * the `Math.min` below always takes the cap and the accel term is slack.
   * Halving `AIR_ACCEL` leaves 2.73, still far above the cap, and changes the
   * outcome by exactly zero. The Glider's air-control penalty was written that
   * way first and a probe caught it doing nothing.
   */
  const cappedWishSpeed = Math.min(wishSpeed, MovementConfig.MAX_AIR_WISH_SPEED * controlFactor);
  const currentSpeed = velocity.dot(wishDir);
  const addSpeed = cappedWishSpeed - currentSpeed;
  if (addSpeed <= 0) return;
  const accelSpeed = Math.min(MovementConfig.AIR_ACCEL * wishSpeed * dt, addSpeed);
  velocity.addScaledVector(wishDir, accelSpeed);
}

/**
 * What the Glider costs in air control while it is holding you up.
 *
 * **This number is the whole reason the Glider is safe to add to a game about
 * surfing.** Gliding is a *recovery* — you missed the ramp, you are falling
 * into the gap, you buy the seconds to line the next one up. Halving the
 * strafe gain means you keep the speed you brought and you steer, but you
 * cannot build under the canopy, so the fastest route is still the ramp and
 * the glider is what you reach for once you have already lost it.
 *
 * If it is ever quicker than surfing a ramp properly it has eaten the point of
 * the game, and this is the knob that decides that.
 */
const GLIDE_AIR_CONTROL_FACTOR = 0.5;

/**
 * The Glider's arming gesture: **tap, release, hold**.
 *
 * `GLIDE_TAP_SECONDS` is how long the opening press may last and still count as
 * a tap; `GLIDE_CHAIN_SECONDS` is how long after releasing it the hold may
 * begin. Both exist so the gesture is deliberate — without them any two presses
 * that happened to land near each other would open the canopy.
 *
 * Generous rather than tight. This is a rescue input, thrown while falling and
 * usually in a hurry, so it should forgive a slow hand; the thing it has to
 * exclude is a *plain hold*, and a plain hold contains no release at all.
 */
const GLIDE_TAP_SECONDS = 0.3;
const GLIDE_CHAIN_SECONDS = 0.45;

/** Sentinel for "no tap has ended recently", kept finite so `+= dt` is safe. */
const NEVER_TAPPED = 1e6;

export class PlayerController {
  readonly position: Vector3;
  readonly velocity = new Vector3(0, 0, 0);
  yaw: number;
  pitch = 0;
  grounded = false;
  groundNormal = new Vector3(0, 1, 0);
  private jumpHeldLastTick = false;
  /** How long the current jump press has been down. Feeds the Glider gesture. */
  private jumpHoldSeconds = 0;
  /** Time since a *short* jump press ended. See `updateGlideArming`. */
  private sinceTapRelease = NEVER_TAPPED;
  /** True while the tap-then-hold gesture is holding the canopy open. */
  glideArmed = false;
  /** True on ticks the Glider is holding the player up. See the note in `tick`. */
  gliding = false;
  private momentumBoostTimer = 0;
  /** The face Beginner Mode is holding the player onto. See `noteRideSurface`. */
  private readonly assistRideNormal = new Vector3();
  private assistRideHold = 0;
  /** Which strafe key the assist last settled on. See `assistStrafe`. */
  private assistSide = 0;

  /** Scratch reused by `tryPlayerMove` so the hot path allocates nothing per bump. */
  private readonly clipPlanes: Vector3[] = Array.from({ length: MAX_CLIP_PLANES }, () => new Vector3());

  constructor(spawnPosition: Vector3, spawnYawDeg: number) {
    this.position = spawnPosition.clone();
    this.yaw = degToRad(spawnYawDeg);
  }

  get speed(): number {
    return Math.hypot(this.velocity.x, this.velocity.z);
  }

  /**
   * Arms the Glider on **tap, release, hold** — and on nothing else.
   *
   * The first version glided on a plain held jump, and that was wrong: with
   * `AUTO_BHOP` a held Space *is* the ordinary bunnyhop posture, so the canopy
   * came out on every descent of every normal run. The player never asked for
   * it and could not switch it off without stopping hopping.
   *
   * The gesture is unambiguous because a plain hold never contains a
   * release-then-press. Both halves are bounded so it stays a deliberate
   * *gesture* rather than any two presses that ever happen to be near each
   * other: the tap has to be short, and the hold has to follow it promptly.
   *
   * Jump behaviour is untouched — the tap still jumps and so does the hold. The
   * gesture only decides whether the *fall* is braked, so nothing is taken away
   * from a player who never learns it.
   */
  private updateGlideArming(dt: number, input: InputFrame): void {
    const held = input.jumpHeld;
    const wasHeld = this.jumpHeldLastTick;

    if (held && !wasHeld) {
      // Rising edge: this press glides only if a short tap just ended.
      this.glideArmed = this.sinceTapRelease <= GLIDE_CHAIN_SECONDS;
      this.jumpHoldSeconds = 0;
      return;
    }
    if (held) {
      this.jumpHoldSeconds += dt;
      return;
    }
    if (wasHeld) {
      // Falling edge: only a *short* press opens the chain window, so
      // "hold, twitch, hold again" cannot arm it by accident.
      this.sinceTapRelease =
        this.jumpHoldSeconds <= GLIDE_TAP_SECONDS ? 0 : NEVER_TAPPED;
      this.jumpHoldSeconds = 0;
      // Releasing always stows the canopy; it is held open, never toggled.
      this.glideArmed = false;
      return;
    }
    this.sinceTapRelease = Math.min(this.sinceTapRelease + dt, NEVER_TAPPED);
  }

  /**
   * `AngleVectors` with the z components zeroed and renormalised, exactly as
   * both `WalkMove` and `AirMove` do — look pitch never contributes to the wish
   * direction, so staring at your feet does not change how you strafe.
   *
   * One departure from Source, behind `AIR_FORWARD_INPUT`: while airborne the
   * forward/back axis is dropped, so W and S only steer on a flat surface. A
   * surfer is airborne on every tick of a ramp (the 0.7 normal cutoff guarantees
   * it), so this is exactly "W/S do nothing while you are surfing" — the input
   * that kills a line by pointing the wish direction where there is no gain left
   * to take. `this.grounded` is the game's own definition of flat: walkable
   * normal, non-wall, per `categorizePosition`.
   */
  private wishDir(input: InputFrame): Vector3 {
    const forward = this.grounded || MovementConfig.AIR_FORWARD_INPUT ? input.moveForward : 0;
    const right = input.moveRight || this.assistStrafe(input);
    const local = new Vector3(right, 0, -forward);
    if (local.lengthSq() > 1e-6) local.normalize();
    return local.applyAxisAngle(UP, this.yaw);
  }

  /**
   * Beginner Mode: the strafe the player would be holding if they knew to.
   *
   * **Which key holds you on a ramp is decided by the ramp, not by the player.**
   * That was measured, and it is the whole reason this reads a surface rather
   * than the mouse: an earlier version derived the strafe from which way the
   * view was sweeping, on the theory that a surfer turns into the key they
   * hold. They do — but a beginner who sweeps the *wrong* way then gets the
   * matching wrong key and slides off exactly as before, which is the one case
   * the assist exists for. The face's own fall line has no such opinion.
   *
   * A surface's normal leans downhill, so the horizontal part of the normal,
   * negated, is the direction that climbs it. Which of the two strafe keys
   * points that way depends on where the player is looking, so this returns a
   * **key**, not a direction: the caller feeds it through the same
   * view-relative path a real keypress takes.
   *
   * That indirection is the difference between a training wheel and an
   * autopilot. Handing back the world-space uphill vector instead was tried,
   * and it holds the player on the ramp beautifully while paying out *no speed
   * at all* — a wish direction that does not turn with the view cannot
   * compound, so sweeping the mouse changes nothing and the player learns
   * nothing. Routed through the view, an assisted rider gains exactly what an
   * advanced one does, from exactly the same act: turning the mouse.
   *
   * Returns 0 unless the assist applies, and it is never consulted while the
   * player is pressing a strafe key of their own, so taking the wheel back
   * mid-ramp needs no transition.
   *
   * Gated on W being held, which is the design: the key a new player wrongly
   * reaches for becomes the one that saves them, and "hands off the keyboard
   * means you slide off" stays true, because that is the lesson.
   */
  private assistStrafe(input: InputFrame): number {
    if (!MovementConfig.SURF_ASSIST || MovementConfig.AIR_FORWARD_INPUT) return 0;
    if (this.grounded || input.moveForward <= 0) return 0;
    if (this.assistRideHold <= 0) return 0;

    const uphill = new Vector3(-this.assistRideNormal.x, 0, -this.assistRideNormal.z);
    if (uphill.lengthSq() < 1e-8) return 0; // a level surface has no uphill
    const right = new Vector3(1, 0, 0).applyAxisAngle(UP, this.yaw);
    const towardUphill = uphill.normalize().dot(right);

    // Looking straight along the fall line leaves both keys equally (un)uphill,
    // and re-deciding every tick there would chatter between them. Hold the last
    // answer through the dead band instead; the ramp will resolve it as soon as
    // the view moves off the crease.
    if (Math.abs(towardUphill) > ASSIST_SIDE_DEAD_BAND) {
      this.assistSide = towardUphill > 0 ? 1 : -1;
    }
    return this.assistSide;
  }

  /**
   * Remembers a face as one the player is riding, for `assistWish`.
   *
   * Walls and walkable ground are both rejected: shoving a player sideways
   * along a wall is absurd, and a walkable surface is one they are standing on,
   * where W is a real input again. `SURF_LANDING_MIN_NORMAL_Y` is reused as the
   * wall cutoff rather than a second constant that could drift from it.
   */
  private noteRideSurface(normal: Vector3, isWall: boolean): void {
    if (isWall || normal.y < SURF_LANDING_MIN_NORMAL_Y || isWalkableNormal(normal.y)) return;
    this.assistRideNormal.copy(normal);
    this.assistRideHold = ASSIST_RIDE_HOLD;
  }

  /**
   * `CGameMovement::TryPlayerMove`, including the parts that are usually left
   * out of ports and are exactly the parts a surf map exercises.
   *
   * Structure, in Source's order:
   *
   * 1. Up to four bumps. Each moves along the CURRENT velocity for the time
   *    still left in the tick — not along a separately clipped copy of the
   *    original displacement. After a clip, the leftover motion follows the new
   *    velocity, which is why a ramp redirects a fall smoothly instead of
   *    carrying a stale heading into the surface.
   * 2. Any distance covered resets the plane list. Planes only accumulate while
   *    the player is genuinely wedged and making no progress.
   * 3. First plane while airborne: a plain clip, and no reverse-stop test. This
   *    is the surf case, and Source deliberately exempts it — the reverse-stop
   *    below would otherwise kill velocity every time a steep face turned it
   *    through more than 90 degrees.
   * 4. Two or more planes: find a clip that satisfies every plane at once; if
   *    none exists with exactly two planes, slide along their crease
   *    (`planes[0] x planes[1]`). This is what carries a player through the
   *    corner where a ramp meets a wall instead of stopping them dead.
   * 5. Reverse-stop: if the result opposes the velocity the tick started with,
   *    zero it. Prevents the buzzing oscillation in acute corners.
   * 6. If no bump made any progress at all, zero velocity.
   */
  private tryPlayerMove(dt: number): void {
    const primalVelocity = this.velocity.clone();
    const originalVelocity = this.velocity.clone();
    const newVelocity = new Vector3();
    const dir = new Vector3();
    let numPlanes = 0;
    let timeLeft = dt;
    let allFraction = 0;
    let bailedOnDuplicatePlane = false;

    for (let bump = 0; bump < MAX_BUMPS; bump++) {
      if (this.velocity.lengthSq() === 0) break;

      const displacement = this.velocity.clone().multiplyScalar(timeLeft);
      const dist = displacement.length();
      if (dist < 1e-9) break;

      // The last argument is why a surfer no longer stops dead at a ramp join.
      //
      // `registerPrism` closes every wedge with vertical planes, and the ones at
      // a strip's first and last ring face straight back along travel. Clipping
      // against one deletes the player's entire forward component — the dead stop
      // that has now been chased through box end-caps, through segment seams, and
      // through the joins between pieces. Pieces are padded to overlap so a cap
      // usually sits buried inside its neighbour, but a player arriving even
      // slightly below a leading edge still meets it head-on, and no shaping of
      // the geometry can help: `registerPrism` builds the plane exactly vertical
      // whatever the edge it came from looks like.
      //
      // Real surf maps make the same call — the CS2 guide's ramp method leaves
      // the leading clip a thin shell rather than a solid end, so an undershoot
      // passes under the ramp instead of splatting on the front of it.
      //
      // Airborne only: a grounded player walking into the end of a ramp should
      // meet a wall, and still does. Surfers are airborne by construction.
      const hit = sweep(this.position, displacement, MovementConfig.PLAYER_RADIUS, !this.grounded);
      const fraction = !hit || hit.distance >= dist ? 1 : Math.max(hit.distance - SKIN_WIDTH, 0) / dist;
      allFraction += fraction;

      if (fraction > 0) {
        this.position.addScaledVector(displacement, fraction);
        originalVelocity.copy(this.velocity);
        numPlanes = 0;
      }

      if (fraction === 1 || !hit) break;

      timeLeft -= timeLeft * fraction;

      if (numPlanes >= MAX_CLIP_PLANES) {
        moveDiagnostics?.('max-clip-planes');
        this.velocity.set(0, 0, 0);
        break;
      }
      let duplicate = false;
      for (let p = 0; p < numPlanes; p++) {
        if (this.clipPlanes[p].dot(hit.normal) > DUPLICATE_PLANE_DOT) {
          duplicate = true;
          break;
        }
      }
      if (duplicate) {
        // Same surface reported twice — see DUPLICATE_PLANE_DOT.
        moveDiagnostics?.('duplicate-plane-bail');
        bailedOnDuplicatePlane = true;
        break;
      }
      this.clipPlanes[numPlanes].copy(hit.normal);
      numPlanes++;

      // Beginner Mode watches what the player is riding from here, because this
      // is the one place that knows: it is the surface the move actually struck.
      if (!this.grounded) this.noteRideSurface(hit.normal, hit.collider.isWall === true);

      // Optional house rule; see the flag. Measured on the velocity as it was
      // *before* the clip, because the clip is precisely what destroys it.
      if (
        MovementConfig.SURF_LANDING_REDIRECT &&
        -originalVelocity.dot(hit.normal) >= SURF_LANDING_IMPACT_SPEED &&
        !hit.collider.isWall &&
        hit.normal.y >= SURF_LANDING_MIN_NORMAL_Y &&
        !isWalkableNormal(hit.normal.y)
      ) {
        const redirected = clipVelocity(originalVelocity, hit.normal);
        redirectLandingVelocity(redirected, hit.normal);
        this.velocity.copy(redirected);
        originalVelocity.copy(redirected);
        continue;
      }

      if (numPlanes === 1 && !this.grounded) {
        // Airborne, first surface: reflect and carry on. The whole of surfing
        // lives in this branch.
        newVelocity.copy(clipVelocity(originalVelocity, this.clipPlanes[0]));
        this.velocity.copy(newVelocity);
        originalVelocity.copy(newVelocity);
        continue;
      }

      // Wedged against several surfaces at once.
      let i = 0;
      for (; i < numPlanes; i++) {
        this.velocity.copy(clipVelocity(originalVelocity, this.clipPlanes[i]));
        let j = 0;
        for (; j < numPlanes; j++) {
          if (j === i) continue;
          if (this.velocity.dot(this.clipPlanes[j]) < 0) break;
        }
        if (j === numPlanes) break; // satisfies every plane
      }

      if (i === numPlanes) {
        // No single plane works — go along the crease of the two.
        if (numPlanes !== 2) {
          moveDiagnostics?.('no-satisfying-clip');
          this.velocity.set(0, 0, 0);
          break;
        }
        dir.crossVectors(this.clipPlanes[0], this.clipPlanes[1]);
        if (dir.lengthSq() < 1e-12) {
          moveDiagnostics?.('degenerate-crease');
          this.velocity.set(0, 0, 0);
          break;
        }
        dir.normalize();
        this.velocity.copy(dir).multiplyScalar(dir.dot(this.velocity));
      }

      if (this.velocity.dot(primalVelocity) <= 0) {
        moveDiagnostics?.('reverse-stop');
        this.velocity.set(0, 0, 0);
        break;
      }
    }

    // Source: no progress in any bump means genuinely wedged, so stop. Excluded
    // when the loop bailed on a surface reported twice, which is a limitation of
    // the ray-ring sweep rather than the player being stuck.
    if (allFraction === 0 && !bailedOnDuplicatePlane) {
      moveDiagnostics?.('no-progress');
      this.velocity.set(0, 0, 0);
    }
  }

  /**
   * `CGameMovement::CategorizePosition`.
   *
   * Two differences from the old probe, both of which mattered:
   *
   * - The trace is 2 hu (`GROUND_TRACE_DIST`), not 13.5. A long probe grounds a
   *   player who is genuinely in the air just above a surface, and a grounded
   *   player has their vertical velocity zeroed and pays friction.
   * - The rising cut-off is `NON_JUMP_VELOCITY` (140 hu/s), not 4.5 hu/s. Below
   *   that a rising player may still be grounded, which is what lets a player
   *   scrape uphill over a small lip without being spat into the air.
   *
   * The snap to `hit.point.y` is Source's `SetGroundEntity` plus `StayOnGround`
   * folded together, and is applied only for a walkable surface.
   */
  private categorizePosition(): void {
    if (this.velocity.y > MovementConfig.NON_JUMP_VELOCITY) {
      this.grounded = false;
      return;
    }
    const hit = groundProbe(
      this.position,
      MovementConfig.PLAYER_RADIUS,
      MovementConfig.GROUND_TRACE_DIST,
    );
    if (hit && !hit.collider.isWall && isWalkableNormal(hit.normal.y)) {
      this.grounded = true;
      this.groundNormal.copy(hit.normal);
      this.position.y = hit.point.y + GROUND_SNAP_EPS;
    } else {
      this.grounded = false;
    }
  }

  /**
   * `CGameMovement::StayOnGround`. After a grounded move, reach one step height
   * down for a walkable surface and settle onto it.
   *
   * Without this a player walking down any shallow slope leaves the ground for a
   * tick, falls, lands, and repeats — they tap down the slope instead of running
   * down it, and every airborne tick in that cycle is a tick where ground
   * friction and ground acceleration do not apply.
   */
  private stayOnGround(): void {
    const hit = groundProbe(this.position, MovementConfig.PLAYER_RADIUS, MovementConfig.STEP_SIZE);
    if (!hit || hit.collider.isWall || !isWalkableNormal(hit.normal.y)) return;
    if (hit.point.y > this.position.y) return; // never pulled upward
    this.position.y = hit.point.y + GROUND_SNAP_EPS;
    this.groundNormal.copy(hit.normal);
    this.grounded = true;
  }

  /**
   * One tick of `CGameMovement::FullWalkMove`, in its order. Every step below is
   * placed where Source places it, and two of those placements are load-bearing:
   *
   * **Gravity is split in half around the move** (`StartGravity` / `FinishGravity`).
   * Half a tick of gravity is applied before the displacement is integrated and
   * half after, which is velocity-Verlet: for a constant acceleration it
   * reproduces the exact continuous trajectory, at any tickrate. Applying it all
   * up front (what this controller used to do) shortens every jump and biases
   * every ramp ride downward by half a tick of gravity, and the error scales
   * with dt — so the movement drifts away from CS's the moment tickrate is
   * anything but what it was tuned against.
   *
   * **The jump is resolved BEFORE anything reads ground state**, because
   * `CheckJumpButton` clears the ground entity and the friction check that
   * follows is gated on "still on the ground". So the tick you jump on pays no
   * ground friction and takes the air path — that is exactly why bunnyhopping in
   * CS preserves speed instead of bleeding a few percent per landing.
   */
  tick(dt: number, input: InputFrame): void {
    this.applyLook(input.yawDelta, input.pitchDelta);
    this.assistRideHold = Math.max(this.assistRideHold - dt, 0);

    const wishDir = this.wishDir(input);
    const wishSpeed = wishDir.lengthSq() > 1e-6 ? MovementConfig.MAX_GROUND_SPEED : 0;

    this.updateGlideArming(dt, input);

    /*
     * The Glider.
     *
     * Decided **once**, here, and used by both halves of the split gravity
     * below. Re-testing at FinishGravity would let a tick that starts
     * descending and ends rising pay two different gravities, which is exactly
     * the kind of dt-dependent drift the split was introduced to avoid.
     *
     * Four conditions, all required: **armed by the tap-then-hold gesture**,
     * airborne, descending, and jump still held. Airborne-and-descending is
     * what keeps it a fall brake rather than a jetpack; the gesture is what
     * keeps it off a player who is simply bunnyhopping. See
     * `updateGlideArming`.
     */
    this.gliding =
      MovementConfig.GLIDE_GRAVITY_SCALE < 1 &&
      this.glideArmed &&
      !this.grounded &&
      this.velocity.y < 0 &&
      input.jumpHeld;
    const gravityScale = this.gliding ? MovementConfig.GLIDE_GRAVITY_SCALE : 1;

    // StartGravity
    this.velocity.y += MovementConfig.GRAVITY * gravityScale * 0.5 * dt;

    // CheckJumpButton
    const wantsJump = MovementConfig.AUTO_BHOP
      ? input.jumpHeld
      : input.jumpHeld && !this.jumpHeldLastTick;
    if (this.grounded && wantsJump) {
      // Source adds to the existing vertical velocity rather than assigning, so
      // the half-tick of gravity applied a moment ago is still paid.
      this.velocity.y += MovementConfig.JUMP_SPEED;
      this.grounded = false;
    }
    this.jumpHeldLastTick = input.jumpHeld;

    if (this.grounded) {
      this.velocity.y = 0;
      applyGroundFriction(this.velocity, dt);
    }
    checkVelocity(this.velocity);

    if (this.grounded) {
      // WalkMove: accelerate horizontally, clamp to max ground speed, then move
      // with no vertical component and settle back onto the ground afterwards.
      this.velocity.y = 0;
      groundAccelerate(this.velocity, wishDir, wishSpeed, dt);
      this.velocity.y = 0;
      const spd = this.velocity.length();
      if (spd > MovementConfig.MAX_GROUND_SPEED) {
        moveDiagnostics?.('ground-speed-clamp');
        this.velocity.multiplyScalar(MovementConfig.MAX_GROUND_SPEED / spd);
      }
      this.applyMomentumBoost(dt, wishDir);
      this.tryPlayerMove(dt);
      this.stayOnGround();
    } else {
      airAccelerate(
        this.velocity,
        wishDir,
        wishSpeed,
        dt,
        this.gliding ? GLIDE_AIR_CONTROL_FACTOR : 1,
      );
      this.applyMomentumBoost(dt, wishDir);
      this.tryPlayerMove(dt);
    }

    this.categorizePosition();
    checkVelocity(this.velocity);

    // FinishGravity — the same scale the tick opened with, see the note there.
    this.velocity.y += MovementConfig.GRAVITY * gravityScale * 0.5 * dt;
    if (this.grounded) this.velocity.y = 0;
  }

  /**
   * Turns the view without simulating anything else.
   *
   * Split out of `tick` so the ReWind countdown can let the player re-aim while
   * the world is held still. They have just watched fifteen seconds run
   * backwards and are usually mid-air on a ramp — resuming on whatever heading
   * the recording happened to end on is the difference between landing the line
   * and being handed back a botched one.
   */
  applyLook(yawDelta: number, pitchDelta: number): void {
    this.yaw += yawDelta;
    this.pitch = clamp(
      this.pitch + pitchDelta,
      -degToRad(MovementConfig.PITCH_LIMIT_DEG),
      degToRad(MovementConfig.PITCH_LIMIT_DEG),
    );
  }

  private applyMomentumBoost(dt: number, wishDir: Vector3): void {
    if (this.momentumBoostTimer <= 0) return;
    this.momentumBoostTimer = Math.max(this.momentumBoostTimer - dt, 0);
    const speed = this.speed;
    const boostDir =
      speed > 1e-6 ? new Vector3(this.velocity.x, 0, this.velocity.z).divideScalar(speed) : wishDir;
    if (boostDir.lengthSq() > 1e-6) {
      this.velocity.addScaledVector(boostDir, MOMENTUM_BOOST_ACCEL * dt);
    }
  }

  /** Arms the momentum nudge (see `MOMENTUM_BOOST_ACCEL`) for its next `MOMENTUM_BOOST_DURATION` seconds of ticks. */
  grantMomentumBoost(): void {
    this.momentumBoostTimer = MOMENTUM_BOOST_DURATION;
  }

  /**
   * Shoves the player along the direction they are facing (see
   * `DASH_IMPULSE_SPEED`). Yaw only — pitch is left out on purpose, because a
   * dash that inherited look pitch would be a free ascent while staring up, and
   * height in a surf line has to be earned off a ramp.
   */
  dashImpulse(): void {
    this.velocity.addScaledVector(this.facing(FACING), DASH_IMPULSE_SPEED);
  }

  /**
   * Where the player is facing on the horizontal plane, written into `out`.
   *
   * Yaw only, for the same reason `dashImpulse` uses yaw only: pitch would make
   * anything aimed along it a free ascent while staring up, and height in a
   * surf line has to be earned off a ramp.
   */
  facing(out: Vector3): Vector3 {
    return out.set(0, 0, -1).applyAxisAngle(UP, this.yaw);
  }

  teleport(position: Vector3): void {
    this.position.copy(position);
    this.velocity.set(0, 0, 0);
    this.grounded = false;
    this.momentumBoostTimer = 0;
    // A remembered face from before the teleport would spend its hold pushing
    // the player sideways out of a spawn nowhere near it.
    this.assistRideHold = 0;
    this.assistSide = 0;
  }
}
