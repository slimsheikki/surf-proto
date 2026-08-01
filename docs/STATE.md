# State — 2026-08-01

Living handoff doc. Read at session start, update before finishing. Keep it short:
delete anything resolved rather than accumulating history.

## Known bugs

None blocking. The approach entry is fixed — see below.

## Verified good

### The approach descent — rebuilt as a staircase

The old single 121-unit descent was **not completable by anyone**. A banked face carries a
player only as far as its bank lets them cross it — about 1.5 s uncorrected, ~3 s with good
strafing — so entered at a walk it gives **45-55 units of run and no more, at any pitch**.
Raising pitch shortens the run needed but does not lengthen the ride, so the two only meet
under ~45. Widening the face is not a lever either: a wider face's high edge stands
`FACE_SIN * width / 2` above its centreline and pokes up through the start pad; measured at
width 36 the player never got off the pad at all (peak 7.1 u/s).

Now two ~30-unit faces at 26 deg, bank **alternating**, staggered 6 sideways, 4-unit gap.
Three things had to be right, each found by probe rather than by eye:

1. **Alternating bank** — mirroring the next face puts its high edge where the previous
   face's low edge drops the player.
2. **Lateral stagger** (`APPROACH_STAIR_LATERAL`) — a player leaves over the *low edge*
   partway along, still carrying lateral drift, so the next face must sit further along
   that drift or it slides past out of reach. With no stagger every test fell into the gap.
3. **Exit height** (`APPROACH_STAIR_EXIT_Y`) — the subtle one. Landing the last face's
   centreline on `TRACK_Y`, level with the straight, put the player 7 units *under* the
   straight's surface, because they ride the low edge and not the centreline. Every
   ballistic exit missed: **0/45**. The chain now finishes one vertical half-span higher.

Ballistic handoff coverage, over exit points 70-100% along, speeds 16-34 u/s, drifts
3-7 u/s: **face0 to face1 34/45, face1 to straight 43/45**. Remaining failures are 16 u/s
with heavy sideways drift (no attempt to hold a line) and 34 u/s, above what face 0 can
build from a walking start. Sub-100% is correct — bail early off a face and you *should*
miss.

The staircase gap is 4, tighter than the ring's 6.55: approach speeds are lower and airtime
is where drift accumulates unchecked.

### Ramp collisions — clean

15-axis SAT over 28 colliders grouped into 27 pieces. Of these, **13 are ramp faces** (10
ring + 2 staircase + 1 straight): **zero intersections, zero clearance violations, closest
non-touching pair 1.602 units.**

Two sets of overlaps exist and both are deliberate:
- The 12 island rim boxes overlap each other and the island body — they approximate a
  cylinder.
- The **re-entry checkpoint platform** is buried in segment 0, segment 9 and the approach
  straight (6.341 / 0.445 / 6.341). Documented in `SurfCourse.ts`: it is deliberately three
  times longer than the gap it sits in so the player cannot miss the checkpoint on the way
  in. The start pad, by contrast, touches nothing.

The old `APPROACH_SEAM_BURY` is **retired**. It existed because a level piece butted against
a pitched one had its leading cap protruding through that piece's surface as an uphill wall
(a banked piece's trailing edge rakes forward by `(width/2)·sin(roll)·sin(pitch)` once
pitched; 30 u/s in, 6.4 u/s out). The staircase reaches the straight across a gap instead,
and open air cannot rake into anything.

Also verified: air-strafe gain, bunnyhop retention (±0.0% over 6 hops), XP magnet at all
speeds (100% collection), boss escape thresholds (25/30/45 u/s by phase).

## Free mode (new)

Second game mode, chosen from the main menu at boot. The player flies a free camera,
drags ramps out of a side palette into the world, moves them in 3D, deletes what they do
not want, and presses Play to surf what they built. Maps persist in `localStorage`.

**The run itself is exactly Standard's**: drones, XP, level-up choices, and the Monolith at
level 10 — over whatever position the player dragged the boss cylinder to. Free mode
changes the course, not the game.

```
src/app/App.ts          menu / editor / play switcher; owns renderer, scene, the one camera
src/ui/MainMenu.ts      mode select (click or 1/2)
src/editor/MapData.ts   FreePiece / FreeMap, the 6-entry palette, the generated starter map
src/editor/MapStorage.ts localStorage table + last-opened pointer, every access try/caught
src/editor/FreeCourse.ts builds meshes (+ optional colliders) from a map; emits a GameCourse
src/editor/Editor.ts    fly camera, selection, drag placement, keyboard transforms
src/editor/EditorUi.ts  palette DOM, save/load toolbar, status line
```

Things that are load-bearing, in the same sense as the invariants above:

- **The editor registers no colliders.** `registerCollider` caches an inverse quaternion
  per box and there is no way to retire one, so a drag — which rebuilds the piece's meshes
  every step — would pile up thousands. `buildRampCurve` takes `registerColliders: false`
  for this. The collidable world is built once, from the map, on Play.
- **`Game` is constructed at most once**, then re-pointed with `setCourse`. `GameOverScreen`
  and `VictoryScreen` bind their restart listeners in their constructors, so a second
  `Game` puts two listeners on one button and every restart fires twice.
- **A `FreePiece`'s position is the centre of its face centreline**, not the leading edge
  `RampCurve` takes. Rotation about any other anchor swings the piece out from under the
  cursor mid-drag. `FreeCourse.pieceStart` does the conversion.
- **Free maps get one global kill plane** (`GameCourse.killPlaneY`), not the standard
  course's per-stage one — a player-built course can climb or loop, so there is no "next
  platform" to hang it under.
- **The boss cylinder is placeable**, and is the only thing that decides where the level-10
  fight happens: `buildFreeWorld` hands its top-surface centre to `GameCourse.islandCenter`
  and `trackY`, which is what `Boss` anchors its hover and engagement radius to. Its
  `trackRadius` is the distance to the furthest piece, clamped to 50-140 so the boss can
  cover a small arena without sniping across a large one.
- **The start pad and the cylinder are selectable and movable but never deletable** —
  no pad means nowhere to spawn, no cylinder means nowhere for the boss to arrive. The
  toolbar's delete button disables itself on both rather than failing when pressed.
- **Editor look is on the right mouse button, not pointer lock.** Under lock the cursor is
  hidden and every click goes to the canvas, so a palette to drag from could not coexist
  with it.
- Framing the opening view fits the map's **bounding sphere at `r/sin(halfFov)`** (not
  `r/tan`, which leaves the camera inside the sphere) and swings 38° off the map's heading,
  or the whole course foreshortens into a smear at the horizon.

Verified in a browser: menu → both modes; drag-drop placement; drag-move in 3D; rotate /
pitch / bank-flip / raise; deletion by button and by `Del`, with both refused on the two
fixtures; save, load, delete, and survival across a page reload; Play and `M` back to the
editor; a free run accelerating 7 → 16.9 u/s off a descent; fall recovery onto the start
pad. Standard mode behaves as before.

Not done, deliberately: no undo, no piece resize, and **no in-editor check that a chain is
rideable** — the player is trusted to sort that out, and the palette presets are all shapes
that already work in the standard course.

## Current level constants (`src/world/SurfCourse.ts`)

```
ring:      TRACK_RADIUS 90  WOBBLE +/-3  LOOP_SEGMENT_COUNT 10  TRACK_Y 0
           RAMP_LENGTH 50   RAMP_FACE_WIDTH 18  RAMP_ARC_GAP 6.55  ISLAND_RADIUS 40
approach:  START_PLATFORM_TOP_Y 55  APPROACH_DESCENT_PITCH_DEG 26
           APPROACH_DESCENT_FACE_COUNT 2  APPROACH_STAIR_GAP 4
           APPROACH_STAIR_LATERAL 6  APPROACH_STAIR_DROP 10.5 (0.75 x face height)
           APPROACH_STAIR_EXIT_Y 9.03 (one vertical half-span + 2)
           APPROACH_STAIR_RUN 30.2 (solved)  APPROACH_STRAIGHT_LENGTH 70
```

`APPROACH_STAIR_RUN` is solved from the others, never authored. **Invariant: it must stay
under ~45**, or the faces are longer than a player can ride and the descent breaks again.

Ring gaps were tightened from the friend's "hard to keep momentum" note; the ~6.55 arc gap
still needs a human re-test.

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
5. Free mode wants a human pass on the palette: six presets is a guess, and whether the
   26° descent and the 50-unit level ramp are the right two defaults is an aesthetic call.

## Probes

Throwaway verification harnesses live at `.probe-*.ts` / `.probe-*.mjs` (gitignored,
esbuild-bundled and run under node). The SAT overlap + approach-flow probe was deleted;
rewrite from the numbers above if needed.
