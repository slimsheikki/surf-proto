# surf-proto — working notes

Browser game: **CS:S surf movement is the point**, a Vampire-Survivors/Megabonk combat
layer is secondary and must never make the player stop surfing to fight.

Vite + TypeScript + Three.js. **No physics engine** — the controller is a hand-rolled
kinematic pipeline mirroring Source's `PM_AirAccelerate` / `PM_Friction` /
`PM_ClipVelocity` / `PM_GroundTrace`. A constraint solver fights this; don't add one.

**`docs/MOVEMENT_VERSIONS.md`** is the running log of movement builds — the movement is tuned
against a human's judgement, so every build is named, stamped on screen, and written up there.
Bump `src/player/MovementVersion.ts` and add an entry in the same commit, always. `O` in game
opens a live tuning panel for the CS convars.

**`docs/ARCHITECTURE.md`** explains the shape of the codebase — boot, frame loop, collision,
where things live, and what adding a model actually involves. Read it if you're new here or
handing the project to someone. **`docs/CS2_SURF_MAPPING.md`** is a vendored surf-mapping
guide with a note on which parts transfer; it's the reference the level is held against.

```
npm run dev      # localhost:5173
npm run build    # tsc -b && vite build — must pass before any commit
```

Branch: **`claude/surf-strafe-game-xzjbvh`**. Never push elsewhere.
Deployed by GitHub Actions on push to `main` → https://slimsheikki.github.io/surf-proto/

## Invariants — each of these has already been broken once and cost real time

**Scale is 1 game unit = 45 Hammer units.** Derived from CS `sv_maxspeed` 320 → 7 u/s
walk. Gravity (`-17.8` = 800/45), jump speed, and the 45.573° walkable cutoff
(`acos(0.7)`, Source's `normal.z >= 0.7`) all follow. Angles measured off real surf maps
transfer directly. Changing one number here silently desyncs the rest.

**Surf ramps are banked walls with pitch exactly 0.** Canonical face normal
`(0, ±0.781, 0.625)` — 51.34° from horizontal, up-component deliberately *below* 0.7 so
the player never grounds and air-strafing stays live. Travel runs along the ramp's
length; the fall line runs *across* the face. A pitched ramp is a downhill chute, which
is the wrong archetype — that mistake survived several sessions because it looked fine
in screenshots.

**Basis handedness in `RampCurve.ts`:** `right = worldUp × forward`, then
`normal = forward × right`. The other order gives determinant −1, `setFromRotationMatrix`
returns a non-unit quaternion, every raycast reports `(0,1,0)`, and ramps render as
axis-aligned half-size boxes.

**Friction runs *after* the jump check** in `PlayerController` (Source's `FullWalkMove`
order). Reversed, bunnyhopping bleeds ~25% over 6 hops.

**Gravity is split in half around the move** (`StartGravity` / `FinishGravity`). Applying it
all up front is what made the jump apex 55.6 hu instead of CS's 57.0, and the error scales
with `dt` — so it silently retunes itself if the tickrate ever changes.

**The frame's mouse delta is split across that frame's ticks** (`InputSystem.beginFrame`).
Handing it all to the first tick leaves the rest with a stale view angle, and a tick whose
view did not turn pays out no air-strafe gain — so strafing got weaker the lower the
framerate.

**A ramp piece's leading edge is a vertical wall, and no shaping of the geometry changes
that.** `registerPrism` builds every side plane as `edge × (0,-1,0)`, so the plane closing off
a strip's first ring comes out *exactly vertical* whatever the edge it was built from looks
like — chamfer it, round it, rake it, the wall stays a wall. Clipping against one deletes the
player's whole forward component, which is the dead stop that has now been found three times
in three disguises (box end-caps, then a butted pitched piece, then piece joins). Two things
hold it off and both must stay: `emitStripColliders` pads both ends of a strip with
`computeRampFrames`' `overlapPad` so the cap is buried in its neighbour, and `Raycast` declines
a **tagged cap plane** as an entry plane for an airborne player. Do not "simplify" either by
guessing at the normal — a cap and a lateral edge wall are both exactly vertical, and ignoring
the lateral one glues the player to the low edge and deletes surfing.

**Ring ramps must close on themselves with no net descent** — that is what makes the loop
endless. Verify with a collision probe, not by eye.

**A collision probe must measure displacement, not just speed.** A fix that pins the player in
place with their velocity intact looks perfect on every speed-based metric and is the worst
outcome there is. Cost a full round-trip in the v2 seam work; see `docs/STATE.md` § Probes.

**All gameplay ticks at a fixed 1/128s.** Render is variable. Never feed render dt into
movement.

## Working agreements

- **The critic agent has full aesthetic authority.** Its job is to research real CS:S surf
  maps and hold this level against them. It writes **zero code**.
- **Coding agents do not make aesthetic decisions**, and **do not commit or push** —
  that's mine. (They have done both anyway; say it explicitly in the prompt.)
- Agents die on session limits mid-task. Have them checkpoint findings to `docs/` so the
  work isn't lost.

## Gotchas that wasted time

- Additive blending desaturates against the bright sky — combat flashes need *normal*
  blending (learned on the old slash cone; the sound blast and solar wake follow it).
  High `emissiveIntensity` on saturated colours clips to white.
- Pointer lock hides the cursor and swallows clicks, so any menu needs keyboard
  selection (1/2/3) or it's unreachable. This froze the game at first level-up.
- Proportional lerp toward a moving target fails at speed (closing velocity vanishes) —
  the XP magnet needs a latched constant-speed seek.
- No `Date.now()` / `Math.random()` in Workflow scripts.
- `sleep` chains are blocked; use `until <check>; do sleep 2; done`.
- The sandbox proxy blocks `github.io`, so the live Pages URL can't be verified from here.
- **Under pointer lock the browser owns `Escape`** — it releases the lock and never delivers
  the keydown, so a key handler cannot open anything with it. `pointerlockchange` always
  fires, so that is what opens the pause menu; `Escape` only ever *closes* a screen (and
  once the lock is gone the page gets the key normally, which is why closing works).
  Chrome also refuses a re-lock for ~1 s afterwards, and **that refusal is a wait, not a
  failure** — Escape-to-pause then Escape-to-resume is always inside the window, so treating
  `pointerlockerror` as "put the panel back" made the pause menu reopen itself the instant it
  was dismissed. Every way back into a run goes through `App.resumeRun`, which retries until
  the browser relents and only surfaces a screen once the window is spent (or the player is
  left on a paused world with no prompt, which is the other half of this trap).
- Playwright's synthetic `Escape` does **not** trigger the native pointer-lock exit. Test
  that path with `document.exitPointerLock()` — but note a scripted exit does **not** arm the
  re-lock cooldown either, so nothing about that path reproduces headlessly unless you stand
  the cooldown up yourself by stubbing `requestPointerLock` to fire `pointerlockerror`.
- `audio.play()` **rejects a promise** when autoplay policy blocks it — it does not throw, so
  an un-awaited call leaves the game silently mute forever. And the fade-in has to hang off
  that promise *resolving*: started beside the call it burns its two seconds while the audio
  is still blocked, then snaps on at full volume on the unlocking click.
- `UpgradeMenu` and `BankMenu` read `e.key`, not `e.code` — a synthetic `{code:'Digit1'}` is
  ignored, and a headless test that "picks an upgrade" that way silently sits in the paused
  state forever.
- **The crosshair and `UltimateArc` are the only things on screen above a full-screen panel**
  (z-index 36 vs the overlays' auto), and they follow pointer lock, which is *held* through a
  choice screen. Left alone, the arc draws a dark half-ring straight through the middle card.
  `Game.applyHudVisibility` drops them for `pausedForUpgrade` only — the bottom HUD column
  stays, because the banked-power counter has to stay readable while it drains.
- **`PauseMenu`'s digit listener is gated only on "am I open"**, exactly like `UpgradeMenu`'s.
  Any two of these open at once means one number key fires both. That is why Escape over a
  power screen routes to `App.resumeRun` instead of opening the pause menu.

## Endless runs

There is **no win state** — felling the Monolith continues the run, and death is the only
exit. All scaling lives in `src/enemies/Difficulty.ts`; when you touch it, check that
`difficultyAt(1, 120)` still returns the pre-endless numbers, because a level term applied
to an unfloored time term silently retunes the early game. Monoliths recur every 10 levels,
scaled. The seeder (`src/enemies/Seeder.ts`) claims a patch of the line a medium distance
*ahead* of the player (never on them — `Blast.plantPoint`), telegraphed for a 2 s fuse; a
still player gets it planted on them instead, which keeps it the enemy that punishes *not*
surfing.

**Enemies spawn on a ring around the player, never in the flight path** —
`src/enemies/SpawnPlacement.ts` rejects the projected collision corridor, and the hard
no-instant-hit guarantee is the 1.2 s spawn contact grace in `Enemy`, not the geometry.
*Composition* is waves (`src/enemies/Waves.ts`): five per act, act = `bossesFelled`, wave
= f(level) — rewinds free, no Frame field. Scaling stays in `Difficulty`, composition in
`Waves`; don't merge them. The speed law reads **no sustained pursuit above 22 u/s**; the
Lancer's telegraphed straight dash is the one sanctioned exception (it cannot pursue).
Stragglers left >120u *behind* travel are ring-relocated (`Enemy.relocateTo`) — a
relocation, never a despawn; there is still no distance cull. A new archetype needs a
`Rewind.ts` kind tag + reconstruction branch or it rebuilds as a plain drone.

`window.__surf` is a dev-only handle on the live `Game` (stripped from prod) — the late game
is otherwise unreachable by scripted input. See `docs/STATE.md`.

## Banked powers

A level-up **banks a pick** and interrupts nothing — the run only stops when the player asks
it to. **Tap `F`** for one power, **hold `F` 2.5 s** for the all-in screen (spend the bank, or
stake it all on one blind roll). Both resume through the 3-2-1, toggleable with `C`.

A tap is only distinguishable from a hold **on the release**, which is where it fires, and
`Game.bankHoldArmed` must stay false until `F` comes back up — the screen opens with the key
still down. `F` is read inside `updateGameplay`, so it is inert in every other state for free,
and it is checked *after* the ReWind edge: ReWind is the panic button, powers keep.

The bank lives in `LevelSystem`, so it rides `LevelSnapshot` and **`Rewind` needed no new
`Frame` field** — the same reason `xpToNext` lives there. Epic/legendary upgrades are
**gamble-only**; `drawUpgradeChoices` filters to common+rare (24 entries since the
solarpunk/sound batch; 11 gamble-only behind them). Shrine blessings are unchanged and do
not bank. See `docs/STATE.md`.

## The ReWind ultimate

Hold **R** at 100% to run up to 15 s of the run backwards; release to resume
after a 3-2-1 countdown. `src/game/Rewind.ts` records **state, not diffs** —
that is the only reason "rewind the powerups too" is tractable, since an upgrade
is an arbitrary mutation and the pool cannot be asked to invert one. **A new
upgrade is only rewound if the field it writes is listed in `Frame`.**
`Ultimate.LEVEL_GROWTH` is deliberately the same 0.07 that `difficultyAt`
divides the spawn interval by; move them together. See `docs/STATE.md`.

## Blessings

A blessing is a **ring the player surfs through**, hung above a ramp. "Reachable" is answered
by construction (`BlessingSpots.ts`): every candidate spot is *derived from a ramp piece the
map contains*, so a blessing can only appear over something rideable. Sampling an envelope
around `islandCenter`/`trackRadius` instead — what the deleted `ShrineRespawn.ts` did — is
wrong on a free map, where those are the boss pillar and its engagement radius, not a track.

**There are exactly `BLESSING_SLOTS` (5) `Shrine` objects and the count may never change
mid-run**, because `Rewind` pairs shrines with snapshots *by array index*; blessings appear
and disappear by flipping slots dormant, never by resizing the list. Position *and facing*
are mutable, so both ride in `Rewind`'s `Frame`.

A run **opens with all five standing** — `restart` resets every slot to a zero delay and the
gameplay loop places them on the first tick, each seeing the ones already up so the ≥70 u
separation still holds. Staggering them 30 s apart instead (the literal reading of "one every
30 seconds") left the player looking at an empty sky for the first half minute;
`SHRINE_RESPAWN_SECONDS` governs only how long a *collected* blessing stays gone.

## Free mode

A second mode off the main menu: a free-camera map editor where ramps are dragged in from
a side palette, moved in 3D, and played. `src/app/App.ts` is the switcher above `Game`;
`src/editor/` is the editor. Two rules there have the same status as the invariants above
— **the editor registers no colliders** (they cannot be retired, and a drag rebuilds
meshes every step), and **`Game` is constructed once and re-pointed with `setCourse`** (the
terminal screens bind restart listeners in their constructors). See `docs/STATE.md`.

**The half-pipe's walkable trough is a decision, not a bug.** It is a half-round pipe (arc
0°→84°, `RampLibrary.ts`), and a semicircle's bottom is horizontal, so 12.9 units of it read
`normal.y ≥ 0.7` and the player can stand there. A truncated version that started the arc at
50° made that impossible and looked like a **V**, which is why it was rejected — the shape won.
`HALFPIPE_THETA_MIN_DEG` is the one-line revert if it ever proves to be the problem in play.
The rim stops at 84° for an unrelated reason: prism solidity is `depth · cos θ`, so a wall
nearing vertical thins to nothing and a fast player goes through it. `rollDeg` is forced to 0
in the builder — tipping a pipe flattens one wall and thins the other's collider.

The front menu's map tiles render **real geometry** for their aerial thumbnails
(`ui/MapThumbnails.ts`), which means they call `buildFreeWorld(map, **false**)` —
the colliders flag is not optional, or every map in storage joins the collision
world.

**The default course is itself a free map**: `src/world/default-course.map.json`, authored in
the editor and loaded by `DefaultCourse.ts`. Both are named for the role — the title on screen
("MegaFlow Demo V1") lives in the JSON's `name` alone, so renaming it is one edit. It gets its
own start path (`App.startDefaultRun`) rather than going through `startMapRun`, because that one
hands the map to the editor and sends `M` back there — right for a saved map, baffling for the
course the game opens on. `defaultCourseMap()` rebuilds it per call, since the editor mutates
whatever map it is given. `buildSurfCourse` (the
old generated ring) is now an unused export kept only for the constants `MapData.ts` reads.

Maps are shared as links, not through a server (`src/editor/MapCode.ts`): JSON → deflate →
base64url behind a format tag, carried in the URL **fragment** so it never reaches a host.
Decoding routes through `parseMap`, imported names go through `uniqueMapName` (or Save
overwrites the recipient's own map of that name), and the hash is cleared after import.

## Where things stand

See **`docs/STATE.md`** — current known bugs, tuning constants, and what's next. Read that
before starting work; update it before finishing.
