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

The first pass draws the world. The second draws the first-person hands and knife, which live
in **their own `Scene` with their own `Camera`** (`src/player/ViewModel.ts`), on top of a
wiped depth buffer. `renderer.autoClear = false` is set in the constructor to make this
possible.

The reason is specific to this game: on a surf map you ride with your shoulder against the
geometry, so a viewmodel sharing the world's depth buffer gets sliced in half by ramps
constantly. Drawing it as a separate pass over cleared depth means it composites on top
unconditionally and can never intersect the level. CS does the same thing, including the
narrower viewmodel FOV (55° vs the world's 75°).

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

`src/world/SurfCourse.ts` assembles the standard course: a floating island orbited by a ring of
**ten banked ramps** at radius 90, plus an approach staircase that feeds the ring. The ring
closes on itself with **no net descent**, which is what makes the run endless. A `CourseStage`
is a rest platform (centre, half-width, half-depth); `Game` uses the stage list for respawns
and for placing the kill plane under the platform you are heading *toward*, so a fall is caught
in a second rather than after a ten-second plummet.

---

## 6. The combat layer

Deliberately simple: **plain arrays with update-and-cull loops**, no ECS — it would be pure
overhead at this entity count. `src/game/EntityManager.ts` owns three lists (`enemies`, `orbs`,
`blasts`) and every add/remove goes through it so scene parenting and disposal stay paired.

`Game.updateGameplay()` (`src/game/Game.ts:241`) runs a fixed order every tick, and most steps
are ordered for a reason:

1. Player controller ticks; dash charge ticks and may fire.
2. Track the last stage touched; respawn if below the kill plane.
3. Spawn the Monolith if the level threshold is met — checked *before* the spawn director, so
   the tick a boss arrives on already has drone spawning suspended.
4. Spawn director adds drones/seeders ahead of the player's travel direction.
5. Each enemy steers and may deal contact damage. Seeders plant blasts *immediately* after
   their own tick, so a blast lands on the position that tick used.
6. Blasts tick — after the seeders that plant them, before the death check.
7. Auto-weapon fires at the nearest target; then the knife swing resolves — before the kill
   pass, so a drone finished by the knife still drops XP this tick.
8. Cull dead enemies (dropping XP orbs), then distant ones (**awarding nothing** — leaving play
   is not a kill). Orbs magnet toward the player and are collected.
9. **Player death is resolved first**, so a simultaneous kill is a loss.

Enemies steer by solving an *interception* on the player's trajectory, not by chasing their
current position — a 12 u/s drone cannot catch a 30 u/s surfer, so chasing means trailing
forever. A **turn-rate cap** is what makes them dodgeable: re-solving every tick with unlimited
steering is perfect homing and every drone hits.

All scaling lives in one file, `src/enemies/Difficulty.ts`. Runs are endless — felling the
Monolith continues the run and death is the only exit.

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
| `Hud` | Speed, HP, XP, level, dash charges, run clock, Monoliths felled |
| `MainMenu` | Mode select at boot |
| `UpgradeMenu` | Level-up choice of three (**keyboard 1/2/3** — see pointer lock, §2) |
| `GameOverScreen` | Death panel and restart |
| `Banner` | Transient headline that pauses nothing |
| `BossBar` | Monolith health |
| `DashEffect` | Full-screen anime speed lines |

---

## 8. Adding models — read this first

**The project currently has zero art assets.** No loaders, no `public/` directory, no image or
model files. Everything is built from Three.js primitives in code. Even the one texture in the
codebase is generated as a `DataTexture` from a hand-filled `Uint8Array` (`src/combat/Tracer.ts:146`),
specifically so that module can run headlessly in node where there is no DOM.

So "adding a small model" splits into two genuinely different options.

### Option A — build it in code (what the project does today)

The pattern to copy is `ViewModel.buildKnife()` (`src/player/ViewModel.ts:314`): make a
`Group`, add primitives positioned in local space, share one material per colour. The knife is
a handle box, grip ridges, a pommel, a guard, a bolster, and a blade — the blade being the one
place the project goes beyond boxes, drawing a 2D `Shape` outline and extruding it
(`buildBladeGeometry`, `src/player/ViewModel.ts:204`).

For enemies there is already a seam: `EnemyVisual` (`src/enemies/Enemy.ts:40`) is
`{ geometry, color, emissive, emissiveIntensity }`, and it exists so a subclass can be a
different shape without reimplementing any steering. That is exactly how `Seeder` (a violet
octahedron) differs from a drone (a red sphere).

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
  sky (the slash cone needs *normal* blending), and high `emissiveIntensity` on saturated
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
| `src/player/` | Controller, tuning constants, camera, first-person viewmodel, dash | `PlayerController.ts` |
| `src/world/` | Ramp geometry generation, the standard course, collider registry | `RampCurve.ts` |
| `src/game/` | Run orchestration and tick order, entity lists | `Game.ts` |
| `src/enemies/` | Drones, seeders, the Monolith, spawn director, difficulty scaling | `Enemy.ts` |
| `src/combat/` | Auto-weapon, knife, projectiles, blasts, health | `Weapon.ts` |
| `src/progression/` | XP orbs, levelling, the upgrade pool | `Upgrades.ts` |
| `src/ui/` | DOM overlay classes | `Hud.ts` |
| `src/editor/` | Free mode: fly camera, palette, map storage, share codes | `Editor.ts` |

Roughly 8,900 lines of TypeScript across 45 files. The comments are unusually dense and mostly
explain *why* rather than *what* — several of them record a mistake that cost a session, so
they are worth reading before changing the code they sit on.
