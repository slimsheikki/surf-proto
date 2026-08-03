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

**Ring ramps must close on themselves with no net descent** — that is what makes the loop
endless. Verify with a collision probe, not by eye.

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

- Additive blending desaturates against the bright sky — the slash cone needs *normal*
  blending. High `emissiveIntensity` on saturated colours clips to white.
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
  Chrome also refuses a re-lock for ~1 s afterwards, so `pointerlockerror` has to put the
  panel back or the player is left on a paused world with no prompt.
- Playwright's synthetic `Escape` does **not** trigger the native pointer-lock exit. Test
  that path with `document.exitPointerLock()`.
- `UpgradeMenu` reads `e.key`, not `e.code` — a synthetic `{code:'Digit1'}` is ignored, and a
  headless test that "picks an upgrade" that way silently sits in the paused state forever.

## Endless runs

There is **no win state** — felling the Monolith continues the run, and death is the only
exit. All scaling lives in `src/enemies/Difficulty.ts`; when you touch it, check that
`difficultyAt(1, 120)` still returns the pre-endless numbers, because a level term applied
to an unfloored time term silently retunes the early game. Monoliths recur every 10 levels,
scaled. The seeder (`src/enemies/Seeder.ts`) plants dodgeable AoE spheres whose escape speed
is deliberately just above walk speed: it is the enemy that punishes *not* surfing.

`window.__surf` is a dev-only handle on the live `Game` (stripped from prod) — the late game
is otherwise unreachable by scripted input. See `docs/STATE.md`.

## The ReWind ultimate

Hold **R** at 100% to run up to 15 s of the run backwards; release to resume
after a 3-2-1 countdown. `src/game/Rewind.ts` records **state, not diffs** —
that is the only reason "rewind the powerups too" is tractable, since an upgrade
is an arbitrary mutation and the pool cannot be asked to invert one. **A new
upgrade is only rewound if the field it writes is listed in `Frame`.**
`Ultimate.LEVEL_GROWTH` is deliberately the same 0.07 that `difficultyAt`
divides the spawn interval by; move them together. See `docs/STATE.md`.

## Blessings

Collecting one removes it; 30 s later it comes back at a random point on the **endless ring**
(`ShrineRespawn.ts`). "Reachable" is answered by construction — candidates are drawn from the
same envelope the authored ring shrines occupy — and never from the approach, which is
one-way. A shrine's position is mutable now, so it is part of `Rewind`'s `Frame`.

## Free mode

A second mode off the main menu: a free-camera map editor where ramps are dragged in from
a side palette, moved in 3D, and played. `src/app/App.ts` is the switcher above `Game`;
`src/editor/` is the editor. Two rules there have the same status as the invariants above
— **the editor registers no colliders** (they cannot be retired, and a drag rebuilds
meshes every step), and **`Game` is constructed once and re-pointed with `setCourse`** (the
terminal screens bind restart listeners in their constructors). See `docs/STATE.md`.

The front menu's map tiles render **real geometry** for their aerial thumbnails
(`ui/MapThumbnails.ts`), which means they call `buildFreeWorld(map, **false**)` —
the colliders flag is not optional, or every map in storage joins the collision
world.

Maps are shared as links, not through a server (`src/editor/MapCode.ts`): JSON → deflate →
base64url behind a format tag, carried in the URL **fragment** so it never reaches a host.
Decoding routes through `parseMap`, imported names go through `uniqueMapName` (or Save
overwrites the recipient's own map of that name), and the hash is cleared after import.

## Where things stand

See **`docs/STATE.md`** — current known bugs, tuning constants, and what's next. Read that
before starting work; update it before finishing.
