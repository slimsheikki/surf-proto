# State — 2026-08-02

Living handoff doc. Read at session start, update before finishing. Keep it short:
delete anything resolved rather than accumulating history.

## Revert point

**Commit `ed58d05` is the last build before the free-map editor rework** (modular ramp
library + spline tool). It is on `claude/dash-mechanic-rework-z1o7r9` at origin and tagged
`backup/pre-editor-rework` locally (the remote refuses tag pushes). If the new editor breaks
the game: `git checkout ed58d05`.

## Known bugs

None blocking. The approach entry is fixed — see below.

## Free-map editor rework (new)

The editor is now built on a **modular ramp library** (`src/editor/RampLibrary.ts`),
following the two specification docs (modular kit + editor rework) and the vendored
CS2 guide's taxonomy:

- **`RampDefinition[]` is data.** Families: straight, trapezoid, reverse-trapezoid,
  pyramid, slide, vertical-curved, horizontal-curved, platform. The palette, the piece
  builder and the spline generator all read the list; adding a family is adding an entry.
- **Variants:** half = one banked face; full = A-frame (two faces meeting at a ridge);
  inverted = V channel. The composite emitter offsets each face from the centre path
  **per segment frame** along that frame's own rolled basis, so the ridge/valley
  coincides with the path exactly on straight *and curved* paths — vertical-curved
  full/inverted and horizontal-curved full exist because of this (probed: ridge height
  mismatch 0.0000 across the dive). The **pyramid** is a true four-faced apex: each
  triangular face is built along its fall line (base-edge midpoint → apex) with zero
  roll, which keeps the taper's stepped boxes coplanar — smooth faces, not staircases.
- **Segment seams overlap, not gap.** A rotated segment chain only meets on the
  centreline; at the face edge each seam opened `2·sin(step/2)·(w/2)` of daylight —
  visible on every curve. Boxes now carry `overlapPad` extra length (mesh *and*
  collider), the same fix the CS2 guide's curved-ramp method uses ("slide the edges so
  the faces overlap"). Probed: zero disjoint neighbouring boxes on a 45° curve.
- **Sockets:** every ramp exposes entry/exit (`piecePath`) computed from the *same*
  `computeRampFrames` walk that builds the mesh (`RampCurve.ts` refactor), so sockets can
  never drift off the geometry. Dragged/dropped pieces snap onto nearby sockets, adopting
  the exit heading (radius 6, off with `N`).
- **Spline tool** (`P`, `src/editor/SplineGen.ts`): click to lay guide points; a
  Catmull-Rom curve regenerates library pieces along itself on every edit — straights on
  straight spans, horizontal curves banked into bends, vertical curves on slope changes,
  chained socket-to-socket with a 3-unit gap. The spline is a planner, never geometry;
  generated pieces are ordinary `FreePiece`s and hand-placed pieces are never touched.
  Verified headless: chain gap error 0.0000 over a 7-piece L-shaped descent.
- **Multi-selection:** shift-click; drag moves the group, Q/E rotates it about the
  centroid (sign verified against `forwardXZ` — a slip there shears chains), Ctrl+D
  duplicates, Del deletes.
- **Map format v2** (`FREE_MAP_VERSION = 2`): pieces store a `def` id plus optional
  `endWidth` / `yawSweepDeg` / `endPitchDeg`; the map stores its spline. v1 maps load
  losslessly (every v1 piece was a straight half-face); unknown def ids degrade to
  `straight-half` rather than dropping the piece. Share codes carry the new fields only
  when set.

**Deferred from the specs, knowingly:** layers/hierarchy with visibility & locking
(multi-select and grouping-by-selection exist; named groups do not), InstancedMesh
batching (box-segment meshes are cheap at current counts), full/inverted variants of
*tapered* families (trapezoid/rev-trapezoid — converging face paths off the fall line
are not exact in this construction), spline width-awareness (a guide curve has no
width, so trapezoids are never auto-chosen), and thumbnails in `RampDefinition`.
Note `pyramid-half` was briefly a flat tapering face; that id is retired and any piece
saved with it degrades to `straight-half` on load.

Play-mode is untouched: `buildFreeWorld` routes ramps through the same library builder
with colliders on, and gameplay code did not change.

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

## Endless runs (new)

A run has **no win condition**. Felling the Monolith is a milestone, not an ending;
`GameState` lost its `victory` member and `VictoryScreen` is gone, replaced by
`src/ui/Banner.ts` — a transient headline that pauses nothing and takes no click, because
the kill usually lands mid-air on a ramp and a modal there would drop the player off the
course as its reward for winning.

- **`src/enemies/Difficulty.ts` is the single source of truth for scaling.** `difficultyAt(level,
  elapsedSeconds)` returns drone/seeder stats, spawn interval, batch size, and the live cap.
  Time carries the first minute (those ramps are the original tuning, unchanged), level
  carries everything after and is never capped out.
- **Verify against level 1 when touching that file.** At `t=120, level=1` it must still read
  `hp 40, speed 12, interval 1.2, batch 2, cap 32` — the pre-endless numbers. A first draft
  divided an unfloored time term by the level term and silently tripled the early-game spawn
  rate; `TIME_FLOOR_SPAWN_INTERVAL` exists to stop exactly that.
- **Monoliths recur every 10 levels**, scaled by `bossScaleFor(index)` — HP ×1.8 per
  encounter, damage ×1.22. HP grows faster on purpose: by the second one the player has
  twenty upgrades and needs the fight to have length, while the attacks stay dodgeable
  patterns whose difficulty should come from holding a line.
- Killing one grants `XP_PER_BOSS`. Not flavour: drone spawning is suspended for the whole
  fight and drones are the only XP source, so without it a boss fight left the player
  *further* from the next one.

### The seeder (new enemy)

`src/enemies/Seeder.ts` + `src/combat/Blast.ts`. A violet octahedron that flies like a drone
(same interception solve, slower) but instead of ramming plants a **`Blast`** — a telegraphed
sphere that fills up over a 1 s fuse and then damages anything inside once.

The two numbers are the mechanic: escape speed is `RADIUS / (FUSE - LEAD)` = **10 u/s**.
Walk speed is 7 and a surf line is 20-40, so a blast is lethal to a player who has stopped,
botched a landing, or hovered to fight, and irrelevant to one who is actually surfing. That
asymmetry is the whole reason it exists — it is the enemy that punishes *not* surfing, which
is the one thing the combat layer is otherwise unable to do.

Two things about it that look like details and are not: it is a **sphere, not a ground disc**
(the player is airborne against a banked wall most of the time, so a circle on the floor is
unreadable), and the wireframe shell sits at full radius from frame one while only the fill
grows (the boundary must not move while you are trying to leave it).

### Sharing maps (new)

`src/editor/MapCode.ts` turns a map into a pasteable string, because there is nowhere to
upload one to — Pages is static, and `localStorage` is per-browser. **Share** copies a link
like `…/surf-proto/#map=<code>`; opening it drops the map into the recipient's editor,
unsaved, name pre-filled. **Import** takes the same string pasted back (a bare code or a
whole URL both work).

- Pipeline is JSON → deflate (`CompressionStream`, native, no dependency) → base64url, behind
  a one-char tag: `1` deflated, `0` plain. The tag is **not** `FREE_MAP_VERSION` — that
  versions the map's shape and `parseMap` already checks it; the tag versions the envelope,
  which `parseMap` never sees.
- The payload rides in the URL **fragment**, so it is never sent to a server and no host's
  URL-length limit applies. Measured: 3-piece starter 289 chars, 33-piece Mickey ~600,
  worst-case 200 unsnapped pieces ~8.5k. The panel shows the length and warns past 2000.
- `id` is dropped before encoding (`parseMap` regenerates it anyway) and numbers are rounded
  to 2 dp — a hundredth of a game unit is 0.45 Hammer units.
- Decoding is fully defensive: byte cap before *and* after inflating, everything in
  try/catch, and the result goes through the same `parseMap` that guards `localStorage`.
  Returns null, never throws.
- **Imported names are uniqued** (`MapStorage.uniqueMapName`). `saveMap` keys by name and
  overwrites, so an incoming "Mickey" would otherwise destroy the recipient's own on first
  Save.
- The hash is cleared with `replaceState` right after importing, or the recipient's next
  refresh silently reverts their edits to the shared version.
- `Editor.onKeyDown` now uses the exported `Input.isTextEntryTarget` instead of its own
  `INPUT`-only check — without that, typing a pasted code into the panel's textarea flies
  the free camera.

### Testing the late game

`window.__surf` is the live `Game`, set in `App.beginRun` behind `import.meta.env.DEV` (Vite
folds it out — `grep __surf dist/` is empty). It exists because ten levels and a 2200 HP boss
are unreachable by scripted input, so without it the endless path can only be tested by
playing it. Verified through it: seeders and blasts spawning, boss kill → run continues →
second Monolith at 3960 HP → death → restart clears the ladder.

### Dash

Shift spends one of the player's rechargeable dash charges (start 2, recharge one every 6 s,
`src/player/Dash.ts`) to fire `PlayerController.dashImpulse()`: a one-shot 8 u/s shove along
the facing direction, yaw only. It is an impulse, not a buff — nothing lingers past the tick,
so the dash reads as a *redirect* (snap momentum toward where you're looking) rather than a
speed upgrade. Pitch is excluded on purpose; inheriting it would make a look-up dash a free
ascent, and height has to be earned off a ramp.

Earlier versions instead armed `grantMomentumBoost()`, the half-second accel the level-up menu
grants on close. That is now the level-up trigger's alone — the dash no longer grants any
sustained speed.

Visuals live in two places and are deliberately separate from the impulse itself, so removing
either never touches movement:
- `ViewModel.triggerDash()` — a single decaying brace pose on `root` (both hands), composed
  additively with the idle bob/sway rather than overwriting it (`updateIdle` sums bob + sway
  + kick into one `.set()`, the same way the slash's `arm` offsets sum onto `RIGHT_ARM_BASE`).
- `src/ui/DashEffect.ts` — anime speed lines (`repeating-conic-gradient` masked to a hole at
  screen centre so the crosshair stays clear), driven imperatively from `tick(dt)` like
  `Banner`, not a CSS animation/transition. That was a deliberate choice after the first pass:
  a CSS `@keyframes` animation needs a forced-reflow restart to fire on a rapid re-trigger, and
  the imperative version sidesteps that by just resetting a `remaining` counter. An earlier
  version also kicked up four puff-cloud blobs behind the player; those were cut — the lines
  alone carry the readout.

There is no dedicated test harness for this yet beyond a manual Playwright smoke pass
(dash consumes a charge, adds forward velocity, shows/hides the effect on schedule).

## Free mode

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
