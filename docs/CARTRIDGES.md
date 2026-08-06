# Cartridges

The upgrade pool. **This describes what shipped**, not a proposal — the design
argument that preceded it is in the commits.

An upgrade is a **Cartridge** you inject. The art is
`public/MEGAFLOW_HP_DASH_UI_ELEMENTS/ICON_Upgrade_*.png`, one translucent shell
per tier.

---

## 1. The whole rule: tier is magnitude

Every Cartridge owns exactly one **step** — one projectile, +14% damage, one rung
up a softcap curve. The tier it rolls says how many of those steps you get at
once, and nothing else.

| Tier | Steps |
|---|---|
| Common | **1** |
| Uncommon | **2** |
| Epic | **3** |
| Legendary | **4** |

There is no tier at which an upgrade is fractionally better. An uncommon Spore is
two more projectiles, not 1.75 of one.

This replaced an earlier scheme of fractional stack weights (1.0 / 1.75 / 2.75 /
4.5), and the reason it went is worth keeping: under fractional weights an
uncommon Spore was worth 0.75 of a projectile, which is nothing a player can see,
and the whole appeal of Spore is *watching more leave the gun*.

The ladder is read off what already shipped rather than invented — `epic-overclock`
is 2.67× `+Attack Speed`, `legend-apex` is 4.7× `+Damage`. 1/2/3/4 sits inside
that band and is legible on a card.

### Two kinds of entry

- **Cartridges (27)** — pure steps, rollable at any tier. Eleven of them are the
  named systems, which are steps too; their first step is what switches the
  system on.
- **Uniques (11)** — fixed tier, no ladder, one named clause, gamble-only.

### Linear vs softcapped, and the one trap

Linear steps (`ember`, `cadence`, `heartwood`, …) are plain `+=` and compose with
the flat uniques for free.

**Softcapped steps must apply the delta along their curve**, never an absolute
write; `along(curve, total, added)` does this. An absolute write would silently
eat whatever a unique had added to the same field — `epic-overclock` gives
`weapon.range += 6`, and a Beam step that set range from its own curve would
delete it.

The exceptions are the two fields *only one Cartridge ever writes*
(`standingWaveSlow`, `GLIDE_GRAVITY_SCALE`), set absolutely from the total
because nothing else can be eaten.

Verified by `.probe-cartridges`: four commons land in exactly the same place as
one legendary, on every softcapped Cartridge.

---

## 2. Where the ladder lives

`RunPerks.steps` — **one array, indexed by position in `CARTRIDGES`**.

That is one `Frame` field for the whole pool however many Cartridges exist, and
recording it is a fixed-length copy into a preallocated frame rather than an
allocation at 32 Hz across 480 frames.

Two consequences:

- **Order in `CARTRIDGES` is load-bearing.** New entries go on the *end*.
  Reordering mid-run would rewrite a player's whole ladder.
- **`createRunPerks` builds the array fresh** rather than spreading it out of
  `PERK_DEFAULTS`. A shared array would be mutated by play and every later run
  would start pre-levelled.

Derived stats are still recorded in their own right alongside. The ladder rides
so the *menu* keeps showing the right running total after a rewind, not so stats
can be recomputed.

---

## 3. Drop rates

Per level-up card, in permille:

| | Common | Uncommon | Epic | Legendary |
|---|---|---|---|---|
| Base | 732 | 240 | **27** | **1** |

Over a forty-level run at four cards that is ~38 uncommon, ~4.3 epic and ~0.16
legendary.

**The legendary is the gamble's prize and stays at one in a thousand.**
Everything under it is looser than the first pass, which had uncommon at 120 and
epic at 9. That pass was tuned to make an epic a *story* — one a run, if that —
and overshot into making the level-up itself forgettable: 87 cards in a hundred
were the floor tier, so a menu paid out a visible step maybe twice an hour. An
epic three or four times a run is still an event.

**The gap to the gamble is what all of it has to preserve**, and it does: 2.8%
epic-or-better on a card against 68% from one full-stake roll, and on the
legendary axis alone 0.1% against 35%. **That gap is the reason banking is a
decision** rather than a slower way to take the safe thing.

The gamble rows are unchanged from before Cartridges existed. The common row is
the bust and it has to stay felt — 12% at a full stake, not 3%.

---

## 4. Solstice, and the luck build

The only Cartridge that never makes you stronger on its own. `.probe-luck`
asserts exactly that: it writes no stat.

- **On a level-up** the tier odds bend, gently. Measured over 20k menus:
  73.2/23.9/2.74/0.10 at no luck, 28.8/43.5/26.7/1.03 at twelve steps. Even that
  deep it stays under a single full-stake gamble's 33% epic, and nowhere near its
  35% legendary — luck must improve the menu without becoming the gamble.

  The uncommon step is **16 permille per luck step, against a base of 240**. It
  was 26 against a base of 120: leaving it there would have stacked a doubled
  base on top of an unchanged climb and swallowed the whole row, so twelve steps
  now lands at the ~43% uncommon it always did. When the base row moves, this
  moves with it.
- **On a gamble** it buys *effective stake rows*: every three steps reads one row
  higher, so at nine steps a two-pick gamble reads the top row. The build
  therefore gambles more **often**, not only harder.

**The quoted row and the rolled row are the same row.** `BankMenu.showDecision`
takes the effective stake as its own parameter for that reason alone, and
`.probe-luck` rolls 60k per row at three luck levels and four stakes to hold it.
A screen that quotes one row while the roll uses another is the worst bug a
gamble can have.

The cost is the design: every step is a pick not spent on Ember, and every level
banked behind it is time on the course underpowered.

---

## 5. Spore and the volley

`src/combat/Volley.ts`. The only Cartridge that adds a weapon rather than a
number: **one more seed per step**, so a first common Spore throws two and a
legendary out of a gamble opens at five.

A *second* weapon rather than a change to the auto-gun, because the two have
distinct jobs — `Weapon`'s sticky-target rule exists because retargeting sprayed
partial damage across a stream of drones and killed nothing. The gun is the
single-target sniper; the volley is the crowd. It fires on its own 1.4 s timer,
so it never asks the player to stop surfing.

- **Homing is a latched constant-speed seek**, not a proportional lerp — the XP
  magnet's lesson, and the shooter here is routinely doing 35 u/s. Turn-rate
  limited so seeds arc rather than snap, which is what leaves Photon something
  to buy.
- **Cleared, never rewound.** A seed lives 1.2 s, so anything a frame could have
  recorded has long since landed. Zero new `Frame` fields.
- **Per-seed damage is 0.40× the gun's, and that fraction is the only brake on
  the weapon.** Seed count is linear in Spore steps with no ceiling.
- Seeds are **violet**, because violet means yours. They shipped green first,
  which put the player's own projectiles in the same hue as the Swarmer and the
  Spitter's bolts.

`.probe-volley` answers the question the weapon rests on: it connects at speed,
0.92 enemies per seed at 60 u/s against 1.00 at 15. Two findings from it:

- **Photon's pierce is worth far more slow than fast** — 2.74 enemies per seed at
  15 u/s against 1.18 at 60. A fast player's seeds chase, and a chasing seed does
  not pass through a line the way a passing one does.
- A pack that is not relocated leaves the 34-unit acquire envelope in about a
  second at 60 u/s. The live spawn director covers this; a probe has to model it
  or it measures whether a 22 u/s drone can outrun a 60 u/s player.

---

## 6. Glider

Movement **v6 "Pull Cord"** — `docs/MOVEMENT_VERSIONS.md` has the full entry.

**Tap `Space`, let go, then hold it**, airborne and descending: gravity ×0.50,
deepening toward ×0.25. Never 0 — a true float would let a player park in the
air and wait a wave out.

A plain held Space does **not** glide, and that is the whole reason for the
gesture: with auto-bhop a held Space is the ordinary bunnyhop posture, so v5's
hold-to-glide opened the canopy on every descent of every normal run. A plain
hold contains no release-then-press, so the gesture excludes it by construction
rather than by timing. The tap still jumps and so does the hold — the gesture
only decides whether the fall is braked.

**It must never be the fast line.** Air control is halved while the canopy is
out: 27.7 u/s free against 25.7 u/s gliding, on a probed perfect strafe.

The trap recorded there, repeated here because it will catch the next person:
**halving `AIR_ACCEL` does nothing.** At `sv_airaccelerate` 100 the per-tick gain
is 5.47 against a wish-speed cap of 0.667, so the cap always binds. The penalty
scales the cap.

---

## 7. The card

`src/ui/Cartridge.ts` builds it; `src/ui/CartridgeIcons.ts` holds the 46
pictograms.

Everything sits in one of the **two recesses moulded into the art**, and both
rects are **measured off the PNGs' own geometry, not chosen** — the same rule
`MegaflowHud`'s bar slots follow. At 365×404 the pill is `x50 y30 265×70` and the
window is `x52 y124 254×206`. Re-export the art and re-measure; do not nudge them
by eye.

- Pictograms are **solid screen-print** — filled geometry, fat rounded strokes,
  nothing thinner than 2.4 of the 24-unit box. Line art was tried and rejected:
  it reads as clinical sci-fi HUD furniture and it dissolves at menu size.
- **One ink and one hot accent, never three.** Two is the most that prints
  legibly across all four shells (frosted white, acid green, hot pink, amber),
  which is what lets one drawing serve every tier. The mark never carries the
  tier; the body does.
- Upgrades carry a short `effect` line for the window *and* a full `description`.
  The uniques' prose was written for a text card and Perpetual Motion's ran to
  six lines straight out of the recess; the gamble reveal prints the sentence
  under the cartridge, where there is room.
- Tier glow is a `drop-shadow` on the shell, not a `box-shadow` on the button.
  The button is a cartridge-shaped hole now, and a box-shadow drew a rectangle of
  light around it. Common gets no glow — three lit tiers and one unlit is what
  makes the lit ones mean anything. **Each glow is its own shell's colour**, so
  the halo confirms the ranking instead of adding a second one; uncommon's went
  ice blue → green when green became the tier.

### The two cheap tiers are crossed against their filenames

`.rarity-common` loads `ICON_Upgrade_Uncommon.png` and `.rarity-uncommon` loads
`ICON_Upgrade_Common.png`, on purpose. The green shell shipped as *common* and
the frosted white one as *uncommon*, which is backwards for every loot game a
player has touched — white is the floor and green is the first rung, from Diablo
to Borderlands to Destiny. Those two tiers are **97% of all cards drawn**, so
getting them the wrong way round is the one ranking error that would be made
constantly, and the glow is a weaker signal than hue against a bright sky.

The art keeps the names it was exported with; the mapping was the error, so the
mapping is what moved. Do not tidy it into matching pairs without swapping the
files themselves.

---

## 8. Enemy hue

One hue, one owner. Two were shared and one of those was the player's:

- **Seeder violet → magenta** `#E84BB8`. Violet is the crosshair, the wordmark,
  every panel and the volley's seeds.
- **Spitter emerald → amber** `#FF9E2C`, bolts to pale gold. The Swarmer is
  already green. Amber sits near the Monolith's orange ring shots, which is
  survivable because a Monolith's arrival calls `clearEnemies` — the two are
  never on screen together. The bolt is deliberately lighter than `Blast`'s
  orange fill, since a bolt and a ground charge are both warm hazards now and at
  speed only value separates them.

Checking a colour in-world needs three things controlled, and each looks exactly
like a colour bug first: the materialize ramp must have finished (its emissive
boost clips every body to white), the camera must not face the sun, and the
seeder must not have planted — its telegraph sits exactly where its body is.

---

## 9. Still open

- **The remaining Cartridges from the design sheet are not built**: Prism (crit
  and overrefraction), Bloom (area), Percussion (knockback), Sap (lifesteal),
  Albedo (damage reduction), Mirage (evasion), Flux (flow and ultimate rate),
  Blight (difficulty-for-XP). Each needs a new system rather than a new number.
- **Four cards, not three.** At 27 visible entries a specific Cartridge shows up
  in ~13.5% of 4-card menus against ~10.5% of 3-card ones.
  `drawUpgradeChoices` already takes a count.
- **XP does not scale with enemy strength.** `XP_PER_KILL` is flat while enemy HP
  scales hard — a ~287× damage-per-level treadmill from level 1 to 40. It is a
  prerequisite for Blight and probably wants to ship on its own, since it retunes
  the whole run's pacing.
- **The combined defensive ceiling** cannot be checked until Albedo and Mirage
  exist. They compose: 55% and 45% is 75.3% mitigation together, before Heartwood
  and two regen sources.
- **A human balance pass.** Every number here is a first pass. The three most
  worth a person's judgement are the 0.40 volley damage fraction, the Glider's
  halved air control, and whether luck should touch the level-up menu at all or
  only the gamble.
