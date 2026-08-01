# surf-proto — working notes

Browser game: **CS:S surf movement is the point**, a Vampire-Survivors/Megabonk combat
layer is secondary and must never make the player stop surfing to fight.

Vite + TypeScript + Three.js. **No physics engine** — the controller is a hand-rolled
kinematic pipeline mirroring Source's `PM_AirAccelerate` / `PM_Friction` /
`PM_ClipVelocity` / `PM_GroundTrace`. A constraint solver fights this; don't add one.

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

## Free mode

A second mode off the main menu: a free-camera map editor where ramps are dragged in from
a side palette, moved in 3D, and played. `src/app/App.ts` is the switcher above `Game`;
`src/editor/` is the editor. Two rules there have the same status as the invariants above
— **the editor registers no colliders** (they cannot be retired, and a drag rebuilds
meshes every step), and **`Game` is constructed once and re-pointed with `setCourse`** (the
terminal screens bind restart listeners in their constructors). See `docs/STATE.md`.

## Where things stand

See **`docs/STATE.md`** — current known bugs, tuning constants, and what's next. Read that
before starting work; update it before finishing.
