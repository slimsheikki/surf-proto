# State — 2026-08-01

Living handoff doc. Read at session start, update before finishing. Keep it short:
delete anything resolved rather than accumulating history.

## Known bugs

### 1. The approach entry doesn't work — BLOCKS PLAYTEST

Walking forward off the elevated start pad, no steering, sampled once a second:

```
0s:1u@y56  1s:7u@y55  2s:7u@y55  3s:12u@y45  4s:17u@y24  5s:17u@y-14
6s:17u@y-70  7s:17u@y-144 ... 11s:17u@y-617
peak 16.7 u/s | surface contact 357/1536 ticks (23%)
```

The player **free-falls straight past the descent ramp** instead of landing on it. Speed
pins at 17 (terminal-ish, no surf accel) and altitude falls without bound. In-game the
out-of-bounds recovery catches it, but the entrance the user asked for — "higher start,
ramp going down, then straight ahead toward the boss circle" — does not function.

Suspects, in order: the start pad's lateral placement vs. the banked descent face's
centreline (`PLATFORM_OUTWARD_OFFSET`), or `descentStart` sitting such that a 7 u/s
walk-off exits past the face's high edge. Fix is narrow and well-diagnosed.

## Verified good

**Ramp collision (15-axis SAT over all 27 colliders, 12 ramp faces):** the 10 ring ramps
have **zero intersections and zero clearance violations**; closest non-touching pair is
1.602 units. The one reported overlap — `ramp[10]` vs `ramp[11]`, 1.680 — is the two
approach pieces and is **deliberate**, see below.

**Why the approach seam overlaps on purpose.** A banked piece's trailing edge stops being
perpendicular to travel once the piece is *also* pitched: rolling the width axis about a
downward-tilted forward gives that axis an along-travel component, so the edge rakes
forward on the high side by `(width/2)·sin(roll)·sin(pitch)` = 2.63 units here. Butt the
pieces at their nominal joint and the level straight's leading cap protrudes *through* the
descent surface as an uphill wall, which `clipVelocity` resolves by deleting forward
velocity — measured **30 u/s in, 6.4 u/s out**. So the straight is built from
`APPROACH_SEAM_BURY` further back and lengthened to match, burying that cap. Commit
`8c80cc2`. **The overlap is the fix — don't "clean it up."**

Also verified: air-strafe gain, bunnyhop retention (±0.0% over 6 hops), XP magnet at all
speeds (100% collection), boss escape thresholds (25/30/45 u/s by phase).

## Current level constants (`src/world/SurfCourse.ts`)

```
TRACK_RADIUS 90   WOBBLE ±3        LOOP_SEGMENT_COUNT 10   TRACK_Y 0
RAMP_LENGTH 50    RAMP_FACE_WIDTH 18   RAMP_ARC_GAP 6.55   ISLAND_RADIUS 40
START_PLATFORM_TOP_Y 55   APPROACH_DESCENT_PITCH_DEG 22   APPROACH_STRAIGHT_LENGTH 70
```

Gaps were tightened from the friend's "hard to keep momentum" note; the ~6.55 arc gap
still needs a human re-test once the approach is fixed.

## Open design questions for the user

- **The knife can never reach the boss.** `Knife` measures true distance from
  `target.position`, while `Boss.distanceToPlayer` subtracts a ~95-unit engagement radius
  so a hitscan gun can engage it. Reusing that would let a 3.5-unit melee weapon hit from
  across the arena for ~145 DPS in total safety. Consequence as built: the knife and its
  speed bonus are irrelevant in the endgame. Deliberate, but worth a decision.
- **XP orbs and player bolts are both cyan** (`0x7fe8ff`). Shifting orbs toward aqua-green
  would separate them.

## Next up

1. Fix the approach entry (bug 1), then re-run the flow probe.
2. Items / level-up powerups: two lists of 10 were delivered, **none implemented** —
   awaiting the user's pick. Suggested starting with 4–5 items plus the knife.
3. Re-test gaps with the friend once deployed.
4. `README.md` points at a `docs/` CS:S surf design reference that was never written — the
   agent assigned to it died. Either write it or drop the reference.

## Probes

Throwaway verification harnesses live at `.probe-*.ts` / `.probe-*.mjs` (gitignored,
esbuild-bundled and run under node). The SAT overlap + approach-flow probe was deleted;
rewrite from the numbers above if needed.
