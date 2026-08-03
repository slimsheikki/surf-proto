# Movement versions

Running log of the movement builds, newest first. The movement is being tuned against a
person's judgement rather than a test, so every build gets a name and a number, both stamped
on screen (bottom-left, `MOVE v1 · Source Parity`) and in `src/player/MovementVersion.ts`.
**Bump that file and add an entry here in the same commit** — a review note that is not
attached to a specific build is not usable.

## How to review a build

- The build stamp is bottom-left, always visible, in every mode.
- **`O` opens the live tuning panel.** It pauses the sim and hands the cursor back. Every
  slider maps to a real CS convar and shows the Hammer-unit value next to the game-unit one.
  Changed values go amber, so a "this feels wrong" note can never be about a slider you
  forgot you moved.
- Settings made in the panel **survive death and restart** (they are held apart from the
  run's own upgrade buffs, which do not). "Reset to shipped defaults" clears them.
- The most useful feedback is a slider position: *"airaccelerate at 60 felt right, 100 was
  twitchy"* is a change I can make exactly. *"Strafing feels off"* is not.

Open questions I could not settle from here are listed at the bottom.

---

## v1 — Source Parity

The controller was a good sketch of `PM_AirAccelerate` and `PM_ClipVelocity` with the rest of
`CGameMovement` missing. This fills in the rest and puts the constants back on CS:S's
numbers. Every change below is a behaviour change, so read it as a list of things to judge.

### Integration — jump height was 2.4% short, at every tickrate

Gravity was applied in full *before* the tick's displacement was integrated. Source applies
**half before and half after** (`StartGravity` / `FinishGravity`), which is velocity-Verlet
and reproduces the exact continuous trajectory for a constant acceleration.

Measured: jump apex went **55.6 hu → 57.0 hu**, which is exactly
`sqrt(2 × 800 × 57)²/(2 × 800)` — the canonical Source jump, to the decimal. The old error
scaled with `dt`, so the movement drifted from CS's whenever the tickrate was not the one it
happened to be tuned against. This also biased every ramp ride downward by half a tick of
gravity, every tick.

### `TryPlayerMove` — the collision response was two thirds missing

The sweep loop ran **2 iterations against a single plane at a time**. Source runs 4 and keeps
a list of up to 5 planes. Restored in full:

- **4 bumps, not 2**, and each bump moves along the *current* velocity for the time left in
  the tick — not along a clipped copy of the original displacement. After a clip the leftover
  motion follows the new velocity, which is why a ramp redirects a fall smoothly.
- **Two-plane crease handling.** When no single plane's clip satisfies both surfaces, slide
  along `planes[0] × planes[1]`. This is what carries you through the corner where a ramp
  meets the wall it is banked against, instead of stopping dead.
- **The airborne first-plane exemption.** Source deliberately skips the "stop dead if the
  result reverses" test for the first surface hit while airborne — that is the surf case, and
  without the exemption a steep face turning your velocity through more than 90° would zero
  it. The old code had neither the test nor the exemption; now it has both, correctly split.
- **Planes reset whenever any distance is covered**, so they only accumulate while genuinely
  wedged.
- `ClipVelocity` gained Source's second projection pass ("iterate once to make sure we aren't
  still moving through the plane"). Without it a non-unit collider normal leaves a residual
  into-plane component that accumulates over a long ride and slowly sinks you into the face.

Two guards exist here that Source does not need, because collision here is a ring of rays
rather than a real hull sweep: a surface reported twice in one tick is treated as one
(`DUPLICATE_PLANE_DOT`), and settling onto ground leaves you `1/32` hu above it rather than
exactly on it. Both are commented at length in `PlayerController.ts`; the first prevents a
dead stop on an open ramp, the second prevents a grounded player walking through walls.

### Ground state — the probe was 6.75× too long

`CategorizePosition` traces **2 hu** down. This traced **13.5**, so a player genuinely in the
air near a surface was reported as standing on it — which zeroes their vertical velocity and
charges them ground friction. On a surf map that is a lot of frames.

- Ground trace 0.3 → `2/45` u.
- The "moving up, so not grounded" cut-off was 4.5 hu/s; Source's `NON_JUMP_VELOCITY` is
  **140**. Below that a rising player can still be grounded, which is what lets you scrape
  over a lip without being spat into the air.
- Added **`StayOnGround`**: after a grounded move, reach one step height (18 hu) down for a
  walkable surface and settle onto it. Without it you *tap* down a shallow slope rather than
  running down it, and every airborne tick in that cycle skips ground friction and ground
  acceleration.
- `WalkMove` now moves horizontally only and clamps ground speed to `sv_maxspeed`, as Source
  does.

### Constants — put back on CS:S's numbers

| | was | now | CS:S |
|---|---|---|---|
| air speed cap | 0.60 (27 hu) | **0.667** (30 hu) | hard-coded 30 |
| `sv_airaccelerate` | 12 | **100** | ships 10; surf servers run 100 |
| `sv_accelerate` | 10 (HL2's) | **5** | 5 |
| `sv_friction` | 6 | **4** | 4 |
| `sv_stopspeed` | 1.5 (67 hu) | **1.667** (75 hu) | 75 |
| `sv_gravity` | −17.8 | **−17.778** (800/45) | 800 |
| jump speed | 6.7 | **6.711** (301.99 hu) | `sqrt(2·800·57)` |
| `sv_maxvelocity` | *(none)* | **77.8** (3500 hu) | 3500 |

The air cap is the one that matters: it is the ceiling on how much speed a single tick of
air-strafing can add, and it was **11% low**. `sv_airaccelerate` looks like a huge change but
mostly is not — at the old 12 the per-tick gain was *already* limited by the cap rather than
by the accel, so raising it only widens the window in which the cap is reached. It is a
slider now, so if 100 reads as twitchy, say what does.

### Mouse input — half your ticks got no view rotation

This one is invisible in the code and I think it is a real part of why strafing felt off.

Mouse motion arrives **once per rendered frame**. The sim runs at 128 Hz. At 60 fps that is
two ticks per frame — and the input system handed the entire frame's mouse delta to the
first tick and *nothing* to the second.

Air-strafe gain per tick is capped at `AIR_SPEED_CAP − (velocity · wishDir)`. A tick where
the view does not turn is a tick where that dot product has already caught up to the cap and
pays out nothing. So roughly half the ticks paid nothing, and the loss got worse the lower
your framerate — the exact symptom of "the strafe doesn't respond like CS".

The frame's tick count is now known before the ticks run, and the mouse delta is split evenly
across them, which is what a CS client generating one usercmd per tick does. Remainders stay
in the accumulator, so a frame's total view rotation is preserved exactly.

### Sensitivity is a setting now

It was a hard-coded `0.0022` rad/count — a fixed CS sensitivity of about **5.7**, with no way
to change it. It is now expressed the CS way (`m_yaw` 0.022° × `sensitivity`) and lives on the
panel, defaulted to 5.7 so this build does not silently change your aim as well as everything
else. **Set this first, before judging anything else** — surf is sweeping the view at a rate
matched to your speed, and the wrong sensitivity means you are evaluating the wrong thing.

### Landing redirect — off by default, and this is the biggest single change

Landing on a banked face used to have its fall re-pointed *along* the ramp at preserved speed.
That is not Source and it is not surf: in CS:S a drop onto a ramp becomes a slide down the
fall line, and converting that slide into forward speed **is the mechanic**.

Measured off the start pad: **33.4 u/s with it on, 17.4 u/s with it off.** So expect the
course to feel considerably slower and considerably more like you have to work for speed.
It is the first toggle to flip if the new build feels sluggish — the panel has it.

The house rule was a deliberate choice made for a specific problem (a late landing being
thrown off a ramp's low edge before you could strafe back up). If that problem comes back,
it is a level-geometry answer I would rather find than re-adding this.

### Also

- Auto-bhop is still on by default, but it is now a toggle. Vanilla CS:S has none —
  `CheckJumpButton` early-outs on `m_nOldButtons & IN_JUMP`, so every hop needs its own
  timed press.
- `Friction` measures 3D speed and scales all three components, matching Source's shape.
- Ground friction is still applied *after* the jump check, which was already right.

### What I deliberately did not change

- **Player hull.** The player is still a flat ring of rays at foot level, 18 hu across; CS's
  hull is a 32×32×72 box. A real swept box would change where you contact a banked face. Left
  alone so v1 changes the movement maths and not the size of the thing being moved.
- **Ducking.** Not implemented at all — no crouch, no duck-jump, no hull change. Real CS:S
  surf uses all three.
- **The 1 unit = 45 hu scale**, and `MAX_GROUND_SPEED` 7. CS:S with a knife out is 250 hu/s,
  not 320, but the whole project's geometry is pinned to 320 → 7.

### Open questions for you

1. **`sv_airaccelerate` 100 vs 10.** I defaulted to the surf-server value. If it feels
   twitchy, the panel goes down to 5.
2. **Auto-bhop.** Keep, or go vanilla and make hops timed?
3. **Landing redirect.** I expect you to notice its absence immediately. Which do you want?
4. On a jump tick Source appears to apply `FinishGravity` twice — once inside
   `CheckJumpButton` and once at the end of `FullWalkMove` — which would shave about 1% off
   jump height. I did not replicate it because I could not verify it from here, and the
   result (exactly 57.0 hu) is the number the community measures. Flag it if jumps feel a
   hair floaty.

### Verification

Headless probes (`.probe-movement.ts`, `.probe-ramp.ts`, gitignored) run the real controller
against the real course and against an isolated canonical 51.34° face, old build vs new:

```
                        old        new
jump apex            55.6 hu    57.0 hu      (CS:S = 57.0)
walk top speed        7.000      7.000       (sv_maxspeed)
ride a ramp, no input  28.1       28.2  u/s  after 4 s
air-strafe @160°/s     22.05      22.43 u/s  from 20.0 over 2 s
air-strafe @320°/s     12.89      22.27 u/s  (old build LOST speed here)
hard landing on a ramp 37.5       32.1  u/s  (redirect off)
stalls on a ramp          0          0
```

No dead stops on any ramp in either build. Browser smoke pass: boots clean, no console
errors, panel opens and closes, run unaffected.
