import { PerspectiveCamera, Scene, Vector3 } from 'three';
import { Blast } from '../combat/Blast';
import { Health } from '../combat/Health';
import { Knife, KnifeTarget, SlashCone } from '../combat/Knife';
import { Weapon } from '../combat/Weapon';
import { InputFrame } from '../engine/Input';
import { degToRad } from '../engine/MathUtils';
import { Boss } from '../enemies/Boss';
import { bossLevelFor, bossScaleFor } from '../enemies/Difficulty';
import { Seeder } from '../enemies/Seeder';
import { SpawnDirector } from '../enemies/SpawnDirector';
import { CameraRig } from '../player/CameraRig';
import { Dash } from '../player/Dash';
import { resetMovementConfig } from '../player/MovementConfig';
import { PlayerController } from '../player/PlayerController';
import { ViewModel } from '../player/ViewModel';
import { LevelSystem } from '../progression/LevelSystem';
import { createRunPerks, drawUpgradeChoices, resetRunPerks, UpgradeContext } from '../progression/Upgrades';
import { resetXpMagnet, XPOrb } from '../progression/XPOrb';
import { Banner } from '../ui/Banner';
import { BossBar } from '../ui/BossBar';
import { DashEffect } from '../ui/DashEffect';
import { GameOverScreen } from '../ui/GameOverScreen';
import { Shrine } from './Shrine';
import { pickShrineRespawnPoint } from './ShrineRespawn';
import { Rewind } from './Rewind';
import { Ultimate } from './Ultimate';
import { COUNTDOWN_SECONDS, UltimateEffect } from '../ui/UltimateEffect';
import { Hud } from '../ui/Hud';
import { UpgradeMenu } from '../ui/UpgradeMenu';
import { CourseStage } from '../world/SurfCourse';
import { EntityManager } from './EntityManager';
import { GameState } from './GameState';

/** Enemy sphere is r=0.45 and the player capsule r=0.4; the rest is slack for a 128 Hz tick at 40 u/s closing speed. */
const CONTACT_RADIUS = 1.3;
const XP_PER_KILL = 3;
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
 * Distance at which entities are considered out of play and despawned. The
 * player outruns drones permanently at surf speed, so anything this far away is
 * dead weight — but both radii are well beyond the weapon's reach and beyond
 * the furthest spawn distance, so nothing plausibly still in play is culled.
 */
const ENEMY_CULL_DISTANCE = 55;
const ORB_CULL_DISTANCE = 40;

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

/**
 * Composition root: owns every subsystem and ties them together in a fixed
 * update order each tick. Combat/progression is a secondary layer here — it
 * never blocks the player controller from ticking, only the level-up pause does.
 */
export class Game {
  readonly playerController: PlayerController;
  readonly cameraRig: CameraRig;
  readonly playerHealth = new Health(BASE_MAX_HP);
  readonly weapon = new Weapon();
  readonly knife = new Knife();
  readonly levelSystem = new LevelSystem();
  readonly entityManager: EntityManager;
  readonly spawnDirector = new SpawnDirector();
  readonly dash = new Dash();
  /** The ReWind ultimate's charge meter. Fed by speed, air time and kills. */
  readonly ultimate = new Ultimate();
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
   * Rolling identity for "which Monolith encounter is this". Bumped when one
   * arrives and again when one falls, and recorded into every rewind frame:
   * the rewind window is cut short at any change, because un-felling a boss
   * would mean restoring a 786-line state machine, and the alternative — the
   * kill standing while the XP it paid is rewound away — is a worse deal than
   * simply not offering it. See `Rewind`.
   */
  private bossEpoch = 0;

  /** Counts the 3-2-1 down while `state === 'rewindCountdown'`. */
  private countdownRemaining = 0;
  /** Rising-edge latch on R; see `updateGameplay`. */
  private ultimateHeldLastTick = false;

  private readonly rewind: Rewind;
  private readonly ultFx = new UltimateEffect();

  private paused = false;
  private readonly hud = new Hud();
  private readonly bossBar = new BossBar();
  private readonly upgradeMenu = new UpgradeMenu();
  private readonly gameOverScreen: GameOverScreen;
  private readonly banner = new Banner();
  private readonly dashFx = new DashEffect();

  /**
   * Reused each tick so the drone list and the boss can be handed to the weapon
   * as one target list without allocating an array 128 times a second.
   *
   * Typed as the knife's (wider) target — everything in it already carries a
   * world position — so both weapons read the same array. `KnifeTarget extends
   * WeaponTarget`, so it still satisfies `Weapon.tick` unchanged.
   */
  private readonly weaponTargets: KnifeTarget[] = [];

  /** One reused mesh; retriggered per swing rather than reallocated. */
  private readonly slashCone = new SlashCone();

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
    scene.add(this.slashCone.mesh);
    this.rebuildShrines();
    // Built last: it captures references to every subsystem above, and the
    // shrines are handed over as a getter because `setCourse` replaces them.
    this.rewind = new Rewind({
      playerController: this.playerController,
      playerHealth: this.playerHealth,
      levelSystem: this.levelSystem,
      dash: this.dash,
      weapon: this.weapon,
      knife: this.knife,
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
      else if (this.state === 'rewindCountdown') this.updateCountdown(dt, input);
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
    this.slashCone.tick(dt);
    this.banner.tick(dt);
    this.dashFx.tick(dt);
    this.ultFx.tick(dt);

    this.cameraRig.update(this.playerController);
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

    this.playerController.tick(dt, input);
    const playerPosition = this.playerController.position;
    const playerVelocity = this.playerController.velocity;

    this.dash.tick(dt);
    if (input.dashPressed && this.dash.tryConsume()) {
      this.playerController.dashImpulse();
      this.viewModel.triggerDash();
      this.dashFx.trigger();
    }

    this.playerHealth.tick(dt);

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
        liveEnemyCount: this.entityManager.enemies.length,
        playerLevel: this.levelSystem.level,
      },
      (enemy) => this.entityManager.addEnemy(enemy),
    );

    for (const enemy of this.entityManager.enemies) {
      enemy.tick(dt, playerPosition, playerVelocity);
      // Collected straight after the enemy's own tick, so a blast is planted
      // against the player position that tick used rather than one frame stale.
      if (enemy instanceof Seeder) {
        const plant = enemy.takePlantedBlast();
        if (plant) this.entityManager.addBlast(new Blast(plant, enemy.blastDamage));
      }
      if (enemy.canDealContactDamage() && enemy.distanceToPlayer(playerPosition) < CONTACT_RADIUS) {
        this.playerHealth.takeDamage(enemy.contactDamage);
        enemy.triggerContactCooldown();
      }
    }

    // Blasts tick after the seeders that plant them but before the death check,
    // so a detonation that kills the player resolves on the tick it goes off.
    // They are deliberately not in `weaponTargets`: an area attack is terrain,
    // not something the auto-weapon should waste a lock on.
    for (const blast of this.entityManager.blasts) {
      blast.tick(dt, playerPosition, this.damagePlayer);
    }

    this.boss?.tick(dt, playerPosition, this.damagePlayer);

    this.weaponTargets.length = 0;
    for (const enemy of this.entityManager.enemies) this.weaponTargets.push(enemy);
    if (this.boss) this.weaponTargets.push(this.boss);
    this.weapon.tick(dt, playerPosition, this.weaponTargets, this.playerController.speed);

    // After the auto-weapon, before the kill pass, so a drone finished off by
    // the knife this tick still drops its XP on this tick.
    const swing = this.knife.tick(dt, this.playerController, this.weaponTargets, input.attackPressed);
    if (swing) {
      this.viewModel.triggerSlash();
      // Shown on whiffs too — the point of the flash is to teach the reach,
      // which is exactly what the player who just missed needs to see.
      this.slashCone.trigger(playerPosition, this.playerController.yaw);
    }

    this.entityManager.cullDeadEnemies((enemy) => {
      this.entityManager.addOrb(new XPOrb(enemy.position, XP_PER_KILL));
      if (this.perks.healOnKill > 0) this.playerHealth.heal(this.perks.healOnKill);
      this.ultimate.registerKill();
    });
    // Runs after the kill pass so a drone that dies this tick still drops XP;
    // distance culling itself awards nothing — leaving play is not a kill.
    this.entityManager.cullDistantEnemies(playerPosition, ENEMY_CULL_DISTANCE);

    for (const orb of this.entityManager.orbs) orb.tick(dt, playerPosition);

    this.entityManager.cullCollectedOrbs((orb) => {
      this.levelSystem.addXp(Math.round(orb.value * this.perks.xpMultiplier), () => this.startLevelUp());
    });
    this.entityManager.cullDistantOrbs(playerPosition, ORB_CULL_DISTANCE);
    this.entityManager.cullSpentBlasts();

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

    // Last in the tick, and in this order. The meter is charged from the state
    // this tick produced, and the recording is written from the state the
    // player will be handed back if they rewind to here — which must be the
    // settled end-of-tick world, not a half-updated one.
    this.ultimate.tick(
      dt,
      this.playerController.speed,
      !this.playerController.grounded,
      this.levelSystem.level,
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
    this.state = 'rewindCountdown';
    this.countdownRemaining = COUNTDOWN_SECONDS;
    this.ultFx.beginCountdown();
    this.ultFx.setCountdown(this.countdownRemaining);
  }

  private updateCountdown(dt: number, input: InputFrame): void {
    // Look is live here, and nothing else is. The player has just watched the
    // run go backwards and is usually mid-air on a ramp; resuming on whatever
    // heading the recording ended on would hand back a botched line as often as
    // a saved one.
    this.playerController.applyLook(input.yawDelta, input.pitchDelta);
    this.ultimateHeldLastTick = input.ultimateHeld;

    this.countdownRemaining -= dt;
    if (this.countdownRemaining > 0) {
      this.ultFx.setCountdown(this.countdownRemaining);
      return;
    }
    this.state = 'playing';
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
    this.levelSystem.addXp(XP_PER_BOSS, () => this.startLevelUp());
    this.banner.show(
      'MONOLITH DOWN',
      `${this.bossesFelled} felled — the next one is coming at level ${bossLevelFor(this.bossesFelled)}`,
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

  private startLevelUp(): void {
    this.openUpgradeChoice();
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
   * Pauses the run on a three-way powerup choice — the shared body of a
   * level-up and a shrine blessing. The pause is the same "welcome back"
   * contract as ever: `grantMomentumBoost` compensates the input window the
   * menu ate.
   */
  private openUpgradeChoice(): void {
    this.state = 'pausedForUpgrade';
    const choices = drawUpgradeChoices(3);
    this.upgradeMenu.show(choices, (choice) => {
      const ctx: UpgradeContext = {
        weapon: this.weapon,
        knife: this.knife,
        playerHealth: this.playerHealth,
        dash: this.dash,
        perks: this.perks,
      };
      choice.apply(ctx);
      this.playerController.grantMomentumBoost();
      this.state = 'playing';
    });
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
    this.hud.setVisible(visible);
  }

  get isMenuOpen(): boolean {
    return this.state === 'gameOver';
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
    this.knife.reset();
    this.slashCone.hide();
    this.viewModel.reset();
    this.dash.reset();
    this.ultimate.reset();
    this.rewind.clear();
    this.ultFx.reset();
    this.bossEpoch = 0;
    this.countdownRemaining = 0;
    this.ultimateHeldLastTick = false;
    resetMovementConfig();
    this.upgradeMenu.hide();
    this.gameOverScreen.hide();
    this.banner.hide();
    this.state = 'playing';
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
      hpFraction: this.playerHealth.hp / this.playerHealth.maxHp,
      xpFraction: this.levelSystem.progress,
      level: this.levelSystem.level,
      elapsedSeconds: this.spawnDirector.elapsedSeconds,
      bossesFelled: this.bossesFelled,
      dashFraction: this.dash.fraction,
      dashCharges: this.dash.charges,
      dashMaxCharges: this.dash.maxCharges,
      ultimateFraction: this.ultimate.charge,
    });
  }
}
