import { PerspectiveCamera, Scene, Vector3 } from 'three';
import { Health } from '../combat/Health';
import { Weapon } from '../combat/Weapon';
import { InputFrame } from '../engine/Input';
import { SpawnDirector } from '../enemies/SpawnDirector';
import { CameraRig } from '../player/CameraRig';
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

const CONTACT_RADIUS = 0.9;
const XP_PER_KILL = 3;
const RESPAWN_HEIGHT_OFFSET = new Vector3(0, 1.2, 0);
const FALL_OUT_OF_BOUNDS_Y = -50;

/**
 * Composition root: owns every subsystem and ties them together in a fixed
 * update order each tick. Combat/progression is a secondary layer here — it
 * never blocks the player controller from ticking, only the level-up pause does.
 */
export class Game {
  readonly playerController: PlayerController;
  readonly cameraRig: CameraRig;
  readonly playerHealth = new Health(100);
  readonly weapon = new Weapon();
  readonly levelSystem = new LevelSystem();
  readonly entityManager: EntityManager;
  readonly spawnDirector = new SpawnDirector();

  state: GameState = 'playing';

  private lastStage: CourseStage;
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
    this.lastStage = stages[0];
    this.gameOverScreen = new GameOverScreen(() => this.restart());
  }

  tick(dt: number, input: InputFrame): void {
    if (input.cameraTogglePressed) this.cameraRig.toggle();

    if (this.state === 'playing') {
      this.updateGameplay(dt, input);
    }

    this.cameraRig.update(this.playerController);
    this.updateHud();
  }

  private updateGameplay(dt: number, input: InputFrame): void {
    this.playerController.tick(dt, input);
    const playerPosition = this.playerController.position;

    this.trackLastStage(playerPosition);
    if (playerPosition.y < FALL_OUT_OF_BOUNDS_Y) {
      this.playerController.teleport(this.lastStage.center.clone().add(RESPAWN_HEIGHT_OFFSET));
    }

    const playerForward = this.currentForward();
    this.spawnDirector.tick(dt, playerPosition, playerForward, (enemy) =>
      this.entityManager.addEnemy(enemy),
    );

    for (const enemy of this.entityManager.enemies) {
      enemy.tick(dt, playerPosition);
      if (enemy.canDealContactDamage() && enemy.distanceToPlayer(playerPosition) < CONTACT_RADIUS) {
        this.playerHealth.takeDamage(enemy.contactDamage);
        enemy.triggerContactCooldown();
      }
    }

    this.weapon.tick(dt, playerPosition, this.entityManager.enemies);

    this.entityManager.cullDeadEnemies((enemy) => {
      this.entityManager.addOrb(new XPOrb(enemy.position, XP_PER_KILL));
    });

    for (const orb of this.entityManager.orbs) orb.tick(dt, playerPosition);

    this.entityManager.cullCollectedOrbs((orb) => {
      this.levelSystem.addXp(orb.value, () => this.startLevelUp());
    });

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

  private restart(): void {
    this.entityManager.clear();
    this.playerHealth.hp = this.playerHealth.maxHp;
    this.playerController.teleport(this.stages[0].center.clone().add(RESPAWN_HEIGHT_OFFSET));
    this.spawnDirector.reset();
    this.levelSystem.level = 1;
    this.levelSystem.xp = 0;
    this.gameOverScreen.hide();
    this.state = 'playing';
  }

  private currentForward(): Vector3 {
    const { velocity } = this.playerController;
    const horizontalSpeed = Math.hypot(velocity.x, velocity.z);
    if (horizontalSpeed > 0.5) {
      return new Vector3(velocity.x, 0, velocity.z).normalize();
    }
    const yaw = this.playerController.yaw;
    return new Vector3(Math.sin(yaw), 0, -Math.cos(yaw));
  }

  private trackLastStage(playerPosition: Vector3): void {
    for (const stage of this.stages) {
      const dx = Math.abs(playerPosition.x - stage.center.x);
      const dz = Math.abs(playerPosition.z - stage.center.z);
      const dy = Math.abs(playerPosition.y - stage.center.y);
      if (dx < stage.halfWidth && dz < stage.halfDepth && dy < 2) {
        this.lastStage = stage;
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
