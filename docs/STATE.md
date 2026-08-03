# State — 2026-08-02

Living handoff doc. Read at session start, update before finishing. Keep it short:
delete anything resolved rather than accumulating history.

## Revert point

**Commit `ed58d05` is the last build before the free-map editor rework** (modular ramp
library + spline tool). It is on `claude/dash-mechanic-rework-z1o7r9` at origin and tagged
`backup/pre-editor-rework` locally (the remote refuses tag pushes). If the new editor breaks
the game: `git checkout ed58d05`.

## Movement — under active review

`docs/MOVEMENT_VERSIONS.md` is the log; **`MOVE v1 · Source Parity`** is what is deployed.
The controller is now a full port of `CGameMovement::FullWalkMove` / `TryPlayerMove` rather
than a sketch of it: split gravity, 4 bumps with plane accumulation and crease handling,
Source's ground-state rules, and the CS:S constants. Two behaviour changes the user will
notice immediately and is reviewing:

- **The landing redirect is off** (`MovementConfig.SURF_LANDING_REDIRECT`). Dropping off the
  start pad reads 17.4 u/s where it read 33.4. The code is still there behind the flag.
- **`sv_airaccelerate` is 100**, the surf-server value, up from 12.

`O` opens a live tuning panel (pauses the sim, hands back the cursor, sliders in CS convars
with Hammer units alongside). Panel values are *preferences* and survive a run reset —
`setMovementPreference` keeps them apart from the upgrade pool's writes to the same object,
which must not survive.

Awaiting the user's verdict before v2. Candidates already identified: a real 32x32x72 swept
hull instead of the flat ray ring, and ducking.

## ReWind — the ultimate (new)

Hold **R** with the ultimate bar full and up to **15 seconds of the run play
backwards**; let go anywhere in that window and play resumes from there after a
3-2-1 countdown. Three files: `src/game/Ultimate.ts` (the meter),
`src/game/Rewind.ts` (the recorder), `src/ui/UltimateEffect.ts` (the visuals).

**The recorder stores state, never diffs.** That is what makes "rewind the
powerups too" tractable: an upgrade is an arbitrary mutation (`maxHp += 20`,
`rechargeSeconds = max(1.5, x - 1.2)`) and inverting one is not something the
upgrade pool can be asked to support. A frame carries the *result* — weapon and
knife stats, perks, magnet radius, the three `MovementConfig` fields upgrades
touch, HP, the level system, the dash economy, the run clock, shrine flags, and
every live enemy and orb. A new upgrade is rewound correctly the day it is added
as long as the field it writes is in `Frame`.

Load-bearing details, each of which cost something to find:

- **32 Hz ring buffer, not 128.** A frame carries the whole entity list; at tick
  rate that is 4x the memory for fidelity nobody can see. The player's transform
  is interpolated between frames (the eye tracks it), everything else snaps.
- **`Enemy.rewindId` / `XPOrb.rewindId`.** Reconciling the live list against a
  recorded frame *by index* is wrong the moment anything was culled — the arrays
  are spliced, so everything after the gap would be teleported into its
  neighbour's slot. Ids are matched, so the common case (nothing changed) does no
  work and a rebuilt enemy resumes being the same enemy.
- **The window is cut at a Monolith arriving or falling** (`Game.bossEpoch`).
  Un-felling a boss means restoring a 786-line state machine; letting the kill
  stand while its XP is rewound away is a worse deal than not offering it.
- **The charge is spent on activation, not completion.** Releasing R after half a
  second still costs the ultimate — a refundable rewind is a free scrub through
  the last fifteen seconds, which is a different and much weaker mechanic.
- **Look is live during the countdown, nothing else is.** The player has just
  watched the run go backwards and is usually mid-air on a ramp.
- **`Ultimate`'s `LEVEL_GROWTH` is 0.07 because `difficultyAt`'s spawn interval
  divides by `1 + 0.07n`.** Matching them makes the kill term level-neutral by
  construction. **If that divisor is retuned, move this with it.** Measured fill
  times against modelled kill rates: 45 s at level 1, 44 s at 10, 46 s at 20.

Known limits, all deliberate: live blasts are cleared and not restored (they live
~1 s, and the seeders come back and re-plant); enemy internals (heading, aim
error, contact cooldown) do not travel, only position and health; and the ability
cannot be fired from the game-over screen, so it saves a doomed fall but not a
death.

Verified headless (`.probe-rewind.ts`): a 7 s rewind across three upgrade picks,
a level-up, a collected shrine and a wiped enemy wave restores all of it —
position drift 0.000, and the scene child count comes back exactly, so nothing
leaks. Browser pass: charge → ready flames → activation → countdown → resume,
no console errors.

## Blessings respawn (new)

A collected blessing vanishes rather than dimming in place, and 30 s later
(`SHRINE_RESPAWN_SECONDS`) returns at a random point on the endless ring.

`ShrineRespawn.ts` answers "reachable" **by construction** rather than by testing
a candidate: every draw lands in the envelope the course's own hand-placed ring
shrines occupy (track radius −3..+8, 11..17 above the track plane). If a point
there were unreachable, the authored shrines would be too. Candidates only ever
come from the ring, never the approach — the approach is one-way, so a blessing
respawned there is gone for the run. Additional rules: at least 70 u from the
player (about an eighth of a lap), at least 25 u from any standing blessing, and
a furthest-of-24-draws fallback so a cornered player cannot hang the loop.

The countdown runs inside `updateGameplay`, so it obeys the same pause the rest
of the sim does — time spent in the upgrade menu is not time waiting for a
shrine. A shrine's position is mutable now, which means it travels in `Rewind`'s
`Frame` alongside the collected flag: rewinding across a pickup has to put the
blessing back *where it was taken from*.

Verified in the live game loop: an approach shrine at radius 630 / +159 was
collected, vanished, and came back exactly 30.00 s later at radius 93 / +16 — off
the one-way start and onto the ring.

## Purple glass UI (new)

The whole DOM layer is violet glass now. Tokens at the top of `styles.css`:
`--accent` (#b45cff — the crosshair's colour, and the wordmark's, so the UI
finally agrees with both instead of accenting mint green), `--accent-rgb` for
custom alphas, `--glass` / `--glass-strong` / `--glass-blur` / `--glass-border`
/ `--glass-highlight`, and `--glow-edge` / `--glow-sm` / `--glow-md` /
`--glow-text`. Change the scheme there, not at the call sites.

Three rules that are load-bearing rather than decorative:

- **`#main-menu` opts out of the scrim blur** every other overlay takes. Its
  backdrop is the course on a slow orbit — a held shot — and the shared
  `.overlay` blur turned it to mush. Same element, higher specificity.
- **The HUD bars get the rim and bloom but no `backdrop-filter`.** They are the
  only glass-styled thing on screen during play, and a blur pass under them
  would run every frame of a 128 Hz run. Everything that does blur appears
  while the sim is paused.
- **`#editor-footer` gained a pane.** It was bare text on the scene, which
  worked while the accent was bright mint; violet over a bright sky was
  unreadable. It hugs its content rather than spanning, or it runs under the
  movement stamp in the far corner.

Semantic bar colours are untouched — HP red, dash yellow, boss red. Only XP
moved (blue → violet), because it is the one bar whose meaning is "progress"
rather than "danger".

## MEGAFLOW rebrand (new)

The game is **MEGAFLOW**. Only the player-facing strings changed — window title,
the start overlay's heading, and the main menu, which is now the wordmark image
at `public/images/megaflow-logo.png` (1200 × 800, transparent, 1.11 MB). The
`localStorage` keys keep their `surf-proto.` prefix deliberately: renaming them
orphans every saved map and settings blob already in players' browsers. Repo,
package name, and the `/surf-proto/` Pages base path are likewise untouched.

Type is two faces behind CSS variables in `styles.css`: `--font-display`
(Bitcount Prop Single SemiBold) on `h1`/`h2`, menu titles and items, banner and
boss name; `--font-body` (IBM Plex Mono Regular) on everything else. Both live
in `public/fonts/`. **`font-display: block`, not `swap`** — they are the first
thing on screen.

The logo turns `rotateY` 0→360 over 11 s, perspective on the parent (a flat
`rotate` would just be a pinwheel). Stops under `prefers-reduced-motion`.

**The back half is mirrored back to forwards with `scaleX(-1)` folded into the
keyframes**, so the wordmark reads correctly from both sides. The swap is at 90°
and 270°, *not* 180° — those are the instants the element is edge-on and renders
zero-width, so it happens with nothing on screen to see it; at 180° the logo is
fully face-on and the flip would be a visible snap. The 0.01% keyframe pairs are
what make the swap discrete: interpolated, `scaleX` 1→−1 squashes the logo flat
across the whole segment instead of switching instantly.

**An absolute `src` in `index.html` does not get the base path.** Vite rewrites
`url()` inside CSS but leaves HTML `src` alone, so the logo's path is built from
`import.meta.env.BASE_URL` in **`ui/Logo.ts`** — the hard-coded form works on
localhost and 404s on Pages. The same helper swaps in a text wordmark on the
image's `error` event, so a missing file never shows a broken-image icon, and it
attaches that listener *before* setting `src` (a cached failure is synchronous).
Two screens call it now: the front menu and the start screen.

## Start screen (new)

The screen a run opens on, `#start-overlay`. It was the turn's dumping ground —
nine paragraphs down the middle of the viewport, one more every time the game
grew a feature. Now three bands:

- **The turning wordmark** at the top, the same `.menu-logo` treatment the front
  menu uses (`.start-logo` only shrinks the caps), so the two screens agree.
- **"Click to start", pinned to the centre.** Taken out of the flex flow —
  `position: absolute; inset: 0` + `place-items: center` — because with the
  other two bands sized by their content, `space-between` puts it at whatever
  point falls between them, which is neither the centre nor stable as the guide
  changes. The float animation is on the inner `<span>` so its `transform` never
  fights the centring.
- **The controls as a 4 × 2 card grid along the bottom**, icon + title + one
  line each. Anything needing more than that line belongs in the game.

**The guide sits above the XP bar, and the bottom padding is what puts it
there.** This overlay shows with `#hud` already visible behind it; 132px is the
HUD's own stack (~96px) plus its 18px offset plus air. If the HUD grows a row,
that number grows with it. A `max-height: 780px` query trims the cards, because
on a laptop the band that has to give is the guide — the prompt is pinned to the
centre and the HUD clearance is fixed, so a short viewport eats the gap between
them.

The icons are inline stroke SVG on `currentColor`, not emoji: one weight and one
colour with the type beside them, and no per-platform surprises. The cards
deliberately take **no `backdrop-filter`** — the `.overlay` scrim already blurs
the world once, and eight more passes buy nothing over a flat violet fill.

**The crosshair and the ultimate arc now follow pointer lock** (`setHudVisible`
in the `pointerlockchange` handler, and `false` in `beginRun`). They are aiming
aids for a run that has not started, and dead centre is exactly where the prompt
is.

## Music (new)

`src/audio/MusicManager.ts`, owned by `App` (it outlives a run). Nine liquid
DnB tracks in `public/audio/music/` (~53 MB, so elements are built on first use,
never up front), `HTMLAudioElement` with `loop = true` — no Web Audio anywhere
in the project, and none needed for a stereo bed. Adding a track is one entry in
`MUSIC_TRACKS` plus the file.

- Menu and editor: the fixed `ultra-speed` track. Every run: a random one that
  is **not** the track that just played, drawn in `pickTrack`.
- 2 s fade in, 1 s fade out, crossfaded when one track replaces another. Fades
  are per element and ramp on `requestAnimationFrame`, so they keep moving while
  the sim is paused behind "click to start".
- Volume is `gain × master`, default master 0.35, persisted with the other
  settings. Mute is `el.muted`, so a fade underneath it keeps its position.
- **Autoplay:** `play()` *rejects* rather than throwing when the page has no
  interaction yet, so `start()` catches it and re-arms on the next
  pointerdown/keydown — and the fade-in is hung off the promise resolving, not
  started beside the call, or a blocked track burns its ramp in silence and
  snaps on at full volume. (That bug was live; the probe caught it.)
- A restart off the game-over screen never passes back through `App`, so `Game`
  takes an `onRunStart` hook and that is what draws the next track. Without it
  the whole session after the first run keeps one song.

Verified headless (both autoplay policies): blocked start recovers on the mode
click, ramp reaches 0.35 in 2 s, 13 consecutive runs with no back-to-back
repeat, slider writes `musicVolume` to storage, mute and Reset behave, all nine
files serve as `audio/mpeg`.

## Settings and HUD layout (new)

`Escape` opens `SettingsPanel` (FOV, sensitivity, music volume; slider and
number field over each value, persisted to `localStorage`, plus a Mute music
button beside Reset). It doubles as the pause screen, and that is forced rather
than chosen — see the pointer-lock gotcha in `CLAUDE.md`. Sensitivity was
removed from the `O` tuning panel so there is one owner.

The HUD is bottom-centre and 25% wider (260 → 325). XP leads the column at a
further 25% (406) and 16px tall; level/clock/speed/trophies share one row. The
ultimate meter left the column entirely: it is now a half-ring around the **left**
of the crosshair (`UltimateArc`), filling bottom-to-top, growing flames and a
`HOLD R` label when full. The crosshair is a purple dot with a hairline black
ring — the ring is what keeps it visible against both the bright sky and the
dark ramps.

## Front menu (new)

Classic stacked **PLAY / EDITOR / SETTINGS**, replacing the two side-by-side
description cards. PLAY opens a second page *inside the same overlay* — so the
orbiting backdrop never cuts — listing the standard course plus every map in
storage, each with an aerial thumbnail. Picking a saved map plays it directly,
without a trip through the editor (`App.startMapRun`, which still hands the map
to the editor because `M` out of a free run goes *back* there).

`ui/MapThumbnails.ts` renders the real geometry rather than an authored picture,
so a tile can never drift from the map it stands for. Three things in it are
load-bearing:

- **`buildFreeWorld(map, false)`.** The collider registry is a module-level
  singleton with no per-object removal, so a thumbnail pass that registered
  would silently add every map in storage to the collision world.
- **Opaque light backdrop and an under-light.** Course geometry is dark grey and
  the tiles are dark cards; the first render came out as three near-black
  rectangles. From above, every banked face also turns its *underside* to the
  camera, so without a fill from below half the course renders black.
- **The standard course is focused on the ring, not fitted.** Its bounding
  sphere is set by the approach descent 600 units out, which shrinks the ring —
  the thing that identifies the course — to a dot.

The standard tile is photographed once at boot, which is the only moment that
world is guaranteed live (`setWorld` disposes what it replaces). Map tiles are
re-rendered per visit, because the editor can change one between two trips.

**`Escape` mid-run opens the pause menu** (`ui/PauseMenu.ts`) — CONTINUE /
RESTART / QUIT / SETTINGS — not the settings screen. Same stacked list and same number keys
as the front menu, deliberately: a player who has read one has learned the other.
The pause itself was already there (losing pointer lock pauses the sim); this
gives it a menu.

- **CONTINUE** re-takes pointer lock. `Escape` pressed *on* the pause menu means
  this, and that one is a plain key handler — the lock is already gone by then,
  so the page gets the key normally.
- **RESTART** is `Game.restartRun()`, the same teardown the game-over screen
  uses. `Shrine.reset()` now returns each blessing to its **authored** position,
  not just un-collects it in place: positions are mutable since blessings
  respawn, so without an `origin` a restart left every shrine wherever the
  previous run had scattered it.
- **QUIT** always goes to the front menu, including from a free-mode run. `M`
  still goes back to the *editor*, because that is the useful exit while
  iterating on a map; Quit is the one that leaves.

- **SETTINGS** opens the settings screen plain. `O` is the shortcut that opens
  it with Advanced already expanded, and it works from gameplay and from the
  pause menu.

Closing settings returns wherever it was opened from — the pause menu, or
straight into the run (`App.settingsFromPause`); the two entry points want
different exits. `SettingsPanel.show` takes `'resume' | 'back'`, which names
where the close button *goes* rather than where it was opened from: those are
not the same thing, and conflating them briefly put "Resume" on a button that
went back to the pause menu.

**Settings** is reachable from the front menu as well; the
only difference is the close button's wording. The movement convar bench is no
longer a floating panel of its own — it is embedded under a collapsible
**Advanced Settings** section on that screen, and `MovementPanel` is now a
content builder with no positioning, visibility or pointer-lock handling of its
own. `O` still works and opens Settings with that section already expanded.

## Known bugs

None blocking. The approach entry is fixed — see below.

## Round two of polish (falls, blessings, sky)

- **Falling is death.** No mid-course respawns; the start zone is the only checkpoint,
  and a fall ends the run (game-over screen, fresh round). The checkpoint pads remain as
  geometry/rest spots but carry no respawn function; `Game`'s stage-tracking machinery
  (`trackLastStage`, `lastStageIndex`, teleport recovery) is deleted.
- **The "random teleport to start" bug — root-caused.** It was NOT a collider in the sky
  (the sky is mesh-only; nothing to hit). It was the old checkpoint kill-plane ladder:
  the plane hung 30 below the *next* stage, stages armed only inside a narrow height band
  (dy −0.5..2), so flying OVER a pad left it unarmed and the plane stayed ~90 units up —
  crossed mid-flight later, teleporting the player to the unarmed ladder's start. Replaced
  by two rules that cannot fire above the course: a **doomed check** (plummeting faster
  than −22 u/s with no surface within 100 below — probed: 117/117 flight positions above
  the journey line have ground cover) and a global `killPlaneY = −45` backstop under
  everything (island bottoms out at −29). Both now end the run instead of teleporting.
- **Blessings open on contact.** The E/token flow is gone (E key, HUD readout, banner,
  tokens all removed); flying through a shrine pauses the sim on the choice menu
  immediately, and the flight resumes exactly where it stopped after picking. Menu
  heading is now "Choose a Power" since it serves both level-ups and shrines.
- **Ghibli sky** (`src/world/Sky.ts`): procedurally painted canvas (deterministic
  mulberry32 seed — reshuffling clouds per refresh reads as a bug) on an inward sphere:
  cerulean → pale warm horizon gradient, three bands of soft cumulus. Classic skybox
  mechanics: re-centred on the camera every frame, `fog: false`, renderOrder −1,
  frustumCulled off, **no collider**. Fog and clear colour now match the painted horizon
  (`SKY_HORIZON_COLOR`), keeping the bright-sky contrast gotchas valid.

## The polished standard game (new)

Three additions, per the user's Megabonk-flavoured brief:

- **The journey** (`SurfCourse.ts`): the standard course is now a ~800-unit linear surf
  map between the descent staircase and the ring arena — cruise, ±24° slalom, a 22° dive,
  **a climb** (two faces pitched −12°: the not-only-downhill piece, a genuine speed check),
  a narrow-width precision section, and a final descent onto the old straight. Built
  entirely from the proven single-face piece with the staircase's handoff rules (alternate
  bank, stagger toward drift, step the centreline down); dry-passed forward in local space
  then translated so the exit feeds the straight exactly. The start tower is now at y≈180.
  Checkpoints between sections (in-line, re-entry-pattern pads); **deliberately none
  between the dive and the climb** — a respawn there would face the ascent at walk speed,
  forever, so the pre-dive pad is the retry point for the whole passage.
  **Verified by the original approach's method** — ballistic exit coverage per handoff
  (70–100% along, 16–34 u/s, 3–7 drift): every straight-heading pair lands 24–41/48
  (misses are the 16 u/s rows; slow exits dying is the game), turn pairs 12–46/48 with
  strafing supplying the rest. First tuning pass measured dive→climb 2/48 and the climb
  pair **0/48** — fixed with `JOURNEY_DIVE_EXIT_STEP` (12) and `JOURNEY_CLIMB_STEP` (6).
  The journey's specs are exported on the course (`course.journey`) for probes.
- **Shrines** (`src/game/Shrine.ts`, positions on `course.shrines`): nine gold floating
  pickups placed off the surf line — reaching one costs speed, line and airtime. Contact
  **banks a blessing token** (menu-on-contact would spring mid-flight at 30 u/s and cost
  the landing); **E** spends a token on a free three-way powerup choice — the same menu,
  pause and momentum-boost contract as a level-up. Gold on purpose: pickups are identified
  by colour before shape, and teal is XP, violet is seeder. Spent shrines stay visible but
  go dark. `Game` owns the objects and resets them per run; free-mode maps have none (yet).
- **The item pool** (`Upgrades.ts`) grew 6 → 15: weapon range, Velocity Rounds (shots
  scale with speed like the knife; duplicate draws fall back to +3 damage so no dead
  picks), knife damage/reach, Regeneration, Vampiric Edge (heal on kill), Quick Recovery
  (dash recharge), XP Magnet, Scholar (+25% XP). New plumbing, each with a reset path:
  `RunPerks` on `Game` (copy-the-defaults reset like MovementConfig), `Health.regenPerSecond`
  + `tick`, `Knife.bonusDamage/bonusRange`, `Dash.rechargeSeconds`, `XP_MAGNET` box in
  XPOrb, `Weapon.velocityRounds` (+ speed param on `Weapon.tick`).

Ramps and movement untouched, per the brief. Smoke-verified in-browser: shrine collect →
banner → gold HUD prompt → E opens the choice, hands-free descent surfs at 21 u/s, free
mode unaffected. The first shrine placement was collected by the *autopilot* without
deviating — moved up and toward the high side; a shrine the default line collects is a
freebie, not a shrine.

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
- **Ridge miter.** Where two slabs meet at an apex, each face is pulled down-slope by
  `thickness·tan(roll)` so its sub-surface corner lands exactly on the ridge plane —
  without this the slabs visibly cross at the top. Composite/pyramid slabs are thin
  (`COMPOSITE_THICKNESS` 0.5) precisely because the miter seam scales with thickness;
  probed: zero protrusion above the face planes, seam ±0.36 at the apex.
- **Axis gizmo.** The selected piece (or spline point) carries an X/Y/Z translate gizmo
  — DCC colours, camera-distance scaled, depth-test off so it never buries inside its
  piece, drag solved by line-line closest point. Gizmo picking outranks piece picking.
- **Content-browser palette.** Two-column grid of 3D thumbnail tiles rendered at editor
  startup from each definition's real geometry (`src/editor/Thumbnails.ts`, offscreen
  renderer, disposed after one pass), hints demoted to tooltips, controls help collapsed
  behind a `<details>`.
- **One watertight mesh per piece.** The visible piece is a single lofted
  `BufferGeometry` (`skinGeometry`): widths interpolate continuously (tapers are
  straight-edged, the pyramid is exact — planar faces, straight hips, one apex point),
  and under-sides drop vertically so faces sharing an edge meet exactly. Collision
  stays stepped oriented boxes from the same frame walk. An adversarial audit of all
  14 definitions found the visuals defect-free and all real issues collision-side;
  fixed since: collider boxes take *inscribed* (minimum-boundary) widths so collision
  never reaches past a visible tapered edge (was up to 1.4 over), taper steps halved
  to 1 unit, and the seam-overlap pad extends toward interior seams only, never past
  a piece's entry/exit. Accepted trades, on record: up to ~0.5 of visible taper edge
  is unbacked (slides off marginally early), the intentional ridge-miter slit (±0.4
  band, no collider on the exact ridge line), and collision slab *sides* extending
  laterally at sub-surface heights (felt only brushing an underside). Raked ends on
  roll+pitch channels (vertical-curved-inverted: 4-unit V notch at a free-standing
  exit) are self-consistent shear that mates flush when chained — cosmetic.
- **Landing on a ramp no longer converts the fall into a downhill slide.** `clipVelocity`
  removes only the component *into* a surface, and the fall line lies *in* the surface
  plane (`n·d = 0`, so `v'·d = v·d` exactly) — so a 20 u/s drop onto a 51.34° face used to
  land already sliding down it at ~15.6 u/s, which threw a late landing off the low edge.
  `PlayerController.redirectLandingVelocity` now re-points that component **along** the
  ramp instead of down it, preserving speed (the user's explicit choice over simply
  deleting it).
  The whole difficulty is firing on a landing and *never* while riding — cancel the
  downhill component every tick and the player is glued to the face, which destroys the
  height-for-speed trade that surfing is. The discriminator is approach speed into the
  surface, which separates the cases by ~35×: riding accumulates only ~0.09 u/s per tick
  (gravity's normal component, clipped away again immediately), while a 20 u/s drop
  arrives with 12.5. `SURF_LANDING_IMPACT_SPEED = 3` sits between, needs no cross-tick
  state, and is self-limiting inside the two-iteration sweep loop.
  Measured: landings touch down at ~0.0 u/s downhill (was ~15.6) keeping 77–101% of
  speed, while a rider's downhill drift still builds 3.5 → 13.9 u/s over a second.
  Walkable ground is excluded, so bunnyhopping is untouched (walk still caps at 7.00).
  **Consequence to know:** falling onto a ramp is now a way to convert height into
  along-ramp speed — dropping off the start pad reads 7 → 33 u/s where it read 7 → 17
  before. That is inherent to "preserve total speed" and was chosen deliberately;
  `MAX_LANDING_REDIRECT_GAIN` (3) is the knob, and lowering it toward 1 slides the
  behaviour back toward "keep only the speed you already had along the ramp". The
  redirect can never *create* speed — its result is bounded by `min(speed, gain×along)`.
  A near-vertical drop degrades gracefully rather than launching somewhere arbitrary:
  50 u/s straight down lands at 1.5 u/s.
  The approach staircase's recorded ballistic-handoff numbers (34/45, 43/45) predate this
  and should now read *better*; treat them as stale measurements.
- **Curved-ramp collision is now welded convex wedges, not boxes — and that ended a
  whole class of bugs.** Oriented boxes fundamentally cannot follow a smooth curved
  surface: independent boxes leave each segment's end-cap standing proud of its
  neighbour (the player is stopped dead), and sinking them to bury the caps only trades
  the stall for collision sitting *below* the visible surface (the player clips through
  it). Every knob in between — shingle sinks, circumscribed widths, ridge miters, ridge
  overlaps, per-seam pads — was an attempt to balance those two, and each fix traded one
  for the other. Measured proof it was a real trade and not a tuning miss: disabling the
  shingle took holes to 0.00% and sink to ~0 but brought back −21 u/s stalls, and
  tripling the segment count (2° → 0.75°) left those stalls *unchanged*, which disproved
  the second-order-skew model they were built on.
  `Colliders.registerPrism` + `Raycast.rayIntersectConvex` add a convex primitive
  (intersection of half-spaces, with a broadphase sphere), and ramp collision is now the
  **same triangles as the visible skin**, extruded straight down. Adjacent wedges share
  a face exactly, so a ray leaves one and enters the next at the same point — no cap
  between them, no gap. This is also what real surf maps do; the CS2 guide compiles
  curved ramps as *Multiple Convex Hulls* for exactly this reason.
  **Result across all 14 definitions: sink 0.000, lip 0.000, holes 0.00%, no stalls at
  any of seven lateral positions.** What you see is what you ride.
  Standard course is untouched (still 28 boxes, 0 wedges — it builds through
  `buildRampCurve`). Cost: a heavy 30-curved-piece map is 1470 volumes at ~14.5 µs/ray,
  about 2.8% of the 1/128 s tick budget.
- **The "stuck partway along a curved ramp" bug — first fix, engine-level.**
  `sweep()` spreads its five sample rays **horizontally**; a surf face is banked, so at
  51° a sample 0.4 to the side sits 0.31 *inside* the slab. `rayIntersectBox` already
  declined to report the box a ray starts in — but that ray then flew on and hit the
  **next segment's leading end-cap**, whose backward-facing normal made `clipVelocity`
  delete the entire forward component. Hence: only multi-segment runs showed it (the
  standard course's ring is one box per ramp with gaps, so it never could), and it hit
  hardest on the first seam of a curve. `isInsideAnyCollider` now makes `sweep` skip
  buried samples outright — the consistent form of the rule `rayIntersectBox` already
  applied. **Measured: zero buried samples across a 1151-tick standard-course run, so
  behaviour there is bit-identical** (collider count still 28).
  Three geometry fixes went with it: segment step 4°→2° (seam mismatch grows with its
  square), forward-only box overlap plus a per-seam shingle offset so every seam is a
  step *down* in the travel direction, and taper widths switched back to circumscribed —
  inscribed widths left crescent holes that dropped the player below the surface into
  the next end-cap. A-frame ridges now *overlap* past the peak instead of mitering short
  of it: the ridge is convex, so the overshoot hides below the opposite face, and the
  slit that used to stop a player tracking the ridge is gone.
  **Verified by simulating the real `PlayerController` down all 14 definitions at five
  lateral positions each: no sudden stops anywhere.** The probe must judge stalls by
  *absolute* one-tick speed loss — a relative test flags a player gently decelerating
  as they climb a 55° pyramid face, which is physics, not a defect.
- **Undo/redo** (`Ctrl/Cmd+Z`, redo on `Ctrl/Cmd+X` by request): whole-map snapshots,
  one per completed gesture, taken *before* mutation; drags snapshot on grab and
  discard on release if nothing moved; cap 500. `splineGeneratedIds` survives undo
  untouched — ids are session-unique, so stale entries are harmless and surviving
  ones keep regeneration owning its pieces.
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
