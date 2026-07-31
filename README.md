# surf-proto

A CS-surf-style movement prototype (air-strafing, bunnyhop, curved surf ramps) with a
lightweight Megabonk/Vampire-Survivors-style combat layer riding on top. Built with
Vite + TypeScript + Three.js, no physics engine — the character controller is a
hand-rolled kinematic pipeline (ground/air acceleration, ClipVelocity ramp sliding).

## Run

```
npm install
npm run dev
```

Open the printed localhost URL, click to enable pointer lock, then:

- `WASD` — move
- mouse — look (also drives air-strafe direction)
- `Space` — jump / bunnyhop (hold to auto-bhop)
- `V` — toggle first-person / third-person camera
