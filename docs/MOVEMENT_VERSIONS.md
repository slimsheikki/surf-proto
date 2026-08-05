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

## v5 — Canopy

**The Glider.** Hold `Space` while airborne and falling and you descend at half gravity,
deepening toward a quarter as the Cartridge stacks. Nothing else about the controller
changes: with the Cartridge untaken the whole feature is one multiply by one, and a run
that never picks it is bit-identical to v4.

It costs no new key. `AUTO_BHOP` reads `jumpHeld` **only while grounded**, so a held Space
already means "jump the moment I land" — the glide only engages airborne and descending, and
the two readings can never contend for the same tick.

**It must never be the fast line, and that is the whole design.** Gliding is a recovery: you
missed the ramp, you are falling into the gap, you buy the seconds to line the next one up.
So air control is cut to half while the canopy is out — you keep the speed you brought and
you steer, but you cannot build under it. Probed: a perfect strafe reaches 27.7 u/s free and
25.7 u/s gliding over the same 2.5 seconds. If it ever out-builds a ramp it has eaten the
point of the game, and `GLIDE_AIR_CONTROL_FACTOR` is the one-line revert.

Two things to know if you touch this:

- **The glide decision is latched once per tick**, before `StartGravity`, and both halves of
  the split gravity use it. Re-testing at `FinishGravity` would let a tick that starts
  descending and ends rising pay two different gravities — precisely the dt-dependent drift
  the split was introduced to avoid.
- **The air-control penalty scales the wish-speed cap, not `AIR_ACCEL`.** Scaling the accel
  term does nothing at all: at `sv_airaccelerate` 100 the per-tick gain is `100 x 7 / 128` =
  5.47 against a cap of 0.667, so the cap always binds and the accel term is slack. Halving
  it leaves 2.73 — still far above the cap, still exactly zero change. It was written that
  way first and `.probe-glider` caught it doing nothing, which is the only reason it is not
  in the build.

The floor is 0.25 and never 0. A true float would let a player park in the air and wait a
wave out, and this game has no standing still in it.

**To review:** take Glider, then deliberately miss a ramp. The question is whether the
rescue feels earned or whether you start using it instead of the line.

---

## v4 — Training Wheels

**Beginner Mode**, picked on the map screen: hold W on a ramp and the game supplies the
strafe key that keeps you on it. Advanced Mode is v3 unchanged, bit for bit.

The switch sits under the map grid with both modes named either side and the live one lit —
it applies to whichever map you then pick, because the mode is a property of the run, not of
a map. `B` toggles it, it persists across sessions, and it **defaults on**: a first-time
player cannot ask for help they do not know exists. The build stamp reads
`MOVE v4 · TRAINING WHEELS · BEGINNER` while it is on, so a speed figure can never be
mistaken for an unassisted one.

### The assist supplies the key, nothing else

`PlayerController.assistStrafe` returns a **strafe key**, not a direction, and the caller
feeds it through the same view-relative path a real keypress takes. So an assisted rider is
running the ordinary `airAccelerate` on an ordinary unit wish direction: same gain law, same
ceiling, same everything. Pressing A or D drops the assist mid-ramp with no transition,
because the player's own input is simply read first.

Which key it is comes off **the ramp**, not the player: a surface's normal leans downhill, so
the negated horizontal part of the normal is the direction that climbs it, and whichever
strafe key points nearest that is the one a surfer would be holding. The face is remembered
from the collision itself (`noteRideSurface`, off the hit in `tryPlayerMove`) with a 0.35 s
hold, because a rider is not in contact every tick — clip, fly, clip again — and an assist
that strobed would be a key hammered rather than held, which the gain law pays out on
neither.

### Two dead ends worth recording

**Deriving the key from which way the view is sweeping.** This was the original design, on
the theory that a surfer turns into the key they hold. They do — but a beginner who sweeps
the *wrong* way then gets the matching wrong key and slides off exactly as before, which is
the single case the mode exists for. Measured: wrong key against a wrong-way sweep, off the
low edge in 0.83 s. The ramp has no such opinion, so the ramp decides.

**Handing back the world-space uphill vector instead of a key.** It holds the player on the
face beautifully and pays out **no speed at all** — a wish direction that does not turn with
the view cannot compound, so sweeping the mouse changes nothing. That is an autopilot, not a
training wheel: it would keep a beginner alive while teaching them that the mouse does not
matter, which is the opposite of the lesson. Routed through the view instead, the mouse is
still the only thing making speed, and graduating is just pressing the key yourself.

### Verified

`.probe-assist.ts`, 10 green against a 51.34° face. Unassisted, W held: off the low edge in
1.13 s. Assisted: still riding at 3 s, within 0.11u of the same line as the uphill key held
by hand — and 35.8u from where the *other* key ends up. W released, or no ramp under you, or
`AIR_FORWARD_INPUT` on, and it is bit-identical to no assist at all; press a strafe key and it
is bit-identical to that key alone, wrong key included.

One thing this rig cannot show, so nothing here claims it: **speed gain**. The test slab is
18 units wide, so a correct strafe climbs it and runs out of ramp in a second or two with no
descent to give the height back — every correct line reads as a speed *loss* on a slab that
short. Gain needs a real ramp and a human; that is what the mode has to be judged on in play.

---

## v3 — Strafe Only

**W and S are only live when you are standing on a flat surface.** In the air — which is
every tick of every surf, since a ramp's normal is deliberately below the 0.7 walkable
cutoff — the wish direction is built from A and D alone. One knob, `AIR_FORWARD_INPUT`
(*W/S in air* in the tuning panel), off by default; on restores CS:S exactly.

Judge this build on whether a line ever gets away from you for a reason you did not choose.
Ground movement, jumping and the strafe maths itself are untouched.

### Why W was never doing what it looks like it does

Holding W on a ramp is not a small mistake, and it is not mainly about falling off the low
edge. It deletes the acceleration.

`airAccelerate` may add at most `AIR_SPEED_CAP - (v · wishDir)` along the wish direction per
tick (30 hu = 0.667 u/s). Riding at 20 u/s with W held, the wish direction points along
travel, so `v · wishDir ≈ 20` — twenty times past the cap. `addSpeed` comes out negative and
the function returns having added **nothing**. A W+A diagonal is barely better: `v · wishDir`
is still ~14, still far past the cap, still nothing. Only A on its own keeps the wish
direction near-perpendicular to travel, where `v · wishDir ≈ 0` and every tick pays out the
full cap.

S is worse in the opposite direction. It puts `v · wishDir` deeply negative, so `addSpeed` is
huge, nothing clamps it, and the tick runs at the accelerator's uncapped magnitude —
`AIR_ACCEL × wishSpeed × dt` = 100 × 7 / 128 = **5.47 u/s applied straight backwards, every
tick**. Measured airborne at 18 u/s with S held: `vz` goes −18 → −12.53 → −7.06 → −1.59 →
**+0.667**. Three ticks, 23 ms, and you are stopped; hold it and you are travelling backwards
pinned at the 30 hu cap.

So the two keys a new player reaches for first are, respectively, "turn the strafe off" and
"hit the brakes". A CS surfer knows to keep both hands off them; that knowledge is now
built into the controller instead of assumed.

### Where it lives

`PlayerController.wishDir` zeroes `moveForward` unless `this.grounded`. That flag is the
game's own definition of flat — walkable normal, not a wall, per `categorizePosition` — so
"flat surface" needed no new test and cannot drift away from what grounds the player.
`InputSystem` is unchanged: it still reports the keys honestly, and the controller decides
what they mean, because the input layer has no idea what the player is standing on.

One tick's worth of nuance: `wishDir` is computed before `CheckJumpButton` clears the ground
flag, so the tick you jump on still reads W. That is one tick of a ground-derived wish
direction on the way up, which is what Source does too (one usercmd, built once per tick).

Verified by `.probe-wsflat.ts`, 14 green against a real 51.34° face: the ramp never grounds
the player; W+A and S+A ride *bit-identically* to A alone (position delta 0); W alone in the
air is indistinguishable from no keys at all; W and S still walk on flat ground; the jump
tick keeps its W and the tick after it does not. With `AIR_FORWARD_INPUT` on, the same ride
reproduces the CS numbers above — W+A gains nothing where A alone gains, S+A sheds a third
of its speed in 0.375 s.

---

## v2 — Clean Seams

One bug, chased to the bottom: **a surfing player stopped dead at the join between two ramp
pieces.** Nothing about the movement maths changed; what changed is that a piece's leading
edge is no longer a wall.

Judge this build on one thing: ride the long banked run and see whether you ever get
snagged. Everything else should feel identical to v1.

### What was actually stopping you

Not the visible corner of the ramp. `Colliders.registerPrism` closes every collision wedge
with side planes built as `edge × (0,-1,0)` — **exactly vertical, whatever shape the edge it
came from has**. At a strip's first and last ring those planes face straight back along
travel, so they are a wall across the whole width of the piece. Clipping against one deletes
the player's entire forward component.

Two things put you in front of one:

1. **A crack at every curved join.** `RampLibrary.faceRings` builds ring `i` at the segment
   *boundary* `frames[i].start` but with that segment's *midpoint* basis, so a piece's two
   end rings each sit half an angle step (0.978° at the stock 45°/23 segments) off their
   nominal heading. Two pieces snapped socket-on-socket therefore meet with a full step of
   yaw discontinuity in the width axis, opening a triangular notch — nil at the ridge, **0.19
   at the low edge**, right where a surfer rides. Measured on the shipped course:
   **22 of 31 face-joins left an exposed cap.** The same sampling choice is why every "45°"
   curve reports an exit heading of 44.02°, which is why the map's chained yaws read
   22.5 → 66.52 → 110.54.
2. **Authored gaps.** Most joins on the course are hand-placed with several units of air.
   Arrive below the next piece's leading edge and you hit that wall head-on.

This is the third time this bug class has been found, in three different clothes: box
end-caps between segments, then a level piece butted against a pitched one (*"30 u/s in,
6.4 u/s out"*), now piece joins. Welded wedges fixed it **within** a piece. Nothing had ever
fixed it **between** pieces — and nothing had ever driven a probe down the hand-placed
61-piece course to notice.

### The fix, in two halves

**Geometry — `RampLibrary.emitStripColliders` now pads both ends of a strip.**
`computeRampFrames` has always computed exactly the right number for this (`overlapPad`,
sized to the daylight half a step of rotation opens across the face) and the old box builder
has always used it; the prism path simply never picked it up when collision moved to welded
wedges. Collision only — the visible skin is untouched, so nothing lengthens on screen.
Floored at 0.05 for single-segment pieces, whose own pad is zero and which still crack by a
few thousandths from float noise at map-scale coordinates — *worse* than a wide crack,
because a hit inside `SKIN_WIDTH` yields exactly zero progress.

**Engine — `Raycast` declines a cap plane for an airborne player.** `registerPrism` takes a
`capEdge`, `emitStripColliders` tags the two terminal prisms, and `rayIntersectConvex` reports
a miss when the ray's *entry* plane is that cap. This loses nothing: a ray that would land on
the ride surface enters through the **top** plane, which is what raises `tMin` last in that
case, so it is still reported. What is dropped is only the head-on strike. Real surf maps make
the same call — the CS2 guide's ramp method leaves the leading clip a thin shell rather than a
solid end, so an undershoot passes *under* the ramp instead of splatting on the front of it.

Airborne only. A grounded player walking into the end of a ramp still meets a wall.

### The wrong version of the engine half, on record

The first attempt bailed out of the bump loop on a cap hit, keeping velocity — the same shape
as the existing duplicate-plane rule. It reads fine and it is badly wrong: the player is
**pinned in place with velocity intact**, which a speed-based stall test cannot see.
Measured 0.0% of `|v|·dt` realised over a 45-second run, 5755 near-zero-progress ticks out of
5760. If you ever reach for that shape again, measure displacement, not speed.

### Measured, on the shipped course

Probe: the real `PlayerController` at 1/128 s over the real `buildFreeWorld` colliders, seeded
on all 52 ramp pieces × 7 lateral positions × 4 entry speeds. Stalls judged by **absolute**
one-tick speed loss ≥ 4 u/s — gravity alone is 0.139 u/s per tick and the steepest legitimate
deceleration on this map is ~0.114, so 4 is ~30× anything physical.

```
                                    v1        v2
butt joints with an exposed cap    22/31     2/31
stalls (of 2632 seeds)               471      180

  by piece type:
    horizontal-curved-full           176        0
    vertical-curved-full              98        0
    horizontal-curved-half-l          40        0
    horizontal-curved-half-r          14        0
    straight-full                     21        0
    straight-inverted                108      164
    pyramid-full                      14       16

  blocking surface:
    ramp face                        213      174
    CAP (end plane)                  209        6
      ... inside SKIN_WIDTH           70        2
    lateral side wall                 49        0

displacement realised                  -   100.0%
prism count                         3412     3412
```

**No stall remains on any surface you are meant to surf.** The 2 residual exposed caps are
both a genuine 1.4-unit authoring gap at one join (two pitched straights), not a geometry
defect — a map problem.

### Two things this did not fix, deliberately

- **The bottom of a V channel is still a wedge.** All 164 remaining `straight-inverted`
  stalls are a player who slid to the valley floor and stuck in the crease — they fire at a
  speed-*independent* tick (t=60 at every entry speed, ~3.7 units into a 50-unit piece), so
  they are the floor, not the join, and only the two lateral positions nearest the valley line
  produce them. Pre-existing, and Source's reverse-stop would do the same in an acute corner —
  real surf channels are ridden on the walls. Note the count went **up**, 108 → 164, because
  pieces that used to stop you at the cap now let you carry speed into the valley. Fixing it
  means rounding the valley, which is a level-design decision, not a collision one.
- **`MAX_GROUND_SPEED` still clamps actual velocity, not just `wishspeed`**
  (`PlayerController.tick`). Source's `WalkMove` clamps `wishvel`/`wishspeed`; the only
  post-`Accelerate` magnitude test is `if (spd < 1.0f)`, a *minimum*. So one grounded tick at
  30 u/s truncates you to 7 and `stayOnGround` holds it. On this course no ramp face is
  walkable (every bank is 51.34°, `normal.y` 0.625; pyramids are 55°, 0.574) so it can only
  fire on the 8 checkpoint pads and the spawn pad — but two of those are 2×2 clusters
  directly on the route. It is a feel change and belongs in its own build.

Also unchanged and still the named next candidate: the real 32×32×72 swept hull. It would not
have fixed this — a hull crossing the crack still meets the cap plane — and it moves where the
player contacts every banked face, so it deserves its own before/after rather than riding
along with a bug fix.

### Diagnostics

`setMoveDiagnostics(sink)` in `PlayerController` names every site that can destroy velocity
(`max-clip-planes`, `no-satisfying-clip`, `degenerate-crease`, `reverse-stop`, `no-progress`,
`duplicate-plane-bail`, `ground-speed-clamp`). They cannot be told apart from outside — all of
them leave the same zeroed velocity — and working out which one fired was the hard part of
this bug all three times. Null by default; the call sites are `?.()`, so it costs a handful of
undefined-checks a tick and allocates nothing.

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
