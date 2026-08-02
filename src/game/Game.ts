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
import { drawUpgradeChoices, UpgradeContext } from '../progression/Upgrades';
import { XPOrb } from '../progression/XPOrb';
import { Banner } from '../ui/Banner';
import { BossBar } from '../ui/BossBar';
import { DashEffect } from '../ui/DashEffect';
import { GameOverScreen } from '../ui/GameOverScreen';
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
const RESPAWN_HEIGHT_OFFSET = new Vector3(0, 1.2, 0);
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

  state: GameState = 'playing';

  /** Null between Monoliths — which is most of a run. */
  boss: Boss | null = null;

  /** How many Monoliths this run has felled. Drives boss scaling and the game-over stats. */
  bossesFelled = 0;

  /** Index into `stages` of the last rest platform the player stood on. */
  private lastStageIndex = 0;
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

  private stages: CourseStage[];

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
    this.stages = course.stages;
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
  }

  private get lastStage(): CourseStage {
    return this.stages[this.lastStageIndex];
  }

  /**
   * Kill plane, placed just below the platform the player is currently surfing
   * *toward* rather than below the whole course.
   *
   * A single global plane derived from the lowest stage looks equivalent but
   * isn't: this course descends over 1100 units, so falling off the first ramp
   * would mean plummeting ~1000 units — about ten seconds of nothing — before
   * the recovery triggered. Each stage's ramp stays above the platform it ends
   * on, so a margin below that platform is below the whole ramp run and catches
   * a fall promptly wherever it happens.
   */
  private get outOfBoundsY(): number {
    if (this.course.killPlaneY !== undefined) return this.course.killPlaneY;
    const target = this.stages[Math.min(this.lastStageIndex + 1, this.stages.length - 1)];
    return target.center.y - OUT_OF_BOUNDS_MARGIN;
  }

  /**
   * Points the game at a different course and starts it from the top. Used when
   * free mode hands over a map the player just built, and again when they go
   * back to the editor and return with it changed.
   */
  setCourse(course: GameCourse): void {
    this.course = course;
    this.stages = course.stages;
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

    if (this.state === 'playing' && !this.paused) {
      this.updateGameplay(dt, input);
    }

    // Outside the gameplay branch: the viewmodel keeps settling (and a swing
    // keeps playing out) through a level-up pause instead of freezing mid-arc.
    this.viewModel.update(dt, this.playerController.speed, input.yawDelta, input.pitchDelta);
    this.slashCone.tick(dt);
    this.banner.tick(dt);
    this.dashFx.tick(dt);

    this.cameraRig.update(this.playerController);
    this.updateHud();
  }

  private updateGameplay(dt: number, input: InputFrame): void {
    this.playerController.tick(dt, input);
    const playerPosition = this.playerController.position;
    const playerVelocity = this.playerController.velocity;

    this.dash.tick(dt);
    if (input.dashPressed && this.dash.tryConsume()) {
      this.playerController.grantMomentumBoost();
      this.playerController.applyDashForwardPush();
      this.viewModel.triggerDash();
      this.dashFx.trigger();
    }

    this.trackLastStage(playerPosition);
    if (playerPosition.y < this.outOfBoundsY) {
      this.playerController.teleport(this.lastStage.center.clone().add(RESPAWN_HEIGHT_OFFSET));
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
    this.weapon.tick(dt, playerPosition, this.weaponTargets);

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
    });
    // Runs after the kill pass so a drone that dies this tick still drops XP;
    // distance culling itself awards nothing — leaving play is not a kill.
    this.entityManager.cullDistantEnemies(playerPosition, ENEMY_CULL_DISTANCE);

    for (const orb of this.entityManager.orbs) orb.tick(dt, playerPosition);

    this.entityManager.cullCollectedOrbs((orb) => {
      this.levelSystem.addXp(orb.value, () => this.startLevelUp());
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
    }
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
    this.state = 'pausedForUpgrade';
    const choices = drawUpgradeChoices(3);
    this.upgradeMenu.show(choices, (choice) => {
      const ctx: UpgradeContext = { weapon: this.weapon, playerHealth: this.playerHealth, dash: this.dash };
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
    this.playerController.teleport(this.course.spawnPoint.clone());
    // Yaw too, not just position. A free map can start the player on any
    // heading, and `restart` is also the path `setCourse` takes — leaving the
    // yaw where the last run ended would drop them onto a new map facing
    // backwards off the pad.
    this.playerController.yaw = degToRad(this.course.spawnYawDeg);
    this.playerController.pitch = 0;
    this.lastStageIndex = 0;
    this.spawnDirector.reset();
    this.levelSystem.reset();
    this.weapon.reset();
    this.knife.reset();
    this.slashCone.hide();
    this.viewModel.reset();
    this.dash.reset();
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

  private trackLastStage(playerPosition: Vector3): void {
    for (let i = 0; i < this.stages.length; i++) {
      const stage = this.stages[i];
      const dx = Math.abs(playerPosition.x - stage.center.x);
      const dz = Math.abs(playerPosition.z - stage.center.z);
      const dy = playerPosition.y - stage.center.y;
      // Feet are snapped to the platform top when standing, and respawns drop
      // from RESPAWN_HEIGHT_OFFSET above it, so only a small band above the
      // surface counts as "on this stage" — a player passing underneath must not.
      if (dx < stage.halfWidth && dz < stage.halfDepth && dy > -0.5 && dy < 2) {
        this.lastStageIndex = i;
        break;
      }
    }
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
    });
  }
}
