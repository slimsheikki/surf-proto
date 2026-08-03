import {
  AmbientLight,
  Color,
  DirectionalLight,
  Fog,
  Group,
  PerspectiveCamera,
  Scene,
  Vector3,
  WebGLRenderer,
} from 'three';
import { FixedStepLoop } from '../engine/Clock';
import { disposeObject } from '../engine/Dispose';
import { InputSystem, isTextEntryTarget } from '../engine/Input';
import { Editor } from '../editor/Editor';
import { EditorUi } from '../editor/EditorUi';
import { buildFreeWorld } from '../editor/FreeCourse';
import { clearMapCodeFromLocation, decodeMapCode, mapCodeFromLocation } from '../editor/MapCode';
import { createStarterMap, FreeMap } from '../editor/MapData';
import { lastMapName, loadMap, rememberLastMap, uniqueMapName } from '../editor/MapStorage';
import { Game, GameCourse } from '../game/Game';
import { ViewModel } from '../player/ViewModel';
import { GameMode, MainMenu } from '../ui/MainMenu';
import { MovementPanel } from '../ui/MovementPanel';
import { MOVEMENT_VERSION_LABEL } from '../player/MovementVersion';
import { buildSkyDome, SKY_HORIZON_COLOR } from '../world/Sky';
import { buildSurfCourse } from '../world/SurfCourse';
import { clearColliders } from '../world/Colliders';

/**
 * Fog and clear colour match the painted dome's horizon, so distant geometry
 * fades into the *sky's* colour rather than a mismatched flat blue.
 */
const SKY_COLOR = SKY_HORIZON_COLOR;

/** Menu backdrop orbit: slow enough to read as a held shot rather than a spin. */
const MENU_ORBIT_RADIUS = 165;
const MENU_ORBIT_HEIGHT = 95;
const MENU_ORBIT_SPEED = 0.06;
const MENU_LOOK_AT = new Vector3(0, -6, 0);

/**
 * Where the app is. `play` covers both game modes — what differs between them
 * is only which course is loaded and where `M` goes back to.
 */
type AppMode = 'menu' | 'editor' | 'play';

/**
 * Composition root above `Game`: owns the renderer, the scene, and the one
 * camera everything borrows, and switches between the main menu, the free-mode
 * editor, and a run.
 *
 * `Game` is constructed at most once and re-pointed with `setCourse`, never
 * rebuilt. That is a hard requirement rather than an optimisation: the terminal
 * screens bind their restart handlers in their constructors, so a second `Game`
 * would leave two listeners on the same button and every restart would run
 * twice.
 */
export class App {
  private readonly renderer: WebGLRenderer;
  private readonly scene = new Scene();
  private readonly camera: PerspectiveCamera;
  private readonly viewModel = new ViewModel();
  private readonly input: InputSystem;
  private readonly loop = new FixedStepLoop();
  private readonly mainMenu = new MainMenu();
  /**
   * Live movement tuning, on `O`. Opening it drops pointer lock, which the
   * existing `pointerlockchange` handler already turns into a pause — so the
   * panel never has to reach into `Game` to stop the sim.
   */
  private readonly movementPanel = new MovementPanel();
  /**
   * Distance fog, applied only while a run is in progress.
   *
   * During play it is part of the look and part of the read — it tells the
   * player which ramp is the next one. In the editor it is actively harmful:
   * anything past 220 units fades into the sky, so a map long enough to need
   * the overview would disappear exactly when the player pulled back to see it.
   */
  private readonly playFog = new Fog(SKY_COLOR, 40, 220);
  private readonly skyDome: ReturnType<typeof buildSkyDome>;

  private readonly startOverlay = document.getElementById('start-overlay')!;
  private readonly hudEl = document.getElementById('hud')!;

  private mode: AppMode = 'menu';
  /** Which mode a run belongs to — decides whether `M` goes to the menu or back to the editor. */
  private playMode: GameMode = 'standard';

  private game: Game | null = null;
  /** The world currently in the scene. Owned here, disposed on every swap. */
  private world: Group | null = null;

  private editor: Editor | null = null;
  private editorUi: EditorUi | null = null;

  private lastFrameSeconds: number | null = null;
  private menuElapsed = 0;

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.renderer = new WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    // The viewmodel pass composites on top of the finished world image, so the
    // renderer must stop clearing between the two `render` calls.
    this.renderer.autoClear = false;

    this.scene.background = new Color(SKY_COLOR);
    // The painted sky. Mesh-only (no collider), fog-exempt, re-centred on the
    // camera every frame in `frame()` — a skybox, not a place.
    this.skyDome = buildSkyDome();
    this.scene.add(this.skyDome);
    this.scene.add(new AmbientLight(0xffffff, 0.55));
    const sun = new DirectionalLight(0xffffff, 1.1);
    sun.position.set(40, 60, 20);
    this.scene.add(sun);

    // Far plane well past the ring's 220-unit fog wall, because free maps are
    // not bounded by it: a player can lay ramps out over hundreds of units and
    // the editor has to be able to pull back far enough to see all of them.
    this.camera = new PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 2000);
    this.input = new InputSystem(canvas);

    document.getElementById('movement-tag')!.textContent = MOVEMENT_VERSION_LABEL;
    this.installListeners();
    this.loadStandardWorld();
    void this.bootFromUrl();
  }

  /**
   * Opens the main menu, or — if the page was opened from a share link — the
   * editor with that map already loaded.
   *
   * Async because decoding is: `DecompressionStream` is stream-based. The menu
   * is not shown first and then replaced, because a menu that appears and then
   * yanks itself away reads as a bug; the decode is fast enough that the extra
   * frames before either appears are invisible.
   */
  private async bootFromUrl(): Promise<void> {
    const code = mapCodeFromLocation();
    if (!code) {
      this.openMenu();
      return;
    }

    const map = await decodeMapCode(code);
    // Dropped whether or not the decode worked: a bad code should not survive a
    // refresh either, and a good one must not silently revert the recipient's
    // edits the next time they reload.
    clearMapCodeFromLocation();

    if (!map) {
      this.openMenu();
      return;
    }
    // Renamed before it reaches the editor, so the name in the field is the one
    // Save will actually use rather than something quietly changed underneath.
    map.name = uniqueMapName(map.name);
    this.openEditor(map);
  }

  start(): void {
    requestAnimationFrame((now) => this.frame(now));
  }

  // ------------------------------------------------------------- world swaps

  /**
   * Replaces the scene's world. Every path that changes what is collidable goes
   * through here, because the collider registry is a module-level singleton
   * with no per-object removal — the only correct way to unload a world is to
   * clear the whole registry and rebuild.
   */
  private setWorld(group: Group, disposeOld = true): void {
    if (this.world) {
      this.scene.remove(this.world);
      // The editor's root is long-lived and reused across visits, so it is
      // detached rather than destroyed.
      if (disposeOld) disposeObject(this.world);
    }
    this.world = group;
    this.scene.add(group);
  }

  private loadStandardWorld(): GameCourse {
    clearColliders();
    const course = buildSurfCourse();
    this.setWorld(course.group, this.world !== this.editor?.root);
    return course;
  }

  private loadFreeWorld(map: FreeMap): GameCourse {
    clearColliders();
    const built = buildFreeWorld(map, true);
    this.setWorld(built.group, this.world !== this.editor?.root);
    return built.course;
  }

  // -------------------------------------------------------------- mode: menu

  private openMenu(): void {
    this.mode = 'menu';
    this.menuElapsed = 0;
    this.input.releasePointerLock();
    this.editorUi?.hide();
    this.editor?.exit();
    this.startOverlay.classList.add('hidden');
    this.hudEl.classList.add('hidden');
    this.scene.fog = null;
    this.mainMenu.show((mode) => this.enterMode(mode));
  }

  private enterMode(mode: GameMode): void {
    if (mode === 'standard') this.startStandardRun();
    else this.openEditor();
  }

  // ------------------------------------------------------------ mode: editor

  /** `map` is supplied when arriving from a share link; otherwise the editor keeps whatever it had. */
  private openEditor(map?: FreeMap): void {
    this.mode = 'editor';
    this.input.releasePointerLock();
    this.startOverlay.classList.add('hidden');
    this.hudEl.classList.add('hidden');
    this.scene.fog = null;

    if (!this.editor) {
      this.editor = new Editor(this.canvas, this.camera, this.initialMap(), {
        onChange: () => this.editorUi?.refresh(),
      });
      this.editorUi = new EditorUi(this.editor, {
        onPlay: () => this.startFreeRun(),
        onExitToMenu: () => this.openMenu(),
        onNewMap: () => this.editor?.setMap(createStarterMap()),
      });
    }

    // Applied before `show`, so the toolbar's name field picks up the imported
    // name rather than the one the editor was constructed with.
    if (map) this.editor.setMap(map);

    // The editor world carries no colliders, so nothing needs clearing here —
    // the registry is wiped again the moment a map is handed over to be played.
    this.setWorld(this.editor.root, this.world !== this.editor.root);
    this.editor.enter();
    this.editorUi!.show();
    if (map) this.editorUi!.flashImported(map.name);
  }

  /** The last map the player worked on, or a generated starter the first time through. */
  private initialMap(): FreeMap {
    const name = lastMapName();
    if (name) {
      const saved = loadMap(name);
      if (saved) return saved;
    }
    return createStarterMap();
  }

  // -------------------------------------------------------------- mode: play

  private startStandardRun(): void {
    const course = this.loadStandardWorld();
    this.playMode = 'standard';
    this.beginRun(course);
  }

  private startFreeRun(): void {
    if (!this.editor) return;
    const map = this.editor.getMap();
    rememberLastMap(map.name);
    this.editor.exit();
    this.editorUi?.hide();
    const course = this.loadFreeWorld(map);
    this.playMode = 'free';
    this.beginRun(course);
  }

  private beginRun(course: GameCourse): void {
    this.mode = 'play';
    this.hudEl.classList.remove('hidden');
    this.scene.fog = this.playFog;

    if (!this.game) {
      this.game = new Game(this.scene, this.camera, course, this.viewModel);
      // Dev-only handle on the live run, for driving the game from a headless
      // browser: the late game is gated behind ten levels and a 2200 HP boss,
      // which no scripted input can reach in reasonable time, so without this
      // the endless-run code path is untestable outside of playing it. Vite
      // constant-folds `import.meta.env.DEV` to false and drops the branch from
      // the production bundle.
      if (import.meta.env.DEV) {
        (window as unknown as Record<string, unknown>).__surf = this.game;
      }
    } else {
      this.game.setCourse(course);
    }
    // Suspended until the click that takes pointer lock, so drones don't spawn
    // and the player doesn't slide off a ramp behind the start overlay.
    this.game.setPaused(true);
    this.startOverlay.classList.remove('hidden');
  }

  /** `M` during a run: back to wherever the run came from. */
  private leaveRun(): void {
    if (this.mode !== 'play') return;
    this.game?.setPaused(true);
    this.input.releasePointerLock();
    if (this.playMode === 'free') this.openEditor();
    else this.openMenu();
  }

  // ---------------------------------------------------------------- listeners

  private installListeners(): void {
    const requestStart = () => {
      if (this.mode === 'play' && !this.input.isLocked()) this.input.requestPointerLock();
    };
    this.canvas.addEventListener('click', requestStart);
    this.startOverlay.addEventListener('click', requestStart);

    document.addEventListener('pointerlockchange', () => {
      if (this.mode !== 'play') return;
      const locked = this.input.isLocked();
      // Never surface "click to start" on top of the game-over panel.
      this.startOverlay.classList.toggle(
        'hidden',
        locked || !!this.game?.isMenuOpen || this.movementPanel.isOpen,
      );
      this.game?.setPaused(!locked);
    });

    window.addEventListener('keydown', (event) => {
      // The shared rule rather than a local INPUT-only check: the editor's
      // share panel is a <textarea>, and typing an `o` into a pasted map code
      // must not open the movement panel.
      if (isTextEntryTarget(event.target)) return;
      // `M` rather than `Escape` for leaving a run: Escape is what the browser
      // uses to drop pointer lock, and the keydown for it is not reliably
      // delivered to the page, so binding it here would work on some browsers
      // and silently do nothing on others.
      if (event.code === 'KeyO') {
        event.preventDefault();
        const opened = this.movementPanel.toggle();
        if (opened) this.input.releasePointerLock();
        else if (this.mode === 'play') this.input.requestPointerLock();
        this.startOverlay.classList.toggle('hidden', opened || this.input.isLocked());
        return;
      }
      if (event.code === 'KeyM' && this.mode === 'play') {
        event.preventDefault();
        this.leaveRun();
      } else if (event.code === 'Escape' && this.mode === 'editor') {
        event.preventDefault();
        this.openMenu();
      } else if (event.code === 'Enter' && this.mode === 'editor') {
        event.preventDefault();
        this.startFreeRun();
      }
    });

    window.addEventListener('resize', () => {
      this.camera.aspect = window.innerWidth / window.innerHeight;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(window.innerWidth, window.innerHeight);
      this.viewModel.resize(window.innerWidth, window.innerHeight);
    });
  }

  // -------------------------------------------------------------- frame loop

  private frame(nowMs: number): void {
    const now = nowMs / 1000;
    const renderDt = this.lastFrameSeconds === null ? 0 : Math.min(0.1, now - this.lastFrameSeconds);
    this.lastFrameSeconds = now;

    // Stepped every frame regardless of mode so the accumulator's clock stays
    // current; the callback is what is gated. Skipping the call entirely would
    // bank the whole time spent in the editor and burn it as a burst of ticks
    // on the first frame of the next run.
    this.loop.step(
      now,
      (dt) => {
        if (this.mode === 'play' && this.game) this.game.tick(dt, this.input.consumeFrame());
      },
      // Told up front how many ticks this frame will run so the frame's mouse
      // motion is split evenly across them instead of all landing on the first.
      (steps) => this.input.beginFrame(steps),
    );

    if (this.mode === 'play' && this.game) {
      // Game-over and victory are the only panels the player must click, so the
      // cursor is handed back the moment one appears — under pointer lock it is
      // hidden and every click goes to the canvas, so the restart button would
      // be unreachable and the run would dead-end.
      if ((this.game.isMenuOpen || this.movementPanel.isOpen) && this.input.isLocked()) {
        this.input.releasePointerLock();
      }
    } else if (this.mode === 'editor') {
      this.editor?.update(renderDt);
    } else {
      this.updateMenuCamera(renderDt);
    }

    // Skybox behaviour: the dome travels with the camera, so it reads as
    // infinitely far and can never be reached, clipped into, or parallaxed.
    this.skyDome.position.copy(this.camera.position);

    this.renderer.clear();
    this.renderer.render(this.scene, this.camera);
    // Second pass over a wiped depth buffer: the knife is always in front of the
    // level, so riding with your shoulder against a ramp can never saw it in
    // half. First person only — in third person a pair of floating fists five
    // units from the player makes no sense.
    if (this.mode === 'play' && this.game?.cameraRig.mode === 'first') {
      this.renderer.clearDepth();
      this.renderer.render(this.viewModel.scene, this.viewModel.camera);
    }

    requestAnimationFrame((next) => this.frame(next));
  }

  private updateMenuCamera(dt: number): void {
    this.menuElapsed += dt;
    const angle = this.menuElapsed * MENU_ORBIT_SPEED;
    this.camera.position.set(
      Math.sin(angle) * MENU_ORBIT_RADIUS,
      MENU_ORBIT_HEIGHT,
      Math.cos(angle) * MENU_ORBIT_RADIUS,
    );
    this.camera.lookAt(MENU_LOOK_AT);
  }
}
