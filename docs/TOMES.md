# Tomes — a tiered, stacking upgrade family

Design spec. **No code has been written for this yet** — this document is the
thing to argue with before any of it ships.

"Tome" is a placeholder name (see § 0). Numbers are a first pass with their
derivations shown, not tuned values; § 6 says how to check them.

---

## Why

The pool (`src/progression/Upgrades.ts`) is 35 flat entries — 24 visible, drawn
3-at-a-time uniformly, and 11 gamble-only. Every entry is a one-shot mutation
with no ladder: `+Damage` is `+3` on the first pick and `+3` on the twentieth,
and rarity is nearly cosmetic in a pick menu, since common and rare are drawn
with *identical* probability. Only epic and legendary are genuinely gated.

Tomes add the axis the pool lacks: **one item, four tiers, numbers that scale
with the tier, stacks that accumulate on a curve.** Depth on a stat you have
committed to, rather than another row in a draw the docs already flag as thin.

---

## 0. The name

"Tome" doesn't fit — there are no books in MEGAFLOW. Candidates in the existing
voice (solar/botany and wave physics, real terms, no invented compounds):

- **Cell** — solar cell. "Surf Cell", "Prism Cell". One syllable, solarpunk,
  and the plural already reads as a collection. The strongest option.
- **Seed** — botany, and a thing that *grows* reads the stacking for free.
- **Lens**, **Panel** — both fit, both weaker.

This document says "Tome" throughout so it is one find-and-replace.

---

## 1. Stacking is diminishing returns — four shapes, two of them useful

| Shape | Formula | Behaviour |
|---|---|---|
| **Linear-additive** | `bonus = step · s` | Constant absolute gain. *Relative* gain diminishes on its own — the 10th +14% is a smaller share of your total than the 1st. What the pool does today. |
| **Multiplicative** | `(1+x)ⁿ` | Snowballs. Never use. |
| **Hyperbolic softcap** | `bonus = CAP · s/(s+K)` | Approaches CAP, never reaches it. `K` is the stack count at half-cap. |
| **Geometric decay** | `step · rⁿ⁻¹` | Converges to `step/(1−r)`. Same job as hyperbolic, harder to reason about. Skip. |

**The rule:** linear where runaway *is* the fun — damage, HP, regen, XP.
Hyperbolic softcap for anything that breaks a system if it goes too far — air
control, damage reduction, cooldowns, area, range.

The pool already has hand-rolled versions of the second kind: `standingWaveSlow`
climbing `0.3 → 0.4 → 0.5 → 0.55(cap)`, and `Math.max(1.5, rechargeSeconds − 1.2)`.
Both become plain hyperbolic curves under this scheme and lose their clamps —
the difference being that a clamp is a wall four picks slam into, and a curve is
one nobody ever quite reaches.

### Stack weight, not stack count

A Tome writes **one** `RunPerks` field: an accumulated weight `s`. Each pick adds
its tier's weight.

| Tier | Weight added to `s` |
|---|---|
| Common | **1.0** |
| Uncommon | **1.75** |
| Epic | **2.75** |
| Legendary | **4.5** |

One legendary Surf Tome ≈ four-and-a-half commons, and every Tome needs exactly
one field and one formula no matter which tier it arrived at.

**The ladder is read off what already shipped**, not invented: `epic-overclock`
is 2.67× `+Attack Speed`, `epic-tailwind` is 2.5× `+Move Speed`, `legend-apex` is
4.7× `+Damage`, `legend-perpetual` is 4.2× `+Move Speed`. 1 / 1.75 / 2.75 / 4.5
sits inside that band.

### How many stacks is realistic

Visible pool 26, drawn 3 at a time → a given Tome appears in ~11.5% of menus.
Over a 40-level run that is ~4-5 offers; a player building for it takes 3-4.
**Tune so `s ≈ 8` is strong, `s ≈ 15` is the practical ceiling, and the asymptote
sits somewhere you would never mind reaching.** Every table below reads at
s = 1, 3, 8.

### Legendary riders

A Tome at legendary is 4.5 weight *and* a one-line named clause, so a legendary
is a moment rather than a bigger number. Epic gets no rider — that is what keeps
the weight ladder honest.

---

## 2. The Tomes

Fourteen, covering every build axis. `s` is the accumulated weight above.

### Offense

#### 1. Ember Tome — *"Your shots carry more heat."*

`weapon.damage = 7 · (1 + 0.14·s)` — linear.
**s=1 → ×1.14 · s=3 → ×1.42 · s=8 → ×2.12**

Replaces `+Damage`. **The single biggest retune in the proposal:** today's `+3`
on a base of `7` is **+43% of base per pick**, which is why flat picks dominate
and why any percentage-based damage stat cannot compete with them. Moving to
+14%/stack is a deliberate flattening, and it must be checked against
`Difficulty.ts`'s enemy-HP curve before it ships.

*Legendary rider:* **Ignition** — a kill's overkill damage splashes to the nearest
enemy inside the Bloom radius.

#### 2. Cadence Tome — *"The gun keeps a faster time."*

`weapon.attacksPerSecond = 4 + 0.55·s` — linear.
**s=1 → 4.55 · s=3 → 5.65 · s=8 → 8.4**

Replaces `+Attack Speed`. Stacks on top of Doppler Drive's speed-scaled bonus,
which is applied per-tick and unchanged.

*Legendary rider:* **Downbeat** — every 12th shot fires a free Sound Blast at the
target. Reuses `applySoundBlast`; no new system.

#### 3. Beam Tome — *"Light reaches further before it gives up."*

`weapon.range = 22 + 30·s/(s+7)` — **softcap**, → 52 at infinity.
**s=1 → 25.8 · s=3 → 31.0 · s=8 → 38.0**

Replaces `+Range`. Capped because uncapped range turns the whole course into one
kill volume and quietly deletes the decision to surf *toward* a fight.

**This is the Projectile Tome's slot.** There are no projectiles here — the
weapon is hitscan and `Tracer.BOLT_SPEED` is cosmetic — so "how fast your shot
arrives" becomes "how far it reaches", which is the honest local equivalent.

*Legendary rider:* **Collimation** — shots no longer drop the sticky target when
it leaves range; they hold until it dies.

#### 4. Prism Tome — *"White light splits. So does damage."* — new system

Refraction chance `c = 0.09·s` — **linear and deliberately uncapped**, because
the overflow *is* the diminishing return.
**s=1 → 9% · s=3 → 27% · s=8 → 72% · s=11.1 → 100%**

Above 100%, **Overrefraction**:
`crits = floor(c) + (rand < frac(c) ? 1 : 0)`, damage `× (1 + crits)`.
So 100% is every shot at ×2; 200% is every shot at ×3. Going 100→200% is worth
strictly less than 0→100% as a share of total DPS — the softcap without a softcap.

**This is the Precision Tome's slot, and it keeps Overcrit.** Refraction, prisms
and split light are the solarpunk reading of a critical hit.

*Legendary rider:* **Spectrum** — a refracted shot also burns its target at
`solarWaveDps` for 2 s, whether or not you own Solar Wave.

#### 5. Bloom Tome — *"Everything you set off opens wider."* — new system

Area multiplier `a = 1 + 0.9·s/(s+7)` — **softcap**, → ×1.9 radius at infinity.
**s=1 → ×1.11 · s=3 → ×1.27 · s=8 → ×1.48**

Multiplies `soundBlastRadius`, `SolarWave.BURN_RADIUS` and `MIRROR_RADIUS`.

**This is the Size Tome's slot.** Hard-capped because **area goes as the square** —
×1.9 radius is already ×3.6 area, and a linear radius stat would be quadratic in
kills.

*Legendary rider:* **Full Bloom** — your dash blast also strips 25% speed from
everything it touches. Reuses `WeaponTarget.applySlow`.

### Movement — the part that must not break

#### 6. Surf Tome — *"The line answers you sooner."*

Two curves, both **softcapped**:

```
MAX_AIR_WISH_SPEED = 0.6667 · (1 + 0.30·s/(s+6))   → +30% at infinity
MAX_GROUND_SPEED   = 7 + 4.0·s/(s+5)               → 11 u/s at infinity
```

**s=1 → +4.3% air · s=3 → +10% air · s=8 → +17% air**

Replaces `+Move Speed`. **This is a nerf to the per-pick value, and that is the
point.** `docs/STATE.md` § Next up already flags `epic-tailwind`'s
`MAX_AIR_WISH_SPEED += 0.15` — **+22% off a single pick** — as the one open
balance risk in the pool, and today's `+Move Speed` is +9% per pick with **no
ceiling at all**. A hard +30% across every stack in a run is a tightening.

> **Open finding, needs a decision either way.** `FlowXP`'s comment asserts flow
> is "unreachable on foot by construction": walk cap 7 + dash impulse 8 = 15,
> under the 16 floor. Today's uncapped `+Move Speed` stacks already breach that;
> an 11 u/s ceiling makes it 19 and breaches it worse. Either raise
> `FLOW_MIN_SPEED`, exclude the dash impulse from the flow measure, or accept it —
> but it should be a decision, not a side effect.

*Legendary rider:* **Laminar** — landing on a ramp within 0.3 s of leaving one
keeps full speed instead of clipping. A scoped, opt-in `SURF_LANDING_REDIRECT`.

#### 7. Updraft Tome — *"You leave the ground with more to spend."*

```
JUMP_SPEED         = 6.711 + 4.5·s/(s+5)   → 11.2 at infinity
DASH_IMPULSE_SPEED = 8 + 5·s/(s+5)         → 13 at infinity
```

**s=1 → jump 7.46 · s=3 → 8.40 · s=8 → 9.48**

Replaces `+Jump Height`, and makes dash strength upgradeable for the first time —
`DASH_IMPULSE_SPEED` is currently a module constant in `PlayerController.ts:80`.

*Legendary rider:* **Thermal** — one free air-jump, refunded on every ramp touch.

#### 8. Kite Tome — *"The dash comes back before you miss it."*

```
dash.rechargeSeconds = 6 − 4.5·s/(s+4)   → 1.5 s at infinity
dash.maxCharges      = 2 + floor(s/3)
```

**s=1 → 5.1 s · s=3 → 3.7 s, +1 charge · s=8 → 3.0 s, +2 charges**

Replaces `Quick Recovery` **and** `Extra Dash`. The curve lands on the existing
1.5 s floor asymptotically, so `Math.max(1.5, …)` disappears rather than being a
wall four picks hit.

*Legendary rider:* **Slipknot** — a dash that kills something refunds its charge.

### Survival

#### 9. Heartwood Tome — *"More of you to lose."*

`playerHealth.maxHp = 100 + 18·s`, healed to match — linear.
**s=1 → 118 · s=3 → 154 · s=8 → 244**

Replaces `+Max HP`.

*Legendary rider:* **Heartwood** — the first hit that would kill you leaves you at
1 HP instead. Once per Monolith.

#### 10. Chlorophyll Tome — *"You mend in the light."*

`playerHealth.regenPerSecond = 1.3·s` — linear.
**s=1 → 1.3 · s=3 → 3.9 · s=8 → 10.4**

Replaces `Regeneration`. Distinct from Photosynthesis, which is airborne-only and
stays as its own build piece.

*Legendary rider:* **Evergreen** — regen doubles while above the flow floor.

#### 11. Graft Tome — *"What you kill, you keep."*

`perks.healOnKill = 1.8·s` — linear.
**s=1 → 1.8 · s=3 → 5.4 · s=8 → 14.4**

Replaces `Vampiric Edge`.

*Legendary rider:* **Rootstock** — kills past full HP bank into a shield worth up
to 25% of max HP.

#### 12. Albedo Tome — *"You send some of it back."* — new system

`damageReduction = 0.55·s/(s+6)` — **hyperbolic, mandatory**.
**s=1 → 7.9% · s=3 → 18.3% · s=8 → 31.4% · ∞ → 55%**

The one defensive stat the game has no version of. Applied at the three
incoming-damage sites: contact, seeder `Blast`, Monolith beam.

Hyperbolic **because a linear reduction stat reaches immunity and ends the run's
tension**. This shape cannot.

*Legendary rider:* **Specular** — damage you resist is dealt back as a Mirror
Array flash, whether or not you own Mirror Array.

### Economy

#### 13. Pollen Tome — *"It drifts to you now."*

```
perks.xpMultiplier = 1 + 0.18·s              — linear
XP_MAGNET.radius   = 18 + 26·s/(s+6)         — softcap, → 44 at infinity
```

**s=1 → ×1.18 XP, r=21.7 · s=3 → ×1.54, r=26.7 · s=8 → ×2.44, r=32.9**

Replaces `XP Magnet` **and** `Scholar`. Radius is capped so it cannot outgrow the
weapon's 22-unit kill envelope by so much that pickup stops being a positioning
decision.

*Legendary rider:* **Anemophily** — orbs you leave behind chase you for 4 s past
the point they would normally give up.

#### 14. Flux Tome — *"The line pays better."*

```
flowRateMultiplier       = 1 + 0.15·s
ultimateChargeMultiplier = 1 + 0.12·s
```

**s=1 → ×1.15 / ×1.12 · s=3 → ×1.45 / ×1.36 · s=8 → ×2.20 / ×1.96**

Both linear. The flow multiplier is applied **after** `FLOW_XP_PCT_CAP`, the same
way Aurora Wake is, so it is not dead exactly where flow is strongest.

New entry — nothing in the pool covers flow or ultimate charge rate outside of
Aurora Wake and Solar Capacitor, and both of those are conditional.

*Legendary rider:* **Standing Flux** — ReWind's window grows from 15 s to 20 s.

---

## 3. Pool arithmetic

| | Before | After |
|---|---|---|
| Visible entries | 24 | **26** (14 Tomes + 12 named build pieces) |
| A given entry per 3-card menu | 12.5% | **11.5%** |
| Gamble-only uniques | 11 | 11 (unchanged) |
| Tomes reachable at epic/legendary | — | all 14, gamble-only |

**One pool entry per Tome, tier rolled at offer time.** 14 Tomes is 14 rows, not
56. Pick menus roll common/uncommon; the F-gamble rolls epic/legendary — so the
existing "epic and legendary are gamble-only" rule survives untouched, and a
tiered Tome becomes another reason to stake a full bank.

Twelve entries fold in and stop being separate rows: `damage`, `attack-speed`,
`weapon-range`, `max-hp`, `jump-height`, `move-speed`, `magnet`, `scholar`,
`dash-recharge`, `extra-dash`, `regen`, `vampiric`.

**Untouched:** Photosynthesis, Heliotropism, Doppler Drive, Subwoofer, Velocity
Rounds, Sound Blast, Solar Wave, Solar Capacitor, Aurora Wake, Mirror Array, Echo
Chamber, Standing Wave, and all 11 gamble uniques. Those are build pieces, not
stat sliders, and the Tome frame would flatten them.

---

## 4. Tier vocabulary

The request says **Common / Uncommon / Epic / Legendary**; the code's second tier
is `rare`. Renaming `rare` → `uncommon` is mechanical but touches four places:
the `Rarity` type and every entry's `rarity` field, `.rarity-rare` in
`styles.css`, `BankMenu`'s tier headline, and `VISIBLE_RARITIES`.

The alternative is reading "Uncommon" as the existing `rare` and changing
nothing. Either is fine; the rename is assumed below.

---

## 5. What it costs to build

**`src/progression/Upgrades.ts`** — `Upgrade` gains a marker so a Tome is one row
rollable at any tier; `drawUpgradeChoices` rolls common/uncommon per offered Tome;
`drawOfRarity` draws from `{uniques of that tier} ∪ {all Tomes}`.

**`RunPerks`** — 14 new weight fields (`surfTome`, `emberTome`, …) plus derived
getters. `PERK_DEFAULTS` / `resetRunPerks` need no per-field work; that contract
already holds.

**`src/game/Rewind.ts`** — 14 `Frame` fields, 14 lines in `write()`, 14 in
`applyFrame()`. Non-negotiable: *"an upgrade whose field is not in `Frame` is one
a rewind silently leaves applied."* Note that the weight-field design means **one**
field per Tome however many stats it drives — derived values are recomputed, not
recorded.

**Four new systems:** the crit roll in `Weapon.tick`; an area multiplier read at
the `applySoundBlast` / `SolarWave` / mirror-flash call sites; `damageReduction`
on `Health.takeDamage` (player instance only); and `DASH_IMPULSE_SPEED` promoted
from a `PlayerController` constant to a `MovementConfig` field, which gets its
restart reset for free via `resetMovementConfig`.

**UI** — `UpgradeMenu`'s card should show the rolled tier and the current stack
count (`SURF TOME · uncommon · ×3`). That is a genuine new affordance: nothing in
the game surfaces stacking today, and a tiered pool without it is unreadable.

**Docs** — `docs/STATE.md` and `docs/MegaFlow_Changes_Additions_Fixes.md` in the
same commit, per the project's own rule.

---

## 6. Verification

Numbers this dense are not eyeballable. The probe harness (`.probe-powerups.ts`,
`.probe-bank.ts`) is gitignored and no longer in the tree, so it has to be
rewritten — esbuild-bundled, run under node with
`--define:import.meta.env='{"BASE_URL":"/","DEV":false}'` and a `globalThis.document`
stub providing `createElementNS`.

1. **Curve probe** — for each Tome apply s = 1, 3, 8, 20 and assert the derived
   stat matches the tables above; assert every softcapped stat is monotonic and
   still under its asymptote at s = 1000.
2. **Rewind probe** — apply every Tome at every tier, record 2 s, rewind past the
   pick, assert every derived stat is back at its pre-pick value. This is the one
   that catches a missed `Frame` field.
3. **Restart probe** — `MovementConfig`, `XP_MAGNET`, `Weapon`, `Health` and
   `Dash` all back to authored defaults after `restart`, with 30 Tomes applied
   first.
4. **The two open findings**, each answered with a measurement rather than a
   guess: the flow-floor breach at an 11 u/s ground cap (§ 2.6), and Ember's
   flat→percentage retune against `difficultyAt`'s enemy-HP curve (§ 2.1).
5. **`npm run build` must pass before any commit.** And `MovementVersion.ts` bumps
   with a `docs/MOVEMENT_VERSIONS.md` entry in the same commit — Surf Tome and
   Updraft Tome both change `MAX_AIR_WISH_SPEED` / `JUMP_SPEED` behaviour, and
   that is exactly what the version log exists for.
