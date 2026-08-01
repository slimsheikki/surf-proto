import {
  AdditiveBlending,
  CylinderGeometry,
  DataTexture,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Quaternion,
  RGBAFormat,
  Sprite,
  SpriteMaterial,
  Vector3,
} from 'three';

/* ------------------------------------------------------------------ *
 * Tuning
 * ------------------------------------------------------------------ */

/**
 * Flight speed of the cosmetic bolt, u/s.
 *
 * Deliberately finite rather than instant. The damage is hitscan and stays
 * hitscan (the DPS numbers the boss is balanced against are measured, and
 * travel time would silently change all of them plus add whiff chance against
 * drones crossing at 30 u/s). The bolt is *only* a picture of a shot that has
 * already landed, so its speed is chosen purely for readability: at the
 * weapon's 22-unit range this is ~0.16 s of flight — long enough for the eye to
 * catch a streak, short enough that it still reads as a gunshot rather than a
 * lobbed ball.
 */
const BOLT_SPEED = 140;

/** Neon cyan. The player's colour: orange = boss burst, magenta = homing orb. */
const BOLT_COLOR = 0x7fe8ff;
const BOLT_RADIUS = 0.06;
/** Tapered nose, so a bolt reads as pointing where it is going. */
const BOLT_NOSE_RADIUS = 0.022;
const BOLT_LENGTH = 0.9;
/**
 * The flare: a translucent additive sleeve that gives the bolt presence beyond
 * its 0.12-unit core.
 *
 * Its colour is *not* `BOLT_COLOR`. Additive blending adds to the background, so
 * a shell carrying red (0x7f...) over the course's mid-grey floor pushes all
 * three channels up together and the bolt turns chalky pale blue — measured on
 * a test render, it desaturated the whole effect and cost more than it gained.
 * Dropping the red to near zero means the shell can only add cyan, so the halo
 * gets *more* saturated over grey rather than washing toward white. It also has
 * to stay tight; a fat sleeve swamps the core no matter what colour it is.
 */
const BOLT_SHELL_COLOR = 0x14dcff;
const BOLT_SHELL_RADIUS = 0.17;
const BOLT_SHELL_LENGTH = 1.2;
const BOLT_SHELL_OPACITY = 0.34;
/**
 * Slightly over 1, deliberately. Emissive above 1 clips the green and blue
 * channels while leaving red at 0.5*1.55, so the middle of the bolt burns out to
 * white and its edges stay cyan — which is what a neon tube actually looks like.
 * Pushed much higher (3+) all three channels clip and the bolt goes flat white,
 * losing the colour that distinguishes it from the boss's fire.
 */
const BOLT_EMISSIVE_INTENSITY = 1.55;
/** Seconds of fade at the end of a bolt's flight, so it dies out instead of popping. */
const BOLT_FADE_SECONDS = 0.05;

const FLASH_COLOR = 0xbdf4ff;
const FLASH_SECONDS = 0.12;
/** Sprite scale is the quad's world width, so these are diameters, not radii. */
const FLASH_START_SCALE = 0.6;
const FLASH_END_SCALE = 2.2;
const FLASH_OPACITY = 1;
/** Fraction of the flash sprite's radius held at full brightness before the falloff. */
const FLASH_CORE_FRACTION = 0.24;

/**
 * Pool sizes. Nothing is allocated per shot — a shot claims a preallocated
 * slot and gives it back. At 4-10 shots/s against a drone (0.16 s of flight)
 * about two bolts are ever live at once; the worst case is the boss, which sits
 * ~92 units away behind an engagement bubble, so its bolts fly for ~0.66 s and
 * ~7 can overlap. 32 leaves a wide margin, and exhaustion recycles the
 * furthest-along bolt rather than allocating.
 */
const BOLT_POOL_SIZE = 32;
/** Flashes last 0.12 s, so far fewer overlap than bolts. */
const FLASH_POOL_SIZE = 16;

/**
 * Muzzle offset from the player's *feet* position, which is what the weapon is
 * handed. Roughly hip-to-shoulder height, kicked to the shot's right and pushed
 * forward along the shot direction.
 *
 * The forward push is not cosmetic: in first person the camera sits at eye
 * height on the same spot, so a bolt born at the player's origin would spawn
 * inside the near plane and be clipped away on the frame it most needs to be
 * seen. Offsetting right and down also stops the bolt from hiding exactly
 * behind the crosshair, which is where it would be least visible.
 */
const MUZZLE_UP = 1.3;
const MUZZLE_RIGHT = 0.35;
const MUZZLE_FORWARD = 0.6;

/* ------------------------------------------------------------------ *
 * Shared GPU resources
 * ------------------------------------------------------------------ */

/**
 * Module-level and shared by every bolt in every pool, matching how the boss's
 * projectile geometry is handled: geometry never varies per instance, so there
 * is nothing per-instance to own and therefore nothing per-instance to leak.
 * Materials *are* per-instance (each bolt fades on its own clock) but they are
 * allocated once with the pool and freed in `dispose`.
 *
 * Both cylinders are capped. The beam uses open-ended ones because the player
 * can be *inside* a beam and would see its inner wall, but a bolt is a small
 * solid object seen from outside: open ends showed the inside of the tube and
 * made a close-range bolt read as a plastic trough rather than a projectile.
 */
const BOLT_CORE_GEOMETRY = new CylinderGeometry(
  BOLT_NOSE_RADIUS,
  BOLT_RADIUS,
  BOLT_LENGTH,
  8,
  1,
  false,
);
const BOLT_SHELL_GEOMETRY = new CylinderGeometry(
  BOLT_SHELL_RADIUS * 0.4,
  BOLT_SHELL_RADIUS,
  BOLT_SHELL_LENGTH,
  10,
  1,
  false,
);
/**
 * Soft round falloff for the impact flash, built as a `DataTexture` rather than
 * drawn on a canvas: this module is exercised headlessly (the FX probe runs in
 * plain node), and a `CanvasTexture` needs a DOM. A plain typed array needs
 * nothing.
 *
 * A flash has to be *soft*. The first attempt used a low-detail additive
 * icosahedron and read as a hard-edged solid ball parked on the target rather
 * than a burst of light — the giveaway was its visible polygon silhouette. A
 * radial alpha ramp on a camera-facing sprite has no silhouette at all.
 */
function buildFlashTexture(size = 64): DataTexture {
  const data = new Uint8Array(size * size * 4);
  const centre = (size - 1) / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (x - centre) / centre;
      const dy = (y - centre) / centre;
      const r = Math.min(1, Math.sqrt(dx * dx + dy * dy));
      // A solid hot core with a quadratic skirt. A pure falloff from the centre
      // (any power of `1 - r`) measured far too faint on a test render: a cubic
      // ramp averages only ~0.1 alpha across the quad, so the flash disappeared
      // against a lit target. The plateau puts real brightness where the hit is
      // and leaves the ramp to soften the edge.
      const skirt = Math.max(0, (r - FLASH_CORE_FRACTION) / (1 - FLASH_CORE_FRACTION));
      const alpha = (1 - skirt) * (1 - skirt);
      const i = (y * size + x) * 4;
      data[i] = 255;
      data[i + 1] = 255;
      data[i + 2] = 255;
      data[i + 3] = Math.round(alpha * 255);
    }
  }
  const texture = new DataTexture(data, size, size, RGBAFormat);
  texture.needsUpdate = true;
  return texture;
}

const FLASH_TEXTURE = buildFlashTexture();

const CYLINDER_AXIS = new Vector3(0, 1, 0);
const UP = new Vector3(0, 1, 0);

const scratchDir = new Vector3();
const scratchRight = new Vector3();
const scratchOrientation = new Quaternion();

/* ------------------------------------------------------------------ *
 * Pooled entities
 * ------------------------------------------------------------------ */

/**
 * One pooled bolt: a bright thin core inside a translucent additive shell,
 * flying a straight line from a muzzle point to a recorded end point.
 *
 * The end point is recorded at fire time and never re-read from the target.
 * The target is frequently dead — often *because of this shot* — long before
 * the bolt lands, and a cosmetic effect that dereferences a corpse is exactly
 * the kind of thing that keeps dead entities alive.
 */
class Bolt {
  readonly group = new Group();
  active = false;

  private readonly coreMaterial: MeshStandardMaterial;
  private readonly shellMaterial: MeshBasicMaterial;
  private readonly start = new Vector3();
  private readonly end = new Vector3();
  private readonly direction = new Vector3(0, 1, 0);
  private distance = 0;
  private duration = 0;
  private age = 0;

  constructor() {
    this.coreMaterial = new MeshStandardMaterial({
      // Base colour is near-black on purpose: with a lit cyan base the ambient
      // and directional lights add on top of the emissive and the bolt washes
      // out to plain white, which is the one thing it must not be. Emissive
      // alone drives the look, so lighting cannot decide whether a shot is
      // visible or what colour it is.
      color: 0x06222c,
      emissive: BOLT_COLOR,
      emissiveIntensity: BOLT_EMISSIVE_INTENSITY,
      transparent: true,
      opacity: 1,
      roughness: 1,
      metalness: 0,
    });
    this.shellMaterial = new MeshBasicMaterial({
      color: BOLT_SHELL_COLOR,
      transparent: true,
      opacity: BOLT_SHELL_OPACITY,
      blending: AdditiveBlending,
      // A glow the world is seen *through*; writing depth would make it occlude
      // geometry behind it and z-fight with the core it wraps.
      depthWrite: false,
    });
    this.group.add(
      new Mesh(BOLT_CORE_GEOMETRY, this.coreMaterial),
      new Mesh(BOLT_SHELL_GEOMETRY, this.shellMaterial),
    );
  }

  /** Arms this slot for a flight from `from` to `to`. Returns false for a degenerate shot. */
  launch(from: Vector3, to: Vector3): boolean {
    scratchDir.copy(to).sub(from);
    this.distance = scratchDir.length();
    if (this.distance < 1e-3) return false;

    this.direction.copy(scratchDir).divideScalar(this.distance);
    this.start.copy(from);
    this.end.copy(to);
    this.duration = this.distance / BOLT_SPEED;
    this.age = 0;
    this.active = true;

    scratchOrientation.setFromUnitVectors(CYLINDER_AXIS, this.direction);
    this.group.quaternion.copy(scratchOrientation);
    this.group.position.copy(from);
    this.coreMaterial.opacity = 1;
    this.shellMaterial.opacity = BOLT_SHELL_OPACITY;
    return true;
  }

  /** Advances the flight. Returns true on the tick it finishes, so a flash can be spawned. */
  tick(dt: number): boolean {
    this.age += dt;
    if (this.age >= this.duration) {
      this.group.position.copy(this.end);
      this.active = false;
      return true;
    }
    this.group.position.copy(this.start).addScaledVector(this.direction, this.age * BOLT_SPEED);

    const fadeWindow = Math.min(BOLT_FADE_SECONDS, this.duration);
    const remaining = this.duration - this.age;
    const alpha = remaining >= fadeWindow ? 1 : remaining / fadeWindow;
    this.coreMaterial.opacity = alpha;
    this.shellMaterial.opacity = BOLT_SHELL_OPACITY * alpha;
    return false;
  }

  /** Where this bolt is headed, so a completing bolt can place its impact flash. */
  get endPoint(): Vector3 {
    return this.end;
  }

  /** 0-1 flight progress, used to pick a victim when the pool is exhausted. */
  get progress(): number {
    return this.duration > 0 ? this.age / this.duration : 1;
  }

  dispose(): void {
    this.coreMaterial.dispose();
    this.shellMaterial.dispose();
  }
}

/**
 * A pooled impact pop: a camera-facing additive sprite that expands and fades
 * over 0.12 s, marking where a shot actually landed.
 *
 * Short on purpose. It has to punctuate a shot, not linger — at 4-10 shots a
 * second anything longer overlaps itself into a permanent smear at the target.
 */
class ImpactFlash {
  readonly mesh: Sprite;
  active = false;

  private readonly material: SpriteMaterial;
  private age = 0;

  constructor() {
    this.material = new SpriteMaterial({
      map: FLASH_TEXTURE,
      color: FLASH_COLOR,
      transparent: true,
      opacity: FLASH_OPACITY,
      blending: AdditiveBlending,
      depthWrite: false,
      // Depth test off, not just depth write. The impact point is the target's
      // *centre*, so a depth-tested flash is drawn inside the target's own mesh
      // and the near half of a drone (or all 5.5 units of the boss) hides it
      // completely — which was exactly the case on the first test render. The
      // alternative, insetting the impact point to the target's surface, needs a
      // per-target radius the weapon has no business knowing.
      //
      // Ignoring occlusion is also consistent with the weapon it belongs to: the
      // auto-attack is hitscan with no line-of-sight check, so it already shoots
      // through geometry. A 0.12 s pop that can be glimpsed through a ramp is a
      // far smaller lie than a hit with no visible impact at all.
      depthTest: false,
    });
    this.mesh = new Sprite(this.material);
  }

  pop(at: Vector3): void {
    this.mesh.position.copy(at);
    this.mesh.scale.setScalar(FLASH_START_SCALE);
    this.material.opacity = FLASH_OPACITY;
    this.age = 0;
    this.active = true;
  }

  /** Returns true on the tick it finishes. */
  tick(dt: number): boolean {
    this.age += dt;
    if (this.age >= FLASH_SECONDS) {
      this.active = false;
      return true;
    }
    const t = this.age / FLASH_SECONDS;
    this.mesh.scale.setScalar(FLASH_START_SCALE + (FLASH_END_SCALE - FLASH_START_SCALE) * t);
    this.material.opacity = FLASH_OPACITY * (1 - t);
    return false;
  }

  dispose(): void {
    this.material.dispose();
  }
}

/* ------------------------------------------------------------------ *
 * The system
 * ------------------------------------------------------------------ */

/**
 * Purely cosmetic muzzle-to-impact effects for the hitscan auto-attack.
 *
 * The playtest complaint that started this ("didn't see any projectiles") was
 * literally true: the weapon applied damage and flashed the target's material
 * for 0.12 s, and that was the entire visual output of combat. At 30 u/s,
 * looking somewhere else, that is invisible. This draws the shot.
 *
 * It owns exactly one `Group` holding every live bolt and flash, so a caller
 * attaches and detaches all of it with a single `scene.add` / `scene.remove`
 * and cannot leave a stray mesh behind.
 */
export class TracerFx {
  readonly group = new Group();

  private readonly bolts: Bolt[] = [];
  private readonly flashes: ImpactFlash[] = [];

  constructor() {
    for (let i = 0; i < BOLT_POOL_SIZE; i++) this.bolts.push(new Bolt());
    for (let i = 0; i < FLASH_POOL_SIZE; i++) this.flashes.push(new ImpactFlash());
  }

  /* ------------------------- introspection ------------------------- */

  /** Live bolts. Assertable from a headless test; the pool never exceeds its cap. */
  get activeBoltCount(): number {
    return this.bolts.reduce((n, bolt) => n + (bolt.active ? 1 : 0), 0);
  }

  get activeFlashCount(): number {
    return this.flashes.reduce((n, flash) => n + (flash.active ? 1 : 0), 0);
  }

  /** Hard ceiling on how many objects this system can ever parent into the scene. */
  get capacity(): number {
    return BOLT_POOL_SIZE + FLASH_POOL_SIZE;
  }

  /* ----------------------------- firing ----------------------------- */

  /**
   * Draws one shot: a bolt from a muzzle derived from `playerPosition` to
   * `impactPoint`, which is the target's position *at the moment of firing*.
   *
   * Silently does nothing if the shot is degenerate (target inside the player).
   * Never fails a caller: this is decoration, and decoration must not be able
   * to interrupt a damage tick.
   */
  fire(playerPosition: Vector3, impactPoint: Vector3): void {
    const bolt = this.claimBolt();
    const muzzle = this.muzzleFor(playerPosition, impactPoint);
    if (!bolt.launch(muzzle, impactPoint)) return;
    this.group.add(bolt.group);
  }

  /**
   * Muzzle point for a shot at `impactPoint`. Right-hand offset is taken from
   * the shot direction rather than from the player's yaw, so this needs no
   * camera or look-direction plumbing from the caller.
   */
  private muzzleFor(playerPosition: Vector3, impactPoint: Vector3): Vector3 {
    const muzzle = playerPosition.clone();
    muzzle.y += MUZZLE_UP;

    scratchDir.copy(impactPoint).sub(muzzle);
    const distance = scratchDir.length();
    if (distance < 1e-3) return muzzle;
    scratchDir.divideScalar(distance);

    scratchRight.crossVectors(scratchDir, UP);
    if (scratchRight.lengthSq() < 1e-6) scratchRight.set(1, 0, 0);
    scratchRight.normalize();

    // Never push the muzzle past the thing it is shooting at.
    const forward = Math.min(MUZZLE_FORWARD, distance * 0.5);
    return muzzle.addScaledVector(scratchDir, forward).addScaledVector(scratchRight, MUZZLE_RIGHT);
  }

  /**
   * A free slot, or the bolt closest to landing if every slot is busy. Recycling
   * rather than growing is the point of the pool: a leaked mesh per shot at 4-10
   * shots/s for a whole run is precisely the entity leak this codebase has had
   * before.
   */
  private claimBolt(): Bolt {
    let fallback = this.bolts[0];
    for (const bolt of this.bolts) {
      if (!bolt.active) return bolt;
      if (bolt.progress > fallback.progress) fallback = bolt;
    }
    // The victim is already parented; unparent it so `fire` can re-add cleanly
    // without leaving a duplicate entry in the group's child list.
    this.group.remove(fallback.group);
    fallback.active = false;
    return fallback;
  }

  private spawnFlash(at: Vector3): void {
    let flash = this.flashes.find((candidate) => !candidate.active);
    if (!flash) {
      flash = this.flashes[0];
      this.group.remove(flash.mesh);
    }
    flash.pop(at);
    this.group.add(flash.mesh);
  }

  /* ------------------------------ update ------------------------------ */

  /**
   * Advances every live effect. Called by `Weapon.tick` with the `dt` it already
   * has, so the caller has one thing to tick rather than two.
   */
  tick(dt: number): void {
    for (const bolt of this.bolts) {
      if (!bolt.active) continue;
      if (bolt.tick(dt)) {
        this.group.remove(bolt.group);
        this.spawnFlash(bolt.endPoint);
      }
    }
    for (const flash of this.flashes) {
      if (!flash.active) continue;
      if (flash.tick(dt)) this.group.remove(flash.mesh);
    }
  }

  /** Drops every effect in flight without touching the pool. Used on restart. */
  clear(): void {
    for (const bolt of this.bolts) {
      if (!bolt.active) continue;
      bolt.active = false;
      this.group.remove(bolt.group);
    }
    for (const flash of this.flashes) {
      if (!flash.active) continue;
      flash.active = false;
      this.group.remove(flash.mesh);
    }
  }

  /**
   * Frees every per-instance material in both pools. Geometry and the flash
   * texture are module-level and shared with any other `TracerFx`, so they
   * outlive this one on purpose.
   */
  dispose(): void {
    this.clear();
    for (const bolt of this.bolts) bolt.dispose();
    for (const flash of this.flashes) flash.dispose();
  }
}
