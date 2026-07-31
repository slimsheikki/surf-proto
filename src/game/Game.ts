import { PerspectiveCamera, Scene, Vector3 } from 'three';
import { Health } from '../combat/Health';
import { Weapon } from '../combat/Weapon';
import { InputFrame } from '../engine/Input';
import { SpawnDirector } from '../enemies/SpawnDirector';
import { CameraRig } from '../player/CameraRig';
import { resetMovementConfig } from '../player/MovementConfig';
import { PlayerController } from '../player/PlayerController';
import { LevelSystem } from '../progression/LevelSystem';
import { drawUpgradeChoices, UpgradeContext } from '../progression/Upgrades';
import { XPOrb } from '../progression/XPOrb';
import { GameOverScreen } from '../ui/GameOverScreen';
import { Hud } from '../ui/Hud';
import { UpgradeMenu } from '../ui/UpgradeMenu';
import { CourseStage } from '../world/SurfCourse';
import { EntityManager } from './EntityManager';
import { GameState } from './GameState';

/** Enemy sphere is r=0.45 and the player capsule r=0.4; the rest is slack for a 128 Hz tick at 40 u/s closing speed. */
const CONTACT_RADIUS = 1.3;
const XP_PER_KILL = 3;
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
 * Composition root: owns every subsystem and ties them together in a fixed
 * update order each tick. Combat/progression is a secondary layer here — it
 * never blocks the player controller from ticking, only the level-up pause does.
 */
export class Game {
  readonly playerController: PlayerController;
  readonly cameraRig: CameraRig;
  readonly playerHealth = new Health(BASE_MAX_HP);
  readonly weapon = new Weapon();
  readonly levelSystem = new LevelSystem();
  readonly entityManager: EntityManager;
  readonly spawnDirector = new SpawnDirector();

  state: GameState = 'playing';

  /** Index into `stages` of the last rest platform the player stood on. */
  private lastStageIndex = 0;
  private paused = false;
  private readonly hud = new Hud();
  private readonly upgradeMenu = new UpgradeMenu();
  private readonly gameOverScreen: GameOverScreen;

  constructor(
    scene: Scene,
    camera: PerspectiveCamera,
    private readonly stages: CourseStage[],
    spawnPosition: Vector3,
    spawnYawDeg: number,
  ) {
    this.playerController = new PlayerController(spawnPosition, spawnYawDeg);
    this.cameraRig = new CameraRig(camera);
    this.entityManager = new EntityManager(scene);
    this.gameOverScreen = new GameOverScreen(() => this.restart());
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
    const target = this.stages[Math.min(this.lastStageIndex + 1, this.stages.length - 1)];
    return target.center.y - OUT_OF_BOUNDS_MARGIN;
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

    this.cameraRig.update(this.playerController);
    this.updateHud();
  }

  private updateGameplay(dt: number, input: InputFrame): void {
    this.playerController.tick(dt, input);
    const playerPosition = this.playerController.position;
    const playerVelocity = this.playerController.velocity;

    this.trackLastStage(playerPosition);
    if (playerPosition.y < this.outOfBoundsY) {
      this.playerController.teleport(this.lastStage.center.clone().add(RESPAWN_HEIGHT_OFFSET));
    }

    this.spawnDirector.tick(
      dt,
      {
        playerPosition,
        travelDirection: this.travelDirection(),
        playerSpeed: playerVelocity.length(),
        liveEnemyCount: this.entityManager.enemies.length,
      },
      (enemy) => this.entityManager.addEnemy(enemy),
    );

    for (const enemy of this.entityManager.enemies) {
      enemy.tick(dt, playerPosition, playerVelocity);
      if (enemy.canDealContactDamage() && enemy.distanceToPlayer(playerPosition) < CONTACT_RADIUS) {
        this.playerHealth.takeDamage(enemy.contactDamage);
        enemy.triggerContactCooldown();
      }
    }

    this.weapon.tick(dt, playerPosition, this.entityManager.enemies);

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

    if (this.playerHealth.isDead) {
      this.state = 'gameOver';
      this.gameOverScreen.show(this.levelSystem.level, this.spawnDirector.elapsedSeconds);
    }
  }

  private startLevelUp(): void {
    this.state = 'pausedForUpgrade';
    const choices = drawUpgradeChoices(3);
    this.upgradeMenu.show(choices, (choice) => {
      const ctx: UpgradeContext = { weapon: this.weapon, playerHealth: this.playerHealth };
      choice.apply(ctx);
      this.upgradeMenu.hide();
      this.state = 'playing';
    });
  }

  /**
   * Restores every piece of run state that upgrades or progression mutated.
   * Anything missed here compounds across runs, making each restart easier
   * (stats) or harder (XP thresholds) than a fresh start.
   */
  private restart(): void {
    this.entityManager.clear();
    this.playerHealth.maxHp = BASE_MAX_HP;
    this.playerHealth.hp = BASE_MAX_HP;
    this.playerController.teleport(this.stages[0].center.clone().add(RESPAWN_HEIGHT_OFFSET));
    this.lastStageIndex = 0;
    this.spawnDirector.reset();
    this.levelSystem.reset();
    this.weapon.reset();
    resetMovementConfig();
    this.upgradeMenu.hide();
    this.gameOverScreen.hide();
    this.state = 'playing';
  }

  /** Unit vector along the player's actual 3D path, or their look direction when nearly still. */
  private travelDirection(): Vector3 {
    const { velocity } = this.playerController;
    if (velocity.lengthSq() > 0.25) return velocity.clone().normalize();
    const yaw = this.playerController.yaw;
    return new Vector3(Math.sin(yaw), 0, -Math.cos(yaw));
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
    this.hud.update({
      speed: this.playerController.speed,
      hpFraction: this.playerHealth.hp / this.playerHealth.maxHp,
      xpFraction: this.levelSystem.progress,
      level: this.levelSystem.level,
      elapsedSeconds: this.spawnDirector.elapsedSeconds,
    });
  }
}
