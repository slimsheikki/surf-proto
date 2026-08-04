import { PerspectiveCamera, Scene, Vector3 } from 'three';
import { Blast } from '../combat/Blast';
import { Bolt } from '../combat/Bolt';
import { Health } from '../combat/Health';
import { applySoundBlast, SoundBlastFx } from '../combat/SoundBlast';
import { SolarWave } from '../combat/SolarWave';
import { Weapon, WeaponTarget } from '../combat/Weapon';
import { InputFrame } from '../engine/Input';
import { degToRad } from '../engine/MathUtils';
import { Boss } from '../enemies/Boss';
import { bossLevelFor, bossScaleFor } from '../enemies/Difficulty';
import { Seeder } from '../enemies/Seeder';
import { SpawnDirector } from '../enemies/SpawnDirector';
import { Spitter } from '../enemies/Spitter';
import { waveAt } from '../enemies/Waves';
import { CameraRig } from '../player/CameraRig';
import { Dash } from '../player/Dash';
import { resetMovementConfig } from '../player/MovementConfig';
import { PlayerController } from '../player/PlayerController';
import { PlayerModel } from '../player/PlayerModel';
import { ViewModel } from '../player/ViewModel';
import { LevelSystem } from '../progression/LevelSystem';
import {
  createRunPerks,
  drawOfRarity,
  drawUpgradeChoices,
  resetRunPerks,
  rollGambleRarity,
  UpgradeContext,
} from '../progression/Upgrades';
import { heliotropismBonus, resetXpMagnet, XPOrb } from '../progression/XPOrb';
import { Banner } from '../ui/Banner';
import { BankMenu } from '../ui/BankMenu';
import { BossBar } from '../ui/BossBar';
import { COUNTDOWN_SECONDS, Countdown } from '../ui/Countdown';
import { DashEffect } from '../ui/DashEffect';
import { GameOverScreen } from '../ui/GameOverScreen';
import { FlowXP } from './FlowXP';
import { Shrine } from './Shrine';
import { pickShrineRespawnPoint } from './ShrineRespawn';
import { Rewind } from './Rewind';
import { getSettings } from './Settings';
import { Ultimate } from './Ultimate';
import { UltimateEffect } from '../ui/UltimateEffect';
import { Hud } from '../ui/Hud';
import { UpgradeMenu } from '../ui/UpgradeMenu';
import { CourseStage } from '../world/SurfCourse';
import { EntityManager } from './EntityManager';
import { GameState } from './GameState';

const XP_PER_KILL = 3;
/** Scatter for multi-orb drops, so a rich kill reads as several orbs rather than one bright one. */
const ORB_DROP_JITTER = 0.5;
/**
 * XP for felling a Monolith.
 *
 * Not flavour — it corrects an accounting problem the endless run creates. Drone
 * spawning is suspended for the whole fight, and drones are the only XP source,
 * so a boss fight is otherwise a two-minute hole in the player's progression
 * that leaves them *further* from the next Monolith than when they started.
 * Roughly two levels' worth at the point the first one arrives.
 */
const XP_PER_BOSS = 45;

/** How long the "Monolith down" headline stays up. Long enough to read mid-air, short enough not to sit on the HUD. */
const BOSS_BANNER_SECONDS = 4.5;

/** Wave headlines are shorter-lived than the boss one — they recur every couple of levels. */
const WAVE_BANNER_SECONDS = 3.5;

/**
 * How long F must be held to open the all-in screen instead of cashing one
 * power.
 *
 * Long enough that no tap reaches it by accident, short enough to sit through
 * on a straight. The world keeps running for the whole hold — that is the price
 * of the bigger decision, and the HUD fills a meter so the wait is never
 * mistaken for a dead key.
 */
const BANK_HOLD_SECONDS = 2.5;

/**
 * Mirror Array's retaliatory flash: much tighter than a dash blast (which is
 * `perks.soundBlastRadius`), because it fires from a hit you *took* — it
 * answers the swarm pressing against you, not the room.
 */
const MIRROR_RADIUS = 4;
/** Echo Chamber: the repeat fires this long after the dash blast, at this fraction of it. */
const ECHO_DELAY_SECONDS = 0.35;
const ECHO_DAMAGE_FRACTION = 0.6;
/** Chorus: every Nth kill sings, never for less than this. */
const CHORUS_EVERY_KILLS = 8;
const CHORUS_MIN_DAMAGE = 25;
/**
 * Fall detection: one rule only — below the course's `killPlaneY`, the run
 * ends. The plane is the map's true floor, safely under every piece of
 * geometry, so nothing in the air can ever trigger it.
 *
 * Two prompter detectors came before it and both are gone for cause. The
 * checkpoint kill-plane ladder hung an invisible plane below the next unarmed
 * checkpoint and yanked mid-flight players to the start (the "random
 * teleport" bug). Its replacement, a plummeting-with-no-ground-below check,
 * killed players the moment they carved a bank at speed: their feet sit ON
 * the face, the downward probe starts inside that slab — which raycasts
 * ignore — finds nothing beneath, and a fast carve's vertical speed crossed
 * the threshold. Falling to the floor takes a few seconds; a few seconds of
 * plummet is honest, and no clever detector has survived contact with this
 * game yet.
 */
const BASE_MAX_HP = 100;

/**
 * How far below the lowest course stage the kill plane sits. Must clear the
 * lowest ramp surface (which dips under its landing platform) with room to
 * spare, while still catching a player who has genuinely fallen off the course.
 */
const OUT_OF_BOUNDS_MARGIN = 30;

/**
 * Nothing is despawned by distance any more — not orbs (PR #24) and not
 * enemies: Vampire-Survivors persistence, a straggler chases forever and
 * re-engages when the course loops back through it. Two radii remain, neither
 * of which deletes anything:
 *
 * - `ENEMY_ENGAGE_RADIUS` bounds the spawn director's concurrency count, so
 *   far stragglers cannot eat the live cap and starve the fight around the
 *   player. 55 is the old cull distance, kept because nothing escapes it in
 *   the early game — which is exactly what leaves the tuned early game
 *   bit-identical.
 * - `ENEMY_RENDER_DISTANCE` hides meshes past the ~220-unit fog wall (they are
 *   fully fogged anyway); pursuit keeps simulating, only the draw call stops.
 */
const ENEMY_ENGAGE_RADIUS = 55;
const ENEMY_RENDER_DISTANCE = 240;

/**
 * The slice of the built course the game loop needs. Declared here rather than
 * imported wholesale so this file states its own requirements: the boss is
 * anchored to the island the surf loop orbits, which means `Game` genuinely
 * depends on the loop's geometry and not just on its rest platforms.
 */
export interface GameCourse {
  /** Rest-platform stages, in course order. */
  stages: CourseStage[];
  spawnPoint: Vector3;
  spawnYawDeg: number;
  /** Centre of the floating island the loop orbits — the boss's hover anchor. */
  islandCenter: Vector3;
  /** World Y of the surf track's plane. */
  trackY: number;
  /** Radius of the surf loop, which sizes the boss's engagement and cull radii. */
  trackRadius: number;
  /** Blessing-shrine positions. Absent on free-mode maps (for now). */
  shrines?: Vector3[];
  /**
   * Absolute world Y of the kill plane, overriding the per-stage one below.
   *
   * The standard course leaves this unset: it descends in stages, so hanging
   * the plane under the platform the player is heading *for* catches a fall in
   * a second instead of after a ten-second plummet. A free-mode map has no
   * stage ladder — the player may have built a course that climbs or loops —
   * so it supplies one honest global plane instead.
   */
  killPlaneY?: number;
}

/** Notifications out of the run, for the things that live above it. */
export interface GameHooks {
  /** A run just started from the top — the restart button, or a new course. */
  onRunStart?: () => void;
}

/**
 * Composition root: owns every subsystem and ties them together in a fixed
 * update order each tick. Combat/progression is a secondary layer here — it
 * never blocks the player controller from ticking, only the level-up pause does.
 */
export class Game {
  readonly playerController: PlayerController;
  readonly cameraRig: CameraRig;
  /**
   * The player's body in the world scene. Third-person only — in first person
   * the camera sits inside its head — and driven purely from controller state,
   * so it needs nothing in `Rewind`'s `Frame`: rewinding the player's transform
   * rewinds the body with it.
   */
  readonly playerModel = new PlayerModel();
  readonly playerHealth = new Health(BASE_MAX_HP);
  readonly weapon = new Weapon();
  readonly levelSystem = new LevelSystem();
  readonly entityManager: EntityManager;
  readonly spawnDirector = new SpawnDirector();
  readonly dash = new Dash();
  /** The ReWind ultimate's charge meter. Fed by speed, air time and kills. */
  readonly ultimate = new Ultimate();
  /** Passive XP for sustained speed. See `FlowXP` for the budget maths. */
  readonly flowXp = new FlowXP();
  /** Run-scoped perk hooks (heal-on-kill, XP multiplier). See `RunPerks`. */
  readonly perks = createRunPerks();

  /** Blessing shrines built from the course. */
  private shrines: Shrine[] = [];

  state: GameState = 'playing';

  /** Null between Monoliths — which is most of a run. */
  boss: Boss | null = null;

  /** How many Monoliths this run has felled. Drives boss scaling and the game-over stats. */
  bossesFelled = 0;

  /**
   * Last wave whose banner has fired, by global index. Pure announcement
   * state: deliberately not in `Frame`, so after a rewind across a wave
   * boundary the banner simply doesn't refire — a headline is not worth a
   * recorded field. Zero means "wave 1 not yet announced", which is what makes
   * the opening FIRST CONTACT banner fire on a fresh run's first tick.
   */
  private lastAnnouncedWave = 0;

  /**
   * Rolling identity for "which Monolith encounter is this". Bumped when one
   * arrives and again when one falls, and recorded into every rewind frame:
   * the rewind window is cut short at any change, because un-felling a boss
   * would mean restoring a 786-line state machine, and the alternative — the
   * kill standing while the XP it paid is rewound away — is a worse deal than
   * simply not offering it. See `Rewind`.
   */
  private bossEpoch = 0;

  /** Counts the 3-2-1 down while `state === 'countdown'`. */
  private countdownRemaining = 0;
  /** Rising-edge latch on R; see `updateGameplay`. */
  private ultimateHeldLastTick = false;
  /** How long F has been down this press. Drives the HUD's hold meter. */
  private bankHoldSeconds = 0;
  /**
   * False from the moment a hold fires until F comes back up.
   *
   * The all-in screen opens while the key is still down, and it is usually
   * still down when the countdown ends — without this the run would reopen the
   * screen on the first tick back, and the eventual release would read as a tap
   * on top of that.
   */
  private bankHoldArmed = true;

  private readonly rewind: Rewind;
  private readonly ultFx = new UltimateEffect();
  private readonly countdown = new Countdown();

  private paused = false;
  /** Last pointer-lock-driven HUD visibility from `App`; see `applyHudVisibility`. */
  private hudVisible = false;
  /** See `setRunVisible`. Starts false: `beginRun` is what turns the run on. */
  private runVisible = false;
  private readonly hud = new Hud();
  private readonly bossBar = new BossBar();
  private readonly upgradeMenu = new UpgradeMenu();
  private readonly bankMenu = new BankMenu();
  private readonly gameOverScreen: GameOverScreen;
  private readonly banner = new Banner();
  private readonly dashFx = new DashEffect();

  /**
   * Reused each tick so the drone list and the boss can be handed to the weapon
   * as one target list without allocating an array 128 times a second.
   */
  private readonly weaponTargets: WeaponTarget[] = [];

  /** One reused mesh; retriggered per dash-blast rather than reallocated. */
  private readonly soundBlastFx = new SoundBlastFx();
  /**
   * Second shell for blasts that do not happen at the dash: the echo, Chorus
   * and the mirror flash. One shared mesh cannot serve both — an echo lands
   * 0.35 s after a dash, exactly one fade-time, so the follow-up would hijack
   * the dash shell mid-draw and teleport it.
   */
  private readonly remoteBlastFx = new SoundBlastFx();
  /** The burning wake. Owns its bounded point pool; see `SolarWave`. */
  readonly solarWave = new SolarWave();

  /**
   * Echo Chamber's pending repeat. Transient on purpose — cleared on restart
   * and on rewind, never in `Frame` — the same contract as live blasts: it
   * spans 0.35 s, nothing recorded is still pending, and the next dash re-arms
   * it. Zero means none pending.
   */
  private pendingEchoSeconds = 0;
  private readonly pendingEchoPos = new Vector3();
  /**
   * Chorus counts kills toward the next free blast. Game state, not upgrade
   * state (the pool rule stands), reset on restart, deliberately not in
   * `Frame`: a rewind that replays kills can re-sing, the same accepted
   * nondeterminism as the gamble reroll.
   */
  private chorusKills = 0;
  /** Reused per tick: sites buffered during the kill pass, sung after it returns. */
  private readonly chorusSites: Vector3[] = [];

  /** Stable callback the boss reports its damage through; see `Boss.tick`. */
  private readonly damagePlayer = (amount: number) => this.playerHealth.takeDamage(amount);

  constructor(
    private readonly scene: Scene,
    camera: PerspectiveCamera,
    /**
     * Swappable via `setCourse`, so free mode can hand the same `Game` a
     * freshly built map without constructing a second one. That is not just
     * tidiness: the terminal screens bind their restart listeners in their
     * constructors, so a second `Game` would stack a second listener on the
     * same button and every restart would fire twice.
     */
    private course: GameCourse,
    /**
     * Owned by `main.ts` (it is the thing that has a renderer and a render
     * order), driven from here. Animation state has to advance on the fixed
     * timestep alongside the swing that triggers it, or a 0.25 s swing would
     * play at a different speed on every monitor.
     */
    private readonly viewModel: ViewModel,
    /**
     * Fired at the end of every `restart`. It exists for the music, which has
     * to draw a fresh track per run: a restart off the game-over screen never
     * passes back through `App`, so without this the whole second run of a
     * session would inherit the first one's track.
     */
    private readonly hooks: GameHooks = {},
  ) {
    this.playerController = new PlayerController(course.spawnPoint, course.spawnYawDeg);
    this.cameraRig = new CameraRig(camera);
    this.entityManager = new EntityManager(scene);
    // The auto-weapon's tracers and impact flashes live in one Group it owns and
    // pools. Without this the weapon is silent and invisible — a playtester
    // reported "didn't see any projectiles", which was exactly this: hitscan
    // damage with nothing drawn.
    this.scene.add(this.weapon.effects);
    this.gameOverScreen = new GameOverScreen(() => this.restart());
    scene.add(this.soundBlastFx.mesh);
    scene.add(this.remoteBlastFx.mesh);
    scene.add(this.solarWave.group);
    scene.add(this.playerModel.root);
    this.rebuildShrines();
    // Built last: it captures references to every subsystem above, and the
    // shrines are handed over as a getter because `setCourse` replaces them.
    this.rewind = new Rewind({
      playerController: this.playerController,
      playerHealth: this.playerHealth,
      levelSystem: this.levelSystem,
      dash: this.dash,
      flowXp: this.flowXp,
      weapon: this.weapon,
      perks: this.perks,
      spawnDirector: this.spawnDirector,
      entityManager: this.entityManager,
      getShrines: () => this.shrines,
      getBoss: () => this.boss,
      getBossEpoch: () => this.bossEpoch,
    });
  }

  /**
   * Tears down and rebuilds the shrine objects for the current course. Called
   * from the constructor and from `setCourse` — a new map brings new shrine
   * positions, and the old meshes must not linger in the scene.
   */
  private rebuildShrines(): void {
    for (const shrine of this.shrines) {
      this.scene.remove(shrine.group);
      shrine.dispose();
    }
    this.shrines = (this.course.shrines ?? []).map((position) => new Shrine(position.clone()));
    for (const shrine of this.shrines) this.scene.add(shrine.group);
  }

  /**
   * The unconditional backstop plane. Promptness comes from the doomed check
   * (see `DOOMED_FALL_SPEED`), so one honest global plane per course is enough.
   */
  private get outOfBoundsY(): number {
    return this.course.killPlaneY ?? -OUT_OF_BOUNDS_MARGIN;
  }

  /**
   * Points the game at a different course and starts it from the top. Used when
   * free mode hands over a map the player just built, and again when they go
   * back to the editor and return with it changed.
   */
  setCourse(course: GameCourse): void {
    this.course = course;
    this.rebuildShrines();
    this.restart();
  }

  /**
   * Suspends simulation without changing `state` — used while pointer lock is
   * released (the "click to start" overlay), so drones don't spawn and the
   * player doesn't fall off a ramp while the user isn't holding the controls.
   */
  setPaused(paused: boolean): void {
    this.paused = paused;
  }

  get isPaused(): boolean {
    return this.paused;
  }

  tick(dt: number, input: InputFrame): void {
    if (input.cameraTogglePressed) this.cameraRig.toggle();

    if (!this.paused) {
      if (this.state === 'playing') this.updateGameplay(dt, input);
      else if (this.state === 'rewinding') this.updateRewind(dt, input);
      else if (this.state === 'countdown') this.updateCountdown(dt, input);
    }

    // Outside the gameplay branch: the viewmodel keeps settling (and a swing
    // keeps playing out) through a level-up pause instead of freezing mid-arc.
    // While the world is running backwards it gets no look deltas: the player's
    // view is being restored from the recording, so feeding the sway the mouse
    // motion they are *not* being given would be sway from nothing.
    const looking = this.state !== 'rewinding';
    this.viewModel.update(
      dt,
      this.playerController.speed,
      looking ? input.yawDelta : 0,
      looking ? input.pitchDelta : 0,
    );
    // Same reasoning as the viewmodel above, and the same look deltas: the body
    // keeps animating through a level-up pause, and gets no bank from a mouse
    // it is not being driven by while the run plays backwards.
    this.playerModel.update(dt, this.playerController, looking ? input.yawDelta : 0);
    this.soundBlastFx.tick(dt);
    this.remoteBlastFx.tick(dt);
    this.banner.tick(dt);
    this.dashFx.tick(dt);
    this.ultFx.tick(dt);

    this.cameraRig.update(this.playerController);
    // After the rig, so the toggle takes effect on the very frame the camera
    // pulls back rather than one behind it.
    this.playerModel.setVisible(this.runVisible && this.cameraRig.mode === 'third');
    this.updateHud();
  }

  private updateGameplay(dt: number, input: InputFrame): void {
    // Rising edge, not the raw hold. A player who happens to be resting on R
    // when the bar completes would otherwise spend the ultimate without ever
    // deciding to — and the ability is spent on activation, so there is no
    // taking it back.
    const pressed = input.ultimateHeld && !this.ultimateHeldLastTick;
    this.ultimateHeldLastTick = input.ultimateHeld;
    if (pressed && this.ultimate.isReady && this.rewind.canRewind) {
      this.beginRewind();
      return;
    }

    // F, after the ReWind check on purpose. ReWind is the panic button, built
    // over minutes and spent on activation; banked powers keep, and F is never
    // urgent. Losing a rewind to a stray F is far worse than the reverse.
    //
    // A tap can only be told from a hold on the release, so that is where it
    // fires. Both branches `return` like `startBlessing` does: the tick that
    // opens a screen neither simulates nor records, so the world resumes
    // exactly where it froze.
    if (!input.bankHeld) {
      const wasTap =
        this.bankHoldArmed && this.bankHoldSeconds > 0 && this.bankHoldSeconds < BANK_HOLD_SECONDS;
      this.bankHoldSeconds = 0;
      this.bankHoldArmed = true;
      if (wasTap && this.levelSystem.bankedPicks > 0) {
        this.openSinglePick();
        return;
      }
    } else if (this.bankHoldArmed && this.levelSystem.bankedPicks > 0) {
      this.bankHoldSeconds += dt;
      if (this.bankHoldSeconds >= BANK_HOLD_SECONDS) {
        this.bankHoldSeconds = 0;
        this.bankHoldArmed = false;
        this.openAllInScreen();
        return;
      }
    }

    this.playerController.tick(dt, input);
    const playerPosition = this.playerController.position;
    const playerVelocity = this.playerController.velocity;

    this.dash.tick(dt);
    if (input.dashPressed && this.dash.tryConsume()) {
      this.playerController.dashImpulse();
      this.viewModel.triggerDash();
      this.playerModel.triggerDash();
      this.dashFx.trigger();
      // Sound Blast rides the dash: same tick, same position, so the shockwave
      // is centred on where the player pushed off, not where the impulse threw
      // them. Kills land in this tick's kill pass and drop XP while the dasher
      // is still inside magnet range. Drones and seeders only — the boss's
      // engagement-radius distance is a hitscan convenience a shockwave must
      // not inherit.
      if (this.perks.soundBlastDamage > 0) {
        applySoundBlast(
          this.entityManager.enemies,
          playerPosition,
          this.perks.soundBlastDamage,
          this.perks.soundBlastRadius,
        );
        this.soundBlastFx.trigger(playerPosition, this.perks.soundBlastRadius);
        // Echo Chamber: the repeat is anchored where THIS blast fired — an
        // echo answers the room it rang in, it does not follow the dasher.
        if (this.perks.echoChamber > 0) {
          this.pendingEchoSeconds = ECHO_DELAY_SECONDS;
          this.pendingEchoPos.copy(playerPosition);
        }
      }
    }

    this.playerHealth.tick(dt);
    // Photosynthesis: sunlight on the board — regen paid only while airborne,
    // which on a surf map is the state the game wants the player in anyway.
    // Kept off Health.regenPerSecond, which Regeneration owns and Frame
    // records separately; this rides the perk field instead.
    if (this.perks.airRegenPerSecond > 0 && !this.playerController.grounded) {
      this.playerHealth.heal(this.perks.airRegenPerSecond * dt);
    }

    // Shrines animate and test pickup on the fixed step like everything else.
    // Contact opens the blessing choice immediately: the pause freezes the
    // whole sim, so the flight resumes exactly where it stopped once a power
    // is picked — flying through a shrine costs the line, not the landing.
    for (const shrine of this.shrines) {
      if (shrine.tick(dt, playerPosition)) {
        this.startBlessing();
        return;
      }
      // A collected blessing is gone, not spent: after its countdown it comes
      // back somewhere else on the ring. Checked here rather than on a central
      // timer so the countdown obeys the same pause the rest of the sim does —
      // time spent in the upgrade menu is not time waiting for a shrine.
      if (shrine.needsRespawn) this.respawnShrine(shrine);
    }

    // Falling is death, judged at the map's floor and nowhere else.
    if (playerPosition.y < this.outOfBoundsY) {
      this.endRun();
      return;
    }

    // Checked before the spawn director runs, so the tick a Monolith arrives on
    // is already a tick with drone spawning suspended.
    if (!this.boss && this.levelSystem.level >= bossLevelFor(this.bossesFelled)) {
      this.spawnBoss();
    }

    this.spawnDirector.tick(
      dt,
      {
        playerPosition,
        travelDirection: this.travelDirection(),
        playerSpeed: playerVelocity.length(),
        nearbyEnemyCount: this.entityManager.countEnemiesWithin(playerPosition, ENEMY_ENGAGE_RADIUS),
        playerLevel: this.levelSystem.level,
        bossesFelled: this.bossesFelled,
      },
      (enemy) => this.entityManager.addEnemy(enemy),
    );

    // Mirror Array latch: N same-tick contacts must answer with ONE flash, not
    // N stacked ones — the perk is a deterrent, not a damage multiplier.
    let contactLanded = false;
    for (const enemy of this.entityManager.enemies) {
      enemy.tick(dt, playerPosition, playerVelocity);
      const distToPlayer = enemy.distanceToPlayer(playerPosition);
      // Persistence makes far stragglers routine; past the fog wall they are
      // invisible anyway, so stop paying their draw call. Simulation continues.
      enemy.mesh.visible = distToPlayer < ENEMY_RENDER_DISTANCE;
      // Collected straight after the enemy's own tick, so a blast is planted
      // against the player position that tick used rather than one frame stale.
      if (enemy instanceof Seeder) {
        const plant = enemy.takePlantedBlast();
        if (plant) this.entityManager.addBlast(new Blast(plant, enemy.blastDamage));
      }
      // Same polling contract for the spitter's shots.
      if (enemy instanceof Spitter) {
        const shot = enemy.takePendingShot();
        if (shot) this.entityManager.addBolt(new Bolt(shot.origin, shot.velocity, enemy.boltDamage));
      }
      if (enemy.canDealContactDamage() && distToPlayer < enemy.contactRadius) {
        this.playerHealth.takeDamage(enemy.contactDamage);
        enemy.triggerContactCooldown();
        contactLanded = true;
      }
    }
    // Mirror Array: polished panels bite back. Contact damage only — the boss
    // beam and seeder blasts arrive through `damagePlayer` and correctly do
    // not trigger it. Fired after the loop so it cannot re-enter the iteration.
    if (contactLanded && this.perks.mirrorDamage > 0) {
      applySoundBlast(this.entityManager.enemies, playerPosition, this.perks.mirrorDamage, MIRROR_RADIUS);
      this.remoteBlastFx.trigger(playerPosition, MIRROR_RADIUS);
    }

    // Blasts tick after the seeders that plant them but before the death check,
    // so a detonation that kills the player resolves on the tick it goes off.
    // They are deliberately not in `weaponTargets`: an area attack is terrain,
    // not something the auto-weapon should waste a lock on.
    for (const blast of this.entityManager.blasts) {
      blast.tick(dt, playerPosition, this.damagePlayer);
    }

    // Bolts fly after the spitters that fired them, same ordering logic as
    // blasts-after-seeders; they use the same damage route, so Mirror Array
    // (contact-only) correctly ignores them too.
    for (const bolt of this.entityManager.bolts) {
      bolt.tick(dt, playerPosition, this.damagePlayer);
    }

    this.boss?.tick(dt, playerPosition, this.damagePlayer);

    this.weaponTargets.length = 0;
    for (const enemy of this.entityManager.enemies) this.weaponTargets.push(enemy);
    if (this.boss) this.weaponTargets.push(this.boss);
    this.weapon.tick(
      dt,
      playerPosition,
      this.weaponTargets,
      this.playerController.speed,
      this.perks.dopplerAps,
    );

    // After the auto-weapon, before the kill pass, so a chaser burned down by
    // the wake this tick still drops its XP on this tick. Drones and seeders
    // only, same reasoning as the sound blast above. Standing Wave rides in as
    // the slow factor (1 = not owned).
    this.solarWave.tick(
      dt,
      playerPosition,
      this.playerController.speed,
      this.perks.solarWaveDps,
      this.entityManager.enemies,
      1 - this.perks.standingWaveSlow,
    );

    // Echo Chamber resolves before the kill pass for the same reason: an echo
    // kill pays its orb on this tick. The echo repeats where the dash blast
    // rang, at a fraction of its damage, one radius louder.
    if (this.pendingEchoSeconds > 0) {
      this.pendingEchoSeconds -= dt;
      if (this.pendingEchoSeconds <= 0) {
        applySoundBlast(
          this.entityManager.enemies,
          this.pendingEchoPos,
          this.perks.soundBlastDamage * ECHO_DAMAGE_FRACTION,
          this.perks.soundBlastRadius + 1,
        );
        this.remoteBlastFx.trigger(this.pendingEchoPos, this.perks.soundBlastRadius + 1);
      }
    }

    // Chorus sites are buffered during the cull and sung after it returns:
    // blasting mid-cull would kill enemies the descending loop has already
    // passed, splitting one wave's accounting across two ticks.
    this.chorusSites.length = 0;
    this.entityManager.cullDeadEnemies((enemy) => {
      // Elites (and later the Bulwark) pay out several orbs; the jitter is
      // what makes "several" legible before the magnet gathers them anyway.
      for (let i = 0; i < enemy.xpOrbCount; i++) {
        const dropAt =
          i === 0
            ? enemy.position
            : enemy.position
                .clone()
                .add(
                  new Vector3(
                    (Math.random() * 2 - 1) * ORB_DROP_JITTER,
                    (Math.random() * 2 - 1) * ORB_DROP_JITTER,
                    (Math.random() * 2 - 1) * ORB_DROP_JITTER,
                  ),
                );
        this.entityManager.addOrb(new XPOrb(dropAt, XP_PER_KILL));
      }
      if (this.perks.healOnKill > 0) this.playerHealth.heal(this.perks.healOnKill);
      this.ultimate.registerKill();
      if (this.perks.chorus > 0) {
        this.chorusKills += 1;
        if (this.chorusKills >= CHORUS_EVERY_KILLS) {
          this.chorusKills = 0;
          this.chorusSites.push(enemy.position.clone());
        }
      }
    });
    if (this.chorusSites.length > 0) {
      // Works without Sound Blast owned (the floor), sings louder with it.
      const damage = Math.max(this.perks.soundBlastDamage, CHORUS_MIN_DAMAGE);
      for (const site of this.chorusSites) {
        applySoundBlast(this.entityManager.enemies, site, damage, this.perks.soundBlastRadius);
        this.remoteBlastFx.trigger(site, this.perks.soundBlastRadius);
      }
    }

    // Full 3D speed, not the horizontal `speed` getter: the pull's lead has to
    // beat the player's actual closing rate, and on a descent much of that is
    // vertical. Heliotropism's reach, by contrast, is paid on horizontal speed
    // like every other speed reward — a plummet earns no extra pull.
    const playerSpeed3d = playerVelocity.length();
    const magnetBonus = heliotropismBonus(this.playerController.speed, this.perks.heliotropism);
    for (const orb of this.entityManager.orbs) {
      orb.tick(dt, playerPosition, playerSpeed3d, magnetBonus);
    }

    this.entityManager.cullCollectedOrbs((orb) => {
      this.levelSystem.addXp(Math.round(orb.value * this.perks.xpMultiplier));
    });
    this.entityManager.cullSpentBlasts();
    this.entityManager.cullSpentBolts();

    // Player death is resolved first: a simultaneous kill is a loss, and the
    // boss dying must not rescue a player the beam already finished off. Death
    // is now the *only* way a run ends — there is no win state to race it.
    if (this.playerHealth.isDead) {
      this.endRun();
      return;
    }
    if (this.boss && !this.boss.isAlive) {
      this.fellBoss();
      return;
    }

    // Flow: sustained speed pays a trickle of XP — a percentage of the current
    // level requirement per second, so it stays worth the same fraction of a
    // bar at any level without ever competing with kills (the budget maths
    // live in FlowXP). Scholar's multiplier applies, same as every XP source;
    // Aurora Wake feeds the two flow-shaping multipliers.
    const flowPct = this.flowXp.tick(
      dt,
      this.playerController.speed,
      1 + 0.25 * this.perks.auroraWake,
      1 + 0.6 * this.perks.auroraWake,
    );
    if (flowPct > 0) {
      this.levelSystem.addXp(
        (flowPct / 100) * this.levelSystem.xpToNextLevel * this.perks.xpMultiplier * dt,
      );
    }

    // Wave headlines fire once the tick's XP has settled, and never over a
    // Monolith — the duel suspends spawning, so announcing its backdrop wave
    // would be noise. `fellBoss` hands the next act's opener to its own banner.
    if (!this.boss) {
      const wave = waveAt(this.levelSystem.level, this.bossesFelled);
      if (wave.globalWave > this.lastAnnouncedWave) {
        this.lastAnnouncedWave = wave.globalWave;
        this.banner.show(wave.spec.name, `Wave ${wave.globalWave}`, WAVE_BANNER_SECONDS);
      }
    }

    // Last in the tick, and in this order. The meter is charged from the state
    // this tick produced, and the recording is written from the state the
    // player will be handed back if they rewind to here — which must be the
    // settled end-of-tick world, not a half-updated one.
    this.ultimate.tick(
      dt,
      this.playerController.speed,
      !this.playerController.grounded,
      this.levelSystem.level,
      // Solar Capacitor: banked sunshine — the meter earns faster only while
      // flow is genuinely full. `flowXp.tick` ran above, so `flow` is fresh.
      1 + (this.flowXp.flow >= 1 ? this.perks.solarCapacitor : 0),
    );
    this.rewind.record(dt);
  }

  // ------------------------------------------------------------------ ReWind

  /**
   * Spends the ultimate and hands the world to the playback head.
   *
   * The charge goes immediately rather than when the rewind finishes: letting
   * go of R after half a second still costs it. A refundable rewind would be a
   * free scrub back through the last fifteen seconds to see what happened,
   * which is a different mechanic and a much weaker one.
   */
  private beginRewind(): void {
    this.ultimate.consume();
    this.rewind.begin();
    // Same contract as live blasts (which `rewind.begin` clears): wake points
    // live ~1.6 s, nothing recorded is still burning, and the trail re-grows
    // the moment play resumes. A pending echo is the same class — 0.35 s of
    // life, re-armed by the next dash.
    this.solarWave.clear();
    this.pendingEchoSeconds = 0;
    this.state = 'rewinding';
    this.ultFx.beginRewind();
    this.ultFx.setRewoundSeconds(0);
  }

  private updateRewind(dt: number, input: InputFrame): void {
    const moreLeft = this.rewind.stepBack(dt);
    this.ultFx.setRewoundSeconds(this.rewind.rewoundSeconds);
    // Ends on the release OR on running out of recording — the player does not
    // have to still be holding the button when the fifteen seconds are spent.
    if (input.ultimateHeld && moreLeft) return;

    this.rewind.commit();
    this.ultFx.setResuming();
    this.beginCountdown();
  }

  /**
   * Hands the world back through the 3-2-1, shared by a finished ReWind and a
   * finished cash-in. Both end with a frozen player who needs a beat to work
   * out where they are before anything moves.
   */
  private beginCountdown(): void {
    this.state = 'countdown';
    this.countdownRemaining = COUNTDOWN_SECONDS;
    this.countdown.begin();
    this.countdown.set(this.countdownRemaining);
  }

  private updateCountdown(dt: number, input: InputFrame): void {
    // Look is live here, and nothing else is. Whether the player has just
    // watched the run go backwards or just read three cards, they are usually
    // mid-air on a ramp; resuming on whatever heading they were left on would
    // hand back a botched line as often as a saved one.
    this.playerController.applyLook(input.yawDelta, input.pitchDelta);
    this.ultimateHeldLastTick = input.ultimateHeld;

    this.countdownRemaining -= dt;
    if (this.countdownRemaining > 0) {
      this.countdown.set(this.countdownRemaining);
      return;
    }
    this.state = 'playing';
    this.countdown.end();
    // A no-op when no rewind lit the flames — the effect is already off.
    this.ultFx.end();
  }

  /**
   * Summons a Monolith over the island and turns the run into a duel: drone
   * spawning stops and live drones are dismissed, so nothing else is competing
   * for the player's attention or the weapon's target slot. Live blasts go too
   * — one planted a second ago would detonate under a player whose attention
   * has just been yanked to the other end of the course. XP orbs already in
   * flight are left alone; they are earned.
   *
   * The `bossesFelled`-th Monolith is the one arriving, so the scale it is
   * built with is the scale for the encounter the player has not had yet.
   */
  private spawnBoss(): void {
    this.boss = new Boss(
      this.course.islandCenter,
      this.course.trackRadius,
      this.course.trackY,
      bossScaleFor(this.bossesFelled),
    );
    this.scene.add(this.boss.group);
    this.bossEpoch += 1;
    this.spawnDirector.suspended = true;
    this.entityManager.clearEnemies();
    this.entityManager.clearBlasts();
    this.entityManager.clearBolts();
  }

  /** Tears the boss down completely; safe to call when there is no boss. */
  private despawnBoss(): void {
    if (!this.boss) return;
    this.scene.remove(this.boss.group);
    this.boss.dispose();
    this.boss = null;
    // Drops the weapon's sticky target without touching its stats: the boss is
    // no longer in the target list, and `Weapon` re-targets whenever its current
    // target isn't in the list it was handed.
    this.weaponTargets.length = 0;
    this.bossBar.hide();
  }

  /**
   * A Monolith dies and the run carries straight on.
   *
   * This used to be `winRun`, and the change is the whole shape of the game:
   * the fight is a milestone inside an endless run rather than its ending. The
   * drone stream resumes on the same tick, scaled to whatever level the player
   * reached getting here, and the next Monolith is queued up ten levels out at
   * `bossScaleFor(bossesFelled)` — which has just gone up by one.
   */
  private fellBoss(): void {
    this.bossesFelled += 1;
    this.bossEpoch += 1;
    this.despawnBoss();
    this.spawnDirector.suspended = false;
    // Granted after the counter, so an award that levels the player straight
    // past the next boss threshold still finds `bossesFelled` correct.
    this.levelSystem.addXp(XP_PER_BOSS);
    // The next act starts this same tick. Its opening wave rides the boss
    // banner — announced here and marked as such, so the wave check in the
    // gameplay tick doesn't stomp MONOLITH DOWN with a second headline.
    const wave = waveAt(this.levelSystem.level, this.bossesFelled);
    this.lastAnnouncedWave = wave.globalWave;
    this.banner.show(
      'MONOLITH DOWN',
      `${this.bossesFelled} felled — ${wave.spec.name} begins, next Monolith at level ${bossLevelFor(this.bossesFelled)}`,
      BOSS_BANNER_SECONDS,
    );
  }

  /** The one exit from a run. */
  private endRun(): void {
    this.state = 'gameOver';
    this.banner.hide();
    this.gameOverScreen.show(
      this.levelSystem.level,
      this.spawnDirector.elapsedSeconds,
      this.bossesFelled,
    );
  }

  /**
   * Sends a collected blessing back into the world at a fresh spot on the ring.
   *
   * The occupied list is every *standing* blessing except this one, so two can
   * never be planted on top of each other; `pickShrineRespawnPoint` owns the
   * rest of the rules, including why a point on the ring is reachable by
   * construction and a point on the approach would not be.
   */
  private respawnShrine(shrine: Shrine): void {
    const occupied: Vector3[] = [];
    for (const other of this.shrines) {
      if (other !== shrine && !other.collected) occupied.push(other.position);
    }
    shrine.respawnAt(
      pickShrineRespawnPoint({
        trackRadius: this.course.trackRadius,
        trackY: this.course.trackY,
        islandCenter: this.course.islandCenter,
        playerPosition: this.playerController.position,
        occupied,
      }),
    );
  }

  /** A shrine blessing: identical menu, identical stakes, no level required. */
  private startBlessing(): void {
    this.openUpgradeChoice();
  }

  /**
   * Pauses the run on a three-way powerup choice, resuming the instant it is
   * picked.
   *
   * The shrine path only, now. It is the one menu that still takes control with
   * no warning — the player flew through a shrine, they did not ask for a
   * screen — so it keeps the original "welcome back" contract, where
   * `grantMomentumBoost` compensates the input window the menu ate.
   */
  private openUpgradeChoice(): void {
    this.state = 'pausedForUpgrade';
    this.upgradeMenu.show(drawUpgradeChoices(3), (choice) => {
      choice.apply(this.upgradeContext());
      this.playerController.grantMomentumBoost();
      this.state = 'playing';
    });
  }

  private upgradeContext(): UpgradeContext {
    return {
      weapon: this.weapon,
      playerHealth: this.playerHealth,
      dash: this.dash,
      perks: this.perks,
    };
  }

  /** A tap of F: one banked power, three to choose from. */
  private openSinglePick(): void {
    this.state = 'pausedForUpgrade';
    this.runPicks(1, 1);
  }

  /** A long hold of F: spend the whole bank, or stake it on one roll. */
  private openAllInScreen(): void {
    const picks = this.levelSystem.bankedPicks;
    this.state = 'pausedForUpgrade';
    this.bankMenu.showDecision(picks, {
      onSpend: () => this.runPicks(picks, picks),
      onGamble: () => this.rollGamble(),
    });
  }

  /**
   * Runs `remaining` pick menus back to back, numbering them within `total`.
   *
   * Recursive through the pick callback rather than driven by a counter field,
   * so the whole sequence lives in closures and there is nothing on `Game` for
   * `restart` to forget. `total` is carried rather than re-read from the bank,
   * which drains a pick at a time as the player chooses — reading it would
   * relabel every menu "1 of what's left" and make a tap of F on a full bank
   * announce itself as the last of five.
   */
  private runPicks(remaining: number, total: number): void {
    if (remaining <= 0) {
      this.finishCashIn();
      return;
    }
    const label = total > 1 ? `Power ${total - remaining + 1} of ${total}` : '';
    this.upgradeMenu.show(
      drawUpgradeChoices(3),
      (choice) => {
        choice.apply(this.upgradeContext());
        this.levelSystem.spendPicks(1);
        this.runPicks(remaining - 1, total);
      },
      label,
    );
  }

  /**
   * Stakes the whole bank on one blind roll.
   *
   * Applied before the reveal rather than on dismissal, so there is no window
   * in which the roll has happened but the stat has not — and no way to back
   * out of one, which is the entire point of calling it a gamble.
   */
  private rollGamble(): void {
    const picks = this.levelSystem.bankedPicks;
    const upgrade = drawOfRarity(rollGambleRarity(picks));
    upgrade.apply(this.upgradeContext());
    this.levelSystem.spendPicks(picks);
    this.bankMenu.showResult(upgrade, () => this.finishCashIn());
  }

  /**
   * Hands the run back after a cash-in.
   *
   * With the countdown on, three seconds of live look is the compensation for
   * the frozen window — strictly better than a shove, since the player gets to
   * choose their heading. With it off there is no such window, so the shrine
   * path's momentum boost stands in for it instead.
   */
  private finishCashIn(): void {
    this.bankMenu.hide();
    this.upgradeMenu.hide();
    if (getSettings().countdownOnResume) {
      this.beginCountdown();
      return;
    }
    this.playerController.grantMomentumBoost();
    this.state = 'playing';
  }

  /**
   * True while a menu with on-screen buttons is up. `main.ts` uses this to decide
   * whether the cursor should be handed back, and to keep the "click to start"
   * overlay from appearing on top of one of these.
   */
  /**
   * Restarts the run from the top. Public because the pause menu offers it as
   * well as the game-over screen — the same teardown either way, so there is
   * one path rather than two that must agree.
   */
  restartRun(): void {
    this.restart();
  }

  /** The crosshair and the ultimate arc are centre-screen, so `#hud` cannot own them. */
  setHudVisible(visible: boolean): void {
    this.hudVisible = visible;
    this.applyHudVisibility();
  }

  /**
   * Centre-screen HUD follows the pointer lock, *and* gets out of the way of a
   * choice overlay.
   *
   * The crosshair and the ultimate arc are the only things on screen with a
   * higher z-index than a full-screen panel, so without this the arc draws a
   * dark half-ring straight through the middle power card. They mean nothing
   * while the world is stopped on a choice, and the bottom HUD column stays up
   * regardless — the banked-power counter has to stay readable while it drains.
   *
   * Not folded into the countdown: that is exactly when the player *is* aiming.
   */
  private applyHudVisibility(): void {
    this.hud.setVisible(this.hudVisible && this.state !== 'pausedForUpgrade');
  }

  /**
   * Whether a run is the thing on screen at all — false in the menu and the
   * editor. `Game` is constructed once and re-pointed with `setCourse`, and its
   * world-space objects live in the shared scene, so without this the player's
   * body is left standing on the course through the menu's orbit shot.
   *
   * Deliberately not folded into `setHudVisible`: that one follows pointer
   * lock, and a body that vanished every time the pause menu opened would be a
   * worse bug than the one this fixes.
   */
  setRunVisible(visible: boolean): void {
    this.runVisible = visible;
    // Applied straight away rather than waiting for `tick`, which does not run
    // outside play mode — the frame that leaves a run is the frame that must
    // not still be drawing a body.
    if (!visible) this.playerModel.setVisible(false);
  }

  get isMenuOpen(): boolean {
    return this.state === 'gameOver';
  }

  /**
   * A keyboard-driven overlay is up: the sim is frozen by `state`, but the run
   * still wants the pointer lock.
   *
   * Distinct from `isMenuOpen`, which means "hand the cursor back". These
   * screens are picked with number keys, so Escape over one should give the lock
   * straight back rather than stack a pause menu on top — whose own digit
   * listener is gated the same way this one's is, and would therefore fire
   * alongside it on `1`.
   */
  get isKeyboardOverlayOpen(): boolean {
    return this.state === 'pausedForUpgrade';
  }

  /**
   * Restores every piece of run state that upgrades or progression mutated.
   * Anything missed here compounds across runs, making each restart easier
   * (stats) or harder (XP thresholds) than a fresh start.
   */
  private restart(): void {
    this.entityManager.clear();
    // Before `spawnDirector.reset()`, which is what lifts the suspension.
    this.despawnBoss();
    this.bossesFelled = 0;
    this.playerHealth.maxHp = BASE_MAX_HP;
    this.playerHealth.hp = BASE_MAX_HP;
    this.playerHealth.regenPerSecond = 0;
    resetRunPerks(this.perks);
    resetXpMagnet();
    for (const shrine of this.shrines) shrine.reset();
    this.playerController.teleport(this.course.spawnPoint.clone());
    // Yaw too, not just position. A free map can start the player on any
    // heading, and `restart` is also the path `setCourse` takes — leaving the
    // yaw where the last run ended would drop them onto a new map facing
    // backwards off the pad.
    this.playerController.yaw = degToRad(this.course.spawnYawDeg);
    this.playerController.pitch = 0;
    this.spawnDirector.reset();
    this.levelSystem.reset();
    this.weapon.reset();
    this.soundBlastFx.hide();
    this.remoteBlastFx.hide();
    this.solarWave.clear();
    this.pendingEchoSeconds = 0;
    this.chorusKills = 0;
    this.viewModel.reset();
    this.playerModel.reset();
    this.dash.reset();
    this.ultimate.reset();
    this.flowXp.reset();
    this.rewind.clear();
    this.ultFx.reset();
    this.bossEpoch = 0;
    this.lastAnnouncedWave = 0;
    this.countdownRemaining = 0;
    this.ultimateHeldLastTick = false;
    this.bankHoldSeconds = 0;
    this.bankHoldArmed = true;
    resetMovementConfig();
    this.countdown.reset();
    this.upgradeMenu.hide();
    this.bankMenu.hide();
    this.gameOverScreen.hide();
    this.banner.hide();
    this.state = 'playing';
    // Last, so anything the hook does sees a run that is already running.
    this.hooks.onRunStart?.();
  }

  /** Unit vector along the player's actual 3D path, or their look direction when nearly still. */
  private travelDirection(): Vector3 {
    const { velocity } = this.playerController;
    if (velocity.lengthSq() > 0.25) return velocity.clone().normalize();
    // Same yaw convention as PlayerController.wishDir: -Z at yaw 0, swinging
    // toward -X as yaw increases. The mirrored `+sin(yaw)` form agrees only at
    // yaw 0/180, which on a circular course would spawn drones behind the player
    // for most of the ring.
    const yaw = this.playerController.yaw;
    return new Vector3(-Math.sin(yaw), 0, -Math.cos(yaw));
  }


  private updateHud(): void {
    // Runs every tick regardless of state, which is what lets a state change
    // into or out of a choice overlay take the crosshair with it.
    this.applyHudVisibility();

    // Hidden on the terminal screens so the bar doesn't hang over them.
    if (this.boss && this.state !== 'gameOver') {
      this.bossBar.update({
        name: this.boss.name,
        hpFraction: this.boss.hpFraction,
        phase: this.boss.phase,
      });
    } else {
      this.bossBar.hide();
    }

    this.hud.update({
      speed: this.playerController.speed,
      // Post-multiplier: the readout shows what is actually filling the bar.
      flowXpPctPerSecond: this.flowXp.ratePctPerSecond * this.perks.xpMultiplier,
      hpFraction: this.playerHealth.hp / this.playerHealth.maxHp,
      xpFraction: this.levelSystem.progress,
      level: this.levelSystem.level,
      elapsedSeconds: this.spawnDirector.elapsedSeconds,
      wave: waveAt(this.levelSystem.level, this.bossesFelled).globalWave,
      bossesFelled: this.bossesFelled,
      dashFraction: this.dash.fraction,
      dashCharges: this.dash.charges,
      dashMaxCharges: this.dash.maxCharges,
      ultimateFraction: this.ultimate.charge,
      bankedPicks: this.levelSystem.bankedPicks,
      picksAtCap: this.levelSystem.atPickCap,
      bankHoldFraction: Math.min(1, this.bankHoldSeconds / BANK_HOLD_SECONDS),
    });
  }
}
