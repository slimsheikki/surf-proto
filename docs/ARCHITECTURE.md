# Architecture — how surf-proto is built and how it runs

Orientation for someone new to the project (or for explaining it out loud). This describes
the *shape* of the code. Two sibling docs cover the other axes:

- **`CLAUDE.md`** — the invariants and gotchas. Rules that cost real time when broken.
- **`docs/STATE.md`** — what is currently true: known bugs, tuning numbers, what was last
  verified.

Read this one first, then `CLAUDE.md` before changing anything.

---

## 1. What it is

A browser game. Open a URL, it runs — **no server, no backend, no accounts, no network calls
at runtime.** The whole thing is HTML + CSS + one JavaScript bundle on a static host.

Three facts that surprise people:

1. **There is no game engine.** No Unity, no Godot, no physics library. Three.js is a
   *rendering* library — it draws triangles and manages a scene graph. Everything else —
   movement, collision, enemies, progression — is hand-written TypeScript. The single runtime
   dependency in `package.json` is `three`.
2. **There are no art assets.** No `.glb` models, no textures, no sprites, no `public/`
   folder. Every visible object is constructed from primitives in code at startup. See §8,
   because this is the thing that matters if you want to add models.
3. **The movement is a port, not an invention.** The player controller mirrors Counter-Strike:
   Source's `PM_AirAccelerate` / `PM_Friction` / `PM_ClipVelocity` / `PM_GroundTrace`, at a
   fixed scale of 1 game unit = 45 Hammer units. That is the point of the project; the combat
   layer on top is secondary and must never make you stop surfing to fight.

**Toolchain.** TypeScript for the source, [Vite](https://vitejs.dev) for the build. In dev,
Vite serves the modules straight to the browser with hot reload. For production it type-checks
(`tsc -b`) and bundles everything into one JS file plus one CSS file — ~600 KB, ~160 KB
gzipped, almost all of it Three.js.

---

## 2. How a frame runs

### Boot

`index.html` is a `<canvas id="scene">` plus every piece of UI as ordinary DOM: the HUD bars,
the main menu, the upgrade menu, the game-over panel, the editor toolbar. All of it starts
hidden and is shown/hidden by class toggles. It loads exactly one script, `src/main.ts`, which
is four lines:

```ts
import { App } from './app/App';

const canvas = document.getElementById('scene') as HTMLCanvasElement;
new App(canvas).start();
```

`src/app/App.ts` is the composition root. Its constructor creates the `WebGLRenderer`, the one
`Scene`, the one `PerspectiveCamera` that every mode borrows, the lights (one ambient, one
directional "sun"), the sky colour, and the input system. Then `start()` kicks off the frame
loop.

### The loop

`App.frame()` (`src/app/App.ts:344`) runs once per `requestAnimationFrame` and does three
things in order.

**a. Drain the fixed-timestep accumulator.**

```ts
this.loop.step(now, (dt) => {
  if (this.mode === 'play' && this.game) this.game.tick(dt, this.input.consumeFrame());
});
```

`FixedStepLoop` (`src/engine/Clock.ts`) accumulates real elapsed time and calls the callback
once per **1/128 second** of it — zero times on a fast frame, twice or more on a slow one.
`dt` handed to gameplay is *always* exactly `1/128`.

This separation is load-bearing, not stylistic. Source-derived movement math is tuned for a
constant tick; feed it a variable frame delta and air-strafe gain, bunnyhop retention, and
ramp behaviour all drift with the player's framerate. **Never pass render dt into movement.**

Two details worth knowing: the accumulator is clamped (`MAX_FRAME_DELTA = 0.25`) so a
tab-switch does not produce a thousand catch-up ticks — the "spiral of death". And `step` is
called on *every* frame regardless of mode, with only the callback gated, so time spent in the
menu or editor is not banked and then burned as a tick burst on the next run.

**b. Render-rate update.** Whatever is not gameplay: the editor's fly camera, or the menu's
slow orbit. These legitimately use variable `renderDt` — nothing about them is simulation.

**c. Render — twice.**

```ts
this.renderer.clear();
this.renderer.render(this.scene, this.camera);
if (this.mode === 'play' && this.game?.cameraRig.mode === 'first') {
  this.renderer.clearDepth();
  this.renderer.render(this.viewModel.scene, this.viewModel.camera);
}
```

The first pass draws the world. The second draws the first-person hands, which live
in **their own `Scene` with their own `Camera`** (`src/player/ViewModel.ts`), on top of a
wiped depth buffer. `renderer.autoClear = false` is set in the constructor to make this
possible.

The reason is specific to this game: on a surf map you ride with your shoulder against the
geometry, so a viewmodel sharing the world's depth buffer gets sliced in half by ramps
constantly. Drawing it as a separate pass over cleared depth means it composites on top
unconditionally and can never intersect the level. CS does the same thing, including the
narrower viewmodel FOV (55° vs the world's 75°).

The **third-person body** is the other half of this. `src/player/PlayerModel.ts` is a blocky
Minecraft-proportioned placeholder character that lives in the *world* scene (added by `Game`,
not by the course), shown only while `cameraRig.mode === 'third'` — in first person the camera
sits inside its head. It shares the gloved fists with the viewmodel: `src/player/Hands.ts`
owns those builders and both views call into it, so the two can never drift into wearing
different gloves. The pose sets differ, the model does not.

Nothing in it is simulation — it reads the controller and never writes to it — so it needs no
entry in `Rewind`'s `Frame`: rewinding the player's transform rewinds the body with it.

### Input

`src/engine/Input.ts` listens on `window` and accumulates state. `consumeFrame()` returns an
`InputFrame` — move axes, `jumpHeld`, mouse deltas, and edge-triggered `attackPressed` /
`dashPressed` / `cameraTogglePressed` — then clears the one-shot flags. Called once per
gameplay tick, so a click is delivered exactly once.

Mouse look requires **pointer lock**, taken on a click. That has a consequence worth
remembering: under pointer lock the cursor is hidden and clicks go to the canvas, so any menu
must be reachable by keyboard (the upgrade menu uses 1/2/3) or the game soft-locks. It has.

---

## 3. Three modes, one scene

`App` switches between `'menu'`, `'editor'`, and `'play'` (`AppMode`). All three share one
`Scene` and one `Camera`; what changes is what is in the scene and who drives the camera.

- **menu** — the course sits in the scene as a backdrop while the camera orbits it slowly.
  `src/ui/MainMenu.ts` is DOM on top.
- **editor** — free mode. A fly camera, ramps dragged in from a side palette, saved to
  `localStorage` and shared as URL fragments (`src/editor/`).
- **play** — a run. `Game` ticks.

`setWorld()` is the only path that swaps what is in the scene, because unloading a world means
clearing the collider registry (§4) and disposing GPU resources (§8).

**Two rules here have invariant status:**

1. **`Game` is constructed once and re-pointed with `setCourse()`, never rebuilt.** The
   terminal screens bind their restart handlers in their constructors, so a second `Game`
   leaves two listeners on the same button and every restart fires twice.
2. **The editor registers no colliders.** A drag rebuilds a piece's meshes every step, and
   colliders cannot be retired individually — an editing session would pile up thousands of
   stale ones. The world is rebuilt from scratch, colliders and all, when the editor hands a
   map over to be played.

Music crosses all three modes, so `MusicManager` is owned by `App` rather than `Game`: menu
and editor share one fixed bed, and every run draws a random track that is not the one that
just played. A run started from the game-over screen never comes back through `App`, so
`Game` takes an `onRunStart` hook to announce it. See `src/audio/MusicManager.ts` for the
autoplay-policy handling, which is the only genuinely awkward part.

---

## 4. Movement and collision — the interesting part

### The per-tick pipeline

`PlayerController.tick()` (`src/player/PlayerController.ts:159`) runs this order, and the
order mirrors Source's `CGameMovement::FullWalkMove`:

1. **Look** — apply yaw/pitch deltas, clamp pitch to ±89°.
2. **Wish direction** — WASD as a local vector, normalized, rotated by yaw.
3. **Jump** — *before* anything reads ground state. In Source, `CheckJumpButton()` clears the
   ground entity and the friction check that follows is gated on still being grounded, so the
   tick you jump on pays **no ground friction** and takes the air path. That is exactly why
   bunnyhopping preserves speed. Reversed, hops bleed ~25% over six jumps.
4. **Accelerate** — grounded: friction then `groundAccelerate`. Airborne: `airAccelerate` then
   gravity.
5. **Integrate** — sweep the displacement against colliders, clipping velocity on each hit.
6. **Ground probe** — decide whether the player is standing on something.

The air-acceleration function is where surf lives:

```ts
const wishspeed = MovementConfig.MAX_GROUND_SPEED;              // 7
const cappedWishSpeed = Math.min(wishspeed, MAX_AIR_WISH_SPEED); // 0.6
const addSpeed = cappedWishSpeed - velocity.dot(wishDir);
if (addSpeed <= 0) return;
const accelSpeed = Math.min(AIR_ACCEL * wishspeed * dt, addSpeed);  // uncapped wishspeed!
velocity.addScaledVector(wishDir, accelSpeed);
```

The target speed is capped at 0.6, but the acceleration *magnitude* still scales off the
uncapped 7. That asymmetry is the whole trick — it is why sweeping the mouse while holding a
strafe key gains speed indefinitely. Using the same value in both places looks like a
tidy-up and silently kills the game.

### Collision without a physics engine

There is no rigid-body solver, no broadphase, no contact manifolds. There are **oriented
boxes and rays.**

- **A collider** (`src/world/Colliders.ts`) is a position, a quaternion, half-extents, and an
  `isWall` flag. `registerCollider()` pushes it into a module-level array and caches the
  inverted quaternion once — the course registers ~160 boxes and the controller fires ~15 rays
  per tick at 128 Hz, so inverting per-test was allocating a million throwaway quaternions a
  second. **Treat a registered collider as immutable.**
- **The registry is global and has no per-object removal.** The only correct way to unload a
  world is `clearColliders()` and rebuild. Everything about world swapping follows from this.
- **`raycast()`** (`src/engine/Raycast.ts`) transforms the ray into each box's local space and
  runs a standard slab test, returning the nearest hit and its world-space normal. It is a
  linear scan over every collider — fine at this count, and the hot path is written to
  allocate nothing (module-level scratch vectors, so the routines are **not re-entrant**).
- **`sweep()` and `groundProbe()`** each fire **five** rays, from a small ring of points at the
  player's radius, standing in for a capsule sweep. One centre ray misses a player straddling
  a platform edge or a ramp seam.
- **`clipVelocity()`** projects velocity onto the surface plane on a hit — Source's
  `PM_ClipVelocity`. That is what makes you *slide along* a ramp instead of stopping dead.
- **Walkable test:** `normal.y >= cos(45.573°)`, i.e. Source's `normal.z >= 0.7`. A surface
  steeper than that never grounds the player.

That last line is the design's keystone. **A surf ramp is a banked wall whose up-component is
deliberately below 0.7**, so the player never grounds, stays permanently airborne, and
air-strafing stays live. Canonical face normal: `(0, ±0.781, 0.625)` — 51.34° from horizontal.

---

## 5. The world

`src/world/RampCurve.ts` builds every piece of level geometry. `buildRampCurve()` takes a start
point, heading, pitch, **roll** (the bank), width, length, and a mode — `'straight'`,
`'vertical'` (pitch sweep) or `'horizontal'` (yaw sweep) — and emits a chain of short box
segments, each rotated a few degrees from the last, edges kept coincident so there is no seam
to kick the player's velocity. It returns the end position and heading so the next piece chains
onto it.

**Mesh and collider come from the same loop**: each segment creates a `BoxGeometry` mesh *and*
calls `registerCollider` with the identical transform. What you see is what you hit.

This mirrors how real surf maps are built by hand — see `docs/CS2_SURF_MAPPING.md`, which
constructs curved ramps the same way, duplicating and rotating a segment a constant few degrees
at a time.

`roll` is what makes a piece a *surf ramp* rather than a chute. At 0 the face is a floor you
walk on; at 90 it is a vertical wall; in between the fall line runs sideways *across* the face
while travel runs *along* its length. You slide down the face and air-strafe back up, tracing
an arc. **A pitched ramp is a downhill chute — the wrong archetype**, and that mistake survived
several sessions because it looks fine in screenshots.

**Ramp surfaces are textured, not flat-shaded.** `src/world/RampTexture.ts` owns the prototype
grid (`public/images/textures/texture_01.png`) that every ramp face, edge and cap wears, and the
UV maths that tiles it at a fixed world scale — one white-bordered cell per 128 Hammer units,
fitted so a face's width holds a whole number of cells. Both ramp builders route through it:
`RampCurve` rewrites its `BoxGeometry` UVs with `applyBoxGridUv`, and the editor's lofted skins
(`RampLibrary.stripUv`) measure along and across the face itself, which is the only way a wall
banked 51° gets square cells. One shared `Texture` for the whole app, and materials take the map
only once the image has decoded — see the comments there for why that matters to the menu tiles.
Pads and platforms are deliberately left plain: they are the one flat thing you can stand on, and
looking different is useful.

The course everybody starts on is **MegaFlow Demo V1** (`src/world/DefaultCourse.ts` +
`default-course.map.json`), authored in the free-mode editor and shipped as data — an ordinary
free map that happens not to come out of the player's storage. The generated course below is no
longer reachable from the menu, but its module stays: `MapData.ts` reads its ramp constants.

`src/world/SurfCourse.ts` assembles the generated course: a floating island orbited by a ring of
**ten banked ramps** at radius 90, plus an approach staircase that feeds the ring. The ring
closes on itself with **no net descent**, which is what makes the run endless. A `CourseStage`
is a rest platform (centre, half-width, half-depth); `Game` uses the stage list for respawns
and for placing the kill plane under the platform you are heading *toward*, so a fall is caught
in a second rather than after a ten-second plummet.

---

## 6. The combat layer

Deliberately simple: **plain arrays with update-and-cull loops**, no ECS — it would be pure
overhead at this entity count. `src/game/EntityManager.ts` owns four lists (`enemies`, `orbs`,
`blasts`, `bolts`) and every add/remove goes through it so scene parenting and disposal stay
paired.

`Game.updateGameplay()` (`src/game/Game.ts`) runs a fixed order every tick, and most steps
are ordered for a reason:

1. Player controller ticks; dash charge ticks and may fire.
2. Track the last stage touched; respawn if below the kill plane.
3. Spawn the Monolith if the level threshold is met — checked *before* the spawn director, so
   the tick a boss arrives on already has drone spawning suspended.
4. Spawn director adds enemies on a ring around the player (`SpawnPlacement`), never in the
   projected collision corridor; the wave in effect (`Waves.waveAt`, from level +
   `bossesFelled`) decides the archetype mix, batch pattern and elite chance.
5. Each enemy steers and may deal contact damage (per-enemy `contactRadius`; fresh spawns
   carry a 1.2 s grace). A straggler left >120u behind the travel direction is
   ring-relocated — same entity, same rewind identity. Seeders plant blasts and spitters
   queue bolts *immediately* after their own tick, so both land on the position that tick
   used.
6. Blasts tick, then bolts fly — after the enemies that produce them, before the death check.
7. Auto-weapon fires at the nearest target; then the solar wake burns (and Standing Wave
   drags) anything sitting in it, and a pending Echo Chamber repeat resolves — all before
   the kill pass, so anything they finish still drops XP this tick. (A dash earlier in the
   tick may have fired the sound blast; Chorus blasts fire right after the kill pass, at
   the victims' positions.)
8. Cull dead enemies (dropping `xpOrbCount` XP orbs each). Nothing is distance-culled —
   enemies persist (hidden past the fog wall, still simulated; left-behind stragglers are
   relocated, never deleted), and uncollected orbs hover where they fell until picked up;
   the spawn director's cap counts only enemies near the fight so stragglers cannot starve
   it.
9. **Player death is resolved first**, so a simultaneous kill is a loss.
10. Last: the wave headline fires if the settled level crossed a boundary (never over a
    boss), flow XP pays out for sustained speed (`FlowXP`), the ultimate meter
    charges, and `Rewind` records the tick. The recorder reads the *settled*
    end-of-tick world — a recorded frame is what the player is handed back if
    they rewind to it, so it must never be a half-updated one.

`Game.state` has two extra states for the ReWind ultimate (`rewinding`,
`rewindCountdown`) in which `updateGameplay` does not run at all: the world is
being written from the recording instead of simulated. See `docs/STATE.md`.

Enemies steer by solving an *interception* on the player's trajectory, not by chasing their
current position — a 12 u/s drone cannot catch a 30 u/s surfer, so chasing means trailing
forever. A **turn-rate cap** (per-enemy `turnRate`) is what makes them dodgeable: re-solving
every tick with unlimited steering is perfect homing and every drone hits. The roster is six
archetypes on one steering core — drone, seeder, swarmer, lancer, bulwark, spitter — each an
`Enemy` subclass differing in `EnemyVisual`, a few instance knobs (`turnRate`,
`contactRadius`, `baseScale`, `xpOrbCount`), and at most one behaviour (a plant timer, a
dash state machine, a standoff band). Any of them can carry the elite affix (`markElite` —
look and drops only; the spawner multiplies the stats).

All scaling lives in one file, `src/enemies/Difficulty.ts`; all *composition* — which
archetypes a wave fields, in what formation, at what elite rate — lives in
`src/enemies/Waves.ts` (five waves per act, act = Monoliths felled, acts 3+ remixed from
the two authored ones). Runs are endless — felling the Monolith continues the run and death
is the only exit.

---

## 7. The UI is DOM, not 3D

Every piece of interface — HUD bars, readouts, main menu, upgrade menu, game-over panel, the
banner, the dash speed lines — is **HTML in `index.html` styled by `src/styles.css`**, layered
over the canvas. Nothing is drawn in the 3D scene, and there is no UI framework: the classes in
`src/ui/` hold element references and set `textContent`, `style.width`, or a CSS custom
property directly.

They are driven from the sim tick, not from CSS animations. `DashEffect` and `Banner` both
count down a `remaining` timer per tick and write opacity themselves — a CSS `@keyframes`
animation needs a forced-reflow hack to restart on a rapid re-trigger, and resetting a counter
does not.

| Class | Owns |
|---|---|
| `Hud` | Speed, HP, XP, level, dash charges, run clock, Monoliths felled, ultimate meter, banked powers |
| `MainMenu` | Mode select at boot |
| `UpgradeMenu` | Power choice of three (**keyboard 1/2/3** — see pointer lock, §2) |
| `BankMenu` | Banked powers: spend-or-gamble, and the blind roll's reveal |
| `CountdownToggle` | The `C` tickbox on both power screens; state lives in `Settings` |
| `GameOverScreen` | Death panel and restart |
| `Banner` | Transient headline that pauses nothing |
| `BossBar` | Monolith health |
| `DashEffect` | Full-screen anime speed lines |
| `UltimateEffect` | ReWind: activation shockwave, purple flames, seconds readout |
| `Countdown` | The shared 3-2-1 — both a ReWind and a cash-in resume through it |
| `UltimateArc` | The ReWind meter as a half-ring around the crosshair |
| `SettingsPanel` | FOV + sensitivity, on `Escape`; doubles as the pause screen; hosts the convar bench under Advanced Settings |
| `MainMenu` | Stacked PLAY/EDITOR/SETTINGS, plus the play page's map tiles |
| `PauseMenu` | Mid-run `Escape`: Continue / Restart / Settings / Quit |
| `MapThumbnails` | Aerial renders of whole courses, for those tiles |

---

## 8. Adding models — read this first

**The project currently has zero art assets.** No loaders, no `public/` directory, no image or
model files. Everything is built from Three.js primitives in code. Even the one texture in the
codebase is generated as a `DataTexture` from a hand-filled `Uint8Array` (`src/combat/Tracer.ts:146`),
specifically so that module can run headlessly in node where there is no DOM.

So "adding a small model" splits into two genuinely different options.

### Option A — build it in code (what the project does today)

The pattern to copy is `buildRightHand()` (`src/player/Hands.ts`) or `PlayerModel.buildHead()`:
make a `Group`, add primitives positioned in local space, share one material per colour. (The
old combat knife went further — a 2D `Shape` outline extruded into a blade; it was cut with
the knife weapon, but the technique is in git history under `KnifeHand.ts` if a non-box
silhouette is ever needed again.)

For enemies there is already a seam: `EnemyVisual` (`src/enemies/Enemy.ts`) is
`{ geometry, color, emissive, emissiveIntensity }`, and it exists so a subclass can be a
different shape without reimplementing any steering. That is exactly how `Seeder` (a violet
octahedron), `Swarmer` (acid-green tetra), `Lancer` (bone-white spike), `Bulwark` (cobalt
boulder) and `Spitter` (emerald disc) differ from a drone (a red sphere). A new archetype
also needs: stats in `Difficulty`, a case in `SpawnDirector.buildEnemy` (the switch is
exhaustive — the compiler will point at it), weights in a `Waves.ts` table, and a kind tag
plus reconstruction branch in `Rewind.ts` — miss that last one and the rewind rebuilds it
as a plain drone.

Costs nothing, needs no loader, no asset pipeline, and diffs as text in git. It is why the
game currently looks the way it does.

### Option B — load a `.glb` (a new capability for this repo)

Real modelled assets are not hard, but be clear that this is a **new capability, not a tweak**.
It brings:

- `GLTFLoader` (ships with Three.js, imported from `three/examples/jsm/`).
- A `public/` directory, and asset URLs that must respect Vite's `base` — which is
  `/surf-proto/` in production for GitHub Pages (§9). Hardcoded absolute paths will 404 on the
  deployed site while working fine in dev.
- **Async loading**, which the current construction path does not accommodate anywhere —
  `SurfCourse`, `ViewModel`, and every enemy are built synchronously in a constructor. Either
  everything preloads before the run starts (and something is shown meanwhile), or objects
  appear a beat late.
- A decision about model scale: **1 unit = 45 Hammer units**, so the player is roughly 1.6
  units tall. Most exported models will need scaling down hard.

### Rules any new visual must follow, either way

- **Register no collider** unless the thing is meant to be solid. Decoration is mesh-only.
- **Share geometry at module level; own materials per instance if they animate.** Enemies each
  construct their own `MeshStandardMaterial` because they flash on hit by writing `emissive`;
  they share one module-level `SphereGeometry`.
- **Every removal path must dispose.** `disposeObject()` (`src/engine/Dispose.ts`) frees
  geometry and materials under a root. WebGL buffers are not reachable by the GC through the JS
  objects alone, and the editor rebuilds meshes on every drag step — without disposal, dragging
  a ramp for a minute leaks thousands of GPU buffers.
- **Drive transforms from the sim tick, not the render frame.** Anything gameplay-relevant
  moves on the 1/128 s step.
- **Two lighting gotchas already paid for:** additive blending desaturates against the bright
  sky (combat flashes need *normal* blending — learned on the old slash cone, and the sound
  blast and solar wake follow it), and high `emissiveIntensity` on saturated
  colours clips to white.

---

## 9. Build, deploy, dev handle

```
npm install
npm run dev      # localhost:5173, hot reload
npm run build    # tsc -b && vite build  — must pass before any commit
npm run preview  # serve the production build locally
```

`vite.config.ts` sets `base` to `/surf-proto/` for production builds, because GitHub Pages
serves a project site under `/<repo>/`. Deploying anywhere that serves from the domain root
needs `BASE_PATH=/ npm run build`, or every asset URL 404s.

`.github/workflows/deploy.yml` builds on every push to `main` and publishes `dist/` to Pages:
https://slimsheikki.github.io/surf-proto/

`window.__surf` is the live `Game` instance, assigned in `App.beginRun` behind
`import.meta.env.DEV`. Vite constant-folds that to `false` and drops the branch from production
(`grep __surf dist/` is empty). It exists because the late game — ten levels and a 2200 HP boss
— is unreachable by scripted input in any reasonable time, so without it that code path can
only be tested by playing it.

---

## 10. Where to look for what

| Directory | Responsibility | Read first |
|---|---|---|
| `src/app/` | Composition root, renderer, mode switching, frame loop | `App.ts` |
| `src/engine/` | Reusable primitives: fixed clock, input, raycasting, math, disposal | `Raycast.ts` |
| `src/player/` | Controller, tuning constants, camera, first/third-person models, dash | `PlayerController.ts` |
| `src/world/` | Ramp geometry generation, ramp texturing, the built-in course, collider registry | `RampCurve.ts` |
| `src/game/` | Run orchestration and tick order, entity lists | `Game.ts` |
| `src/enemies/` | Drones, seeders, the Monolith, spawn director, difficulty scaling | `Enemy.ts` |
| `src/combat/` | Auto-weapon, sound blast, solar wake, projectiles, blasts, health | `Weapon.ts` |
| `src/progression/` | XP orbs, levelling, the upgrade pool | `Upgrades.ts` |
| `src/ui/` | DOM overlay classes | `Hud.ts` |
| `src/editor/` | Free mode: fly camera, palette, map storage, share codes | `Editor.ts` |
| `src/audio/` | Background music: track pool, random per-run pick, fades, volume | `MusicManager.ts` |

Roughly 8,900 lines of TypeScript across 45 files. The comments are unusually dense and mostly
explain *why* rather than *what* — several of them record a mistake that cost a session, so
they are worth reading before changing the code they sit on.
