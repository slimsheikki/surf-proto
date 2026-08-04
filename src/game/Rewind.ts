import { Vector3 } from 'three';
import { Health } from '../combat/Health';
import { Weapon } from '../combat/Weapon';
import { Boss } from '../enemies/Boss';
import { Enemy } from '../enemies/Enemy';
import { Lancer } from '../enemies/Lancer';
import { Seeder } from '../enemies/Seeder';
import { SpawnDirector, SpawnSnapshot } from '../enemies/SpawnDirector';
import { Swarmer } from '../enemies/Swarmer';
import { Dash, DashSnapshot } from '../player/Dash';
import { MovementConfig } from '../player/MovementConfig';
import { PlayerController } from '../player/PlayerController';
import { LevelSnapshot, LevelSystem } from '../progression/LevelSystem';
import { RunPerks } from '../progression/Upgrades';
import { XP_MAGNET, XPOrb } from '../progression/XPOrb';
import { EntityManager } from './EntityManager';
import { FlowXP } from './FlowXP';
import { Shrine, ShrineSnapshot } from './Shrine';

/** The advertised ceiling on the ability: fifteen seconds and not a frame more. */
export const MAX_REWIND_SECONDS = 15;

/**
 * Snapshots per second of game time.
 *
 * Not the 128 Hz sim tick, and the gap is the whole reason this is affordable:
 * a frame carries every live enemy and orb, so recording one per tick would be
 * four times the memory and four times the write cost for a fidelity nobody can
 * see. The player's transform is interpolated between frames during playback,
 * so the thing the eye actually tracks stays smooth; enemies snap, at 1/32 s
 * granularity, while flying backwards.
 *
 * The cost of the granularity is that the resume point can be up to 1/32 s off
 * where the player let go. At 30 u/s that is a third of a unit, and the
 * countdown that follows hides it completely.
 */
const RECORD_HZ = 32;
const RECORD_INTERVAL = 1 / RECORD_HZ;
const CAPACITY = Math.round(MAX_REWIND_SECONDS * RECORD_HZ);

/**
 * How fast the world plays backwards, as a multiple of real time.
 *
 * Faster than 1x on purpose. At 1x a full 15-second rewind is fifteen seconds
 * of watching, which is far too long to hold a button mid-run and reads as a
 * cutscene rather than an ability. At 2.5x the full window drains in six
 * seconds, which is long enough to *find* the moment you want to return to and
 * short enough to stay tense.
 */
const REWIND_SPEED = 2.5;

/**
 * Below this there is not enough recording to be worth spending an ultimate on,
 * so the ability refuses to fire — otherwise a player who charged the bar in
 * the first seconds of a run could burn it on a two-second hop backwards.
 */
const MIN_USEFUL_SECONDS = 1.5;

/**
 * The archetype tag. Every spawnable class needs its own value and its own
 * branch in `applyEnemies`' reconstruction switch, or a rebuilt enemy comes
 * back as a plain drone — the classes carry behaviour the sample cannot.
 */
const ENEMY_KIND_DRONE = 0;
const ENEMY_KIND_SEEDER = 1;
const ENEMY_KIND_SWARMER = 2;
const ENEMY_KIND_LANCER = 3;

interface EnemySample {
  id: number;
  kind: number;
  x: number;
  y: number;
  z: number;
  hp: number;
  maxHp: number;
  moveSpeed: number;
  contactDamage: number;
  /** Seeders only; ignored for drones. */
  blastDamage: number;
  /**
   * Recorded stats are already elite-multiplied, so reconstruction feeds them
   * straight through the constructor; this flag only re-applies the look and
   * the drop bonus (`markElite` is stat-free by design).
   */
  elite: boolean;
}

interface OrbSample {
  id: number;
  x: number;
  y: number;
  z: number;
  value: number;
  magnetised: boolean;
}

/**
 * One moment of the run.
 *
 * Every field here is *state*, never a diff. That is deliberate and it is what
 * makes "rewind the powerups too" tractable: an upgrade is an arbitrary
 * mutation (`maxHp += 20`, `rechargeSeconds = max(1.5, x - 1.2)`) and inverting
 * an arbitrary mutation is not something the upgrade pool can be asked to
 * support. Recording the *result* instead means a new upgrade is rewound
 * correctly the day it is added, as long as the field it writes is listed here.
 *
 * Frames are preallocated and rewritten in place — this is a ring buffer, not a
 * log, and at 32 Hz a fresh object graph per frame would be 32 allocations a
 * second held for fifteen seconds.
 */
class Frame {
  px = 0;
  py = 0;
  pz = 0;
  vx = 0;
  vy = 0;
  vz = 0;
  yaw = 0;
  pitch = 0;
  grounded = false;

  hp = 0;
  maxHp = 0;
  regenPerSecond = 0;

  level: LevelSnapshot = { level: 1, xp: 0, xpToNext: 0, bankedPicks: 0 };
  dash: DashSnapshot = { charges: 0, maxCharges: 0, rechargeSeconds: 0, rechargeTimer: 0 };
  spawn: SpawnSnapshot = { survivalTime: 0, timeSinceLastSpawn: 0, suspended: false };
  /**
   * The flow-XP meter. The XP it granted rides `level` above; the meter that
   * granted it has to travel too, or a rewind hands back full-rate flow the
   * player has not re-earned (or confiscates one they had).
   */
  flow = 0;

  /**
   * Bumped by `Game` whenever a Monolith arrives or falls. The rewind window is
   * clamped at any change — see `usableFrames`.
   */
  bossEpoch = 0;
  /** Negative when no Monolith was alive. */
  bossHp = -1;

  weaponDamage = 0;
  weaponAttacksPerSecond = 0;
  weaponRange = 0;
  weaponVelocityRounds = false;
  healOnKill = 0;
  xpMultiplier = 1;
  soundBlastDamage = 0;
  soundBlastRadius = 0;
  solarWaveDps = 0;
  airRegenPerSecond = 0;
  heliotropism = 0;
  dopplerAps = 0;
  solarCapacitor = 0;
  auroraWake = 0;
  mirrorDamage = 0;
  echoChamber = 0;
  standingWaveSlow = 0;
  chorus = 0;
  magnetRadius = 0;
  maxGroundSpeed = 0;
  maxAirWishSpeed = 0;
  jumpSpeed = 0;

  /**
   * Parallel to the course's shrine list. Position travels too, not just the
   * collected flag: a blessing is no longer a fixture of the level — taking one
   * moves it — so rewinding across a pickup has to put it back where it was
   * taken from.
   */
  shrines: ShrineSnapshot[] = [];

  /** Sub-arrays are reused and grow to the run's high-water mark; `*Count` is the live length. */
  enemyCount = 0;
  enemies: EnemySample[] = [];
  orbCount = 0;
  orbs: OrbSample[] = [];
}

/** Everything the recorder reads from and writes back to. */
export interface RewindContext {
  playerController: PlayerController;
  playerHealth: Health;
  levelSystem: LevelSystem;
  dash: Dash;
  flowXp: FlowXP;
  weapon: Weapon;
  perks: RunPerks;
  spawnDirector: SpawnDirector;
  entityManager: EntityManager;
  /** A getter, not a list: `setCourse` rebuilds the shrines wholesale. */
  getShrines: () => Shrine[];
  getBoss: () => Boss | null;
  getBossEpoch: () => number;
}

/**
 * Ring-buffer recorder and playback head for the ReWind ultimate.
 *
 * Records the last {@link MAX_REWIND_SECONDS} of the run, then plays it
 * backwards through the live world so the player watches themselves un-happen.
 * Playback writes to the same objects the game loop owns rather than to ghost
 * copies, which is why the HUD winds back on its own — the XP bar is reading
 * the level system that is being restored.
 *
 * **Known limits, all deliberate:**
 *
 * - **Live blasts are cleared and never restored.** They live about a second,
 *   so anything recorded has long since gone off, and the seeders that plant
 *   them come back and re-plant.
 * - **Enemy internals do not travel** — heading, aim error, contact cooldown.
 *   Position and health do. A drone rebuilt by the rewind picks a fresh aim
 *   error, which is invisible next to it being in the right place.
 * - **The rewind cannot cross a Monolith's arrival or death** (`bossEpoch`).
 *   Un-felling a boss would mean rebuilding a 786-line state machine from a
 *   snapshot, and the alternative — letting the kill stand while its XP is
 *   rewound away — is worse than simply not offering the trade.
 */
export class Rewind {
  private readonly frames: Frame[] = Array.from({ length: CAPACITY }, () => new Frame());
  /** Index of the newest frame; -1 until the first record. */
  private head = -1;
  private count = 0;
  private sinceRecord = 0;

  /** Playback head, in frames *back* from the newest. 0 = now. */
  private cursor = 0;
  /** Frames the current playback is allowed to reach, fixed when playback begins. */
  private limit = 0;

  private readonly wantedIds = new Set<number>();
  private readonly liveEnemies = new Map<number, Enemy>();
  private readonly liveOrbs = new Map<number, XPOrb>();
  private readonly scratch = new Vector3();

  constructor(private readonly ctx: RewindContext) {}

  // ------------------------------------------------------------- recording

  /** Call once per gameplay tick. Internally throttled to `RECORD_HZ`. */
  record(dt: number): void {
    this.sinceRecord += dt;
    if (this.sinceRecord < RECORD_INTERVAL) return;
    // Subtract rather than zero, so the record rate does not drift with a tick
    // rate that is not an exact multiple of it.
    this.sinceRecord -= RECORD_INTERVAL;
    this.write(this.advance());
  }

  /**
   * Wipes the recording. Called on restart and — importantly — the moment a
   * rewind is committed: everything after the resume point is a timeline that
   * no longer happened, and leaving it in the buffer would let a second rewind
   * scrub *forward* into it.
   */
  clear(): void {
    this.head = -1;
    this.count = 0;
    this.sinceRecord = 0;
    this.cursor = 0;
    this.limit = 0;
  }

  private advance(): Frame {
    this.head = (this.head + 1) % CAPACITY;
    if (this.count < CAPACITY) this.count += 1;
    return this.frames[this.head];
  }

  /** `age` 0 is the newest frame, `count - 1` the oldest. */
  private frameAt(age: number): Frame {
    const index = (this.head - age + CAPACITY * 2) % CAPACITY;
    return this.frames[index];
  }

  private write(frame: Frame): void {
    const c = this.ctx;
    const { position, velocity } = c.playerController;
    frame.px = position.x;
    frame.py = position.y;
    frame.pz = position.z;
    frame.vx = velocity.x;
    frame.vy = velocity.y;
    frame.vz = velocity.z;
    frame.yaw = c.playerController.yaw;
    frame.pitch = c.playerController.pitch;
    frame.grounded = c.playerController.grounded;

    frame.hp = c.playerHealth.hp;
    frame.maxHp = c.playerHealth.maxHp;
    frame.regenPerSecond = c.playerHealth.regenPerSecond;

    frame.level = c.levelSystem.capture();
    frame.dash = c.dash.capture();
    frame.spawn = c.spawnDirector.capture();
    frame.flow = c.flowXp.capture();

    frame.bossEpoch = c.getBossEpoch();
    frame.bossHp = c.getBoss()?.health.hp ?? -1;

    frame.weaponDamage = c.weapon.damage;
    frame.weaponAttacksPerSecond = c.weapon.attacksPerSecond;
    frame.weaponRange = c.weapon.range;
    frame.weaponVelocityRounds = c.weapon.velocityRounds;
    frame.healOnKill = c.perks.healOnKill;
    frame.xpMultiplier = c.perks.xpMultiplier;
    frame.soundBlastDamage = c.perks.soundBlastDamage;
    frame.soundBlastRadius = c.perks.soundBlastRadius;
    frame.solarWaveDps = c.perks.solarWaveDps;
    frame.airRegenPerSecond = c.perks.airRegenPerSecond;
    frame.heliotropism = c.perks.heliotropism;
    frame.dopplerAps = c.perks.dopplerAps;
    frame.solarCapacitor = c.perks.solarCapacitor;
    frame.auroraWake = c.perks.auroraWake;
    frame.mirrorDamage = c.perks.mirrorDamage;
    frame.echoChamber = c.perks.echoChamber;
    frame.standingWaveSlow = c.perks.standingWaveSlow;
    frame.chorus = c.perks.chorus;
    frame.magnetRadius = XP_MAGNET.radius;
    frame.maxGroundSpeed = MovementConfig.MAX_GROUND_SPEED;
    frame.maxAirWishSpeed = MovementConfig.MAX_AIR_WISH_SPEED;
    frame.jumpSpeed = MovementConfig.JUMP_SPEED;

    const shrines = c.getShrines();
    frame.shrines.length = shrines.length;
    for (let i = 0; i < shrines.length; i++) frame.shrines[i] = shrines[i].capture();

    const enemies = c.entityManager.enemies;
    frame.enemyCount = enemies.length;
    for (let i = 0; i < enemies.length; i++) {
      const enemy = enemies[i];
      const sample = frame.enemies[i] ?? (frame.enemies[i] = blankEnemySample());
      sample.id = enemy.rewindId;
      sample.kind =
        enemy instanceof Seeder
          ? ENEMY_KIND_SEEDER
          : enemy instanceof Swarmer
            ? ENEMY_KIND_SWARMER
            : enemy instanceof Lancer
              ? ENEMY_KIND_LANCER
              : ENEMY_KIND_DRONE;
      sample.x = enemy.position.x;
      sample.y = enemy.position.y;
      sample.z = enemy.position.z;
      sample.hp = enemy.health.hp;
      sample.maxHp = enemy.health.maxHp;
      sample.moveSpeed = enemy.moveSpeed;
      sample.contactDamage = enemy.contactDamage;
      sample.blastDamage = enemy instanceof Seeder ? enemy.blastDamage : 0;
      sample.elite = enemy.elite;
    }

    const orbs = c.entityManager.orbs;
    frame.orbCount = orbs.length;
    for (let i = 0; i < orbs.length; i++) {
      const orb = orbs[i];
      const sample = frame.orbs[i] ?? (frame.orbs[i] = blankOrbSample());
      sample.id = orb.rewindId;
      sample.x = orb.position.x;
      sample.y = orb.position.y;
      sample.z = orb.position.z;
      sample.value = orb.value;
      sample.magnetised = orb.magnetised;
    }
  }

  // -------------------------------------------------------------- playback

  /**
   * How far back the ability could take the player right now, in seconds. Drives
   * both the "is it worth firing" test and the readout during the rewind.
   */
  get availableSeconds(): number {
    return Math.max(0, this.usableFrames() - 1) / RECORD_HZ;
  }

  get canRewind(): boolean {
    return this.availableSeconds >= MIN_USEFUL_SECONDS;
  }

  /** Seconds already scrubbed back in the current playback. */
  get rewoundSeconds(): number {
    return this.cursor / RECORD_HZ;
  }

  /**
   * Frames reachable from now: the whole buffer, cut short at a Monolith
   * arriving or falling. See the class comment for why that boundary is hard.
   */
  private usableFrames(): number {
    const epoch = this.ctx.getBossEpoch();
    for (let age = 0; age < this.count; age++) {
      if (this.frameAt(age).bossEpoch !== epoch) return age;
    }
    return this.count;
  }

  begin(): void {
    this.cursor = 0;
    this.limit = Math.max(0, this.usableFrames() - 1);
    // A blast planted before the rewind would otherwise detonate on the tick
    // play resumes, under a player who is no longer where it was aimed.
    this.ctx.entityManager.clearBlasts();
  }

  /**
   * Scrubs one tick further back and writes the world to match.
   * Returns false once the recording is exhausted, which ends the rewind on its
   * own — the player does not have to be holding the button when it runs out.
   */
  stepBack(dt: number): boolean {
    this.cursor += REWIND_SPEED * RECORD_HZ * dt;
    const exhausted = this.cursor >= this.limit;
    if (exhausted) this.cursor = this.limit;

    const older = Math.min(Math.floor(this.cursor), this.limit);
    const frame = this.frameAt(older);
    this.applyFrame(frame);

    // The player's own transform is interpolated between the two bracketing
    // frames. Everything else snaps: 1/32 s of drone travel is invisible, but
    // 1/32 s of the camera's own motion is not.
    const t = this.cursor - older;
    if (t > 1e-6 && older + 1 <= this.limit) {
      this.blendPlayer(frame, this.frameAt(older + 1), t);
    }
    return !exhausted;
  }

  /**
   * Ends the playback on an exact recorded frame and discards the buffer. The
   * interpolated pose the player was watching is snapped to the nearest whole
   * frame first, so the world they resume in is one that genuinely existed.
   */
  commit(): void {
    const target = Math.min(Math.round(this.cursor), this.limit);
    this.applyFrame(this.frameAt(target));
    this.clear();
  }

  private blendPlayer(a: Frame, b: Frame, t: number): void {
    const { position, velocity } = this.ctx.playerController;
    position.set(a.px + (b.px - a.px) * t, a.py + (b.py - a.py) * t, a.pz + (b.pz - a.pz) * t);
    velocity.set(a.vx + (b.vx - a.vx) * t, a.vy + (b.vy - a.vy) * t, a.vz + (b.vz - a.vz) * t);
    // Yaw accumulates without wrapping and a frame is 1/32 s, so a plain lerp
    // can never take the short way round the wrong side.
    this.ctx.playerController.yaw = a.yaw + (b.yaw - a.yaw) * t;
    this.ctx.playerController.pitch = a.pitch + (b.pitch - a.pitch) * t;
  }

  private applyFrame(frame: Frame): void {
    const c = this.ctx;
    c.playerController.position.set(frame.px, frame.py, frame.pz);
    c.playerController.velocity.set(frame.vx, frame.vy, frame.vz);
    c.playerController.yaw = frame.yaw;
    c.playerController.pitch = frame.pitch;
    c.playerController.grounded = frame.grounded;

    c.playerHealth.maxHp = frame.maxHp;
    c.playerHealth.hp = frame.hp;
    c.playerHealth.regenPerSecond = frame.regenPerSecond;

    c.levelSystem.restore(frame.level);
    c.dash.restore(frame.dash);
    c.spawnDirector.restore(frame.spawn);
    c.flowXp.restore(frame.flow);

    c.weapon.damage = frame.weaponDamage;
    c.weapon.attacksPerSecond = frame.weaponAttacksPerSecond;
    c.weapon.range = frame.weaponRange;
    c.weapon.velocityRounds = frame.weaponVelocityRounds;
    c.perks.healOnKill = frame.healOnKill;
    c.perks.xpMultiplier = frame.xpMultiplier;
    c.perks.soundBlastDamage = frame.soundBlastDamage;
    c.perks.soundBlastRadius = frame.soundBlastRadius;
    c.perks.solarWaveDps = frame.solarWaveDps;
    c.perks.airRegenPerSecond = frame.airRegenPerSecond;
    c.perks.heliotropism = frame.heliotropism;
    c.perks.dopplerAps = frame.dopplerAps;
    c.perks.solarCapacitor = frame.solarCapacitor;
    c.perks.auroraWake = frame.auroraWake;
    c.perks.mirrorDamage = frame.mirrorDamage;
    c.perks.echoChamber = frame.echoChamber;
    c.perks.standingWaveSlow = frame.standingWaveSlow;
    c.perks.chorus = frame.chorus;
    XP_MAGNET.radius = frame.magnetRadius;
    MovementConfig.MAX_GROUND_SPEED = frame.maxGroundSpeed;
    MovementConfig.MAX_AIR_WISH_SPEED = frame.maxAirWishSpeed;
    MovementConfig.JUMP_SPEED = frame.jumpSpeed;

    const shrines = c.getShrines();
    for (let i = 0; i < shrines.length && i < frame.shrines.length; i++) {
      shrines[i].restore(frame.shrines[i]);
    }

    const boss = c.getBoss();
    // Phase is re-derived from HP on the boss's next tick, so putting the health
    // back is enough to put the whole fight back where it was.
    if (boss && frame.bossHp >= 0) boss.health.hp = frame.bossHp;

    this.applyEnemies(frame);
    this.applyOrbs(frame);
  }

  private applyEnemies(frame: Frame): void {
    const em = this.ctx.entityManager;

    this.wantedIds.clear();
    for (let i = 0; i < frame.enemyCount; i++) this.wantedIds.add(frame.enemies[i].id);
    em.retainEnemies((enemy) => this.wantedIds.has(enemy.rewindId));

    this.liveEnemies.clear();
    for (const enemy of em.enemies) this.liveEnemies.set(enemy.rewindId, enemy);

    for (let i = 0; i < frame.enemyCount; i++) {
      const sample = frame.enemies[i];
      let enemy = this.liveEnemies.get(sample.id);
      if (!enemy) {
        this.scratch.set(sample.x, sample.y, sample.z);
        enemy = this.reconstructEnemy(sample);
        // Stand in for the enemy that was here, so the next frame recognises it
        // instead of destroying and rebuilding it all over again.
        enemy.rewindId = sample.id;
        if (sample.elite) enemy.markElite();
        // It was fully present when this frame was recorded — no spawn pop-in.
        enemy.finishMaterialize();
        em.addEnemy(enemy);
      }
      enemy.position.set(sample.x, sample.y, sample.z);
      enemy.mesh.position.copy(enemy.position);
      enemy.health.maxHp = sample.maxHp;
      enemy.health.hp = sample.hp;
    }
  }

  /** `scratch` already holds the sample's position when this is called. */
  private reconstructEnemy(sample: EnemySample): Enemy {
    switch (sample.kind) {
      case ENEMY_KIND_SEEDER:
        return new Seeder(
          this.scratch,
          sample.maxHp,
          sample.moveSpeed,
          sample.contactDamage,
          sample.blastDamage,
        );
      case ENEMY_KIND_SWARMER:
        return new Swarmer(this.scratch, sample.maxHp, sample.moveSpeed, sample.contactDamage);
      case ENEMY_KIND_LANCER:
        return new Lancer(this.scratch, sample.maxHp, sample.moveSpeed, sample.contactDamage);
      default:
        return new Enemy(this.scratch, sample.maxHp, sample.moveSpeed, sample.contactDamage);
    }
  }

  private applyOrbs(frame: Frame): void {
    const em = this.ctx.entityManager;

    this.wantedIds.clear();
    for (let i = 0; i < frame.orbCount; i++) this.wantedIds.add(frame.orbs[i].id);
    em.retainOrbs((orb) => this.wantedIds.has(orb.rewindId));

    this.liveOrbs.clear();
    for (const orb of em.orbs) this.liveOrbs.set(orb.rewindId, orb);

    for (let i = 0; i < frame.orbCount; i++) {
      const sample = frame.orbs[i];
      let orb = this.liveOrbs.get(sample.id);
      if (!orb) {
        this.scratch.set(sample.x, sample.y, sample.z);
        orb = new XPOrb(this.scratch, sample.value);
        orb.rewindId = sample.id;
        em.addOrb(orb);
      }
      orb.position.set(sample.x, sample.y, sample.z);
      orb.mesh.position.copy(orb.position);
      orb.magnetised = sample.magnetised;
      orb.collected = false;
    }
  }
}

function blankEnemySample(): EnemySample {
  return {
    id: 0,
    kind: ENEMY_KIND_DRONE,
    x: 0,
    y: 0,
    z: 0,
    hp: 0,
    maxHp: 0,
    moveSpeed: 0,
    contactDamage: 0,
    blastDamage: 0,
    elite: false,
  };
}

function blankOrbSample(): OrbSample {
  return { id: 0, x: 0, y: 0, z: 0, value: 0, magnetised: false };
}
