import { Vector3 } from 'three';
import { InputFrame } from '../engine/Input';
import { clamp, clipVelocity, degToRad } from '../engine/MathUtils';
import { groundProbe, sweep } from '../engine/Raycast';
import { MovementConfig } from './MovementConfig';

const UP = new Vector3(0, 1, 0);

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
function airAccelerate(velocity: Vector3, wishDir: Vector3, wishSpeed: number, dt: number): void {
  const cappedWishSpeed = Math.min(wishSpeed, MovementConfig.MAX_AIR_WISH_SPEED);
  const currentSpeed = velocity.dot(wishDir);
  const addSpeed = cappedWishSpeed - currentSpeed;
  if (addSpeed <= 0) return;
  const accelSpeed = Math.min(MovementConfig.AIR_ACCEL * wishSpeed * dt, addSpeed);
  velocity.addScaledVector(wishDir, accelSpeed);
}

export class PlayerController {
  readonly position: Vector3;
  readonly velocity = new Vector3(0, 0, 0);
  yaw: number;
  pitch = 0;
  grounded = false;
  groundNormal = new Vector3(0, 1, 0);
  private jumpHeldLastTick = false;
  private momentumBoostTimer = 0;

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
   * `AngleVectors` with the z components zeroed and renormalised, exactly as
   * both `WalkMove` and `AirMove` do — look pitch never contributes to the wish
   * direction, so staring at your feet does not change how you strafe.
   */
  private wishDir(input: InputFrame): Vector3 {
    const local = new Vector3(input.moveRight, 0, -input.moveForward);
    if (local.lengthSq() > 1e-6) local.normalize();
    return local.applyAxisAngle(UP, this.yaw);
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

    const wishDir = this.wishDir(input);
    const wishSpeed = wishDir.lengthSq() > 1e-6 ? MovementConfig.MAX_GROUND_SPEED : 0;

    // StartGravity
    this.velocity.y += MovementConfig.GRAVITY * 0.5 * dt;

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
      airAccelerate(this.velocity, wishDir, wishSpeed, dt);
      this.applyMomentumBoost(dt, wishDir);
      this.tryPlayerMove(dt);
    }

    this.categorizePosition();
    checkVelocity(this.velocity);

    // FinishGravity
    this.velocity.y += MovementConfig.GRAVITY * 0.5 * dt;
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
    const forward = new Vector3(0, 0, -1).applyAxisAngle(UP, this.yaw);
    this.velocity.addScaledVector(forward, DASH_IMPULSE_SPEED);
  }

  teleport(position: Vector3): void {
    this.position.copy(position);
    this.velocity.set(0, 0, 0);
    this.grounded = false;
    this.momentumBoostTimer = 0;
  }
}
