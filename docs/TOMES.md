# Tomes — a tiered, stacking upgrade family

Design spec. **No code has been written for this yet** — this document is the
thing to argue with before any of it ships.

"Tome" is a placeholder name (see § 0). Numbers are a first pass with their
derivations shown, not tuned values; § 7 says how to check them.

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
| **Linear-additive** | `bonus = step · s` | Constant absolute gain. *Relative* gain diminishes on its own — the 10th +14% is a smaller slice of your total than the 1st. What the pool does today. |
| **Multiplicative** | `(1+x)ⁿ` | Snowballs. Never use. |
| **Hyperbolic softcap** | `bonus = CAP · s/(s+K)` | Approaches CAP, never reaches it. `K` is the stack count at half-cap. |
| **Geometric decay** | `step · rⁿ⁻¹` | Converges to `step/(1−r)`. Same job as hyperbolic, harder to reason about. Skip. |

**The rule:** linear where runaway *is* the fun — damage, HP, regen, XP.
Hyperbolic softcap for anything that breaks a system if it goes too far — air
control, damage reduction, evasion, cooldowns, area, range, knockback.

**A third pattern, for chance-based stats: linear and uncapped, with overflow.**
Crit chance and lifesteal chance run past 100% and the excess converts into a
*second* roll (Overrefraction, Oversap). Going 100→200% is worth strictly less
than 0→100% as a share of the total, so the diminishing return is structural
rather than imposed. Two Tomes use it (Prism, Sap).

The pool already has hand-rolled versions of the hyperbolic kind:
`standingWaveSlow` climbing `0.3 → 0.4 → 0.5 → 0.55(cap)`, and
`Math.max(1.5, rechargeSeconds − 1.2)`. Both become plain curves under this
scheme and lose their clamps — the difference being that a clamp is a wall four
picks slam into, and a curve is one nobody ever quite reaches.

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

Visible pool 33, drawn 3 at a time → a given Tome appears in ~9.1% of menus.
Over a 40-level run that is ~3-4 offers; a player building for it takes 2-3.
**Tune so `s ≈ 8` is strong, `s ≈ 15` is the practical ceiling, and the asymptote
sits somewhere you would never mind reaching.** Every table below reads at
s = 1, 3, 8.

### Legendary riders

A Tome at legendary is 4.5 weight *and* a one-line named clause, so a legendary
is a moment rather than a bigger number. Epic gets no rider — that is what keeps
the weight ladder honest.

---

## 2. The Tomes

Twenty-two. `s` is the accumulated weight above.

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
which is applied per-tick and unchanged. This is the *Cooldown Tome*'s slot —
the weapon has no cooldown stat separate from its rate, so rate is the honest
local form.

*Legendary rider:* **Downbeat** — every 12th shot fires a free Sound Blast at the
target. Reuses `applySoundBlast`; no new system.

#### 3. Harmonic Tome — *"One note, sounding as several."* — new system

`extraTargets = floor(0.4·s)`, each struck for **60%** damage.
**s=1 → +0 · s=2.5 → +1 · s=5 → +2 · s=8 → +3**

The weapon fires at its sticky target plus the *N* next-nearest in range.

**This is the Quantity / Projectile Count slot, and it is the most
build-changing Tome in the set.** `Weapon` today is strictly single-target with
a deliberate sticky-target rule (added because retargeting sprayed partial damage
across a stream of drones and killed nothing). Harmonic converts it into a crowd
clearer without touching that rule — the sticky target still gets full damage;
the extras are spillover.

60% rather than 100% because the multiplicative stack with Ember and Prism is
where this set is most likely to go degenerate. See § 7.4.

*Legendary rider:* **Overtone** — extra targets take full damage instead of 60%.

#### 4. Beam Tome — *"Light reaches further before it gives up."*

`weapon.range = 22 + 30·s/(s+7)` — **softcap**, → 52 at infinity.
**s=1 → 25.8 · s=3 → 31.0 · s=8 → 38.0**

Replaces `+Range`. Capped because uncapped range turns the whole course into one
kill volume and quietly deletes the decision to surf *toward* a fight.

**This is the Projectile Tome's slot.** There are no projectiles here — the
weapon is hitscan and `Tracer.BOLT_SPEED` is cosmetic — so "how fast your shot
arrives" becomes "how far it reaches", which is the honest local equivalent.

*Legendary rider:* **Collimation** — shots no longer drop the sticky target when
it leaves range; they hold until it dies.

#### 5. Prism Tome — *"White light splits. So does damage."* — new system

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

#### 6. Bloom Tome — *"Everything you set off opens wider."* — new system

Area multiplier `a = 1 + 0.9·s/(s+7)` — **softcap**, → ×1.9 radius at infinity.
**s=1 → ×1.11 · s=3 → ×1.27 · s=8 → ×1.48**

Multiplies `soundBlastRadius`, `SolarWave.BURN_RADIUS`, `MIRROR_RADIUS` and the
Percussion push distance.

**This is the Size Tome's slot.** Hard-capped because **area goes as the square** —
×1.9 radius is already ×3.6 area, and a linear radius stat would be quadratic in
kills.

*Legendary rider:* **Full Bloom** — your dash blast also strips 25% speed from
everything it touches. Reuses `WeaponTarget.applySlow`.

#### 7. Percussion Tome — *"Every hit lands like a drum."* — new system

`knockback = 1.2·s/(s+4)` units, × the Bloom multiplier — **softcap**, → 1.2 u.
**s=1 → 0.24 u · s=3 → 0.51 u · s=8 → 0.80 u**

Pushed along the shot direction on every hit. **This is the Knockback Tome's slot.**

Two things make it fit here specifically. First, in a game about never stopping,
knockback is *defensive positioning you get without slowing down* — it shoves
interceptors off your line rather than asking you to turn and fight. Second, the
implementation is a one-shot `enemy.position.addScaledVector(away, dist)`, and
because `EnemySample` already records `x/y/z`, **knockback rides the rewind for
free with zero `Frame` work** — the same reason `applySlow` needed none.

Capped low (1.2 u against a 22 u weapon range) because knockback that pushes
enemies *out* of range is a DPS loss disguised as a power. Worth measuring, not
assuming — see § 7.4.

*Legendary rider:* **Shockmount** — enemies knocked into another enemy stagger
both, refreshing Standing Wave's slow on each.

### Movement — the part that must not break

#### 8. Surf Tome — *"The line answers you sooner."*

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

#### 9. Updraft Tome — *"You leave the ground with more to spend."*

```
JUMP_SPEED         = 6.711 + 4.5·s/(s+5)   → 11.2 at infinity
DASH_IMPULSE_SPEED = 8 + 5·s/(s+5)         → 13 at infinity
```

**s=1 → jump 7.46 · s=3 → 8.40 · s=8 → 9.48**

Replaces `+Jump Height`, and makes dash strength upgradeable for the first time —
`DASH_IMPULSE_SPEED` is currently a module constant in `PlayerController.ts:80`.

*Legendary rider:* **Thermal** — one free air-jump, refunded on every ramp touch.

#### 10. Kite Tome — *"The dash comes back before you miss it."*

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

#### 11. Heartwood Tome — *"More of you to lose."*

`playerHealth.maxHp = 100 + 18·s`, healed to match — linear.
**s=1 → 118 · s=3 → 154 · s=8 → 244**

Replaces `+Max HP`. This is the HP Tome's slot.

*Legendary rider:* **Heartwood** — the first hit that would kill you leaves you at
1 HP instead. Once per Monolith.

#### 12. Chlorophyll Tome — *"You mend in the light."*

`playerHealth.regenPerSecond = 1.3·s` — linear.
**s=1 → 1.3 · s=3 → 3.9 · s=8 → 10.4**

Replaces `Regeneration`. Distinct from Photosynthesis, which is airborne-only and
stays as its own build piece.

*Legendary rider:* **Evergreen** — regen doubles while above the flow floor.

#### 13. Graft Tome — *"What you kill, you keep."*

`perks.healOnKill = 1.8·s` — linear.
**s=1 → 1.8 · s=3 → 5.4 · s=8 → 14.4**

Replaces `Vampiric Edge`. Chunky, kill-gated sustain — the counterpart to Sap's
trickle.

*Legendary rider:* **Rootstock** — kills past full HP bank into a shield worth up
to 25% of max HP.

#### 14. Sap Tome — *"You draw a little back from every touch."* — new system

Sap chance `c = 0.06·s` — **linear, uncapped, overflow**, exactly like Prism.
`heals = floor(c) + (rand < frac(c) ? 1 : 0)`, 1 HP each.
**s=1 → 6% · s=3 → 18% · s=8 → 48% · s=16.7 → 100%**

**This is the Bloody Tome's slot, overflow included** — past 100% every hit heals
1 guaranteed plus a chance at a second.

Deliberately paired with attack rate rather than kills: Sap is the sustain that
scales with Cadence and Harmonic, where Graft scales with how much you actually
kill. At s=8 with 8 shots/s that is ~3.8 HP/s, comparable to Chlorophyll but
conditional on having targets.

*Legendary rider:* **Heartwood Sap** — sap heals scale with Ember instead of
being flat 1 HP.

#### 15. Albedo Tome — *"You send some of it back."* — new system

`damageReduction = 0.55·s/(s+6)` — **hyperbolic, mandatory**.
**s=1 → 7.9% · s=3 → 18.3% · s=8 → 31.4% · ∞ → 55%**

The Armor Tome's slot, and the one defensive stat the game has no version of.
Applied at the three incoming-damage sites: contact, seeder `Blast`, Monolith beam.

Hyperbolic **because a linear reduction stat reaches immunity and ends the run's
tension**. This shape cannot.

*Legendary rider:* **Specular** — damage you resist is dealt back as a Bramble
flash, whether or not you own Bramble.

#### 16. Mirage Tome — *"Sometimes you were never there."* — new system

`evasion = 0.45·s/(s+7)` — **hyperbolic, mandatory**.
**s=1 → 5.6% · s=3 → 13.5% · s=8 → 24.0% · ∞ → 45%**

Chance to take no damage at all from an incoming hit. The Evasion Tome's slot;
optically, a mirage is the attack arriving where you are not.

Distinct from Albedo in feel — Albedo makes every hit smaller, Mirage makes some
hits not happen — and **that difference is exactly why the two need checking
together**, see § 7.4.

*Legendary rider:* **Heat Shimmer** — an evaded hit grants 0.6 s of doubled air
acceleration. Evading pays in speed, which is the currency the game is about.

#### 17. Bramble Tome — *"Touch it and find out."*

`thornsDamage = 12·s` — linear, radius `MIRROR_RADIUS` × Bloom.
**s=1 → 12 · s=3 → 36 · s=8 → 96**

The Thorns Tome's slot. **Folds in `Mirror Array`**, which is already exactly this
(`Enemies that touch you take a 14-damage flash (stacks)`) — a flat slider wearing
a build-piece name.

*Legendary rider:* **Thicket** — thorns also fire on a Mirage evade, so dodging
counter-attacks.

### Economy

#### 18. Pollen Tome — *"It drifts to you now."*

`XP_MAGNET.radius = 18 + 26·s/(s+6)` — **softcap**, → 44 at infinity.
**s=1 → 21.7 · s=3 → 26.7 · s=8 → 32.9**

The Attraction Tome's slot. Replaces `XP Magnet`. Capped so it cannot outgrow the
weapon's 22-unit kill envelope by so much that pickup stops being a positioning
decision.

*Legendary rider:* **Anemophily** — orbs you leave behind chase you for 4 s past
the point they would normally give up.

#### 19. Harvest Tome — *"The line pays out."*

`perks.xpMultiplier = 1 + 0.20·s` — linear.
**s=1 → ×1.20 · s=3 → ×1.60 · s=8 → ×2.60**

The XP Tome's slot. Replaces `Scholar`. Split from Pollen because the reference
set splits pickup range from XP gain, and they genuinely are different builds —
one is about *reaching* loot, the other about what loot is worth.

*Legendary rider:* **Second Crop** — every 10th orb collected counts twice.

#### 20. Flux Tome — *"The line pays better."*

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

#### 21. Solstice Tome — *"The sun sits higher when you draw."* — new system

Pick menus: `uncommonChance = 0.28 + 0.45·s/(s+6)` — **softcap**, → 0.73.
**s=1 → 34.4% · s=3 → 43.0% · s=8 → 53.7%**

Gamble: the odds row is read at `min(5, stake + floor(s/3))` — luck buys
*effective stake rows* rather than needing a new odds table.

The Luck Tome's slot, and it covers the reference's "leveling up, shrines and
more" for free, because shrine blessings already route through
`drawUpgradeChoices`.

> **This Tome exists only because tiers roll at offer time.** Under the
> four-separate-rows model there is nothing for luck to bias — you would have to
> reweight the pool itself, which is a different and much worse mechanic. It is
> the strongest argument for § 4's structural decision.

*Legendary rider:* **Zenith** — one guaranteed epic-or-better on your next gamble.

#### 22. Blight Tome — *"Make it worse. Get paid."* — new system

Effective difficulty level offset `+2.5·s`, i.e. `difficultyAt(level + 2.5·s, t)`.
Plus `perks.xpMultiplier += 0.25·s`.
**s=1 → +2.5 levels · s=3 → +7.5 · s=8 → +20**

The Cursed Tome's slot. Routing it through a *level offset* rather than
per-stat multipliers means enemy HP, speed, contact damage, blast damage, spawn
rate, batch size and live cap all move together and coherently — `difficultyAt`
already has exactly one axis for "harder", and it is level.

> **Why the explicit `xpMultiplier` clause is not redundant.** § 3 makes XP scale
> with enemy HP, so at first glance Blight pays for itself. It does not. If
> `xp ∝ maxHp^p` and time-to-kill `∝ maxHp`, then XP *rate* `∝ maxHp^(p−1)`. With
> p = 0.75 that is `maxHp^−0.25` — **tougher enemies pay less per second, not
> more.** Blight without a direct multiplier is a trap that looks like a
> risk/reward item. The +0.25·s is what makes the bet real, and the extra spawn
> volume (more targets for a surfing player, who is usually target-starved rather
> than DPS-starved) is the rest of it.

*Legendary rider:* **Total Eclipse** — Monoliths arrive every 5 levels instead of
10, at full scaling.

---

## 3. The Cursed Tome exposes a real bug: XP does not scale with enemy strength

You flagged this as an implication. It is worse than an implication — it is a
**287× progression treadmill** that already exists, and Blight cannot be designed
around it.

`Game.ts:679` drops `new XPOrb(enemy.position, XP_PER_KILL)` with
`XP_PER_KILL = 3`, flat, regardless of what died. Enemy HP meanwhile scales hard
in `difficultyAt`. Measured against the real curves:

| Level | Drone HP | XP to next | Kills / level | **HP you must deal per level** |
|---|---|---|---|---|
| 1 | 21 | 6 | 2.0 | **42** |
| 10 | 98 | 35 | 11.7 | **1,139** |
| 20 | 162 | 65 | 21.7 | **3,501** |
| 40 | 290 | 125 | 41.7 | **12,067** |

Damage-per-level rises **287×** from level 1 to 40 while player damage rises maybe
10-20×. Levelling does not slow down late — it very nearly stops. (This is almost
certainly part of why Flow XP had to be invented.)

### The fix

```ts
const BASE_DRONE_HP = 10;              // difficultyAt(1, 0).droneHp
const XP_HP_EXPONENT = 0.75;
xpFor(enemy) = XP_PER_KILL * (enemy.health.maxHp / BASE_DRONE_HP) ** XP_HP_EXPONENT
```

| Level | XP / kill | Kills / level | **HP per level** |
|---|---|---|---|
| 1 | 5.3 | 1.1 | **24** |
| 10 | 16.6 | 2.1 | **206** |
| 20 | 24.2 | 2.7 | **434** |
| 40 | 37.5 | 3.3 | **967** |

287× becomes **40×**, which is the shape you want: levelling *does* slow down,
because you should have to get stronger, but it never grinds out.

**The exponent is the knob and it is doing real work.** At p = 1.0 XP-per-damage
is perfectly flat, which removes progression pacing entirely. At p = 0.75 a mild
treadmill survives. It should not be set by feel — probe it.

Two smaller things fall out of the same read:

- **`XP_PER_BOSS = 45` is also flat** and does not scale with `bossScaleFor(index).hp`.
  The fifth Monolith is 4.2× the health of the first for identical XP.
- **`Game.ts:880` does not apply `perks.xpMultiplier` to the boss award**, while
  orb pickup (`:710`) and flow (`:738`) both do. Harvest, Scholar and Tuition
  silently do nothing for Monolith XP. That reads as a plain oversight.

None of this is a Tome. It is a prerequisite for one, and it should probably ship
first and on its own, since it retunes the whole run's pacing.

---

## 4. Pool arithmetic

| | Before | After |
|---|---|---|
| Visible entries | 24 | **33** (22 Tomes + 11 named build pieces) |
| A given entry per 3-card menu | 12.5% | **9.1%** |
| Gamble-only uniques | 11 | 11 (unchanged) |
| Tomes reachable at epic/legendary | — | all 22, gamble-only |

**One pool entry per Tome, tier rolled at offer time.** 22 Tomes is 22 rows, not
88. Pick menus roll common/uncommon; the F-gamble rolls epic/legendary — so the
existing "epic and legendary are gamble-only" rule survives untouched, and a
tiered Tome becomes another reason to stake a full bank.

Thirteen entries fold in and stop being separate rows: `damage`, `attack-speed`,
`weapon-range`, `max-hp`, `jump-height`, `move-speed`, `magnet`, `scholar`,
`dash-recharge`, `extra-dash`, `regen`, `vampiric`, `mirror-array`.

**Untouched build pieces (11):** Photosynthesis, Heliotropism, Doppler Drive,
Subwoofer, Velocity Rounds, Sound Blast, Solar Wave, Solar Capacitor, Aurora
Wake, Echo Chamber, Standing Wave — plus all 11 gamble uniques.

> **9.1% is thin and worth a decision.** A specific Tome is offered ~3-4 times in
> a 40-level run, so a committed build reaches maybe s = 4-6 rather than the s = 8
> these curves are tuned around. Three options: leave it (Solstice partly
> compensates by improving *tier* rather than frequency), raise the menu to 4
> cards (`drawUpgradeChoices` already takes a `count`), or drop the weakest 4-5
> Tomes. **Recommendation: leave the draw at 3 and re-read the curves at s = 5**,
> since a build that never quite gets there is more interesting than one that caps
> out.

---

## 5. Tier vocabulary

The request says **Common / Uncommon / Epic / Legendary**; the code's second tier
is `rare`. Renaming `rare` → `uncommon` is mechanical but touches four places:
the `Rarity` type and every entry's `rarity` field, `.rarity-rare` in
`styles.css`, `BankMenu`'s tier headline, and `VISIBLE_RARITIES`.

The alternative is reading "Uncommon" as the existing `rare` and changing
nothing. Either is fine; the rename is assumed above.

---

## 6. What it costs to build

**`src/progression/Upgrades.ts`** — `Upgrade` gains a marker so a Tome is one row
rollable at any tier; `drawUpgradeChoices` rolls common/uncommon per offered Tome
(biased by Solstice); `drawOfRarity` draws from `{uniques of that tier} ∪ {all Tomes}`.

**`RunPerks`** — 22 new weight fields (`surfTome`, `emberTome`, …) plus derived
getters. `PERK_DEFAULTS` / `resetRunPerks` need no per-field work; that contract
already holds.

**`src/game/Rewind.ts`** — 22 `Frame` fields, 22 lines in `write()`, 22 in
`applyFrame()`. Non-negotiable: *"an upgrade whose field is not in `Frame` is one
a rewind silently leaves applied."* Note that the weight-field design means **one**
field per Tome however many stats it drives — derived values are recomputed, not
recorded. Knockback needs none at all (enemy position is already sampled).

**Nine new systems**, in rough order of cost:

| System | Where | Cost |
|---|---|---|
| Knockback | `Game` kill/hit pass | Trivial — one `position.addScaledVector`, rewound for free |
| Thorns | already exists as `mirrorDamage` | None; a rename |
| Crit + Overrefraction | `Weapon.tick` | Small |
| Lifesteal + overflow | `Weapon.tick` | Small, reuses the crit overflow helper |
| Area multiplier | `applySoundBlast` / `SolarWave` / mirror call sites | Small |
| Damage reduction | `Health.takeDamage`, player instance only | Small |
| Evasion | same three incoming-damage sites | Small |
| Multishot | `Weapon.tick` target selection | Medium — the sticky-target rule must survive it |
| Luck | `drawUpgradeChoices` + `gambleOdds` | Medium — changes the shape of both draws |
| Difficulty offset | `Game`'s `difficultyAt` call | Small, but see § 3 |

Plus `DASH_IMPULSE_SPEED` promoted from a `PlayerController` constant to a
`MovementConfig` field, which gets its restart reset for free via
`resetMovementConfig`.

**UI** — `UpgradeMenu`'s card should show the rolled tier and the current stack
count (`SURF TOME · uncommon · ×3`). That is a genuine new affordance: nothing in
the game surfaces stacking today, and a tiered pool without it is unreadable.

**Docs** — `docs/STATE.md` and `docs/MegaFlow_Changes_Additions_Fixes.md` in the
same commit, per the project's own rule.

---

## 7. Verification

Numbers this dense are not eyeballable. The probe harness (`.probe-powerups.ts`,
`.probe-bank.ts`) is gitignored and no longer in the tree, so it has to be
rewritten — esbuild-bundled, run under node with
`--define:import.meta.env='{"BASE_URL":"/","DEV":false}'` and a `globalThis.document`
stub providing `createElementNS`.

1. **Curve probe** — for each Tome apply s = 1, 3, 5, 8, 20 and assert the derived
   stat matches the tables above; assert every softcapped stat is monotonic and
   still under its asymptote at s = 1000.
2. **Rewind probe** — apply every Tome at every tier, record 2 s, rewind past the
   pick, assert every derived stat is back at its pre-pick value. This is the one
   that catches a missed `Frame` field.
3. **Restart probe** — `MovementConfig`, `XP_MAGNET`, `Weapon`, `Health` and
   `Dash` all back to authored defaults after `restart`, with 40 Tomes applied
   first.
4. **The four open findings**, each answered with a measurement rather than a guess:
   - **The combined defensive ceiling.** Albedo (→55%) and Mirage (→45%) are each
     safe alone but *compose*: `1 − (1−0.45)(1−0.55)` = **75.3% mitigation** at
     both asymptotes, before Heartwood's HP and two regen sources. A full
     defensive build may simply not die. Probe the pair, not each alone.
   - **The offensive stack.** Ember × Prism × Harmonic multiply. At s = 8 each
     that is ×2.12 × ~1.72 × 4 targets ≈ **14.6× effective throughput**. The 60%
     spillover on Harmonic is the intended brake; verify it is enough.
   - **Percussion's sign.** Knockback that pushes enemies out of weapon range is a
     DPS *loss*. Probe kills-per-minute at s = 0, 3, 8 and confirm it is monotonic
     upward. If it is not, the cap comes down or the push goes lateral.
   - **The flow-floor breach** at an 11 u/s ground cap (§ 2.8).
5. **The XP exponent (§ 3)** — sweep p ∈ {0.6, 0.75, 0.9} and read time-to-level
   at levels 1/10/20/40. This retunes the whole run's pacing and is the one number
   here that a human has to feel rather than assert.
6. **`npm run build` must pass before any commit.** And `MovementVersion.ts` bumps
   with a `docs/MOVEMENT_VERSIONS.md` entry in the same commit — Surf Tome and
   Updraft Tome both change `MAX_AIR_WISH_SPEED` / `JUMP_SPEED` behaviour, and
   that is exactly what the version log exists for.
