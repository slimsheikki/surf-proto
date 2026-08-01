# surf-proto

A Counter-Strike-surf movement prototype — banked ramps, air-strafing, bunnyhopping —
with a lightweight Vampire-Survivors/Megabonk combat layer riding on top. Surfing is
the point; the combat is secondary.

Built with Vite + TypeScript + Three.js and **no physics engine**: the character
controller is a hand-rolled kinematic pipeline that mirrors Source's movement code
(`PM_AirAccelerate`, ground friction applied after the jump check so bunnyhopping keeps
its speed, and `ClipVelocity` against ramp surfaces).

## Play

**In a browser:** https://slimsheikki.github.io/surf-proto/ *(live once GitHub Pages is
enabled — Settings → Pages → Source: "GitHub Actions")*

**Locally:**

```
npm install
npm run dev
```

Open the printed URL and **click the page** to capture your mouse.

| | |
|---|---|
| `W` `A` `S` `D` | move |
| mouse | look — this is also what steers your surf |
| `Space` | jump (hold for auto-bunnyhop) |
| `V` | first / third person |
| `Esc` | release the mouse |

## How to surf

Surfing does not work like normal movement. Played like a platformer you will just fall
off. The ramps are steep **banked walls**, and the trick is that they're too steep to
stand on — so you are permanently airborne, and air-strafing is what holds you up.

1. **Walk forward off the start pad.** Hold `W` for a couple of seconds; the pad is deep.
2. **You drop into a V-shaped channel** with an angled wall on each side, and land on one.
3. **Let go of `W`.** Counterintuitive, but holding `W` or `S` on a ramp slides you off —
   same as it does in real CS surf.
4. **Hold the strafe key toward the wall's high side while sweeping the mouse the same
   way** — `D` with a rightward sweep, `A` with a leftward one. Key and mouse must agree.
   That's air-strafing, and it's where speed comes from.
5. **Steer with your view:** look *into* the wall to climb, *away* to slide down. Trading
   height for speed and back is the whole game.

Watch the speed readout bottom-left. At `7.0` or below you're walking on something. Above
`7.0` you're on a face and actually surfing. Slide out of the bottom of the channel and
you're teleported back to the last platform you touched.

## Objective

Survive. Drones fly at you, your weapon auto-fires at the nearest one (no aiming needed),
kills drop XP orbs that pull toward you, and levelling up offers a choice of three
upgrades. At zero HP the run ends.

## Scale

Everything is pinned to **1 game unit = 45 Hammer units**, from matching CS's
`sv_maxspeed` 320 to a 7 u/s walk. Gravity, jump height, and the 45.573° walkable-slope
cutoff (Source's `normal.z >= 0.7`) all follow from that, so angles and dimensions
measured off real surf maps transfer directly. See `docs/` for the CS surf design
reference the level is held against.

## Deploying elsewhere

The production build assumes it's served from `/surf-proto/`. For a host that serves from
the domain root, build with `BASE_PATH=/ npm run build`.
